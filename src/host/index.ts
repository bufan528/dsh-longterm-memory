/**
 * DSH Memory Vault (长期记忆) — host half.
 *
 * This is the module the Cordis loader imports for the bundle row. It has **no
 * static `@deepseek-ai/*` import**: everything it needs from the host is reached
 * through the Cordis context (`ctx.get`, `ctx.inject`, `ctx.on`, `ctx.effect`).
 * That is deliberate — a host plugin is only as reliable as its module
 * resolution, and an unresolvable bare import would take the whole plugin down.
 * Where a DSH helper would be convenient (`defineTool`, `createUserMessage`,
 * `dsh-native-command`) the shape has been reproduced locally from the shipped
 * source instead.
 *
 * The plugin degrades by capability: a profile without `ctx.webServer` still
 * gets storage, indexing, the prompt section, and the tools; a profile without
 * `ctx.systemPrompt` still gets everything else. What was actually installed is
 * reported to the management page rather than assumed.
 *
 * @module dsh-longterm-memory/host/index
 */

import { fileURLToPath } from 'node:url'

import { resolveConfig } from './config.js'
import { MemoryService } from './core/service.js'
import { installStandingSection, installTurnExtraction, installPerStepRecall } from './dsh/inject.js'
import { CompanionService } from './companion/service.js'
import { EvolutionService, EvolutionStore } from './companion/evolution.js'
import { StickerStore } from './companion/stickers.js'
import { ReminderStore } from './tasks/reminder-store.js'
import { ReminderService } from './tasks/reminder-service.js'
import { installRoutes } from './dsh/routes.js'
import { installTools } from './dsh/tools.js'
import { createDshLlmAdapter } from './dsh/llm.js'
import { DEFAULT_SETTINGS, type PluginSettings } from '../shared/protocol.js'

/** Cordis plugin name. */
export const name = 'longterm-memory'

/**
 * Services this plugin *requires*.
 *
 * Empty on purpose: nothing here is mandatory, and requiring a service that a
 * slim profile lacks would keep the plugin (and therefore the user's memory)
 * inactive. Optional services are attached with `ctx.inject` below.
 */
export const inject: string[] = []

/**
 * `companion` is registered at runtime via `ctx.provide()` inside `apply()`.
 * The module-level array is intentionally empty: Cordis 4.x does not treat it
 * as a registration mechanism, and declaring it here would make the Host
 * believe a service exists before `apply()` has run.
 */
export const provide: string[] = []

/** Minimal Cordis context surface used by the entry. */
export interface CordisContextLike {
  get: (name: string) => unknown
  on: (name: string, listener: (...args: never[]) => unknown, options?: unknown) => unknown
  effect: (execute: () => unknown, label?: string) => unknown
  inject: (names: string[], callback: (context: CordisContextLike) => unknown) => unknown
  /** Optional: older Host builds may not expose dynamic service registration. */
  provide?: (name: string, value: unknown) => unknown
  logger?: {
    info: (message: string, ...rest: unknown[]) => void
    warn: (message: string, ...rest: unknown[]) => void
  }
}

/**
 * Activate the plugin.
 *
 * @param ctx - the Cordis context for this bundle row.
 * @param config - the row's `config` from `cordis.patch.yml` (validated here).
 */
export function apply(ctx: CordisContextLike, config?: unknown): void {
  const { settings, warnings } = resolveConfig(config)
  for (const warning of warnings) ctx.logger?.warn('dsh-longterm-memory: %s', warning)

  const notes: Record<string, string> = {}
  for (const warning of warnings) notes['config'] = [notes['config'] ?? '', warning].filter(Boolean).join(' ')

  // Model access is only created when the user asked for it. Building it costs
  // nothing (it resolves lazily), but keeping it out of the default path makes it
  // obvious that no model is ever contacted unless someone turned this on.
  const llmAdapter =
    settings.enableLlmExtraction === true
      ? createDshLlmAdapter(ctx, { timeoutMs: 60_000, maxOutputTokens: 1_200 })
      : undefined

  const service = new MemoryService({
    ...(settings.vaultPath === undefined ? {} : { configuredVaultPath: settings.vaultPath }),
    configSettings: settings,
    // The loaded module path is the only trustworthy way to name the Profile this
    // process actually runs in (an inherited DSH_PROFILE can name a different
    // one). Derivation failure is handled inside the service.
    modulePath: moduleFilePath(),
    ...(llmAdapter === undefined ? {} : { llmAdapter }),
    ...(ctx.logger === undefined
      ? {}
      : { logger: { info: ctx.logger.info.bind(ctx.logger), warn: ctx.logger.warn.bind(ctx.logger) } }),
  })

  // Capabilities are reported from *inside* each `ctx.inject` callback, never
  // from here. Cordis defers those callbacks until the requested service exists,
  // so recording the outcome up front would report "unavailable" for services
  // that are in fact present — the page would then tell the user the host cannot
  // reach the plugin while it demonstrably can.
  service.setCapabilities({ filesystem: true, notes, registeredTools: [] })

  // ------------------------------------------- shared Companion (design §七)
  // Published dynamically, not through a static import from the QQ plugin, so
  // load order cannot create a circular dependency (design §九.C). The QQ side
  // resolves `ctx.get('companion')` lazily and degrades to a conservative
  // default when this service is absent.
  const companion = new CompanionService(
    () => service.getVaultPath(),
    ctx.logger === undefined ? {} : { logger: { warn: ctx.logger.warn.bind(ctx.logger) } },
  )
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('companion', companion)
      ctx.logger?.info('dsh-longterm-memory: companion service provided (contract companion@v1)')
    } catch (error) {
      ctx.logger?.warn('dsh-longterm-memory: companion 服务注册失败: %o', error)
    }
  } else {
    // Informational, not a warning: a Host without provide() is a supported
    // degradation path and the QQ side falls back to the conservative persona.
    ctx.logger?.info('dsh-longterm-memory: 当前 Host 不提供 provide()，QQ 侧将使用保守默认人格')
  }

  // ------------------------------------- shared reminders (design WP-5)
  // "提醒属于共享的个人事项": the list lives in `Tasks/Reminders/` inside the
  // vault so both ends read the same rows. The QQ plugin still owns *delivery*
  // policy — this service only stores state, it never sends anything.
  const reminderStore = new ReminderStore({
    vaultPath: () => service.getVaultPath(),
    ...(ctx.logger === undefined ? {} : { logger: { warn: ctx.logger.warn.bind(ctx.logger) } }),
  })
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('reminderStore', reminderStore)
      ctx.logger?.info('dsh-longterm-memory: reminderStore service provided (contract reminder-store@v1)')
    } catch (error) {
      ctx.logger?.warn('dsh-longterm-memory: reminderStore 服务注册失败: %o', error)
    }
  }

  // Management-page operations (create/cancel/complete/reschedule) live here so
  // the reminder tab works without the QQ plugin being loaded. Delivery policy
  // still belongs to the plugin: this service only writes rows.
  const reminderService = new ReminderService(reminderStore)
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('reminderService', reminderService)
    } catch (error) {
      ctx.logger?.warn('dsh-longterm-memory: reminderService 服务注册失败: %o', error)
    }
  }

  // ------------------------------------------ sticker library (WP-4 on PC)
  // The library lives in `Companion/Stickers/` (excluded from the fact index),
  // so the PC page can manage stickers on an install where dsh-qqbot-merge is
  // absent. The plugin reads the same directory through this contract.
  const stickerStore = new StickerStore({
    vaultPath: () => service.getVaultPath(),
    ...(ctx.logger === undefined ? {} : { logger: { warn: ctx.logger.warn.bind(ctx.logger) } }),
  })
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('stickerLibrary', stickerStore)
      ctx.logger?.info('dsh-longterm-memory: stickerLibrary service provided (contract sticker-library@v1)')
    } catch (error) {
      ctx.logger?.warn('dsh-longterm-memory: stickerLibrary 服务注册失败: %o', error)
    }
  }

  // ------------------------------------------------ persona evolution (WP-9)
  // Suggestions are produced from the user's own memories by deterministic
  // rules; applying one is an explicit click on the page. No timer, no hook into
  // the conversation — a persona cannot drift while the user is not looking.
  const evolutionStore = new EvolutionStore({
    vaultPath: () => service.getVaultPath(),
    ...(ctx.logger === undefined ? {} : { logger: { warn: ctx.logger.warn.bind(ctx.logger) } }),
  })
  const evolutionService = new EvolutionService({
    companion,
    store: evolutionStore,
    listMemories: async (limit) => {
      try {
        const result = service.search({ text: '', limit, includeNonCurrent: false })
        return result.hits.map((hit) => ({
          id: hit.record.id,
          title: hit.record.title,
          // The index keeps a truncated preview rather than the full summary;
          // that is what the rules read, and it is enough for phrase counting.
          summary: hit.record.preview ?? '',
          tags: hit.record.tags,
        }))
      } catch {
        // Index not ready yet: an empty scan is honest, a thrown one blanks the page.
        return []
      }
    },
  })
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('evolutionService', evolutionService)
      ctx.logger?.info('dsh-longterm-memory: evolutionService provided (persona suggestions)')
    } catch (error) {
      ctx.logger?.warn('dsh-longterm-memory: evolutionService 服务注册失败: %o', error)
    }
  }

  // ---------------------------------------------------------------- web API
  ctx.inject(['webServer'], (scoped) => {
    const result = installRoutes(scoped, service, undefined, companion)
    service.setCapabilities({
      webServer: result.installed,
      ...(result.installed || result.note === undefined ? {} : { notes: { webServer: result.note } }),
    })
  })

  // ---------------------------------------------------------- prompt section
  if (settings.enablePromptSection !== false) {
    ctx.inject(['systemPrompt'], (scoped) => {
      const installed = installStandingSection(scoped, service, notes, service.linkage)
      service.linkage.setEnforcement({ standing: installed })
      service.setCapabilities({ systemPrompt: installed })
    })
  } else {
    notes['systemPrompt'] = '长期记忆的常驻系统提示词分区已被配置关闭。'
    service.linkage.setEnforcement({ standing: false })
    service.setCapabilities({ systemPrompt: false })
  }

  // --------------------------------------------------------------- LLM tools
  if (settings.enableTools !== false) {
    ctx.inject(['tools'], (scoped) => {
      const result = installTools(scoped, service, service.linkage, {
        stickers: stickerStore,
        reminders: reminderService,
      })
      service.linkage.setEnforcement({ tools: result.registered.length > 0, registeredTools: result.registered })
      service.setCapabilities({
        tools: result.registered.length > 0,
        registeredTools: result.registered,
        ...(Object.keys(result.notes).length === 0 ? {} : { notes: result.notes }),
      })
    })
  } else {
    notes['tools'] = '模型记忆工具已被配置关闭。'
    service.linkage.setEnforcement({ tools: false })
    service.setCapabilities({ tools: false })
  }

  // ------------------------------------------------- turn extraction trigger
  const extractionSettings: PluginSettings = { ...DEFAULT_SETTINGS, ...settings }
  const extractionInstalled = installTurnExtraction(ctx, service, extractionSettings, notes, service.linkage)
  service.linkage.setEnforcement({ extraction: extractionInstalled })
  service.setCapabilities({ sessionEvents: extractionInstalled })

  // -------------------------------------------------------- optional per-step
  if (extractionSettings.enablePerStepRecall) {
    const perStepInstalled = installPerStepRecall(ctx, service, notes, service.linkage)
    service.linkage.setEnforcement({ perStepRecall: perStepInstalled })
  } else {
    service.linkage.setEnforcement({ perStepRecall: false })
  }

  // ------------------------------------------------------------ LLM extraction
  if (llmAdapter !== undefined) {
    // Resolve the module and services in the background; the capability flips to
    // true only when a real call could actually be made.
    service.setCapabilities({
      llmExtraction: false,
      notes: { llmExtraction: '模型辅助提取已开启，正在解析模型访问能力…' },
    })
    void llmAdapter
      .init()
      .then(() => {
        service.setCapabilities({
          llmExtraction: llmAdapter.available,
          notes: {
            llmExtraction:
              llmAdapter.reason ??
              '模型辅助提取可用：会话结束后会调用一次你配置的模型，把该轮对话整理成候选记忆；内容会发送给该模型提供者，并产生调用费用。',
          },
        })
      })
      .catch((error: unknown) => {
        service.setCapabilities({
          llmExtraction: false,
          notes: { llmExtraction: `模型辅助提取初始化失败：${error instanceof Error ? error.message : String(error)}` },
        })
      })
  } else {
    service.setCapabilities({
      llmExtraction: false,
      notes: { llmExtraction: '模型辅助提取默认关闭（默认仅使用本地确定性规则，不产生任何模型调用）。' },
    })
  }

  // Warm the vault and index in the background; failures are reported through
  // the management page rather than breaking activation.
  void (async () => {
    try {
      const ready = await service.ensureReady()
      if (ready) {
        await service.loadPersistedSettings()
        ctx.logger?.info('dsh-longterm-memory: vault ready at %s', service.getVaultPath() ?? '(unknown)')
      } else {
        ctx.logger?.info('dsh-longterm-memory: no vault yet; open the 长期记忆 page to initialize one')
      }
    } catch (error) {
      ctx.logger?.warn('dsh-longterm-memory: vault warm-up failed: %o', error)
    }
  })()
}

/** Exposed for tests and for embedders that want the service without the page. */
export { MemoryService } from './core/service.js'
export { resolveConfig, pluginConfigSchema } from './config.js'

/**
 * Absolute path of this module on disk.
 *
 * Under the Cordis loader this is the real installed `lib/host/index.js`, so the
 * QQ diagnostics can derive the Profile from it instead of trusting an inherited
 * environment variable.
 */
function moduleFilePath(): string | undefined {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return undefined
  }
}
