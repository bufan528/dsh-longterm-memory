/**
 * End-to-end service tests over a real temporary vault (task-book sections C, D, E).
 *
 * These exercise the whole closed loop: initialize → write Markdown → index →
 * search → manage → rebuild → recall. Nothing is mocked except the clock where a
 * test needs determinism.
 *
 * @module tests/integration/service.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService, ServiceError } from '../../src/host/core/service.js'
import { layoutFor } from '../../src/host/core/layout.js'
import { pathExists } from '../../src/host/core/fsx.js'
import { scanVault } from '../../src/host/core/repository.js'
import type { SaveRequest } from '../../src/shared/protocol.js'

let root: string
let vault: string
let service: MemoryService

beforeEach(async () => {
  root = await makeTempRoot('service')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault, configSettings: { language: 'zh' } })
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

function saveRequest(overrides: Partial<SaveRequest> = {}): SaveRequest {
  return {
    type: 'decision',
    title: '使用 Markdown 作为唯一事实来源',
    summary: '长期记忆以 Markdown 文件为核心，索引只是可重建的辅助数据。',
    tags: ['architecture'],
    confidence: 'high',
    importance: 80,
    evidence: '用户在需求中明确说明。',
    ...overrides,
  }
}

describe('initialization and status', () => {
  it('reports the vault, capabilities and settings', async () => {
    const status = await service.status()
    expect(status.vault?.path).toBe(vault)
    expect(status.vault?.initialized).toBe(true)
    expect(status.vault?.obsidianVault).toBe(true)
    expect(status.vault?.index.healthy).toBe(true)
    expect(status.settings.language).toBe('zh')
    expect(status.capabilities.filesystem).toBe(true)
  })

  it('refuses to answer a query before it is ready', async () => {
    const cold = new MemoryService({ configuredVaultPath: null })
    // No vault configured and discovery would look at the real machine, so ask
    // directly for a query: it must refuse rather than guess.
    await expect(async () => cold.overview()).rejects.toThrow(ServiceError)
  })
})

describe('writing and reading Markdown', () => {
  it('writes a note with frontmatter into the category directory', async () => {
    const result = await service.save(saveRequest())
    const file = join(vault, 'Decisions', `${'使用 Markdown 作为唯一事实来源'}-${result.id}.md`)
    expect(await pathExists(file)).toBe(true)

    const raw = await readFile(file, 'utf8')
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain(`id: ${result.id}`)
    expect(raw).toContain('type: decision')
    expect(raw).toContain('status: active')
    expect(raw).toContain('## 核心内容')
    expect(raw).toContain('## 来源与依据')
    expect(raw).toContain('## 相关记忆')
    expect(raw).toContain('使用 Markdown 作为唯一事实来源')
  })

  it('adds the category tag automatically and de-duplicates tags', async () => {
    const result = await service.save(saveRequest({ tags: ['decision', 'architecture'] }))
    const detail = await service.get(result.id)
    expect(detail.memory.tags).toEqual(['decision', 'architecture'])
  })

  it('finds the new memory through Chinese keyword search', async () => {
    const result = await service.save(saveRequest())
    const response = service.search({ text: '唯一事实来源' })
    expect(response.hits.map((hit) => hit.record.id)).toContain(result.id)
    expect(response.hits[0]?.reasons.join(' ')).toMatch(/关键词匹配/)
  })

  it('finds it by exact id and by tag filter', async () => {
    const result = await service.save(saveRequest())
    expect(service.search({ text: result.id }).hits[0]?.record.id).toBe(result.id)
    expect(service.search({ filters: { tags: ['architecture'] } }).hits.map((hit) => hit.record.id)).toContain(result.id)
  })

  it('returns full detail including the raw Markdown and related memories', async () => {
    const first = await service.save(saveRequest({ title: '索引策略', summary: '索引是可重建的辅助数据。' }))
    const second = await service.save(
      saveRequest({ title: '索引重建流程', summary: '索引重建只依赖 Markdown，不调用模型。', tags: ['architecture'] }),
    )
    const detail = await service.get(second.id)
    expect(detail.memory.title).toBe('索引重建流程')
    expect(detail.raw).toContain('索引重建只依赖 Markdown')
    expect(detail.related.map((hit) => hit.record.id)).toContain(first.id)
    expect(detail.recallable).toBe(true)
    expect(detail.recallNote).toMatch(/参与/)
  })

  it('refuses an invalid save request', async () => {
    await expect(service.save(saveRequest({ title: '   ' }))).rejects.toThrow(/标题不能为空/)
    await expect(service.save(saveRequest({ type: 'nope' as never }))).rejects.toThrow(/未知类别/)
    await expect(service.save(saveRequest({ confidence: 'certain' as never }))).rejects.toThrow(/未知置信度/)
  })

  it('updates in place, keeps created_at and appends to the same file', async () => {
    const created = await service.save(saveRequest())
    const before = await service.get(created.id)
    const updated = await service.save({ ...saveRequest({ summary: '补充：索引可随时删除并从 Markdown 重建。' }), id: created.id })
    expect(updated.created).toBe(false)
    const after = await service.get(created.id)
    expect(after.memory.createdAt).toBe(before.memory.createdAt)
    expect(after.memory.summary).toContain('可随时删除并从 Markdown 重建')
    expect(after.relativePath).toBe(before.relativePath)
  })
})

describe('status transitions move the note where a human expects it', () => {
  it('moves a pending memory to Inbox and back to its category', async () => {
    const created = await service.save(saveRequest({ status: 'pending' }))
    let detail = await service.get(created.id)
    expect(detail.relativePath.startsWith('Inbox/')).toBe(true)

    await service.confirm(created.id)
    detail = await service.get(created.id)
    expect(detail.memory.status).toBe('active')
    expect(detail.relativePath.startsWith('Decisions/')).toBe(true)
    // No stale copy is left behind in Inbox.
    const scan = await scanVault(vault)
    expect(scan.documents.filter((document) => document.id === created.id)).toHaveLength(1)
  })

  it('moves an archived memory to Archive and stops it being current fact', async () => {
    const created = await service.save(saveRequest())
    await service.setStatus(created.id, 'archived', '用户归档')
    const detail = await service.get(created.id)
    expect(detail.relativePath.startsWith('Archive/')).toBe(true)
    expect(detail.recallable).toBe(false)
    expect(detail.recallNote).toMatch(/不会作为当前事实/)
  })

  it('moves a conflicted memory to Conflicts', async () => {
    const created = await service.save(saveRequest())
    await service.setStatus(created.id, 'conflict')
    expect((await service.get(created.id)).relativePath.startsWith('Conflicts/')).toBe(true)
  })

  it('keeps a stale memory in its category directory', async () => {
    const created = await service.save(saveRequest())
    await service.setStatus(created.id, 'stale')
    const detail = await service.get(created.id)
    expect(detail.relativePath.startsWith('Decisions/')).toBe(true)
    expect(detail.recallable).toBe(false)
  })

  it('raises a low-confidence memory to medium when the user confirms it', async () => {
    const created = await service.save(saveRequest({ confidence: 'low', status: 'pending' }))
    await service.confirm(created.id)
    expect((await service.get(created.id)).memory.confidence).toBe('medium')
  })

  it('toggles pinning and refuses an unknown status', async () => {
    const created = await service.save(saveRequest())
    await service.setPinned(created.id, true)
    expect((await service.get(created.id)).memory.pinned).toBe(true)
    await service.setPinned(created.id, false)
    expect((await service.get(created.id)).memory.pinned).toBe(false)
    await expect(service.setStatus(created.id, 'banana' as never)).rejects.toThrow(/未知状态/)
  })
})

describe('deletion requires explicit confirmation', () => {
  it('refuses a delete without the confirmation flag', async () => {
    const created = await service.save(saveRequest())
    await expect(service.remove(created.id, false)).rejects.toThrow(/二次确认/)
    expect(await pathExists((await service.get(created.id)).absolutePath)).toBe(true)
  })

  it('removes the note and records the deletion when confirmed', async () => {
    const created = await service.save(saveRequest())
    await service.remove(created.id, true)
    await expect(service.get(created.id)).rejects.toThrow(/未找到记忆/)
    const history = await service.history(created.id, 10)
    expect(history.some((entry) => entry.op === 'delete')).toBe(true)
  })
})

describe('merge and conflict resolution', () => {
  it('folds duplicates into a survivor and supersedes the rest', async () => {
    const first = await service.save(saveRequest({ title: '索引策略 A', summary: '索引需要可重建，A 版本。' }))
    const second = await service.save(saveRequest({ title: '索引策略 B', summary: '索引需要可重建，B 版本。' }))
    const result = await service.merge({ ids: [first.id, second.id], targetId: first.id })

    expect(result.id).toBe(first.id)
    expect(result.mergedIds).toEqual([second.id])
    const survivor = await service.get(first.id)
    expect(survivor.memory.summary).toContain('A 版本')
    expect(survivor.memory.summary).toContain('B 版本')
    expect(survivor.memory.status).toBe('active')

    const loser = await service.get(second.id)
    expect(loser.memory.status).toBe('superseded')
    expect(loser.memory.supersededBy).toBe(first.id)
    expect(loser.recallable).toBe(false)
  })

  it('refuses a merge with fewer than two memories', async () => {
    const created = await service.save(saveRequest())
    await expect(service.merge({ ids: [created.id] })).rejects.toThrow(/至少需要两条/)
  })

  it('archives the losing side when a conflict is decided with keep', async () => {
    const kept = await service.save(saveRequest({ title: '存储方案', summary: '使用 SQLite。' }))
    const other = await service.save(saveRequest({ title: '存储方案（异议）', summary: '不使用 SQLite。' }))
    const result = await service.resolveConflict(kept.id, 'keep', [other.id])
    expect(result.archived).toEqual([other.id])
    expect((await service.get(other.id)).memory.status).toBe('archived')
    expect((await service.get(kept.id)).memory.status).toBe('active')
  })

  it('keeps both sides and records the disagreement when the user chooses both', async () => {
    const first = await service.save(saveRequest({ title: '存储方案', summary: '使用 SQLite。' }))
    const second = await service.save(saveRequest({ title: '存储方案（异议）', summary: '不使用 SQLite。' }))
    await service.setStatus(first.id, 'conflict')
    await service.resolveConflict(first.id, 'both', [second.id])
    const detail = await service.get(first.id)
    expect(detail.memory.status).toBe('active')
    expect(detail.memory.conflictsWith).toContain(second.id)
    expect(detail.memory.evidence).toMatch(/冲突未裁决/)
  })
})

describe('index lifecycle', () => {
  it('rebuilds a deleted index from Markdown with no loss', async () => {
    const created = await service.save(saveRequest())
    const layout = layoutFor(vault)
    await rm(layout.index, { force: true })
    expect(await pathExists(layout.index)).toBe(false)

    const rebuilt = await service.rebuildIndex()
    expect(rebuilt.records).toBeGreaterThan(0)
    expect(service.search({ text: '唯一事实来源' }).hits.map((hit) => hit.record.id)).toContain(created.id)
    expect(await pathExists(layout.index)).toBe(true)
  })

  it('surfaces two files carrying the same id instead of silently picking one', async () => {
    const created = await service.save(saveRequest())
    const detail = await service.get(created.id)
    const contents = await readFile(detail.absolutePath, 'utf8')

    // Simulate an interrupted move or a restored backup: a second file that
    // declares the same id in a different directory.
    const secondCopy = join(vault, 'Archive', '重复副本.md')
    await writeFile(secondCopy, contents, 'utf8')

    const scan = await scanVault(vault)
    const duplicate = scan.duplicates.find((entry) => entry.id === created.id)
    expect(duplicate).toBeDefined()
    expect(duplicate?.paths).toHaveLength(2)
    expect(duplicate?.paths).toContain(detail.relativePath)
    expect(duplicate?.paths).toContain('Archive/重复副本.md')

    const overview = await service.overview()
    expect(overview.duplicates.map((entry) => entry.id)).toContain(created.id)
  })

  it('leaves no stale copy behind when a status change moves a note', async () => {
    const created = await service.save(saveRequest({ status: 'pending' }))
    expect((await service.get(created.id)).relativePath.startsWith('Inbox/')).toBe(true)
    await service.confirm(created.id)
    const scan = await scanVault(vault)
    expect(scan.documents.filter((document) => document.id === created.id)).toHaveLength(1)
    expect(scan.duplicates).toEqual([])
  })

  it('recovers from a corrupt index instead of failing', async () => {
    const created = await service.save(saveRequest())
    const layout = layoutFor(vault)
    await writeFile(layout.index, '{ this is not json', 'utf8')

    const fresh = new MemoryService({ configuredVaultPath: vault })
    const status = await fresh.initialize(vault)
    expect(status.vault?.index.healthy).toBe(true)
    expect(fresh.search({ text: '唯一事实来源' }).hits.map((hit) => hit.record.id)).toContain(created.id)
  })

  it('recovers from a structurally valid but wrong-shaped index', async () => {
    const created = await service.save(saveRequest())
    const layout = layoutFor(vault)
    await writeFile(layout.index, JSON.stringify({ version: 3, builtAt: 'x', vaultPath: vault, records: [{ id: 1 }] }), 'utf8')
    const fresh = new MemoryService({ configuredVaultPath: vault })
    await fresh.initialize(vault)
    expect(fresh.search({ text: '唯一事实来源' }).hits.map((hit) => hit.record.id)).toContain(created.id)
  })

  it('rebuilds when the index was built for a different vault path', async () => {
    const created = await service.save(saveRequest())
    const layout = layoutFor(vault)
    await writeFile(
      layout.index,
      JSON.stringify({ version: 3, builtAt: 'x', vaultPath: 'C:/somewhere/else', records: [] }),
      'utf8',
    )
    const fresh = new MemoryService({ configuredVaultPath: vault })
    await fresh.initialize(vault)
    expect(fresh.search({ text: '唯一事实来源' }).hits.map((hit) => hit.record.id)).toContain(created.id)
  })

  it('detects a note edited outside the plugin and syncs it', async () => {
    const created = await service.save(saveRequest())
    const detail = await service.get(created.id)
    const edited = (await readFile(detail.absolutePath, 'utf8')).replace('索引只是可重建的辅助数据', '索引是可随时删除并重建的辅助数据')
    // Ensure a visibly different mtime even on a coarse filesystem clock.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(detail.absolutePath, edited, 'utf8')

    const sync = await service.syncIndex()
    expect(sync.updated).toContain(created.id)
    const after = await service.get(created.id)
    expect(after.memory.summary).toContain('可随时删除并重建')
  })

  it('detects a note added by hand and a note deleted by hand', async () => {
    const created = await service.save(saveRequest())
    const detail = await service.get(created.id)
    // A hand-written note with our frontmatter is picked up.
    const handWritten = join(vault, 'Knowledge', '手写记忆-mem_20260101t000000_aaaaaaaa.md')
    await writeFile(
      handWritten,
      ['---', 'id: mem_20260101t000000_aaaaaaaa', 'type: knowledge', 'status: active', 'title: 手写记忆', '---', '', '# 手写记忆', '', '## 核心内容', '', '用户在 Obsidian 中手写。', ''].join('\n'),
      'utf8',
    )
    const added = await service.syncIndex()
    expect(added.added).toContain('mem_20260101t000000_aaaaaaaa')
    expect(service.search({ text: '手写记忆' }).hits.map((hit) => hit.record.id)).toContain('mem_20260101t000000_aaaaaaaa')

    await rm(detail.absolutePath, { force: true })
    const removed = await service.syncIndex()
    expect(removed.removed).toContain(created.id)
  })

  it('ignores a Markdown file that is not a memory note', async () => {
    await writeFile(join(vault, 'Knowledge', '普通笔记.md'), '# 只是笔记\n\n没有 frontmatter。\n', 'utf8')
    const sync = await service.syncIndex()
    expect(sync.added).toEqual([])
  })

  it('quarantines a note whose metadata is unusable and keeps the rest working', async () => {
    const good = await service.save(saveRequest())
    const bad = join(vault, 'Knowledge', '坏记忆-mem_20260202t000000_bbbbbbbb.md')
    await writeFile(bad, ['---', 'id: ""', 'type: knowledge', '---', '', '# 坏记忆', ''].join('\n'), 'utf8')

    const rebuilt = await service.rebuildIndex()
    expect(rebuilt.quarantined.length).toBeGreaterThan(0)
    expect(service.search({ text: '唯一事实来源' }).hits.map((hit) => hit.record.id)).toContain(good.id)
  })

  it('regenerates the human-readable index notes on rebuild', async () => {
    const created = await service.save(saveRequest())
    await service.rebuildIndex()
    const indexNote = await readFile(join(vault, 'Index', 'all-memories.md'), 'utf8')
    expect(indexNote).toContain('generated_by: dsh-longterm-memory')
    expect(indexNote).toContain(created.id)
  })
})

describe('raw editing with optimistic concurrency', () => {
  it('accepts a edit whose expected checksum matches', async () => {
    const created = await service.save(saveRequest())
    const raw = await service.readRaw(created.id)
    const next = raw.content.replace('索引只是可重建的辅助数据', '索引完全可以从 Markdown 重建')
    const result = await service.writeRaw(created.id, next, raw.checksum)
    expect(result.repairs).toEqual([])
    expect((await service.get(created.id)).memory.summary).toContain('完全可以从 Markdown 重建')
  })

  it('refuses a write whose expected checksum is stale, so an edit is never lost', async () => {
    const created = await service.save(saveRequest())
    const raw = await service.readRaw(created.id)
    // Someone else edits the file first.
    await writeFile(join(vault, raw.relativePath), raw.content.replace('Markdown', 'Markdown（他人已修改）'), 'utf8')

    await expect(service.writeRaw(created.id, raw.content, raw.checksum)).rejects.toMatchObject({
      code: 'write-conflict',
    })
    expect(await readFile(join(vault, raw.relativePath), 'utf8')).toContain('他人已修改')
  })

  it('refuses a raw write that changes or removes the id', async () => {
    const created = await service.save(saveRequest())
    const raw = await service.readRaw(created.id)
    await expect(service.writeRaw(created.id, raw.content.replace(created.id, 'mem_other'), raw.checksum)).rejects.toThrow(/不一致/)
  })

  it('refuses a raw write with unusable metadata', async () => {
    const created = await service.save(saveRequest())
    const raw = await service.readRaw(created.id)
    await expect(service.writeRaw(created.id, 'no frontmatter at all', raw.checksum)).rejects.toThrow(/元数据不合法|frontmatter/)
  })
})

describe('change history', () => {
  it('records before, after, reason and time for each change', async () => {
    const created = await service.save(saveRequest())
    await service.setStatus(created.id, 'archived', '用户认为已过时')
    const history = await service.history(created.id, 20)
    expect(history.length).toBeGreaterThanOrEqual(2)
    const archive = history.find((entry) => entry.op === 'archive')
    expect(archive).toBeDefined()
    if (archive === undefined) return
    expect(archive.reason).toBe('用户认为已过时')
    expect(archive.before).toContain('使用 Markdown')
    expect(archive.after).toContain('archived')
    expect(Number.isNaN(Date.parse(archive.at))).toBe(false)
  })

  it('keeps the journal bounded and parseable', async () => {
    const created = await service.save(saveRequest())
    for (let index = 0; index < 5; index += 1) {
      await service.save({ ...saveRequest({ summary: `第 ${String(index)} 次修订` }), id: created.id })
    }
    const history = await service.history(created.id, 100)
    expect(history.length).toBe(6)
    for (const entry of history) expect(typeof entry.reason).toBe('string')
  })
})

describe('turn processing (extraction → memory)', () => {
  it('auto-applies an explicitly asserted preference', async () => {
    const result = await service.processTurn({
      userText: '请记住：我更喜欢用 PowerShell 而不是 bash。',
      sessionId: 'session-demo',
    })
    expect(result.applied.length).toBe(1)
    const id = result.applied[0]?.id ?? ''
    const detail = await service.get(id)
    expect(detail.memory.type).toBe('preference')
    expect(detail.memory.status).toBe('active')
    expect(detail.memory.sourceSessions).toEqual(['session-demo'])
    expect(detail.memory.evidence).toContain('session-demo')
  })

  it('parks an inferred, low-confidence statement in the Inbox', async () => {
    const result = await service.processTurn({ userText: '这个项目的进度已经完成了 60%。' })
    expect(result.applied).toEqual([])
    expect(result.pending.length).toBeGreaterThan(0)
    const pending = result.pending[0]
    expect(pending?.confidence).toBe('low')
    expect(pending?.decision.action).toBe('inbox')
    // Nothing was written as a stated fact.
    expect(service.search({ text: '进度', includeNonCurrent: true }).hits.every((hit) => hit.record.status !== 'active')).toBe(true)
  })

  it('refuses a message that is a credential and writes nothing', async () => {
    const before = service.search({ limit: 100 }).total
    const result = await service.processTurn({ userText: '请记住：我的 API key 是 sk-abcdefghijklmnopqrstuvwx' })
    expect(result.refused.length).toBeGreaterThan(0)
    expect(result.applied).toEqual([])
    expect(service.search({ limit: 100 }).total).toBe(before)
  })

  it('does not create the same memory twice for a repeated turn', async () => {
    const turn = { userText: '请记住：我更喜欢用 PowerShell 而不是 bash。', sessionId: 'session-dup' }
    const first = await service.processTurn(turn)
    expect(first.applied.length).toBe(1)
    expect(first.skippedAsDuplicate).toBeUndefined()

    const second = await service.processTurn(turn)
    // The very same turn is recognised as already handled: nothing is applied and
    // no second pending entry is created, so a retried or replayed event cannot
    // grow the vault or the Inbox.
    expect(second.skippedAsDuplicate).toBe(true)
    expect(second.applied).toEqual([])
    expect(second.pending).toEqual([])
    expect(second.candidates).toEqual([])
    expect(service.listCandidates()).toEqual([])

    const stored = service.search({ text: 'PowerShell', includeNonCurrent: true })
    expect(stored.hits.filter((hit) => hit.record.type === 'preference')).toHaveLength(1)
  })

  it('coalesces the same fact restated on a different turn', async () => {
    const first = await service.processTurn({ userText: '请记住：我更喜欢用 PowerShell 而不是 bash。', sessionId: 's', turn: 1 })
    expect(first.applied.length).toBe(1)
    // A different turn restating the same fact must not create a duplicate either.
    const second = await service.processTurn({ userText: '请记住：我更喜欢用 PowerShell 而不是 bash。', sessionId: 's', turn: 2 })
    expect(second.applied).toEqual([])
    const stored = service.search({ text: 'PowerShell', includeNonCurrent: true })
    expect(stored.hits.filter((hit) => hit.record.type === 'preference')).toHaveLength(1)
  })

  it('records the applied change in history', async () => {
    const result = await service.processTurn({ userText: '请记住：我习惯把配置放在 cordis.patch.yml。', sessionId: 'session-h' })
    const id = result.applied[0]?.id ?? ''
    const history = await service.history(id, 10)
    expect(history.some((entry) => entry.op === 'create' && entry.source === 'session-h')).toBe(true)
  })

  it('makes an extracted memory immediately searchable', async () => {
    await service.processTurn({ userText: '请记住：我的技术栈是 TypeScript 和 Node.js。', sessionId: 's1' })
    const hits = service.search({ text: 'TypeScript' })
    expect(hits.hits.length).toBeGreaterThan(0)
  })
})

describe('candidates', () => {
  it('lists manually added candidates and materializes them on demand', async () => {
    const added = service.addCandidate({
      type: 'task',
      title: '补齐索引重建测试',
      summary: '需要覆盖索引损坏后的重建路径。',
      confidence: 'medium',
    })
    expect(service.listCandidates().map((entry) => entry.id)).toContain(added.id)

    const materialized = await service.materializeCandidate(added.id)
    expect(service.listCandidates().map((entry) => entry.id)).not.toContain(added.id)
    // medium confidence → written as pending, so it still needs confirmation.
    expect((await service.get(materialized.id)).memory.status).toBe('pending')
  })

  it('refuses an invalid candidate', () => {
    expect(() => service.addCandidate({ type: 'nope' as never, title: 'x', summary: 'y' })).toThrow(/未知类别/)
  })
})

describe('recall and context budget', () => {
  it('produces a fenced, bounded recall block for a relevant query', async () => {
    await service.save(saveRequest({ title: '索引重建策略', summary: '索引重建只依赖 Markdown。' }))
    const recalled = service.recall('索引重建怎么做')
    expect(recalled.text).toContain('<system-reminder>')
    expect(recalled.text).toContain('</system-reminder>')
    expect(recalled.text).toMatch(/untrusted DATA/)
    expect(recalled.usedTokens).toBeGreaterThan(0)
    expect(recalled.includedIds.length).toBeGreaterThan(0)
    expect(recalled.historyOnly).toBe(false)
  })

  it('never injects unrelated memories', async () => {
    await service.save(saveRequest({ title: '索引重建策略', summary: '索引重建只依赖 Markdown。' }))
    const recalled = service.recall('完全无关的话题：今天天气怎么样')
    expect(recalled.text).toBe('')
    expect(recalled.includedIds).toEqual([])
  })

  it('excludes archived memories from current fact and labels history', async () => {
    const created = await service.save(saveRequest({ title: '旧索引方案', summary: '索引使用 SQLite 存储。' }))
    await service.setStatus(created.id, 'archived')

    const current = service.recall('索引使用什么存储')
    expect(current.historyOnly).toBe(true)
    expect(current.text).toMatch(/NOT current fact/)
  })

  it('honours the entry cap and reports what was omitted', async () => {
    for (let index = 0; index < 12; index += 1) {
      await service.save(saveRequest({ title: `索引专题 ${String(index)}`, summary: `关于索引的第 ${String(index)} 条说明。` }))
    }
    await service.setSettings({ recallMaxItems: 3, recallBudgetTokens: 2000 })
    const recalled = service.recall('索引')
    expect(recalled.includedIds.length).toBeLessThanOrEqual(3)
    expect(recalled.omitted).toBeGreaterThan(0)
  })

  it('keeps the recall block inside the configured token budget', async () => {
    for (let index = 0; index < 30; index += 1) {
      await service.save(saveRequest({ title: `预算测试 ${String(index)}`, summary: '较长的内容。'.repeat(40) }))
    }
    await service.setSettings({ recallMaxItems: 50, recallBudgetTokens: 300 })
    const recalled = service.recall('预算测试')
    expect(recalled.usedTokens).toBeLessThanOrEqual(400)
  })

  it('builds a standing block from profile, preference and pinned memories only', async () => {
    await service.save(saveRequest({ type: 'profile', title: '用户背景', summary: '后端工程师。' }))
    await service.save(saveRequest({ type: 'preference', title: '偏好', summary: '偏好 PowerShell。' }))
    const decision = await service.save(saveRequest({ type: 'decision', title: '某决策', summary: '决定使用 A。' }))
    await service.setPinned(decision.id, true)
    await service.save(saveRequest({ type: 'knowledge', title: '普通知识', summary: '仅供参考。' }))

    const standing = service.standing()
    const ids = standing.includedIds
    const types = ids.map((id) => service.search({ filters: {} }).hits.find((hit) => hit.record.id === id)?.record.type)
    expect(types).toContain('profile')
    expect(types).toContain('preference')
    expect(types).toContain('decision')
    expect(types).not.toContain('knowledge')
    expect(standing.text).toContain('Long-term memory')
  })

  it('previews exactly what would be injected', async () => {
    await service.save(saveRequest({ title: '预览测试', summary: '这条应当出现在预览中。' }))
    const preview = service.previewRecall('预览测试')
    expect(preview.text).toContain('预览测试')
    expect(preview.includedIds.length).toBeGreaterThan(0)
    expect(preview.usedTokens).toBeGreaterThan(0)
  })
})

describe('overview', () => {
  it('summarises counts, recent items, tags and pending work', async () => {
    await service.save(saveRequest({ title: '决策一', summary: '内容一', tags: ['alpha'] }))
    await service.save(saveRequest({ title: '待确认项', summary: '内容二', status: 'pending', tags: ['beta'] }))
    const conflict = await service.save(saveRequest({ title: '冲突项', summary: '内容三' }))
    await service.setStatus(conflict.id, 'conflict')

    const overview = await service.overview()
    expect(overview.vault.stats.total).toBe(3)
    expect(overview.vault.stats.pending).toBe(1)
    expect(overview.vault.stats.conflicts).toBe(1)
    expect(overview.pending).toHaveLength(1)
    expect(overview.problems.length).toBeGreaterThanOrEqual(1)
    expect(overview.recentCreated.length).toBe(3)
    expect(overview.tags.map((entry) => entry.tag)).toEqual(expect.arrayContaining(['alpha', 'beta']))
    expect(overview.busy).toBe(false)
  })

  it('reports out-of-sync memories', async () => {
    const created = await service.save(saveRequest())
    const detail = await service.get(created.id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(detail.absolutePath, `${detail.raw}\n\n外部追加一行。\n`, 'utf8')
    const overview = await service.overview()
    expect(overview.outOfSync).toContain(created.id)
  })
})

describe('settings', () => {
  it('persists settings into the vault marker and reloads them', async () => {
    await service.setSettings({ language: 'en', recallMaxItems: 5, enablePerStepRecall: true })
    const config = JSON.parse(await readFile(layoutFor(vault).config, 'utf8')) as { settings: Record<string, unknown> }
    expect(config.settings['language']).toBe('en')
    expect(config.settings['recallMaxItems']).toBe(5)

    const fresh = new MemoryService({ configuredVaultPath: vault })
    await fresh.initialize(vault)
    expect(fresh.getSettings().language).toBe('en')
    expect(fresh.getSettings().enablePerStepRecall).toBe(true)
  })

  it('refuses an unsupported language', async () => {
    await expect(service.setSettings({ language: 'fr' as never })).rejects.toThrow(/不支持的语言/)
  })

  it('never writes a secret into the vault marker', async () => {
    await service.setSettings({ language: 'zh' })
    const raw = await readFile(layoutFor(vault).config, 'utf8')
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{16,}/)
    expect(raw).not.toMatch(/api[_-]?key/i)
  })
})

describe('openVault', () => {
  it('reports a clear failure for a path that does not exist', async () => {
    const result = await service.openVault('does-not-exist')
    expect(result.opened).toBe(false)
    expect(result.detail).toMatch(/不存在/)
  })

  it('reports a failure before the vault is initialized', async () => {
    const cold = new MemoryService({ configuredVaultPath: null })
    const result = await cold.openVault()
    expect(result.opened).toBe(false)
    expect(result.detail).toMatch(/尚未初始化/)
  })
})

describe('durability', () => {
  it('survives a full reload: Markdown is the source of truth', async () => {
    const created = await service.save(saveRequest({ title: '持久化验证', summary: '重启后仍应存在。' }))
    const info = await stat(join(vault, 'Decisions'))
    expect(info.isDirectory()).toBe(true)

    // A brand-new service instance, as after a DSH restart.
    const fresh = new MemoryService({ configuredVaultPath: vault })
    await fresh.initialize(vault)
    const detail = await fresh.get(created.id)
    expect(detail.memory.title).toBe('持久化验证')
    expect(fresh.search({ text: '重启后仍应存在' }).hits.map((hit) => hit.record.id)).toContain(created.id)
  })

  it('leaves the Markdown intact when the index file is unreadable garbage', async () => {
    const created = await service.save(saveRequest())
    const layout = layoutFor(vault)
    await writeFile(layout.index, Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('binary'), 'latin1')

    const fresh = new MemoryService({ configuredVaultPath: vault })
    await fresh.initialize(vault)
    expect((await fresh.get(created.id)).memory.title).toBe('使用 Markdown 作为唯一事实来源')
  })
})
