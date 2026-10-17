/**
 * Journal eventId content-conflict detection (round 27).
 *
 * Rules under test:
 * - same eventId + same payload      → idempotent merge (one logical event);
 * - same eventId + different payload → CONFLICT (history fails, both copies kept);
 * - different eventIds + same payload → both kept (independent operations);
 * - legacy events without eventId    → stable identity, all kept, no phantom conflicts.
 *
 * @module tests/integration/journal-conflicts.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'

let root: string
let vault: string
let service: MemoryService

const meta = () => join(vault, '.dsh-memory')
const pendingDir = () => join(meta(), 'journal-pending')
const monthFile = () => join(meta(), 'journal', `${new Date().toISOString().slice(0, 7)}.jsonl`)

function newService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault })
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt-1',
    at: new Date().toISOString(),
    op: 'update',
    id: 'mem_conflict',
    reason: '测试事件',
    before: 'before-payload',
    after: 'after-payload',
    ...overrides,
  }
}

async function writeMonth(entries: Record<string, unknown>[]): Promise<void> {
  await mkdir(join(meta(), 'journal'), { recursive: true })
  await writeFile(monthFile(), entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8')
}

async function addPending(name: string, payload: Record<string, unknown>): Promise<string> {
  await mkdir(pendingDir(), { recursive: true })
  const path = join(pendingDir(), `${name}.json`)
  await writeFile(path, JSON.stringify({ state: 'committed', ...payload }), 'utf8')
  return path
}

async function monthLines(): Promise<Record<string, unknown>[]> {
  const raw = await readFile(monthFile(), 'utf8').catch(() => '')
  return raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function pendingNames(): Promise<string[]> {
  return (await readdir(pendingDir()).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort()
}

beforeEach(async () => {
  root = await makeTempRoot('journal-conflicts')
  vault = join(root, 'DSH Memory')
  service = newService()
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

describe('same eventId and payload', () => {
  it('C1: duplicates inside the month file merge into one logical event', async () => {
    await writeMonth([entry(), entry()])
    const history = await service.history(undefined, 50)
    expect(history.filter((item) => item.id === 'mem_conflict').length).toBe(1)
    // Raw evidence is untouched.
    expect((await monthLines()).length).toBe(2)
  })

  it('C3: a pending copy identical to the archived one converges idempotently', async () => {
    const same = entry()
    await writeMonth([same])
    await addPending('dup', same)
    const history = await service.history(undefined, 50)
    expect(history.filter((item) => item.id === 'mem_conflict').length).toBe(1)
    expect(await pendingNames()).toEqual([]) // identical copy archived/cleaned
    expect((await monthLines()).length).toBe(1) // not appended twice
  })

  it('C5: two identical pending copies converge without duplicate history', async () => {
    const same = entry()
    await addPending('a', same)
    await addPending('b', same)
    const history = await service.history(undefined, 50)
    expect(history.filter((item) => item.id === 'mem_conflict').length).toBe(1)
    expect((await monthLines()).filter((line) => line['eventId'] === 'evt-1').length).toBe(1)
    expect(await pendingNames()).toEqual([])
  })
})

describe('same eventId, different payload', () => {
  it('C2: differing duplicates in the month file are a conflict, evidence preserved', async () => {
    await writeMonth([entry(), entry({ after: 'other-after' })])
    await expect(service.history(undefined, 50)).rejects.toThrow(/冲突|history/)
    expect((await monthLines()).length).toBe(2)
  })

  it('C4: archived vs pending disagreement is a conflict and keeps both copies', async () => {
    await writeMonth([entry()])
    await addPending('bad', entry({ reason: '不同原因' }))
    await expect(service.history(undefined, 50)).rejects.toThrow(/冲突/)
    expect((await monthLines()).length).toBe(1)
    expect(await pendingNames()).toEqual(['bad.json'])
    expect(JSON.parse(await readFile(join(pendingDir(), 'bad.json'), 'utf8'))['state']).toBe('committed')
  })

  it('C6: two pending copies with different payloads are a conflict, neither deleted', async () => {
    await addPending('a', entry())
    await addPending('b', entry({ after: 'other-after' }))
    await expect(service.history(undefined, 50)).rejects.toThrow(/冲突/)
    // One copy may already be archived, but the disagreeing pending copy is preserved.
    expect(await pendingNames()).toEqual(['b.json'])
    expect((await monthLines()).filter((line) => line['eventId'] === 'evt-1').length).toBe(1)
  })

  it('C8: each semantic field difference alone triggers the conflict', async () => {
    for (const [field, value] of [
      ['op', 'delete'],
      ['id', 'mem_other'],
      ['reason', '另一个原因'],
      ['before', 'other-before'],
      ['after', 'other-after'],
    ] as const) {
      await writeMonth([entry(), entry({ [field]: value })])
      await expect(service.history(undefined, 50), `field ${field}`).rejects.toThrow(/冲突/)
    }
  })
})

describe('independent events', () => {
  it('C9: different eventIds with identical payloads both stay', async () => {
    await writeMonth([entry({ eventId: 'evt-a' }), entry({ eventId: 'evt-b' })])
    const history = await service.history(undefined, 50)
    const mine = history.filter((item) => item.id === 'mem_conflict')
    expect(mine.length).toBe(2)
    // Still two archived lines: nothing merged by payload.
    expect((await monthLines()).length).toBe(2)
  })

  it('legacy lines without eventId keep stable identity and are all retained', async () => {
    const legacy = { at: new Date().toISOString(), op: 'update', id: 'mem_legacy', reason: '旧格式', before: 'b', after: 'a' }
    await writeMonth([legacy, { ...legacy }])
    const first = await service.history(undefined, 50)
    const second = await service.history(undefined, 50)
    expect(first.filter((item) => item.id === 'mem_legacy').length).toBe(2) // no folding by content
    expect(second.filter((item) => item.id === 'mem_legacy').length).toBe(2) // stable across reads
    expect((await monthLines()).length).toBe(2)
  })
})
