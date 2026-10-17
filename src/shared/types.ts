/**
 * DSH Memory Vault — shared memory model.
 *
 * This module is imported by both the Host half and the Client half, so it must
 * stay free of Node built-ins and of any `@deepseek-ai/*` import.
 *
 * @module dsh-longterm-memory/shared/types
 */

/** The current on-disk metadata schema version; bumped by a migration when the shape changes. */
export const FRONTMATTER_SCHEMA_VERSION = 1

/**
 * Memory categories. The nine product categories map onto these eight types plus
 * the `pending`/`archived`/`superseded`/`conflict` statuses.
 */
export const MEMORY_TYPES = [
  'profile',
  'preference',
  'project',
  'project-state',
  'decision',
  'knowledge',
  'experience',
  'task',
] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

/** Lifecycle state of a memory. Only `active` memories are recalled as current fact. */
export const MEMORY_STATUSES = ['active', 'pending', 'stale', 'superseded', 'conflict', 'archived'] as const

export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/** How strongly a memory's content is believed. Never invented: `low` keeps a memory out of recall. */
export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const

export type Confidence = (typeof CONFIDENCE_LEVELS)[number]

/** Human-facing label for each category, plus its storage directory. */
export interface TypeDescriptor {
  readonly type: MemoryType
  /** Directory inside the vault holding `active` memories of this type. */
  readonly dir: string
  readonly labelZh: string
  readonly labelEn: string
  /** Short tag attached automatically to new memories of this type. */
  readonly defaultTag: string
}

export const TYPE_DESCRIPTORS: Readonly<Record<MemoryType, TypeDescriptor>> = {
  profile: { type: 'profile', dir: 'Profile', labelZh: '用户背景', labelEn: 'Profile', defaultTag: 'profile' },
  preference: {
    type: 'preference',
    dir: 'Preferences',
    labelZh: '长期偏好',
    labelEn: 'Preference',
    defaultTag: 'preference',
  },
  project: { type: 'project', dir: 'Projects', labelZh: '项目', labelEn: 'Project', defaultTag: 'project' },
  'project-state': {
    type: 'project-state',
    dir: 'Projects/State',
    labelZh: '项目进展',
    labelEn: 'Project state',
    defaultTag: 'project-state',
  },
  decision: { type: 'decision', dir: 'Decisions', labelZh: '决策', labelEn: 'Decision', defaultTag: 'decision' },
  knowledge: { type: 'knowledge', dir: 'Knowledge', labelZh: '知识', labelEn: 'Knowledge', defaultTag: 'knowledge' },
  experience: {
    type: 'experience',
    dir: 'Experiences',
    labelZh: '经验教训',
    labelEn: 'Experience',
    defaultTag: 'experience',
  },
  task: { type: 'task', dir: 'Tasks', labelZh: '任务', labelEn: 'Task', defaultTag: 'task' },
}

/** Fixed vault directories that are not type directories. */
export const VAULT_DIRS = {
  index: 'Index',
  templates: 'Templates',
  inbox: 'Inbox',
  archive: 'Archive',
  conflicts: 'Conflicts',
  history: 'History',
  private: '.dsh-memory',
  obsidian: '.obsidian',
} as const

/** File names the plugin owns at the vault root. */
export const VAULT_ROOT_FILES = {
  readme: 'README.md',
  home: 'Memory Home.md',
  allMemories: 'Index/all-memories.md',
} as const

/**
 * The status a memory's file lives under when it is not `active`.
 * `active` and `stale` stay in the type directory; the rest move to a dedicated
 * folder so that a human browsing the vault sees what is no longer current.
 */
export const STATUS_DIRECTORY: Readonly<Partial<Record<MemoryStatus, string>>> = {
  pending: VAULT_DIRS.inbox,
  archived: VAULT_DIRS.archive,
  conflict: VAULT_DIRS.conflicts,
  superseded: VAULT_DIRS.archive,
}

/** One memory as stored in Markdown, without its body. */
export interface MemoryMeta {
  /** Stable, unique memory id, e.g. `mem_20261017t031200_a1b2c3d4`. */
  id: string
  type: MemoryType
  status: MemoryStatus
  /** ISO-8601 UTC instant the memory was first written. */
  createdAt: string
  /** ISO-8601 UTC instant of the most recent content or metadata change. */
  updatedAt: string
  /** One-line human title; also the Markdown H1. */
  title: string
  tags: string[]
  /** Confidence in the content. `low` is excluded from recall until confirmed. */
  confidence: Confidence
  /** 0-100; drives recall priority and the "important" filter. */
  importance: number
  /** Pinned memories are always considered by recall, budget permitting. */
  pinned: boolean
  /** Session ids that produced or last touched this memory. Empty when host-provided ids were unavailable. */
  sourceSessions: string[]
  /** Ids of memories this one replaces. */
  supersedes: string[]
  /** Id of the active memory that replaced this one, when superseded. */
  supersededBy?: string
  /** Ids of memories this one factually disagrees with. */
  conflictsWith: string[]
  /** Alternate names/terms used for exact and fuzzy matching. */
  aliases: string[]
  /** Free-form provenance note (how the content was established). */
  evidence: string
  /** On-disk metadata schema version. */
  schemaVersion: number
}

/** A complete memory: metadata plus the natural-language body. */
export interface Memory extends MemoryMeta {
  /**
   * Body sections as authored. `summary` is the "核心内容" section,
   * `evidence` text lives in metadata, and `related` holds `[[wikilink]]` targets.
   */
  summary: string
  /** Extra narrative sections preserved verbatim, in document order. */
  sections: MemorySection[]
  /**
   * Frontmatter keys this plugin does not own, kept so a write never deletes a
   * user's own metadata. Never serialized as a field; it is re-emitted as-is.
   */
  extraFrontmatter?: Record<string, unknown>
  /**
   * The document body as last read, used to splice only the plugin-owned sections
   * and leave every other line untouched. Derived on read, never stored in the file.
   */
  preservedBody?: string
  /**
   * The complete original file text. Used to rewrite only plugin-owned fields at
   * the source-text level, so YAML comments, key order and quoting survive.
   */
  preservedSource?: string
  related: string[]
}

export interface MemorySection {
  heading: string
  body: string
}

/** A candidate memory that has not yet been promoted to a memory file. */
export interface MemoryCandidate {
  id: string
  type: MemoryType
  title: string
  summary: string
  tags: string[]
  confidence: Confidence
  importance: number
  sourceSessions: string[]
  evidence: string
  createdAt: string
  /** Why the extractor proposed this candidate. */
  reason: string
  /** Ids of existing memories this candidate is judged to touch. */
  relatedIds: string[]
  /** The action the deterministic policy chose. */
  decision: CandidateDecision
  /** Set when the candidate was refused outright (secret, or no evidence). */
  refused?: string
}

export type CandidateDecision =
  | { action: 'create' }
  | { action: 'update'; targetId: string; rationale: string }
  | { action: 'merge'; targetIds: string[]; rationale: string }
  | { action: 'conflict'; targetId: string; rationale: string }
  | { action: 'inbox'; rationale: string }

/** A recorded change, one JSON object per journal line. */
export interface JournalEntry {
  at: string
  /** What the plugin did. */
  op:
    | 'create'
    | 'update'
    | 'delete'
    | 'archive'
    | 'stale'
    | 'supersede'
    | 'conflict'
    | 'merge'
    | 'confirm'
    | 'reject'
    | 'index-rebuild'
    | 'index-sync'
    | 'init'
    | 'migrate'
  id: string
  /** Bounded before/after summaries — never the full text, so the journal stays small and safe. */
  before?: string
  after?: string
  reason: string
  /** Session or actor that caused the change. */
  source?: string
  /** Ids of memories folded into this change. */
  related?: string[]
}

/** Index statistics surfaced in the management page. */
export interface VaultStats {
  total: number
  byType: Record<string, number>
  byStatus: Record<string, number>
  pending: number
  conflicts: number
  stale: number
  archived: number
  pinned: number
  /** Memories whose file mtime/size differs from the indexed ones. */
  outOfSync: number
}

export interface VaultInfo {
  /** Absolute vault path. */
  path: string
  /** True when the vault already existed and was reused rather than created. */
  reused: boolean
  /** Whether the vault directory carries our marker. */
  initialized: boolean
  /** Whether the vault is a real Obsidian vault (has a `.obsidian` directory). */
  obsidianVault: boolean
  stats: VaultStats
  /** Index freshness. */
  index: {
    builtAt: string | null
    count: number
    /** False when the persisted index was rejected/corrupt and rebuilt. */
    healthy: boolean
    /** Path of the persisted index file. */
    path: string
  }
}

/** Detection outcome for the first-run / path-selection flow. */
export interface VaultDiscovery {
  /** Environment the host half is running in, as far as it can be proven. */
  environment: 'desktop' | 'web' | 'node'
  /** Whether local filesystem access is available at all. */
  filesystem: boolean
  /** Obsidian installations/vaults confirmed on this machine. */
  obsidian: {
    detected: boolean
    /** Path of the Obsidian configuration file that was read, when one was. */
    configPath: string | null
    /** Vaults that were confirmed to exist and look like Obsidian vaults. */
    vaults: string[]
  }
  /** The vault currently in effect, when one is configured/reusable. */
  current: string | null
  /** Ordered, de-duplicated candidates for a new vault. */
  candidates: string[]
  /** Whether the caller must pick a path before initialization can proceed. */
  needsChoice: boolean
  /** Human-readable explanation of the decision. */
  rationale: string
  /** Non-fatal problems worth showing. */
  warnings: string[]
}

export function typeDir(type: MemoryType, status: MemoryStatus): string {
  const override = STATUS_DIRECTORY[status]
  if (override !== undefined) return override
  return TYPE_DESCRIPTORS[type].dir
}

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value)
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value)
}

/** Statuses that may be presented to the model as current fact. */
export const RECALLABLE_STATUSES: readonly MemoryStatus[] = ['active']

/** Statuses that are human-readable but must not be presented as current fact. */
export const NON_CURRENT_STATUSES: readonly MemoryStatus[] = ['stale', 'superseded', 'archived', 'conflict']
