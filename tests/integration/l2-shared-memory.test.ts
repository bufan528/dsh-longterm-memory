/**
 * L2 — cross-interface shared memory closed loop.
 *
 * Design alignment: WP-2 场景 A/B, §六 (visibility + Inbox review), §九.B
 * (filtering at all five execution points), §十一 M-01/02/03/07/08/10.
 *
 * Everything runs on a throwaway vault; the production vault is never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryService } from '../../src/host/core/service.js'
import { cleanup, makeTempRoot } from '../helpers.js'
import {
  CHANNEL_VISIBILITIES, DEFAULT_VISIBILITY,
  type MemoryVisibility,
} from '../../src/shared/types.js'
import { visibilitiesFor, type OwnerAccessDecision } from '../../src/shared/owner-access.js'

let root: string
let vault: string
let service: MemoryService

const open = async (target: string = vault): Promise<MemoryService> => {
  const s = new MemoryService({
    configuredVaultPath: target,
    configSettings: { language: 'zh', enableAutoExtraction: false, enableLlmExtraction: false },
  })
  await s.initialize(target)
  return s
}

const qqProcess = (text: string, sessionId: string, turn = 1) => service.processTurn({
  userText: text,
  sessionId,
  turn,
  forceInbox: true,
  sourceChannel: 'qq',
})

const ASSERTION = '请记住：我更喜欢用 PowerShell 而不是 bash，因为脚本要兼容 Windows。'

beforeEach(async () => {
  root = await makeTempRoot('l2-shared')
  vault = join(root, 'DSH Memory')
  service = await open()
})

afterEach(async () => { await cleanup(root) })

describe('WP-2 场景 B：QQ 候选进 Inbox 且可持久化恢复', () => {
  it('QQ 来源候选带 qq-private + sourceChannels=["qq"]，且不会自动写成 active 事实', async () => {
    const result = await qqProcess(ASSERTION, 'sess-qq-1')
    expect(result.applied).toEqual([])
    expect(result.pending.length).toBeGreaterThan(0)
    const candidate = result.pending[0]!
    expect(candidate.visibility).toBe('qq-private')
    expect(candidate.sourceChannels).toEqual(['qq'])
    expect(candidate.decision.action).toBe('inbox')
    expect(service.listCandidates().some((c) => c.id === candidate.id)).toBe(true)
    // Not a stated fact yet: no active memory exists.
    expect(service.search({ text: 'PowerShell', includeNonCurrent: false }).hits).toHaveLength(0)
  })

  it('M-02 / M-10：Host 重启后 PC Inbox 仍显示同一条候选，字段不丢失', async () => {
    const result = await qqProcess(ASSERTION, 'sess-qq-restart')
    const id = result.pending[0]!.id
    expect(service.listCandidates()).toHaveLength(1)

    const restarted = await open() // simulate a fresh Host process
    const queue = restarted.listCandidates()
    expect(queue).toHaveLength(1)
    expect(queue[0]!.id).toBe(id)
    expect(queue[0]!.visibility).toBe('qq-private')
    expect(queue[0]!.sourceChannels).toEqual(['qq'])
    service = restarted
  })

  it('队列文件损坏 / 非法 visibility / 重复 id → 保守修复，绝不自动 shared', async () => {
    const queuePath = join(vault, '.dsh-memory', 'candidates.json')
    await mkdir(join(vault, '.dsh-memory'), { recursive: true })
    await writeFile(queuePath, '{ broken', 'utf8')
    expect((await open()).listCandidates()).toHaveLength(0)

    const result = await qqProcess(ASSERTION, 'sess-qq-corrupt')
    const c = result.pending[0]!
    const raw = JSON.parse(await readFile(queuePath, 'utf8')) as {
      candidates: Record<string, unknown>[]
    }
    raw.candidates[0]!['visibility'] = 'shared' // forged widening
    raw.candidates.push({ ...raw.candidates[0]! })
    raw.candidates.push({ id: 'garbage' })
    await writeFile(queuePath, JSON.stringify(raw), 'utf8')

    const reopened = await open()
    expect(reopened.listCandidates()).toHaveLength(1)
    expect(reopened.listCandidates()[0]!.visibility).toBe(DEFAULT_VISIBILITY)
    expect(reopened.listCandidates()[0]!.id).toBe(c.id)
    expect(reopened.listCandidates().some((x) => x.visibility === 'shared')).toBe(false)
    service = reopened
  })

  it('重复 turn 不产生两份候选（幂等）', async () => {
    await qqProcess(ASSERTION, 'sess-qq-dup')
    const again = await qqProcess(ASSERTION, 'sess-qq-dup')
    expect(again.skippedAsDuplicate).toBe(true)
    expect(service.listCandidates()).toHaveLength(1)
  })
})

describe('M-03：审核闭环与共享范围升级', () => {
  it('PC 显式选择 shared 后，QQ 与 PC 读取同一 memory ID，不生成重复记录', async () => {
    const result = await qqProcess(ASSERTION, 'sess-qq-review')
    const candidateId = result.pending[0]!.id
    const confirmed = await service.confirm(candidateId, '用户在 PC 确认并选择共享', 'shared')
    expect(confirmed.id).toBe(candidateId)
    expect(service.listCandidates()).toHaveLength(0)

    const detail = await service.get(candidateId)
    expect(detail.memory.visibility).toBe('shared')
    expect(detail.memory.status).toBe('active')
    expect(detail.memory.sourceChannels).toContain('qq')

    for (const channel of ['desktop', 'qq'] as const) {
      const hits = service.search({
        text: 'PowerShell',
        filters: { visibilities: [...CHANNEL_VISIBILITIES[channel]] },
      }).hits
      expect(hits.some((h) => h.record.id === candidateId)).toBe(true)
    }
    expect(service.search({ text: 'PowerShell' }).total).toBe(1)
  })

  it('确认时不传 visibility → 保持 qq-private，PC 通道读不到', async () => {
    const result = await qqProcess(ASSERTION, 'sess-qq-private')
    const id = result.pending[0]!.id
    await service.confirm(id)
    const detail = await service.get(id)
    expect(detail.memory.visibility).toBe('qq-private')
    const qqHits = service.search({
      text: 'PowerShell', filters: { visibilities: [...CHANNEL_VISIBILITIES.qq] },
    }).hits
    const pcHits = service.search({
      text: 'PowerShell', filters: { visibilities: [...CHANNEL_VISIBILITIES.desktop] },
    }).hits
    expect(qqHits.some((h) => h.record.id === id)).toBe(true)
    expect(pcHits.some((h) => h.record.id === id)).toBe(false)
  })

  it('非法 visibility 被拒绝，且不改动候选', async () => {
    const result = await qqProcess(ASSERTION, 'sess-qq-invalid')
    const id = result.pending[0]!.id
    await expect(service.confirm(id, 'x', 'everything' as MemoryVisibility)).rejects.toThrow('未知共享范围')
    expect(service.listCandidates()).toHaveLength(1)
    expect(service.listCandidates()[0]!.visibility).toBe('qq-private')
  })

  it('拒绝候选后队列持久化，重启不会复活', async () => {
    const result = await qqProcess(ASSERTION, 'sess-qq-reject')
    const id = result.pending[0]!.id
    await service.reject(id)
    expect(service.listCandidates()).toHaveLength(0)
    const restarted = await open()
    expect(restarted.listCandidates()).toHaveLength(0)
    service = restarted
  })
})

describe('五个执行点的跨端过滤（§九.B / M-01 / M-07 / M-08）', () => {
  const saveMemory = (title: string, visibility: MemoryVisibility) => service.save({
    type: 'preference',
    title,
    summary: '这是一条用于验证跨端可见范围的长期偏好记忆，内容足够长以便通过注入质量门槛。',
    tags: ['visibility'],
    confidence: 'high',
    importance: 70,
    visibility,
  })

  it('M-01：PC 明确保存 shared → QQ 下一轮可召回', async () => {
    const saved = await saveMemory('共享偏好', 'shared')
    const qq = service.search({
      text: '共享偏好', filters: { visibilities: [...CHANNEL_VISIBILITIES.qq] },
    }).hits
    expect(qq.some((h) => h.record.id === saved.id)).toBe(true)
  })

  it('M-07：desktop-private 对 QQ 完全不可见（search / standing / recall）', async () => {
    const saved = await saveMemory('桌面私有项目细节', 'desktop-private')
    const qqScope = [...CHANNEL_VISIBILITIES.qq]
    expect(service.search({
      text: '桌面私有', filters: { visibilities: qqScope },
    }).hits.some((h) => h.record.id === saved.id)).toBe(false)
    expect(service.standing({ visibilities: qqScope }).text).not.toContain('桌面私有')
    expect((await service.recallForInjection('桌面私有项目细节', qqScope)).text).not.toContain('桌面私有')
  })

  it('M-08：DENY 决策 → 空范围，任何记忆都不可读（[] 不退化为不过滤）', async () => {
    await saveMemory('绑定前记忆', DEFAULT_VISIBILITY)
    const denied: OwnerAccessDecision = {
      allowed: false, reason: 'no owner binding', ownerId: null, channel: 'unknown',
    }
    const scope = visibilitiesFor(denied)
    expect(scope).toEqual([])
    expect(service.search({
      text: '绑定前记忆', filters: { visibilities: scope },
    }).hits).toHaveLength(0)
    expect(service.standing({ visibilities: scope }).text).not.toContain('绑定前记忆')
  })

  it('自动提取写回也带来源：desktop turn 产生 sourceChannels=["desktop"]', async () => {
    const result = await service.processTurn({
      userText: ASSERTION, sessionId: 'sess-desktop-provenance', sourceChannel: 'desktop',
    })
    expect(result.applied.length).toBe(1)
    const detail = await service.get(result.applied[0]!.id)
    expect(detail.memory.sourceChannels).toEqual(['desktop'])
    expect(detail.memory.visibility).toBe(DEFAULT_VISIBILITY)
  })

  it('来源不可识别时不猜测通道，且 DENY 仍强制 Inbox', async () => {
    const result = await service.processTurn({
      userText: ASSERTION, sessionId: 'sess-unknown', forceInbox: true,
    })
    expect(result.pending[0]!.sourceChannels ?? []).toEqual([])
    expect(result.pending[0]!.visibility).toBe(DEFAULT_VISIBILITY)
    expect(result.applied).toEqual([])
  })
})
