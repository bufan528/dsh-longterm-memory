/**
 * The Cordis **client** plugin: the bundle's CommonJS exports.
 *
 * `apply` does exactly three things, in this order:
 * 1. installs the plugin's `<style>` element inside an effect;
 * 2. binds the *optional* `locale` service (the panel works without it);
 * 3. registers the first-level sidebar entry and the matching `main` page.
 *
 * Both registrations live inside their own `ctx.slots.inject`, which is what
 * makes the panel survive the sidebar's own activation order: the callback runs
 * when the slot is declared and is disposed when the declaration collapses.
 *
 * The module is also idempotent across a reload of the *same* instance, so a
 * second `apply` can never double-register a slot entry (the registry rejects
 * duplicates, and that error would blank the panel).
 *
 * @module dsh-longterm-memory/client
 */

import type { ClientContext } from './context.js'
import { NS, bindLocaleService, t } from './i18n.js'
import { MemoryPage } from './memory-page.js'
import { MemoryPanelIcon, PANEL_ID } from './sidebar-entry.js'
import { CLIENT_CSS } from './styles.js'

/** The package id; must equal the `window.__ModuleLoader__.load` id. */
const PACKAGE_ID = 'dsh-longterm-memory'

/** Cordis plugin name. */
export const name = 'longterm-memory'

/** Required services: the slot registry is a hard dependency. */
export const inject = ['slots']

/** Guards against a second `apply` on the same module instance (HMR safety). */
let applied = false

/**
 * Create the plugin's `<style>` element and return the disposer that removes it.
 *
 * Nothing else is ever appended to the document: the module system already tags
 * an untagged `<style>` with `data-plugin`, and we tag it ourselves so a reload
 * can identify it unambiguously.
 */
function installStyles(): () => void {
  const scope = globalThis as { document?: Document }
  const doc = scope.document
  if (doc === undefined) return () => undefined
  const style = doc.createElement('style')
  style.setAttribute('data-plugin', PACKAGE_ID)
  style.textContent = CLIENT_CSS
  doc.head.appendChild(style)
  return () => {
    style.remove()
  }
}

/**
 * Install the panel.
 *
 * @param ctx - the Cordis client context; only `slots`, `effect` and the
 * optional `locale` injection are used.
 */
export function apply(ctx: ClientContext): void {
  if (applied) return
  applied = true

  ctx.effect(() => installStyles(), `${PACKAGE_ID}: styles`)

  ctx.inject(['locale'], (scoped) => {
    const dispose = bindLocaleService(scoped.locale)
    if (dispose === undefined) return
    scoped.effect(() => dispose, `${PACKAGE_ID}: locale dictionary`)
  })

  // 1) First-level left-sidebar entry. Its `id` is the address the sidebar
  //    dispatches through `layout.selectPanel(id)`.
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => t('panel'),
      },
      MemoryPanelIcon,
    ),
  )

  // 2) The management page, keyed by the same id, so the click opens it instead
  //    of a new chat.
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      },
      MemoryPage,
    ),
  )
}
