/**
 * Index building, incremental synchronisation, and persistence.
 *
 * The index is a *derived* artefact: it can always be rebuilt from the Markdown
 * notes and deleting it loses nothing. It is persisted as JSON rather than
 * SQLite so that the plugin needs no native module, the file stays inspectable
 * by a human, and a partially written file can never be mistaken for valid data
 * (the read validates the shape and falls back to a rebuild).
 *
 * @module dsh-longterm-memory/host/core/indexing
 */

import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { TYPE_DESCRIPTORS, VAULT_DIRS, type JournalEntry } from '../../shared/types.js'
import { extractWikilinks } from '../../shared/markdown.js'
import {
  INDEX_FORMAT_VERSION,
  type IndexRecord,
  type MemoryIndex,
  checksum,
  deriveIndex,
  emptyIndex,
  fieldTokens,
  termWeights,
} from '../../shared/search.js'
import { FsError, ensureDir, readTextIfExists, statOrNull, writeFileAtomic } from './fsx.js'
import { layoutFor, type VaultLayout } from './layout.js'
import { scanVault, type LoadedDocument, type RejectedDocument } from './repository.js'

interface PersistedIndex {
  version: number
  builtAt: string
  vaultPath: string
  records: IndexRecord[]
}

export interface BuildIndexResult {
  index: MemoryIndex
  rejected: RejectedDocument[]
  ignored: number
  /** Ids carried by more than one file; see ScanResult.duplicates. */
  duplicates: { id: string; paths: string[] }[]
  /** Notes that were repaired during the build, with the repairs applied. */
  repaired: { id: string; relativePath: string; repairs: string[] }[]
  tookMs: number
}

/** Turn one parsed note into an index record. */
export function recordFromDocument(document: LoadedDocument): IndexRecord {
  const memory = document.memory
  const tokens = fieldTokens({
    title: memory.title,
    aliases: memory.aliases,
    tags: memory.tags,
    summary: memory.summary,
    // Section bodies are searchable, but the evidence block is metadata and is
    // folded into the body terms so it is findable without dominating ranking.
    body: [memory.sections.map((section) => `${section.heading}\n${section.body}`).join('\n'), memory.evidence].join('\n'),
  })
  return {
    id: memory.id,
    path: document.relativePath,
    type: memory.type,
    status: memory.status,
    title: memory.title,
    tags: [...memory.tags],
    aliases: [...memory.aliases],
    confidence: memory.confidence,
    importance: memory.importance,
    pinned: memory.pinned,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    preview: memory.summary.replace(/\s+/g, ' ').trim().slice(0, 320),
    terms: termWeights(tokens),
    links: [...new Set([...memory.related, ...extractWikilinks(document.raw)])],
    size: document.size,
    mtimeMs: document.mtimeMs,
    checksum: document.checksum,
  }
}

/** Build a complete index from the vault's Markdown. */
export async function buildIndex(root: string): Promise<BuildIndexResult> {
  const started = Date.now()
  const index = emptyIndex(root)
  const scan = await scanVault(root)
  const repaired: BuildIndexResult['repaired'] = []

  for (const document of scan.documents) {
    index.records.set(document.id, recordFromDocument(document))
    if (document.repairs.length > 0) {
      repaired.push({ id: document.id, relativePath: document.relativePath, repairs: document.repairs })
    }
  }
  index.builtAt = new Date().toISOString()
  deriveIndex(index)

  return { index, rejected: scan.rejected, ignored: scan.ignored, duplicates: scan.duplicates, repaired, tookMs: Date.now() - started }
}

export interface SyncResult {
  index: MemoryIndex
  added: string[]
  updated: string[]
  removed: string[]
  unchanged: number
  rejected: RejectedDocument[]
  duplicates: { id: string; paths: string[] }[]
  repaired: BuildIndexResult['repaired']
}

/**
 * Bring an existing index up to date without re-tokenising unchanged notes.
 *
 * A note whose content fingerprint is unchanged is left exactly as it was, so a
 * large vault syncs in one directory walk plus a few file reads.
 */
export async function syncIndex(root: string, index: MemoryIndex): Promise<SyncResult> {
  const scan = await scanVault(root)
  const seen = new Set<string>()
  const added: string[] = []
  const updated: string[] = []
  let unchanged = 0
  const repaired: BuildIndexResult['repaired'] = []
  let mutated = false

  for (const document of scan.documents) {
    seen.add(document.id)
    const existing = index.records.get(document.id)
    if (existing === undefined) {
      index.records.set(document.id, recordFromDocument(document))
      added.push(document.id)
      mutated = true
    } else if (existing.checksum !== document.checksum) {
      index.records.set(document.id, recordFromDocument(document))
      updated.push(document.id)
      mutated = true
    } else {
      // Content identical, but a human may have moved the file between folders.
      if (existing.path !== document.relativePath || existing.mtimeMs !== document.mtimeMs) {
        existing.path = document.relativePath
        existing.mtimeMs = document.mtimeMs
        existing.size = document.size
        mutated = true
      }
      unchanged += 1
    }
    if (document.repairs.length > 0) {
      repaired.push({ id: document.id, relativePath: document.relativePath, repairs: document.repairs })
    }
  }

  const removed: string[] = []
  for (const id of [...index.records.keys()]) {
    if (seen.has(id)) continue
    index.records.delete(id)
    removed.push(id)
    mutated = true
  }

  if (mutated || added.length > 0 || removed.length > 0 || updated.length > 0) {
    index.builtAt = new Date().toISOString()
    deriveIndex(index)
  }
  return { index, added, updated, removed, unchanged, rejected: scan.rejected, duplicates: scan.duplicates, repaired }
}

/** Ids whose file on disk no longer matches the indexed fingerprint. */
export async function detectOutOfSync(root: string, index: MemoryIndex): Promise<string[]> {
  const out: string[] = []
  for (const record of index.records.values()) {
    const absolute = join(root, record.path.split('/').join('\\'))
    const stat = await statOrNull(absolute)
    if (stat === null) {
      out.push(record.id)
      continue
    }
    if (stat.size !== record.size || stat.mtimeMs !== record.mtimeMs) out.push(record.id)
  }
  return out
}

/** Persist the index. Failure is reported but never blocks a write. */
export async function persistIndex(layout: VaultLayout, index: MemoryIndex): Promise<void> {
  const payload: PersistedIndex = {
    version: INDEX_FORMAT_VERSION,
    builtAt: index.builtAt,
    vaultPath: index.vaultPath,
    records: [...index.records.values()],
  }
  await ensureDir(layout.root)
  await writeFileAtomic(layout.index, `${JSON.stringify(payload)}\n`)
}

export type LoadIndexResult =
  | { ok: true; index: MemoryIndex; reason?: undefined }
  | { ok: false; index: null; reason: string }

/**
 * Load a persisted index.
 *
 * Every field that matters is checked before the file is trusted. A partial
 * write, a hand-edited file, a future format version, or an index built for a
 * different vault all resolve to `ok: false`, which the caller answers by
 * rebuilding from Markdown. This is why a corrupt index is never data loss.
 */
export async function loadIndex(layout: VaultLayout): Promise<LoadIndexResult> {
  const raw = await readTextIfExists(layout.index)
  if (raw === null) return { ok: false, index: null, reason: '索引文件不存在' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, index: null, reason: `索引文件不是合法 JSON：${describeError(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, index: null, reason: '索引文件结构不是对象' }
  }
  const candidate = parsed as Partial<PersistedIndex>
  if (candidate.version !== INDEX_FORMAT_VERSION) {
    return { ok: false, index: null, reason: `索引格式版本不匹配（文件 ${String(candidate.version)}，期望 ${String(INDEX_FORMAT_VERSION)}）` }
  }
  if (!Array.isArray(candidate.records)) return { ok: false, index: null, reason: '索引缺少 records 数组' }
  if (typeof candidate.vaultPath !== 'string') return { ok: false, index: null, reason: '索引缺少 vaultPath' }

  const index = emptyIndex(candidate.vaultPath)
  index.builtAt = typeof candidate.builtAt === 'string' ? candidate.builtAt : new Date().toISOString()
  for (const entry of candidate.records) {
    const record = validateRecord(entry)
    if (record === null) return { ok: false, index: null, reason: '索引中存在损坏的记录，已放弃该索引' }
    index.records.set(record.id, record)
  }
  deriveIndex(index)
  return { ok: true, index }
}

function validateRecord(value: unknown): IndexRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<IndexRecord>
  if (typeof record.id !== 'string' || record.id.length === 0) return null
  if (typeof record.path !== 'string' || typeof record.title !== 'string') return null
  if (typeof record.type !== 'string' || typeof record.status !== 'string') return null
  if (typeof record.updatedAt !== 'string' || typeof record.createdAt !== 'string') return null
  if (typeof record.checksum !== 'string') return null
  if (!Array.isArray(record.tags) || !Array.isArray(record.aliases) || !Array.isArray(record.links)) return null
  if (record.terms === null || typeof record.terms !== 'object' || Array.isArray(record.terms)) return null
  const terms: Record<string, number> = {}
  for (const [term, weight] of Object.entries(record.terms as Record<string, unknown>)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight)) return null
    terms[term] = weight
  }
  return {
    id: record.id,
    path: record.path,
    type: record.type,
    status: record.status,
    title: record.title,
    tags: record.tags.filter((tag): tag is string => typeof tag === 'string'),
    aliases: record.aliases.filter((alias): alias is string => typeof alias === 'string'),
    confidence: typeof record.confidence === 'string' ? record.confidence : 'medium',
    importance: typeof record.importance === 'number' ? record.importance : 50,
    pinned: record.pinned === true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preview: typeof record.preview === 'string' ? record.preview : '',
    terms,
    links: record.links.filter((link): link is string => typeof link === 'string'),
    size: typeof record.size === 'number' ? record.size : 0,
    mtimeMs: typeof record.mtimeMs === 'number' ? record.mtimeMs : 0,
    checksum: record.checksum,
  }
}

/** Record a rebuild in the journal so the human can see when it happened and why. */
export async function journalIndexEvent(layout: VaultLayout, entry: JournalEntry): Promise<void> {
  await ensureDir(layout.journalDir)
  const month = entry.at.slice(0, 7)
  await appendFile(join(layout.journalDir, `${month}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * Rewrite the human-readable index notes.
 *
 * These are the files a user browses in Obsidian, so they are regenerated
 * wholesale on every rebuild and clearly marked as generated.
 */
export async function writeIndexNotes(root: string, index: MemoryIndex): Promise<string[]> {
  const written: string[] = []
  const byType = new Map<string, IndexRecord[]>()
  for (const record of index.records.values()) {
    const bucket = byType.get(record.type)
    if (bucket === undefined) byType.set(record.type, [record])
    else bucket.push(record)
  }

  const sections: string[] = []
  for (const descriptor of Object.values(TYPE_DESCRIPTORS)) {
    const records = (byType.get(descriptor.type) ?? []).sort(byImportanceThenRecency)
    sections.push(`## ${descriptor.labelZh}（${String(records.length)}）`, '')
    if (records.length === 0) {
      sections.push('_（暂无）_', '')
      continue
    }
    for (const record of records) {
      sections.push(`- [[${record.title}]] — \`${record.id}\` · ${record.status} · ${record.updatedAt.slice(0, 10)}`)
    }
    sections.push('')
  }

  const allContent = renderGeneratedNote(
    '全部记忆',
    `共 ${String(index.records.size)} 条记忆，索引构建于 ${index.builtAt}。`,
    sections,
  )
  const allPath = join(root, VAULT_DIRS.index, 'all-memories.md')
  await writeFileAtomic(allPath, allContent)
  written.push('Index/all-memories.md')

  for (const descriptor of Object.values(TYPE_DESCRIPTORS)) {
    const records = (byType.get(descriptor.type) ?? []).sort(byImportanceThenRecency)
    const body: string[] = []
    if (records.length === 0) body.push('_（暂无）_', '')
    else {
      for (const record of records) {
        body.push(`- [[${record.title}]] — \`${record.id}\` · ${record.status} · ${record.updatedAt.slice(0, 10)}`)
        if (record.preview.length > 0) body.push(`  ${record.preview}`)
      }
      body.push('')
    }
    const path = join(root, VAULT_DIRS.index, `${descriptor.type}.md`)
    await writeFileAtomic(
      path,
      renderGeneratedNote(descriptor.labelZh, `共 ${String(records.length)} 条。`, body),
    )
    written.push(`Index/${descriptor.type}.md`)
  }

  return written
}

function renderGeneratedNote(title: string, subtitle: string, body: readonly string[]): string {
  return `---
generated_by: dsh-longterm-memory
generated_at: ${new Date().toISOString()}
---

# ${title}

> 本页由插件在重建索引时自动生成，手动修改会在下次重建时被覆盖。
> 记忆本身是独立的 Markdown 文件；本页只是便于浏览的索引。

${subtitle}

${body.join('\n')}
`
}

function byImportanceThenRecency(a: IndexRecord, b: IndexRecord): number {
  if (b.importance !== a.importance) return b.importance - a.importance
  const aTime = Date.parse(a.updatedAt)
  const bTime = Date.parse(b.updatedAt)
  if (bTime !== aTime) return bTime - aTime
  return a.title.localeCompare(b.title, 'zh-Hans-CN')
}

/** Export for callers that persist an index they built elsewhere. */
export { checksum }

/** Guard used by the service to ensure the vault has an index before a query. */
export async function assertIndexFile(layout: VaultLayout): Promise<void> {
  const stat = await statOrNull(layout.index)
  if (stat !== null && stat.isDirectory) {
    throw new FsError('FS_INVALID_PATH', `索引路径是一个目录而不是文件：${layout.index}`, layout.index)
  }
}

export { layoutFor }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
