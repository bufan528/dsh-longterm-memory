/**
 * 「连续消息智能合并」契约与宿主桥。
 *
 * 这层测试守的是两条底线：
 * 1. 契约不兼容/扩展缺席时，页面拿到的是 `available: false` + 原因，而不是假状态；
 * 2. 配置只能写进**真实运行中的扩展**，写不进去时必须报错而不是静默丢进 Vault 设置。
 *
 * @module tests/integration/qq-merge-bridge.test.ts
 */

import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'

import { cleanup, makeTempRoot, writeText } from '../helpers.js'
import { MemoryService, validateSettingsPatch } from '../../src/host/core/service.js'
import { dispatch } from '../../src/host/dsh/routes.js'
import { MergeBridgeError, QqbotMergeBridge, normalizeStatus, validateMergePatch } from '../../src/host/qq/merge-bridge.js'
import {
  DEFAULT_QQBOT_MERGE_CONFIG,
  isMergeContractCompatible,
  normalizeMergeConfig,
  normalizeMaxBatchChars,
  normalizeMaxBatchMessages,
  normalizeMergeWindow,
  type QqbotMergeService,
  type QqbotMergeStatus,
} from '../../src/shared/qqbot-merge-contract.js'

let root: string

afterEach(async () => {
  if (root !== undefined) await cleanup(root)
})

function makeStatus(overrides: Partial<QqbotMergeStatus> = {}): QqbotMergeStatus {
  return {
    contract: { name: 'qqbot-merge', version: 1 },
    config: { ...DEFAULT_QQBOT_MERGE_CONFIG, enabled: true, windowMs: 800 },
    applied: { revision: 3, appliedAt: '2026-10-27T10:00:00.000Z', activeBatches: 1, pendingMessages: 2 },
    runtime: {
      steerSupported: true,
      steerMechanism: 'agent.steer() (DSH 0.2.1-rc.3 public API)',
      integration: 'dsh-qqbot 0.5.3 fork + urgentPredicate bypass',
      streamingRevision: true,
      note: 'C2C 流式消息按 revision 全量重写。',
    },
    counters: {
      batchesMerged: 4,
      messagesSteered: 9,
      messagesFollowedUp: 5,
      messagesOverflowed: 1,
      steerFallbacks: 1,
      replyRewrites: 7,
      repliesCompleted: 4,
      batchesAborted: 0,
    },
    lastBatch: {
      at: '2026-10-27T10:00:01.000Z',
      sessionKey: 'c2c:OPENID',
      count: 3,
      chars: 120,
      mode: 'steer',
      ok: true,
    },
    ...overrides,
  }
}

function fakeService(status: QqbotMergeStatus): QqbotMergeService & { written: unknown[] } {
  const written: unknown[] = []
  return {
    contract: status.contract,
    getStatus: () => status,
    getConfig: () => status.config,
    setConfig: async (patch) => {
      written.push(patch)
      status = { ...status, config: { ...status.config, ...patch }, applied: { ...status.applied, revision: status.applied.revision + 1 } }
      return status
    },
    written,
  } as QqbotMergeService & { written: unknown[] }
}

describe('merge contract normalization', () => {
  it('clamps the tuning knobs instead of trusting the wire', () => {
    expect(normalizeMergeWindow(50)).toBe(100)
    expect(normalizeMergeWindow(999999)).toBe(10000)
    expect(normalizeMergeWindow('800')).toBe(800)
    expect(normalizeMaxBatchMessages(0)).toBe(1)
    expect(normalizeMaxBatchMessages(999)).toBe(50)
    expect(normalizeMaxBatchChars(10)).toBe(200)
  })

  it('normalizes a partial config with safe defaults', () => {
    const config = normalizeMergeConfig({ enabled: true, windowMs: 1200, scope: { group: true } })
    expect(config.enabled).toBe(true)
    expect(config.windowMs).toBe(1200)
    expect(config.scope).toEqual({ c2c: true, group: true })
    expect(config.busyPolicy).toBe('steer')
    expect(config.replyMode).toBe('single-message')
  })

  it('rejects mismatched contract versions with an explicit note', () => {
    expect(isMergeContractCompatible({ name: 'qqbot-merge', version: 1 })).toEqual({ compatible: true, note: null })
    expect(isMergeContractCompatible({ name: 'qqbot-merge', version: 2 }).compatible).toBe(false)
    expect(isMergeContractCompatible(undefined).compatible).toBe(false)
    expect(isMergeContractCompatible({ name: 'qqbot-merge', version: 2 }).note).toContain('契约不匹配')
  })

  it('normalizes an extension status and never lets NaN/negatives through', () => {
    const status = normalizeStatus(makeStatus({ counters: { ...makeStatus().counters, batchesMerged: Number.NaN } }))
    expect(status.counters.batchesMerged).toBe(0)
    expect(status.counters.messagesSteered).toBe(9)
    expect(status.lastBatch?.mode).toBe('steer')
    expect(normalizeStatus(makeStatus({ lastBatch: null })).lastBatch).toBeNull()
  })

  it('validates config patches and rejects unknown enums', () => {
    expect(validateMergePatch({ enabled: true, windowMs: 900 })).toEqual({ enabled: true, windowMs: 900 })
    expect(() => validateMergePatch({ busyPolicy: 'nope' as never })).toThrow(MergeBridgeError)
    expect(() => validateMergePatch({ replyMode: 'nope' as never })).toThrow(MergeBridgeError)
    expect(() => validateMergePatch({ scope: { c2c: 'yes' } as never })).toThrow(MergeBridgeError)
    expect(() => validateMergePatch({ windowMs: '800' as never })).toThrow(MergeBridgeError)
  })
})

describe('QqbotMergeBridge', () => {
  it('reports unavailable with a reason and a detected official version when no extension is attached', async () => {
    root = await makeTempRoot('qq-merge-bridge')
    const profileDir = join(root, 'profiles', 'demo')
    await writeText(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { '@tencent-connect/dsh-qqbot': '0.5.3' } }))
    const bridge = new QqbotMergeBridge({ profileDir: () => profileDir })
    const report = await bridge.report()
    expect(report.available).toBe(false)
    if (report.available) throw new Error('expected unavailable')
    expect(report.officialVersion).toBe('0.5.3')
    expect(report.reason).toContain('qqbotMerge')
    expect(bridge.isAttached()).toBe(false)
  })

  it('refuses to write config when no extension can read it', async () => {
    const bridge = new QqbotMergeBridge({ profileDir: () => null })
    await expect(bridge.setConfig({ enabled: true })).rejects.toBeInstanceOf(MergeBridgeError)
  })

  it('reports the live revision and forwards the full merged config once attached', async () => {
    const service = fakeService(makeStatus())
    const bridge = new QqbotMergeBridge({ profileDir: () => null })
    bridge.attach(service)
    expect(bridge.isAttached()).toBe(true)
    const before = await bridge.report()
    expect(before.available).toBe(true)
    if (!before.available) throw new Error('expected available')
    expect(before.status.applied.revision).toBe(3)
    expect(before.compatible).toBe(true)

    const after = await bridge.setConfig({ windowMs: 1500, scope: { c2c: true, group: true } })
    expect(after.available).toBe(true)
    if (!after.available) throw new Error('expected available')
    expect(after.status.config.windowMs).toBe(1500)
    expect(after.status.config.scope.group).toBe(true)
    expect(after.status.applied.revision).toBe(4)
    expect(service.written).toHaveLength(1)
  })

  it('ignores an attached object that does not implement the service surface', () => {
    const bridge = new QqbotMergeBridge({ profileDir: () => null })
    bridge.attach({ contract: { name: 'qqbot-merge', version: 1 } })
    expect(bridge.isAttached()).toBe(false)
    bridge.attach(null)
    expect(bridge.isAttached()).toBe(false)
  })

  it('reports an incompatible contract instead of pretending the config applies', async () => {
    const service = fakeService(makeStatus({ contract: { name: 'qqbot-merge', version: 99 } }))
    const bridge = new QqbotMergeBridge({ profileDir: () => null })
    bridge.attach(service)
    const report = await bridge.report()
    expect(report.available).toBe(true)
    if (!report.available) throw new Error('expected available')
    expect(report.compatible).toBe(false)
    expect(report.compatibilityNote).toContain('99')
  })
})

describe('MemoryService QQ merge RPC', () => {
  it('reports unavailable when the running QQ plugin provides no qqbotMerge service', async () => {
    const service = new MemoryService({})
    const report = await service.qqMergeReport()
    expect(report.available).toBe(false)
    if (report.available) throw new Error('expected unavailable')
    expect(report.reason.length).toBeGreaterThan(20)
  })

  it('rejects setQqMerge with unsupported when nothing can apply it', async () => {
    const service = new MemoryService({})
    await expect(service.setQqMerge({ enabled: true })).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('routes qqMerge through dispatch and translates bridge errors', async () => {
    const service = new MemoryService({})
    const report = (await dispatch(service, 'qqMerge', {})) as { available: boolean }
    expect(report.available).toBe(false)
    await expect(dispatch(service, 'setQqMerge', { config: { enabled: true } })).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('keeps the vault settings validator untouched by merge config', () => {
    expect(() => validateSettingsPatch({})).not.toThrow()
  })
})


