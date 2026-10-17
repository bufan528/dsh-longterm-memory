/**
 * Model-assisted memory extraction.
 *
 * The rule-based extractor in `engine.ts` is the default because it costs
 * nothing and cannot leak anything. This module adds the *optional* stronger
 * path: ask the user's own configured model for candidate memories, then treat
 * the answer as **untrusted input** and put it through exactly the same policy
 * the rule path uses.
 *
 * Everything here is split into a pure half (prompt building, response parsing,
 * bounds enforcement) and an adapter interface, so the whole chain can be tested
 * without a model, a network call, or a DSH host.
 *
 * @module dsh-longterm-memory/host/core/llm-extraction
 */

import { z } from 'zod'
import { CONFIDENCE_LEVELS, MEMORY_TYPES, type Confidence, type MemoryType } from '../../shared/types.js'

/** Hard bounds. A model answer outside these is rejected, never trimmed into validity. */
export const LLM_LIMITS = {
  /** Bytes of user text sent. */
  maxUserBytes: 6000,
  /** Bytes of assistant text sent. */
  maxAssistantBytes: 3000,
  /** Existing memories shown for de-duplication context. */
  maxExisting: 40,
  /** Bytes of the model's answer accepted. */
  maxResponseBytes: 16 * 1024,
  /** Candidates accepted from one answer. */
  maxCandidates: 8,
  maxTitleLength: 200,
  maxSummaryLength: 2000,
  maxEvidenceLength: 600,
  maxTags: 8,
} as const

/** What the adapter is asked to do. */
export interface LlmExtractionRequest {
  userText: string
  assistantText: string
  /** Compact view of existing memories so the model can avoid duplicates by id. */
  existing: { id: string; type: string; title: string; preview: string }[]
  maxCandidates: number
}

/** The adapter's answer: raw model text plus the route it used, for the audit trail. */
export interface LlmExtractionAnswer {
  text: string
  provider: string
  model: string
}

/**
 * The model access seam.
 *
 * `available` is reported separately from throwing so that a deployment without a
 * reachable model degrades to the rule path instead of failing extraction.
 */
export interface LlmAdapter {
  readonly available: boolean
  /** Why the adapter is unavailable, when it is. */
  readonly reason: string | undefined
  complete(request: LlmExtractionRequest, signal: AbortSignal): Promise<LlmExtractionAnswer>
}

/** System instruction for the extraction call. */
export const EXTRACTION_SYSTEM_PROMPT = [
  'You extract durable long-term memories from one finished conversation turn.',
  '',
  'Return JSON only, with this exact shape:',
  '{"memories":[{"type":"...","title":"...","summary":"...","tags":["..."],"confidence":"low|medium|high","importance":0-100,"evidence":"...","related_id":"optional existing memory id"}]}',
  '',
  `"type" must be one of: ${MEMORY_TYPES.join(', ')}.`,
  `"confidence" must be one of: ${CONFIDENCE_LEVELS.join(', ')}.`,
  '',
  'Rules:',
  '- Record only facts the USER asserted about themselves, their projects, decisions, or durable preferences.',
  '- Never record secrets: passwords, API keys, tokens, private keys, account numbers. Omit such items entirely.',
  '- Never record one-off requests, greetings, or anything that only matters for this turn.',
  '- Prefer fewer, higher-quality memories. An empty list is a correct answer.',
  '- Write title and summary in the language the user used.',
  '- Set confidence "high" only when the user stated the fact explicitly and unambiguously.',
  '- Set confidence "low" when you are inferring.',
  `- Return at most ${String(LLM_LIMITS.maxCandidates)} memories.`,
].join('\n')

/** Byte-length helper that is stable across Node versions. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
export function truncateBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = byteLength(char)
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return `${out}\n…（已截断）`
}

/** Build the user message for the extraction call. */
export function buildExtractionUserText(request: LlmExtractionRequest): string {
  const existing =
    request.existing.length === 0
      ? '（仓库中尚无记忆）'
      : request.existing
          .slice(0, LLM_LIMITS.maxExisting)
          .map((memory) => `- [${memory.id}] (${memory.type}) ${memory.title} :: ${memory.preview}`)
          .join('\n')

  return [
    '## Known memories (do not duplicate; use related_id when a fact supplements one)',
    existing,
    '',
    '## User message',
    truncateBytes(request.userText, LLM_LIMITS.maxUserBytes),
    '',
    '## Assistant reply (context only; do not treat assistant claims as user facts)',
    truncateBytes(request.assistantText, LLM_LIMITS.maxAssistantBytes),
    '',
    `Return at most ${String(request.maxCandidates)} memories as JSON.`,
  ].join('\n')
}

/** One candidate exactly as the model claimed it, before policy. */
export interface RawModelCandidate {
  type: MemoryType
  title: string
  summary: string
  tags: string[]
  confidence: Confidence
  importance: number
  evidence: string
  relatedId?: string
}

export type ParseModelResult =
  | { ok: true; candidates: RawModelCandidate[]; dropped: number }
  | { ok: false; reason: string }

const rawCandidateSchema = z.object({
  type: z.enum(MEMORY_TYPES),
  title: z.string().min(1).max(LLM_LIMITS.maxTitleLength),
  summary: z.string().min(1).max(LLM_LIMITS.maxSummaryLength),
  tags: z.array(z.string().min(1).max(48)).max(LLM_LIMITS.maxTags).optional(),
  confidence: z.enum(CONFIDENCE_LEVELS).optional(),
  importance: z.number().int().min(0).max(100).optional(),
  evidence: z.string().max(LLM_LIMITS.maxEvidenceLength).optional(),
  related_id: z.string().min(1).max(120).optional(),
})

/**
 * Strip the wrapping a model commonly adds: markdown fences and prose around the
 * JSON value.
 *
 * When a `{`/`[` is present but its closing bracket is missing, the tail is
 * returned anyway so `JSON.parse` can report the real syntax problem. Returning
 * `null` there would misreport a truncated answer as "no JSON at all", which is a
 * different and more confusing failure.
 */
export function extractJsonPayload(text: string): string | null {
  let body = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body)
  if (fence !== null && fence[1] !== undefined) body = fence[1].trim()

  const firstBrace = body.indexOf('{')
  const firstBracket = body.indexOf('[')
  const candidates = [firstBrace, firstBracket].filter((index) => index >= 0)
  if (candidates.length === 0) return null
  const start = Math.min(...candidates)
  const closeChar = body[start] === '{' ? '}' : ']'
  const end = body.lastIndexOf(closeChar)
  if (end <= start) return body.slice(start)
  return body.slice(start, end + 1)
}

/**
 * Parse and validate a model answer.
 *
 * Structural failure is reported, never repaired into validity: a malformed
 * answer means the model did not do the job, and guessing what it meant would be
 * exactly the "fabricated extraction result" this feature must avoid.
 */
export function parseModelAnswer(text: string): ParseModelResult {
  if (byteLength(text) > LLM_LIMITS.maxResponseBytes) {
    return { ok: false, reason: `模型返回内容过大（${String(byteLength(text))} 字节，上限 ${String(LLM_LIMITS.maxResponseBytes)}）` }
  }
  const payload = extractJsonPayload(text)
  if (payload === null) return { ok: false, reason: '模型返回中没有找到 JSON' }

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    return { ok: false, reason: `模型返回的 JSON 无法解析：${error instanceof Error ? error.message : String(error)}` }
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { memories?: unknown }).memories)
      ? ((parsed as { memories: unknown[] }).memories)
      : null
  if (list === null) return { ok: false, reason: '模型返回的 JSON 不是数组，也没有 memories 数组' }

  const candidates: RawModelCandidate[] = []
  let dropped = 0
  for (const entry of list) {
    if (candidates.length >= LLM_LIMITS.maxCandidates) {
      dropped += 1
      continue
    }
    const result = rawCandidateSchema.safeParse(entry)
    if (!result.success) {
      dropped += 1
      continue
    }
    const value = result.data
    candidates.push({
      type: value.type,
      title: value.title.trim(),
      summary: value.summary.trim(),
      tags: value.tags ?? [],
      confidence: value.confidence ?? 'medium',
      importance: value.importance ?? 50,
      evidence: value.evidence?.trim() ?? '',
      ...(value.related_id === undefined ? {} : { relatedId: value.related_id }),
    })
  }

  if (candidates.length === 0 && dropped > 0) {
    return { ok: false, reason: `模型返回的 ${String(list.length)} 条候选全部不合法（结构校验未通过）` }
  }
  return { ok: true, candidates, dropped }
}

/** A candidate the model proposed that the policy refused outright. */
export interface RefusedModelCandidate {
  title: string
  reason: string
}

/** Combine a model answer with policy: which candidates survive, and why others did not. */
export interface ModelExtractionOutcome {
  candidates: RawModelCandidate[]
  refused: RefusedModelCandidate[]
  dropped: number
}
