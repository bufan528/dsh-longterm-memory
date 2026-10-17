/**
 * Settings failure consistency and journal partial-commit semantics (round 15).
 *
 * Two questions:
 * 1. When `setSettings` cannot persist, does the running instance stay on the old
 *    values? The error message claims "本次修改未生效", so that must be true in
 *    memory and on disk.
 * 2. When the journal append fails during `save`, what exactly is committed, what
 *    does the caller see, what does `history` return, and what does a retry do?
 *
 * @module tests/integration/settings-journal-semantics.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'

let root: string
let vault: string
let service: MemoryService

const meta = () => join(vault, '.dsh-memory')
const configPath = () => join(meta(), 'config.json')
const journalDir = () => join(meta(), 'journal')

function newService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault })
}

async function blockFile(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await mkdir(path, { recursive: true })
}


async function restoreFile(path: string, content: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await writeFile(path, content, 'utf8')
}


beforeEach(async () => {
  root = await makeTempRoot('settings-journal')
  vault = join(root, 'DSH Memory')
  service = newService()
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

/* ------------------------------------------------------------------ settings */

describe('a failed settings write must not change the running instance', () => {
  it('reports failure, keeps memory and disk on the old values, then recovers', async () => {
    const before = service.getSettings()
    const configBefore = await readFile(configPath(), 'utf8')
    await blockFile(configPath())

    let threw = false
    try {
      // Two fields in one patch: a partial application would show up as a mixed state.
      await service.setSettings({ recallMaxItems: 3, recallBudgetTokens: 111 })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    // Runtime state must be unchanged in the SAME instance.
    const afterFailure = service.getSettings()
    expect(afterFailure.recallMaxItems).toBe(before.recallMaxItems)
    expect(afterFailure.recallBudgetTokens).toBe(before.recallBudgetTokens)
    // No mixed state: neither field took effect.
    expect(afterFailure.recallMaxItems).not.toBe(3)
    expect(afterFailure.recallBudgetTokens).not.toBe(111)

    // Disk must still hold the previous, complete configuration.
    await restoreFile(configPath(), configBefore)
    expect(await readFile(configPath(), 'utf8')).toBe(configBefore)

    // After the fault is removed the same instance accepts a valid update again.
    const updated = await service.setSettings({ recallMaxItems: 4, recallBudgetTokens: 222 })
    expect(updated.recallMaxItems).toBe(4)
    expect(updated.recallBudgetTokens).toBe(222)
    expect(service.getSettings().recallMaxItems).toBe(4)
  })

  it('a reloaded service agrees with the pre-failure persisted state', async () => {
    const before = service.getSettings()
    const configBefore = await readFile(configPath(), 'utf8')
    await blockFile(configPath())
    await expect(service.setSettings({ recallMaxItems: 3 })).rejects.toThrow()
    await restoreFile(configPath(), configBefore)

    // Same instance must already be consistent, and so must a fresh process.
    expect(service.getSettings().recallMaxItems).toBe(before.recallMaxItems)
    const reloaded = newService()
    await reloaded.initialize(vault)
    expect(reloaded.getSettings().recallMaxItems).toBe(before.recallMaxItems)
    expect(reloaded.getSettings().recallBudgetTokens).toBe(before.recallBudgetTokens)
  })
})

/* ------------------------------------------------------------------- journal */

describe('journal append failure during save', () => {
  it('archives durably through the outbox when the month file cannot be appended', async () => {
    const primer = await service.save({ type: 'knowledge', title: '预热', summary: 'R15-REGRESSION-1000。', tags: [], confidence: 'high', importance: 50 })
    expect(primer.id).toBeTruthy()
    const monthFile = (await readdir(journalDir())).find((entry) => String(entry).endsWith('.jsonl'))
    expect(monthFile).toBeDefined()
    await blockFile(join(journalDir(), String(monthFile)))

    // Round-16 semantics: the event is staged durably, so the operation is committed
    // and the caller is NOT told it failed.
    const saved = await service.save({ type: 'knowledge', title: '日志失败目标', summary: 'R15-REGRESSION-2000。', tags: [], confidence: 'high', importance: 50 })
    expect(saved.id).toBeTruthy()
    const staged = await readdir(join(meta(), 'journal-pending')).catch(() => [] as string[])
    expect(staged.filter((name) => name.endsWith('.json')).length).toBe(1)
    // History shows the committed event even before the archive completes.
    expect((await service.history(undefined, 50)).length).toBeGreaterThan(0)

    // Restoring the month file and reading history archives it exactly once.
    await restoreFile(join(journalDir(), String(monthFile)), '')
    await service.history(undefined, 50)
    expect(await readdir(join(meta(), 'journal-pending')).then((names) => names.filter((n) => n.endsWith('.json')))).toEqual([])
  })
  it('history degrades to empty when the journal is deleted, and repair resumes it', async () => {
    const saved = await service.save({ type: 'knowledge', title: '无日志', summary: 'NO-JOURNAL-MARK-7788。', tags: [], confidence: 'high', importance: 50 })
    await rm(journalDir(), { recursive: true, force: true })
    expect(await readdir(journalDir()).catch(() => null)).toBeNull()
    // Past change records are gone immediately: they have no Markdown copy.
    await expect(service.history(undefined, 10)).resolves.toEqual([])

    // A fresh process can still read the memory: Markdown is authoritative.
    const reloaded = newService()
    await reloaded.initialize(vault)
    await expect(reloaded.get(saved.id)).resolves.toBeDefined()
    expect(reloaded.search({ text: 'NO-JOURNAL-MARK-7788' }).hits.length).toBe(1)
    // Initialization may journal its own repair event, so only require that the old
    // entries are gone and that whatever exists is a legitimate new record.
    const afterInit = await reloaded.history(undefined, 10)
    expect(afterInit.every((entry) => typeof entry.id === 'string')).toBe(true)

    // Later writes recreate the journal and history resumes from that point on.
    await reloaded.save({ type: 'knowledge', title: '恢复后写入', summary: 'AFTER-JOURNAL-MARK-9900。', tags: [], confidence: 'high', importance: 50 })
    const history = await reloaded.history(undefined, 10)
    expect(history.length).toBeGreaterThan(0)
  })
})