/**
 * Session-history residue: what happens to a memory that was already injected
 * (round 7, task B).
 *
 * The facts this file pins down:
 *
 * 1. A recall block enters the conversation as an ordinary **user message** tagged
 *    `source.kind = 'longterm-memory'`, so it becomes part of durable session
 *    history and is replayed by the host on later requests.
 * 2. DSH exposes no API to edit or delete history, so an old block **cannot be
 *    withdrawn**. The plugin therefore appends a retraction notice naming the
 *    affected ids — it never claims the old copy is gone.
 * 3. New injections are still controlled: retired memories are never candidates,
 *    and an id is retracted at most once per session.
 *
 * @module tests/integration/recall-history.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { retiredAmongIds } from '../../src/host/dsh/inject.js'
import { renderRetiredNotice, statusLabel } from '../../src/shared/retraction.js'
import { FENCE_CLOSE, FENCE_OPEN } from '../../src/shared/recall.js'
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
  root = await makeTempRoot('recall-history')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

async function seed(title: string, summary: string): Promise<string> {
  const saved = await service.save({
    type: 'knowledge',
    title,
    summary,
    tags: [],
    confidence: 'high',
    importance: 60,
  })
  return saved.id
}

describe('retraction notices describe, never erase', () => {
  it('renders the fence, the ids and a Chinese status label', () => {
    const notice = renderRetiredNotice([
      { id: 'mem_a', status: 'archived' },
      { id: 'mem_b', status: 'superseded' },
      { id: 'mem_c', status: 'missing' },
    ])
    expect(notice.startsWith(FENCE_OPEN)).toBe(true)
    expect(notice.endsWith(FENCE_CLOSE)).toBe(true)
    expect(notice).toContain('mem_a')
    expect(notice).toContain('已归档')
    expect(notice).toContain('mem_b')
    expect(notice).toContain('已被替代')
    expect(notice).toContain('mem_c')
    expect(notice).toContain('文件已不存在')
    // The wording must be honest: it says the old content is no longer current,
    // never that it has been removed from history.
    expect(notice).toContain('已不是当前有效事实')
    expect(notice).toContain('以本通知为准')
    expect(notice).not.toMatch(/已删除历史|已清除/)
  })

  it('renders nothing for an empty set', () => {
    expect(renderRetiredNotice([])).toBe('')
  })

  it('labels every status the index can hold', () => {
    expect(statusLabel('active')).toBe('active')
    expect(statusLabel('conflict')).toBe('存在冲突待裁决')
    expect(statusLabel('stale')).toBe('已过时')
  })
})

describe('which previously injected ids are no longer current', () => {
  it('reports archived, superseded and missing ids, and not active ones', async () => {
    const active = await seed('仍然有效', '这条记忆保持 active。')
    const archived = await seed('将被归档', '这条记忆会被归档。')
    const superseded = await seed('将被替代', '这条记忆会被替代。')
    await service.setStatus(archived, 'archived', '测试归档')
    await service.setStatus(superseded, 'superseded', '测试替代')

    const retired = await retiredAmongIds(service, [active, archived, superseded, 'mem_does_not_exist'], new Set())
    const byId = new Map(retired.map((entry) => [entry.id, entry.status]))
    expect(byId.get(archived)).toBe('archived')
    expect(byId.get(superseded)).toBe('superseded')
    expect(byId.get('mem_does_not_exist')).toBe('missing')
    expect(byId.has(active)).toBe(false)
  })

  it('retracts an id at most once per session', async () => {
    const archived = await seed('只提示一次', '这条记忆会被归档。')
    await service.setStatus(archived, 'archived', '测试归档')
    const corrected = new Set<string>()

    const first = await retiredAmongIds(service, [archived], corrected)
    expect(first.map((entry) => entry.id)).toEqual([archived])
    for (const entry of first) corrected.add(entry.id)

    const second = await retiredAmongIds(service, [archived], corrected)
    expect(second).toEqual([])
  })

  it('does not resurrect a retired id as a fresh injection candidate', async () => {
    const archived = await seed('退役候选', '这条记忆会被归档，标记 RETIRED-MARK-9931。')
    await service.setStatus(archived, 'archived', '测试归档')
    // Even when the id is still in history, the automatic path may not re-offer it.
    const injection = service.recall('RETIRED-MARK-9931', { mode: 'injection' })
    expect(injection.includedIds).toEqual([])
    expect(injection.text).toBe('')
  })

  it('restores injectability once the memory is active again', async () => {
    const id = await seed('恢复候选', '这条记忆先归档再恢复，标记 RESTORE-MARK-2244。')
    await service.setStatus(id, 'archived', '测试归档')
    expect(service.recall('RESTORE-MARK-2244', { mode: 'injection' }).includedIds).toEqual([])

    const detail = await service.get(id)
    await service.setStatus(id, 'active', '测试恢复')
    const injection = service.recall('RESTORE-MARK-2244', { mode: 'injection' })
    expect(injection.includedIds).toContain(id)
    // The retired query now reports nothing for it.
    expect(await retiredAmongIds(service, [id], new Set())).toEqual([])
    expect(detail.memory.id).toBe(id)
  })
})

describe('the injected block is a point-in-time snapshot', () => {
  it('says the content is as-of-this-step and that later notices win', async () => {
    const id = await seed('快照语义', '索引可以从 Markdown 重建，标记 SNAPSHOT-MARK-5512。')
    const injection = service.recall('SNAPSHOT-MARK-5512', { mode: 'injection' })
    expect(injection.includedIds).toContain(id)
    expect(injection.text).toMatch(/as of this step/)
    expect(injection.text).toMatch(/later one wins/)
  })
})
