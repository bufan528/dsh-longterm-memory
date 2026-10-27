/**
 * QQ 接入联动的**宿主端运行时**。
 *
 * 这里把 `shared/qq-linkage.ts` 的纯判定函数接到真实的四个执行点上，并记录
 * 「策略确实跑过」的证据（拦截计数 + 最近会话判定样本），供管理页面的诊断区
 * 如实展示。它是唯一持有可变状态的地方：判定函数本身保持纯函数，因此页面
 * 预览与后端执行结果不会分叉。
 *
 * 设计上的两条硬规则：
 *
 * 1. 读不到会话事实时，一律按「未识别来源」处理，绝不猜测来源。
 * 2. 判定结果只收紧、不放宽：QQ 标记优先于受信标记，未知会话在 `allowlist`
 *    模式下被拒绝。
 *
 * @module dsh-longterm-memory/host/qq/linkage
 */

import {
  channelLabel,
  classifyProvenance,
  decideRead as evaluateReadPolicy,
  decideTools as evaluateToolPolicy,
  decideWrite as evaluateWritePolicy,
  describeLinkageRuntime,
  readSessionFacts,
  type LinkageDecision,
  type LinkageRuntimeStatus,
  type Provenance,
  type QqLinkageConfig,
  type SessionFacts,
} from '../../shared/qq-linkage.js'
import type {
  QqEnforcementReport,
  QqLinkageCounters,
  QqLinkageReport,
  QqHostFacts,
  QqSessionSample,
} from '../../shared/protocol.js'

/** 最多保留的最近会话判定样本数。 */
const MAX_SAMPLES = 20

/** 构造运行时所需的依赖。 */
export interface LinkageRuntimeDeps {
  /** 读取**当前生效**的联动配置（设置变更后立刻可见，无需重建运行时）。 */
  config: () => QqLinkageConfig
  /** 日志出口；缺失时静默。 */
  logger?: { warn: (message: string, ...rest: unknown[]) => void }
}

/** 一次判定的完整结果，供调用点与诊断共用。 */
export interface LinkageVerdict {
  facts: SessionFacts
  provenance: Provenance
  decision: LinkageDecision
}

function emptyCounters(): QqLinkageCounters {
  return { standingBlocked: 0, recallBlocked: 0, writesForcedInbox: 0, toolsBlocked: 0 }
}

function emptyEnforcement(): QqEnforcementReport {
  return { standing: false, perStepRecall: false, extraction: false, tools: false, registeredTools: [], notes: {} }
}

/**
 * 联动运行时。
 *
 * 生命周期与插件进程一致：计数与样本都是进程内的，重启归零，不写任何文件。
 */
export class QqLinkageRuntime {
  private readonly deps: LinkageRuntimeDeps
  private counters: QqLinkageCounters = emptyCounters()
  private enforcement: QqEnforcementReport = emptyEnforcement()
  private readonly samples = new Map<string, QqSessionSample>()
  /** 是否已观测到宿主在求值提示词分区时传入会话上下文。 */
  private standingContextProven = false

  constructor(deps: LinkageRuntimeDeps) {
    this.deps = deps
  }

  /** 当前生效的联动配置。 */
  config(): QqLinkageConfig {
    return this.deps.config()
  }

  /** 合并一个执行点的注册结果（由 host/dsh/inject 与 host/dsh/tools 上报）。 */
  setEnforcement(patch: Partial<QqEnforcementReport>): void {
    this.enforcement = {
      ...this.enforcement,
      ...patch,
      notes: { ...this.enforcement.notes, ...(patch.notes ?? {}) },
      registeredTools: patch.registeredTools ?? this.enforcement.registeredTools,
    }
  }

  /**
   * 标记「宿主确实把会话上下文传给了提示词分区」。
   *
   * 只有观测到这一点，常驻记忆注入才**按会话**生效；到达之前页面会如实写
   * 「尚未观测到」而不是宣称已隔离。
   */
  markStandingContextSeen(): void {
    this.standingContextProven = true
  }

  /** 是否已观测到常驻分区的会话上下文。 */
  standingContextSeen(): boolean {
    return this.standingContextProven
  }

  /**
   * 判定一个会话在读取类执行点（常驻注入 / 每步检索）上的结果。
   *
   * @param candidate - Agent、Session 或会话 header 任一形状。
   */
  read(candidate: unknown): LinkageVerdict {
    const config = this.config()
    const facts = readSessionFacts(candidate)
    const provenance = classifyProvenance(facts, config)
    const decision = evaluateReadPolicy(provenance, config)
    if (!decision.allowed) this.counters.recallBlocked += 1
    this.observe(facts, provenance, 'recall')
    return { facts, provenance, decision }
  }

  /** 常驻注入点的判定；与读取共用策略，但单独计数，便于诊断区分。 */
  standing(candidate: unknown): LinkageVerdict {
    const config = this.config()
    const facts = readSessionFacts(candidate)
    const provenance = classifyProvenance(facts, config)
    const decision = evaluateReadPolicy(provenance, config)
    if (!decision.allowed) this.counters.standingBlocked += 1
    this.observe(facts, provenance, 'standing')
    return { facts, provenance, decision }
  }

  /** 写回点的判定：是否允许直接落盘（不允许时强制进收件箱）。 */
  write(candidate: unknown): LinkageVerdict {
    const config = this.config()
    const facts = readSessionFacts(candidate)
    const provenance = classifyProvenance(facts, config)
    const decision = evaluateWritePolicy(provenance, config)
    if (!decision.allowed) this.counters.writesForcedInbox += 1
    this.observe(facts, provenance, 'write')
    return { facts, provenance, decision }
  }

  /** 工具执行点的判定。 */
  tools(candidate: unknown): LinkageVerdict {
    const config = this.config()
    const facts = readSessionFacts(candidate)
    const provenance = classifyProvenance(facts, config)
    const decision = evaluateToolPolicy(provenance, config)
    if (!decision.allowed) this.counters.toolsBlocked += 1
    this.observe(facts, provenance, 'tools')
    return { facts, provenance, decision }
  }

  /** 最近会话判定样本（最多 {@link MAX_SAMPLES} 条，最新在后）。 */
  recentSessions(): QqSessionSample[] {
    return [...this.samples.values()]
  }

  /** 各执行点的拦截计数快照。 */
  countersSnapshot(): QqLinkageCounters {
    return { ...this.counters }
  }

  /** 策略运行时状态（与页面共用同一套判定）。 */
  runtimeStatus(): LinkageRuntimeStatus {
    return describeLinkageRuntime(this.config(), this.standingContextProven)
  }

  /** 报告里的执行点事实。 */
  enforcementReport(): QqEnforcementReport {
    return {
      ...this.enforcement,
      notes: { ...this.enforcement.notes, ...(this.standingContextProven ? {} : this.standingNote()) },
      registeredTools: [...this.enforcement.registeredTools],
    }
  }

  /** 组装给页面的完整报告。 */
  report(host: QqHostFacts, vaultPath: string | null): QqLinkageReport {
    return {
      config: this.config(),
      runtime: this.runtimeStatus(),
      enforcement: this.enforcementReport(),
      host,
      vaultPath,
      sessions: this.recentSessions(),
      counters: this.countersSnapshot(),
    }
  }

  private standingNote(): Record<string, string> {
    if (!this.enforcement.standing) return {}
    return {
      standingContext:
        '常驻记忆注入已注册为按会话求值，但尚未观测到宿主传入会话上下文；在首次模型回合确认之前，该执行点不会按会话拦截。',
    }
  }

  private observe(facts: SessionFacts, provenance: Provenance, point: 'standing' | 'recall' | 'write' | 'tools'): void {
    const sessionId = facts.sessionId
    if (sessionId === null) return
    const sample: QqSessionSample = {
      sessionId,
      channel: provenance.channel,
      matchedBy: provenance.matchedBy,
      marker: provenance.marker,
      reason: `${channelLabel(provenance.channel)} · ${provenance.reason}（执行点：${pointLabel(point)}）`,
      lastSeenAt: new Date().toISOString(),
    }
    this.samples.delete(sessionId)
    this.samples.set(sessionId, sample)
    while (this.samples.size > MAX_SAMPLES) {
      const oldest = this.samples.keys().next()
      if (oldest.done === true) break
      this.samples.delete(oldest.value)
    }
  }
}

function pointLabel(point: 'standing' | 'recall' | 'write' | 'tools'): string {
  switch (point) {
    case 'standing':
      return '常驻注入'
    case 'recall':
      return '每步检索'
    case 'write':
      return '写回'
    case 'tools':
      return '模型工具'
  }
}
