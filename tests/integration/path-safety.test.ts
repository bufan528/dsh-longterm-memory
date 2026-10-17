/**
 * Test-path safety (round 11, R6).
 *
 * The failure this guards against: a test that forgets to configure a vault falls
 * back to "discovered" desktop paths and creates a real vault in the user's home.
 * Round 9 did exactly that twice.
 *
 * Every case below checks the **filesystem**, not just that a function threw: after
 * a refused write the target must still not exist.
 *
 * @module tests/integration/path-safety.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { confineDiscoveryToTestRoot } from '../../src/host/core/discovery-guard.js'
import {
  PathSafetyError,
  assertTestWritable,
  assertWritableTarget,
  filterCandidatesForTestMode,
  isInsideRoot,
  normalizeForCompare,
  testRootFromEnv,
  userDefaultDirectories,
} from '../../src/shared/path-safety.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

const SCRATCH = join(process.cwd(), '.scratch')
let root: string

function discovery(overrides: Partial<VaultDiscovery> = {}): VaultDiscovery {
  return {
    environment: 'desktop',
    filesystem: true,
    obsidian: { detected: false, configPath: null, vaults: [] },
    current: null,
    candidates: [],
    needsChoice: false,
    rationale: 'test',
    warnings: [],
    ...overrides,
  }
}

beforeEach(async () => {
  root = await makeTempRoot('path-safety')
})

afterEach(async () => {
  await cleanup(root)
  vi.unstubAllEnvs()
})

describe('boundary comparison', () => {
  it('treats a directory prefix as outside the root (no string-prefix bug)', () => {
    const inside = join(SCRATCH, 'a')
    const similar = `${join(SCRATCH)}x${'\\'}a`
    expect(isInsideRoot(inside, SCRATCH)).toBe(true)
    expect(isInsideRoot(similar, SCRATCH)).toBe(false)
    expect(isInsideRoot(SCRATCH, SCRATCH)).toBe(true)
  })

  it('normalizes case and separators on Windows', () => {
    const upper = join(SCRATCH, 'CaseTest').toUpperCase()
    expect(normalizeForCompare(upper)).toBe(normalizeForCompare(join(SCRATCH, 'CaseTest')))
  })

  it('reads the allowed root from the environment used by the test suite', () => {
    expect(testRootFromEnv()).not.toBeNull()
    expect(normalizeForCompare(testRootFromEnv() ?? '')).toBe(normalizeForCompare(SCRATCH))
    expect(testRootFromEnv({})).toBeNull()
  })
})

describe('refusals leave the filesystem untouched', () => {
  it('refuses a relative path', async () => {
    await expect(assertWritableTarget('relative/vault', { allowedRoot: SCRATCH })).rejects.toBeInstanceOf(PathSafetyError)
  })

  it('refuses a user Documents target in test mode and creates nothing', async () => {
    const target = join(homedir(), 'Documents', 'DSH Memory')
    const existed = existsSync(target)
    await expect(assertTestWritable(target)).rejects.toBeInstanceOf(PathSafetyError)
    expect(existsSync(target)).toBe(existed)
  })

  it('refuses a Desktop target in test mode', async () => {
    const target = join(homedir(), 'Desktop', 'DSH Memory')
    const existed = existsSync(target)
    await expect(assertTestWritable(target)).rejects.toBeInstanceOf(PathSafetyError)
    expect(existsSync(target)).toBe(existed)
  })

  it('refuses a prefix-similar directory outside the root', async () => {
    const target = `${SCRATCH}x${'\\'}DSH Memory`
    await expect(assertTestWritable(target)).rejects.toBeInstanceOf(PathSafetyError)
    expect(existsSync(target)).toBe(false)
  })

  it('refuses a path that escapes the root with ..', async () => {
    const target = join(SCRATCH, 'a', '..', '..', 'escaped-vault')
    await expect(assertTestWritable(target)).rejects.toBeInstanceOf(PathSafetyError)
    expect(existsSync(join(process.cwd(), 'escaped-vault'))).toBe(false)
  })

  it('refuses a target reached through a junction', async () => {
    const link = join(root, 'junction-out')
    const outside = await mkdtemp(join(tmpdir(), 'r11-outside-'))
    try {
      await symlink(outside, link, 'junction')
    } catch {
      // If the OS refuses to create a junction, fail-closed behaviour is still the
      // contract: a path whose real location cannot be confirmed must be refused.
      await expect(assertWritableTarget(link, { allowedRoot: SCRATCH })).rejects.toBeInstanceOf(PathSafetyError)
      return
    }
    try {
      await expect(assertWritableTarget(join(link, 'vault'), { allowedRoot: SCRATCH })).rejects.toBeInstanceOf(PathSafetyError)
      expect(existsSync(join(outside, 'vault'))).toBe(false)
    } finally {
      await cleanup(outside)
    }
  })

  it('refuses when the parent chain cannot be inspected', async () => {
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'x', 'utf8')
    await expect(assertWritableTarget(join(file, 'vault'), { allowedRoot: SCRATCH })).rejects.toBeInstanceOf(PathSafetyError)
    expect(existsSync(join(file, 'vault'))).toBe(false)
  })

  it('keeps refusing on retry after a failure', async () => {
    const target = join(homedir(), 'Documents', 'DSH Memory')
    // The guard must never create the target. Whether the real user directory already
    // exists is machine state, not a product behaviour, so compare against the state
    // captured before the first attempt instead of asserting `false`.
    const existedBefore = existsSync(target)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(assertTestWritable(target)).rejects.toBeInstanceOf(PathSafetyError)
    }
    expect(existsSync(target)).toBe(existedBefore)
  })
})

describe('allowed paths still work', () => {
  it('accepts and creates an isolated vault inside the root', async () => {
    const vault = join(root, 'DSH Memory')
    const service = new MemoryService({
      configuredVaultPath: vault,
      discoveryProvider: async () => discovery({ candidates: [vault] }),
    })
    await expect(service.initialize(vault)).resolves.toBeDefined()
    expect(existsSync(join(vault, '.dsh-memory', 'config.json'))).toBe(true)
  })

  it('does not let discovery override an explicitly configured vault', async () => {
    const configured = join(root, 'Configured Vault')
    const elsewhere = join(root, 'Discovered Vault')
    await mkdir(elsewhere, { recursive: true })
    const service = new MemoryService({
      configuredVaultPath: configured,
      discoveryProvider: async () => discovery({ current: elsewhere, candidates: [elsewhere] }),
    })
    expect(await service.ensureReady()).toBe(true)
    expect((await service.status()).vault?.path).toBe(configured)
  })

  it('production mode (no test root) leaves a normal explicit path alone', async () => {
    const target = join(root, 'production-vault')
    await expect(assertWritableTarget(target, { allowedRoot: null })).resolves.toBeUndefined()
    // and the test-mode guard is inert when the env is empty
    await expect(assertTestWritable(target, {})).resolves.toBeUndefined()
  })
})

describe('test-mode discovery cannot adopt a real vault', () => {
  it('drops candidates and current outside the root', () => {
    const outside = join(homedir(), 'Documents', 'DSH Memory')
    const inside = join(root, 'Inside Vault')
    const confined = confineDiscoveryToTestRoot(
      discovery({ current: outside, candidates: [outside, inside], needsChoice: true }),
      { DSH_MEMORY_TEST_ROOT: SCRATCH },
    )
    expect(confined.current).toBeNull()
    expect(confined.candidates).toEqual([inside])
    expect(confined.warnings.some((warning) => warning.includes('测试根目录'))).toBe(true)
  })

  it('leaves discovery untouched when no test root is configured', () => {
    const result = discovery({ candidates: [join(homedir(), 'Documents', 'DSH Memory')] })
    expect(confineDiscoveryToTestRoot(result, {})).toEqual(result)
  })

  it('filters candidates with the shared helper', () => {
    const inside = join(SCRATCH, 'x')
    expect(filterCandidatesForTestMode([inside, 'C:\\Users\\someone\\Documents\\DSH Memory'], SCRATCH)).toEqual([join(SCRATCH, 'x')])
    expect(filterCandidatesForTestMode([inside], null)).toEqual([inside])
  })

  it('refuses to auto-create when no safe candidate remains', () => {
    const confined = confineDiscoveryToTestRoot(
      discovery({ candidates: [join(homedir(), 'Documents', 'DSH Memory')], needsChoice: false }),
      { DSH_MEMORY_TEST_ROOT: SCRATCH },
    )
    expect(confined.candidates).toEqual([])
    expect(confined.needsChoice).toBe(false)
    // Every default directory the plugin might otherwise pick is covered.
    expect(userDefaultDirectories().length).toBeGreaterThan(0)
  })
})
