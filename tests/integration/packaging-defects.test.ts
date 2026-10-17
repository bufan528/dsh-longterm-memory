/**
 * Defects found by end-to-end packaging verification (round 3).
 *
 * Each test here failed against the code as shipped in round 2 and is kept as the
 * regression guard for its fix.
 *
 * @module tests/integration/packaging-defects.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { checkTargetUsable } from '../../src/host/core/discover.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

let root: string
let vault: string

function discoveryFor(path: string, vaults: string[] = [], current: string | null = null): VaultDiscovery {
  return {
    environment: 'desktop',
    filesystem: true,
    obsidian: { detected: vaults.length > 0, configPath: null, vaults },
    current,
    candidates: [path],
    needsChoice: false,
    rationale: 'test',
    warnings: [],
  }
}

beforeEach(async () => {
  root = await makeTempRoot('pkg-defects')
  vault = join(root, 'DSH Memory')
})

afterEach(async () => {
  await cleanup(root)
})

describe('D1: filesystem evidence of an Obsidian vault, not just obsidian.json', () => {
  it('refuses a target inside a directory that only has a .obsidian folder', async () => {
    // An Obsidian vault Obsidian itself never registered (opened by folder, or a
    // synced copy). The registry knows nothing about it; the filesystem does.
    const unregistered = join(root, 'Unregistered Vault')
    await mkdir(join(unregistered, '.obsidian'), { recursive: true })
    await writeFile(join(unregistered, 'my-note.md'), '# 我的笔记\n', 'utf8')
    const nested = join(unregistered, 'Memory')

    const result = await checkTargetUsable(nested)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/嵌套|Obsidian 仓库内/)
    await expect(readFile(join(nested, 'README.md'), 'utf8')).rejects.toThrow()
  })

  it('refuses the unregistered vault directory itself', async () => {
    const unregistered = join(root, 'Unregistered Vault')
    await mkdir(join(unregistered, '.obsidian'), { recursive: true })
    const result = await checkTargetUsable(unregistered)
    expect(result.ok).toBe(false)
  })

  it('still allows a sibling directory of an unregistered vault', async () => {
    const unregistered = join(root, 'notes', 'Unregistered Vault')
    await mkdir(join(unregistered, '.obsidian'), { recursive: true })
    await expect(checkTargetUsable(join(root, 'notes', 'DSH Memory'))).resolves.toEqual({ ok: true })
  })

  it('does not refuse a deep plain path that has no .obsidian ancestor', async () => {
    await expect(checkTargetUsable(join(root, 'deep', 'a', 'b', 'DSH Memory'))).resolves.toEqual({ ok: true })
  })
})

describe('D2: initialize() must record the vault it actually created', () => {
  it('does not write a stale vaultPath into the new vault marker', async () => {
    const stale = join(root, 'stale-elsewhere')
    const target = join(root, 'target-vault')
    // The service is told to use `stale`, but the caller initializes `target`.
    const service = new MemoryService({
      configuredVaultPath: stale,
      discoveryProvider: async () => discoveryFor(target),
    })

    await service.initialize(target)
    const config = JSON.parse(await readFile(join(target, '.dsh-memory', 'config.json'), 'utf8')) as {
      settings?: { vaultPath?: string }
    }
    expect(config.settings?.vaultPath).toBe(target)
    expect(service.getSettings().vaultPath).toBe(target)
  })

  it('keeps settings and the attached vault consistent after init', async () => {
    const target = join(root, 'consistent-vault')
    // The provider models a real discovery result: it reports the attached vault as
    // `current`, which is what `discoverVault` does from the configured path.
    const service = new MemoryService({ discoveryProvider: async () => discoveryFor(target, [], target) })
    const status = await service.initialize(target)
    expect(status.vault?.path).toBe(target)
    expect(service.getSettings().vaultPath).toBe(target)
    const discovery = await service.getDiscovery(true)
    expect(discovery.current).toBe(target)
  })
})

describe('D3: a brand-new vault is not reported as reused', () => {
  it('reports reused=false for a freshly created vault', async () => {
    const service = new MemoryService({ discoveryProvider: async () => discoveryFor(vault) })
    const status = await service.initialize(vault)
    expect(status.vault?.reused).toBe(false)
    expect(status.vault?.initialized).toBe(true)
  })

  it('reports reused=true when an existing vault is adopted', async () => {
    const first = new MemoryService({ discoveryProvider: async () => discoveryFor(vault) })
    await first.initialize(vault)

    const second = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
    const status = await second.initialize(vault)
    expect(status.vault?.reused).toBe(true)
  })

  it('reports reused=true when a boot attaches an existing vault', async () => {
    const first = new MemoryService({ discoveryProvider: async () => discoveryFor(vault) })
    await first.initialize(vault)

    const second = new MemoryService({
      discoveryProvider: async () => ({ ...discoveryFor(vault), current: vault }),
    })
    expect(await second.ensureReady()).toBe(true)
    const status = await second.status()
    expect(status.vault?.reused).toBe(true)
  })
})
