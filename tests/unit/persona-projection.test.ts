/**
 * The shared persona projection — a reimplementation of the QQ runtime's
 * `projectPersona`, which both the preview and the self-check rely on.
 *
 * The behaviour that matters most is the *order of loss*: the budget drops whole
 * layers from least essential to most essential, and the hard boundary plus the
 * closing restatement must survive every cut. If these drift, the management
 * page would lie about what the model actually receives.
 *
 * @module tests/unit/persona-projection
 */

import { describe, expect, it } from 'vitest'

import {
  PERSONA_BUDGET,
  assemblePersonaLayers,
  buildPersonaContextSection,
  buildPersonaLayers,
  projectPersona,
} from '../../src/shared/persona-projection.js'
import type { PersonaProjectionInput } from '../../src/shared/persona-projection.js'

function input(overrides: Partial<PersonaProjectionInput> = {}): PersonaProjectionInput {
  return {
    name: '小满',
    identity: '一个安静的倾听者。',
    temperament: '温和、清晰',
    address: '你',
    languageHabits: '短句，不堆客套话。',
    boundaries: ['不假装真实人类'],
    scenario: '日常闲聊',
    catchphrases: ['慢慢来'],
    avoid: ['居高临下的说教'],
    examples: [{ user: '今天好累', assistant: '那就先歇着。' }],
    tone: 'gentle',
    notes: '',
    ...overrides,
  }
}

describe('buildPersonaLayers', () => {
  it('marks identity fields as irreducible and optional anchors as droppable', () => {
    const layers = buildPersonaLayers(input())
    const byKey = new Map(layers.map((layer) => [layer.key, layer]))
    expect(byKey.get('name')?.weight).toBe(0)
    expect(byKey.get('identity')?.weight).toBe(0)
    expect(byKey.get('boundaries')?.weight).toBe(0)
    expect(byKey.get('scenario')?.weight).toBe(3)
    expect(byKey.get('catchphrases')?.weight).toBe(2)
    expect(byKey.get('avoid')?.weight).toBe(2)
    expect(byKey.get('examples')?.weight).toBe(1)
  })

  it('omits optional layers when their content is empty or whitespace', () => {
    const layers = buildPersonaLayers(input({ scenario: '  ', catchphrases: [], avoid: [], examples: [] }))
    expect(layers.map((layer) => layer.key)).not.toContain('scenario')
    expect(layers.map((layer) => layer.key)).not.toContain('catchphrases')
    expect(layers.map((layer) => layer.key)).not.toContain('avoid')
    expect(layers.map((layer) => layer.key)).not.toContain('examples')
  })

  it('formats example pairs exactly as the QQ runtime does', () => {
    const examples = buildPersonaLayers(input()).find((layer) => layer.key === 'examples')
    expect(examples?.text).toContain('用户：今天好累\n你：那就先歇着。')
  })
})

describe('assemblePersonaLayers', () => {
  const layers = buildPersonaLayers(input())

  it('drops the highest weight first and reports every cut layer', () => {
    const result = assemblePersonaLayers(layers, 100)
    expect(result.dropped[0]?.key).toBe('scenario')
    expect(result.dropped.map((layer) => layer.key)).toContain('catchphrases')
    expect(result.dropped.map((layer) => layer.key)).toContain('avoid')
    expect(result.text.length).toBeLessThanOrEqual(100)
  })

  it('never drops a weight-0 layer even when the budget is tiny', () => {
    const result = assemblePersonaLayers(layers, 40)
    expect(result.dropped.filter((layer) => layer.key === 'name')).toEqual([])
    expect(result.hardTruncated).toBe(true)
  })

  it('keeps everything when the budget is generous', () => {
    const result = assemblePersonaLayers(layers, 10_000)
    expect(result.dropped).toEqual([])
    expect(result.hardTruncated).toBe(false)
  })
})

describe('projectPersona', () => {
  it('puts the hard boundary before the closing restatement inside the core', () => {
    const projection = projectPersona(input(), 'qq')
    const boundary = projection.core.indexOf('不可假装真实人类')
    const closing = projection.core.indexOf('按上面的语气说话')
    expect(boundary).toBeGreaterThan(-1)
    expect(closing).toBeGreaterThan(boundary)
  })

  it('flags a hard truncation instead of pretending the boundary survived', () => {
    const oversized = input({ identity: '很'.repeat(400), languageHabits: '长'.repeat(300) })
    const projection = projectPersona(oversized, 'qq')
    expect(projection.hardTruncated).toBe(true)
    // This is the QQ runtime's real behaviour, not one we invented: the self-check
    // must tell the user to shorten those fields rather than hide it.
    expect(projection.core).not.toContain('不可假装真实人类')
    const coreBudget = Math.max(PERSONA_BUDGET.minCore, PERSONA_BUDGET.textLimit - PERSONA_BUDGET.adaptationReserve)
    expect(projection.core.length).toBeLessThanOrEqual(coreBudget)
  })

  it('adapts to the channel: QQ is short and allows stickers, PC is detailed', () => {
    const qq = projectPersona(input(), 'qq')
    const pc = projectPersona(input(), 'pc')
    expect(qq.adaptation).toContain('QQ 私聊')
    expect(qq.allowStickers).toBe(true)
    expect(qq.maxChars).toBe(220)
    expect(pc.adaptation).toContain('PC 桌面')
    expect(pc.allowStickers).toBe(false)
    expect(pc.maxChars).toBe(1200)
    // The core is deliberately identical across channels.
    expect(qq.core).toBe(pc.core)
  })

  it('honours the total persona budget', () => {
    const oversized = input({
      identity: '很'.repeat(400),
      languageHabits: '长'.repeat(300),
      scenario: '场'.repeat(180),
    })
    expect(projectPersona(oversized, 'qq').text.length).toBeLessThanOrEqual(PERSONA_BUDGET.textLimit)
  })

  it('reports examples as dropped when the identity eats the whole budget', () => {
    const oversized = input({
      identity: '很'.repeat(400),
      languageHabits: '长'.repeat(300),
      scenario: '场'.repeat(180),
      examples: [{ user: '今天好累', assistant: '那就先歇着。' }],
    })
    const projection = projectPersona(oversized, 'qq')
    expect(projection.dropped.map((layer) => layer.key)).toContain('examples')
    expect(projection.core).not.toContain('今天好累')
  })
})

describe('buildPersonaContextSection', () => {
  it('wraps the projection in the QQ [伙伴规则] section', () => {
    const section = buildPersonaContextSection(projectPersona(input(), 'qq'))
    expect(section.startsWith('[伙伴规则]')).toBe(true)
    expect(section).toContain('当前语境：中性。')
    expect(section).toContain('长度上限：约 220 字。')
    expect(section.length).toBeLessThanOrEqual(PERSONA_BUDGET.contextSectionLimit)
  })
})
