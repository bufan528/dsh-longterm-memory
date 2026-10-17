/**
 * Durable journal delivery (outbox) — round 16.
 *
 * Architecture decision: the monthly JSONL journal is the **authoritative history**;
 * it holds reasons, timestamps and before/after summaries that Markdown does not.
 * It therefore cannot be treated as a discardable cache, and a failed append must
 * not turn a committed domain change into an unexplained failure.
 *
 * Protocol:
 *
 * 1. `stageEvent` atomically writes the complete event to
 *    `.dsh-memory/journal-pending/<eventId>.json`. If this fails, the caller must
 *    fail the operation — nothing durable can be guaranteed.
 * 2. `flushPending` appends staged events to the monthly JSONL, then deletes the
 *    staged file. If an append fails, the staged file stays; the operation is still
 *    considered committed because the event is durably recorded.
 * 3. Appending is idempotent: an event whose id already appears in the month file is
 *    not appended again (crash between append and delete is safe).
 * 4. `history()` merges monthly files with still-pending events, so committed
 *    history is visible even before the archive completes.
 * 5. Startup calls `flushPending`, so a restart finishes any pending archive.
 *
 * @module dsh-longterm-memory/host/core/journal-outbox
 */

import { randomUUID } from 'node:crypto'
import { appendFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { journalPath, type VaultLayout } from './layout.js'
import { FsError, readTextIfExists, writeFileAtomic } from './fsx.js'

/** Structural view of a journal entry: this module only needs these fields. */
export interface StagedEvent {
  at: string
  op: string
  id: string
  reason?: string
  eventId?: string
  /** PREPARED events are durable but not yet committed; only COMMITTED ones are history. */
  state?: 'prepared' | 'committed'
  [key: string]: unknown
}

/** Pending-event directory, kept beside (not inside) the monthly journal directory. */
export function pendingDir(layout: VaultLayout): string {
  return join(dirname(layout.journalDir), 'journal-pending')
}

export function eventKeyOf(event: StagedEvent): string {
  return eventKey(event)
}

function eventKey(event: StagedEvent): string {
  return typeof event.eventId === 'string' && event.eventId.length > 0 ? event.eventId : randomUUID()
}

/**
 * Persist one event durably before it is archived.
 *
 * @returns the event id, which is also the file name and the dedupe key.
 * @throws when the pending record cannot be written — callers must treat that as
 *   "history could not be secured".
 */
export async function stageEvent(layout: VaultLayout, event: StagedEvent): Promise<string> {
  const eventId = eventKey(event)
  // A staged event starts life as PREPARED: it must never be presented as history
  // until the domain write it describes has actually committed.
  const record: StagedEvent = { ...event, eventId, state: event.state ?? 'prepared' }
  await writeFileAtomic(join(pendingDir(layout), `${encodeEventFile(eventId)}.json`), `${JSON.stringify(record)}\n`)
  return eventId
}

/**
 * Promote a staged event to COMMITTED after its domain write succeeded.
 *
 * Only COMMITTED events are exposed by history and archived into the monthly JSONL.
 */
export async function markCommitted(layout: VaultLayout, eventId: string): Promise<boolean> {
  const files = await findEventFiles(layout, eventId)
  let updated = false
  for (const path of files) {
    const raw = await readTextIfExists(path)
    if (raw === null) continue
    try {
      const parsed = JSON.parse(raw) as StagedEvent
      await writeFileAtomic(path, `${JSON.stringify({ ...parsed, eventId, state: 'committed' })}\n`)
      updated = true
    } catch {
      // Leave unparseable files untouched.
    }
  }
  return updated
}

/** Whether a staged/archived event counts as committed history. */
export function isCommitted(event: StagedEvent): boolean {
  return event.state === undefined || event.state === 'committed'
}
/** Maximum UTF-8 byte length of an event id accepted for on-disk staging. */
export const MAX_EVENT_ID_BYTES = 96

/**
 * Injective, filesystem-safe file stem for an event id.
 *
 * base64url(UTF-8) uses only `[A-Za-z0-9_-]`, so the name is legal on Windows and two
 * different ids can never produce the same stem. The raw id stays in the JSON payload;
 * this is only the storage address.
 */
export function encodeEventFile(eventId: string): string {
  if (eventId.length === 0) {
    throw new FsError('FS_INVALID_NAME', '事件标识为空，拒绝写入暂存文件。')
  }
  // Lone surrogates become U+FFFD in UTF-8 and would silently collide: reject them.
  for (let index = 0; index < eventId.length; index += 1) {
    const code = eventId.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = eventId.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new FsError('FS_INVALID_NAME', '事件标识包含未配对的高位代理项，拒绝写入暂存文件。')
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new FsError('FS_INVALID_NAME', '事件标识包含未配对的低位代理项，拒绝写入暂存文件。')
    }
  }
  const bytes = Buffer.from(eventId, 'utf8')
  if (bytes.length > MAX_EVENT_ID_BYTES) {
    throw new FsError('FS_INVALID_NAME', `事件标识过长（${String(bytes.length)} 字节，上限 ${String(MAX_EVENT_ID_BYTES)}），拒绝写入暂存文件。`)
  }
  // Lowercase hex is injective and safe under Windows' case-insensitive comparison.
  return `evt_${bytes.toString('hex')}`
}

/** Names produced by earlier versions (raw, R29 sanitised, R31 base64url). */
function isLegacyEventName(name: string, eventId: string): boolean {
  const base64Name = `evt_${Buffer.from(eventId, 'utf8').toString('base64url')}.json`
  if (name.toLowerCase() === base64Name.toLowerCase()) return true
  if (name === `${eventId}.json` && /^[A-Za-z0-9._-]+$/.test(eventId)) return true
  const sanitized = eventId.replace(/[^A-Za-z0-9._-]/g, '_')
  return name === `${sanitized}.json`
}


/** Locate every staged file whose payload carries `eventId` (canonical or legacy name). */
export async function findEventFiles(layout: VaultLayout, eventId: string): Promise<string[]> {
  const dir = pendingDir(layout)
  const names = await readdir(dir).catch(() => [] as string[])
  const canonical = `${encodeEventFile(eventId)}.json`
  const found: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    if (name.toLowerCase() !== canonical.toLowerCase() && !isLegacyEventName(name, eventId)) continue
    const path = join(dir, name)
    const raw = await readTextIfExists(path)
    if (raw === null) continue
    try {
      const parsed = JSON.parse(raw) as StagedEvent
      if (parsed.eventId === eventId) found.push(path)
    } catch {
      // Unparseable files are reported by the pending-history integrity check.
    }
  }
  return found
}
/** Storage-only fields: they identify where an event is stored, not what it means. */
const STORAGE_ONLY_FIELDS = new Set(['eventId', 'state'])

/**
 * Canonical semantic payload of a history event.
 *
 * Every field except storage-only ones participates, with sorted object keys, so key
 * order and JSON formatting never matter but any real content difference does.
 */
export function canonicalEventContent(event: StagedEvent): string {
  const fields = Object.keys(event)
    .filter((key) => !STORAGE_ONLY_FIELDS.has(key))
    .sort()
  return JSON.stringify(fields.map((key) => [key, event[key] ?? null]))
}

export interface HistoryConflicts {
  /** eventIds whose copies disagree in meaning. */
  conflicts: string[]
  /** Events after idempotent de-duplication (only when payloads agree). */
  events: StagedEvent[]
}

/**
 * Combine archived and pending events under the conflict rules:
 * - same eventId + same payload  → one logical event (idempotent merge);
 * - same eventId + different payload → CONFLICT (both copies reported, never merged);
 * - different eventIds + same payload → both kept (independent operations);
 * - legacy events without eventId → each stays independent (stable, no random ids).
 */
export function reconcileHistory(archived: readonly StagedEvent[], pending: readonly StagedEvent[]): HistoryConflicts {
  const conflicts = new Set<string>()
  const byId = new Map<string, { payload: string; event: StagedEvent }>()
  const events: StagedEvent[] = []
  for (const event of [...archived, ...pending]) {
    const id = typeof event.eventId === 'string' && event.eventId.length > 0 ? event.eventId : null
    if (id === null) {
      events.push(event)
      continue
    }
    const payload = canonicalEventContent(event)
    const known = byId.get(id)
    if (known === undefined) {
      byId.set(id, { payload, event })
      events.push(event)
      continue
    }
    if (known.payload !== payload) {
      conflicts.add(id)
      continue
    }
    // Identical copy: idempotent, keep the first occurrence only.
  }
  return { conflicts: [...conflicts], events }
}
/** Remove a staged event whose domain operation did not commit (never archives it). */
export async function discardStaged(layout: VaultLayout, eventId: string): Promise<void> {
  for (const path of await findEventFiles(layout, eventId)) {
    await rm(path, { force: true })
  }
}
/** Locate the archived line for one eventId, if any (malformed lines are ignored here). */
function findArchivedCopy(raw: string, eventId: string): StagedEvent | null {
  for (const line of raw.split('\n')) {
    if (!line.includes(`"eventId":"${eventId}"`)) continue
    try {
      const parsed = JSON.parse(line) as StagedEvent
      if (parsed.eventId === eventId) return parsed
    } catch {
      // A torn line is handled by the reader, not here.
    }
  }
  return null
}
/** Delete pending copies of one eventId whose payload equals `payload` (idempotent). */
async function removeIdenticalCopies(layout: VaultLayout, eventId: string, payload: string): Promise<void> {
  const dir = pendingDir(layout)
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    const raw = await readTextIfExists(path)
    if (raw === null) continue
    try {
      const parsed = JSON.parse(raw) as StagedEvent
      if (parsed.eventId === eventId && canonicalEventContent(parsed) === payload) {
        await rm(path, { force: true })
      }
    } catch {
      // Leave unparseable files alone; the corrupt path reports them.
    }
  }
}
/** Read every staged event; unparseable records are reported, never silently dropped. */
export async function readPending(layout: VaultLayout): Promise<{ events: StagedEvent[]; corrupt: string[] }> {
  const dir = pendingDir(layout)
  const names = await readdir(dir).catch(() => [] as string[])
  const events: StagedEvent[] = []
  const corrupt: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const raw = await readTextIfExists(join(dir, name))
    if (raw === null) continue
    try {
      const parsed = JSON.parse(raw) as StagedEvent
      if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') {
        corrupt.push(name)
        continue
      }
      events.push(parsed)
    } catch {
      corrupt.push(name)
    }
  }
  return { events, corrupt }
}

/**
 * Append staged events to their monthly files and remove the pending copies.
 *
 * Never throws: a failure here leaves the event staged, which is a legal state
 * (committed, archive pending). Returns what happened so tests and callers can see it.
 */
export async function flushPending(
  layout: VaultLayout,
  events?: readonly StagedEvent[],
): Promise<{ appended: string[]; duplicates: string[]; failed: { eventId: string; reason: string }[]; corrupt: string[]; conflicts: string[] }> {
  const read = events === undefined ? await readPending(layout) : { events: [...events], corrupt: [] as string[] }
  const appended: string[] = []
  const duplicates: string[] = []
  const failed: { eventId: string; reason: string }[] = []

  const conflicts: string[] = []
  for (const event of read.events) {
    // PREPARED events are durable but not yet committed: never archive them.
    if (!isCommitted(event)) continue
    const eventId = eventKey(event)
    const monthFile = journalPath(layout, new Date(event.at))
    try {
      const existing = await readTextIfExists(monthFile)
      const archivedCopy = existing === null ? null : findArchivedCopy(existing, eventId)
      if (archivedCopy !== null) {
        if (canonicalEventContent(archivedCopy) !== canonicalEventContent(event)) {
          // Same id, different meaning: keep BOTH copies and report the conflict.
          conflicts.push(eventId)
          continue
        }
        // Idempotent duplicate: the event is already archived.
        duplicates.push(eventId)
      } else {
        await appendFile(monthFile, `${JSON.stringify({ ...event, eventId })}\n`, 'utf8')
        appended.push(eventId)
      }
      // Only delete after the archive is durable (or provably identical).
      await removeIdenticalCopies(layout, eventId, canonicalEventContent(event))
    } catch (error) {
      failed.push({ eventId, reason: String((error as Error | null)?.message ?? error) })
    }
  }
  return { appended, duplicates, failed, corrupt: read.corrupt, conflicts }
}

/**
 * Merge archived events with events that are still staged for archive.
 *
 * This is what makes `history()` truthful while an archive is pending: an event is
 * visible as soon as it is durably staged, not only after it reaches the month file.
 * Deduplicated by event id so an append-then-crash cannot double-report.
 */
export async function mergeHistory(
  layout: VaultLayout,
  archived: readonly StagedEvent[],
  limit: number,
): Promise<StagedEvent[]> {
  const { events: pending } = await readPending(layout)
  const seen = new Set<string>()
  const merged: StagedEvent[] = []
  for (const event of [...archived, ...pending]) {
    if (!isCommitted(event)) continue
    const key = eventKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(event)
  }
  merged.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))
  return merged.slice(0, limit)
}
