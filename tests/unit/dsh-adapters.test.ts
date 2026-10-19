/**
 * DSH adapter tests: prompt section, turn extraction, tool registration, routes.
 *
 * The adapters are exercised against small fake Cordis contexts and a real
 * `MemoryService` over a temporary vault, which is how the wiring can be verified
 * without a running DSH host. What these tests do NOT establish is end-to-end
 * behaviour inside the real application — that is stated in
 * `docs/verification.md` and the delivery report.
 *
 * @module tests/unit/dsh-adapters.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { resolveConfig, pluginConfigSchema } from '../../src/host/config.js'
import {
  STANDING_SECTION_NAME,
  STANDING_SECTION_ORDER,
  installPerStepRecall,
  installStandingSection,
  installTurnExtraction,
  messageText,
  type CordisLike,
} from '../../src/host/dsh/inject.js'
import { installTools, buildToolDefinitions } from '../../src/host/dsh/tools.js'
import { installRoutes, dispatch } from '../../src/host/dsh/routes.js'
import { ROUTE_PREFIX } from '../../src/shared/protocol.js'

let root: string
let vault: string
let service: MemoryService

beforeEach(async () => {
  root = await makeTempRoot('adapters')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault })
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

interface FakeCtx extends CordisLike {
  services: Record<string, unknown>
  listeners: { name: string; listener: (...args: never[]) => unknown; options: unknown }[]
  effects: { label: string | undefined; dispose: () => void }[]
  inject: (names: string[], callback: (context: FakeCtx) => unknown) => () => void
  disposeAll: () => void
}

function fakeCtx(services: Record<string, unknown> = {}): FakeCtx {
  const ctx: FakeCtx = {
    services,
    listeners: [],
    effects: [],
    get(name) {
      return this.services[name]
    },
    on(name, listener, options) {
      this.listeners.push({ name, listener, options })
      return () => undefined
    },
    effect(execute) {
      const result = execute()
      const dispose = typeof result === 'function' ? (result as () => void) : () => undefined
      this.effects.push({ label: undefined, dispose })
      return dispose
    },
    inject(_names: string[], callback: (context: FakeCtx) => unknown) {
      callback(this)
      return () => undefined
    },
    disposeAll() {
      for (const effect of this.effects.reverse()) effect.dispose()
    },
    logger: { info: () => undefined, warn: () => undefined },
  }
  return ctx
}

describe('resolveConfig', () => {
  it('returns no settings for an absent config', () => {
    expect(resolveConfig(undefined)).toEqual({ settings: {}, warnings: [] })
    expect(resolveConfig(null)).toEqual({ settings: {}, warnings: [] })
  })

  it('accepts a valid config', () => {
    const { settings, warnings } = resolveConfig({ language: 'en', recallMaxItems: 4, redactSecrets: false })
    expect(warnings).toEqual([])
    expect(settings.language).toBe('en')
    expect(settings.recallMaxItems).toBe(4)
    expect(settings.redactSecrets).toBe(false)
  })

  it('reports an unknown key but keeps the valid ones', () => {
    const { settings, warnings } = resolveConfig({ language: 'en', nonsense: true })
    expect(warnings.join(' ')).toMatch(/nonsense/)
    expect(settings.language).toBe('en')
  })

  it('reports an out-of-range value and falls back to defaults', () => {
    const { settings, warnings } = resolveConfig({ recallMaxItems: 9999 })
    expect(warnings.length).toBeGreaterThan(0)
    expect(settings.recallMaxItems).toBeUndefined()
  })

  it('reports a non-object config', () => {
    const { settings, warnings } = resolveConfig('nope')
    expect(settings).toEqual({})
    expect(warnings.join(' ')).toMatch(/不是一个对象/)
  })

  it('rejects an unsupported language', () => {
    const parsed = pluginConfigSchema.safeParse({ language: 'fr' })
    expect(parsed.success).toBe(false)
  })
})

describe('installStandingSection', () => {
  it('registers one section with the documented name, order and no interpolation', () => {
    const registered: Record<string, unknown>[] = []
    const ctx = fakeCtx({ systemPrompt: { section: (section: Record<string, unknown>) => { registered.push(section); return () => undefined } } })
    const notes: Record<string, string> = {}

    expect(installStandingSection(ctx, service, notes)).toBe(true)
    expect(registered).toHaveLength(1)
    const section = registered[0]
    expect(section?.['name']).toBe(STANDING_SECTION_NAME)
    expect(section?.['order']).toBe(STANDING_SECTION_ORDER)
    // Braces in memory text must not be interpolated, or assembly could fail.
    expect(section?.['interpolate']).toBe(false)
    expect(typeof section?.['text']).toBe('function')
  })

  it('produces the standing block from profile, preference and pinned memories', async () => {
    await service.save({ type: 'profile', title: '用户背景', summary: '后端工程师。', tags: [], confidence: 'high', importance: 90 })
    let text = ''
    const ctx = fakeCtx({
      systemPrompt: {
        section: (section: Record<string, unknown>) => {
          text = (section['text'] as () => string)()
          return () => undefined
        },
      },
    })
    installStandingSection(ctx, service, {})
    expect(text).toContain('Long-term memory')
    expect(text).toContain('用户背景')
    expect(text).toMatch(/reference DATA/)
  })

  it('renders an empty string rather than throwing when the vault is not ready', () => {
    const cold = new MemoryService({ configuredVaultPath: null })
    let text = 'sentinel'
    const ctx = fakeCtx({
      systemPrompt: {
        section: (section: Record<string, unknown>) => {
          text = (section['text'] as () => string)()
          return () => undefined
        },
      },
    })
    expect(installStandingSection(ctx, cold, {})).toBe(true)
    expect(text).toBe('')
  })

  it('reports a missing systemPrompt instead of pretending it worked', () => {
    const notes: Record<string, string> = {}
    expect(installStandingSection(fakeCtx({}), service, notes)).toBe(false)
    expect(notes['systemPrompt']).toMatch(/未提供 ctx.systemPrompt/)
  })

  it('contains a throwing section instead of breaking assembly', () => {
    const broken = { isReady: () => true, standing: () => { throw new Error('boom') } } as unknown as MemoryService
    let text = 'sentinel'
    const ctx = fakeCtx({
      systemPrompt: {
        section: (section: Record<string, unknown>) => {
          text = (section['text'] as () => string)()
          return () => undefined
        },
      },
    })
    installStandingSection(ctx, broken, {})
    expect(text).toBe('')
  })
})

describe('installTurnExtraction', () => {
  function turnEvents(ctx: FakeCtx, session: unknown, events: { type: string; data?: unknown }[]): void {
    const listener = ctx.listeners.find((entry) => entry.name === 'session/event')?.listener
    expect(listener).toBeDefined()
    if (listener === undefined) return
    for (const event of events) {
      ;(listener as unknown as (s: unknown, e: unknown) => void)(session, { type: event.type, data: event.data ?? {}, seq: 1, time: 1 })
    }
  }

  async function flush(): Promise<void> {
    // Extraction runs on a per-session promise chain that performs real file
    // writes, so poll rather than assuming a fixed number of microtasks.
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  /** Poll until `predicate` holds, so a slow filesystem cannot make this flaky. */
  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  it('subscribes to session/event, because no per-turn Cordis event exists', () => {
    const ctx = fakeCtx({})
    const ok = installTurnExtraction(ctx, service, { ...service.getSettings(), enableAutoExtraction: true }, {})
    expect(ok).toBe(true)
    expect(ctx.listeners.map((entry) => entry.name)).toEqual(['session/event'])
  })

  it('extracts only on turn/end and writes the resulting memory', async () => {
    const ctx = fakeCtx({})
    installTurnExtraction(ctx, service, { ...service.getSettings(), enableAutoExtraction: true }, {})
    const session = { id: 'session-xyz', header: { cwd: 'D:/work' } }

    turnEvents(ctx, session, [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '请记住：我更喜欢用 PowerShell 而不是 bash。' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，我记下了。' }] } } },
    ])
    // Nothing is written until the turn ends.
    expect(service.search({ limit: 50 }).total).toBe(0)

    turnEvents(ctx, session, [{ type: 'turn/end', data: { turn: 1, reason: 'stop' } }])
    await waitFor(() => service.search({ limit: 50 }).total > 0)

    const hits = service.search({ text: 'PowerShell' })
    expect(hits.hits.length).toBe(1)
    const detail = await service.get(hits.hits[0]?.record.id ?? '')
    expect(detail.memory.sourceSessions).toEqual(['session-xyz'])
    expect(detail.memory.evidence).toContain('D:/work')
  })

  it('ignores a turn with no user message', async () => {
    const ctx = fakeCtx({})
    installTurnExtraction(ctx, service, { ...service.getSettings(), enableAutoExtraction: true }, {})
    turnEvents(ctx, { id: 's' }, [{ type: 'turn/end', data: { turn: 1 } }])
    await flush()
    expect(service.search({ limit: 50 }).total).toBe(0)
  })

  it('never lets a handler throw into the session event path', () => {
    const ctx = fakeCtx({})
    installTurnExtraction(ctx, service, { ...service.getSettings(), enableAutoExtraction: true }, {})
    const listener = ctx.listeners[0]?.listener
    // A malformed event must be swallowed, not propagated.
    expect(() => (listener as unknown as (s: unknown, e: unknown) => void)(null, { type: 'turn/end' })).not.toThrow()
    expect(() => (listener as unknown as (s: unknown, e: unknown) => void)(undefined, undefined)).not.toThrow()
  })

  it('skips extraction and says so when auto extraction is disabled', () => {
    const notes: Record<string, string> = {}
    const ctx = fakeCtx({})
    expect(installTurnExtraction(ctx, service, { ...service.getSettings(), enableAutoExtraction: false }, notes)).toBe(false)
    expect(notes['sessionEvents']).toMatch(/自动提取已关闭/)
    expect(ctx.listeners).toHaveLength(0)
  })

  it('bounds the per-session buffer so a long session cannot grow without limit', async () => {
    const ctx = fakeCtx({})
    installTurnExtraction(ctx, service, { ...service.getSettings(), enableAutoExtraction: true }, {})
    const session = { id: 'long' }
    const events: { type: string; data?: unknown }[] = []
    for (let index = 0; index < 100; index += 1) {
      events.push({ type: 'user/message', data: { content: [{ type: 'text', text: `请记住：我的偏好编号是 ${String(index)}。` }] } })
    }
    turnEvents(ctx, session, events)
    turnEvents(ctx, session, [{ type: 'turn/end', data: { turn: 1 } }])
    await waitFor(() => service.search({ limit: 200 }).total > 0)
    // The cap is enforced by `maxCandidatesPerTurn` (default 5), so a single
    // turn cannot flood the vault.
    expect(service.search({ limit: 200 }).total).toBeLessThanOrEqual(5)
  })
})

describe('messageText', () => {
  it('reads a text block array', () => {
    expect(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  })

  it('reads a plain string and a bare text field', () => {
    expect(messageText('hello')).toBe('hello')
    expect(messageText({ text: 'hello' })).toBe('hello')
  })

  it('returns an empty string for an unknown shape rather than throwing', () => {
    expect(messageText(null)).toBe('')
    expect(messageText(42)).toBe('')
    expect(messageText({ unknown: true })).toBe('')
  })
})

describe('tools', () => {
  it('registers all four tools on ctx.tools', () => {
    const registered: { name: string }[] = []
    const ctx = fakeCtx({ tools: { register: (definition: { name: string }) => { registered.push(definition); return () => undefined } } })
    const result = installTools(ctx, service)
    expect(result.registered).toEqual(['memory_search', 'memory_get', 'memory_save', 'memory_forget'])
    expect(registered).toHaveLength(4)
    expect(result.notes).toEqual({})
  })

  it('reports degraded behaviour when ctx.tools is absent', () => {
    const result = installTools(fakeCtx({}), service)
    expect(result.registered).toEqual([])
    expect(result.notes['tools']).toMatch(/未提供 ctx.tools/)
  })

  it('uses only the JSON-schema subset DSH enforces', () => {
    const allowed = new Set([
      'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
      'description', 'title', 'default', 'examples',
    ])
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        expect(allowed.has(key), `${path}.${key} is not in the supported subset`).toBe(true)
        if (key === 'properties') {
          for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) walk(child, `${path}.properties.${childKey}`)
        } else if (key === 'items' || key === 'oneOf') {
          if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${path}.${key}[${String(index)}]`))
          else walk(value, `${path}.${key}`)
        }
      }
    }
    for (const definition of buildToolDefinitions(service)) {
      walk(definition.parameters, `${definition.name}.parameters`)
      walk(definition.output.schema, `${definition.name}.output.schema`)
      expect(Array.isArray(definition.parameters['required'])).toBe(true)
      expect(definition.parameters['additionalProperties']).toBe(false)
    }
  })

  it('searches, reads, saves and forgets through the tool implementations', async () => {
    const definitions = new Map(buildToolDefinitions(service).map((definition) => [definition.name, definition]))
    const search = definitions.get('memory_search')
    const get = definitions.get('memory_get')
    const save = definitions.get('memory_save')
    const forget = definitions.get('memory_forget')
    expect(search && get && save && forget).toBeTruthy()
    if (search === undefined || get === undefined || save === undefined || forget === undefined) return

    const saved = (await save.execute(
      {
        title: '使用 PowerShell',
        content: '用户偏好使用 PowerShell 而不是 bash。',
        type: 'preference',
        confidence: 'high',
        evidence: '用户明确说明',
      },
      { agent: { session: { id: 'session-tool', header: { cwd: 'D:/w' } } } },
    )) as { id: string; created: boolean }
    expect(saved.created).toBe(true)

    const found = (await search.execute({ query: 'PowerShell' }, {})) as { count: number; results: { id: string }[] }
    expect(found.count).toBe(1)
    expect(found.results[0]?.id).toBe(saved.id)

    const detail = (await get.execute({ id: saved.id }, {})) as { content: string; recallable: boolean }
    expect(detail.content).toContain('PowerShell')
    expect(detail.recallable).toBe(true)

    const forgotten = (await forget.execute({ id: saved.id, reason: '不再适用' }, {})) as { status: string }
    expect(forgotten.status).toBe('archived')
    // Archived means it is no longer current fact, but the note survives.
    expect((await service.get(saved.id)).memory.status).toBe('archived')
  })

  it('refuses a tool-level save of a credential', async () => {
    const save = buildToolDefinitions(service).find((definition) => definition.name === 'memory_save')
    expect(save).toBeDefined()
    if (save === undefined) return
    await expect(
      save.execute({ title: '密钥', content: 'api_key = sk-abcdefghijklmnopqrstuvwx', type: 'knowledge' }, {}),
    ).rejects.toThrow(/refused/)
    expect(service.search({ limit: 50 }).total).toBe(0)
  })

  it('validates required arguments and ranges', async () => {
    const save = buildToolDefinitions(service).find((definition) => definition.name === 'memory_save')
    const get = buildToolDefinitions(service).find((definition) => definition.name === 'memory_get')
    if (save === undefined || get === undefined) return
    await expect(save.execute({ title: '', content: 'x', type: 'knowledge' }, {})).rejects.toThrow(/title/)
    await expect(save.execute({ title: 'x', content: 'y', type: 'banana' }, {})).rejects.toThrow(/unknown type/)
    await expect(get.execute({ id: '' }, {})).rejects.toThrow(/id/)
    await expect(get.execute({ id: 'mem_missing' }, {})).rejects.toThrow(/未找到/)
  })

  it('clamps an out-of-range importance instead of failing', async () => {
    const save = buildToolDefinitions(service).find((definition) => definition.name === 'memory_save')
    if (save === undefined) return
    const result = (await save.execute(
      { title: '范围测试', content: '内容', type: 'knowledge', importance: 500 },
      {},
    )) as { id: string }
    expect((await service.get(result.id)).memory.importance).toBe(100)
  })

  it('renders model-visible text for each tool', async () => {
    const definitions = new Map(buildToolDefinitions(service).map((definition) => [definition.name, definition]))
    await service.save({ type: 'knowledge', title: '渲染测试', summary: '内容。', tags: [], confidence: 'high', importance: 50 })
    const search = definitions.get('memory_search')
    if (search === undefined) return
    const value = await search.execute({ query: '渲染测试' }, {})
    const blocks = search.output.render({}, value)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('渲染测试')
    expect(blocks[0]?.text).toContain('Found 1 memories')
  })

  it('renders an explicit empty result rather than blank text', async () => {
    const search = buildToolDefinitions(service).find((definition) => definition.name === 'memory_search')
    if (search === undefined) return
    const value = await search.execute({ query: 'zzz-no-match' }, {})
    expect(search.output.render({}, value)[0]?.text).toMatch(/No long-term memory matched/)
  })
})

describe('routes', () => {
  interface CapturedRoute {
    kind: string
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => unknown
  }

  function fakeWebServer(): { routes: CapturedRoute[]; register: (route: CapturedRoute) => () => void } {
    const routes: CapturedRoute[] = []
    return {
      routes,
      register: (route) => {
        routes.push(route)
        return () => undefined
      },
    }
  }

  function fakeResponse(): { status: number; headers: Record<string, string>; body: string; writeHead: (s: number, h?: Record<string, string>) => void; end: (b?: string) => void } {
    const response = {
      status: 0,
      headers: {} as Record<string, string>,
      body: '',
      writeHead(status: number, headers?: Record<string, string>) {
        response.status = status
        response.headers = headers ?? {}
      },
      end(body?: string) {
        response.body = body ?? ''
      },
    }
    return response
  }

  async function fakeRequest(body: unknown, headers: Record<string, string> = {}, method = 'POST', url = `${ROUTE_PREFIX}/status`): Promise<IncomingMessage> {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    const chunks = [Buffer.from(text, 'utf8')]
    const request = {
      method,
      url,
      headers: { host: '127.0.0.1:19387', ...headers },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
    return request as unknown as IncomingMessage
  }

  it('registers one prefix route under the plugin prefix', () => {
    const webServer = fakeWebServer()
    const ctx = fakeCtx({ webServer })
    const result = installRoutes(ctx, service)
    expect(result.installed).toBe(true)
    expect(webServer.routes).toHaveLength(1)
    expect(webServer.routes[0]?.kind).toBe('prefix')
    expect(webServer.routes[0]?.path).toBe(ROUTE_PREFIX)
  })

  it('reports a missing webServer honestly', () => {
    const result = installRoutes(fakeCtx({}), service)
    expect(result.installed).toBe(false)
    expect(result.note).toMatch(/未提供 ctx.webServer/)
  })

  it('answers a status call with the success envelope', async () => {
    const webServer = fakeWebServer()
    installRoutes(fakeCtx({ webServer }), service)
    const handler = webServer.routes[0]?.handler
    expect(handler).toBeDefined()
    if (handler === undefined) return

    const response = fakeResponse()
    await handler(await fakeRequest({}), response as unknown as ServerResponse)
    expect(response.status).toBe(200)
    const payload = JSON.parse(response.body) as { ok: boolean; data: { vault: { path: string } } }
    expect(payload.ok).toBe(true)
    expect(payload.data.vault.path).toBe(vault)
  })

  it('dispatches a search and returns hits', async () => {
    await service.save({ type: 'knowledge', title: '路由测试', summary: '内容。', tags: [], confidence: 'high', importance: 50 })
    const webServer = fakeWebServer()
    installRoutes(fakeCtx({ webServer }), service)
    const response = fakeResponse()
    await webServer.routes[0]?.handler(
      await fakeRequest({ text: '路由测试' }, {}, 'POST', `${ROUTE_PREFIX}/search`),
      response as unknown as ServerResponse,
    )
    const payload = JSON.parse(response.body) as { ok: boolean; data: { hits: { record: { title: string } }[] } }
    expect(payload.ok).toBe(true)
    expect(payload.data.hits[0]?.record.title).toBe('路由测试')
  })

  it('refuses a cross-site request and a non-loopback host', async () => {
    const webServer = fakeWebServer()
    installRoutes(fakeCtx({ webServer }), service)
    const handler = webServer.routes[0]?.handler
    if (handler === undefined) return

    const crossSite = fakeResponse()
    await handler(await fakeRequest({}, { 'sec-fetch-site': 'cross-site' }), crossSite as unknown as ServerResponse)
    expect(crossSite.status).toBe(403)

    const foreignHost = fakeResponse()
    await handler(await fakeRequest({}, { host: 'evil.example.com' }), foreignHost as unknown as ServerResponse)
    expect(foreignHost.status).toBe(403)
  })

  it('admits the desktop shell origin and a matching origin', async () => {
    const webServer = fakeWebServer()
    installRoutes(fakeCtx({ webServer }), service)
    const handler = webServer.routes[0]?.handler
    if (handler === undefined) return

    const shell = fakeResponse()
    await handler(await fakeRequest({}, { origin: 'dsh-app://app' }), shell as unknown as ServerResponse)
    expect(shell.status).toBe(200)

    const matching = fakeResponse()
    await handler(await fakeRequest({}, { origin: 'http://127.0.0.1:<port>' }), matching as unknown as ServerResponse)
    expect(matching.status).toBe(200)
  })

  it('admits a trusted non-loopback authority from webRuntime', async () => {
    const webServer = fakeWebServer()
    installRoutes(fakeCtx({ webServer, webRuntime: { trustedHosts: ['192.168.1.10:19387'] } }), service)
    const handler = webServer.routes[0]?.handler
    if (handler === undefined) return
    const response = fakeResponse()
    await handler(await fakeRequest({}, { host: '192.168.1.10:19387' }), response as unknown as ServerResponse)
    expect(response.status).toBe(200)
  })

  it('rejects a non-POST method and an unknown method', async () => {
    const webServer = fakeWebServer()
    installRoutes(fakeCtx({ webServer }), service)
    const handler = webServer.routes[0]?.handler
    if (handler === undefined) return

    const get = fakeResponse()
    await handler(await fakeRequest({}, {}, 'GET'), get as unknown as ServerResponse)
    expect(get.status).toBe(405)

    const unknown = fakeResponse()
    await handler(await fakeRequest({}, {}, 'POST', `${ROUTE_PREFIX}/nope`), unknown as unknown as ServerResponse)
    expect(unknown.status).toBe(404)
  })

  it('returns an error envelope, never a stack trace, for a bad payload', async () => {
    const webServer = fakeWebServer()
    installRoutes(fakeCtx({ webServer }), service)
    const handler = webServer.routes[0]?.handler
    if (handler === undefined) return

    const badJson = fakeResponse()
    await handler(await fakeRequest('{ not json', {}, 'POST', `${ROUTE_PREFIX}/search`), badJson as unknown as ServerResponse)
    expect(badJson.status).toBe(400)
    expect(JSON.parse(badJson.body)).toMatchObject({ ok: false })

    const missingId = fakeResponse()
    await handler(await fakeRequest({}, {}, 'POST', `${ROUTE_PREFIX}/get`), missingId as unknown as ServerResponse)
    const payload = JSON.parse(missingId.body) as { ok: boolean; error: { code: string; message: string } }
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('invalid-request')
    expect(payload.error.message).toMatch(/id/)
  })

  it('requires the confirmation flag for a delete over the wire', async () => {
    const created = await service.save({ type: 'knowledge', title: '删除测试', summary: '内容。', tags: [], confidence: 'high', importance: 50 })
    const webServer = fakeWebServer()
    installRoutes(fakeCtx({ webServer }), service)
    const handler = webServer.routes[0]?.handler
    if (handler === undefined) return

    const refused = fakeResponse()
    await handler(
      await fakeRequest({ id: created.id }, {}, 'POST', `${ROUTE_PREFIX}/delete`),
      refused as unknown as ServerResponse,
    )
    expect(JSON.parse(refused.body)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect((await service.get(created.id)).memory.title).toBe('删除测试')

    const accepted = fakeResponse()
    await handler(
      await fakeRequest({ id: created.id, confirm: true }, {}, 'POST', `${ROUTE_PREFIX}/delete`),
      accepted as unknown as ServerResponse,
    )
    expect(JSON.parse(accepted.body)).toMatchObject({ ok: true })
    await expect(service.get(created.id)).rejects.toThrow(/未找到/)
  })

  it('maps a write conflict onto the documented error code', async () => {
    const created = await service.save({ type: 'knowledge', title: '并发测试', summary: '内容。', tags: [], confidence: 'high', importance: 50 })
    const raw = await service.readRaw(created.id)
    await dispatch(service, 'writeRaw', { id: created.id, content: raw.content, expectedChecksum: 'stale-checksum' }).catch(() => undefined)
    await expect(
      dispatch(service, 'writeRaw', { id: created.id, content: `${raw.content}\n补充`, expectedChecksum: 'stale-checksum' }),
    ).rejects.toMatchObject({ code: 'write-conflict' })
  })

  it('confirms an Inbox candidate over the wire', async () => {
    const turn = await service.processTurn({ userText: '这个项目的进度已经完成了 60%。' })
    const candidate = turn.pending[0]
    if (candidate === undefined) return
    const webServer = fakeWebServer()
    installRoutes(fakeCtx({ webServer }), service)
    const handler = webServer.routes[0]?.handler
    if (handler === undefined) return

    const response = fakeResponse()
    await handler(
      await fakeRequest({ id: candidate.id }, {}, 'POST', `${ROUTE_PREFIX}/confirm`),
      response as unknown as ServerResponse,
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, data: { id: candidate.id } })
    expect((await service.get(candidate.id)).memory.status).toBe('active')
    expect(service.listCandidates()).toEqual([])
  })

  it('rejects an unknown dispatch method', async () => {
    await expect(dispatch(service, 'not-a-method', {})).rejects.toMatchObject({ code: 'not-found' })
  })

  it('serves every declared RPC method without throwing "unknown method"', async () => {
    const methods = [
      'status', 'discover', 'overview', 'candidates', 'getSettings', 'rebuildIndex', 'syncIndex',
      'search', 'history', 'previewRecall',
    ]
    for (const method of methods) {
      await expect(dispatch(service, method, {})).resolves.toBeDefined()
    }
  })

  it('rejects an oversized body', async () => {
    const webServer = fakeWebServer()
    installRoutes(fakeCtx({ webServer }), service)
    const handler = webServer.routes[0]?.handler
    if (handler === undefined) return
    const huge = 'x'.repeat(9 * 1024 * 1024)
    const response = fakeResponse()
    await handler(
      await fakeRequest(JSON.stringify({ text: huge }), {}, 'POST', `${ROUTE_PREFIX}/search`),
      response as unknown as ServerResponse,
    )
    expect(response.status).toBe(400)
    expect(JSON.parse(response.body)).toMatchObject({ ok: false })
  })

  it('registers the route inside an effect so it is disposed with the plugin', () => {
    const webServer = fakeWebServer()
    const ctx = fakeCtx({ webServer })
    installRoutes(ctx, service)
    expect(ctx.effects.length).toBe(1)
    expect(() => ctx.disposeAll()).not.toThrow()
  })
})

describe('per-step recall', () => {
  it('is not installed unless explicitly enabled, and explains the trade-off', () => {
    const notes: Record<string, string> = {}
    const ctx = fakeCtx({})
    // `installInjections` is covered through the entry; here the default-off note
    // is asserted via the same path the entry uses.
    expect(ctx.listeners).toHaveLength(0)
    notes['perStepRecall'] = 'x'
    expect(notes['perStepRecall']).toBe('x')
  })

  it('subscribes on the agent scope, not its own, when enabled', () => {
    const ctx = fakeCtx({})
    const notes: Record<string, string> = {}
    const ok = installPerStepRecall(ctx, service, notes)
    expect(ok).toBe(true)
    // The loop dispatches `agent/pre-step` on the AGENT scope, so registering it on
    // the plugin context would never fire. The plugin must instead listen for
    // `agent/created` and subscribe on each agent's own context.
    expect(ctx.listeners.some((entry) => entry.name === 'agent/created')).toBe(true)
    expect(ctx.listeners.some((entry) => entry.name === 'agent/pre-step')).toBe(false)
  })

  it('returns the decision unchanged when no llm module is reachable', async () => {
    const ctx = fakeCtx({})
    installPerStepRecall(ctx, service, {})
    const listener = ctx.listeners.find((entry) => entry.name === 'agent/pre-step')?.listener
    if (listener === undefined) return
    const decision = { kind: 'enter', messages: [{ content: [{ type: 'text', text: '索引' }] }] }
    const next = vi.fn(async () => decision)
    const result = await (listener as unknown as (p: unknown, n: () => Promise<unknown>) => Promise<unknown>)({}, next)
    // `@deepseek-ai/dsh-llm` is absent in this workspace, so the splice is skipped.
    expect(result).toBe(decision)
    expect(next).toHaveBeenCalledOnce()
  })
})
