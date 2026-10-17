/**
 * Filesystem primitives for the vault.
 *
 * A host plugin is ordinary Node code, so the vault is owned with `node:fs`
 * directly. `ctx.fs` is deliberately not used: the shipped base bundle mounts
 * `dsh-fs-sandbox`, whose default policy is `workspace-write` rooted at
 * `process.cwd()`, so a memory vault in the user's home would be denied. The
 * atomic-replace and cross-process-lock algorithms below mirror
 * `@deepseek-ai/dsh-atomic-write` (the same package DSH presents to its own
 * tools) so behaviour matches the host's, without depending on that package
 * resolving from this plugin.
 *
 * @module dsh-longterm-memory/host/core/fsx
 */

import { constants } from 'node:fs'
import { access, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/** Error codes surfaced to the UI and asserted by tests. */
export const FS_CODES = {
  notFound: 'FS_NOT_FOUND',
  denied: 'FS_DENIED',
  invalidPath: 'FS_INVALID_PATH',
  invalidName: 'FS_INVALID_NAME',
  busy: 'FS_BUSY',
  io: 'FS_IO',
  outsideVault: 'FS_OUTSIDE_VAULT',
} as const

export type FsCode = (typeof FS_CODES)[keyof typeof FS_CODES]

export class FsError extends Error {
  readonly code: FsCode
  readonly path: string | undefined

  constructor(code: FsCode, message: string, path?: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FsError'
    this.code = code
    this.path = path
  }
}

const WINDOWS_TRANSIENT_RENAME = new Set(['EACCES', 'EBUSY', 'EPERM'])
const RENAME_RETRY_INITIAL_MS = 20
const RENAME_RETRY_MAX_MS = 200
const RENAME_RETRY_LIMIT = 8

function isTransientRename(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && WINDOWS_TRANSIENT_RENAME.has(code)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function renameWithRetry(temp: string, target: string): Promise<void> {
  let wait = RENAME_RETRY_INITIAL_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, target)
      return
    } catch (error) {
      if (!isTransientRename(error) || attempt >= RENAME_RETRY_LIMIT) throw error
    }
    await delay(wait)
    wait = Math.min(wait * 2, RENAME_RETRY_MAX_MS)
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isDirectory()
  } catch {
    return false
  }
}

/**
 * Replace `filename` with `content` in one observable step.
 *
 * The content is written to a random-suffix sibling opened with exclusive create
 * (so a symlink planted at the temp path is refused), then renamed over the
 * target. A reader therefore sees either the previous complete file or the new
 * complete file, never a partial one.
 */
export async function writeFileAtomic(
  filename: string,
  content: string,
  options: { mode?: number; dirMode?: number } = {},
): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode ?? 0o644, flag: 'wx' })
    await renameWithRetry(temp, filename)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw wrapFsError(error, FS_CODES.io, 'atomic write failed', filename)
  }
}

export interface LockOptions {
  /** How long to wait for an existing lock before giving up. */
  waitMs?: number
  /** A lock whose recorded pid is gone is taken over after this long. */
  staleMs?: number
}

/**
 * Serialise a read-modify-write cycle on `filename` across processes.
 *
 * A `wx`-created `<file>.lock` sibling records the holder pid; a lock whose
 * holder no longer exists is taken over. Readers stay lock-free because the
 * commit is an atomic rename.
 */
export async function withFileLock<T>(filename: string, operation: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const waitMs = options.waitMs ?? 2000
  const staleMs = options.staleMs ?? 30_000
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + waitMs
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let wait = 25

  for (;;) {
    try {
      handle = await open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce: randomUUID() }))
      break
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code !== 'EEXIST') {
        throw wrapFsError(error, FS_CODES.io, 'could not create the vault lock file', lockPath)
      }
      if (await isStaleLock(lockPath, staleMs)) {
        await rm(lockPath, { force: true }).catch(() => undefined)
        continue
      }
      if (Date.now() >= deadline) {
        throw new FsError(
          FS_CODES.busy,
          `another DSH process is writing ${filename}; the lock file ${lockPath} is still held`,
          lockPath,
        )
      }
      await delay(wait)
      wait = Math.min(wait * 2, 200)
    }
  }

  try {
    return await operation()
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath)
    if (Date.now() - info.mtimeMs > staleMs) return true
    const raw = await readFile(lockPath, 'utf8')
    const parsed = JSON.parse(raw) as { pid?: unknown }
    if (typeof parsed.pid !== 'number') return true
    return !isProcessAlive(parsed.pid)
  } catch {
    // An unreadable or vanished lock is treated as free; `open(wx)` re-checks.
    return true
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'EPERM'
  }
}

export async function readTextIfExists(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null
    throw wrapFsError(error, FS_CODES.io, 'could not read file', target)
  }
}

export async function statOrNull(target: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean } | null> {
  try {
    const info = await stat(target)
    return { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null
    throw wrapFsError(error, FS_CODES.io, 'could not stat path', target)
  }
}

export async function removeFile(target: string): Promise<void> {
  try {
    await unlink(target)
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return
    throw wrapFsError(error, FS_CODES.io, 'could not remove file', target)
  }
}

/** Recursively list files under `root` whose name ends with one of `extensions`. */
export async function listFiles(root: string, extensions: readonly string[], options: { maxDepth?: number; skipDirs?: readonly string[] } = {}): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 12
  const skip = new Set(options.skipDirs ?? ['.git', 'node_modules'])
  const out: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return
      throw wrapFsError(error, FS_CODES.io, 'could not list directory', dir)
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (extensions.some((extension) => lower.endsWith(extension))) out.push(full)
    }
  }

  await walk(root, 0)
  out.sort()
  return out
}

/**
 * Join a vault-relative path onto the vault root, refusing escapes.
 *
 * Both `..` traversal and absolute inputs are rejected, as are Windows drive
 * letters and UNC prefixes, so no caller can address a file outside the vault.
 */
export function safeJoin(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath) || relativePath.startsWith('\\\\')) {
    throw new FsError(FS_CODES.invalidPath, `expected a vault-relative path, received an absolute one: ${relativePath}`, relativePath)
  }
  const normalizedRelative = normalize(relativePath).replace(/^([.][/\\])+/, '')
  const target = resolve(root, normalizedRelative)
  const rootResolved = resolve(root)
  const rel = relative(rootResolved, target)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new FsError(FS_CODES.outsideVault, `path escapes the vault root: ${relativePath}`, target)
  }
  return target
}

/** Convert an absolute path inside `root` into the `/`-separated vault-relative form. */
export function toVaultRelative(root: string, absolute: string): string {
  const rel = relative(resolve(root), resolve(absolute))
  return rel.split(sep).join('/')
}

/** Characters that are illegal in a Windows file name. */
const ILLEGAL_NAME = /[\\/:*?"<>|\u0000-\u001f]/

export function assertSafeFileName(name: string): void {
  if (name.length === 0 || name.length > 200 || ILLEGAL_NAME.test(name) || name === '.' || name === '..') {
    throw new FsError(FS_CODES.invalidName, `unsafe file name: ${JSON.stringify(name)}`, name)
  }
}

function wrapFsError(error: unknown, code: FsCode, message: string, path: string): FsError {
  if (error instanceof FsError) return error
  const nodeCode = (error as { code?: unknown } | null)?.code
  const mapped: FsCode =
    nodeCode === 'ENOENT'
      ? FS_CODES.notFound
      : nodeCode === 'EACCES' || nodeCode === 'EPERM'
        ? FS_CODES.denied
        : code
  const detail = error instanceof Error ? error.message : String(error)
  return new FsError(mapped, `${message}: ${detail}`, path, { cause: error })
}
