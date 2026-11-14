/**
 * Sticker selection policy.
 *
 * Fixed clock: 2026-11-13 19:00 local. The policy is the only thing standing
 * between "the bot has stickers" and "the bot spams stickers", so every gate is
 * asserted explicitly — a silent regression here would be very visible in chat.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STICKER_POLICY, EMPTY_POLICY_STATE, chooseSticker, needlesOf, normalizePolicy,
  normalizePolicyState, noteSend, rollWindow, scoreSticker,
} from '../../src/shared/sticker-pick.js'
import type { StickerCandidateLike, StickerPolicy, StickerPolicyState } from '../../src/shared/sticker-pick.js'

const NOW = new Date(2026, 10, 13, 19, 0, 0, 0).getTime()
const MINUTE = 60_000

function sticker(over: Partial<StickerCandidateLike> & { id: string }): StickerCandidateLike {
  return {
    description: '',
    tags: [],
    favorite: false,
    enabled: true,
    usedCount: 0,
    ...over,
  }
}

const policy = (over: Partial<StickerPolicy> = {}): StickerPolicy => ({ ...DEFAULT_STICKER_POLICY, ...over })
const state = (over: Partial<StickerPolicyState> = {}): StickerPolicyState => ({ ...EMPTY_POLICY_STATE, ...over })

describe('needlesOf', () => {
  it('splits Chinese and latin punctuation and lowercases', () => {
    expect(needlesOf('开心，Good Mood', undefined)).toEqual(['开心', 'good', 'mood'])
  })

  it('drops empties and dedupes', () => {
    expect(needlesOf(' 笑  笑 ', '')).toEqual(['笑'])
  })
})

describe('scoreSticker', () => {
  it('prefers an exact tag over a substring over the description', () => {
    const exact = sticker({ id: 'a', tags: ['晚安'] })
    const partial = sticker({ id: 'b', tags: ['晚安啦'] })
    const described = sticker({ id: 'c', description: '晚安' })
    const needles = needlesOf('晚安')
    expect(scoreSticker(exact, needles, NOW)).toBeGreaterThan(scoreSticker(partial, needles, NOW))
    expect(scoreSticker(partial, needles, NOW)).toBeGreaterThan(scoreSticker(described, needles, NOW))
  })

  it('returns 0 when nothing matches, so it is never picked as a fallback', () => {
    expect(scoreSticker(sticker({ id: 'a', tags: ['开心'] }), needlesOf('晚安'), NOW)).toBe(0)
  })

  it('nudges favourites up and over-used stickers down', () => {
    const plain = sticker({ id: 'a', tags: ['开心'], usedCount: 0 })
    const favourite = sticker({ id: 'b', tags: ['开心'], favorite: true })
    const tired = sticker({ id: 'c', tags: ['开心'], usedCount: 40 })
    const needles = needlesOf('开心')
    expect(scoreSticker(favourite, needles, NOW)).toBeGreaterThan(scoreSticker(plain, needles, NOW))
    expect(scoreSticker(tired, needles, NOW)).toBeLessThan(scoreSticker(plain, needles, NOW))
  })

  it('penalises a sticker used moments ago', () => {
    const fresh = sticker({ id: 'a', tags: ['开心'], lastUsedAt: new Date(NOW - 2 * MINUTE).toISOString() })
    const stale = sticker({ id: 'b', tags: ['开心'], lastUsedAt: new Date(NOW - 6 * 60 * MINUTE).toISOString() })
    const needles = needlesOf('开心')
    expect(scoreSticker(fresh, needles, NOW)).toBeLessThan(scoreSticker(stale, needles, NOW))
  })
})

describe('chooseSticker', () => {
  const library = [
    sticker({ id: 'happy', tags: ['开心'], description: '猫猫大笑' }),
    sticker({ id: 'night', tags: ['晚安'], description: '盖被子' }),
    sticker({ id: 'off', tags: ['开心'], enabled: false }),
    sticker({ id: 'quiet', tags: ['内部梗'] }),
  ]

  it('picks the row that matches the mood', () => {
    const decision = chooseSticker(library, { emotion: '晚安' }, policy(), state(), NOW)
    expect(decision.ok).toBe(true)
    if (decision.ok) expect(decision.id).toBe('night')
  })

  it('never picks a disabled row', () => {
    const decision = chooseSticker(library, { emotion: '开心' }, policy(), state(), NOW)
    expect(decision.ok).toBe(true)
    if (decision.ok) expect(decision.id).toBe('happy')
  })

  it('honours quiet tags', () => {
    const decision = chooseSticker(
      [sticker({ id: 'quiet', tags: ['内部梗'] })],
      { emotion: '内部梗' },
      policy({ quietTags: ['内部梗'] }),
      state(),
      NOW,
    )
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.blocked).toBe('empty')
  })

  it('refuses during the cooldown and says when to retry', () => {
    const decision = chooseSticker(
      library,
      { emotion: '开心' },
      policy({ minGapMinutes: 10 }),
      state({ lastSentAt: new Date(NOW - 3 * MINUTE).toISOString() }),
      NOW,
    )
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.blocked).toBe('cooldown')
      expect(decision.retryAt).toBeDefined()
      // 3 minutes elapsed of a 10 minute gap → 7 minutes left.
      const retry = new Date(decision.retryAt!).getTime()
      expect(Math.round((retry - NOW) / MINUTE)).toBe(7)
    }
  })

  it('allows sending again once the gap has passed', () => {
    const decision = chooseSticker(
      library,
      { emotion: '开心' },
      policy({ minGapMinutes: 10 }),
      state({ lastSentAt: new Date(NOW - 11 * MINUTE).toISOString() }),
      NOW,
    )
    expect(decision.ok).toBe(true)
  })

  it('enforces the rolling 24h ceiling', () => {
    const decision = chooseSticker(
      library,
      { emotion: '开心' },
      policy({ maxPer24h: 5 }),
      state({ sentLast24h: 5, windowStartedAt: new Date(NOW - 60 * MINUTE).toISOString() }),
      NOW,
    )
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.blocked).toBe('rate')
  })

  it('resets the counter once the window has rolled', () => {
    const rolled = rollWindow(state({ sentLast24h: 5, windowStartedAt: new Date(NOW - 25 * 3600_000).toISOString() }), NOW)
    expect(rolled.sentLast24h).toBe(0)
    const decision = chooseSticker(library, { emotion: '开心' }, policy({ maxPer24h: 5 }), rolled, NOW)
    expect(decision.ok).toBe(true)
  })

  it('reports no-match instead of picking something unrelated', () => {
    const decision = chooseSticker(library, { emotion: '考试' }, policy(), state(), NOW)
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.blocked).toBe('no-match')
  })

  it('reports an empty library honestly', () => {
    const decision = chooseSticker([], { emotion: '开心' }, policy(), state(), NOW)
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.blocked).toBe('empty')
  })

  it('applies the probability gate with an injectable random', () => {
    const blocked = chooseSticker(library, { emotion: '开心' }, policy({ probability: 0.2 }), state(), NOW, () => 0.9)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.blocked).toBe('probability')
    const allowed = chooseSticker(library, { emotion: '开心' }, policy({ probability: 0.2 }), state(), NOW, () => 0.1)
    expect(allowed.ok).toBe(true)
  })
})

describe('noteSend', () => {
  it('starts the window on the first send and keeps counting', () => {
    const first = noteSend(state(), NOW)
    expect(first.sentLast24h).toBe(1)
    expect(first.windowStartedAt).not.toBeNull()
    const second = noteSend(first, NOW + MINUTE)
    expect(second.sentLast24h).toBe(2)
    expect(second.windowStartedAt).toBe(first.windowStartedAt)
  })
})

describe('normalisation', () => {
  it('clamps out-of-range policy values from disk', () => {
    const normalized = normalizePolicy({ minGapMinutes: -5, probability: 9, maxPer24h: 9999, quietTags: [' a ', 3] })
    expect(normalized.minGapMinutes).toBe(0)
    expect(normalized.probability).toBe(1)
    expect(normalized.maxPer24h).toBe(500)
    expect(normalized.quietTags).toEqual(['a'])
  })

  it('falls back to defaults for garbage', () => {
    expect(normalizePolicy('nope')).toEqual(DEFAULT_STICKER_POLICY)
    expect(normalizePolicyState(null)).toEqual(EMPTY_POLICY_STATE)
  })

  it('drops an invalid timestamp instead of blocking sends forever', () => {
    const state = normalizePolicyState({ lastSentAt: 'not-a-date', sentLast24h: -3, windowStartedAt: 42 })
    expect(state.lastSentAt).toBeNull()
    expect(state.sentLast24h).toBe(0)
    expect(state.windowStartedAt).toBeNull()
  })
})
