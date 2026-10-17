/**
 * Event-file identity mapping: injective encoding, legacy compatibility (round 31).
 *
 * The on-disk staging file name is `evt_<base64url(eventId)>`, which is legal on
 * Windows and collision-free for the supported id domain. The JSON payload keeps the
 * raw id; older files (raw or R29-sanitised names) are still found by payload.
 *
 * @module tests/integration/event-file-identity.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { encodeEventFile, MAX_EVENT_ID_BYTES } from '../../src/host/core/journal-outbox.js'

let root: string
let vault: string
let service: MemoryService

const meta = () => join(vault, '.dsh-memory')
const pendingDir = () => join(meta(), 'journal-pending')
const journalDir = () => join(meta(), 'journal')

type Repo = {
  stageJournal: (entry: unknown) => Promise<string>
  commitJournal: (id: string) => Promise<boolean>
  flushJournal: () => Promise<void>
  discardJournal: (id: string) => Promise<void>
  clearOperation: (id: string) => Promise<void>
}

function repo(): Repo {
  return (service as unknown as { repository: Repo }).repository
}

function entry(eventId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { eventId, at: new Date().toISOString(), op: 'update', id: `mem_${eventId.replace(/[^A-Za-z0-9]/g, '_')}`, reason: 'r31', before: 'b', after: 'a', ...overrides }
}

async function pendingNames(): Promise<string[]> {
  return (await readdir(pendingDir()).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort()
}

async function monthText(): Promise<string> {
  const names = (await readdir(journalDir()).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'))
  let text = ''
  for (const name of names) text += await readFile(join(journalDir(), name), 'utf8')
  return text
}

beforeEach(async () => {
  root = await makeTempRoot('event-file-identity')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault })
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

describe('injective event file encoding', () => {
  it('a:b and a?b map to distinct files and never overwrite each other', async () => {
    expect(encodeEventFile('a:b')).not.toBe(encodeEventFile('a?b'))
    const id1 = await repo().stageJournal(entry('a:b'))
    const id2 = await repo().stageJournal(entry('a?b'))
    expect(id1).not.toBe(id2)
    const names = await pendingNames()
    expect(names.length).toBe(2)
    // The R29 lossy mapping would have produced a single `a_b.json`.
    expect(names).not.toContain('a_b.json')
    for (const name of names) expect(name).toMatch(/^evt_[A-Za-z0-9_-]+\.json$/)

    await repo().commitJournal('a:b')
    await repo().commitJournal('a?b')
    await repo().flushJournal()
    const text = await monthText()
    expect(text).toContain('"eventId":"a:b"')
    expect(text).toContain('"eventId":"a?b"')
    expect(await pendingNames()).toEqual([])
  })

  it('payload eventId stays raw while the file name is encoded', async () => {
    await repo().stageJournal(entry('weird:id/with\\chars'))
    const names = await pendingNames()
    expect(names.length).toBe(1)
    const name = names[0] as string
    expect(name).toMatch(/^evt_[A-Za-z0-9_-]+\.json$/)
    const payload = JSON.parse(await readFile(join(pendingDir(), name), 'utf8'))
    expect(payload.eventId).toBe('weird:id/with\\chars')
  })

  it('rejects oversize ids before writing anything', async () => {
    const tooLong = 'x'.repeat(MAX_EVENT_ID_BYTES + 1)
    await expect(repo().stageJournal(entry(tooLong))).rejects.toThrow(/过长|INVALID_NAME/)
    expect(await pendingNames()).toEqual([])
  })

  it('Windows reserved device names never become file names', async () => {
    await repo().stageJournal(entry('CON'))
    const names = await pendingNames()
    expect(names.length).toBe(1)
    expect((names[0] as string).startsWith('evt_')).toBe(true)
    expect(names.map((name) => name.toUpperCase())).not.toContain('CON.JSON')
  })
})

describe('legacy file names remain readable', () => {
  it('finds a pending file written with the raw safe name', async () => {
    await mkdir(pendingDir(), { recursive: true })
    await writeFile(join(pendingDir(), 'plain.id.json'), JSON.stringify({ ...entry('plain.id'), state: 'prepared' }), 'utf8')
    expect(await repo().commitJournal('plain.id')).toBe(true)
    await repo().flushJournal()
    expect(await monthText()).toContain('"eventId":"plain.id"')
    expect(await pendingNames()).toEqual([])
  })

  it('finds a pending file written with the R29 sanitised name', async () => {
    await mkdir(pendingDir(), { recursive: true })
    await writeFile(join(pendingDir(), 'a_b.json'), JSON.stringify({ ...entry('a:b'), state: 'prepared' }), 'utf8')
    expect(await repo().commitJournal('a:b')).toBe(true)
    await repo().flushJournal()
    expect(await monthText()).toContain('"eventId":"a:b"')
    expect(await pendingNames()).toEqual([])
  })

  it('discard removes legacy and canonical copies of the same id', async () => {
    await mkdir(pendingDir(), { recursive: true })
    await writeFile(join(pendingDir(), 'a_b.json'), JSON.stringify({ ...entry('a:b'), state: 'committed' }), 'utf8')
    await repo().stageJournal(entry('a:b'))
    expect((await pendingNames()).length).toBe(2) // legacy + canonical
    await repo().discardJournal('a:b')
    expect(await pendingNames()).toEqual([])
  })
  it('same id staged twice stays a single event', async () => {
    await repo().stageJournal(entry('dup:id'))
    await repo().stageJournal(entry('dup:id'))
    expect(await pendingNames()).toEqual(['evt_6475703a6964.json'])
    await repo().commitJournal('dup:id')
    await repo().flushJournal()
    expect((await monthText()).split('"eventId":"dup:id"').length - 1).toBe(1)
  })
})

describe('R32: case-insensitive filesystem identity', () => {
  it('2.G and 2.a collide under the old base64url name, but not under hex', async () => {
    const oldG = Buffer.from('2.G', 'utf8').toString('base64url')
    const oldA = Buffer.from('2.a', 'utf8').toString('base64url')
    // The R31 defect: case-insensitive comparison folds these to the same name.
    expect(oldG.toLowerCase()).toBe(oldA.toLowerCase())
    const newG = encodeEventFile('2.G')
    const newA = encodeEventFile('2.a')
    expect(newG).not.toBe(newA)
    expect(newG.toLowerCase()).not.toBe(newA.toLowerCase())
    // Real filesystem: both can coexist with distinct payloads.
    await repo().stageJournal(entry('2.G'))
    await repo().stageJournal(entry('2.a'))
    expect((await pendingNames()).length).toBe(2)
    expect((await pendingNames()).some((name) => name.toLowerCase() === (newG + '.json').toLowerCase())).toBe(true)
    expect((await pendingNames()).some((name) => name.toLowerCase() === (newA + '.json').toLowerCase())).toBe(true)
    await repo().commitJournal('2.G')
    await repo().commitJournal('2.a')
    await repo().flushJournal()
    const text = await monthText()
    expect(text).toContain('"eventId":"2.G"')
    expect(text).toContain('"eventId":"2.a"')
  })

  it('case-only and unicode ids stay distinct', async () => {
    const ids = ['EventA', 'eventa', '记忆:id']
    const encoded = ids.map((id) => encodeEventFile(id).toLowerCase())
    expect(new Set(encoded).size).toBe(ids.length)
    for (const id of ids) await repo().stageJournal(entry(id))
    expect(await pendingNames()).toHaveLength(ids.length)
    for (const id of ids) await repo().commitJournal(id)
    await repo().flushJournal()
    const text = await monthText()
    for (const id of ids) expect(text).toContain('"eventId":"' + id + '"')
  })

  it('accepts the 96-byte boundary and rejects unpaired surrogates', async () => {
    const boundary = 'y'.repeat(96)
    await expect(repo().stageJournal(entry(boundary))).resolves.toBeTruthy()
    await expect(repo().stageJournal(entry('\uD800'))).rejects.toThrow(/代理项|INVALID_NAME/)
    expect(await pendingNames()).toHaveLength(1)
  })

  it('finds files written with the R31 base64url name', async () => {
    await mkdir(pendingDir(), { recursive: true })
    await writeFile(join(pendingDir(), 'evt_Mi5H.json'), JSON.stringify({ ...entry('2.G'), state: 'prepared' }), 'utf8')
    expect(await repo().commitJournal('2.G')).toBe(true)
    await repo().flushJournal()
    expect(await monthText()).toContain('"eventId":"2.G"')
    expect(await pendingNames()).toEqual([])
  })
})

describe('R32: clearOperation input validation', () => {
  it('removes a valid plan and rejects unsafe ids without deleting anything', async () => {
    await mkdir(pendingDir(), { recursive: true })
    await writeFile(join(pendingDir(), 'op_merge_ok.json'), JSON.stringify({ kind: 'operation', operationId: 'op_merge_ok' }), 'utf8')
    await writeFile(join(pendingDir(), 'keep.json'), JSON.stringify({ eventId: 'keep', at: new Date().toISOString(), id: 'mem_keep' }), 'utf8')
    await writeFile(join(pendingDir(), 'op_merge_m0000000_abc123.json'), JSON.stringify({ kind: 'operation', operationId: 'op_merge_m0000000_abc123' }), 'utf8')
    const keepBefore = await readFile(join(pendingDir(), 'keep.json'), 'utf8')
    await repo().clearOperation('op_merge_ok')
    await repo().clearOperation('op_merge_m0000000_abc123')
    expect(await pendingNames()).toEqual(['keep.json'])
    for (const bad of ['../evil', '..\\\\evil', 'a/b', 'a\\\\b', '..', '', 'x'.repeat(200)]) {
      await expect(repo().clearOperation(bad), bad).rejects.toMatchObject({ code: 'FS_INVALID_NAME' })
      expect(await pendingNames(), bad).toEqual(['keep.json'])
      expect(await readFile(join(pendingDir(), 'keep.json'), 'utf8'), bad).toBe(keepBefore)
    }
  })
})