/**
 * Markdown non-destructive writing (round 4, P0).
 *
 * The contract under test: a write driven by the plugin rewrites **only** the
 * parts the plugin owns (the H1 title and the three named sections) and leaves
 * every other byte of the document alone. Anything the plugin cannot read safely
 * is refused instead of being re-serialized into a lossy version.
 *
 * What is guaranteed: unknown frontmatter keys, unknown `##` sections, block
 * quotes, custom markers, stray paragraphs and blank-line placement survive a
 * plugin-initiated edit, archive, restore and restart.
 * What is NOT guaranteed (and is asserted as such): comments *inside* YAML
 * frontmatter, because YAML is parsed and re-emitted.
 *
 * @module tests/integration/markdown-fidelity.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { spliceBody } from '../../src/shared/markdown.js'
import type { Memory, VaultDiscovery } from '../../src/shared/types.js'

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

/** A note as a user would leave it: extra frontmatter, extra body, odd spacing. */
const USER_NOTE = `---
id: mem_20261017t000000_fidelity1
type: knowledge
status: active
title: 保真测试记忆
created_at: 2026-10-17T00:00:00.000Z
updated_at: 2026-10-17T00:00:00.000Z
tags:
  - fidelity
confidence: high
importance: 60
schema_version: 1
cssclass: wide-page
review_after: 2027-01-01
aliases:
  - 保真别名
---

# 保真测试记忆

## 核心内容

这是插件拥有的正文。

## 我的备注

用户自己加的段落，必须原样保留。
第二行也一样。

> 一段引用，带 **加粗** 和 [[内部链接]]。

- 列表项 A
- 列表项 B

<!-- USER-MARKER-9931 -->

## 来源与依据

验收脚本写入。

## 相关记忆

（暂无）

## 附录

尾部附录，插件不认识。
`

const NOTE_REL = 'Knowledge/保真测试记忆-mem_20261017t000000_fidelity1.md'

beforeEach(async () => {
  root = await makeTempRoot('fidelity')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
  await service.initialize(vault)
  await writeFile(join(vault, NOTE_REL), USER_NOTE, 'utf8')
  // The user wrote this file outside the plugin, so it reaches the index the same
  // way any external edit does: through a sync.
  await service.syncIndex()
})

afterEach(async () => {
  await cleanup(root)
})

async function readNote(): Promise<string> {
  return readFile(join(vault, NOTE_REL), 'utf8')
}

/** Everything the plugin must never touch. */
const PRESERVED_FRAGMENTS = [
  'cssclass: wide-page',
  'review_after: 2027-01-01',
  '## 我的备注',
  '用户自己加的段落，必须原样保留。',
  '第二行也一样。',
  '> 一段引用，带 **加粗** 和 [[内部链接]]。',
  '- 列表项 A',
  '- 列表项 B',
  '<!-- USER-MARKER-9931 -->',
  '## 附录',
  '尾部附录，插件不认识。',
]

describe('unknown frontmatter and user body survive plugin edits', () => {
  it('keeps every user-owned fragment when the plugin changes a field', async () => {
    await service.setPinned('mem_20261017t000000_fidelity1', true)
    const after = await readNote()
    for (const fragment of PRESERVED_FRAGMENTS) {
      expect(after, `lost: ${fragment}`).toContain(fragment)
    }
    expect(after).toMatch(/pinned: true/)
    // Order of the user's own sections is preserved: 我的备注 before 附录.
    expect(after.indexOf('## 我的备注')).toBeLessThan(after.indexOf('## 附录'))
  })

  it('keeps user fragments through archive and restore', async () => {
    // Archiving moves the note to Archive/, so read the live path from the service.
    await service.setStatus('mem_20261017t000000_fidelity1', 'archived', '测试归档')
    const archivedDetail = await service.get('mem_20261017t000000_fidelity1')
    expect(archivedDetail.relativePath.startsWith('Archive/')).toBe(true)
    const archived = await readFile(archivedDetail.absolutePath, 'utf8')
    for (const fragment of PRESERVED_FRAGMENTS) expect(archived).toContain(fragment)
    expect(archived).toMatch(/status: archived/)

    await service.setStatus('mem_20261017t000000_fidelity1', 'active', '测试恢复')
    const restoredDetail = await service.get('mem_20261017t000000_fidelity1')
    expect(restoredDetail.relativePath.startsWith('Knowledge/')).toBe(true)
    const restored = await readFile(restoredDetail.absolutePath, 'utf8')
    for (const fragment of PRESERVED_FRAGMENTS) expect(restored).toContain(fragment)
    expect(restored).toMatch(/status: active/)
  })

  it('keeps user fragments when the summary is rewritten by editing a field only', async () => {
    // A plugin-initiated write must not need the body to change at all.
    await service.save({
      id: 'mem_20261017t000000_fidelity1',
      type: 'knowledge',
      title: '保真测试记忆',
      summary: '这是插件拥有的正文。',
      tags: ['fidelity'],
      confidence: 'high',
      importance: 80,
      reason: '只改重要度',
    })
    const after = await readNote()
    expect(after).toMatch(/importance: 80/)
    for (const fragment of PRESERVED_FRAGMENTS) expect(after).toContain(fragment)
  })

  it('keeps user fragments after a restart and index reconciliation', async () => {
    await service.setPinned('mem_20261017t000000_fidelity1', true)
    const before = await readNote()

    const second = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
    await second.initialize(vault)
    const after = await readNote()
    expect(after).toBe(before)
  })

  it('is idempotent: the same end state renders the same file', async () => {
    const id = 'mem_20261017t000000_fidelity1'
    await service.setPinned(id, true)
    const once = await readNote()
    await service.setPinned(id, false)
    await service.setPinned(id, true)
    const twice = await readNote()
    // Repeated writes that end in the same state must produce the same document,
    // which is what proves the renderer is not slowly reflowing the body. Only the
    // plugin-owned `updated_at` legitimately changes on every write.
    const strip = (text: string): string => text.replace(/^updated_at: .*$/m, '')
    expect(strip(twice)).toBe(strip(once))
    for (const fragment of PRESERVED_FRAGMENTS) expect(twice).toContain(fragment)
  })

  it('preserves unknown keys added after the last write', async () => {
    await service.setPinned('mem_20261017t000000_fidelity1', true)
    // The user appends another custom key by hand...
    const edited = (await readNote()).replace('cssclass: wide-page', 'cssclass: wide-page\nmy_custom_key: keep-me')
    await writeFile(join(vault, NOTE_REL), edited, 'utf8')
    // ...and the plugin edits a field again.
    const fresh = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
    await fresh.initialize(vault)
    await fresh.setStatus('mem_20261017t000000_fidelity1', 'stale', '测试过时')
    const after = await readNote()
    expect(after).toContain('my_custom_key: keep-me')
    expect(after).toContain('<!-- USER-MARKER-9931 -->')
  })

  it('preserves YAML frontmatter comments (source-level editing, round 5)', async () => {
    const withComment = (await readNote()).replace('confidence: high', '# 这是 frontmatter 注释\nconfidence: high')
    await writeFile(join(vault, NOTE_REL), withComment, 'utf8')
    const fresh = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
    await fresh.initialize(vault)
    await fresh.setPinned('mem_20261017t000000_fidelity1', true)
    const after = await readNote()
    // Comments are no longer lost: only the lines of changed fields are rewritten.
    expect(after).toContain('# 这是 frontmatter 注释')
    expect(after).toContain('<!-- USER-MARKER-9931 -->')
    expect(after).toContain('cssclass: wide-page')
  })
})

describe('unsafe input is refused, never silently rewritten', () => {
  it('refuses a raw write with no frontmatter and leaves the file untouched', async () => {
    const before = await readNote()
    await expect(service.writeRaw('mem_20261017t000000_fidelity1', '# 没有 frontmatter', 'whatever')).rejects.toThrow()
    expect(await readNote()).toBe(before)
  })

  it('refuses a raw write whose id does not match, leaving the file untouched', async () => {
    const detail = await service.readRaw('mem_20261017t000000_fidelity1')
    const before = await readNote()
    await expect(
      service.writeRaw('mem_20261017t000000_fidelity1', detail.content.replace('mem_20261017t000000_fidelity1', 'mem_other'), detail.checksum),
    ).rejects.toThrow(/不一致/)
    expect(await readNote()).toBe(before)
  })

  it('refuses a note with unterminated frontmatter instead of guessing', async () => {
    const broken = '---\nid: mem_20261017t000000_fidelity1\ntitle: 坏文件\n\n# 正文\n'
    await writeFile(join(vault, NOTE_REL), broken, 'utf8')
    const fresh = new MemoryService({ configuredVaultPath: vault, discoveryProvider: async () => discoveryFor(vault) })
    const status = await fresh.initialize(vault)
    // The file is quarantined by the rebuild, and the original bytes are untouched.
    expect(status.vault?.index.healthy).toBe(true)
    expect((await readFile(join(vault, NOTE_REL), 'utf8'))).toBe(broken)
    await expect(fresh.get('mem_20261017t000000_fidelity1')).rejects.toThrow()
  })

  it('refuses a raw write after an external edit, so no content is lost to a stale write', async () => {
    const detail = await service.readRaw('mem_20261017t000000_fidelity1')
    await new Promise((resolve) => setTimeout(resolve, 25))
    const externallyEdited = `${detail.content}\n\n用户新增的一段。\n`
    await writeFile(join(vault, NOTE_REL), externallyEdited, 'utf8')
    await expect(service.writeRaw('mem_20261017t000000_fidelity1', detail.content, detail.checksum)).rejects.toMatchObject({
      code: 'write-conflict',
    })
    expect(await readNote()).toContain('用户新增的一段。')
    // The retry the message asks for must work.
    const reloaded = await service.readRaw('mem_20261017t000000_fidelity1')
    await expect(service.writeRaw('mem_20261017t000000_fidelity1', reloaded.content, reloaded.checksum)).resolves.toBeDefined()
    expect(await readNote()).toContain('用户新增的一段。')
  })
})

describe('spliceBody unit contract', () => {
  const memory: Memory = {
    id: 'mem_1',
    type: 'knowledge',
    status: 'active',
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
    title: '新标题',
    tags: ['k'],
    confidence: 'high',
    importance: 50,
    pinned: false,
    sourceSessions: [],
    supersedes: [],
    conflictsWith: [],
    aliases: [],
    evidence: '新依据。',
    schemaVersion: 1,
    summary: '新正文。',
    sections: [],
    related: ['甲'],
  }

  it('replaces owned sections and copies everything else verbatim', () => {
    const out = spliceBody(USER_NOTE.split('---\n').slice(2).join('---\n'), memory)
    expect(out).toContain('# 新标题')
    expect(out).toContain('新正文。')
    expect(out).toContain('新依据。')
    expect(out).toContain('- [[甲]]')
    expect(out).not.toContain('这是插件拥有的正文。')
    expect(out).toContain('## 我的备注')
    expect(out).toContain('<!-- USER-MARKER-9931 -->')
    expect(out).toContain('## 附录')
  })

  it('appends missing owned sections without disturbing existing ones', () => {
    const out = spliceBody('# 标题\n\n## 只属于用户\n\n内容\n', memory)
    expect(out).toContain('## 只属于用户')
    expect(out).toContain('## 核心内容')
    expect(out).toContain('## 来源与依据')
    expect(out).toContain('## 相关记忆')
    expect(out.indexOf('## 只属于用户')).toBeLessThan(out.indexOf('## 核心内容'))
  })
})
