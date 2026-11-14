/**
 * Shared reminder store (design WP-5: "提醒属于共享的个人事项").
 *
 * Reminders are *not* long-term facts, so they do not live in the memory index.
 * They are still shared state — the PC page and the QQ delivery runtime must see
 * the same list — so they get a deterministic Markdown home inside the vault:
 *
 *     Reminders/<id>.md              frontmatter = machine state, body = note
 *
 * Markdown is chosen over a single JSON blob for the same reasons the rest of
 * the vault uses it: a human can read and edit it in Obsidian, a diff is
 * meaningful, and one file per reminder keeps every write atomic without
 * rewriting the whole list.
 *
 * The whole `Reminders/` tree is excluded from `scanVault` (see repository.ts), so a
 * reminder can never be recalled as a "fact".
 *
 * @module dsh-longterm-memory/host/tasks/reminder-store
 */

import { readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { joinFrontmatter, splitFrontmatter } from '../../shared/markdown.js'
import { DEFAULT_REMINDER_POLICY, normalizeReminderPolicy } from '../../shared/reminder-policy.js'
import type { ReminderPolicy } from '../../shared/reminder-policy.js'
import { writeFileAtomic } from '../core/fsx.js'

export const REMINDER_STORE_CONTRACT = 'reminder-store@v1'

export type ReminderStatus = 'pending' | 'done' | 'cancelled'
export type ReminderDelivery = 'waiting' | 'deferred' | 'delivered'
export interface ReminderRepeat {
  unit: 'day' | 'week' | 'month'
  interval: number
}

/** Wire-compatible with the QQ plugin's `Reminder` type. */
export interface ReminderRecord {
  id: string
  title: string
  note: string
  dueAt: string
  status: ReminderStatus
  repeat: ReminderRepeat | null
  scope: 'shared'
  createdAt: string
  updatedAt: string
  delivery: ReminderDelivery
  attempts: number
  lastAttemptAt: string | null
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
/** Beside the notes, never read as one (load() filters `*.md`). */
export const REMINDER_POLICY_FILE = 'policy.json'
const STATUSES: readonly string[] = ['pending', 'done', 'cancelled']
const DELIVERIES: readonly string[] = ['waiting', 'deferred', 'delivered']
const UNITS: readonly string[] = ['day', 'week', 'month']

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function readRepeat(value: unknown): ReminderRepeat | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const unit = r['unit']
  const interval = r['interval']
  if (typeof unit !== 'string' || !UNITS.includes(unit)) return null
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > 365) return null
  return { unit: unit as ReminderRepeat['unit'], interval }
}

/** Validate a record that may come from disk or from the QQ plugin. */
export function isReminderRecord(value: unknown): value is ReminderRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r['id'] === 'string' && ID_PATTERN.test(r['id'])
    && typeof r['title'] === 'string' && r['title'].trim().length > 0 && r['title'].length <= 200
    && typeof r['note'] === 'string' && r['note'].length <= 1000
    && isInstant(r['dueAt']) && isInstant(r['createdAt']) && isInstant(r['updatedAt'])
    && typeof r['status'] === 'string' && STATUSES.includes(r['status'])
    && typeof r['delivery'] === 'string' && DELIVERIES.includes(r['delivery'])
    && r['scope'] === 'shared'
    && (r['repeat'] === null || readRepeat(r['repeat']) !== null)
    && typeof r['attempts'] === 'number' && Number.isInteger(r['attempts']) && r['attempts'] >= 0
    && (r['lastAttemptAt'] === null || isInstant(r['lastAttemptAt']))
}

export interface ReminderStoreOptions {
  /** Vault root; `null`/`undefined` means the store is unavailable (no vault yet). */
  vaultPath: () => string | null | undefined
  logger?: { warn: (message: string, ...rest: unknown[]) => void }
  now?: () => Date
}

export type ReminderStoreLoadResult = {
  records: ReminderRecord[]
  dropped: number
  recovered: number
}

/**
 * Vault-backed reminder store.
 *
 * Method names match the QQ plugin's `ReminderRepositoryLike` so it can be
 * consumed directly through `ctx.provide('reminderStore', …)` without either
 * side importing the other.
 */
export class ReminderStore {
  readonly contract = REMINDER_STORE_CONTRACT
  private dropped = 0
  private recovered = 0
  private readonly now: () => Date
  /** Serialises writes so two flushes cannot interleave temp files. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ReminderStoreOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** Absolute directory, or null when the vault is not resolved yet. */
  get root(): string | null {
    const vault = this.options.vaultPath()
    return vault === undefined || vault === null ? null : join(vault, 'Reminders')
  }

  get available(): boolean { return this.root !== null }
  get droppedCount(): number { return this.dropped }
  get recoveredCount(): number { return this.recovered }

  /**
   * Delivery policy, stored beside the notes.
   *
   * `policy.json` is not a reminder: `load()` only reads `*.md`, so the file can
   * live in the same directory without ever being mistaken for one.
   */
  async readPolicy(): Promise<ReminderPolicy> {
    const root = this.root
    if (root === null) return { ...DEFAULT_REMINDER_POLICY }
    try {
      const raw = JSON.parse(await readFile(join(root, REMINDER_POLICY_FILE), 'utf8')) as unknown
      // The file is `{ schemaVersion, policy }`. Normalising the wrapper would
      // find no fields and silently fall back to defaults on every read — which
      // is exactly the bug this line exists to prevent. A bare policy object is
      // also accepted, so an older hand-written file still works.
      const wrapped = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      return normalizeReminderPolicy(wrapped['policy'] ?? raw)
    } catch {
      return { ...DEFAULT_REMINDER_POLICY }
    }
  }

  async writePolicy(policy: ReminderPolicy): Promise<ReminderPolicy> {
    const root = this.root
    if (root === null) return policy
    const normalized = normalizeReminderPolicy(policy)
    await writeFileAtomic(join(root, REMINDER_POLICY_FILE), `${JSON.stringify({ schemaVersion: 1, policy: normalized }, null, 2)}\n`)
    return normalized
  }

  /**
   * Read every reminder note.
   *
   * A note whose frontmatter is unreadable is skipped, never guessed at: a
   * half-valid reminder must not silently fire at the wrong time.
   */
  async load(): Promise<ReminderStoreLoadResult> {
    const root = this.root
    if (root === null) {
      return { records: [], dropped: 0, recovered: 0 }
    }
    let names: string[] = []
    try {
      names = (await readdir(root)).filter((name) => name.toLowerCase().endsWith('.md'))
    } catch {
      names = [] // directory does not exist yet
    }
    const records: ReminderRecord[] = []
    const seen = new Set<string>()
    let dropped = 0
    let recovered = 0
    const repaired: ReminderRecord[] = []
    for (const name of names) {
      const path = join(root, name)
      let source: string
      try {
        source = await readFile(path, 'utf8')
      } catch {
        dropped += 1
        continue
      }
      let meta: Record<string, unknown>
      let body: string
      try {
        const parsed = splitFrontmatter(source)
        meta = parsed.meta
        body = parsed.body
      } catch {
        dropped += 1
        continue
      }
      // Frontmatter uses snake_case (human-friendly YAML); the record shape is
      // camelCase so it can be handed to the QQ runtime unchanged.
      const candidate: Record<string, unknown> = {
        id: meta['id'],
        title: meta['title'],
        note: body.trim(),
        dueAt: meta['due_at'],
        status: meta['status'],
        delivery: meta['delivery'],
        scope: meta['scope'],
        repeat: meta['repeat'] ?? null,
        createdAt: meta['created_at'],
        updatedAt: meta['updated_at'],
        attempts: meta['attempts'],
        lastAttemptAt: meta['last_attempt_at'] ?? null,
      }
      const idFromName = name.slice(0, -3)
      if (!isReminderRecord(candidate) || candidate.id !== idFromName || seen.has(candidate.id)) {
        dropped += 1
        continue
      }
      seen.add(candidate.id)
      const record = candidate as unknown as ReminderRecord
      const fixed = recoverInterrupted(record)
      if (fixed !== record) {
        recovered += 1
        repaired.push(fixed)
      }
      records.push(fixed)
    }
    this.dropped = dropped
    this.recovered = recovered
    // Only the repaired rows are rewritten; untouched notes keep their mtime so
    // an Obsidian sync does not see the whole folder as modified.
    for (const record of repaired) await this.write(record)
    return { records, dropped, recovered }
  }

  async list(): Promise<ReminderRecord[]> {
    const result = await this.load()
    return result.records
  }

  /** Insert or replace exactly one reminder. */
  async upsert(reminder: ReminderRecord): Promise<void> {
    if (!isReminderRecord(reminder)) throw new Error('reminder-store: invalid reminder record')
    await this.write(reminder)
  }

  async remove(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) return false
    const root = this.root
    if (root === null) return false
    const path = join(root, `${id}.md`)
    if (!isWithin(root, path)) return false
    try {
      await rm(path)
      return true
    } catch {
      return false
    }
  }

  /** No-op hook: every write is already committed atomically by `upsert`. */
  async flush(): Promise<void> {
    await this.chain.catch(() => undefined)
  }

  private async write(reminder: ReminderRecord): Promise<void> {
    const root = this.root
    if (root === null) throw new Error('reminder-store: vault path is not resolved')
    const path = join(root, `${reminder.id}.md`)
    if (!isWithin(root, path)) throw new Error('reminder-store: id escapes the reminder directory')
    const meta: Record<string, unknown> = {
      id: reminder.id,
      title: reminder.title,
      due_at: reminder.dueAt,
      status: reminder.status,
      delivery: reminder.delivery,
      scope: reminder.scope,
      repeat: reminder.repeat,
      created_at: reminder.createdAt,
      updated_at: reminder.updatedAt,
      attempts: reminder.attempts,
      last_attempt_at: reminder.lastAttemptAt,
    }
    const body = reminder.note.trim()
    const content = joinFrontmatter(meta, body.length === 0 ? '' : body)
    const run = this.chain.catch(() => undefined).then(() => writeFileAtomic(path, content))
    this.chain = run
    await run
  }

  /** Timestamp used by callers that need to stamp a record. */
  timestamp(): string { return this.now().toISOString() }
}

/**
 * A crash between "marked delivered" and "marked done" leaves a pending
 * reminder flagged as delivered. Treat it as deferred so it is offered again on
 * the next legal inbound instead of being lost.
 */
function recoverInterrupted(record: ReminderRecord): ReminderRecord {
  if (record.status === 'pending' && record.delivery === 'delivered') {
    return { ...record, delivery: 'deferred' }
  }
  return record
}

function isWithin(root: string, candidate: string): boolean {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(`${base}${process.platform === 'win32' ? '\\' : '/'}`)
}
