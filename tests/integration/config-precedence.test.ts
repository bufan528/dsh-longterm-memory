/**
 * Configuration precedence over discovery (round 9).
 *
 * An explicit `vaultPath` is an instruction from the user (or from the profile's
 * `cordis.patch.yml`). It must win over whatever discovery happens to find,
 * otherwise a vault that merely exists at the default location silently overrides
 * the configuration — and in a test process that default can be the real home
 * directory, which is how a unit test once created a vault in a user's Documents.
 *
 * @module tests/integration/config-precedence.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

let root: string

function discoveryWith(current: string | null, candidates: string[]): VaultDiscovery {
  return {
    environment: 'desktop',
    filesystem: true,
    obsidian: { detected: false, configPath: null, vaults: [] },
    current,
    candidates,
    needsChoice: false,
    rationale: 'test',
    warnings: [],
  }
}

/** Build a minimal real vault skeleton so `discoverVault`-style reuse is possible. */
async function makeVault(path: string): Promise<void> {
  await mkdir(join(path, '.dsh-memory'), { recursive: true })
  await writeFile(
    join(path, '.dsh-memory', 'config.json'),
    JSON.stringify({ product: 'dsh-longterm-memory', schemaVersion: 1, createdAt: new Date().toISOString(), settings: {} }),
    'utf8',
  )
}

beforeEach(async () => {
  root = await makeTempRoot('config-precedence')
})

afterEach(async () => {
  await cleanup(root)
})

describe('an explicit vaultPath is an instruction, not a suggestion', () => {
  it('uses the configured path even when discovery reports another existing vault', async () => {
    const configured = join(root, 'Configured Vault')
    const discovered = join(root, 'Discovered Vault')
    await makeVault(discovered)

    const service = new MemoryService({
      configuredVaultPath: configured,
      discoveryProvider: async () => discoveryWith(discovered, [discovered]),
    })

    expect(await service.ensureReady()).toBe(true)
    const status = await service.status()
    expect(status.vault?.path).toBe(configured)
    expect(status.vault?.path).not.toBe(discovered)
  })

  it('still adopts the discovered vault when nothing is configured', async () => {
    const discovered = join(root, 'Discovered Vault')
    await makeVault(discovered)

    const service = new MemoryService({
      discoveryProvider: async () => discoveryWith(discovered, [discovered]),
    })

    expect(await service.ensureReady()).toBe(true)
    expect((await service.status()).vault?.path).toBe(discovered)
  })
})
