/**
 * QQ 接入联动 + Owner Gate：三个宿主执行点的拦截集成测试（WP-2A-R1）。
 *
 * 用假 Cordis 上下文 + 真实 `MemoryService`（真实临时仓库）验证：
 * 1. 常驻记忆注入：QQ/未绑定 fail-closed；有正向 PC 证据才返回常驻文本；
 * 2. 会话结束写回：无 Owner 证据 → forceInbox；有证据且 linkage 允许 → active；
 * 3. 模型工具：installTools 经统一 Owner Gate；无服务/未登记 → DENY。
 *
 * 注意：mock `qqbotContext` 的 `platform:'desktop'` 仅用于验证
 * **存在正向证据时的 ALLOW 路径**；当前代码库无生产 producer（见交付报告）。
 *
 * @module tests/integration/qq-injection-guard.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import {
  STANDING_SECTION_NAME,
  installStandingSection,
  installTurnExtraction,
  type CordisLike,
} from '../../src/host/dsh/inject.js'
import { buildToolDefinitions, installTools, type ToolDefinition } from '../../src/host/dsh/tools.js'
import type { SessionMarkers } from '../../src/shared/qq-linkage.js'

let root: string
let vault: string
let service: MemoryService

/** 一条能稳定触发规则提取、且置信度足够自动落盘的用户消息。 */
const ASSERTED_MESSAGE = '请记住：我更喜欢用 PowerShell 而不是 bash。'

/** 一份完整的标记集合（运行时允许缺字段，类型上要求三个数组齐全）。 */
function markers(overrides: Partial<SessionMarkers> = {}): SessionMarkers {
  return { origins: [], presets: [], cwds: [], ...overrides }
}

beforeEach(async () => {
  root = await makeTempRoot('qq-injection')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault })
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

/* ------------------------------------------------------------- 假 Cordis ctx */

interface FakeCtx extends CordisLike {
  services: Record<string, unknown>
  listeners: { name: string; listener: (...args: never[]) => unknown }[]
  effects: (() => void)[]
}

function fakeCtx(services: Record<string, unknown> = {}): FakeCtx {
  const ctx: FakeCtx = {
    services,
    listeners: [],
    effects: [],
    get(name) {
      return this.services[name]
    },
    on(name, listener) {
      this.listeners.push({ name, listener })
      return () => undefined
    },
    effect(execute) {
      const result = execute()
      const dispose = typeof result === 'function' ? (result as () => void) : () => undefined
      this.effects.push(dispose)
      return dispose
    },
    logger: { info: () => undefined, warn: () => undefined },
  }
  return ctx
}

/**
 * WP-2A-R1 mock qqbotContext：
 * - `desktop*` / `plain*` 会话 → live `platform:'desktop'`（正向 PC 证据，ALLOW 路径）
 * - `qq*` 会话 → live qq C2C（ownerId 默认已绑定，可用参数改为未绑定）
 * - 其他 → null（未登记 → 无正向证据 → DENY）
 */
function mockQqContext(opts: { qqOwnerId?: string | null; knownQq?: (id: string) => boolean } = {}) {
  const qqOwnerId = opts.qqOwnerId === undefined ? 'owner-test' : opts.qqOwnerId
  return {
    getContext(sessionId: string) {
      if (sessionId.startsWith('desktop') || sessionId.startsWith('plain') || sessionId.startsWith('unmarked')) {
        return {
          platform: 'desktop',
          conversationType: 'c2c',
          isPrivate: true,
          ownerId: null,
          identified: true,
        }
      }
      if (sessionId.startsWith('qq')) {
        return {
          platform: 'qq',
          conversationType: 'c2c',
          isPrivate: true,
          ownerId: qqOwnerId,
          identified: true,
        }
      }
      return null
    },
    isKnownQqSession(sessionId: string) {
      if (opts.knownQq) return opts.knownQq(sessionId)
      return sessionId.startsWith('qq')
    },
    isRegistryHealthy() {
      return true
    },
  }
}

/** 取出常驻分区的 `text` 回调，并原样模拟宿主传入的 context 形状。 */
function captureStandingText(
  ctx: FakeCtx,
  linkage = service.linkage,
  qqContext: unknown = mockQqContext(),
): (context?: unknown) => string {
  const sections: Record<string, unknown>[] = []
  const services: Record<string, unknown> = { ...ctx.services }
  if (qqContext !== null) services['qqbotContext'] = qqContext
  const ctxWithPrompt = fakeCtx({
    ...services,
    systemPrompt: {
      section: (section: Record<string, unknown>) => {
        sections.push(section)
        return () => undefined
      },
    },
  })
  const notes: Record<string, string> = {}
  expect(installStandingSection(ctxWithPrompt, service, notes, linkage)).toBe(true)
  expect(sections).toHaveLength(1)
  expect(sections[0]?.['name']).toBe(STANDING_SECTION_NAME)
  return sections[0]?.['text'] as (context?: unknown) => string
}

/** agent → session → header 的形状，等价于宿主传给 `text` 的 `context.agent`。 */
interface AgentLike {
  session: { id: string; header: Record<string, string> }
}

function agentFor(sessionId: string, header: Record<string, string>): AgentLike {
  return { session: { id: sessionId, header } }
}

/** 把一批 session 事件喂给 `session/event` 监听器。 */
function emitSessionEvents(ctx: FakeCtx, session: unknown, events: { type: string; data?: unknown }[]): void {
  const listener = ctx.listeners.find((entry) => entry.name === 'session/event')?.listener
  expect(listener).toBeDefined()
  if (listener === undefined) return
  for (const event of events) {
    ;(listener as unknown as (s: unknown, e: unknown) => void)(session, {
      type: event.type,
      data: event.data ?? {},
      seq: 1,
      time: 1,
    })
  }
}

/** 轮询等待异步写回链完成，避免用固定延时造成偶发失败。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error('waitFor: 条件在超时前未满足')
}

/** 保存一条常驻记忆，让 standing 文本非空、便于断言「有内容」与「被清空」。 */
async function saveStandingMemory(visibility: 'shared' | 'desktop-private' = 'shared'): Promise<void> {
  // L1 起记忆带可见范围：这条记忆是「QQ 已绑定时应当读到的常驻内容」，
  // 因此显式声明 shared。旧用例默认它可被 QQ 读到，等于默认 PC 记忆对 QQ 全量可见，
  // 那正是可见范围要禁止的行为。
  await service.save({
    type: 'profile',
    title: '用户背景',
    summary: '后端工程师。',
    tags: [],
    confidence: 'high',
    importance: 90,
    visibility,
  })
}

async function enableDenyQq(): Promise<void> {
  await service.setQqLinkage({
    mode: 'deny-qq',
    writeMode: 'inbox-only',
    qqMarkers: markers({ origins: ['qq'] }),
  })
}

/* ------------------------------------------------------ 常驻注入执行点 */

describe('installStandingSection 的按会话拦截', () => {
  it('deny-qq + QQ 会话上下文 → 返回空串并计入 standingBlocked', async () => {
    await saveStandingMemory()
    await enableDenyQq()
    const text = captureStandingText(fakeCtx())

    const output = text({ agent: agentFor('qq-standing', { origin: 'qq' }) })
    expect(output).toBe('')
    expect(service.qqLinkageReport().counters.standingBlocked).toBe(1)
    // 观测到宿主确实传入了会话上下文，报告不再声称「尚未观测到」。
    expect(service.qqLinkageReport().runtime.sessionAwareStanding).toBe(true)
  })

  it('QQ 已绑定 → linkage 放行时返回常驻文本（正向矩阵）', async () => {
    await saveStandingMemory()
    const text = captureStandingText(fakeCtx(), service.linkage, mockQqContext({ qqOwnerId: 'owner-1' }))

    const output = text({ agent: agentFor('qq-standing', { origin: 'qq' }) })
    expect(output).toContain('用户背景')
    expect(service.qqLinkageReport().counters.standingBlocked).toBe(0)
  })

  it('QQ 已绑定但记忆是 desktop-private → 常驻文本为空（可见范围隔离）', async () => {
    // 放行不等于可读：身份通过只是第一道门，可见范围是第二道。
    await saveStandingMemory('desktop-private')
    const text = captureStandingText(fakeCtx(), service.linkage, mockQqContext({ qqOwnerId: 'owner-1' }))

    const output = text({ agent: agentFor('qq-standing-private', { origin: 'qq' }) })
    expect(output).toBe('')
  })

  it('QQ 未绑定 → 即使 linkage mode=off 也 DENY 空串（R 矩阵）', async () => {
    await saveStandingMemory()
    const text = captureStandingText(fakeCtx(), service.linkage, mockQqContext({ qqOwnerId: null }))

    const output = text({ agent: agentFor('qq-unbound', { origin: 'qq' }) })
    expect(output).toBe('')
  })

  it('有正向 PC 证据的桌面会话 → 返回常驻文本，不计数', async () => {
    await saveStandingMemory()
    await enableDenyQq()
    const text = captureStandingText(fakeCtx())

    const output = text({ agent: agentFor('desktop-standing', { origin: 'desktop' }) })
    expect(output).toContain('长期记忆')
    expect(output).toContain('用户背景')
    expect(service.qqLinkageReport().counters.standingBlocked).toBe(0)
  })

  it('R2: 无 qqbotContext 服务 → DENY 空串（服务缺失≠可信 PC）', async () => {
    await saveStandingMemory()
    await enableDenyQq()
    const text = captureStandingText(fakeCtx(), service.linkage, null)

    const output = text({ agent: agentFor('no-service-standing', {}) })
    expect(output).toBe('')
  })

  it('R1: 服务在但会话未登记且无 live 来源 → DENY', async () => {
    await saveStandingMemory()
    const text = captureStandingText(fakeCtx(), service.linkage, mockQqContext())

    const output = text({ agent: agentFor('unknown-session', {}) })
    expect(output).toBe('')
  })

  it('没有会话上下文的调用（如管理页预览）不计入拦截，也不宣称已观测上下文', async () => {
    await saveStandingMemory()
    await enableDenyQq()
    const text = captureStandingText(fakeCtx())

    const output = text()
    expect(output).toContain('用户背景')
    expect(service.qqLinkageReport().counters.standingBlocked).toBe(0)
    expect(service.qqLinkageReport().runtime.sessionAwareStanding).toBe(false)
  })

  it('未配置 QQ 标记时 linkage 不误伤；有正向 PC 证据仍可读', async () => {
    await saveStandingMemory()
    await service.setQqLinkage({ mode: 'deny-qq' })
    const text = captureStandingText(fakeCtx())

    const output = text({ agent: agentFor('unmarked', { origin: 'qq' }) })
    // mock 将 unmarked* 视为 desktop 正向证据 → 允许；linkage 因无标记不拦截
    expect(output).toContain('用户背景')
    expect(service.qqLinkageReport().counters.standingBlocked).toBe(0)
  })

  it('mode=off + QQ 已绑定 → 常驻文本（linkage 与 Owner Gate 并行，回归）', async () => {
    await saveStandingMemory()
    const text = captureStandingText(fakeCtx(), service.linkage, mockQqContext({ qqOwnerId: 'owner-1' }))

    const output = text({ agent: agentFor('qq-off', { origin: 'qq' }) })
    expect(output).toContain('用户背景')
    expect(service.qqLinkageReport().counters.standingBlocked).toBe(0)
  })
})

/* ------------------------------------------------------ 写回执行点 */

describe('installTurnExtraction 的写回拦截', () => {
  function installExtraction(linkage = service.linkage, qqContext: unknown = mockQqContext()): FakeCtx {
    const ctx = fakeCtx(qqContext === null ? {} : { qqbotContext: qqContext })
    const notes: Record<string, string> = {}
    const ok = installTurnExtraction(ctx, service, { ...service.getSettings(), enableAutoExtraction: true }, notes, linkage)
    expect(ok).toBe(true)
    return ctx
  }

  it('QQ 会话的 turn/end 只把候选写进收件箱，索引不新增 active 记忆', async () => {
    await enableDenyQq()
    const ctx = installExtraction()
    const session = { id: 'qq-session', header: { origin: 'qq' } }

    emitSessionEvents(ctx, session, [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: ASSERTED_MESSAGE }] } },
      { type: 'turn/end', data: { turn: 1, reason: 'stop' } },
    ])

    await waitFor(() => service.listCandidates().length > 0)
    expect(service.search({ limit: 50 }).total).toBe(0)
    const pending = service.listCandidates()
    expect(pending.length).toBeGreaterThan(0)
    expect(pending[0]?.decision.action).toBe('inbox')
    expect(service.qqLinkageReport().counters.writesForcedInbox).toBe(1)
  })

  it('桌面会话（正向 PC 证据）turn/end 直接落盘为 active 记忆', async () => {
    await enableDenyQq()
    const ctx = installExtraction()
    const session = { id: 'desktop-session', header: { cwd: 'D:/work' } }

    emitSessionEvents(ctx, session, [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: ASSERTED_MESSAGE }] } },
      { type: 'turn/end', data: { turn: 1, reason: 'stop' } },
    ])

    await waitFor(() => service.search({ limit: 50 }).total > 0)
    expect(service.qqLinkageReport().counters.writesForcedInbox).toBe(0)
  })

  it('R1: 未登记会话无正向证据 → 强制收件箱（不直接 active）', async () => {
    await enableDenyQq()
    const ctx = installExtraction()
    const session = { id: 'unknown-session-1' }

    emitSessionEvents(ctx, session, [
      { type: 'user/message', data: { content: [{ type: 'text', text: ASSERTED_MESSAGE }] } },
      { type: 'turn/end', data: { turn: 1 } },
    ])

    await waitFor(() => service.listCandidates().length > 0)
    expect(service.search({ limit: 50 }).total).toBe(0)
    expect(service.listCandidates()[0]?.decision.action).toBe('inbox')
  })

  it('无标记但有正向 PC 证据 → deny-qq 下照常直接落盘', async () => {
    await enableDenyQq()
    const ctx = installExtraction()
    const session = { id: 'plain-session' }

    emitSessionEvents(ctx, session, [
      { type: 'user/message', data: { content: [{ type: 'text', text: ASSERTED_MESSAGE }] } },
      { type: 'turn/end', data: { turn: 1 } },
    ])

    await waitFor(() => service.search({ limit: 50 }).total > 0)
    expect(service.qqLinkageReport().counters.writesForcedInbox).toBe(0)
  })

  it('mode=off + QQ 已绑定 → 来源级 Inbox 约束仍生效（与 linkage 开关独立）', async () => {
    // 设计 §六：QQ 端产生的新记忆一律只创建候选，经 PC 确认后才升级。
    // qqLinkage 的写侧开关不能解除来源级审核（§十一.2）；L2 之前此处
    // 断言「直接落盘」属旧语义，已按设计方案更新。
    await service.setQqLinkage({ writeMode: 'direct', qqMarkers: markers({ origins: ['qq'] }) })
    const ctx = installExtraction(service.linkage, mockQqContext({ qqOwnerId: 'owner-1' }))
    const session = { id: 'qq-off-session', header: { origin: 'qq' } }

    emitSessionEvents(ctx, session, [
      { type: 'user/message', data: { content: [{ type: 'text', text: ASSERTED_MESSAGE }] } },
      { type: 'turn/end', data: { turn: 1 } },
    ])

    await waitFor(() => service.listCandidates().length > 0)
    expect(service.search({ limit: 50 }).total).toBe(0)
    // linkage 开关确实没有干预；强制 Inbox 来自独立的 Owner Gate 通道判定。
    expect(service.qqLinkageReport().counters.writesForcedInbox).toBe(0)
    expect(service.listCandidates()[0]?.visibility).toBe('qq-private')
    expect(service.listCandidates()[0]?.sourceChannels).toEqual(['qq'])
  })
})

/* ------------------------------------------------------ 模型工具执行点 */

describe('记忆工具执行前的拦截', () => {
  function searchTool(linkage = service.linkage, qqContext: unknown = mockQqContext()): ToolDefinition {
    // install 路径才挂 ownerGate；显式传入 mock 服务
    const ctx = fakeCtx(qqContext === null ? {} : { qqbotContext: qqContext })
    const registered: ToolDefinition[] = []
    const toolsCtx = fakeCtx({
      ...(qqContext === null ? {} : { qqbotContext: qqContext }),
      tools: {
        register: (definition: ToolDefinition) => {
          registered.push(definition)
          return () => undefined
        },
      },
    })
    installTools(toolsCtx, service, linkage)
    void ctx
    const definition = registered.find((entry) => entry.name === 'memory_search')
    expect(definition).toBeDefined()
    if (definition === undefined) throw new Error('memory_search 未注册')
    return definition
  }

  it('QQ 已绑定 + linkage 放行 → memory_search 可用（正向矩阵）', async () => {
    await saveStandingMemory()
    await service.setQqLinkage({ mode: 'off' })
    const search = searchTool(service.linkage, mockQqContext({ qqOwnerId: 'owner-1' }))
    const result = (await search.execute(
      { query: '用户背景' },
      { agent: agentFor('qq-bound-tool', {}) },
    )) as { count: number }
    expect(result.count).toBeGreaterThan(0)
  })

  it('QQ 已绑定但记忆是 desktop-private → memory_search 命中 0（可见范围隔离）', async () => {
    await saveStandingMemory('desktop-private')
    await service.setQqLinkage({ mode: 'off' })
    const search = searchTool(service.linkage, mockQqContext({ qqOwnerId: 'owner-1' }))
    const result = (await search.execute(
      { query: '用户背景' },
      { agent: agentFor('qq-bound-tool-private', {}) },
    )) as { count: number }
    expect(result.count).toBe(0)
  })

  it('QQ 未绑定 → memory_search DENY（即使 linkage off）', async () => {
    await enableDenyQq()
    const search = searchTool(service.linkage, mockQqContext({ qqOwnerId: null }))
    await expect(
      search.execute({ query: '用户背景' }, { agent: agentFor('qq-unbound-tool', {}) }),
    ).rejects.toThrow(/refused/)
  })

  it('R2: installTools 无 qqbotContext 服务 → DENY', async () => {
    await enableDenyQq()
    const registered: ToolDefinition[] = []
    const ctx = fakeCtx({
      tools: {
        register: (definition: ToolDefinition) => {
          registered.push(definition)
          return () => undefined
        },
      },
    })
    installTools(ctx, service, service.linkage)
    const search = registered.find((definition) => definition.name === 'memory_search')
    if (search === undefined) throw new Error('memory_search 未注册')
    await expect(
      search.execute({ query: 'PowerShell' }, { agent: agentFor('no-svc-tool', {}) }),
    ).rejects.toThrow(/refused/)
  })

  it('R1: 服务在但未登记会话 → installTools DENY', async () => {
    await enableDenyQq()
    const registered: ToolDefinition[] = []
    const ctx = fakeCtx({
      qqbotContext: mockQqContext(),
      tools: {
        register: (definition: ToolDefinition) => {
          registered.push(definition)
          return () => undefined
        },
      },
    })
    installTools(ctx, service, service.linkage)
    const search = registered.find((definition) => definition.name === 'memory_search')
    if (search === undefined) throw new Error('memory_search 未注册')
    await expect(
      search.execute({ query: 'PowerShell' }, { agent: agentFor('unregistered-tool', {}) }),
    ).rejects.toThrow(/refused/)
  })

  it('无 linkage 的 buildToolDefinitions（未挂 ownerGate）保持旧兼容', async () => {
    await enableDenyQq()
    const search = buildToolDefinitions(service).find((entry) => entry.name === 'memory_search')
    expect(search).toBeDefined()
    if (search === undefined) throw new Error('memory_search 未注册')
    const result = (await search.execute(
      { query: 'PowerShell' },
      { agent: agentFor('qq-no-linkage', { origin: 'qq' }) },
    )) as { count: number }
    expect(result.count).toBe(0)
    expect(service.qqLinkageReport().counters.toolsBlocked).toBe(0)
  })

  it('installTools 把 Owner Gate + linkage 传到注册后的工具定义上', async () => {
    await enableDenyQq()
    const registered: ToolDefinition[] = []
    const ctx = fakeCtx({
      qqbotContext: mockQqContext({ qqOwnerId: null }),
      tools: {
        register: (definition: ToolDefinition) => {
          registered.push(definition)
          return () => undefined
        },
      },
    })
    const result = installTools(ctx, service, service.linkage)
    expect(result.registered).toEqual(['memory_search', 'memory_get', 'memory_save', 'memory_forget'])

    const search = registered.find((definition) => definition.name === 'memory_search')
    if (search === undefined) throw new Error('memory_search 未注册')
    await expect(
      search.execute({ query: 'PowerShell' }, { agent: agentFor('qq-unbound-installed', {}) }),
    ).rejects.toThrow(/refused/)
  })

  it('工具无执行上下文（无 sessionId）→ DENY，不放行', async () => {
    await enableDenyQq()
    const search = searchTool(service.linkage, mockQqContext())
    await expect(search.execute({ query: 'PowerShell' }, {})).rejects.toThrow(/refused/)
  })
})
