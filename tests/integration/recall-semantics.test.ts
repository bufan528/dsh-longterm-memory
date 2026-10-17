/**
 * Recall semantics: explicit search vs automatic injection (round 6, R1).
 *
 * Two different questions share one index:
 *
 * - **explicit search** (a tool call, a person looking something up) may surface a
 *   retired memory when nothing current matches, as long as it is clearly labelled
 *   as history;
 * - **automatic injection** (per-step recall) must never do that: a retired memory
 *   must not be spliced into the model's input as if it were current fact.
 *
 * The two modes share one status decision in `service.recall()`; these tests pin
 * both directions so a future change cannot silently collapse them again.
 *
 * @module tests/integration/recall-semantics.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { renderMemory } from '../../src/shared/markdown.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

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
  root = await makeTempRoot('recall-semantics')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

async function saveRetired(): Promise<string> {
  const saved = await service.save({
    type: 'knowledge',
    title: '旧索引方案',
    summary: '索引使用 SQLite 存储，唯一标记 RECALL-MARK-7731。',
    tags: ['索引'],
    confidence: 'high',
    importance: 60,
  })
  await service.setStatus(saved.id, 'archived', '测试归档')
  return saved.id
}

describe('explicit search may surface history', () => {
  it('returns a retired memory when nothing active matches, labelled as history', async () => {
    const id = await saveRetired()
    const recalled = service.recall('索引使用什么存储')
    expect(recalled.historyOnly).toBe(true)
    expect(recalled.includedIds).toContain(id)
    expect(recalled.text).toMatch(/NOT current fact/)
  })

  it('prefers active memories over retired ones', async () => {
    await saveRetired()
    const fresh = await service.save({
      type: 'knowledge',
      title: '新索引方案',
      summary: '索引使用 Markdown 重建，唯一标记 ACTIVE-MARK-1188。',
      tags: ['索引'],
      confidence: 'high',
      importance: 70,
    })
    const recalled = service.recall('索引')
    expect(recalled.historyOnly).toBe(false)
    expect(recalled.includedIds).toContain(fresh.id)
    expect(recalled.text).toMatch(/ACTIVE-MARK-1188/)
  })
})

describe('automatic injection never carries retired memories', () => {
  it('returns nothing to inject when the only match is retired', async () => {
    await saveRetired()
    const injected = service.recall('索引使用什么存储', { mode: 'injection' })
    expect(injected.historyOnly).toBe(false)
    expect(injected.includedIds).toEqual([])
    expect(injected.text).toBe('')
    expect(injected.text).not.toMatch(/RECALL-MARK-7731/)
  })

  it('still injects an active memory', async () => {
    const fresh = await service.save({
      type: 'knowledge',
      title: '索引重建策略',
      summary: '索引可以从 Markdown 重建，唯一标记 ACTIVE-MARK-1188。',
      tags: ['索引'],
      confidence: 'high',
      importance: 80,
    })
    const injected = service.recall('索引重建', { mode: 'injection' })
    expect(injected.includedIds).toContain(fresh.id)
    expect(injected.text).toMatch(/ACTIVE-MARK-1188/)
  })

  it('previewRecall defaults to the injection semantics', async () => {
    await saveRetired()
    const preview = service.previewRecall('索引使用什么存储')
    expect(preview.includedIds).toEqual([])
    expect(preview.text).toBe('')
  })

  it('previewRecall can still be asked for the explicit view', async () => {
    const id = await saveRetired()
    const preview = service.previewRecall('索引使用什么存储', 5, { mode: 'explicit' })
    expect(preview.includedIds).toContain(id)
  })

  it('picks up a hand-edited archive on the next start, before the first turn', async () => {
    const id = await service.save({
      type: 'knowledge',
      title: '手工归档目标',
      summary: '这条记录会被手工归档，唯一标记 MANUAL-MARK-5542。',
      tags: [],
      confidence: 'high',
      importance: 50,
    }).then((saved) => saved.id)
    expect(service.recall('MANUAL-MARK-5542', { mode: 'injection' }).includedIds).toContain(id)

    // The user edits the file in Obsidian while DSH is closed.
    const detail = await service.get(id)
    const { readFile, writeFile } = await import('node:fs/promises')
    await new Promise((resolve) => setTimeout(resolve, 25))
    await writeFile(detail.absolutePath, (await readFile(detail.absolutePath, 'utf8')).replace('status: active', 'status: archived'), 'utf8')

    // A fresh service, as after a restart: startup reconciliation must make the
    // archived state effective immediately, not one restart later.
    const restarted = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
    await restarted.initialize(vault)
    // The very first query after startup must already see the archive.
    expect(restarted.recall('MANUAL-MARK-5542', { mode: 'injection' }).includedIds).toEqual([])

    // Restoring by hand is picked up the same way.
    const moved = await restarted.get(id)
    await new Promise((resolve) => setTimeout(resolve, 25))
    await writeFile(moved.absolutePath, (await readFile(moved.absolutePath, 'utf8')).replace('status: archived', 'status: active'), 'utf8')
    const again = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
    await again.initialize(vault)
    expect(again.recall('MANUAL-MARK-5542', { mode: 'injection' }).includedIds).toContain(id)
  })
})

describe('source-level rendering covers every owned field', () => {
  it('writes back every frontmatter key the canonical renderer owns', () => {
    const memory = {
      id: 'mem_1',
      type: 'knowledge' as const,
      status: 'superseded' as const,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
      title: '来源',
      tags: ['标签'],
      confidence: 'medium' as const,
      importance: 40,
      pinned: false,
      sourceSessions: ['session-1'],
      supersedes: [],
      supersededBy: 'mem_2',
      conflictsWith: ['mem_3'],
      aliases: ['别名'],
      evidence: '证据：冲突未裁决。',
      schemaVersion: 1,
      summary: '正文。',
      sections: [],
      related: [],
    }
    const source = ['---', 'id: mem_1', 'status: superseded', 'custom_key: keep-me', '---', '', '# 来源', '', '## 核心内容', '', '正文。', ''].join('\n')
    const rendered = renderMemory({ ...memory, preservedSource: source })
    // Field-by-field: any owned key omitted by the source-level updater shows up
    // here as a missing or stale value.
    expect(rendered).toContain('superseded_by: mem_2')
    expect(rendered).toContain('evidence: ')
    expect(rendered).toContain('冲突未裁决')
    expect(rendered).toContain('custom_key: keep-me')
    expect(rendered).toContain('conflicts_with:')
    expect(rendered).toContain('mem_3')
    expect(rendered).toContain('tags:')
  })
})
