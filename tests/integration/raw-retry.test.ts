/** Regression for the broken write-conflict retry (found by UI acceptance). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

let root: string
let vault: string
let service: MemoryService

function discoveryFor(path: string): VaultDiscovery {
  return {
    environment: 'desktop', filesystem: true, obsidian: { detected: false, configPath: null, vaults: [] },
    current: null, candidates: [path], needsChoice: false, rationale: 'test', warnings: [],
  }
}

beforeEach(async () => {
  root = await makeTempRoot('raw-retry')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

describe('write-conflict retry path', () => {
  it('readRaw returns the on-disk checksum, so reload-then-write succeeds', async () => {
    const created = await service.save({
      type: 'knowledge', title: '重试测试', summary: '原始内容。', tags: [], confidence: 'high', importance: 50,
    })
    const first = await service.readRaw(created.id)

    const absolute = join(vault, first.relativePath)
    await new Promise((resolve) => setTimeout(resolve, 25))
    await writeFile(absolute, (await readFile(absolute, 'utf8')).replace('原始内容。', '外部改写后的内容。'), 'utf8')

    await expect(service.writeRaw(created.id, first.content, first.checksum)).rejects.toMatchObject({ code: 'write-conflict' })

    // The reload the error tells the user to do must hand back a checksum that
    // matches the file, so the retry succeeds.
    const reloaded = await service.readRaw(created.id)
    expect(reloaded.checksum).not.toBe(first.checksum)
    expect(reloaded.content).toContain('外部改写后的内容')
    // The retry now goes through: the reload hands back a usable fingerprint.
    await expect(service.writeRaw(created.id, reloaded.content, reloaded.checksum)).resolves.toBeDefined()

    // Round 24: the raw editor is now byte-faithful for the body. Text appended after
    // the last plugin-owned section used to be silently dropped; it must persist now.
    const appended = `${reloaded.content}\n\n尾部附加内容。\n`
    await service.writeRaw(created.id, appended, (await service.readRaw(created.id)).checksum)
    expect((await service.readRaw(created.id)).content).toContain('尾部附加内容')
  })
})