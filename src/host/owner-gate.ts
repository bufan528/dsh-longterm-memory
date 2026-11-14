/**
 * 统一 Owner-aware Memory Access 入口（WP-2A / R1 fail-closed）。
 *
 * tools / standing / per-step / turn 写回共用同一套
 * classify → decide 逻辑，避免复制导致语义漂移。
 *
 * **WP-2A-R1 契约：**
 * - 对存在 agent/session 的模型路径，**始终返回 OwnerAccessDecision**（不返回 null 跳过）。
 * - `allowed=false` = fail-closed 拒绝；仅 `trusted-pc` 正向证据或已绑定 QQ C2C 为 true。
 * - 服务缺失、sessionId 缺失、注册表失败、未登记会话 → 一律 DENY。
 * - 不存在「非 QQ → 跳过门禁」分支。
 *
 * @module dsh-longterm-memory/host/owner-gate
 */
import {
  classifySessionProvenance,
  decideByProvenance,
  type OwnerAccessDecision,
  type OwnerSourceView,
} from '../shared/owner-access.js'

/** qqbotContext 最小消费面。 */
export interface QqbotContextGateLike {
  getContext(sessionId: string): {
    platform: string
    conversationType: string
    isPrivate: boolean
    ownerId: string | null
    identified: boolean
  } | null
  /** 会话是否曾被 QQ 插件登记。缺省视为 false（未登记 ≠ 可信 PC）。 */
  isKnownQqSession?(sessionId: string): boolean
  /** KnownSessionRegistry 是否健康。缺省 true；false 时即使未登记也 DENY。 */
  isRegistryHealthy?(): boolean
}

export interface OwnerGateInput {
  sessionId: string | null | undefined
  explicitSessionId?: string | null
  /** Optional Host MessageSource (plugin-user) for provenance verify before identity gate. */
  hostSource?: { kind?: string; requestId?: string; producer?: { package?: string }; category?: string; attestation?: string } | null
  hostMessageId?: string
  hostText?: string
}

export interface OwnerGateOptions {
  /**
   * WP-NEXT-01E: QQ personal memory read/write stays OFF until WP-NEXT-01F.
   * Unit tests that omit this option keep historical ALLOW behavior for bound C2C.
   */
  qqPersonalMemory?: boolean
  /**
   * 显式「本机信任」模式（默认关闭，fail-closed 不变）。
   *
   * 单人本机场景下，桌面会话拿不到任何 live 来源（qqbotContext 只认识 QQ 会话），
   * 而宿主虽然会为桌面消息登记 desktop-owner 凭据（`verifyDesktop`），那份凭据是
   * **按消息**的，常驻注入这条读路径拿不到 messageId，因此无法据此放行。
   *
   * 打开后，只有「没有 live 来源、且不属于任何已知 QQ 会话、且 QQ 注册表健康」
   * 的会话才按本机会话放行。以下三类**始终**拒绝，开关不覆盖：
   *  - 已知 QQ 会话但 live 来源消失（qq-missing，异常而非本机）；
   *  - 注册表读取失败（unknown 里可能藏着 QQ 会话）；
   *  - live 来源存在但平台不可识别（是我们不理解的通道，不是「没有通道」）。
   */
  trustLocalSessions?: boolean
  /** Host ingress for provenance verify when hostSource is plugin-user. */
  getIngress?: () => {
    verify?: (input: {
      messageId: string
      sessionId: string
      text: string
      source: unknown
    }) => { ok: boolean; reason: string }
  } | undefined
}

function deny(reason: string): OwnerAccessDecision {
  return { allowed: false, reason, ownerId: null, channel: 'unknown' }
}

/** 本机信任模式放行：ownerId 为 null（本机会话没有 QQ Owner 身份）。 */
function allowLocal(reason: string): OwnerAccessDecision {
  return { allowed: true, reason, ownerId: null, channel: 'desktop' }
}

/**
 * 构建绑定到 ctx 的 Owner 门禁。
 *
 * @param getContextService - 每次调用时解析 qqbotContext（可热插拔）
 * @returns 始终给出 ALLOW/DENY 决策，**不**用 null 表示放行。
 */
export function createOwnerGate(
  getContextService: () => QqbotContextGateLike | undefined,
  options?: OwnerGateOptions,
) {
  const qqPersonalMemory = options?.qqPersonalMemory !== false
  const getIngress = options?.getIngress
  const trustLocal = options?.trustLocalSessions === true
  return function ownerGate(input: OwnerGateInput): OwnerAccessDecision {
    try {
      const sessionId = input.sessionId ?? input.explicitSessionId ?? null
      const qq = getContextService()

      // Host Provenance BEFORE identity gate when plugin-user source is present.
      if (input.hostSource && input.hostSource.kind === 'plugin-user') {
        const ingress = getIngress?.()
        if (!ingress || typeof ingress.verify !== 'function') {
          return deny('host provenance verify unavailable，拒绝个人记忆访问')
        }
        const v = ingress.verify({
          messageId: input.hostMessageId ?? '',
          sessionId: sessionId ?? '',
          text: input.hostText ?? '',
          source: input.hostSource,
        })
        if (!v.ok) {
          return deny(`host provenance failed: ${v.reason}`)
        }
      }

      // R2：服务缺失 / getContext 不可用 → 无独立可信 PC 证明 → DENY
      if (!qq || typeof qq.getContext !== 'function') {
        // PC-only 安装没有 QQ 插件，也就没有 QQ 会话可言：本机信任模式下放行。
        if (trustLocal && sessionId !== null && sessionId.length > 0) {
          return allowLocal('本机信任模式：无 QQ 身份服务，按本机会话处理')
        }
        return deny('QQ 身份服务缺失，无独立可信 PC 证明，拒绝个人记忆访问')
      }

      if (!sessionId) {
        return deny('无法定位会话，缺少来源证明，拒绝个人记忆访问')
      }

      let raw: ReturnType<QqbotContextGateLike['getContext']>
      try {
        raw = qq.getContext(sessionId)
      } catch {
        return deny('来源查询失败，拒绝个人记忆访问')
      }

      // A source object exists but is malformed (no `platform`) is *not* the same
      // as having no source: it is a service that answered something we do not
      // understand. That must never be promoted to "local" by the trust switch.
      const hasRawSource = raw !== null && raw !== undefined
      const source: OwnerSourceView | null =
        raw !== null && raw !== undefined && typeof raw.platform === 'string'
          ? {
              platform: raw.platform,
              conversationType: raw.conversationType,
              isPrivate: raw.isPrivate,
              ownerId: raw.ownerId,
              identified: raw.identified,
            }
          : null

      const knownQqSession =
        typeof qq.isKnownQqSession === 'function' ? qq.isKnownQqSession(sessionId) : false
      const registryHealthy =
        typeof qq.isRegistryHealthy === 'function' ? qq.isRegistryHealthy() : true

      const provenance = classifySessionProvenance({
        serviceAvailable: true,
        source,
        knownQqSession,
        registryHealthy,
      })

      // 本机信任模式只补「没有 live 来源」这一格。
      // 已知 QQ 会话（qq-missing）、注册表异常、以及平台不可识别的 live 来源
      // 都不在此列：那三种情况分别意味着异常、不可信、和「我们不认识的通道」。
      if (
        trustLocal
        && provenance.kind === 'unknown'
        && !hasRawSource
        && !knownQqSession
        && registryHealthy
      ) {
        return allowLocal('本机信任模式：会话无 live 来源且不属于任何已知 QQ 会话，按本机会话处理')
      }
      // WP-NEXT-01E: QQ personal memory disabled until WP-NEXT-01F canary.
      // trusted-pc (Desktop) path is unaffected.
      if (provenance.kind === 'qq' && !qqPersonalMemory) {
        return deny('QQ 个人记忆读写未启用（WP-NEXT-01E），拒绝访问')
      }
      return decideByProvenance(provenance)
    } catch {
      return deny('Owner 门禁异常，拒绝个人记忆访问')
    }
  }
}

/** OwnerGate 回调类型（与 tools.ts 对齐；始终返回 decision）。 */
export type OwnerGateForAgentFn = (agent: unknown) => OwnerAccessDecision

/** 从 agent 对象提取 sessionId（session.id 或 header.id）。 */
export function sessionIdOfAgent(agent: unknown): string | null {
  if (agent === null || typeof agent !== 'object') return null
  const session =
    (agent as { session?: unknown }).session !== undefined
      ? (agent as { session: unknown }).session
      : agent
  if (session === null || typeof session !== 'object') return null
  const direct = (session as { id?: unknown }).id
  if (typeof direct === 'string' && direct.length > 0) return direct
  const header = (session as { header?: unknown }).header
  if (header !== null && typeof header === 'object') {
    const hid = (header as { id?: unknown }).id
    if (typeof hid === 'string' && hid.length > 0) return hid
  }
  return null
}
