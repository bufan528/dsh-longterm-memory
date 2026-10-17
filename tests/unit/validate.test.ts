/**
 * Metadata validation tests: illegal values must be repaired or quarantined,
 * never allowed to corrupt the index.
 *
 * @module tests/unit/validate.test
 */

import { describe, expect, it } from 'vitest'
import {
  isSafeMemoryId,
  memoryFileName,
  newMemoryId,
  normalizeInstant,
  normalizeMemory,
  normalizeMeta,
} from '../../src/shared/validate.js'

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mem_20261017t031200_a1b2c3d4',
    type: 'knowledge',
    status: 'active',
    createdAt: '2026-10-17T03:12:00.000Z',
    updatedAt: '2026-10-17T03:12:00.000Z',
    title: '标题',
    tags: ['Knowledge Tag'],
    confidence: 'medium',
    importance: 55,
    pinned: false,
    sourceSessions: [],
    supersedes: [],
    conflictsWith: [],
    aliases: [],
    evidence: '',
    schemaVersion: 1,
    summary: '内容',
    sections: [],
    related: [],
    ...overrides,
  }
}

describe('normalizeMemory', () => {
  it('accepts a well-formed memory without repairs', () => {
    const result = normalizeMemory(validInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairs).toEqual([])
    expect(result.memory.tags).toEqual(['knowledge-tag'])
  })

  it('refuses a memory with no id', () => {
    const result = normalizeMemory(validInput({ id: '' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/missing or empty `id`/)
  })

  it('maps an unknown type to knowledge and records the repair', () => {
    const result = normalizeMemory(validInput({ type: 'banana' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory.type).toBe('knowledge')
    expect(result.repairs.join(' ')).toMatch(/unknown type/)
  })

  it('maps an unknown status to pending, so a bad value can never look current', () => {
    const result = normalizeMemory(validInput({ status: 'weird' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory.status).toBe('pending')
  })

  it('repairs a missing timestamp to now rather than dropping the memory', () => {
    const result = normalizeMemory(validInput({ createdAt: undefined, updatedAt: undefined }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Number.isNaN(Date.parse(result.memory.createdAt))).toBe(false)
    expect(result.memory.updatedAt).toBe(result.memory.createdAt)
  })

  it('caps importance into 0..100', () => {
    const high = normalizeMemory(validInput({ importance: 999 }))
    const low = normalizeMemory(validInput({ importance: -12 }))
    expect(high.ok && high.memory.importance).toBe(100)
    expect(low.ok && low.memory.importance).toBe(0)
  })

  it('drops unusable tags but keeps at least the category tag', () => {
    const result = normalizeMemory(validInput({ tags: ['', '   ', 42, 'ok'] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory.tags).toEqual(['ok'])
  })

  it('adds the category tag when no tag survives', () => {
    const result = normalizeMemory(validInput({ tags: [] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory.tags).toEqual(['knowledge'])
  })

  it('accepts a comma separated tag string, as a human might write it', () => {
    const result = normalizeMemory(validInput({ tags: 'alpha, beta' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory.tags).toEqual(['alpha', 'beta'])
  })

  it('rejects a non-object root', () => {
    expect(normalizeMemory(null).ok).toBe(false)
    expect(normalizeMemory([1, 2]).ok).toBe(false)
    expect(normalizeMemory('x').ok).toBe(false)
  })

  it('drops malformed sections instead of failing the whole memory', () => {
    const result = normalizeMemory(validInput({ sections: [{ heading: 'ok', body: 'b' }, { heading: 42 }, null] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory.sections).toEqual([{ heading: 'ok', body: 'b' }])
  })

  it('caps oversized collections', () => {
    const result = normalizeMemory(validInput({ sourceSessions: Array.from({ length: 500 }, (_, index) => `s${String(index)}`) }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory.sourceSessions.length).toBeLessThanOrEqual(64)
  })

  it('keeps supersededBy only when it is a usable string', () => {
    const withValue = normalizeMemory(validInput({ supersededBy: 'mem_x' }))
    const without = normalizeMemory(validInput({ supersededBy: '   ' }))
    expect(withValue.ok && withValue.memory.supersededBy).toBe('mem_x')
    expect(without.ok && without.memory.supersededBy).toBeUndefined()
  })
})

describe('normalizeMeta', () => {
  it('returns metadata without the body fields', () => {
    const result = normalizeMeta(validInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta).not.toHaveProperty('summary')
    expect(result.meta).not.toHaveProperty('sections')
    expect(result.meta.id).toBe('mem_20261017t031200_a1b2c3d4')
  })
})

describe('dates', () => {
  it('normalizes a date-only value', () => {
    expect(normalizeInstant('2026-10-17')).toBe('2026-10-17T00:00:00.000Z')
  })

  it('normalizes an Obsidian space-separated value', () => {
    expect(normalizeInstant('2026-10-17 03:12')).toBe('2026-10-17T03:12:00.000Z')
  })

  it('normalizes an offset value to UTC', () => {
    expect(normalizeInstant('2026-10-17T11:12:00+08:00')).toBe('2026-10-17T03:12:00.000Z')
  })

  it('returns null for nonsense', () => {
    expect(normalizeInstant('not a date')).toBeNull()
    expect(normalizeInstant('')).toBeNull()
  })
})

describe('ids and file names', () => {
  it('generates ids that match the safety shape and sort by time', () => {
    const early = newMemoryId(new Date('2026-10-17T03:12:00.000Z'), () => 0)
    const late = newMemoryId(new Date('2026-10-18T03:12:00.000Z'), () => 0)
    expect(isSafeMemoryId(early)).toBe(true)
    expect(early < late).toBe(true)
  })

  it('generates distinct ids for the same instant', () => {
    const now = new Date('2026-10-17T03:12:00.000Z')
    let counter = 0
    const first = newMemoryId(now, () => (counter++ % 2 === 0 ? 0.1 : 0.9))
    const second = newMemoryId(now, () => (counter++ % 2 === 0 ? 0.2 : 0.8))
    expect(first).not.toBe(second)
  })

  it('builds a file name that ends with the id, so an id survives a rename', () => {
    const file = memoryFileName({ id: 'mem_20261017t031200_a1b2c3d4', title: '中文标题' })
    expect(file).toMatch(/^中文标题-mem_20261017t031200_a1b2c3d4\.md$/)
  })
})
