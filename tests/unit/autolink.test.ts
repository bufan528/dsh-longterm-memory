/**
 * Auto-link inference tests.
 *
 * The contract: infer only explainable relations, never cross a read boundary,
 * never duplicate a manual link, and never fill the vault with hub edges.
 *
 * @module tests/unit/autolink.test
 */

import { describe, expect, it } from 'vitest'

import { suggestAutoLinks } from '../../src/host/core/autolink.js'
import {
  deriveIndex,
  emptyIndex,
  fieldTokens,
  termWeights,
  type IndexRecord,
  type MemoryIndex,
} from '../../src/shared/search.js'
import type { Memory } from '../../src/shared/types.js'

function record(
  id: string,
  title: string,
  overrides: Partial<IndexRecord> & { summary?: string } = {},
): IndexRecord {
  const summary = overrides.summary ?? ''
  const tokens = fieldTokens({
    title,
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? [],
    summary,
    body: '',
  })
  return {
    id,
    path: `Knowledge/${id}.md`,
    type: overrides.type ?? 'knowledge',
    status: overrides.status ?? 'active',
    title,
    tags: overrides.tags ?? [],
    aliases: overrides.aliases ?? [],
    confidence: overrides.confidence ?? 'high',
    importance: overrides.importance ?? 50,
    pinned: overrides.pinned ?? false,
    visibility: overrides.visibility ?? 'desktop-private',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    preview: summary,
    terms: termWeights(tokens),
    links: overrides.links ?? [],
    size: 100,
    mtimeMs: 1000,
    checksum: 'deadbeef',
  }
}

function makeIndex(records: IndexRecord[]): MemoryIndex {
  const index = emptyIndex('/tmp/vault')
  for (const entry of records) index.records.set(entry.id, entry)
  deriveIndex(index)
  return index
}

function memory(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    type: 'knowledge',
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    tags: [],
    confidence: 'high',
    importance: 50,
    pinned: false,
    sourceSessions: [],
    sourceChannels: [],
    visibility: 'desktop-private',
    supersedes: [],
    conflictsWith: [],
    aliases: [],
    evidence: '',
    schemaVersion: 1,
    summary: '',
    sections: [],
    related: [],
    ...overrides,
  }
}

describe('suggestAutoLinks', () => {
  it('links a memory whose exact title appears in the new text', () => {
    const index = makeIndex([record('a', 'Markdown 是唯一事实源')])
    const source = memory({ id: 'b', title: '索引策略', summary: '沿用 Markdown 是唯一事实源 的结论。' })
    const links = suggestAutoLinks(source, index)
    expect(links.map((link) => link.target)).toEqual(['Markdown 是唯一事实源'])
    expect(links[0]?.reason).toContain('正文提及')
  })

  it('links on two shared specific tags', () => {
    const index = makeIndex([record('a', '索引与检索', { tags: ['architecture', 'index'] })])
    const source = memory({ id: 'b', title: '存储层', tags: ['architecture', 'index'] })
    expect(suggestAutoLinks(source, index).map((link) => link.target)).toEqual(['索引与检索'])
  })

  it('ignores the type default tag, which every note of that type carries', () => {
    const index = makeIndex([record('a', '远程工作政策', { tags: ['knowledge'] })])
    const source = memory({ id: 'b', title: '咖啡烘焙曲线', tags: ['knowledge'] })
    expect(suggestAutoLinks(source, index)).toEqual([])
  })

  it('does not infer a target the user already wrote as a wikilink', () => {
    const index = makeIndex([record('a', 'Markdown 是唯一事实源')])
    const source = memory({ id: 'b', title: '索引策略', summary: '见 [[Markdown 是唯一事实源]]。' })
    expect(suggestAutoLinks(source, index)).toEqual([])
  })

  it('never duplicates a manual link', () => {
    const index = makeIndex([record('a', 'Markdown 是唯一事实源')])
    const source = memory({
      id: 'b',
      title: '索引策略',
      summary: '见 Markdown 是唯一事实源。',
      related: ['Markdown 是唯一事实源'],
    })
    expect(suggestAutoLinks(source, index)).toEqual([])
  })

  it('never links across a visibility boundary', () => {
    const index = makeIndex([record('a', '对外的记忆', { visibility: 'shared' })])
    const source = memory({ id: 'b', title: '私人记忆', visibility: 'qq-private', summary: '见 对外的记忆。' })
    expect(suggestAutoLinks(source, index)).toEqual([])
  })

  it('caps inferred links so a hub cannot explode', () => {
    const index = makeIndex(
      ['一', '二', '三', '四', '五'].map((title, position) =>
        record(`m${String(position)}`, title),
      ),
    )
    const source = memory({ id: 'b', title: '总览', summary: '见 一、二、三、四、五。' })
    expect(suggestAutoLinks(source, index)).toHaveLength(3)
  })

  it('returns nothing when only the type and importance overlap', () => {
    const index = makeIndex([record('a', '远程工作政策')])
    const source = memory({ id: 'b', title: '咖啡烘焙曲线', summary: '记录浅烘与深烘的风味差异。' })
    expect(suggestAutoLinks(source, index)).toEqual([])
  })
})
