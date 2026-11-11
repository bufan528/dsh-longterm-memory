/**
 * Retrieval: turning a query — or the current task — into a bounded set of
 * memories worth putting in front of the model.
 *
 * Two separate decisions live here, and conflating them is the classic failure:
 *
 * - **Selection** (which records are eligible) — narrow, principled, and biased
 *   towards "leave it out": a fact that is stale, mistyped or not actually about the
 *   person costs prompt budget and, worse, teaches the model to recite.
 * - **Presentation** (how they are worded) — delegated to `shared/recall`, which
 *   knows nothing about access and everything about phrasing.
 *
 * Everything here is deterministic and local. Semantic search is deliberately
 * absent: no embedding model is verified available in this deployment, and
 * faking one would be worse than not having it.
 *
 * @module dsh-longterm-memory/host/core/retrieval
 */

import type { IndexRecord, MemoryIndex, QueryFilters, SearchHit } from '../../shared/search.js'
import { queryIndex, relatedMemories } from '../../shared/search.js'
import {
  DEFAULT_GROUP_CAPS,
  estimateTokens,
  renderRecallBlock,
  renderStandingBlock,
  standingGroupOf,
  type PresentationLanguage,
  type RecallRenderResult,
  type StandingGroupCaps,
  type StandingRenderResult,
} from '../../shared/recall.js'

/**
 * Categories that may occupy a slot in the standing block.
 *
 * Broader than the pre-R1 `profile | preference` pair: a prompt that knows the
 * person's background and preferences but not what they are currently working on
 * reads as a stranger with a file. The narrowing happens through the per-slot caps
 * and the freshness window, not by excluding whole types.
 */
const STANDING_TYPES = [
  'profile',
  'preference',
  'project',
  'project-state',
  'task',
  'decision',
  'knowledge',
  'experience',
] as const

/** Types whose usefulness decays: only recent instances are injected. */
const FRESHNESS_SENSITIVE_TYPES = new Set(['project', 'project-state', 'task'])

export interface RecallInput {
  query: string
  budgetTokens: number
  maxItems: number
  /** Include archived/superseded/conflicting memories as *history*, clearly labelled. */
  includeNonCurrent?: boolean
  /** Extra filters, e.g. the session's workspace. */
  filters?: QueryFilters
  /**
   * Read scopes the caller may see, already decided by the owner gate.
   *
   * Kept separate from `filters` so every automatic path is forced to pass it
   * explicitly. Merged into the effective filter below; an empty array means
   * nothing is readable.
   */
  visibilities?: string[]
  /**
   * Apply the word-level relevance floor. Automatic injection must set this:
   * a single shared CJK character is a coincidence, not a match.
   */
  requireRelevance?: boolean
}

export interface RecallOutput extends RecallRenderResult {
  hits: SearchHit[]
  /** True when the block is only history and must not be presented as current fact. */
  historyOnly: boolean
}

/**
 * Retrieve memories relevant to one task and render them inside the token budget.
 *
 * Current facts and historical notes are never mixed invisibly: when the query
 * only matches retired memories the returned block says so, so the model is not
 * told that a superseded decision is still in force.
 */
export function retrieveForTask(index: MemoryIndex, input: RecallInput): RecallOutput {
  // The active-status restriction must survive an absent or partial filter
  // object: dropping it would let a retired memory be injected as current fact.
  const scope = input.visibilities === undefined ? {} : { visibilities: input.visibilities }
  const currentFilters: QueryFilters = { ...(input.filters ?? {}), ...scope, statuses: ['active'] }
  const current = queryIndex(index, {
    text: input.query,
    filters: currentFilters,
    limit: Math.max(input.maxItems * 4, 24),
  })

  let hits = current
  let historyOnly = false
  if (hits.length === 0 && input.includeNonCurrent !== false) {
    const historyFilters: QueryFilters = { ...(input.filters ?? {}), ...scope }
    const historical = queryIndex(index, {
      text: input.query,
      ...(input.filters === undefined && input.visibilities === undefined ? {} : { filters: historyFilters }),
      limit: Math.max(input.maxItems * 2, 12),
    }).filter((hit) => hit.record.status !== 'active')
    if (historical.length > 0) {
      hits = historical
      historyOnly = true
    }
  }

  if (input.requireRelevance === true) hits = hits.filter(isTopicallyRelevant)

  const purpose = historyOnly ? HISTORY_PURPOSE : CURRENT_PURPOSE
  return renderHits(hits, input, purpose, historyOnly)
}

/**
 * Is this hit about the queried subject, or did it match on a shared character?
 *
 * `queryIndex` scores substrings, which is right for a human browsing the vault and
 * wrong for automatic injection: 「明天会不会下雨」 used to match a memory titled
 * 「不加糖」 because both contain 不. The floor is deliberately crude — one CJK
 * character is never enough, and any hit with no matched term at all is dropped.
 */
export function isTopicallyRelevant(hit: SearchHit): boolean {
  const terms = hit.matchedTerms ?? []
  if (terms.length === 0) return false
  for (const term of terms) {
    if (term.length >= 2) return true
    // A single Latin/digit token (a port number, an initial) is still a real term.
    if (!isCjkText(term)) return true
  }
  return false
}

function isCjkText(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x3040 && code <= 0x30ff) return true
    if (code >= 0x3400 && code <= 0x4dbf) return true
    if (code >= 0x4e00 && code <= 0x9fff) return true
    if (code >= 0xf900 && code <= 0xfaff) return true
    if (code >= 0xac00 && code <= 0xd7af) return true
  }
  return false
}

/** Wording for entries that are still current fact, with snapshot precedence. */
export const CURRENT_PURPOSE =
  'These entries are the current, active memory for this task as of this step. If a later memory block or retraction notice disagrees with one of them, the later one wins.'

/** Wording for retired entries returned by an explicit search. */
export const HISTORY_PURPOSE =
  'These entries are NOT current fact: they are retired or contested memories kept for traceability.'

/**
 * Re-render a candidate set that was filtered after retrieval (for example because
 * a record turned out to be stale on disk), keeping the same budget and wording.
 */
export function renderHits(
  hits: SearchHit[],
  input: RecallInput,
  purpose: string,
  historyOnly = false,
): RecallRenderResult & { hits: SearchHit[]; historyOnly: boolean } {
  const rendered = renderRecallBlock(hits, {
    budgetTokens: input.budgetTokens,
    maxItems: input.maxItems,
    purpose,
    includePreview: true,
  })
  return { ...rendered, hits, historyOnly }
}

export interface StandingInput {
  budgetTokens: number
  maxItems: number
  language?: PresentationLanguage
  /** Semantic four-slot layout. `false` keeps the pre-R1 flat list. */
  grouped?: boolean
  /** Date / uncertainty annotations. */
  timeHints?: boolean
  /** Apply the "is this actually a fact about the user" filter. */
  qualityGate?: boolean
  /** Only inject `project*`/`task` records touched within this many days. */
  currentWindowDays?: number
  /**
   * Per-slot caps. A slot whose cap is 0 is not merely truncated: its types are
   * excluded up front and reported, so the page can say "not part of standing
   * memory" instead of "over the limit".
   */
  slotCaps?: Partial<StandingGroupCaps>
  /**
   * Read scopes the caller is allowed to see, already decided by the owner gate.
   *
   * `undefined` = no restriction (vault browsing); an empty array = nothing is
   * readable. The retrieval layer only compares strings — it has no idea who is
   * asking, so it cannot widen this.
   */
  visibilities?: string[]
  /** Reference instant; injected by tests so the output is deterministic. */
  now?: Date
}

/** Why a record was withheld from the standing block. */
export type StandingQualityProblem = 'pasted-instruction' | 'transcript-quote'

/** Reasons a record does not reach the prompt. */
export type StandingExclusionReason = StandingQualityProblem | 'stale-window' | 'slot-disabled'

/**
 * Would this record read, to a model, like text it should *obey* or *continue*?
 *
 * The vault is fed by an extractor and by `memory_save`, so it collects things that
 * are not facts about the person: a tool signature someone pasted while debugging,
 * a quoted line of a transcript, a settings-doc fragment. Injecting those into a
 * system prompt at order 9500 hands them far more authority than they ever had in
 * the conversation.
 *
 * Pinned records are exempt: the person explicitly asked for them, which is a
 * stronger signal than any heuristic here.
 */
export function standingQualityProblem(record: IndexRecord): StandingQualityProblem | null {
  if (record.pinned) return null
  const title = record.title.trim()
  const body = record.preview.trim()
  const both = `${title}\n${body}`

  // Code / call shape: object literals, arrow functions, keyword arguments.
  if (/(?:\(\s*\{|=>|\{\s*["'][A-Za-z_][\w-]*["']\s*:)/.test(both)) return 'pasted-instruction'
  // Directory entry: "`tool_name`: what it does".
  if (/^`{1,2}[A-Za-z0-9_.-]+`{1,2}\s*[:：]/.test(title)) return 'pasted-instruction'
  // A quoted turn: a speaker label or an opening quote followed by a long line.
  if (/^(?:Then\s*:|User\s*:|用户\s*[:：]|>\s|["“「'])/.test(title) && title.length >= 24) {
    return 'transcript-quote'
  }
  return null
}

export interface StandingOutput extends StandingRenderResult {
  hits: SearchHit[]
  /** Ids withheld before rendering, with the reason. */
  excluded: { id: string; title: string; reason: StandingExclusionReason }[]
}

/**
 * The slow-moving facts that belong in the system prompt.
 *
 * Selection is deliberately narrow, for two reasons: prompt budget, and a
 * behavioural one — the more of the vault is recited, the more the model treats the
 * vault as something to summarise back at the person.
 */
export function standingFacts(index: MemoryIndex, input: StandingInput): StandingOutput {
  const now = input.now ?? new Date()
  const windowDays = input.currentWindowDays ?? 45
  const caps = { ...DEFAULT_GROUP_CAPS, ...(input.slotCaps ?? {}) }
  const types = [...STANDING_TYPES]
  const scope = input.visibilities === undefined ? {} : { visibilities: input.visibilities }
  const all = queryIndex(index, { filters: { statuses: ['active'], types, ...scope }, limit: 400 })
  const pinned = queryIndex(index, { filters: { statuses: ['active'], pinnedOnly: true, ...scope }, limit: 200 })

  const excluded: StandingOutput['excluded'] = []
  const seen = new Set<string>()
  const merged: SearchHit[] = []

  // Pinned first: the user explicitly asked for these, and they are the most
  // stable content in the vault, so they belong at the top of a cached prefix.
  for (const hit of [...pinned, ...all]) {
    if (seen.has(hit.record.id)) continue
    seen.add(hit.record.id)
    // A pinned record overrides the slot switch: the person asked for it by name.
    if (!hit.record.pinned && caps[standingGroupOf(hit.record.type)] === 0) {
      excluded.push({ id: hit.record.id, title: hit.record.title, reason: 'slot-disabled' })
      continue
    }
    if (input.qualityGate !== false) {
      const problem = standingQualityProblem(hit.record)
      if (problem !== null) {
        excluded.push({ id: hit.record.id, title: hit.record.title, reason: problem })
        continue
      }
    }
    if (FRESHNESS_SENSITIVE_TYPES.has(hit.record.type)) {
      const updated = Date.parse(hit.record.updatedAt)
      if (Number.isFinite(updated)) {
        const age = Math.floor((now.getTime() - updated) / 86_400_000)
        // Pinned items are exempt from the window: the person asked for them.
        if (!hit.record.pinned && age > windowDays) {
          excluded.push({ id: hit.record.id, title: hit.record.title, reason: 'stale-window' })
          continue
        }
      }
    }
    merged.push(hit)
  }

  const rendered = renderStandingBlock(merged, {
    budgetTokens: input.budgetTokens,
    maxItems: input.maxItems,
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(input.grouped === undefined ? {} : { grouped: input.grouped }),
    ...(input.timeHints === undefined ? {} : { timeHints: input.timeHints }),
    caps,
    now,
  })
  return { ...rendered, hits: merged, excluded }
}

/** Related memories for the detail pane. */
export function relatedFor(index: MemoryIndex, id: string, limit = 12): SearchHit[] {
  return relatedMemories(index, id, limit)
}

/** Distinct tags with counts, for the filter UI. */
export function tagCounts(index: MemoryIndex): { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const record of index.records.values()) {
    for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.tag.localeCompare(b.tag)))
}

/** A cheap guard so callers can decide whether a recall block is worth emitting. */
export function isWorthInjecting(rendered: RecallRenderResult, minimumTokens = 24): boolean {
  return rendered.text.length > 0 && rendered.usedTokens >= minimumTokens
}

export { estimateTokens }
