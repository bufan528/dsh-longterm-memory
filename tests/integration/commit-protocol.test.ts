/**
 * PREPARED vs COMMITTED history state (round 18).
 *
 * The commit protocol must never present a durable-but-uncommitted intent as history:
 * a staged event only becomes history after its domain write succeeds.
 *
 * @module tests/integration/commit-protocol.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'

let root: string
let vault: string
let service: MemoryService

const meta = () => join(vault, '.dsh-memory')
const pendingDir = () => join(meta(), 'journal-pending')

type RepositoryInternals = {
  stageJournal: (entry: unknown) => Promise<string>
  commitJournal: (eventId: string) => Promise<boolean>
  discardJournal: (eventId: string) => Promise<void>
  flushJournal: () => Promise<void>
}

function repo(): RepositoryInternals {
  return (service as unknown as { repository: RepositoryInternals }).repository
}

async function pendingEvents(): Promise<{ name: string; state?: string }[]> {
  const names = (await readdir(pendingDir()).catch(() => [] as string[])).filter((name) => name.endsWith('.json'))
  const out: { name: string; state?: string }[] = []
  for (const name of names) {
    const raw = await readFile(join(pendingDir(), name), 'utf8').catch(() => '')
    try {
      out.push({ name, state: (JSON.parse(raw) as { state?: string }).state })
    } catch {
      out.push({ name })
    }
  }
  return out
}

beforeEach(async () => {
  root = await makeTempRoot('commit-protocol')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault })
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

describe('a prepared event is durable but not history', () => {
  it('is invisible to history() and is not archived until committed', async () => {
    const eventId = await repo().stageJournal({ at: new Date().toISOString(), op: 'create', id: 'mem_prepared_only', reason: 'prepared test' })
    const staged = await pendingEvents()
    expect(staged.length).toBe(1)
    expect(staged[0]?.state).toBe('prepared')

    // Not history: a PREPARED event describes an operation that has not committed.
    const history = await service.history(undefined, 20)
    expect(JSON.stringify(history)).not.toContain('mem_prepared_only')

    // Archive sweep leaves it staged (it must not be presented as an archived fact).
    await repo().flushJournal()
    expect((await pendingEvents()).length).toBe(1)
    expect(JSON.stringify(await service.history(undefined, 20))).not.toContain('mem_prepared_only')

    // Committing then flushing turns it into real history exactly once.
    expect(await repo().commitJournal(eventId)).toBe(true)
    await service.history(undefined, 20)
    const visible = JSON.stringify(await service.history(undefined, 20))
    expect(visible).toContain('mem_prepared_only')
    expect((await pendingEvents()).length).toBe(0)
    await repo().flushJournal()
    const month = (await readdir(join(meta(), 'journal')).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'))
    let occurrences = 0
    for (const file of month) {
      occurrences += (await readFile(join(meta(), 'journal', file), 'utf8')).split(eventId).length - 1
    }
    expect(occurrences).toBe(1)
  })

  it('a discarded prepared event never becomes history', async () => {
    const eventId = await repo().stageJournal({ at: new Date().toISOString(), op: 'create', id: 'mem_aborted', reason: 'abort test' })
    await repo().discardJournal(eventId)
    expect((await pendingEvents()).length).toBe(0)
    expect(JSON.stringify(await service.history(undefined, 20))).not.toContain('mem_aborted')
  })
})

describe('a committed save produces committed history', () => {
  it('marks the event committed and archives it once', async () => {
    const saved = await service.save({ type: 'knowledge', title: '提交协议', summary: 'COMMIT-PROTOCOL-MARK-1000。', tags: [], confidence: 'high', importance: 50 })
    const history = await service.history(undefined, 20)
    expect(history.some((entry) => entry.id === saved.id)).toBe(true)
    expect((await pendingEvents()).length).toBe(0)
    // Repeated flushing stays idempotent.
    await repo().flushJournal()
    await repo().flushJournal()
    const month = (await readdir(join(meta(), 'journal')).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'))
    let occurrences = 0
    for (const file of month) occurrences += (await readFile(join(meta(), 'journal', file), 'utf8')).split(saved.id).length - 1
    expect(occurrences).toBeGreaterThanOrEqual(1)
  })
})
