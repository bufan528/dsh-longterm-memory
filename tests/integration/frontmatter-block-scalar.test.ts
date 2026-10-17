/**
 * F4 regression: user-authored frontmatter block scalars must survive a save
 * (round RR-3). The closing fence is only a fence at column 0; indented `---`
 * inside a block scalar is data. BOM / CRLF style must not be silently changed.
 *
 * @module tests/integration/frontmatter-block-scalar.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { editFrontmatterSource, splitFrontmatterSource } from '../../src/shared/frontmatter-edit.js'
import { parseMemoryDocument } from '../../src/shared/markdown.js'

let root: string
let vault: string
let service: MemoryService

function newService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault })
}

/** Insert lines just before the column-0 closing fence of the frontmatter. */
function injectIntoFrontmatter(source: string, lines: string[]): string {
  const normalized = source.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n')
  let closing = -1
  for (let index = 1; index < parts.length; index += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(parts[index] ?? '')) { closing = index; break }
  }
  if (closing === -1) throw new Error('no closing fence in fixture')
  return [...parts.slice(0, closing), ...lines, ...parts.slice(closing)].join('\n')
}

beforeEach(async () => {
  root = await makeTempRoot('frontmatter-block-scalar')
  vault = join(root, 'DSH Memory')
  service = newService()
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

describe('block scalars survive a real load → save → load', () => {
  it('keeps trailing lines after an indented --- through a status change', async () => {
    const created = await service.save({ type: 'knowledge', title: '块标量记忆', summary: '正文。', tags: [], confidence: 'high', importance: 50 })
    const raw = await service.readRaw(created.id)
    const path = join(vault, raw?.relativePath as string)
    const injected = injectIntoFrontmatter(raw?.content ?? '', ['extra: |-', '  first', '  ---', '  last'])
    await writeFile(path, injected, 'utf8')

    await service.setStatus(created.id, 'archived', 'block scalar test')

    const after = await service.readRaw(created.id)
    const content = after?.content ?? ''
    // The data lines must still exist, at their original indentation.
    expect(content).toContain('  first\n  ---\n  last')
    // Re-parsing must recover the full value, not just the first line.
    const parsed = parseMemoryDocument(content)
    expect(parsed.unknownFrontmatter['extra']).toBe('first\n---\nlast')
    // The plugin-owned status was still updated.
    const status = /^status:\s*(\S+)$/m.exec(content)?.[1]
    expect(status).toBe('archived')
  })

  it('leaves a body-level --- untouched', async () => {
    const created = await service.save({ type: 'knowledge', title: '正文分隔线', summary: '正文。', tags: [], confidence: 'high', importance: 50 })
    const raw = await service.readRaw(created.id)
    const path = join(vault, raw?.relativePath as string)
    const content = `${raw?.content ?? ''}\n## 用户补充\n\n正文中的分隔线：\n---\n分隔线之后。\n`
    await writeFile(path, content, 'utf8')
    await service.setStatus(created.id, 'archived', 'body fence test')
    const after = await service.readRaw(created.id)
    expect(after?.content).toContain('## 用户补充')
    expect(after?.content).toContain('正文中的分隔线：\n---\n分隔线之后。')
  })

  it('refuses an unterminated document without touching existing bytes', async () => {
    const created = await service.save({ type: 'knowledge', title: '未闭合', summary: '正文。', tags: [], confidence: 'high', importance: 50 })
    const raw = await service.readRaw(created.id)
    const path = join(vault, raw?.relativePath as string)
    const broken = (raw?.content ?? '').replace(/\n---\n/, '\n').replace(/\n---$/, '\n')
    await writeFile(path, broken, 'utf8')
    const before = await readFile(path, 'utf8')
    await expect(service.setStatus(created.id, 'archived', 'should refuse')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(before)
  })
})

describe('block scalar forms and source style', () => {
  const head = 'id: mem_probe\ntype: knowledge\nstatus: active\ntitle: probe\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\nconfidence: high\nimportance: 50\npinned: false'

  const markerValues: Record<string, string> = {
    '|': 'first\n---\nlast\n',
    '|-': 'first\n---\nlast',
    '|+': 'first\n---\nlast\n',
    '>': 'first --- last\n',
  }
  for (const marker of ['|', '|-', '|+', '>']) {
    it(`keeps ${marker} block scalar content and round-trips YAML`, () => {
      const source = `---\n${head}\nextra: ${marker}\n  first\n  ---\n  last\n---\n\n# probe\n\n## 核心内容\n\nbody\n`
      const edited = editFrontmatterSource(source, { scalars: { title: 'renamed' }, arrays: {} })
      expect(edited.ok).toBe(true)
      if (!edited.ok) return
      expect(edited.source).toContain('  first\n  ---\n  last')
      const parsed = parseMemoryDocument(edited.source)
      expect(parsed.unknownFrontmatter['extra']).toBe(markerValues[marker])
      expect(parsed.title).toBe('renamed')
    })
  }

  it('preserves BOM and CRLF while editing one field', () => {
    const source = `\uFEFF---\r\n${head.replace(/\n/g, '\r\n')}\r\nextra: |-\r\n  first\r\n  ---\r\n  last\r\n---\r\n\r\n# probe\r\n\r\nbody\r\n`
    const edited = editFrontmatterSource(source, { scalars: { title: 'renamed' }, arrays: {} })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.source.startsWith('\uFEFF')).toBe(true)
    expect(edited.source).toContain('\r\n')
    expect(edited.source.replace(/\r\n/g, '')).not.toContain('\n')
    const parsed = parseMemoryDocument(edited.source)
    expect(parsed.unknownFrontmatter['extra']).toBe('first\n---\nlast')
    expect(parsed.title).toBe('renamed')
  })

  it('splits only on column-0 fences', () => {
    const source = `---\n${head}\nextra: |-\n  first\n  ---\n  last\n---\n\nbody\n`
    const split = splitFrontmatterSource(source)
    expect(split).not.toBeNull()
    expect(split?.frontmatter.join('\n')).toContain('  ---')
    expect(split?.body.trim()).toBe('body')
  })

  it('still recognizes the real closing fence and dot fence', () => {
    const source = `---\n${head}\nextra: value\n...\n\nbody\n`
    const split = splitFrontmatterSource(source)
    expect(split?.frontmatter.join('\n')).toContain('extra: value')
    expect(split?.body.trim()).toBe('body')
  })
})
