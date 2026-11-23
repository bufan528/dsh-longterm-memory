/**
 * Deterministic link inference for newly written memories.
 *
 * The design follows what the mature note systems do: several weak signals,
 * a strict threshold, a small cap, and a reason stored next to every edge. It
 * never uses an embedding service, so it runs offline and gives the same answer
 * on the same vault.
 *
 * Signals, strongest first:
 *  - the source text names the other memory (title or alias);
 *  - the two memories share a non-generic tag, weighted by how rare that tag is;
 *  - their weighted term vectors are close (cosine over the existing index).
 *
 * Manual links always win: an inferred link is dropped when the user already
 * linked the same target, and the generated block lives apart from user lines.
 *
 * @module dsh-longterm-memory/host/core/autolink
 */

import { DEFAULT_VISIBILITY, TYPE_DESCRIPTORS, type AutoLink, type Memory } from '../../shared/types.js'
import { extractWikilinks } from '../../shared/markdown.js'
import {
  fieldTokens,
  normalizeLinkTarget,
  termWeights,
  type IndexRecord,
  type MemoryIndex,
} from '../../shared/search.js'

/** How many inferred links one memory may carry. */
export const AUTO_LINK_LIMIT = 3
/** Below this weighted score a candidate is noise, not a relation. */
const MIN_SCORE = 12

export interface AutoLinkOptions {
  limit?: number
  minScore?: number
}

/** Infer links for `memory` against the current index. */
export function suggestAutoLinks(memory: Memory, index: MemoryIndex, options: AutoLinkOptions = {}): AutoLink[] {
  const limit = Math.max(0, Math.min(8, options.limit ?? AUTO_LINK_LIMIT))
  if (limit === 0) return []
  const minScore = options.minScore ?? MIN_SCORE
  const bodyText = [memory.summary, ...memory.sections.map((section) => section.body), memory.evidence].join('\n')
  // A wikilink the user typed is already a relation; inferring it again would
  // mislabel the edge as automatic and duplicate it in the note.
  const manual = new Set(
    [...memory.related, ...extractWikilinks(bodyText)].map(normalizeLinkTarget),
  )
  const genericTags = new Set(Object.values(TYPE_DESCRIPTORS).map((descriptor) => descriptor.defaultTag))
  const tagDf = new Map<string, number>()
  const inDegree = new Map<string, number>()

  for (const record of index.records.values()) {
    for (const tag of new Set(record.tags)) tagDf.set(tag, (tagDf.get(tag) ?? 0) + 1)
  }
  for (const targets of index.resolvedLinks.values()) {
    for (const target of targets) inDegree.set(target, (inDegree.get(target) ?? 0) + 1)
  }

  const total = Math.max(2, index.records.size)
  // A tag shared by most of a tiny vault is not a hub yet; only large vaults can
  // afford to drop ubiquitous tags.
  const hubTagFloor = Math.max(5, total * 0.45)
  const sourceText = normalizeText([memory.title, ...memory.aliases, bodyText].join('\n'))
  const sourceTerms = termWeights(
    fieldTokens({
      title: memory.title,
      aliases: memory.aliases,
      tags: memory.tags,
      summary: memory.summary,
      body: [memory.sections.map((section) => section.body).join('\n'), memory.evidence].join('\n'),
    }),
  )

  const candidates: { target: string; reason: string; score: number }[] = []
  for (const record of index.records.values()) {
    if (record.id === memory.id) continue
    if (record.status === 'archived' || record.status === 'superseded' || record.status === 'conflict') continue
    // Never let an inferred link cross a read boundary: the title would be
    // written into a note the other interface may read.
    if ((record.visibility ?? DEFAULT_VISIBILITY) !== memory.visibility) continue
    if (isManuallyLinked(record, manual)) continue

    const reasons: string[] = []
    let score = 0

    const mentioned = [record.title, ...record.aliases]
      .filter((name) => name.trim().length >= 2)
      .some((name) => sourceText.includes(normalizeText(name)))
    if (mentioned) {
      score += 44
      reasons.push(`正文提及「${record.title}」`)
    }

    const sharedTags = record.tags.filter(
      (tag) => memory.tags.includes(tag) && !genericTags.has(tag) && (tagDf.get(tag) ?? 0) < hubTagFloor,
    )
    if (sharedTags.length > 0) {
      let tagScore = 0
      for (const tag of sharedTags) tagScore += 20 / (1 + Math.log1p(tagDf.get(tag) ?? 1))
      score += Math.min(34, tagScore)
      reasons.push(`共享标签：${sharedTags.slice(0, 3).join('、')}`)
    }

    const similarity = cosine(sourceTerms, record.terms)
    if (similarity >= 0.16) {
      score += Math.min(34, similarity * 60)
      reasons.push('内容相近')
    } else if (similarity >= 0.08) {
      // Weak overlap still nudges the ranking but cannot carry an edge alone.
      score += similarity * 30
    }

    if (record.type === memory.type) score += 3
    if (record.pinned) score += 2
    score += (record.importance / 100) * 2
    // A well-connected note is already easy to find; do not turn it into a hub.
    score /= 1 + (inDegree.get(record.id) ?? 0) * 0.05

    if (reasons.length === 0 || score < minScore) continue
    candidates.push({ target: record.title, reason: reasons.join(' · '), score })
  }

  if (candidates.length === 0) return []
  candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.target.localeCompare(b.target, 'zh-Hans-CN')))
  const best = candidates[0]?.score ?? 0
  return candidates
    .filter((candidate) => candidate.score >= Math.max(minScore, best * 0.5))
    .slice(0, limit)
    .map((candidate) => ({ target: candidate.target, reason: candidate.reason }))
}

/** Return a copy of `memory` with freshly inferred links. */
export function refreshAutoLinks(memory: Memory, index: MemoryIndex, options: AutoLinkOptions = {}): Memory {
  return { ...memory, relatedAuto: suggestAutoLinks(memory, index, options) }
}

function isManuallyLinked(record: IndexRecord, manual: Set<string>): boolean {
  if (manual.size === 0) return false
  if (manual.has(normalizeLinkTarget(record.id))) return true
  if (manual.has(normalizeLinkTarget(record.title))) return true
  return record.aliases.some((alias) => manual.has(normalizeLinkTarget(alias)))
}

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [term, weight] of Object.entries(a)) {
    normA += weight * weight
    const other = b[term]
    if (other !== undefined) dot += weight * other
  }
  for (const weight of Object.values(b)) normB += weight * weight
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')
}
