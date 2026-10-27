/**
 * 「QQ 接入」页的探测、诊断与会话判定组合逻辑（纯函数）。
 *
 * 这一层刻意不依赖 React，也不做任何状态缓存：输入是宿主/官方插件返回的事实，
 * 输出是「页面该显示什么」的结构化结果。所有结论都必须可追溯到一条真实依据：
 *
 * 1. 官方插件（@tencent-connect/dsh-qqbot）不注册 cordis 服务，因此无法用
 *    `ctx.get` 判断它是否存在；唯一允许的存活证据是它自己的客户端也在用的
 *    只读探测 `GET /qqbot/im-qqbot/bind`（200 = 已加载，404 = 未加载）。
 * 2. 探测结果只分为 已绑定 / 已加载未绑定 / 未加载 / 连接异常 / 无法确认 五类，
 *    绝不把「不知道」说成「没安装」或「已连接」。
 * 3. 会话归属只能靠用户在配置里显式声明的 origin/agentPreset/cwd 标记判定；
 *    官方 0.5.2 不提供会话来源标识，因此 QQ 私聊与群聊无法区分，页面只展示
 *    通道级策略，不做假的群聊隔离。
 *
 * @module dsh-longterm-memory/client/qq-channel
 */

import {
  classifyProvenance,
  decideRead,
  decideTools,
  decideWrite,
  markersEmpty,
  normalizeMarkers,
} from '../shared/qq-linkage.js'
import type {
  LinkageDecision,
  Provenance,
  QqLinkageConfig,
  SessionFacts,
  SessionMarkers,
} from '../shared/qq-linkage.js'
import type { QqLinkageReport } from '../shared/protocol.js'
import { readOfficialPresence, type OfficialPresence } from './host-inventory.js'

/** 官方 QQ 接入插件的 npm 包名。 */
export const OFFICIAL_PACKAGE = '@tencent-connect/dsh-qqbot'

/** 官方插件在 cordis 里的插件名。 */
export const OFFICIAL_CORDIS_NAME = 'im-qqbot'

/** 核查时 npm `dist-tags.latest` 的版本。 */
export const OFFICIAL_LATEST_KNOWN = '0.5.2'

/** 官方插件开始提供客户端 UI（设置面板 / 右侧栏 Tab）的版本。 */
export const OFFICIAL_CLIENT_SINCE = '0.5.1'

/**
 * 官方插件注册的只读状态路由。
 *
 * 官方客户端自己就用这个路由做存活探测（404 时退避），所以它是「已加载」的
 * 唯一安全证据；除此之外本插件不硬编码、也不调用官方插件的任何其它路由。
 */
export const OFFICIAL_BIND_ROUTE = '/qqbot/im-qqbot/bind'

/** 官方 `dsh.compatibility.dshReleases` 里声明「已验证」的宿主版本。 */
export const OFFICIAL_VERIFIED_RELEASES = ['0.1.0-rc.8', '0.2.0-rc.2'] as const

/** 本插件仓库声明的宿主兼容版本（见 package.json engines.dsh）。 */
export const REPO_HOST_COMPAT = '0.2.1-rc.3'

/** 本插件仓库声明的宿主兼容范围（与 package.json engines.dsh 保持一致）。 */
export const REPO_HOST_ENGINE_RANGE = '>=0.2.1-rc.3 <0.2.2'

/** 探测超时（毫秒）。 */
export const PROBE_TIMEOUT_MS = 4000

/** 探测结论的五种可能。 */
export type QqProbeKind = 'bound' | 'unbound' | 'not-loaded' | 'failed' | 'unknown'

/** 一次探测的完整结果；`evidenceKey`/`evidenceParams` 是页面展示的「依据」。 */
export interface QqProbeOutcome {
  kind: QqProbeKind
  /** 实际探测的同源路由。 */
  route: string
  /** 官方返回的 phase 原文，拿不到为 null。 */
  phase: string | null
  /** 官方在 bound 状态回显的 appId（非机密），其余情况为 null。 */
  appId: string | null
  /** HTTP 状态码，网络失败/超时为 null。 */
  httpStatus: number | null
  /** 依据文案的 i18n key。 */
  evidenceKey: string
  /** 依据文案的插值参数。 */
  evidenceParams: Record<string, string | number>
  /** 探测发生的时刻（ISO）。 */
  at: string
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function unknownOutcome(
  route: string,
  at: string,
  evidenceKey: string,
  evidenceParams: Record<string, string | number>,
  httpStatus: number | null = null,
): QqProbeOutcome {
  return { kind: 'unknown', route, phase: null, appId: null, httpStatus, evidenceKey, evidenceParams, at }
}

/**
 * 只读探测官方 QQ 插件是否已加载、是否已绑定。
 *
 * 语义（来自官方 `lib/client.js` 与 `dist/setup/bind-routes.js`）：
 * - `200` + JSON `{ phase }`：官方插件已加载；phase 为 `bound` 时已绑定，
 *   `waiting`/`starting`/`saving` 表示已加载但绑定未完成，`failed` 表示连接异常；
 * - `404`：该路由只在官方插件加载时注册，所以判定为未安装 / 未在本 Profile 启用；
 * - 其它状态、超时、非 JSON、缺少 phase：一律「无法确认」，绝不过度解读。
 *
 * @param timeoutMs - 探测超时，默认 {@link PROBE_TIMEOUT_MS}。
 */
export async function probeOfficialChannel(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<QqProbeOutcome> {
  const at = new Date().toISOString()
  const route = OFFICIAL_BIND_ROUTE

  if (typeof fetch !== 'function') {
    return unknownOutcome(route, at, 'qq.probe.evidence.noFetch', { route })
  }

  const controller = new AbortController()
  const timer = window.setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    const response = await fetch(route, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const httpStatus = response.status

    if (httpStatus === 404) {
      return {
        kind: 'not-loaded',
        route,
        phase: null,
        appId: null,
        httpStatus,
        evidenceKey: 'qq.probe.evidence.notLoaded',
        evidenceParams: { route },
        at,
      }
    }

    if (httpStatus !== 200) {
      return unknownOutcome(route, at, 'qq.probe.evidence.http', { route, status: httpStatus }, httpStatus)
    }

    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return unknownOutcome(route, at, 'qq.probe.evidence.nonJson', { route }, httpStatus)
    }

    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    const rawPhase = record === null ? undefined : record['phase']
    const phase = typeof rawPhase === 'string' && rawPhase.length > 0 ? rawPhase : null
    if (phase === null) {
      return unknownOutcome(route, at, 'qq.probe.evidence.missingPhase', { route }, httpStatus)
    }

    const rawAppId = record === null ? undefined : record['appId']
    const appId = typeof rawAppId === 'string' && rawAppId.length > 0 ? rawAppId : null

    if (phase === 'bound') {
      return {
        kind: 'bound',
        route,
        phase,
        appId,
        httpStatus,
        evidenceKey: 'qq.probe.evidence.bound',
        evidenceParams: { route },
        at,
      }
    }

    if (phase === 'waiting' || phase === 'starting' || phase === 'saving') {
      return {
        kind: 'unbound',
        route,
        phase,
        appId,
        httpStatus,
        evidenceKey: 'qq.probe.evidence.unbound',
        evidenceParams: { route, phase },
        at,
      }
    }

    if (phase === 'failed') {
      const rawReason = record === null ? undefined : record['reason']
      const reason = typeof rawReason === 'string' && rawReason.length > 0 ? rawReason : '—'
      return {
        kind: 'failed',
        route,
        phase,
        appId: null,
        httpStatus,
        evidenceKey: 'qq.probe.evidence.failed',
        evidenceParams: { route, reason },
        at,
      }
    }

    return unknownOutcome(route, at, 'qq.probe.evidence.unknownPhase', { route, phase }, httpStatus)
  } catch (error) {
    const timedOut = controller.signal.aborted
    return timedOut
      ? unknownOutcome(route, at, 'qq.probe.evidence.timeout', { route, ms: timeoutMs })
      : unknownOutcome(route, at, 'qq.probe.evidence.network', { route, message: messageOf(error) })
  } finally {
    window.clearTimeout(timer)
  }
}

/** 一次完整探测：只读 HTTP 结论 + 宿主插件清单证据。 */
export interface QqChannelProbe {
  outcome: QqProbeOutcome
  presence: OfficialPresence
}

/**
 * 只读探测 + 插件清单交叉验证。
 *
 * 插件清单（`pluginInventory` Remote）只能证明「装没装、启没启用、加载到哪个
 * 阶段」，不能证明连接/绑定状态；连接状态仍然只来自官方插件自己的
 * `/qqbot/im-qqbot/bind`。两者交叉之后才能把「未安装」和「已安装但读不到状态」
 * 区分开——这正是 404 单独无法回答的问题。
 */
export async function probeOfficialChannelDetailed(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<QqChannelProbe> {
  const [outcome, presence] = await Promise.all([probeOfficialChannel(timeoutMs), readOfficialPresence()])
  return { outcome: refineOutcome(outcome, presence), presence }
}

/**
 * 用插件清单修正只读探测的结论。
 *
 * - 404 + 清单确认未安装 → 保留「未加载」，依据补上「已由插件清单确认」；
 * - 404 + 清单显示已安装（启用/停用/加载失败都算）→ 改为「无法确认」，因为该
 *   路由缺失可能来自停用、加载失败，或该版本不注册 HTTP 路由，不能据此断言
 *   「未安装」；
 * - 其余情况（官方已返回 200 系列）以官方状态为准，插件清单只作附加证据。
 */
export function refineOutcome(outcome: QqProbeOutcome, presence: OfficialPresence): QqProbeOutcome {
  if (outcome.kind !== 'not-loaded') return outcome
  if (!presence.available) return outcome
  if (presence.state === 'absent') {
    return {
      ...outcome,
      evidenceKey: 'qq.probe.evidence.notInstalledConfirmed',
      evidenceParams: { ...outcome.evidenceParams, inventory: presence.note },
    }
  }
  return {
    ...outcome,
    kind: 'unknown',
    evidenceKey: 'qq.probe.evidence.installedButUnreadable',
    evidenceParams: {
      ...outcome.evidenceParams,
      state: presence.state,
      phase: presence.row?.phase ?? '—',
      inventory: presence.note,
    },
  }
}

/** 一组标记在文本输入框里的形态（一行一个）。 */
export interface MarkerTexts {
  origins: string
  presets: string
  cwds: string
}

/** 两组标记的文本形态。 */
export interface LinkageMarkerTexts {
  qq: MarkerTexts
  trusted: MarkerTexts
}

/** 把结构化标记转成多行文本。 */
export function markersToText(markers: SessionMarkers): MarkerTexts {
  return {
    origins: markers.origins.join('\n'),
    presets: markers.presets.join('\n'),
    cwds: markers.cwds.join('\n'),
  }
}

/** 把配置里的两组标记转成文本形态。 */
export function linkageMarkersToText(config: QqLinkageConfig): LinkageMarkerTexts {
  return { qq: markersToText(config.qqMarkers), trusted: markersToText(config.trustedMarkers) }
}

/** 把多行文本解析为标记：按行切分、去空、经共享的 normalize 归一化。 */
export function textToMarkers(texts: MarkerTexts): SessionMarkers {
  return normalizeMarkers({
    origins: splitLines(texts.origins),
    presets: splitLines(texts.presets),
    cwds: splitLines(texts.cwds),
  })
}

/** 把编辑中的两组标记文本写回配置（其余字段保持不变）。 */
export function applyMarkerTexts(config: QqLinkageConfig, texts: LinkageMarkerTexts): QqLinkageConfig {
  return {
    ...config,
    qqMarkers: textToMarkers(texts.qq),
    trustedMarkers: textToMarkers(texts.trusted),
  }
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 页面「会话隔离」矩阵里的一类样本会话。 */
export type QqSampleClass = 'qq' | 'trusted' | 'unidentified'

/** 一类样本会话在当前策略下的判定结果。 */
export interface QqIsolationSample {
  id: QqSampleClass
  /** 用于判定的真实字段形状（构造自配置里的标记）。 */
  facts: SessionFacts
  provenance: Provenance
  read: LinkageDecision
  write: LinkageDecision
  tools: LinkageDecision
  /** 配置里是否存在能命中该样本的标记；false 表示该行实际按未识别会话处理。 */
  configured: boolean
}

function factsForMarkers(markers: SessionMarkers, sessionId: string): SessionFacts {
  return {
    sessionId,
    origin: markers.origins[0] ?? null,
    agentPreset: markers.presets[0] ?? null,
    cwd: markers.cwds[0] ?? null,
    parentSession: null,
  }
}

function makeSample(
  id: QqSampleClass,
  facts: SessionFacts,
  config: QqLinkageConfig,
  configured: boolean,
): QqIsolationSample {
  const provenance = classifyProvenance(facts, config)
  return {
    id,
    facts,
    provenance,
    read: decideRead(provenance, config),
    write: decideWrite(provenance, config),
    tools: decideTools(provenance, config),
    configured,
  }
}

/**
 * 用页面同一套 `classifyProvenance` / `decideRead` / `decideWrite` / `decideTools`
 * 计算「当前配置下各类会话会得到什么结果」。
 *
 * 样本只用配置里已声明的标记构造，未声明时如实按未识别会话处理。
 */
export function buildIsolationSamples(config: QqLinkageConfig): QqIsolationSample[] {
  const qqFacts = factsForMarkers(config.qqMarkers, 'sample-qq')
  const trustedFacts = factsForMarkers(config.trustedMarkers, 'sample-trusted')
  const unidentifiedFacts: SessionFacts = {
    sessionId: 'sample-unidentified',
    cwd: null,
    origin: null,
    agentPreset: null,
    parentSession: null,
  }
  return [
    makeSample('qq', qqFacts, config, !markersEmpty(config.qqMarkers)),
    makeSample('trusted', trustedFacts, config, !markersEmpty(config.trustedMarkers)),
    makeSample('unidentified', unidentifiedFacts, config, true),
  ]
}

/** 诊断行的状态。 */
export type QqDiagState = 'ok' | 'warn' | 'error' | 'unknown'

/** 诊断行的标识，也决定标题文案。 */
export type QqDiagId = 'plugin' | 'rpc' | 'profile' | 'capabilities' | 'policy' | 'inventory'

/** 诊断区的一行：状态 + 一条可追溯的依据。 */
export interface QqDiagnosticRow {
  id: QqDiagId
  state: QqDiagState
  evidenceKey: string
  evidenceParams: Record<string, string | number>
}

/** {@link buildDiagnostics} 的输入，全部来自真实探测 / RPC 结果。 */
export interface QqDiagnosticsInput {
  /** 最近一次探测结果；从未探测为 null。 */
  probe: QqProbeOutcome | null
  /** 探测是否正在进行。 */
  probing: boolean
  /** `qqLinkage` 报告；失败或未返回为 null。 */
  report: QqLinkageReport | null
  /** RPC 失败时给用户看的一句话（已本地化），成功为 null。 */
  rpcError: string | null
  /** 当前模式的本地化标签，用于「策略是否在跑」的依据文案。 */
  modeLabel: string
}

const PROBE_STATE: Record<QqProbeKind, QqDiagState> = {
  bound: 'ok',
  unbound: 'warn',
  'not-loaded': 'warn',
  failed: 'error',
  unknown: 'unknown',
}

const PROBE_EVIDENCE: Record<QqProbeKind, string> = {
  bound: 'qq.diag.pluginBound',
  unbound: 'qq.diag.pluginUnbound',
  'not-loaded': 'qq.diag.pluginNotLoaded',
  failed: 'qq.diag.pluginFailed',
  unknown: 'qq.diag.pluginUnknown',
}

/**
 * 逐行汇总五类真实结果：插件探测 / 后端 RPC / 宿主 Profile / 能力 / 策略是否在跑。
 *
 * 任何一项缺少证据时返回 `unknown` 并写明缺什么，而不是推测一个结论。
 */
export function buildDiagnostics(input: QqDiagnosticsInput): QqDiagnosticRow[] {
  const report = input.report

  let plugin: QqDiagnosticRow
  if (input.probing && input.probe === null) {
    plugin = { id: 'plugin', state: 'unknown', evidenceKey: 'qq.diag.pluginProbing', evidenceParams: {} }
  } else if (input.probe === null) {
    plugin = { id: 'plugin', state: 'unknown', evidenceKey: 'qq.diag.pluginNoProbe', evidenceParams: {} }
  } else {
    plugin = {
      id: 'plugin',
      state: PROBE_STATE[input.probe.kind],
      evidenceKey: PROBE_EVIDENCE[input.probe.kind],
      evidenceParams: { route: input.probe.route, phase: input.probe.phase ?? '—' },
    }
  }

  let rpc: QqDiagnosticRow
  if (report !== null) {
    rpc = {
      id: 'rpc',
      state: 'ok',
      evidenceKey: 'qq.diag.rpcOk',
      evidenceParams: { vault: report.vaultPath ?? '—' },
    }
  } else if (input.rpcError !== null) {
    rpc = { id: 'rpc', state: 'error', evidenceKey: 'qq.diag.rpcError', evidenceParams: { message: input.rpcError } }
  } else {
    rpc = { id: 'rpc', state: 'unknown', evidenceKey: 'qq.diag.rpcPending', evidenceParams: {} }
  }

  let profile: QqDiagnosticRow
  if (report === null) {
    profile = { id: 'profile', state: 'unknown', evidenceKey: 'qq.diag.profileUnknownNoReport', evidenceParams: {} }
  } else if (report.host.profile === null && report.host.profileDir === null) {
    profile = { id: 'profile', state: 'warn', evidenceKey: 'qq.diag.profileNotExposed', evidenceParams: {} }
  } else {
    profile = {
      id: 'profile',
      state: 'ok',
      evidenceKey: 'qq.diag.profileOk',
      evidenceParams: { profile: report.host.profile ?? '—', dir: report.host.profileDir ?? '—' },
    }
  }

  let capabilities: QqDiagnosticRow
  let registered = 0
  if (report === null) {
    capabilities = { id: 'capabilities', state: 'unknown', evidenceKey: 'qq.diag.capabilitiesUnknown', evidenceParams: {} }
  } else {
    const points = [
      report.enforcement.standing,
      report.enforcement.perStepRecall,
      report.enforcement.extraction,
      report.enforcement.tools,
    ]
    registered = points.filter(Boolean).length
    capabilities = {
      id: 'capabilities',
      state: registered === points.length ? 'ok' : 'warn',
      evidenceKey: 'qq.diag.capabilitiesRegistered',
      evidenceParams: { count: registered, total: points.length },
    }
  }

  let policy: QqDiagnosticRow
  if (report === null) {
    policy = { id: 'policy', state: 'unknown', evidenceKey: 'qq.diag.policyUnknown', evidenceParams: {} }
  } else if (!report.runtime.enforcing) {
    policy = { id: 'policy', state: 'warn', evidenceKey: 'qq.diag.policyOff', evidenceParams: {} }
  } else if (report.runtime.mode === 'allowlist' && markersEmpty(report.config.trustedMarkers)) {
    policy = {
      id: 'policy',
      state: 'warn',
      evidenceKey: 'qq.diag.policyNoTrusted',
      evidenceParams: { mode: input.modeLabel },
    }
  } else if (!report.runtime.qqIdentifiable) {
    policy = {
      id: 'policy',
      state: 'warn',
      evidenceKey: 'qq.diag.policyNoMarkers',
      evidenceParams: { mode: input.modeLabel },
    }
  } else if (!report.runtime.sessionAwareStanding) {
    policy = {
      id: 'policy',
      state: 'warn',
      evidenceKey: 'qq.diag.policyStandingLimited',
      evidenceParams: { mode: input.modeLabel },
    }
  } else {
    policy = {
      id: 'policy',
      state: 'ok',
      evidenceKey: 'qq.diag.policyOn',
      evidenceParams: { mode: input.modeLabel, count: registered },
    }
  }

  return [plugin, rpc, profile, capabilities, policy]
}

/** 生成官方插件的安装命令（Profile 未知时保留 `<profile>` 占位符）。 */
export function installCommand(profile: string | null | undefined): string {
  const target = profile === null || profile === undefined || profile.trim().length === 0 ? '<profile>' : profile.trim()
  return `npx @deepseek-ai/dsh plugin --profile ${target} add ${OFFICIAL_PACKAGE}`
}

/**
 * 官方插件凭据文件路径。
 *
 * 只用于「告诉用户凭据落在哪」，本插件绝不读取该文件内容。
 */
export function credentialFilePath(profileDir: string | null | undefined): string {
  const base =
    profileDir === null || profileDir === undefined || profileDir.trim().length === 0
      ? '<profile>'
      : profileDir.trim().replace(/[\\/]+$/, '')
  return `${base}/cordis.patch.yml`
}
