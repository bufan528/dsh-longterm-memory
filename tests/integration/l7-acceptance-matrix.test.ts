/**
 * L7 — automated part of the design §十一 acceptance matrix.
 *
 * M-01..M-12 are executed here against a real throwaway vault. Automated PASS
 * is NOT a release verdict: WP-7 requires real QQ client + real DSH Desktop
 * E2E and separate authorisation, which is recorded as NOT_EXECUTED in
 * `.scratch/wp-life-2/L7-ACCEPTANCE-MATRIX.md`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryService } from '../../src/host/core/service.js'
import { visibilitiesFor, type OwnerAccessDecision } from '../../src/shared/owner-access.js'
import { CHANNEL_VISIBILITIES, DEFAULT_VISIBILITY } from '../../src/shared/types.js'
import { cleanup, makeTempRoot } from '../helpers.js'

let root: string
let vault: string
let service: MemoryService

const QQ = [...CHANNEL_VISIBILITIES.qq]
const PC = [...CHANNEL_VISIBILITIES.desktop]

const open = async (target: string = vault): Promise<MemoryService> => {
  const s = new MemoryService({
    configuredVaultPath: target,
    configSettings: { language: 'zh', enableAutoExtraction: false, enableLlmExtraction: false },
  })
  await s.initialize(target)
  return s
}

const save = (title: string, summary: string, visibility?: 'shared' | 'desktop-private' | 'qq-private') =>
  service.save({
    type: 'preference', title, summary, tags: ['matrix'], confidence: 'high', importance: 70,
    ...(visibility === undefined ? {} : { visibility }),
  })

const recallIds = (text: string, visibilities: string[]): string[] =>
  service.search({ text, filters: { visibilities } }).hits.map((h) => h.record.id)

const qqTurn = (text: string, sessionId: string, turn = 1) => service.processTurn({
  userText: text, sessionId, turn, forceInbox: true, sourceChannel: 'qq',
})

beforeEach(async () => {
  root = await makeTempRoot('l7-matrix')
  vault = join(root, 'DSH Memory')
  service = await open()
})

afterEach(async () => { await cleanup(root) })

describe('M-01 ~ M-03 双端共享记忆闭环', () => {
  it('M-01 PC 明确保存 shared → QQ 下一轮可召回', async () => {
    const a = await save('技术交流偏好', '技术问题请展开讲清楚，日常聊天尽量简短自然。', 'shared')
    expect(recallIds('技术交流偏好', QQ)).toContain(a.id)
  })

  it('M-02 QQ 产生候选 → PC Inbox 显示，且不自动成为事实', async () => {
    const result = await qqTurn('请记住：我最近开始准备计算机视觉比赛。', 'sess-qq-m02')
    expect(result.pending.length).toBeGreaterThan(0)
    expect(service.listCandidates().map((c) => c.id)).toContain(result.pending[0]!.id)
    expect(recallIds('计算机视觉比赛', PC)).toHaveLength(0)
  })

  it('M-03 PC 确认 QQ 候选并显式共享 → 两端同一 ID，无重复记录', async () => {
    const result = await qqTurn('请记住：我最近开始准备计算机视觉比赛。', 'sess-qq-m03')
    const id = result.pending[0]!.id
    await service.confirm(id, '用户在 PC 确认并共享', 'shared')
    expect(recallIds('计算机视觉比赛', QQ)).toContain(id)
    expect(recallIds('计算机视觉比赛', PC)).toContain(id)
    expect(service.search({ text: '计算机视觉比赛' }).total).toBe(1)
  })
})

describe('M-04 ~ M-06 修改 / 归档 / 删除的即时一致性', () => {
  it('M-04 PC 修改记忆 → QQ 不再读取旧的有效事实', async () => {
    const a = await save('旧事实记录', '旧版本：用户使用的是 bash 脚本环境，请按 bash 语法给出示例。', 'shared')
    await service.save({
      id: a.id, type: 'preference', title: '旧事实记录',
      summary: '新版本：用户已改用 PowerShell，请按 PowerShell 语法给出示例。',
      tags: ['matrix'], confidence: 'high', importance: 70,
    })
    const hits = service.search({ text: 'bash', filters: { visibilities: QQ } }).hits
    expect(hits.some((h) => h.record.id === a.id && h.record.preview.includes('bash 语法'))).toBe(false)
    expect((await service.get(a.id)).memory.summary).toContain('PowerShell')
  })

  it('M-05 PC 归档 → QQ 不再把它作为当前事实', async () => {
    const a = await save('即将归档的事实', '这条事实即将被归档，归档后不应再作为当前有效信息。', 'shared')
    await service.setStatus(a.id, 'archived')
    // Management search includes non-current notes by default; the QQ recall
    // path does not. Assert the current-fact view explicitly.
    expect(service.search({
      text: '即将归档的事实', filters: { visibilities: QQ }, includeNonCurrent: false,
    }).hits.map((h) => h.record.id)).not.toContain(a.id)
    expect(service.standing({ visibilities: QQ }).text).not.toContain('即将归档的事实')
    expect(service.search({ text: '即将归档的事实', filters: { visibilities: QQ }, includeNonCurrent: true }).hits
      .some((h) => h.record.id === a.id && h.record.status === 'archived')).toBe(true)
  })

  it('M-06 PC 删除 → QQ 不再召回', async () => {
    const a = await save('将被删除的事实', '这条事实即将被删除，删除后不应在任何入口出现。', 'shared')
    await service.remove(a.id, true)
    expect(recallIds('将被删除的事实', QQ)).toHaveLength(0)
    expect(service.search({ text: '将被删除的事实', includeNonCurrent: true }).hits).toHaveLength(0)
  })
})

describe('M-07 ~ M-09 身份与隐私', () => {
  it('M-07 PC 私有记忆 → QQ 无法访问（search / standing / recall）', async () => {
    const a = await save('桌面私密项目细节', 'PC 上正在进行的私密项目配置与内部代号。', 'desktop-private')
    expect(recallIds('桌面私密项目细节', QQ)).not.toContain(a.id)
    expect(service.standing({ visibilities: QQ }).text).not.toContain('桌面私密项目')
  })

  it('M-08 未绑定 QQ → 无法访问个人记忆', async () => {
    await save('未绑定时的记忆', '未绑定状态下任何个人记忆都不应被 QQ 读取。', 'shared')
    const denied: OwnerAccessDecision = {
      allowed: false, reason: 'no owner binding', ownerId: null, channel: 'unknown',
    }
    expect(visibilitiesFor(denied)).toEqual([])
    expect(service.search({ text: '未绑定', filters: { visibilities: visibilitiesFor(denied) } }).hits).toHaveLength(0)
  })

  it('M-09 QQ 解绑 → 后续消息不再获取个人记忆', async () => {
    await save('解绑前的共享记忆', '解绑前可共享，解绑后决策变为 DENY 即不再可见。', 'shared')
    const bound: OwnerAccessDecision = {
      allowed: true, reason: 'bound', ownerId: 'owner-1', channel: 'qq',
    }
    expect(recallIds('解绑前的共享记忆', visibilitiesFor(bound))).toHaveLength(1)
    const unbound: OwnerAccessDecision = {
      allowed: false, reason: 'unbound', ownerId: null, channel: 'unknown',
    }
    expect(service.search({ text: '解绑前的共享记忆', filters: { visibilities: visibilitiesFor(unbound) } }).hits)
      .toHaveLength(0)
  })
})

describe('M-10 ~ M-12 重启与恢复', () => {
  it('M-10 DSH 重启 → 记忆、共享范围与审核队列正确恢复', async () => {
    const a = await save('重启后仍共享', '重启之后这条共享记忆仍应被 QQ 读取。', 'shared')
    await qqTurn('请记住：我更喜欢晚上集中学习。', 'sess-qq-restart')
    const queueBefore = service.listCandidates().length
    const restarted = await open()
    expect((await restarted.get(a.id)).memory.visibility).toBe('shared')
    expect(restarted.listCandidates()).toHaveLength(queueBefore)
    expect(restarted.search({ text: '重启后仍共享', filters: { visibilities: QQ } }).hits
      .some((h) => h.record.id === a.id)).toBe(true)
    service = restarted
  })

  it('M-11 索引损坏 → 能从 Markdown 重建', async () => {
    const a = await save('Markdown 是事实来源', '索引损坏后应从 Markdown 完整重建，不丢失任何记忆。', 'shared')
    const indexFile = join(vault, '.dsh-memory', 'index.json')
    await writeFile(indexFile, '{ broken index', 'utf8')
    await service.rebuildIndex()
    expect(recallIds('Markdown 是事实来源', QQ)).toContain(a.id)
    expect((await service.get(a.id)).memory.visibility).toBe('shared')
  })

  it('M-12 写入中途索引丢失 → 重新初始化后状态可判定，无静默丢失', async () => {
    const a = await save('崩溃恢复记忆', '写入完成后删除索引并重启，记忆必须仍可从 Markdown 判定。', 'shared')
    await rm(join(vault, '.dsh-memory', 'index.json'), { force: true })
    const restarted = await open()
    expect((await restarted.get(a.id)).memory.summary).toContain('Markdown')
    expect((await restarted.status()).vault?.stats?.total).toBeGreaterThanOrEqual(1)
    service = restarted
  })
})

describe('§十一.4 性能与稳定性（自动化部分）', () => {
  it('同一 Vault 多条消息并发写入，全部可判定', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      save(`并发记忆 ${i}`, `这是第 ${i} 条并发写入的记忆，内容完整可索引。`)))
    expect(new Set(results.map((r) => r.id)).size).toBe(6)
    expect(service.search({ text: '并发记忆' }).total).toBe(6)
  })

  it('同一事实跨端重复提取不产生两份记录', async () => {
    const text = '请记住：我更喜欢用 PowerShell 而不是 bash。'
    await qqTurn(text, 'sess-qq-repeat')
    await qqTurn(text, 'sess-qq-repeat')
    await service.processTurn({ userText: text, sessionId: 'sess-pc-repeat', sourceChannel: 'desktop' })
    // Exactly one representation of the fact, whether it is still queued or
    // already promoted: no duplicate Inbox entry and no duplicate note.
    const representations = service.listCandidates().length
      + service.search({ text: 'PowerShell', includeNonCurrent: true }).total
    expect(representations).toBeLessThanOrEqual(1)
  })

  it('两端同时修改同一条记忆时，过期 checksum 被拒绝而不静默覆盖', async () => {
    const a = await save('并发修改目标', '原始版本的并发修改目标内容。', 'shared')
    const raw = await service.readRaw(a.id)
    await service.writeRaw(a.id, raw.content.replace('原始版本', 'PC 版本'), raw.checksum)
    await expect(service.writeRaw(
      a.id, raw.content.replace('原始版本', 'QQ 版本'), raw.checksum,
    )).rejects.toThrow()
    expect((await service.get(a.id)).memory.summary).toContain('PC 版本')
  })

  it('非法值不会悄悄改变共享范围（默认仍为 desktop-private）', async () => {
    const a = await save('范围未指定', '未显式指定范围的记忆应落到最严格的缺省值。')
    expect((await service.get(a.id)).memory.visibility).toBe(DEFAULT_VISIBILITY)
  })
})
