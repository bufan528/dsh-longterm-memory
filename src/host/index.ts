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

/** No service is published by this plugin; `provide` is intentionally absent. */
export const provide: string[] = []

/** Minimal Cordis context surface used by the entry. */
export interface CordisContextLike {
  get: (name: string) => unknown
  on: (name: string, listener: (...args: never[]) => unknown, options?: unknown) => unknown
  effect: (execute: () => unknown, label?: string) => unknown
  inject: (names: string[], callback: (context: CordisContextLike) => unknown) => unknown
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

  // ---------------------------------------------------------------- web API
  ctx.inject(['webServer'], (scoped) => {
    const result = installRoutes(scoped, service)
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
      const result = installTools(scoped, service, service.linkage)
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
