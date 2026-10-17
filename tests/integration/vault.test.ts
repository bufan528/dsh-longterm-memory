/**
 * Vault discovery and initialization tests (task-book section B).
 *
 * All of these run against real temporary directories; the Obsidian
 * configuration is a synthetic file that the code reads exactly as it would read
 * the real one.
 *
 * @module tests/integration/vault.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import {
  candidatePaths,
  checkTargetUsable,
  discoverVault,
  detectEnvironment,
  isInside,
  isMemoryVault,
  readObsidianVaults,
} from '../../src/host/core/discover.js'
import { initializeVault, readVaultConfig, verifyVault, vaultStatus } from '../../src/host/core/vault.js'
import { layoutFor } from '../../src/host/core/layout.js'
import { pathExists, toVaultRelative } from '../../src/host/core/fsx.js'

let root: string
let fakeHome: string
let fakeAppData: string

beforeEach(async () => {
  root = await makeTempRoot('vault')
  fakeHome = join(root, 'home')
  fakeAppData = join(root, 'appdata')
  await mkdir(fakeHome, { recursive: true })
  await mkdir(fakeAppData, { recursive: true })
})

afterEach(async () => {
  await cleanup(root)
})

async function makeObsidianVault(path: string): Promise<void> {
  await mkdir(join(path, '.obsidian'), { recursive: true })
}

async function writeObsidianConfig(vaults: { path: string }[]): Promise<string> {
  await mkdir(join(fakeAppData, 'obsidian'), { recursive: true })
  const configPath = join(fakeAppData, 'obsidian', 'obsidian.json')
  const map: Record<string, unknown> = {}
  vaults.forEach((vault, index) => {
    map[`vault${String(index)}`] = { path: vault.path, ts: 1_700_000_000_000, open: index === 0 }
  })
  await writeFile(configPath, JSON.stringify({ vaults: map }), 'utf8')
  return configPath
}

describe('detectEnvironment', () => {
  it('reports desktop when Electron is present', () => {
    const original = process.versions.electron
    Object.defineProperty(process.versions, 'electron', { value: '41.0.0', configurable: true })
    try {
      expect(detectEnvironment({})).toBe('desktop')
    } finally {
      Object.defineProperty(process.versions, 'electron', { value: original, configurable: true })
    }
  })

  it('reports desktop when the desktop node executable is set', () => {
    expect(detectEnvironment({ DSH_DESKTOP_NODE_EXECUTABLE: 'D:/x/node.exe' })).toBe('desktop')
  })

  it('reports web for a profile-launched host', () => {
    expect(detectEnvironment({ DSH_PROFILE: 'web' })).toBe('web')
  })

  it('reports node when nothing identifies the host', () => {
    expect(detectEnvironment({})).toBe('node')
  })
})

describe('isInside', () => {
  it('is true for the same path and for a nested path', () => {
    expect(isInside('C:/a', 'C:/a')).toBe(true)
    expect(isInside('C:/a', 'C:/a/b')).toBe(true)
  })

  it('is false for a sibling or an unrelated path', () => {
    expect(isInside('C:/a', 'C:/ab')).toBe(false)
    expect(isInside('C:/a/b', 'C:/a')).toBe(false)
  })
})

describe('readObsidianVaults', () => {
  it('returns only vaults whose directory exists and carries .obsidian', async () => {
    const good = join(root, 'GoodVault')
    const moved = join(root, 'MovedVault')
    await makeObsidianVault(good)
    await mkdir(moved, { recursive: true })
    await writeObsidianConfig([{ path: good }, { path: moved }, { path: join(root, 'never-existed') }])

    const result = await readObsidianVaults({ home: fakeHome, appData: fakeAppData, env: {} })
    expect(result.vaults).toEqual([good])
    expect(result.configPath).toContain('obsidian.json')
    expect(result.warnings.join(' ')).toMatch(/缺少 .obsidian|不存在的仓库路径/)
  })

  it('reports a malformed configuration instead of throwing', async () => {
    await mkdir(join(fakeAppData, 'obsidian'), { recursive: true })
    const configPath = join(fakeAppData, 'obsidian', 'obsidian.json')
    await writeFile(configPath, '{ not json', 'utf8')
    const result = await readObsidianVaults({ home: fakeHome, appData: fakeAppData, env: {} })
    expect(result.configPath).toBeNull()
    expect(result.warnings.join(' ')).toMatch(/无法解析/)
  })

  it('returns nothing when no configuration exists', async () => {
    const result = await readObsidianVaults({ home: fakeHome, appData: fakeAppData, env: {} })
    expect(result.configPath).toBeNull()
    expect(result.vaults).toEqual([])
  })

  it('reports a configuration with no vaults field', async () => {
    await mkdir(join(fakeAppData, 'obsidian'), { recursive: true })
    await writeFile(join(fakeAppData, 'obsidian', 'obsidian.json'), JSON.stringify({ updateDisabled: true }), 'utf8')
    const result = await readObsidianVaults({ home: fakeHome, appData: fakeAppData, env: {} })
    expect(result.configPath).toBeNull()
    expect(result.warnings.join(' ')).toMatch(/缺少 vaults/)
  })
})

describe('candidatePaths', () => {
  it('never proposes a vault nested inside an existing Obsidian vault', () => {
    const existing = join(root, 'MyVault')
    const candidates = candidatePaths({ home: fakeHome, obsidianVaults: [existing], env: {} })
    for (const candidate of candidates) {
      expect(isInside(existing, candidate)).toBe(false)
    }
  })

  it('prefers a sibling of a detected Obsidian vault', () => {
    const existing = join(root, 'notes', 'MyVault')
    const candidates = candidatePaths({ home: fakeHome, obsidianVaults: [existing], env: {} })
    expect(candidates[0]).toBe(join(root, 'notes', 'DSH Memory'))
  })

  it('is de-duplicated', () => {
    const existing = join(root, 'MyVault')
    const candidates = candidatePaths({ home: fakeHome, obsidianVaults: [existing, existing], env: {} })
    expect(new Set(candidates).size).toBe(candidates.length)
  })

  it('honours the documents override used by tests and unusual layouts', () => {
    const candidates = candidatePaths({ home: fakeHome, obsidianVaults: [], env: { DSH_MEMORY_DOCUMENTS_DIR: join(root, 'docs') } })
    expect(candidates[0]).toBe(join(root, 'docs', 'DSH Memory'))
  })
})

describe('discoverVault', () => {
  it('needs no choice when exactly one Obsidian vault exists', async () => {
    const existing = join(root, 'Only')
    await makeObsidianVault(existing)
    await writeObsidianConfig([{ path: existing }])

    const discovery = await discoverVault({
      home: fakeHome,
      appData: fakeAppData,
      env: { DSH_MEMORY_DOCUMENTS_DIR: join(root, 'docs') },
    })
    expect(discovery.obsidian.detected).toBe(true)
    expect(discovery.obsidian.vaults).toEqual([existing])
    expect(discovery.needsChoice).toBe(false)
    expect(discovery.candidates.length).toBeGreaterThan(0)
  })

  it('asks the user to choose when several Obsidian vaults exist', async () => {
    const first = join(root, 'A')
    const second = join(root, 'B')
    await makeObsidianVault(first)
    await makeObsidianVault(second)
    await writeObsidianConfig([{ path: first }, { path: second }])

    const discovery = await discoverVault({ home: fakeHome, appData: fakeAppData, env: {} })
    expect(discovery.needsChoice).toBe(true)
    expect(discovery.rationale).toMatch(/无法安全推断|请选择/)
    expect(discovery.candidates.length).toBeGreaterThan(1)
  })

  it('reuses an existing memory vault instead of creating a new one', async () => {
    const vault = join(root, 'docs', 'DSH Memory')
    await initializeVault(vault, {})
    const discovery = await discoverVault({
      configuredPath: vault,
      home: fakeHome,
      appData: fakeAppData,
      env: { DSH_MEMORY_DOCUMENTS_DIR: join(root, 'docs') },
    })
    expect(discovery.current).toBe(vault)
    expect(discovery.needsChoice).toBe(false)
  })

  it('warns that a non-desktop host may not be the user\'s own machine', async () => {
    const discovery = await discoverVault({ home: fakeHome, appData: fakeAppData, env: { DSH_PROFILE: 'web' } })
    expect(discovery.environment).toBe('web')
    expect(discovery.warnings.join(' ')).toMatch(/不一定是用户本机/)
  })

  it('skips a candidate occupied by foreign data and explains why', async () => {
    const docs = join(root, 'docs')
    const occupied = join(docs, 'DSH Memory')
    await mkdir(occupied, { recursive: true })
    await writeFile(join(occupied, 'user-file.md'), '# 我自己的文件', 'utf8')

    const discovery = await discoverVault({ home: fakeHome, appData: fakeAppData, env: { DSH_MEMORY_DOCUMENTS_DIR: docs } })
    expect(discovery.candidates).not.toContain(occupied)
    expect(discovery.warnings.join(' ')).toMatch(/以免覆盖用户文件|非空/)
  })
})

describe('checkTargetUsable', () => {
  it('accepts a path that does not exist yet', async () => {
    await expect(checkTargetUsable(join(root, 'fresh'))).resolves.toEqual({ ok: true })
  })

  it('accepts our own vault', async () => {
    const vault = join(root, 'mine')
    await initializeVault(vault, {})
    await expect(checkTargetUsable(vault)).resolves.toEqual({ ok: true })
  })

  it('refuses a non-empty foreign directory', async () => {
    const foreign = join(root, 'foreign')
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'a.md'), 'x', 'utf8')
    const result = await checkTargetUsable(foreign)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/拒绝/)
  })

  it('accepts an existing empty directory', async () => {
    const empty = join(root, 'empty')
    await mkdir(empty, { recursive: true })
    await expect(checkTargetUsable(empty)).resolves.toEqual({ ok: true })
  })

  it('refuses a path that is a file', async () => {
    const file = join(root, 'file.txt')
    await writeFile(file, 'x', 'utf8')
    const result = await checkTargetUsable(file)
    expect(result.ok).toBe(false)
  })

  // Task requirement: "不要把新的独立 Vault 嵌套在另一个 Vault 内". This must hold
  // for a path the user configures explicitly too, not only for proposed defaults.
  it('refuses a target nested inside a detected Obsidian vault', async () => {
    const userVault = join(root, 'Obsidian Vault')
    const nested = join(userVault, 'DSH Memory')
    await mkdir(userVault, { recursive: true })
    await writeFile(join(userVault, 'my-note.md'), '# 用户笔记\n', 'utf8')

    const result = await checkTargetUsable(nested, { obsidianVaults: [userVault] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/嵌套|Obsidian 仓库内/)
  })

  it('refuses a target that is an existing Obsidian vault itself', async () => {
    const userVault = join(root, 'Obsidian Vault')
    await mkdir(join(userVault, '.obsidian'), { recursive: true })

    const result = await checkTargetUsable(userVault, { obsidianVaults: [userVault] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/Obsidian/)
  })

  it('allows a target that is a sibling of an Obsidian vault', async () => {
    const userVault = join(root, 'notes', 'Obsidian Vault')
    await mkdir(join(userVault, '.obsidian'), { recursive: true })
    const sibling = join(root, 'notes', 'DSH Memory')

    await expect(checkTargetUsable(sibling, { obsidianVaults: [userVault] })).resolves.toEqual({ ok: true })
  })

  it('still reuses our own vault even if it sits near an Obsidian vault', async () => {
    const userVault = join(root, 'notes', 'Obsidian Vault')
    await mkdir(join(userVault, '.obsidian'), { recursive: true })
    const mine = join(root, 'notes', 'DSH Memory')
    await initializeVault(mine, { obsidianVaults: [userVault] })

    await expect(checkTargetUsable(mine, { obsidianVaults: [userVault] })).resolves.toEqual({ ok: true })
  })
})

describe('initializeVault', () => {
  it('creates the complete structure and passes read/write verification', async () => {
    const vault = join(root, 'docs', 'DSH Memory')
    const result = await initializeVault(vault, {})
    const layout = layoutFor(vault)

    expect(result.created).toBe(true)
    expect(result.reused).toBe(false)
    expect(result.verification.ok).toBe(true)
    expect(result.verification.failures).toEqual([])

    for (const path of [
      layout.marker,
      layout.readme,
      layout.home,
      layout.indexDir,
      layout.historyDir,
      layout.quarantineDir,
      layout.obsidianDir,
      join(vault, 'Profile'),
      join(vault, 'Preferences'),
      join(vault, 'Projects'),
      join(vault, 'Projects', 'State'),
      join(vault, 'Decisions'),
      join(vault, 'Knowledge'),
      join(vault, 'Experiences'),
      join(vault, 'Tasks'),
      join(vault, 'Inbox'),
      join(vault, 'Archive'),
      join(vault, 'Conflicts'),
    ]) {
      expect(await pathExists(path), `expected ${path} to exist`).toBe(true)
    }

    const config = await readVaultConfig(layout)
    expect(config?.product).toBe('dsh-longterm-memory')
    expect(config?.schemaVersion).toBe(1)

    const readme = await readFile(layout.readme, 'utf8')
    expect(readme).toContain('# DSH 长期记忆仓库')
    expect(readme).toContain('Markdown 文件是记忆的唯一事实来源')
  })

  it('marks the directory as an Obsidian vault without touching global Obsidian config', async () => {
    const vault = join(root, 'obs')
    await initializeVault(vault, {})
    const status = await vaultStatus(vault)
    expect(status.obsidianVault).toBe(true)
    expect(await pathExists(join(vault, '.obsidian'))).toBe(true)
    expect(await pathExists(join(fakeAppData, 'obsidian', 'obsidian.json'))).toBe(false)
  })

  it('is idempotent and never rewrites a file that already exists', async () => {
    const vault = join(root, 'idem')
    await initializeVault(vault, {})
    const layout = layoutFor(vault)

    // A user edits the README and adds their own note.
    await writeFile(layout.readme, '# 我改过的 README\n', 'utf8')
    await writeFile(join(vault, 'Knowledge', '我的笔记.md'), '# 手写笔记\n', 'utf8')

    const second = await initializeVault(vault, {})
    expect(second.created).toBe(false)
    expect(second.reused).toBe(true)
    expect(second.written).toEqual([])
    expect(second.preserved.length).toBeGreaterThan(0)

    expect(await readFile(layout.readme, 'utf8')).toBe('# 我改过的 README\n')
    expect(await readFile(join(vault, 'Knowledge', '我的笔记.md'), 'utf8')).toBe('# 手写笔记\n')
  })

  it('refuses a directory that already holds user data', async () => {
    const vault = join(root, 'occupied')
    await mkdir(vault, { recursive: true })
    await writeFile(join(vault, 'important.md'), 'do not lose me', 'utf8')

    await expect(initializeVault(vault, {})).rejects.toThrow(/拒绝|覆盖/)
    // The user's file is untouched.
    expect(await readFile(join(vault, 'important.md'), 'utf8')).toBe('do not lose me')
  })

  it('repairs a torn vault whose marker is damaged, without touching user files', async () => {
    const vault = join(root, 'retry')
    await initializeVault(vault, {})
    const layout = layoutFor(vault)

    // A torn state: the directory is a vault but the marker no longer says so.
    await writeFile(layout.marker, '{"product":"dsh-longterm-mem', 'utf8')
    // The user has since written their own note into the vault.
    await writeFile(join(vault, 'Knowledge', '我的笔记.md'), '# 不要动我\n', 'utf8')

    // Structural evidence is present, so the target is usable again.
    await expect(checkTargetUsable(vault)).resolves.toEqual({ ok: true })

    const second = await initializeVault(vault, {})
    expect(second.verification.ok).toBe(true)
    expect(second.warnings.join(' ')).toMatch(/标记文件/)
    const config = await readVaultConfig(layout)
    expect(config?.product).toBe('dsh-longterm-memory')
    // The user's note survived.
    expect(await readFile(join(vault, 'Knowledge', '我的笔记.md'), 'utf8')).toBe('# 不要动我\n')
  })

  it('refuses a directory holding a foreign marker and none of our artifacts', async () => {
    const other = join(root, 'other-product')
    await mkdir(join(other, '.dsh-memory'), { recursive: true })
    await writeFile(join(other, '.dsh-memory', 'config.json'), JSON.stringify({ product: 'someone-else' }), 'utf8')
    await writeFile(join(other, 'their-data.txt'), 'not ours', 'utf8')

    const result = await checkTargetUsable(other)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/拒绝在此初始化/)
    expect(await readFile(join(other, 'their-data.txt'), 'utf8')).toBe('not ours')
  })

  it('reports a failure when the marker is corrupt', async () => {
    const vault = join(root, 'corrupt')
    await initializeVault(vault, {})
    const layout = layoutFor(vault)
    await writeFile(layout.config, '{ not json', 'utf8')

    const verification = await verifyVault(layout)
    expect(verification.ok).toBe(false)
    expect(verification.failures.join(' ')).toMatch(/合法 JSON/)
  })

  it('reports the initializer-owned files in vault-relative form', async () => {
    const vault = join(root, 'rel')
    const result = await initializeVault(vault, {})
    expect(result.written).toContain('README.md')
    expect(result.written).toContain('Memory Home.md')
    expect(result.written).toContain('Index/all-memories.md')
    expect(result.written.every((entry) => !entry.includes('\\'))).toBe(true)
    expect(toVaultRelative(vault, layoutFor(vault).readme)).toBe('README.md')
  })
})

describe('isMemoryVault', () => {
  it('is false for a directory without our marker', async () => {
    const plain = join(root, 'plain')
    await mkdir(plain, { recursive: true })
    expect(await isMemoryVault(plain)).toBe(false)
  })

  it('is false when the marker names another product', async () => {
    const other = join(root, 'other')
    await mkdir(join(other, '.dsh-memory'), { recursive: true })
    await writeFile(join(other, '.dsh-memory', 'config.json'), JSON.stringify({ product: 'someone-else' }), 'utf8')
    expect(await isMemoryVault(other)).toBe(false)
  })
})
