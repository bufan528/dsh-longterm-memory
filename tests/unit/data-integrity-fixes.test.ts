/**
 * Data-integrity regressions for the review findings (B1/B2/B3/B4/B5).
 *
 * - B1: frontmatter scalars starting with `- ` / `? ` / `: ` and multi-line values
 *   must round-trip without producing invalid YAML or losing lines.
 * - B2: an empty lock file (opened but not yet written) must not be treated as stale;
 *   a lock whose owner is dead must be reclaimed.
 * - B3: `#`/`##` lines inside fenced code blocks are content, not headings.
 * - B4: the user's 来源与依据 content survives a save.
 * - B5: CJK frontmatter keys are recognised (not treated as continuation lines).
 *
 * @module tests/unit/data-integrity-fixes.test.ts
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseBody, parseMemoryDocument, renderMemory, spliceBody, splitFrontmatter } from '../../src/shared/markdown.js'
import { normalizeMemory } from '../../src/shared/validate.js'
import { editFrontmatterSource } from '../../src/shared/frontmatter-edit.js'
import { isStaleLock, withFileLock } from '../../src/host/core/fsx.js'

const head = [
  'id: mem_regression',
  'type: knowledge',
  'status: active',
  "title: 'base title'",
  'created_at: 2026-01-01T00:00:00.000Z',
  'updated_at: 2026-01-01T00:00:00.000Z',
  'confidence: high',
  'importance: 50',
  'pinned: false',
].join('\n')

function doc(body: string, extraFrontmatter = ''): string {
  return `---\n${head}${extraFrontmatter}\n---\n\n# base title\n\n${body}\n`
}

describe('B3: fenced code blocks are not headings', () => {
  const body = [
    '## 核心内容',
    '',
    'summary text',
    '',
    '## 用户代码',
    '',
    '```js',
    '## this is a comment in code',
    '# not a title',
    '```',
    '',
    'after the fence',
  ].join('\n')

  it('parseBody keeps fenced lines inside the owning section', () => {
    const parsed = parseBody(`# base title\n\n${body}\n`)
    const headings = parsed.sections.map((section) => section.heading)
    expect(headings).toContain('用户代码')
    expect(headings).not.toContain('this is a comment in code')
    const code = parsed.sections.find((section) => section.heading === '用户代码')
    expect(code?.body).toContain('## this is a comment in code')
    expect(code?.body).toContain('# not a title')
    expect(code?.body).toContain('after the fence')
  })

  it('parseMemoryDocument does not take a fenced # line as the title', () => {
    const source = `---\n${head.replace("title: 'base title'", 'title: ""')}\n---\n\n\`\`\`\n# not the title\n\`\`\`\n\n## 核心内容\n\nbody\n`
    const parsed = parseMemoryDocument(source)
    expect(parsed.title).not.toBe('not the title')
  })

  it('spliceBody preserves fenced content byte-for-byte', () => {
    const parsed = parseMemoryDocument(doc(body))
    const normalized = normalizeMemory(parsed.raw)
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return
    const rendered = spliceBody(parsed.body, { ...normalized.memory, preservedBody: parsed.body })
    expect(rendered).toContain('```js')
    expect(rendered).toContain('## this is a comment in code')
    expect(rendered).toContain('# not a title')
    expect(rendered).toContain('after the fence')
  })
})

describe('B4: the user evidence section survives a render', () => {
  it('keeps 来源与依据 content instead of replacing it with the placeholder', () => {
    const source = doc(
      '## 核心内容\n\nsummary text\n\n## 来源与依据\n\n用户证据原文：见 PR #42\n\n## 相关记忆\n\n（暂无）',
    )
    const parsed = parseMemoryDocument(source)
    expect(parsed.raw.evidence).toBe('用户证据原文：见 PR #42')
    const normalized = normalizeMemory(parsed.raw)
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return
    const rendered = renderMemory({ ...normalized.memory, preservedBody: parsed.body, preservedSource: source })
    expect(rendered).toContain('用户证据原文：见 PR #42')
    expect(rendered).not.toContain('（暂无可追溯来源）')
  })
})

describe('B1/B5: frontmatter scalars and CJK keys', () => {
  const cases: Array<[string, string]> = [
    ['- dash value', '- dash value'],
    ['? question value', '? question value'],
    [': colon value', ': colon value'],
    ['multi\nline value', 'multi\nline value'],
    ["it's quoted", "it's quoted"],
  ]
  for (const [value, expected] of cases) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      const edited = editFrontmatterSource(doc('## 核心内容\n\nsummary\n'), { scalars: { title: value }, arrays: {} })
      expect(edited.ok).toBe(true)
      if (!edited.ok) return
      const meta = splitFrontmatter(edited.source).meta
      expect(meta['title']).toBe(expected)
    })
  }

  it('recognises a CJK frontmatter key and keeps it untouched', () => {
    const source = doc('## 核心内容\n\nsummary\n', '\n备注: 中文说明')
    const edited = editFrontmatterSource(source, { scalars: { title: 'renamed' }, arrays: {} })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    const meta = splitFrontmatter(edited.source).meta
    expect(meta['备注']).toBe('中文说明')
    expect(meta['title']).toBe('renamed')
  })
})

describe('B2: lock staleness and cleanup', () => {
  it('treats a fresh empty lock as live but an old malformed one as stale', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.scratch', 'lock-check-'))
    try {
      const target = join(dir, 'memory.md')
      const lock = `${target}.lock`
      await writeFile(lock, '', 'utf8')
      expect(await isStaleLock(lock, 30_000)).toBe(false)
      const old = new Date(Date.now() - 5000)
      await utimes(lock, old, old)
      expect(await isStaleLock(lock, 30_000)).toBe(true)
      await writeFile(lock, JSON.stringify({ pid: process.pid }), 'utf8')
      expect(await isStaleLock(lock, 30_000)).toBe(false)
      await writeFile(lock, JSON.stringify({ pid: 999_999 }), 'utf8')
      expect(await isStaleLock(lock, 30_000)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reclaims a lock owned by a dead process and releases it afterwards', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.scratch', 'lock-check-'))
    try {
      const target = join(dir, 'memory.md')
      await writeFile(`${target}.lock`, JSON.stringify({ pid: 999_999 }), 'utf8')
      const result = await withFileLock(target, async () => 'ran', { waitMs: 500, staleMs: 30_000 })
      expect(result).toBe('ran')
      const statAfter = await import('node:fs/promises').then((fs) => fs.stat(`${target}.lock`).catch(() => null))
      expect(statAfter).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
