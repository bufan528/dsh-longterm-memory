/**
 * QQ 接入 ↔ 长期记忆联动：服务层集成测试（真实临时仓库，不 mock 文件系统）。
 *
 * 覆盖四件事：
 *
 * 1. 默认配置的回归保证 —— `settings.qqLinkage.mode` 必须是 `off`，即升级本身
 *    不会改变任何既有用户的记忆注入结果；
 * 2. 配置持久化 —— `setQqLinkage` 写入 Vault 的 `.dsh-memory/config.json`，
 *    重建服务后读回一致；
 * 3. 边界校验与报告 —— 非法输入抛 `ServiceError(invalid-request)` 且原配置不变，
 *    `qqLinkageReport()` 的字段齐全、计数随执行点增加；
 * 4. 写回拦截 —— `processTurn({ forceInbox: true })` 只产出收件箱候选，不产生
 *    active 记忆；同一输入不经拦截时照旧直接落盘。
 *
 * RPC 路由也用真实的 `dispatch` 走一遍，确保页面能拿到同一份报告。
 *
 * @module tests/integration/qq-linkage-service.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService, ServiceError } from '../../src/host/core/service.js'
import { dispatch } from '../../src/host/dsh/routes.js'
import { DEFAULT_QQ_LINKAGE, type QqLinkageConfig, type SessionMarkers } from '../../src/shared/qq-linkage.js'
import { DEFAULT_SETTINGS, ERROR_CODES } from '../../src/shared/protocol.js'

let root: string
let vault: string
let service: MemoryService
let configPath: string

/** 一条能稳定触发规则提取、且置信度足够自动落盘的用户消息。 */
const ASSERTED_MESSAGE = '请记住：我更喜欢用 PowerShell 而不是 bash。'

/** 一份完整的标记集合（运行时允许缺字段，类型上要求三个数组齐全）。 */
function markers(overrides: Partial<SessionMarkers> = {}): SessionMarkers {
  return { origins: [], presets: [], cwds: [], ...overrides }
}

beforeEach(async () => {
  root = await makeTempRoot('qq-linkage-service')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault })
  await service.initialize(vault)
  configPath = join(vault, '.dsh-memory', 'config.json')
})

afterEach(async () => {
  await cleanup(root)
})

/** 直接读盘上的 Vault 配置，绕过内存缓存。 */
async function readConfigFile(): Promise<{ settings?: Record<string, unknown> }> {
  return JSON.parse(await readFile(configPath, 'utf8')) as { settings?: Record<string, unknown> }
}

describe('默认配置（回归）', () => {
  it('默认 settings.qqLinkage 保持 off，行为与未接入 QQ 时一致', async () => {
    const settings = service.getSettings()
    expect(settings.qqLinkage).toEqual(DEFAULT_QQ_LINKAGE)
    expect(settings.qqLinkage.mode).toBe('off')
    expect(settings.qqLinkage.writeMode).toBe('inbox-only')
    expect(settings.qqLinkage.allowTools).toBe(false)

    const report = service.qqLinkageReport()
    expect(report.config).toEqual(DEFAULT_QQ_LINKAGE)
    expect(report.runtime.enforcing).toBe(false)
    expect(report.runtime.qqIdentifiable).toBe(false)
  })

  it('off 模式下 QQ 形状的会话仍可读取，且不产生任何拦截计数', () => {
    const verdict = service.linkage.read({ session: { id: 'qq-shaped', header: { origin: 'qq' } } })
    expect(verdict.decision.allowed).toBe(true)
    expect(verdict.provenance.channel).toBe('unidentified')
    const counters = service.qqLinkageReport().counters
    expect(counters).toEqual({ standingBlocked: 0, recallBlocked: 0, writesForcedInbox: 0, toolsBlocked: 0 })
  })

  it('DEFAULT_SETTINGS 里 qqLinkage 指向同一份默认配置', () => {
    expect(DEFAULT_SETTINGS.qqLinkage).toEqual(DEFAULT_QQ_LINKAGE)
  })
})

describe('setQqLinkage 持久化', () => {
  it('写入 .dsh-memory/config.json，重建服务后配置一致', async () => {
    const saved = await service.setQqLinkage({
      mode: 'deny-qq',
      writeMode: 'inbox-only',
      allowTools: false,
      qqMarkers: markers({ origins: ['qq'], presets: ['qqbot-preset'], cwds: ['D:\\QQ'] }),
      trustedMarkers: markers({ origins: ['desktop'] }),
    })
    expect(saved.config.mode).toBe('deny-qq')

    const onDisk = await readConfigFile()
    const stored = onDisk.settings?.['qqLinkage'] as QqLinkageConfig
    expect(stored).toBeDefined()
    expect(stored.mode).toBe('deny-qq')
    expect(stored.writeMode).toBe('inbox-only')
    expect(stored.allowTools).toBe(false)
    expect(stored.qqMarkers.origins).toEqual(['qq'])
    expect(stored.qqMarkers.presets).toEqual(['qqbot-preset'])
    expect(stored.qqMarkers.cwds).toEqual(['D:\\QQ'])
    expect(stored.trustedMarkers.origins).toEqual(['desktop'])
    expect(stored.trustedMarkers.presets).toEqual([])

    // 重建服务并重新加载持久化设置，必须得到同一份配置。
    const rebuilt = new MemoryService({ configuredVaultPath: vault })
    await rebuilt.initialize(vault)
    expect(rebuilt.getSettings().qqLinkage).toEqual(saved.config)
    expect(rebuilt.qqLinkageReport().config).toEqual(saved.config)
  })

  it('局部更新只改传入字段，不抹掉其它已保存字段', async () => {
    await service.setQqLinkage({
      mode: 'deny-qq',
      qqMarkers: markers({ origins: ['qq'] }),
      trustedMarkers: markers({ origins: ['desktop'] }),
    })
    const after = await service.setQqLinkage({ writeMode: 'direct' })
    expect(after.config.mode).toBe('deny-qq')
    expect(after.config.writeMode).toBe('direct')
    expect(after.config.qqMarkers.origins).toEqual(['qq'])
    expect(after.config.trustedMarkers.origins).toEqual(['desktop'])
  })

  it('保留标记的大小写但去重（大小写不敏感）', async () => {
    const report = await service.setQqLinkage({ qqMarkers: markers({ origins: [' QQ ', 'qq', 'Qq'] }) })
    expect(report.config.qqMarkers.origins).toEqual(['QQ'])
  })

  it('从配置层（configSettings）继承的标记会被用户选择逐字段合并保留', async () => {
    // 用一块全新的仓库，避免上一个服务初始化时把默认值写进用户设置。
    const configuredVault = join(root, 'Configured Vault')
    const configured = new MemoryService({
      configuredVaultPath: configuredVault,
      configSettings: { qqLinkage: { mode: 'deny-qq', qqMarkers: { origins: ['qq'] } } as never },
    })
    await configured.initialize(configuredVault)
    expect(configured.getSettings().qqLinkage.mode).toBe('deny-qq')
    expect(configured.getSettings().qqLinkage.qqMarkers.origins).toEqual(['qq'])

    const after = await configured.setQqLinkage({ allowTools: true })
    expect(after.config.mode).toBe('deny-qq')
    expect(after.config.qqMarkers.origins).toEqual(['qq'])
    expect(after.config.allowTools).toBe(true)
  })
})

describe('边界校验', () => {
  /** 断言一次非法更新被拒绝，并且内存与磁盘上的配置都没有变化。 */
  async function expectInvalid(patch: unknown): Promise<void> {
    const before = service.getSettings().qqLinkage
    const beforeFile = await readFile(configPath, 'utf8')
    await expect(service.setQqLinkage(patch as never)).rejects.toMatchObject({ code: ERROR_CODES.invalid })
    expect(service.getSettings().qqLinkage).toEqual(before)
    expect(await readFile(configPath, 'utf8')).toBe(beforeFile)
  }

  it('非法 mode / writeMode 被拒绝', async () => {
    await expectInvalid({ mode: 'block-everything' })
    await expectInvalid({ writeMode: 'sometimes' })
  })

  it('allowTools 不是布尔值被拒绝', async () => {
    await expectInvalid({ allowTools: 'yes' })
    await expectInvalid({ allowTools: 1 })
  })

  it('标记不是对象或字段不是字符串数组时被拒绝', async () => {
    await expectInvalid({ qqMarkers: 'qq' })
    await expectInvalid({ qqMarkers: [] })
    await expectInvalid({ qqMarkers: null })
    await expectInvalid({ qqMarkers: { origins: 'qq' } })
    await expectInvalid({ qqMarkers: { origins: ['qq', 7] } })
    await expectInvalid({ trustedMarkers: { cwds: [null] } })
  })

  it('顶层不是对象时被拒绝', async () => {
    await expectInvalid(null)
    await expectInvalid('deny-qq')
    await expectInvalid([])
  })

  it('setSettings({ qqLinkage }) 走同一套边界校验', async () => {
    await expect(service.setSettings({ qqLinkage: { mode: 'nope' } as never })).rejects.toMatchObject({
      code: ERROR_CODES.invalid,
    })
  })

  it('合法 patch 不因校验过严被误拒', async () => {
    const report = await service.setQqLinkage({ mode: 'allowlist', writeMode: 'direct', allowTools: true })
    expect(report.config.mode).toBe('allowlist')
    expect(report.config.writeMode).toBe('direct')
    expect(report.config.allowTools).toBe(true)
  })
})

describe('qqLinkageReport', () => {
  it('包含 config / runtime / enforcement / host / vaultPath / counters / sessions', () => {
    const report = service.qqLinkageReport()
    expect(report.config).toBeDefined()
    expect(report.config.mode).toBe('off')
    expect(report.runtime.mode).toBe('off')
    expect(Array.isArray(report.runtime.notes)).toBe(true)
    expect(report.enforcement).toEqual({
      standing: false,
      perStepRecall: false,
      extraction: false,
      tools: false,
      registeredTools: [],
      notes: {},
    })
    expect(report.host.platform.length).toBeGreaterThan(0)
    expect(report.host.nodeVersion.length).toBeGreaterThan(0)
    expect(report.host).toHaveProperty('profile')
    expect(report.host).toHaveProperty('profileDir')
    expect(report.host).toHaveProperty('dshHome')
    expect(report.vaultPath).toBe(resolve(vault))
    expect(report.counters).toEqual({ standingBlocked: 0, recallBlocked: 0, writesForcedInbox: 0, toolsBlocked: 0 })
    expect(report.sessions).toEqual([])
  })

  it('报告反映刚保存的策略（页面与后端读的是同一份配置）', async () => {
    await service.setQqLinkage({ mode: 'deny-qq', qqMarkers: markers({ origins: ['qq'] }) })
    const report = service.qqLinkageReport()
    expect(report.config.mode).toBe('deny-qq')
    expect(report.runtime.enforcing).toBe(true)
    expect(report.runtime.qqIdentifiable).toBe(true)
    expect(report.runtime.notes.join('\n')).toContain('尚未观测到宿主')
  })
})

describe('执行点计数与最近样本', () => {
  beforeEach(async () => {
    await service.setQqLinkage({
      mode: 'deny-qq',
      writeMode: 'inbox-only',
      allowTools: false,
      qqMarkers: markers({ origins: ['qq'] }),
    })
  })

  it('每步检索：QQ 会话被拦截后 recallBlocked 增加，非 QQ 会话不增加', () => {
    const qqVerdict = service.linkage.read({ session: { id: 'qq-recall', header: { origin: 'qq' } } })
    expect(qqVerdict.decision.allowed).toBe(false)
    expect(service.qqLinkageReport().counters.recallBlocked).toBe(1)

    const desktopVerdict = service.linkage.read({ session: { id: 'desk-recall', header: { origin: 'desktop' } } })
    expect(desktopVerdict.decision.allowed).toBe(true)
    expect(service.qqLinkageReport().counters.recallBlocked).toBe(1)
  })

  it('常驻注入、写回、工具三个执行点各自计数', () => {
    expect(service.linkage.standing({ session: { id: 'qq-standing', header: { origin: 'qq' } } }).decision.allowed).toBe(false)
    expect(service.linkage.write({ session: { id: 'qq-write', header: { origin: 'qq' } } }).decision.allowed).toBe(false)
    expect(service.linkage.tools({ session: { id: 'qq-tools', header: { origin: 'qq' } } }).decision.allowed).toBe(false)

    const counters = service.qqLinkageReport().counters
    expect(counters.standingBlocked).toBe(1)
    expect(counters.writesForcedInbox).toBe(1)
    expect(counters.toolsBlocked).toBe(1)
    expect(counters.recallBlocked).toBe(0)
  })

  it('allowTools=true 时工具执行点放行且不计数', async () => {
    await service.setQqLinkage({ allowTools: true })
    expect(service.linkage.tools({ session: { id: 'qq-tools-ok', header: { origin: 'qq' } } }).decision.allowed).toBe(true)
    expect(service.qqLinkageReport().counters.toolsBlocked).toBe(0)
  })

  it('最近判定样本记录会话 ID、通道与命中的标记', () => {
    service.linkage.read({ session: { id: 'qq-sample', header: { origin: 'qq' } } })
    const samples = service.qqLinkageReport().sessions
    expect(samples).toHaveLength(1)
    expect(samples[0]?.sessionId).toBe('qq-sample')
    expect(samples[0]?.channel).toBe('qq')
    expect(samples[0]?.matchedBy).toBe('origin')
    expect(samples[0]?.marker).toBe('qq')
    expect(samples[0]?.reason).toContain('每步检索')
    expect(typeof samples[0]?.lastSeenAt).toBe('string')
  })

  it('没有会话 ID 的判定不写入样本（避免伪造证据）', () => {
    service.linkage.read({ header: { origin: 'qq' } })
    expect(service.qqLinkageReport().sessions).toEqual([])
  })
})

describe('processTurn 的强制收件箱（写回执行点）', () => {
  it('forceInbox 缺省时，同一输入会直接落盘为 active 记忆', async () => {
    const result = await service.processTurn({
      userText: ASSERTED_MESSAGE,
      assistantText: '好的，我记下了。',
      sessionId: 'desktop-session',
      turn: 1,
    })
    expect(result.applied.length).toBeGreaterThan(0)
    expect(result.pending).toEqual([])
    expect(service.search({ limit: 50 }).total).toBe(1)
  })

  it('forceInbox=true 时 applied 为空、pending 非空，索引不新增 active 记忆', async () => {
    const result = await service.processTurn({
      userText: ASSERTED_MESSAGE,
      assistantText: '好的，我记下了。',
      sessionId: 'qq-session',
      turn: 1,
      forceInbox: true,
    })
    expect(result.applied).toEqual([])
    expect(result.pending.length).toBeGreaterThan(0)
    expect(result.pending[0]?.decision.action).toBe('inbox')
    const firstDecision = result.pending[0]?.decision
    if (firstDecision?.action === 'inbox') expect(firstDecision.rationale).toContain('收件箱')
    expect(service.listCandidates().length).toBeGreaterThan(0)
    // 索引里没有任何 active 记忆：QQ 会话的候选仍进入既有的人工确认流程。
    expect(service.search({ limit: 50 }).total).toBe(0)
  })

  it('同一输入：先强制收件箱，人工拒绝后不拦截则直接落盘（对照证明差异来自 forceInbox）', async () => {
    const forced = await service.processTurn({
      userText: ASSERTED_MESSAGE,
      assistantText: '好的，我记下了。',
      sessionId: 'contrast-session',
      turn: 1,
      forceInbox: true,
    })
    expect(forced.applied).toEqual([])
    expect(forced.pending.length).toBeGreaterThan(0)
    expect(service.search({ limit: 50 }).total).toBe(0)

    // 拒绝收件箱里的候选，回到「同一输入、未设置 forceInbox」的对照。
    const pendingId = forced.pending[0]?.id ?? ''
    await service.reject(pendingId)
    expect(service.listCandidates()).toEqual([])

    const direct = await service.processTurn({
      userText: ASSERTED_MESSAGE,
      assistantText: '好的，我记下了。',
      sessionId: 'contrast-session',
      turn: 2,
    })
    expect(direct.applied.length).toBeGreaterThan(0)
    expect(service.search({ limit: 50 }).total).toBe(1)
  })
})

describe('RPC 路由', () => {
  it('dispatch qqLinkage 返回与 service 相同的报告', async () => {
    const viaRoute = (await dispatch(service, 'qqLinkage', {})) as Record<string, unknown>
    const direct = service.qqLinkageReport() as unknown as Record<string, unknown>
    expect(viaRoute).toEqual(direct)
    expect((viaRoute['config'] as { mode: string }).mode).toBe('off')
  })

  it('dispatch setQqLinkage 生效并持久化', async () => {
    const result = (await dispatch(service, 'setQqLinkage', { config: { mode: 'deny-qq' } })) as {
      config: QqLinkageConfig
    }
    expect(result.config.mode).toBe('deny-qq')
    expect(service.getSettings().qqLinkage.mode).toBe('deny-qq')
    const onDisk = await readConfigFile()
    expect((onDisk.settings?.['qqLinkage'] as QqLinkageConfig).mode).toBe('deny-qq')
  })

  it('dispatch setQqLinkage 的非法配置返回 invalid-request', async () => {
    await expect(dispatch(service, 'setQqLinkage', { config: { mode: 'nope' } })).rejects.toMatchObject({
      code: ERROR_CODES.invalid,
    })
    expect(service.getSettings().qqLinkage.mode).toBe('off')
  })

  it('路由透传 ServiceError，便于页面展示失败原因', async () => {
    await expect(dispatch(service, 'setQqLinkage', { config: { allowTools: 'yes' } })).rejects.toBeInstanceOf(ServiceError)
  })
})
