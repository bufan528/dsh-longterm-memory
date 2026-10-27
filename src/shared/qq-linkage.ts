/**
 * QQ 接入 ↔ 长期记忆联动的共享契约。
 *
 * 这一层只放「纯数据 + 纯函数」：配置形状、会话事实读取、来源判定、以及
 * 三个执行点（常驻记忆注入 / 每步检索 / 会话结束写回）的决策函数。客户端页面
 * 用同一套函数把「若现在执行会怎样」展示给用户，宿主端用它们做真正的后端拦截，
 * 所以页面上的开关与后端的执行结果不可能不一致。
 *
 * 重要事实（见 docs/evidence/qq-official-plugin.md 与
 * docs/evidence/dsh-host-0.2.1-rc.3.md）：
 *
 * 1. 官方 QQ 插件（@tencent-connect/dsh-qqbot 0.5.2，cordis name `im-qqbot`）
 *    不注册任何 cordis 服务，因此不存在「问它 QQ 侧状态」的跨插件接口。
 * 2. 它创建 DSH 会话时只写 `meta: { cwd, agentPreset? }`，不写来源标记；
 *    但 DSH 的会话 header 支持 `origin` / `agentPreset` / `cwd` / `parentSession`
 *    四个可验证字段（@deepseek-ai/dsh-session 的 SessionStore.prepare）。
 * 3. 因此「哪些会话来自 QQ」只能在用户显式声明标记（origin / preset / cwd）
 *    之后才可判定；没有声明时一律是 `unidentified`，绝不猜测。
 *
 * @module dsh-longterm-memory/shared/qq-linkage
 */

/** 联动保护模式。 */
export const QQ_LINKAGE_MODES = ['off', 'deny-qq', 'allowlist'] as const

export type QqLinkageMode = (typeof QQ_LINKAGE_MODES)[number]

/** QQ 会话产生的候选记忆如何处理。 */
export const QQ_WRITE_MODES = ['inbox-only', 'direct'] as const

export type QqWriteMode = (typeof QQ_WRITE_MODES)[number]

/** 用于识别会话归属的标记集合。 */
export interface SessionMarkers {
  /** `session.header.origin` 的精确值。 */
  origins: string[]
  /** `session.header.agentPreset` 的精确值。 */
  presets: string[]
  /** `session.header.cwd` 的绝对路径；Windows 下大小写不敏感。 */
  cwds: string[]
}

/** QQ 接入与长期记忆的联动配置（保存在 Vault 的既有设置里，不新建数据库）。 */
export interface QqLinkageConfig {
  /**
   * `off`：不拦截，保持与未接入 QQ 时完全相同的既有行为。
   * `deny-qq`：命中 QQ 标记的会话不读取记忆、不直接写回记忆。
   * `allowlist`：只有命中「受信标记」的会话才读取记忆，其余（含 QQ 与未识别）一律不读。
   */
  mode: QqLinkageMode
  /** 判定为 QQ 会话的标记。 */
  qqMarkers: SessionMarkers
  /** `allowlist` 模式下判定为受信（本机桌面）会话的标记。 */
  trustedMarkers: SessionMarkers
  /** QQ 会话写回候选记忆的方式。 */
  writeMode: QqWriteMode
  /** 是否允许 QQ 会话调用模型的记忆工具。 */
  allowTools: boolean
}

export const EMPTY_MARKERS: SessionMarkers = { origins: [], presets: [], cwds: [] }

/**
 * 默认值刻意选择「保持现状」：`mode: 'off'` 时本插件的行为与未接入 QQ 时
 * 完全一致，不会因为一次升级而改变既有用户的记忆注入结果。
 */
export const DEFAULT_QQ_LINKAGE: QqLinkageConfig = {
  mode: 'off',
  qqMarkers: EMPTY_MARKERS,
  trustedMarkers: EMPTY_MARKERS,
  writeMode: 'inbox-only',
  allowTools: false,
}

/** 从 DSH 会话/Agent 上能可靠读到的字段。读不到的一律为 `null`。 */
export interface SessionFacts {
  sessionId: string | null
  cwd: string | null
  origin: string | null
  agentPreset: string | null
  parentSession: string | null
}

/** 会话归属判定结果。 */
export type ChannelKind = 'qq' | 'trusted' | 'unidentified'

/** 判定所依据的标记种类。 */
export type MarkerKind = 'origin' | 'preset' | 'cwd'

export interface Provenance {
  channel: ChannelKind
  /** 命中的标记种类；未命中为 `null`。 */
  matchedBy: MarkerKind | null
  /** 命中的标记值；未命中为 `null`。 */
  marker: string | null
  /** 人类可读的判定理由，页面直接展示。 */
  reason: string
}

/** 三个执行点。 */
export type EnforcementPoint = 'standing' | 'recall' | 'write' | 'tools'

/** 一个执行点的决策结果。 */
export interface LinkageDecision {
  /** 该执行点是否允许继续（写回点表示「是否允许直接落盘」）。 */
  allowed: boolean
  channel: ChannelKind
  reason: string
}

const CHANNEL_LABEL: Record<ChannelKind, string> = {
  qq: 'QQ 会话',
  trusted: '受信会话',
  unidentified: '未识别来源的会话',
}

const MODE_LABEL: Record<QqLinkageMode, string> = {
  off: '联动保护未启用',
  'deny-qq': '已启用：拒绝 QQ 会话读取记忆',
  allowlist: '已启用：仅受信会话可读取记忆',
}

export function channelLabel(channel: ChannelKind): string {
  return CHANNEL_LABEL[channel]
}

export function modeLabel(mode: QqLinkageMode): string {
  return MODE_LABEL[mode]
}

/** 归一化 cwd：去尾部分隔符，Windows 下统一大小写。 */
export function normalizeCwd(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '')
  return /^[a-zA-Z]:/.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

function readField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

function readString(value: unknown, key: string): string | null {
  const found = readField(value, key)
  return typeof found === 'string' && found.length > 0 ? found : null
}

function nonEmptyArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

/**
 * 从「Agent / Session / 会话 header」中的任意一个已知形状里读取会话事实。
 *
 * 宿主在三个执行点给出的对象形状不同（`context.agent`、`session/event` 的
 * session、工具执行上下文里的 `exec.agent`），这里统一兼容，读不到就返回
 * `null`，绝不用默认值假装读到了。
 */
export function readSessionFacts(candidate: unknown): SessionFacts {
  const direct = candidate !== null && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : null
  const session =
    readField(direct, 'session') !== undefined ? readField(direct, 'session') : direct
  const header = readField(session, 'header')
  // 三种已知形状都要能读：`{ agent: { session: { header } } }`、
  // `{ session: { header } }`、以及 header 对象本身直接传。字段优先取
  // `session.header`，再回落到会话对象自身——DSH 的 `Session` 把 id/cwd 等放在
  // header 上，但调用方也可能只交出 header。
  const facts: SessionFacts = {
    sessionId:
      readString(session, 'id') ??
      readString(direct, 'id') ??
      readString(header, 'id'),
    cwd: readString(header, 'cwd') ?? readString(session, 'cwd'),
    origin: readString(header, 'origin') ?? readString(session, 'origin'),
    agentPreset: readString(header, 'agentPreset') ?? readString(session, 'agentPreset'),
    parentSession: readString(header, 'parentSession') ?? readString(session, 'parentSession'),
  }
  return facts
}

function matchMarkers(markers: SessionMarkers, facts: SessionFacts): { kind: MarkerKind; marker: string } | null {
  const origin = facts.origin
  for (const marker of nonEmptyArray(markers.origins)) {
    if (origin !== null && origin === marker) return { kind: 'origin', marker }
  }
  const preset = facts.agentPreset
  for (const marker of nonEmptyArray(markers.presets)) {
    if (preset !== null && preset === marker) return { kind: 'preset', marker }
  }
  const cwd = facts.cwd
  if (cwd !== null) {
    const normalized = normalizeCwd(cwd)
    for (const marker of nonEmptyArray(markers.cwds)) {
      if (normalized === normalizeCwd(marker)) return { kind: 'cwd', marker }
    }
  }
  return null
}

/** 标记是否完全为空（此时无法识别任何来源）。 */
export function markersEmpty(markers: SessionMarkers): boolean {
  return nonEmptyArray(markers.origins).length === 0 && nonEmptyArray(markers.presets).length === 0 && nonEmptyArray(markers.cwds).length === 0
}

function describeMatch(kind: MarkerKind, marker: string): string {
  const field = kind === 'origin' ? '会话 origin' : kind === 'preset' ? '会话 agentPreset' : '会话 cwd'
  return `${field} 命中标记「${marker}」`
}

/**
 * 判定会话归属。
 *
 * QQ 标记优先于受信标记：同时命中时按 QQ 处理，宁可收紧也不放宽。
 */
export function classifyProvenance(facts: SessionFacts, config: QqLinkageConfig): Provenance {
  const qq = matchMarkers(config.qqMarkers, facts)
  if (qq !== null) {
    return { channel: 'qq', matchedBy: qq.kind, marker: qq.marker, reason: describeMatch(qq.kind, qq.marker) }
  }
  const trusted = matchMarkers(config.trustedMarkers, facts)
  if (trusted !== null) {
    return { channel: 'trusted', matchedBy: trusted.kind, marker: trusted.marker, reason: describeMatch(trusted.kind, trusted.marker) }
  }
  return {
    channel: 'unidentified',
    matchedBy: null,
    marker: null,
    reason: '会话 header 中没有可与标记匹配的 origin/agentPreset/cwd',
  }
}

function decision(allowed: boolean, channel: ChannelKind, reason: string): LinkageDecision {
  return { allowed, channel, reason }
}

/**
 * 读取类执行点（常驻记忆注入、每步检索）的决策。
 *
 * - `off`：一律放行（既有行为不变）。
 * - `deny-qq`：QQ 会话被拒绝，其余放行。
 * - `allowlist`：只有 `trusted` 放行；QQ 与未识别一律拒绝。
 */
export function decideRead(provenance: Provenance, config: QqLinkageConfig): LinkageDecision {
  const channel = provenance.channel
  if (config.mode === 'off') {
    return decision(true, channel, `${MODE_LABEL.off}：不拦截任何会话`)
  }
  if (config.mode === 'deny-qq') {
    if (channel === 'qq') {
      return decision(false, channel, `${CHANNEL_LABEL.qq}命中 QQ 标记，按「拒绝 QQ 读取」策略不注入记忆（${provenance.reason}）`)
    }
    return decision(true, channel, `${CHANNEL_LABEL[channel]}不是 QQ 会话，允许读取记忆`)
  }
  if (channel === 'trusted') {
    return decision(true, channel, `${CHANNEL_LABEL.trusted}命中受信标记，允许读取记忆（${provenance.reason}）`)
  }
  return decision(
    false,
    channel,
    channel === 'qq'
      ? `${CHANNEL_LABEL.qq}在「仅受信会话」模式下不允许读取记忆（${provenance.reason}）`
      : '未识别来源的会话在「仅受信会话」模式下默认拒绝读取记忆',
  )
}

/** 写回类执行点（会话结束提取候选记忆）的决策：是否允许直接落盘。 */
export function decideWrite(provenance: Provenance, config: QqLinkageConfig): LinkageDecision {
  const channel = provenance.channel
  if (config.mode === 'off') {
    return decision(true, channel, `${MODE_LABEL.off}：写回方式沿用既有规则`)
  }
  if (channel !== 'qq') {
    if (config.mode === 'allowlist' && channel === 'unidentified') {
      return decision(false, channel, '未识别来源的会话在「仅受信会话」模式下一律只进收件箱，不直接落盘')
    }
    return decision(true, channel, `${CHANNEL_LABEL[channel]}不属于 QQ，写回方式沿用既有规则`)
  }
  if (config.writeMode === 'inbox-only') {
    return decision(false, channel, `${CHANNEL_LABEL.qq}的候选记忆只进入收件箱，等待人工确认`)
  }
  return decision(true, channel, `${CHANNEL_LABEL.qq}的候选记忆允许按既有规则直接落盘`)
}

/** 模型工具执行点的决策。 */
export function decideTools(provenance: Provenance, config: QqLinkageConfig): LinkageDecision {
  const channel = provenance.channel
  if (config.mode === 'off') return decision(true, channel, `${MODE_LABEL.off}：工具不拦截`)
  if (channel !== 'qq') {
    if (config.mode === 'allowlist' && channel === 'unidentified') {
      return decision(false, channel, '未识别来源的会话不允许调用记忆工具')
    }
    return decision(true, channel, `${CHANNEL_LABEL[channel]}不属于 QQ，工具可用`)
  }
  if (config.allowTools) return decision(true, channel, `已允许 QQ 会话调用记忆工具`)
  return decision(false, channel, `QQ 会话不允许调用记忆工具（${provenance.reason}）`)
}

/** 判断配置是否被真正执行（供页面如实显示，而不是只显示开关）。 */
export interface LinkageRuntimeStatus {
  mode: QqLinkageMode
  /** 策略是否处于会改变运行行为的状态。 */
  enforcing: boolean
  /** QQ 标记是否已配置，未配置则 QQ 会话无法被识别。 */
  qqIdentifiable: boolean
  /**
   * 是否**已观测到**宿主在为常驻提示词分区求值时传入会话上下文。
   * 只有为 `true` 时，常驻记忆注入才真的能按会话拦截。
   */
  sessionAwareStanding: boolean
  notes: string[]
}

/**
 * 汇总「这套策略在运行时到底能做到什么」。
 *
 * `sessionAwareStanding` 由宿主端上报：只有当 `ctx.systemPrompt.section()` 的
 * `text` 被宿主以 `{ agent, scope }` 调用时，常驻记忆注入才可能按会话拦截；
 * 未观测到时页面必须如实说明该执行点尚未获得验证。
 */
export function describeLinkageRuntime(config: QqLinkageConfig, sessionAwareStanding: boolean): LinkageRuntimeStatus {
  const notes: string[] = []
  const enforcing = config.mode !== 'off'
  const qqIdentifiable = !markersEmpty(config.qqMarkers)
  if (!enforcing) notes.push('联动保护未启用：本插件的行为与未接入 QQ 时完全相同。')
  if (enforcing && !qqIdentifiable) {
    notes.push('尚未配置 QQ 标记：没有任何会话会被识别为 QQ，因此「拒绝 QQ」策略暂时不会命中任何会话。')
  }
  if (enforcing && config.mode === 'allowlist' && markersEmpty(config.trustedMarkers)) {
    notes.push('「仅受信会话」模式需要配置受信标记；未配置时所有会话都会被拒绝读取记忆。')
  }
  if (!sessionAwareStanding && enforcing) {
    notes.push(
      '尚未观测到宿主为常驻提示词分区传入会话上下文：在首次模型回合确认之前，常驻记忆注入无法按会话拦截（每步检索与工具拦截不受影响）。',
    )
  }
  if (config.writeMode === 'inbox-only') notes.push('QQ 会话产生的候选记忆只进收件箱，需要人工确认后才成为长期记忆。')
  return { mode: config.mode, enforcing, qqIdentifiable, sessionAwareStanding, notes }
}

/** 归一化一份可能来自 HTTP / 旧配置 / 磁盘的联动配置。 */
export function normalizeQqLinkage(input: unknown): QqLinkageConfig {
  const record = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const mode = record['mode']
  const writeMode = record['writeMode']
  return {
    mode: (QQ_LINKAGE_MODES as readonly string[]).includes(mode as string) ? (mode as QqLinkageMode) : DEFAULT_QQ_LINKAGE.mode,
    qqMarkers: normalizeMarkers(record['qqMarkers']),
    trustedMarkers: normalizeMarkers(record['trustedMarkers']),
    writeMode: (QQ_WRITE_MODES as readonly string[]).includes(writeMode as string) ? (writeMode as QqWriteMode) : DEFAULT_QQ_LINKAGE.writeMode,
    allowTools: record['allowTools'] === true,
  }
}

/** 归一化一组标记：去空、去重、限长。 */
export function normalizeMarkers(input: unknown): SessionMarkers {
  const record = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return {
    origins: normalizeList(record['origins']),
    presets: normalizeList(record['presets']),
    cwds: normalizeList(record['cwds']),
  }
}

const MAX_MARKERS = 32
const MAX_MARKER_LENGTH = 260

function normalizeList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of input) {
    if (typeof entry !== 'string') continue
    const value = entry.trim()
    if (value.length === 0 || value.length > MAX_MARKER_LENGTH) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= MAX_MARKERS) break
  }
  return out
}
