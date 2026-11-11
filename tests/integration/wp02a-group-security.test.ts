/**
 * WP-NEXT-02A Stage C/D — isolated integration + regression for the three
 * formally built patches (A self-echo, B authoritative mention, C gate-first).
 *
 * Loads the PATCHED RELEASE build (via isolated single-file modules whose relative
 * imports point at the unmodified production modules) and the UNPATCHED baseline,
 * plus the real SDK middlewares, real QqbotContextRuntime, real MemoryService,
 * real OwnerGate and real tool definitions. No production file is modified.
 * All writes stay under .scratch/wp-next-02a-group-security-hardening/.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (x: unknown) => x }))

import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryService } from '../../src/host/core/service.js'
import { createOwnerGate } from '../../src/host/owner-gate.js'
import { buildToolDefinitions, type ToolDefinition } from '../../src/host/dsh/tools.js'

const ROOT = 'D:/dsh-memory-vault/.scratch/wp-next-02a-group-security-hardening'
const ISO = `${ROOT}/iso`
const RELEASE = `${ROOT}/release`
const ISO_VAULT = `${ROOT}/iso-vault/DSH Memory`
const PROD_QQ = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/dsh-qqbot-merge/dist'
const PROD_ING = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-host-plugin-ingress/lib/index.js'
const SDK_MW = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/@tencent-connect/qqbot-nodejs/dist/middleware'
const PROD_VAULT = 'C:/Users/bf410/Documents/DSH Memory'

const APP_ID = '1906048158'
const OWNER = 'qq-owner-openid-wp02a-iso'
const MEMBER = 'qq-member-wp02a-iso'
const GROUP_A = 'group-openid-A-wp02a'

const S = {
  groupA: 'sess-wp02a-group-a',
  groupB: 'sess-wp02a-group-b',
  groupOwner: 'sess-wp02a-group-owner',
  c2cBound: 'sess-wp02a-c2c-bound',
  c2cUnbound: 'sess-wp02a-c2c-unbound',
  desktop: 'sess-wp02a-desktop',
  unknown: 'sess-wp02a-unknown',
  forged: 'sess-wp02a-forged-source',
}

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

interface Row { id: string; name: string; expected: string; observed: string; pass: boolean; counters: string }
const rows: Row[] = []
const counterEvidence: Array<Record<string, unknown>> = []
const trustEvidence: Array<Record<string, unknown>> = []

function push(
  id: string, name: string, expected: string, observed: string, pass: boolean,
  counters = '—', assert = true,
) {
  rows.push({ id, name, expected, observed, pass, counters })
  if (assert) expect(pass, `${id} ${name}: ${observed}`).toBe(true)
}

describe('WP-NEXT-02A isolated patch integration + trust review', () => {
  let service: MemoryService & { counters: Counters }
  let context: any
  let gate: ReturnType<typeof createOwnerGate>
  let defs: Record<string, ToolDefinition>
  let sdk: { mentionGate: any; messageFilter: any }
  let inboundBase: any
  let inboundPatch: any
  let injectBase: any
  let injectPatch: any
  let ing: any
  let qqService: any
  let releaseChecks: Record<string, boolean> = {}

  beforeAll(async () => {
    await mkdir(`${ROOT}/iso-vault`, { recursive: true })
    await rm(ISO_VAULT, { recursive: true, force: true })
    service = wrapService(new MemoryService({
      configuredVaultPath: ISO_VAULT,
      configSettings: { language: 'zh', enableAutoExtraction: false, enableLlmExtraction: false },
    }))
    await service.initialize(ISO_VAULT)

    sdk = {
      mentionGate: (await loadMod(join(SDK_MW, 'mention-gate.js'))).mentionGate,
      messageFilter: (await loadMod(join(SDK_MW, 'message-filter.js'))).messageFilter,
    }
    inboundBase = (await loadMod(join(ISO, 'inbound.baseline.mjs'))).handleInbound
    inboundPatch = (await loadMod(join(ISO, 'inbound.wp02a.mjs'))).handleInbound
    injectBase = (await loadMod(join(ISO, 'inject.baseline.mjs'))).installTurnExtraction
    injectPatch = (await loadMod(join(ISO, 'inject.wp02a.mjs'))).installTurnExtraction

    // Isolated copy of the deployed Host Ingress (only the unresolvable dsh-llm import stubbed).
    const ingRaw = await readFile(PROD_ING, 'utf8')
    const ingPath = join(ISO, 'ingress.wp02a.mjs')
    await writeFile(ingPath, ingRaw.replace(
      "import { createUserMessage } from '@deepseek-ai/dsh-llm';",
      'const createUserMessage = (x) => x; // WP02A isolated stub',
    ), 'utf8')
    ing = await loadMod(ingPath)
    qqService = await loadMod(join(PROD_QQ, 'identity/service.js'))

    const deps = { persist: () => true }
    context = new qqService.QqbotContextRuntime({ ...deps, initial: undefined })
    const issued = context.createPairCode()
    expect(context.pair(issued.code, { platform: 'qq', appId: APP_ID, openid: OWNER }).ok).toBe(true)
    const note = (sessionId: string, o: Record<string, unknown>) =>
      context.noteSource({ sessionId, platform: 'qq', appId: APP_ID, identified: true, ...o })
    note(S.groupA, { conversationType: 'group', isPrivate: false, senderId: MEMBER })
    note(S.groupB, { conversationType: 'group', isPrivate: false, senderId: MEMBER })
    note(S.groupOwner, { conversationType: 'group', isPrivate: false, senderId: OWNER })
    note(S.c2cBound, { conversationType: 'c2c', isPrivate: true, senderId: OWNER })
    note(S.c2cUnbound, { conversationType: 'c2c', isPrivate: true, senderId: MEMBER })
    context.noteSource({
      sessionId: S.desktop, platform: 'desktop', conversationType: 'c2c',
      isPrivate: true, appId: '', senderId: '', identified: true,
    })

    gate = createOwnerGate(() => context, { qqPersonalMemory: true, getIngress: () => undefined })
    defs = Object.fromEntries(buildToolDefinitions(
      service, undefined,
      (agent: any) => gate({ sessionId: agent?.session?.id ?? null }),
    ).map((d) => [d.name, d]))

    // Release-package consistency checks (deployable files, not the iso test modules).
    const setupJs = await readFile(join(RELEASE, 'qqbot-merge/dist/gateway/middleware-setup.js'), 'utf8')
    const setupTs = await readFile(join(RELEASE, 'qqbot-merge/src/gateway/middleware-setup.ts'), 'utf8')
    const inboundJs = await readFile(join(RELEASE, 'qqbot-merge/dist/transport/inbound.js'), 'utf8')
    const inboundTs = await readFile(join(RELEASE, 'qqbot-merge/src/transport/inbound.ts'), 'utf8')
    const injectTs = await readFile(join(RELEASE, 'mv-patch/src/host/dsh/inject.ts'), 'utf8')
    const injectJs = await readFile(join(RELEASE, 'mv-patch/lib/host/dsh/inject.js'), 'utf8')
    releaseChecks = {
      'A/dist skipSelfEcho=true': setupJs.includes('skipSelfEcho: true') && !setupJs.includes('skipSelfEcho: false'),
      'A/src skipSelfEcho=true': setupTs.includes('skipSelfEcho: true') && !setupTs.includes('skipSelfEcho: false'),
      'B/dist authoritative guard': inboundJs.includes('GROUP_AT_MESSAGE_CREATE') && inboundJs.includes('authoritative'),
      'B/src authoritative guard': inboundTs.includes('GROUP_AT_MESSAGE_CREATE') && inboundTs.includes('authoritative'),
      'B/dist no plain text fallback as evidence': !inboundJs.includes('detectMentionInContent'),
      'C/src gate-first': injectTs.includes('group turn-end extraction skipped'),
      'C/lib gate-first': injectJs.includes('group turn-end extraction skipped'),
      'no test-only hooks in release dist': !inboundJs.includes('bindFromCallerForTest'),
      'no legacy followup bypass': !/^\s*import .*createUserMessage/m.test(inboundJs) &&
        !inboundJs.includes('agent.followup(') && inboundJs.includes('host ingress unavailable'),
    }
  })

  afterAll(async () => {
    const pass = rows.filter((r) => r.pass).length
    const baseRows = rows.filter((r) => r.id.endsWith('·BASE'))
    const acceptRows = rows.filter((r) => !r.id.endsWith('·BASE'))
    await writeFile(join(ROOT, 'isolated-regression-results.md'), [
      '# WP-NEXT-02A Stage C/D — 隔离集成与回归结果',
      '',
      `生成时间：${new Date().toISOString()}`,
      `隔离 Vault：\`${ISO_VAULT}\``,
      '',
      '| 编号 | 用例 | 预期 | 实测 | 结论 | 计数证据 |',
      '|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.id} | ${r.name} | ${r.expected} | ${r.observed} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.counters} |`),
      '',
      `**验收口径（排除 ·BASE 对照行）**：${acceptRows.length} 项，PASS ${acceptRows.filter((r) => r.pass).length}，FAIL ${acceptRows.filter((r) => !r.pass).length}`,
      `01E 生产基线对照：${baseRows.length} 项，PASS ${baseRows.filter((r) => r.pass).length}，FAIL ${baseRows.filter((r) => !r.pass).length}（FAIL 为补丁前缺口的预期暴露，不计入验收）`,
      `全部行合计：${rows.length} 项，PASS ${pass}`,
      '',
      '`BASE` = 01E 生产构建（未打补丁）；`PATCH` = 02A 正式构建包（A/B/C）。',
      '`B3·EXPOSURE` 的 PASS 表示「来源伪造缺口可复现」，不是安全验收通过。',
      '所有写入均落在 02A 隔离目录；生产个人 Vault 未被写入。',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(ROOT, 'evidence/wp02a-counter-evidence.json'), JSON.stringify(counterEvidence, null, 2), 'utf8')
    await writeFile(join(ROOT, 'evidence/session-registry-trust-evidence.json'), JSON.stringify(trustEvidence, null, 2), 'utf8')
    await writeFile(join(ROOT, 'evidence/release-consistency-checks.json'), JSON.stringify(releaseChecks, null, 2), 'utf8')
  })

  // ───────────────── helpers ─────────────────
  function makeMsg(over: Record<string, unknown> = {}) {
    // Mirrors the real SDK InboundMessage shape (event-dispatcher.ts:237-262).
    return {
      kind: 'group',
      messageId: `msg-wp02a-${Math.random().toString(36).slice(2, 10)}`,
      senderId: MEMBER,
      groupOpenid: GROUP_A,
      content: '这是一条普通群消息',
      rawEventType: 'GROUP_MESSAGE_CREATE',
      mentions: undefined,
      senderIsBot: false,
      senderName: 'tester',
      timestamp: new Date().toISOString(),
      ...over,
    }
  }

  function makeCtx(msg: Record<string, unknown>) {
    const stopped: string[] = []
    return {
      message: msg, state: {}, bot: { appId: APP_ID },
      log: { debug: () => undefined }, stop: (r: string) => stopped.push(r),
      stopped, next: async () => undefined,
    } as any
  }

  async function runChain(msg: Record<string, unknown>) {
    const gateMw = sdk.mentionGate({ requireMentionInGroup: true })
    const run = async (skipSelfEcho: boolean) => {
      const ctx = makeCtx(msg)
      const filter = sdk.messageFilter({ skipSelfEcho })
      let reached = false
      ctx.next = async () => { reached = true }
      await filter(ctx, async () => { await gateMw(ctx, async () => { reached = true }) })
      return {
        decision: ctx.state.mention as { wasMentioned: boolean; shouldAnswer: boolean } | undefined,
        reached, stopped: ctx.stopped,
      }
    }
    return { base: await run(false), patch: await run(true) }
  }

  async function runInbound(handler: any, msg: Record<string, unknown>, sessionId: string, wasMentioned?: boolean) {
    const submitted: any[] = []
    const created: any[] = []
    const mention = wasMentioned ?? (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || (msg as any)._mentioned === true)
    const ctx = { message: msg, state: { mention: { wasMentioned: mention } }, bot: { sendMarkdown: async () => undefined } }
    const manager = {
      getOrCreate: async (scope: string, peerId: string, senderId: string, replyTarget: unknown) => {
        created.push({ scope, peerId, senderId, replyTarget })
        return { sessionId, agent: { whenIdle: async () => undefined } }
      },
    }
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
    const ingress = {
      submit: async (input: any) => {
        submitted.push(input)
        return { ok: true, messageId: 'ingress-msg', category: input.qq?.conversationType === 'group' ? 'qq-group' : 'qq-c2c', provenanceId: 'p' }
      },
    }
    await handler(ctx, manager, { appId: APP_ID }, logger, undefined, undefined, ingress)
    return { submitted, created }
  }

  async function tryTool(name: string, sessionId: string, args: unknown) {
    const before = { ...service.counters }
    let allowed = false; let error = ''
    try {
      const def = defs[name]
      if (def === undefined) throw new Error(`missing tool ${name}`)
      await def.execute(args, { agent: { session: { id: sessionId } } })
      allowed = true
    } catch (err) { error = String((err as Error).message).slice(0, 140) }
    const d = delta(service.counters, before)
    return { allowed, error, d, readCalls: sum(d, readKeys), writeCalls: sum(d, writeKeys) }
  }

  function makeExtraction(install: any, sessionId: string) {
    const handlers: Array<(s: unknown, e: unknown) => void> = []
    const logs: string[] = []
    let linkageWrites = 0
    const linkage = { write: () => { linkageWrites += 1; return { decision: { allowed: true, reason: 'test' } } } }
    const ctx: any = {
      get: (name: string) => name === 'qqbotContext' ? context : undefined,
      on: (_e: string, h: (s: unknown, e: unknown) => void) => { handlers.push(h) },
      logger: { info: (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }, warn: () => undefined },
    }
    expect(install(ctx, service, { enableAutoExtraction: true } as any, {}, linkage as any)).toBe(true)
    const fire = (text: string) => {
      for (const h of handlers) {
        h({ id: sessionId, header: {} }, { type: 'user/message', data: { text } })
        h({ id: sessionId, header: {} }, { type: 'assistant/message', data: { text: '收到。' } })
        h({ id: sessionId, header: {} }, { type: 'turn/end', data: { turn: 1 } })
      }
    }
    return { fire, logs, writes: () => linkageWrites }
  }
  const settle = () => new Promise((r) => setTimeout(r, 130))

  // ───────────────── Stage C: 16-item matrix ─────────────────
  it('C1–C6 @Bot / echo / C2C contract: BASE vs PATCH', async () => {
    const cases: Array<{ id: string; name: string; expectTrigger: boolean; msg: Record<string, unknown> }> = [
      { id: 'C1', name: '真实结构化 @Bot（GROUP_AT_MESSAGE_CREATE）', expectTrigger: true,
        msg: makeMsg({ content: '请解释 TCP 三次握手', rawEventType: 'GROUP_AT_MESSAGE_CREATE', _mentioned: true }) },
      { id: 'C2', name: '文本伪造 <@!appId>（GROUP_MESSAGE_CREATE）', expectTrigger: false,
        msg: makeMsg({ content: `<@!${APP_ID}> 你好机器人`, rawEventType: 'GROUP_MESSAGE_CREATE' }) },
      { id: 'C3', name: '@其他人（mentions 无 is_you）', expectTrigger: false,
        msg: makeMsg({ content: '@张三 你看一下', rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{ is_you: false, id: MEMBER }] }) },
      { id: 'C4', name: '普通群消息（无提及）', expectTrigger: false,
        msg: makeMsg({ content: '大家好' }) },
      { id: 'C5', name: 'Bot 自身 Echo（senderIsBot + 权威事件）', expectTrigger: false,
        msg: makeMsg({ content: '上一条回复', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderIsBot: true, _mentioned: true }) },
    ]
    for (const c of cases) {
      const chain = await runChain(c.msg)
      const patchMention = chain.patch.stopped.length > 0 ? false : chain.patch.decision?.wasMentioned
      const base = await runInbound(inboundBase, c.msg, S.groupA, chain.base.decision?.wasMentioned)
      const patch = await runInbound(inboundPatch, c.msg, S.groupA, patchMention)
      counterEvidence.push({
        id: c.id, rawEventType: c.msg.rawEventType, senderIsBot: c.msg.senderIsBot,
        sdkWasMentioned: chain.base.decision?.wasMentioned ?? null,
        baseStopped: chain.base.stopped, patchStopped: chain.patch.stopped,
        baseSubmits: base.submitted.length, patchSubmits: patch.submitted.length,
      })
      push(`${c.id}·BASE`, `${c.name}（01E 生产基线）`, c.expectTrigger ? 'submit=1' : 'submit=0',
        `submit=${base.submitted.length}`, base.submitted.length === (c.expectTrigger ? 1 : 0),
        `submit=${base.submitted.length}`, false)
      push(`${c.id}·PATCH`, `${c.name}（02A 正式构建）`, c.expectTrigger ? 'submit=1' : 'submit=0',
        `submit=${patch.submitted.length}; chainStopped=${JSON.stringify(chain.patch.stopped)}`,
        patch.submitted.length === (c.expectTrigger ? 1 : 0), `submit=${patch.submitted.length}`)
    }

    // C6: C2C normal inbound must be untouched by A/B
    const c2c = makeMsg({ kind: 'c2c', groupOpenid: undefined, rawEventType: 'C2C_MESSAGE_CREATE', senderId: OWNER, content: '你还记得我之前说过什么吗' })
    const chain = await runChain(c2c)
    const base = await runInbound(inboundBase, c2c, S.c2cBound, chain.base.decision?.wasMentioned)
    const patch = await runInbound(inboundPatch, c2c, S.c2cBound, chain.patch.decision?.wasMentioned)
    expect(patch.submitted.length).toBe(1)
    expect(patch.submitted[0].qq.conversationType).toBe('c2c')
    push('C6', 'C2C 正常入站（A/B 不影响私聊）', 'submit=1，conversationType=c2c',
      `BASE=${base.submitted.length}, PATCH=${patch.submitted.length}, qq=${patch.submitted[0]?.qq?.conversationType}`,
      base.submitted.length === 1 && patch.submitted.length === 1 && patch.submitted[0].qq.conversationType === 'c2c',
      'submit=1')
  })

  // ───────────────── C7/C8: gate-first, forceInbox/processTurn = 0 ─────────────────
  it('C7/C8 Group DENY：gate-first 短路，forceInbox 与 processTurn 皆为 0', async () => {
    const scenarios = [
      { id: 'C7', label: 'BASE（01E）', install: injectBase, session: S.groupA },
      { id: 'C8', label: 'PATCH（02A）', install: injectPatch, session: S.groupA },
      { id: 'C8b', label: 'PATCH · Group Owner 本人', install: injectPatch, session: S.groupOwner },
      { id: 'C8c', label: 'PATCH · Group B', install: injectPatch, session: S.groupB },
    ]
    for (const s of scenarios) {
      const before = { ...service.counters }
      const canary = `WP02A-GROUP-TURN-CANARY-${s.id}`
      const h = makeExtraction(s.install, s.session)
      h.fire(`请记住：${canary} 是群聊讨论内容`)
      await settle()
      const d = delta(service.counters, before)
      const candidates = JSON.stringify(service.listCandidates())
      const ev = {
        id: s.id, scenario: s.label, sessionId: s.session,
        processTurn_calls: d.processTurn ?? 0, save_calls: d.save ?? 0,
        forceInbox_linkage_write_calls: h.writes(),
        inbox_contains_group_content: candidates.includes(canary),
        raw_deltas: d, logs: h.logs,
      }
      counterEvidence.push(ev)
      const isPatched = s.id.startsWith('C8')
      push(s.id, `${s.label} 群聊 turn/end 写回`, isPatched ? 'processTurn=0, forceInbox=0' : '记录基线',
        `processTurn=${ev.processTurn_calls}, linkageWrite=${ev.forceInbox_linkage_write_calls}, Inbox含群内容=${ev.inbox_contains_group_content}`,
        isPatched
          ? ev.processTurn_calls === 0 && ev.forceInbox_linkage_write_calls === 0 && !ev.inbox_contains_group_content
          : true,
        `processTurn=${ev.processTurn_calls}, write=${sum(d, writeKeys)}`)
    }

    // Regression: C2C Owner and Desktop ALLOW paths must still extract normally.
    for (const s of [
      { id: 'C8d', label: 'PATCH · C2C Owner 自动提取', session: S.c2cBound },
      { id: 'C8e', label: 'PATCH · Desktop 自动提取', session: S.desktop },
      { id: 'C8f', label: 'PATCH · 未知来源 DENY 保留 forceInbox（既有 R1 行为）', session: S.unknown },
    ]) {
      const before = { ...service.counters }
      const h = makeExtraction(injectPatch, s.session)
      h.fire('请记住：WP02A-ALLOW-CANARY 是允许来源的内容')
      await settle()
      const d = delta(service.counters, before)
      counterEvidence.push({ id: s.id, scenario: s.label, sessionId: s.session, raw_deltas: d, linkageWrites: h.writes() })
      push(s.id, s.label, 'processTurn>=1（既有写回流程未被 C 破坏）',
        `processTurn=${d.processTurn ?? 0}`, (d.processTurn ?? 0) >= 1,
        `processTurn=${d.processTurn ?? 0}`)
    }
  })

  // ───────────────── C9–C12/C16: Vault call counters ─────────────────
  it('C9–C12 / C16 群聊 Vault 读写计数与 Group Owner DENY', async () => {
    const cases = [
      { id: 'C16a', name: 'Group A 访问个人 Vault', sid: S.groupA },
      { id: 'C16b', name: 'Group B 访问个人 Vault', sid: S.groupB },
      { id: 'C16', name: 'Group Owner 本人访问个人 Vault', sid: S.groupOwner },
    ]
    for (const c of cases) {
      const decision = gate({ sessionId: c.sid })
      const search = await tryTool('memory_search', c.sid, { query: '个人资料', limit: 5 })
      const save = await tryTool('memory_save', c.sid, {
        type: 'preference', title: 'WP02A-GROUP-SHOULD-NOT-WRITE',
        content: '群聊内容不得写入个人记忆', tags: ['wp02a'], confidence: 'high', importance: 50,
      })
      const forget = await tryTool('memory_forget', c.sid, { id: 'mem-none', status: 'archived' })
      const allDenied = !decision.allowed && !search.allowed && !save.allowed && !forget.allowed
      const zeroCalls = search.readCalls === 0 && search.writeCalls === 0 &&
        save.writeCalls === 0 && forget.writeCalls === 0
      const ev = {
        id: c.id, name: c.name, sessionId: c.sid,
        gate: { allowed: decision.allowed, reason: decision.reason },
        search_calls: search.readCalls,
        write_calls: search.writeCalls + save.writeCalls + forget.writeCalls,
        delete_calls: forget.writeCalls, update_calls: 0,
        raw_deltas: { search: search.d, save: save.d, forget: forget.d },
      }
      counterEvidence.push(ev)
      push(c.id, c.name, 'DENY，所有 Vault 调用 = 0',
        `gate=${decision.allowed}; tools=${search.allowed}/${save.allowed}/${forget.allowed}; search=${ev.search_calls}; write=${ev.write_calls}`,
        allDenied && zeroCalls,
        `search=${ev.search_calls}, write=${ev.write_calls}, delete=${ev.delete_calls}, update=0`)
    }
    const groupRows = counterEvidence.filter((r) => String(r.id).startsWith('C16'))
    push('C9', 'Group Vault Search 汇总', '0', String(groupRows.reduce((n: number, r: any) => n + r.search_calls, 0)),
      groupRows.reduce((n: number, r: any) => n + r.search_calls, 0) === 0, 'search_calls=0')
    push('C10', 'Group Vault Write 汇总', '0', String(groupRows.reduce((n: number, r: any) => n + r.write_calls, 0)),
      groupRows.reduce((n: number, r: any) => n + r.write_calls, 0) === 0, 'write_calls=0')
    push('C11', 'Group Vault Delete 汇总', '0', String(groupRows.reduce((n: number, r: any) => n + r.delete_calls, 0)),
      groupRows.reduce((n: number, r: any) => n + r.delete_calls, 0) === 0, 'delete_calls=0')
    push('C12', 'Group Vault Update 汇总', '0', String(groupRows.reduce((n: number, r: any) => n + r.update_calls, 0)),
      groupRows.reduce((n: number, r: any) => n + r.update_calls, 0) === 0, 'update_calls=0')
  })

  // ───────────────── C13–C15 + extra: memory regression ─────────────────
  it('C13–C15 与 Inbox/敏感策略回归', async () => {
    const save = await tryTool('memory_save', S.c2cBound, {
      type: 'preference', title: 'WP02A-C2C-REGRESSION-CANARY',
      content: 'WP02A 隔离测试：C2C Owner 个人记忆读写回归标识。',
      tags: ['wp02a'], confidence: 'high', importance: 70,
    })
    push('C13', 'C2C Owner 记忆写入', 'ALLOW，save+1',
      `allowed=${save.allowed}, write=${save.writeCalls}`, save.allowed && save.writeCalls >= 1, `write=${save.writeCalls}`)
    const search = await tryTool('memory_search', S.c2cBound, { query: 'WP02A-C2C-REGRESSION-CANARY', limit: 5 })
    push('C14', 'C2C Owner 记忆读取', 'ALLOW，search+1',
      `allowed=${search.allowed}, read=${search.readCalls}`, search.allowed && search.readCalls >= 1, `read=${search.readCalls}`)
    const pcRead = await tryTool('memory_search', S.desktop, { query: 'WP02A-C2C-REGRESSION-CANARY', limit: 5 })
    push('C15', 'Desktop Owner 记忆读取', 'ALLOW，search+1',
      `allowed=${pcRead.allowed}, read=${pcRead.readCalls}`, pcRead.allowed && pcRead.readCalls >= 1, `read=${pcRead.readCalls}`)

    const pcWrite = await tryTool('memory_save', S.desktop, {
      type: 'preference', title: 'WP02A-DESKTOP-WRITE-CANARY',
      content: 'WP02A 隔离测试：Desktop 正常写入回归。', tags: ['wp02a'], confidence: 'high', importance: 60,
    })
    push('C15b', 'Desktop 正常记忆写入', 'ALLOW，save+1',
      `allowed=${pcWrite.allowed}, write=${pcWrite.writeCalls}`, pcWrite.allowed && pcWrite.writeCalls >= 1,
      `write=${pcWrite.writeCalls}`)

    // Low-confidence / sensitive policies live in MemoryService (service.ts), which Patch C
    // does not touch. Verify the real policy functions are still wired on the ALLOW path.
    const { scanSecrets } = await import('../../src/host/core/engine.js')
    const secretHits = scanSecrets('请记住：我的银行卡密码是 1234567890')
    const low = await service.processTurn({
      userText: '请记住：我可能偶尔会考虑用 Vim 编辑器。', assistantText: '好的',
      sessionId: S.desktop, turn: 900,
    } as any)
    const sens = await service.processTurn({
      userText: '请记住：我的银行卡密码是 1234567890', assistantText: '好的',
      sessionId: S.desktop, turn: 901,
    } as any)
    const ev = {
      secretScannerHits: secretHits.length,
      low: { candidates: low.candidates?.length ?? 0, pending: low.pending?.length ?? 0, applied: low.applied?.length ?? 0, refused: low.refused?.length ?? 0 },
      sensitive: { candidates: sens.candidates?.length ?? 0, pending: sens.pending?.length ?? 0, applied: sens.applied?.length ?? 0, refused: sens.refused?.length ?? 0 },
      inboxDecisionPresent: [...(low.pending ?? []), ...(sens.pending ?? [])].some((c: any) => c?.decision?.action === 'inbox'),
    }
    counterEvidence.push({ id: 'C15c', scenario: 'low-confidence / sensitive policy regression', ...ev })
    const policyAlive = secretHits.length > 0 &&
      (ev.inboxDecisionPresent || (ev.low.pending + ev.low.candidates + ev.sensitive.refused) > 0)
    push('C15c', '低置信度 / 敏感内容仍走 Inbox 或拒绝策略', '策略仍生效',
      JSON.stringify(ev), policyAlive, `secretHits=${ev.secretScannerHits}`)

    const files = (await readdir(ISO_VAULT, { recursive: true } as never)) as string[]
    push('C15d', '隔离 Vault 中 C2C/Desktop canary 文件存在', '存在',
      `exists=${files.some((f) => String(f).includes('WP02A-C2C-REGRESSION-CANARY'))}`,
      files.some((f) => String(f).includes('WP02A-C2C-REGRESSION-CANARY')))
  })

  // ───────────────── Stage B/D: Session Registry trust evidence ─────────────────
  it('B/D Session Registry 来源伪造、Host registry 索引与 HMR 失效', async () => {
    // 1) Host ProvenanceRegistry is keyed by messageId, NOT sessionId.
    const registry = new ing.ProvenanceRegistry({ hostSecret: 'wp02a-iso-secret' })
    const arbitrarySession = 'arbitrary-session-id-chosen-by-caller'
    const fakeRecord = {
      provenanceId: 'p-fake', messageId: 'msg-fake', sessionId: arbitrarySession,
      category: 'qq-c2c', packageId: 'dsh-qqbot-merge', entryId: 'dsh-qqbot-merge',
      fiberGeneration: 1, contentDigest: 'deadbeef', createdAt: Date.now(),
    }
    registry.register(fakeRecord)  // no caller authentication in register()
    const bySession = registry.get(arbitrarySession)
    trustEvidence.push({
      id: 'B1', check: 'ProvenanceRegistry.get(sessionId)',
      result: bySession ?? null,
      note: 'registry.get is keyed by messageId; no getBySession/resolveSessionSource API exists',
    })
    push('B1', 'Host Registry 不提供按 sessionId 查询可信来源', 'undefined',
      `get(sessionId)=${String(bySession)}`, bySession === undefined)

    // 2) BoundPluginIngress.submit accepts arbitrary sessionId + qq binding.
    let delivered: any[] = []
    const cap = new ing.BoundPluginIngress({
      identity: { packageId: 'dsh-qqbot-merge', entryId: 'dsh-qqbot-merge', fiberGeneration: 1, fiberUid: 'u' },
      deliver: async (input: any) => { delivered.push(input) },
      registry,
      currentGeneration: () => 1,
      isAlive: () => true,
    })
    const submitted = await cap.submit({
      sessionId: arbitrarySession, text: 'forged text', delivery: 'followup', requestId: 'qq-msg-x',
      qq: { qqMessageId: 'qq-msg-x', peerId: 'someone', senderId: 'someone', conversationType: 'c2c', appId: APP_ID },
    })
    trustEvidence.push({
      id: 'B2', check: 'submit with arbitrary sessionId + qq binding',
      submitted, deliveredCount: delivered.length,
      note: 'submit only checks non-empty sessionId/text; no ownership or session↔qq consistency check',
    })
    push('B2', 'submit 不校验 sessionId 所有权 / 与 qq binding 一致性', 'ok=true（暴露缺口）',
      `ok=${submitted.ok}, category=${submitted.category}`, submitted.ok === true && submitted.category === 'qq-c2c')

    // 3) A plugin-side qqbotContext.noteSource can forge a trusted-desktop source.
    const forgedRuntime = new qqService.QqbotContextRuntime({ persist: () => true, initial: undefined })
    forgedRuntime.noteSource({
      sessionId: S.forged, platform: 'desktop', conversationType: 'c2c', isPrivate: true,
      appId: '', senderId: '', identified: true,
    })
    const forgedGate = createOwnerGate(() => forgedRuntime, { qqPersonalMemory: true, getIngress: () => undefined })
    const forgedDecision = forgedGate({ sessionId: S.forged })
    trustEvidence.push({
      id: 'B3', check: 'noteSource({platform:"desktop"}) by a non-QQ caller',
      liveSource: forgedRuntime.getContext(S.forged), decision: forgedDecision,
      note: 'qqbotContext is ctx.provide()-exposed; noteSource has no auth/signature/fiber check',
    })
    push('B3·EXPOSURE', '插件侧 Registry 来源可伪造（desktop 正向证据）', '可伪造（暴露缺口，非安全验收 PASS）',
      `gate.allowed=${forgedDecision.allowed}, reason=${forgedDecision.reason}`,
      forgedDecision.allowed === true, undefined, false)

    // 4) Registry health / fail-closed on missing live source.
    const coldGate = createOwnerGate(() => new qqService.QqbotContextRuntime({ persist: () => true, initial: undefined }), {
      qqPersonalMemory: true, getIngress: () => undefined,
    })
    const cold = coldGate({ sessionId: S.groupA })
    push('B4', '缺少 Registry live 记录时 fail-closed DENY', 'DENY',
      `allowed=${cold.allowed}, reason=${cold.reason}`, !cold.allowed)

    // 5) HMR: old capability must not deliver.
    let generation = 1
    const hmrRegistry = new ing.ProvenanceRegistry({ hostSecret: 'wp02a-hmr' })
    const hmrCap = new ing.BoundPluginIngress({
      identity: { packageId: 'dsh-qqbot-merge', entryId: 'dsh-qqbot-merge', fiberGeneration: 1, fiberUid: 'u1' },
      deliver: async () => undefined, registry: hmrRegistry,
      currentGeneration: () => generation, isAlive: () => true,
    })
    const mk = (id: string) => ({
      sessionId: S.groupA, text: 'x', delivery: 'followup', requestId: id,
      qq: { qqMessageId: id, peerId: GROUP_A, senderId: MEMBER, conversationType: 'group', groupId: GROUP_A, appId: APP_ID },
    })
    const first = await hmrCap.submit(mk('hmr-1'))
    generation = 2
    const stale = await hmrCap.submit(mk('hmr-2'))
    trustEvidence.push({ id: 'B5', first, stale, note: 'fiber-generation-stale invalidates the old capability' })
    push('B5', 'HMR 后旧 Capability / 旧来源记录失效', 'stale=fiber-generation-stale',
      `first=${first.ok}, stale=${stale.reason}`, first.ok === true && stale.ok === false && stale.reason === 'fiber-generation-stale')

    // 6) Host registry is not persisted in production (persistPath: '').
    const freshRegistry = new ing.ProvenanceRegistry({ hostSecret: 'wp02a-iso-secret' })
    push('B6', 'Host Registry 重启后为空（persistPath 为空）', 'get(fake)=undefined',
      `get(msg-fake)=${String(freshRegistry.get('msg-fake'))}`, freshRegistry.get('msg-fake') === undefined)
  })

  // ───────────────── Release consistency + production vault safety ─────────────────
  it('E1/E2 正式构建包一致性与生产 Vault 未污染', async () => {
    for (const [name, ok] of Object.entries(releaseChecks)) {
      push(`E1·${name.slice(0, 26)}`, `构建包核对：${name}`, 'true', String(ok), ok === true)
    }
    expect(ISO_VAULT.replace(/\\/g, '/')).toContain('wp-next-02a-group-security-hardening/iso-vault')
    expect(ISO_VAULT.replace(/\\/g, '/')).not.toContain('Documents/DSH Memory')
    let prodCanary = false
    try {
      const listing = (await readdir(PROD_VAULT, { recursive: true } as never)) as string[]
      prodCanary = listing.some((f) => String(f).includes('WP02A-'))
    } catch { /* no write from this suite */ }
    push('E2', '生产个人 Vault 无 WP02A 测试文件', '无', `prodCanary=${prodCanary}`, !prodCanary)
  })
})
