/**
 * The client↔host contract.
 *
 * The Client half talks to the Host half over the DSH web server, so these types
 * are the wire shape. They are plain JSON by construction: no `Date`, no `Map`,
 * no `undefined` inside payloads.
 *
 * @module dsh-longterm-memory/shared/protocol
 */

import type {
  Confidence,
  JournalEntry,
  Memory,
  MemoryCandidate,
  MemoryChannel,
  MemoryStatus,
  MemoryType,
  MemoryVisibility,
  VaultDiscovery,
  VaultInfo,
} from './types.js'
import type { IndexRecord, QueryFilters, SearchHit } from './search.js'
import { DEFAULT_QQ_LINKAGE, type LinkageRuntimeStatus, type QqLinkageConfig } from './qq-linkage.js'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/dsh-longterm-memory/api'

/** Every RPC method the host serves. */
export const RPC_METHODS = [
  'status',
  'discover',
  'initialize',
  'chooseVault',
  'overview',
  'search',
  'get',
  'readRaw',
  'writeRaw',
  'save',
  'confirm',
  'reject',
  'setStatus',
  'setPinned',
  'delete',
  'merge',
  'resolveConflict',
  'rebuildIndex',
  'syncIndex',
  'history',
  'candidates',
  'addCandidate',
  'openVault',
  'getSettings',
  'setSettings',
  'previewRecall',
  'previewStanding',
  'qqLinkage',
  'setQqLinkage',
  'ownerBindingStatus',
  'ownerBindingCreatePairCode',
  'ownerBindingUnbind',
  'visibilityReview',
  'setVisibility',
  'companionStatus',
  'updateCompanion',
  'companionPresets',
  'companionApplyPreset',
  'companionFillAnchors',
  /**
   * Spend one model call to see the saved persona answer a single line.
   *
   * A persona editor cannot be judged from its own form fields; this is the only
   * way to hear the voice before QQ uses it.
   */
  'personaTry',
  'stickerLibrary',
  /** One sticker's bytes as a data URL, so the library shows real previews. */
  'stickerThumb',
  'stickerImport',
  'stickerUpdate',
  'stickerDelete',
  'reminderList',
  'reminderCreate',
  'reminderCancel',
  'reminderComplete',
  'reminderReschedule',
] as const

export type RpcMethod = (typeof RPC_METHODS)[number]

/** A JSON-safe search hit for the wire. */
export interface WireHit {
  record: IndexRecord
  score: number
  reasons: string[]
  matchedTerms: string[]
}

export function toWireHit(hit: SearchHit): WireHit {
  return { record: hit.record, score: hit.score, reasons: [...hit.reasons], matchedTerms: [...hit.matchedTerms] }
}

/** What the host can and cannot do in this DSH build, reported honestly to the UI. */
export interface CapabilityReport {
  /** Host filesystem access is available (always true for a host plugin). */
  filesystem: boolean
  /** `ctx.webServer` is present, so the page can reach the host. */
  webServer: boolean
  /** `ctx.systemPrompt` is present, so standing memories reach the model. */
  systemPrompt: boolean
  /** `ctx.tools` is present, so the model can call the memory tools. */
  tools: boolean
  /** `session/event` subscription is active, so turns can trigger extraction. */
  sessionEvents: boolean
  /** Extraction by LLM is enabled *and* `ctx.llm` was reachable. */
  llmExtraction: boolean
  /** `ctx.tools` rows actually registered, by tool name. */
  registeredTools: string[]
  /** Reasons a capability is off, keyed by the capability name. */
  notes: Record<string, string>
}

export interface StatusResponse {
  vault: VaultInfo | null
  discovery: VaultDiscovery
  capabilities: CapabilityReport
  settings: PluginSettings
}

export interface OverviewResponse {
  vault: VaultInfo
  /** Most recently created memories. */
  recentCreated: WireHit[]
  /** Most recently updated memories. */
  recentUpdated: WireHit[]
  /** Pending candidates awaiting confirmation. */
  pending: WireHit[]
  /** Memories flagged as conflicting or superseded. */
  problems: WireHit[]
  /** Distinct tags with counts. */
  tags: { tag: string; count: number }[]
  /** Memories whose Markdown changed on disk since the index last saw them. */
  outOfSync: string[]
  /** Ids carried by more than one file, so the user can reconcile them. */
  duplicates: { id: string; paths: string[] }[]
  /** Whether an index rebuild is running. */
  busy: boolean
}

export interface SearchRequest {
  text?: string
  filters?: QueryFilters
  limit?: number
  /** Include non-active memories. Defaults to true in the management page. */
  includeNonCurrent?: boolean
}

export interface SearchResponse {
  hits: WireHit[]
  total: number
  /** How long the query took, in milliseconds. */
  tookMs: number
  /** True when the index had to be rebuilt or synced to answer. */
  indexRefreshed: boolean
}

export interface GetResponse {
  memory: Memory
  /** The exact Markdown currently on disk. */
  raw: string
  relativePath: string
  absolutePath: string
  /** Change history for this memory, newest first. */
  history: JournalEntry[]
  related: WireHit[]
  /** Whether this memory is eligible for recall right now. */
  recallable: boolean
  /** Why it is or is not recallable. */
  recallNote: string
}

export interface SaveRequest {
  /** Omitted to create a new memory. */
  id?: string
  type: MemoryType
  title: string
  summary: string
  tags: string[]
  confidence: Confidence
  importance: number
  pinned?: boolean
  aliases?: string[]
  evidence?: string
  /** Status to write; omitted keeps the existing status, or `active` for a new memory. */
  status?: MemoryStatus
  /** Session ids to attribute the change to. */
  sourceSessions?: string[]
  /**
   * Read scope to write. Omitted keeps the existing value, or the restrictive
   * default for a new memory.
   *
   * Deliberately **not** exposed to the model as a tool argument: letting the
   * model widen visibility would let a single prompt turn a desktop-private
   * memory into a shared one.
   */
  visibility?: MemoryVisibility
  /** Interfaces that contributed. Merged with the existing set, never replaced. */
  sourceChannels?: MemoryChannel[]
  reason?: string
}

export interface SaveResponse {
  id: string
  created: boolean
  /** Validation repairs applied to human input, surfaced so the user can see them. */
  repairs: string[]
  warnings: string[]
}

export interface StatusChangeRequest {
  id: string
  status: MemoryStatus
  reason?: string
  /** Required when superseding: the memory that supersedes this one. */
  supersededBy?: string
}

export interface DeleteRequest {
  id: string
  /** Must be exactly `true`; the UI sends it only after the second confirmation. */
  confirm: true
  /** When true the note is archived instead of removed. */
  archiveOnly?: boolean
}

export interface MergeRequest {
  /** Memories to fold together; the first is the survivor. */
  ids: string[]
  /** Optional explicit survivor. */
  targetId?: string
  reason?: string
}

export interface ConflictRequest {
  id: string
  /** `keep`: keep this one and archive the counterpart; `merge`: fold them; `both`: leave both, clear the flag. */
  strategy: 'keep' | 'merge' | 'both'
  otherIds: string[]
  reason?: string
}

export interface HistoryResponse {
  entries: JournalEntry[]
}

export interface CandidatesResponse {
  candidates: MemoryCandidate[]
}

export interface AddCandidateRequest {
  type: MemoryType
  title: string
  summary: string
  tags?: string[]
  confidence?: Confidence
  importance?: number
  evidence?: string
  sourceSessions?: string[]
  reason?: string
}

export interface RawDocument {
  relativePath: string
  content: string
  /** Fingerprint of the content the client read, so a conflicting write is refused. */
  checksum: string
}

export interface WriteRawRequest {
  id: string
  content: string
  /** The checksum the client last saw; a mismatch means the file changed underneath. */
  expectedChecksum: string
}

export interface WriteRawResponse {
  repairs: string[]
  warnings: string[]
}

export interface RebuildIndexResponse {
  records: number
  repairedFiles: number
  quarantined: { path: string; reason: string }[]
  /** Ids carried by more than one file, which the index can only key once. */
  duplicates: { id: string; paths: string[] }[]
  tookMs: number
}

export interface SyncIndexResponse {
  added: string[]
  updated: string[]
  removed: string[]
  unchanged: number
  duplicates: { id: string; paths: string[] }[]
}

export interface OpenVaultResponse {
  opened: boolean
  /** The command that was attempted, or the reason nothing was attempted. */
  detail: string
}

export interface PluginSettings {
  /** Vault path in effect, or null before initialization. */
  vaultPath: string | null
  /** Interface language: `zh` or `en`. */
  language: 'zh' | 'en'
  /** Register the model-facing memory tools. */
  enableTools: boolean
  /** Contribute the standing-facts system-prompt section. */
  enablePromptSection: boolean
  /** Token budget for the standing system-prompt section. */
  standingBudgetTokens: number
  /** Maximum entries in the standing section. */
  standingMaxItems: number
  /**
   * 用语义分区（长期背景 / 当前关注 / 交流偏好 / 其他）表达常驻记忆，而不是逐条列表。
   *
   * 关闭后退回 0.1.8 的平铺列表，用于对照实验；不影响任何权限判定。
   */
  standingSemanticGroups?: boolean
  /** 在条目后标注时间与「不确定」，避免过期内容被当成当前事实。 */
  standingTimeHints?: boolean
  /** 过滤「不像关于这个人的事实」的条目（工具签名、转述片段、目录条目）。 */
  standingQualityGate?: boolean
  /** `project*` / `task` 类记忆只有在该天数内更新过才进入常驻块。 */
  standingCurrentWindowDays?: number
  /** Token budget for per-query recall. */
  recallBudgetTokens: number
  /** Maximum entries in a per-query recall block. */
  recallMaxItems: number
  /** Splice retrieved memory into each step as a user message (durable history, costs tokens). */
  enablePerStepRecall: boolean
  /** Automatically extract candidate memories when a turn ends. */
  enableAutoExtraction: boolean
  /** Use an LLM call for extraction (opt-in; performs a provider request). */
  enableLlmExtraction: boolean
  /** Refuse memories that look like secrets. */
  redactSecrets: boolean
  /** Treat health/finance/identity content as needing confirmation. */
  sensitiveNeedsConfirmation: boolean
  /** Maximum candidates extracted per turn. */
  maxCandidatesPerTurn: number
  /** ISO instant of the last index rebuild. */
  lastIndexRebuild: string | null
  /**
   * QQ 接入与长期记忆的联动配置。
   *
   * 默认 `mode: 'off'`，即本插件的行为与未接入 QQ 时完全一致；策略一旦启用，
   * 由宿主端在常驻注入、每步检索、写回与工具四个执行点真正执行，而不是只
   * 隐藏界面开关。
   */
  qqLinkage: QqLinkageConfig
}

export const DEFAULT_SETTINGS: PluginSettings = {
  vaultPath: null,
  language: 'zh',
  enableTools: true,
  enablePromptSection: true,
  standingBudgetTokens: 700,
  standingMaxItems: 12,
  standingSemanticGroups: true,
  standingTimeHints: true,
  standingQualityGate: true,
  standingCurrentWindowDays: 45,
  recallBudgetTokens: 600,
  recallMaxItems: 8,
  enablePerStepRecall: false,
  enableAutoExtraction: true,
  enableLlmExtraction: false,
  redactSecrets: true,
  sensitiveNeedsConfirmation: true,
  maxCandidatesPerTurn: 5,
  lastIndexRebuild: null,
  qqLinkage: DEFAULT_QQ_LINKAGE,
}

export interface RpcRequestMap {
  status: Record<string, never>
  discover: Record<string, never>
  initialize: { path?: string }
  chooseVault: { path: string }
  overview: Record<string, never>
  search: SearchRequest
  get: { id: string }
  readRaw: { id: string }
  writeRaw: WriteRawRequest
  save: SaveRequest
  /** visibility is an explicit human review decision; omitted keeps the conservative scope. */
  confirm: { id: string; reason?: string; visibility?: MemoryVisibility }
  reject: { id: string; reason?: string; keepFile?: boolean }
  setStatus: StatusChangeRequest
  setPinned: { id: string; pinned: boolean }
  delete: DeleteRequest
  merge: MergeRequest
  resolveConflict: ConflictRequest
  rebuildIndex: Record<string, never>
  syncIndex: Record<string, never>
  history: { id?: string; limit?: number }
  candidates: Record<string, never>
  addCandidate: AddCandidateRequest
  openVault: { target?: string }
  getSettings: Record<string, never>
  setSettings: Partial<PluginSettings>
  previewRecall: { query?: string; limit?: number }
  previewStanding: Record<string, never>
  qqLinkage: Record<string, never>
  setQqLinkage: { config: Partial<QqLinkageConfig> }
  ownerBindingStatus: Record<string, never>
  ownerBindingCreatePairCode: Record<string, never>
  ownerBindingUnbind: Record<string, never>
  visibilityReview: Record<string, never>
  setVisibility: SetVisibilityRequest
  companionStatus: Record<string, never>
  updateCompanion: UpdateCompanionRequest
  companionPresets: Record<string, never>
  companionApplyPreset: { presetId: string }
  companionFillAnchors: { presetId: string }
  personaTry: PersonaTryRequest
  stickerLibrary: Record<string, never>
  stickerThumb: { id: string }
  stickerImport: StickerImportRequest
  stickerUpdate: StickerUpdateRequest
  stickerDelete: { id: string; confirm: boolean }
  reminderList: Record<string, never>
  reminderCreate: ReminderCreateRequest
  reminderCancel: { id: string }
  reminderComplete: { id: string }
  reminderReschedule: { id: string; dueAt: string }
}

export interface RpcResultMap {
  status: StatusResponse
  discover: VaultDiscovery
  initialize: StatusResponse
  chooseVault: StatusResponse
  overview: OverviewResponse
  search: SearchResponse
  get: GetResponse
  readRaw: RawDocument
  writeRaw: WriteRawResponse
  save: SaveResponse
  confirm: { id: string }
  reject: { id: string }
  setStatus: { id: string }
  setPinned: { id: string }
  delete: { id: string }
  merge: { id: string; mergedIds: string[] }
  resolveConflict: { id: string; archived: string[] }
  rebuildIndex: RebuildIndexResponse
  syncIndex: SyncIndexResponse
  history: HistoryResponse
  candidates: CandidatesResponse
  addCandidate: { id: string }
  openVault: OpenVaultResponse
  getSettings: PluginSettings
  setSettings: PluginSettings
  previewRecall: { text: string; usedTokens: number; includedIds: string[]; omitted: number }
  previewStanding: StandingPreview
  qqLinkage: QqLinkageReport
  setQqLinkage: QqLinkageReport
  ownerBindingStatus: OwnerBindingStatusWire
  ownerBindingCreatePairCode: OwnerPairCodeWire
  ownerBindingUnbind: OwnerBindingStatusWire
  visibilityReview: VisibilityReviewResponse
  setVisibility: { id: string; changed: boolean }
  companionStatus: CompanionWire | null
  updateCompanion: CompanionWire
  companionPresets: PersonaPresetsResponse
  companionApplyPreset: CompanionWire
  /** Fills only the empty anchors from a preset; user text is never overwritten. */
  companionFillAnchors: CompanionWire
  personaTry: PersonaTryResponse
  stickerLibrary: StickerLibraryResponse
  stickerThumb: StickerThumbResponse
  stickerImport: StickerImportResponse
  stickerUpdate: { id: string; changed: boolean }
  stickerDelete: { id: string; removed: boolean }
  reminderList: ReminderListResponse
  reminderCreate: ReminderWire
  reminderCancel: { id: string; changed: boolean }
  reminderComplete: { id: string; nextId: string | null }
  reminderReschedule: ReminderWire
}

/* ------------------------------------------------ WP-6 management centre --- */

/** One row of the opt-in sharing review. Never defaults to `shared`. */
export interface VisibilityReviewRow {
  id: string
  title: string
  type: MemoryType
  status: MemoryStatus
  visibility: MemoryVisibility
  sourceChannels: MemoryChannel[]
  updatedAt: string
}

export interface VisibilityReviewResponse {
  rows: VisibilityReviewRow[]
  byVisibility: Record<MemoryVisibility, number>
}

/** Deliberately single-id: there is no bulk "share everything" endpoint. */
export interface SetVisibilityRequest {
  id: string
  visibility: MemoryVisibility
  reason?: string
}

/** One exchange used as a persona style anchor. */
export interface PersonaExampleWire {
  user: string
  assistant: string
}

export interface CompanionWire {
  available: boolean
  usingDefault: boolean
  problems: string[]
  revision: string | null
  documents: {
    name: string
    identity: string
    temperament: string
    address: string
    languageHabits: string
    boundaries: string[]
    /** Optional anchors — absent on a legacy hand-written `Persona.md`. */
    scenario?: string
    catchphrases?: string[]
    avoid?: string[]
    examples?: PersonaExampleWire[]
    tone: string
    notes: string
    quietTriggers: string[]
    stopTriggers: string[]
  }
}

export interface UpdateCompanionRequest {
  name?: string
  identity?: string
  temperament?: string
  address?: string
  languageHabits?: string
  boundaries?: string[]
  scenario?: string
  catchphrases?: string[]
  avoid?: string[]
  examples?: PersonaExampleWire[]
  tone?: string
  notes?: string
  quietTriggers?: string[]
  stopTriggers?: string[]
}

/**
 * Ask the saved persona to answer one line.
 *
 * Costs exactly one model call against the user's own provider, which is why it
 * is a deliberate button and never a side effect of opening the page.
 */
export interface PersonaTryRequest {
  /** What the user says to the persona. Normalised and capped host-side. */
  text: string
}

export interface PersonaTryResponse {
  /** False when no model route is reachable; `reason` then says why. */
  available: boolean
  reason: string | null
  /** The line the persona would send; null when the call produced none. */
  reply: string | null
  provider: string | null
  model: string | null
  /** The exact instruction that was sent, so a bad line can be explained. */
  systemPrompt: string
  /** The utterance actually sent, after normalisation. */
  utterance: string
  /**
   * Persona layers the character budget removed before the model ever saw them.
   *
   * An empty array is the normal case. A filled one means the user wrote a field
   * that will never take effect in QQ — silently, unless the page says so.
   */
  droppedLayers: readonly { key: string; label: string }[]
}

/* ------------------------------- WP-6 跨插件管理面（life-agent@v1） --- */

/** Built-in persona archetypes offered before the user edits anything. */
export interface PersonaPresetWire {
  id: string
  /** Human label (Chinese); the English page uses the dictionary by id. */
  label: string
  tagline: string
}

export interface PersonaPresetsResponse {
  available: boolean
  items: PersonaPresetWire[]
}

/**
 * One sticker as the PC management page sees it.
 *
 * The library is owned by the Vault (`Companion/Stickers/`, excluded from the
 * fact index) and consumed by the QQ plugin through `sticker-library@v1`. The
 * page therefore works on an install without the plugin; `source` says which
 * owner answered this request.
 */
export interface StickerWire {
  id: string
  /** Basename inside the plugin's sticker root. Never an absolute path. */
  file: string
  description: string
  tags: string[]
  enabled: boolean
  favorite: boolean
  usedCount: number
  bytes: number
  addedAt: string
}

export interface StickerLibraryResponse {
  /** False when the QQ plugin (or its storage) is not loaded in this Host. */
  available: boolean
  /** Human-readable reason for `available: false`. */
  reason: string | null
  /** Directory the plugin owns, for diagnostics only. */
  storagePath: string | null
  total: number
  enabledCount: number
  /** Rows dropped because the plugin returned a shape we do not trust. */
  rejected: number
  items: StickerWire[]
  /** Which owner answered: the Vault library, or the QQ plugin bridge. */
  source?: 'vault' | 'plugin'
}

/** Single-file import. There is deliberately no batch import endpoint. */
export interface StickerImportRequest {
  fileName: string
  /** Base64 of the image bytes; decoded length is capped host-side. */
  dataBase64: string
  description?: string
  tags?: string[]
}

/** A single preview image; `dataUrl` is null when the file is too large. */
export interface StickerThumbResponse {
  available: boolean
  dataUrl: string | null
  reason: string | null
}

export interface StickerImportResponse {
  id: string | null
  duplicate: boolean
  reason: string | null
  item: StickerWire | null
}

/**
 * Toggle user-controlled state on exactly one sticker. No bulk variant exists.
 *
 * `description` / `tags` are optional and only honoured by the vault-owned
 * catalogue: the QQ plugin bridge exposes flags alone, and the Host reports that
 * limitation instead of pretending the edit was saved.
 */
export interface StickerUpdateRequest {
  id: string
  enabled?: boolean
  favorite?: boolean
  /** Human label shown in the tray; trimmed and length-capped host-side. */
  description?: string
  /** Emotion tags the QQ side selects on; normalised (trim / dedupe / lowercase). */
  tags?: string[]
}

/** One reminder as the PC management page sees it. */
export interface ReminderWire {
  id: string
  title: string
  note: string
  dueAt: string
  status: 'pending' | 'done' | 'cancelled'
  repeat: { unit: 'day' | 'week' | 'month'; interval: number } | null
  /**
   * Delivery state. Outside a legal QQ passive window a due reminder stays
   * `deferred` — it is never pushed proactively (design §八.3).
   */
  delivery: 'waiting' | 'deferred' | 'delivered'
  createdAt: string
  updatedAt: string
  attempts: number
  lastAttemptAt: string | null
}

export interface ReminderListResponse {
  available: boolean
  reason: string | null
  /** Which store actually backs the list. */
  store: 'vault' | 'plugin' | null
  items: ReminderWire[]
  /** Reminders currently parked in the deferred queue. */
  queueSize: number
  delivery: { windowOpen: boolean; remainingReplies: number } | null
}

export interface ReminderCreateRequest {
  title: string
  note?: string
  dueAt: string
  repeat?: { unit: 'day' | 'week' | 'month'; interval: number } | null
}

/**
 * The plugin's exact system-prompt contribution, obtained by invoking the very
 * text callback that was registered with ctx.systemPrompt.section().
 *
 * This is how the prompt contribution is verified on a live host without a model
 * call: the callback *is* the contribution.
 */
export interface StandingPreview {
  /** Whether a section was registered at all. */
  registered: boolean
  /** Registered section name, e.g. longterm-memory:standing. */
  name: string | null
  /** Registered order. */
  order: number | null
  /** The exact string the prompt pipeline receives from this plugin. */
  text: string
  usedTokens: number
  includedIds: string[]
  omitted: number
  /**
   * 文本实际分成了哪几个语义区，以及每区渲染了哪几条。
   * 只在启用语义分区时出现；旧客户端读不到该字段也不受影响。
   */
  groups?: { key: string; heading: string; ids: string[] }[]
  /** 被质量门或时效窗口排除的条目及原因，供管理页解释「为什么没进去」。 */
  excluded?: { id: string; title: string; reason: string }[]
  /** 因与另一条同主题而被合并显示的条目 id。 */
  dedupedIds?: string[]
  /** Why the callback failed, when it did. */
  error: string | null
}

export type RpcRequest<M extends RpcMethod> = RpcRequestMap[M]
export type RpcResult<M extends RpcMethod> = RpcResultMap[M]

/* ------------------------------------------------------- QQ 接入联动报告 */

/** 宿主环境事实，用于诊断区如实展示「本插件跑在哪个运行环境里」。 */
export interface QqHostFacts {
  /** 本进程实际加载的 DSH Profile 名；无法判定时为 null。 */
  profile: string | null
  /** 该 Profile 的配置目录；无法判定时为 null。 */
  profileDir: string | null
  /**
   * `profile` / `profileDir` 的证据来源：
   * `module-path` = 从插件安装路径推导（最可信）；`env` = 退回环境变量；
   * `unknown` = 两者都没有。
   */
  profileSource: 'module-path' | 'env' | 'unknown'
  /** `DSH_HOME` 环境变量的值，未知时为 null。 */
  dshHome: string | null
  platform: string
  nodeVersion: string
}

/** 四个执行点的实际注册情况。 */
export interface QqEnforcementReport {
  /** 常驻记忆注入已注册，且宿主的 `text` 回调携带会话上下文（可按会话拦截）。 */
  standing: boolean
  /** 每步检索已注册。 */
  perStepRecall: boolean
  /** 会话结束提取已注册。 */
  extraction: boolean
  /** 模型记忆工具已注册。 */
  tools: boolean
  registeredTools: string[]
  notes: Record<string, string>
}

/** 最近观察到的一次会话判定，用来证明策略真的在跑。 */
export interface QqSessionSample {
  sessionId: string
  channel: string
  matchedBy: string | null
  marker: string | null
  reason: string
  /** ISO 时间。 */
  lastSeenAt: string
}

/** 各执行点的拦截计数（本次进程生命周期内，重启归零）。 */
export interface QqLinkageCounters {
  standingBlocked: number
  recallBlocked: number
  writesForcedInbox: number
  toolsBlocked: number
}

export interface QqLinkageReport {
  config: QqLinkageConfig
  /** 策略在运行时到底能做到什么，来自 shared/qq-linkage 的同一套判定。 */
  runtime: LinkageRuntimeStatus
  enforcement: QqEnforcementReport
  host: QqHostFacts
  vaultPath: string | null
  sessions: QqSessionSample[]
  counters: QqLinkageCounters
}

/** 跨端 Owner 绑定状态（来自 qqbotContext@v1，缺失时 available=false）。 */
export interface OwnerBindingStatusWire {
  available: boolean
  bound: boolean
  ownerId: string | null
  qq: {
    platform: string
    appIdMasked: string
    openidMasked: string
    boundAt: string
  } | null
}

/** 一次性配对码：明文只返回这一次。 */
export interface OwnerPairCodeWire {
  available: boolean
  code: string | null
  expiresAt: string | null
  ttlMs: number
  error?: string
}

/** Success/failure envelope used by every route response. */
export type RpcEnvelope<M extends RpcMethod> =
  | { ok: true; data: RpcResult<M> }
  | { ok: false; error: { code: string; message: string; detail?: string } }

/** Machine-readable failure codes the UI reacts to. */
export const ERROR_CODES = {
  notInitialized: 'vault-not-initialized',
  needsChoice: 'vault-needs-choice',
  notFound: 'not-found',
  conflict: 'write-conflict',
  invalid: 'invalid-request',
  forbidden: 'forbidden',
  busy: 'busy',
  unsupported: 'unsupported',
  internal: 'internal',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
