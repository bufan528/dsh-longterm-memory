/**
 * QQ 接入联动：三个宿主执行点的拦截集成测试。
 *
 * 用假 Cordis 上下文 + 真实 `MemoryService`（真实临时仓库）验证联动策略真的
 * 落在执行上，而不只是页面上的一排开关：
 *
 * 1. 常驻记忆注入：`systemPrompt.section().text({ agent })` 在 QQ 会话返回空串，
 *    桌面会话返回既有常驻文本，无上下文的预览调用不计入拦截；
 * 2. 会话结束写回：`session/event` 的 `turn/end` 对 QQ 会话只产出收件箱候选，
 *    索引里不出现 active 记忆；桌面会话照旧自动落盘；
 * 3. 模型工具：`buildToolDefinitions(service, linkage)` / `installTools` 在执行前
 *    拦截 QQ 会话的 `memory_search`，桌面会话正常返回。
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

/** 取出常驻分区的 `text` 回调，并原样模拟宿主传入的 context 形状。 */
function captureStandingText(ctx: FakeCtx, linkage = service.linkage): (context?: unknown) => string {
  const sections: Record<string, unknown>[] = []
  const ctxWithPrompt = fakeCtx({
    ...ctx.services,
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
async function saveStandingMemory(): Promise<void> {
  await service.save({
    type: 'profile',
    title: '用户背景',
    summary: '后端工程师。',
    tags: [],
    confidence: 'high',
    importance: 90,
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

  it('桌面会话 → 返回既有常驻文本，不计数', async () => {
    await saveStandingMemory()
    await enableDenyQq()
    const text = captureStandingText(fakeCtx())

    const output = text({ agent: agentFor('desktop-standing', { origin: 'desktop' }) })
    expect(output).toContain('Long-term memory')
    expect(output).toContain('用户背景')
    expect(service.qqLinkageReport().counters.standingBlocked).toBe(0)
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

  it('未配置 QQ 标记时即使策略启用也不会误伤任何会话', async () => {
    await saveStandingMemory()
    await service.setQqLinkage({ mode: 'deny-qq' })
    const text = captureStandingText(fakeCtx())

    const output = text({ agent: agentFor('unmarked', { origin: 'qq' }) })
    expect(output).toContain('用户背景')
    expect(service.qqLinkageReport().counters.standingBlocked).toBe(0)
  })

  it('mode=off 时 QQ 上下文照旧得到常驻文本（回归）', async () => {
    await saveStandingMemory()
    const text = captureStandingText(fakeCtx())

    const output = text({ agent: agentFor('qq-off', { origin: 'qq' }) })
    expect(output).toContain('用户背景')
    expect(service.qqLinkageReport().counters.standingBlocked).toBe(0)
  })
})

/* ------------------------------------------------------ 写回执行点 */

describe('installTurnExtraction 的写回拦截', () => {
  function installExtraction(linkage = service.linkage): FakeCtx {
    const ctx = fakeCtx()
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

  it('桌面会话的 turn/end 照旧直接落盘为 active 记忆', async () => {
    await enableDenyQq()
    const ctx = installExtraction()
    const session = { id: 'desktop-session', header: { origin: 'desktop' } }

    emitSessionEvents(ctx, session, [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: ASSERTED_MESSAGE }] } },
      { type: 'turn/end', data: { turn: 1, reason: 'stop' } },
    ])

    await waitFor(() => service.search({ limit: 50 }).total > 0)
    expect(service.qqLinkageReport().counters.writesForcedInbox).toBe(0)
  })

  it('无标记的会话不会被误判为 QQ（deny-qq 下照常直接落盘）', async () => {
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

  it('mode=off 时 QQ 标记存在也不会强制收件箱（回归）', async () => {
    await service.setQqLinkage({ writeMode: 'direct', qqMarkers: markers({ origins: ['qq'] }) })
    const ctx = installExtraction()
    const session = { id: 'qq-off-session', header: { origin: 'qq' } }

    emitSessionEvents(ctx, session, [
      { type: 'user/message', data: { content: [{ type: 'text', text: ASSERTED_MESSAGE }] } },
      { type: 'turn/end', data: { turn: 1 } },
    ])

    await waitFor(() => service.search({ limit: 50 }).total > 0)
    expect(service.qqLinkageReport().counters.writesForcedInbox).toBe(0)
  })
})

/* ------------------------------------------------------ 模型工具执行点 */

describe('记忆工具执行前的拦截', () => {
  function searchTool(linkage = service.linkage): ToolDefinition {
    const definition = buildToolDefinitions(service, linkage).find((entry) => entry.name === 'memory_search')
    expect(definition).toBeDefined()
    if (definition === undefined) throw new Error('memory_search 未注册')
    return definition
  }

  it('QQ 会话调用 memory_search 被拒绝（抛普通工具错误）', async () => {
    await enableDenyQq()
    const search = searchTool()
    await expect(
      search.execute({ query: 'PowerShell' }, { agent: agentFor('qq-tool', { origin: 'qq' }) }),
    ).rejects.toThrow(/refused/)
    expect(service.qqLinkageReport().counters.toolsBlocked).toBe(1)
  })

  it('桌面会话调用 memory_search 正常返回结果', async () => {
    await saveStandingMemory()
    await enableDenyQq()
    const search = searchTool()
    const result = (await search.execute(
      { query: '用户背景' },
      { agent: agentFor('desktop-tool', { origin: 'desktop' }) },
    )) as { count: number; results: { title: string }[] }
    expect(result.count).toBeGreaterThan(0)
    expect(result.results[0]?.title).toBe('用户背景')
    expect(service.qqLinkageReport().counters.toolsBlocked).toBe(0)
  })

  it('没有 linkage 时工具行为完全不变（既有调用方兼容）', async () => {
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

  it('installTools 把 linkage 传到注册后的工具定义上', async () => {
    await enableDenyQq()
    const registered: ToolDefinition[] = []
    const ctx = fakeCtx({ tools: { register: (definition: ToolDefinition) => { registered.push(definition); return () => undefined } } })
    const result = installTools(ctx, service, service.linkage)
    expect(result.registered).toEqual(['memory_search', 'memory_get', 'memory_save', 'memory_forget'])

    const search = registered.find((definition) => definition.name === 'memory_search')
    if (search === undefined) throw new Error('memory_search 未注册')
    await expect(
      search.execute({ query: 'PowerShell' }, { agent: agentFor('qq-installed', { origin: 'qq' }) }),
    ).rejects.toThrow(/refused/)
  })

  it('工具调用没有执行上下文时按「未识别来源」处理，deny-qq 下仍放行', async () => {
    await enableDenyQq()
    const search = searchTool()
    const result = (await search.execute({ query: 'PowerShell' }, {})) as { count: number }
    expect(result.count).toBe(0)
    expect(service.qqLinkageReport().counters.toolsBlocked).toBe(0)
  })
})
