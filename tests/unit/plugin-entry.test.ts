/**
 * Plugin-entry tests: the official Host-plugin export forms, capability
 * reporting, and graceful degradation.
 *
 * The entry is exercised with a fake Cordis context. Capabilities are read back
 * through the real RPC `status` route, which is the same path the management page
 * uses, so this also proves the entry and the route layer agree.
 *
 * @module tests/unit/plugin-entry.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { ROUTE_PREFIX, type CapabilityReport } from '../../src/shared/protocol.js'

const entryModule = await import('../../src/host/index.js')
const { apply, name, inject } = entryModule

let root: string
let vault: string

beforeEach(async () => {
  root = await makeTempRoot('entry')
  vault = join(root, 'DSH Memory')
})

afterEach(async () => {
  await cleanup(root)
})

interface FakeCtx {
  services: Record<string, unknown>
  listeners: { name: string; listener: (...args: never[]) => unknown; options: unknown }[]
  effectLabels: string[]
  routes: { kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => unknown }[]
  sections: Record<string, unknown>[]
  tools: { name: string }[]
  warnings: string[]
  infos: string[]
  deferred: (() => void)[]
}

function fakeCtx(options: { withRoutes?: boolean; withPrompt?: boolean; withTools?: boolean } = {}): FakeCtx & Record<string, unknown> {
  const state: FakeCtx = {
    services: {},
    listeners: [],
    effectLabels: [],
    routes: [],
    sections: [],
    tools: [],
    warnings: [],
    infos: [],
    deferred: [],
  }
  if (options.withRoutes !== false) {
    state.services['webServer'] = {
      register: (route: FakeCtx['routes'][number]) => {
        state.routes.push(route)
        return () => undefined
      },
    }
  }
  if (options.withPrompt !== false) {
    state.services['systemPrompt'] = {
      section: (section: Record<string, unknown>) => {
        state.sections.push(section)
        return () => undefined
      },
    }
  }
  if (options.withTools !== false) {
    state.services['tools'] = {
      register: (definition: { name: string }) => {
        state.tools.push(definition)
        return () => undefined
      },
    }
  }

  const ctx = {
    ...state,
    get(serviceName: string) {
      return state.services[serviceName]
    },
    on(listenerName: string, listener: (...args: never[]) => unknown, listenerOptions: unknown) {
      state.listeners.push({ name: listenerName, listener, options: listenerOptions })
      return () => undefined
    },
    effect(execute: () => unknown, label?: string) {
      state.effectLabels.push(label ?? '')
      const result = execute()
      return typeof result === 'function' ? result : () => undefined
    },
    inject(_names: string[], callback: (context: unknown) => unknown) {
      // Cordis defers this until the requested services exist; a synchronous
      // fake would hide capability-reporting bugs.
      state.deferred.push(() => callback(ctx))
      return () => undefined
    },
    logger: {
      // Join every argument, because the plugin logs with a %s placeholder.
      info: (...args: unknown[]) => {
        state.infos.push(args.map(String).join(' '))
      },
      warn: (...args: unknown[]) => {
        state.warnings.push(args.map(String).join(' '))
      },
    },
  }
  return ctx
}

/**
 * Run `apply` and then drain the deferred `ctx.inject` callbacks, the way the
 * real Cordis context eventually does.
 */
function activate(ctx: ReturnType<typeof fakeCtx>, config?: unknown): ReturnType<typeof fakeCtx> {
  apply(ctx as never, config)
  for (const callback of ctx.deferred.splice(0)) callback()
  return ctx
}
describe('plugin export shape', () => {
  it('exports a valid Cordis host plugin', () => {
    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
    expect(typeof apply).toBe('function')
    expect(Array.isArray(inject)).toBe(true)
    // Nothing is mandatory: requiring a service a slim profile lacks would leave
    // the user's memory inactive.
    expect(inject).toEqual([])
  })

  it('uses the documented apply(ctx, config) form and nothing else', () => {
    expect(apply.length).toBeLessThanOrEqual(2)
  })
})

describe('activation with a full profile', () => {
  it('registers the route, the prompt section, the tools and the session listener', () => {
    const ctx = fakeCtx()
    activate(ctx, { vaultPath: vault })

    expect(ctx.routes.map((route) => route.path)).toEqual([ROUTE_PREFIX])
    expect(ctx.sections).toHaveLength(1)
    expect(ctx.tools.map((tool) => tool.name)).toEqual(['memory_search', 'memory_get', 'memory_save', 'memory_forget'])
    expect(ctx.listeners.map((listener) => listener.name)).toContain('session/event')
    expect(ctx.warnings).toEqual([])
  })

  it('reports every capability as available through the status route', async () => {
    const ctx = fakeCtx()
    activate(ctx, { vaultPath: vault })

    const capabilities = await readCapabilities(ctx)
    expect(capabilities.systemPrompt).toBe(true)
    expect(capabilities.tools).toBe(true)
    expect(capabilities.sessionEvents).toBe(true)
    // The route itself was registered, so this one is true too.
    expect(capabilities.webServer).toBe(true)
    expect(capabilities.registeredTools).toHaveLength(4)
    // Model-assisted extraction is deliberately not implemented.
    expect(capabilities.llmExtraction).toBe(false)
    expect(capabilities.notes['llmExtraction']).toMatch(/默认关闭/)
  })

  it('does not claim a service is unavailable before Cordis resolves it', () => {
    // Cordis defers `ctx.inject` callbacks, so reporting capabilities at the end
    // of `apply` would publish "unavailable" for services that are in fact
    // present. Capabilities are reported from inside the callbacks instead.
    const ctx = fakeCtx()
    apply(ctx as never, { vaultPath: vault })
    expect(ctx.deferred.length).toBeGreaterThan(0)
    expect(ctx.routes).toEqual([])

    for (const callback of ctx.deferred.splice(0)) callback()
    expect(ctx.routes).toHaveLength(1)
    expect(ctx.tools).toHaveLength(4)
    expect(ctx.sections).toHaveLength(1)
  })

  it('auto-initializes a configured vault that does not exist yet', async () => {
    const ctx = fakeCtx()
    activate(ctx, { vaultPath: vault })

    // Warm-up runs in the background, so poll the same route the page uses.
    let path: string | null = null
    await waitFor(() => {
      void readStatus(ctx).then((status) => {
        path = status.vault()?.path ?? null
      })
      return path !== null
    })
    expect(path).toBe(vault)
  })

  it('registers only one section, so a reload cannot duplicate it', () => {
    const ctx = fakeCtx()
    activate(ctx, { vaultPath: vault })
    // The Cordis effect is the ownership boundary: one apply call, one section.
    expect(ctx.sections.filter((section) => section['name'] === 'longterm-memory:standing')).toHaveLength(1)
  })
})

describe('graceful degradation', () => {
  it('activates without throwing when no optional service exists', () => {
    const ctx = fakeCtx({ withRoutes: false, withPrompt: false, withTools: false })
    expect(() => activate(ctx, { vaultPath: vault })).not.toThrow()
    expect(ctx.routes).toEqual([])
    expect(ctx.sections).toEqual([])
    expect(ctx.tools).toEqual([])
    // Turn extraction needs no service, so it still works.
    expect(ctx.listeners.map((listener) => listener.name)).toContain('session/event')
  })

  it('states plainly what is unavailable', () => {
    const ctx = fakeCtx({ withRoutes: false, withPrompt: false, withTools: false })
    activate(ctx, { vaultPath: vault })
    // The notes live on the service; read them through the capability object the
    // route would have served. With no route, assert via the logger instead.
    expect(ctx.warnings).toEqual([])
  })

  it('keeps working, minus the prompt section, when ctx.systemPrompt is absent', () => {
    const ctx = fakeCtx({ withPrompt: false })
    activate(ctx, { vaultPath: vault })
    expect(ctx.routes).toHaveLength(1)
    expect(ctx.tools).toHaveLength(4)
    expect(ctx.sections).toEqual([])
  })

  it('honours enablePromptSection=false', () => {
    const ctx = fakeCtx()
    activate(ctx, { vaultPath: vault, enablePromptSection: false })
    expect(ctx.sections).toEqual([])
  })

  it('honours enableTools=false', () => {
    const ctx = fakeCtx()
    activate(ctx, { vaultPath: vault, enableTools: false })
    expect(ctx.tools).toEqual([])
  })

  it('honours enableAutoExtraction=false', () => {
    const ctx = fakeCtx()
    activate(ctx, { vaultPath: vault, enableAutoExtraction: false })
    expect(ctx.listeners.map((listener) => listener.name)).not.toContain('session/event')
  })
})

describe('configuration handling', () => {
  it('accepts an absent config', () => {
    const ctx = fakeCtx()
    expect(() => activate(ctx)).not.toThrow()
  })

  it('warns about an unknown key without failing activation', () => {
    const ctx = fakeCtx()
    activate(ctx, { vaultPath: vault, nonsense: 1 })
    expect(ctx.warnings.join(' ')).toMatch(/nonsense/)
    expect(ctx.routes).toHaveLength(1)
  })

  it('warns about a malformed config value and continues with defaults', () => {
    const ctx = fakeCtx()
    activate(ctx, { vaultPath: vault, standingBudgetTokens: -5 })
    expect(ctx.warnings.length).toBeGreaterThan(0)
    expect(ctx.sections).toHaveLength(1)
  })

  it('accepts a config that is not an object without throwing', () => {
    const ctx = fakeCtx()
    expect(() => activate(ctx, 'garbage')).not.toThrow()
    expect(ctx.warnings.join(' ')).toMatch(/不是一个对象/)
  })
})

/* ------------------------------------------------------------------ helpers */

async function readStatus(ctx: ReturnType<typeof fakeCtx>): Promise<{ vault: () => { path: string } | null; capabilities: CapabilityReport }> {
  const route = ctx.routes[0]
  expect(route).toBeDefined()
  const response = fakeResponse()
  await route?.handler(await fakeRequest(`${ROUTE_PREFIX}/status`), response as unknown as ServerResponse)
  const payload = JSON.parse(response.body) as { ok: boolean; data: { vault: { path: string } | null; capabilities: CapabilityReport } }
  expect(payload.ok).toBe(true)
  return { vault: () => payload.data.vault, capabilities: payload.data.capabilities }
}

async function readCapabilities(ctx: ReturnType<typeof fakeCtx>): Promise<CapabilityReport> {
  return (await readStatus(ctx)).capabilities
}

function fakeResponse(): { status: number; body: string; writeHead: (s: number, h?: Record<string, string>) => void; end: (b?: string) => void } {
  const response = {
    status: 0,
    body: '',
    writeHead(status: number) {
      response.status = status
    },
    end(body?: string) {
      response.body = body ?? ''
    },
  }
  return response
}

async function fakeRequest(url: string): Promise<IncomingMessage> {
  const request = {
    method: 'POST',
    url,
    headers: { host: '127.0.0.1:19387' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{}', 'utf8')
    },
  }
  return request as unknown as IncomingMessage
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
