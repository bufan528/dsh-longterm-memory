/**
 * Model-facing memory tools.
 *
 * The tool definitions are built by hand rather than with
 * `@deepseek-ai/dsh-tools`'s `defineTool` helper, because a third-party plugin's
 * module scope is not guaranteed to resolve that package. The definition shape
 * below is exactly what `ToolRuntime.register()` requires and validates: a
 * `name`, a `description`, a `parameters` JSON Schema, an `output` with a
 * schema and a `render` function, and an `execute` function.
 *
 * The schema subset DSH enforces is narrow — `type`, `oneOf`, `properties`,
 * `required`, `additionalProperties`, `items`, `enum`, `const`, plus the
 * `description`/`title`/`default`/`examples` annotations. Numeric ranges are not
 * expressible, so every range is checked in `execute` and reported as a normal
 * tool error.
 *
 * @module dsh-longterm-memory/host/dsh/tools
 */

import type { MemoryService } from '../core/service.js'
import { ServiceError } from '../core/service.js'
import { MEMORY_TYPES, MEMORY_STATUSES, TYPE_DESCRIPTORS, type MemoryType } from '../../shared/types.js'
import { scanSecrets } from '../core/engine.js'

/** Minimal JSON value type used by tool render output. */
export interface ToolTextBlock {
  type: 'text'
  text: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => ToolTextBlock[]
  }
  execute: (args: unknown, exec: ToolExecContext) => Promise<unknown>
  presentCall?: (args: unknown) => Record<string, unknown>
}

/** The subset of the DSH tool execution context this plugin relies on. */
export interface ToolExecContext {
  agent?: {
    session?: {
      id?: string
      header?: { cwd?: string }
    }
  }
  signal?: AbortSignal
}

/** Names of the tools this plugin registers. */
export const TOOL_NAMES = ['memory_search', 'memory_get', 'memory_save', 'memory_forget'] as const

const TYPE_ENUM = [...MEMORY_TYPES]

/** Description text for the search tool. */
const SEARCH_DESCRIPTION = [
  'Search the user\'s durable local long-term memory vault (Markdown notes on this machine).',
  'Use it before asking the user to repeat a preference, decision, project state, or past lesson.',
  'Returns matching memories with their ids, categories, statuses, and relevance reasons.',
  'Only `active` memories are current fact; `stale`, `superseded`, `archived`, and `conflict` entries are historical.',
].join(' ')

const GET_DESCRIPTION =
  'Read one long-term memory in full by its id, including its evidence, change history, and related memories.'

const SAVE_DESCRIPTION = [
  'Record a durable fact about the user into their local long-term memory vault.',
  'Only call this for information the user actually stated and that is worth remembering across sessions',
  '(stable preferences, profile facts, decisions and their reasons, project state, lessons, open tasks).',
  'Do NOT record secrets (passwords, API keys, tokens), one-off chatter, or your own guesses.',
  'The memory is written as a Markdown note in the user\'s Obsidian vault and is immediately searchable.',
].join(' ')

const FORGET_DESCRIPTION = [
  'Retire a long-term memory that is no longer true, without destroying it.',
  'The note is archived with a recorded reason, so the fact that it once existed survives.',
  'Use `status: "stale"` when the information is outdated but not replaced, and `archived` when it should',
  'stop participating in recall.',
].join(' ')

/**
 * Build the four tool definitions bound to a service instance.
 *
 * Kept as a factory so the adapter can report exactly which tools were
 * registered, and so tests can call `execute` without a DSH host.
 */
export function buildToolDefinitions(service: MemoryService): ToolDefinition[] {
  return [
    {
      name: 'memory_search',
      description: SEARCH_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: 'Keywords, a project name, a technology, or a memory id. Empty returns the most important memories.',
          },
          type: {
            type: 'array',
            description: 'Restrict to these categories.',
            items: { type: 'string', enum: TYPE_ENUM },
          },
          status: {
            type: 'array',
            description: 'Restrict to these statuses. Defaults to active memories only.',
            items: { type: 'string', enum: [...MEMORY_STATUSES] },
          },
          tag: { type: 'string', description: 'Restrict to memories carrying this tag.' },
          limit: { type: 'integer', description: 'Maximum results (1-50, default 10).' },
          include_history: {
            type: 'boolean',
            description: 'Also consider retired memories. They are labelled as history, never as current fact.',
          },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'results'],
          properties: {
            count: { type: 'integer' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'title', 'type', 'status', 'summary'],
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  type: { type: 'string' },
                  status: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  summary: { type: 'string' },
                  reasons: { type: 'array', items: { type: 'string' } },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const payload = value as { count: number; results: { id: string; title: string; type: string; status: string; summary: string; reasons?: string[] }[] }
          if (payload.count === 0) {
            return [{ type: 'text', text: 'No long-term memory matched. The vault may be empty, or the query may be too specific.' }]
          }
          const lines = payload.results.map((entry) => {
            const label = TYPE_DESCRIPTORS[entry.type as MemoryType]?.labelZh ?? entry.type
            const reasons = entry.reasons !== undefined && entry.reasons.length > 0 ? ` (${entry.reasons.join('；')})` : ''
            return `- [${entry.id}] (${label}/${entry.status}) ${entry.title}${reasons}\n  ${entry.summary}`
          })
          return [{ type: 'text', text: `Found ${String(payload.count)} memories:\n${lines.join('\n')}` }]
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const query = typeof input['query'] === 'string' ? input['query'] : ''
        const types = stringArray(input['type'])
        const statuses = stringArray(input['status'])
        const tag = typeof input['tag'] === 'string' && input['tag'].length > 0 ? input['tag'] : undefined
        const limit = clampInt(input['limit'], 10, 1, 50)
        const includeHistory = input['include_history'] === true

        const response = service.search({
          text: query,
          limit,
          includeNonCurrent: includeHistory || (statuses !== undefined && statuses.some((status) => status !== 'active')),
          filters: {
            ...(types === undefined ? {} : { types }),
            ...(statuses === undefined
              ? includeHistory
                ? {}
                : { statuses: ['active'] }
              : { statuses }),
            ...(tag === undefined ? {} : { tags: [tag] }),
          },
        })

        return {
          count: response.hits.length,
          results: response.hits.map((hit) => ({
            id: hit.record.id,
            title: hit.record.title,
            type: hit.record.type,
            status: hit.record.status,
            tags: hit.record.tags,
            summary: hit.record.preview,
            reasons: hit.reasons,
            updatedAt: hit.record.updatedAt,
          })),
        }
      },
      presentCall: (args) => {
        const input = asRecord(args)
        return {
          card: 'generic',
          title: `Search long-term memory: ${typeof input['query'] === 'string' ? input['query'] : ''}`,
          kind: 'search',
          rawInput: input,
        }
      },
    },

    {
      name: 'memory_get',
      description: GET_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'The memory id, as returned by memory_search.' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'type', 'status', 'content', 'recallable'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            type: { type: 'string' },
            status: { type: 'string' },
            content: { type: 'string' },
            evidence: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            related: { type: 'array', items: { type: 'string' } },
            recallable: { type: 'boolean' },
            recallNote: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const payload = value as {
            id: string
            title: string
            type: string
            status: string
            content: string
            evidence: string
            recallable: boolean
            recallNote: string
          }
          return [
            {
              type: 'text',
              text: [
                `[${payload.id}] ${payload.title} (${payload.type}/${payload.status})`,
                payload.content,
                payload.evidence.length > 0 ? `Evidence:\n${payload.evidence}` : '',
                payload.recallable ? '' : `Note: ${payload.recallNote}`,
              ]
                .filter((part) => part.length > 0)
                .join('\n\n'),
            },
          ]
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const id = typeof input['id'] === 'string' ? input['id'].trim() : ''
        if (id.length === 0) throw new Error('memory_get requires a non-empty `id`')
        const response = await service.get(id)
        return {
          id: response.memory.id,
          title: response.memory.title,
          type: response.memory.type,
          status: response.memory.status,
          content: [response.memory.summary, ...response.memory.sections.map((section) => `## ${section.heading}\n${section.body}`)]
            .filter((part) => part.trim().length > 0)
            .join('\n\n'),
          evidence: response.memory.evidence,
          tags: response.memory.tags,
          related: response.relativePath.length > 0 ? response.related.map((hit) => hit.record.id) : [],
          recallable: response.recallable,
          recallNote: response.recallNote,
        }
      },
    },

    {
      name: 'memory_save',
      description: SAVE_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'A short, human title (one line).' },
          content: { type: 'string', description: 'The memory in natural language, in the user\'s own terms.' },
          type: {
            type: 'string',
            enum: TYPE_ENUM,
            description: 'profile | preference | project | project-state | decision | knowledge | experience | task',
          },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase tags.' },
          confidence: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'How strongly the user asserted this. Default: medium.',
          },
          importance: { type: 'integer', description: '0-100, how important this is to remember. Default: from the category.' },
          evidence: { type: 'string', description: 'What the user said that establishes this, quoted or paraphrased.' },
          pin: { type: 'boolean', description: 'Keep this memory in the standing system-prompt block.' },
        },
        required: ['title', 'content', 'type'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'created', 'status'],
          properties: {
            id: { type: 'string' },
            created: { type: 'boolean' },
            status: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const payload = value as { id: string; created: boolean; status: string; note?: string }
          return [
            {
              type: 'text',
              text: [
                payload.created
                  ? `Saved a new long-term memory: ${payload.id} (status: ${payload.status}).`
                  : `Updated long-term memory: ${payload.id} (status: ${payload.status}).`,
                payload.note ?? '',
              ]
                .filter((part) => part.length > 0)
                .join(' '),
            },
          ]
        },
      },
      execute: async (args, exec) => {
        const input = asRecord(args)
        const title = requireString(input['title'], 'title')
        const content = requireString(input['content'], 'content')
        const rawType = requireString(input['type'], 'type')
        if (!(MEMORY_TYPES as readonly string[]).includes(rawType)) {
          throw new Error(`memory_save: unknown type ${JSON.stringify(rawType)}; expected one of ${TYPE_ENUM.join(', ')}`)
        }
        const type = rawType as MemoryType

        // The same secret refusal the automatic extraction path applies, so the
        // model cannot route a credential past the policy by calling a tool.
        const findings = scanSecrets(`${title}\n${content}\n${typeof input['evidence'] === 'string' ? input['evidence'] : ''}`)
        if (findings.length > 0) {
          throw new Error(
            'memory_save refused: the content looks like a credential (API key, password, token, or private key). ' +
              'Secrets are never written to the long-term memory vault.',
          )
        }

        const confidenceRaw = typeof input['confidence'] === 'string' ? input['confidence'] : 'medium'
        const confidence = (['low', 'medium', 'high'] as const).includes(confidenceRaw as 'low')
          ? (confidenceRaw as 'low' | 'medium' | 'high')
          : 'medium'
        const tags = stringArray(input['tags']) ?? []
        const importance = clampInt(input['importance'], defaultToolImportance(type), 0, 100)
        const sessionId = exec.agent?.session?.id
        const cwd = exec.agent?.session?.header?.cwd

        // One status decision, used for BOTH persistence and the tool response.
        // Previously the response said `pending` for low confidence while the note
        // was written as `active`, so a low-confidence claim became current fact.
        const status: 'pending' | 'active' = confidence === 'low' ? 'pending' : 'active'

        const saved = await service.save({
          status,
          type,
          title,
          summary: content,
          tags,
          confidence,
          importance,
          pinned: input['pin'] === true,
          evidence:
            typeof input['evidence'] === 'string' && input['evidence'].trim().length > 0
              ? input['evidence'].trim()
              : `由模型在会话中记录${sessionId === undefined ? '' : `（会话 ${sessionId}${cwd === undefined ? '' : `，工作目录 ${cwd}`}）`}`,
          ...(sessionId === undefined ? {} : { sourceSessions: [sessionId] }),
          reason: '模型调用 memory_save 记录用户明确陈述的长期事实',
        })
        return {
          id: saved.id,
          created: saved.created,
          status,
          note:
            saved.warnings.length > 0
              ? saved.warnings.join('；')
              : status === 'pending'
                ? 'Low confidence: the note is waiting in the inbox and is not current fact until you confirm it.'
                : 'Only record what the user actually stated; the note is now searchable in the vault.',
        }
      },
      presentCall: (args) => {
        const input = asRecord(args)
        return {
          card: 'generic',
          title: `Remember: ${typeof input['title'] === 'string' ? input['title'] : ''}`,
          kind: 'other',
          rawInput: input,
        }
      },
    },

    {
      name: 'memory_forget',
      description: FORGET_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'The memory id to retire.' },
          reason: { type: 'string', description: 'Why it is no longer true or no longer wanted.' },
          status: {
            type: 'string',
            enum: ['archived', 'stale'],
            description: 'archived (stop using it) or stale (outdated but not replaced). Default: archived.',
          },
        },
        required: ['id', 'reason'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const payload = value as { id: string; status: string }
          return [{ type: 'text', text: `Retired ${payload.id} with status ${payload.status}. The note is kept in the vault's archive.` }]
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const id = requireString(input['id'], 'id')
        const reason = requireString(input['reason'], 'reason')
        const status = input['status'] === 'stale' ? 'stale' : 'archived'
        try {
          await service.setStatus(id, status, `模型调用 memory_forget：${reason}`)
        } catch (error) {
          if (error instanceof ServiceError) throw new Error(error.message)
          throw error
        }
        return { id, status, note: 'The memory is retained for traceability and will not be used as current fact.' }
      },
    },
  ]
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  return out.length === 0 ? undefined : out
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`\`${field}\` is required and must be a non-empty string`)
  }
  return value.trim()
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function defaultToolImportance(type: MemoryType): number {
  switch (type) {
    case 'profile':
      return 90
    case 'preference':
      return 80
    case 'decision':
      return 75
    case 'project':
      return 70
    case 'project-state':
      return 60
    case 'knowledge':
      return 55
    case 'experience':
      return 50
    case 'task':
      return 45
  }
}

/** The `ctx.tools` surface this plugin uses. */
export interface ToolRegistryLike {
  register: (definition: ToolDefinition) => unknown
}

/**
 * Register the memory tools on `ctx.tools`.
 *
 * @returns the tool names that registered, so the management page reports the
 *   truth rather than assuming the registration succeeded.
 */
export function installTools(ctx: { get: (name: string) => unknown; effect: (fn: () => unknown, label?: string) => unknown; logger?: { warn: (message: string, ...rest: unknown[]) => void } }, service: MemoryService): { registered: string[]; notes: Record<string, string> } {
  const notes: Record<string, string> = {}
  const tools = (ctx.get('tools') ?? null) as ToolRegistryLike | null
  if (tools === null || typeof tools.register !== 'function') {
    notes['tools'] = '宿主未提供 ctx.tools，模型无法主动调用记忆工具（自动提取与提示词注入不受影响）。'
    return { registered: [], notes }
  }
  const registered: string[] = []
  const definitions = buildToolDefinitions(service)
  ctx.effect(
    () => {
      const disposers: unknown[] = []
      for (const definition of definitions) {
        try {
          disposers.push(tools.register(definition))
          registered.push(definition.name)
        } catch (error) {
          notes[definition.name] = `注册工具 ${definition.name} 失败：${error instanceof Error ? error.message : String(error)}`
        }
      }
      return () => {
        for (const dispose of disposers) {
          if (typeof dispose === 'function') (dispose as () => void)()
        }
      }
    },
    'dsh-longterm-memory: model tools',
  )
  return { registered, notes }
}
