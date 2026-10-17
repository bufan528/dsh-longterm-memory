/**
 * Node-side integration tests for vault path safety at the service layer.
 *
 * `checkTargetUsable` is covered in `vault.test.ts`; this file proves the
 * **service** actually passes the discovered Obsidian vaults through to those
 * checks, which is the part that a unit test of the helper cannot establish.
 *
 * @module tests/integration/vault-safety.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService, ServiceError } from '../../src/host/core/service.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

let root: string
let userVault: string

beforeEach(async () => {
  root = await makeTempRoot('vault-safety')
  userVault = join(root, 'Obsidian Vault')
  await mkdir(join(userVault, '.obsidian'), { recursive: true })
  await writeFile(join(userVault, 'my-note.md'), '# 我自己的笔记\n', 'utf8')
})

afterEach(async () => {
  await cleanup(root)
})

/** A discovery whose Obsidian vault is the fake one above, with no current vault. */
function discoveryWith(vaults: string[], current: string | null = null): VaultDiscovery {
  return {
    environment: 'desktop',
    filesystem: true,
    obsidian: { detected: true, configPath: null, vaults },
    current,
    candidates: [join(root, 'DSH Memory')],
    needsChoice: false,
    rationale: 'test',
    warnings: [],
  }
}

describe('service refuses to nest a vault inside the user Obsidian vault', () => {
  it('refuses initialize() when the configured path is inside the Obsidian vault', async () => {
    const nested = join(userVault, 'DSH Memory')
    const service = new MemoryService({
      configuredVaultPath: nested,
      discoveryProvider: async () => discoveryWith([userVault]),
    })

    await expect(service.initialize(nested)).rejects.toThrow(ServiceError)
    await expect(service.initialize(nested)).rejects.toThrow(/嵌套|Obsidian 仓库内/)
    // Nothing was created inside the user's vault.
    await expect(readFile(join(nested, '.dsh-memory', 'config.json'), 'utf8')).rejects.toThrow()
    expect((await readFile(join(userVault, 'my-note.md'), 'utf8'))).toBe('# 我自己的笔记\n')
  })

  it('refuses initialize() when the target IS the Obsidian vault', async () => {
    const service = new MemoryService({ discoveryProvider: async () => discoveryWith([userVault]) })
    await expect(service.initialize(userVault)).rejects.toThrow(/Obsidian 仓库本身/)
    // The user's note survived untouched.
    expect((await readFile(join(userVault, 'my-note.md'), 'utf8'))).toBe('# 我自己的笔记\n')
  })

  it('refuses chooseVault() for a nested path', async () => {
    const service = new MemoryService({ discoveryProvider: async () => discoveryWith([userVault]) })
    await expect(service.chooseVault(join(userVault, 'memories'))).rejects.toThrow(/嵌套|Obsidian 仓库内/)
  })

  it('does not auto-create a vault at a configured nested path', async () => {
    const nested = join(userVault, 'DSH Memory')
    const service = new MemoryService({
      configuredVaultPath: nested,
      discoveryProvider: async () => discoveryWith([userVault]),
    })
    expect(await service.ensureReady()).toBe(false)
    expect((await readFile(join(userVault, 'my-note.md'), 'utf8'))).toBe('# 我自己的笔记\n')
  })

  it('accepts a sibling path outside the Obsidian vault', async () => {
    const sibling = join(root, 'DSH Memory')
    const service = new MemoryService({ discoveryProvider: async () => discoveryWith([userVault]) })
    const status = await service.initialize(sibling)
    expect(status.vault?.path).toBe(sibling)
    expect(status.vault?.initialized).toBe(true)
  })
})
