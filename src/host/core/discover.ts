/**
 * Environment and Obsidian discovery.
 *
 * Everything here is evidence-based: a path is only reported as an Obsidian
 * vault when the configuration file that names it was actually read *and* the
 * named directory exists and carries a `.obsidian` folder. Nothing is assumed
 * from a hardcoded string.
 *
 * @module dsh-longterm-memory/host/core/discover
 */

import { homedir, platform } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import type { VaultDiscovery } from '../../shared/types.js'
import { isDirectory, pathExists } from './fsx.js'
import { layoutFor } from './layout.js'

/** Folder name of the dedicated memory vault. */
export const DEFAULT_VAULT_FOLDER = 'DSH Memory'

export interface DiscoverOptions {
  /** A vault path already recorded in the plugin's settings, if any. */
  configuredPath?: string | null
  /** Injectable for tests. */
  home?: string
  appData?: string | null
  env?: NodeJS.ProcessEnv
  /** Injectable for tests: reads a UTF-8 file, or null. */
  readFileImpl?: (path: string) => Promise<string | null>
}

/**
 * Work out whether the host is serving the user's own machine or a server.
 *
 * This distinction is the whole reason the discovery report is honest: in a
 * server-side (headless `web`) deployment the process may be able to read a
 * filesystem, but that filesystem is not necessarily the user's computer, so no
 * claim is made that the user's local Obsidian vault was found.
 */
export function detectEnvironment(env: NodeJS.ProcessEnv = process.env): VaultDiscovery['environment'] {
  const electron = typeof process.versions.electron === 'string' && process.versions.electron.length > 0
  if (electron || (env['DSH_DESKTOP_NODE_EXECUTABLE'] ?? '').length > 0) return 'desktop'
  if ((env['DSH_WEB_URL'] ?? '').length > 0 || (env['DSH_PROFILE'] ?? '').length > 0) return 'web'
  return 'node'
}

/** Resolve the Obsidian configuration file path for this platform. */
export function obsidianConfigCandidates(options: DiscoverOptions = {}): string[] {
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const os = platform()
  const appData = options.appData !== undefined ? options.appData : (env['APPDATA'] ?? null)
  const out: string[] = []
  if (os === 'win32') {
    if (appData !== null && appData.length > 0) out.push(join(appData, 'obsidian', 'obsidian.json'))
    out.push(join(home, 'AppData', 'Roaming', 'obsidian', 'obsidian.json'))
  } else if (os === 'darwin') {
    out.push(join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'))
  } else {
    const xdg = env['XDG_CONFIG_HOME']
    out.push(join(xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.config'), 'obsidian', 'obsidian.json'))
  }
  return [...new Set(out)]
}

interface ObsidianConfigRead {
  configPath: string | null
  vaults: string[]
  warnings: string[]
}

/**
 * Read Obsidian's own configuration and return the vault paths it confirms.
 *
 * A path is accepted only when the directory exists and contains `.obsidian`;
 * the configuration file is the *index*, the filesystem is the *proof*.
 */
export async function readObsidianVaults(options: DiscoverOptions = {}): Promise<ObsidianConfigRead> {
  const warnings: string[] = []
  const readFileImpl = options.readFileImpl ?? (async (path: string) => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  })

  for (const configPath of obsidianConfigCandidates(options)) {
    const raw = await readFileImpl(configPath)
    if (raw === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      warnings.push(`Obsidian 配置文件存在但无法解析：${configPath}（${describeError(error)}）`)
      continue
    }
    const vaultsField = (parsed as { vaults?: unknown } | null)?.vaults
    if (vaultsField === null || typeof vaultsField !== 'object') {
      warnings.push(`Obsidian 配置缺少 vaults 字段：${configPath}`)
      continue
    }
    const confirmed: string[] = []
    const entries = Object.values(vaultsField as Record<string, unknown>)
    for (const entry of entries) {
      const rawPath = (entry as { path?: unknown } | null)?.path
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) continue
      const candidate = resolve(rawPath.trim())
      if (!(await isDirectory(candidate))) {
        warnings.push(`Obsidian 记录了不存在的仓库路径：${candidate}`)
        continue
      }
      if (!(await isDirectory(join(candidate, '.obsidian')))) {
        warnings.push(`Obsidian 记录的路径缺少 .obsidian 目录，可能已被移动：${candidate}`)
        continue
      }
      confirmed.push(candidate)
    }
    return { configPath, vaults: [...new Set(confirmed)], warnings }
  }

  return { configPath: null, vaults: [], warnings }
}

/** True when `candidate` is the same as, or nested inside, `parent`. */
export function isInside(parent: string, candidate: string): boolean {
  const normalizedParent = resolve(parent).replace(/[\\/]+$/, '').toLowerCase()
  const normalizedCandidate = resolve(candidate).replace(/[\\/]+$/, '').toLowerCase()
  if (normalizedParent === normalizedCandidate) return true
  return (
    normalizedCandidate.startsWith(`${normalizedParent}\\`) || normalizedCandidate.startsWith(`${normalizedParent}/`)
  )
}

/** True when the directory doubles as one of our vaults (marker present and valid). */
export async function isMemoryVault(candidate: string): Promise<boolean> {
  const layout = layoutFor(candidate)
  if (!(await isDirectory(candidate))) return false
  const raw = await readFile(layout.marker, 'utf8').catch(() => null)
  if (raw === null) return false
  try {
    const parsed = JSON.parse(raw) as { product?: unknown }
    return parsed.product === 'dsh-longterm-memory'
  } catch {
    return false
  }
}

/** A directory that exists, is not ours, and holds something. */
async function isForeignNonEmptyDirectory(candidate: string): Promise<boolean> {
  if (!(await isDirectory(candidate))) return false
  if (await isMemoryVault(candidate)) return false
  try {
    const entries = await readdir(candidate)
    return entries.length > 0
  } catch {
    return false
  }
}

/**
 * Candidate target directories for a new memory vault, most preferred first.
 *
 * Rules the list encodes:
 * - never nest an independent vault inside an existing Obsidian vault;
 * - never propose the user's existing Obsidian vault itself as our target;
 * - prefer a location beside a detected Obsidian vault, so the user finds it.
 */
export function candidatePaths(input: {
  home: string
  obsidianVaults: readonly string[]
  env?: NodeJS.ProcessEnv
}): string[] {
  const env = input.env ?? process.env
  const home = input.home
  const documents = documentsDirectory(home, env)
  const out: string[] = []

  // Beside a detected Obsidian vault: the user already keeps notes there.
  for (const vault of input.obsidianVaults) {
    const parent = dirname(vault)
    // Refuse to place our vault inside the Obsidian vault itself.
    const beside = join(parent, DEFAULT_VAULT_FOLDER)
    if (!isInside(vault, beside)) out.push(beside)
  }

  out.push(join(documents, DEFAULT_VAULT_FOLDER))
  out.push(join(home, DEFAULT_VAULT_FOLDER))

  const seen = new Set<string>()
  const unique: string[] = []
  for (const candidate of out) {
    const normalized = resolve(candidate)
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    // A candidate that sits inside any Obsidian vault is not independent.
    if (input.obsidianVaults.some((vault) => isInside(vault, normalized))) continue
    seen.add(key)
    unique.push(normalized)
  }
  return unique
}

function documentsDirectory(home: string, env: NodeJS.ProcessEnv): string {
  const override = env['DSH_MEMORY_DOCUMENTS_DIR']
  if (override !== undefined && override.trim().length > 0) return resolve(override.trim())
  // OneDrive-redirected Documents is common on Windows; prefer it when it exists.
  const oneDrive = env['OneDrive'] ?? env['OneDriveConsumer'] ?? env['OneDriveCommercial']
  if (oneDrive !== undefined && oneDrive.trim().length > 0) {
    return join(oneDrive.trim(), 'Documents')
  }
  return join(home, 'Documents')
}

/**
 * Produce the complete discovery report the UI shows on first run.
 *
 * The report never guesses: `needsChoice` is true exactly when more than one
 * independent target is plausible, or when the preferred target is occupied by a
 * directory the plugin did not create.
 */
export async function discoverVault(options: DiscoverOptions = {}): Promise<VaultDiscovery> {
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const environment = detectEnvironment(env)
  const warnings: string[] = []

  if (environment !== 'desktop') {
    warnings.push(
      '当前宿主不是桌面版：本进程可以读写它自己所在的文件系统，但这不一定是用户本机的磁盘。' +
        '若 DSH 运行在远程服务器上，这里创建的仓库位于服务器而非用户电脑。',
    )
  }

  const obsidian = await readObsidianVaults(options)
  warnings.push(...obsidian.warnings)

  const configured = options.configuredPath ?? null
  let current: string | null = null
  if (configured !== null && configured.trim().length > 0) {
    const resolved = resolve(configured.trim())
    const ours = await isMemoryVault(resolved)
    // A configured path inside the user's own Obsidian vault is refused unless it
    // is already our vault: nesting would mix generated folders into their notes,
    // and no explicit configuration makes that a good idea.
    const nesting = ours ? null : describeObsidianNesting(resolved, obsidian.vaults)
    if (nesting !== null) {
      warnings.push(`配置中记录的仓库路径已忽略：${nesting}`)
    } else if (ours) current = resolved
    else if (await isDirectory(resolved)) {
      const foreign = await isForeignNonEmptyDirectory(resolved)
      if (foreign) warnings.push(`配置中记录的仓库路径存在但不是本插件的仓库，且目录非空：${resolved}`)
      else current = resolved
    } else {
      warnings.push(`配置中记录的仓库路径不存在：${resolved}`)
    }
  }

  // Look for an existing dedicated vault in the standard places.
  if (current === null) {
    const searchPaths = candidatePaths({ home, obsidianVaults: obsidian.vaults, env })
    for (const candidate of searchPaths) {
      if (await isMemoryVault(candidate)) {
        current = candidate
        break
      }
    }
  }

  const candidates: string[] = []
  const blocked: string[] = []
  if (current !== null) {
    candidates.push(current)
  } else {
    for (const candidate of candidatePaths({ home, obsidianVaults: obsidian.vaults, env })) {
      if (await isForeignNonEmptyDirectory(candidate)) {
        blocked.push(candidate)
        continue
      }
      candidates.push(candidate)
    }
  }

  let needsChoice = false
  let rationale: string
  if (current !== null) {
    rationale = `已找到可复用的长期记忆仓库：${current}`
  } else if (candidates.length === 0) {
    needsChoice = true
    rationale = '所有默认位置都已被非本插件的目录占用，请手动指定一个空目录或新目录。'
  } else if (obsidian.vaults.length >= 2) {
    // Two or more Obsidian vaults means we cannot tell where the user keeps
    // notes, so guessing a default would be a guess, not a decision.
    needsChoice = true
    rationale = `发现 ${String(obsidian.vaults.length)} 个 Obsidian 仓库，无法安全推断默认位置，请选择要在哪里创建长期记忆仓库。`
  } else {
    // A single preferred candidate is a decision the plugin may take itself; the
    // remaining candidates are fallbacks, not an ambiguity.
    rationale = `将使用默认位置创建仓库：${candidates[0] ?? ''}`
  }

  for (const path of blocked) {
    warnings.push(`候选位置已存在同名且非空的目录，已被跳过以免覆盖用户文件：${path}`)
  }

  return {
    environment,
    filesystem: true,
    obsidian: {
      detected: obsidian.configPath !== null,
      configPath: obsidian.configPath,
      vaults: obsidian.vaults,
    },
    current,
    candidates,
    needsChoice,
    rationale,
    warnings,
  }
}

/**
 * Look for structural evidence that a directory is one of our vaults.
 *
 * Used only when the marker file is missing or unreadable. The check is narrow
 * on purpose: it looks for artifacts this plugin generates and nobody else does
 * (`Index/all-memories.md` stamped `generated_by: dsh-longterm-memory`, and the
 * `Memory Home.md` entry page). A user's own notes folder cannot match by
 * accident, so a torn vault becomes recoverable without widening what may be
 * adopted.
 *
 * @returns the artifact names that matched, empty when there is no evidence.
 */
export async function vaultStructureEvidence(dir: string): Promise<string[]> {
  const evidence: string[] = []
  const indexNote = await readFile(join(dir, 'Index', 'all-memories.md'), 'utf8').catch(() => null)
  if (indexNote !== null && indexNote.includes('generated_by: dsh-longterm-memory')) {
    evidence.push('Index/all-memories.md')
  }
  if (await pathExists(join(dir, 'Memory Home.md'))) evidence.push('Memory Home.md')
  if (await isDirectory(join(dir, '.dsh-memory'))) evidence.push('.dsh-memory/')
  return evidence
}

/**
 * Read the `product` field a marker file declares.
 *
 * @returns the declared product name, `''` when the file parses but declares
 *   none, or `null` when the file cannot be read or parsed at all.
 */
async function readDeclaredProduct(marker: string): Promise<string | null> {
  const raw = await readFile(marker, 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { product?: unknown }
    if (typeof parsed.product === 'string') return parsed.product
    return ''
  } catch {
    return null
  }
}

export interface CheckTargetOptions {
  /**
   * Obsidian vaults confirmed on this machine.
   *
   * A memory vault must stay independent: placing it inside an existing Obsidian
   * vault would mix the plugin's generated folders into the user's own notes,
   * make the plugin's index and the user's graph interfere, and turn "delete the
   * memory vault" into a destructive operation on their real notes. This applies
   * to an explicitly configured path just as much as to a proposed default.
   */
  obsidianVaults?: readonly string[]
}

/**
 * Explain why `target` may not host an independent memory vault because of an
 * existing Obsidian vault, or `null` when it is clear of all of them.
 *
 * A memory vault must stay independent: inside the user's vault its generated
 * folders would mix with their notes, the plugin's index would compete with
 * their graph, and "delete the memory vault" would become a destructive
 * operation on their real notes.
 */
export function describeObsidianNesting(target: string, vaults: readonly string[]): string | null {
  const resolved = resolve(target)
  for (const vault of vaults) {
    if (!isInside(vault, resolved)) continue
    const same = resolve(vault).toLowerCase() === resolved.toLowerCase()
    return same
      ? `目标是用户已有的 Obsidian 仓库本身（${vault}），拒绝在此初始化，以免把插件目录混进用户笔记。请选择该仓库之外的位置。`
      : `目标位于用户已有的 Obsidian 仓库内（${vault}）。独立的长期记忆仓库不能嵌套在另一个 Vault 内，请选择该仓库之外的位置。`
  }
  return null
}

/**
 * Find an Obsidian vault among `target`'s ancestors by **filesystem evidence**.
 *
 * Obsidian's registry (`obsidian.json`) only lists vaults Obsidian has opened
 * itself. A vault opened by folder, restored from a backup, or synced from another
 * machine has a `.obsidian` directory but no registry entry, so relying on the
 * registry alone would happily create the memory vault inside it.
 *
 * @returns the enclosing vault directory, or `null`.
 */
export async function enclosingObsidianVault(target: string): Promise<string | null> {
  let dir = dirname(resolve(target))
  for (let depth = 0; depth < 32; depth += 1) {
    if (await isDirectory(join(dir, '.obsidian'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
/** Whether a path may be used as a new vault target, and why not when it may not. */
export async function checkTargetUsable(
  target: string,
  options: CheckTargetOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const resolved = resolve(target)
  if (resolved.length === 0) return { ok: false, reason: '路径为空' }

  // Reusing our own vault is always allowed, even if it happens to sit near an
  // Obsidian vault — refusing it would strand an existing memory vault.
  const ours = await isMemoryVault(resolved)
  if (ours) return { ok: true }

  const nesting = describeObsidianNesting(resolved, options.obsidianVaults ?? [])
  if (nesting !== null) return { ok: false, reason: nesting }


  // Registry-independent evidence: the target may sit inside an Obsidian vault
  // that Obsidian never registered (opened by folder, restored, or synced).
  // `obsidian.json` alone cannot answer that, and this must run before the
  // "does not exist yet" shortcut because the nested target usually does not exist.
  const enclosing = await enclosingObsidianVault(resolved)
  if (enclosing !== null) {
    return {
      ok: false,
      reason: `目标位于一个 Obsidian 仓库内（${enclosing}，由 .obsidian 目录确认）。独立的长期记忆仓库不能嵌套在另一个 Vault 内，请选择该仓库之外的位置。`,
    }
  }

  if (!(await pathExists(resolved))) return { ok: true }
  if (!(await isDirectory(resolved))) return { ok: false, reason: '目标是一个文件，不是目录' }

  // A vault-shaped directory whose marker is unreadable or names another product
  // is recoverable only when our own generated artifacts are present.
  const marker = join(resolved, '.dsh-memory', 'config.json')
  if (await pathExists(marker)) {
    const declared = await readDeclaredProduct(marker)
    if (declared !== null && declared !== 'dsh-longterm-memory') {
      // The marker parses and positively claims another product: never adopt it.
      return {
        ok: false,
        reason: `目录中的 .dsh-memory/config.json 属于其他产品（product: ${declared}），拒绝在此初始化：${resolved}。`,
      }
    }
    const evidence = await vaultStructureEvidence(resolved)
    if (declared === 'dsh-longterm-memory' || evidence.length > 0) return { ok: true }
    return {
      ok: false,
      reason:
        `目录中存在无法解析的 .dsh-memory/config.json，且没有任何本插件生成的文件：${resolved}。` +
        '为避免误判为插件仓库，拒绝在此初始化。',
    }
  }

  // The target itself may be an Obsidian vault Obsidian never registered. Checked
  // after the marker branch so a torn vault of ours stays repairable.
  if (await isDirectory(join(resolved, '.obsidian'))) {
    return {
      ok: false,
      reason: `目标本身就是一个 Obsidian 仓库（含 .obsidian 目录，${resolved}）。拒绝在此初始化，以免把插件目录混进用户笔记，请选择该仓库之外的位置。`,
    }
  }
  if (await isForeignNonEmptyDirectory(resolved)) {
    return {
      ok: false,
      reason: `目录已存在且包含其他文件（${basename(resolved)}），为避免覆盖用户数据，拒绝在此初始化。`,
    }
  }
  return { ok: true }
}

/** Whether a directory already carries an Obsidian vault marker. */
export async function hasObsidianMarker(target: string): Promise<boolean> {
  try {
    const info = await stat(join(target, '.obsidian'))
    return info.isDirectory()
  } catch {
    return false
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
