/**
 * Multi-record operation commit and forward recovery: `merge` (round 28).
 *
 * The plan (survivor + retired states, checksums, deterministic event ids) is persisted
 * before the first domain write. A crash mid-merge is recovered from the plan by a new
 * instance, idempotently; unknown states become CONFLICT.
 *
 * @module tests/integration/multi-record-merge.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'

let root: string
let vault: string
let service: MemoryService

const meta = () => join(vault, '.dsh-memory')
const pendingDir = () => join(meta(), 'journal-pending')
const CHILD = join(process.cwd(), 'tests', 'support', 'child-save-crash.mjs')

function newService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault })
}

async function svc(): Promise<MemoryService> {
  const instance = newService()
  await instance.initialize(vault)
  return instance
}

async function seedPair(marker: string): Promise<[string, string]> {
  const instance = await svc()
  const a = await instance.save({ type: 'knowledge', title: `${marker}-a`, summary: `${marker} 第一条。`, tags: [], confidence: 'high', importance: 50 })
  const b = await instance.save({ type: 'knowledge', title: `${marker}-b`, summary: `${marker} 第二条。`, tags: [], confidence: 'high', importance: 50 })
  return [a.id, b.id]
}

async function operations(): Promise<number> {
  const names = (await readdir(pendingDir()).catch(() => [] as string[])).filter((name) => name.endsWith('.json'))
  let count = 0
  for (const name of names) {
    const raw = await readFile(join(pendingDir(), name), 'utf8').catch(() => '')
    if (raw.includes('"kind":"operation"')) count += 1
  }
  return count
}

async function monthEventCount(id: string): Promise<number> {
  const dir = join(meta(), 'journal')
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'))
  let total = 0
  for (const name of names) {
    for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) {
      if (line.trim().length === 0) continue
      try {
        if ((JSON.parse(line) as { id?: string }).id === id) total += 1
      } catch {
        // torn line
      }
    }
  }
  return total
}


beforeEach(async () => {
  root = await makeTempRoot('multi-record-merge')
  vault = join(root, 'DSH Memory')
  service = await svc()
})

afterEach(async () => {
  await cleanup(root)
})

describe('merge: operation plan is durable before domain writes', () => {
  it('a plan-staging failure leaves both records untouched', async () => {
    const [a, b] = await seedPair('MERGE-PREP-8001')
    const idsBefore = JSON.stringify((await svc()).search({ text: '' }).hits.map((hit) => `${hit.record.id}:${hit.record.status}`).sort())
    await blockDirectory(pendingDir())
    let threw = false
    try {
      await service.merge({ ids: [a, b], targetId: a })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // Fault removed: both records unchanged, no operation plan, no merge event.
    await restorePending()
    const reloaded = await svc()
    const idsAfter = JSON.stringify(reloaded.search({ text: '' }).hits.map((hit) => `${hit.record.id}:${hit.record.status}`).sort())
    expect(idsAfter).toBe(idsBefore)
    expect(await operations()).toBe(0)
    expect(await monthEventCount(a)).toBe(1) // only the seed create
  })
  it('killed after the survivor write → recovery finishes the merge', async () => {
    const marker = 'MERGE-CRASH-8002'
    const child = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; confirmed: boolean; stderr: string }>((resolvePromise) => {
      const process_ = spawn(process.execPath, [CHILD, vault, 'after-survivor', marker, 'merge'], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      process_.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      process_.on('close', (code, signal) => resolvePromise({ code, signal, confirmed: existsSync(join(vault, '.crash-after-survivor')), stderr }))
    })
    expect(child.confirmed, child.stderr).toBe(true)
    expect(child.signal === 'SIGKILL' || child.code !== 0).toBe(true)
    const ids = JSON.parse(await readFile(join(vault, '.child-ids'), 'utf8')) as string[]
    expect(ids.length).toBe(2)
    // Resolve roles semantically (never by array position): the child's first record
    // (`.child-id`) is the merge target; the other id is the retired record.
    const survivorId = await childId()
    const retiredId = ids.find((id) => id !== survivorId) as string
    expect(ids).toContain(survivorId)
    expect(retiredId).toBeDefined()
    // The operation plan survived the crash; the operation is not yet complete.
    expect(await operations()).toBe(1)

    const recovered = await svc()
    expect(await operations()).toBe(0) // plan executed and cleared
    const diary = JSON.stringify({ ids, survivorId, retiredId })
    expect(await statusFromDisk(recovered, survivorId), diary).toBe('active')
    expect(await statusFromDisk(recovered, retiredId), diary).toBe('superseded')
    // One merge + one supersede event for this operation, archived exactly once.
    expect(await monthEventCount(survivorId)).toBe(2) // seed create + merge
    expect(await monthEventCount(retiredId)).toBe(2) // seed create + supersede
    expect((await recovered.history(undefined, 50)).some((entry) => entry.op === 'merge' && entry.id === survivorId)).toBe(true)

    // Repeated recovery: no re-merge, no duplicate events.
    await svc()
    expect(await operations()).toBe(0)
    expect(await monthEventCount(survivorId)).toBe(2)
    expect(await monthEventCount(retiredId)).toBe(2)
  })
})

async function childId(): Promise<string> {
  return (await readFile(join(vault, '.child-id'), 'utf8')).trim()
}
async function statusFromDisk(instance: MemoryService, id: string): Promise<string | undefined> {
  const raw = await instance.readRaw(id)
  return /^status:\s*(\S+)$/m.exec(raw?.content ?? '')?.[1]
}

async function blockDirectory(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(path, { force: true, recursive: true })
  await writeFile(path, '', 'utf8')
}

async function restorePending(): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(pendingDir(), { force: true, recursive: true })
  await mkdir(pendingDir(), { recursive: true })
}

async function runMergeCrash(phase: 'after-survivor' | 'after-other' | 'after-commit', marker: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; confirmed: boolean; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CHILD, vault, phase, marker, 'merge'], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('close', (code, signal) => resolvePromise({ code, signal, confirmed: existsSync(join(vault, `.crash-${phase}`)), stderr }))
  })
}

describe('R33: remaining merge fault windows', () => {
  it('killed after the retired record, before journaling → recovery finishes idempotently', async () => {
    const marker = 'MERGE-AFTER-OTHER-9001'
    const child = await runMergeCrash('after-other', marker)
    expect(child.confirmed, child.stderr).toBe(true)
    expect(child.signal === 'SIGKILL' || child.code !== 0).toBe(true)
    const ids = JSON.parse(await readFile(join(vault, '.child-ids'), 'utf8')) as string[]
    const survivorId = await childId()
    const retiredId = ids.find((id) => id !== survivorId) as string
    expect(await operations()).toBe(1) // plan retained
    expect(await monthEventCount(survivorId)).toBe(1) // only seed create: no events yet

    const recovered = await svc()
    expect(await operations()).toBe(0)
    expect(await statusFromDisk(recovered, survivorId)).toBe('active')
    expect(await statusFromDisk(recovered, retiredId)).toBe('superseded')
    expect(await monthEventCount(survivorId)).toBe(2)
    expect(await monthEventCount(retiredId)).toBe(2)

    await svc()
    expect(await operations()).toBe(0)
    expect(await monthEventCount(survivorId)).toBe(2)
    expect(await monthEventCount(retiredId)).toBe(2)
  })

  it('killed after COMMITTED events, before plan cleanup → recovery does not duplicate archives', async () => {
    const marker = 'MERGE-AFTER-COMMIT-9002'
    const child = await runMergeCrash('after-commit', marker)
    expect(child.confirmed, child.stderr).toBe(true)
    expect(child.signal === 'SIGKILL' || child.code !== 0).toBe(true)
    const ids = JSON.parse(await readFile(join(vault, '.child-ids'), 'utf8')) as string[]
    const survivorId = await childId()
    const retiredId = ids.find((id) => id !== survivorId) as string
    expect(await operations()).toBe(1) // committed, plan not cleared
    expect(await monthEventCount(survivorId)).toBe(2) // events already archived

    const recovered = await svc()
    expect(await operations()).toBe(0) // cleanup completed by recovery
    expect(await monthEventCount(survivorId)).toBe(2) // exactly once, no duplicate
    expect(await monthEventCount(retiredId)).toBe(2)
    expect(await statusFromDisk(recovered, survivorId)).toBe('active')
    expect(await statusFromDisk(recovered, retiredId)).toBe('superseded')

    await svc()
    expect(await operations()).toBe(0)
    expect(await monthEventCount(survivorId)).toBe(2)
  })
})

async function runRecoverCrash(phase: 'after-survivor' | 'after-other' | 'after-commit', marker: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; confirmed: boolean; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CHILD, vault, phase, marker, 'recover'], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('close', (code, signal) => resolvePromise({ code, signal, confirmed: existsSync(join(vault, `.crash-${phase}`)), stderr }))
  })
}

/** Read a record's status directly from disk (no service instance, no recovery). */
async function diskStatus(id: string): Promise<string | undefined> {
  const entries = await readdir(vault, { recursive: true })
  for (const entry of entries) {
    const rel = String(entry)
    if (!rel.endsWith('.md') || rel.includes('.dsh-memory')) continue
    const text = await readFile(join(vault, rel), 'utf8').catch(() => '')
    if (!new RegExp(`^id:\\s*${id}\\r?$`, 'm').test(text)) continue
    return /^status:\s*(\S+)$/m.exec(text)?.[1]
  }
  return undefined
}

describe('R33-W6: crash during recovery itself', () => {
  it('killed after recovery applied the retired write → next startup completes it', async () => {
    const marker = 'MERGE-W6-9003'
    // Phase 1: create a real interrupted merge (plan + survivor write only).
    const first = await runMergeCrash('after-survivor', marker)
    expect(first.confirmed, first.stderr).toBe(true)
    const ids = JSON.parse(await readFile(join(vault, '.child-ids'), 'utf8')) as string[]
    const survivorId = await childId()
    const retiredId = ids.find((id) => id !== survivorId) as string
    expect(await operations()).toBe(1)

    // Phase 2: a recovery-only process is killed after it persisted the retired write.
    const second = await runRecoverCrash('after-other', marker)
    expect(second.confirmed, second.stderr).toBe(true)
    expect(second.signal === 'SIGKILL' || second.code !== 0).toBe(true)

    // Recovery made real progress (retired now superseded) but did not finish:
    // plan must remain, events must not be archived yet.
    expect(await operations()).toBe(1)
    expect(await diskStatus(survivorId)).toBe('active')
    expect(await diskStatus(retiredId)).toBe('superseded')
    expect(await monthEventCount(survivorId)).toBe(1) // only seed create
    expect(await monthEventCount(retiredId)).toBe(1)

    // Phase 3: a fresh instance completes recovery exactly once.
    const recovered = await svc()
    expect(await operations()).toBe(0)
    expect(await statusFromDisk(recovered, survivorId)).toBe('active')
    expect(await statusFromDisk(recovered, retiredId)).toBe('superseded')
    expect(await monthEventCount(survivorId)).toBe(2)
    expect(await monthEventCount(retiredId)).toBe(2)

    await svc()
    expect(await operations()).toBe(0)
    expect(await monthEventCount(survivorId)).toBe(2)
    expect(await monthEventCount(retiredId)).toBe(2)
  })
})