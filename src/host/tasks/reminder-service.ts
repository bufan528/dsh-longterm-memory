/**
 * Vault-side reminder operations (PC management page).
 *
 * `ReminderStore` only stores rows; the QQ plugin's `ReminderRuntime` owns
 * *delivery*. The management page still has to create / cancel / complete /
 * reschedule reminders, and it must not require the QQ plugin to be loaded —
 * otherwise the page shows "life-agent@v1 not found" on a PC-only install.
 *
 * So the four operations live here, with the same semantics the QQ runtime uses
 * (`complete` also rolls a repeating reminder forward), and the runtime keeps
 * being the only thing that decides *when* a due reminder may be sent.
 */
import { randomUUID } from 'node:crypto'

import type { ReminderRecord, ReminderRepeat, ReminderStore } from './reminder-store.js'
import {
  DEFAULT_REMINDER_POLICY, shouldDeliver, summarizeDue,
} from '../../shared/reminder-policy.js'
import type { DeliveryDecision, ReminderPolicy } from '../../shared/reminder-policy.js'

export const REMINDER_SERVICE_CONTRACT = 'reminder-service@v1'

export interface CreateReminderInput {
  title: string
  note?: string
  dueAt: string
  repeat?: ReminderRepeat | null
}

export interface ReminderServiceOptions {
  now?: () => Date
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

export function validateRepeat(rule: ReminderRepeat | null): string | null {
  if (rule === null) return null
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 365) {
    return '周期次数必须为 1..365 的整数'
  }
  if (!['day', 'week', 'month'].includes(rule.unit)) return '未知周期单位'
  return null
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/** Next occurrence strictly after both `dueAt` and `from` (mirrors the QQ scheduler). */
export function nextOccurrence(dueAt: string, rule: ReminderRepeat, from: number): string | null {
  const base = new Date(Math.max(Date.parse(dueAt), from))
  if (Number.isNaN(base.getTime())) return null
  const next = new Date(base.getTime())
  if (rule.unit === 'day') next.setUTCDate(next.getUTCDate() + rule.interval)
  else if (rule.unit === 'week') next.setUTCDate(next.getUTCDate() + 7 * rule.interval)
  else {
    const targetMonth = next.getUTCMonth() + rule.interval
    const year = next.getUTCFullYear() + Math.floor(targetMonth / 12)
    const month = ((targetMonth % 12) + 12) % 12
    next.setUTCFullYear(year, month, Math.min(next.getUTCDate(), lastDayOfMonth(year, month)))
  }
  if (next.getTime() <= base.getTime()) return null
  return next.toISOString()
}

export class ReminderService {
  readonly contract = REMINDER_SERVICE_CONTRACT
  private readonly now: () => Date

  constructor(
    private readonly store: ReminderStore,
    options: ReminderServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
  }

  get available(): boolean { return this.store.available }
  get storeKind(): 'vault' | null { return this.store.available ? 'vault' : null }

  async list(): Promise<ReminderRecord[]> {
    return this.store.list()
  }

  async create(input: CreateReminderInput): Promise<ReminderRecord> {
    const title = input.title.trim()
    if (title.length === 0 || title.length > 200) throw new Error('title must be 1..200 chars')
    const note = input.note ?? ''
    if (note.length > 1000) throw new Error('note too long')
    if (Number.isNaN(Date.parse(input.dueAt))) throw new Error('dueAt must be a valid ISO instant')
    const repeat = input.repeat ?? null
    const problem = validateRepeat(repeat)
    if (problem !== null) throw new Error(problem)

    const id = randomUUID().replace(/-/g, '').slice(0, 24)
    if (!ID_PATTERN.test(id)) throw new Error('invalid reminder id')
    if ((await this.store.list()).some((r) => r.id === id)) throw new Error('reminder id already exists')

    const at = this.now().toISOString()
    const reminder: ReminderRecord = {
      id, title, note, dueAt: input.dueAt,
      status: 'pending', repeat, scope: 'shared',
      createdAt: at, updatedAt: at,
      delivery: 'waiting', attempts: 0, lastAttemptAt: null,
    }
    await this.store.upsert(reminder)
    return reminder
  }

  async cancel(id: string): Promise<boolean> {
    const found = await this.find(id)
    if (found === null) return false
    await this.store.upsert({ ...found, status: 'cancelled', updatedAt: this.now().toISOString() })
    return true
  }

  /**
   * Mark one reminder done. A repeating reminder spawns its next occurrence in
   * the same call, exactly like the QQ runtime, so completing from the PC page
   * and completing from QQ cannot diverge.
   */
  async complete(id: string): Promise<{ completed: ReminderRecord; next: ReminderRecord | null } | null> {
    const found = await this.find(id)
    if (found === null) return null
    const completed: ReminderRecord = {
      ...found, status: 'done', delivery: 'delivered', updatedAt: this.now().toISOString(),
    }
    await this.store.upsert(completed)
    let next: ReminderRecord | null = null
    if (found.repeat !== null) {
      const dueAt = nextOccurrence(found.dueAt, found.repeat, this.now().getTime())
      if (dueAt !== null) {
        const at = this.now().toISOString()
        next = {
          ...completed,
          id: `${id}_n${Date.parse(dueAt).toString(36)}`,
          dueAt,
          status: 'pending',
          delivery: 'waiting',
          attempts: 0,
          lastAttemptAt: null,
          createdAt: at,
          updatedAt: at,
        }
        await this.store.upsert(next)
      }
    }
    return { completed, next }
  }

  async reschedule(id: string, dueAt: string): Promise<ReminderRecord | null> {
    if (Number.isNaN(Date.parse(dueAt))) throw new Error('dueAt must be a valid ISO instant')
    const found = await this.find(id)
    if (found === null) return null
    const next: ReminderRecord = {
      ...found,
      dueAt,
      status: 'pending',
      delivery: 'waiting',
      attempts: 0,
      lastAttemptAt: null,
      updatedAt: this.now().toISOString(),
    }
    await this.store.upsert(next)
    return next
  }

  /**
   * Delivery policy for the shared reminder list.
   *
   * Read-through rather than cached: the QQ runtime may rewrite the file while
   * this page is open, and a stale policy would show the wrong quiet hours.
   */
  async policy(): Promise<ReminderPolicy> {
    try {
      return await this.store.readPolicy()
    } catch {
      return { ...DEFAULT_REMINDER_POLICY }
    }
  }

  async updatePolicy(patch: Partial<ReminderPolicy>): Promise<ReminderPolicy> {
    const current = await this.policy()
    const merged: ReminderPolicy = {
      quietHours: patch.quietHours === undefined ? current.quietHours : patch.quietHours,
      backoffBase: patch.backoffBase ?? current.backoffBase,
      backoffMinutes: patch.backoffMinutes ?? current.backoffMinutes,
      maxAttempts: patch.maxAttempts ?? current.maxAttempts,
    }
    return this.store.writePolicy(merged)
  }

  /** Whether one reminder may be delivered now, and why not when it may not. */
  async deliveryFor(id: string): Promise<{ decision: DeliveryDecision; policy: ReminderPolicy } | null> {
    const record = await this.find(id)
    if (record === null) return null
    const policy = await this.policy()
    return {
      policy,
      decision: shouldDeliver(
        {
          dueAt: record.dueAt,
          attempts: record.attempts,
          lastAttemptAt: record.lastAttemptAt,
          status: record.status,
        },
        policy,
        this.now().getTime(),
      ),
    }
  }

  /** A one-line answer to "anything I should be reminded of right now?" */
  async dueSummary(): Promise<{ dueNow: number; deferred: number; summary: string }> {
    const [records, policy] = await Promise.all([this.store.load(), this.policy()])
    return summarizeDue(
      records.records.map((record) => ({
        id: record.id,
        title: record.title,
        dueAt: record.dueAt,
        attempts: record.attempts,
        lastAttemptAt: record.lastAttemptAt,
        status: record.status,
      })),
      policy,
      this.now().getTime(),
    )
  }

  private async find(id: string): Promise<ReminderRecord | null> {
    if (!ID_PATTERN.test(id)) return null
    const rows = await this.store.list()
    return rows.find((r) => r.id === id) ?? null
  }
}
