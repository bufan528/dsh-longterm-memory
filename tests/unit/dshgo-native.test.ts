/**
 * DSH Go 原生适配层的契约测试。
 *
 * 覆盖三件事：
 *   1. package.json 里的 dshGo 清单结构与桥接注册 id 一致（否则 App 点了没反应）；
 *   2. 视图构造函数产出的是无损 JSON，且落在 dsh-go 的预算内；
 *   3. toolCard 的三种降级路径（抛错 / 非无损 / 超限）都返回空对象，
 *      绝不拖垮工具调用本身。
 *
 * 这些测试不需要 DSH 宿主、不需要 Flutter，也不需要真机。
 *
 * @module tests/unit/dshgo-native.test
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CARD_TOOLS,
  NATIVE_CAPSULE_SAVE,
  NATIVE_CAPSULE_SEARCH,
  NATIVE_MESSAGE_SAVE,
  NATIVE_PANELS,
  withNativeCard,
} from '../../src/host/dshgo/bridge.js'
import {
  inboxPanelView,
  memoryGetView,
  memorySaveView,
  memorySearchView,
  overviewPanelView,
  remindersPanelView,
  stripData,
  toolCard,
  toolResultView,
  viewLang,
} from '../../src/host/dshgo/views.js'
import { EMPTY_SNAPSHOT } from '../../src/host/dshgo/types.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Record<string, any>

function nodeCount(value: unknown): number {
  if (Array.isArray(value)) return (value as unknown[]).reduce<number>((sum, item) => sum + nodeCount(item), 0)
  if (value !== null && typeof value === 'object') {
    return 1 + Object.values(value as Record<string, unknown>).reduce<number>((sum, item) => sum + nodeCount(item), 0)
  }
  return 0
}

describe('dshGo manifest', () => {
  const manifest = pkg.dsh?.dshGo

  it('declares a v1 manifest with a bilingual title', () => {
    expect(manifest).toBeTruthy()
    expect(manifest.v).toBe(1)
    expect(manifest.title.zh).toBeTruthy()
    expect(manifest.title.en).toBeTruthy()
  })

  it('panel ids match the bridge registrations', () => {
    const ids = (manifest.contributes.panels as { id: string }[]).map((p) => p.id)
    expect(ids.sort()).toEqual([...NATIVE_PANELS].sort())
    expect(ids.length).toBeLessThanOrEqual(4)
  })

  it('capsule and message action ids match the bridge handlers', () => {
    const capsuleIds = (manifest.contributes['composer.actions'] as { id: string }[]).map((c) => c.id)
    expect(capsuleIds).toContain(NATIVE_CAPSULE_SAVE)
    expect(capsuleIds).toContain(NATIVE_CAPSULE_SEARCH)
    const messageIds = (manifest.contributes['message.actions'] as { id: string }[]).map((c) => c.id)
    expect(messageIds).toContain(NATIVE_MESSAGE_SAVE)
  })

  it('strip id matches and points at a declared panel', () => {
    const strip = (manifest.contributes['composer.strip'] as { id: string; panel: string }[])[0] as { id: string; panel: string }
    expect(strip.id).toBe('memory')
    const ids = (manifest.contributes.panels as { id: string }[]).map((p) => p.id)
    expect(ids).toContain(strip.panel)
  })

  it('all ids are unique across surfaces', () => {
    const all = Object.values(manifest.contributes).flat().map((entry: any) => entry.id)
    expect(new Set(all).size).toBe(all.length)
  })

  it('label lengths respect the surface limits', () => {
    for (const c of manifest.contributes['composer.actions']) {
      expect(c.label.zh.length).toBeLessThanOrEqual(10)
      expect(c.label.en.length).toBeLessThanOrEqual(10)
    }
    for (const c of manifest.contributes['message.actions']) {
      expect(c.label.zh.length).toBeLessThanOrEqual(12)
      expect(c.label.en.length).toBeLessThanOrEqual(12)
    }
  })
})

describe('native views', () => {
  const zh = viewLang({ locale: 'zh_CN' })
  const en = viewLang({ locale: 'en-US' })

  it('picks zh/en from the app locale', () => {
    expect(zh).toBe('zh')
    expect(en).toBe('en')
  })

  it('every tool card is lossless JSON under 8 KiB and 40 nodes', () => {
    const samples: Record<string, unknown> = {
      memory_search: { count: 1, results: [{ id: 'm1', title: 'T', type: 'profile', status: 'active', summary: 'S' }] },
      memory_get: { id: 'm1', title: 'T', type: 'profile', status: 'active', content: 'C', recallable: true, evidence: '' },
      memory_save: { id: 'm1', created: true, status: 'active' },
      memory_forget: { id: 'm1', status: 'archived' },
      reminder_list: { reminders: [{ id: 'r1', title: 'R', dueAt: '2026-01-01' }] },
      reminder_create: { id: 'r1', title: 'R' },
      reminder_complete: { id: 'r1' },
      sticker_pick: { id: 's1', label: 'ok' },
      sticker_ingest: { imported: 2, skipped: 1 },
    }
    for (const tool of CARD_TOOLS) {
      const view = toolResultView(tool, { locale: 'en' }, {}, samples[tool])
      expect(view, `missing view for ${tool}`).toBeTruthy()
      const json = JSON.stringify(view)
      expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(8 * 1024)
      expect(nodeCount(view)).toBeLessThanOrEqual(40)
      expect(json).not.toContain('undefined')
    }
  })

  it('panels are lossless JSON under 32 KiB and 120 nodes', () => {
    const s = {
      ...EMPTY_SNAPSHOT,
      ready: true,
      totalMemories: 12,
      recent: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, title: `Memory ${i}`, type: 'profile', status: 'active', updatedAt: '2026-01-01' })),
      inbox: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, title: `Cand ${i}`, type: 'task', confidence: 'low', importance: 50, decision: 'inbox' })),
      reminders: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: `Rem ${i}`, dueAt: null, done: false })),
    }
    for (const view of [overviewPanelView(s, { locale: 'zh' }), inboxPanelView(s, { locale: 'zh' }), remindersPanelView(s, { locale: 'zh' })]) {
      const json = JSON.stringify(view)
      expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(32 * 1024)
      expect(nodeCount(view)).toBeLessThanOrEqual(120)
      expect(json).not.toContain('undefined')
    }
  })

  it('strip text is short and reflects pending count', () => {
    expect(stripData(EMPTY_SNAPSHOT, { locale: 'zh' }).text.length).toBeLessThanOrEqual(24)
    const withPending = { ...EMPTY_SNAPSHOT, totalMemories: 5, pendingCandidates: 2 }
    expect(stripData(withPending, { locale: 'zh' }).text).toContain('+2')
    expect(stripData(withPending, { locale: 'zh' }).tone).toBe('warn')
  })

  it('search card handles an empty result set without a list', () => {
    const view = memorySearchView({ locale: 'en' }, { query: 'x' }, { count: 0, results: [] })
    const json = JSON.stringify(view)
    expect(json).toContain('No match')
    expect(json).not.toContain('"type":"list"')
  })

  it('get/save cards carry the id and honesty note', () => {
    expect(JSON.stringify(memoryGetView({ locale: 'en' }, {}, { id: 'm1', title: 'T', content: 'C', recallable: false, recallNote: 'retired' }))).toContain('retired')
    expect(JSON.stringify(memorySaveView({ locale: 'en' }, {}, { id: 'm1', created: false, status: 'active' }))).toContain('updated')
  })
})

describe('toolCard defensive wrapper', () => {
  it('returns {} when the builder throws', () => {
    expect(toolCard(() => { throw new Error('boom') })({}, {})).toEqual({})
  })

  it('returns {} for an oversized view', () => {
    expect(toolCard(() => ({ type: 'text', text: 'x'.repeat(9000) }))({}, {})).toEqual({})
  })

  it('returns {} for undefined', () => {
    expect(toolCard(() => undefined)({}, {})).toEqual({})
  })

  it('injects a zh card only for card-capable tools, without touching output.schema/render', () => {
    const def = { name: 'memory_search', output: { schema: { type: 'object' }, render: () => [] } } as any
    withNativeCard(def)
    expect(def.output.schema).toEqual({ type: 'object' })
    expect(def.output.render).toBeTypeOf('function')
    const meta = def.output.presentationMeta({}, { count: 0, results: [] })
    expect(meta['dsh-go/view']).toBeTruthy()
    expect(JSON.stringify(meta)).toContain('未命中')

    const plain = { name: 'unknown_tool', output: {} } as any
    withNativeCard(plain)
    expect(plain.output.presentationMeta).toBeUndefined()
  })

  it('wraps a valid view under the dsh-go/view key', () => {
    const result = toolCard(() => ({ type: 'text', text: 'ok' }))({}, {})
    expect((result['dsh-go/view'] as { type: string }).type).toBe('text')
  })
})
