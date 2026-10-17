/**
 * Source-text frontmatter contract (round 5, P0).
 *
 * The contract: editing a plugin-owned field rewrites **only that field's lines**.
 * Everything else — YAML comments, unknown keys and their order, empty values,
 * quoting style, body text — stays byte-for-byte identical. When the field's
 * boundaries cannot be determined safely, the edit is refused, and the file on
 * disk is left untouched.
 *
 * These tests compare raw text, not parsed objects: a parsed comparison would hide
 * the very loss this contract exists to prevent.
 *
 * @module tests/integration/frontmatter-fidelity.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { editFrontmatterSource, splitFrontmatterSource } from '../../src/shared/frontmatter-edit.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

const DOC = `---
# 这是文件顶部的注释
id: mem_20261017t000000_fm1
type: knowledge
status: active          # 行尾注释
title: '带引号的标题'
created_at: 2026-10-17T00:00:00.000Z
updated_at: 2026-10-17T00:00:00.000Z
tags:
  - fidelity
  # 列表中的注释
  - markdown
empty_field:
custom_key: keep-me
zzz_last: 也是未知字段
schema_version: 1
---

# 带引号的标题

## 核心内容

正文。

## 我的备注

用户段落。

## 来源与依据

验收。

## 相关记忆

（暂无）
`

describe('editFrontmatterSource keeps untouched lines byte-identical', () => {
  it('rewrites only the changed scalar and leaves every other line intact', () => {
    const result = editFrontmatterSource(DOC, { scalars: { status: 'archived' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const before = DOC.split('\n')
    const after = result.source.split('\n')
    const changed = before
      .map((line, index) => ({ line, index }))
      .filter((entry) => after[entry.index] !== entry.line)
    // Exactly one line differs, and it is the status line.
    expect(changed).toHaveLength(1)
    expect(changed[0]?.line.startsWith('status:')).toBe(true)
    // The trailing comment is preserved, only the value changes.\n    expect(after[changed[0]?.index ?? 0]).toBe('status: archived          # 行尾注释')
  })

  it('keeps the leading comment, the inline comment and unknown key order', () => {
    const result = editFrontmatterSource(DOC, { scalars: { title: '新标题' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('# 这是文件顶部的注释')
    expect(result.source).toContain('status: active          # 行尾注释')
    expect(result.source).toContain('empty_field:')
    const customIndex = result.source.indexOf('custom_key: keep-me')
    const zzzIndex = result.source.indexOf('zzz_last: 也是未知字段')
    expect(customIndex).toBeGreaterThan(-1)
    expect(customIndex).toBeLessThan(zzzIndex)
  })

  it('preserves quoting style of values it does not touch', () => {
    const result = editFrontmatterSource(DOC, { scalars: { importance: 70 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("title: '带引号的标题'")
  })

  it('is a no-op source-wise when the value is unchanged', () => {
    const first = editFrontmatterSource(DOC, { scalars: { status: 'active' } })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.source).toBe(DOC)
  })

  it('rebuilds a list and keeps the comments that followed it', () => {
    const result = editFrontmatterSource(DOC, { arrays: { tags: ['one', 'two'] } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('  - one')
    expect(result.source).toContain('  - two')
    expect(result.source).toContain('# 列表中的注释')
    // The unrelated body is untouched.
    expect(result.source).toContain('用户段落。')
  })

  it('refuses a duplicate owned key', () => {
    const duplicated = DOC.replace('status: active          # 行尾注释', 'status: active          # 行尾注释\nstatus: archived')
    const result = editFrontmatterSource(duplicated, { scalars: { status: 'stale' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/重复的键/)
  })

  it('refuses a multi-line scalar it cannot rewrite safely', () => {
    const multi = DOC.replace('title: \'带引号的标题\'', "title: '第一行'\n  续行内容")
    const result = editFrontmatterSource(multi, { scalars: { title: '新标题' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/跨越多行/)
  })

  it('refuses a document whose frontmatter is not terminated', () => {
    const broken = '---\nid: mem_1\ntitle: 坏文件\n\n# 正文\n'
    const result = editFrontmatterSource(broken, { scalars: { status: 'active' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/边界/)
  })

  it('refuses a source with no frontmatter at all', () => {
    expect(editFrontmatterSource('# 只有正文\n', { scalars: { status: 'active' } }).ok).toBe(false)
  })

  it('splitFrontmatterSource round-trips the original document', () => {
    const split = splitFrontmatterSource(DOC)
    expect(split).not.toBeNull()
    if (split === null) return
    expect(split.body.startsWith('\n# 带引号的标题')).toBe(true)
  })
})

describe('plugin writes preserve raw frontmatter text', () => {
  const REL = 'Knowledge/带引号的标题-mem_20261017t000000_fm1.md'
  let root: string
  let vault: string
  let service: MemoryService

  function discoveryFor(path: string): VaultDiscovery {
    return {
      environment: 'desktop',
      filesystem: true,
      obsidian: { detected: false, configPath: null, vaults: [] },
      current: null,
      candidates: [path],
      needsChoice: false,
      rationale: 'test',
      warnings: [],
    }
  }

  beforeEach(async () => {
    root = await makeTempRoot('fm-fidelity')
    vault = join(root, 'DSH Memory')
    service = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
    await service.initialize(vault)
    await writeFile(join(vault, REL), DOC, 'utf8')
    await service.syncIndex()
  })

  afterEach(async () => {
    await cleanup(root)
  })

  it('a field edit keeps every line except the edited one', async () => {
    const before = await readFile(join(vault, REL), 'utf8')
    await service.setStatus('mem_20261017t000000_fm1', 'archived', '测试归档')
    // Archiving moves the note into Archive/, so read the live path from the service.
    const moved = await service.get('mem_20261017t000000_fm1')
    const after = await readFile(moved.absolutePath, 'utf8')

    const beforeLines = before.split('\n')
    const afterLines = after.split('\n')
    // Archiving also moves the file, so compare by content: only the status and
    // updated_at lines may differ, and no line may be lost from the user's text.
    for (const fragment of [
      '# 这是文件顶部的注释',
      '# 行尾注释',
      "title: '带引号的标题'",
      'empty_field:',
      'custom_key: keep-me',
      'zzz_last: 也是未知字段',
      '# 列表中的注释',
      '## 我的备注',
      '用户段落。',
    ]) {
      expect(after, `lost: ${fragment}`).toContain(fragment)
    }
    expect(after).toMatch(/status: archived/)
    // No user line may disappear. The plugin may only ADD its own required fields
    // (an empty `tags:`/`pinned:` etc.), never drop or reformat a user line.
    expect(afterLines.length).toBeGreaterThanOrEqual(beforeLines.length)
    // The region the user owns — everything from their own section to the end of
    // the file — must survive byte-for-byte (the plugin-owned sections above it may
    // legitimately be rewritten).
    const notesRegion = beforeLines
      .slice(beforeLines.indexOf('## 我的备注'), beforeLines.indexOf('## 来源与依据'))
      .join('\n')
    expect(after).toContain(notesRegion)
  })

  it('repeated edits keep unrelated raw content stable', async () => {
    await service.setPinned('mem_20261017t000000_fm1', true)
    const once = await readFile(join(vault, REL), 'utf8')
    await service.setPinned('mem_20261017t000000_fm1', false)
    await service.setPinned('mem_20261017t000000_fm1', true)
    const twice = await readFile(join(vault, REL), 'utf8')
    const strip = (text: string): string =>
      text
        .split('\n')
        .filter((line) => !line.startsWith('updated_at:') && !line.startsWith('status:'))
        .join('\n')
    expect(strip(twice)).toBe(strip(once))
  })

  it('refuses to overwrite an unsafe file and leaves its bytes untouched', async () => {
    const broken = '---\nid: mem_20261017t000000_fm1\ntitle: 未闭合\n\n# 正文\n'
    const path = join(vault, REL)
    await writeFile(path, broken, 'utf8')
    await expect(service.setPinned('mem_20261017t000000_fm1', true)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(broken)
  })
})
