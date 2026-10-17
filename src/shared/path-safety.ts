/**
 * Path safety for writes.
 *
 * Two different contracts share this module:
 *
 * - **production**: a path the user explicitly configured (or that discovery
 *   legitimately proposed) is used as-is. Nothing here narrows normal usage.
 * - **tests**: writing outside an allowed root must be impossible. If a test forgets
 *   to configure a vault, the failure mode must be "refuse and say why", never
 *   "create a vault somewhere in the user's home".
 *
 * The rules are intentionally boring and deterministic: normalize, compare by
 * directory boundary (never by string prefix), reject reparse points and known
 * user-default locations, and fail *before* creating anything.
 *
 * @module dsh-longterm-memory/shared/path-safety
 */

import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Raised when a write target is not allowed. Always fail-closed. */
export class PathSafetyError extends Error {
  readonly code = 'unsafe-path'

  constructor(reason: string) {
    super(reason)
    this.name = 'PathSafetyError'
  }
}

/** Environment variable that switches on test-mode path confinement. */
export const TEST_ROOT_ENV = 'DSH_MEMORY_TEST_ROOT'

/** Normalize a path for comparison: absolute, separators resolved, case-folded on Windows. */
export function normalizeForCompare(input: string): string {
  const absolute = resolve(input)
  const trimmed = absolute.length > 1 && absolute.endsWith(sep) ? absolute.slice(0, -1) : absolute
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** Whether `candidate` is `root` itself or inside it, by directory boundary. */
export function isInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForCompare(candidate)
  const normalizedRoot = normalizeForCompare(root)
  if (normalizedCandidate === normalizedRoot) return true
  return normalizedCandidate.startsWith(normalizedRoot + (process.platform === 'win32' ? '\\' : '/'))
}

/** Directories that must never be chosen automatically in test mode. */
export function userDefaultDirectories(home: string = homedir()): string[] {
  return [
    join(home, 'Documents'),
    join(home, 'Documents', 'DSH Memory'),
    join(home, 'Desktop'),
    join(home, 'Desktop', 'DSH Memory'),
    join(home, 'OneDrive'),
  ]
}

/** Read the test-mode allowed root, or `null` when not in test mode. */
export function testRootFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[TEST_ROOT_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  return resolve(raw.trim())
}

export interface WriteGuardOptions {
  /** Allowed root; typically `.scratch` in tests. `null` disables confinement. */
  allowedRoot: string | null
  /** Extra always-forbidden locations (user defaults), for a precise error message. */
  forbiddenDirectories?: readonly string[]
}

/**
 * Assert that `target` may be created or written.
 *
 * Rejects, in order: a relative path (ambiguous), a user-default location, a path
 * outside the allowed root, and any existing ancestor that is a symlink/junction.
 * The reparse check resolves the *nearest existing ancestor*, so a not-yet-created
 * target is still evaluated against what the filesystem would actually do.
 */
export async function assertWritableTarget(target: string, options: WriteGuardOptions): Promise<void> {
  const raw = target.trim()
  if (raw.length === 0) throw new PathSafetyError('写入目标为空。')
  if (!isAbsolute(raw)) {
    throw new PathSafetyError(`写入目标必须是绝对路径：${raw}。相对路径会随进程工作目录变化，无法确认落点。`)
  }

  const resolved = resolve(raw)

  for (const forbidden of options.forbiddenDirectories ?? []) {
    if (isInsideRoot(resolved, forbidden) || isInsideRoot(forbidden, resolved)) {
      throw new PathSafetyError(
        `拒绝在用户默认位置写入：${resolved}（禁止范围 ${forbidden}）。请在配置中显式指定一个独立的仓库路径。`,
      )
    }
  }

  if (options.allowedRoot !== null) {
    if (!isInsideRoot(resolved, options.allowedRoot)) {
      throw new PathSafetyError(
        `测试模式只允许在 ${options.allowedRoot} 内写入，拒绝目标 ${resolved}。请为测试显式指定隔离仓库路径。`,
      )
    }
    const reparse = await firstReparsePoint(resolved, options.allowedRoot)
    if (reparse !== null) {
      throw new PathSafetyError(`目标路径经过重解析点（${reparse}），无法确认实际落点，拒绝写入。`)
    }
  }
}

/**
 * Walk from `candidate` up to (not including) `root`, and return the first existing
 * component that is a symbolic link or junction, or `null` when the chain is clean.
 *
 * Unreadable components are treated as unsafe: an unverifiable path must not be
 * written to.
 */
export async function firstReparsePoint(candidate: string, root: string): Promise<string | null> {
  let current = resolve(candidate)
  const stop = resolve(root)
  for (let depth = 0; depth < 64; depth += 1) {
    if (!isInsideRoot(current, stop)) return current
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) return current
      // An existing ancestor that is not a directory means the chain is not a real
      // directory tree, so the write target cannot be verified.
      if (!stat.isDirectory()) return current
      // A junction resolves to a different real path; compare real paths when possible.
      try {
        const real = await realpath(current)
        if (normalizeForCompare(real) !== normalizeForCompare(current) && normalizeForCompare(current) !== normalizeForCompare(stop)) {
          return current
        }
      } catch {
        return current
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') return current
    }
    if (normalizeForCompare(current) === normalizeForCompare(stop)) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return candidate
}

/** Convenience wrapper for the common test-mode case. */
export async function assertTestWritable(target: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const allowedRoot = testRootFromEnv(env)
  if (allowedRoot === null) return
  await assertWritableTarget(target, { allowedRoot, forbiddenDirectories: userDefaultDirectories() })
}

/** Filter discovery candidates so test mode cannot fall back to a real vault. */
export function filterCandidatesForTestMode(candidates: readonly string[], testRoot: string | null): string[] {
  if (testRoot === null) return [...candidates]
  return candidates.filter((candidate) => isInsideRoot(candidate, testRoot))
}
