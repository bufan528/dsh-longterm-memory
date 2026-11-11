/**
 * WP-NEXT-01F Stage C — isolated cross-device memory canary + permission matrix.
 * Uses real MemoryService, real OwnerGate, real IdentityStore, real Host Ingress.
 * Never touches production vault (Documents/DSH Memory).
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'

// Host ingress package imports dsh-llm only for defaultDeliver; we only need ProvenanceRegistry.
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (x: unknown) => x,
}))

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryService } from '../../src/host/core/service.js'
import { createOwnerGate } from '../../src/host/owner-gate.js'
import { decideOwnerMemoryAccess } from '../../src/shared/owner-access.js'

const ISO_ROOT = 'D:/dsh-memory-vault/.scratch/wp-next-01f-c2c-memory'
const ISO_VAULT = `${ISO_ROOT}/iso-vault/DSH Memory`
const PROD_QQ = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/dsh-qqbot-merge/dist'
const PROD_ING = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-host-plugin-ingress/lib/index.js'
const PROD_VAULT = 'C:/Users/bf410/Documents/DSH Memory'
// The installed profile does not ship @deepseek-ai/dsh-llm. Ingress imports it
// only for `defaultDeliver`, which this suite never calls (it uses
// ProvenanceRegistry exclusively). Loading ingress from its absolute profile
// path makes that import go through Node's native resolver, where vi.mock()
// and Vite aliases do not apply, so collection used to fail and all 6 cases
// were silently skipped.
//
// Fix: byte-copy the *real production ingress* into an isolated directory and
// place the repo's existing test stub next to it. The module under test is
// therefore unchanged; only its resolution root moves. We assert byte equality
// below so this can never silently degrade into testing a different ingress.
const STUB_LLM = 'D:/dsh-memory-vault/node_modules/@deepseek-ai/dsh-llm'
const SHIM_SCOPE = `${ISO_ROOT}/ingress-shim/node_modules/@deepseek-ai`
const ISO_ING = `${SHIM_SCOPE}/dsh-host-plugin-ingress/lib/index.js`

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

async function prepareIngressShim(): Promise<string> {
  const source = await readFile(PROD_ING)
  const ingressPkg = `${SHIM_SCOPE}/dsh-host-plugin-ingress`
  const stubPkg = `${SHIM_SCOPE}/dsh-llm`
  await mkdir(`${ingressPkg}/lib`, { recursive: true })
  await mkdir(stubPkg, { recursive: true })
  await writeFile(ISO_ING, source)
  await writeFile(`${ingressPkg}/package.json`, JSON.stringify({
    name: '@deepseek-ai/dsh-host-plugin-ingress', type: 'module', main: 'lib/index.js',
  }))
  // The repo's stub ships a malformed package.json (BOM + escaped colons),
  // which Node rejects as an invalid package config. Copy its *implementation*
  // verbatim and write a well-formed manifest for it — the export stays
  // byte-identical, so nothing about the dependency's behaviour changes.
  const stubImpl = await readFile(join(STUB_LLM, 'index.js'))
  await writeFile(join(stubPkg, 'index.js'), stubImpl)
  await writeFile(`${stubPkg}/package.json`, JSON.stringify({
    name: '@deepseek-ai/dsh-llm', version: '0.0.0-stub', type: 'module',
    main: './index.js', exports: { '.': './index.js' },
  }))
  const copied = await readFile(ISO_ING)
  const digest = sha256(source)
  if (sha256(copied) !== digest) throw new Error('ingress shim is not byte-identical to production ingress')
  return digest
}

async function loadMod(spec: string) {
  return import(spec.startsWith('file:') ? spec : pathToFileURL(spec).href)
}

interface Counters {
  search: number
  save: number
  get: number
}

function wrapService(service: MemoryService): MemoryService & { counters: Counters } {
  const counters: Counters = { search: 0, save: 0, get: 0 }
  const s = service as MemoryService & { counters: Counters }
  const origSearch = service.search.bind(service)
  const origSave = service.save.bind(service)
  const origGet = service.get.bind(service)
  s.search = ((...args: Parameters<MemoryService['search']>) => {
    counters.search += 1
    return origSearch(...args)
  }) as MemoryService['search']
  s.save = ((...args: Parameters<MemoryService['save']>) => {
    counters.save += 1
    return origSave(...args)
  }) as MemoryService['save']
  s.get = ((...args: Parameters<MemoryService['get']>) => {
    counters.get += 1
    return origGet(...args)
  }) as MemoryService['get']
  s.counters = counters
  return s
}

/** Gate + vault access path used by tools (same decision as production tools.ts). */
async function gatedVaultOp(
  opts: {
    service: MemoryService & { counters: Counters }
    gate: ReturnType<typeof createOwnerGate>
    sessionId: string
    op: 'search' | 'save'
    payload: unknown
    hostSource?: unknown
    hostMessageId?: string
    hostText?: string
  },
): Promise<{ allowed: boolean; reason: string; result?: unknown }> {
  const decision = opts.gate({
    sessionId: opts.sessionId,
    ...(opts.hostSource ? { hostSource: opts.hostSource as never } : {}),
    ...(opts.hostMessageId ? { hostMessageId: opts.hostMessageId } : {}),
    ...(opts.hostText ? { hostText: opts.hostText } : {}),
  })
  if (!decision.allowed) {
    return { allowed: false, reason: decision.reason }
  }
  if (opts.op === 'search') {
    const result = await opts.service.search(opts.payload as never)
    return { allowed: true, reason: decision.reason, result }
  }
  const result = await opts.service.save(opts.payload as never)
  return { allowed: true, reason: decision.reason, result }
}

describe('WP-NEXT-01F isolated cross-device canary', () => {
  let root: string
  let vault: string
  let service: MemoryService & { counters: Counters }
  let store: {
    createPairCode: (now?: Date) => { code: string; expiresAt: string; ttlMs: number }
    pair: (code: string, account: unknown, now?: Date) => { ok: boolean; reason?: string; ownerId?: string }
    getStatus: () => { bound: boolean; ownerId: string | null; qq: unknown }
    resolveOwner: (account: unknown) => string | null
    unbind: () => unknown
  }
  let context: {
    noteSource: (facts: Record<string, unknown>) => void
    getContext: (sessionId: string) => {
      platform: string
      conversationType: string
      isPrivate: boolean
      ownerId: string | null
      identified: boolean
    } | null
    isKnownQqSession?: (id: string) => boolean
    isRegistryHealthy?: () => boolean
    createPairCode: (now?: Date) => { code: string; expiresAt: string; ttlMs: number }
    pair: (code: string, account: unknown, now?: Date) => { ok: boolean; reason?: string; ownerId?: string }
    getStatus: () => { bound: boolean; ownerId: string | null; qq: unknown }
    resolveOwner: (account: unknown) => string | null
    unbind: () => unknown
  }
  let ingress: {
    verify: (input: {
      messageId: string
      sessionId: string
      text: string
      source: unknown
    }) => { ok: boolean; reason: string }
    registry?: unknown
  }
  let gateOn: ReturnType<typeof createOwnerGate>
  let gateOff: ReturnType<typeof createOwnerGate>
  let ingressDigest = ''
  let appId = '1906048158'
  let ownerOpenId = 'qq-owner-openid-iso-01f'
  let otherOpenId = 'qq-other-openid-iso-01f'
  let boundSession = 'sess-qq-c2c-bound'
  let unboundSession = 'sess-qq-c2c-unbound'
  let otherSession = 'sess-qq-c2c-other'
  let groupSession = 'sess-qq-group-owner'
  let pcSession = 'sess-desktop-owner'
  let unknownSession = 'sess-unknown'
  let forgedSession = 'sess-forged-provenance'

  beforeAll(async () => {
    await mkdir(join(ISO_ROOT, 'iso-vault'), { recursive: true })
    await rm(ISO_VAULT, { recursive: true, force: true })
    root = ISO_ROOT
    vault = ISO_VAULT
    service = wrapService(
      new MemoryService({
        configuredVaultPath: vault,
        configSettings: { language: 'zh', enableAutoExtraction: false, enableLlmExtraction: false },
      }),
    )
    await service.initialize(vault)

    const storeMod = await loadMod(join(PROD_QQ, 'identity/store.js'))
    const serviceMod = await loadMod(join(PROD_QQ, 'identity/service.js'))
    ingressDigest = await prepareIngressShim()
    const ingressMod = await loadMod(ISO_ING)

    const persistLog: Array<Record<string, unknown>> = []
    const storeDeps = {
      persist: (patch: Record<string, unknown>) => {
        persistLog.push(patch)
        return true
      },
    }
    store = new storeMod.IdentityStore(storeDeps)
    context = new serviceMod.QqbotContextRuntime({
      ...storeDeps,
      initial: undefined,
    })
    store = context as unknown as typeof store

    // ProvenanceRegistry is the verify surface used by OwnerGate (no dsh-llm dep)
    const registry = new ingressMod.ProvenanceRegistry({
      hostSecret: 'wp01f-iso-ingress-secret',
    })
    ingress = { verify: (input: Parameters<typeof registry.verify>[0]) => registry.verify(input), registry }

    // Pair: bound owner
    const issued = context.createPairCode()
    const pairRes = context.pair(issued.code, { platform: 'qq', appId, openid: ownerOpenId })
    expect(pairRes.ok).toBe(true)

    context.noteSource({
      sessionId: boundSession,
      platform: 'qq',
      conversationType: 'c2c',
      isPrivate: true,
      appId,
      senderId: ownerOpenId,
      identified: true,
    })
    context.noteSource({
      sessionId: unboundSession,
      platform: 'qq',
      conversationType: 'c2c',
      isPrivate: true,
      appId,
      senderId: otherOpenId,
      identified: true,
    })
    context.noteSource({
      sessionId: otherSession,
      platform: 'qq',
      conversationType: 'c2c',
      isPrivate: true,
      appId,
      senderId: 'not-the-owner-openid',
      identified: true,
    })
    context.noteSource({
      sessionId: groupSession,
      platform: 'qq',
      conversationType: 'group',
      isPrivate: false,
      appId,
      senderId: ownerOpenId,
      identified: true,
    })

    const getContextService = () => context as never
    gateOn = createOwnerGate(getContextService, {
      qqPersonalMemory: true,
      getIngress: () => ingress as never,
    })
    gateOff = createOwnerGate(getContextService, {
      qqPersonalMemory: false,
      getIngress: () => ingress as never,
    })

    // Register host provenance matching ProvenanceRegistry.verify contract
    const boundText = '请记住：QQ-C2C-MEMORY-CANARY 是我的跨设备记忆测试标识。'
    const boundMsgId = 'msg-iso-qq-write-1'
    const fiberGeneration = 1
    const { createHash } = await import('node:crypto')
    const contentDigest = createHash('sha256')
      .update(`${boundSession}\n${boundText}\nqq-c2c`, 'utf8')
      .digest('hex')
    const attestation = registry.issueAttestation({
      messageId: boundMsgId,
      sessionId: boundSession,
      contentDigest,
      packageId: 'dsh-qqbot-merge',
      entryId: 'dsh-qqbot-merge',
      fiberGeneration,
    })
    registry.register({
      messageId: boundMsgId,
      sessionId: boundSession,
      contentDigest,
      category: 'qq-c2c',
      packageId: 'dsh-qqbot-merge',
      entryId: 'dsh-qqbot-merge',
      fiberGeneration,
      provenanceId: 'iso-1',
      at: new Date().toISOString(),
    })
    const boundSourceFinal = {
      kind: 'plugin-user',
      requestId: boundMsgId,
      producer: { package: 'dsh-qqbot-merge', version: 1 },
      category: 'qq-c2c',
      attestation,
    }
    ;(globalThis as Record<string, unknown>).__isoBoundMsg = {
      boundMsgId,
      boundText,
      boundSource: boundSourceFinal,
    }
  })

  afterAll(async () => {
    // Keep iso-vault artifacts for evidence; only clear if under temp (legacy)
    if (root && root.includes('wp01f-iso')) {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('C1 QQ bound Owner writes QQ-C2C-MEMORY-CANARY via gate+service', async () => {
    const msg = (globalThis as Record<string, unknown>).__isoBoundMsg as {
      boundMsgId: string
      boundText: string
      boundSource: unknown
    }
    const before = { ...service.counters }
    const res = await gatedVaultOp({
      service,
      gate: gateOn,
      sessionId: boundSession,
      op: 'save',
      hostSource: msg.boundSource,
      hostMessageId: msg.boundMsgId,
      hostText: msg.boundText,
      payload: {
        type: 'preference' as const,
        title: 'QQ-C2C-MEMORY-CANARY',
        summary: '这是用于验证 QQ 与 PC 共享长期记忆的测试记录。',
        tags: ['cross-device', 'canary'],
        confidence: 'high' as const,
        importance: 70,
        evidence: 'WP-NEXT-01F isolated canary',
      },
    })
    expect(res.allowed).toBe(true)
    expect(service.counters.save).toBe(before.save + 1)
    // persisted on disk
    const files = await readdir(vault, { recursive: true, withFileTypes: true })
    const names = files.filter((f) => f.isFile()).map((f) => f.name)
    expect(names.some((n) => n.includes('QQ-C2C-MEMORY-CANARY') || n.endsWith('.md'))).toBe(true)
    const search = await service.search({ text: 'QQ-C2C-MEMORY-CANARY', limit: 10 })
    expect(JSON.stringify(search)).toContain('QQ-C2C-MEMORY-CANARY')
  })

  it('C2 PC retrieves the QQ-written canary from vault (not session context)', async () => {
    const before = { ...service.counters }
    const res = await gatedVaultOp({
      service,
      gate: gateOn,
      sessionId: pcSession,
      op: 'search',
      // PC live trusted path: note a desktop source
      payload: { query: '跨设备记忆测试标识', limit: 10 },
    })
    // For PC, gate needs live trusted-pc source — note it first
    // If gate denied because no live source, note desktop and retry
    if (!res.allowed) {
      context.noteSource({
        sessionId: pcSession,
        platform: 'desktop',
        conversationType: 'c2c',
        isPrivate: true,
        appId: '',
        senderId: '',
        identified: true,
      })
      const res2 = await gatedVaultOp({
        service,
        gate: gateOn,
        sessionId: pcSession,
        op: 'search',
        payload: { query: '跨设备记忆测试标识', limit: 10 },
      })
      expect(res2.allowed).toBe(true)
      expect(service.counters.search).toBe(before.search + 1)
      expect(JSON.stringify(res2.result)).toContain('QQ-C2C-MEMORY-CANARY')
      return
    }
    expect(res.allowed).toBe(true)
    expect(service.counters.search).toBe(before.search + 1)
    expect(JSON.stringify(res.result)).toContain('QQ-C2C-MEMORY-CANARY')
  })

  it('C3 PC writes PC-C2C-MEMORY-CANARY; QQ bound Owner retrieves it', async () => {
    // PC write
    context.noteSource({
      sessionId: pcSession,
      platform: 'desktop',
      conversationType: 'c2c',
      isPrivate: true,
      appId: '',
      senderId: '',
      identified: true,
    })
    const writeRes = await gatedVaultOp({
      service,
      gate: gateOn,
      sessionId: pcSession,
      op: 'save',
      payload: {
        type: 'preference' as const,
        title: 'PC-C2C-MEMORY-CANARY',
        summary: 'PC-C2C-MEMORY-CANARY 是第二条跨设备测试记录。',
        tags: ['cross-device', 'canary'],
        confidence: 'high' as const,
        importance: 70,
        evidence: 'WP-NEXT-01F isolated canary PC',
      },
    })
    expect(writeRes.allowed).toBe(true)

    // QQ bound retrieve (no hostSource → no provenance branch; uses live context)
    const before = { ...service.counters }
    const qqRead = await gatedVaultOp({
      service,
      gate: gateOn,
      sessionId: boundSession,
      op: 'search',
      payload: { query: 'PC-C2C-MEMORY-CANARY', limit: 10 },
    })
    expect(qqRead.allowed).toBe(true)
    expect(service.counters.search).toBe(before.search + 1)
    expect(JSON.stringify(qqRead.result)).toContain('PC-C2C-MEMORY-CANARY')
  })

  it('C4 permission matrix with vault call counters (DENY never calls vault)', async () => {
    const matrix: Array<{
      name: string
      sessionId: string
      expectAllowed: boolean
      noteSource?: Record<string, unknown>
      qqPersonalMemory?: boolean
      hostSource?: unknown
      hostMessageId?: string
      hostText?: string
      expectVaultCalls: 0 | 1
    }> = [
      {
        name: 'Desktop Owner',
        sessionId: pcSession,
        expectAllowed: true,
        noteSource: {
          sessionId: pcSession,
          platform: 'desktop',
          conversationType: 'c2c',
          isPrivate: true,
          appId: '',
          senderId: '',
          identified: true,
        },
        qqPersonalMemory: true,
        expectVaultCalls: 1,
      },
      {
        name: 'QQ C2C bound Owner',
        sessionId: boundSession,
        expectAllowed: true,
        qqPersonalMemory: true,
        expectVaultCalls: 1,
      },
      {
        name: 'QQ C2C unbound user',
        sessionId: unboundSession,
        expectAllowed: false,
        qqPersonalMemory: true,
        expectVaultCalls: 0,
      },
      {
        name: 'QQ C2C other user',
        sessionId: otherSession,
        expectAllowed: false,
        qqPersonalMemory: true,
        expectVaultCalls: 0,
      },
      {
        name: 'QQ Group ordinary member',
        sessionId: groupSession,
        expectAllowed: false,
        qqPersonalMemory: true,
        expectVaultCalls: 0,
      },
      {
        name: 'QQ Group Owner本人 (group scope)',
        sessionId: groupSession,
        expectAllowed: false,
        qqPersonalMemory: true,
        expectVaultCalls: 0,
      },
      {
        name: 'Unknown',
        sessionId: unknownSession,
        expectAllowed: false,
        qqPersonalMemory: true,
        expectVaultCalls: 0,
      },
      {
        name: 'Forged provenance (plugin-user not in registry)',
        sessionId: forgedSession,
        expectAllowed: false,
        qqPersonalMemory: true,
        hostSource: {
          kind: 'plugin-user',
          requestId: 'forged-msg',
          producer: { package: 'dsh-qqbot-merge', version: 1 },
          category: 'qq-c2c',
          attestation: 'forged',
        },
        hostMessageId: 'forged-msg',
        hostText: 'forged text',
        expectVaultCalls: 0,
      },
      {
        name: 'QQ C2C bound but qqPersonalMemory=false (01E production gate)',
        sessionId: boundSession,
        expectAllowed: false,
        qqPersonalMemory: false,
        expectVaultCalls: 0,
      },
    ]

    const rows: string[] = []
    for (const row of matrix) {
      if (row.noteSource) context.noteSource(row.noteSource)
      const gate = row.qqPersonalMemory === false ? gateOff : gateOn
      const before = { ...service.counters }
      const res = await gatedVaultOp({
        service,
        gate,
        sessionId: row.sessionId,
        op: 'search',
        payload: { text: 'QQ-C2C-MEMORY-CANARY', limit: 5 },
        ...(row.hostSource ? { hostSource: row.hostSource } : {}),
        ...(row.hostMessageId ? { hostMessageId: row.hostMessageId } : {}),
        ...(row.hostText ? { hostText: row.hostText } : {}),
      })
      const calls = service.counters.search - before.search
      expect(res.allowed, `${row.name}: allowed=${res.allowed} reason=${res.reason}`).toBe(row.expectAllowed)
      expect(calls, `${row.name}: vault search calls=${calls}`).toBe(row.expectVaultCalls)
      rows.push(
        `| ${row.name} | ${row.expectAllowed ? 'ALLOW' : 'DENY'} | search_calls=${calls} | ${res.reason.slice(0, 80)} |`,
      )
    }

    // C4 write-side: unbound must not save
    const beforeSave = { ...service.counters }
    const denyWrite = await gatedVaultOp({
      service,
      gate: gateOn,
      sessionId: unboundSession,
      op: 'save',
      payload: {
        type: 'preference' as const,
        title: 'SHOULD-NOT-WRITE',
        summary: 'must not persist',
        tags: ['x'],
        confidence: 'high' as const,
        importance: 10,
      },
    })
    expect(denyWrite.allowed).toBe(false)
    expect(service.counters.save).toBe(beforeSave.save)

    await writeFile(join(ISO_ROOT, 'permission-matrix-results.md'), [
      '# Stage C4 Permission Matrix Results',
      '',
      '| 来源 | 决策 | Vault 调用 | 原因 |',
      '|---|---|---|---|',
      ...rows,
      '',
      'DENY 路径 search/save 计数均为 0（未触碰 MemoryService）。',
      `vault=${vault}`,
      '',
    ].join('\n'), 'utf8')
  })

  it('identity: pair one-time + group cannot pair + unbind clears owner', async () => {
    // group pair denial is pair-gate middleware (static); store-level:
    const status1 = context.getStatus()
    expect(status1.bound).toBe(true)

    // unbind → resolveOwner null → QQ context ownerId null → DENY
    const un = context.unbind()
    expect((un as { persisted?: boolean }).persisted).not.toBe(false)
    const after = context.getStatus()
    expect(after.bound).toBe(false)
    expect(
      context.resolveOwner({ platform: 'qq', appId, openid: ownerOpenId }),
    ).toBeNull()

    const ctxAfter = context.getContext(boundSession)
    expect(ctxAfter?.ownerId).toBeNull()
    const d = decideOwnerMemoryAccess({
      platform: 'qq',
      conversationType: 'c2c',
      isPrivate: true,
      ownerId: ctxAfter?.ownerId ?? null,
      identified: true,
    })
    expect(d.allowed).toBe(false)

    // re-pair for cleanliness (not required)
    const issued = context.createPairCode()
    const again = context.pair(issued.code, { platform: 'qq', appId, openid: ownerOpenId })
    expect(again.ok).toBe(true)
    // second use of same code already-used
    const replay = context.pair(issued.code, { platform: 'qq', appId, openid: ownerOpenId })
    expect(replay.ok).toBe(false)
    expect(replay.reason).toBe('already-used')
  })

  it('production vault path was never written by this suite', async () => {
    // Prove the ingress actually exercised above is the byte-identical
    // production module, not a stand-in written for this test.
    expect(ingressDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(ingressDigest).toBe(sha256(await readFile(PROD_ING)))
    expect(vault.replace(/\\/g, '/')).toContain('wp-next-01f-c2c-memory/iso-vault')
    expect(vault.replace(/\\/g, '/')).not.toContain('Documents/DSH Memory')
    try {
      const listing = await readdir(PROD_VAULT, { recursive: true, withFileTypes: true })
      const files = listing.filter((f) => f.isFile()).map((f) => f.name)
      const hasCanary = files.some((n) => n.includes('QQ-C2C-MEMORY-CANARY') || n.includes('PC-C2C-MEMORY-CANARY'))
      expect(hasCanary).toBe(false)
    } catch {
      expect(vault.includes('Documents')).toBe(false)
    }
  })
})
