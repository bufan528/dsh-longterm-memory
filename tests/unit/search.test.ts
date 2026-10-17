/**
 * Index and ranking tests.
 *
 * The important claim under test is that retrieval works on real Chinese text —
 * which has no spaces — without any embedding model.
 *
 * @module tests/unit/search.test
 */

import { describe, expect, it } from 'vitest'
import {
  checksum,
  deriveIndex,
  emptyIndex,
  fieldTokens,
  queryIndex,
  relatedMemories,
  termWeights,
  tokenize,
  type IndexRecord,
  type MemoryIndex,
} from '../../src/shared/search.js'

function makeRecord(overrides: Partial<IndexRecord> & { id: string; title: string }): IndexRecord {
  const summary = overrides.preview ?? ''
  const tokens = fieldTokens({
    title: overrides.title,
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? [],
    summary,
    body: overrides.aliases?.join(' ') ?? '',
  })
  return {
    id: overrides.id,
    path: overrides.path ?? `Knowledge/${overrides.id}.md`,
    type: overrides.type ?? 'knowledge',
    status: overrides.status ?? 'active',
    title: overrides.title,
    tags: overrides.tags ?? [],
    aliases: overrides.aliases ?? [],
    confidence: overrides.confidence ?? 'medium',
    importance: overrides.importance ?? 50,
    pinned: overrides.pinned ?? false,
    createdAt: overrides.createdAt ?? '2026-10-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-10-01T00:00:00.000Z',
    preview: summary,
    terms: termWeights(tokens),
    links: overrides.links ?? [],
    size: overrides.size ?? 100,
    mtimeMs: overrides.mtimeMs ?? 1000,
    checksum: overrides.checksum ?? 'deadbeef',
  }
}

function makeIndex(records: IndexRecord[]): MemoryIndex {
  const index = emptyIndex('/tmp/vault')
  for (const record of records) index.records.set(record.id, record)
  deriveIndex(index)
  return index
}

describe('tokenize', () => {
  it('splits latin text on non-word characters and lower-cases it', () => {
    expect(tokenize('Use TypeScript, not JavaScript!')).toEqual(['use', 'typescript', 'not', 'javascript'])
  })

  it('emits unigrams and bigrams for Chinese so word-less text is searchable', () => {
    const tokens = tokenize('长期记忆')
    expect(tokens).toContain('长')
    expect(tokens).toContain('长期')
    expect(tokens).toContain('记忆')
  })

  it('handles mixed Chinese and latin text', () => {
    const tokens = tokenize('使用 Obsidian 管理记忆')
    expect(tokens).toContain('obsidian')
    expect(tokens).toContain('记忆')
  })

  it('drops single latin letters but keeps single digits', () => {
    const tokens = tokenize('a b 7')
    expect(tokens).not.toContain('a')
    expect(tokens).not.toContain('b')
    expect(tokens).toContain('7')
  })

  it('returns nothing for empty input', () => {
    expect(tokenize('')).toEqual([])
  })

  it('de-duplicates terms', () => {
    expect(tokenize('memory memory memory')).toEqual(['memory'])
  })
})

describe('queryIndex ranking', () => {
  const index = makeIndex([
    makeRecord({
      id: 'mem_title',
      title: 'Obsidian 记忆仓库',
      preview: '仓库结构说明',
      tags: ['obsidian'],
    }),
    makeRecord({
      id: 'mem_body',
      title: '无关标题',
      preview: '这里只是顺便提到 obsidian 一次，正文很长。',
    }),
    makeRecord({
      id: 'mem_other',
      title: '完全无关',
      preview: '别的内容',
    }),
  ])

  it('ranks a title hit above a body hit', () => {
    const hits = queryIndex(index, { text: 'obsidian' })
    expect(hits[0]?.record.id).toBe('mem_title')
    expect(hits.map((hit) => hit.record.id)).toContain('mem_body')
    expect(hits.map((hit) => hit.record.id)).not.toContain('mem_other')
  })

  it('explains why each result matched', () => {
    const hits = queryIndex(index, { text: 'obsidian' })
    expect(hits[0]?.reasons.join(' ')).toMatch(/关键词匹配/)
  })

  it('matches an exact memory id with a large bonus', () => {
    const hits = queryIndex(index, { text: 'mem_other' })
    expect(hits[0]?.record.id).toBe('mem_other')
    expect(hits[0]?.reasons.join(' ')).toMatch(/精确匹配/)
  })

  it('matches an exact title', () => {
    const hits = queryIndex(index, { text: 'Obsidian 记忆仓库' })
    expect(hits[0]?.record.id).toBe('mem_title')
  })

  it('searches Chinese substrings', () => {
    const hits = queryIndex(index, { text: '记忆' })
    expect(hits.map((hit) => hit.record.id)).toContain('mem_title')
  })

  it('returns filter matches when no text is given, ordered by importance and recency', () => {
    const ranked = makeIndex([
      makeRecord({ id: 'a', title: 'A', importance: 10, updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeRecord({ id: 'b', title: 'B', importance: 90, updatedAt: '2026-01-01T00:00:00.000Z' }),
    ])
    const hits = queryIndex(ranked, {})
    expect(hits[0]?.record.id).toBe('b')
  })

  it('returns nothing when nothing matches', () => {
    expect(queryIndex(index, { text: 'zzzznotpresent' })).toEqual([])
  })
})

describe('queryIndex filters', () => {
  const index = makeIndex([
    makeRecord({ id: 'active', title: 'A', status: 'active', type: 'decision', tags: ['x'], updatedAt: '2026-10-10T00:00:00.000Z' }),
    makeRecord({ id: 'archived', title: 'B', status: 'archived', type: 'decision', tags: ['x'] }),
    makeRecord({ id: 'pending', title: 'C', status: 'pending', type: 'task', tags: ['y'] }),
    makeRecord({ id: 'pinned', title: 'D', status: 'active', type: 'profile', pinned: true }),
  ])

  it('filters by status', () => {
    expect(queryIndex(index, { filters: { statuses: ['active'] } }).map((hit) => hit.record.id).sort()).toEqual(['active', 'pinned'])
  })

  it('filters by type', () => {
    expect(queryIndex(index, { filters: { types: ['task'] } }).map((hit) => hit.record.id)).toEqual(['pending'])
  })

  it('filters by tag', () => {
    expect(queryIndex(index, { filters: { tags: ['x'] } }).map((hit) => hit.record.id).sort()).toEqual(['active', 'archived'])
  })

  it('filters by pinned', () => {
    expect(queryIndex(index, { filters: { pinnedOnly: true } }).map((hit) => hit.record.id)).toEqual(['pinned'])
  })

  it('filters by updated-at range', () => {
    const hits = queryIndex(index, { filters: { since: '2026-10-05T00:00:00.000Z' } })
    expect(hits.map((hit) => hit.record.id)).toEqual(['active'])
  })

  it('restricts to an explicit id allow-list', () => {
    expect(queryIndex(index, { onlyIds: ['pending'] }).map((hit) => hit.record.id)).toEqual(['pending'])
  })

  it('respects the limit', () => {
    expect(queryIndex(index, { limit: 2 })).toHaveLength(2)
  })
})

describe('relatedMemories', () => {
  it('ranks a linked memory first, then shared tags, then shared terms', () => {
    const index = makeIndex([
      makeRecord({ id: 'src', title: '源', tags: ['shared'], links: ['被链接'] }),
      makeRecord({ id: 'linked', title: '被链接', tags: [] }),
      makeRecord({ id: 'tagged', title: '同标签', tags: ['shared'] }),
      makeRecord({ id: 'unrelated', title: '无关' }),
    ])
    const related = relatedMemories(index, 'src')
    expect(related[0]?.record.id).toBe('linked')
    expect(related.map((hit) => hit.record.id)).toContain('tagged')
    expect(related[0]?.reasons.join(' ')).toMatch(/互相链接/)
  })

  it('returns nothing for an unknown id', () => {
    expect(relatedMemories(makeIndex([]), 'nope')).toEqual([])
  })
})

describe('checksum', () => {
  it('is stable and content sensitive', () => {
    expect(checksum('abc')).toBe(checksum('abc'))
    expect(checksum('abc')).not.toBe(checksum('abd'))
  })

  it('handles CJK content', () => {
    expect(checksum('长期记忆')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('deriveIndex', () => {
  it('builds postings from record terms and resolves links both ways', () => {
    const index = makeIndex([
      makeRecord({ id: 'a', title: '称呼甲', tags: ['t'] }),
      makeRecord({ id: 'b', title: '称呼乙', tags: ['t'], links: ['称呼甲'] }),
    ])
    expect(index.postings.size).toBeGreaterThan(0)
    expect(index.resolvedLinks.get('b')).toEqual(['a'])
  })

  it('ignores a dangling wikilink rather than inventing a relation', () => {
    const index = makeIndex([makeRecord({ id: 'a', title: '甲', links: ['不存在的标题'] })])
    expect(index.resolvedLinks.get('a')).toEqual([])
  })
})
