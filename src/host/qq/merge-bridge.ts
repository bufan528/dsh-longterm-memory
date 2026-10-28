/**
 * 「连续消息智能合并」桥（宿主端）。
 *
 * 真实执行者在独立的 QQ Bot 扩展包 `dsh-qqbot-merge` 里（官方
 * `@tencent-connect/dsh-qqbot` 0.5.3 的维护分支）。本插件**不复制**它的实现，只
 * 消费它通过 cordis 服务 `qqbotMerge` 暴露的契约：
 *
 * - 服务在 → 页面可编辑配置，并能读到运行期真实计数 / 最近批次 / 生效 revision；
 * - 服务不在 → 页面显示「未生效 / BLOCKED」，所有开关禁用。
 *
 * 这条桥存在的意义正是避免「在 Vault 设置里写一个值，然后声称 QQ Bot 已生效」：
 * 官方 0.5.3 不 provide 任何服务，也没有第三方扩展点，所以只要没有
 * `qqbotMerge` 服务，本插件就不可能真正控制 QQ 运行时，页面必须如实说明。
 *
 * @module dsh-longterm-memory/host/qq/merge-bridge
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_QQBOT_MERGE_CONFIG,
  QQBOT_MERGE_BUSY_POLICIES,
  QQBOT_MERGE_REPLY_MODES,
  isMergeContractCompatible,
  normalizeMergeConfig,
  normalizeMaxBatchChars,
  normalizeMaxBatchMessages,
  normalizeMergeWindow,
  type QqbotMergeConfig,
  type QqbotMergeCounters,
  type QqbotMergeReport,
  type QqbotMergeService,
  type QqbotMergeStatus,
} from '../../shared/qqbot-merge-contract.js'
import { ERROR_CODES } from '../../shared/protocol.js'

/**
 * 桥自己的错误类型。
 *
 * 刻意不 import `ServiceError`：`core/service.ts` 会 import 本模块，两者共用类型
 * 会形成模块循环。Service 层负责把这里的错误翻译成 `ServiceError`（保留 code）。
 */
export class MergeBridgeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'MergeBridgeError'
    this.code = code
  }
}

/** 官方 QQ 插件的 npm 包名（用于版本探测）。 */
const OFFICIAL_PACKAGE = '@tencent-connect/dsh-qqbot'

/** 构造桥所需的依赖。 */
export interface MergeBridgeDeps {
  /** 当前 Profile 目录；用于只读探测官方插件版本。 */
  profileDir: () => string | null
  logger?: { warn: (message: string, ...rest: unknown[]) => void }
}

const EMPTY_COUNTERS: QqbotMergeCounters = {
  batchesMerged: 0,
  messagesSteered: 0,
  messagesFollowedUp: 0,
  messagesOverflowed: 0,
  steerFallbacks: 0,
  replyRewrites: 0,
  repliesCompleted: 0,
  batchesAborted: 0,
}

/**
 * 跨插件桥。
 *
 * `attach` 由 host/index.ts 在 `ctx.inject(['qqbotMerge'])` 命中时调用；未命中时
 * 桥保持未连接状态，报告 `available: false`。
 */
export class QqbotMergeBridge {
  private readonly deps: MergeBridgeDeps
  private service: QqbotMergeService | null = null
  /** 官方 QQ 插件版本缓存（探测失败为 null，不重试轰炸文件系统）。 */
  private officialVersion: string | null | undefined = undefined

  constructor(deps: MergeBridgeDeps) {
    this.deps = deps
  }

  /** 连接扩展提供的服务；服务缺席（undefined/null）是正常情况，不记警告。 */
  attach(candidate: unknown): void {
    if (candidate === null || candidate === undefined) return
    if (typeof candidate !== 'object') {
      this.deps.logger?.warn('dsh-longterm-memory: qqbotMerge 服务不是对象，已忽略')
      return
    }
    const record = candidate as Partial<QqbotMergeService>
    if (typeof record.getStatus !== 'function' || typeof record.getConfig !== 'function' || typeof record.setConfig !== 'function') {
      this.deps.logger?.warn('dsh-longterm-memory: qqbotMerge 服务缺少 getStatus/getConfig/setConfig，已忽略')
      return
    }
    this.service = record as QqbotMergeService
  }

  /** 是否已连接到一个支持合并的 QQ 扩展。 */
  isAttached(): boolean {
    return this.service !== null
  }

  /**
   * 生成给页面的报告。
   *
   * 未连接扩展时不会去读官方插件的内部状态、也不会伪造版本号：只做一次只读的
   * profile `package.json` 版本探测，读不到就返回 null。
   */
  async report(): Promise<QqbotMergeReport> {
    if (this.service === null) {
      const version = await this.detectOfficialVersion()
      return {
        available: false,
        reason:
          '当前运行的 QQ Bot 插件没有提供 qqbotMerge 服务：官方 @tencent-connect/dsh-qqbot 0.5.3 不注册任何 cordis 服务、也没有第三方扩展点，' +
          '它的「合并」只是把新消息排队到当前轮结束后的下一轮（concurrencyGuard strategy=merge），不是非打断式 steering。' +
          '要实现真正的连续消息智能合并，需要安装受支持的扩展包 dsh-qqbot-merge 并重启 DSH。',
        officialVersion: version,
      }
    }
    let raw: QqbotMergeStatus
    try {
      raw = this.service.getStatus()
    } catch (error) {
      return {
        available: false,
        reason: `读取 qqbotMerge 状态失败：${describeError(error)}`,
        officialVersion: await this.detectOfficialVersion(),
      }
    }
    const contract = isMergeContractCompatible(raw.contract)
    return {
      available: true,
      status: normalizeStatus(raw),
      compatible: contract.compatible,
      compatibilityNote: contract.note,
    }
  }

  /**
   * 把配置写入扩展，并返回写入后的真实状态。
   *
   * 这里先把 patch 归一化/校验，再整体交给扩展；扩展返回的状态才是「已生效」的
   * 证据（revision / appliedAt 由扩展维护）。
   */
  async setConfig(patch: Partial<QqbotMergeConfig>): Promise<QqbotMergeReport> {
    if (this.service === null) {
      throw new MergeBridgeError(
        ERROR_CODES.unsupported,
        '未连接到支持连续消息合并的 QQ Bot 扩展（qqbotMerge 服务不存在），本次修改不会被任何运行时读取，因此未保存。',
      )
    }
    const validated = validateMergePatch(patch)
    const current = normalizeMergeConfig(this.safeGetConfig())
    const merged: QqbotMergeConfig = { ...current, ...validated, scope: { ...current.scope, ...(validated.scope ?? {}) } }
    try {
      await this.service.setConfig(merged)
    } catch (error) {
      throw new MergeBridgeError(ERROR_CODES.internal, `写入 qqbotMerge 配置失败：${describeError(error)}`)
    }
    return this.report()
  }

  private safeGetConfig(): unknown {
    try {
      return this.service?.getConfig()
    } catch {
      return DEFAULT_QQBOT_MERGE_CONFIG
    }
  }

  /**
   * 只读探测官方 QQ 插件版本。
   *
   * 从当前 Profile 的 `package.json` 依赖表读取（不读凭据、不读 patch 文件），
   * 读不到就是 null。
   */
  private async detectOfficialVersion(): Promise<string | null> {
    if (this.officialVersion !== undefined) return this.officialVersion
    this.officialVersion = null
    const profileDir = this.deps.profileDir()
    if (profileDir === null) return this.officialVersion
    try {
      const text = await readFile(join(profileDir, 'package.json'), 'utf8')
      const parsed = JSON.parse(text) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
      const found = parsed.dependencies?.[OFFICIAL_PACKAGE] ?? parsed.devDependencies?.[OFFICIAL_PACKAGE]
      if (typeof found === 'string' && found.length > 0) this.officialVersion = found
    } catch (error) {
      this.deps.logger?.warn('dsh-longterm-memory: 无法读取 Profile 依赖表（%s），官方插件版本未知', describeError(error))
    }
    return this.officialVersion
  }
}

/** 归一化扩展上报的状态：未知字段一律回落安全默认值，不让页面渲染出脏数据。 */
export function normalizeStatus(raw: QqbotMergeStatus): QqbotMergeStatus {
  const runtime = raw.runtime !== null && typeof raw.runtime === 'object' ? raw.runtime : ({} as QqbotMergeStatus['runtime'])
  const applied = raw.applied !== null && typeof raw.applied === 'object' ? raw.applied : ({} as QqbotMergeStatus['applied'])
  const counters = raw.counters !== null && typeof raw.counters === 'object' ? raw.counters : EMPTY_COUNTERS
  return {
    contract: { name: String(raw.contract?.name ?? ''), version: Number(raw.contract?.version ?? 0) },
    config: normalizeMergeConfig(raw.config),
    applied: {
      revision: Number.isFinite(applied.revision) ? Number(applied.revision) : 0,
      appliedAt: typeof applied.appliedAt === 'string' ? applied.appliedAt : '',
      activeBatches: Number.isFinite(applied.activeBatches) ? Number(applied.activeBatches) : 0,
      pendingMessages: Number.isFinite(applied.pendingMessages) ? Number(applied.pendingMessages) : 0,
    },
    runtime: {
      steerSupported: runtime.steerSupported === true,
      steerMechanism: typeof runtime.steerMechanism === 'string' ? runtime.steerMechanism : '',
      integration: typeof runtime.integration === 'string' ? runtime.integration : '',
      streamingRevision: runtime.streamingRevision === true,
      note: typeof runtime.note === 'string' ? runtime.note : '',
    },
    counters: {
      batchesMerged: count(counters.batchesMerged),
      messagesSteered: count(counters.messagesSteered),
      messagesFollowedUp: count(counters.messagesFollowedUp),
      messagesOverflowed: count(counters.messagesOverflowed),
      steerFallbacks: count(counters.steerFallbacks),
      replyRewrites: count(counters.replyRewrites),
      repliesCompleted: count(counters.repliesCompleted),
      batchesAborted: count(counters.batchesAborted),
    },
    lastBatch: normalizeLastBatch(raw.lastBatch),
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
}

function normalizeLastBatch(value: unknown): QqbotMergeStatus['lastBatch'] {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const mode = record['mode'] === 'steer' ? 'steer' : 'followup'
  return {
    at: typeof record['at'] === 'string' ? record['at'] : '',
    sessionKey: typeof record['sessionKey'] === 'string' ? record['sessionKey'] : '',
    count: count(record['count']),
    chars: count(record['chars']),
    mode,
    ok: record['ok'] === true,
    ...(typeof record['error'] === 'string' && record['error'].length > 0 ? { error: record['error'] } : {}),
  }
}

/**
 * 校验并归一化一个配置 patch。
 *
 * 只允许契约里出现的字段；枚举值必须在白名单内；数值走归一化（限幅）。非法字段
 * 直接抛 `invalid-request`，避免把半截配置写进扩展。
 */
export function validateMergePatch(patch: Partial<QqbotMergeConfig>): Partial<QqbotMergeConfig> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new MergeBridgeError(ERROR_CODES.invalid, '合并配置必须是对象。')
  }
  const out: Partial<QqbotMergeConfig> = {}
  const record = patch as Record<string, unknown>
  if (record['enabled'] !== undefined) {
    if (typeof record['enabled'] !== 'boolean') throw new MergeBridgeError(ERROR_CODES.invalid, 'enabled 必须是布尔值。')
    out.enabled = record['enabled']
  }
  if (record['windowMs'] !== undefined) {
    if (typeof record['windowMs'] !== 'number' || !Number.isFinite(record['windowMs'])) {
      throw new MergeBridgeError(ERROR_CODES.invalid, 'windowMs 必须是数字。')
    }
    out.windowMs = normalizeMergeWindow(record['windowMs'])
  }
  if (record['maxBatchMessages'] !== undefined) {
    if (typeof record['maxBatchMessages'] !== 'number' || !Number.isFinite(record['maxBatchMessages'])) {
      throw new MergeBridgeError(ERROR_CODES.invalid, 'maxBatchMessages 必须是数字。')
    }
    out.maxBatchMessages = normalizeMaxBatchMessages(record['maxBatchMessages'])
  }
  if (record['maxBatchChars'] !== undefined) {
    if (typeof record['maxBatchChars'] !== 'number' || !Number.isFinite(record['maxBatchChars'])) {
      throw new MergeBridgeError(ERROR_CODES.invalid, 'maxBatchChars 必须是数字。')
    }
    out.maxBatchChars = normalizeMaxBatchChars(record['maxBatchChars'])
  }
  if (record['busyPolicy'] !== undefined) {
    if (!(QQBOT_MERGE_BUSY_POLICIES as readonly string[]).includes(record['busyPolicy'] as string)) {
      throw new MergeBridgeError(ERROR_CODES.invalid, `未知的 busyPolicy：${String(record['busyPolicy'])}`)
    }
    out.busyPolicy = record['busyPolicy'] as QqbotMergeConfig['busyPolicy']
  }
  if (record['replyMode'] !== undefined) {
    if (!(QQBOT_MERGE_REPLY_MODES as readonly string[]).includes(record['replyMode'] as string)) {
      throw new MergeBridgeError(ERROR_CODES.invalid, `未知的 replyMode：${String(record['replyMode'])}`)
    }
    out.replyMode = record['replyMode'] as QqbotMergeConfig['replyMode']
  }
  if (record['scope'] !== undefined) {
    const scope = record['scope']
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
      throw new MergeBridgeError(ERROR_CODES.invalid, 'scope 必须是对象。')
    }
    const scopeRecord = scope as Record<string, unknown>
    out.scope = {} as QqbotMergeConfig['scope']
    for (const key of ['c2c', 'group'] as const) {
      if (scopeRecord[key] === undefined) continue
      if (typeof scopeRecord[key] !== 'boolean') throw new MergeBridgeError(ERROR_CODES.invalid, `scope.${key} 必须是布尔值。`)
      out.scope[key] = scopeRecord[key] as boolean
    }
  }
  return out
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


