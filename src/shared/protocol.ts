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
  MemoryStatus,
  MemoryType,
  VaultDiscovery,
  VaultInfo,
} from './types.js'
import type { IndexRecord, QueryFilters, SearchHit } from './search.js'

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
}

export const DEFAULT_SETTINGS: PluginSettings = {
  vaultPath: null,
  language: 'zh',
  enableTools: true,
  enablePromptSection: true,
  standingBudgetTokens: 700,
  standingMaxItems: 12,
  recallBudgetTokens: 600,
  recallMaxItems: 8,
  enablePerStepRecall: false,
  enableAutoExtraction: true,
  enableLlmExtraction: false,
  redactSecrets: true,
  sensitiveNeedsConfirmation: true,
  maxCandidatesPerTurn: 5,
  lastIndexRebuild: null,
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
  confirm: { id: string; reason?: string }
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
  /** Why the callback failed, when it did. */
  error: string | null
}

export type RpcRequest<M extends RpcMethod> = RpcRequestMap[M]
export type RpcResult<M extends RpcMethod> = RpcResultMap[M]

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
