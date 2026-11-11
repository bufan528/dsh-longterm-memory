/**
 * The persona preview's pure half.
 *
 * The prompt is produced by `shared/persona-projection.ts`, which mirrors the
 * QQ runtime. These assertions pin the wrapper, the output contract, and — most
 * importantly — that a persona over budget reports *which* layers were cut
 * instead of quietly describing a different voice.
 *
 * @module tests/unit/try-voice
 */

import { describe, expect, it } from 'vitest'

import {
  VOICE_LIMITS,
  buildVoicePreview,
  buildVoiceSystemPrompt,
  normalizeUtterance,
  sanitizeReply,
} from '../../src/host/companion/try-voice.js'
import type { CompanionDocuments } from '../../src/host/companion/documents.js'

function docs(overrides: Partial<CompanionDocuments['persona']> = {}): CompanionDocuments {
  return {
    persona: {
      name: '小满',
      identity: '一个安静的倾听者。',
      temperament: '温和、清晰',
      address: '你',
      languageHabits: '短句，不堆客套话。',
      scenario: '日常闲聊',
      catchphrases: ['慢慢来'],
      avoid: ['居高临下的说教'],
      examples: [{ user: '今天好累', assistant: '那就先歇着。' }],
      boundaries: ['不假装真实人类'],
      ...overrides,
    },
    style: { tone: 'gentle', notes: '' },
    policy: { pretendHuman: false, emotionalDependency: false, quietTriggers: [], stopTriggers: [] },
    revision: 'test',
  }
}

describe('buildVoicePreview', () => {
  it('wraps the real QQ persona section, not an invented prompt', () => {
    const { systemPrompt } = buildVoicePreview(docs())
    expect(systemPrompt).toContain('[伙伴规则]')
    expect(systemPrompt).toContain('伙伴：小满')
    expect(systemPrompt).toContain('性格：温和、清晰｜表达风格：gentle')
    expect(systemPrompt).toContain('适用场景：日常闲聊')
    expect(systemPrompt).toContain('常用句式：慢慢来')
    expect(systemPrompt).toContain('不要说：居高临下的说教')
    expect(systemPrompt).toContain('示例对话（学语气，不要照抄内容）')
    expect(systemPrompt).toContain('不可假装真实人类')
    expect(systemPrompt).toContain('QQ 私聊：简短自然')
  })

  it('keeps the neutral-turn directive and length cap from the QQ policy engine', () => {
    const { systemPrompt, projection } = buildVoicePreview(docs())
    expect(systemPrompt).toContain('当前语境：中性。')
    expect(systemPrompt).toContain(`长度上限：约 ${String(projection.maxChars)} 字。`)
    expect(systemPrompt).toContain('只输出这一句回复本身')
    expect(systemPrompt).toContain(String(VOICE_LIMITS.maxReply))
  })

  it('reports no dropped layers for a normal, short persona', () => {
    expect(buildVoicePreview(docs()).projection.dropped).toEqual([])
  })

  it('reports dropped layers when the persona blows the character budget', () => {
    const oversized = docs({
      identity: '很'.repeat(400),
      languageHabits: '长'.repeat(300),
      scenario: '场'.repeat(180),
      catchphrases: ['慢慢来'],
      avoid: ['居高临下的说教'],
      examples: [{ user: '今天好累', assistant: '那就先歇着。' }],
    })
    const { projection, systemPrompt } = buildVoicePreview(oversized)
    expect(projection.dropped.length).toBeGreaterThan(0)
    expect(projection.text.length).toBeLessThanOrEqual(760)
    expect(systemPrompt).toContain('[伙伴规则]')
  })

  it('never emits half a layer: a cut example is gone, not truncated', () => {
    const oversized = docs({
      identity: '很'.repeat(400),
      languageHabits: '长'.repeat(300),
      examples: [{ user: '今天好累', assistant: '那就先歇着。' }],
    })
    const { projection } = buildVoicePreview(oversized)
    const examplesDropped = projection.dropped.some((layer) => layer.key === 'examples')
    expect(examplesDropped ? projection.core.includes('今天好累') === false : true).toBe(true)
  })

  it('the compatibility helper returns the same system prompt', () => {
    expect(buildVoiceSystemPrompt(docs())).toBe(buildVoicePreview(docs()).systemPrompt)
  })
})

describe('normalizeUtterance', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeUtterance('  今天   有点\n累  ')).toBe('今天 有点 累')
  })

  it('caps length instead of forwarding a wall of text', () => {
    expect(normalizeUtterance('啊'.repeat(500))).toHaveLength(VOICE_LIMITS.maxUtterance)
  })

  it('treats non-strings and blank input as nothing to send', () => {
    expect(normalizeUtterance(undefined)).toBe('')
    expect(normalizeUtterance(42)).toBe('')
    expect(normalizeUtterance('   ')).toBe('')
  })
})

describe('sanitizeReply', () => {
  it('strips the quotes models add by default', () => {
    expect(sanitizeReply('“那就先歇着。”')).toBe('那就先歇着。')
    expect(sanitizeReply('「那就先歇着。」')).toBe('那就先歇着。')
    expect(sanitizeReply('"Take a break."')).toBe('Take a break.')
  })

  it('unwraps a fenced block', () => {
    expect(sanitizeReply('```text\n那就先歇着。\n```')).toBe('那就先歇着。')
  })

  it('keeps only the first line so trailing commentary never reaches the preview', () => {
    expect(sanitizeReply('那就先歇着。\n\n（以上为示例回复）')).toBe('那就先歇着。')
  })

  it('unwraps quotes even when trailing noise follows them', () => {
    expect(sanitizeReply('“那就先歇着。”\n\n（以上为示例回复）')).toBe('那就先歇着。')
    expect(sanitizeReply('"Take a break."\n\n[end of example]')).toBe('Take a break.')
  })

  it('caps a runaway answer', () => {
    expect(sanitizeReply('嗯'.repeat(2000))).toHaveLength(VOICE_LIMITS.maxReply)
  })

  it('does not mangle a single quote character or an empty answer', () => {
    expect(sanitizeReply('"')).toBe('"')
    expect(sanitizeReply('   ')).toBe('')
  })
})
