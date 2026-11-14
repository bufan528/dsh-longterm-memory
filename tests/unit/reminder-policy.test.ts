/**
 * Reminder delivery rules.
 *
 * The whole point is that a reminder must not nag and must not speak at night.
 * Local-time arithmetic is used deliberately (quiet hours are a human concept),
 * so every expectation below is built from local `Date` parts.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REMINDER_POLICY, inQuietHours, nextAttemptAt, normalizeReminderPolicy,
  quietEndsAt, shouldDeliver, summarizeDue,
} from '../../src/shared/reminder-policy.js'
import type { ReminderPolicy } from '../../src/shared/reminder-policy.js'

const policy = (over: Partial<ReminderPolicy> = {}): ReminderPolicy => ({ ...DEFAULT_REMINDER_POLICY, ...over })

/** Local wall-clock helper: all tests read as "at 21:30 on the 13th". */
const at = (hour: number, minute = 0): number => new Date(2026, 10, 13, hour, minute, 0, 0).getTime()

describe('inQuietHours', () => {
  it('covers a window that wraps midnight', () => {
    expect(inQuietHours(policy(), at(23))).toBe(true)
    expect(inQuietHours(policy(), at(3))).toBe(true)
    expect(inQuietHours(policy(), at(7, 59))).toBe(true)
    expect(inQuietHours(policy(), at(8))).toBe(false)
    expect(inQuietHours(policy(), at(21, 59))).toBe(false)
  })

  it('handles a same-day window', () => {
    const day = policy({ quietHours: { start: 13, end: 14 } })
    expect(inQuietHours(day, at(13, 30))).toBe(true)
    expect(inQuietHours(day, at(14))).toBe(false)
  })

  it('is disabled by a null or empty window', () => {
    expect(inQuietHours(policy({ quietHours: null }), at(3))).toBe(false)
    expect(inQuietHours(policy({ quietHours: { start: 9, end: 9 } }), at(9))).toBe(false)
  })
})

describe('quietEndsAt', () => {
  it('points at this morning when the window wraps', () => {
    const end = quietEndsAt(policy(), at(3))
    const date = new Date(end)
    expect(date.getHours()).toBe(8)
    expect(date.getDate()).toBe(13)
  })

  it('points at tomorrow when the window starts tonight', () => {
    const end = quietEndsAt(policy(), at(23))
    const date = new Date(end)
    expect(date.getHours()).toBe(8)
    expect(date.getDate()).toBe(14)
  })

  it('is a no-op outside the window', () => {
    expect(quietEndsAt(policy(), at(12))).toBe(at(12))
  })
})

describe('nextAttemptAt', () => {
  const due = new Date(at(12)).toISOString()

  it('uses the due instant before any attempt', () => {
    expect(nextAttemptAt({ dueAt: due, attempts: 0, lastAttemptAt: null }, policy())).toBe(at(12))
  })

  it('backs off exponentially from the last attempt', () => {
    const first = nextAttemptAt({ dueAt: due, attempts: 1, lastAttemptAt: due }, policy())
    const second = nextAttemptAt({ dueAt: due, attempts: 2, lastAttemptAt: due }, policy())
    // 15 minutes, then 15 × 1.6 = 24 minutes.
    expect((first! - at(12)) / 60_000).toBeCloseTo(15)
    expect((second! - at(12)) / 60_000).toBeCloseTo(24)
  })

  it('gives up after the attempt ceiling', () => {
    expect(nextAttemptAt({ dueAt: due, attempts: 5, lastAttemptAt: due }, policy())).toBeNull()
  })
})

describe('shouldDeliver', () => {
  const due = new Date(at(12)).toISOString()

  it('delivers a due reminder during the day', () => {
    expect(shouldDeliver({ dueAt: due, attempts: 0, lastAttemptAt: null }, policy(), at(12, 1))).toEqual({ deliver: true })
  })

  it('never delivers a completed reminder', () => {
    const decision = shouldDeliver({ dueAt: due, attempts: 0, lastAttemptAt: null, status: 'done' }, policy(), at(12, 1))
    expect(decision.deliver).toBe(false)
    if (!decision.deliver) expect(decision.reason).toBe('done')
  })

  it('defers to the end of quiet hours instead of dropping it', () => {
    const decision = shouldDeliver({ dueAt: due, attempts: 0, lastAttemptAt: null }, policy(), at(23))
    expect(decision.deliver).toBe(false)
    if (!decision.deliver) {
      expect(decision.reason).toBe('quiet-hours')
      expect(new Date(decision.nextAttemptAt!).getHours()).toBe(8)
      expect(new Date(decision.nextAttemptAt!).getDate()).toBe(14)
    }
  })

  it('waits out the backoff window', () => {
    const last = new Date(at(12)).toISOString()
    const decision = shouldDeliver({ dueAt: due, attempts: 1, lastAttemptAt: last }, policy(), at(12, 5))
    expect(decision.deliver).toBe(false)
    if (!decision.deliver) {
      expect(decision.reason).toBe('backoff')
      expect(new Date(decision.nextAttemptAt!).getMinutes()).toBe(15)
    }
  })

  it('delivers once the backoff has elapsed', () => {
    const last = new Date(at(12)).toISOString()
    expect(shouldDeliver({ dueAt: due, attempts: 1, lastAttemptAt: last }, policy(), at(12, 20))).toEqual({ deliver: true })
  })

  it('reports not-due before the instant', () => {
    const decision = shouldDeliver({ dueAt: new Date(at(18)).toISOString(), attempts: 0, lastAttemptAt: null }, policy(), at(12))
    expect(decision.deliver).toBe(false)
    if (!decision.deliver) expect(decision.reason).toBe('not-due')
  })

  it('stops nagging but says why', () => {
    const last = new Date(at(12)).toISOString()
    const decision = shouldDeliver({ dueAt: due, attempts: 5, lastAttemptAt: last }, policy(), at(12, 30))
    expect(decision.deliver).toBe(false)
    if (!decision.deliver) expect(decision.reason).toBe('gave-up')
  })
})

describe('summarizeDue', () => {
  it('splits deliverable from deferred', () => {
    const records = [
      { id: 'a', title: 'a', dueAt: new Date(at(11)).toISOString(), attempts: 0, lastAttemptAt: null },
      { id: 'b', title: 'b', dueAt: new Date(at(11)).toISOString(), attempts: 1, lastAttemptAt: new Date(at(12)).toISOString() },
    ]
    const result = summarizeDue(records, policy(), at(12, 5))
    expect(result.dueNow).toBe(1)
    expect(result.deferred).toBe(1)
    expect(result.summary).toContain('1 件到点')
  })

  it('says nothing is due when nothing is', () => {
    expect(summarizeDue([], policy(), at(12)).summary).toBe('没有到点的提醒。')
  })
})

describe('normalizeReminderPolicy', () => {
  it('clamps a hostile base and keeps a valid window', () => {
    const normalized = normalizeReminderPolicy({ quietHours: { start: 22, end: 7 }, backoffBase: 99, backoffMinutes: 0, maxAttempts: 999 })
    expect(normalized.quietHours).toEqual({ start: 22, end: 7 })
    expect(normalized.backoffBase).toBe(3)
    expect(normalized.backoffMinutes).toBe(1)
    expect(normalized.maxAttempts).toBe(20)
  })

  it('drops an out-of-range window instead of wrapping nonsense', () => {
    expect(normalizeReminderPolicy({ quietHours: { start: 25, end: 8 } }).quietHours).toBeNull()
  })

  it('falls back to defaults for garbage', () => {
    expect(normalizeReminderPolicy('nope').backoffBase).toBe(DEFAULT_REMINDER_POLICY.backoffBase)
  })
})
