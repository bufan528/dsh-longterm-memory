/**
 * 宿主**插件清单**桥（客户端）。
 *
 * 官方 QQ 插件不注册任何 cordis 服务，所以「它是否已安装 / 已启用 / 加载到哪个
 * 阶段」不能靠 `ctx.get` 判断（装了也是 undefined）。DSH 0.2.1-rc.3 提供了
 * `pluginInventory` Remote（见 docs/evidence/dsh-host-0.2.1-rc.3.md §4）：
 *
 * ```ts
 * inject = ['remote', 'remote.pluginInventory']
 * const result = await ctx.remote.pluginInventory.list()
 * // { ok: true, value: { entries: [{ moduleName, enabled, fiberPhase }] } }
 * ```
 *
 * 这条桥把 Remote 的可选依赖封装成一个模块级函数，页面因此可以在「Remote
 * 不可用」时退回只读 HTTP 探测，而不是假设宿主一定提供它。桥从未把清单当成
 * 「连接状态」：它只能证明**装没装、启没启用、加载阶段**，连接/绑定状态仍然只能
 * 来自官方插件自己的 `/qqbot/im-qqbot/bind`。
 *
 * @module dsh-longterm-memory/client/host-inventory
 */

/** 官方 QQ 接入插件的 npm 包名。 */
export const OFFICIAL_PACKAGE = '@tencent-connect/dsh-qqbot'

/** 官方插件在 cordis 里的插件名（loader entry id）。 */
export const OFFICIAL_ENTRY_ID = 'im-qqbot'

/** 一条插件清单记录（字段按宿主 `PluginInventoryEntry` 归一化）。 */
export interface PluginInventoryRow {
  moduleName: string
  entryId: string | null
  enabled: boolean | null
  phase: string | null
}

/** 官方插件在宿主编译期清单里的存在性结论。 */
export interface OfficialPresence {
  /** 桥是否可用（宿主是否暴露了 pluginInventory Remote）。 */
  available: boolean
  /** 结论：未安装 / 已安装 / 已安装但停用 / 桥不可用。 */
  state: 'absent' | 'installed' | 'disabled' | 'unknown'
  /** 命中的清单行（若有）。 */
  row: PluginInventoryRow | null
  /** 人类可读依据。 */
  note: string
}

/** 桥的实现；由 client/index.ts 在 apply 时注入。 */
export interface PluginInventoryBridge {
  available: boolean
  note: string
  list: () => Promise<PluginInventoryRow[]>
}

const UNAVAILABLE: PluginInventoryBridge = {
  available: false,
  note: '宿主未暴露 pluginInventory Remote，无法读取插件清单。',
  list: async () => [],
}

let bridge: PluginInventoryBridge = UNAVAILABLE

/** 安装桥（client/index.ts 调用；重复安装以最后一次为准）。 */
export function setPluginInventoryBridge(next: PluginInventoryBridge): void {
  bridge = next
}

/** 当前桥状态，供诊断区展示。 */
export function pluginInventoryBridge(): PluginInventoryBridge {
  return bridge
}

/**
 * 归一化一条清单记录。
 *
 * 宿主的 entry 形状可能随版本微调（`moduleName` / `moduleSpecifier`，`fiberPhase`
 * / `phase`），这里接受已知别名，读不到就记为 null，不猜。
 */
export function normalizeInventoryRow(input: unknown): PluginInventoryRow | null {
  if (input === null || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const moduleName = firstString(record, ['moduleName', 'moduleSpecifier', 'name', 'module'])
  const entryId = firstString(record, ['entryId', 'id', 'patchId'])
  const enabledRaw = record['enabled']
  const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : null
  const phase = firstString(record, ['fiberPhase', 'phase', 'status'])
  if (moduleName === null && entryId === null) return null
  return { moduleName: moduleName ?? '', entryId, enabled, phase }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** 从清单里找出官方 QQ 插件的那一行。 */
export function findOfficialPluginRow(rows: readonly PluginInventoryRow[]): PluginInventoryRow | null {
  const exact = rows.find((row) => row.moduleName === OFFICIAL_PACKAGE)
  if (exact !== undefined) return exact
  const byEntry = rows.find((row) => row.entryId === OFFICIAL_ENTRY_ID)
  if (byEntry !== undefined) return byEntry
  return rows.find((row) => row.moduleName.includes('dsh-qqbot')) ?? null
}

/** 把「命中的清单行」翻译成存在性结论。 */
export function classifyOfficialPresence(rows: readonly PluginInventoryRow[]): OfficialPresence {
  const row = findOfficialPluginRow(rows)
  if (row === null) {
    return { available: true, state: 'absent', row: null, note: '宿主插件清单中没有 @tencent-connect/dsh-qqbot。' }
  }
  if (row.enabled === false) {
    return { available: true, state: 'disabled', row, note: '插件清单显示该插件已安装但被停用。' }
  }
  return {
    available: true,
    state: 'installed',
    row,
    note: `插件清单命中：enabled=${String(row.enabled)}，phase=${row.phase ?? '未知'}。`,
  }
}

/** 读取官方插件存在性；桥不可用或调用失败时返回 `state: 'unknown'`。 */
export async function readOfficialPresence(): Promise<OfficialPresence> {
  if (!bridge.available) {
    return { available: false, state: 'unknown', row: null, note: bridge.note }
  }
  try {
    const rows = await bridge.list()
    return classifyOfficialPresence(rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { available: false, state: 'unknown', row: null, note: `读取插件清单失败：${message}` }
  }
}
