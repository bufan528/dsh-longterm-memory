/**
 * Model-facing tools for the "life" surfaces: stickers and reminders.
 *
 * Why these exist: until now the model had only four memory tools. Asked to
 * "remind me at three tomorrow" in a QQ chat it had nothing to call, and asked
 * for a sticker it could not see the library at all. Every mature implementation
 * of these features is delivered as *tools* rather than as changes to the chat
 * platform (dsh-qq-sticker, qq-group-ai-sticker, persona-bot all do exactly
 * this), because tools are the one integration point that does not need the
 * other plugin to change.
 *
 * Design rules taken from the survey:
 *  - `sticker_pick` always enforces a send policy (tg-stickers' 2-5 message rule,
 *    expressed as a time gap because we cannot count messages from here);
 *  - a refusal is a *useful* answer: it says why and when to retry, so the model
 *    can phrase it instead of inventing a sticker;
 *  - nothing here reads personal text, so stickers are not owner-gated — they are
 *    user-curated images meant to be sent in public. Reminders *are* gated,
 *    because a schedule is personal.
 *
 * @module dsh-longterm-memory/host/dsh/life-tools
 */
import { shouldDeliver } from '../../shared/reminder-policy.js'
import type { ReminderPolicy } from '../../shared/reminder-policy.js'
import type { ToolDefinition, ToolExecContext, ToolTextBlock } from './tools.js'

/** The sticker surface this module needs; satisfied by `StickerStore`. */
export interface StickerToolSurface {
  pick: (query: { emotion?: string; context?: string }) => Promise<
    | { ok: true; id: string; path: string; description: string; tags: string[]; reason: string }
    | { ok: false; blocked: string; reason: string; retryAt?: string }
  >
  importPath: (
    absolutePath: string,
    input?: { description?: string; tags?: string[]; source?: 'import' | 'incoming' | 'stolen' | 'other' },
  ) => Promise<{ ok: true; record: { id: string; description: string; tags: string[] }; duplicate: boolean } | { ok: false; reason: string }>
}

export interface ReminderToolSurface {
  list: () => Promise<{
    id: string
    title: string
    note: string
    dueAt: string
    status: string
    repeat: { unit: string; interval: number } | null
    attempts: number
    lastAttemptAt: string | null
  }[]>
  create: (input: {
    title: string
    dueAt: string
    note?: string
    repeat?: { unit: 'day' | 'week' | 'month'; interval: number } | null
  }) => Promise<{ id: string; title: string; dueAt: string; repeat: { unit: string; interval: number } | null }>
  complete: (id: string) => Promise<{ completed: { id: string }; next: { id: string } | null } | null>
  /** Optional: absent on the QQ bridge, which has no quiet hours of its own. */
  policy?: () => Promise<ReminderPolicy>
}

export interface LifeToolExtras {
  stickers?: StickerToolSurface
  reminders?: ReminderToolSurface
  /** Owner gate for personal surfaces; throws when the session may not act. */
  assertAllowed?: (exec: ToolExecContext | undefined) => void
}

/**
 * Auto-capture counter, per session.
 *
 * "Save the memes" has no natural stopping point, so the ceiling is explicit:
 * three per conversation for images the model judged reusable on its own. An
 * explicit user request can pass `source: 'import'`, which is not capped — the
 * cap exists to stop silent accumulation, not to refuse the user.
 */
const AUTO_COLLECT_MAX_PER_DAY = 3
const autoCollected = new Map<string, number>()

/**
 * Session **and** day.
 *
 * A QQ conversation maps to a session that can stay alive for days, so a plain
 * per-session counter would run out after three captures and then stay silent
 * forever. The day component resets the allowance without letting one long chat
 * accumulate hundreds of images.
 */
export function autoCollectKey(sessionId: string, now: Date = new Date()): string {
  const day = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `${sessionId}:${day}`
}

function sessionKeyOf(exec: ToolExecContext | undefined): string {
  return autoCollectKey(exec?.agent?.session?.id ?? 'unknown')
}

function noteAutoCollected(exec: ToolExecContext | undefined): void {
  const key = sessionKeyOf(exec)
  // Keep the map from growing across a long-lived host.
  if (autoCollected.size > 500) autoCollected.clear()
  autoCollected.set(key, (autoCollected.get(key) ?? 0) + 1)
}

function autoCollectedIn(exec: ToolExecContext | undefined): number {
  return autoCollected.get(sessionKeyOf(exec)) ?? 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function text(value: string): ToolTextBlock[] {
  return [{ type: 'text', text: value }]
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
    .filter((item) => item.length > 0).slice(0, limit)
}

/** Format an instant the way a person would say it. */
function whenLabel(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const minutes = Math.round((at - now) / 60_000)
  const around = new Date(at)
  const clock = `${String(around.getHours()).padStart(2, '0')}:${String(around.getMinutes()).padStart(2, '0')}`
  if (minutes < 0) return `${clock}（已过期 ${String(Math.round(-minutes / 60))} 小时）`
  if (minutes < 60) return `${clock}（${String(minutes)} 分钟后）`
  if (minutes < 60 * 24) return `${clock}（${String(Math.round(minutes / 60))} 小时后）`
  return `${clock}（${String(Math.round(minutes / 1440))} 天后）`
}

/**
 * Build the sticker and reminder tools.
 *
 * Returned separately from the memory tools so `tools.ts` keeps one array literal
 * per tool and this file can be tested on its own with duck-typed surfaces.
 */
export function buildLifeTools(extras: LifeToolExtras): ToolDefinition[] {
  const tools: ToolDefinition[] = []

  if (extras.stickers !== undefined) {
    const stickers = extras.stickers
    tools.push({
      name: 'sticker_pick',
      description: [
        'Pick one sticker from the user\'s own library for the current mood, and get its local file path so it can be sent as an image.',
        'Call this only when a sticker genuinely adds to the message — roughly one sticker every few turns, never twice in a row.',
        'It enforces the user\'s send policy: when it returns ok=false, relay the reason instead of sending anything.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          emotion: { type: 'string', description: 'The mood to express, e.g. 开心 / 无语 / 摸摸头 / 晚安.' },
          context: { type: 'string', description: 'Optional: what the user just said or did, used to break ties.' },
        },
        required: ['emotion'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            description: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' },
            retryAt: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const payload = value as { ok: boolean; path?: string; description?: string; reason?: string; retryAt?: string }
          if (!payload.ok) {
            return text(`No sticker sent: ${payload.reason ?? 'send policy refused this one.'}`)
          }
          return text(`Sticker: ${payload.description ?? ''}\nSend it as an image message from: ${payload.path ?? ''}`)
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const emotion = typeof input['emotion'] === 'string' ? input['emotion'].trim() : ''
        const context = typeof input['context'] === 'string' ? input['context'].trim() : ''
        if (emotion.length === 0 && context.length === 0) {
          throw new Error('sticker_pick requires `emotion` (or at least `context`)')
        }
        return await stickers.pick({
          ...(emotion.length === 0 ? {} : { emotion }),
          ...(context.length === 0 ? {} : { context }),
        })
      },
    })

    tools.push({
      name: 'sticker_ingest',
      description: [
        'Add one image from the local disk to the user\'s sticker library.',
        'Use it when the user shares an image and says to keep it, or when a chat image is clearly meant as a reaction.',
        'Duplicate bytes are reported as such and never stored twice.',
        'At most three self-initiated captures per conversation; pass source=import when the user explicitly asks, which is not capped.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Absolute path of the image file on this machine.' },
          description: { type: 'string', description: 'What the sticker expresses, in the user\'s language.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Mood tags; the emotion vocabulary used by the library.' },
          source: { type: 'string', enum: ['import', 'incoming', 'stolen', 'other'], description: 'Where it came from.' },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            duplicate: { type: 'boolean' },
            description: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const payload = value as { ok: boolean; duplicate?: boolean; description?: string; reason?: string }
          if (!payload.ok) return text(`Not added: ${payload.reason ?? 'unknown reason'}`)
          return text(payload.duplicate === true
            ? `Already in the library: ${payload.description ?? ''}`
            : `Added to the sticker library: ${payload.description ?? ''}`)
        },
      },
      execute: async (args, exec) => {
        const input = asRecord(args)
        const path = typeof input['path'] === 'string' ? input['path'].trim() : ''
        if (path.length === 0) throw new Error('sticker_ingest requires `path`')
        const source = input['source']
        const allowed = source === 'import' || source === 'incoming' || source === 'stolen' || source === 'other'
        const effective = allowed ? source : 'incoming'
        // Capped only for the model's own initiative. `import` means the user asked.
        if (effective !== 'import' && autoCollectedIn(exec) >= AUTO_COLLECT_MAX_PER_DAY) {
          return {
            ok: false,
            reason: `今天已经自动收录 ${String(AUTO_COLLECT_MAX_PER_DAY)} 张。若用户明确要求继续，请用 source=import 再收录。`,
          }
        }
        const result = await stickers.importPath(path, {
          ...(typeof input['description'] === 'string' && input['description'].trim().length > 0
            ? { description: input['description'].trim() }
            : {}),
          ...(stringList(input['tags'], 12).length === 0 ? {} : { tags: stringList(input['tags'], 12) }),
          source: effective,
        })
        if (!result.ok) return { ok: false, reason: result.reason }
        if (!result.duplicate && effective !== 'import') noteAutoCollected(exec)
        return {
          ok: true,
          id: result.record.id,
          duplicate: result.duplicate,
          description: result.record.description,
        }
      },
    })
  }

  if (extras.reminders !== undefined) {
    const reminders = extras.reminders
    const assertAllowed = extras.assertAllowed

    tools.push({
      name: 'reminder_create',
      description: [
        'Create one personal reminder. `dueAt` is an ISO instant; `inMinutes` is a relative shortcut.',
        'Convert the user\'s natural language to one of the two — never guess a date the user did not say.',
        'Reminders are delivered by the chat channel only while its passive window is open, so the due time should be a real deadline, not a nudge time.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'What to be reminded about, in the user\'s words.' },
          dueAt: { type: 'string', description: 'ISO 8601 instant, e.g. 2026-11-14T15:00:00+08:00.' },
          inMinutes: { type: 'integer', description: 'Relative alternative to dueAt (1-43200).' },
          note: { type: 'string', description: 'Optional extra detail.' },
          repeat: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional recurrence.',
            properties: {
              unit: { type: 'string', enum: ['day', 'week', 'month'] },
              interval: { type: 'integer' },
            },
            required: ['unit'],
          },
        },
        required: ['title'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'dueAt'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            dueAt: { type: 'string' },
            repeat: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const payload = value as { id: string; title: string; dueAt: string; repeat?: string }
          const suffix = payload.repeat === undefined ? '' : ` (repeats ${payload.repeat})`
          return text(`Reminder created: “${payload.title}” at ${whenLabel(payload.dueAt, Date.now())}${suffix}\nid: ${payload.id}`)
        },
      },
      execute: async (args, exec) => {
        assertAllowed?.(exec)
        const input = asRecord(args)
        const title = typeof input['title'] === 'string' ? input['title'].trim() : ''
        if (title.length === 0) throw new Error('reminder_create requires `title`')
        const dueAtRaw = typeof input['dueAt'] === 'string' ? input['dueAt'].trim() : ''
        const inMinutes = typeof input['inMinutes'] === 'number' && Number.isFinite(input['inMinutes'])
          ? Math.round(input['inMinutes'])
          : null
        let dueAt: string
        if (dueAtRaw.length > 0) {
          const parsed = Date.parse(dueAtRaw)
          if (Number.isNaN(parsed)) throw new Error(`reminder_create: \`dueAt\` is not a valid instant: ${dueAtRaw}`)
          dueAt = new Date(parsed).toISOString()
        } else if (inMinutes !== null && inMinutes > 0) {
          dueAt = new Date(Date.now() + Math.min(43_200, inMinutes) * 60_000).toISOString()
        } else {
          throw new Error('reminder_create requires either `dueAt` or `inMinutes`')
        }
        const repeatRaw = asRecord(input['repeat'])
        const unit = repeatRaw['unit']
        const repeat: { unit: 'day' | 'week' | 'month'; interval: number } | null =
          unit === 'day' || unit === 'week' || unit === 'month'
            ? {
              unit,
              interval: typeof repeatRaw['interval'] === 'number' && repeatRaw['interval'] > 0
                ? Math.min(12, Math.round(repeatRaw['interval']))
                : 1,
            }
            : null
        const note = typeof input['note'] === 'string' ? input['note'].trim() : ''
        const record = await reminders.create({
          title: title.slice(0, 120),
          dueAt,
          ...(note.length === 0 ? {} : { note: note.slice(0, 300) }),
          repeat,
        })
        return {
          id: record.id,
          title: record.title,
          dueAt: record.dueAt,
          ...(record.repeat === null ? {} : { repeat: `${String(record.repeat.interval)} ${record.repeat.unit}` }),
        }
      },
    })

    tools.push({
      name: 'reminder_list',
      description: 'List the user\'s reminders, soonest first. Use it before creating a duplicate or when asked what is coming up.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['pending', 'all'], description: 'Defaults to pending only.' },
          limit: { type: 'integer', description: '1-50, default 10.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'items'],
          properties: {
            count: { type: 'integer' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'title', 'dueAt', 'status'],
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  dueAt: { type: 'string' },
                  status: { type: 'string' },
                  note: { type: 'string' },
                  attempts: { type: 'integer' },
                  /** When this one may actually be sent (quiet hours / backoff applied). */
                  nextAttemptAt: { type: 'string' },
                  deliverable: { type: 'boolean' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const payload = value as {
            count: number
            items: { title: string; dueAt: string; status: string; attempts: number; deliverable?: boolean; nextAttemptAt?: string }[]
          }
          if (payload.count === 0) return text('No reminders.')
          const lines = payload.items.map((item) => {
            const late = item.attempts > 0 ? ` · 已尝试投递 ${String(item.attempts)} 次` : ''
            const wait = item.deliverable === false && item.nextAttemptAt !== undefined
              ? ` · 下次可投递 ${whenLabel(item.nextAttemptAt, Date.now())}`
              : ''
            return `- [${item.status}] ${item.title} — ${whenLabel(item.dueAt, Date.now())}${late}${wait}`
          })
          return text(`${String(payload.count)} reminder(s):\n${lines.join('\n')}`)
        },
      },
      execute: async (args, exec) => {
        assertAllowed?.(exec)
        const input = asRecord(args)
        const wantAll = input['status'] === 'all'
        const limitRaw = input['limit']
        const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw)
          ? Math.min(50, Math.max(1, Math.round(limitRaw)))
          : 10
        const all = await reminders.list()
        const rows = all
          .filter((item) => (wantAll ? true : item.status === 'pending'))
          .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
          .slice(0, limit)
        // Decorate with the delivery decision so the model can say "not before
        // 08:00" instead of implying it will speak in the middle of the night.
        const policy = typeof reminders.policy === 'function' ? await reminders.policy() : null
        const now = Date.now()
        return {
          count: rows.length,
          items: rows.map((item) => {
            const decision = policy === null
              ? null
              : shouldDeliver(
                { dueAt: item.dueAt, attempts: item.attempts, lastAttemptAt: item.lastAttemptAt, status: item.status },
                policy,
                now,
              )
            return {
              id: item.id,
              title: item.title,
              dueAt: item.dueAt,
              status: item.status,
              ...(item.note.length === 0 ? {} : { note: item.note }),
              attempts: item.attempts,
              ...(decision === null || decision.deliver
                ? { deliverable: decision === null ? undefined : true }
                : { deliverable: false, ...(decision.nextAttemptAt === undefined ? {} : { nextAttemptAt: decision.nextAttemptAt }) }),
            }
          }),
        }
      },
    })

    tools.push({
      name: 'reminder_complete',
      description: 'Mark one reminder done. A repeating reminder immediately rolls forward to its next occurrence.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Reminder id as returned by reminder_list.' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'done'],
          properties: {
            id: { type: 'string' },
            done: { type: 'boolean' },
            nextId: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const payload = value as { id: string; done: boolean; nextId?: string }
          if (!payload.done) return text(`No reminder with id ${payload.id}.`)
          return text(payload.nextId === undefined
            ? 'Reminder completed.'
            : `Reminder completed; the next occurrence is scheduled (id ${payload.nextId}).`)
        },
      },
      execute: async (args, exec) => {
        assertAllowed?.(exec)
        const input = asRecord(args)
        const id = typeof input['id'] === 'string' ? input['id'].trim() : ''
        if (id.length === 0) throw new Error('reminder_complete requires `id`')
        const result = await reminders.complete(id)
        if (result === null) return { id, done: false }
        return {
          id,
          done: true,
          ...(result.next === null ? {} : { nextId: result.next.id }),
        }
      },
    })
  }

  return tools
}
