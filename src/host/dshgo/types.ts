/**
 * Minimal, dependency-free typings for the DSH Go native-plugin bridge.
 *
 * This plugin must never import `@dsh-go/plugin-kit` at runtime: the SDK is not
 * published to npm and a third-party plugin's module scope is not guaranteed to
 * resolve it. The bridge is reached through Cordis (`ctx.inject(['dshGo'])`)
 * with duck-typed surfaces, exactly like the rest of this plugin's host API.
 *
 * @module dsh-longterm-memory/host/dshgo/types
 */

/** Locale hint coming from the app; may be `zh`, `zh_CN`, `en-US`, etc. */
export interface NativeCaps {
  protocol?: number
  app?: string
  locale?: string
  surfaces?: string[]
  components?: string[]
}

export interface NativeScope {
  sessionId?: string
  turnId?: string
  messageId?: string
  callId?: string
  /** `composer.actions` with `wants: ["draft"]`. */
  draft?: string
  /** `composer.actions` with `wants: ["clipboard"]`. */
  clipboard?: string
  /** `message.actions` with `wants: ["message"]`. */
  message?: string
}

export interface NativeEvent {
  surface?: string
  id?: string
  action?: string
  value?: unknown
  locale?: string
}

/** A JSON view node. Kept loose on purpose: the component catalogue is large. */
export type NativeView = Record<string, unknown>

/** An effect returned from an action handler. */
export type NativeEffect = Record<string, unknown>

export type NativeActionHandler = (
  scope: NativeScope,
  event: NativeEvent,
) => NativeEffect | NativeEffect[] | undefined

export interface NativePanelSpec {
  view: (scope: NativeScope, caps: NativeCaps) => NativeView
  data?: (scope: NativeScope, emit: (data: unknown) => void, caps: NativeCaps) => unknown
  actions?: Record<string, NativeActionHandler>
}

export interface NativeStripData {
  text?: string
  icon?: string
  tone?: 'good' | 'warn' | 'bad' | 'info' | 'muted'
}

/** The `ctx.dshGo` surface this plugin uses. */
export interface DshGoBridgeLike {
  on?: (id: string, handler: NativeActionHandler) => unknown
  panel: (id: string, spec: NativePanelSpec) => unknown
  strip?: (id: string, data: (scope: NativeScope, emit: (data: NativeStripData) => void, caps: NativeCaps) => unknown) => unknown
  refresh?: (id?: string, scope?: NativeScope) => unknown
  turnNote?: (id: string, data: (scope: NativeScope, emit: (data: unknown) => void) => unknown) => unknown
}

/** The Cordis context surface needed to install the native bridge. */
export interface DshGoContextLike {
  get: (name: string) => unknown
  inject: (names: string[], callback: (context: DshGoContextLike) => unknown) => unknown
  on?: (name: string, listener: (...args: never[]) => unknown) => unknown
  effect: (execute: () => unknown, label?: string) => unknown
  logger?: { info: (message: string, ...rest: unknown[]) => void; warn: (message: string, ...rest: unknown[]) => void }
}

/** A compact graph summary for the native panel (the visual graph is WebView-only). */
export interface NativeGraphSummary {
  nodes: number
  edges: number
  auto: number
  isolated: number
  components: number
  communities: number
  hubs: { id: string; title: string; degree: number }[]
}

/** Snapshot used by every native view; built off-engine, stored in memory. */
export interface NativeSnapshot {
  ready: boolean
  vaultPath: string | null
  totalMemories: number
  activeMemories: number
  pendingCandidates: number
  problemMemories: number
  recent: { id: string; title: string; type: string; status: string; updatedAt: string }[]
  inbox: { id: string; title: string; type: string; confidence: string; importance: number; decision: string; refused?: string }[]
  reminders: { id: string; title: string; dueAt: string | null; done: boolean }[]
  tags: { tag: string; count: number }[]
  graph: NativeGraphSummary
  capabilities: { tools: boolean; systemPrompt: boolean; webServer: boolean; sessionEvents: boolean }
}

export const EMPTY_SNAPSHOT: NativeSnapshot = {
  ready: false,
  vaultPath: null,
  totalMemories: 0,
  activeMemories: 0,
  pendingCandidates: 0,
  problemMemories: 0,
  recent: [],
  inbox: [],
  reminders: [],
  tags: [],
  graph: { nodes: 0, edges: 0, auto: 0, isolated: 0, components: 0, communities: 0, hubs: [] },
  capabilities: { tools: false, systemPrompt: false, webServer: false, sessionEvents: false },
}
