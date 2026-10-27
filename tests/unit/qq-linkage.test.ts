/**
 * QQ 接入 ↔ 长期记忆联动：共享纯函数契约的单元测试。
 *
 * 这一层被客户端页面与宿主端执行点共同使用（页面用它预览「若现在执行会
 * 怎样」，宿主用它做真正的后端拦截），所以每个决策函数都要有独立断言：
 * 一旦这里的行为漂移，页面与后端就会说两套话。
 *
 * 覆盖：会话事实读取（三种形状）、来源判定（QQ 优先、cwd 归一化）、
 * 三个执行点的决策（off / deny-qq / allowlist）、运行时可执行性说明、
 * 以及配置归一化（去空、去重、限长、非法枚举回落）。
 *
 * @module tests/unit/qq-linkage.test
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QQ_LINKAGE,
  EMPTY_MARKERS,
  channelLabel,
  classifyProvenance,
  decideRead,
  decideTools,
  decideWrite,
  describeLinkageRuntime,
  markersEmpty,
  modeLabel,
  normalizeCwd,
  normalizeMarkers,
  normalizeQqLinkage,
  readSessionFacts,
  type LinkageDecision,
  type Provenance,
  type QqLinkageConfig,
  type SessionFacts,
  type SessionMarkers,
} from '../../src/shared/qq-linkage.js'

/* ------------------------------------------------------------------ helpers */

function markers(overrides: Partial<SessionMarkers> = {}): SessionMarkers {
  return { ...EMPTY_MARKERS, ...overrides }
}

function config(overrides: Partial<QqLinkageConfig> = {}): QqLinkageConfig {
  return { ...DEFAULT_QQ_LINKAGE, ...overrides }
}

function facts(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return {
    sessionId: null,
    cwd: null,
    origin: null,
    agentPreset: null,
    parentSession: null,
    ...overrides,
  }
}

/** 一份可直接喂给 classifyProvenance 的 QQ 会话事实。 */
function provenance(channel: Provenance['channel'], overrides: Partial<Provenance> = {}): Provenance {
  return {
    channel,
    matchedBy: channel === 'unidentified' ? null : 'origin',
    marker: channel === 'unidentified' ? null : channel,
    reason: '测试用判定理由',
    ...overrides,
  }
}

/* --------------------------------------------------- readSessionFacts 形状 */

describe('readSessionFacts', () => {
  it('从 { agent → session → header } 形状读取全部字段', () => {
    const agent = {
      session: {
        id: 'session-via-agent',
        header: {
          cwd: 'D:/work/qq',
          origin: 'qq',
          agentPreset: 'qqbot-preset',
          parentSession: 'parent-1',
        },
      },
    }
    expect(readSessionFacts(agent)).toEqual({
      sessionId: 'session-via-agent',
      cwd: 'D:/work/qq',
      origin: 'qq',
      agentPreset: 'qqbot-preset',
      parentSession: 'parent-1',
    })
  })

  it('从 session 本身（id + header）读取全部字段', () => {
    const session = {
      id: 'session-direct',
      header: { cwd: '/home/me/work', origin: 'desk', agentPreset: 'default', parentSession: 'root' },
    }
    expect(readSessionFacts(session)).toEqual({
      sessionId: 'session-direct',
      cwd: '/home/me/work',
      origin: 'desk',
      agentPreset: 'default',
      parentSession: 'root',
    })
  })

  it('把外层直接带 header 的对象（逐层降级的中间形状）也当作会话读取', () => {
    const holder = { header: { id: 'from-header', cwd: 'C:/qq', origin: 'qq', agentPreset: 'p' } }
    expect(readSessionFacts(holder)).toEqual({
      sessionId: 'from-header',
      cwd: 'C:/qq',
      origin: 'qq',
      agentPreset: 'p',
      parentSession: null,
    })
  })

  it('session 上没有 header 时从 session.cwd 兜底，其余字段为 null', () => {
    const result = readSessionFacts({ id: 'bare', cwd: 'D:/bare' })
    expect(result.sessionId).toBe('bare')
    expect(result.cwd).toBe('D:/bare')
    expect(result.origin).toBeNull()
    expect(result.agentPreset).toBeNull()
    expect(result.parentSession).toBeNull()
  })

  it('读不到时所有字段都是 null，而不是用默认值假装读到了', () => {
    const empty = readSessionFacts(undefined)
    expect(empty).toEqual({
      sessionId: null,
      cwd: null,
      origin: null,
      agentPreset: null,
      parentSession: null,
    })
    expect(readSessionFacts(null)).toEqual(empty)
    expect(readSessionFacts('a string')).toEqual(empty)
    expect(readSessionFacts(42)).toEqual(empty)
    expect(readSessionFacts({})).toEqual(empty)
  })

  it('空字符串字段视为读不到（不把空串当作有效标记值）', () => {
    const result = readSessionFacts({ session: { id: '', header: { origin: '', agentPreset: '', cwd: '' } } })
    expect(result.sessionId).toBeNull()
    expect(result.origin).toBeNull()
    expect(result.agentPreset).toBeNull()
    expect(result.cwd).toBeNull()
  })

  it('非字符串字段被忽略，不抛异常', () => {
    const result = readSessionFacts({ session: { id: 7, header: { origin: { qq: true }, cwd: ['/x'] } } })
    expect(result.sessionId).toBeNull()
    expect(result.origin).toBeNull()
    expect(result.cwd).toBeNull()
  })
})

/* ------------------------------------------------------- classifyProvenance */

describe('classifyProvenance', () => {
  const qqConfig = config({
    mode: 'deny-qq',
    qqMarkers: markers({ origins: ['qq'], presets: ['qqbot-preset'], cwds: ['C:\\Users\\QQ'] }),
    trustedMarkers: markers({ origins: ['desktop'], presets: ['default'], cwds: ['/home/me'] }),
  })

  it('origin 命中 → qq', () => {
    const result = classifyProvenance(facts({ origin: 'qq' }), qqConfig)
    expect(result.channel).toBe('qq')
    expect(result.matchedBy).toBe('origin')
    expect(result.marker).toBe('qq')
    expect(result.reason).toContain('origin')
  })

  it('agentPreset 命中 → qq，并报告命中的标记种类', () => {
    const result = classifyProvenance(facts({ agentPreset: 'qqbot-preset' }), qqConfig)
    expect(result.channel).toBe('qq')
    expect(result.matchedBy).toBe('preset')
    expect(result.marker).toBe('qqbot-preset')
  })

  it('cwd 命中 → qq（忽略末尾分隔符与 Windows 盘符大小写）', () => {
    const result = classifyProvenance(facts({ cwd: 'c:\\users\\qq\\' }), qqConfig)
    expect(result.channel).toBe('qq')
    expect(result.matchedBy).toBe('cwd')
    expect(result.marker).toBe('C:\\Users\\QQ')
  })

  it('QQ 标记优先于受信标记：同时命中时按 QQ 处理（宁可收紧）', () => {
    const both = config({
      mode: 'deny-qq',
      qqMarkers: markers({ origins: ['shared'] }),
      trustedMarkers: markers({ origins: ['shared'] }),
    })
    const result = classifyProvenance(facts({ origin: 'shared' }), both)
    expect(result.channel).toBe('qq')
    expect(result.reason).toContain('shared')
  })

  it('只命中受信标记 → trusted', () => {
    const result = classifyProvenance(facts({ origin: 'desktop' }), qqConfig)
    expect(result.channel).toBe('trusted')
    expect(result.matchedBy).toBe('origin')
  })

  it('受信 cwd 同样按末尾分隔符与盘符大小写归一化匹配', () => {
    const configWithCwd = config({ trustedMarkers: markers({ cwds: ['D:\\Work\\Desktop'] }) })
    const result = classifyProvenance(facts({ cwd: 'd:/work/desktop/' }), configWithCwd)
    // 分隔符不同（\ 与 /）时不做转换，只有同分隔符写法才匹配；这里验证的是
    // 尾部分隔符与大小写规则本身。
    expect(result.channel).toBe('unidentified')
    const sameSeparator = classifyProvenance(facts({ cwd: 'd:\\work\\desktop\\' }), configWithCwd)
    expect(sameSeparator.channel).toBe('trusted')
    expect(sameSeparator.matchedBy).toBe('cwd')
  })

  it('没有命中任何标记 → unidentified，matchedBy 为 null', () => {
    const result = classifyProvenance(facts({ origin: 'other', agentPreset: 'x', cwd: '/tmp' }), qqConfig)
    expect(result.channel).toBe('unidentified')
    expect(result.matchedBy).toBeNull()
    expect(result.marker).toBeNull()
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('标记未配置时任何会话都是 unidentified（绝不猜测来源）', () => {
    const result = classifyProvenance(facts({ origin: 'qq', agentPreset: 'qqbot-preset' }), config())
    expect(result.channel).toBe('unidentified')
  })

  it('标记列表中的空字符串/空数组不产生匹配', () => {
    const emptyMarkers = config({ qqMarkers: markers({ origins: ['', '   '] }), trustedMarkers: markers() })
    expect(classifyProvenance(facts({ origin: '' }), emptyMarkers).channel).toBe('unidentified')
  })

  it('判定与模式无关：mode=off 时仍如实报告来源（供页面展示）', () => {
    const offConfig = config({ mode: 'off', qqMarkers: markers({ origins: ['qq'] }) })
    expect(classifyProvenance(facts({ origin: 'qq' }), offConfig).channel).toBe('qq')
  })
})

/* --------------------------------------------------------------- 决策函数 */

describe('decideRead', () => {
  it('off：三种来源全部放行（既有行为不变）', () => {
    const off = config({ mode: 'off' })
    for (const channel of ['qq', 'trusted', 'unidentified'] as const) {
      const decision = decideRead(provenance(channel), off)
      expect(decision.allowed).toBe(true)
      expect(decision.channel).toBe(channel)
    }
  })

  it('deny-qq：只拒绝 qq，受信与未识别放行', () => {
    const deny = config({ mode: 'deny-qq' })
    expect(decideRead(provenance('qq'), deny).allowed).toBe(false)
    expect(decideRead(provenance('trusted'), deny).allowed).toBe(true)
    expect(decideRead(provenance('unidentified'), deny).allowed).toBe(true)
  })

  it('allowlist：只有受信会话放行，qq 与 unidentified 一律拒绝', () => {
    const allow = config({ mode: 'allowlist' })
    expect(decideRead(provenance('trusted'), allow).allowed).toBe(true)
    expect(decideRead(provenance('qq'), allow).allowed).toBe(false)
    expect(decideRead(provenance('unidentified'), allow).allowed).toBe(false)
  })

  it('拒绝时给出人类可读理由，且带上判定依据', () => {
    const deny = config({ mode: 'deny-qq' })
    const decision: LinkageDecision = decideRead(provenance('qq', { reason: '会话 origin 命中标记「qq」' }), deny)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('QQ')
    expect(decision.reason).toContain('origin 命中标记')
  })
})

describe('decideWrite', () => {
  it('off：写回方式沿用既有规则（全部放行）', () => {
    const off = config({ mode: 'off' })
    expect(decideWrite(provenance('qq'), off).allowed).toBe(true)
    expect(decideWrite(provenance('unidentified'), off).allowed).toBe(true)
  })

  it('qq + inbox-only → 不允许直接落盘（强制进收件箱）', () => {
    const deny = config({ mode: 'deny-qq', writeMode: 'inbox-only' })
    const decision = decideWrite(provenance('qq'), deny)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('收件箱')
  })

  it('qq + direct → 允许按既有规则直接落盘', () => {
    const deny = config({ mode: 'deny-qq', writeMode: 'direct' })
    expect(decideWrite(provenance('qq'), deny).allowed).toBe(true)
  })

  it('非 QQ 会话不受 writeMode 影响', () => {
    const deny = config({ mode: 'deny-qq', writeMode: 'inbox-only' })
    expect(decideWrite(provenance('trusted'), deny).allowed).toBe(true)
    expect(decideWrite(provenance('unidentified'), deny).allowed).toBe(true)
  })

  it('allowlist 下未识别来源只进收件箱，受信会话照常写回', () => {
    const allow = config({ mode: 'allowlist', writeMode: 'direct' })
    expect(decideWrite(provenance('unidentified'), allow).allowed).toBe(false)
    expect(decideWrite(provenance('trusted'), allow).allowed).toBe(true)
  })
})

describe('decideTools', () => {
  it('off：不拦截任何工具调用', () => {
    expect(decideTools(provenance('qq'), config({ mode: 'off' })).allowed).toBe(true)
  })

  it('deny-qq：QQ 会话默认不允许调用记忆工具', () => {
    const deny = config({ mode: 'deny-qq', allowTools: false })
    const decision = decideTools(provenance('qq'), deny)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('不允许')
  })

  it('deny-qq + allowTools=true：QQ 会话允许调用工具', () => {
    const deny = config({ mode: 'deny-qq', allowTools: true })
    expect(decideTools(provenance('qq'), deny).allowed).toBe(true)
  })

  it('allowlist：未识别来源即使 allowTools=true 也被拒绝', () => {
    const allow = config({ mode: 'allowlist', allowTools: true })
    expect(decideTools(provenance('unidentified'), allow).allowed).toBe(false)
    expect(decideTools(provenance('trusted'), allow).allowed).toBe(true)
    expect(decideTools(provenance('qq'), allow).allowed).toBe(true)
  })
})

/* ------------------------------------------------ describeLinkageRuntime */

describe('describeLinkageRuntime', () => {
  it('off：明确说明行为与未接入 QQ 时完全相同', () => {
    const status = describeLinkageRuntime(config({ mode: 'off', writeMode: 'direct' }), false)
    expect(status.enforcing).toBe(false)
    expect(status.qqIdentifiable).toBe(false)
    expect(status.sessionAwareStanding).toBe(false)
    expect(status.notes.join('\n')).toContain('联动保护未启用')
    // 未启用时不应该报告「未配置 QQ 标记」这类只在启用后才有意义的提示。
    expect(status.notes.join('\n')).not.toContain('尚未配置 QQ 标记')
  })

  it('启用但未配置 QQ 标记：提示没有任何会话会被识别为 QQ', () => {
    const status = describeLinkageRuntime(config({ mode: 'deny-qq' }), true)
    expect(status.enforcing).toBe(true)
    expect(status.qqIdentifiable).toBe(false)
    expect(status.notes.join('\n')).toContain('尚未配置 QQ 标记')
  })

  it('allowlist 未配置受信标记：提示所有会话都会被拒绝读取', () => {
    const status = describeLinkageRuntime(
      config({ mode: 'allowlist', qqMarkers: markers({ origins: ['qq'] }) }),
      true,
    )
    expect(status.notes.join('\n')).toContain('需要配置受信标记')
    expect(status.notes.join('\n')).toContain('所有会话都会被拒绝读取记忆')
  })

  it('未观测到 standing 上下文：如实提示该执行点尚未按会话拦截', () => {
    const status = describeLinkageRuntime(
      config({ mode: 'deny-qq', qqMarkers: markers({ origins: ['qq'] }) }),
      false,
    )
    expect(status.sessionAwareStanding).toBe(false)
    expect(status.notes.join('\n')).toContain('尚未观测到宿主为常驻提示词分区传入会话上下文')
  })

  it('已观测到 standing 上下文且标记齐备：不再出现关于拦截能力的告警', () => {
    const status = describeLinkageRuntime(
      config({
        mode: 'allowlist',
        writeMode: 'direct',
        qqMarkers: markers({ origins: ['qq'] }),
        trustedMarkers: markers({ origins: ['desktop'] }),
      }),
      true,
    )
    expect(status.notes).toEqual([])
    expect(status.enforcing).toBe(true)
    expect(status.qqIdentifiable).toBe(true)
    expect(status.sessionAwareStanding).toBe(true)
  })

  it('inbox-only 写回方式会额外提示候选记忆只进收件箱', () => {
    const status = describeLinkageRuntime(config({ mode: 'off', writeMode: 'inbox-only' }), false)
    expect(status.notes.join('\n')).toContain('只进收件箱')
  })
})

/* ------------------------------------------------------ normalizeQqLinkage */

describe('normalizeQqLinkage', () => {
  it('空/非法输入回落为默认配置', () => {
    const defaults = {
      mode: 'off',
      writeMode: 'inbox-only',
      allowTools: false,
      qqMarkers: markers(),
      trustedMarkers: markers(),
    }
    expect(normalizeQqLinkage(undefined)).toEqual(defaults)
    expect(normalizeQqLinkage(null)).toEqual(defaults)
    expect(normalizeQqLinkage('nope')).toEqual(defaults)
    expect(normalizeQqLinkage(42)).toEqual(defaults)
    expect(normalizeQqLinkage([])).toEqual(defaults)
  })

  it('保留合法枚举值', () => {
    const parsed = normalizeQqLinkage({ mode: 'allowlist', writeMode: 'direct' })
    expect(parsed.mode).toBe('allowlist')
    expect(parsed.writeMode).toBe('direct')
  })

  it('非法枚举值回落默认值', () => {
    const parsed = normalizeQqLinkage({ mode: 'block-everything', writeMode: 'sometimes' })
    expect(parsed.mode).toBe('off')
    expect(parsed.writeMode).toBe('inbox-only')
  })

  it('allowTools 只有字面量 true 才算开启', () => {
    expect(normalizeQqLinkage({ allowTools: true }).allowTools).toBe(true)
    expect(normalizeQqLinkage({ allowTools: 'true' }).allowTools).toBe(false)
    expect(normalizeQqLinkage({ allowTools: 1 }).allowTools).toBe(false)
    expect(normalizeQqLinkage({ allowTools: null }).allowTools).toBe(false)
  })

  it('标记列表在归一化时去空、去重（大小写不敏感）', () => {
    const parsed = normalizeQqLinkage({
      qqMarkers: { origins: [' qq ', 'QQ', '', '   ', 'qq'] },
    })
    expect(parsed.qqMarkers.origins).toEqual(['qq'])
    expect(parsed.qqMarkers.presets).toEqual([])
    expect(parsed.qqMarkers.cwds).toEqual([])
  })

  it('缺失的标记段归一化为空列表，不是 undefined', () => {
    const parsed = normalizeQqLinkage({ mode: 'deny-qq' })
    expect(parsed.qqMarkers).toEqual(markers())
    expect(parsed.trustedMarkers).toEqual(markers())
  })

  it('未知字段被忽略', () => {
    const parsed = normalizeQqLinkage({ mode: 'deny-qq', mystery: true })
    expect(parsed).not.toHaveProperty('mystery')
    expect(parsed.mode).toBe('deny-qq')
  })
})

/* ---------------------------------------------------------- normalizeMarkers */

describe('normalizeMarkers', () => {
  it('非数组/非对象输入得到空标记', () => {
    expect(normalizeMarkers(undefined)).toEqual(markers())
    expect(normalizeMarkers(null)).toEqual(markers())
    expect(normalizeMarkers('x')).toEqual(markers())
    expect(normalizeMarkers({ origins: 'not-an-array' })).toEqual(markers())
  })

  it('去空、去重（大小写不敏感）、过滤非字符串并保留首次写法', () => {
    const parsed = normalizeMarkers({
      origins: [' qq ', 'QQ', '', 7, null, 'qqbot', 'QqBot'],
      presets: ['default'],
      cwds: ['D:\\Work\\QQ', 'd:\\work\\qq'],
    })
    expect(parsed.origins).toEqual(['qq', 'qqbot'])
    expect(parsed.presets).toEqual(['default'])
    expect(parsed.cwds).toEqual(['D:\\Work\\QQ'])
  })

  it('单个标记超过长度上限被丢弃', () => {
    const parsed = normalizeMarkers({ origins: ['x'.repeat(261), 'y'.repeat(260)] })
    expect(parsed.origins).toEqual(['y'.repeat(260)])
  })

  it('标记总数上限为 32 条', () => {
    const many = Array.from({ length: 40 }, (_value, index) => `marker-${String(index)}`)
    const parsed = normalizeMarkers({ origins: many })
    expect(parsed.origins).toHaveLength(32)
    expect(parsed.origins[0]).toBe('marker-0')
    expect(parsed.origins[31]).toBe('marker-31')
  })

  it('去重按键大小写不敏感，但保留用户输入的大小写', () => {
    const parsed = normalizeMarkers({ origins: ['QQ'] })
    expect(parsed.origins).toEqual(['QQ'])
  })
})

/* ------------------------------------------------------------- 小工具函数 */

describe('标记与路径小工具', () => {
  it('normalizeCwd 去掉尾部分隔符，Windows 盘符路径统一小写', () => {
    expect(normalizeCwd('/home/me/')).toBe('/home/me')
    expect(normalizeCwd('/home/me///')).toBe('/home/me')
    expect(normalizeCwd('C:\\Users\\QQ\\')).toBe('c:\\users\\qq')
    expect(normalizeCwd('d:/work')).toBe('d:/work')
    // POSIX 路径不做大小写折叠。
    expect(normalizeCwd('/Home/Me')).toBe('/Home/Me')
    expect(normalizeCwd('  /home/me  ')).toBe('/home/me')
  })

  it('markersEmpty 只把三段全空视为空', () => {
    expect(markersEmpty(markers())).toBe(true)
    expect(markersEmpty(markers({ origins: ['qq'] }))).toBe(false)
    expect(markersEmpty(markers({ presets: ['qq'] }))).toBe(false)
    expect(markersEmpty(markers({ cwds: ['/qq'] }))).toBe(false)
  })

  it('channelLabel / modeLabel 对每种取值都有非空中文文案', () => {
    for (const channel of ['qq', 'trusted', 'unidentified'] as const) {
      expect(channelLabel(channel).length).toBeGreaterThan(0)
    }
    for (const mode of ['off', 'deny-qq', 'allowlist'] as const) {
      expect(modeLabel(mode).length).toBeGreaterThan(0)
    }
  })

  it('默认配置保持既有行为：mode=off、writeMode=inbox-only、不识别任何 QQ 标记', () => {
    expect(DEFAULT_QQ_LINKAGE.mode).toBe('off')
    expect(DEFAULT_QQ_LINKAGE.writeMode).toBe('inbox-only')
    expect(DEFAULT_QQ_LINKAGE.allowTools).toBe(false)
    expect(markersEmpty(DEFAULT_QQ_LINKAGE.qqMarkers)).toBe(true)
    expect(markersEmpty(DEFAULT_QQ_LINKAGE.trustedMarkers)).toBe(true)
  })
})
