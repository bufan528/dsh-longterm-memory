/**
 * Retrieval: turning a query — or the current task — into a bounded set of
 * memories worth putting in front of the model.
 *
 * Everything here is deterministic and local. Semantic search is deliberately
 * absent: no embedding model is verified available in this deployment, and
 * faking one would be worse than not having it.
 *
 * @module dsh-longterm-memory/host/core/retrieval
 */

import type { MemoryIndex, QueryFilters, SearchHit } from '../../shared/search.js'
import { queryIndex, relatedMemories } from '../../shared/search.js'
import { estimateTokens, renderRecallBlock, renderStandingBlock, type RecallRenderResult } from '../../shared/recall.js'

/** Categories whose content is a standing fact about the user. */
const STANDING_TYPES = ['profile', 'preference'] as const

export interface RecallInput {
  query: string
  budgetTokens: number
  maxItems: number
  /** Include archived/superseded/conflicting memories as *history*, clearly labelled. */
  includeNonCurrent?: boolean
  /** Extra filters, e.g. the session's workspace. */
  filters?: QueryFilters
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
  const currentFilters: QueryFilters = { ...(input.filters ?? {}), statuses: ['active'] }
  const current = queryIndex(index, {
    text: input.query,
    filters: currentFilters,
    limit: Math.max(input.maxItems * 4, 24),
  })

  let hits = current
  let historyOnly = false
  if (hits.length === 0 && input.includeNonCurrent !== false) {
    const historical = queryIndex(index, {
      text: input.query,
      ...(input.filters === undefined ? {} : { filters: input.filters }),
      limit: Math.max(input.maxItems * 2, 12),
    }).filter((hit) => hit.record.status !== 'active')
    if (historical.length > 0) {
      hits = historical
      historyOnly = true
    }
  }

  const purpose = historyOnly ? HISTORY_PURPOSE : CURRENT_PURPOSE
  return renderHits(hits, input, purpose, historyOnly)
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
}

/**
 * The slow-moving facts that belong in the system prompt.
 *
 * Only profile, preference, and pinned memories qualify. Keeping this narrow is
 * what protects the provider prefix cache: a system prompt that changed every
 * turn would cost far more than the memories are worth.
 */
export function standingFacts(index: MemoryIndex, input: StandingInput): RecallRenderResult & { hits: SearchHit[] } {
  const hits = queryIndex(index, { filters: { statuses: ['active'], types: [...STANDING_TYPES] }, limit: 200 })
  const pinned = queryIndex(index, { filters: { statuses: ['active'], pinnedOnly: true }, limit: 200 })

  const merged: SearchHit[] = []
  const seen = new Set<string>()
  // Pinned first: the user explicitly asked for these, and they are the most
  // stable content in the vault, so they belong at the top of a cached prefix.
  for (const hit of [...pinned, ...hits]) {
    if (seen.has(hit.record.id)) continue
    seen.add(hit.record.id)
    merged.push(hit)
  }

  const rendered = renderStandingBlock(merged, { budgetTokens: input.budgetTokens, maxItems: input.maxItems })
  return { ...rendered, hits: merged }
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
