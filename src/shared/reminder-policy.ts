/**
 * Reminder delivery policy — pure functions, no IO.
 *
 * Delivery itself belongs to the chat plugin, and it can only speak inside a
 * passive window, so "when to nag again" is the only part this side can decide.
 * The research on proactive assistants (textavery's production write-up is the
 * clearest) converges on two rules:
 *
 *  1. **Do not repeat at a fixed interval.** Every unanswered reminder multiplies
 *     the wait by a base factor (1.6 is the published figure), so the third nudge
 *     is hours away rather than minutes.
 *  2. **Do not speak at night.** A reminder that fires at 03:00 is a bug, even
 *     when it is technically due — it gets deferred to the end of quiet hours.
 *
 * Keeping the arithmetic here means the QQ side only needs one call before it
 * sends (`shouldDeliver`), and the rules can be unit-tested without a clock.
 *
 * @module dsh-longterm-memory/shared/reminder-policy
 */

export interface QuietHours {
  /** 0-23, inclusive start. */
  start: number
  /** 0-23, exclusive end. `start > end` means the window wraps midnight. */
  end: number
}

export interface ReminderPolicy {
  /** `null` disables quiet hours. */
  quietHours: QuietHours | null
  /** Multiplier applied per unanswered attempt (1.0 disables backoff). */
  backoffBase: number
  /** First retry delay, in minutes. */
  backoffMinutes: number
  /** After this many attempts the reminder stops nagging (it stays overdue). */
  maxAttempts: number
}

/**
 * Defaults: silence 22:00-08:00, retry at 15 min, ×1.6 each time, give up
 * nagging after five attempts. A reminder still shows as overdue in the list —
 * "stop nagging" is not "forget".
 */
export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  quietHours: { start: 22, end: 8 },
  backoffBase: 1.6,
  backoffMinutes: 15,
  maxAttempts: 5,
}

/** The fields of a reminder the decision needs. */
export interface ReminderTiming {
  dueAt: string
  attempts: number
  lastAttemptAt: string | null
}

export type DeliveryDecision =
  | { deliver: true }
  | {
    deliver: false
    reason: 'not-due' | 'quiet-hours' | 'backoff' | 'gave-up' | 'done'
    /** When it should be reconsidered, when that is knowable. */
    nextAttemptAt?: string
    note: string
  }

const MINUTE_MS = 60_000

/** True when `now` falls inside the quiet window (handles midnight wrap). */
export function inQuietHours(policy: ReminderPolicy, now: number): boolean {
  const quiet = policy.quietHours
  if (quiet === null) return false
  const hour = new Date(now).getHours()
  if (quiet.start === quiet.end) return false
  return quiet.start < quiet.end
    ? hour >= quiet.start && hour < quiet.end
    : hour >= quiet.start || hour < quiet.end
}

/** The next instant quiet hours end, or `now` when they are not active. */
export function quietEndsAt(policy: ReminderPolicy, now: number): number {
  const quiet = policy.quietHours
  if (quiet === null || !inQuietHours(policy, now)) return now
  const date = new Date(now)
  const end = new Date(now)
  end.setHours(quiet.end, 0, 0, 0)
  if (end.getTime() <= now) {
    // The end is tomorrow (start < end and we are past it, or a wrapped window).
    end.setDate(date.getDate() + 1)
    end.setHours(quiet.end, 0, 0, 0)
  }
  return end.getTime()
}

/**
 * The earliest instant this reminder may be delivered again.
 *
 * `attempts` counts attempts already made, so the first retry uses
 * `backoffMinutes`, the second `backoffMinutes × base`, and so on.
 */
export function nextAttemptAt(record: ReminderTiming, policy: ReminderPolicy): number | null {
  if (record.attempts <= 0) return Date.parse(record.dueAt)
  if (record.attempts >= policy.maxAttempts) return null
  const anchor = record.lastAttemptAt === null ? record.dueAt : record.lastAttemptAt
  const anchorMs = Date.parse(anchor)
  if (Number.isNaN(anchorMs)) return null
  const delay = policy.backoffMinutes * Math.pow(policy.backoffBase, record.attempts - 1)
  return anchorMs + delay * MINUTE_MS
}

/**
 * Should this reminder be delivered right now?
 *
 * Order matters: an already-completed reminder is never delivered, even if it is
 * also in quiet hours; and a deferred reminder reports the instant it becomes
 * eligible so the caller can schedule rather than poll.
 */
export function shouldDeliver(
  record: ReminderTiming & { status?: string },
  policy: ReminderPolicy,
  now: number,
): DeliveryDecision {
  if (record.status !== undefined && record.status !== 'pending') {
    return { deliver: false, reason: 'done', note: '提醒已完成，不再投递。' }
  }
  const due = Date.parse(record.dueAt)
  if (!Number.isNaN(due) && now < due) {
    return { deliver: false, reason: 'not-due', note: '还没到时间。', nextAttemptAt: new Date(due).toISOString() }
  }
  const eligible = nextAttemptAt(record, policy)
  if (eligible === null) {
    return {
      deliver: false,
      reason: 'gave-up',
      note: `已经提醒过 ${String(record.attempts)} 次，不再自动催促；它仍会留在逾期列表里。`,
    }
  }
  if (now < eligible) {
    return {
      deliver: false,
      reason: 'backoff',
      note: `上一次提醒后按 ${String(policy.backoffBase)} 倍退避，还没到下一次。`,
      nextAttemptAt: new Date(eligible).toISOString(),
    }
  }
  if (inQuietHours(policy, now)) {
    const end = quietEndsAt(policy, now)
    return {
      deliver: false,
      reason: 'quiet-hours',
      note: `现在处于静默时段（${String(policy.quietHours?.start ?? 0)}:00-${String(policy.quietHours?.end ?? 0)}:00），到点后再谈。`,
      nextAttemptAt: new Date(end).toISOString(),
    }
  }
  return { deliver: true }
}

/** A one-line digest of what is waiting, for the model or the page. */
export function summarizeDue(
  records: readonly (ReminderTiming & { id: string; title: string; status?: string })[],
  policy: ReminderPolicy,
  now: number,
): { dueNow: number; deferred: number; summary: string } {
  let dueNow = 0
  let deferred = 0
  for (const record of records) {
    const decision = shouldDeliver(record, policy, now)
    if (decision.deliver) dueNow += 1
    else if (decision.reason === 'quiet-hours' || decision.reason === 'backoff') deferred += 1
  }
  if (dueNow === 0 && deferred === 0) return { dueNow, deferred, summary: '没有到点的提醒。' }
  const parts: string[] = []
  if (dueNow > 0) parts.push(`${String(dueNow)} 件到点，可以说了`)
  if (deferred > 0) parts.push(`${String(deferred)} 件在等待（静默时段或退避中）`)
  return { dueNow, deferred, summary: parts.join('；') + '。' }
}

/** Clamp anything read from disk into a policy that cannot hang or spam. */
export function normalizeReminderPolicy(raw: unknown): ReminderPolicy {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_REMINDER_POLICY, quietHours: { ...DEFAULT_REMINDER_POLICY.quietHours! } }
  const obj = raw as Record<string, unknown>
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = obj[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  }
  const quietRaw = obj['quietHours']
  let quietHours: QuietHours | null = null
  if (quietRaw !== null && typeof quietRaw === 'object') {
    const q = quietRaw as Record<string, unknown>
    const start = typeof q['start'] === 'number' ? Math.round(q['start']) : NaN
    const end = typeof q['end'] === 'number' ? Math.round(q['end']) : NaN
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= 23 && end >= 0 && end <= 23) {
      quietHours = { start, end }
    }
  }
  return {
    quietHours,
    backoffBase: number('backoffBase', DEFAULT_REMINDER_POLICY.backoffBase, 1, 3),
    backoffMinutes: number('backoffMinutes', DEFAULT_REMINDER_POLICY.backoffMinutes, 1, 720),
    maxAttempts: number('maxAttempts', DEFAULT_REMINDER_POLICY.maxAttempts, 1, 20),
  }
}

/** Hours remaining until quiet hours end, for a UI hint. */
export function quietRemainingMs(policy: ReminderPolicy, now: number): number {
  return Math.max(0, quietEndsAt(policy, now) - now)
}
