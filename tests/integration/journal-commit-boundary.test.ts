/**
 * History commit boundary, corrupt-history visibility, and vaultPath success
 * semantics (round 17).
 *
 * Invariants under test:
 * - a history event is staged durably BEFORE the memory write, so a staging failure
 *   leaves no committed memory (fixes R16 J4);
 * - if the memory write fails, the staged event is discarded and never becomes
 *   history;
 * - a corrupt staged event makes `history()` fail loudly and is never deleted;
 * - `setSettings({vaultPath})` keeps its original success semantics: the setting is
 *   persisted, the *active* vault is not silently switched.
 *
 * @module tests/integration/journal-commit-boundary.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'

let root: string
let vault: string
let service: MemoryService

const meta = () => join(vault, '.dsh-memory')
const journalDir = () => join(meta(), 'journal')
const pendingDir = () => join(meta(), 'journal-pending')

function newService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault })
}

async function blockDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await writeFile(path, '', 'utf8')
}

async function blockFile(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await mkdir(path, { recursive: true })
}

async function pendingCount(): Promise<number> {
  return (await readdir(pendingDir()).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).length
}

async function notes(): Promise<string[]> {
  const files = await readdir(vault, { recursive: true }).catch(() => [] as string[])
  return files.filter((entry) => String(entry).endsWith('.md') && !String(entry).includes('Index') && !String(entry).includes('.dsh-memory'))
}

async function saveMarker(marker: string): Promise<string> {
  const saved = await service.save({ type: 'knowledge', title: marker, summary: `${marker} 正文。`, tags: [], confidence: 'high', importance: 50 })
  return saved.id
}

beforeEach(async () => {
  root = await makeTempRoot('commit-boundary')
  vault = join(root, 'DSH Memory')
  service = newService()
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

describe('history staging happens before the memory write', () => {
  it('a staging failure leaves NO committed memory and reports failure', async () => {
    const before = (await notes()).length
    await blockDirectory(pendingDir())

    let threw = false
    try {
      await saveMarker('STAGE-FAIL-MARK-8800')
    } catch {
      threw = true
    }
    expect(threw, 'the operation must fail when history cannot be secured').toBe(true)
    // The commit boundary: no Markdown was written at all.
    expect((await notes()).length).toBe(before)
    expect((await notes()).some((entry) => String(entry).includes('STAGE-FAIL-MARK-8800'))).toBe(false)

    // Removing the fault allows a clean retry with exactly one record.
    await rm(pendingDir(), { force: true })
    await mkdir(pendingDir(), { recursive: true })
    const retried = await saveMarker('STAGE-FAIL-MARK-8800')
    expect(retried).toBeTruthy()
    const after = (await notes()).filter((entry) => String(entry).includes('STAGE-FAIL-MARK-8800'))
    expect(after.length).toBe(1)
    expect((await service.history(undefined, 20)).length).toBeGreaterThan(0)
  })

  it('discards a staged event when the domain write is abandoned', async () => {
    // Compensating path: the service stages before writing and calls discard when the
    // write throws. Exercise that API directly (fault injection of the write itself is
    // reported as UNVERIFIED in the round-17 report: replacing the type directory with
    // a file does not reliably make `writeFileAtomic` fail on this platform).
    const repository = (service as unknown as { repository: { stageJournal: (entry: unknown) => Promise<string>; discardJournal: (id: string) => Promise<void> } }).repository
    const eventId = await repository.stageJournal({ at: new Date().toISOString(), op: 'create', id: 'mem_discarded', reason: 'discard test' })
    expect(await pendingCount()).toBe(1)
    await repository.discardJournal(eventId)
    expect(await pendingCount()).toBe(0)
    expect(JSON.stringify(await service.history(undefined, 20))).not.toContain('mem_discarded')
  })
  it('keeps archive-failure semantics: staging succeeds, so the save succeeds', async () => {
    await saveMarker('ARCHIVE-PRIMER-1000')
    const month = (await readdir(journalDir())).find((entry) => String(entry).endsWith('.jsonl'))
    expect(month).toBeDefined()
    await blockFile(join(journalDir(), String(month)))

    const id = await saveMarker('ARCHIVE-FAIL-MARK-7700')
    expect(id).toBeTruthy()
    expect(await pendingCount()).toBe(1)
    expect((await service.history(undefined, 20)).length).toBeGreaterThan(0)
  })
})

describe('corrupt staged history is visible and preserved', () => {
  it('fails history loudly and keeps the corrupt file', async () => {
    await saveMarker('CORRUPT-PRIMER-2000')
    await mkdir(pendingDir(), { recursive: true })
    const broken = join(pendingDir(), 'broken-event.json')
    await writeFile(broken, '{ this is not json', 'utf8')

    await expect(service.history(undefined, 20)).rejects.toThrow(/历史记录不完整|无法解析/)
    // The original bytes are preserved for diagnosis.
    expect(await readFile(broken, 'utf8')).toBe('{ this is not json')

    // A restart must not delete or ignore it either.
    const restarted = newService()
    await restarted.initialize(vault)
    await expect(restarted.history(undefined, 20)).rejects.toThrow(/历史记录不完整|无法解析/)
    expect(await readFile(broken, 'utf8')).toBe('{ this is not json')
  })

  it('reports missing required fields as corrupt rather than silently ignoring', async () => {
    await saveMarker('CORRUPT-PRIMER-3000')
    await mkdir(pendingDir(), { recursive: true })
    const bad = join(pendingDir(), 'missing-fields.json')
    await writeFile(bad, JSON.stringify({ at: '2026-10-17T00:00:00.000Z' }), 'utf8')
    await expect(service.history(undefined, 20)).rejects.toThrow(/历史记录不完整|无法解析/)
    expect(await readFile(bad, 'utf8')).toContain('at')
  })
})

describe('vaultPath success semantics', () => {
  it('persists the new path without silently switching the active vault', async () => {
    const beforeVault = service.getVaultPath()
    const target = join(root, 'Second Vault')
    const updated = await service.setSettings({ vaultPath: target })
    expect(updated.vaultPath).toBe(target)
    // Original contract: settings change, activation happens on the next start.
    expect(service.getVaultPath()).toBe(beforeVault)

    const reloaded = newService()
    await reloaded.initialize(target)
    expect(reloaded.getSettings().vaultPath).toBe(target)
  })
})
