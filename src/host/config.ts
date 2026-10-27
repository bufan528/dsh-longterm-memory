/**
 * Plugin configuration.
 *
 * DSH reads a plugin's `Config` export only if that plugin imports
 * `@deepseek-ai/schemastery`. A third-party plugin's module scope is not
 * guaranteed to resolve that package, and a failure there would take the whole
 * plugin down — so the row's `config` is validated here with `zod` instead, and
 * an invalid value falls back to its default with a warning rather than
 * preventing activation.
 *
 * Every field is documented in `docs/compatibility.md`; users set them in the
 * profile's `cordis.patch.yml`, which survives plugin upgrades.
 *
 * @module dsh-longterm-memory/host/config
 */

import { z } from 'zod'
import { DEFAULT_SETTINGS, type PluginSettings } from '../shared/protocol.js'

/** 联动标记集合：只校验形状，具体清洗在运行时归一化时完成。 */
const markersSchema = z
  .object({
    origins: z.array(z.string()).optional(),
    presets: z.array(z.string()).optional(),
    cwds: z.array(z.string()).optional(),
  })
  .strict()

export const pluginConfigSchema = z
  .object({
    /** Absolute path of the memory vault. Omitted means "discover it". */
    vaultPath: z.string().min(1).optional(),
    /** Interface language for the management page. */
    language: z.enum(['zh', 'en']).optional(),
    enableTools: z.boolean().optional(),
    enablePromptSection: z.boolean().optional(),
    standingBudgetTokens: z.number().int().min(0).max(20000).optional(),
    standingMaxItems: z.number().int().min(0).max(200).optional(),
    recallBudgetTokens: z.number().int().min(0).max(20000).optional(),
    recallMaxItems: z.number().int().min(0).max(200).optional(),
    enablePerStepRecall: z.boolean().optional(),
    enableAutoExtraction: z.boolean().optional(),
    enableLlmExtraction: z.boolean().optional(),
    redactSecrets: z.boolean().optional(),
    sensitiveNeedsConfirmation: z.boolean().optional(),
    maxCandidatesPerTurn: z.number().int().min(0).max(50).optional(),
    /**
     * QQ 接入与长期记忆联动。
     *
     * 允许在 `cordis.patch.yml` 里预设策略（例如给独立 QQ profile 固定成
     * 「拒绝 QQ 读取」），管理页面上保存的选择会覆盖这里同名字段。
     */
    qqLinkage: z
      .object({
        mode: z.enum(['off', 'deny-qq', 'allowlist']).optional(),
        writeMode: z.enum(['inbox-only', 'direct']).optional(),
        allowTools: z.boolean().optional(),
        qqMarkers: markersSchema.optional(),
        trustedMarkers: markersSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type PluginConfig = z.infer<typeof pluginConfigSchema>

/**
 * Validate a raw Cordis row config into plugin settings.
 *
 * Unknown keys are reported, not fatal: the profile patch is user-edited, and a
 * typo should produce a warning in the management page rather than silence the
 * plugin.
 */
export function resolveConfig(raw: unknown): { settings: Partial<PluginSettings>; warnings: string[] } {
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { settings: {}, warnings }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings: {}, warnings: ['插件配置不是一个对象，已忽略并使用默认设置。'] }
  }
  const parsed = pluginConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const unknownKeys = Object.keys(raw as Record<string, unknown>).filter(
      (key) => !(key in pluginConfigSchema.shape),
    )
    for (const key of unknownKeys) warnings.push(`未知的配置项 "${key}"，已忽略。`)
    // Retry with the known keys only, so one typo cannot discard the rest.
    const known: Record<string, unknown> = {}
    for (const key of Object.keys(pluginConfigSchema.shape)) {
      if (key in (raw as Record<string, unknown>)) known[key] = (raw as Record<string, unknown>)[key]
    }
    const retry = pluginConfigSchema.safeParse(known)
    if (retry.success) return { settings: retry.data as Partial<PluginSettings>, warnings }
    for (const issue of parsed.error.issues) {
      warnings.push(`配置项 ${issue.path.join('.') || '<root>'} 无效：${issue.message}`)
    }
    return { settings: {}, warnings }
  }
  return { settings: parsed.data as Partial<PluginSettings>, warnings }
}

/** Defaults the tests and the docs both refer to. */
export const CONFIG_DEFAULTS = DEFAULT_SETTINGS
