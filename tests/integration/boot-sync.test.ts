/**
 * Boot-time freshness: Markdown edited while the plugin was not running must be
 * reflected on the next start.
 *
 * The index is derived data, and the most natural user action is editing a note in
 * Obsidian — including changing `status:` to archive it. If startup trusts the
 * persisted index without re-checking the files, that edit is invisible to recall
 * (and therefore to the system prompt) until someone clicks "同步索引".
 *
 * @module tests/integration/boot-sync.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

let root: string
let vault: string

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

function newService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
}

beforeEach(async () => {
  root = await makeTempRoot('boot-sync')
  vault = join(root, 'DSH Memory')
})

afterEach(async () => {
  await cleanup(root)
})

async function seedProfile(service: MemoryService, title: string, summary: string): Promise<string> {
  const saved = await service.save({
    type: 'profile',
    title,
    summary,
    tags: [],
    confidence: 'high',
    importance: 95,
    pinned: true,
  })
  return saved.id
}

describe('startup picks up Markdown edited while stopped', () => {
  it('reflects an archive performed by hand between runs', async () => {
    const first = newService()
    await first.initialize(vault)
    const id = await seedProfile(first, '手改归档测试', '这条记忆会在插件停止时被手工归档。')
    expect(first.standing().includedIds).toContain(id)

    // Simulate the user editing the note in Obsidian while DSH is closed.
    const detail = await first.get(id)
    const edited = (await readFile(detail.absolutePath, 'utf8')).replace('status: active', 'status: archived')
    await new Promise((resolve) => setTimeout(resolve, 25))
    await writeFile(detail.absolutePath, edited, 'utf8')

    // A brand-new service instance, as after a DSH restart.
    const second = newService()
    await second.initialize(vault)
    expect(second.standing().includedIds).not.toContain(id)
    expect(second.search({ filters: { statuses: ['active'] } }).hits.map((hit) => hit.record.id)).not.toContain(id)
  })

  it('reflects an edit to a note body between runs', async () => {
    const first = newService()
    await first.initialize(vault)
    const id = await seedProfile(first, '手改正文测试', '原始正文内容。')

    const detail = await first.get(id)
    await new Promise((resolve) => setTimeout(resolve, 25))
    await writeFile(detail.absolutePath, (await readFile(detail.absolutePath, 'utf8')).replace('原始正文内容。', '被手工改成的新正文。'), 'utf8')

    const second = newService()
    await second.initialize(vault)
    expect((await second.get(id)).memory.summary).toContain('被手工改成的新正文')
  })

  it('picks up a note added by hand between runs', async () => {
    const first = newService()
    await first.initialize(vault)
    const handWritten = join(vault, 'Knowledge', '手写新增-mem_20260101t000000_bootsync.md')
    await writeFile(
      handWritten,
      ['---', 'id: mem_20260101t000000_bootsync', 'type: knowledge', 'status: active', 'title: 手写新增', '---', '', '# 手写新增', '', '## 核心内容', '', '用户在关闭 DSH 期间手写的一条记忆。', ''].join('\n'),
      'utf8',
    )

    const second = newService()
    await second.initialize(vault)
    expect(second.search({ text: '手写新增' }).hits.map((hit) => hit.record.id)).toContain('mem_20260101t000000_bootsync')
  })

  it('picks up a note deleted by hand between runs', async () => {
    const first = newService()
    await first.initialize(vault)
    const id = await seedProfile(first, '手动删除测试', '这条会被手工删除。')
    const detail = await first.get(id)
    const { rm } = await import('node:fs/promises')
    await rm(detail.absolutePath, { force: true })

    const second = newService()
    await second.initialize(vault)
    await expect(second.get(id)).rejects.toThrow(/未找到记忆/)
  })

  it('does not lose a still-valid index when nothing changed', async () => {
    const first = newService()
    await first.initialize(vault)
    const id = await seedProfile(first, '无变化测试', '内容不变。')

    const second = newService()
    const status = await second.initialize(vault)
    expect(status.vault?.index.healthy).toBe(true)
    expect(second.standing().includedIds).toContain(id)
  })
})
