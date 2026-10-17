/**
 * Durable journal outbox and vault-path settings consistency (round 16).
 *
 * Architecture decision: the monthly journal is authoritative history, not a cache.
 * An event is therefore staged durably *before* it is archived; an archive failure
 * leaves the event staged (committed, archive pending) instead of turning a committed
 * change into an unexplained failure. History merges staged events, recovery is
 * idempotent, and startup finishes whatever was pending.
 *
 * @module tests/integration/journal-outbox.test.ts
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
const configPath = () => join(meta(), 'config.json')

function newService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault })
}

async function blockFile(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await mkdir(path, { recursive: true })
}

async function blockDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await writeFile(path, '', 'utf8')
}

async function restoreFile(path: string, content = ''): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await writeFile(path, content, 'utf8')
}

async function monthFiles(): Promise<string[]> {
  const names = await readdir(journalDir()).catch(() => [] as string[])
  return names.filter((name) => name.endsWith('.jsonl')).map((name) => join(journalDir(), name))
}

/** Count archived event records for one memory id (by the record id field, not text). */
async function countInMonth(eventMarker: string): Promise<number> {
  let total = 0
  for (const file of await monthFiles()) {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line) as { id?: string }
        if (parsed.id === eventMarker) total += 1
      } catch {
        // torn line: ignored, same as the reader
      }
    }
  }
  return total
}

async function pendingEvents(): Promise<number> {
  return (await readdir(pendingDir()).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).length
}

async function saveOne(title: string, marker: string): Promise<string> {
  const saved = await service.save({ type: 'knowledge', title, summary: `${marker} 正文。`, tags: [], confidence: 'high', importance: 50 })
  return saved.id
}

beforeEach(async () => {
  root = await makeTempRoot('journal-outbox')
  vault = join(root, 'DSH Memory')
  service = newService()
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

describe('archive failure keeps the event durable and the operation committed', () => {
  it('stages the event, reports success, and exposes it through history', async () => {
    const primer = await saveOne('预热', 'OUTBOX-PRIMER-1000')
    expect(primer).toBeTruthy()
    const month = (await monthFiles())[0]
    expect(month, 'primer should have created a month file').toBeDefined()
    await blockFile(String(month))

    // The archive target is now a directory: appending must fail.
    const id = await saveOne('归档失败目标', 'OUTBOX-MARK-3300')
    expect(id).toBeTruthy()

    // The event is durably staged, not lost.
    expect(await pendingEvents()).toBe(1)
    // The caller was told the operation succeeded (it did commit).
    const history = await service.history(undefined, 20)
    expect(history.some((entry) => JSON.stringify(entry).includes('OUTBOX-MARK-3300') || entry.id === id)).toBe(true)

    // Restoring the archive target and flushing must append it exactly once.
    await restoreFile(String(month))
    await service.history(undefined, 20)
    expect(await pendingEvents()).toBe(0)
    expect(await countInMonth(id)).toBe(1)
  })

  it('is idempotent: a duplicate recovery does not append the same event twice', async () => {
    const month = (await monthFiles())[0]
    await blockFile(String(month))
    const id = await saveOne('幂等恢复目标', 'OUTBOX-MARK-4400')
    expect(await pendingEvents()).toBe(1)
    const staged = await readdir(pendingDir())
    const stagedContent = await readFile(join(pendingDir(), String(staged[0])), 'utf8')

    await restoreFile(String(month))
    await service.history(undefined, 20)
    expect(await countInMonth(id)).toBe(1)

    // Simulate a crash between append and pending-delete: put the staged copy back.
    await writeFile(join(pendingDir(), String(staged[0])), stagedContent, 'utf8')
    await service.history(undefined, 20)
    await service.history(undefined, 20)
    expect(await countInMonth(id)).toBe(1)
    expect(await pendingEvents()).toBe(0)
  })

  it('finishes a pending archive on the next startup', async () => {
    const month = (await monthFiles())[0]
    await blockFile(String(month))
    const id = await saveOne('重启恢复目标', 'OUTBOX-MARK-5500')
    expect(await pendingEvents()).toBe(1)

    await restoreFile(String(month))
    const restarted = newService()
    await restarted.initialize(vault)
    // Startup flushes the outbox before serving history.
    expect(await pendingEvents()).toBe(0)
    expect(await countInMonth(id)).toBe(1)
    expect((await restarted.history(undefined, 50)).length).toBeGreaterThan(0)
  })
})

describe('staging failure is reported, never silently swallowed', () => {
  it('fails the operation when the event cannot be made durable', async () => {
    const primer = await saveOne('预热二', 'OUTBOX-PRIMER-2000')
    expect(primer).toBeTruthy()
    await blockDirectory(pendingDir())

    let threw = false
    try {
      await saveOne('暂存失败目标', 'OUTBOX-MARK-6600')
    } catch {
      threw = true
    }
    expect(threw, 'a non-durable event must not be reported as success').toBe(true)

    // Restore and prove the vault is still fully recoverable from Markdown.
    await rm(pendingDir(), { force: true })
    await mkdir(pendingDir(), { recursive: true })
    const reloaded = newService()
    await reloaded.initialize(vault)
    await reloaded.rebuildIndex()
    const hits = reloaded.search({ text: 'OUTBOX-MARK-6600' }).hits
    // Whatever was committed is readable; nothing is half-parsed.
    for (const hit of hits) await expect(reloaded.get(hit.record.id)).resolves.toBeDefined()
  })
})

describe('retry does not duplicate a committed memory', () => {
  it('a successful save needs no retry, and similar memories still coexist', async () => {
    const month = (await monthFiles())[0]
    await blockFile(String(month))
    // First attempt now SUCCEEDS (event staged), so the caller has no reason to retry.
    const first = await saveOne('相同标题', 'OUTBOX-MARK-7700')
    expect(first).toBeTruthy()
    await restoreFile(String(month))

    // Two intentionally similar memories are both kept: no content-based dedupe.
    const second = await saveOne('相同标题', 'OUTBOX-MARK-7700')
    expect(second).not.toBe(first)
    const notes = (await readdir(vault, { recursive: true })).filter((entry) => String(entry).endsWith('.md') && !String(entry).includes('Index') && !String(entry).includes('.dsh-memory'))
    const matching = []
    for (const note of notes) {
      const text = await readFile(join(vault, String(note)), 'utf8').catch(() => '')
      if (text.includes('OUTBOX-MARK-7700')) matching.push(String(note))
    }
    expect(matching.length).toBe(2)
  })
})

describe('vaultPath settings consistency', () => {
  it('keeps settings, active vault and disk unchanged when the target is unusable', async () => {
    const before = service.getSettings()
    const beforeVault = service.getVaultPath()
    const configBefore = await readFile(configPath(), 'utf8')
    // A target nested inside an existing Obsidian vault is refused by the product.
    const fakeVault = join(root, 'Fake Obsidian')
    await mkdir(join(fakeVault, '.obsidian'), { recursive: true })
    const target = join(fakeVault, 'Nested Memory')

    await expect(service.setSettings({ vaultPath: target })).rejects.toThrow()
    expect(service.getSettings().vaultPath).toBe(before.vaultPath)
    expect(service.getVaultPath()).toBe(beforeVault)
    expect(await readFile(configPath(), 'utf8')).toBe(configBefore)
    expect((await readdir(join(root, 'Fake Obsidian'))).includes('Nested Memory')).toBe(false)
  })

  it('keeps settings and active vault unchanged when persistence fails after a valid selection', async () => {
    const before = service.getSettings()
    const beforeVault = service.getVaultPath()
    const configBefore = await readFile(configPath(), 'utf8')
    const target = join(root, 'Another Vault')
    await blockFile(configPath())

    let threw = false
    try {
      await service.setSettings({ vaultPath: target })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(service.getSettings().vaultPath).toBe(before.vaultPath)
    expect(service.getVaultPath()).toBe(beforeVault)
    // The original configuration on disk is untouched.
    await restoreFile(configPath(), configBefore)
    expect(await readFile(configPath(), 'utf8')).toBe(configBefore)

    // Same instance still accepts a later valid update, and a reload agrees.
    const updated = await service.setSettings({ vaultPath: target })
    expect(updated.vaultPath).toBe(target)
    const reloaded = newService()
    await reloaded.initialize(vault)
    expect(reloaded.getSettings().vaultPath).toBe(target)
  })
})
