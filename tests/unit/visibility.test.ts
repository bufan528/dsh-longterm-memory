/**
 * 跨端可见范围（visibility）契约测试。
 *
 * 这一层是 PC 与 QQ 共享记忆的**唯一**安全边界，因此测试分三类：
 * 1. 语义：通道与可见范围的对应关系必须对称，不能有一侧意外放宽；
 * 2. 过滤：`QueryFilters.visibilities` 的三种状态（undefined / 空数组 / 具体值）
 *    必须可区分，空数组绝不能退化成「不过滤」；
 * 3. 持久化：缺字段的旧记忆必须落到保守缺省，而不是 shared。
 *
 * @module tests/unit/visibility.test
 */

import { describe, expect, it } from 'vitest'
import {
  CHANNEL_VISIBILITIES,
  DEFAULT_VISIBILITY,
  MEMORY_VISIBILITIES,
  isMemoryChannel,
  isMemoryVisibility,
} from '../../src/shared/types.js'
import {
  deriveIndex,
  emptyIndex,
  fieldTokens,
  queryIndex,
  termWeights,
  type IndexRecord,
  type MemoryIndex,
} from '../../src/shared/search.js'
import {
  classifySessionProvenance,
  decideByProvenance,
  visibilitiesFor,
  type OwnerAccessDecision,
} from '../../src/shared/owner-access.js'
import { metaToFrontmatter, frontmatterToMetaRaw } from '../../src/shared/markdown.js'
import { normalizeMemory } from '../../src/shared/validate.js'
import { retrieveForTask, standingFacts } from '../../src/host/core/retrieval.js'

function record(overrides: Partial<IndexRecord> & Pick<IndexRecord, 'id'>): IndexRecord {
  const title = overrides.title ?? overrides.id
  const preview = overrides.preview ?? '正文'
  // 文本召回依赖 postings，因此词项必须从标题与正文真实生成；
  // 留空会让 queryIndex 的文本分支匹配不到任何东西。
  const terms = termWeights(
    fieldTokens({ title, aliases: [], tags: [], summary: preview, body: '' }),
  )
  return {
    // `id` 由 `...overrides` 带入（类型上必填），此处重复声明会被覆盖
    path: `Knowledge/${overrides.id}.md`,
    type: 'knowledge',
    status: 'active',
    title,
    tags: [],
    aliases: [],
    confidence: 'high',
    importance: 50,
    pinned: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    preview,
    links: [],
    size: 1,
    mtimeMs: 1,
    checksum: 'x',
    ...overrides,
    // 保证 overrides 没有覆盖时仍然带真实词项
    terms: overrides.terms ?? terms,
  }
}

function indexOf(...records: IndexRecord[]): MemoryIndex {
  const index = emptyIndex('/vault')
  for (const entry of records) index.records.set(entry.id, entry)
  deriveIndex(index)
  return index
}

describe('可见范围语义', () => {
  it('通道与可见范围的对应关系是对称的：只有 shared 两边都能读', () => {
    expect([...CHANNEL_VISIBILITIES.desktop]).toEqual(['shared', 'desktop-private'])
    expect([...CHANNEL_VISIBILITIES.qq]).toEqual(['shared', 'qq-private'])

    const overlap = CHANNEL_VISIBILITIES.desktop.filter((value) => CHANNEL_VISIBILITIES.qq.includes(value))
    expect(overlap).toEqual(['shared'])
  })

  it('缺省可见范围必须是最保守值，不能是 shared', () => {
    expect(DEFAULT_VISIBILITY).toBe('desktop-private')
    expect(DEFAULT_VISIBILITY).not.toBe('shared')
    // 而且必须是 desktop 可读、QQ 不可读
    expect(CHANNEL_VISIBILITIES.desktop).toContain(DEFAULT_VISIBILITY)
    expect(CHANNEL_VISIBILITIES.qq).not.toContain(DEFAULT_VISIBILITY)
  })

  it('每个可见范围都至少被一个通道读取，不存在无人可见的死值', () => {
    for (const value of MEMORY_VISIBILITIES) {
      const readable = Object.values(CHANNEL_VISIBILITIES).some((scopes) => scopes.includes(value))
      expect(readable, `${value} 不可被任何通道读取`).toBe(true)
    }
  })

  it('枚举守卫只接受已知值', () => {
    expect(isMemoryVisibility('shared')).toBe(true)
    expect(isMemoryVisibility('qq-private')).toBe(true)
    expect(isMemoryVisibility('public')).toBe(false)
    expect(isMemoryVisibility(undefined)).toBe(false)
    expect(isMemoryChannel('desktop')).toBe(true)
    expect(isMemoryChannel('mobile')).toBe(false)
  })
})

describe('门禁决策到可见范围的桥接', () => {
  it('拒绝时返回空数组，而不是 undefined', () => {
    const denied: OwnerAccessDecision = { allowed: false, reason: 'x', ownerId: null, channel: 'unknown' }
    const scopes = visibilitiesFor(denied)
    expect(scopes).toEqual([])
    // 关键：空数组必须与 undefined 语义不同，空数组 = 一条都读不到
    expect(scopes).not.toBeUndefined()
  })

  it('桌面放行只得到桌面可读范围', () => {
    const granted: OwnerAccessDecision = { allowed: true, reason: 'ok', ownerId: null, channel: 'desktop' }
    expect(visibilitiesFor(granted)).toEqual(['shared', 'desktop-private'])
    expect(visibilitiesFor(granted)).not.toContain('qq-private')
  })

  it('QQ 放行只得到 QQ 可读范围', () => {
    const granted: OwnerAccessDecision = { allowed: true, reason: 'ok', ownerId: 'o1', channel: 'qq' }
    expect(visibilitiesFor(granted)).toEqual(['shared', 'qq-private'])
    expect(visibilitiesFor(granted)).not.toContain('desktop-private')
  })

  it('不可信来源即使不抛错也拿不到任何范围', () => {
    const provenance = classifySessionProvenance({
      serviceAvailable: false,
      source: null,
      knownQqSession: false,
    })
    expect(visibilitiesFor(decideByProvenance(provenance))).toEqual([])
  })

  it('已绑定 QQ 私聊放行，且渠道标记为 qq', () => {
    const decision = decideByProvenance({
      kind: 'qq',
      source: {
        platform: 'qq',
        conversationType: 'c2c',
        isPrivate: true,
        ownerId: 'owner-1',
        identified: true,
      },
    })
    expect(decision.allowed).toBe(true)
    expect(decision.channel).toBe('qq')
    expect(visibilitiesFor(decision)).toEqual(['shared', 'qq-private'])
  })
})

describe('检索过滤', () => {
  const privateDesktop = record({ id: 'mem_desktop', visibility: 'desktop-private' })
  const shared = record({ id: 'mem_shared', visibility: 'shared' })
  const privateQq = record({ id: 'mem_qq', visibility: 'qq-private' })
  const legacy = record({ id: 'mem_legacy' }) // 无 visibility，模拟升级前的旧索引

  it('undefined 表示不限制（浏览仓库）', () => {
    const hits = queryIndex(indexOf(privateDesktop, shared, privateQq, legacy), {
      filters: { visibilities: undefined },
    })
    expect(hits.map((hit) => hit.record.id).sort()).toEqual(['mem_desktop', 'mem_legacy', 'mem_qq', 'mem_shared'])
  })

  it('空数组表示一条都读不到（fail-closed），不等于不过滤', () => {
    const hits = queryIndex(indexOf(privateDesktop, shared, privateQq, legacy), {
      filters: { visibilities: [] },
    })
    expect(hits).toHaveLength(0)
  })

  it('QQ 范围读不到 desktop-private', () => {
    const hits = queryIndex(indexOf(privateDesktop, shared, privateQq, legacy), {
      filters: { visibilities: [...CHANNEL_VISIBILITIES.qq] },
    })
    expect(hits.map((hit) => hit.record.id).sort()).toEqual(['mem_qq', 'mem_shared'])
  })

  it('桌面范围读不到 qq-private', () => {
    const hits = queryIndex(indexOf(privateDesktop, shared, privateQq, legacy), {
      filters: { visibilities: [...CHANNEL_VISIBILITIES.desktop] },
    })
    // `mem_legacy` 无字段 → 缺省 desktop-private → 桌面可读、QQ 不可读。
    // 这正是升级后「旧记忆不会自动共享，但用户在 PC 上仍看得到」的预期。
    expect(hits.map((hit) => hit.record.id).sort()).toEqual(['mem_desktop', 'mem_legacy', 'mem_shared'])
  })

  it('缺少可见范围的旧记录按保守缺省处理，QQ 读不到', () => {
    const qqHits = queryIndex(indexOf(legacy), { filters: { visibilities: [...CHANNEL_VISIBILITIES.qq] } })
    expect(qqHits).toHaveLength(0)

    const desktopHits = queryIndex(indexOf(legacy), {
      filters: { visibilities: [...CHANNEL_VISIBILITIES.desktop] },
    })
    expect(desktopHits.map((hit) => hit.record.id)).toEqual(['mem_legacy'])
  })

  it('可见范围与状态过滤是叠加关系，不是二选一', () => {
    const archivedShared = record({ id: 'mem_archived_shared', visibility: 'shared', status: 'archived' })
    const hits = queryIndex(indexOf(shared, archivedShared), {
      filters: { visibilities: [...CHANNEL_VISIBILITIES.qq], statuses: ['active'] },
    })
    expect(hits.map((hit) => hit.record.id)).toEqual(['mem_shared'])
  })
})

describe('常驻提示词（standing）按可见范围过滤', () => {
  const build = () =>
    indexOf(
      record({ id: 'mem_shared_pref', type: 'preference', visibility: 'shared', title: '交流偏好', preview: '喜欢简短' }),
      record({ id: 'mem_desktop_pref', type: 'preference', visibility: 'desktop-private', title: '桌面偏好', preview: '桌面习惯' }),
      record({ id: 'mem_qq_pref', type: 'preference', visibility: 'qq-private', title: 'QQ 偏好', preview: 'QQ 习惯' }),
    )

  it('QQ 会话的 standing 块不含 desktop-private', () => {
    const result = standingFacts(build(), {
      budgetTokens: 4000,
      maxItems: 20,
      visibilities: [...CHANNEL_VISIBILITIES.qq],
      qualityGate: false,
    })
    const ids = result.hits.map((hit) => hit.record.id).sort()
    expect(ids).toContain('mem_shared_pref')
    expect(ids).toContain('mem_qq_pref')
    expect(ids).not.toContain('mem_desktop_pref')
  })

  it('桌面会话的 standing 块不含 qq-private', () => {
    const result = standingFacts(build(), {
      budgetTokens: 4000,
      maxItems: 20,
      visibilities: [...CHANNEL_VISIBILITIES.desktop],
      qualityGate: false,
    })
    const ids = result.hits.map((hit) => hit.record.id).sort()
    expect(ids).toContain('mem_shared_pref')
    expect(ids).toContain('mem_desktop_pref')
    expect(ids).not.toContain('mem_qq_pref')
  })

  it('空可见范围时 standing 块为空，不退回全量', () => {
    const result = standingFacts(build(), {
      budgetTokens: 4000,
      maxItems: 20,
      visibilities: [],
      qualityGate: false,
    })
    expect(result.hits).toHaveLength(0)
    expect(result.text).toBe('')
  })

  it('不传可见范围时保持旧行为（浏览仓库可见全部）', () => {
    const result = standingFacts(build(), { budgetTokens: 4000, maxItems: 20, qualityGate: false })
    expect(result.hits).toHaveLength(3)
  })
})

describe('任务召回（recall）按可见范围过滤', () => {
  // 正文必须超过 renderHits 的最低信息量门槛，否则被当成噪音丢弃，
  // 测试就会因为「内容太少」而不是「被过滤」而失败。
  const body = (label: string) =>
    `校园网 登录 方式 是 通过 Portal 认证 页面 提交 学号 和 密码，随后 点击 登录 按钮 完成 认证，${label}。`
  const build = () =>
    indexOf(
      record({ id: 'mem_r_shared', visibility: 'shared', title: '校园网 登录 共享', preview: body('共享说明') }),
      record({ id: 'mem_r_desktop', visibility: 'desktop-private', title: '校园网 登录 桌面', preview: body('桌面私有细节') }),
      record({ id: 'mem_r_qq', visibility: 'qq-private', title: '校园网 登录 QQ', preview: body('QQ 记录说明') }),
    )

  it('QQ 召回拿不到 desktop-private 的正文', () => {
    const result = retrieveForTask(build(), {
      query: '校园网 登录',
      budgetTokens: 8000,
      maxItems: 10,
      visibilities: [...CHANNEL_VISIBILITIES.qq],
    })
    expect(result.includedIds).toContain('mem_r_shared')
    expect(result.includedIds).toContain('mem_r_qq')
    expect(result.includedIds).not.toContain('mem_r_desktop')
    expect(result.text).not.toContain('桌面私有细节')
  })

  it('空可见范围召回为空文本', () => {
    const result = retrieveForTask(build(), {
      query: '校园网 登录',
      budgetTokens: 8000,
      maxItems: 10,
      visibilities: [],
    })
    expect(result.includedIds).toHaveLength(0)
    expect(result.text).toBe('')
  })
})

describe('持久化兼容', () => {
  it('frontmatter 往返保留可见范围与来源渠道', () => {
    const memory = {
      id: 'mem_roundtrip',
      type: 'preference' as const,
      status: 'active' as const,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      title: '偏好',
      tags: ['preference'],
      confidence: 'high' as const,
      importance: 60,
      pinned: false,
      visibility: 'shared' as const,
      sourceChannels: ['desktop' as const, 'qq' as const],
      sourceSessions: [],
      supersedes: [],
      conflictsWith: [],
      aliases: [],
      evidence: '',
      schemaVersion: 2,
    }
    const frontmatter = metaToFrontmatter(memory)
    expect(frontmatter['visibility']).toBe('shared')
    expect(frontmatter['source_channels']).toEqual(['desktop', 'qq'])

    const raw = frontmatterToMetaRaw(frontmatter)
    expect(raw['visibility']).toBe('shared')
    expect(raw['sourceChannels']).toEqual(['desktop', 'qq'])
  })

  it('旧记忆缺 visibility 时补为保守缺省，且不记为修复项', () => {
    // 缺字段是 L1 之前所有记忆的正常状态，缺省方向已经偏向最严格，
    // 因此不算缺陷。若记为修复项，整个历史仓库都会被标成"被修复"，
    // 真缺陷信号会被淹没。
    const result = normalizeMemory({
      id: 'mem_old',
      type: 'knowledge',
      status: 'active',
      title: '旧记忆',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      confidence: 'high',
      importance: 50,
      pinned: false,
      sourceSessions: [],
      supersedes: [],
      conflictsWith: [],
      aliases: [],
      evidence: '',
      schemaVersion: 1,
      summary: '正文',
      sections: [],
      related: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory.visibility).toBe(DEFAULT_VISIBILITY)
    expect(result.memory.sourceChannels).toEqual([])
    expect(result.repairs.some((line) => line.includes('visibility'))).toBe(false)
  })

  it('缺 visibility 不等于 shared：旧记忆对 QQ 侧不可见', () => {
    const result = normalizeMemory({
      id: 'mem_old2',
      type: 'knowledge',
      status: 'active',
      title: '旧记忆二',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      summary: '正文',
      sections: [],
      related: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(CHANNEL_VISIBILITIES.qq).not.toContain(result.memory.visibility)
    expect(CHANNEL_VISIBILITIES.desktop).toContain(result.memory.visibility)
  })

  it('非法 visibility 值被修复为保守缺省，而不是让整个文件失效', () => {
    const result = normalizeMemory({
      id: 'mem_bad',
      type: 'knowledge',
      status: 'active',
      title: '坏值',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      confidence: 'high',
      importance: 50,
      pinned: false,
      visibility: 'public',
      sourceChannels: ['desktop', 'telegram'],
      sourceSessions: [],
      supersedes: [],
      conflictsWith: [],
      aliases: [],
      evidence: '',
      schemaVersion: 1,
      summary: '正文',
      sections: [],
      related: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory.visibility).toBe(DEFAULT_VISIBILITY)
    // 未知通道被丢弃，不猜测
    expect(result.memory.sourceChannels).toEqual(['desktop'])
  })
})
