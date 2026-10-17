/**
 * Bundle-level verification for the browser half.
 *
 * The test reads the *built* `lib/client.js`, evaluates it in `node:vm` exactly
 * the way the DSH shell would (a classic script that calls
 * `window.__ModuleLoader__.load`), and then exercises the returned factory with
 * a mock Cordis context. It proves the three things that cannot be proven by
 * type-checking alone:
 *
 * 1. the script only registers a lazy factory, and that factory never reaches
 *    for a name outside its own scope;
 * 2. the resulting CommonJS exports really are a Cordis plugin
 *    (`apply` + `inject`);
 * 3. `apply` performs exactly two `slots.register` calls — the sidebar entry and
 *    the main page — and a second `apply` on the same instance adds none.
 *
 * `react` and `react/jsx-runtime` are stubbed with the minimum the bundle may
 * rely on, which also pins down that the client code never depends on React
 * internals.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE_PATH = resolve(HERE, '..', '..', 'lib', 'client.js')
const PACKAGE_ID = 'dsh-longterm-memory'
const PANEL_ID = 'longterm-memory'
const NS = 'longterm-memory'

/** One `slots.register(options, component)` call, as the mock records it. */
interface Registration {
  options: Record<string, unknown>
  component: unknown
}

/** The module-loader registration the bundle is expected to make. */
interface Captured {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/** A style element created through the document stub. */
interface FakeStyle {
  tagName: string
  attributes: Record<string, string>
  textContent: string
  setAttribute: (name: string, value: string) => void
  remove: () => void
}

/** The result of evaluating the bundle once. */
interface LoadedBundle {
  captured: Captured
  appendedToHead: FakeStyle[]
}

/** A `createElement`-only React stub; the bundle must not need React internals. */
function makeReactStub(): Record<string, unknown> {
  const createElement = (type: unknown, props: unknown, ...children: unknown[]): unknown => ({
    type,
    props: props ?? {},
    children,
  })
  return {
    createElement,
    Fragment: 'react.fragment',
    createContext: (initial: unknown) => ({ Provider: initial, Consumer: initial, __initial: initial }),
    useContext: () => ({}),
    useState: (initial: unknown) => [initial, () => undefined],
    useEffect: () => undefined,
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: unknown) => (typeof fn === 'function' ? fn() : undefined),
    useRef: (initial: unknown) => ({ current: initial }),
  }
}

/** A `react/jsx-runtime` stub matching the automatic JSX transform. */
function makeJsxRuntimeStub(): Record<string, unknown> {
  const jsx = (type: unknown, props: unknown): unknown => ({ type, props })
  return { jsx, jsxs: jsx, Fragment: 'react.fragment' }
}

/**
 * A `require` that answers only the allowed externals and throws loudly
 * otherwise, mirroring the module loader's own behaviour.
 */
function makeRequire(): (specifier: string) => unknown {
  const modules: Record<string, unknown> = {
    react: makeReactStub(),
    'react/jsx-runtime': makeJsxRuntimeStub(),
  }
  return (specifier: string) => {
    if (Object.prototype.hasOwnProperty.call(modules, specifier)) return modules[specifier]
    throw new Error(`client-bundle: unexpected require(${JSON.stringify(specifier)})`)
  }
}

/** Read `lib/client.js` and evaluate it in a fresh VM context. */
function loadBundle(): LoadedBundle {
  const code = readFileSync(BUNDLE_PATH, 'utf8')
  const appendedToHead: FakeStyle[] = []
  const holder: { registration?: Captured } = {}

  const documentStub = {
    head: {
      appendChild: (node: FakeStyle) => {
        appendedToHead.push(node)
      },
    },
    createElement: (tagName: string): FakeStyle => {
      const node: FakeStyle = {
        tagName: tagName.toUpperCase(),
        attributes: {},
        textContent: '',
        setAttribute(name: string, value: string) {
          node.attributes[name] = value
        },
        remove() {
          const index = appendedToHead.indexOf(node)
          if (index >= 0) appendedToHead.splice(index, 1)
        },
      }
      return node
    },
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }

  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load: (registration: Captured) => {
          holder.registration = registration
        },
      },
    },
    document: documentStub,
    console,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('client-bundle: no network in this test')),
  }

  vm.runInNewContext(code, sandbox, { filename: BUNDLE_PATH })

  const registration = holder.registration
  if (registration === undefined) {
    throw new Error('client-bundle: the script never called window.__ModuleLoader__.load')
  }
  return { captured: registration, appendedToHead }
}

/** What {@link makeMockContext} records. */
interface MockContext {
  ctx: Record<string, unknown>
  registrations: Registration[]
  injections: string[]
  effects: unknown[]
  localeRegistrations: { ns: string; dictionaries: Record<string, Record<string, string>> }[]
  localeBinds: string[]
}

/** A Cordis client context good enough for `apply`, recording what it receives. */
function makeMockContext(options: { withLocale?: boolean } = {}): MockContext {
  const registrations: Registration[] = []
  const injections: string[] = []
  const effects: unknown[] = []
  const localeRegistrations: { ns: string; dictionaries: Record<string, Record<string, string>> }[] = []
  const localeBinds: string[] = []

  const locale = {
    register: (ns: string, dictionaries: Record<string, Record<string, string>>) => {
      localeRegistrations.push({ ns, dictionaries })
      return () => undefined
    },
    bind: (ns: string) => {
      localeBinds.push(ns)
      return (key: string) => `T:${key}`
    },
  }

  const effect = (fn: () => unknown): unknown => {
    const disposer = fn()
    effects.push(disposer)
    return disposer
  }

  const ctx: Record<string, unknown> = {
    slots: {
      inject: (ownerKey: string, callback: () => unknown) => {
        injections.push(ownerKey)
        return callback()
      },
      register: (slotOptions: Record<string, unknown>, component: unknown) => {
        registrations.push({ options: slotOptions, component })
        return () => undefined
      },
    },
    effect,
    inject: (_deps: readonly string[], callback: (scoped: unknown) => void) => {
      if (options.withLocale !== true) return
      callback({ locale, effect })
    },
  }

  return { ctx, registrations, injections, effects, localeRegistrations, localeBinds }
}

/** Call `apply` with the mock context. */
function runApply(plugin: Record<string, unknown>, ctx: Record<string, unknown>): void {
  const apply = plugin.apply
  if (typeof apply !== 'function') throw new Error('client-bundle: the exported plugin has no apply()')
  ;(apply as (context: unknown) => void)(ctx)
}

describe('lib/client.js', () => {
  it('is a classic script that only registers a lazy factory', () => {
    const { captured } = loadBundle()
    expect(captured.id).toBe(PACKAGE_ID)
    expect(typeof captured.factory).toBe('function')
  })

  it('starts with the module-loader call', () => {
    const firstLine = readFileSync(BUNDLE_PATH, 'utf8').split('\n')[0]
    expect(firstLine).toBe('window.__ModuleLoader__.load({')
  })

  it('exports a Cordis plugin with apply and inject', () => {
    const { captured } = loadBundle()
    const plugin = captured.factory(makeRequire())
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.inject).toEqual(['slots'])
    expect(plugin.name).toBe('longterm-memory')
  })

  it('registers the sidebar entry and the main page exactly once', () => {
    const { captured } = loadBundle()
    const plugin = captured.factory(makeRequire())
    const mock = makeMockContext()

    runApply(plugin, mock.ctx)
    runApply(plugin, mock.ctx) // a second apply on the same instance must be a no-op

    expect(mock.injections).toEqual(['sidebar.panellist', 'main'])
    expect(mock.registrations).toHaveLength(2)

    const panel = mock.registrations[0]
    expect(panel).toBeDefined()
    expect(panel?.options.name).toBe('sidebar.panellist')
    expect(panel?.options.id).toBe(PANEL_ID)
    expect(panel?.options.order).toBe(20)
    expect(typeof panel?.options.label).toBe('function')
    expect((panel?.options.label as () => string)()).toBe('长期记忆')
    expect(typeof panel?.component).toBe('function')

    const main = mock.registrations[1]
    expect(main).toBeDefined()
    expect(main?.options.name).toBe('main')
    expect(main?.options.key).toBe(PANEL_ID)
    expect(main?.options.locale).toBe(NS)
    expect(typeof main?.component).toBe('function')
  })

  it('installs exactly one plugin-owned style element inside an effect', () => {
    const { captured, appendedToHead } = loadBundle()
    const plugin = captured.factory(makeRequire())
    const mock = makeMockContext()
    runApply(plugin, mock.ctx)

    expect(appendedToHead).toHaveLength(1)
    const style = appendedToHead[0]
    expect(style?.tagName).toBe('STYLE')
    expect(style?.attributes['data-plugin']).toBe(PACKAGE_ID)
    expect(style?.textContent).toContain('.lmv-page')
    expect(mock.effects.length).toBeGreaterThanOrEqual(1)

    // Every colour comes from a theme token; the only literals are the fallbacks
    // inside `var(--dsw-alias-*, …)`.
    const css = style?.textContent ?? ''
    const withoutTokens = css.replace(/var\([^)]*\)/g, '')
    expect(withoutTokens).not.toMatch(/#[0-9a-fA-F]{3}/)
    expect(withoutTokens).not.toMatch(/rgba?\(/)
    expect(css).toMatch(/var\(--dsw-alias-bg-base,\s*#[0-9a-f]{6}\)/)
  })

  it('works without the optional locale service', () => {
    const { captured } = loadBundle()
    const plugin = captured.factory(makeRequire())
    const mock = makeMockContext()
    runApply(plugin, mock.ctx)

    expect(mock.localeRegistrations).toHaveLength(0)
    expect(mock.localeBinds).toHaveLength(0)
    expect(mock.registrations).toHaveLength(2)
  })

  it('binds the locale service when present and prefers its translator', () => {
    const { captured } = loadBundle()
    const plugin = captured.factory(makeRequire())
    const mock = makeMockContext({ withLocale: true })
    runApply(plugin, mock.ctx)

    expect(mock.localeRegistrations).toHaveLength(1)
    expect(mock.localeRegistrations[0]?.ns).toBe(NS)
    expect(mock.localeRegistrations[0]?.dictionaries.zh?.panel).toBe('长期记忆')
    expect(mock.localeRegistrations[0]?.dictionaries.en?.panel).toBe('Long-term memory')
    expect(mock.localeBinds).toEqual([NS])

    const panel = mock.registrations[0]
    expect((panel?.options.label as () => string)()).toBe('T:panel')
  })
})
