/**
 * Sticker library owned by the Vault (`Companion/Stickers/`).
 *
 * Design §八.2 put the library in the QQ plugin's own media directory. That
 * works for sending but breaks the PC management page: with the QQ plugin not
 * loaded (or not yet rebuilt), the page had nothing to read and showed
 * "life-agent@v1 not found". The library is product configuration, exactly like
 * `Persona.md`, so it belongs next to it:
 *
 *     Companion/Stickers/catalog.json     metadata (same schema as the plugin)
 *     Companion/Stickers/<sha256>.<ext>   image bytes
 *
 * `Companion/` is already excluded from `scanVault`, so images and their
 * catalogue can never be recalled as long-term facts — the reason the earlier
 * design kept them out of the vault still holds.
 *
 * The catalogue format is byte-compatible with the QQ plugin's
 * `src/stickers/metadata.ts` (schemaVersion 1, id === sha256), so the plugin can
 * read the same directory instead of keeping a second library.
 */
import { createHash } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

import {
  DEFAULT_STICKER_POLICY, EMPTY_POLICY_STATE, chooseSticker, normalizePolicy, normalizePolicyState, noteSend,
} from '../../shared/sticker-pick.js'
import type { StickerPolicy, StickerPolicyState, StickerQuery } from '../../shared/sticker-pick.js'
import { VAULT_DIRS } from '../../shared/types.js'
import { writeFileAtomic } from '../core/fsx.js'

export const STICKER_LIBRARY_CONTRACT = 'sticker-library@v1'
export const STICKER_CATALOG_FILE = 'catalog.json'
/** Policy lives beside the catalogue; the QQ plugin ignores files it does not know. */
export const STICKER_POLICY_FILE = 'policy.json'

export const STICKER_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] as const
export const STICKER_MAX_BYTES = 5 * 1024 * 1024
export const STICKER_TAG_LIMIT = 12
export const STICKER_DESC_LIMIT = 200

/** Where a row came from. Optional so old catalogues keep loading unchanged. */
export type StickerSource = 'import' | 'incoming' | 'stolen' | 'other'

export interface StickerRecord {
  id: string
  file: string
  ext: string
  bytes: number
  sha256: string
  description: string
  tags: string[]
  favorite: boolean
  enabled: boolean
  addedAt: string
  usedCount: number
  /** Last time the model actually sent this one; drives the "just used" penalty. */
  lastUsedAt?: string
  /** Provenance, for the library UI ("来自聊天" vs "手动导入"). */
  source?: StickerSource
}

interface StickerCatalogFile {
  schemaVersion: 1
  stickers: StickerRecord[]
}

interface StickerPolicyFile {
  schemaVersion: 1
  policy: StickerPolicy
  state: StickerPolicyState
}

const SAFE_BASENAME = /^[A-Za-z0-9._-]+$/
const ID_PATTERN = /^[a-f0-9]{64}$/

export function isSafeStickerFile(name: string): boolean {
  if (!SAFE_BASENAME.test(name) || name === '.' || name === '..') return false
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return (STICKER_EXTS as readonly string[]).includes(ext)
}

/** Magic-byte check: an upload must be an image, not a renamed executable. */
export function detectImageExt(bytes: Uint8Array): string | null {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  return null
}

export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0 && t.length <= 40))]
    .slice(0, STICKER_TAG_LIMIT)
}

function isRecord(value: unknown): value is StickerRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r['id'] === 'string' && ID_PATTERN.test(r['id'])
    && typeof r['file'] === 'string' && isSafeStickerFile(r['file'])
    && typeof r['ext'] === 'string'
    && typeof r['bytes'] === 'number' && r['bytes'] > 0 && r['bytes'] <= STICKER_MAX_BYTES
    && typeof r['sha256'] === 'string' && r['sha256'] === r['id']
    && typeof r['description'] === 'string' && r['description'].length <= STICKER_DESC_LIMIT
    && Array.isArray(r['tags']) && r['tags'].length <= STICKER_TAG_LIMIT
    && r['tags'].every((t) => typeof t === 'string' && t.length <= 40)
    && typeof r['favorite'] === 'boolean'
    && typeof r['enabled'] === 'boolean'
    && typeof r['addedAt'] === 'string'
    && typeof r['usedCount'] === 'number' && r['usedCount'] >= 0
}

/** Invalid rows are dropped and counted; a corrupt file never crashes the page. */
export function parseCatalog(raw: unknown): { stickers: StickerRecord[]; dropped: number } {
  if (raw === null || typeof raw !== 'object') return { stickers: [], dropped: 0 }
  const obj = raw as Record<string, unknown>
  if (obj['schemaVersion'] !== 1 || !Array.isArray(obj['stickers'])) return { stickers: [], dropped: 0 }
  const valid = obj['stickers'].filter(isRecord) as StickerRecord[]
  const seen = new Set<string>()
  const unique = valid.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
  return { stickers: unique, dropped: obj['stickers'].length - unique.length }
}

/** `开心_猫猫.png` → `开心 猫猫`; falls back to a neutral label. */
export function describeFromFileName(fileName: string): string {
  const raw = basename(fileName, extname(fileName))
  const text = raw.replace(/[_\-+.]+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim()
  return text.length === 0 ? '未命名表情' : text.slice(0, STICKER_DESC_LIMIT)
}

export type StickerImportOutcome =
  | { ok: true; record: StickerRecord; duplicate: boolean }
  | { ok: false; reason: string }

export interface StickerStoreOptions {
  vaultPath: () => string | null | undefined
  logger?: { warn: (message: string, ...rest: unknown[]) => void }
  now?: () => Date
}

export class StickerStore {
  readonly contract = STICKER_LIBRARY_CONTRACT
  private stickers: StickerRecord[] = []
  private dropped = 0
  private loaded = false
  private chain: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date

  constructor(private readonly options: StickerStoreOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** Absolute directory, or null while the vault is not resolved. */
  get rootDir(): string | null {
    const vault = this.options.vaultPath()
    if (vault === undefined || vault === null || vault.trim().length === 0) return null
    return join(resolve(vault), VAULT_DIRS.companion, 'Stickers')
  }

  get available(): boolean { return this.rootDir !== null }
  get droppedCount(): number { return this.dropped }

  /** Synchronous snapshot for `StickerSender`, which walks candidates per turn. */
  list(): StickerRecord[] { return [...this.stickers] }
  enabled(): StickerRecord[] { return this.stickers.filter((s) => s.enabled) }
  get(id: string): StickerRecord | undefined { return this.stickers.find((s) => s.id === id) }
  hasHash(hash: string): boolean { return this.stickers.some((s) => s.sha256 === hash) }

  /**
   * Re-read the catalogue from disk. Called on plugin start and by the QQ side
   * before each send so an import from the PC page is visible immediately.
   */
  async load(): Promise<StickerRecord[]> {
    const root = this.rootDir
    if (root === null) { this.stickers = []; this.loaded = false; return [] }
    let raw: unknown = null
    try {
      raw = JSON.parse(await readFile(join(root, STICKER_CATALOG_FILE), 'utf8')) as unknown
    } catch {
      raw = null // missing or corrupt → empty list, never a crash
    }
    const parsed = parseCatalog(raw)
    this.stickers = parsed.stickers
    this.dropped = parsed.dropped
    this.loaded = true
    return this.list()
  }

  async refresh(): Promise<StickerRecord[]> { return this.load() }

  /** Import exactly one image. Same bytes twice returns `duplicate: true`. */
  async importBytes(
    bytes: Uint8Array,
    fileName: string,
    input: { description?: string; tags?: string[]; source?: StickerSource } = {},
  ): Promise<StickerImportOutcome> {
    const root = this.rootDir
    if (root === null) return { ok: false, reason: 'vault not ready' }
    if (bytes.length === 0) return { ok: false, reason: 'empty file' }
    if (bytes.length > STICKER_MAX_BYTES) return { ok: false, reason: `file exceeds ${String(STICKER_MAX_BYTES)} bytes` }
    const sniffed = detectImageExt(bytes)
    if (sniffed === null) return { ok: false, reason: 'unsupported image format' }
    const declared = extname(fileName).replace('.', '').toLowerCase()
    // The declared extension is advisory, never a gate.
    //
    // Chat platforms save images under names like `1234_abc.image` (OneBot/QQ)
    // that are not in the whitelist, and rejecting those made auto-collection
    // fail on every real message. The magic bytes are authoritative: `sniffed`
    // is non-null at this point, so the stored name is always `<sha256>.<sniffed>`
    // and a renamed executable is still refused above.
    const ext = sniffed === 'jpg' && declared === 'jpeg' ? 'jpeg' : sniffed
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const file = `${sha256}.${ext}`

    if (this.hasHash(sha256)) {
      const existing = this.get(sha256)
      if (existing !== undefined) return { ok: true, record: existing, duplicate: true }
    }

    const record: StickerRecord = {
      id: sha256,
      file,
      ext,
      bytes: bytes.length,
      sha256,
      description: (input.description?.trim() || describeFromFileName(fileName)).slice(0, STICKER_DESC_LIMIT),
      tags: normalizeTags(input.tags ?? []),
      favorite: false,
      enabled: true,
      addedAt: this.now().toISOString(),
      usedCount: 0,
      ...(input.source === undefined ? {} : { source: input.source }),
    }

    // Bytes first, then the row: a crash in between leaves an orphan file,
    // never a row pointing at a file that does not exist.
    await writeFileAtomic(join(root, file), bytes)
    this.stickers = [...this.stickers.filter((s) => s.id !== record.id), record]
    await this.save()
    return { ok: true, record, duplicate: false }
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.patch(id, (s) => ({ ...s, enabled }))
  }

  async setFavorite(id: string, favorite: boolean): Promise<boolean> {
    return this.patch(id, (s) => ({ ...s, favorite }))
  }

  /**
   * Rewrite the row's own metadata.
   *
   * Tags are how the QQ side decides which sticker fits a mood, and the tags a
   * user typed at import time are frequently wrong for some of the files in a
   * batch. Without this, the only cure is delete-and-re-import, which also loses
   * the usage count — so editing one row in place is the cheaper operation, and
   * it stays per-id like every other sticker mutation.
   */
  async setMeta(id: string, input: { description?: string; tags?: string[] }): Promise<boolean> {
    return this.patch(id, (s) => ({
      ...s,
      ...(input.description === undefined
        ? {}
        : { description: input.description.trim().slice(0, STICKER_DESC_LIMIT) }),
      ...(input.tags === undefined ? {} : { tags: normalizeTags(input.tags) }),
    }))
  }

  async recordUse(id: string): Promise<boolean> {
    const at = this.now().toISOString()
    return this.patch(id, (s) => ({ ...s, usedCount: s.usedCount + 1, lastUsedAt: at }))
  }

  /**
   * Read the send policy, falling back to the conservative defaults.
   *
   * Kept out of `catalog.json` on purpose: that file is shared byte-for-byte
   * with the QQ plugin, and putting our own keys in it would be the first step
   * towards the two sides disagreeing about the schema.
   */
  async readPolicyFile(): Promise<{ policy: StickerPolicy; state: StickerPolicyState }> {
    const root = this.rootDir
    if (root === null) return { policy: { ...DEFAULT_STICKER_POLICY }, state: { ...EMPTY_POLICY_STATE } }
    let raw: unknown = null
    try {
      raw = JSON.parse(await readFile(join(root, STICKER_POLICY_FILE), 'utf8')) as unknown
    } catch {
      raw = null
    }
    const obj = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    return { policy: normalizePolicy(obj['policy']), state: normalizePolicyState(obj['state']) }
  }

  async writePolicyFile(policy: StickerPolicy, state: StickerPolicyState): Promise<void> {
    const root = this.rootDir
    if (root === null) return
    const body: StickerPolicyFile = { schemaVersion: 1, policy, state }
    await writeFileAtomic(join(root, STICKER_POLICY_FILE), `${JSON.stringify(body, null, 2)}\n`)
  }

  /** Absolute path of one sticker's bytes, or null when the row is unknown. */
  pathOf(id: string): string | null {
    const root = this.rootDir
    const record = this.get(id)
    if (root === null || record === undefined) return null
    return join(root, record.file)
  }

  /**
   * Pick a sticker for a mood, enforcing the send policy.
   *
   * The catalogue is re-read first: the QQ side writes the same file, so a stale
   * in-memory copy could pick a row the user just deleted. On success the use is
   * recorded and the rolling counter advanced — the caller may still fail to
   * send, but counting the attempt keeps a retry loop from draining the library.
   */
  async pick(query: StickerQuery): Promise<
    | { ok: true; id: string; path: string; description: string; tags: string[]; reason: string }
    | { ok: false; blocked: string; reason: string; retryAt?: string }
  > {
    await this.load()
    const { policy, state } = await this.readPolicyFile()
    const now = this.now().getTime()
    const decision = chooseSticker(this.stickers, query, policy, state, now)
    if (!decision.ok) {
      return {
        ok: false,
        blocked: decision.blocked,
        reason: decision.reason,
        ...(decision.retryAt === undefined ? {} : { retryAt: decision.retryAt }),
      }
    }
    const record = this.get(decision.id)
    const path = this.pathOf(decision.id)
    if (record === undefined || path === null) {
      return { ok: false, blocked: 'empty', reason: '挑中的表情已不存在，可能刚被删除。' }
    }
    await this.recordUse(record.id)
    await this.writePolicyFile(policy, noteSend(state, now))
    return { ok: true, id: record.id, path, description: record.description, tags: record.tags, reason: decision.reason }
  }

  /** Import from a local file path (the shape a chat media cache gives us). */
  async importPath(
    absolutePath: string,
    input: { description?: string; tags?: string[]; source?: StickerSource } = {},
  ): Promise<StickerImportOutcome> {
    const info = await stat(absolutePath).catch(() => null)
    if (info === null || !info.isFile()) return { ok: false, reason: 'file not found' }
    if (info.size > STICKER_MAX_BYTES) return { ok: false, reason: `file exceeds ${String(STICKER_MAX_BYTES)} bytes` }
    const bytes = await readFile(absolutePath)
    return this.importBytes(new Uint8Array(bytes), basename(absolutePath), input)
  }

  /** Removes the row and, best-effort, the image file it points at. */
  async remove(id: string): Promise<boolean> {
    const root = this.rootDir
    if (root === null) return false
    const record = this.get(id)
    if (record === undefined) return false
    this.stickers = this.stickers.filter((s) => s.id !== id)
    await this.save()
    try { await rm(join(root, record.file)) } catch { /* row already gone is fine */ }
    return true
  }

  /** Drop rows whose image file disappeared (user cleaned the folder). */
  async pruneMissing(): Promise<number> {
    const root = this.rootDir
    if (root === null || !this.loaded) return 0
    const kept: StickerRecord[] = []
    for (const record of this.stickers) {
      try {
        const info = await stat(join(root, record.file))
        if (info.isFile()) kept.push(record)
      } catch { /* missing → drop */ }
    }
    const removed = this.stickers.length - kept.length
    if (removed > 0) {
      this.stickers = kept
      await this.save()
    }
    return removed
  }

  private async patch(id: string, change: (s: StickerRecord) => StickerRecord): Promise<boolean> {
    if (this.rootDir === null) return false
    const index = this.stickers.findIndex((s) => s.id === id)
    if (index < 0) return false
    const next = [...this.stickers]
    next[index] = change(next[index]!)
    this.stickers = next
    await this.save()
    return true
  }

  /** Serialised atomic write of the whole catalogue. */
  private save(): Promise<void> {
    const root = this.rootDir
    if (root === null) return Promise.resolve()
    const body: StickerCatalogFile = { schemaVersion: 1, stickers: this.stickers }
    const run = this.chain.catch(() => undefined).then(async () => {
      await writeFileAtomic(join(root, STICKER_CATALOG_FILE), `${JSON.stringify(body, null, 2)}\n`)
    })
    this.chain = run
    return run
  }
}

