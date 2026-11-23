/**
 * Install the DSH Go native-plugin bridge.
 *
 * Everything here is strictly opt-in: `ctx.inject(['dshGo'], …)` only fires on a
 * host that actually exposes the bridge (a DSH Go local engine). On the desktop
 * web client the callback never runs, so the plugin behaves exactly as before.
 *
 * Data comes from the same in-process `MemoryService` the web RPC uses — no
 * second code path, no HTTP, no extra file reads. The snapshot is rebuilt on a
 * slow poll and after write actions; view functions only read the cached value,
 * which keeps them synchronous and within the bridge's 3-second callback window.
 *
 * @module dsh-longterm-memory/host/dshgo/bridge
 */

import type { NativeSnapshot, NativeView, DshGoBridgeLike, DshGoContextLike, NativeCaps, NativeEffect } from './types.js'
import { EMPTY_SNAPSHOT } from './types.js'
import { graphPanelView, inboxPanelView, overviewPanelView, remindersPanelView, stripData, toolCard, toolResultView } from './views.js'
import { analyseLinkGraph } from '../../shared/links.js'
import type { MemoryService } from '../core/service.js'

/** A reminder row as read from any of the vault/plugin reminder surfaces. */
export interface NativeReminderRow {
  id?: string
  title?: string
  dueAt?: string
  status?: string
  done?: boolean
}

/** Duck-typed async reminder list; `ReminderService.list()` fits this shape. */
export interface ReminderSurfaceLike {
  list: () => Promise<NativeReminderRow[]> | NativeReminderRow[] | { reminders?: NativeReminderRow[] }
}

export interface DshGoBridgeDeps {
  service: MemoryService
  /** Optional: supplies reminders for the reminders panel. */
  getReminders?: () => ReminderSurfaceLike | undefined
  /** Poll interval for refreshing the cached snapshot. Default 15 s. */
  refreshMs?: number
  logger?: { info: (message: string, ...rest: unknown[]) => void; warn: (message: string, ...rest: unknown[]) => void }
}

/** Panel ids — must match the `dshGo.contributes.panels` ids in package.json. */
export const NATIVE_PANELS = ['overview', 'inbox', 'reminders', 'graph'] as const
export type NativePanelId = (typeof NATIVE_PANELS)[number]

/** Composer capsule ids — must match `dshGo.contributes.composer.actions`. */
export const NATIVE_CAPSULE_SAVE = 'memory-save'
export const NATIVE_CAPSULE_SEARCH = 'memory-search'
export const NATIVE_MESSAGE_SAVE = 'message-save'

/** Tool names whose cards are installed via `presentationMeta`. */
export const CARD_TOOLS = [
  'memory_search', 'memory_get', 'memory_save', 'memory_forget',
  'reminder_list', 'reminder_create', 'reminder_complete',
  'sticker_pick', 'sticker_ingest',
] as const

/** Attach a native result card to a tool definition, without changing its text result. */
export function withNativeCard(
  definition: { name: string; output: Record<string, unknown> },
): void {
  if (!(CARD_TOOLS as readonly string[]).includes(definition.name)) return
  const tool = definition.name
  const output = definition.output as {
    presentationMeta?: (args: unknown, value: unknown) => Record<string, unknown>
  }
  // A defensive wrapper: if the bridge is not present on this host the view is
  // still produced but simply ignored by the host; it can never fail the call.
  // `presentationMeta` gets no locale argument from DSH, so cards default to
  // the primary audience language (zh); the manifest-level panels are bilingual.
  output.presentationMeta = toolCard((args, value) => toolResultView(tool, { locale: 'zh' }, args, value))
}

async function toArray(value: unknown): Promise<NativeReminderRow[]> {
  const resolved = await value
  if (Array.isArray(resolved)) return resolved as NativeReminderRow[]
  if (resolved !== null && typeof resolved === 'object' && Array.isArray((resolved as { reminders?: unknown }).reminders)) {
    return (resolved as { reminders: NativeReminderRow[] }).reminders
  }
  return []
}

/** Build one in-memory snapshot from the service's synchronous/async surfaces. */
export async function buildSnapshot(deps: DshGoBridgeDeps): Promise<NativeSnapshot> {
  const { service } = deps
  const snapshot: NativeSnapshot = {
    ...EMPTY_SNAPSHOT,
    capabilities: { ...EMPTY_SNAPSHOT.capabilities },
  }
  try {
    snapshot.ready = service.isReady()
    snapshot.vaultPath = service.getVaultPath()
    const caps = service.getCapabilities()
    snapshot.capabilities = {
      tools: caps.tools, systemPrompt: caps.systemPrompt,
      webServer: caps.webServer, sessionEvents: caps.sessionEvents,
    }
    if (!snapshot.ready) return snapshot

    const overview = await service.overview()
    snapshot.totalMemories = overview.vault.stats.total
    snapshot.activeMemories = overview.vault.stats.byStatus['active'] ?? 0
    snapshot.pendingCandidates = overview.vault.stats.pending
    snapshot.problemMemories = overview.vault.stats.conflicts + overview.vault.stats.stale
    snapshot.recent = overview.recentCreated.slice(0, 12).map((hit) => ({
      id: hit.record.id, title: hit.record.title, type: hit.record.type,
      status: hit.record.status, updatedAt: hit.record.updatedAt,
    }))
    snapshot.problemMemories = overview.problems.length
    snapshot.tags = overview.tags.slice(0, 8)
    const graph = service.links()
    const analysis = analyseLinkGraph(graph)
    snapshot.graph = {
      nodes: graph.stats.nodes,
      edges: graph.stats.edges,
      auto: graph.stats.auto,
      isolated: analysis.isolated.length,
      components: analysis.components.length,
      communities: analysis.clusters.length,
      hubs: analysis.hubs.slice(0, 6).map((id) => {
        const node = graph.nodes.find((candidate) => candidate.id === id)
        return { id, title: node?.title ?? id, degree: analysis.degree[id] ?? 0 }
      }),
    }
    snapshot.inbox = overview.pending.slice(0, 12).map((hit) => ({
      id: hit.record.id, title: hit.record.title, type: hit.record.type,
      confidence: String(hit.record.confidence ?? ''), importance: hit.record.importance ?? 0,
      decision: 'inbox',
    }))
    // `listCandidates()` is the authoritative inbox (the overview's pending
    // slice is a preview). Prefer it when present.
    const candidates = service.listCandidates()
    if (candidates.length > 0) {
      snapshot.pendingCandidates = candidates.length
      snapshot.inbox = candidates.slice(0, 12).map((c) => ({
        id: c.id, title: c.title, type: c.type, confidence: c.confidence,
        importance: c.importance, decision: typeof c.decision?.action === 'string' ? c.decision.action : '',
        ...(c.refused === undefined ? {} : { refused: c.refused }),
      }))
    }
    const reminderSurface = deps.getReminders?.()
    const reminders = reminderSurface === undefined ? [] : await toArray(reminderSurface.list())
    snapshot.reminders = reminders.slice(0, 12).map((r) => ({
      id: typeof r.id === 'string' ? r.id : '',
      title: typeof r.title === 'string' ? r.title : '',
      dueAt: typeof r.dueAt === 'string' ? r.dueAt : null,
      done: r.done === true || r.status === 'done' || r.status === 'completed',
    }))
  } catch (error) {
    deps.logger?.warn('dsh-longterm-memory: native snapshot failed: %o', error)
  }
  return snapshot
}

/** Result of installing the bridge; exposed for tests and capability reporting. */
export interface DshGoInstallResult {
  installed: boolean
  panels: string[]
}

/**
 * Install native panels, strip and capsule handlers on a DSH Go host.
 * Returns synchronously; the real installation happens inside the inject
 * callback. `result.installed` is updated when that callback fires.
 */
export function installDshGoBridge(ctx: DshGoContextLike, deps: DshGoBridgeDeps): DshGoInstallResult {
  const result: DshGoInstallResult = { installed: false, panels: [] }
  let snapshot: NativeSnapshot = { ...EMPTY_SNAPSHOT, capabilities: { ...EMPTY_SNAPSHOT.capabilities } }
  let timer: ReturnType<typeof setInterval> | undefined

  const refresh = async (): Promise<void> => {
    snapshot = await buildSnapshot(deps)
    try {
      const bridge = (ctx.get('dshGo') as DshGoBridgeLike | undefined)
      bridge?.refresh?.('overview')
      bridge?.refresh?.('inbox')
      bridge?.refresh?.('reminders')
      bridge?.refresh?.('graph')
    } catch {
      /* refresh is best-effort */
    }
  }

  try {
    ctx.inject(['dshGo'], (scoped) => {
      const bridge = scoped.get('dshGo') as DshGoBridgeLike | undefined
      if (bridge === undefined || typeof bridge.panel !== 'function') return
      result.installed = true

      const view = (build: (s: NativeSnapshot, caps: NativeCaps | undefined) => NativeView) =>
        (_scope: unknown, caps: NativeCaps | undefined) => build(snapshot, caps)

      bridge.panel('overview', {
        view: view(overviewPanelView),
        actions: {
          refresh: () => { void refresh(); return { refresh: 'overview' } },
          search: () => ({ insert: '请用 memory_search 搜索我的长期记忆，并列出最相关的几条。' }),
          manage: () => ({ open: 'panel:longterm-memory' }),
        },
      })
      bridge.panel('inbox', {
        view: view(inboxPanelView),
        actions: {
          refresh: () => { void refresh(); return { refresh: 'inbox' } },
          confirm: (_scope, event) => {
            const value = event.value as { id?: string } | undefined
            if (typeof value?.id !== 'string') return undefined
            void deps.service.confirm(value.id, '用户在 DSH Go 原生面板确认').then(() => refresh()).catch(() => undefined)
            return { toast: '已确认' }
          },
          reject: (_scope, event) => {
            const value = event.value as { id?: string } | undefined
            if (typeof value?.id !== 'string') return undefined
            void deps.service.reject(value.id, '用户在 DSH Go 原生面板拒绝').then(() => refresh()).catch(() => undefined)
            return { toast: '已拒绝' }
          },
        },
      })
      bridge.panel('reminders', {
        view: view(remindersPanelView),
        actions: {
          refresh: () => { void refresh(); return { refresh: 'reminders' } },
          'new-reminder': () => ({ insert: '请用 reminder_create 为我创建一个提醒：' }),
        },
      })
      bridge.panel('graph', {
        view: view(graphPanelView),
        actions: {
          refresh: () => { void refresh(); return { refresh: 'graph' } },
          manage: () => ({ open: 'panel:longterm-memory' }),
        },
      })
      result.panels = [...NATIVE_PANELS]

      bridge.strip?.('memory', (_scope, emit, caps) => {
        emit(stripData(snapshot, caps))
        return () => undefined
      })

      // The manifest declares `wants: ["draft"]` for these two capsules, so
      // actually use the draft in the inserted prompt (never persist it here —
      // the model decides what, if anything, to save).
      bridge.on?.(NATIVE_CAPSULE_SAVE, (scope) => {
        const draft = typeof scope.draft === 'string' ? scope.draft.trim().slice(0, 2000) : ''
        return {
          insert: draft.length > 0
            ? `请把下面这段内容里值得长期记住的事实，用 memory_save 存入长期记忆：\n\n${draft}`
            : '请把我接下来告诉你的内容，用 memory_save 记入长期记忆：',
        }
      })
      bridge.on?.(NATIVE_CAPSULE_SEARCH, (scope) => {
        const draft = typeof scope.draft === 'string' ? scope.draft.trim().slice(0, 2000) : ''
        return {
          insert: draft.length > 0
            ? `请用 memory_search 搜索我的长期记忆，关键词：${draft}`
            : '请用 memory_search 搜索我的长期记忆：',
        }
      })
      bridge.on?.(NATIVE_MESSAGE_SAVE, (scope) => {
        const text = typeof scope.message === 'string' ? scope.message.slice(0, 2000) : ''
        return {
          insert: text.length > 0
            ? `请把下面这条内容中值得长期记住的事实，用 memory_save 存入长期记忆：\n\n${text}`
            : '请判断上一条消息里是否有值得长期记住的事实，若有，用 memory_save 存入长期记忆。',
        }
      })

      void refresh()
      timer = setInterval(() => { void refresh() }, Math.max(5000, deps.refreshMs ?? 15000))
      timer.unref?.()
      scoped.effect(() => () => { if (timer !== undefined) clearInterval(timer) }, 'dsh-longterm-memory: native bridge')
      deps.logger?.info('dsh-longterm-memory: DSH Go native bridge installed (4 panels, 1 strip)')
    })
  } catch {
    /* no bridge service on this host — desktop path, nothing to do */
  }

  return result
}

/** Build the `presentationMeta` map for all card-capable tools. */
export function installNativeToolCards(definitions: { name: string; output: Record<string, unknown> }[]): void {
  for (const definition of definitions) withNativeCard(definition)
}

/** Helper for tests / capability reporting. */
export function nativeSnapshotForView(s: NativeSnapshot, panel: NativePanelId, caps?: NativeCaps): NativeView {
  if (panel === 'inbox') return inboxPanelView(s, caps)
  if (panel === 'reminders') return remindersPanelView(s, caps)
  if (panel === 'graph') return graphPanelView(s, caps)
  return overviewPanelView(s, caps)
}

/** Type-only re-export for consumers. */
export type { NativeEffect, NativeView }
