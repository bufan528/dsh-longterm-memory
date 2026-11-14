/**
 * Sticker selection policy — pure functions, no IO.
 *
 * Why this exists: the QQ side can send a sticker, but it has no idea *when*
 * sending one is welcome and no memory of what was sent recently. Every mature
 * implementation of this feature converges on the same two rules (tg-stickers,
 * dsh-onebot-bridge, qq-group-ai-sticker):
 *
 *  1. pick by emotion/context, never at random from the whole library;
 *  2. rate-limit it — a bot that sends a sticker with every message is worse
 *     than one that never sends any.
 *
 * The QQ side cannot be changed (it is another plugin's compiled output, and it
 * has no proactive push at all), so the gate lives here and is enforced by the
 * `sticker_pick` tool the model calls. Keeping it pure means the scoring and the
 * cooldown can be unit-tested without a vault, a clock, or a model.
 *
 * @module dsh-longterm-memory/shared/sticker-pick
 */

/** What the caller is looking for. Both fields are optional free text. */
export interface StickerQuery {
  /** The mood to express, e.g. `开心` / `无语` / `摸摸头`. */
  emotion?: string
  /** Extra context words; used only to break ties. */
  context?: string
}

/** Tunable limits, persisted next to the sticker catalogue. */
export interface StickerPolicy {
  /** Hard floor between two stickers. */
  minGapMinutes: number
  /** 0..1 — a soft gate on top of the time gap. 1 means "always send". */
  probability: number
  /** Tags that must never be sent automatically (e.g. a private joke). */
  quietTags: string[]
  /** Rolling 24h ceiling, so a long chat cannot drain the library. */
  maxPer24h: number
}

/**
 * Defaults are deliberately conservative.
 *
 * tg-stickers recommends one sticker every 2-5 messages; we cannot count
 * messages from this side, so the time gap stands in for it: 4 minutes is
 * roughly "a few turns" in a chat. A user who wants more can lower it, but the
 * default must not read as spam.
 */
export const DEFAULT_STICKER_POLICY: StickerPolicy = {
  minGapMinutes: 4,
  probability: 1,
  quietTags: [],
  maxPer24h: 40,
}

/** Rolling counters, persisted with the policy. */
export interface StickerPolicyState {
  lastSentAt: string | null
  sentLast24h: number
  windowStartedAt: string | null
}

export const EMPTY_POLICY_STATE: StickerPolicyState = {
  lastSentAt: null,
  sentLast24h: 0,
  windowStartedAt: null,
}

/** The subset of a catalogue row the selector needs. */
export interface StickerCandidateLike {
  id: string
  description: string
  tags: string[]
  favorite: boolean
  enabled: boolean
  usedCount: number
  lastUsedAt?: string
}

export type StickerPickDecision =
  | { ok: true; id: string; score: number; reason: string }
  | {
    ok: false
    blocked: 'empty' | 'cooldown' | 'rate' | 'no-match' | 'probability'
    reason: string
    /** When the cooldown lifts, for a "try again later" answer. */
    retryAt?: string
  }

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** Split free text into comparable needles, dropping punctuation and case. */
export function needlesOf(...parts: readonly (string | undefined)[]): string[] {
  const out = new Set<string>()
  for (const part of parts) {
    if (part === undefined) continue
    for (const raw of part.split(/[\s,，、;；/|]+/u)) {
      const needle = raw.trim().toLowerCase()
      if (needle.length > 0) out.add(needle)
    }
  }
  return [...out]
}

/**
 * How well one sticker answers the query. 0 means "no reason to pick this".
 *
 * Exact tag beats substring, which beats description text. Favourites get a
 * small bonus and rarely used ones get a small rarity bonus, so the same two
 * stickers do not come up every single time.
 */
export function scoreSticker(candidate: StickerCandidateLike, needles: readonly string[], now: number): number {
  const tags = candidate.tags.map((tag) => tag.toLowerCase())
  const description = candidate.description.toLowerCase()
  let score = 0
  for (const needle of needles) {
    if (tags.includes(needle)) score += 100
    else if (tags.some((tag) => tag.includes(needle) || needle.includes(tag))) score += 55
    else if (description.includes(needle)) score += 35
  }
  if (score === 0) return 0
  if (candidate.favorite) score += 12
  score += Math.max(0, 8 - Math.min(candidate.usedCount, 8))
  // A sticker sent moments ago reads as a glitch, not a joke.
  if (candidate.lastUsedAt !== undefined) {
    const at = Date.parse(candidate.lastUsedAt)
    if (!Number.isNaN(at) && now - at < 30 * MINUTE_MS) score -= 25
  }
  return score
}

/** Refresh the rolling window without mutating the stored state. */
export function rollWindow(state: StickerPolicyState, now: number): StickerPolicyState {
  if (state.windowStartedAt === null) return state
  const started = Date.parse(state.windowStartedAt)
  if (Number.isNaN(started) || now - started >= DAY_MS) {
    return { lastSentAt: state.lastSentAt, sentLast24h: 0, windowStartedAt: null }
  }
  return state
}

/**
 * Decide whether a sticker may be sent now, and which one.
 *
 * `random` is injectable so the probability gate is testable; production passes
 * `Math.random`. A refusal always carries a human-readable reason — the model
 * relays it instead of silently inventing a sticker.
 */
export function chooseSticker(
  candidates: readonly StickerCandidateLike[],
  query: StickerQuery,
  policy: StickerPolicy,
  state: StickerPolicyState,
  now: number,
  random: () => number = Math.random,
): StickerPickDecision {
  const rolled = rollWindow(state, now)
  const quiet = new Set(policy.quietTags.map((tag) => tag.toLowerCase()))
  const usable = candidates.filter((candidate) => candidate.enabled && !candidate.tags.some((tag) => quiet.has(tag.toLowerCase())))

  if (usable.length === 0) {
    return {
      ok: false,
      blocked: 'empty',
      reason: '表情库为空，或所有表情都被停用/静默。先在伙伴中心导入几张。',
    }
  }

  if (rolled.lastSentAt !== null) {
    const last = Date.parse(rolled.lastSentAt)
    if (!Number.isNaN(last)) {
      const ready = last + policy.minGapMinutes * MINUTE_MS
      if (now < ready) {
        return {
          ok: false,
          blocked: 'cooldown',
          reason: `刚发过表情，${String(Math.ceil((ready - now) / MINUTE_MS))} 分钟后再发更自然。`,
          retryAt: new Date(ready).toISOString(),
        }
      }
    }
  }

  if (rolled.sentLast24h >= policy.maxPer24h) {
    return {
      ok: false,
      blocked: 'rate',
      reason: `24 小时内已经发了 ${String(rolled.sentLast24h)} 张，先缓一缓。`,
    }
  }

  const needles = needlesOf(query.emotion, query.context)
  const scored = usable
    .map((candidate) => ({ candidate, score: scoreSticker(candidate, needles, now) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.usedCount - b.candidate.usedCount)

  if (scored.length === 0) {
    return {
      ok: false,
      blocked: 'no-match',
      reason: needles.length === 0
        ? '没有给出情绪或情境，无法挑选。'
        : `没有表情匹配「${needles.join(' ')}」。可以换一个说法，或用 sticker 工具先收录一张。`,
    }
  }

  if (policy.probability < 1 && random() > policy.probability) {
    return { ok: false, blocked: 'probability', reason: '这次不发表情更合适（概率门控）。' }
  }

  const best = scored[0]!
  const matched = needles.filter((needle) =>
    best.candidate.tags.some((tag) => tag.toLowerCase().includes(needle))
    || best.candidate.description.toLowerCase().includes(needle))
  return {
    ok: true,
    id: best.candidate.id,
    score: best.score,
    reason: matched.length === 0
      ? `按相近情绪挑选（${best.candidate.description.slice(0, 40)}）`
      : `命中「${matched.join(' ')}」（${best.candidate.description.slice(0, 40)}）`,
  }
}

/** Record one send: bump the counter, roll the window, remember the instant. */
export function noteSend(state: StickerPolicyState, now: number): StickerPolicyState {
  const rolled = rollWindow(state, now)
  return {
    lastSentAt: new Date(now).toISOString(),
    sentLast24h: rolled.sentLast24h + 1,
    windowStartedAt: rolled.windowStartedAt ?? new Date(now).toISOString(),
  }
}

/** Clamp anything that came off disk into a usable policy. */
export function normalizePolicy(raw: unknown): StickerPolicy {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_STICKER_POLICY }
  const obj = raw as Record<string, unknown>
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = obj[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  }
  const quietTags = Array.isArray(obj['quietTags'])
    ? obj['quietTags'].filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter((tag) => tag.length > 0).slice(0, 30)
    : []
  return {
    minGapMinutes: number('minGapMinutes', DEFAULT_STICKER_POLICY.minGapMinutes, 0, 720),
    probability: number('probability', DEFAULT_STICKER_POLICY.probability, 0, 1),
    quietTags,
    maxPer24h: number('maxPer24h', DEFAULT_STICKER_POLICY.maxPer24h, 0, 500),
  }
}

/** Clamp the persisted counters; a corrupt file must not block sending forever. */
export function normalizePolicyState(raw: unknown): StickerPolicyState {
  if (raw === null || typeof raw !== 'object') return { ...EMPTY_POLICY_STATE }
  const obj = raw as Record<string, unknown>
  const iso = (value: unknown): string | null =>
    typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null
  const count = obj['sentLast24h']
  return {
    lastSentAt: iso(obj['lastSentAt']),
    sentLast24h: typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
    windowStartedAt: iso(obj['windowStartedAt']),
  }
}
