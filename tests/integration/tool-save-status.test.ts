/**
 * `memory_save` status contract (round 12, P0).
 *
 * The bug this pins down: the tool reported `pending` for low-confidence saves while
 * `service.save` was called without a status, so the note was persisted as `active`
 * and became injectable current fact. One status decision must drive persistence,
 * the index, injection eligibility and the tool response.
 *
 * @module tests/integration/tool-save-status.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { buildToolDefinitions } from '../../src/host/dsh/tools.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

let root: string
let vault: string
let service: MemoryService
let save: (args: unknown, exec: unknown) => Promise<{ id: string; status: string }>

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
  root = await makeTempRoot('tool-save-status')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
  await service.initialize(vault)
  const tool = buildToolDefinitions(service).find((definition) => definition.name === 'memory_save')
  if (tool === undefined) throw new Error('memory_save tool is not registered')
  save = tool.execute as unknown as (args: unknown, exec: unknown) => Promise<{ id: string; status: string }>
})

afterEach(async () => {
  await cleanup(root)
})

async function runSave(confidence: string | undefined): Promise<{ response: { id: string; status: string }; diskStatus: string; indexStatus: string; injectable: boolean }> {
  const marker = `SAVE-MARK-${confidence ?? 'none'}-7731`
  const response = await save(
    {
      title: `状态契约 ${confidence ?? 'none'}`,
      content: `这是一条用于状态契约验证的记忆 ${marker}。`,
      type: 'knowledge',
      ...(confidence === undefined ? {} : { confidence }),
    },
    {},
  )
  const detail = await service.get(response.id)
  const indexStatus = service.search({ filters: { statuses: ['pending', 'active'] } }).hits.find((hit) => hit.record.id === response.id)?.record.status ?? '<absent>'
  const injected = service.recall(marker, { mode: 'injection' }).includedIds.includes(response.id)
  return { response, diskStatus: detail.memory.status, indexStatus, injectable: injected }
}

describe('low confidence is persisted as pending, everywhere', () => {
  it('reports pending and writes pending to Markdown and the index', async () => {
    const result = await runSave('low')
    expect(result.response.status).toBe('pending')
    expect(result.diskStatus).toBe('pending')
    expect(result.indexStatus).toBe('pending')
    expect(result.injectable).toBe(false)
  })

  it('survives restart and index rebuild without being promoted', async () => {
    const result = await runSave('low')
    await service.rebuildIndex()
    expect((await service.get(result.response.id)).memory.status).toBe('pending')

    const restarted = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
    await restarted.initialize(vault)
    expect((await restarted.get(result.response.id)).memory.status).toBe('pending')
    expect(restarted.recall(`SAVE-MARK-low-7731`, { mode: 'injection' }).includedIds).toEqual([])
  })

  it('keeps pending out of the active-only view used by tool search and recall', async () => {
    const result = await runSave('low')
    // `service.search` without filters is deliberately status-agnostic (the UI needs
    // to show pending memories); the *current fact* views filter to active.
    const activeOnly = service.search({ text: 'SAVE-MARK-low-7731', filters: { statuses: ['active'] } })
    expect(activeOnly.hits.map((hit) => hit.record.id)).not.toContain(result.response.id)
    expect(service.recall('SAVE-MARK-low-7731', { mode: 'injection' }).includedIds).toEqual([])
  })
})

describe('medium and high confidence remain active', () => {
  it('persists medium as active and injectable', async () => {
    const result = await runSave('medium')
    expect(result.response.status).toBe('active')
    expect(result.diskStatus).toBe('active')
    expect(result.injectable).toBe(true)
  })

  it('persists high as active and injectable', async () => {
    const result = await runSave('high')
    expect(result.response.status).toBe('active')
    expect(result.diskStatus).toBe('active')
    expect(result.injectable).toBe(true)
  })

  it('defaults a missing confidence to medium (active)', async () => {
    const result = await runSave(undefined)
    expect(result.response.status).toBe('active')
    expect(result.diskStatus).toBe('active')
  })

  it('treats an unknown confidence value as medium instead of failing open to pending', async () => {
    const result = await runSave('definitely-not-a-level')
    expect(result.response.status).toBe('active')
    expect(result.diskStatus).toBe('active')
  })
})

describe('a pending memory can be confirmed by a later status change', () => {
  it('becomes injectable only after an explicit status change', async () => {
    const result = await runSave('low')
    expect(result.injectable).toBe(false)
    await service.setStatus(result.response.id, 'active', '用户确认')
    expect((await service.get(result.response.id)).memory.status).toBe('active')
    expect(service.recall('SAVE-MARK-low-7731', { mode: 'injection' }).includedIds).toContain(result.response.id)
  })
})
