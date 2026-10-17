/**
 * DSH integration: prompt contribution, per-step recall, and turn extraction.
 *
 * Two facts from the shipped DSH source shape this module:
 *
 * 1. **There is no per-turn Cordis event.** `ctx.on('turn/end')` does not exist;
 *    `turn/end` is a *session log* event. Extraction therefore subscribes to
 *    `session/event` and filters on `event.type === 'turn/end'`, which is the
 *    same pattern `@deepseek-ai/dsh-agent-instructions` uses for `step/end`.
 *
 * 2. **A prompt section's `text` may be a function**, re-evaluated on every
 *    `systemPrompt.assemble()` — that is, on every model step. That makes one
 *    registered section the cheapest legal per-request retrieval channel, and it
 *    is why retrieval is driven from there rather than by rewriting requests
 *    (which DSH forbids: `agent/request` cannot mutate messages).
 *
 * Every handler is defensive: a memory defect must never break a turn, so all
 * failures are contained and logged.
 *
 * @module dsh-longterm-memory/host/dsh/inject
 */

import type { PluginSettings } from '../../shared/protocol.js'
import { renderRetiredNotice, type RetiredMemory } from '../../shared/retraction.js'
import type { MemoryService } from '../core/service.js'

/** Minimal Cordis context surface this module uses. */
export interface CordisLike {
  get: (name: string) => unknown
  on: (name: string, listener: (...args: never[]) => unknown, options?: unknown) => unknown
  effect: (execute: () => unknown, label?: string) => unknown
  logger?: { info: (message: string, ...rest: unknown[]) => void; warn: (message: string, ...rest: unknown[]) => void }
}

/** Order chosen in DSH's free external range: after tool guidance, before environment facts. */
export const STANDING_SECTION_ORDER = 9500
export const STANDING_SECTION_NAME = 'longterm-memory:standing'

export interface InjectionResult {
  systemPrompt: boolean
  perStepRecall: boolean
  sessionEvents: boolean
  notes: Record<string, string>
}

interface SessionBuffer {
  userText: string[]
  assistantText: string[]
  turn: number | undefined
  cwd: string | undefined
}

const MAX_BUFFER_ENTRIES = 24
const MAX_TEXT_PER_ENTRY = 8000

/**
 * Install every injection path that this DSH build actually supports.
 *
 * @returns which paths were installed, so the management page can state the
 *   truth about what reaches the model instead of implying more.
 */
export function installInjections(ctx: CordisLike, service: MemoryService, settings: PluginSettings): InjectionResult {
  const notes: Record<string, string> = {}
  const systemPrompt = installStandingSection(ctx, service, notes)
  const sessionEvents = installTurnExtraction(ctx, service, settings, notes)
  let perStepRecall = false
  if (settings.enablePerStepRecall) {
    perStepRecall = installPerStepRecall(ctx, service, notes)
  } else {
    notes['perStepRecall'] = '每步注入默认关闭（会写入持久会话历史并长期占用 token）。'
  }
  return { systemPrompt, perStepRecall, sessionEvents, notes }
}

/**
 * The standing-facts system-prompt section.
 *
 * The exact section descriptor that is handed to `ctx.systemPrompt.section()` is
 * also recorded on the service, so the management page (and the acceptance
 * checks) can invoke the **same** `text` callback the prompt pipeline invokes.
 * That is how the plugin's prompt contribution is verified on a live host without
 * a model call: the callback is the contribution.
 */
export function installStandingSection(ctx: CordisLike, service: MemoryService, notes: Record<string, string>): boolean {
  const systemPrompt = ctx.get('systemPrompt') as
    | { section: (section: Record<string, unknown>) => unknown }
    | undefined
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
    notes['systemPrompt'] = '宿主未提供 ctx.systemPrompt，长期记忆无法进入系统提示词。'
    return false
  }
  const section = {
    name: STANDING_SECTION_NAME,
    order: STANDING_SECTION_ORDER,
    // Memory text may contain braces; interpolation must stay off or a stray
    // `{{name}}` would fail the whole prompt assembly.
    interpolate: false,
    text: (): string => {
      try {
        if (!service.isReady()) return ''
        return service.standing().text
      } catch (error) {
        ctx.logger?.warn('dsh-longterm-memory: standing section failed: %o', error)
        return ''
      }
    },
  }
  try {
    ctx.effect(() => systemPrompt.section(section), 'dsh-longterm-memory: system prompt section')
    service.setStandingSectionProbe({ name: section.name, order: section.order, text: section.text })
    return true
  } catch (error) {
    notes['systemPrompt'] = `注册系统提示词分区失败：${describeError(error)}`
    return false
  }
}

/**
 * Subscribe to the session log and extract a memory candidate set when a turn
 * ends.
 *
 * The buffer is per session and bounded, so a long session cannot grow the
 * plugin's memory without limit. Extraction work is chained per session so two
 * turns cannot write the same note concurrently.
 */
export function installTurnExtraction(
  ctx: CordisLike,
  service: MemoryService,
  settings: PluginSettings,
  notes: Record<string, string>,
): boolean {
  if (!settings.enableAutoExtraction) {
    notes['sessionEvents'] = '自动提取已关闭：会话结束时不会生成候选记忆。'
    return false
  }
  const buffers = new Map<string, SessionBuffer>()
  const chains = new Map<string, Promise<void>>()

  try {
    ctx.on(
      'session/event',
      ((session: unknown, event: unknown) => {
        try {
          handleSessionEvent(ctx, service, buffers, chains, session, event)
        } catch (error) {
          ctx.logger?.warn('dsh-longterm-memory: session/event handling failed: %o', error)
        }
      }) as (...args: never[]) => unknown,
      'dsh-longterm-memory: turn extraction',
    )
    return true
  } catch (error) {
    notes['sessionEvents'] = `无法订阅 session/event：${describeError(error)}`
    return false
  }
}

function handleSessionEvent(
  ctx: CordisLike,
  service: MemoryService,
  buffers: Map<string, SessionBuffer>,
  chains: Map<string, Promise<void>>,
  session: unknown,
  event: unknown,
): void {
  const type = readString(event, 'type')
  if (type === undefined) return
  const sessionId = sessionIdOf(session)
  if (sessionId === undefined) return

  if (type === 'user/message' || type === 'assistant/message') {
    const buffer = buffers.get(sessionId) ?? { userText: [], assistantText: [], turn: undefined, cwd: undefined }
    const text = messageText(readValue(event, 'data'))
    if (text.length === 0) return
    if (type === 'user/message') {
      buffer.userText.push(clip(text))
      if (buffer.userText.length > MAX_BUFFER_ENTRIES) buffer.userText.splice(0, buffer.userText.length - MAX_BUFFER_ENTRIES)
    } else {
      buffer.assistantText = [clip(text)]
    }
    buffer.cwd = sessionCwd(session) ?? buffer.cwd
    buffers.set(sessionId, buffer)
    return
  }

  if (type === 'turn/start') {
    const data = readValue(event, 'data')
    const turn = readNumber(data, 'turn')
    const buffer = buffers.get(sessionId) ?? { userText: [], assistantText: [], turn: undefined, cwd: undefined }
    if (turn !== undefined) buffer.turn = turn
    buffers.set(sessionId, buffer)
    return
  }

  if (type !== 'turn/end') return

  const buffer = buffers.get(sessionId)
  buffers.delete(sessionId)
  if (buffer === undefined || buffer.userText.length === 0) return
  const data = readValue(event, 'data')
  const turn = readNumber(data, 'turn') ?? buffer.turn

  const previous = chains.get(sessionId) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      if (!service.isReady()) {
        const ready = await service.ensureReady()
        if (!ready) return
      }
      const result = await service.processTurn({
        userText: buffer.userText.join('\n'),
        assistantText: buffer.assistantText.join('\n'),
        sessionId,
        ...(turn === undefined ? {} : { turn }),
        ...(buffer.cwd === undefined ? {} : { cwd: buffer.cwd }),
      })
      if (result.applied.length > 0 || result.pending.length > 0) {
        ctx.logger?.info(
          'dsh-longterm-memory: turn %s → %d applied, %d pending, %d refused',
          String(turn ?? '?'),
          result.applied.length,
          result.pending.length,
          result.refused.length,
        )
      }
    })
    .catch((error: unknown) => {
      ctx.logger?.warn('dsh-longterm-memory: extraction failed for session %s: %o', sessionId, error)
    })
    .finally(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId)
    })
  chains.set(sessionId, next)
}

/**
 * Splice query-relevant memory into the step as a user-role message.
 *
 * Off by default. This is the channel DSH itself uses for `AGENTS.md`, and it is
 * the only way to put *retrieved* memory in front of the model — but the message
 * becomes durable history replayed on every later request in the session, so it
 * costs tokens for the rest of the session. The system-prompt section is the
 * cheaper default; this exists for users who want per-step retrieval.
 */
export function installPerStepRecall(ctx: CordisLike, service: MemoryService, notes: Record<string, string>): boolean {
  let createUserMessage: ((input: Record<string, unknown>) => unknown) | undefined
  void (async () => {
    try {
      const moduleName = '@deepseek-ai/dsh-llm'
      const loaded = (await import(/* @vite-ignore */ moduleName)) as { createUserMessage?: (input: Record<string, unknown>) => unknown }
      if (typeof loaded.createUserMessage === 'function') createUserMessage = loaded.createUserMessage
      else notes['perStepRecall'] = '无法从 @deepseek-ai/dsh-llm 取得 createUserMessage，每步注入不可用。'
    } catch (error) {
      notes['perStepRecall'] = `无法加载 @deepseek-ai/dsh-llm（${describeError(error)}），每步注入不可用。`
    }
  })()

  // The agent loop dispatches `agent/pre-step` on the **agent's** scope, so a
  // listener registered on this plugin's own context never runs (the same scoping
  // rule that applies to `system-prompt/assemble`). Register per agent from
  // `agent/created`, and keep every disposer inside our own effect so unloading the
  // plugin removes all of them.
  const perAgentDisposers = new Map<string, () => void>()
  const handler = async (_payload: unknown, next: () => Promise<unknown>, corrected: Set<string>): Promise<unknown> => {
    const decision = (await next()) as { kind?: string; messages?: unknown[] } | undefined
    try {
      if (decision === undefined || decision.kind !== 'enter' || createUserMessage === undefined) return decision
      if (!service.isReady()) return decision
      const claimed = Array.isArray(decision.messages) ? decision.messages : []

      // --- retraction of earlier injections -------------------------------------
      // Session history is append-only, so an earlier recall block cannot be
      // withdrawn. When one of its memories is no longer current, append a notice
      // naming it. Deduplicated per agent so a long session does not accumulate
      // the same warning on every step.
      const priorIds = new Set<string>()
      for (const entry of claimed) {
        if (!sameRecallSource(entry)) continue
        for (const id of recallIdsOf(entry)) priorIds.add(id)
      }
      const retired = await retiredAmongIds(service, [...priorIds], corrected)
      let messages = [...(decision.messages ?? [])]
      if (retired.length > 0) {
        const notice = renderRetiredNotice(retired)
        if (notice.length > 0) {
          messages.push(
            createUserMessage({
              content: [{ type: 'text', text: notice }],
              source: { kind: 'longterm-memory', form: 'retraction', ids: retired.map((entry) => entry.id) },
            }),
          )
          for (const entry of retired) corrected.add(entry.id)
          ctx.logger?.info('dsh-longterm-memory: appended retraction for %d retired memory/memories', retired.length)
        }
      }

      // --- fresh injection ------------------------------------------------------
      const query = claimed.map(messageText).filter((text) => text.length > 0).join('\n')
      if (query.trim().length === 0) return retired.length > 0 ? { ...decision, messages } : decision
      // Disk-verified: an unverifiable candidate is dropped, never injected.
      const recalled = await service.recallForInjection(query)
      // Defence in depth: even if a future change made the service return retired
      // entries, an automatic path must never splice them. `historyOnly` marks
      // exactly that fallback, so treat it as "nothing to inject".
      if (recalled.historyOnly === true) {
        ctx.logger?.info('dsh-longterm-memory: per-step recall found only retired memories; not injecting')
        return retired.length > 0 ? { ...decision, messages } : decision
      }
      if (recalled.text.length === 0) return retired.length > 0 ? { ...decision, messages } : decision
      // Skip when an identical recall block is already on the decision.
      if (claimed.some((entry) => sameRecallSource(entry))) return { ...decision, messages }
      const message = createUserMessage({
        content: [{ type: 'text', text: recalled.text }],
        source: { kind: 'longterm-memory', form: 'recall', ids: recalled.includedIds },
      })
      // Drop any ids already retired so a fresh block never re-asserts them.
      const lastClaimed = claimed.length === 0 ? -1 : messages.findLastIndex((entry) => claimed.includes(entry))
      messages.splice(lastClaimed + 1, 0, message)
      return { ...decision, messages }
    } catch (error) {
      ctx.logger?.warn('dsh-longterm-memory: per-step recall failed: %o', error)
      return decision
    }
  }

  try {
    ctx.effect(() => {
      const onCreated = ctx.on('agent/created', (payload: unknown) => {
        const agent = (payload as { agent?: { id?: string; ctx?: CordisLike } }).agent
        if (agent?.ctx === undefined) return
        const agentId = agent.id ?? `agent-${String(Date.now())}`
        try {
          // One retraction memory per agent: an id is reported once per session.
          const corrected = new Set<string>()
          const scopedHandler = ((payload: unknown, next: () => Promise<unknown>) =>
            handler(payload, next, corrected)) as (...args: never[]) => unknown
          const dispose = agent.ctx.effect(
            () => agent.ctx?.on('agent/pre-step', scopedHandler as (...args: never[]) => unknown, { prepend: true }),
            'dsh-longterm-memory: per-step recall',
          )
          if (typeof dispose === 'function') perAgentDisposers.set(agentId, dispose as () => void)
          agent.ctx.on?.('agent/disposed', () => {
            perAgentDisposers.get(agentId)?.()
            perAgentDisposers.delete(agentId)
          })
        } catch (error) {
          ctx.logger?.warn('dsh-longterm-memory: per-step registration failed: %o', error)
          notes['perStepRecall'] = `无法为 agent 注册每步注入：${describeError(error)}`
        }
      })
      return () => {
        if (typeof onCreated === 'function') (onCreated as () => void)()
        for (const dispose of perAgentDisposers.values()) dispose()
        perAgentDisposers.clear()
      }
    }, 'dsh-longterm-memory: per-step recall lifecycle')
    return true
  } catch (error) {
    notes['perStepRecall'] = `无法订阅 agent/pre-step：${describeError(error)}`
    return false
  }
}

/** Ids carried by a recall message's `source`. */
function recallIdsOf(message: unknown): string[] {
  const source = readValue(message, 'source')
  const ids = readValue(source, 'ids')
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string')
}

/**
 * Which previously injected ids are no longer current, excluding ones already
 * retracted in this session. Unknown or unreadable ids are treated as retired:
 * telling the model to stop relying on a memory we cannot verify is the safe side.
 */
export async function retiredAmongIds(
  service: MemoryService,
  ids: readonly string[],
  alreadyCorrected: ReadonlySet<string>,
): Promise<RetiredMemory[]> {
  const retired: RetiredMemory[] = []
  for (const id of ids) {
    if (alreadyCorrected.has(id)) continue
    let status: string
    try {
      status = (await service.get(id)).memory.status
    } catch {
      status = 'missing'
    }
    if (status !== 'active') retired.push({ id, status })
  }
  return retired
}
function sameRecallSource(message: unknown): boolean {
  const source = readValue(message, 'source')
  return readString(source, 'kind') === 'longterm-memory' && readString(source, 'form') === 'recall'
}

/* --------------------------------------------------------------- accessors */

function readValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

function readString(value: unknown, key: string): string | undefined {
  const found = readValue(value, key)
  return typeof found === 'string' ? found : undefined
}

function readNumber(value: unknown, key: string): number | undefined {
  const found = readValue(value, key)
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined
}

/**
 * Pull the text out of a message of unknown shape.
 *
 * DSH message content is a block array, but a plugin must survive a host
 * version that changes the shape, so several plausible layouts are accepted and
 * an unknown one yields an empty string rather than throwing.
 */
export function messageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (block === null || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
      else if (typeof record['text'] === 'string') parts.push(record['text'])
    }
    if (parts.length > 0) return parts.join('\n')
  }
  if (typeof (message as { text?: unknown }).text === 'string') return (message as { text: string }).text
  if (typeof (message as { summary?: unknown }).summary === 'string') return (message as { summary: string }).summary
  return ''
}

function sessionIdOf(session: unknown): string | undefined {
  const direct = readString(session, 'id')
  if (direct !== undefined && direct.length > 0) return direct
  const header = readValue(session, 'header')
  const fromHeader = readString(header, 'id')
  return fromHeader !== undefined && fromHeader.length > 0 ? fromHeader : undefined
}

function sessionCwd(session: unknown): string | undefined {
  const header = readValue(session, 'header')
  const cwd = readString(header, 'cwd')
  return cwd !== undefined && cwd.length > 0 ? cwd : undefined
}

function clip(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  return normalized.length > MAX_TEXT_PER_ENTRY ? normalized.slice(0, MAX_TEXT_PER_ENTRY) : normalized
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
