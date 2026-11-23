/**
 * JSON view builders for the DSH Go native UI.
 *
 * Every function here is pure: it takes a value and returns a plain JSON tree.
 * No I/O, no clock, no host access — the same properties the official
 * `@dsh-go/plugin-kit` expects from a view function. Kept local because the SDK
 * is not published to npm.
 *
 * Budgets (from the DSH Go view catalogue):
 *   tool card ≤ 8 KiB / 40 nodes / depth 6
 *   panel    ≤ 32 KiB / 120 nodes / depth 8
 *   strip    ≤ 2 KiB / 8 nodes / depth 3
 *
 * @module dsh-longterm-memory/host/dshgo/views
 */

import type { NativeCaps, NativeSnapshot, NativeView } from './types.js'

/** Pick the view language from an app locale hint. */
export function viewLang(caps: NativeCaps | undefined): 'zh' | 'en' {
  const locale = caps?.locale ?? ''
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function strings(caps: NativeCaps | undefined, zh: string, en: string): string {
  return viewLang(caps) === 'zh' ? zh : en
}

/**
 * Wrap a view builder for `output.presentationMeta`.
 *
 * The three failure modes that would otherwise fail the *whole tool call* are
 * handled here, mirroring the official `toolCard()`: a throwing builder, a
 * non-lossless JSON value (undefined/NaN/Infinity), and an oversized view.
 * Returning `{}` means "no card" — the ordinary text result still reaches the
 * model and the desktop web client.
 */
export function toolCard(
  build: (args: unknown, value: unknown) => NativeView | undefined,
  maxBytes = 8 * 1024,
): (args: unknown, value: unknown) => Record<string, unknown> {
  return (args, value) => {
    try {
      const view = build(args, value)
      if (view === undefined) return {}
      const json = JSON.stringify(view)
      if (json === undefined) return {}
      const bytes = Buffer.byteLength(json, 'utf8')
      if (bytes > maxBytes) return {}
      return { 'dsh-go/view': JSON.parse(json) as NativeView }
    } catch {
      return {}
    }
  }
}

/** Clamp a string to a maximum length (tool-card text limit is 2000 chars). */
function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function labelOfType(type: string, caps: NativeCaps | undefined): string {
  const zh: Record<string, string> = {
    profile: '画像', preference: '偏好', project: '项目', 'project-state': '项目进展',
    decision: '决策', knowledge: '知识', experience: '经验', task: '任务',
  }
  const en: Record<string, string> = {
    profile: 'Profile', preference: 'Preference', project: 'Project', 'project-state': 'Project state',
    decision: 'Decision', knowledge: 'Knowledge', experience: 'Experience', task: 'Task',
  }
  return (viewLang(caps) === 'zh' ? zh : en)[type] ?? type
}

/* ----------------------------------------------------------- tool result cards */

interface SearchResult {
  id: string
  title: string
  type: string
  status: string
  summary: string
  tags?: string[]
  reasons?: string[]
  updatedAt?: string
}

/** `memory_search` → count + a compact list of the strongest hits. */
export function memorySearchView(caps: NativeCaps | undefined, args: unknown, value: unknown): NativeView {
  const payload = value as { count?: number; results?: SearchResult[] }
  const count = typeof payload?.count === 'number' ? payload.count : 0
  const results = Array.isArray(payload?.results) ? payload.results.slice(0, 8) : []
  const input = args as { query?: string } | undefined
  const query = typeof input?.query === 'string' ? input.query : ''
  const empty = count === 0
  return {
    type: 'stack',
    v: 2,
    title: strings(caps, `记忆检索${query ? ` · ${query}` : ''}`, `Memory search${query ? ` · ${query}` : ''}`),
    children: [
      {
        type: 'metric',
        label: strings(caps, '命中记忆', 'Memories found'),
        value: count,
        caption: strings(caps, '仅 active 为当前事实', 'Only active entries are current fact'),
      },
      ...(empty
        ? [{ type: 'callout', tone: 'info', text: strings(caps, '未命中。仓库可能为空，或查询过于具体。', 'No match. The vault may be empty or the query too specific.') }]
        : [{
            type: 'list',
            items: results.map((hit) => ({
              title: clip(hit.title, 60),
              subtitle: clip(hit.summary, 90),
              trailing: labelOfType(hit.type, caps),
              icon: 'book',
            })),
          }]),
    ],
  }
}

/** `memory_get` → one memory's fields plus its body. */
export function memoryGetView(caps: NativeCaps | undefined, _args: unknown, value: unknown): NativeView {
  const payload = value as {
    id?: string; title?: string; type?: string; status?: string; content?: string
    evidence?: string; tags?: string[]; recallable?: boolean; recallNote?: string
  }
  return {
    type: 'stack',
    v: 2,
    title: strings(caps, '记忆详情', 'Memory detail'),
    children: [
      { type: 'text', text: `**${clip(payload?.title, 120)}**` },
      {
        type: 'keyValue',
        items: [
          [strings(caps, '编号', 'ID'), clip(payload?.id, 40)],
          [strings(caps, '类别', 'Type'), labelOfType(payload?.type ?? '', caps)],
          [strings(caps, '状态', 'Status'), clip(payload?.status, 30)],
          [strings(caps, '可召回', 'Recallable'), payload?.recallable === true
            ? strings(caps, '是', 'Yes') : strings(caps, '否', 'No')],
        ],
      },
      ...(Array.isArray(payload?.tags) && payload.tags.length > 0
        ? [{ type: 'text', tone: 'muted', text: `Tags: ${payload.tags.slice(0, 8).join(' · ')}` }]
        : []),
      { type: 'text', text: clip(payload?.content, 1200) },
      ...(typeof payload?.evidence === 'string' && payload.evidence.length > 0
        ? [{ type: 'callout', tone: 'info', text: clip(payload.evidence, 600) }]
        : []),
      ...(payload?.recallable === false && typeof payload?.recallNote === 'string'
        ? [{ type: 'callout', tone: 'warn', text: clip(payload.recallNote, 400) }]
        : []),
    ],
  }
}

/** `memory_save` → created/updated + id + the honesty note. */
export function memorySaveView(caps: NativeCaps | undefined, _args: unknown, value: unknown): NativeView {
  const payload = value as { id?: string; created?: boolean; status?: string; note?: string }
  return {
    type: 'stack',
    v: 2,
    title: strings(caps, '写入长期记忆', 'Saved to memory'),
    children: [
      {
        type: 'callout',
        tone: payload?.created === true ? 'good' : 'info',
        text: payload?.created === true
          ? strings(caps, '已新增一条长期记忆。', 'A new long-term memory was recorded.')
          : strings(caps, '已更新已有的长期记忆。', 'An existing long-term memory was updated.'),
      },
      {
        type: 'keyValue',
        items: [
          [strings(caps, '编号', 'ID'), clip(payload?.id, 40)],
          [strings(caps, '状态', 'Status'), clip(payload?.status, 30)],
        ],
      },
      ...(typeof payload?.note === 'string' && payload.note.length > 0
        ? [{ type: 'text', tone: 'muted', text: clip(payload.note, 500) }]
        : []),
    ],
  }
}

/** `memory_forget` → retired status + traceability note. */
export function memoryForgetView(caps: NativeCaps | undefined, _args: unknown, value: unknown): NativeView {
  const payload = value as { id?: string; status?: string; note?: string }
  return {
    type: 'stack',
    v: 2,
    title: strings(caps, '退役记忆', 'Memory retired'),
    children: [
      { type: 'callout', tone: 'good', text: strings(caps, '已归档，未物理删除。', 'Archived, not physically deleted.') },
      {
        type: 'keyValue',
        items: [
          [strings(caps, '编号', 'ID'), clip(payload?.id, 40)],
          [strings(caps, '新状态', 'New status'), clip(payload?.status, 30)],
        ],
      },
      ...(typeof payload?.note === 'string' ? [{ type: 'text', tone: 'muted', text: clip(payload.note, 500) }] : []),
    ],
  }
}

/** Reminder tools → compact list / confirmation card. */
export function reminderListView(caps: NativeCaps | undefined, _args: unknown, value: unknown): NativeView {
  const payload = value as {
    reminders?: { id?: string; title?: string; dueAt?: string; status?: string }[]
    dueSummary?: { summary?: string }
  }
  const rows = Array.isArray(payload?.reminders) ? payload.reminders.slice(0, 10) : []
  return {
    type: 'stack',
    v: 2,
    title: strings(caps, '提醒', 'Reminders'),
    children: [
      ...(typeof payload?.dueSummary?.summary === 'string'
        ? [{ type: 'text', tone: 'muted', text: clip(payload.dueSummary.summary, 300) }]
        : []),
      ...(rows.length === 0
        ? [{ type: 'callout', tone: 'info', text: strings(caps, '暂无提醒。', 'No reminders.') }]
        : [{
            type: 'list',
            items: rows.map((row) => ({
              title: clip(row.title, 60),
              subtitle: clip(row.dueAt, 40),
              trailing: clip(row.status, 20),
              icon: 'reminder',
            })),
          }]),
    ],
  }
}

export function reminderMutateView(caps: NativeCaps | undefined, kind: 'create' | 'complete', value: unknown): NativeView {
  const payload = value as { id?: string; title?: string; next?: unknown }
  return {
    type: 'stack',
    v: 2,
    title: kind === 'create'
      ? strings(caps, '提醒已创建', 'Reminder created')
      : strings(caps, '提醒已完成', 'Reminder completed'),
    children: [
      { type: 'callout', tone: 'good', text: clip(payload?.title ?? payload?.id, 200) },
      ...(payload?.next !== undefined
        ? [{ type: 'text', tone: 'muted', text: strings(caps, '重复提醒已安排下一次。', 'The next occurrence was scheduled.') }]
        : []),
    ],
  }
}

/** Sticker tools → one compact card. */
export function stickerToolView(caps: NativeCaps | undefined, kind: 'pick' | 'ingest', value: unknown): NativeView {
  const payload = value as { id?: string; label?: string; description?: string; imported?: number; skipped?: number; reason?: string }
  return {
    type: 'stack',
    v: 2,
    title: kind === 'pick' ? strings(caps, '选中表情', 'Sticker picked') : strings(caps, '收录表情', 'Sticker ingested'),
    children: [
      {
        type: 'callout',
        tone: payload?.reason === undefined ? 'good' : 'info',
        text: clip(payload?.reason ?? payload?.label ?? payload?.id, 300),
      },
      ...(typeof payload?.description === 'string'
        ? [{ type: 'text', tone: 'muted', text: clip(payload.description, 400) }]
        : []),
      ...(kind === 'ingest'
        ? [{
            type: 'keyValue',
            items: [
              [strings(caps, '已收录', 'Imported'), String(payload?.imported ?? 0)],
              [strings(caps, '跳过', 'Skipped'), String(payload?.skipped ?? 0)],
            ],
          }]
        : []),
    ],
  }
}

/**
 * Route a tool's raw result to the matching card. Unknown tools return
 * `undefined` so `toolCard()` emits no card at all.
 */
export function toolResultView(tool: string, caps: NativeCaps | undefined, args: unknown, value: unknown): NativeView | undefined {
  switch (tool) {
    case 'memory_search': return memorySearchView(caps, args, value)
    case 'memory_get': return memoryGetView(caps, args, value)
    case 'memory_save': return memorySaveView(caps, args, value)
    case 'memory_forget': return memoryForgetView(caps, args, value)
    case 'reminder_list': return reminderListView(caps, args, value)
    case 'reminder_create': return reminderMutateView(caps, 'create', value)
    case 'reminder_complete': return reminderMutateView(caps, 'complete', value)
    case 'sticker_pick': return stickerToolView(caps, 'pick', value)
    case 'sticker_ingest': return stickerToolView(caps, 'ingest', value)
    default: return undefined
  }
}

/* ------------------------------------------------------------------- panels */

/** Shared header for the management panels. */
function panelHeader(caps: NativeCaps | undefined, ready: boolean): NativeView[] {
  return ready
    ? [{ type: 'text', tone: 'muted', text: strings(caps, '来自本机长期记忆仓库', 'From your local memory vault') }]
    : [{
        type: 'callout',
        tone: 'warn',
        text: strings(caps, '仓库尚未初始化——请在网页管理页创建或选择一个仓库。', 'No vault yet — open the web management page to create or choose one.'),
      }]
}

/** `overview` panel: totals, recent memories, quick actions. */
export function overviewPanelView(s: NativeSnapshot, caps: NativeCaps | undefined): NativeView {
  return {
    type: 'stack',
    v: 2,
    title: strings(caps, '长期记忆', 'Long-term memory'),
    children: [
      ...panelHeader(caps, s.ready),
      {
        type: 'row',
        children: [
          { type: 'metric', label: strings(caps, '记忆总数', 'Memories'), value: s.totalMemories },
          { type: 'metric', label: strings(caps, '待确认', 'Inbox'), value: s.pendingCandidates, tone: s.pendingCandidates > 0 ? 'warn' : undefined },
          { type: 'metric', label: strings(caps, '异常', 'Problems'), value: s.problemMemories, tone: s.problemMemories > 0 ? 'bad' : undefined },
        ],
      },
      ...(s.recent.length > 0
        ? [{
            type: 'list',
            title: strings(caps, '最近更新', 'Recently updated'),
            items: s.recent.slice(0, 12).map((m) => ({
              title: clip(m.title, 60),
              subtitle: `${labelOfType(m.type, caps)} · ${clip(m.updatedAt, 20)}`,
              trailing: clip(m.status, 16),
              icon: 'book',
            })),
          }]
        : [{ type: 'callout', tone: 'info', text: strings(caps, '还没有记忆。', 'No memories yet.') }]),
      {
        type: 'actions',
        items: [
          { label: strings(caps, '刷新', 'Refresh'), action: 'refresh', icon: 'refresh' },
          { label: strings(caps, '搜记忆', 'Search'), action: 'search', icon: 'search', style: 'primary' },
          { label: strings(caps, '打开管理页', 'Manage'), action: 'manage', icon: 'panel' },
        ],
      },
    ],
  }
}

/** `inbox` panel: confirm / reject candidates in place. */
export function inboxPanelView(s: NativeSnapshot, caps: NativeCaps | undefined): NativeView {
  const rows = s.inbox.slice(0, 12)
  return {
    type: 'stack',
    v: 2,
    title: strings(caps, '待确认候选', 'Memory inbox'),
    children: [
      {
        type: 'metric',
        label: strings(caps, '等待确认', 'Awaiting review'),
        value: s.pendingCandidates,
        caption: strings(caps, '确认后才会成为当前事实', 'Only confirmed entries become current fact'),
      },
      ...(rows.length === 0
        ? [{ type: 'callout', tone: 'good', text: strings(caps, '收件箱已清空。', 'Inbox is clear.') }]
        : [{
            type: 'list',
            items: rows.flatMap((c) => [
              {
                title: clip(c.title, 60),
                subtitle: `${labelOfType(c.type, caps)} · ${clip(c.decision, 20)}${c.refused ? ` · ${clip(c.refused, 30)}` : ''}`,
                icon: 'note',
              },
              {
                title: strings(caps, '确认', 'Confirm'),
                subtitle: clip(c.id, 40),
                icon: 'check',
                action: { id: 'confirm', args: { id: c.id } },
              },
              {
                title: strings(caps, '拒绝', 'Reject'),
                subtitle: clip(c.id, 40),
                icon: 'remove',
                action: { id: 'reject', args: { id: c.id } },
              },
            ]),
          }]),
      { type: 'actions', items: [{ label: strings(caps, '刷新', 'Refresh'), action: 'refresh', icon: 'refresh' }] },
    ],
  }
}

/** `reminders` panel: current reminders + insert-a-reminder shortcut. */
export function remindersPanelView(s: NativeSnapshot, caps: NativeCaps | undefined): NativeView {
  const rows = s.reminders.slice(0, 12)
  return {
    type: 'stack',
    v: 2,
    title: strings(caps, '提醒', 'Reminders'),
    children: [
      ...(rows.length === 0
        ? [{ type: 'callout', tone: 'info', text: strings(caps, '暂无提醒。', 'No reminders yet.') }]
        : [{
            type: 'list',
            items: rows.map((r) => ({
              title: clip(r.title, 60),
              subtitle: clip(r.dueAt, 40),
              trailing: r.done ? strings(caps, '已完成', 'Done') : undefined,
              icon: 'reminder',
            })),
          }]),
      {
        type: 'actions',
        items: [
          { label: strings(caps, '新建提醒', 'New reminder'), action: 'new-reminder', icon: 'add', style: 'primary' },
          { label: strings(caps, '刷新', 'Refresh'), action: 'refresh', icon: 'refresh' },
        ],
      },
    ],
  }
}

/** `graph` panel: real graph counts + a bridge to the WebView visualization. */
export function graphPanelView(s: NativeSnapshot, caps: NativeCaps | undefined): NativeView {
  const graph = s.graph
  return {
    type: 'stack',
    v: 2,
    title: strings(caps, '记忆图谱', 'Memory Graph'),
    children: [
      ...panelHeader(caps, s.ready),
      {
        type: 'row',
        children: [
          { type: 'metric', label: strings(caps, '记忆', 'Memories'), value: graph.nodes },
          { type: 'metric', label: strings(caps, '关系', 'Relations'), value: graph.edges },
          {
            type: 'metric',
            label: strings(caps, '孤立', 'Isolated'),
            value: graph.isolated,
            tone: graph.isolated > 0 ? 'warn' : undefined,
          },
        ],
      },
      {
        type: 'row',
        children: [
          { type: 'metric', label: strings(caps, '自动关联', 'Inferred'), value: graph.auto },
          { type: 'metric', label: strings(caps, '连通分量', 'Components'), value: graph.components },
          { type: 'metric', label: strings(caps, '算法社区', 'Communities'), value: graph.communities },
        ],
      },
      ...(graph.edges === 0
        ? [{
            type: 'callout',
            tone: 'info',
            text: strings(
              caps,
              '还没有记录关系。打开网页版后可在「记忆图谱」里点「自动补全」。',
              'No relations recorded yet. Open the web page and use “Infer links” on the Memory Graph.',
            ),
          }]
        : []),
      ...(graph.hubs.length > 0
        ? [{
            type: 'list',
            title: strings(caps, '枢纽记忆', 'Hub memories'),
            items: graph.hubs.slice(0, 6).map((hub) => ({
              title: clip(hub.title, 60),
              subtitle: strings(caps, `${String(hub.degree)} 条关系`, `${String(hub.degree)} relations`),
              icon: 'book',
            })),
          }]
        : []),
      {
        type: 'callout',
        tone: 'info',
        text: strings(
          caps,
          '图谱可视化在网页版：打开管理页 → 记忆图谱，可缩放、筛选、查看关系与路径。',
          'The visual graph is in the web page: Manage → Memory Graph for zoom, filters, relations and paths.',
        ),
      },
      {
        type: 'actions',
        items: [
          { label: strings(caps, '打开网页版', 'Open web'), action: 'manage', icon: 'panel', style: 'primary' },
          { label: strings(caps, '刷新', 'Refresh'), action: 'refresh', icon: 'refresh' },
        ],
      },
    ],
  }
}

/** `composer.strip`: one short line, ≤ 24 chars. */
export function stripData(s: NativeSnapshot, caps: NativeCaps | undefined): { text: string; icon: string; tone?: 'warn' } {
  const count = s.totalMemories
  const pending = s.pendingCandidates
  const base = strings(caps, '记忆', 'mem')
  return {
    icon: 'book',
    text: pending > 0 ? `${base} ${count} · +${pending}` : `${base} ${count}`,
    ...(pending > 0 ? { tone: 'warn' as const } : {}),
  }
}
