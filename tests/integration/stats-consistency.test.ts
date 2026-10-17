/**
 * `stats.outOfSync` semantics (round 8, task A).
 *
 * Contract under test: the field is **current state** — "inconsistencies between
 * the authoritative Markdown and the derived index that have been discovered and
 * not yet repaired" — not an event counter and not a per-call scan result.
 *
 * Consequences verified here:
 * - both `status()` and `overview()` report the same registry, so the page cannot
 *   disagree with the service;
 * - repeated detection (overview, injection, status) keeps one entry per record;
 * - a successful sync/rebuild removes exactly the ids it fixed;
 * - a flagged inconsistency is not cleared by operations that did not repair it.
 *
 * @module tests/integration/stats-consistency.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

const MARK = 'STATS-MARK-6612'
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

beforeEach(async () => {
  root = await makeTempRoot('stats-consistency')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

async function seed(): Promise<string> {
  const saved = await service.save({
    type: 'knowledge',
    title: '统计一致性',
    summary: `索引统计测试，标记 ${MARK}。`,
    tags: [],
    confidence: 'high',
    importance: 60,
  })
  return saved.id
}

async function statsOf(svc: MemoryService): Promise<number> {
  return (await svc.status()).vault?.stats.outOfSync ?? -1
}

/** Put the note's own frontmatter back to `active` while the index still says otherwise. */
async function editStatusInPlace(id: string, from: string, to: string): Promise<void> {
  const detail = await service.get(id)
  await new Promise((resolve) => setTimeout(resolve, 25))
  const text = await readFile(detail.absolutePath, 'utf8')
  await writeFile(detail.absolutePath, text.replace(`status: ${from}`, `status: ${to}`), 'utf8')
}

describe('an inconsistency is reported by every surface', () => {
  it('reports > 0 in status() and overview() after the index went stale', async () => {
    const id = await seed()
    expect(await statsOf(service)).toBe(0)

    // Index says archived, Markdown says active again.
    await service.setStatus(id, 'archived', '测试归档')
    await editStatusInPlace(id, 'archived', 'active')

    const overview = await service.overview()
    expect(overview.outOfSync.length).toBeGreaterThan(0)
    expect(overview.vault.stats.outOfSync).toBeGreaterThan(0)
    // The page header uses status(): it must agree with overview(), not report 0.
    expect(await statsOf(service)).toBe(await Promise.resolve(overview.vault.stats.outOfSync))
  })

  it('also reports an inconsistency discovered by the injection check alone', async () => {
    const id = await seed()
    // Markdown becomes archived while the index still believes it is active.
    await editStatusInPlace(id, 'active', 'archived')
    expect(await statsOf(service)).toBe(0)

    const injected = await service.recallForInjection(MARK)
    expect(injected.includedIds).toEqual([]) // fail-closed
    // The injection check found it, so the registry must know about it.
    expect(await statsOf(service)).toBeGreaterThan(0)
  })

  it('keeps one entry when the same record is detected repeatedly', async () => {
    const id = await seed()
    await editStatusInPlace(id, 'active', 'archived')

    await service.overview()
    const first = await statsOf(service)
    await service.overview()
    await service.recallForInjection(MARK)
    await service.recallForInjection(MARK)
    await service.overview()
    expect(await statsOf(service)).toBe(first)
    expect(first).toBe(1)
  })
})

describe('repair reduces the count accurately', () => {
  it('reaches 0 after syncIndex and injection starts working again', async () => {
    const id = await seed()
    await editStatusInPlace(id, 'active', 'archived')
    await service.overview()
    expect(await statsOf(service)).toBe(1)
    expect((await service.recallForInjection(MARK)).includedIds).toEqual([])

    await service.syncIndex()
    expect(await statsOf(service)).toBe(0)
    // Archived is now the truth, so still no injection — but the disagreement is gone.
    expect((await service.recallForInjection(MARK)).includedIds).toEqual([])

    await service.setStatus(id, 'active', '恢复')
    expect((await service.recallForInjection(MARK)).includedIds).toContain(id)
    expect(await statsOf(service)).toBe(0)
  })

  it('reaches 0 after rebuildIndex when the Markdown wins', async () => {
    const id = await seed()
    await service.setStatus(id, 'archived', '测试归档')
    await editStatusInPlace(id, 'archived', 'active')
    await service.overview()
    expect(await statsOf(service)).toBeGreaterThan(0)

    await service.rebuildIndex()
    expect(await statsOf(service)).toBe(0)
    const restored = await service.get(id)
    expect(restored.memory.status).toBe('active')
    expect((await service.recallForInjection(MARK)).includedIds).toContain(id)
  })

  it('does not clear the flag on operations that did not repair anything', async () => {
    const id = await seed()
    await editStatusInPlace(id, 'active', 'archived')
    await service.overview()
    const flagged = await statsOf(service)
    expect(flagged).toBe(1)

    // Read-only and unrelated operations must not claim the vault is healthy.
    await service.search({ text: MARK })
    await service.recall(MARK)
    await service.overview()
    expect(await statsOf(service)).toBe(flagged)
  })

  it('reports a newly introduced inconsistency after an earlier one was repaired', async () => {
    const first = await seed()
    await editStatusInPlace(first, 'active', 'archived')
    await service.overview()
    expect(await statsOf(service)).toBe(1)
    await service.syncIndex()
    expect(await statsOf(service)).toBe(0)

    // A different record goes stale: the count must be about the new one only.
    const second = await service.save({
      type: 'knowledge',
      title: '第二条',
      summary: '第二条统计测试，标记 STATS-SECOND-7788。',
      tags: [],
      confidence: 'high',
      importance: 50,
    })
    await editStatusInPlace(second.id, 'active', 'archived')
    await service.overview()
    expect(await statsOf(service)).toBe(1)
    await service.syncIndex()
    expect(await statsOf(service)).toBe(0)
  })
})
