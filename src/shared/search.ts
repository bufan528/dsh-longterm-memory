/**
 * Pure tokenizer and ranking for the local memory index.
 *
 * The index is a keyword index, not a semantic one: it must work with zero
 * external services. CJK text is tokenised into unigrams and bigrams because
 * those scripts do not separate words with spaces; Latin text is tokenised into
 * lower-cased word runs.
 *
 * @module dsh-longterm-memory/shared/search
 */

/** Bumped when tokenisation or scoring changes so a stale index is rebuilt. */
export const INDEX_FORMAT_VERSION = 3

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const WORD = /[a-z0-9][a-z0-9_]*/g
const MAX_TOKENS_PER_FIELD = 4000

/** Tokenise one string into index terms. */
export function tokenize(text: string): string[] {
  if (text.length === 0) return []
  const lowered = text.toLowerCase().normalize('NFKC')
  const out: string[] = []

  // Latin/numeric runs.
  for (const match of lowered.matchAll(WORD)) {
    const token = match[0]
    if (token.length === 1 && !/[0-9]/.test(token)) continue // single letters carry no signal
    out.push(token)
    if (out.length >= MAX_TOKENS_PER_FIELD) return dedupe(out)
  }

  // CJK runs → unigrams + bigrams.
  let run: string[] = []
  const flush = (): void => {
    if (run.length === 0) return
    for (const char of run) out.push(char)
    for (let index = 0; index + 1 < run.length; index += 1) out.push(`${run[index]}${run[index + 1]}`)
    run = []
  }
  for (const char of lowered) {
    if (CJK.test(char)) run.push(char)
    else flush()
  }
  flush()

  return dedupe(out).slice(0, MAX_TOKENS_PER_FIELD)
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** Weighted field tokens for one document. */
export interface FieldTokens {
  title: string[]
  aliases: string[]
  tags: string[]
  summary: string[]
  body: string[]
}

/** Token counts with the per-field boosts already folded in. */
export function fieldTokens(input: {
  title: string
  aliases: readonly string[]
  tags: readonly string[]
  summary: string
  body: string
}): FieldTokens {
  return {
    title: tokenize(input.title),
    aliases: input.aliases.flatMap((alias) => tokenize(alias)),
    tags: input.tags.flatMap((tag) => tokenize(tag)),
    summary: tokenize(input.summary),
    body: tokenize(input.body),
  }
}

/** Per-field multipliers chosen so a title hit outranks a body hit by ~8x. */
const FIELD_WEIGHT = {
  title: 8,
  aliases: 6,
  tags: 6,
  summary: 3,
  body: 1,
} as const

/**
 * Fold field tokens into one term→weight map.
 *
 * Repetition inside a field is damped by `1 + log(count)` so a note that repeats
 * a word cannot dominate a note that uses it once.
 */
export function termWeights(tokens: FieldTokens): Record<string, number> {
  const counts = new Map<string, Record<keyof FieldTokens, number>>()
  const bump = (field: keyof FieldTokens, term: string): void => {
    let entry = counts.get(term)
    if (entry === undefined) {
      entry = { title: 0, aliases: 0, tags: 0, summary: 0, body: 0 }
      counts.set(term, entry)
    }
    entry[field] += 1
  }
  for (const field of ['title', 'aliases', 'tags', 'summary', 'body'] as const) {
    for (const term of tokens[field]) bump(field, term)
  }

  const weights: Record<string, number> = {}
  for (const [term, perField] of counts) {
    let weight = 0
    for (const field of ['title', 'aliases', 'tags', 'summary', 'body'] as const) {
      const count = perField[field]
      if (count === 0) continue
      weight += FIELD_WEIGHT[field] * (1 + Math.log(count))
    }
    weights[term] = round(weight)
  }
  return weights
}

/** One indexed document. Persistent: keep it small and plain-JSON. */
export interface IndexRecord {
  id: string
  /** Path relative to the vault root, using `/` separators. */
  path: string
  type: string
  status: string
  title: string
  tags: string[]
  aliases: string[]
  confidence: string
  importance: number
  pinned: boolean
  createdAt: string
  updatedAt: string
  /** First ~320 characters of the summary, for result snippets. */
  preview: string
  /** Term → weight. */
  terms: Record<string, number>
  /** `[[wikilink]]` targets as written (may be titles or ids). */
  links: string[]
  /** Byte length and mtime of the source file, for external-change detection. */
  size: number
  mtimeMs: number
  /** Content fingerprint, used to skip re-tokenising an unchanged file. */
  checksum: string
}

/** A rebuilt, in-memory index. `postings` is derived, never persisted. */
export interface MemoryIndex {
  version: number
  builtAt: string
  vaultPath: string
  records: Map<string, IndexRecord>
  /** term → record ids */
  postings: Map<string, string[]>
  /** record id → outgoing links resolved to record ids */
  resolvedLinks: Map<string, string[]>
}

export function emptyIndex(vaultPath: string): MemoryIndex {
  return {
    version: INDEX_FORMAT_VERSION,
    builtAt: new Date().toISOString(),
    vaultPath,
    records: new Map(),
    postings: new Map(),
    resolvedLinks: new Map(),
  }
}

/** Recompute postings and resolved links from records. */
export function deriveIndex(index: MemoryIndex): void {
  const postings = new Map<string, string[]>()
  for (const record of index.records.values()) {
    for (const term of Object.keys(record.terms)) {
      const bucket = postings.get(term)
      if (bucket === undefined) postings.set(term, [record.id])
      else bucket.push(record.id)
    }
  }
  index.postings = postings
  index.resolvedLinks = resolveLinks(index)
}

/**
 * Resolve `[[wikilink]]` targets to record ids.
 *
 * A target may be a memory id, a memory title, or a file stem. Unresolvable
 * targets are kept out of `resolvedLinks` so dangling links never look like
 * real relations.
 */
export function resolveLinks(index: MemoryIndex): Map<string, string[]> {
  const byTitle = new Map<string, string[]>()
  const byStem = new Map<string, string>()
  for (const record of index.records.values()) {
    const key = record.title.trim().toLowerCase()
    const bucket = byTitle.get(key)
    if (bucket === undefined) byTitle.set(key, [record.id])
    else bucket.push(record.id)
    const stem = record.path.replace(/^.*\//, '').replace(/\.md$/i, '')
    byStem.set(stem.toLowerCase(), record.id)
  }

  const resolved = new Map<string, string[]>()
  for (const record of index.records.values()) {
    const targets: string[] = []
    const seen = new Set<string>()
    for (const link of record.links) {
      const normalized = link.trim().toLowerCase()
      let targetId: string | undefined
      if (index.records.has(link.trim())) targetId = link.trim()
      else if (byTitle.has(normalized)) targetId = byTitle.get(normalized)?.[0]
      else if (byStem.has(normalized)) targetId = byStem.get(normalized)
      if (targetId === undefined || targetId === record.id || seen.has(targetId)) continue
      seen.add(targetId)
      targets.push(targetId)
    }
    resolved.set(record.id, targets)
  }
  return resolved
}

/** Filters that narrow a query. */
export interface QueryFilters {
  types?: string[]
  statuses?: string[]
  tags?: string[]
  /** Inclusive lower bound on `updatedAt`. */
  since?: string
  /** Exclusive upper bound on `updatedAt`. */
  until?: string
  pinnedOnly?: boolean
  minImportance?: number
}

export interface QueryInput {
  text?: string
  filters?: QueryFilters
  /** Maximum results. */
  limit?: number
  /** Restrict to these ids (used for scoped recall). */
  onlyIds?: string[]
}

/** One ranked search hit. */
export interface SearchHit {
  record: IndexRecord
  score: number
  /** Human-readable reasons the record matched, for the UI's relevance explanation. */
  reasons: string[]
  /** The matched terms, for highlighting. */
  matchedTerms: string[]
}

export function queryIndex(index: MemoryIndex, input: QueryInput): SearchHit[] {
  const filters = input.filters ?? {}
  const limit = clampLimit(input.limit)
  const terms = input.text !== undefined ? tokenize(input.text) : []
  const only = input.onlyIds !== undefined ? new Set(input.onlyIds) : null

  const candidates = [...index.records.values()].filter((record) => {
    if (only !== null && !only.has(record.id)) return false
    return passesFilters(record, filters)
  })

  if (terms.length === 0) {
    const ranked = candidates
      .map((record) => ({ record, score: baselineScore(record), reasons: ['filter match'], matchedTerms: [] }))
      .sort(byScoreThenRecency)
    return ranked.slice(0, limit)
  }

  const documentCount = Math.max(1, index.records.size)
  const weights = new Map<string, number>()
  for (const term of terms) {
    const df = index.postings.get(term)?.length ?? 0
    // Inverse document frequency with a floor, so a rare term dominates a common one.
    weights.set(term, Math.log(1 + documentCount / (1 + df)) + 0.5)
  }

  const hits: SearchHit[] = []
  for (const record of candidates) {
    let score = 0
    const matched: string[] = []
    let exactId = false
    const loweredTitle = record.title.toLowerCase()

    for (const term of terms) {
      const weight = record.terms[term]
      if (weight === undefined) continue
      score += weight * (weights.get(term) ?? 0.5)
      matched.push(term)
    }
    if (input.text !== undefined && record.id === input.text.trim()) {
      score += 1000
      exactId = true
    }
    if (input.text !== undefined && loweredTitle === input.text.trim().toLowerCase()) {
      score += 300
      exactId = true
    }
    if (matched.length === 0 && !exactId) continue
    score += baselineScore(record) * 0.02

    const reasons: string[] = []
    if (exactId) reasons.push('精确匹配记忆 ID 或标题')
    if (matched.length > 0) reasons.push(`关键词匹配：${matched.slice(0, 8).join('、')}`)
    const sharedTags = (filters.tags ?? []).filter((tag) => record.tags.includes(tag))
    if (sharedTags.length > 0) reasons.push(`标签匹配：${sharedTags.join('、')}`)

    hits.push({ record, score: round(score), reasons, matchedTerms: matched })
  }

  hits.sort(byScoreThenRecency)
  return hits.slice(0, limit)
}

/** Related memories: explicit links first, then shared tags, then shared terms. */
export function relatedMemories(index: MemoryIndex, id: string, limit = 10): SearchHit[] {
  const source = index.records.get(id)
  if (source === undefined) return []
  const linked = new Set(index.resolvedLinks.get(id) ?? [])
  const sourceTerms = new Set(Object.keys(source.terms))
  const hits: SearchHit[] = []

  for (const record of index.records.values()) {
    if (record.id === id) continue
    const reasons: string[] = []
    let score = 0
    if (linked.has(record.id)) {
      score += 100
      reasons.push('互相链接')
    }
    const sharedTags = record.tags.filter((tag) => source.tags.includes(tag))
    if (sharedTags.length > 0) {
      score += 12 * sharedTags.length
      reasons.push(`共同标签：${sharedTags.slice(0, 5).join('、')}`)
    }
    if (record.type === source.type) {
      score += 3
      reasons.push('同一类别')
    }
    let overlap = 0
    for (const term of Object.keys(record.terms)) {
      if (sourceTerms.has(term)) overlap += 1
    }
    if (overlap > 0) {
      score += Math.min(20, overlap * 0.5)
      if (reasons.length === 0) reasons.push(`内容关键词重合 ${String(overlap)} 项`)
    }
    if (score <= 0) continue
    hits.push({ record, score: round(score), reasons, matchedTerms: [] })
  }
  hits.sort(byScoreThenRecency)
  return hits.slice(0, clampLimit(limit))
}

/** Cheap content fingerprint (FNV-1a, 32-bit, hex) used to skip untouched files. */
export function checksum(content: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function passesFilters(record: IndexRecord, filters: QueryFilters): boolean {
  if (filters.types !== undefined && filters.types.length > 0 && !filters.types.includes(record.type)) return false
  if (filters.statuses !== undefined && filters.statuses.length > 0 && !filters.statuses.includes(record.status)) return false
  if (filters.tags !== undefined && filters.tags.length > 0) {
    const has = filters.tags.some((tag) => record.tags.includes(tag))
    if (!has) return false
  }
  if (filters.pinnedOnly === true && !record.pinned) return false
  if (filters.minImportance !== undefined && record.importance < filters.minImportance) return false
  if (filters.since !== undefined) {
    const since = Date.parse(filters.since)
    if (!Number.isNaN(since) && Date.parse(record.updatedAt) < since) return false
  }
  if (filters.until !== undefined) {
    const until = Date.parse(filters.until)
    if (!Number.isNaN(until) && Date.parse(record.updatedAt) >= until) return false
  }
  return true
}

function baselineScore(record: IndexRecord): number {
  const ageDays = Math.max(0, (Date.now() - Date.parse(record.updatedAt)) / 86_400_000)
  const recency = 12 / (1 + ageDays / 30)
  const confidence = record.confidence === 'high' ? 6 : record.confidence === 'medium' ? 3 : 0
  const pinned = record.pinned ? 8 : 0
  return round(recency + record.importance * 0.12 + confidence + pinned)
}

function byScoreThenRecency(a: SearchHit, b: SearchHit): number {
  if (b.score !== a.score) return b.score - a.score
  const aTime = Date.parse(a.record.updatedAt)
  const bTime = Date.parse(b.record.updatedAt)
  if (bTime !== aTime) return bTime - aTime
  return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 20
  return Math.max(1, Math.min(500, Math.floor(limit)))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
