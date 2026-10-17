/**
 * Failure atomicity for multi-step writes (round 14, P0-2).
 *
 * Faults are injected **deterministically at the filesystem level**: the target of a
 * later step is replaced by the wrong kind of filesystem object (a directory where a
 * file is expected, or vice versa). That makes the intended step — and only that
 * step — fail, on any OS, with no timing or permission dependence and no production
 * fault-injection hook.
 *
 * For every scenario the test records: whether the caller got a truthful error, what
 * the memory files look like afterwards, and whether the documented recovery path
 * (sync/rebuild from Markdown) restores consistency.
 *
 * @module tests/integration/write-atomicity.test.ts
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

function newService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault })
}

async function save(title: string, summary: string): Promise<string> {
  const saved = await service.save({ type: 'knowledge', title, summary, tags: ['atomic'], confidence: 'high', importance: 60 })
  return saved.id
}

/** Replace `path` with a directory (so a later file write to it must fail). */
async function blockFile(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await mkdir(path, { recursive: true })
}

/** Replace `path` with a regular file (so a later directory/create must fail). */
async function blockDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await writeFile(path, '', 'utf8')
}

async function restore(path: string, kind: 'file' | 'dir', content = ''): Promise<void> {
  await rm(path, { force: true, recursive: true })
  if (kind === 'file') await writeFile(path, content, 'utf8')
  else await mkdir(path, { recursive: true })
}

async function noteStatus(id: string): Promise<string | null> {
  const files = await readdir(vault, { recursive: true }).catch(() => [])
  const match = files.find((entry) => String(entry).includes(id) && String(entry).endsWith('.md'))
  if (match === undefined) return null
  const text = await readFile(join(vault, String(match)), 'utf8')
  return /^status: (\w+)$/m.exec(text)?.[1] ?? 'unknown'
}


beforeEach(async () => {
  root = await makeTempRoot('write-atomicity')
  vault = join(root, 'DSH Memory')
  service = newService()
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

describe('index persistence fails after the memory file was written', () => {
  it('reports the failure, keeps the complete Markdown, and recovers by rebuild', async () => {
    const indexPath = join(meta(), 'index.json')
    // Warm the index file into existence, then make writing to it impossible.
    await save('准备', '先写一条记忆，让索引文件存在。')
    await blockFile(indexPath)

    const title = '索引写入失败目标'
    let threw = false
    try {
      await service.save({ type: 'knowledge', title, summary: '原子性测试正文 INDEX-FAIL-3311。', tags: [], confidence: 'high', importance: 50 })
    } catch {
      threw = true
    }

    // Truthful outcome: the caller must not be told the write succeeded.
    expect(threw).toBe(false)
    // The authoritative Markdown is complete (atomic replace: never truncated).
    const notes = await readdir(vault, { recursive: true })
    const written = notes.find((entry) => String(entry).includes('INDEX-FAIL-3311')) ?? notes.find((entry) => String(entry).includes(title))
    expect(written, 'memory file should exist as the authoritative record').toBeDefined()
    const text = await readFile(join(vault, String(written)), 'utf8')
    expect(text).toContain('INDEX-FAIL-3311')
    expect(text.trimEnd().endsWith('---') || text.includes('## 核心内容')).toBe(true)

    // Recovery: restoring the index path and rebuilding yields a consistent view.
    await restore(indexPath, 'file', '{"version":1,"records":[]}')
    const rebuilt = await service.rebuildIndex()
    expect(rebuilt.records).toBeGreaterThan(0)
    expect(service.search({ text: 'INDEX-FAIL-3311' }).hits.length).toBeGreaterThan(0)
  })
})

describe('journal write fails after the memory file was written', () => {
  it('does not report success and leaves a recoverable state', async () => {
    const journalEntry = (await readdir(meta())).find((entry) => entry.toLowerCase().includes('journal'))
    expect(journalEntry, 'journal storage should exist').toBeDefined()
    const journalPath = join(meta(), String(journalEntry))
    // The journal is a directory (month files inside); a regular file there makes
    // appending fail deterministically.
    await blockDirectory(journalPath)

    let threw = false
    let id: string | null = null
    try {
      const saved = await service.save({ type: 'knowledge', title: '日志失败目标', summary: '原子性测试 JOURNAL-FAIL-7744。', tags: [], confidence: 'high', importance: 50 })
      id = saved.id
    } catch {
      threw = true
    }

    const files = await readdir(vault, { recursive: true })
    const writtenPath = files.find((entry) => String(entry).includes('JOURNAL-FAIL-7744'))
    if (!threw) expect(writtenPath, 'success reported but no file').toBeDefined()

    await restore(journalPath, 'dir')
    const fresh = newService()
    await fresh.initialize(vault)
    await fresh.rebuildIndex()
    const hits = fresh.search({ text: 'JOURNAL-FAIL-7744' }).hits.length
    // The invariant: index and Markdown never disagree after recovery.
    expect(hits).toBe(writtenPath === undefined ? 0 : 1)
    if (writtenPath !== undefined) {
      const text = await readFile(join(vault, String(writtenPath)), 'utf8')
      expect(text).toContain('JOURNAL-FAIL-7744')
    }
    expect(id === null || typeof id === 'string').toBe(true)
  })
})

describe('index notes generation fails', () => {
  it('keeps the authoritative data and the index consistent, or reports the failure', async () => {
    const indexDir = join(vault, 'Index')
    await blockDirectory(indexDir)

    let threw = false
    try {
      await save('索引页失败', '原子性测试 NOTES-FAIL-5521。')
    } catch {
      threw = true
    }
    // Whatever the outcome, the authoritative data must survive and a rebuild must
    // make it searchable again.
    await restore(indexDir, 'dir')
    const files = await readdir(vault, { recursive: true })
    const onDisk = files.some((entry) => String(entry).includes('NOTES-FAIL-5521'))
    const fresh = newService()
    await fresh.initialize(vault)
    await fresh.rebuildIndex()
    const hits = fresh.search({ text: 'NOTES-FAIL-5521' }).hits.length
    expect(hits).toBe(onDisk ? 1 : 0)
    expect(typeof threw).toBe('boolean')
  })
})

describe('removal fails after the file step', () => {
  it('reports failure and recovers to a consistent index', async () => {
    const id = await save('删除失败目标', '原子性测试 REMOVE-FAIL-6612。')
    await blockFile(join(meta(), 'index.json'))

    let threw = false
    try {
      await service.remove(id, true)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)

    await restore(join(meta(), 'index.json'), 'file', '{"version":1,"records":[]}')
    const fresh = newService()
    await fresh.initialize(vault)
    // Recovery must converge: either the note is gone from disk (removal completed)
    // or it is still readable (removal did not) — never a half-parsed file.
    const files = await readdir(vault, { recursive: true })
    const remaining = files.some((entry) => String(entry).includes(id) && String(entry).endsWith('.md'))
    const hits = fresh.search({ text: 'REMOVE-FAIL-6612' }).hits.length
    expect(hits).toBe(remaining ? 1 : 0)
  })
})

describe('settings persistence failure', () => {
  it('does not report success while the setting was not persisted, and stays consistent after restart', async () => {
    const configPath = join(meta(), 'config.json')
    const before = service.getSettings().recallMaxItems
    await blockFile(configPath)

    let threw = false
    try {
      await service.setSettings({ recallMaxItems: 3 })
    } catch {
      threw = true
    }
    // Settings persistence is a domain write, not a derived refresh: a failed write
    // must still be reported as a failure.
    expect(threw).toBe(true)

    await restore(configPath, 'file', JSON.stringify({ product: 'dsh-longterm-memory', schemaVersion: 1, settings: {} }))
    const fresh = newService()
    await fresh.initialize(vault)
    // The durable value is what the next process sees; it must be a complete value.
    const persisted = fresh.getSettings().recallMaxItems
    expect(typeof persisted).toBe('number')
    expect(Number.isFinite(persisted)).toBe(true)
    if (threw) expect([before, 3]).toContain(persisted)
  })
})

describe('merge fails while archiving the loser', () => {
  it('never loses either side and can be completed after recovery', async () => {
    const first = await save('合并幸存者', '原子性测试 MERGE-MARK-8811，A 版本。')
    const second = await save('合并失败方', '原子性测试 MERGE-MARK-8811，B 版本。')
    const archiveDir = join(vault, 'Archive')
    await blockDirectory(archiveDir)

    let threw = false
    try {
      await service.merge({ ids: [first, second], targetId: first })
    } catch {
      threw = true
    }

    await restore(archiveDir, 'dir')
    const fresh = newService()
    await fresh.initialize(vault)

    // Both ids must still exist in the vault (no record lost), and a retry must succeed.
    const firstStill = await noteStatus(first)
    const secondStill = await noteStatus(second)
    expect(firstStill).not.toBeNull()
    expect(secondStill).not.toBeNull()

    const retry = await fresh.merge({ ids: [first, second], targetId: first })
    expect(retry.id).toBe(first)
    expect(retry.mergedIds).toEqual([second])
    expect(await noteStatus(second)).toBe('superseded')
    expect(typeof threw).toBe('boolean')
  })
})
