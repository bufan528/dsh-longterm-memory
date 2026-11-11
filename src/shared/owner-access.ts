/**
 * 跨端 Owner 记忆访问判定（纯函数，fail-closed）。
 *
 * 最终权限矩阵（WP-2A-R1，不得放宽）：
 * | 情况                                    | 决策   |
 * |-----------------------------------------|--------|
 * | 有可靠正向证据的可信 PC（live platform∈TRUSTED_PC） | ALLOW |
 * | 已绑定 QQ C2C                           | ALLOW  |
 * | 未绑定 QQ C2C                           | DENY   |
 * | QQ 群聊                                 | DENY   |
 * | 已登记 QQ Session 但 live 上下文消失     | DENY   |
 * | 未知来源                                | DENY   |
 * | 来源缺失                                | DENY   |
 * | QQ 服务缺失且无独立可信 PC 证明          | DENY   |
 * | 注册表读取失败                          | DENY   |
 * | OwnerBinding 不存在 / 解绑              | DENY   |
 * | 解绑后旧 QQ Session / 缓存上下文        | DENY   |
 *
 * 关键裁定（WP-2A-R1）：
 * - 「不在 KnownSessionRegistry」≠ 可信 PC → 只能是 Unknown → DENY。
 * - 「qqbotContext 服务缺失」≠ 可信 PC → Missing provenance → DENY。
 *   （当前代码库**没有**独立可信 PC 正向证明机制，见交付报告。）
 * - 不依赖 SessionHeader.origin（ADR-008）。
 * - 不将 Unknown 重映射为 trusted-pc。
 *
 * @module dsh-longterm-memory/shared/owner-access
 */

import {
  CHANNEL_VISIBILITIES,
  isMemoryChannel,
  type MemoryChannel,
  type MemoryVisibility,
} from './types.js'

/** 与 qqbotContext 对齐的最小来源视图。 */
export interface OwnerSourceView {
  platform: string
  conversationType: string
  isPrivate: boolean
  /** 绑定后的 Owner UUID；未绑定为 null。 */
  ownerId: string | null
  identified: boolean
}

/**
 * 门禁决策。
 *
 * 判别联合而非可选字段：`allowed: true` 时**必然**带一个合法 `channel`，
 * 因此上层构造可见性过滤时不需要再判空。反过来，`allowed: false` 时
 * `channel` 只能是 `unknown`，不存在「拒绝但仍有渠道」的中间态。
 */
export type OwnerAccessDecision =
  | { allowed: true; reason: string; ownerId: string | null; channel: MemoryChannel }
  | { allowed: false; reason: string; ownerId: null; channel: 'unknown' }

/** 会话来源分类（进入决策前的归类）。 */
export type SessionProvenance =
  /**
   * 已证明本机会话：**仅** live source.platform ∈ TRUSTED_PC_PLATFORMS。
   * （当前代码库无 producer；见报告。不得用「非 QQ」代替。）
   */
  | { kind: 'trusted-pc' }
  /** live QQ 来源。 */
  | { kind: 'qq'; source: OwnerSourceView }
  /** 已登记 QQ 会话但缺少 live 来源（重启/HMR/sources 丢失）。 */
  | { kind: 'qq-missing' }
  /** 服务缺失、来源缺失、注册表失败、未登记会话、字段矛盾。 */
  | { kind: 'unknown'; reason?: string }

function deny(reason: string): OwnerAccessDecision {
  return { allowed: false, reason, ownerId: null, channel: 'unknown' }
}

function allow(ownerId: string | null, reason: string, channel: MemoryChannel): OwnerAccessDecision {
  return { allowed: true, reason, ownerId, channel }
}

/**
 * 受信本机 PC 的 **live source.platform** 白名单。
 *
 * 仅当 qqbotContext.getContext 或等价可信路径**主动声明** platform 为下列值
 * 时才构成正向证据。不存在 producer 时本白名单不会命中。
 */
const TRUSTED_PC_PLATFORMS = new Set(['desktop', 'pc', 'local', 'trusted-pc'])

export interface ClassifyInput {
  /**
   * 宿主是否提供可用的 qqbotContext（getContext 可调用）。
   * false = 服务缺失/注册失败/不可用 → **不得**视为可信 PC。
   */
  serviceAvailable: boolean
  source: OwnerSourceView | null
  /** sessionId 是否曾被 QQ 插件登记（sources ∪ 持久化清单）。 */
  knownQqSession: boolean
  /**
   * KnownSessionRegistry 是否健康（文件可读且格式有效）。
   * false = 注册表读取失败 → 即使 known=false 也不可信。
   * 缺省 true（调用方未提供健康信息时按健康处理；未登记仍归 Unknown）。
   */
  registryHealthy?: boolean
}

/**
 * 归类会话来源（fail-closed）。
 *
 * R1：未登记 → Unknown，不是 trusted-pc。
 * R2：服务缺失 → Unknown/Missing，不是 trusted-pc。
 * R3：仅 live TRUSTED_PC_PLATFORMS 或 live 已绑定 QQ C2C 可 ALLOW。
 */
export function classifySessionProvenance(input: ClassifyInput): SessionProvenance {
  // R2：服务缺失 / 不可用 — 无独立可信 PC 证明 → 拒绝路径
  if (!input.serviceAvailable) {
    return { kind: 'unknown', reason: 'QQ 身份服务缺失，无独立可信 PC 证明' }
  }

  const source = input.source
  if (source !== null) {
    if (source.platform === 'qq') {
      return { kind: 'qq', source }
    }
    // 唯一正向 PC 证据：live source 显式声明受信平台
    if (TRUSTED_PC_PLATFORMS.has(source.platform)) {
      return { kind: 'trusted-pc' }
    }
    return { kind: 'unknown', reason: `来源平台「${source.platform || 'empty'}」不可识别` }
  }

  // 无 live 来源
  // 已登记（sources 或清单）→ 缺 live 来源必须拒（清单文件健康与否不改变该结论）
  if (input.knownQqSession) {
    return { kind: 'qq-missing' }
  }

  // 注册表损坏/读取失败 — 不得信任 known=false → Unknown
  const registryHealthy = input.registryHealthy !== false
  if (!registryHealthy) {
    return { kind: 'unknown', reason: '会话注册表读取失败，无法确认来源' }
  }

  // R1：未登记 ≠ 可信 PC → Unknown（禁止 trusted-pc）
  return { kind: 'unknown', reason: '会话无 live 来源且未登记为 QQ，亦无可信 PC 正向证明' }
}

/**
 * 按来源分类执行 Owner 决策。
 * trusted-pc → allow；qq → 矩阵；qq-missing/unknown → deny。
 */
export function decideByProvenance(provenance: SessionProvenance): OwnerAccessDecision {
  switch (provenance.kind) {
    case 'trusted-pc':
      return allow(null, '已证明本机会话（正向证据），允许个人记忆', 'desktop')
    case 'qq':
      return decideOwnerMemoryAccess(provenance.source)
    case 'qq-missing':
      return deny('已登记 QQ 会话缺少实时来源，拒绝个人记忆访问')
    case 'unknown':
      return deny(provenance.reason ?? '来源无法识别，拒绝个人记忆访问')
  }
}

/**
 * 判定是否可读取/写入 Owner 个人记忆（直接给 source 时的入口）。
 *
 * - `null` / 缺失来源 → 拒绝；
 * - 非 QQ 且非 live TRUSTED_PC 白名单 → 拒绝；
 * - 受信 PC（live 白名单）→ 允许；
 * - QQ 群聊 → 拒绝；
 * - QQ 私聊未绑定 / 未确认 → 拒绝；
 * - QQ 私聊已绑定 → 允许。
 */
export function decideOwnerMemoryAccess(source: OwnerSourceView | null | undefined): OwnerAccessDecision {
  if (source === null || source === undefined) {
    return deny('缺少来源证明，拒绝个人记忆访问')
  }

  const platform = source.platform

  if (platform !== 'qq') {
    if (TRUSTED_PC_PLATFORMS.has(platform)) {
      return allow(source.ownerId, '受信 PC 来源（正向证据），允许个人记忆', 'desktop')
    }
    return deny(`未知来源平台「${platform || 'empty'}」，拒绝个人记忆访问`)
  }

  // platform === 'qq' — ownerBinding 解绑后 live ownerId 必为 null → 拒绝
  if (source.conversationType === 'group' || source.isPrivate === false) {
    return deny('QQ 群聊默认拒绝个人记忆访问')
  }
  if (!source.identified) {
    return deny('QQ 来源未确认，拒绝个人记忆访问')
  }
  if (!source.ownerId) {
    return deny('QQ 账号未绑定 Owner，拒绝个人记忆访问')
  }
  return allow(source.ownerId, 'QQ 已绑定 Owner，允许对应个人记忆', 'qq')
}

/**
 * 是否需要进入 Owner 门禁。
 *
 * WP-2A-R1：**任何**非 trusted-pc 的分类都必须过门禁（含服务缺失）。
 * trusted-pc 仅来自 live TRUSTED_PC 白名单（当前无 producer 时不会出现）。
 * 返回 true 时调用方必须执行 decideByProvenance，不得跳过到旧 linkage。
 */
export function requiresOwnerGate(input: ClassifyInput): boolean {
  const provenance = classifySessionProvenance(input)
  return provenance.kind !== 'trusted-pc'
}

/**
 * 把门禁决策翻译成检索层的可见范围数组。
 *
 * 这是身份层与检索层之间**唯一**的桥。检索层只收到一个字符串数组，
 * 既不知道调用者是谁，也没有能力扩大它——D1 建立的「recall 签名不含
 * sessionId/ctx」这一不变式因此得以保持。
 *
 * 拒绝时返回**空数组**而不是 `undefined`：在 `QueryFilters` 里
 * `undefined` 表示「不做范围限制」（浏览整个仓库），空数组表示
 * 「一条都读不到」。把两者混同就是 fail-open，所以这里必须显式返回空。
 */
export function visibilitiesFor(decision: OwnerAccessDecision): MemoryVisibility[] {
  if (!decision.allowed) return []
  // Runtime guard, not a type-level one: `allowed` and a concrete channel are
  // coupled by the union, but a gate instance produced outside this build (older
  // plugin copy, or a caller casting through `any`) can still hand back
  // `allowed: true` with no channel. Indexing the table with `undefined` would
  // throw a TypeError inside the retrieval path; failing closed to "nothing
  // readable" keeps an unknown channel from ever widening access.
  if (!isMemoryChannel(decision.channel)) return []
  return [...CHANNEL_VISIBILITIES[decision.channel]]
}
