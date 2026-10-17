/**
 * The Markdown repository: the only component allowed to write memory notes.
 *
 * Design rules enforced here:
 * - Markdown is the source of truth; nothing else may hold a fact.
 * - A write never widens into a folder rewrite: exactly one note per operation.
 * - Every mutation is atomic, journaled, and reversible in the sense that the
 *   previous content is recoverable from the change record's summary plus the
 *   note's own `history`.
 * - Concurrent writers cannot silently lose an edit: the file lock is taken for
 *   the read-modify-write cycle, and an expected-version check refuses a write
 *   over a file that changed underneath.
 *
 * @module dsh-longterm-memory/host/core/repository
 */

import { join } from 'node:path'
import { readdir, rm } from 'node:fs/promises'

import {
  TYPE_DESCRIPTORS,
  VAULT_DIRS,
  type JournalEntry,
  type Memory,
} from '../../shared/types.js'
import {
  FrontmatterError,
  extractWikilinks,
  parseMemoryDocument,
  renderMemory,
  renderMemoryPreservingBody,
  splitFrontmatter,
} from '../../shared/markdown.js'
import { looksLikeMemoryId, memoryFileName, normalizeMemory, nowIso } from '../../shared/validate.js'
import { INDEX_FORMAT_VERSION, checksum } from '../../shared/search.js'
import {
  FsError,
  ensureDir,
  listFiles,
  pathExists,
  readTextIfExists,
  removeFile,
  statOrNull,
  toVaultRelative,
  withFileLock,
  writeFileAtomic,
} from './fsx.js'
import { discardStaged, eventKeyOf, flushPending, isCommitted, markCommitted, pendingDir, readPending, reconcileHistory, stageEvent } from './journal-outbox.js'
import { layoutFor, relativePathFor, type VaultLayout } from './layout.js'

/** One parsed note together with where it lives. */
export interface LoadedDocument {
  id: string
  relativePath: string
  absolutePath: string
  memory: Memory
  raw: string
  size: number
  mtimeMs: number
  checksum: string
  repairs: string[]
}

/** A file that could not be turned into a memory. */
export interface RejectedDocument {
  relativePath: string
  absolutePath: string
  reason: string
}

export interface ScanResult {
  documents: LoadedDocument[]
  rejected: RejectedDocument[]
  /** Files that were skipped because they are not memory notes at all. */
  ignored: number
  /**
   * Ids carried by more than one file.
   *
   * A hand-copy, an interrupted move, or a restored backup can leave two notes
   * with one id. The index is keyed by id, so only one of them can be indexed;
   * surfacing the conflict lets the management page tell the user instead of
   * silently picking a winner.
   */
  duplicates: { id: string; paths: string[] }[]
}

const SCAN_EXTENSIONS = ['.md'] as const
const SCAN_SKIP_DIRS = ['.git', 'node_modules', '.obsidian', '.dsh-memory'] as const

/**
 * Walk the vault and parse every memory note.
 *
 * A note is recognised only when its frontmatter carries an `id` or its file
 * name ends in a memory id, so hand-written notes in the vault (README, index
 * pages, a user's own files) are left alone rather than reported as corrupt.
 */
export async function scanVault(root: string): Promise<ScanResult> {
  const documents: LoadedDocument[] = []
  const rejected: RejectedDocument[] = []
  let ignored = 0

  const roots = new Set<string>()
  for (const descriptor of Object.values(TYPE_DESCRIPTORS)) roots.add(join(root, descriptor.dir))
  roots.add(join(root, VAULT_DIRS.inbox))
  roots.add(join(root, VAULT_DIRS.archive))
  roots.add(join(root, VAULT_DIRS.conflicts))
  roots.add(root)

  const seen = new Set<string>()
  for (const base of roots) {
    const files = await listFiles(base, SCAN_EXTENSIONS, { skipDirs: SCAN_SKIP_DIRS, maxDepth: 4 })
    for (const absolute of files) {
      const key = absolute.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const relativePath = toVaultRelative(root, absolute)
      if (relativePath.startsWith(`${VAULT_DIRS.index}/`) || relativePath.startsWith(`${VAULT_DIRS.history}/`)) {
        ignored += 1
        continue
      }
      if (relativePath.startsWith('.dsh-memory/') || relativePath.startsWith('.obsidian/')) {
        ignored += 1
        continue
      }

      const raw = await readTextIfExists(absolute)
      if (raw === null) continue
      const stat = await statOrNull(absolute)
      const stem = relativePath.replace(/^.*\//, '').replace(/\.md$/i, '')
      let declaredId = looksLikeMemoryId(stem)
      let hasFrontmatterId = false
      try {
        const { meta } = splitFrontmatter(raw)
        if (typeof meta['id'] === 'string' && meta['id'].trim().length > 0) {
          declaredId = meta['id'].trim()
          hasFrontmatterId = true
        }
      } catch (error) {
        if (declaredId === null && error instanceof FrontmatterError) {
          ignored += 1
          continue
        }
      }
      if (declaredId === null && !hasFrontmatterId) {
        ignored += 1
        continue
      }

      try {
        const parsed = parseMemoryDocument(raw)
        const result = normalizeMemory(parsed.raw)
        if (!result.ok) {
          rejected.push({ relativePath, absolutePath: absolute, reason: result.reason })
          continue
        }
        documents.push({
          id: result.memory.id,
          relativePath,
          absolutePath: absolute,
          // Preserve what the plugin does not own: unknown frontmatter keys and the
          // original body, so a later field edit rewrites only the owned sections.
          memory: {
            ...result.memory,
            ...(Object.keys(parsed.unknownFrontmatter).length === 0
              ? {}
              : { extraFrontmatter: parsed.unknownFrontmatter }),
            preservedBody: parsed.body,
            preservedSource: raw,
          },
          raw,
          size: stat?.size ?? raw.length,
          mtimeMs: stat?.mtimeMs ?? 0,
          checksum: checksum(raw),
          repairs: result.repairs,
        })
      } catch (error) {
        rejected.push({ relativePath, absolutePath: absolute, reason: describeError(error) })
      }
    }
  }

  // Deterministic order so index builds are reproducible.
  documents.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  rejected.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))

  const duplicates: { id: string; paths: string[] }[] = []
  const byId = new Map<string, string[]>()
  for (const document of documents) {
    const bucket = byId.get(document.id)
    if (bucket === undefined) byId.set(document.id, [document.relativePath])
    else bucket.push(document.relativePath)
  }
  for (const [id, paths] of byId) {
    if (paths.length > 1) duplicates.push({ id, paths: paths.sort() })
  }
  duplicates.sort((a, b) => (a.id < b.id ? -1 : 1))

  return { documents, rejected, ignored, duplicates }
}

export interface WriteOptions {
  /** Refuse the write when the file's fingerprint differs (optimistic concurrency). */
  expectedChecksum?: string
  reason?: string
  source?: string
  /** Raw source edits keep the user's body byte-for-byte (frontmatter still canonical). */
  preserveBodyVerbatim?: boolean
}

export class MemoryRepository {
  readonly root: string
  readonly layout: VaultLayout

  constructor(root: string) {
    this.root = root
    this.layout = layoutFor(root)
  }

  async ensureDirectories(): Promise<void> {
    await ensureDir(this.root)
    for (const descriptor of Object.values(TYPE_DESCRIPTORS)) await ensureDir(join(this.root, descriptor.dir))
    for (const dir of [VAULT_DIRS.inbox, VAULT_DIRS.archive, VAULT_DIRS.conflicts, VAULT_DIRS.index, VAULT_DIRS.history]) {
      await ensureDir(join(this.root, dir))
    }
    await ensureDir(this.layout.journalDir)
    await ensureDir(this.layout.quarantineDir)
  }

  /** Locate a memory by id. Returns null when no note carries that id. */
  async load(id: string): Promise<LoadedDocument | null> {
    const scan = await this.scanFor(id)
    return scan
  }

  private async scanFor(id: string): Promise<LoadedDocument | null> {
    const result = await scanVault(this.root)
    return result.documents.find((document) => document.id === id) ?? null
  }

  /** Full scan; callers that need many ids should scan once. */
  async scan(): Promise<ScanResult> {
    return scanVault(this.root)
  }

  /**
   * Write a memory, creating it when absent.
   *
   * The file is placed by `type` + `status`, so a status change such as
   * `archive` physically moves the note to `Archive/` and the human sees the
   * change when browsing the vault.
   */
  async save(memory: Memory, options: WriteOptions = {}): Promise<{ document: LoadedDocument; created: boolean; movedFrom: string | null }> {
    await this.ensureDirectories()
    const rendered = options.preserveBodyVerbatim === true ? renderMemoryPreservingBody(memory) : renderMemory(memory)
    const target = await this.resolveTarget(memory)

    return withFileLock(target.absolutePath, async () => {
      const existing = await statOrNull(target.absolutePath)
      if (existing !== null) {
        const currentRaw = (await readTextIfExists(target.absolutePath)) ?? ''
        if (options.expectedChecksum !== undefined && checksum(currentRaw) !== options.expectedChecksum) {
          throw new FsError(
            'FS_BUSY',
            '文件已被其他程序修改，为避免覆盖您的编辑，本次写入被拒绝。请重新载入后再保存。',
            target.absolutePath,
          )
        }
      }
      await writeFileAtomic(target.absolutePath, rendered)
      const stat = await statOrNull(target.absolutePath)
      const document: LoadedDocument = {
        id: memory.id,
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        memory,
        raw: rendered,
        size: stat?.size ?? rendered.length,
        mtimeMs: stat?.mtimeMs ?? Date.now(),
        checksum: checksum(rendered),
        repairs: [],
      }

      // Remove a stale copy left behind when the note moved directory.
      let movedFrom: string | null = null
      const previous = await this.findPreviousPath(memory.id, target.relativePath)
      if (previous !== null) {
        await removeFile(previous.absolutePath)
        movedFrom = previous.relativePath
      }
      return { document, created: existing === null && movedFrom === null, movedFrom }
    })
  }

  /**
   * Find a *second* note carrying `id` that lives somewhere else.
   *
   * A status change moves a note between directories, so the write lands at the
   * new path while the old copy is still on disk. Returning `null` on the first
   * id match would leave that stale copy behind, and since the index is keyed by
   * id the stale copy could then win — exactly the situation this lookup exists
   * to prevent.
   */
  private async findPreviousPath(id: string, keepRelativePath: string): Promise<{ relativePath: string; absolutePath: string } | null> {
    const result = await scanVault(this.root)
    const keep = keepRelativePath.toLowerCase()
    for (const document of result.documents) {
      if (document.id !== id) continue
      if (document.relativePath.toLowerCase() === keep) continue
      return { relativePath: document.relativePath, absolutePath: document.absolutePath }
    }
    return null
  }

  /** Decide the on-disk location for a memory, avoiding collisions with other ids. */
  private async resolveTarget(memory: Memory): Promise<{ relativePath: string; absolutePath: string }> {
    // Prefer the note's current path when it is already correct, so ordinary
    // edits never move (and therefore never churn) a file.
    const result = await scanVault(this.root)
    const existing = result.documents.find((document) => document.id === memory.id)
    if (existing !== undefined) {
      const desired = relativePathFor(memory.type, memory.status, memoryFileName(memory))
      const desiredAbsolute = join(this.root, desired.split('/').join('\\'))
      if (existing.relativePath.toLowerCase() === desired.toLowerCase() || !(await pathExists(desiredAbsolute))) {
        return { relativePath: desired, absolutePath: desiredAbsolute }
      }
      return { relativePath: existing.relativePath, absolutePath: existing.absolutePath }
    }

    const taken = new Set(result.documents.map((document) => document.relativePath.toLowerCase()))
    const relativePath = relativePathFor(memory.type, memory.status, memoryFileName(memory), taken)
    return { relativePath, absolutePath: join(this.root, relativePath.split('/').join('\\')) }
  }

  /** Rewrite a note's raw text, validating it first. */
  async writeRaw(id: string, content: string, options: WriteOptions = {}): Promise<{ document: LoadedDocument; repairs: string[] }> {
    const parsed = parseMemoryDocument(content)
    const normalized = normalizeMemory(parsed.raw)
    if (!normalized.ok) {
      throw new FsError('FS_INVALID_NAME', `保存失败：元数据不合法（${normalized.reason}）`)
    }
    if (normalized.memory.id !== id) {
      throw new FsError(
        'FS_INVALID_NAME',
        `保存失败：文档中的 id（${normalized.memory.id}）与正在编辑的记忆（${id}）不一致。`,
      )
    }
    const saved = await this.save(
      {
        ...normalized.memory,
        ...(Object.keys(parsed.unknownFrontmatter).length === 0
          ? {}
          : { extraFrontmatter: parsed.unknownFrontmatter }),
        preservedBody: parsed.body,
        preservedSource: content,
      },
      { ...options, preserveBodyVerbatim: true },
    )
    return { document: saved.document, repairs: normalized.repairs }
  }

  /** Remove a memory note. Callers must have obtained explicit confirmation. */
  async remove(id: string, reason: string, source?: string, options: { skipJournal?: boolean } = {}): Promise<{ relativePath: string }> {
    const existing = await this.scanFor(id)
    if (existing === null) throw new FsError('FS_NOT_FOUND', `未找到记忆 ${id}`, this.root)
    await removeFile(existing.absolutePath)
    if (options.skipJournal === true) return { relativePath: existing.relativePath }
    await this.journal({
      at: nowIso(),
      op: 'delete',
      id,
      before: summarize(existing.memory),
      reason,
      ...(source === undefined ? {} : { source }),
    })
    return { relativePath: existing.relativePath }
  }

  /** Append one change record. Journal lines are append-only. */
  /**
   * Record one history event.
   *
   * The event is staged durably first (outbox), then archived to the monthly JSONL.
   * If archiving fails, the event remains staged and the operation still counts as
   * committed — the history is safe and `history()` will surface it. If staging
   * itself fails, this throws: no durable history could be secured.
   */
  async journal(entry: JournalEntry): Promise<void> {
    // Generic callers journal *after* their domain write, so the event describes an
    // operation that has already committed: stage it, promote it, then archive.
    const eventId = await stageEvent(this.layout, entry as never)
    await markCommitted(this.layout, eventId)
    await flushPending(this.layout)
  }

  /**
   * Persist a history event *before* the domain write it describes.
   *
   * This is what keeps the commit boundary honest: if the history event cannot be
   * made durable, the caller aborts before touching authoritative data.
   */
  async stageJournal(entry: JournalEntry): Promise<string> {
    return await stageEvent(this.layout, entry as never)
  }

  /**
   * Render exactly the bytes `writeRaw` would persist for this content.
   *
   * writeRaw re-renders the document (canonical frontmatter plus a spliced body), so the
   * caller cannot use the raw input checksum as its "after" state. Recovery needs the
   * checksum of the bytes that will actually land on disk.
   */
  previewRawContent(content: string): string {
    const parsed = parseMemoryDocument(content)
    const normalized = normalizeMemory(parsed.raw)
    if (!normalized.ok) {
      throw new FsError('FS_INVALID_NAME', `保存失败：元数据不合法（${normalized.reason}）`)
    }
    return renderMemoryPreservingBody({
      ...normalized.memory,
      ...(Object.keys(parsed.unknownFrontmatter).length === 0 ? {} : { extraFrontmatter: parsed.unknownFrontmatter }),
      preservedBody: parsed.body,
      preservedSource: content,
    })
  }
    /** Persist a multi-record operation plan before any domain write. */
  async stageOperation(plan: Record<string, unknown>): Promise<void> {
    const operationId = String(plan['operationId'])
    await writeFileAtomic(
      join(pendingDir(this.layout), `${operationId}.json`),
      `${JSON.stringify({ state: 'prepared', kind: 'operation', operationId, at: plan['at'], id: operationId, plan })}\n`,
    )
  }

  /** Read every persisted operation plan (for forward recovery). */
  async readOperationPlans(): Promise<Record<string, unknown>[]> {
    const dir = pendingDir(this.layout)
    const names = await readdir(dir).catch(() => [] as string[])
    const plans: Record<string, unknown>[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const raw = await readTextIfExists(join(dir, name))
      if (raw === null) continue
      try {
        const parsed = JSON.parse(raw) as { kind?: string; plan?: Record<string, unknown> }
        if (parsed.kind === 'operation' && parsed.plan !== undefined) plans.push(parsed.plan)
      } catch {
        // Unparseable files are reported by the pending-history integrity check.
      }
    }
    return plans
  }

  /** Remove an operation plan after it is fully applied and archived. */
  async clearOperation(operationId: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(operationId) || operationId.includes('..')) {
      throw new FsError('FS_INVALID_NAME', `操作标识非法，拒绝删除暂存计划：${operationId}`, this.root)
    }
    await rm(join(pendingDir(this.layout), `${operationId}.json`), { force: true })
  }

  /** Surface an operation-level conflict through history(). */
  noteConflict(message: string): void {
    this.journalConflicts.push(message)
  }
/** Checksum of a vault-relative file, or null when it does not exist. */
  async checksumAt(relativePath: string): Promise<string | null> {
    const segments = relativePath.split('/')
    if (relativePath.startsWith('/') || segments.includes('..') || segments.includes('')) {
      throw new FsError('FS_INVALID_NAME', `拒绝非法的仓库相对路径：${relativePath}`, this.root)
    }
    const raw = await readTextIfExists(join(this.root, ...segments))
    return raw === null ? null : checksum(raw)
  }
  /** The path a save would target, computed without writing (used for commit metadata). */
  predictSavePath(memory: Memory): string {
    return relativePathFor(memory.type, memory.status, memoryFileName(memory))
  }

  /**
   * Recover PREPARED save intents after a crash.
   *
   * A PREPARED event records the target relative path and the checksums of the state
   * before and after the write. Comparing the *current* file content decides the
   * outcome without re-performing any domain write:
   * - matches "after"  → the write committed; promote the history event;
   * - matches "before" (or both absent) → nothing was written; abort the intent;
   * - anything else → CONFLICT: keep the evidence and refuse to guess.
   */
  async recoverPreparedSaves(): Promise<void> {
    const { events } = await readPending(this.layout)
    this.journalConflicts = []
    for (const event of events) {
      if (event.state !== 'prepared') continue
      const saveMeta = (event as { saveMetadata?: { path?: string; before?: string | null; after?: string } }).saveMetadata
      if (typeof saveMeta?.path === 'string' && typeof saveMeta.after === 'string') {
        const actual = await this.checksumAt(saveMeta.path)
        const before = typeof saveMeta.before === 'string' ? saveMeta.before : null
        if (actual === saveMeta.after) await markCommitted(this.layout, eventKeyOf(event))
        else if (actual === before) await discardStaged(this.layout, eventKeyOf(event))
        else this.journalConflicts.push(`${eventKeyOf(event)}: 内容既不匹配操作前也不匹配操作后状态`)
        continue
      }
      const commitMeta = (event as { commitMetadata?: { kind?: string; path?: string; from?: string; to?: string; before?: string | null; after?: string } }).commitMetadata
      if (commitMeta === undefined) continue
      if (commitMeta.kind === 'write' && typeof commitMeta.path === 'string' && typeof commitMeta.after === 'string') {
        const actual = await this.checksumAt(commitMeta.path)
        const before = typeof commitMeta.before === 'string' ? commitMeta.before : null
        if (actual === commitMeta.after) await markCommitted(this.layout, eventKeyOf(event))
        else if (actual === before) await discardStaged(this.layout, eventKeyOf(event))
        else this.journalConflicts.push(`${eventKeyOf(event)}: 写入目标内容无法判定`)
        continue
      }
      if (commitMeta.kind === 'move' && typeof commitMeta.from === 'string' && typeof commitMeta.to === 'string') {
        const target = await this.checksumAt(commitMeta.to)
        const source = await this.checksumAt(commitMeta.from)
        if (typeof commitMeta.after === 'string' && target === commitMeta.after) await markCommitted(this.layout, eventKeyOf(event))
        else if (source !== null && source === commitMeta.before && target === null) await discardStaged(this.layout, eventKeyOf(event))
        else this.journalConflicts.push(`${eventKeyOf(event)}: 状态迁移的原/目标文件组合无法判定`)
        continue
      }
      if (commitMeta.kind === 'remove' && typeof commitMeta.path === 'string') {
        const actual = await this.checksumAt(commitMeta.path)
        if (actual === null) await markCommitted(this.layout, eventKeyOf(event))
        else if (typeof commitMeta.before === 'string' && actual === commitMeta.before) await discardStaged(this.layout, eventKeyOf(event))
        else this.journalConflicts.push(`${eventKeyOf(event)}: 删除目标仍存在且内容与预期不符`)
      }

    }
  }

  /** Conflicts found by recovery; history refuses to look complete while any exist. */
  private journalConflicts: string[] = []
  hasJournalConflicts(): boolean {
    return this.journalConflicts.length > 0
  }  /** Promote a pre-staged event to committed history after the domain write. */
  async commitJournal(eventId: string): Promise<boolean> {
    return await markCommitted(this.layout, eventId)
  }

  /** Drop a pre-staged event because its domain operation failed. */
  async discardJournal(eventId: string): Promise<void> {
    await discardStaged(this.layout, eventId)
  }
  /** Finish archiving any staged events (called on startup and before history reads). */
  async flushJournal(): Promise<void> {
    const result = await flushPending(this.layout)
    for (const eventId of result.conflicts) {
      this.journalConflicts.push(`eventId ${eventId}: 月度归档与暂存事件内容不一致`)
    }
  }

  /** Read change records, optionally restricted to one memory id. */
  async history(id: string | undefined, limit: number): Promise<JournalEntry[]> {
    await this.flushJournal()
    // A corrupt staged event means history may be incomplete. Report it instead of
    // returning a normal-looking result; the original file is never deleted.
    if (this.journalConflicts.length > 0) {
      throw new FsError(
        'FS_IO',
        `历史记录存在未解决的提交冲突（${String(this.journalConflicts.length)} 项）：${this.journalConflicts.join('；')}。原始证据已保留，请人工核对。`,
        this.layout.journalDir,
      )
    }
    const pendingState = await readPending(this.layout)
    if (pendingState.corrupt.length > 0) {
      throw new FsError(
        'FS_IO',
        `历史记录不完整：${String(pendingState.corrupt.length)} 个暂存事件无法解析（${pendingState.corrupt.join(', ')}）。原始文件已保留，请人工检查 journal-pending 目录。`,
        this.layout.journalDir,
      )
    }
    const files = await listFiles(this.layout.journalDir, ['.jsonl'], { maxDepth: 1 })
    files.sort()
    files.reverse()
    const out: JournalEntry[] = []
    for (const file of files) {
      const raw = await readTextIfExists(file)
      if (raw === null) continue
      const lines = raw.split('\n')
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]
        if (line === undefined || line.trim().length === 0) continue
        try {
          const parsed = JSON.parse(line) as JournalEntry
          if (id !== undefined && parsed.id !== id) continue
          out.push(parsed)
          if (out.length >= limit) return out
        } catch {
          // A torn final line (a crash between write and flush) is skipped.
        }
      }
    }
    // Reconcile archived vs pending: identical copies merge, differing copies are a
    // CONFLICT (never silently pick a version); legacy events without ids stay as-is.
    const pendingForHistory = await readPending(this.layout)
    const reconciled = reconcileHistory(out as never, pendingForHistory.events.filter(isCommitted) as never)
    if (reconciled.conflicts.length > 0) {
      throw new FsError(
        'FS_IO',
        `历史记录存在冲突：eventId ${reconciled.conflicts.join(', ')} 的副本内容不一致。原始数据已保留，请人工核对。`,
        this.layout.journalDir,
      )
    }
    return reconciled.events.slice(0, limit) as JournalEntry[]
  }
}

/** A short, human-readable digest of a memory, stored instead of full text. */
export function summarize(memory: Pick<Memory, 'title' | 'summary' | 'status' | 'type'>): string {
  const summary = memory.summary.replace(/\s+/g, ' ').trim()
  const clipped = summary.length > 160 ? `${summary.slice(0, 160)}…` : summary
  return `[${memory.type}/${memory.status}] ${memory.title} :: ${clipped}`
}

/** Export the search-index format version so callers can compare. */
export const CURRENT_INDEX_VERSION = INDEX_FORMAT_VERSION

/** Read every `[[wikilink]]` in a memory's raw text; used by the indexer. */
export { extractWikilinks }

/** Convenience: the absolute path a memory's note should have. */
export function noteAbsolutePath(root: string, relativePath: string): string {
  return join(root, relativePath.split('/').join('\\'))
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
