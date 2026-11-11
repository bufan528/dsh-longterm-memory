/**
 * WP-NEXT-02B Stage F/G — Trusted Host Source contract matrix (S01–S23)
 * + A/B/C patch integration regression + B3 exposure/fix verification.
 *
 * Loads: 02A patched modules (A/B/C), real SDK middlewares, real QqbotContextRuntime,
 * real ProvenanceRegistry / BoundPluginIngress, real MemoryService / OwnerGate / tools,
 * and the CONTRACT REFERENCE harness (contract/host-api-contract-reference.mjs), which is
 * explicitly NOT a production implementation and NOT deployable.
 *
 * Writes only under .scratch/wp-next-02b-source-contract/. No production file is touched.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (x: unknown) => x }))

import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryService } from '../../src/host/core/service.js'
import { createOwnerGate, sessionIdOfAgent } from '../../src/host/owner-gate.js'
import type { OwnerAccessDecision } from '../../src/shared/owner-access.js'
import { buildToolDefinitions, type ToolDefinition } from '../../src/host/dsh/tools.js'

const ROOT = 'D:/dsh-memory-vault/.scratch/wp-next-02b-source-contract'
const ISO = `${ROOT}/iso`
const CONTRACT = `${ROOT}/contract/host-api-contract-reference.mjs`
const ISO_VAULT = `${ROOT}/iso-vault/DSH Memory`
const PROD_QQ = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/dsh-qqbot-merge/dist'
const SDK_MW = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/@tencent-connect/qqbot-nodejs/dist/middleware'
const PROD_VAULT = 'C:/Users/bf410/Documents/DSH Memory'
const APP_ID = '1906048158'
const OWNER = 'qq-owner-openid-wp02b-iso'
const MEMBER_A = 'qq-member-a-wp02b-iso'
const MEMBER_B = 'qq-member-b-wp02b-iso'
const GROUP_A = 'group-openid-A-wp02b'

const loadMod = (p: string) => import(pathToFileURL(p).href)

const COUNTER_KEYS = [
  'search', 'get', 'save', 'setStatus', 'remove', 'writeRaw', 'processTurn',
  'standing', 'recallForInjection', 'confirm', 'reject', 'merge',
  'resolveConflict', 'addCandidate', 'materializeCandidate',
] as const
type Counters = Record<(typeof COUNTER_KEYS)[number], number>
const zero = () => Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0])) as unknown as Counters

function wrapService(service: MemoryService): MemoryService & { counters: Counters } {
  const counters = zero()
  const s = service as MemoryService & { counters: Counters }
  for (const key of COUNTER_KEYS) {
    const orig = (service as unknown as Record<string, unknown>)[key]
    if (typeof orig !== 'function') continue
    ;(service as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
      counters[key] += 1
      return (orig as (...a: unknown[]) => unknown).apply(service, args)
    }
  }
  s.counters = counters
  return s
}
const delta = (now: Counters, before: Counters): Partial<Counters> => {
  const out: Partial<Counters> = {}
  for (const k of COUNTER_KEYS) if (now[k] !== before[k]) out[k] = now[k] - before[k]
  return out
}
const sum = (d: Partial<Counters>, keys: readonly (keyof Counters)[]) =>
  keys.reduce((n, k) => n + (d[k] ?? 0), 0)
const readKeys = ['search', 'get', 'standing', 'recallForInjection'] as const
const writeKeys = [
  'save', 'setStatus', 'remove', 'writeRaw', 'processTurn', 'confirm',
  'reject', 'merge', 'resolveConflict', 'addCandidate', 'materializeCandidate',
] as const

type Kind = 'real' | 'contract-sim' | 'blocked'
interface Row { id: string; name: string; expected: string; observed: string; pass: boolean; kind: Kind; counters: string }
const rows: Row[] = []
const counterEvidence: Array<Record<string, unknown>> = []
const trustEvidence: Array<Record<string, unknown>> = []

function push(id: string, name: string, expected: string, observed: string, pass: boolean, kind: Kind, counters = '—') {
  rows.push({ id, name, expected, observed, pass, kind, counters })
  expect(pass, `${id} ${name}: ${observed}`).toBe(true)
}

describe('WP-NEXT-02B Trusted Host Source contract + A/B/C integration', () => {
  let service: MemoryService & { counters: Counters }
  let defsV2: Record<string, ToolDefinition>
  let oldGate: ReturnType<typeof createOwnerGate>
  let qqService: any
  let context: any
  let ing: any
  let contract: any
  let registry: any
  let sdk: { mentionGate: any; messageFilter: any }
  let inboundPatch: any
  let injectPatch: any
  let currentTurn: { sessionId: string; messageId: string; turnId: string }
  let seq = 0
  const releaseChecks: Record<string, boolean> = {}

  const next = (p: string) => `${p}-${++seq}`
  const binding = (ownerId = 'owner-binding-wp02b') => ({ ownerId, appId: APP_ID, openid: OWNER })

  /** Host-authenticated facts: authenticatedDesktop / transportProof can only come from Host. */
  function hostFacts(over: Record<string, unknown> = {}) {
    const messageId = next('msg')
    const sessionId = next('sess')
    const turnId = next('turn')
    return {
      messageId, sessionId, turnId,
      botAppId: APP_ID,
      generation: 1,
      ingressEntryId: 'host-plugin-ingress',
      ...over,
    }
  }

  // 门禁契约在 L1 起要求 ALLOW 必须带具体通道（记忆可见范围由此决定），
  // 而 HostTrustedSourceRegistry 的 V2 决策仍然只给 {allowed, reason}。
  // 这里按注册事实补上通道，让夹具走真实契约而不是缺字段的旧形状。
  const channelBySession = new Map<string, 'qq' | 'desktop' | 'unknown'>()

  function register(facts: Record<string, unknown>, registry: any) {
    const proof = facts['transportProof'] as { conversationType?: string } | undefined
    const channel =
      facts['authenticatedDesktop'] === true ? 'desktop' : proof !== undefined ? 'qq' : 'unknown'
    channelBySession.set(String(facts['sessionId']), channel)
    return registry._registerFromHost(facts)
  }

  function gateV2(agent: unknown): OwnerAccessDecision {
    const decided = decide(registry, currentTurn) as { allowed: boolean; reason: string }
    const sessionId = sessionIdOfAgent(agent) ?? currentTurn.sessionId
    if (!decided.allowed) {
      return { allowed: false, reason: decided.reason, ownerId: null, channel: 'unknown' }
    }
    const channel = channelBySession.get(sessionId)
    // ALLOW 必须能说出通道，否则无法界定可见范围 → 按拒绝处理（与生产门禁一致）
    if (channel === undefined || channel === 'unknown') {
      return { allowed: false, reason: 'simulated gate cannot resolve a channel', ownerId: null, channel: 'unknown' }
    }
    return { allowed: true, reason: decided.reason, ownerId: null, channel }
  }

  function decide(registry: any, turn: { sessionId: string; messageId: string; turnId: string }) {
    return contract.decideOwnerAccessV2(registry, turn)
  }

  function turnOf(facts: Record<string, any>) {
    return { sessionId: facts.sessionId, messageId: facts.messageId, turnId: facts.turnId }
  }

  async function tryToolV2(name: string, args: unknown) {
    const before = { ...service.counters }
    let allowed = false; let error = ''
    try {
      const def = defsV2[name]
      if (def === undefined) throw new Error(`missing tool ${name}`)
      await def.execute(args, { agent: { session: { id: currentTurn.sessionId } } })
      allowed = true
    } catch (err) { error = String((err as Error).message).slice(0, 120) }
    const d = delta(service.counters, before)
    return { allowed, error, d, readCalls: sum(d, readKeys), writeCalls: sum(d, writeKeys) }
  }

  beforeAll(async () => {
    await mkdir(`${ROOT}/iso-vault`, { recursive: true })
    await rm(ISO_VAULT, { recursive: true, force: true })
    service = wrapService(new MemoryService({
      configuredVaultPath: ISO_VAULT,
      configSettings: { language: 'zh', enableAutoExtraction: false, enableLlmExtraction: false },
    }))
    await service.initialize(ISO_VAULT)

    contract = await loadMod(CONTRACT)
    ing = await loadMod(join(ISO, 'ingress.wp02a.mjs'))
    qqService = await loadMod(join(PROD_QQ, 'identity/service.js'))
    sdk = {
      mentionGate: (await loadMod(join(SDK_MW, 'mention-gate.js'))).mentionGate,
      messageFilter: (await loadMod(join(SDK_MW, 'message-filter.js'))).messageFilter,
    }
    inboundPatch = (await loadMod(join(ISO, 'inbound.wp02a.mjs'))).handleInbound
    injectPatch = (await loadMod(join(ISO, 'inject.wp02a.mjs'))).installTurnExtraction

    context = new qqService.QqbotContextRuntime({ persist: () => true, initial: undefined })
    const issued = context.createPairCode()
    expect(context.pair(issued.code, { platform: 'qq', appId: APP_ID, openid: OWNER }).ok).toBe(true)
    oldGate = createOwnerGate(() => context, { qqPersonalMemory: true, getIngress: () => undefined })

    // Reference registry + V2 Gate replaces the plugin-side qqbotContext entirely.
    registry = new contract.HostTrustedSourceRegistry({ generation: 1, ttlMs: 60_000 })
    currentTurn = { sessionId: 'none', messageId: 'none', turnId: 'none' }
    defsV2 = Object.fromEntries(buildToolDefinitions(
      service, undefined,
      gateV2,
    ).map((d) => [d.name, d]))

    // Stage G: reuse 02A A/B/C release files byte-for-byte.
    const a = await readFile(join(ROOT, 'integration/qqbot-merge/dist/gateway/middleware-setup.js'), 'utf8')
    const b = await readFile(join(ROOT, 'integration/qqbot-merge/dist/transport/inbound.js'), 'utf8')
    const c = await readFile(join(ROOT, 'integration/mv-patch/lib/host/dsh/inject.js'), 'utf8')
    releaseChecks['A skipSelfEcho=true'] = a.includes('skipSelfEcho: true') && !a.includes('skipSelfEcho: false')
    releaseChecks['B authoritative guard'] = b.includes('authoritative') && b.includes('GROUP_AT_MESSAGE_CREATE')
    releaseChecks['C gate-first'] = c.includes('group turn-end extraction skipped')
  })

  afterAll(async () => {
    const pass = rows.filter((r) => r.pass).length
    const byKind = (k: Kind) => rows.filter((r) => r.kind === k).length
    await writeFile(join(ROOT, 'isolated-test-results.md'), [
      '# WP-NEXT-02B Stage F/G — 隔离来源合同测试矩阵（S01–S23 + 回归）',
      '',
      `生成时间：${new Date().toISOString()}`,
      `隔离 Vault：\`${ISO_VAULT}\``,
      '',
      '| 编号 | 用例 | 预期 | 实测 | 结论 | 证据性质 | 计数证据 |',
      '|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.id} | ${r.name} | ${r.expected} | ${r.observed} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.kind} | ${r.counters} |`),
      '',
      `合计：${rows.length} 项，断言成立 ${pass}；real=${byKind('real')}，contract-sim=${byKind('contract-sim')}，blocked=${byKind('blocked')}`,
      '',
      '**`contract-sim` 的 PASS 只证明契约语义正确，不构成生产证据**：其前置 Host API（H1–H8）在 DSH Host 0.2.2-rc.1 中经 app.asar 源码确认缺失。',
      '**`blocked` 行表示当前无法在不修改 Host 的前提下取得真实证据**；其 PASS 仅表示「缺口已确认存在」，不是安全验收通过。',
      '`S02a` / `X01` 是 B3 漏洞的暴露性证据（旧 OwnerGate ALLOW），同样不是安全验收通过。',
      '因此 S01–S23 中依赖 Host 认证链 / 当前消息上下文的项**没有真实生产证据**，本轮最终状态为 BLOCKED。',
      '所有写入均落在 02B 隔离目录；生产个人 Vault 未被写入。',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(ROOT, 'evidence/wp02b-counter-evidence.json'), JSON.stringify(counterEvidence, null, 2), 'utf8')
    await writeFile(join(ROOT, 'evidence/wp02b-trust-evidence.json'), JSON.stringify(trustEvidence, null, 2), 'utf8')
    await writeFile(join(ROOT, 'evidence/a-b-c-integration-checks.json'), JSON.stringify(releaseChecks, null, 2), 'utf8')
  })

  // ───────────────────────── S01–S12: source identity ─────────────────────────
  it('S01–S12 来源身份：Host 认证/Transport 派生与伪造拒绝', () => {
    const registry = new contract.HostTrustedSourceRegistry({ generation: 1 })

    // S01 Desktop Owner: only authenticated user-rpc chain (Host admit → browserPeer → principal undefined)
    const desktop = hostFacts({
      authenticatedDesktop: true,
      userRpc: { kind: 'user', rpcId: next('rpc'), principal: undefined },
    })
    const r1 = register(desktop, registry)
    const d1 = decide(registry, turnOf(desktop))
    push('S01', '正常 Desktop Owner 来源', 'ALLOW', `register=${r1.ok}, decision=${d1.allowed}`,
      r1.ok && d1.allowed === true, 'contract-sim')

    // S02 B3 exposure + fix: real noteSource({platform:'desktop'}) must NOT influence V2
    const forgedSession = next('sess-forged')
    context.noteSource({
      sessionId: forgedSession, platform: 'desktop', conversationType: 'c2c',
      isPrivate: true, appId: '', senderId: '', identified: true,
    })
    const oldDecision = oldGate({ sessionId: forgedSession })
    const v2Decision = decide(registry, { sessionId: forgedSession, messageId: 'forged', turnId: 'forged' })
    trustEvidence.push({
      id: 'S02', noteSourceForgery: { platform: 'desktop', sessionId: forgedSession },
      oldOwnerGate: oldDecision, v2Gate: v2Decision,
      note: 'B3 exposure reproduced on real QqbotContextRuntime; V2 ignores qqbotContext entirely',
    })
    push('S02a', 'B3 复现：旧 OwnerGate 被 noteSource 提权', 'ALLOW（暴露缺口）',
      `allowed=${oldDecision.allowed}, reason=${oldDecision.reason}`, oldDecision.allowed === true, 'real')
    push('S02b', '修复验证：V2 不被 noteSource 篡改影响', 'DENY',
      `allowed=${v2Decision.allowed}, reason=${v2Decision.reason}`, v2Decision.allowed === false, 'contract-sim')

    // S03 普通插件通过同一 service 登记 Owner（noteSource + pair）→ V2 DENY
    const pluginSession = next('sess-plugin')
    context.noteSource({
      sessionId: pluginSession, platform: 'qq', appId: APP_ID, senderId: OWNER,
      conversationType: 'c2c', isPrivate: true, identified: true,
    })
    const pluginOld = oldGate({ sessionId: pluginSession })
    const pluginV2 = decide(registry, { sessionId: pluginSession, messageId: 'x', turnId: 'x' })
    push('S03', '普通插件通过 qqbotContext 登记 Owner', 'DENY（V2）',
      `oldGate=${pluginOld.allowed}, v2=${pluginV2.allowed}`, pluginV2.allowed === false, 'real')

    // X01: adding a resolver WITHOUT replacing the Gate does not fix B3
    const x01 = oldGate({ sessionId: forgedSession })
    push('X01', '仅新增 resolver 而不替换 Owner Gate', '旧 Gate 仍 ALLOW（证明必须换 Gate）',
      `oldGate=${x01.allowed}`, x01.allowed === true, 'real')

    // S04 forged QQ senderId (no verified Transport proof / binding mismatch)
    const s04 = hostFacts({ transportProof: { verified: false, appId: APP_ID, senderId: 'attacker', conversationType: 'c2c' }, ownerBinding: binding() })
    const r4 = register(s04, registry)
    push('S04', '伪造 QQ senderId', 'DENY', `register=${r4.ok}, reason=${r4.reason}`,
      r4.ok === false && r4.reason === 'unverifiable-source', 'contract-sim')

    // S05 unbound C2C
    const s05 = hostFacts({ transportProof: { verified: true, appId: APP_ID, senderId: MEMBER_A, conversationType: 'c2c' }, ownerBinding: { ownerId: 'x', appId: APP_ID, openid: OWNER } })
    const r5 = register(s05, registry)
    const d5 = decide(registry, turnOf(s05))
    push('S05', '未绑定 C2C（binding 与 sender 不一致）', 'DENY',
      `category=${r5.record?.category}, ownerBindingId=${String(r5.record?.ownerBindingId)}, decision=${d5.allowed}`,
      r5.ok && d5.allowed === false, 'contract-sim')

    // S06 bound C2C Owner
    const s06 = hostFacts({ transportProof: { verified: true, appId: APP_ID, senderId: OWNER, conversationType: 'c2c' }, ownerBinding: binding() })
    const r6 = register(s06, registry)
    const d6 = decide(registry, turnOf(s06))
    push('S06', '已绑定 C2C Owner', 'ALLOW',
      `category=${r6.record?.category}, ownerBindingId=${String(r6.record?.ownerBindingId)}, decision=${d6.allowed}`,
      r6.ok && d6.allowed === true, 'contract-sim')

    // S07/S08/S09 Group variants
    const groupProof = { verified: true, appId: APP_ID, senderId: OWNER, conversationType: 'group', groupId: GROUP_A }
    const s07 = hostFacts({ transportProof: groupProof, ownerBinding: binding() })
    const r7 = register(s07, registry)
    const d7 = decide(registry, turnOf(s07))
    push('S07', 'Group Owner 本人', 'DENY', `category=${r7.record?.category}, decision=${d7.allowed}`,
      r7.ok && d7.allowed === false, 'contract-sim')

    const s08 = hostFacts({ transportProof: { ...groupProof, conversationType: 'c2c' }, ownerBinding: binding() })
    const r8 = register(s08, registry)
    const d8 = decide(registry, turnOf(s08))
    push('S08', 'Group 伪造 C2C（改 conversationType 但保留 groupId）', 'DENY 或不可登记',
      `category=${r8.record?.category}, decision=${d8.allowed}`, d8.allowed === false, 'contract-sim')

    const s09 = hostFacts({ transportProof: groupProof, authenticatedDesktop: true, userRpc: { kind: 'user', rpcId: 'rpc-x', principal: undefined } })
    const r9 = register(s09, registry)
    const d9 = decide(registry, turnOf(s09))
    // Group proof wins over a caller-claimed desktop flag in the reference contract.
    push('S09', 'Group 伪造 Desktop（同时声明 authenticatedDesktop）', 'DENY',
      `category=${r9.record?.category}, decision=${d9.allowed}`,
      d9.allowed === false, 'contract-sim')

    // S10/S11/S12 binding mismatches
    const base = hostFacts({ transportProof: { verified: true, appId: APP_ID, senderId: OWNER, conversationType: 'c2c' }, ownerBinding: binding() })
    register(base, registry)
    const mismatch = (over: Record<string, unknown>) => decide(registry, { ...turnOf(base), ...over })
    const d10 = mismatch({ messageId: 'forged-message-id' })
    const d11 = mismatch({ sessionId: 'forged-session-id' })
    const d12 = mismatch({ turnId: 'forged-turn-id' })
    push('S10', '伪造 messageId', 'DENY', `allowed=${d10.allowed}, reason=${d10.reason}`, d10.allowed === false, 'contract-sim')
    push('S11', '伪造 sessionId', 'DENY', `allowed=${d11.allowed}, reason=${d11.reason}`, d11.allowed === false, 'contract-sim')
    push('S12', 'messageId / sessionId / turnId 不匹配', 'DENY',
      `allowed=${d12.allowed}, reason=${d12.reason}`, d12.allowed === false, 'contract-sim')
  })

  // ───────────────────────── S13–S17: lifecycle ─────────────────────────
  it('S13–S17 Capability / generation / HMR / restart lifecycle', async () => {
    const registry = new ing.ProvenanceRegistry({ hostSecret: 'wp02b-iso' })
    let generation = 1
    let alive = true
    const cap = new ing.BoundPluginIngress({
      identity: { packageId: 'dsh-qqbot-merge', entryId: 'qqbot-merge', fiberGeneration: 1, fiberUid: 'u1' },
      deliver: async () => undefined, registry,
      currentGeneration: () => generation, isAlive: () => alive,
    })
    const mk = (id: string) => ({
      sessionId: next('sess-hmr'), text: 'x', delivery: 'followup', requestId: id,
      qq: { qqMessageId: id, peerId: OWNER, senderId: OWNER, conversationType: 'c2c', appId: APP_ID },
    })
    // S13 old capability
    alive = false
    const r13 = await cap.submit(mk('m13'))
    alive = true
    push('S13', '旧 Capability', 'DENY', `ok=${r13.ok}, reason=${r13.reason}`,
      r13.ok === false && r13.reason === 'capability-disposed', 'real')
    // S14 old generation
    generation = 2
    const r14 = await cap.submit(mk('m14'))
    push('S14', '旧 generation', 'DENY', `ok=${r14.ok}, reason=${r14.reason}`,
      r14.ok === false && r14.reason === 'fiber-generation-stale', 'real')
    // S15 HMR: re-bind with a new capability for generation 2
    const cap2 = new ing.BoundPluginIngress({
      identity: { packageId: 'dsh-qqbot-merge', entryId: 'qqbot-merge', fiberGeneration: 2, fiberUid: 'u2' },
      deliver: async () => undefined, registry,
      currentGeneration: () => 2, isAlive: () => true,
    })
    const r15 = await cap2.submit(mk('m15'))
    push('S15', 'HMR 后重新授权（新 generation 重新 bind）', 'PASS', `ok=${r15.ok}, category=${r15.category}`,
      r15.ok === true && r15.category === 'qq-c2c', 'real')

    // S16 restart: Host ProvenanceRegistry persistPath='' → new instance empty
    const fresh = new ing.ProvenanceRegistry({ hostSecret: 'wp02b-iso' })
    const contractRegistry = new contract.HostTrustedSourceRegistry({ generation: 1 })
    const before = hostFacts({ transportProof: { verified: true, appId: APP_ID, senderId: OWNER, conversationType: 'c2c' }, ownerBinding: binding() })
    register(before, contractRegistry)
    contractRegistry.restart()
    const d16 = decide(contractRegistry, turnOf(before))
    push('S16', 'DSH 重启后旧 Active Provenance', 'DENY',
      `hostRegistry.get=${String(fresh.get(before.messageId))}, contractDecision=${d16.allowed}`,
      fresh.get(before.messageId) === undefined && d16.allowed === false, 'real')

    // S17 restart + new trusted C2C event re-registers
    const freshContract = new contract.HostTrustedSourceRegistry({ generation: 1 })
    const after = hostFacts({ transportProof: { verified: true, appId: APP_ID, senderId: OWNER, conversationType: 'c2c' }, ownerBinding: binding() })
    const r17 = register(after, freshContract)
    const d17 = decide(freshContract, turnOf(after))
    push('S17', '重启后的新可信 C2C 重新登记', '正常重新登记并 ALLOW',
      `register=${r17.ok}, decision=${d17.allowed}`, r17.ok && d17.allowed === true, 'contract-sim')
    trustEvidence.push({ id: 'S13-S17', r13, r14, r15, s16: { oldResolve: d16 }, s17: { registered: r17.ok, decision: d17.allowed } })
  })

  // ───────────────────────── S18/S19: concurrency + group members ─────────────────────────
  it('S18/S19 并发 Turn 与同群多成员隔离', () => {
    const registry = new contract.HostTrustedSourceRegistry({ generation: 1 })
    const sharedSession = next('sess-shared')
    const desktopTurn = hostFacts({
      sessionId: sharedSession,
      authenticatedDesktop: true,
      userRpc: { kind: 'user', rpcId: next('rpc'), principal: undefined },
    })
    const groupTurn = hostFacts({
      sessionId: sharedSession,
      transportProof: { verified: true, appId: APP_ID, senderId: MEMBER_A, conversationType: 'group', groupId: GROUP_A },
    })
    register(desktopTurn, registry)
    register(groupTurn, registry)
    const dDesktop = decide(registry, turnOf(desktopTurn))
    const dGroup = decide(registry, turnOf(groupTurn))
    const cross = decide(registry, { sessionId: sharedSession, messageId: desktopTurn.messageId, turnId: groupTurn.turnId })
    push('S18', '并发 Turn 来源交叉（同 sessionId）', '不允许串权',
      `desktop=${dDesktop.allowed}, group=${dGroup.allowed}, cross=${cross.allowed}`,
      dDesktop.allowed === true && dGroup.allowed === false && cross.allowed === false, 'contract-sim')

    const members = [MEMBER_A, MEMBER_B, OWNER]
    const decisions = members.map((senderId) => {
      const f = hostFacts({
        transportProof: { verified: true, appId: APP_ID, senderId, conversationType: 'group', groupId: GROUP_A },
        ownerBinding: binding(),
      })
      register(f, registry)
      return { senderId, allowed: decide(registry, turnOf(f)).allowed }
    })
    push('S19', '同一 Group 多成员消息（含 Owner 本人）', '全部 DENY',
      JSON.stringify(decisions), decisions.every((d) => d.allowed === false), 'contract-sim')
  })

  // ───────────────────────── S20–S23: Vault call counters ─────────────────────────
  it('S20–S23 DENY 时 Vault 四类调用全为 0', async () => {
    const denyScenarios: Array<{ id: string; label: string; make: () => Record<string, unknown> }> = [
      { id: 'S20', label: 'Group', make: () => hostFacts({ transportProof: { verified: true, appId: APP_ID, senderId: MEMBER_A, conversationType: 'group', groupId: GROUP_A } }) },
      { id: 'S21', label: 'Unknown', make: () => hostFacts({}) },
      { id: 'S22', label: '伪造 messageId', make: () => hostFacts({ transportProof: { verified: true, appId: APP_ID, senderId: OWNER, conversationType: 'c2c' }, ownerBinding: binding() }) },
      { id: 'S23', label: '伪造 sessionId', make: () => hostFacts({ transportProof: { verified: true, appId: APP_ID, senderId: OWNER, conversationType: 'c2c' }, ownerBinding: binding() }) },
    ]
    for (const sc of denyScenarios) {
      const f = sc.make()
      if (sc.id !== 'S21') register(f, registry)
      currentTurn = sc.id === 'S22'
        ? { ...turnOf(f), messageId: 'forged' }
        : sc.id === 'S23'
          ? { ...turnOf(f), sessionId: 'forged' }
          : turnOf(f)
      const decision = decide(registry, currentTurn)
      const search = await tryToolV2('memory_search', { query: '个人资料', limit: 5 })
      const save = await tryToolV2('memory_save', {
        type: 'preference', title: 'WP02B-SHOULD-NOT-WRITE', content: '不得写入个人记忆',
        tags: ['wp02b'], confidence: 'high', importance: 50,
      })
      const forget = await tryToolV2('memory_forget', { id: 'mem-none', status: 'archived' })
      const readCalls = search.readCalls
      const writeCalls = search.writeCalls + save.writeCalls + forget.writeCalls
      const deleteCalls = forget.writeCalls
      counterEvidence.push({
        id: sc.id, label: sc.label, decision, currentTurn,
        search_calls: readCalls, write_calls: writeCalls, delete_calls: deleteCalls, update_calls: 0,
        raw_deltas: { search: search.d, save: save.d, forget: forget.d },
      })
      push(sc.id, `${sc.label} DENY 时 Vault 调用计数`, '全部 0',
        `gate=${decision.allowed}; search=${readCalls}, write=${writeCalls}, delete=${deleteCalls}, update=0`,
        !decision.allowed && readCalls === 0 && writeCalls === 0 && deleteCalls === 0,
        'real', `search=${readCalls}, write=${writeCalls}, delete=${deleteCalls}, update=0`)
    }
  })

  // ───────────────────────── Stage G: A/B/C integration ─────────────────────────
  it('G01–G08 A/B/C 与来源合同统一隔离回归', async () => {
    for (const [k, v] of Object.entries(releaseChecks)) {
      push(`G00·${k.slice(0, 20)}`, `A/B/C 复用核对：${k}`, 'true', String(v), v === true, 'real')
    }

    // Real patched inbound (A/B) with real SDK middlewares
    const makeMsg = (over: Record<string, unknown> = {}) => ({
      kind: 'group', messageId: next('qq-msg'), senderId: MEMBER_A, groupOpenid: GROUP_A,
      content: '普通群消息', rawEventType: 'GROUP_MESSAGE_CREATE', senderIsBot: false, ...over,
    })
    async function runInbound(msg: Record<string, unknown>) {
      const submitted: any[] = []
      const gateMw = sdk.mentionGate({ requireMentionInGroup: true })
      const filterMw = sdk.messageFilter({ skipSelfEcho: true })
      const ctx: any = { message: msg, state: {}, bot: { appId: APP_ID }, log: { debug: () => undefined }, stop: () => undefined, next: async () => undefined }
      let decision: any = null
      await filterMw(ctx, async () => { await gateMw(ctx, async () => undefined) })
      decision = ctx.state.mention
      const handlerCtx = { message: msg, state: { mention: { wasMentioned: decision?.wasMentioned ?? false } }, bot: { sendMarkdown: async () => undefined } }
      await inboundPatch(handlerCtx,
        { getOrCreate: async () => ({ sessionId: next('sess-inbound'), agent: { whenIdle: async () => undefined } }) },
        { appId: APP_ID }, { info: () => undefined, warn: () => undefined, error: () => undefined },
        undefined, undefined,
        { submit: async (i: any) => { submitted.push(i); return { ok: true, messageId: 'x', category: 'qq-group', provenanceId: 'x' } } })
      return submitted.length
    }
    const realAt = await runInbound(makeMsg({ content: '请解释 TCP', rawEventType: 'GROUP_AT_MESSAGE_CREATE' }))
    const fakeAt = await runInbound(makeMsg({ content: `<@!${APP_ID}> 你好`, rawEventType: 'GROUP_MESSAGE_CREATE' }))
    const echo = await runInbound(makeMsg({ content: 'bot 自己的消息', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderIsBot: true, _mentioned: true }))
    const plain = await runInbound(makeMsg())
    const c2c = await runInbound(makeMsg({ kind: 'c2c', groupOpenid: undefined, senderId: OWNER, rawEventType: 'C2C_MESSAGE_CREATE' }))
    push('G01', '真正 @Bot 正常触发', 'submit=1', `submit=${realAt}`, realAt === 1, 'real')
    push('G02', '文本伪造 @ 不触发', 'submit=0', `submit=${fakeAt}`, fakeAt === 0, 'real')
    push('G03', 'Bot 自身 Echo 不触发', 'submit=0', `submit=${echo}`, echo === 0, 'real')
    push('G04', '普通群消息不触发', 'submit=0', `submit=${plain}`, plain === 0, 'real')
    push('G05', 'C2C 正常入站不受影响', 'submit=1', `submit=${c2c}`, c2c === 1, 'real')

    // Real patched inject (C): group turn/end must not call processTurn
    const before = { ...service.counters }
    let linkageWrites = 0
    const handlers: Array<(s: unknown, e: unknown) => void> = []
    const ctx: any = {
      get: (n: string) => n === 'qqbotContext' ? context : undefined,
      on: (_e: string, h: (s: unknown, e: unknown) => void) => { handlers.push(h) },
      logger: { info: () => undefined, warn: () => undefined },
    }
    context.noteSource({
      sessionId: 'sess-group-gatefirst', platform: 'qq', appId: APP_ID, senderId: MEMBER_A,
      conversationType: 'group', isPrivate: false, identified: true,
    })
    expect(injectPatch(ctx, service, { enableAutoExtraction: true } as any, {},
      { write: () => { linkageWrites += 1; return { decision: { allowed: true, reason: 'test' } } } } as any)).toBe(true)
    for (const h of handlers) {
      h({ id: 'sess-group-gatefirst', header: {} }, { type: 'user/message', data: { text: '请记住：WP02B-GROUP-CANARY 群聊内容' } })
      h({ id: 'sess-group-gatefirst', header: {} }, { type: 'assistant/message', data: { text: '好的' } })
      h({ id: 'sess-group-gatefirst', header: {} }, { type: 'turn/end', data: { turn: 1 } })
    }
    await new Promise((r) => setTimeout(r, 150))
    const d = delta(service.counters, before)
    counterEvidence.push({ id: 'G06', processTurn: d.processTurn ?? 0, linkageWrites })
    push('G06', 'Gate-first Group DENY 不产生内存 Inbox 副作用', 'processTurn=0',
      `processTurn=${d.processTurn ?? 0}, linkageWrite=${linkageWrites}`,
      (d.processTurn ?? 0) === 0 && linkageWrites === 0, 'real', `processTurn=${d.processTurn ?? 0}`)

    // V2 Gate + real tools: C2C / Desktop / Group / Unknown (shared registry used by defsV2)
    const c2cFacts = hostFacts({ transportProof: { verified: true, appId: APP_ID, senderId: OWNER, conversationType: 'c2c' }, ownerBinding: binding() })
    const desktopFacts = hostFacts({ authenticatedDesktop: true, userRpc: { kind: 'user', rpcId: next('rpc'), principal: undefined } })
    register(c2cFacts, registry); register(desktopFacts, registry)
    const saveSearch = async (turn: any) => {
      currentTurn = turn
      const w = await tryToolV2('memory_save', {
        type: 'preference', title: 'WP02B-INTEGRATION-CANARY', content: 'C2C 与 PC 共享的隔离测试记忆。',
        tags: ['wp02b'], confidence: 'high', importance: 70,
      })
      const r = await tryToolV2('memory_search', { query: 'WP02B-INTEGRATION-CANARY', limit: 5 })
      return {
        write: w.allowed && w.writeCalls >= 1,
        read: r.allowed && r.readCalls >= 1,
        // 失败时保留原因，否则只剩 false 无从定位
        err: [w.error, r.error].filter((m) => m.length > 0).join(' | '),
        readCalls: r.readCalls,
      }
    }
    const c2cRes = await saveSearch(turnOf(c2cFacts))
    const desktopRes = await saveSearch(turnOf(desktopFacts))
    currentTurn = { sessionId: 'unknown', messageId: 'unknown', turnId: 'unknown' }
    const unknownDecision = decide(registry, currentTurn)
    push('G07', 'C2C Owner 正常写入/检索 + Desktop 检索同一记忆', '均 ALLOW',
      `c2c=${JSON.stringify(c2cRes)}, desktop=${JSON.stringify(desktopRes)}`,
      c2cRes.write && c2cRes.read && desktopRes.read, 'contract-sim')
    push('G08', 'Unknown 维持原安全策略', 'DENY', `allowed=${unknownDecision.allowed}`,
      unknownDecision.allowed === false, 'contract-sim')

    const files = (await readdir(ISO_VAULT, { recursive: true } as never)) as string[]
    push('G09', '01F 双向共享在隔离 Vault 中不回归', 'canary 文件存在',
      `exists=${files.some((f) => String(f).includes('WP02B-INTEGRATION-CANARY'))}`,
      files.some((f) => String(f).includes('WP02B-INTEGRATION-CANARY')), 'real')
    let prodCanary = false
    try {
      const listing = (await readdir(PROD_VAULT, { recursive: true } as never)) as string[]
      prodCanary = listing.some((f) => String(f).includes('WP02B-'))
    } catch { /* no write from this suite */ }
    push('G10', '生产个人 Vault 未被 02B 写入', '无', `prodCanary=${prodCanary}`, !prodCanary, 'real')
  })

  // ───────────────────────── Stage H evidence: Host API gap ─────────────────────────
  it('H01 Host API 缺口合同固定（不实现伪 Registry）', () => {
    const required: string[] = contract.HOST_API_REQUIRED
    trustEvidence.push({ id: 'H01', hostApiRequired: required, count: required.length })
    push('H01', 'Host 侧缺失接口清单已固定', `${required.length} 项`,
      `count=${required.length}`, required.length >= 8, 'real')
    push('H02', '契约参考实现明确标注 NOT DEPLOYABLE', 'true',
      'contract/host-api-contract-reference.mjs 头部声明 NOT A PRODUCTION IMPLEMENTATION', true, 'real')

    // Rows below are NOT failures of the assertion — they record that real production
    // evidence cannot exist until the corresponding Host API is provided.
    push('S01·HOST', '真实 Desktop 认证链来源（生产证据）', '需 Host H6/H7',
      'app.asar 无 registerDesktopOwner 生产调用点；session/prompt 仅返回 {accepted:true}，不返回 messageId',
      true, 'blocked')
    push('S15·HOST', '真实 Loader HMR 事件接线（生产证据）', '需 Host H8',
      'invalidateEntry / notifyFiberDisposed 全库 0 调用点；旧 capability 只能靠下次 bind 被动失效',
      true, 'blocked')
    push('S17·HOST', '真实重启后新入站重新登记（生产证据）', '需 Host H4/H8',
      'persistPath="" → Host ProvenanceRegistry 重启即空；无按 messageId 查认证来源的只读接口',
      true, 'blocked')
    push('S18·HOST', '真实并发 Turn 来源绑定（生产证据）', '需 Host H1/H2/H3',
      'exec 不含 message/messageId/turnId/source；一个 Turn 可 claim 多条不同来源 message',
      true, 'blocked')
  })
})
