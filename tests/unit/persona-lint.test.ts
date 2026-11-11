/**
 * The persona linter's contract.
 *
 * These rules are load-bearing: each one encodes a failure mode we can explain
 * ("negation activates the concept", "attention decays with distance"), so a
 * regression here would silently let a contradictory persona through.
 *
 * @module tests/unit/persona-lint
 */

import { describe, expect, it } from 'vitest'

import { isPersonaHealthy, lintPersona } from '../../src/client/persona-lint.js'
import type { PersonaLintInput } from '../../src/client/persona-lint.js'

function persona(overrides: Partial<PersonaLintInput> = {}): PersonaLintInput {
  return {
    name: '小满',
    identity: '一个安静的倾听者，先听完再一起想办法。',
    address: '你',
    scenario: '日常闲聊与学习陪伴',
    catchphrases: ['慢慢来'],
    avoid: ['居高临下的说教'],
    examples: [{ user: '我今天好累', assistant: '那就先歇着，剩下的我帮你理一理。' }],
    ...overrides,
  }
}

describe('lintPersona', () => {
  it('passes a coherent persona with nothing to report', () => {
    expect(lintPersona(persona())).toEqual([])
    expect(isPersonaHealthy([])).toBe(true)
  })

  it('flags a phrase that is both required and forbidden', () => {
    const issues = lintPersona(persona({ catchphrases: ['慢慢来'], avoid: ['慢慢来'] }))
    const found = issues.find((issue) => issue.code === 'catchphrase-collision')
    expect(found?.severity).toBe('error')
    expect(found?.field).toBe('catchphrases')
    expect(found?.sample).toBe('慢慢来')
  })

  it('matches the collision case-insensitively and ignoring extra spaces', () => {
    const issues = lintPersona(persona({ catchphrases: ['Take  It  Easy'], avoid: ['take it easy'] }))
    expect(issues.some((issue) => issue.code === 'catchphrase-collision')).toBe(true)
  })

  it('warns when a forbidden item is phrased as a negation', () => {
    for (const phrase of ['不要冷冰冰', '别用书面语', "don't be curt", '禁止说教']) {
      const issues = lintPersona(persona({ avoid: [phrase] }))
      expect(issues.some((issue) => issue.code === 'avoid-negation'), phrase).toBe(true)
    }
  })

  it('accepts a forbidden item phrased as the replacement', () => {
    const issues = lintPersona(persona({ avoid: ['改说成：我理解你的意思'] }))
    expect(issues.some((issue) => issue.code === 'avoid-negation')).toBe(false)
  })

  it('dilutes, not fails, when the avoid list grows past the readable size', () => {
    const avoid = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']
    const issues = lintPersona(persona({ avoid }))
    const found = issues.find((issue) => issue.code === 'avoid-too-many')
    expect(found?.severity).toBe('tip')
    expect(found?.sample).toBe('7')
  })

  it('warns when there is no complete example, because examples carry the behaviour', () => {
    const none = lintPersona(persona({ examples: [] }))
    expect(none.find((issue) => issue.code === 'no-examples')?.severity).toBe('warn')

    const halves = lintPersona(persona({ examples: [{ user: '在吗', assistant: '  ' }] }))
    expect(halves.some((issue) => issue.code === 'no-examples')).toBe(true)
  })

  it('nudges a half-filled example without treating it as a failure', () => {
    const issues = lintPersona(
      persona({
        examples: [
          { user: '在吗', assistant: '在的' },
          { user: '帮我看看这个', assistant: '' },
        ],
      }),
    )
    const found = issues.find((issue) => issue.code === 'examples-half-filled')
    expect(found?.severity).toBe('tip')
    expect(found?.sample).toBe('1')
  })

  it('reports the length, not a verdict, when the identity runs long', () => {
    const issues = lintPersona(persona({ identity: '很'.repeat(301) }))
    const found = issues.find((issue) => issue.code === 'identity-long')
    expect(found?.severity).toBe('tip')
    expect(found?.sample).toBe('301')
  })

  it('sorts by severity so the page never reorders between reloads', () => {
    const issues = lintPersona(
      persona({
        identity: '很'.repeat(320),
        address: '',
        scenario: '',
        catchphrases: ['慢慢来'],
        avoid: ['慢慢来', '不要催'],
        examples: [],
      }),
    )
    const order = issues.map((issue) => issue.severity)
    expect(order).toEqual([...order].sort((a, b) => ({ error: 0, warn: 1, tip: 2 })[a] - ({ error: 0, warn: 1, tip: 2 })[b]))
    expect(order[0]).toBe('error')
  })

  it('reports only the first negation instead of one line per item', () => {
    const issues = lintPersona(persona({ avoid: ['不要这样', '别那样', '勿催促'] }))
    expect(issues.filter((issue) => issue.code === 'avoid-negation')).toHaveLength(1)
    expect(issues.find((issue) => issue.code === 'avoid-negation')?.sample).toBe('不要这样')
  })
})

describe('isPersonaHealthy', () => {
  it('treats tips as healthy but warnings as not', () => {
    expect(isPersonaHealthy([{ code: 'address-empty', severity: 'tip', field: 'address', sample: '' }])).toBe(true)
    expect(isPersonaHealthy([{ code: 'no-examples', severity: 'warn', field: 'examples', sample: '' }])).toBe(false)
  })
})

describe('budget-aware checks', () => {
  it('is silent when the QQ projector dropped nothing', () => {
    const issues = lintPersona(persona(), [])
    expect(issues.some((issue) => issue.code.startsWith('budget-'))).toBe(false)
  })

  it('treats a cut example dialogue as an error, not a suggestion', () => {
    const issues = lintPersona(persona(), [{ key: 'scenario', label: '适用场景' }, { key: 'examples', label: '示例对话' }])
    const found = issues.find((issue) => issue.code === 'budget-drops-examples')
    expect(found?.severity).toBe('error')
    expect(found?.sample).toContain('示例对话')
    expect(issues.some((issue) => issue.code === 'budget-drops-fields')).toBe(false)
  })

  it('reports other cut layers as a warning with their labels', () => {
    const issues = lintPersona(persona(), [
      { key: 'scenario', label: '适用场景' },
      { key: 'catchphrases', label: '口头禅' },
    ])
    const found = issues.find((issue) => issue.code === 'budget-drops-fields')
    expect(found?.severity).toBe('warn')
    expect(found?.sample).toBe('适用场景、口头禅')
  })

  it('flags a hard truncation as an error because the hard boundary is lost', () => {
    const issues = lintPersona(persona(), [], true)
    const found = issues.find((issue) => issue.code === 'budget-hard-truncated')
    expect(found?.severity).toBe('error')
    expect(found?.field).toBe('identity')
  })
})
