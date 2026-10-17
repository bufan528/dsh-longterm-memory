/**
 * Vault initialization, verification, and status.
 *
 * Initialization is idempotent and additive: it creates what is missing and
 * never rewrites a file that already exists, so re-running it cannot destroy the
 * user's edits. It refuses any target that already holds foreign data.
 *
 * @module dsh-longterm-memory/host/core/vault
 */

import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import {
  TYPE_DESCRIPTORS,
  VAULT_DIRS,
  type MemoryStatus,
  type VaultInfo,
  type VaultStats,
} from '../../shared/types.js'
import {
  FsError,
  ensureDir,
  isDirectory,
  pathExists,
  readTextIfExists,
  removeFile,
  statOrNull,
  writeFileAtomic,
} from './fsx.js'
import { assertTestWritable } from '../../shared/path-safety.js'
import {
  DEFAULT_VAULT_FOLDER,
  checkTargetUsable,
  hasObsidianMarker,
  isMemoryVault,
} from './discover.js'
import {
  PRIVATE_DIR,
  VAULT_PRODUCT,
  VAULT_SCHEMA_VERSION,
  layoutFor,
  requiredDirectories,
  type VaultLayout,
} from './layout.js'

/** Persisted plugin configuration, lives inside the vault marker. */
export interface VaultConfigFile {
  product: string
  schemaVersion: number
  createdAt: string
  updatedAt: string
  /** Non-secret, user-tunable settings. Secrets are never stored here. */
  settings: Record<string, unknown>
  /** Ids the user pinned through the UI, mirrored for fast rebuild-free reads. */
  notes?: string[]
}

export interface InitResult {
  layout: VaultLayout
  created: boolean
  reused: boolean
  /** Files that were written during this run. */
  written: string[]
  /** Files that already existed and were left untouched. */
  preserved: string[]
  verification: { ok: boolean; steps: string[]; failures: string[] }
  warnings: string[]
}

/**
 * Create or adopt the memory vault at `root`.
 *
 * @param root - absolute target directory.
 * @param options - `settings` seeds the marker; `obsidianVaults` supplies the
 *   confirmed Obsidian vaults so a target nested inside one is refused. There is
 *   deliberately no `force`: overwriting is not a supported operation.
 */
export async function initializeVault(
  root: string,
  options: { settings?: Record<string, unknown>; obsidianVaults?: readonly string[] } = {},
): Promise<InitResult> {
  const layout = layoutFor(root)
  const warnings: string[] = []
  const written: string[] = []
  const preserved: string[] = []

  const usable = await checkTargetUsable(root, {
    ...(options.obsidianVaults === undefined ? {} : { obsidianVaults: options.obsidianVaults }),
  })
  if (!usable.ok) throw new FsError('FS_DENIED', usable.reason, root)

  const existedBefore = await isMemoryVault(root)
  const rootExisted = await isDirectory(root)

  // Test-mode confinement: refuse before creating anything. In production the
  // guard is a no-op (no test root configured), so normal paths are unaffected.
  await assertTestWritable(root)
  await ensureDir(root)
  for (const dir of requiredDirectories(layout)) await ensureDir(dir)
  // An empty `.obsidian` directory is what makes Obsidian treat the folder as a
  // vault. The user's global Obsidian registry is deliberately not touched.
  await ensureDir(layout.obsidianDir)

  const now = new Date().toISOString()
  const markerExisted = await pathExists(layout.marker)
  const markerWasValid = existedBefore
  if (!markerWasValid) {
    const config: VaultConfigFile = {
      product: VAULT_PRODUCT,
      schemaVersion: VAULT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      settings: options.settings ?? {},
      notes: [],
    }
    await writeFileAtomic(layout.config, `${JSON.stringify(config, null, 2)}\n`)
    written.push(relativeTo(root, layout.config))
    if (markerExisted) {
      // Structure evidence was checked by `checkTargetUsable`, so rewriting here
      // is a repair of our own metadata, not an adoption of foreign data.
      warnings.push('检测到不可用的仓库标记文件，已根据仓库内的插件生成文件重建。')
    }
  } else {
    preserved.push(relativeTo(root, layout.config))
  }

  const seeds: { path: string; content: string }[] = [
    { path: layout.readme, content: renderVaultReadme(root) },
    { path: layout.home, content: renderMemoryHome() },
    ...renderIndexNotes(layout.indexDir),
  ]
  for (const seed of seeds) {
    if (await pathExists(seed.path)) {
      preserved.push(relativeTo(root, seed.path))
      continue
    }
    await writeFileAtomic(seed.path, seed.content)
    written.push(relativeTo(root, seed.path))
  }

  const verification = await verifyVault(layout)
  if (!verification.ok) {
    warnings.push('写入校验未通过，请检查目录权限或磁盘状态后重试。')
  }

  return {
    layout,
    created: !existedBefore,
    reused: existedBefore || (rootExisted && markerExisted),
    written,
    preserved,
    verification,
    warnings,
  }
}

/**
 * Prove the vault is readable *and* writable.
 *
 * The probe writes a unique file, reads it back, and removes it; a read-only or
 * full disk therefore fails initialization loudly instead of at first write.
 */
export async function verifyVault(layout: VaultLayout): Promise<{ ok: boolean; steps: string[]; failures: string[] }> {
  const steps: string[] = []
  const failures: string[] = []
  const probe = join(layout.quarantineDir, `verify-${randomBytes(4).toString('hex')}.tmp`)

  try {
    const info = await statOrNull(layout.root)
    if (info === null || !info.isDirectory) failures.push(`仓库根目录不可访问：${layout.root}`)
    else steps.push('仓库根目录可访问')
  } catch (error) {
    failures.push(`仓库根目录不可访问：${describeError(error)}`)
  }

  try {
    const payload = `dsh-longterm-memory ${new Date().toISOString()}`
    await ensureDir(layout.quarantineDir)
    await writeFileAtomic(probe, payload)
    steps.push('可写入文件')
    const readBack = await readTextIfExists(probe)
    if (readBack !== payload) failures.push('写入后读回内容不一致')
    else steps.push('写入内容可完整读回')
    await removeFile(probe)
    steps.push('可删除文件')
  } catch (error) {
    failures.push(`读写校验失败：${describeError(error)}`)
  }

  const readme = await readTextIfExists(layout.readme)
  if (readme === null) failures.push('README.md 缺失')
  else steps.push('README.md 可读')

  const config = await readTextIfExists(layout.config)
  if (config === null) failures.push('仓库标记文件缺失')
  else {
    try {
      const parsed = JSON.parse(config) as { product?: unknown }
      if (parsed.product !== VAULT_PRODUCT) failures.push('仓库标记文件的产品标识不匹配')
      else steps.push('仓库标记文件有效')
    } catch {
      failures.push('仓库标记文件不是合法 JSON')
    }
  }

  return { ok: failures.length === 0, steps, failures }
}

/** Read the vault's persisted configuration, or null when absent/unreadable. */
export async function readVaultConfig(layout: VaultLayout): Promise<VaultConfigFile | null> {
  const raw = await readTextIfExists(layout.config)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as VaultConfigFile
    if (parsed.product !== VAULT_PRODUCT) return null
    return parsed
  } catch {
    return null
  }
}

/** Merge and persist vault configuration. Never stores secrets. */
export async function writeVaultConfig(layout: VaultLayout, patch: Partial<VaultConfigFile>): Promise<VaultConfigFile> {
  const existing = (await readVaultConfig(layout)) ?? {
    product: VAULT_PRODUCT,
    schemaVersion: VAULT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: {},
    notes: [],
  }
  const next: VaultConfigFile = {
    ...existing,
    ...patch,
    product: VAULT_PRODUCT,
    schemaVersion: existing.schemaVersion,
    settings: { ...existing.settings, ...(patch.settings ?? {}) },
    updatedAt: new Date().toISOString(),
  }
  await writeFileAtomic(layout.config, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** Collect the counters the management page shows. */
export async function collectStats(
  records: Iterable<{ type: string; status: string; pinned?: boolean }>,
  outOfSyncCount: number,
): Promise<VaultStats> {
  const byType: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  let total = 0
  let pending = 0
  let conflicts = 0
  let stale = 0
  let archived = 0
  let pinned = 0

  for (const record of records) {
    total += 1
    byType[record.type] = (byType[record.type] ?? 0) + 1
    byStatus[record.status] = (byStatus[record.status] ?? 0) + 1
    if (record.status === 'pending') pending += 1
    if (record.status === 'conflict') conflicts += 1
    if (record.status === 'stale') stale += 1
    if (record.status === 'archived' || record.status === 'superseded') archived += 1
    if (record.pinned === true) pinned += 1
  }

  return { total, byType, byStatus, pending, conflicts, stale, archived, pinned, outOfSync: outOfSyncCount }
}

/** Build the `VaultInfo` the UI renders. */
export function vaultInfo(input: {
  root: string
  reused: boolean
  initialized: boolean
  obsidianVault: boolean
  stats: VaultStats
  indexBuiltAt: string | null
  indexCount: number
  indexHealthy: boolean
  indexPath: string
}): VaultInfo {
  return {
    path: input.root,
    reused: input.reused,
    initialized: input.initialized,
    obsidianVault: input.obsidianVault,
    stats: input.stats,
    index: {
      builtAt: input.indexBuiltAt,
      count: input.indexCount,
      healthy: input.indexHealthy,
      path: input.indexPath,
    },
  }
}

/** True when the directory exists and carries our marker. */
export async function vaultStatus(root: string): Promise<{ initialized: boolean; obsidianVault: boolean; exists: boolean }> {
  return {
    initialized: await isMemoryVault(root),
    obsidianVault: await hasObsidianMarker(root),
    exists: await isDirectory(root),
  }
}

/** List unexpected top-level entries, so initialization can report interference. */
export async function topLevelEntries(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

function relativeTo(root: string, absolute: string): string {
  return absolute.slice(root.length).replace(/^[\\/]+/, '').split('\\').join('/')
}

function renderVaultReadme(root: string): string {
  const now = new Date().toISOString()
  const categories = Object.values(TYPE_DESCRIPTORS)
    .map((descriptor) => `| \`${descriptor.dir}/\` | ${descriptor.labelZh} | 用户内容 |`)
    .join('\n')

  return `---
title: DSH Memory Vault
generated_by: dsh-longterm-memory
generated_at: ${now}
---

# DSH 长期记忆仓库

这是由 **DSH Memory Vault**（DSH 插件「长期记忆」，包名 \`dsh-longterm-memory\`）管理的
Obsidian 仓库。**Markdown 文件是记忆的唯一事实来源**；插件在 \`.dsh-memory/\` 下保存的索引
与日志都是可重建的辅助数据。

仓库路径：\`${root}\`

## 目录说明

### 用户内容（可以自由阅读和编辑）

| 目录 | 内容 | 归属 |
| --- | --- | --- |
${categories}
| \`Inbox/\` | 待确认的候选记忆 | 用户内容 |
| \`Archive/\` | 已归档、被替代的记忆 | 用户内容 |
| \`Conflicts/\` | 存在事实冲突的记忆 | 用户内容 |
| \`Index/\` | 人类可读的索引页（插件会重写） | 插件生成 |
| \`History/\` | 变更历史说明 | 插件生成 |

在本仓库中直接编辑 Markdown 是**受支持**的操作。插件会检测到文件被外部修改，并自动
同步索引；如果元数据被改坏，记忆会进入隔离清单而不是破坏整个索引。

### 插件私有目录（不要手动编辑）

| 路径 | 用途 | 可否删除 |
| --- | --- | --- |
| \`.dsh-memory/config.json\` | 仓库标记与插件设置 | 删除后需重新初始化 |
| \`.dsh-memory/index.json\` | 可重建的本地索引 | **可以**，会自动重建 |
| \`.dsh-memory/journal/\` | 变更历史（JSONL） | 可以 |
| \`.dsh-memory/quarantine/\` | 迁移失败记录的清单 | 可以 |
| \`.obsidian/\` | 让 Obsidian 识别本目录为仓库 | 保留 |

> 只删除 \`.dsh-memory/index.json\` 不会丢失任何记忆：索引可以从 Markdown 完整重建。

## 在 Obsidian 中打开

Obsidian 不会自动登记新仓库（插件不会修改 Obsidian 全局配置）。请使用
**「Open folder as vault」** 选择本目录。

## 记忆文件格式

每条记忆是一个独立的 Markdown 文件，带 YAML Frontmatter：

\`\`\`markdown
---
id: mem_20261017t031200_a1b2c3d4
type: decision
status: active
created_at: 2026-10-17T03:12:00.000Z
updated_at: 2026-10-17T03:12:00.000Z
tags:
  - decision
confidence: high
---

# 记忆标题

## 核心内容

用自然语言描述这条记忆。

## 来源与依据

可追溯的来源标识。

## 相关记忆

- [[另一条记忆的标题]]
\`\`\`

完整字段说明见插件仓库的 \`docs/storage-format.md\`。
`
}

function renderMemoryHome(): string {
  return `# 记忆主页

这是「长期记忆」插件的入口页。推荐从这里开始浏览：

- [[all-memories]] — 全部记忆
- [[preferences]] — 长期偏好
- [[projects]] — 项目
- [[decisions]] — 决策
- [[knowledge]] — 知识
- [[experiences]] — 经验教训
- [[tasks]] — 任务

> 本文件由插件初始化时创建，之后不会自动重写，可以自由编辑。
`
}

/**
 * The generated index notes, at absolute paths inside the vault.
 *
 * Paths are built from the vault's own index directory rather than from a
 * relative fragment: a relative path here would silently create `Index/` beside
 * the process working directory instead of inside the vault.
 */
function renderIndexNotes(indexDir: string): { path: string; content: string }[] {
  const notes: { path: string; content: string }[] = [
    {
      path: join(indexDir, 'all-memories.md'),
      content: `---
generated_by: dsh-longterm-memory
---

# 全部记忆

> 本页由插件重建索引时生成，手动修改会在下次重建时被覆盖。
`,
    },
  ]
  for (const descriptor of Object.values(TYPE_DESCRIPTORS)) {
    notes.push({
      path: join(indexDir, `${descriptor.type}.md`),
      content: `---
generated_by: dsh-longterm-memory
---

# ${descriptor.labelZh}

> 本页由插件重建索引时生成，手动修改会在下次重建时被覆盖。
`,
    })
  }
  return notes
}

/** The concrete `MemoryStatus` values a directory may hold, for caller convenience. */
export function statusesInDirectory(directory: string): MemoryStatus[] {
  if (directory === VAULT_DIRS.inbox) return ['pending']
  if (directory === VAULT_DIRS.archive) return ['archived', 'superseded']
  if (directory === VAULT_DIRS.conflicts) return ['conflict']
  return ['active', 'stale']
}

/** Human label for the default vault folder, exported for UI copy. */
export const DEFAULT_FOLDER_NAME = DEFAULT_VAULT_FOLDER

/** Directory the plugin owns; exported so callers do not re-declare it. */
export const PRIVATE_DIR_NAME = PRIVATE_DIR

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
