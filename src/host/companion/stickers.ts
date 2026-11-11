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

import { VAULT_DIRS } from '../../shared/types.js'
import { writeFileAtomic } from '../core/fsx.js'

export const STICKER_LIBRARY_CONTRACT = 'sticker-library@v1'
export const STICKER_CATALOG_FILE = 'catalog.json'

export const STICKER_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] as const
export const STICKER_MAX_BYTES = 5 * 1024 * 1024
export const STICKER_TAG_LIMIT = 12
export const STICKER_DESC_LIMIT = 200

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
}

interface StickerCatalogFile {
  schemaVersion: 1
  stickers: StickerRecord[]
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
    input: { description?: string; tags?: string[] } = {},
  ): Promise<StickerImportOutcome> {
    const root = this.rootDir
    if (root === null) return { ok: false, reason: 'vault not ready' }
    if (bytes.length === 0) return { ok: false, reason: 'empty file' }
    if (bytes.length > STICKER_MAX_BYTES) return { ok: false, reason: `file exceeds ${String(STICKER_MAX_BYTES)} bytes` }
    const sniffed = detectImageExt(bytes)
    if (sniffed === null) return { ok: false, reason: 'unsupported image format' }
    const declared = extname(fileName).replace('.', '').toLowerCase()
    if (declared.length > 0 && !(STICKER_EXTS as readonly string[]).includes(declared)) {
      return { ok: false, reason: `unsupported extension: ${declared}` }
    }
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
    return this.patch(id, (s) => ({ ...s, usedCount: s.usedCount + 1 }))
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

