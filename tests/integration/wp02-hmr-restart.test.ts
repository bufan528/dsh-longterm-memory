/**
 * WP-NEXT-02 Stage H — isolated lifecycle verification (HMR / restart / capability).
 * No production process is restarted and no production config is modified.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOwnerGate } from '../../src/host/owner-gate.js'

const ISO_ROOT = 'D:/dsh-memory-vault/.scratch/wp-next-02-qq-group-isolation'
const PROD_QQ = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/dsh-qqbot-merge/dist'
const PROD_ING = 'C:/Users/bf410/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-host-plugin-ingress/lib/index.js'
const APP_ID = '1906048158'

const loadMod = (p: string) => import(pathToFileURL(p).href)

describe('WP-NEXT-02 Stage H isolated lifecycle', () => {
  const evidence: Array<Record<string, unknown>> = []
  let ing: any
  let sm: any
  let qqService: any

  beforeAll(async () => {
    // Reuse the isolated copies produced by the Stage F suite; regenerate the ingress
    // stub copy if missing so this suite is independently runnable.
    const ingPath = join(ISO_ROOT, 'iso-patch/host-ingress.wp02-isolated.mjs')
    try {
      await readFile(ingPath, 'utf8')
    } catch {
      const raw = await readFile(PROD_ING, 'utf8')
      await writeFile(
        ingPath,
        raw.replace("import { createUserMessage } from '@deepseek-ai/dsh-llm';", 'const createUserMessage = (x) => x;'),
        'utf8',
      )
    }
    ing = await loadMod(ingPath)
    sm = await loadMod(join(ISO_ROOT, 'iso-patch/session-manager.wp02-isolated.mjs'))
    qqService = await loadMod(join(PROD_QQ, 'identity/service.js'))
  })

  it('H1 Session 键在「重启前后」确定性恢复，Group A/B 不碰撞', async () => {
    const smInstance = { config: { appId: APP_ID } }
    const keyA1 = sm.SessionManager.prototype.sessionKey.call(smInstance, 'group', 'group-A')
    const idA1 = sm.SessionManager.prototype.deriveSessionId.call(smInstance, keyA1)
    // simulate a fresh process re-deriving from the same persisted key
    const smInstance2 = { config: { appId: APP_ID } }
    const keyA2 = sm.SessionManager.prototype.sessionKey.call(smInstance2, 'group', 'group-A')
    const idA2 = sm.SessionManager.prototype.deriveSessionId.call(smInstance2, keyA2)
    const keyB = sm.SessionManager.prototype.sessionKey.call(smInstance2, 'group', 'group-B')
    const idB = sm.SessionManager.prototype.deriveSessionId.call(smInstance2, keyB)
    const keyC2c = sm.SessionManager.prototype.sessionKey.call(smInstance2, 'c2c', 'owner-openid')
    expect(keyA1).toBe(keyA2)
    expect(idA1).toBe(idA2)
    expect(idA1).not.toBe(idB)
    expect(keyC2c).not.toBe(keyA1)
    evidence.push({ id: 'H1', keyA: keyA1, keyB, keyC2c, sessionIdA: idA1, sessionIdB: idB, restored: idA1 === idA2 })
  })

  it('H2/H3 HMR 后旧 Capability 失效、Ingress 卸载 FAIL CLOSED，Host provenance 仍为 qq-group', async () => {
    const registry = new ing.ProvenanceRegistry({ hostSecret: 'wp02-hmr-iso' })
    let generation = 1
    let alive = true
    const delivered: any[] = []
    const cap = new ing.BoundPluginIngress({
      identity: {
        packageId: 'dsh-qqbot-merge', entryId: 'dsh-qqbot-merge',
        fiberGeneration: 1, fiberUid: 'wp02-fiber-1',
      },
      deliver: async (input: any) => { delivered.push(input) },
      registry,
      currentGeneration: () => generation,
      isAlive: () => alive,
    })
    const makeInput = (msgId: string) => ({
      sessionId: 'sess-group-a-hmr',
      text: 'GROUP-A-HMR-CANARY',
      delivery: 'followup',
      requestId: msgId,
      qq: {
        qqMessageId: msgId, peerId: 'group-A', senderId: 'member-a',
        conversationType: 'group', groupId: 'group-A', appId: APP_ID,
      },
    })
    const r1 = await cap.submit(makeInput('msg-hmr-1'))
    expect(r1.ok).toBe(true)
    expect(r1.category).toBe('qq-group')
    expect(delivered[0].source).toMatchObject({
      kind: 'plugin-user', category: 'qq-group',
      producer: { package: 'dsh-qqbot-merge', version: 1 },
    })
    expect(typeof delivered[0].source.attestation).toBe('string')

    generation = 2 // QQ plugin HMR → new fiber generation
    const r2 = await cap.submit(makeInput('msg-hmr-2'))
    expect(r2.ok).toBe(false)
    expect(r2.reason).toBe('fiber-generation-stale')

    generation = 1
    alive = false // Ingress unloaded
    const r3 = await cap.submit(makeInput('msg-hmr-3'))
    expect(r3.ok).toBe(false)
    expect(r3.reason).toBe('capability-disposed')
    expect(delivered.length).toBe(1) // stale/disposed capabilities never deliver

    // MV Owner Gate with no ingress available and a plugin-user source → FAIL CLOSED
    const gate = createOwnerGate(() => undefined, { qqPersonalMemory: true, getIngress: () => undefined })
    const d = gate({
      sessionId: 'sess-group-a-hmr',
      hostSource: delivered[0].source,
      hostMessageId: 'msg-hmr-1',
      hostText: 'GROUP-A-HMR-CANARY',
    } as any)
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('provenance verify unavailable')

    evidence.push({
      id: 'H2', firstSubmit: r1, staleSubmit: r2, disposedSubmit: r3,
      deliveredCount: delivered.length,
      hostSource: {
        kind: delivered[0].source.kind,
        category: delivered[0].source.category,
        producer: delivered[0].source.producer,
        attestationPresent: true,
      },
      gateWhenIngressUnavailable: d,
    })
  })

  it('H4/H5 Owner Binding 跨「重启」保持，群来源重启后仍 DENY', async () => {
    const persisted: any[] = []
    const deps = { persist: (patch: any) => { persisted.push(patch); return true } }
    const first = new qqService.QqbotContextRuntime({ ...deps, initial: undefined })
    const issued = first.createPairCode()
    expect(first.pair(issued.code, { platform: 'qq', appId: APP_ID, openid: 'owner-openid-hmr' }).ok).toBe(true)
    first.noteSource({
      sessionId: 'sess-group-a-hmr', platform: 'qq', appId: APP_ID,
      conversationType: 'group', isPrivate: false,
      senderId: 'owner-openid-hmr', identified: true,
    })
    first.noteSource({
      sessionId: 'sess-c2c-hmr', platform: 'qq', appId: APP_ID,
      conversationType: 'c2c', isPrivate: true,
      senderId: 'owner-openid-hmr', identified: true,
    })

    // A fresh runtime rehydrated from the persisted `ownerBinding` row config
    let restored: any = null
    try {
      restored = new qqService.QqbotContextRuntime({ ...deps, initial: persisted.at(-1)?.ownerBinding })
    } catch {
      restored = null
    }
    const statusBefore = first.getStatus()
    const statusAfter = restored?.getStatus?.() ?? null
    expect(statusBefore.bound).toBe(true)
    expect(statusAfter?.bound).toBe(true)

    const target = restored ?? first
    // H5a: right after restart, before the QQ plugin re-reports live sources → fail-closed DENY
    const coldGate = createOwnerGate(() => target, { qqPersonalMemory: true, getIngress: () => undefined })
    const coldGroup = coldGate({ sessionId: 'sess-group-a-hmr' })
    expect(coldGroup.allowed).toBe(false)

    // QQ plugin re-registers the live provenance for restored sessions
    target.noteSource({
      sessionId: 'sess-group-a-hmr', platform: 'qq', appId: APP_ID,
      conversationType: 'group', isPrivate: false,
      senderId: 'owner-openid-hmr', identified: true,
    })
    target.noteSource({
      sessionId: 'sess-c2c-hmr', platform: 'qq', appId: APP_ID,
      conversationType: 'c2c', isPrivate: true,
      senderId: 'owner-openid-hmr', identified: true,
    })
    const gate = createOwnerGate(() => target, { qqPersonalMemory: true, getIngress: () => undefined })
    const groupDecision = gate({ sessionId: 'sess-group-a-hmr' })
    const c2cDecision = gate({ sessionId: 'sess-c2c-hmr' })
    expect(groupDecision.allowed).toBe(false)
    expect(groupDecision.reason).toContain('群聊')
    expect(c2cDecision.allowed).toBe(true)
    evidence.push({
      id: 'H4', persistedPatches: persisted.length,
      boundBefore: statusBefore.bound, boundAfter: statusAfter?.bound ?? null,
      bindingKept: statusBefore.bound === true && statusAfter?.bound === true,
      rehydrated: restored !== null,
      coldStartDecision: coldGroup, groupDecision, c2cDecision,
    })
  })

  it('H6 输出生命周期证据（不重启生产）', async () => {
    expect(evidence.length).toBeGreaterThanOrEqual(3)
    await writeFile(
      join(ISO_ROOT, 'evidence/hmr-restart-evidence.json'),
      JSON.stringify({
        note: 'isolated lifecycle verification only; production Host was NOT restarted',
        productionRestart: false,
        productionConfigModified: false,
        evidence,
      }, null, 2),
      'utf8',
    )
  })
})
