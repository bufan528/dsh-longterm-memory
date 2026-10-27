/**
 * 「QQ 接入」页的客户端纯函数：插件清单判定 + 只读探测结论的交叉修正。
 *
 * 这层测试挡住的是一类诚实性回归：把「404 = 未安装」当成唯一结论、或在插件
 * 清单显示「已安装」时仍然宣称「未安装」。
 *
 * @module tests/unit/qq-channel.test.ts
 */

import { describe, expect, it } from 'vitest'

import {
  classifyOfficialPresence,
  findOfficialPluginRow,
  normalizeInventoryRow,
  type OfficialPresence,
  type PluginInventoryRow,
} from '../../src/client/host-inventory.js'
import { refineOutcome, type QqProbeOutcome } from '../../src/client/qq-channel.js'

function row(overrides: Partial<PluginInventoryRow> = {}): PluginInventoryRow {
  return { moduleName: '@tencent-connect/dsh-qqbot', entryId: 'im-qqbot', enabled: true, phase: 'active', ...overrides }
}

function notLoaded(evidenceParams: Record<string, string | number> = { route: '/qqbot/im-qqbot/bind' }): QqProbeOutcome {
  return {
    kind: 'not-loaded',
    route: '/qqbot/im-qqbot/bind',
    phase: null,
    appId: null,
    httpStatus: 404,
    evidenceKey: 'qq.probe.evidence.notLoaded',
    evidenceParams,
    at: '2026-10-27T00:00:00.000Z',
  }
}

function presence(overrides: Partial<OfficialPresence> = {}): OfficialPresence {
  return { available: true, state: 'absent', row: null, note: '宿主插件清单中没有该插件。', ...overrides }
}

describe('plugin inventory bridge', () => {
  it('normalizes the known host entry shapes and ignores unknown keys', () => {
    expect(normalizeInventoryRow({ moduleName: '@tencent-connect/dsh-qqbot', enabled: true, fiberPhase: 'active' })).toEqual({
      moduleName: '@tencent-connect/dsh-qqbot',
      entryId: null,
      enabled: true,
      phase: 'active',
    })
    expect(normalizeInventoryRow({ moduleSpecifier: 'dsh-x', id: 'im-qqbot', phase: 'failed' })).toEqual({
      moduleName: 'dsh-x',
      entryId: 'im-qqbot',
      enabled: null,
      phase: 'failed',
    })
    // 读不到模块名也读不到 entry id 时，这一行没有信息量，直接丢弃。
    expect(normalizeInventoryRow({ enabled: true })).toBeNull()
    expect(normalizeInventoryRow(null)).toBeNull()
    expect(normalizeInventoryRow([])).toBeNull()
  })

  it('finds the official plugin by package name, entry id, then substring', () => {
    expect(findOfficialPluginRow([row()])?.entryId).toBe('im-qqbot')
    expect(findOfficialPluginRow([row({ moduleName: 'another-plugin', entryId: 'im-qqbot' })])).not.toBeNull()
    expect(findOfficialPluginRow([row({ moduleName: 'community/dsh-qqbot-fork', entryId: null })])).not.toBeNull()
    expect(findOfficialPluginRow([row({ moduleName: 'unrelated', entryId: 'other' })])).toBeNull()
  })

  it('classifies absent / disabled / installed from the inventory only', () => {
    expect(classifyOfficialPresence([])).toMatchObject({ state: 'absent', row: null })
    expect(classifyOfficialPresence([row({ enabled: false })])).toMatchObject({ state: 'disabled' })
    expect(classifyOfficialPresence([row()])).toMatchObject({ state: 'installed' })
  })
})

describe('refineOutcome: 404 vs plugin inventory', () => {
  it('keeps "not loaded" and cites the inventory when the plugin is truly absent', () => {
    const refined = refineOutcome(notLoaded(), presence({ state: 'absent' }))
    expect(refined.kind).toBe('not-loaded')
    expect(refined.evidenceKey).toBe('qq.probe.evidence.notInstalledConfirmed')
    expect(refined.evidenceParams['inventory']).toContain('插件清单')
  })

  it('downgrades to "unconfirmed" when the plugin is installed but the route is missing', () => {
    for (const state of ['installed', 'disabled', 'unknown'] as const) {
      const refined = refineOutcome(notLoaded(), presence({ state, row: row({ phase: 'failed' }) }))
      expect(refined.kind).toBe('unknown')
      expect(refined.evidenceKey).toBe('qq.probe.evidence.installedButUnreadable')
      expect(refined.evidenceParams['state']).toBe(state)
      expect(refined.evidenceParams['phase']).toBe('failed')
    }
  })

  it('leaves the outcome untouched when the inventory is unavailable', () => {
    const original = notLoaded()
    expect(refineOutcome(original, presence({ available: false }))).toBe(original)
  })

  it('never rewrites a real 200 outcome', () => {
    const bound: QqProbeOutcome = {
      ...notLoaded({ route: '/qqbot/im-qqbot/bind' }),
      kind: 'bound',
      phase: 'bound',
      appId: '123456',
      httpStatus: 200,
      evidenceKey: 'qq.probe.evidence.bound',
    }
    expect(refineOutcome(bound, presence({ state: 'absent' }))).toBe(bound)
  })
})
