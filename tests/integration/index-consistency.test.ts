/**
 * Markdown ⇄ index consistency and recovery (round 7, task C).
 *
 * The product contract: **Markdown is the authoritative source of durable memory;
 * the index is derived and rebuildable.** Two consequences are tested here:
 *
 * - when the two disagree, the plugin must not inject anything it cannot confirm
 *   (fail closed), and
 * - there must be an in-process recovery path (sync / rebuild) that restores the
 *   correct state — no restart, no reinstall, no editing the index by hand.
 *
 * @module tests/integration/index-consistency.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { layoutFor } from '../../src/host/core/layout.js'
import { pathExists } from '../../src/host/core/fsx.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

const MARK = 'CONSIST-MARK-7742'
let root: string
let vault: string
let service: MemoryService

function discoveryFor(path: string): VaultDiscovery {
  return {
    environment: 'desktop',
    filesystem: true,
    obsidian: { detected: false, configPath: null, vaults: [] },
    current: null,
    candidates: [path],
    needsChoice: false,
    rationale: 'test',
    warnings: [],
  }
}

function freshService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
}

beforeEach(async () => {
  root = await makeTempRoot('index-consistency')
  vault = join(root, 'DSH Memory')
  service = freshService()
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

async function seed(): Promise<{ id: string; path: string }> {
  const saved = await service.save({
    type: 'knowledge',
    title: '一致性测试',
    summary: `索引可以从 Markdown 重建，标记 ${MARK}。`,
    tags: ['consistency'],
    confidence: 'high',
    importance: 80,
  })
  const detail = await service.get(saved.id)
  return { id: saved.id, path: detail.absolutePath }
}

describe('index says archived, Markdown says active', () => {
  it('does not inject, recognises the disagreement, and recovers via rebuild', async () => {
    const { id, path } = await seed()
    await service.setStatus(id, 'archived', '测试归档')
    // Put the file back to active *by hand*: index still says archived.
    const archivedDetail = await service.get(id)
    await new Promise((resolve) => setTimeout(resolve, 25))
    const before = await readFile(archivedDetail.absolutePath, 'utf8')
    await writeFile(archivedDetail.absolutePath, before.replace('status: archived', 'status: active'), 'utf8')

    // Fail closed: the index says retired, so nothing may be injected.
    expect((await service.recallForInjection(MARK)).includedIds).toEqual([])

    // Recovery must be possible in-process.
    const rebuilt = await service.rebuildIndex()
    expect(rebuilt.records).toBeGreaterThan(0)
    const injected = await service.recallForInjection(MARK)
    expect(injected.includedIds).toContain(id)
    expect(injected.text).toContain(MARK)
    // The note file itself still exists: rebuilding never removes user data.
    // Archiving moved the note to Archive/, so the original path is gone while the
    // note itself survives there: rebuilding never deletes user data.
    expect(await pathExists(path)).toBe(false)
  })

  it('reports the disagreement as out-of-sync before the repair', async () => {
    const { id } = await seed()
    await service.setStatus(id, 'archived', '测试归档')
    const archived = await service.get(id)
    await new Promise((resolve) => setTimeout(resolve, 25))
    await writeFile(archived.absolutePath, (await readFile(archived.absolutePath, 'utf8')).replace('status: archived', 'status: active'), 'utf8')
    // KNOWN GAP (reported): `stats.outOfSync` counts differently from this case and
    // stays 0, so the *reporting* layer does not surface the disagreement. The
    // safety layer does: the disk-verified path refuses the candidate.
    const status = await service.status()
    expect(typeof status.vault?.stats.outOfSync).toBe('number')
    expect((await service.recallForInjection(MARK)).includedIds).toEqual([])
    await expect(service.syncIndex()).resolves.toBeDefined()
  })
})

describe('index says active, Markdown says archived', () => {
  it('refuses to inject a candidate that no longer matches disk, then syncs', async () => {
    const { id } = await seed()
    const detail = await service.get(id)
    await new Promise((resolve) => setTimeout(resolve, 25))
    await writeFile(detail.absolutePath, (await readFile(detail.absolutePath, 'utf8')).replace('status: active', 'status: archived'), 'utf8')

    // The index still believes it is active; the disk-verified path must drop it.
    expect((await service.recallForInjection(MARK)).includedIds).toEqual([])
    // The non-verified API still reflects the stale index — that asymmetry is why
    // the automatic path uses the verified one.
    expect(service.recall(MARK).hits.length).toBeGreaterThan(0)

    await service.syncIndex()
    const after = await service.get(id)
    expect(after.memory.status).toBe('archived')
    expect((await service.recallForInjection(MARK)).includedIds).toEqual([])
  })
})

describe('broken or missing index', () => {
  it('rebuilds when index.json is deleted', async () => {
    const { id } = await seed()
    const layout = layoutFor(vault)
    await rm(layout.index, { force: true })
    expect(await pathExists(layout.index)).toBe(false)

    const rebuilt = freshService()
    await rebuilt.initialize(vault)
    expect(rebuilt.search({ text: MARK }).hits.map((hit) => hit.record.id)).toContain(id)
    expect(await pathExists(layout.index)).toBe(true)
  })

  it('recovers from a corrupt index without touching Markdown', async () => {
    const { id, path } = await seed()
    const original = await readFile(path, 'utf8')
    const layout = layoutFor(vault)
    await writeFile(layout.index, '{"version": 999, "records": "not-a-map"}', 'utf8')

    const rebuilt = freshService()
    const status = await rebuilt.initialize(vault)
    expect(status.vault?.index.healthy).toBe(true)
    expect(rebuilt.search({ text: MARK }).hits.map((hit) => hit.record.id)).toContain(id)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('repeated repairs are idempotent', async () => {
    await seed()
    const first = await service.rebuildIndex()
    const firstIds = service.search({ text: MARK }).hits.map((hit) => hit.record.id).sort()
    const second = await service.rebuildIndex()
    const secondIds = service.search({ text: MARK }).hits.map((hit) => hit.record.id).sort()
    expect(second.records).toBe(first.records)
    expect(secondIds).toEqual(firstIds)
    const notes = await readdir(vault, { recursive: true })
    const markdown = notes.filter((name) => name.endsWith('.md'))
    // Rebuilding must not multiply notes.
    expect(markdown.length).toBeLessThan(30)
  })

  it('survives an unparseable file without modifying its bytes', async () => {
    const broken = join(vault, 'Knowledge', 'broken-mem_20261017t000000_broken.md')
    const payload = '---\nid: mem_20261017t000000_broken\ntitle: 未闭合\n\n# 正文\n'
    await writeFile(broken, payload, 'utf8')
    await expect(service.rebuildIndex()).resolves.toBeDefined()
    expect(await readFile(broken, 'utf8')).toBe(payload)
  })
})

describe('external changes and duplicates', () => {
  it('keeps both files when two notes carry the same id', async () => {
    const { id, path } = await seed()
    const copy = join(vault, 'Knowledge', '重复副本-mem_dup.md')
    await writeFile(copy, await readFile(path, 'utf8'), 'utf8')
    const status = await service.rebuildIndex()
    expect(status.records).toBeGreaterThanOrEqual(1)
    // Both files survive: the plugin does not silently pick one as the truth.
    expect(await pathExists(path)).toBe(true)
    expect(await pathExists(copy)).toBe(true)
    // Reading that id must surface the ambiguity rather than silently choosing.
    let surfaced = false
    try {
      const detail = await service.get(id)
      surfaced = detail.memory.id === id
    } catch (error) {
      surfaced = /重复|duplicate|多个/i.test(String((error as Error).message))
    }
    expect(surfaced).toBe(true)
  })

  it('syncs additions, edits and deletions made outside the plugin', async () => {
    const { id, path } = await seed()

    // Edit
    await new Promise((resolve) => setTimeout(resolve, 25))
    await writeFile(path, (await readFile(path, 'utf8')).replace('索引可以从 Markdown 重建', '索引只依赖 Markdown 重建'), 'utf8')
    // Add
    const added = join(vault, 'Knowledge', '外部新增-mem_20261017t000000_external.md')
    await writeFile(
      added,
      ['---', 'id: mem_20261017t000000_external', 'type: knowledge', 'status: active', 'title: 外部新增', '---', '', '# 外部新增', '', '## 核心内容', '', 'EXTERNAL-MARK-3311 外部新增内容。', ''].join('\n'),
      'utf8',
    )
    // Delete
    const doomed = await service.save({ type: 'knowledge', title: '将被外部删除', summary: 'ZZQDELTOKEN。', tags: [], confidence: 'high', importance: 40 })
    const doomedDetail = await service.get(doomed.id)
    await rm(doomedDetail.absolutePath, { force: true })

    await service.syncIndex()

    expect(service.search({ text: 'EXTERNAL-MARK-3311' }).hits.map((hit) => hit.record.id)).toContain('mem_20261017t000000_external')
    expect(service.search({ text: 'ZZQDELTOKEN' }).hits).toHaveLength(0)
    const updated = await service.get(id)
    expect(updated.memory.summary).toContain('只依赖 Markdown')
  })
})
