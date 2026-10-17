/**
 * Single-record write recovery: writeRaw, transition (move) and remove (round 22).
 *
 * Every mode is exercised through the real service call chain. Crashes are real child
 * processes force-killed (SIGKILL) at a commit boundary; recovery runs in a brand-new
 * service instance in this process.
 *
 * @module tests/integration/single-record-recovery.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'

let root: string
let vault: string

const CHILD = join(process.cwd(), 'tests', 'support', 'child-save-crash.mjs')
const meta = () => join(vault, '.dsh-memory')
const pendingDir = () => join(meta(), 'journal-pending')

function newService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault })
}

/** A fresh service instance already attached to the isolated vault. */
async function svc(): Promise<MemoryService> {
  const service = newService()
  await service.initialize(vault)
  return service
}

async function blockDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await writeFile(path, '', 'utf8')
}

type Phase = 'after-stage' | 'after-write' | 'after-commit'
type Op = 'writeRaw' | 'transition' | 'remove'

async function crashChild(op: Op, phase: Phase, marker: string): Promise<{ signal: NodeJS.Signals | null; code: number | null; confirmed: boolean; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CHILD, vault, phase, marker, op], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code, signal) =>
      resolvePromise({ code, signal, confirmed: existsSync(join(vault, `.crash-${phase}`)), stderr }),
    )
    child.on('error', () => resolvePromise({ code: null, signal: null, confirmed: false, stderr }))
  })
}

async function filesWith(marker: string): Promise<string[]> {
  const entries = await readdir(vault, { recursive: true }).catch(() => [] as string[])
  const out: string[] = []
  for (const entry of entries) {
    const normalized = String(entry).replace(/\\/g, '/')
    const inMemoryDir = normalized.startsWith('Knowledge/') || normalized.startsWith('Archive/') || normalized.startsWith('Inbox/')
    if (!normalized.endsWith('.md') || !inMemoryDir) continue
    const text = await readFile(join(vault, String(entry)), 'utf8').catch(() => '')
    if (text.includes(marker)) out.push(String(entry))
  }
  return out.sort()
}

async function pendingFor(marker: string): Promise<number> {
  const names = (await readdir(pendingDir()).catch(() => [] as string[])).filter((name) => name.endsWith('.json'))
  let count = 0
  for (const name of names) {
    const raw = await readFile(join(pendingDir(), name), 'utf8').catch(() => '')
    if (raw.includes(marker)) count += 1
  }
  return count
}

async function monthEventsFor(id: string): Promise<number> {
  const dir = join(meta(), 'journal')
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'))
  let total = 0
  for (const name of names) {
    for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line) as { id?: string }
        if (parsed.id === id) total += 1
      } catch {
        // torn line
      }
    }
  }
  return total
}

async function seed(marker: string): Promise<string> {
  const created = await (await svc()).save({ type: 'knowledge', title: `${marker}-seed`, summary: `${marker} 种子正文。`, tags: [], confidence: 'high', importance: 50 })
  return created.id
}

/** Files whose frontmatter id matches, i.e. the real record(s), not generated pages. */
async function filesForId(id: string): Promise<string[]> {
  const entries = await readdir(vault, { recursive: true }).catch(() => [] as string[])
  const out: string[] = []
  for (const entry of entries) {
    const normalized = String(entry).replace(/\\/g, '/')
    if (!normalized.endsWith('.md') || normalized.includes('.dsh-memory')) continue
    if (normalized.startsWith('Index/') || normalized.startsWith('README') || normalized.includes('Memory Home')) continue
    const text = await readFile(join(vault, String(entry)), 'utf8').catch(() => '')
    if (new RegExp(`^id:\\s*${id}\\r?$`, 'm').test(text) || normalized.includes(id)) out.push(String(entry))
  }
  return out.sort()
}
/** Id of the record a child seeded, resolved from the note title on disk. */
async function childId(): Promise<string> {
  return (await readFile(join(vault, '.child-id'), 'utf8')).trim()
}

async function seedId(marker: string): Promise<string> {
  const recovered = await svc()
  const hit = recovered.search({ text: `${marker}-seed` }).hits[0]
  if (hit === undefined) throw new Error(`seed for ${marker} not found`)
  return hit.record.id
}

beforeEach(async () => {
  root = await makeTempRoot('single-record-recovery')
  vault = join(root, 'DSH Memory')
  await svc()
})

afterEach(async () => {
  await cleanup(root)
})

describe('writeRaw', () => {
  it('a PREPARED failure leaves the file untouched', async () => {
    const marker = 'RAW-PREP-7001'
    await seed(marker)
    const service = await svc()
    const hit = service.search({ text: `${marker}-seed` }).hits[0]
    const id = hit?.record.id as string
    // Compare through the real API on one explicit record, not a directory scan.
    const raw = await service.readRaw(id)
    await blockDirectory(pendingDir())
    let threw = false
    try {
      await service.writeRaw(id, `${raw?.content ?? ''}\nPREPARED-FAIL ${marker}\n`, raw?.checksum as string)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    const afterRaw = await service.readRaw(id)
    expect(afterRaw?.content).toBe(raw?.content)
    expect(afterRaw?.checksum).toBe(raw?.checksum)

  })

  it('killed after the raw write, before COMMITTED → recovery commits the history', async () => {
    const marker = 'RAW-CRASH-7002'
    const result = await crashChild('writeRaw', 'after-write', marker)
    const id = await childId()
    expect(result.confirmed, result.stderr).toBe(true)
    expect(result.signal === 'SIGKILL' || result.code !== 0).toBe(true)
    expect(await pendingFor(marker)).toBe(1)

    // Force a rendered write so the crash window is real: the file now contains the edit.
    const recovered = await svc()
    const history = await recovered.history(undefined, 50)
    expect(history.some((entry) => entry.id === id)).toBe(true)
    expect(await pendingFor(marker)).toBe(0)
    const notes = await filesForId(id)
    expect(notes.length).toBe(1)
    expect(await readFile(join(vault, notes[0] as string), 'utf8')).toContain(`外部编辑标记 ${marker}`)

    // Idempotent recovery: no duplicate archive, no rewrite.
    const archivedAfterFirst = await monthEventsFor(id)
    expect(archivedAfterFirst).toBe(2) // seed create + raw edit
    await svc()
    expect(await monthEventsFor(id)).toBe(archivedAfterFirst)
    expect(await filesForId(id)).toEqual(notes)
  })

  it('killed after COMMITTED, before the archive → startup archives exactly once', async () => {
    const marker = 'RAW-COMMIT-7003'
    const result = await crashChild('writeRaw', 'after-commit', marker)
    const id = await childId()
    expect(result.confirmed, result.stderr).toBe(true)
    expect(await pendingFor(marker)).toBe(1)
    const recovered = await svc()
    expect(await pendingFor(marker)).toBe(0)
    expect(await monthEventsFor(id)).toBe(2) // child seed create + this operation
    expect((await recovered.history(undefined, 50)).some((entry) => entry.id === id)).toBe(true)
  })
  it('W5: a normal raw edit keeps user body text appended inside an owned section', async () => {
    const marker = 'RAW-NORMAL-7004'
    await seed(marker)
    const service = await svc()
    const id = service.search({ text: marker + '-seed' }).hits[0]?.record.id as string
    const raw = await service.readRaw(id)
    const edited = `${raw?.content ?? ''}\n追加在相关记忆之后的正文 ${marker}。\n`
    await expect(service.writeRaw(id, edited, raw?.checksum as string)).resolves.toBeDefined()
    const after = await service.readRaw(id)
    // The user's text must survive the render (it used to be silently dropped).
    expect(after?.content).toContain(`追加在相关记忆之后的正文 ${marker}`)
    // And the edit is committed history exactly once.
    const history = await service.history(undefined, 20)
    expect(history.filter((entry) => entry.id === id && entry.op === 'update').length).toBe(1)
  })

  it('W4: content matching neither before nor after is a reported conflict', async () => {
    const marker = 'RAW-CONFLICT-7005'
    const id = await seed(marker)
    const path = (await filesForId(id))[0] as string
    await mkdir(pendingDir(), { recursive: true })
    await writeFile(
      join(pendingDir(), 'write-conflict.json'),
      JSON.stringify({
        eventId: 'write-conflict-1',
        at: new Date().toISOString(),
        op: 'update',
        id,
        state: 'prepared',
        commitMetadata: { kind: 'write', path, before: 'aaaa', after: 'bbbb' },
      }),
      'utf8',
    )
    const recovered = await svc()
    // Not silently treated as success, and the evidence is kept.
    await expect(recovered.history(undefined, 20)).rejects.toThrow(/冲突|不完整/)
    expect(existsSync(join(pendingDir(), 'write-conflict.json'))).toBe(true)
    expect((await filesWith(marker)).length).toBe(1)
  })
})

describe('transition (status change with file move)', () => {
  it('a PREPARED failure leaves the record active at its old path', async () => {
    const marker = 'MOVE-PREP-7101'
    await seed(marker)
    const id = await seedId(marker)
    const service = await svc()
    await blockDirectory(join(meta(), 'journal-pending'))
    let threw = false
    try {
      await service.setStatus(id, 'archived', 'prepared-fail')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    await rm(join(meta(), 'journal-pending'), { force: true })
    await mkdir(join(meta(), 'journal-pending'), { recursive: true })
    const reloaded = await svc()
    const hits = reloaded.search({ text: marker + '-seed' }).hits
    expect(hits[0]?.record.status).toBe('active')
  })

  it('killed after the move, before COMMITTED → recovery commits and does not move again', async () => {
    const marker = 'MOVE-CRASH-7102'
    const result = await crashChild('transition', 'after-write', marker)
    const id = await childId()
    expect(result.confirmed, result.stderr).toBe(true)
    expect(result.signal === 'SIGKILL' || result.code !== 0).toBe(true)
    expect(await pendingFor(marker)).toBe(1)

    const recovered = await svc()
    expect(await pendingFor(marker)).toBe(0)
    const hits = recovered.search({ text: marker + '-seed' }).hits
    expect(hits[0]?.record.status).toBe('archived')
    const history = await recovered.history(undefined, 50)
    expect(history.some((entry) => entry.id === id)).toBe(true)

    const again = await svc()
    expect(await monthEventsFor(id)).toBe(2) // child seed create + this operation
    expect(again.search({ text: marker + '-seed' }).hits[0]?.record.status).toBe('archived')
  })

  it('killed after COMMITTED, before the monthly archive → startup finishes the archive', async () => {
    const marker = 'MOVE-COMMIT-7104'
    const result = await crashChild('transition', 'after-commit', marker)
    expect(result.confirmed, result.stderr).toBe(true)
    expect(result.signal === 'SIGKILL' || result.code !== 0).toBe(true)
    const id = await childId()

    // Domain migration is done and the event is COMMITTED, but not yet archived.
    expect(await pendingFor(marker)).toBe(1)
    const migrated = await filesForId(id)
    expect(migrated.length).toBe(1)
    expect(String(migrated[0]).replace(/\\/g, '/')).toContain('Archive/')

    const recovered = await svc()
    expect(await pendingFor(marker)).toBe(0)
    // No duplicate source/target copies, status is the migrated one.
    expect((await filesForId(id)).length).toBe(1)
    expect(recovered.search({ text: marker + '-seed' }).hits[0]?.record.status).toBe('archived')
    expect(await monthEventsFor(id)).toBe(2) // child seed create + transition

    // Repeated recovery must not migrate again or duplicate the archive.
    const again = await svc()
    expect(await monthEventsFor(id)).toBe(2)
    expect((await filesForId(id)).length).toBe(1)
    expect(again.search({ text: marker + '-seed' }).hits[0]?.record.status).toBe('archived')
  })
  it('an unexplainable source/target combination is reported as a conflict', async () => {
    const marker = 'MOVE-CONFLICT-7103'
    const id = await seed(marker)
    const path = (await filesForId(id))[0] as string
    const target = path.replace('Knowledge/', 'Archive/')
    await mkdir(join(vault, 'Archive'), { recursive: true })
    // Both files exist with different content: neither "before" nor "after".
    const original = await readFile(join(vault, path), 'utf8')
    await writeFile(join(vault, target), `${original}\n手工改动\n`, 'utf8')
    await mkdir(pendingDir(), { recursive: true })
    await writeFile(
      join(pendingDir(), 'move-conflict.json'),
      JSON.stringify({
        eventId: 'move-conflict-1',
        at: new Date().toISOString(),
        op: 'archive',
        id,
        state: 'prepared',
        commitMetadata: { kind: 'move', from: path, to: target, before: 'aaaa', after: 'bbbb' },
      }),
      'utf8',
    )
    const recovered = await svc()
    await expect(recovered.history(undefined, 20)).rejects.toThrow(/冲突|不完整/)
    expect(existsSync(join(vault, target))).toBe(true)
    expect(existsSync(join(pendingDir(), 'move-conflict.json'))).toBe(true)
  })
})

describe('remove (permanent delete contract)', () => {
  it('a PREPARED failure keeps the record on disk', async () => {
    const marker = 'DEL-PREP-7201'
    const id = await seed(marker)
    const service = await svc()
    await blockDirectory(join(meta(), 'journal-pending'))
    let threw = false
    try {
      await service.remove(id, true, 'prepared-fail')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    await rm(join(meta(), 'journal-pending'), { force: true })
    await mkdir(join(meta(), 'journal-pending'), { recursive: true })
    expect((await filesForId(id)).length).toBe(1)
  })

  it('killed after the delete, before COMMITTED → recovery commits history, no fictional record', async () => {
    const marker = 'DEL-CRASH-7202'
    const result = await crashChild('remove', 'after-write', marker)
    const id = await childId()
    expect(result.confirmed, result.stderr).toBe(true)
    expect(result.signal === 'SIGKILL' || result.code !== 0).toBe(true)
    expect(await pendingFor(marker)).toBe(1)

    const recovered = await svc()
    expect(await pendingFor(marker)).toBe(0)
    expect(await filesForId(id)).toEqual([])
    const history = await recovered.history(undefined, 50)
    expect(history.some((entry) => entry.id === id)).toBe(true)
    // Recovery must not resurrect or duplicate anything.
    await svc()
    expect(await filesForId(id)).toEqual([])
    expect(await monthEventsFor(id)).toBe(2) // child seed create + this operation
  })

  it('killed after COMMITTED, before the archive → startup finishes the archive', async () => {
    const marker = 'DEL-COMMIT-7203'
    const result = await crashChild('remove', 'after-commit', marker)
    const id = await childId()
    expect(result.confirmed, result.stderr).toBe(true)
    expect(result.signal === 'SIGKILL' || result.code !== 0).toBe(true)

    // Target window: deletion is done, the event is COMMITTED, not yet archived.
    expect(await filesForId(id)).toEqual([])
    expect(await pendingFor(marker)).toBe(1)
    expect(await monthEventsFor(id)).toBe(1) // only the child's seed create so far

    const recovered = await svc()
    expect(await pendingFor(marker)).toBe(0)
    expect(await filesForId(id)).toEqual([])
    expect(await monthEventsFor(id)).toBe(2) // seed create + delete
    expect((await recovered.history(undefined, 50)).some((entry) => entry.id === id)).toBe(true)

    // Repeated recovery: nothing re-archived, nothing resurrected.
    await svc()
    expect(await monthEventsFor(id)).toBe(2)
    expect(await filesForId(id)).toEqual([])
  })
})
