/**
 * Markdown codec tests: the round-trip guarantee the whole vault rests on.
 *
 * @module tests/unit/markdown.test
 */

import { describe, expect, it } from 'vitest'
import {
  FrontmatterError,
  extractWikilinks,
  joinFrontmatter,
  metaToFrontmatter,
  parseMemoryDocument,
  renderMemory,
  slugify,
  splitFrontmatter,
} from '../../src/shared/markdown.js'
import type { Memory } from '../../src/shared/types.js'

function sampleMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_20261017t031200_a1b2c3d4',
    type: 'decision',
    status: 'active',
    createdAt: '2026-10-17T03:12:00.000Z',
    updatedAt: '2026-10-17T03:12:00.000Z',
    title: '使用 Markdown 作为唯一事实来源',
    tags: ['decision', 'architecture'],
    confidence: 'high',
    importance: 80,
    pinned: true,
    sourceSessions: ['session-abc'],
    supersedes: [],
    conflictsWith: [],
    aliases: ['事实来源'],
    evidence: '用户在会话中明确要求："记忆必须能直接在 Obsidian 中阅读"。',
    schemaVersion: 1,
    summary: '长期记忆以 Markdown 文件为核心，数据库索引只能作为可重建的辅助数据。',
    sections: [{ heading: '补充说明', body: '不允许把唯一事实存放在 SQLite 中。' }],
    related: ['长期偏好'],
    ...overrides,
  }
}

describe('frontmatter', () => {
  it('round-trips a rendered memory without loss', () => {
    const memory = sampleMemory()
    const text = renderMemory(memory)
    const parsed = parseMemoryDocument(text)

    expect(parsed.raw['id']).toBe(memory.id)
    expect(parsed.raw['type']).toBe('decision')
    expect(parsed.raw['status']).toBe('active')
    expect(parsed.raw['createdAt']).toBe(memory.createdAt)
    expect(parsed.raw['updatedAt']).toBe(memory.updatedAt)
    expect(parsed.raw['tags']).toEqual(['decision', 'architecture'])
    expect(parsed.raw['confidence']).toBe('high')
    expect(parsed.raw['importance']).toBe(80)
    expect(parsed.raw['pinned']).toBe(true)
    expect(parsed.raw['sourceSessions']).toEqual(['session-abc'])
    expect(parsed.raw['aliases']).toEqual(['事实来源'])
    expect(parsed.raw['summary'] as string).toContain('Markdown 文件为核心')
    expect(parsed.raw['related'] as string[]).toEqual(['长期偏好'])
    expect((parsed.raw['sections'] as { heading: string }[]).map((section) => section.heading)).toContain('补充说明')
  })

  it('starts with a fence and uses snake_case keys Obsidian understands', () => {
    const text = renderMemory(sampleMemory())
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toMatch(/\ncreated_at: /)
    expect(text).toMatch(/\nupdated_at: /)
    expect(text).toMatch(/\nsource_sessions:/)
    expect(text).toMatch(/\nschema_version:/)
  })

  it('omits empty collections so a note stays readable', () => {
    const frontmatter = metaToFrontmatter(sampleMemory({ supersedes: [], conflictsWith: [], aliases: [] }))
    expect(frontmatter).not.toHaveProperty('supersedes')
    expect(frontmatter).not.toHaveProperty('conflicts_with')
    expect(frontmatter).not.toHaveProperty('aliases')
  })

  it('accepts a UTF-8 BOM and CRLF line endings, as Obsidian on Windows writes', () => {
    const text = `\uFEFF---\r\nid: mem_x\r\ntype: knowledge\r\n---\r\n\r\n# 标题\r\n\r\n## 核心内容\r\n\r\n内容\r\n`
    const parsed = splitFrontmatter(text)
    expect(parsed.meta['id']).toBe('mem_x')
    expect(parsed.body).toContain('# 标题')
  })

  it('reports a missing fence rather than guessing', () => {
    expect(() => splitFrontmatter('# just a heading')).toThrow(FrontmatterError)
  })

  it('reports an unterminated fence', () => {
    expect(() => splitFrontmatter('---\nid: x\n\n# body')).toThrow(/never closed/)
  })

  it('reports invalid YAML', () => {
    expect(() => splitFrontmatter('---\nid: [unclosed\n---\n\nbody')).toThrow(/not valid YAML/)
  })

  it('rejects a non-mapping frontmatter', () => {
    expect(() => splitFrontmatter('---\n- a\n- b\n---\n\nbody')).toThrow(/must be a YAML mapping/)
  })

  it('preserves braces in memory text for the join step', () => {
    const memory = sampleMemory({ summary: '模板写作使用 {{variable}} 占位符。' })
    const text = renderMemory(memory)
    const parsed = parseMemoryDocument(text)
    expect(parsed.raw['summary'] as string).toContain('{{variable}}')
  })

  it('accepts Obsidian date-only and space-separated timestamps via the raw reader', () => {
    const text = joinFrontmatter({ id: 'mem_a', created_at: '2026-10-17', updated_at: '2026-10-17 03:12' }, 'body')
    const parsed = splitFrontmatter(text)
    expect(parsed.meta['created_at']).toBe('2026-10-17')
    expect(parsed.meta['updated_at']).toBe('2026-10-17 03:12')
  })
})

describe('wikilinks', () => {
  it('extracts targets, ignoring aliases and anchors', () => {
    expect(extractWikilinks('见 [[记忆标题|别名]] 与 [[另一条#小节]] 和 [[第三条]]')).toEqual([
      '记忆标题',
      '另一条',
      '第三条',
    ])
  })

  it('de-duplicates repeated links', () => {
    expect(extractWikilinks('[[a]] [[a]]')).toEqual(['a'])
  })

  it('parses the related section into the related list', () => {
    const text = renderMemory(sampleMemory({ related: ['甲', '乙'] }))
    expect(parseMemoryDocument(text).raw['related']).toEqual(['甲', '乙'])
  })
})

describe('slugify', () => {
  it('keeps CJK characters', () => {
    expect(slugify('使用 Markdown 作为唯一事实来源')).toBe('使用 Markdown 作为唯一事实来源')
  })

  it('removes characters that are illegal on Windows or confuse Obsidian links', () => {
    const stem = slugify('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')
    expect(stem).not.toMatch(/[\\/:*?"<>|#^[\]]/)
  })

  it('avoids Windows reserved device names', () => {
    expect(slugify('CON').toLowerCase()).not.toBe('con')
    expect(slugify('nul')).toBe('nul-note')
  })

  it('falls back when the title has no usable characters', () => {
    expect(slugify('///', 'memory')).toBe('memory')
  })

  it('caps the length', () => {
    expect(slugify('字'.repeat(300)).length).toBeLessThanOrEqual(80)
  })
})
