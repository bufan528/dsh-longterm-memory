/**
 * Hand-written types for the small slice of the Cordis **client** context this
 * plugin touches.
 *
 * The DSH web shell ships no type package a third-party plugin may depend on, and
 * `@deepseek-ai/*` packages must never be `require()`d at runtime (only `react`
 * and `react/jsx-runtime` are in the platform seed table). Declaring the used
 * surface here keeps the client half type-checked without either problem.
 *
 * @module dsh-longterm-memory/client/context
 */

import type { ComponentType } from 'react'

/** Options accepted by `slots.register`. */
export interface SlotRegisterOptions {
  /** Slot key being filled, e.g. `sidebar.panellist` or `main`. */
  name: string
  /** List-slot entry id; for `sidebar.panellist` this is also the main-panel key. */
  id?: string
  /** Keyed-slot key; for `main` this is the sidebar entry id it is addressed by. */
  key?: string
  /** Ascending order inside a list slot. */
  order?: number
  /** Label thunk; re-read on every projection so a language change is picked up. */
  label?: () => string
  /** Locale namespace the entry's texts come from. */
  locale?: string
}

/** A component the slot registry can render. */
export type SlotComponent = ComponentType<any>

/** A teardown handle. */
export type Disposer = () => void

/** The `slots` service, as used by a third-party panel. */
export interface SlotsService {
  /**
   * Run `callback` once the slot named by `ownerKey` has been declared, and again
   * every time that declaration comes back. Registrations made inside the
   * callback are disposed when the owner's declaration collapses.
   */
  inject(ownerKey: string, callback: () => Disposer | void): Disposer | void
  /** Register `component` into the slot named by `options.name`. */
  register(options: SlotRegisterOptions, component: SlotComponent): Disposer
}

/** The `locale` service, as used by a third-party panel. */
export interface LocaleService {
  /** Add dictionaries for `ns`; throws when that namespace + locale already exists. */
  register(ns: string, dictionaries: Record<string, Record<string, string>>): Disposer
  /** Bind a translator for `ns` that reads the active locale live. */
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
}

/** A context that may carry the optional `locale` service. */
export interface LocaleScopedContext extends ClientContext {
  locale?: LocaleService
}

/** The Cordis client context surface this plugin relies on. */
export interface ClientContext {
  /** The slot registry. Declared as a hard requirement by `inject`. */
  slots: SlotsService
  /** Run `callback` now and collect its disposer for teardown. */
  effect(callback: () => Disposer | void, label?: string): Disposer | void
  /**
   * Run `callback` with a context holding `deps`, whenever they are all present.
   * Used for the *optional* `locale` service: the callback simply never fires
   * when it is absent.
   */
  inject(deps: readonly string[], callback: (scoped: LocaleScopedContext) => void): Disposer | void
}

/** Props a slot component receives; only a few are meaningful to this panel. */
export interface SlotProps {
  /** Owner-provided slot props (for `sidebar.panellist` this is `size`/`active`). */
  [key: string]: unknown
}
