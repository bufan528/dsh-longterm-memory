/**
 * `MemoryService` — the single coordination point over the vault, index,
 * repository, and engine.
 *
 * Every RPC method and every DSH integration path goes through here, so there is
 * exactly one place that decides when the index is refreshed, when a write is
 * safe, and what a candidate turns into.
 *
 * @module dsh-longterm-memory/host/core/service
 */

import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import {
  CONFIDENCE_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  TYPE_DESCRIPTORS,
  type Confidence,
  type JournalEntry,
  type Memory,
  type MemoryCandidate,
  type MemoryStatus,
  type MemoryType,
  type VaultDiscovery,
  type VaultInfo,
} from '../../shared/types.js'
import { newMemoryId, nowIso } from '../../shared/validate.js'
import { normalizeQqLinkage, QQ_LINKAGE_MODES, QQ_WRITE_MODES, type QqLinkageConfig } from '../../shared/qq-linkage.js'
import type { QqbotMergeConfig, QqbotMergeReport } from '../../shared/qqbot-merge-contract.js'
import type { QqHostFacts, QqLinkageReport } from '../../shared/protocol.js'
import { QqLinkageRuntime } from '../qq/linkage.js'
import { MergeBridgeError, QqbotMergeBridge } from '../qq/merge-bridge.js'
import {
  INDEX_FORMAT_VERSION,
  checksum,
  queryIndex,
  type IndexRecord,
  type MemoryIndex,
  type QueryFilters,
  type SearchHit,
  emptyIndex,
} from '../../shared/search.js'
import {
  DEFAULT_SETTINGS,
  ERROR_CODES,
  type CapabilityReport,
  type GetResponse,
  type MergeRequest,
  type OverviewResponse,
  type PluginSettings,
  type RebuildIndexResponse,
  type SaveRequest,
  type SaveResponse,
  type SearchRequest,
  type SearchResponse,
  type StatusResponse,
  type SyncIndexResponse,
  type WireHit,
  toWireHit,
} from '../../shared/protocol.js'
import { FsError, pathExists, readTextIfExists, writeFileAtomic } from './fsx.js'
import { checkTargetUsable, discoverVault } from './discover.js'
import { layoutFor, type VaultLayout } from './layout.js'
import { MemoryRepository, scanVault, summarize } from './repository.js'
import {
  buildIndex,
  detectOutOfSync,
  journalIndexEvent,
  loadIndex,
  persistIndex,
  syncIndex,
  writeIndexNotes,
} from './indexing.js'
import { collectStats, initializeVault, readVaultConfig, verifyVault, vaultInfo, vaultStatus, writeVaultConfig } from './vault.js'
import {
  candidatesFromModel,
  compareCandidate,
  comparisonTerms,
  extractFromTurn,
  mayAutoApply,
  overlapCoefficient,
  viewsFromIndex,
  type TurnInput,
} from './engine.js'
import { LLM_LIMITS, parseModelAnswer, type LlmAdapter } from './llm-extraction.js'
import { confineDiscoveryToTestRoot } from './discovery-guard.js'
import { renderMemory } from '../../shared/markdown.js'
import { CURRENT_PURPOSE, relatedFor, renderHits, standingFacts, tagCounts, retrieveForTask } from './retrieval.js'
import { estimateTokens } from '../../shared/recall.js'

/** Host-side error carrying an RPC error code. */
export class ServiceError extends Error {
  readonly code: string
  readonly detail: string | undefined

  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.detail = detail
  }
}

export interface ServiceDeps {
  /** Where the plugin was told the vault is, before discovery. */
  configuredVaultPath?: string | null
  /** Settings coming from the Cordis row config. */
  configSettings?: Partial<PluginSettings>
  /**
   * Injected discovery, used by tests to control which Obsidian vaults are
   * "present" without reading (or writing) the real machine's configuration.
   */
  discoveryProvider?: () => Promise<VaultDiscovery>
  /**
   * Optional model access for memory extraction. Absent means the feature stays
   * off; it is injected rather than imported so the whole chain is testable
   * without a model call.
   */
  llmAdapter?: LlmAdapter
  /** Reports what the DSH host actually exposed. */
  capabilities?: Partial<CapabilityReport>
  /** Test seam: called at commit boundaries so a child process can be killed there. */
  commitBarrier?: (phase: 'after-stage' | 'after-write' | 'after-survivor' | 'after-other' | 'after-commit') => Promise<void> | void
  /**
   * Absolute path of the loaded host module (`lib/host/index.js`).
   *
   * Used only to derive the **real** DSH profile this process was loaded into:
   * an installed plugin lives at `<DSH_HOME>/profiles/<name>/node_modules/...`,
   * which is a stronger fact than an inherited `DSH_PROFILE` environment
   * variable. Omitted in tests and in self-linked dev installs, in which case the
   * report falls back to the environment and says so.
   */
  modulePath?: string
  logger?: { info: (message: string, ...rest: unknown[]) => void; warn: (message: string, ...rest: unknown[]) => void }
}

export interface TurnProcessingResult {
  candidates: MemoryCandidate[]
  applied: { id: string; action: string }[]
  refused: { reason: string; excerpt: string }[]
  pending: MemoryCandidate[]
  /** True when this exact turn had already been processed (retry / replay). */
  skippedAsDuplicate?: boolean
  /** What the optional model pass did, for the audit trail. */
  modelNote?: string
}

export interface MergePlanStep {
  id: string
  from: string
  to: string
  before: string | null
  after: string
  memory: Memory
}

export interface MergePlanEvent {
  eventId: string
  entry: Record<string, unknown>
}

export interface MergeOperationPlan {
  operationId: string
  at: string
  kind: 'merge'
  survivorId: string
  steps: MergePlanStep[]
  events: MergePlanEvent[]
  result: { id: string; mergedIds: string[] }
}
export class MemoryService {
  private root: string | null = null
  private repository: MemoryRepository | null = null
  private layout: VaultLayout | null = null
  private index: MemoryIndex | null = null
  /** Effective settings (defaults ← config ← user). */
  private settings: PluginSettings
  /** Only the fields the user changed through the management page. */
  private userSettings: Partial<PluginSettings> = {}
  private capabilities: CapabilityReport
  private busy = false
  private discovery: VaultDiscovery | null = null
  private readonly deps: ServiceDeps
  private candidates: MemoryCandidate[] = []
  private lastIndexError: string | null = null
  /** Turn keys already processed; bounded so a long-lived host cannot grow it. */
  private readonly handledTurns = new Set<string>()
  /** Last model-extraction outcome, surfaced for the audit trail. */
  private lastModelNote: string | undefined
  /** True when this run created the vault (as opposed to adopting an existing one). */
  private vaultCreated = false
  /** The registered system-prompt section descriptor, for honest self-inspection. */
  private standingProbe: { name: string; order: number; text: (context?: unknown) => string } | undefined
  /**
   * QQ 接入联动的运行时。
   *
   * 它与本服务同生命周期，配置从 `this.settings.qqLinkage` 实时读取，因此页面
   * 上保存的策略会立刻在四个执行点生效；计数与样本只存在内存里，从不写盘。
   */
  readonly linkage: QqLinkageRuntime
  /**
   * 「连续消息智能合并」跨插件桥。
   *
   * 真实执行者在独立扩展 `dsh-qqbot-merge` 里；这里只消费它提供的 `qqbotMerge`
   * 服务。扩展缺席时报告 `available: false`，页面据此显示 BLOCKED，绝不伪造开关。
   */
  readonly qqMerge: QqbotMergeBridge

  constructor(deps: ServiceDeps = {}) {
    this.deps = deps
    this.settings = { ...DEFAULT_SETTINGS }
    if (deps.configuredVaultPath !== undefined && deps.configuredVaultPath !== null) {
      this.settings.vaultPath = deps.configuredVaultPath
    }
    this.linkage = new QqLinkageRuntime({
      config: () => this.settings.qqLinkage,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    })
    this.qqMerge = new QqbotMergeBridge({
      profileDir: () => {
        const derived = deriveProfileFromModulePath(deps.modulePath)
        if (derived !== null) return derived.dir
        const fromEnv = typeof process === 'undefined' ? undefined : process.env['DSH_PROFILE_DIR']
        return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : null
      },
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    })
    this.recomputeSettings()
    this.capabilities = {
      filesystem: true,
      webServer: false,
      systemPrompt: false,
      tools: false,
      sessionEvents: false,
      llmExtraction: false,
      registeredTools: [],
      notes: {},
      ...(deps.capabilities ?? {}),
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Report capabilities back to the caller after the host adapters initialise. */
  setCapabilities(patch: Partial<CapabilityReport>): void {
    this.capabilities = { ...this.capabilities, ...patch, notes: { ...this.capabilities.notes, ...(patch.notes ?? {}) } }
  }

  getCapabilities(): CapabilityReport {
    return this.capabilities
  }

  getSettings(): PluginSettings {
    return { ...this.settings }
  }

  isReady(): boolean {
    return this.root !== null && this.index !== null
  }

  getVaultPath(): string | null {
    return this.root
  }

  /**
   * Resolve the vault and make the index usable.
   *
   * Called on plugin activation and before any read. Three cases, in order:
   *
   * 1. A usable vault already exists → attach it (reuse, never recreate).
   * 2. A path is configured but does not exist → create it there. An explicit
   *    path in `cordis.patch.yml`, or one chosen earlier in the UI, is an
   *    instruction, so no ambiguity is involved.
   * 3. Nothing is configured → use the discovered default, but only on a
   *    **desktop** host. On a server-side host the discovered filesystem is not
   *    known to be the user's own machine, so the plugin asks instead of
   *    creating a vault somewhere the user cannot see.
   *
   * A missing or corrupt index is rebuilt from Markdown here, which is why an
   * index loss is never a data loss.
   */
  async ensureReady(): Promise<boolean> {
    if (this.root !== null && this.index !== null) return true

    // An explicit `vaultPath` is an instruction and must win over discovery. If the
    // discovered location were checked first, a vault that merely *exists* at the
    // default place would silently override the user's configuration — including in
    // tests, where that default can be a real home directory.
    const configured = this.settings.vaultPath
    if (configured !== null && configured !== undefined && configured.trim().length > 0) {
      const discovery = await this.getDiscovery()
      const usable = await checkTargetUsable(configured, { obsidianVaults: discovery.obsidian.vaults })
      if (!usable.ok) {
        this.deps.logger?.warn('dsh-longterm-memory: configured vault path is unusable: %s', usable.reason)
        return false
      }
      await this.initialize(configured)
      return true
    }

    const discovery = await this.getDiscovery()
    if (discovery.current !== null) {
      await this.attach(discovery.current)
      return true
    }

    if (discovery.needsChoice || discovery.candidates.length === 0) return false
    if (discovery.environment !== 'desktop') return false
    const target = discovery.candidates[0]
    if (target === undefined) return false
    await this.initialize(target)
    return true
  }

  private async attach(root: string): Promise<void> {
    this.root = resolve(root)
    this.layout = layoutFor(this.root)
    this.repository = new MemoryRepository(this.root)
    await this.repository.ensureDirectories()
    // Finish archiving history events that were staged before the last shutdown.
    await this.repository.recoverPreparedSaves()
    await this.repository.flushJournal()
    await this.recoverOperations()
    
    await this.loadOrRebuildIndex()
    // Read the user's stored choices before writing anything back, so a fresh
    // activation cannot overwrite them with this run's defaults.
    await this.loadPersistedSettings()
    await this.persistSettings()
  }

  /**
   * Load the persisted index, then reconcile it with Markdown on disk.
   *
   * The index is derived data, and the most natural way a user edits memory is in
   * Obsidian while DSH is closed. Trusting the persisted index alone would make
   * such an edit — including archiving a note by changing `status:` — invisible
   * until someone pressed "sync index", which would leave the model reading stale
   * facts on the very first turn after a restart. One directory walk plus one read
   * per changed file is cheap, so startup reconciles instead.
   *
   * A missing or corrupt index is rebuilt from Markdown here, which is why an
   * index loss is never a data loss.
   */
  private async loadOrRebuildIndex(): Promise<void> {
    const layout = this.layout
    if (layout === null || this.root === null) return
    const loaded = await loadIndex(layout)
    if (loaded.ok && loaded.index.vaultPath === this.root) {
      // An index from another vault path is not trustworthy even if well-formed.
      this.index = loaded.index
      this.lastIndexError = null
      await this.reconcileIndexWithMarkdown('启动时检测到 Markdown 在插件之外被修改，已增量同步索引')
      return
    }
    if (!loaded.ok) this.lastIndexError = loaded.reason
    await this.rebuildIndexInternal('索引缺失、损坏或与当前仓库不匹配，已从 Markdown 重建')
  }

  /**
   * Bring the in-memory index in line with the files on disk, persisting only when
   * something actually changed.
   */
  private async reconcileIndexWithMarkdown(reason: string): Promise<void> {
    if (this.index === null || this.root === null || this.layout === null) return
    try {
      const result = await syncIndex(this.root, this.index)
      this.index = result.index
      if (result.added.length === 0 && result.updated.length === 0 && result.removed.length === 0) return
      await persistIndex(this.layout, result.index)
      await writeIndexNotes(this.root, result.index)
      await journalIndexEvent(this.layout, {
        at: nowIso(),
        op: 'index-sync',
        id: '*',
        reason,
        after: `新增 ${String(result.added.length)}，更新 ${String(result.updated.length)}，移除 ${String(result.removed.length)}`,
      })
      this.deps.logger?.info(
        'dsh-longterm-memory: startup sync +%d ~%d -%d',
        result.added.length,
        result.updated.length,
        result.removed.length,
      )
    } catch (error) {
      // A failed reconciliation must not block activation; the index stays usable
      // and the next explicit sync or rebuild will fix it.
      this.deps.logger?.warn('dsh-longterm-memory: startup index reconciliation failed: %o', error)
    }
  }

  private async rebuildIndexInternal(reason: string): Promise<RebuildIndexResponse> {
    if (this.root === null || this.layout === null) {
      throw new ServiceError(ERROR_CODES.notInitialized, '仓库尚未初始化，无法重建索引。')
    }
    this.busy = true
    try {
      const built = await buildIndex(this.root)
      this.index = built.index
      await persistIndex(this.layout, built.index)
      await writeIndexNotes(this.root, built.index)
      await journalIndexEvent(this.layout, {
        at: nowIso(),
        op: 'index-rebuild',
        id: '*',
        reason,
        after: `${String(built.index.records.size)} 条记录`,
      })
      this.settings = { ...this.settings, lastIndexRebuild: built.index.builtAt }
      await this.persistSettings()
      this.lastIndexError = null
      return {
        records: built.index.records.size,
        repairedFiles: built.repaired.length,
        quarantined: built.rejected.map((entry) => ({ path: entry.relativePath, reason: entry.reason })),
        duplicates: built.duplicates,
        tookMs: built.tookMs,
      }
    } finally {
      this.busy = false
    }
  }

  /* --------------------------------------------------------------- settings */

  /**
   * Persist only the values the user actually changed.
   *
   * Storing the whole resolved object would freeze today's defaults onto disk,
   * so a later change to the composition's `config` (or to a default) would be
   * silently ignored. Keeping the user's delta separate is what lets
   * `cordis.patch.yml` stay the source of composition defaults.
   */
  /**
   * Persist the stored settings delta.
   *
   * @returns whether the settings reached disk. Callers that changed settings must
   *   surface a `false` as an error: reporting success for a change that was not
   *   persisted would make the UI and the vault disagree after a restart.
   */
  private async persistSettings(candidate: Partial<PluginSettings> = this.userSettings): Promise<boolean> {
    if (this.layout === null) return false
    try {
      await writeVaultConfig(this.layout, { settings: { ...candidate } })
      return true
    } catch (error) {
      this.deps.logger?.warn('could not persist settings: %o', error)
      return false
    }
  }

  /** Read the user's stored delta and recompute the effective settings. */
  async loadPersistedSettings(): Promise<void> {
    if (this.layout === null) {
      this.recomputeSettings()
      return
    }
    const config = await readVaultConfig(this.layout)
    const stored = config === null ? {} : (config.settings as Partial<PluginSettings>)
    this.userSettings = { ...stored }
    this.recomputeSettings()
  }

  /** Effective settings: built-in defaults ← composition config ← the user's choices. */
  private recomputeSettings(): void {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(this.deps.configSettings ?? {}),
      ...this.userSettings,
    }
    // 联动配置是嵌套对象：逐字段合并 config 与用户选择，再归一化。直接整体覆盖
    // 会让「只改了 mode」的保存把 config 里的 QQ 标记整段抹掉。
    const configured = normalizeQqLinkage(this.deps.configSettings?.qqLinkage)
    const chosen = this.userSettings.qqLinkage as Partial<QqLinkageConfig> | undefined
    this.settings.qqLinkage = mergeQqLinkage(configured, chosen)
    if (this.deps.configuredVaultPath !== undefined && this.deps.configuredVaultPath !== null && this.userSettings.vaultPath === undefined) {
      this.settings.vaultPath = this.deps.configuredVaultPath
    }
  }

  async setSettings(patch: Partial<PluginSettings>): Promise<PluginSettings> {
    validateSettingsPatch(patch)
    let vaultSelection: string | null | undefined
    if (patch.vaultPath !== undefined && patch.vaultPath !== this.settings.vaultPath) {
      vaultSelection = patch.vaultPath === null ? null : await this.resolveVaultSelection(patch.vaultPath)
    }
    const rest: Partial<PluginSettings> = { ...patch }
    delete rest.vaultPath

    // Persist the candidate first and commit to the running instance only afterwards.
    // Otherwise a failed write leaves the process on the new values while the error
    // says "本次修改未生效", and the UI would disagree with the vault until restart.
    const candidate: Partial<PluginSettings> = {
      ...this.userSettings,
      ...rest,
      ...(vaultSelection === undefined ? {} : { vaultPath: vaultSelection }),
    }
    const persisted = await this.persistSettings(candidate)
    if (!persisted) {
      throw new ServiceError(ERROR_CODES.internal, '设置未能写入磁盘，本次修改未生效。')
    }
    this.userSettings = candidate
    this.recomputeSettings()
    return this.getSettings()
  }

  /* ------------------------------------------------------- QQ 接入联动 */

  /**
   * 读取 QQ 接入联动报告：配置、运行时能力、执行点注册情况、宿主事实、
   * 最近会话判定样本与拦截计数。
   *
   * 页面拿到的是**同一份判定**（shared/qq-linkage 的纯函数），所以「页面显示的
   * 策略」与「后端真正执行的策略」不可能不一致。
   */
  qqLinkageReport(): QqLinkageReport {
    return this.linkage.report(hostFacts(this.deps.modulePath), this.root)
  }

  /**
   * 更新 QQ 接入联动配置。
   *
   * 只接受 {@link QqLinkageConfig} 的字段：枚举值在边界校验，标记列表在归一化
   * 时去空/去重/限长。配置通过既有的 Vault 设置持久化机制写盘，不新建数据库。
   */
  async setQqLinkage(patch: Partial<QqLinkageConfig>): Promise<QqLinkageReport> {
    validateQqLinkagePatch(patch)
    const merged = mergeQqLinkage(normalizeQqLinkage(this.settings.qqLinkage), patch)
    await this.setSettings({ qqLinkage: merged })
    return this.qqLinkageReport()
  }

  /* ------------------------------------------- QQ 连续消息智能合并（跨插件） */

  /**
   * 读取「连续消息智能合并」的真实状态。
   *
   * 数据全部来自运行中的 QQ 扩展（`qqbotMerge` 服务）；扩展不在时返回
   * `available: false` + 原因，页面据此显示 BLOCKED，而不是显示一个假开关。
   */
  async qqMergeReport(): Promise<QqbotMergeReport> {
    return this.qqMerge.report()
  }

  /**
   * 把合并配置写入运行中的 QQ 扩展。
   *
   * 扩展不在时直接拒绝（`unsupported`）：在 Memory Vault 里存一个值而没有任何
   * 运行时会读取它，是最容易骗过用户的做法，这里显式禁止。
   */
  async setQqMerge(patch: Partial<QqbotMergeConfig>): Promise<QqbotMergeReport> {
    try {
      return await this.qqMerge.setConfig(patch)
    } catch (error) {
      if (error instanceof MergeBridgeError) {
        const code = error.code === ERROR_CODES.unsupported ? ERROR_CODES.unsupported : error.code === ERROR_CODES.invalid ? ERROR_CODES.invalid : ERROR_CODES.internal
        throw new ServiceError(code, error.message)
      }
      throw error
    }
  }

  /* -------------------------------------------------------------- discovery */

  async getDiscovery(force = false): Promise<VaultDiscovery> {
    if (this.discovery !== null && !force) return this.discovery
    const discovery =
      this.deps.discoveryProvider !== undefined
        ? await this.deps.discoveryProvider()
        : await discoverVault({ configuredPath: this.settings.vaultPath })
    this.discovery = confineDiscoveryToTestRoot(discovery)
    return this.discovery
  }

  /**
   * Adopt an explicit vault path chosen by the user.
   *
   * A path that already holds foreign data is refused; a path that is already
   * ours is reused without rewriting anything.
   */
  async chooseVault(path: string): Promise<StatusResponse> {
    await this.handleVaultSelection(path)
    this.discovery = null
    await this.attach(resolve(path))
    await this.loadPersistedSettings()
    return this.status()
  }

  /**
   * Validate a requested vault path without changing any runtime state.
   *
   * The switch itself is only committed after the settings write succeeds, so a
   * rejected or unpersistable update cannot leave the instance pointing elsewhere.
   */
  private async resolveVaultSelection(path: string): Promise<string> {
    const target = resolve(path)
    const discovery = await this.getDiscovery()
    const usable = await checkTargetUsable(target, { obsidianVaults: discovery.obsidian.vaults })
    if (!usable.ok) throw new ServiceError(ERROR_CODES.forbidden, usable.reason, target)
    return target
  }

  /** Validate and apply a vault selection immediately (used by explicit chooseVault). */
  private async handleVaultSelection(path: string): Promise<void> {
    const target = await this.resolveVaultSelection(path)
    this.settings = { ...this.settings, vaultPath: target }
  }

  /** Run initialization for the discovered (or supplied) target. */
  async initialize(path?: string): Promise<StatusResponse> {
    const target = path ?? this.settings.vaultPath ?? (await this.getDiscovery()).candidates[0]
    if (target === undefined || target === null || target.length === 0) {
      throw new ServiceError(
        ERROR_CODES.needsChoice,
        '无法自动确定仓库位置，请先选择一个目录。',
        (await this.getDiscovery()).rationale,
      )
    }
    const discovery = await this.getDiscovery()
    const usable = await checkTargetUsable(target, { obsidianVaults: discovery.obsidian.vaults })
    if (!usable.ok) throw new ServiceError(ERROR_CODES.forbidden, usable.reason, target)

    // Record the target as the effective vault path *before* the marker is
    // written: `initializeVault` seeds the marker's `settings` from what it is
    // given, so passing the previous (possibly ignored or stale) path would bake a
    // wrong `vaultPath` into the new vault, which later boots would then treat as
    // the user's own choice and let it override the composition config.
    const resolvedTarget = resolve(target)
    this.settings = { ...this.settings, vaultPath: resolvedTarget }
    this.userSettings = { ...this.userSettings, vaultPath: resolvedTarget }

    const result = await initializeVault(resolvedTarget, {
      settings: { ...this.settings },
      obsidianVaults: discovery.obsidian.vaults,
    })
    if (!result.verification.ok) {
      throw new ServiceError(
        ERROR_CODES.internal,
        `仓库初始化完成但读写校验失败：${result.verification.failures.join('；')}`,
        resolvedTarget,
      )
    }
    this.vaultCreated = result.created
    this.discovery = null
    await this.attach(resolvedTarget)
    await this.loadPersistedSettings()
    await this.repository?.journal({
      at: nowIso(),
      op: 'init',
      id: '*',
      reason: result.created ? '首次初始化长期记忆仓库' : '复用已存在的长期记忆仓库',
      after: target,
    })
    return this.status()
  }

  /**
   * Markdown ⇄ index inconsistencies that have been **discovered and not yet
   * repaired**, keyed by record id.
   *
   * Contract: this is current state, not an event log. Detecting the same file
   * twice keeps one entry; a repair removes exactly the ids it fixed; a failed
   * repair keeps them. `status()` and `overview()` both report this registry, so
   * the page can never disagree with the service.
   */
  private desynced = new Map<string, string>()

  /** Note an inconsistency found by any path (injection check, stat scan). */
  private markDesynced(id: string, reason: string): void {
    this.desynced.set(id, reason)
  }

  /** A record was just confirmed to match its file. */
  private clearDesynced(id: string): void {
    this.desynced.delete(id)
  }

  /**
   * Authoritative stat-only refresh across the whole index: one `stat` per record,
   * no file reads, deduplicated by id. If the scan itself fails, the previous
   * state is kept rather than reported as healthy.
   */
  private async refreshDiagnostics(): Promise<void> {
    if (this.root === null || this.index === null) return
    try {
      const found = await detectOutOfSync(this.root, this.index)
      this.desynced.clear()
      for (const id of found) this.desynced.set(id, 'file-changed')
    } catch (error) {
      this.deps.logger?.warn('dsh-longterm-memory: diagnostics scan failed; keeping previous state: %o', error)
    }
  }

  /**
   * After a repair, drop the ids that are consistent again and keep the rest.
   * One read per still-suspected entry, never a second full scan.
   */
  private async recheckDiagnostics(): Promise<void> {
    if (this.root === null || this.index === null) return
    for (const id of [...this.desynced.keys()]) {
      const record = this.index.records.get(id)
      if (record === undefined) {
        // The repair removed the stale record, so nothing disagrees any more.
        this.desynced.delete(id)
        continue
      }
      try {
        const text = await readTextIfExists(resolve(this.root, record.path))
        if (text !== null && checksum(text) === record.checksum) this.desynced.delete(id)
      } catch (error) {
        this.deps.logger?.warn('dsh-longterm-memory: repair recheck failed for %s: %o', id, error)
      }
    }
  }
  async status(): Promise<StatusResponse> {
    const discovery = await this.getDiscovery()
    const vault = await this.buildVaultInfo()
    return { vault, discovery, capabilities: this.capabilities, settings: this.getSettings() }
  }

  private async buildVaultInfo(): Promise<VaultInfo | null> {
    if (this.root === null || this.layout === null || this.index === null) return null
    const status = await vaultStatus(this.root)
    const stats = await collectStats(
      [...this.index.records.values()].map((record) => ({
        type: record.type,
        status: record.status,
        pinned: record.pinned,
      })),
      // Discovered-but-unrepaired inconsistencies, from the shared registry.
      this.desynced.size,
    )
    return vaultInfo({
      root: this.root,
      reused: status.initialized && !this.vaultCreated,
      initialized: status.initialized,
      obsidianVault: status.obsidianVault,
      stats,
      indexBuiltAt: this.index.builtAt,
      indexCount: this.index.records.size,
      indexHealthy: this.lastIndexError === null,
      indexPath: this.layout.index,
    })
  }

  /* ------------------------------------------------- single-record commit */

  /** Stage one single-record intent with its recovery metadata, before any write. */
  private async stageIntent(entry: JournalEntry, metadata: Record<string, unknown>): Promise<string> {
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    ;(entry as unknown as Record<string, unknown>)['commitMetadata'] = metadata
    return await this.repository.stageJournal(entry)
  }

  /** Decide what the on-disk state says about a staged single-record intent. */
  private async classifyIntent(metadata: Record<string, unknown>): Promise<'after' | 'before' | 'other'> {
    if (this.repository === null) return 'other'
    const before = typeof metadata['before'] === 'string' ? metadata['before'] : null
    const after = typeof metadata['after'] === 'string' ? metadata['after'] : null
    if (metadata['kind'] === 'write' && typeof metadata['path'] === 'string' && after !== null) {
      const actual = await this.repository.checksumAt(metadata['path'])
      if (actual === after) return 'after'
      return actual === before ? 'before' : 'other'
    }
    if (metadata['kind'] === 'move' && typeof metadata['from'] === 'string' && typeof metadata['to'] === 'string') {
      const target = await this.repository.checksumAt(metadata['to'])
      const source = await this.repository.checksumAt(metadata['from'])
      if (after !== null && target === after) return 'after'
      return source !== null && source === before && target === null ? 'before' : 'other'
    }
    if (metadata['kind'] === 'remove' && typeof metadata['path'] === 'string') {
      const actual = await this.repository.checksumAt(metadata['path'])
      if (actual === null) return 'after'
      return before !== null && actual === before ? 'before' : 'other'
    }
    return 'other'
  }

  /** Converge a staged intent: commit when done, discard only when provably not done. */
  private async settleIntent(stagedId: string, metadata: Record<string, unknown>, _failure?: unknown): Promise<void> {
    if (this.repository === null) return
    const outcome = await this.classifyIntent(metadata)
    if (outcome === 'after') {
      await this.repository.commitJournal(stagedId)
      await this.repository.flushJournal()
      return
    }
    if (outcome === 'before') {
      await this.repository.discardJournal(stagedId).catch(() => undefined)
      return
    }
    throw new ServiceError(
      ERROR_CODES.internal,
      '操作提交状态无法判定：领域数据既不符合操作前也不符合预期操作后状态，已保留历史证据，请人工核对。',
    )
  }

  /** Index refresh is derived work: its failure must not make a committed write look failed. */
  private async refreshAfterWriteQuietly(): Promise<void> {
    try {
      await this.refreshAfterWrite()
    } catch (error) {
      this.deps.logger?.warn('dsh-longterm-memory: index refresh after commit failed (index is rebuildable): %o', error)
    }
  }

  /** Shared commit protocol for single-record removal. */
  private async removeWithIntent(id: string, reason: string): Promise<void> {
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    const detail = await this.get(id)
    const metadata: Record<string, unknown> = {
      kind: 'remove',
      path: detail.relativePath,
      before: await this.repository.checksumAt(detail.relativePath),
    }
    const stagedId = await this.stageIntent(
      { at: nowIso(), op: 'delete', id, before: summarize(detail.memory), reason },
      metadata,
    )
    try {
      await this.repository.remove(id, reason, undefined, { skipJournal: true })
      await this.deps.commitBarrier?.('after-write')
    } catch (error) {
      await this.settleIntent(stagedId, metadata, error).catch(() => undefined)
      throw error
    }
    // Commit, then fire the barrier, and only afterwards archive: this is what makes
    // "committed but not yet archived" a real, testable state for remove.
    const outcome = await this.classifyIntent(metadata)
    if (outcome === 'after') {
      await this.repository.commitJournal(stagedId)
      await this.deps.commitBarrier?.('after-commit')
      await this.repository.flushJournal()
    } else if (outcome === 'before') {
      await this.repository.discardJournal(stagedId).catch(() => undefined)
    } else {
      throw new ServiceError(
        ERROR_CODES.internal,
        '操作提交状态无法判定：领域数据既不符合操作前也不符合预期操作后状态，已保留历史证据，请人工核对。',
      )
    }
    await this.refreshAfterWriteQuietly()
  }
  /** Shared commit protocol for single-record saves (transition and setPinned). */
  private async commitSingleSave(id: string, loaded: { relativePath: string; memory: Memory }, next: Memory, op: JournalEntry['op'], reason: string): Promise<void> {
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    const fromPath = loaded.relativePath
    const toPath = this.repository.predictSavePath(next)
    const metadata: Record<string, unknown> = {
      kind: 'move',
      from: fromPath,
      to: toPath,
      before: await this.repository.checksumAt(fromPath),
      after: checksum(renderMemory(next)),
    }
    const stagedId = await this.stageIntent(
      { at: nowIso(), op, id, before: summarize(loaded.memory), after: summarize(next), reason },
      metadata,
    )
    try {
      await this.repository.save(next)
      await this.deps.commitBarrier?.('after-write')
    } catch (error) {
      await this.settleIntent(stagedId, metadata, error).catch(() => undefined)
      throw error
    }
    // Commit, fire the commit barrier, and only then archive. A crash at
    // "after-commit" must leave a COMMITTED event that is not yet archived.
    const outcome = await this.classifyIntent(metadata)
    if (outcome === 'after') {
      await this.repository.commitJournal(stagedId)
      await this.deps.commitBarrier?.('after-commit')
      await this.repository.flushJournal()
    } else if (outcome === 'before') {
      await this.repository.discardJournal(stagedId).catch(() => undefined)
    } else {
      throw new ServiceError(
        ERROR_CODES.internal,
        '操作提交状态无法判定：领域数据既不符合操作前也不符合预期操作后状态，已保留历史证据，请人工核对。',
      )
    }
    await this.refreshAfterWriteQuietly()
  }
  /* --------------------------------------------------------------- reading */

  private requireIndex(): { index: MemoryIndex; root: string; layout: VaultLayout } {
    if (this.index === null || this.root === null || this.layout === null) {
      throw new ServiceError(ERROR_CODES.notInitialized, '长期记忆仓库尚未初始化，请先在管理页面完成初始化。')
    }
    return { index: this.index, root: this.root, layout: this.layout }
  }

  async overview(): Promise<OverviewResponse> {
    const { index, root } = this.requireIndex()
    await this.refreshDiagnostics()
    const outOfSync = [...this.desynced.keys()]
    const duplicates = (await scanVault(root)).duplicates
    const vault = await this.buildVaultInfo()
    if (vault === null) throw new ServiceError(ERROR_CODES.notInitialized, '仓库信息不可用。')

    const records = [...index.records.values()]
    const stats = await collectStats(
      records.map((record) => ({ type: record.type, status: record.status, pinned: record.pinned })),
      outOfSync.length,
    )
    return {
      vault: { ...vault, stats },
      recentCreated: top(records, (record) => Date.parse(record.createdAt), 8),
      recentUpdated: top(records, (record) => Date.parse(record.updatedAt), 8),
      pending: records.filter((record) => record.status === 'pending').map(wrapHit),
      problems: records
        .filter((record) => record.status === 'conflict' || record.status === 'superseded')
        .map(wrapHit),
      tags: tagCounts(index),
      outOfSync,
      duplicates,
      busy: this.busy,
    }
  }

  search(request: SearchRequest): SearchResponse {
    const { index } = this.requireIndex()
    const started = Date.now()
    const filters: QueryFilters = { ...(request.filters ?? {}) }
    if (request.includeNonCurrent === false) {
      const requested = filters.statuses
      filters.statuses =
        requested === undefined || requested.length === 0
          ? ['active']
          : requested.filter((status) => status === 'active')
      if (filters.statuses.length === 0) filters.statuses = ['active']
    }
    const hits = queryIndexCompat(index, request.text, filters, request.limit)
    return {
      hits: hits.map(toWireHit),
      total: hits.length,
      tookMs: Date.now() - started,
      indexRefreshed: false,
    }
  }

  async get(id: string): Promise<GetResponse> {
    const { index, root } = this.requireIndex()
    const record = index.records.get(id)
    if (record === undefined) throw new ServiceError(ERROR_CODES.notFound, `未找到记忆 ${id}。`)
    const absolute = join(root, record.path.split('/').join('\\'))
    const raw = await readTextIfExists(absolute)
    if (raw === null) {
      throw new ServiceError(ERROR_CODES.notFound, `记忆文件已不存在：${record.path}。请重建索引。`, absolute)
    }
    const scanned = await scanVault(root)
    const document = scanned.documents.find((entry) => entry.id === id)
    if (document === undefined) {
      throw new ServiceError(ERROR_CODES.notFound, `记忆文件无法解析：${record.path}。`, absolute)
    }
    const history = (await this.repository?.history(id, 50)) ?? []
    const recallable = record.status === 'active' && record.confidence !== 'low'
    return {
      memory: document.memory,
      raw,
      relativePath: record.path,
      absolutePath: absolute,
      history,
      related: relatedFor(index, id).map(toWireHit),
      recallable,
      recallNote: recallable
        ? '该记忆处于 active 状态，会参与后续会话的检索与注入。'
        : record.status !== 'active'
          ? `该记忆状态为 ${record.status}，不会作为当前事实注入；它仍可被检索和查阅。`
          : '该记忆置信度为 low，需确认后才会参与注入。',
    }
  }

  async readRaw(id: string): Promise<{ relativePath: string; content: string; checksum: string }> {
    const { index, root } = this.requireIndex()
    const record = index.records.get(id)
    if (record === undefined) throw new ServiceError(ERROR_CODES.notFound, `未找到记忆 ${id}。`)
    const absolute = join(root, record.path.split('/').join('\\'))
    const content = await readTextIfExists(absolute)
    if (content === null) throw new ServiceError(ERROR_CODES.notFound, `记忆文件已不存在：${record.path}。`)
    // Fingerprint the file that was just read, not the indexed fingerprint: after
    // an external edit the index is stale, and returning the stale value made the
    // "reload then write" retry fail with the same conflict forever.
    return { relativePath: record.path, content, checksum: checksum(content) }
  }

  async history(id: string | undefined, limit = 100): Promise<JournalEntry[]> {
    this.requireIndex()
    return (await this.repository?.history(id, Math.max(1, Math.min(500, limit)))) ?? []
  }

  /* --------------------------------------------------------------- writing */

  /**
   * Save a memory from the management UI.
   *
   * Creates when `id` is absent, otherwise updates in place while preserving
   * `created_at` and appending a change record with a bounded before/after
   * summary.
   */
  async save(request: SaveRequest): Promise<SaveResponse> {
    const { index, root } = this.requireIndex()
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    validateSaveRequest(request)

    const existing = request.id !== undefined ? index.records.get(request.id) : undefined
    const createdAt = existing !== undefined ? existing.createdAt : nowIso()
    const repairs: string[] = []
    const warnings: string[] = []

    const previousMemory = existing !== undefined ? (await this.repository.load(existing.id))?.memory : undefined
    const tags = [...new Set([...request.tags, TYPE_DESCRIPTORS[request.type].defaultTag])]
    const memory: Memory = {
      id: existing?.id ?? newMemoryId(),
      type: request.type,
      status: request.status ?? (existing !== undefined ? (existing.status as MemoryStatus) : 'active'),
      createdAt,
      updatedAt: nowIso(),
      title: request.title.trim(),
      tags,
      confidence: request.confidence,
      importance: clamp(request.importance, 0, 100),
      pinned: request.pinned ?? (existing?.pinned ?? false),
      sourceSessions: request.sourceSessions ?? [],
      supersedes: previousMemory?.supersedes ?? [],
      conflictsWith: previousMemory?.conflictsWith ?? [],
      aliases: request.aliases ?? previousMemory?.aliases ?? [],
      evidence: request.evidence ?? previousMemory?.evidence ?? '',
      schemaVersion: 1,
      summary: request.summary,
      sections: previousMemory?.sections ?? [],
      related: previousMemory?.related ?? [],
      // Preserve whatever the plugin does not own, so a field edit from the UI does
      // not re-serialize the note and drop the user's own metadata or paragraphs.
      ...(previousMemory?.extraFrontmatter === undefined ? {} : { extraFrontmatter: previousMemory.extraFrontmatter }),
      ...(previousMemory?.preservedBody === undefined ? {} : { preservedBody: previousMemory.preservedBody }),
      ...(previousMemory?.preservedSource === undefined ? {} : { preservedSource: previousMemory.preservedSource }),
    }
    if (previousMemory?.supersededBy !== undefined) memory.supersededBy = previousMemory.supersededBy

    // Commit boundary: stage the history event durably BEFORE the domain write. If the
    // event cannot be secured, abort with no memory written; if the write then fails,
    // discard the staged event so it never appears as committed history.
    const willCreate = existing === undefined
    const historyReason = request.reason ?? (willCreate ? '用户在管理页面新建记忆' : '用户在管理页面编辑记忆')
    const historyEntry = {
      at: nowIso(),
      op: willCreate ? 'create' : 'update',
      id: memory.id,
      ...(previousMemory === undefined ? {} : { before: summarize(previousMemory) }),
      after: summarize(memory),
      reason: historyReason,
    }
    // Persist the commit evidence with the intent: target path plus the checksums of
    // the pre-write and expected post-write state, so recovery can decide later.
    const predictedPath = this.repository.predictSavePath(memory)
    const targetAbsolute = resolve(root, predictedPath)
    const previousRaw = await readTextIfExists(targetAbsolute)
    const beforeChecksum = previousRaw === null ? null : checksum(previousRaw)
    const afterChecksum = checksum(renderMemory(memory))
    ;(historyEntry as Record<string, unknown>)['saveMetadata'] = {
      kind: 'save',
      path: predictedPath,
      before: beforeChecksum,
      after: afterChecksum,
    }
    const stagedEventId = await this.repository.stageJournal(historyEntry as never)
    await this.deps.commitBarrier?.('after-stage')
    let saved: Awaited<ReturnType<MemoryRepository['save']>>
    try {
      saved = await this.repository.save(memory, request.reason === undefined ? {} : { reason: request.reason })
    } catch (error) {
      // Classify instead of blindly discarding: if the write actually landed, the
      // operation DID commit and its history must survive.
      const currentRaw = await readTextIfExists(targetAbsolute)
      const currentChecksum = currentRaw === null ? null : checksum(currentRaw)
      if (currentChecksum === afterChecksum) {
        // The write landed: converge the history and report success. A failure here
        // would invite a duplicate retry for data that is already committed.
        await this.repository.commitJournal(stagedEventId)
        await this.repository.flushJournal()
        return { id: memory.id, created: existing === undefined, repairs, warnings }
      }
      if (currentChecksum === beforeChecksum) {
        await this.repository.discardJournal(stagedEventId).catch(() => undefined)
      }
      throw error
    }
    await this.deps.commitBarrier?.('after-write')
    await this.repository.commitJournal(stagedEventId)
    await this.deps.commitBarrier?.('after-commit')
    await this.repository.flushJournal()
    await this.refreshAfterWriteQuietly()
    if (saved.movedFrom !== null) warnings.push(`文件已从 ${saved.movedFrom} 移动到 ${saved.document.relativePath}。`)
    void root
    return { id: memory.id, created: saved.created, repairs, warnings }
  }

  async writeRaw(id: string, content: string, expectedChecksum: string): Promise<{ repairs: string[]; warnings: string[] }> {
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    const before = await this.get(id)
    const metadata: Record<string, unknown> = {
      kind: 'write',
      path: before.relativePath,
      before: await this.repository.checksumAt(before.relativePath),
      after: checksum(this.repository.previewRawContent(content)),
    }
    const stagedId = await this.stageIntent(
      {
        at: nowIso(),
        op: 'update',
        id,
        before: summarize(before.memory),
        after: '直接编辑 Markdown 原文',
        reason: '用户在管理页面直接编辑 Markdown',
      },
      metadata,
    )
    let result: Awaited<ReturnType<MemoryRepository['writeRaw']>>
    try {
      result = await this.repository.writeRaw(id, content, { expectedChecksum, reason: '用户在管理页面直接编辑 Markdown' })
      await this.deps.commitBarrier?.('after-write')
    } catch (error) {
      await this.settleIntent(stagedId, metadata, error).catch(() => undefined)
      if (error instanceof FsError && error.message.includes('已被其他程序修改')) {
        throw new ServiceError(ERROR_CODES.conflict, error.message, error.path)
      }
      throw error
    }
    // The write succeeded, so the intent is committed by definition: mark it directly
    // instead of re-deriving it from a re-rendered checksum.
    await this.repository.commitJournal(stagedId)
    await this.deps.commitBarrier?.('after-commit')
    await this.repository.flushJournal()
    await this.refreshAfterWriteQuietly()
    return { repairs: result.repairs, warnings: [] }
  }

  async confirm(id: string, reason = '用户确认该记忆有效'): Promise<{ id: string }> {
    const candidate = this.candidates.find((entry) => entry.id === id)
    if (candidate !== undefined) return await this.confirmCandidate(candidate, reason)
    return this.transition(id, 'active', reason)
  }

  /**
   * Apply a user confirmation to an Inbox candidate.
   *
   * Candidates are not memory files yet (`MemoryCandidate` is the pre-file
   * shape), so `transition()` cannot find them in the index — which is why the
   * Inbox buttons used to fail with `not-found`. The comparison the extractor
   * made when parking the candidate is re-derived against the current index:
   *
   * - a new fact is written as an `active` note;
   * - a supplement or a duplicate is folded into the memory it belongs to
   *   (text already present is not appended twice);
   * - a contradiction keeps both sides, with the new note recording the
   *   conflict target.
   *
   * The candidate then leaves the Inbox in every successful branch.
   */
  private async confirmCandidate(candidate: MemoryCandidate, reason: string): Promise<{ id: string }> {
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    const { index } = this.requireIndex()
    const comparison = compareCandidate(candidate, viewsFromIndex(index))
    const confidence: Confidence = candidate.confidence === 'low' ? 'medium' : candidate.confidence
    const confirmed: MemoryCandidate = { ...candidate, confidence, decision: comparison.decision }

    const targetId =
      comparison.decision.action === 'update'
        ? comparison.decision.targetId
        : comparison.decision.action === 'merge'
          ? comparison.decision.targetIds[0]
          : undefined

    if (targetId !== undefined) {
      const loaded = await this.repository.load(targetId)
      if (loaded !== null) {
        const before = loaded.memory
        const next: Memory = {
          ...before,
          summary: appendUnique(before.summary, confirmed.summary),
          // Do not rewrite `evidence` here: existing notes carry a multi-line
          // block scalar, and the in-place frontmatter editor deliberately
          // refuses to rewrite multi-line scalars. The candidate's provenance is
          // preserved through `sourceSessions` and the journal instead.
          sourceSessions: [...new Set([...before.sourceSessions, ...confirmed.sourceSessions])],
          tags: [...new Set([...before.tags, ...confirmed.tags])],
          confidence: before.confidence === 'low' ? 'medium' : before.confidence,
          updatedAt: nowIso(),
        }
        await this.repository.save(next)
        await this.repository.journal({
          at: nowIso(),
          op: 'update',
          id: before.id,
          before: summarize(before),
          after: summarize(next),
          reason: `${reason}（候选记忆${comparison.decision.action === 'merge' ? '判定为重复，已合并' : '判定为补充，已并入'}）`,
        })
        this.candidates = this.candidates.filter((entry) => entry.id !== candidate.id)
        await this.refreshAfterWrite()
        return { id: before.id }
      }
    }

    const memory = this.memoryFromCandidate(confirmed, 'active')
    if (comparison.decision.action === 'conflict') memory.conflictsWith = [comparison.decision.targetId]
    await this.repository.save(memory)
    await this.repository.journal({
      at: nowIso(),
      op: 'create',
      id: memory.id,
      after: summarize(memory),
      reason: `${reason}（候选记忆：${candidate.reason}）`,
    })
    this.candidates = this.candidates.filter((entry) => entry.id !== candidate.id)
    await this.refreshAfterWrite()
    return { id: memory.id }
  }

  async setStatus(id: string, status: MemoryStatus, reason?: string): Promise<{ id: string }> {
    if (!(MEMORY_STATUSES as readonly string[]).includes(status)) {
      throw new ServiceError(ERROR_CODES.invalid, `未知状态：${String(status)}`)
    }
    return this.transition(id, status, reason ?? `用户将状态改为 ${status}`)
  }

  private async transition(id: string, status: MemoryStatus, reason: string): Promise<{ id: string }> {
    const { index } = this.requireIndex()
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    const record = index.records.get(id)
    if (record === undefined) throw new ServiceError(ERROR_CODES.notFound, `未找到记忆 ${id}。`)
    const loaded = await this.repository.load(id)
    if (loaded === null) throw new ServiceError(ERROR_CODES.notFound, `记忆文件无法加载：${id}。`)

    const before = loaded.memory
    const next: Memory = { ...before, status, updatedAt: nowIso() }
    // Confirming a low-confidence memory is an explicit act of trust.
    if (status === 'active' && before.confidence === 'low') next.confidence = 'medium'
    await this.commitSingleSave(id, loaded, next, statusToOp(status), reason)
    return { id }
  }

  async setPinned(id: string, pinned: boolean): Promise<{ id: string }> {
    const { index } = this.requireIndex()
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    const record = index.records.get(id)
    if (record === undefined) throw new ServiceError(ERROR_CODES.notFound, `未找到记忆 ${id}。`)
    const loaded = await this.repository.load(id)
    if (loaded === null) throw new ServiceError(ERROR_CODES.notFound, `记忆文件无法加载：${id}。`)
    const before = loaded.memory
    const next: Memory = { ...before, pinned, updatedAt: nowIso() }
    await this.commitSingleSave(id, loaded, next, 'update', pinned ? '用户置顶该记忆' : '用户取消置顶')
    return { id }
  }

  /**
   * Delete a memory. `confirm` must be literally `true`; the UI only sends it
   * after a second confirmation, and this method refuses anything else so a
   * programming mistake cannot destroy data silently.
   */
  async remove(id: string, confirm: boolean, reason = '用户在管理页面删除记忆'): Promise<{ id: string }> {
    if (confirm !== true) {
      throw new ServiceError(ERROR_CODES.invalid, '删除需要二次确认；请求中未携带确认标记。')
    }
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    await this.removeWithIntent(id, reason)
    this.candidates = this.candidates.filter((candidate) => candidate.id !== id)
    return { id }
  }

  async reject(id: string, reason = '用户拒绝该候选记忆', keepFile = false): Promise<{ id: string }> {
    const candidate = this.candidates.find((entry) => entry.id === id)
    if (candidate !== undefined) {
      // A rejected candidate is not a memory file: dropping it from the Inbox is
      // the whole operation. `keepFile` explicitly asks for a durable note, so
      // materialize it as pending and archive that.
      if (!keepFile) {
        this.candidates = this.candidates.filter((entry) => entry.id !== id)
        return { id }
      }
      await this.materializeCandidate(id)
      return await this.transition(id, 'archived', reason)
    }
    const { index } = this.requireIndex()
    const record = index.records.get(id)
    if (record === undefined) throw new ServiceError(ERROR_CODES.notFound, `未找到记忆 ${id}。`)
    this.candidates = this.candidates.filter((candidate) => candidate.id !== id)
    if (keepFile) return this.transition(id, 'archived', reason)
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    await this.removeWithIntent(id, reason)
    return { id }
  }

  /** Fold several memories into one survivor. */
  private async applyMergePlan(plan: MergeOperationPlan): Promise<{ id: string; mergedIds: string[] }> {
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    for (const step of plan.steps) {
      const atFrom = await this.repository.checksumAt(step.from)
      const atTo = step.to === step.from ? atFrom : await this.repository.checksumAt(step.to)
      if (atTo === step.after) continue
      if (atFrom === step.before) {
        await this.repository.save(step.memory)
        await this.deps.commitBarrier?.(step.id === plan.survivorId ? 'after-survivor' : 'after-other')
        continue
      }
      throw new ServiceError(
        ERROR_CODES.internal,
        '多记录操作状态无法判定：参与记录与操作清单的预期状态不一致。操作意图与原始数据均已保留，请人工核对。',
      )
    }
    for (const event of plan.events) {
      await this.repository.journal({ ...event.entry, eventId: event.eventId } as never)
    }
    await this.deps.commitBarrier?.('after-commit')
    await this.repository.clearOperation(plan.operationId)
    return plan.result
  }

  private async recoverOperations(): Promise<void> {
    if (this.repository === null) return
    for (const raw of await this.repository.readOperationPlans()) {
      const plan = raw as unknown as MergeOperationPlan
      try {
        await this.applyMergePlan(plan)
      } catch (error) {
        this.repository.noteConflict(
          `operationId ${plan.operationId}: 恢复失败（${error instanceof Error ? error.message : String(error)}）`,
        )
      }
    }
  }
  async merge(request: MergeRequest, reason?: string): Promise<{ id: string; mergedIds: string[] }> {
    validateMergeRequest(request)
    this.requireIndex()
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    const ids = [...new Set(request.ids)]
    if (ids.length < 2) throw new ServiceError(ERROR_CODES.invalid, '合并至少需要两条记忆。')
    const survivorId = request.targetId ?? ids[0]
    if (survivorId === undefined) throw new ServiceError(ERROR_CODES.invalid, '未指定保留的记忆。')

    const loaded = new Map<string, Memory>()
    const paths = new Map<string, string>()
    for (const id of ids) {
      const document = await this.repository.load(id)
      if (document === null) throw new ServiceError(ERROR_CODES.notFound, `记忆无法加载：${id}`)
      loaded.set(id, document.memory)
      paths.set(id, document.relativePath)
    }
    const survivor = loaded.get(survivorId)
    if (survivor === undefined) throw new ServiceError(ERROR_CODES.notFound, `保留项无法加载：${survivorId}`)

    const others = ids.filter((id) => id !== survivorId)
    const mergedSummary = [survivor.summary, ...others.map((id) => loaded.get(id)?.summary ?? '')]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('\n\n')
    const mergedTags = [...new Set(ids.flatMap((id) => loaded.get(id)?.tags ?? []))]
    const mergedAliases = [...new Set(ids.flatMap((id) => loaded.get(id)?.aliases ?? []))]
    const mergedSessions = [...new Set(ids.flatMap((id) => loaded.get(id)?.sourceSessions ?? []))]
    const mergedEvidence = ids
      .map((id) => {
        const memory = loaded.get(id)
        return memory === undefined ? '' : `### ${memory.id}\n${memory.evidence}`
      })
      .filter((part) => part.length > 0)
      .join('\n\n')

    const next: Memory = {
      ...survivor,
      summary: mergedSummary,
      tags: mergedTags,
      aliases: mergedAliases,
      sourceSessions: mergedSessions,
      evidence: mergedEvidence,
      supersedes: [...new Set([...survivor.supersedes, ...others])],
      updatedAt: nowIso(),
      // A merge is a deliberate act, so the survivor becomes current fact.
      status: 'active',
      confidence: survivor.confidence === 'low' ? 'medium' : survivor.confidence,
    }
    // Persist the complete plan before the first domain write, then execute it
    // idempotently. Recovery replays the same plan from disk; it never recomputes a
    // different merge result.
    const mergeReason = reason ?? request.reason ?? '用户在管理页面合并重复记忆'
    const operationId = `op_merge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const survivorFrom = paths.get(survivorId) as string
    const steps: MergePlanStep[] = [
      {
        id: survivorId,
        from: survivorFrom,
        to: this.repository.predictSavePath(next),
        before: await this.repository.checksumAt(survivorFrom),
        after: checksum(renderMemory(next)),
        memory: next,
      },
    ]
    for (const id of others) {
      const memory = loaded.get(id)
      if (memory === undefined) continue
      const retired: Memory = { ...memory, status: 'superseded', supersededBy: survivorId, updatedAt: next.updatedAt }
      const from = paths.get(id) as string
      steps.push({
        id,
        from,
        to: this.repository.predictSavePath(retired),
        before: await this.repository.checksumAt(from),
        after: checksum(renderMemory(retired)),
        memory: retired,
      })
    }
    const events: MergePlanEvent[] = [
      {
        eventId: `${operationId}:merge`,
        entry: { at: next.updatedAt, op: 'merge', id: survivorId, before: summarize(survivor), after: summarize(next), reason: mergeReason, related: others },
      },
      ...others.map((id) => {
        const memory = loaded.get(id) as Memory
        const retired = steps.find((step) => step.id === id)?.memory as Memory
        return {
          eventId: `${operationId}:supersede:${id}`,
          entry: { at: next.updatedAt, op: 'supersede', id, before: summarize(memory), after: summarize(retired), reason: `合并到 ${survivorId}`, related: [survivorId] },
        }
      }),
    ]
    const plan: MergeOperationPlan = {
      operationId,
      at: nowIso(),
      kind: 'merge',
      survivorId,
      steps,
      events,
      result: { id: survivorId, mergedIds: others },
    }
    await this.repository.stageOperation(plan as unknown as Record<string, unknown>)
    const result = await this.applyMergePlan(plan)
    await this.refreshAfterWrite()
    return result
  }

  /**
   * Resolve a flagged contradiction.
   *
   * The losing side is archived rather than deleted, because the fact that two
   * sources disagreed, and when, is itself worth keeping.
   */
  async resolveConflict(id: string, strategy: 'keep' | 'merge' | 'both', otherIds: string[], reason?: string): Promise<{ id: string; archived: string[] }> {
    if (strategy !== 'keep' && strategy !== 'merge' && strategy !== 'both') {
      throw new ServiceError(ERROR_CODES.invalid, `未知的冲突处理策略：${String(strategy)}`)
    }
    const { index } = this.requireIndex()
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    const kept = index.records.get(id)
    if (kept === undefined) throw new ServiceError(ERROR_CODES.notFound, `未找到记忆 ${id}。`)

    if (strategy === 'merge') {
      const result = await this.merge({ ids: [id, ...otherIds], targetId: id, ...(reason === undefined ? {} : { reason }) })
      return { id: result.id, archived: result.mergedIds }
    }

    const archived: string[] = []
    if (strategy === 'keep') {
      for (const otherId of otherIds) {
        if (otherId === id) continue
        await this.transition(otherId, 'archived', reason ?? `用户在冲突处理中归档了 ${otherId}`)
        archived.push(otherId)
      }
    }
    // `both` clears the conflict flag and keeps every side, with the
    // disagreement recorded in metadata rather than acted upon.
    const document = await this.repository.load(id)
    if (document === null) throw new ServiceError(ERROR_CODES.notFound, `记忆无法加载：${id}`)
    const before = document.memory
    const next: Memory = {
      ...before,
      status: 'active',
      conflictsWith: strategy === 'both' ? [...new Set([...before.conflictsWith, ...otherIds])] : [],
      updatedAt: nowIso(),
      evidence:
        strategy === 'both'
          ? `${before.evidence}\n\n冲突未裁决（保留双方）：${otherIds.join('、')}`
          : `${before.evidence}\n\n冲突已裁决：保留本条，归档 ${otherIds.join('、')}`,
    }
    await this.repository.save(next)
    await this.repository.journal({
      at: nowIso(),
      op: 'conflict',
      id,
      before: summarize(before),
      after: summarize(next),
      reason: reason ?? `冲突处理策略：${strategy}`,
      related: otherIds,
    })
    await this.refreshAfterWrite()
    return { id, archived }
  }

  async rebuildIndex(): Promise<RebuildIndexResponse> {
    this.requireIndex()
    const rebuilt = await this.rebuildIndexInternal('用户手动触发索引重建')
    await this.recheckDiagnostics()
    return rebuilt
  }

  async syncIndex(): Promise<SyncIndexResponse> {
    const { root, index, layout } = this.requireIndex()
    const result = await syncIndex(root, index)
    this.index = result.index
    await persistIndex(layout, result.index)
    await this.recheckDiagnostics()
    if (result.added.length > 0 || result.updated.length > 0 || result.removed.length > 0) {
      await writeIndexNotes(root, result.index)
      await journalIndexEvent(layout, {
        at: nowIso(),
        op: 'index-sync',
        id: '*',
        reason: '检测到 Markdown 在插件之外被修改，已增量同步索引',
        after: `新增 ${String(result.added.length)}，更新 ${String(result.updated.length)}，移除 ${String(result.removed.length)}`,
      })
    }
    return {
      added: result.added,
      updated: result.updated,
      removed: result.removed,
      unchanged: result.unchanged,
      duplicates: result.duplicates,
    }
  }

  private async refreshAfterWrite(): Promise<void> {
    const { root, index, layout } = this.requireIndex()
    const result = await syncIndex(root, index)
    this.index = result.index
    await persistIndex(layout, result.index)
    await this.recheckDiagnostics()
    if (result.added.length > 0 || result.updated.length > 0 || result.removed.length > 0) {
      await writeIndexNotes(root, result.index)
    }
  }

  /* --------------------------------------------------------- recall & turns */

  /** Standing facts for the system prompt. */
  standing(): ReturnType<typeof standingFacts> {
    const { index } = this.requireIndex()
    return standingFacts(index, {
      budgetTokens: this.settings.standingBudgetTokens,
      maxItems: this.settings.standingMaxItems,
    })
  }

  /** Query-relevant recall for the current task. */
  /**
   * Retrieval over the memory index, in one of two explicit modes.
   *
   * `explicit` (default) is the documented recall contract: when nothing active
   * matches, retired entries may be returned **flagged as history** so a person or
   * an explicit tool call can still find them.
   *
   * `injection` is what an automatic path (per-step recall) must use: retired
   * entries must never be spliced into the model's input, not even as a labelled
   * fallback. Both modes share this single status decision instead of each caller
   * re-deriving it.
   */
  /**
   * Retrieval for **automatic injection**, additionally verified against disk.
   *
   * The index is derived data and can lag the Markdown (an edit made while DSH was
   * running, a half-applied repair). Before a memory enters the model's input, its
   * file is re-read and compared with the indexed checksum. A candidate that does
   * not match is dropped rather than injected: refusing to inject something we
   * cannot confirm is the safe side of the contract "Markdown is authoritative".
   */
  async recallForInjection(query: string): Promise<ReturnType<typeof renderHits>> {
    const result = this.recall(query, { mode: 'injection' })
    if (result.hits.length === 0 || this.index === null || this.root === null) {
      return renderHits([], { query, budgetTokens: this.settings.recallBudgetTokens, maxItems: this.settings.recallMaxItems }, CURRENT_PURPOSE)
    }
    const fresh: typeof result.hits = []
    for (const hit of result.hits) {
      const record = this.index.records.get(hit.record.id)
      if (record === undefined) continue
      let onDisk: string | null = null
      try {
        onDisk = await readTextIfExists(resolve(this.root, record.path))
      } catch (error) {
        this.deps.logger?.warn('dsh-longterm-memory: candidate unreadable, skipped: %o', error)
        continue
      }
      if (onDisk === null) {
        this.deps.logger?.warn('dsh-longterm-memory: candidate file missing on disk, skipped: %s', record.path)
        this.markDesynced(hit.record.id, 'missing-file')
        continue
      }
      if (checksum(onDisk) !== record.checksum) {
        this.deps.logger?.warn('dsh-longterm-memory: candidate out of sync with disk, skipped: %s', record.path)
        this.markDesynced(hit.record.id, 'checksum-mismatch')
        continue
      }
      this.clearDesynced(hit.record.id)
      fresh.push(hit)
    }
    if (fresh.length === result.hits.length) return renderHits(result.hits, { query, budgetTokens: this.settings.recallBudgetTokens, maxItems: this.settings.recallMaxItems }, CURRENT_PURPOSE)
    return renderHits(fresh, { query, budgetTokens: this.settings.recallBudgetTokens, maxItems: this.settings.recallMaxItems }, CURRENT_PURPOSE)
  }
  recall(query: string, options: { mode?: 'explicit' | 'injection' } = {}): ReturnType<typeof retrieveForTask> {
    const { index } = this.requireIndex()
    const mode = options.mode ?? 'explicit'
    return retrieveForTask(index, {
      query,
      budgetTokens: this.settings.recallBudgetTokens,
      maxItems: this.settings.recallMaxItems,
      includeNonCurrent: mode === 'explicit',
    })
  }

  previewRecall(query: string, limit?: number, optionsForPreview: { mode?: 'explicit' | 'injection' } = {}): { text: string; usedTokens: number; includedIds: string[]; omitted: number } {
    const { index } = this.requireIndex()
    const result = retrieveForTask(index, {
      query,
      budgetTokens: this.settings.recallBudgetTokens,
      maxItems: limit ?? this.settings.recallMaxItems,
      // The preview exists to show what automatic injection would do, so it uses
      // the injection semantics: active-only, no history fallback.
      includeNonCurrent: (optionsForPreview.mode ?? 'injection') === 'explicit',
    })
    return { text: result.text, usedTokens: result.usedTokens || estimateTokens(result.text), includedIds: result.includedIds, omitted: result.omitted }
  }

  listCandidates(): MemoryCandidate[] {
    return [...this.candidates]
  }

  addCandidate(input: {
    type: MemoryType
    title: string
    summary: string
    tags?: string[]
    confidence?: Confidence
    importance?: number
    evidence?: string
    sourceSessions?: string[]
    reason?: string
  }): { id: string } {
    this.requireIndex()
    if (!(MEMORY_TYPES as readonly string[]).includes(input.type)) {
      throw new ServiceError(ERROR_CODES.invalid, `未知类别：${String(input.type)}`)
    }
    const confidence: Confidence = input.confidence ?? 'medium'
    if (!(CONFIDENCE_LEVELS as readonly string[]).includes(confidence)) {
      throw new ServiceError(ERROR_CODES.invalid, `未知置信度：${String(confidence)}`)
    }
    const candidate: MemoryCandidate = {
      id: newMemoryId(),
      type: input.type,
      title: input.title.slice(0, 200),
      summary: input.summary.slice(0, 4000),
      tags: input.tags ?? [TYPE_DESCRIPTORS[input.type].defaultTag],
      confidence,
      importance: clamp(input.importance ?? 50, 0, 100),
      sourceSessions: input.sourceSessions ?? [],
      evidence: input.evidence ?? '由用户在管理页面手动添加',
      createdAt: nowIso(),
      reason: input.reason ?? '手动添加的候选记忆',
      relatedIds: [],
      decision: { action: 'inbox', rationale: '等待用户确认' },
    }
    this.candidates.push(candidate)
    return { id: candidate.id }
  }

  /**
   * Process one completed turn: extract, compare, and apply only what is safe.
   *
   * Two extractors feed this pipeline:
   *
   * - the deterministic rule extractor, which always runs (free, local, offline);
   * - the optional model extractor, whose answer is treated as untrusted input
   *   and passes through the same secret/sensitivity/grounding policy.
   *
   * The model can only *add* candidates. Any model failure leaves the rule result
   * untouched, so a broken or unavailable model degrades the feature rather than
   * losing the turn.
   */
  async processTurn(input: TurnInput): Promise<TurnProcessingResult> {
    const { index } = this.requireIndex()
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')

    // Idempotency: one (session, turn) pair is processed once. A retried event, a
    // duplicated listener call, or a replayed log tail therefore cannot create a
    // second copy of the same memory.
    const turnKey = `${input.sessionId ?? 'unknown'}#${String(input.turn ?? '?')}#${checksum(`${input.userText}\u0000${input.assistantText ?? ''}`)}`
    if (this.handledTurns.has(turnKey)) {
      return { candidates: [], applied: [], refused: [], pending: [], skippedAsDuplicate: true }
    }
    this.handledTurns.add(turnKey)
    if (this.handledTurns.size > MAX_HANDLED_TURNS) {
      const oldest = this.handledTurns.values().next()
      if (!oldest.done) this.handledTurns.delete(oldest.value)
    }

    const options = {
      redactSecrets: this.settings.redactSecrets,
      sensitiveNeedsConfirmation: this.settings.sensitiveNeedsConfirmation,
      maxCandidates: this.settings.maxCandidatesPerTurn,
    }
    const outcome = extractFromTurn(input, options)
    const refused = [...outcome.refused]
    let modelNote: string | undefined

    if (this.settings.enableLlmExtraction && this.deps.llmAdapter !== undefined) {
      const adapter = this.deps.llmAdapter
      if (!adapter.available) {
        modelNote = `模型辅助提取不可用：${adapter.reason ?? '未提供原因'}`
      } else {
        try {
          const answer = await adapter.complete(
            {
              userText: input.userText,
              assistantText: input.assistantText ?? '',
              existing: [...index.records.values()].slice(0, LLM_LIMITS.maxExisting).map((record) => ({
                id: record.id,
                type: record.type,
                title: record.title,
                preview: record.preview.slice(0, 160),
              })),
              maxCandidates: this.settings.maxCandidatesPerTurn,
            },
            new AbortController().signal,
          )
          const parsed = parseModelAnswer(answer.text)
          if (parsed.ok) {
            const mapped = candidatesFromModel(parsed.candidates, input, options)
            for (const refusal of mapped.refused) refused.push({ reason: refusal.reason, excerpt: refusal.title })
            // The model looked at the whole turn and produced structured
            // metadata, so its version wins for a subject both extractors found.
            // Rule candidates that add a subject the model missed are kept.
            const merged: MemoryCandidate[] = []
            for (const candidate of mapped.candidates) {
              if (!merged.some((existing) => sameCandidateSubject(existing, candidate))) merged.push(candidate)
            }
            for (const candidate of outcome.candidates) {
              if (!merged.some((existing) => sameCandidateSubject(existing, candidate))) merged.push(candidate)
            }
            // A model candidate replaces its rule twin, so the merged list can be
            // longer than the rule list: cap it to the configured limit.
            outcome.candidates = merged.slice(0, this.settings.maxCandidatesPerTurn)
            modelNote = `模型辅助提取：采纳 ${String(mapped.candidates.length)} 条，结构不合格 ${String(parsed.dropped)} 条；路由 ${answer.provider}/${answer.model}`
          } else {
            modelNote = `模型辅助提取已跳过：${parsed.reason}`
          }
        } catch (error) {
          modelNote = `模型辅助提取失败，已回退到规则提取：${describeError(error)}`
        }
      }
      this.lastModelNote = modelNote
    }

    const existing = viewsFromIndex(index)
    const applied: { id: string; action: string }[] = []
    const pending: MemoryCandidate[] = []

    for (const candidate of outcome.candidates) {
      // Skip a candidate already waiting for the user, so repeated turns on the
      // same subject do not pile up duplicate Inbox entries.
      if (this.candidates.some((waiting) => sameCandidateSubject(waiting, candidate))) continue
      const comparison = compareCandidate(candidate, existing)
      candidate.decision = comparison.decision

      // QQ 联动策略：识别为 QQ 通道的会话，写入方式可能是「只进收件箱」。
      // 这里在**应用之前**改道，所以候选记忆仍然完整经过既有的提取、敏感信息
      // 与冲突判定流程，只是不会被直接写成 active 长期记忆。
      if (input.forceInbox === true) {
        candidate.decision = { action: 'inbox', rationale: 'QQ 会话按联动策略只写入收件箱，等待人工确认' }
        pending.push(candidate)
        this.candidates.push(candidate)
        continue
      }

      if (!mayAutoApply(candidate)) {
        candidate.decision = { action: 'inbox', rationale: `${comparison.decision.action === 'create' ? '新信息' : comparison.decision.action}，置信度不足或需要人工判断` }
        pending.push(candidate)
        this.candidates.push(candidate)
        continue
      }

      if (candidate.decision.action === 'create') {
        const memory = this.memoryFromCandidate(candidate, 'active')
        await this.repository.save(memory)
        await this.repository.journal({
          at: nowIso(),
          op: 'create',
          id: memory.id,
          after: summarize(memory),
          reason: `自动提取（${candidate.reason}）`,
          ...(input.sessionId === undefined ? {} : { source: input.sessionId }),
        })
        applied.push({ id: memory.id, action: 'create' })
      } else if (candidate.decision.action === 'update') {
        const targetId = candidate.decision.targetId
        const loaded = await this.repository.load(targetId)
        if (loaded === null) {
          pending.push(candidate)
          this.candidates.push(candidate)
          continue
        }
        const before = loaded.memory
        const next: Memory = {
          ...before,
          summary: `${before.summary}\n\n${candidate.summary}`.trim(),
          sourceSessions: [...new Set([...before.sourceSessions, ...candidate.sourceSessions])],
          evidence: `${before.evidence}\n\n${candidate.evidence}`.trim(),
          tags: [...new Set([...before.tags, ...candidate.tags])],
          updatedAt: nowIso(),
        }
        await this.repository.save(next)
        await this.repository.journal({
          at: nowIso(),
          op: 'update',
          id: before.id,
          before: summarize(before),
          after: summarize(next),
          reason: `自动补充（${candidate.decision.rationale}）`,
          ...(input.sessionId === undefined ? {} : { source: input.sessionId }),
        })
        applied.push({ id: before.id, action: 'update' })
      }
    }

    if (applied.length > 0) await this.refreshAfterWrite()
    return {
      candidates: outcome.candidates,
      applied,
      refused,
      pending,
      ...(modelNote === undefined ? {} : { modelNote }),
    }
  }

  /** What the last model-assisted extraction pass did, or undefined when it did not run. */
  getLastModelNote(): string | undefined {
    return this.lastModelNote
  }

  /**
   * Record the exact system-prompt section descriptor that was registered.
   *
   * Holding the descriptor lets the management page invoke the same text
   * callback the prompt pipeline invokes, which is the only way to show the
   * plugin's real prompt contribution without a model call.
   */
  setStandingSectionProbe(probe: { name: string; order: number; text: () => string }): void {
    this.standingProbe = probe
  }

  /**
   * Invoke the registered system-prompt section's own text callback.
   *
   * Returns the exact string the plugin contributes to the system prompt, plus a
   * breakdown so the page can show why each memory is there.
   */
  previewStandingSection(): {
    registered: boolean
    name: string | null
    order: number | null
    text: string
    usedTokens: number
    includedIds: string[]
    omitted: number
    error: string | null
  } {
    if (this.standingProbe === undefined) {
      return {
        registered: false,
        name: null,
        order: null,
        text: '',
        usedTokens: 0,
        includedIds: [],
        omitted: 0,
        error: '系统提示词分区未注册（可能被配置关闭，或宿主未提供 ctx.systemPrompt）',
      }
    }
    try {
      const text = this.standingProbe.text()
      const standing = this.isReady() ? this.standing() : { usedTokens: 0, includedIds: [], omitted: 0 }
      return {
        registered: true,
        name: this.standingProbe.name,
        order: this.standingProbe.order,
        text,
        usedTokens: standing.usedTokens,
        includedIds: standing.includedIds,
        omitted: standing.omitted,
        error: null,
      }
    } catch (error) {
      return {
        registered: true,
        name: this.standingProbe.name,
        order: this.standingProbe.order,
        text: '',
        usedTokens: 0,
        includedIds: [],
        omitted: 0,
        error: describeError(error),
      }
    }
  }

  /**
   * Promote a stored candidate into a memory note.
   *
   * The note starts as `pending`: by definition a candidate is something the
   * plugin has not been authorised to treat as fact yet, so the user confirms it
   * (or edits it) before it can be recalled.
   */
  async materializeCandidate(candidateId: string): Promise<{ id: string }> {
    const candidate = this.candidates.find((entry) => entry.id === candidateId)
    if (candidate === undefined) throw new ServiceError(ERROR_CODES.notFound, `未找到候选记忆 ${candidateId}。`)
    if (this.repository === null) throw new ServiceError(ERROR_CODES.internal, '仓库不可用。')
    const memory = this.memoryFromCandidate(candidate, 'pending')
    await this.repository.save(memory)
    await this.repository.journal({
      at: nowIso(),
      op: 'create',
      id: memory.id,
      after: summarize(memory),
      reason: `候选记忆已确认（${candidate.reason}）`,
    })
    this.candidates = this.candidates.filter((entry) => entry.id !== candidateId)
    await this.refreshAfterWrite()
    return { id: memory.id }
  }

  private memoryFromCandidate(candidate: MemoryCandidate, status: MemoryStatus): Memory {
    return {
      id: candidate.id,
      type: candidate.type,
      status,
      createdAt: candidate.createdAt,
      updatedAt: nowIso(),
      title: candidate.title,
      tags: candidate.tags,
      confidence: candidate.confidence,
      importance: candidate.importance,
      pinned: false,
      sourceSessions: candidate.sourceSessions,
      supersedes: [],
      conflictsWith: [],
      aliases: [],
      evidence: candidate.evidence,
      schemaVersion: 1,
      summary: candidate.summary,
      sections: [],
      related: [],
    }
  }

  /* ------------------------------------------------------------ misc reads */

  /**
   * Reveal the vault in the OS file manager.
   *
   * Implemented directly with `child_process.execFile` because the official
   * helper (`@deepseek-ai/dsh-native-command`) is not guaranteed reachable from
   * a third-party plugin's module scope. Failure is reported, never hidden.
   */
  async openVault(target?: string): Promise<{ opened: boolean; detail: string }> {
    if (this.root === null) {
      return { opened: false, detail: '仓库尚未初始化，没有可打开的路径。' }
    }
    const path = target !== undefined && target.length > 0 ? resolve(this.root, target) : this.root
    if (!(await pathExists(path))) {
      return { opened: false, detail: `路径不存在：${path}` }
    }
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    return await new Promise((resolvePromise) => {
      let settled = false
      const finish = (opened: boolean, detail: string): void => {
        if (settled) return
        settled = true
        resolvePromise({ opened, detail })
      }
      try {
        const child = execFile(command, [path], { windowsHide: false }, (error) => {
          if (error !== null && error !== undefined) {
            // explorer.exe frequently exits non-zero even on success, so a
            // non-zero code alone is not reported as a failure.
            finish(true, `已请求系统打开：${path}（${command} 退出码非零，这在 Windows 上属常见情况）`)
            return
          }
          finish(true, `已请求系统打开：${path}`)
        })
        child.on('error', (error: Error) => {
          finish(false, `无法调用系统文件管理器（${command}）：${error.message}`)
        })
        setTimeout(() => { finish(true, `已请求系统打开：${path}`) }, 4000)
      } catch (error) {
        finish(false, `无法调用系统文件管理器（${command}）：${describeError(error)}`)
      }
    })
  }

  /** Verify the vault on demand and report the steps, for the settings panel. */
  async verify(): Promise<{ ok: boolean; steps: string[]; failures: string[] }> {
    if (this.layout === null) return { ok: false, steps: [], failures: ['仓库尚未初始化'] }
    return verifyVault(this.layout)
  }

  /** Persist an explicit index file; used by tests and the pack script. */
  async writeIndexFile(index: MemoryIndex): Promise<void> {
    if (this.layout === null) throw new ServiceError(ERROR_CODES.notInitialized, '仓库尚未初始化。')
    await persistIndex(this.layout, index)
  }

  /** Persist an empty index, used to prove rebuild-from-Markdown in tests. */
  async resetIndexFile(): Promise<void> {
    if (this.layout === null || this.root === null) throw new ServiceError(ERROR_CODES.notInitialized, '仓库尚未初始化。')
    await persistIndex(this.layout, emptyIndex(this.root))
    await writeFileAtomic(this.layout.index, `${JSON.stringify({ version: INDEX_FORMAT_VERSION, builtAt: nowIso(), vaultPath: this.root, records: [] })}\n`)
  }
}

/* ------------------------------------------------------------------ helpers */

function queryIndexCompat(
  index: MemoryIndex,
  text: string | undefined,
  filters: QueryFilters,
  limit: number | undefined,
): SearchHit[] {
  return queryIndex(index, {
    ...(text === undefined || text.length === 0 ? {} : { text }),
    filters,
    ...(limit === undefined ? {} : { limit }),
  })
}

const BOOLEAN_SETTINGS = [
  'enableTools', 'enablePromptSection', 'enablePerStepRecall', 'enableAutoExtraction',
  'enableLlmExtraction', 'redactSecrets', 'sensitiveNeedsConfirmation',
] as const

const NUMERIC_SETTINGS = [
  'standingBudgetTokens', 'standingMaxItems', 'recallBudgetTokens', 'recallMaxItems', 'maxCandidatesPerTurn',
] as const

/**
 * Validate a settings patch at runtime, before anything is persisted or a vault is
 * switched. Unknown keys keep their previous behaviour (ignored); known keys must
 * have the right type, otherwise a bad request could silently poison settings.
 */
export function validateSettingsPatch(patch: Partial<PluginSettings>): void {
  if (patch === null || typeof patch !== 'object') throw new ServiceError(ERROR_CODES.invalid, '设置必须是对象。')
  for (const key of BOOLEAN_SETTINGS) {
    const value = (patch as Record<string, unknown>)[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new ServiceError(ERROR_CODES.invalid, `设置 ${key} 必须是布尔值。`)
    }
  }
  for (const key of NUMERIC_SETTINGS) {
    const value = (patch as Record<string, unknown>)[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new ServiceError(ERROR_CODES.invalid, `设置 ${key} 必须是数字。`)
    }
    if (value !== undefined && (value as number) < 0) {
      throw new ServiceError(ERROR_CODES.invalid, `设置 ${key} 不能为负数。`)
    }
  }
  const language = (patch as Record<string, unknown>)['language']
  if (language !== undefined && language !== 'zh' && language !== 'en') {
    throw new ServiceError(ERROR_CODES.invalid, `不支持的语言：${String(language)}`)
  }
  const vaultPath = (patch as Record<string, unknown>)['vaultPath']
  if (vaultPath !== undefined && vaultPath !== null && typeof vaultPath !== 'string') {
    throw new ServiceError(ERROR_CODES.invalid, 'vaultPath 必须是字符串或 null。')
  }
  const qqLinkage = (patch as Record<string, unknown>)['qqLinkage']
  if (qqLinkage !== undefined) validateQqLinkagePatch(qqLinkage as Partial<QqLinkageConfig>)
}

/**
 * QQ 联动配置的边界校验。
 *
 * 标记列表只校验「是字符串数组」，具体清洗交给
 * {@link normalizeQqLinkage}（去空、去重、限长），这样即使配置来自手写的
 * `cordis.patch.yml`，也不会把脏值写进设置。
 */
export function validateQqLinkagePatch(patch: Partial<QqLinkageConfig> | unknown): void {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ServiceError(ERROR_CODES.invalid, 'QQ 联动配置必须是对象。')
  }
  const record = patch as Record<string, unknown>
  const mode = record['mode']
  if (mode !== undefined && !(QQ_LINKAGE_MODES as readonly string[]).includes(mode as string)) {
    throw new ServiceError(ERROR_CODES.invalid, `未知的 QqLinkage 模式：${String(mode)}`)
  }
  const writeMode = record['writeMode']
  if (writeMode !== undefined && !(QQ_WRITE_MODES as readonly string[]).includes(writeMode as string)) {
    throw new ServiceError(ERROR_CODES.invalid, `未知的 QQ 写回模式：${String(writeMode)}`)
  }
  if (record['allowTools'] !== undefined && typeof record['allowTools'] !== 'boolean') {
    throw new ServiceError(ERROR_CODES.invalid, 'QQ 联动的 allowTools 必须是布尔值。')
  }
  for (const key of ['qqMarkers', 'trustedMarkers'] as const) {
    const markers = record[key]
    if (markers === undefined) continue
    if (markers === null || typeof markers !== 'object' || Array.isArray(markers)) {
      throw new ServiceError(ERROR_CODES.invalid, `QQ 联动的 ${key} 必须是对象。`)
    }
    const markerRecord = markers as Record<string, unknown>
    for (const field of ['origins', 'presets', 'cwds'] as const) {
      const list = markerRecord[field]
      if (list === undefined) continue
      if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
        throw new ServiceError(ERROR_CODES.invalid, `QQ 联动的 ${key}.${field} 必须是字符串数组。`)
      }
    }
  }
}

/** 逐字段合并联动配置：未提供的字段沿用 `base`，避免一次保存抹掉其它字段。 */
export function mergeQqLinkage(base: QqLinkageConfig, override: Partial<QqLinkageConfig> | undefined): QqLinkageConfig {
  if (override === undefined || override === null) return normalizeQqLinkage(base)
  return normalizeQqLinkage({
    mode: override.mode ?? base.mode,
    writeMode: override.writeMode ?? base.writeMode,
    allowTools: override.allowTools ?? base.allowTools,
    qqMarkers: override.qqMarkers ?? base.qqMarkers,
    trustedMarkers: override.trustedMarkers ?? base.trustedMarkers,
  })
}

/** 宿主环境事实；优先从模块安装路径推导 Profile，其次读环境变量，绝不猜测。 */
function hostFacts(modulePath: string | undefined): QqHostFacts {
  const env = typeof process === 'undefined' ? {} : process.env
  const read = (name: string): string | null => {
    const value = env[name]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  const derived = deriveProfileFromModulePath(modulePath)
  return {
    profile: derived?.name ?? read('DSH_PROFILE'),
    profileDir: derived?.dir ?? read('DSH_PROFILE_DIR'),
    profileSource: derived !== null ? 'module-path' : read('DSH_PROFILE') !== null || read('DSH_PROFILE_DIR') !== null ? 'env' : 'unknown',
    dshHome: read('DSH_HOME'),
    platform: typeof process === 'undefined' ? 'unknown' : process.platform,
    nodeVersion: typeof process === 'undefined' ? 'unknown' : process.version,
  }
}

/**
 * 从插件模块的安装路径推导 Profile。
 *
 * 已安装的插件路径形如 `<DSH_HOME>/profiles/<name>/node_modules/dsh-longterm-memory/...`，
 * 这比继承来的 `DSH_PROFILE` 环境变量更可信（命令行用 `--profile` 启动时，环境
 * 变量可能仍是父进程的值）。用 `link:` 开发安装时路径在仓库里，推导会失败，
 * 这时返回 null，由调用方退回环境变量并在报告里标明来源。
 */
function deriveProfileFromModulePath(modulePath: string | undefined): { name: string; dir: string } | null {
  if (modulePath === undefined || modulePath.length === 0) return null
  const match = /^(.*?[\\/]profiles[\\/])([^\\/]+)[\\/]/i.exec(modulePath)
  if (match === null) return null
  const prefix = match[1]
  const name = match[2]
  if (prefix === undefined || name === undefined || name.length === 0) return null
  const dir = `${prefix}${name}`
  return { name, dir }
}
/** Boundary validation for `merge`: the HTTP body is untyped at runtime. */
export function validateMergeRequest(request: MergeRequest): void {
  if (request === null || typeof request !== 'object') throw new ServiceError(ERROR_CODES.invalid, '请求体必须是对象。')
  if (!Array.isArray(request.ids) || request.ids.length < 2) throw new ServiceError(ERROR_CODES.invalid, '合并至少需要两条记忆。')
  for (const id of request.ids) {
    if (typeof id !== 'string' || id.trim().length === 0) throw new ServiceError(ERROR_CODES.invalid, '合并目标是记忆 ID 字符串。')
  }
  if (request.targetId !== undefined && typeof request.targetId !== 'string') {
    throw new ServiceError(ERROR_CODES.invalid, '保留项必须是记忆 ID 字符串。')
  }
  if (request.reason !== undefined && typeof request.reason !== 'string') {
    throw new ServiceError(ERROR_CODES.invalid, '合并原因必须是字符串。')
  }
}
export function validateSaveRequest(request: SaveRequest): void {
  // Runtime shape checks: TypeScript types are erased at the HTTP boundary, and a
  // string passed as `tags` would otherwise be spread into single characters.
  if (request === null || typeof request !== 'object') throw new ServiceError(ERROR_CODES.invalid, '请求体必须是对象。')
  if (typeof request.title !== 'string') throw new ServiceError(ERROR_CODES.invalid, '标题必须是字符串。')
  if (typeof request.summary !== 'string') throw new ServiceError(ERROR_CODES.invalid, '正文必须是字符串。')
  if (!Array.isArray(request.tags)) throw new ServiceError(ERROR_CODES.invalid, '标签必须是字符串数组。')
  if (!(MEMORY_TYPES as readonly string[]).includes(request.type)) {
    throw new ServiceError(ERROR_CODES.invalid, `未知类别：${String(request.type)}`)
  }
  if (!(CONFIDENCE_LEVELS as readonly string[]).includes(request.confidence)) {
    throw new ServiceError(ERROR_CODES.invalid, `未知置信度：${String(request.confidence)}`)
  }
  if (request.status !== undefined && !(MEMORY_STATUSES as readonly string[]).includes(request.status)) {
    throw new ServiceError(ERROR_CODES.invalid, `未知状态：${String(request.status)}`)
  }
  if (request.title.trim().length === 0) throw new ServiceError(ERROR_CODES.invalid, '标题不能为空。')
  if (request.title.length > 300) throw new ServiceError(ERROR_CODES.invalid, '标题过长（上限 300 字符）。')
  if (request.summary.length > 20000) throw new ServiceError(ERROR_CODES.invalid, '正文过长（上限 20000 字符）。')
  if (!Number.isFinite(request.importance)) throw new ServiceError(ERROR_CODES.invalid, '重要程度必须是数字。')
  for (const tag of request.tags) {
    if (typeof tag !== 'string' || tag.trim().length === 0) throw new ServiceError(ERROR_CODES.invalid, '标签不能为空。')
  }
}

function statusToOp(status: MemoryStatus): JournalEntry['op'] {
  switch (status) {
    case 'archived':
      return 'archive'
    case 'stale':
      return 'stale'
    case 'superseded':
      return 'supersede'
    case 'conflict':
      return 'conflict'
    case 'active':
      return 'confirm'
    default:
      return 'update'
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * Append `extra` to `base` unless it is already there.
 *
 * Confirming a candidate that was judged a duplicate must not double the
 * survivor's summary or evidence text; when the text is new (a real supplement)
 * it is appended in the same `\n\n`-separated form the rest of the plugin uses.
 */
function appendUnique(base: string, extra: string): string {
  const trimmedBase = base.trim()
  const trimmedExtra = extra.trim()
  if (trimmedExtra.length === 0) return trimmedBase
  if (trimmedBase.includes(trimmedExtra)) return trimmedBase
  return trimmedBase.length === 0 ? trimmedExtra : `${trimmedBase}\n\n${trimmedExtra}`
}

function top(records: readonly IndexRecord[], score: (record: IndexRecord) => number, limit: number): WireHit[] {
  return [...records]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map(wrapHit)
}

function wrapHit(record: IndexRecord): WireHit {
  return { record, score: 0, reasons: [], matchedTerms: [] }
}

/** Upper bound on remembered turn keys; older keys are evicted first. */
const MAX_HANDLED_TURNS = 500

/**
 * Whether two candidates are about the same subject.
 *
 * Used for two things: not stacking duplicate Inbox entries across repeated
 * turns, and preferring a model candidate over the rule candidate that found the
 * same fact. Same type plus a high topical overlap is the signal.
 */
export function sameCandidateSubject(a: MemoryCandidate, b: MemoryCandidate): boolean {
  if (a.type !== b.type) return false
  const left = comparisonTerms(`${a.title}\n${a.summary}`)
  const right = comparisonTerms(`${b.title}\n${b.summary}`)
  return overlapCoefficient(left, right) >= 0.7
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

