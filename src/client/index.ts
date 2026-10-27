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

import type { ClientContext, LocaleScopedContext } from './context.js'
import { NS, bindLocaleService, t } from './i18n.js'
import { normalizeInventoryRow, setPluginInventoryBridge, type PluginInventoryRow } from './host-inventory.js'
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
 * Install the optional host inventory bridge (`remote.pluginInventory`).
 *
 * The dependency is declared exactly as the host's own client plugins do
 * (`remote` + the dotted namespace); when either is absent the callback never
 * fires and the bridge stays unavailable, so the QQ page degrades to the HTTP
 * probe instead of assuming anything.
 *
 * The namespace is resolved **lazily on every call** on purpose: the Remote
 * namespaces are mounted by the host's api-remotes client, which can finish
 * after our plugin applies. Checking `list` once at install time would silently
 * disable the bridge on a slow boot.
 */
function installInventoryBridge(scoped: LocaleScopedContext): void {
  const remote = (scoped as unknown as { remote?: Record<string, unknown> }).remote
  if (remote === undefined || remote === null) return
  const resolveNamespace = (): { list: () => Promise<unknown> } | null => {
    const namespace = remote['pluginInventory'] as { list?: () => Promise<unknown> } | undefined
    if (namespace === undefined || typeof namespace.list !== 'function') return null
    return { list: namespace.list.bind(namespace) }
  }
  setPluginInventoryBridge({
    // Declared available as soon as `remote` exists; whether the namespace has
    // mounted yet is verified on the first call, and a failure there is reported
    // to the page as "unavailable" instead of pretending.
    available: true,
    note: '已接入宿主 pluginInventory Remote：可区分「未安装」与「已安装但停用/加载失败」。',
    list: async () => {
      const namespace = resolveNamespace()
      if (namespace === null) throw new Error('宿主 pluginInventory Remote 尚未就绪')
      const result = (await namespace.list()) as { ok?: unknown; value?: unknown; error?: { message?: unknown } } | null
      if (result !== null && typeof result === 'object' && result.ok === false) {
        const message = typeof result.error?.message === 'string' ? result.error.message : 'pluginInventory/list 返回失败'
        throw new Error(message)
      }
      const payload = result !== null && typeof result === 'object' && result.ok === true ? result.value : result
      const entries = (payload as { entries?: unknown } | null)?.entries
      if (!Array.isArray(entries)) throw new Error('pluginInventory/list 响应缺少 entries')
      return entries.map(normalizeInventoryRow).filter((row): row is PluginInventoryRow => row !== null)
    },
  })
}

/**
 * Install the panel.
 *
 * @param ctx - the Cordis client context; only `slots`, `effect` and the
 * optional `locale` / `remote.pluginInventory` injections are used.
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

  // Optional host bridge: the plugin inventory lets the QQ page tell "not
  // installed" apart from "installed but disabled / failed to load". It is
  // strictly optional — when the host does not expose the Remote the page falls
  // back to the read-only HTTP probe and says so. A host that does not know the
  // dotted service name must not take the panel down, hence the guard.
  try {
    ctx.inject(['remote', 'remote.pluginInventory'], (scoped) => {
      installInventoryBridge(scoped)
    })
  } catch {
    /* optional capability: the page degrades to the HTTP probe */
  }

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
