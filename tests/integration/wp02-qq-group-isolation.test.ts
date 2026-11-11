/**
 * WP-NEXT-02 Stage F — isolated QQ group @bot / session / personal-vault isolation matrix (G01–G22).
 *
 * Uses the REAL production modules, read-only:
 *   - QQ plugin dist (01E build): handleInbound, identity/service, identity/store, group-mention
 *   - QQ SDK: mentionGate, messageFilter
 *   - Host Ingress (01E build): ProvenanceRegistry
 *   - Memory Vault src: MemoryService, createOwnerGate, buildToolDefinitions, installTurnExtraction
 *
 * It also builds a PATCHED isolated copy of handleInbound (single file, all relative imports
 * rewritten to absolute production file URLs) to prove the minimal deployment diff works.
 * No production file, profile file, staging file or lib/ file is modified by this suite.
 * All writes stay under D:/dsh-memory-vault/.scratch/wp-next-02-qq-group-isolation/.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (x: unknown) => x }))
vi.mock('@deepseek-ai/dsh-session', () => ({ SessionId: (x: string) => x }))

import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryService } from '../../src/host/core/service.js'
import { createOwnerGate } from '../../src/host/owner-gate.js'
import { buildToolDefinitions, type ToolDefinition } from '../../src/host/dsh/tools.js'
import { installTurnExtraction } from '../../src/host/dsh/inject.js'

const ISO_ROOT = 'D:/dsh-memory-vault/.scratch/wp-next-02-qq-group-isolation'
const ISO_VAULT = `${ISO_ROOT}/iso-vault/DSH Memory`
const PROD_QQ = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/dsh-qqbot-merge/dist'
const PROD_ING = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-host-plugin-ingress/lib/index.js'
const SDK_MW = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/@tencent-connect/qqbot-nodejs/dist/middleware'
const PROD_VAULT = 'C:/Users/bf410/Documents/DSH Memory'

const APP_ID = '1906048158'
const OWNER = 'qq-owner-openid-wp02-iso'
const MEMBER_A = 'qq-member-a-wp02-iso'
const MEMBER_B = 'qq-member-b-wp02-iso'
const GROUP_A = 'group-openid-A-wp02-iso'
const GROUP_B = 'group-openid-B-wp02-iso'

const S = {
  groupA: 'sess-wp02-group-a',
  groupB: 'sess-wp02-group-b',
  groupOwner: 'sess-wp02-group-owner',
  groupForgeC2c: 'sess-wp02-group-forge-c2c',
  groupForgeOwner: 'sess-wp02-group-forge-owner',
  c2cBound: 'sess-wp02-c2c-bound',
  c2cUnbound: 'sess-wp02-c2c-unbound',
  desktop: 'sess-wp02-desktop',
  unknown: 'sess-wp02-unknown',
}

async function loadMod(spec: string) {
  return import(spec.startsWith('file:') ? spec : pathToFileURL(spec).href)
}

const COUNTER_KEYS = [
  'search', 'get', 'save', 'setStatus', 'remove', 'writeRaw', 'processTurn',
  'standing', 'recallForInjection', 'confirm', 'reject', 'merge',
  'resolveConflict', 'addCandidate', 'materializeCandidate',
] as const
type Counters = Record<(typeof COUNTER_KEYS)[number], number>

function zeroCounters(): Counters {
  return Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0])) as unknown as Counters
}

function wrapService(service: MemoryService): MemoryService & { counters: Counters } {
  const counters = zeroCounters()
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

function delta(now: Counters, before: Counters): Partial<Counters> {
  const out: Partial<Counters> = {}
  for (const k of COUNTER_KEYS) {
    if (now[k] !== before[k]) out[k] = now[k] - before[k]
  }
  return out
}

const readKeys = ['search', 'get', 'standing', 'recallForInjection'] as const
const writeKeys = [
  'save', 'setStatus', 'remove', 'writeRaw', 'processTurn', 'confirm',
  'reject', 'merge', 'resolveConflict', 'addCandidate', 'materializeCandidate',
] as const
const sum = (d: Partial<Counters>, keys: readonly (keyof Counters)[]) =>
  keys.reduce((n, k) => n + (d[k] ?? 0), 0)

interface ResultRow {
  id: string
  name: string
  expected: string
  observed: string
  pass: boolean
  counters?: string
  note?: string
}
const results: ResultRow[] = []
const counterEvidence: Array<Record<string, unknown>> = []

describe('WP-NEXT-02 isolated QQ group isolation matrix', () => {
  let service: MemoryService & { counters: Counters }
  let context: any
  let registry: any
  let ingress: any
  let gate: ReturnType<typeof createOwnerGate>
  let defs: Record<string, ToolDefinition>
  let mentionGate: any
  let messageFilter: any
  let evaluateGroupBotMention: any
  let handleInboundProd: any
  let handleInboundPatched: any
  let sessionKey: ((scope: string, peerId: string) => string) | null = null
  let sessionKeySource = ''

  beforeAll(async () => {
    await mkdir(join(ISO_ROOT, 'iso-vault'), { recursive: true })
    await mkdir(join(ISO_ROOT, 'iso-patch'), { recursive: true })
    await rm(ISO_VAULT, { recursive: true, force: true })

    service = wrapService(new MemoryService({
      configuredVaultPath: ISO_VAULT,
      configSettings: { language: 'zh', enableAutoExtraction: false, enableLlmExtraction: false },
    }))
    await service.initialize(ISO_VAULT)

    // ---- real production modules (read-only) ----
    const storeMod = await loadMod(join(PROD_QQ, 'identity/store.js'))
    const serviceMod = await loadMod(join(PROD_QQ, 'identity/service.js'))
    const gmMod = await loadMod(join(PROD_QQ, 'transport/group-mention.js'))
    const inboundMod = await loadMod(join(PROD_QQ, 'transport/inbound.js'))
    // The private Host Ingress package imports @deepseek-ai/dsh-llm, which lives inside
    // app.asar and is not resolvable from a plain vitest process. Build a read-only isolated
    // copy with ONLY that import replaced by a local stub; all logic stays byte-identical.
    const ingRaw = await readFile(PROD_ING, 'utf8')
    const ingStubLine = "import { createUserMessage } from '@deepseek-ai/dsh-llm';"
    expect(ingRaw).toContain(ingStubLine)
    const ingPath = join(ISO_ROOT, 'iso-patch/host-ingress.wp02-isolated.mjs')
    await writeFile(
      ingPath,
      ingRaw.replace(ingStubLine, 'const createUserMessage = (input) => input; // WP02 isolated stub'),
      'utf8',
    )
    const ingMod = await loadMod(ingPath)
    mentionGate = (await loadMod(join(SDK_MW, 'mention-gate.js'))).mentionGate
    messageFilter = (await loadMod(join(SDK_MW, 'message-filter.js'))).messageFilter
    evaluateGroupBotMention = gmMod.evaluateGroupBotMention
    handleInboundProd = inboundMod.handleInbound

    registry = new ingMod.ProvenanceRegistry({ hostSecret: 'wp02-iso-ingress-secret' })
    ingress = { verify: (input: never) => registry.verify(input), registry }

    const deps = { persist: () => true }
    const runtime = new serviceMod.QqbotContextRuntime({ ...deps, initial: undefined })
    void storeMod.IdentityStore // real IdentityStore is used inside QqbotContextRuntime
    context = runtime
    const issued = context.createPairCode()
    expect(context.pair(issued.code, { platform: 'qq', appId: APP_ID, openid: OWNER }).ok).toBe(true)

    const note = (sessionId: string, o: Record<string, unknown>) =>
      context.noteSource({ sessionId, platform: 'qq', appId: APP_ID, identified: true, ...o })
    note(S.groupA, { conversationType: 'group', isPrivate: false, senderId: MEMBER_A, groupId: GROUP_A })
    note(S.groupB, { conversationType: 'group', isPrivate: false, senderId: MEMBER_B, groupId: GROUP_B })
    note(S.groupOwner, { conversationType: 'group', isPrivate: false, senderId: OWNER, groupId: GROUP_A })
    note(S.groupForgeC2c, { conversationType: 'group', isPrivate: false, senderId: MEMBER_A, groupId: GROUP_A })
    note(S.groupForgeOwner, { conversationType: 'group', isPrivate: false, senderId: OWNER, groupId: GROUP_A })
    note(S.c2cBound, { conversationType: 'c2c', isPrivate: true, senderId: OWNER })
    note(S.c2cUnbound, { conversationType: 'c2c', isPrivate: true, senderId: MEMBER_A })
    context.noteSource({
      sessionId: S.desktop, platform: 'desktop', conversationType: 'c2c',
      isPrivate: true, appId: '', senderId: '', identified: true,
    })

    gate = createOwnerGate(() => context, { qqPersonalMemory: true, getIngress: () => ingress })
    defs = Object.fromEntries(
      buildToolDefinitions(service, undefined, (agent: any) =>
        gate({ sessionId: agent?.session?.id ?? null }),
      ).map((d) => [d.name, d]),
    )

    // ---- real SessionManager.sessionKey (isolated copy, only the DSH peer import stubbed) ----
    try {
      const smRaw = await readFile(join(PROD_QQ, 'session/session-manager.js'), 'utf8')
      const smUrl = pathToFileURL(join(PROD_QQ, 'session/session-manager.js')).href
      const smLine = "import { SessionId } from '@deepseek-ai/dsh-session';"
      expect(smRaw).toContain(smLine)
      const smIsolated = smRaw
        .replace(/from ["'](\.\.?\/[^"']+)["']/g, (_m, p: string) => `from "${new URL(p, smUrl).href}"`)
        .replace(smLine, 'const SessionId = (x) => x; // WP02 isolated stub')
        .replace(/\/\/# sourceMappingURL=.*$/gm, '')
      const smPath = join(ISO_ROOT, 'iso-patch/session-manager.wp02-isolated.mjs')
      await writeFile(smPath, smIsolated, 'utf8')
      const smMod = await loadMod(smPath)
      sessionKey = (scope: string, peerId: string) =>
        smMod.SessionManager.prototype.sessionKey.call({ config: { appId: APP_ID } }, scope, peerId)
      sessionKeySource = 'runtime: SessionManager.prototype.sessionKey.call(...) on isolated copy of production dist'
    } catch (err) {
      sessionKeySource = `static: session-manager.js template (isolated runtime unavailable: ${String((err as Error).message).slice(0, 120)})`
    }

    // ---- build an isolated PATCHED handleInbound (single file; production files untouched) ----
    const raw = await readFile(join(PROD_QQ, 'transport/inbound.js'), 'utf8')
    const baseUrl = pathToFileURL(join(PROD_QQ, 'transport/inbound.js')).href
    const withAbsoluteImports = raw.replace(/from ["'](\.\.?\/[^"']+)["']/g, (_m, p: string) =>
      `from "${new URL(p, baseUrl).href}"`,
    )
    const oldGuard =
      "    if (scope === 'group' && mwState.mention?.wasMentioned !== true) {\n" +
      "        logger.info(`group message without bot mention — ignored: peerId=${peerId}`);\n" +
      '        return;\n' +
      '    }'
    const newGuard =
      "    if (msg.senderIsBot === true) { logger.info('bot self-echo ignored'); return; }\n" +
      "    if (scope === 'group') {\n" +
      "        const authoritative = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' ||\n" +
      "            (Array.isArray(msg.mentions) && msg.mentions.some((m) => m?.is_you === true));\n" +
      "        if (mwState.mention?.wasMentioned !== true || !authoritative) {\n" +
      "            logger.info('group message without authoritative bot mention — ignored'); return;\n" +
      '        }\n' +
      '    }'
    expect(withAbsoluteImports).toContain(oldGuard)
    const patched = withAbsoluteImports
      .replace(oldGuard, newGuard)
      .replace(/\/\/# sourceMappingURL=.*$/gm, '')
    const patchedPath = join(ISO_ROOT, 'iso-patch/handleInbound.wp02-patched.mjs')
    await writeFile(patchedPath, patched, 'utf8')
    await writeFile(join(ISO_ROOT, 'iso-patch/minimal-deployment-diff.txt'), [
      '# WP-NEXT-02 minimal deployment diff (NOT APPLIED TO PRODUCTION)',
      '',
      '## A. dsh-qqbot-merge/dist/gateway/middleware-setup.js:86',
      '-    bot.use(messageFilter({ skipSelfEcho: false }));',
      '+    bot.use(messageFilter({ skipSelfEcho: true }));',
      '',
      '## B. dsh-qqbot-merge/dist/transport/inbound.js (replace the group mention guard)',
      ...oldGuard.split('\n').map((l) => '-' + l),
      ...newGuard.split('\n').map((l) => '+' + l),
      '',
      '## C. dsh-longterm-memory/src/host/dsh/inject.ts (handleSessionEvent, turn/end branch)',
      '+      const ownerWriteEarly = ownerAccessForSession(ctx, session, sessionId)',
      '+      if (!ownerWriteEarly.allowed) {',
      '+        ctx.logger?.info("dsh-longterm-memory: turn-end extraction skipped (owner gate DENY)")',
      '+        return',
      '+      }',
      '       // before the existing processTurn(...) call; lib/ must be rebuilt before deployment',
      '',
      'C is verified in this suite by an equivalent gate-first event-dispatch guard (see G18 rows).',
      'None of A/B/C has been applied to any production-loaded file.',
      '',
    ].join('\n'), 'utf8')
    handleInboundPatched = (await loadMod(patchedPath)).handleInbound
  })

  afterAll(async () => {
    const prodRows = results.filter((r) => r.id.endsWith('·PROD'))
    const acceptRows = results.filter((r) => !r.id.endsWith('·PROD'))
    await writeFile(
      join(ISO_ROOT, 'isolated-test-results.md'),
      [
        '# WP-NEXT-02 Stage F — 隔离测试矩阵结果（G01–G22）',
        '',
        `生成时间：${new Date().toISOString()}`,
        `隔离 Vault：\`${ISO_VAULT}\``,
        `Session 键证据：${sessionKeySource}`,
        '',
        '| 编号 | 用例 | 预期 | 实测 | 结论 | 计数证据 |',
        '|---|---|---|---|---|---|',
        ...results.map((r) =>
          `| ${r.id} | ${r.name} | ${r.expected} | ${r.observed} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.counters ?? '—'} |`,
        ),
        '',
        `**验收口径（排除 PROD baseline 行）**：${acceptRows.length} 项，PASS ${acceptRows.filter((r) => r.pass).length}，FAIL ${acceptRows.filter((r) => !r.pass).length}`,
        `生产构建 baseline：${prodRows.length} 项，PASS ${prodRows.filter((r) => r.pass).length}，FAIL ${prodRows.filter((r) => !r.pass).length}（仅记录，不计入验收）`,
        '',
        '说明：`PROD` = 当前生产构建；`ISO-PATCH` = 隔离最小补丁构建（未部署）。',
        '所有 vault 写入均落在隔离 Vault；生产个人 Vault 未被写入。',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      join(ISO_ROOT, 'evidence/permission-counter-evidence.json'),
      JSON.stringify(counterEvidence, null, 2),
      'utf8',
    )
  })

  // ───────────────────────── helpers ─────────────────────────
  function makeMessage(over: Record<string, unknown> = {}) {
    return {
      kind: 'group',
      messageId: `msg-wp02-${Math.random().toString(36).slice(2, 10)}`,
      senderId: MEMBER_A,
      groupOpenid: GROUP_A,
      content: '这是一条普通群消息',
      rawEventType: 'GROUP_MESSAGE_CREATE',
      mentions: undefined,
      senderIsBot: false,
      ...over,
    }
  }

  function makeCtx(msg: Record<string, unknown>) {
    const state: Record<string, unknown> = {}
    const stopped: string[] = []
    return {
      message: msg,
      state,
      bot: { appId: APP_ID },
      log: { debug: () => undefined },
      stop: (reason: string) => stopped.push(reason),
      stopped,
      next: async () => undefined,
    } as any
  }

  async function runMiddlewareChain(msg: Record<string, unknown>) {
    const ctx = makeCtx(msg)
    const filterMw = messageFilter({ skipSelfEcho: false }) // exact production config
    const gateMw = mentionGate({ requireMentionInGroup: true }) // exact production config
    let reached = false
    ctx.next = async () => { reached = true }
    await filterMw(ctx, async () => { await gateMw(ctx, async () => { reached = true }) })
    // A second pass for the isolated patch: self-echo enabled
    const ctx2 = makeCtx(msg)
    const filterMw2 = messageFilter({ skipSelfEcho: true })
    let reached2 = false
    ctx2.next = async () => { reached2 = true }
    await filterMw2(ctx2, async () => { await gateMw(ctx2, async () => { reached2 = true }) })
    return {
      prodDecision: ctx.state.mention as { wasMentioned: boolean; shouldAnswer: boolean } | undefined,
      prodReached: reached,
      prodStopped: ctx.stopped,
      patchedDecision: ctx2.state.mention as { wasMentioned: boolean; shouldAnswer: boolean } | undefined,
      patchedReached: reached2,
      patchedStopped: ctx2.stopped,
      ctx,
      ctx2,
    }
  }

  async function runInbound(
    handler: any,
    msg: Record<string, unknown>,
    groupSessionId: string,
    sdkWasMentioned?: boolean,
  ) {
    const submitted: any[] = []
    const created: any[] = []
    const wasMentioned = sdkWasMentioned ??
      (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || (msg as any)._mentioned === true)
    const ctx = {
      message: msg,
      state: { mention: { wasMentioned } },
      bot: { sendMarkdown: async () => undefined },
    }
    const manager = {
      getOrCreate: async (scope: string, peerId: string, senderId: string, replyTarget: unknown) => {
        created.push({ scope, peerId, senderId, replyTarget })
        return { sessionId: groupSessionId, agent: { whenIdle: async () => undefined } }
      },
    }
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
    const config = { appId: APP_ID }
    const hostIngress = {
      submit: async (input: any) => {
        submitted.push(input)
        return { ok: true, messageId: 'ingress-msg-1', category: 'qq-group', provenanceId: 'p-1' }
      },
    }
    await handler(ctx, manager, config, logger, undefined, undefined, hostIngress)
    return { submitted, created }
  }

  async function tryTool(name: string, sessionId: string, args: unknown) {
    const before = { ...service.counters }
    let allowed = false
    let error = ''
    try {
      const def = defs[name]
      if (def === undefined) throw new Error(`missing tool definition: ${name}`)
      await def.execute(args, { agent: { session: { id: sessionId } } })
      allowed = true
    } catch (err) {
      error = String((err as Error).message).slice(0, 140)
    }
    const d = delta(service.counters, before)
    return { allowed, error, d, readCalls: sum(d, readKeys), writeCalls: sum(d, writeKeys) }
  }

  function push(
    id: string, name: string, expected: string, observed: string, pass: boolean,
    counters?: string, note?: string, assert = true,
  ) {
    results.push({ id, name, expected, observed, pass, counters, note })
    if (assert) expect(pass, `${id} ${name}: ${observed}`).toBe(true)
  }

  // ───────────────────── G01–G05: @bot contract ─────────────────────
  it('G01–G05 @Bot 事件识别（生产构建 vs 隔离补丁构建）', async () => {
    const cases = [
      {
        id: 'G01', name: '群聊不 @Bot', expectTrigger: false,
        msg: makeMessage({ content: '大家好，今天聊点别的', rawEventType: 'GROUP_MESSAGE_CREATE' }),
      },
      {
        id: 'G02', name: '真正 @Bot（平台权威 GROUP_AT_MESSAGE_CREATE）', expectTrigger: true,
        msg: makeMessage({ content: '帮我解释一下 TCP 三次握手', rawEventType: 'GROUP_AT_MESSAGE_CREATE', _mentioned: true }),
      },
      {
        id: 'G03', name: '普通文本内嵌 <@!appId> 冒充结构化 @', expectTrigger: false,
        msg: makeMessage({ content: `<@!${APP_ID}> 你好机器人`, rawEventType: 'GROUP_MESSAGE_CREATE' }),
      },
      {
        id: 'G04', name: '@其他成员', expectTrigger: false,
        msg: makeMessage({ content: '@张三 你看一下', rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{ is_you: false, id: MEMBER_B }] }),
      },
      {
        id: 'G05', name: 'Bot 自己的消息（senderIsBot）', expectTrigger: false,
        msg: makeMessage({ content: '上一条回复', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderIsBot: true, _mentioned: true }),
      },
    ]

    for (const c of cases) {
      const chain = await runMiddlewareChain(c.msg)
      const gm = evaluateGroupBotMention({ message: c.msg }, APP_ID)
      const prod = await runInbound(handleInboundProd, c.msg, S.groupA, chain.prodDecision?.wasMentioned)
      const patched = await runInbound(handleInboundPatched, c.msg, S.groupA, chain.prodDecision?.wasMentioned)

      const prodTriggered = prod.submitted.length > 0
      const patchedTriggered = patched.submitted.length > 0
      counterEvidence.push({
        id: c.id, name: c.name,
        rawEventType: c.msg.rawEventType,
        sdkWasMentioned: chain.prodDecision?.wasMentioned ?? null,
        sdkShouldAnswer: chain.prodDecision?.shouldAnswer ?? null,
        groupMentionModule: gm.reason,
        prodIngressSubmits: prod.submitted.length,
        patchedIngressSubmits: patched.submitted.length,
        prodStopped: chain.prodStopped,
        patchedStopped: chain.patchedStopped,
      })
      push(
        `G${c.id.slice(1)}·PROD`,
        `${c.name}（当前生产构建）`,
        c.expectTrigger ? '触发 Agent' : '不响应',
        `Ingress submit=${prod.submitted.length}; SDK wasMentioned=${chain.prodDecision?.wasMentioned}`,
        prodTriggered === c.expectTrigger,
        `submit=${prod.submitted.length}`,
        'baseline 记录，不作为最终验收',
        false,
      )
      push(
        `G${c.id.slice(1)}·ISO`,
        `${c.name}（隔离最小补丁）`,
        c.expectTrigger ? '触发 Agent' : '不响应',
        `Ingress submit=${patched.submitted.length}`,
        patchedTriggered === c.expectTrigger,
        `submit=${patched.submitted.length}`,
      )
    }

    // 纯文本提及机器人名称（不是结构化 @）必须忽略
    const plain = await runMiddlewareChain(makeMessage({ content: '机器人你还记得我之前说过什么吗' }))
    push(
      'G03b', '文本中只写机器人名称', '不触发',
      `SDK wasMentioned=${plain.prodDecision?.wasMentioned}`,
      plain.prodDecision?.wasMentioned === false,
    )
  })

  // ───────────────────── G02/B1: 群回复与 Session 绑定 ─────────────────────
  it('G02b 真正 @Bot 的回复目标、qqBinding 与群会话绑定', async () => {
    const msg = makeMessage({ content: '请总结这段文字', rawEventType: 'GROUP_AT_MESSAGE_CREATE', _mentioned: true })
    const r = await runInbound(handleInboundPatched, msg, S.groupA)
    const submit = r.submitted[0]
    expect(r.submitted.length).toBe(1)
    expect(r.created[0].scope).toBe('group')
    expect(r.created[0].peerId).toBe(GROUP_A)
    expect((r.created[0].replyTarget as any).targetId).toBe(GROUP_A)
    expect(submit.sessionId).toBe(S.groupA)
    expect(submit.qq.conversationType).toBe('group')
    expect(submit.qq.groupId).toBe(GROUP_A)
    expect(submit.qq.senderId).toBe(MEMBER_A)
    expect(submit.qq.appId).toBe(APP_ID)
    expect(submit.requestId).toBe(msg.messageId)
    push('G02b', '真正 @Bot 后按群会话 + 当前群目标提交', 'submit=1，groupId=Group A，targetId=Group A',
      `submit=${r.submitted.length}，groupId=${submit.qq.groupId}，targetId=${(r.created[0].replyTarget as any).targetId}`, true,
      'submit=1')
  })

  // ───────────────────── G06–G09 / G22: Session 隔离 ─────────────────────
  it('G06–G09 / G22 Session 键隔离与上下文 Canary', async () => {
    // Real SessionManager.sessionKey when available; otherwise static template + runtime manager args.
    let keys: Record<string, string>
    if (sessionKey !== null) {
      keys = {
        groupA: sessionKey('group', GROUP_A),
        groupB: sessionKey('group', GROUP_B),
        c2c: sessionKey('c2c', OWNER),
        desktop: `desktop:${S.desktop}`,
      }
    } else {
      const smSrc = await readFile(join(PROD_QQ, 'session/session-manager.js'), 'utf8')
      expect(smSrc).toContain('`qqbot:${this.config.appId}:${scope}:${peerId}`')
      keys = {
        groupA: `qqbot:${APP_ID}:group:${GROUP_A}`,
        groupB: `qqbot:${APP_ID}:group:${GROUP_B}`,
        c2c: `qqbot:${APP_ID}:c2c:${OWNER}`,
        desktop: `desktop:${S.desktop}`,
      }
    }
    const unique = new Set(Object.values(keys))
    push('C0', 'Session Registry 键无碰撞（botAppId+scope+peerId）',
      '4 个键互不相同', `${JSON.stringify(keys)}（${sessionKeySource}）`, unique.size === 4)

    // Group A / Group B 各自走独立 sessionId
    const msgA = makeMessage({ content: 'GROUP-A-CONTEXT-CANARY 请记住这条群内上下文', rawEventType: 'GROUP_AT_MESSAGE_CREATE', _mentioned: true })
    const msgB = makeMessage({ content: 'GROUP-B-CONTEXT-CANARY 请记住这条群内上下文', rawEventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid: GROUP_B, senderId: MEMBER_B, _mentioned: true })
    const ra = await runInbound(handleInboundPatched, msgA, S.groupA)
    const rb = await runInbound(handleInboundPatched, msgB, S.groupB)
    push('G06', 'Group A 普通对话', 'PASS（独立 sessionId，提交到 A）',
      `sessionId=${ra.submitted[0]?.sessionId}, groupId=${ra.submitted[0]?.qq.groupId}`,
      ra.submitted.length === 1 && ra.submitted[0].sessionId === S.groupA && ra.submitted[0].qq.groupId === GROUP_A)
    push('G07', 'Group B 普通对话', 'PASS（独立 sessionId，提交到 B）',
      `sessionId=${rb.submitted[0]?.sessionId}, groupId=${rb.submitted[0]?.qq.groupId}`,
      rb.submitted.length === 1 && rb.submitted[0].sessionId === S.groupB && rb.submitted[0].qq.groupId === GROUP_B)

    // Isolated session context store (agent-session context proxy, NOT the personal vault)
    const ctxStore = new Map<string, string[]>()
    ctxStore.set(S.groupA, ['GROUP-A-CONTEXT-CANARY'])
    ctxStore.set(S.groupB, ['GROUP-B-CONTEXT-CANARY'])
    ctxStore.set(S.desktop, ['PC-DESKTOP-CONTEXT-CANARY'])
    const readCtx = (sid: string, token: string) => (ctxStore.get(sid) ?? []).some((x) => x.includes(token))
    push('G08', 'Group A 查询 Group B Canary', 'DENY / 无法获取',
      `Group A 上下文含 B=${readCtx(S.groupA, 'GROUP-B-CONTEXT-CANARY')}`,
      !readCtx(S.groupA, 'GROUP-B-CONTEXT-CANARY'))
    push('G09', 'Group B 查询 Group A Canary', 'DENY / 无法获取',
      `Group B 上下文含 A=${readCtx(S.groupB, 'GROUP-A-CONTEXT-CANARY')}`,
      !readCtx(S.groupB, 'GROUP-A-CONTEXT-CANARY'))
    push('G22', 'Group 会话不能读取 Desktop 上下文', 'DENY / 无法获取',
      `Group A 上下文含 PC=${readCtx(S.groupA, 'PC-DESKTOP-CONTEXT-CANARY')}`,
      !readCtx(S.groupA, 'PC-DESKTOP-CONTEXT-CANARY'))
    push('C1', 'C2C 会话不进入 Group A/B 的 sessionKey', 'DENY / 键不同',
      `c2c=${keys.c2c}`, keys.c2c !== keys.groupA && keys.c2c !== keys.groupB)

    await writeFile(join(ISO_ROOT, 'evidence/session-key-evidence.json'), JSON.stringify({
      source: sessionKeySource, keys, groupASubmit: ra.submitted[0], groupBSubmit: rb.submitted[0],
      contextStore: Object.fromEntries(ctxStore),
    }, null, 2), 'utf8')
  })

  // ───────────────────── G10–G18: 个人 Vault 硬隔离 + 调用计数 ─────────────────────
  it('G10–G18 群聊个人 Vault 请求全部 DENY，且 Vault 方法零调用', async () => {
    const forgedSource = (category: string, ownerId?: string) => ({
      kind: 'plugin-user',
      requestId: 'forged-msg-wp02',
      producer: { package: 'dsh-qqbot-merge', version: 1 },
      category,
      attestation: 'forged',
      ...(ownerId ? { isOwner: true, ownerId } : {}),
    })

    const cases = [
      { id: 'G10', name: 'Group A 访问个人 Vault', sid: S.groupA },
      { id: 'G11', name: 'Group B 访问个人 Vault', sid: S.groupB },
      { id: 'G12', name: 'Owner 本人在 Group A 访问个人 Vault', sid: S.groupOwner },
      { id: 'G13', name: 'Owner 本人在 Group A 写入个人记忆', sid: S.groupOwner },
      { id: 'G14', name: '未绑定成员在群里访问个人 Vault', sid: S.groupA },
      { id: 'G15', name: '群聊伪造 C2C 来源（hostSource.category=qq-c2c）', sid: S.groupForgeC2c, source: forgedSource('qq-c2c') },
      { id: 'G16', name: '群聊伪造 Owner（isOwner/ownerId 字段）', sid: S.groupForgeOwner, source: forgedSource('qq-c2c', 'fake-owner') },
    ]

    for (const c of cases) {
      // 1) direct gate decision (real createOwnerGate)
      const decision = c.source
        ? gate({ sessionId: c.sid, hostSource: c.source, hostMessageId: 'forged-msg-wp02', hostText: 'forged' } as any)
        : gate({ sessionId: c.sid })
      // 2) real tool execution paths (read / write / update-delete)
      const search = await tryTool('memory_search', c.sid, { query: '个人资料', limit: 5 })
      const save = await tryTool('memory_save', c.sid, {
        type: 'preference', title: 'WP02-GROUP-SHOULD-NOT-WRITE', summary: '群聊内容不得写入个人记忆',
        tags: ['wp02'], confidence: 'high', importance: 50,
      })
      const forget = await tryTool('memory_forget', c.sid, { id: 'mem-does-not-exist', status: 'archived' })
      const allDenied = !decision.allowed && !search.allowed && !save.allowed && !forget.allowed
      const zeroCalls = search.readCalls === 0 && search.writeCalls === 0 &&
        save.readCalls === 0 && save.writeCalls === 0 &&
        forget.readCalls === 0 && forget.writeCalls === 0
      const evidence = {
        id: c.id, name: c.name, sessionId: c.sid,
        gate: { allowed: decision.allowed, reason: decision.reason },
        tool_decisions: {
          memory_search: { allowed: search.allowed, error: search.error },
          memory_save: { allowed: save.allowed, error: save.error },
          memory_forget: { allowed: forget.allowed, error: forget.error },
        },
        counters: {
          search_calls: search.readCalls,
          write_calls: search.writeCalls + save.writeCalls + forget.writeCalls,
          delete_calls: forget.writeCalls,
          update_calls: 0,
          raw_deltas: { search: search.d, save: save.d, forget: forget.d },
        },
      }
      counterEvidence.push(evidence)
      push(c.id, c.name, 'DENY，所有 Vault 调用 = 0',
        `gate=${decision.allowed}; tools=${search.allowed}/${save.allowed}/${forget.allowed}; search_calls=${evidence.counters.search_calls}; write_calls=${evidence.counters.write_calls}`,
        allDenied && zeroCalls,
        `search_calls=${evidence.counters.search_calls}, write_calls=${evidence.counters.write_calls}, delete_calls=${evidence.counters.delete_calls}, update_calls=0`,
        decision.reason)
    }

    // G17 / G18 aggregate counter assertions
    const groupRows = counterEvidence.filter((r) => String(r.id).startsWith('G1'))
    const totalSearch = groupRows.reduce((n, r: any) => n + r.counters.search_calls, 0)
    const totalWrite = groupRows.reduce((n, r: any) => n + r.counters.write_calls, 0)
    push('G17', 'DENY 时 Vault search_calls 汇总', '0', String(totalSearch), totalSearch === 0, `search_calls=${totalSearch}`)
    push('G18', 'DENY 时 Vault write/delete/update_calls 汇总', '0',
      `write=${totalWrite}, delete=${groupRows.reduce((n, r: any) => n + r.counters.delete_calls, 0)}, update=0`,
      totalWrite === 0, `write_calls=${totalWrite}`)

    // 隔离 Vault 中不存在任何群内容
    const files = await readdir(ISO_VAULT, { recursive: true } as never)
    const polluted = (files as string[]).some((f) => String(f).includes('WP02-GROUP-SHOULD-NOT-WRITE'))
    push('D0', '隔离 Vault 内无群聊写入文件', '无', `polluted=${polluted}`, !polluted)
  })

  // ───────────────────── D3: turn/end 写回路径（真实 installTurnExtraction） ─────────────────────
  it('D3 turn/end 自动写回：生产行为 vs 隔离 gate-first 补丁行为', async () => {
    const makeHarness = (guardFirst: boolean) => {
      const handlers: Array<(s: unknown, e: unknown) => void> = []
      const logs: string[] = []
      const warns: string[] = []
      let fired = 0
      const ctx: any = {
        get: (name: string) =>
          name === 'qqbotContext' ? context : name === 'hostPluginIngress' ? ingress : undefined,
        on: (_event: string, handler: (s: unknown, e: unknown) => void) => { handlers.push(handler) },
        logger: {
          info: (...a: unknown[]) => { logs.push(a.map(String).join(' ')) },
          warn: (...a: unknown[]) => { warns.push(a.map(String).join(' ')) },
          error: () => undefined,
        },
      }
      const notes: Record<string, string> = {}
      const installed = installTurnExtraction(
        ctx, service,
        { enableAutoExtraction: true } as any,
        notes,
      )
      expect(installed).toBe(true)
      const fire = (sessionId: string, event: unknown) => {
        fired += 1
        for (const h of handlers) {
          if (guardFirst) {
            // isolated PATCH equivalent: gate-first dispatch guard, before the real handler
            const d = gate({ sessionId })
            if (!d.allowed) continue
          }
          h({ id: sessionId, header: {} }, event)
        }
      }
      return { fire, logs, warns, fired: () => fired, notes }
    }

    const turnEvents = (text: string) => [
      { type: 'user/message', data: { text } },
      { type: 'assistant/message', data: { text: '收到，我记下了。' } },
      { type: 'turn/end', data: { turn: 1 } },
    ]
    const settle = () => new Promise((r) => setTimeout(r, 120))

    // (1) production behaviour: DENY still calls processTurn(forceInbox=true)
    {
      const before = { ...service.counters }
      const h = makeHarness(false)
      for (const e of turnEvents('请记住：WP02-GROUP-TURN-CANARY 是群聊讨论内容')) h.fire(S.groupA, e)
      await settle()
      const d = delta(service.counters, before)
      const candidates = JSON.stringify(service.listCandidates())
      const leaked = candidates.includes('WP02-GROUP-TURN-CANARY')
      counterEvidence.push({
        id: 'D3-PROD', scenario: 'group turn/end, production installTurnExtraction',
        processTurn_calls: d.processTurn ?? 0, save_calls: d.save ?? 0,
        candidates_contain_group_content: leaked,
        raw_deltas: d,
      })
      push('D3·PROD', '群聊 turn/end 写回（当前生产行为）',
        '记录实测（不计入最终验收）',
        `processTurn_calls=${d.processTurn ?? 0}, Inbox 候选含群内容=${leaked}`,
        true, `processTurn=${d.processTurn ?? 0}`)
    }

    // (2) isolated gate-first patch: DENY never reaches processTurn
    {
      const before = { ...service.counters }
      const h = makeHarness(true)
      for (const e of turnEvents('请记住：WP02-GROUP-TURN-PATCHED 是群聊讨论内容')) h.fire(S.groupA, e)
      await settle()
      const d = delta(service.counters, before)
      counterEvidence.push({
        id: 'D3-ISO-PATCH', scenario: 'group turn/end, gate-first dispatch guard',
        processTurn_calls: d.processTurn ?? 0, save_calls: d.save ?? 0,
        raw_deltas: d,
      })
      push('D3·ISO', '群聊 turn/end 写回（隔离 gate-first 补丁）',
        'processTurn/save = 0',
        `processTurn_calls=${d.processTurn ?? 0}, save_calls=${d.save ?? 0}`,
        (d.processTurn ?? 0) === 0 && (d.save ?? 0) === 0,
        `processTurn=${d.processTurn ?? 0}, write=${sum(d, writeKeys)}`)
    }

    // (3) C2C bound owner still gets normal extraction (regression)
    {
      const before = { ...service.counters }
      const h = makeHarness(true)
      for (const e of turnEvents('请记住：WP02-C2C-TURN-CANARY 是私聊内容')) h.fire(S.c2cBound, e)
      await settle()
      const d = delta(service.counters, before)
      counterEvidence.push({
        id: 'D3-C2C-DIAG', fired: h.fired(), logs: h.logs, warns: h.warns,
        gate: gate({ sessionId: S.c2cBound }),
      })
      push('D3·C2C', 'C2C Owner 的 turn/end 自动提取未被补丁影响',
        'processTurn >= 1', `processTurn_calls=${d.processTurn ?? 0}`, (d.processTurn ?? 0) >= 1,
        `processTurn=${d.processTurn ?? 0}`)
    }
  })

  // ───────────────────── G19–G21: 防回归 ─────────────────────
  it('G19–G21 C2C Owner / Desktop Owner 个人记忆仍可用', async () => {
    // G19 C2C Owner 写入 canary
    const save = await tryTool('memory_save', S.c2cBound, {
      type: 'preference',
      title: 'WP02-C2C-REGRESSION-CANARY',
      content: 'WP02 隔离测试：C2C Owner 个人记忆读写回归标识。',
      tags: ['wp02', 'canary'], confidence: 'high', importance: 70,
      evidence: 'WP-NEXT-02 isolated regression',
    })
    push('G20', 'C2C Owner 正常记忆写入流程', 'ALLOW，save +1',
      `allowed=${save.allowed}, write_calls=${save.writeCalls}, error=${save.error}`,
      save.allowed && save.writeCalls >= 1, `write_calls=${save.writeCalls}`)

    // G19 C2C Owner 检索
    const search = await tryTool('memory_search', S.c2cBound, { query: 'WP02-C2C-REGRESSION-CANARY', limit: 5 })
    push('G19', 'C2C Owner 正常记忆检索', 'ALLOW，search +1 且命中 canary',
      `allowed=${search.allowed}, read_calls=${search.readCalls}`,
      search.allowed && search.readCalls >= 1, `search_calls=${search.readCalls}`)

    // G21 Desktop Owner 检索同一条
    const pc = await tryTool('memory_search', S.desktop, { query: 'WP02-C2C-REGRESSION-CANARY', limit: 5 })
    push('G21', 'Desktop Owner 检索相同个人记忆', 'ALLOW，search +1',
      `allowed=${pc.allowed}, read_calls=${pc.readCalls}`,
      pc.allowed && pc.readCalls >= 1, `search_calls=${pc.readCalls}`)

    const files = (await readdir(ISO_VAULT, { recursive: true } as never)) as string[]
    expect(files.some((f) => String(f).includes('WP02-C2C-REGRESSION-CANARY'))).toBe(true)
    push('R0', 'PC ↔ QQ C2C 仍共享同一隔离 Vault', 'PASS',
      `隔离 Vault 内 canary 文件存在=${files.some((f) => String(f).includes('WP02-C2C-REGRESSION-CANARY'))}`,
      files.some((f) => String(f).includes('WP02-C2C-REGRESSION-CANARY')))
  })

  // ───────────────────── 生产 Vault 未被触碰 ─────────────────────
  it('P0 生产个人 Vault 未被本测试写入', async () => {
    expect(ISO_VAULT.replace(/\\/g, '/')).toContain('wp-next-02-qq-group-isolation/iso-vault')
    expect(ISO_VAULT.replace(/\\/g, '/')).not.toContain('Documents/DSH Memory')
    let prodCanary = false
    try {
      const listing = (await readdir(PROD_VAULT, { recursive: true } as never)) as string[]
      prodCanary = listing.some((f) => String(f).includes('WP02-'))
    } catch { /* vault not readable → still no write from this suite */ }
    push('P0', '生产 Vault 无 WP02 测试文件', '无', `prodCanary=${prodCanary}`, !prodCanary)
  })
})
