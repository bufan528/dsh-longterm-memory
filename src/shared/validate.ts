/**
 * Metadata validation and normalisation.
 *
 * Every value that reaches the index passes through {@link normalizeMemory} or
 * {@link normalizeMeta}. Illegal values are repaired where the intent is
 * unambiguous and the memory is quarantined where it is not — a single bad note
 * must never be able to corrupt the whole index.
 *
 * @module dsh-longterm-memory/shared/validate
 */

import { z } from 'zod'
import {
  CONFIDENCE_LEVELS,
  FRONTMATTER_SCHEMA_VERSION,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  TYPE_DESCRIPTORS,
  type Confidence,
  type Memory,
  type MemoryMeta,
  type MemoryStatus,
  type MemoryType,
} from './types.js'
import { slugify } from './markdown.js'

export const memoryTypeSchema = z.enum(MEMORY_TYPES)
export const memoryStatusSchema = z.enum(MEMORY_STATUSES)
export const confidenceSchema = z.enum(CONFIDENCE_LEVELS)

/** A tag: lower-case, no spaces, no leading `#`. */
export const tagSchema = z
  .string()
  .min(1)
  .max(48)
  .transform((value) => value.trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase())
  .refine((value) => value.length > 0 && !/[\u0000-\u001f]/.test(value), 'tag is empty or contains control characters')

/** An ISO-8601 instant, normalised to UTC with a `Z` suffix. */
export const isoInstantSchema = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const parsed = normalizeInstant(value)
    if (parsed === null) {
      ctx.addIssue({ code: 'custom', message: `"${value}" is not a valid date-time` })
      return z.NEVER
    }
    return parsed
  })

export const memoryMetaSchema = z.object({
  id: z.string().min(1).max(120),
  type: memoryTypeSchema,
  status: memoryStatusSchema,
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
  title: z.string().min(1).max(300),
  tags: z.array(tagSchema).max(64),
  confidence: confidenceSchema,
  importance: z.number().int().min(0).max(100),
  pinned: z.boolean(),
  sourceSessions: z.array(z.string().min(1).max(200)).max(64),
  supersedes: z.array(z.string().min(1).max(120)).max(64),
  supersededBy: z.string().min(1).max(120).optional(),
  conflictsWith: z.array(z.string().min(1).max(120)).max(64),
  aliases: z.array(z.string().min(1).max(200)).max(32),
  evidence: z.string().max(4000),
  schemaVersion: z.number().int().min(1).max(1000),
})

export const memorySchema = memoryMetaSchema.extend({
  summary: z.string().max(20000),
  sections: z.array(z.object({ heading: z.string().min(1).max(200), body: z.string().max(20000) })).max(32),
  related: z.array(z.string().min(1).max(300)).max(64),
  extraFrontmatter: z.record(z.string(), z.unknown()).optional(),
  preservedBody: z.string().max(200000).optional(),
})

/** Outcome of normalising one parsed note. */
export type NormalizeResult =
  | { ok: true; memory: Memory; repairs: string[] }
  | { ok: false; reason: string }

/** Convert a possibly-lossy parsed note into a validated memory. */
export function normalizeMemory(input: unknown): NormalizeResult {
  const repairs: string[] = []
  const record = asRecord(input)
  if (record === null) return { ok: false, reason: 'document root is not an object' }

  const now = new Date().toISOString()
  const rawType = record['type']
  const type: MemoryType = isKnownType(rawType) ? rawType : 'knowledge'
  if (!isKnownType(rawType)) repairs.push(`unknown type ${JSON.stringify(rawType)} → "knowledge"`)

  const rawStatus = record['status']
  const status: MemoryStatus = isKnownStatus(rawStatus) ? rawStatus : 'pending'
  if (!isKnownStatus(rawStatus)) repairs.push(`unknown status ${JSON.stringify(rawStatus)} → "pending"`)

  const title = typeof record['title'] === 'string' && record['title'].trim().length > 0 ? record['title'].trim() : ''
  const id = typeof record['id'] === 'string' && record['id'].trim().length > 0 ? record['id'].trim() : ''
  if (id.length === 0) return { ok: false, reason: 'missing or empty `id`' }
  if (title.length === 0) repairs.push('missing title → derived from id')

  const createdAt = typeof record['createdAt'] === 'string' ? normalizeInstant(record['createdAt']) : null
  const updatedAt = typeof record['updatedAt'] === 'string' ? normalizeInstant(record['updatedAt']) : null
  if (createdAt === null) repairs.push('missing/invalid created_at → now')
  if (updatedAt === null) repairs.push('missing/invalid updated_at → created_at')

  const created = createdAt ?? now
  const updated = updatedAt ?? created

  const confidence: Confidence = isConfidence(record['confidence']) ? record['confidence'] : 'medium'
  if (!isConfidence(record['confidence'])) repairs.push(`invalid confidence → "medium"`)

  const importanceRaw = record['importance']
  const importance =
    typeof importanceRaw === 'number' && Number.isFinite(importanceRaw)
      ? Math.max(0, Math.min(100, Math.round(importanceRaw)))
      : defaultImportance(type)
  if (typeof importanceRaw !== 'number') repairs.push(`missing importance → ${String(importance)}`)

  const candidate: Record<string, unknown> = {
    id,
    type,
    status,
    createdAt: created,
    updatedAt: updated,
    title: title.length > 0 ? title : id,
    tags: normalizeTags(record['tags'], type),
    confidence,
    importance,
    pinned: record['pinned'] === true,
    sourceSessions: normalizeStringArray(record['sourceSessions'], 64),
    supersedes: normalizeStringArray(record['supersedes'], 64),
    conflictsWith: normalizeStringArray(record['conflictsWith'], 64),
    aliases: normalizeStringArray(record['aliases'], 32),
    evidence: typeof record['evidence'] === 'string' ? record['evidence'].slice(0, 4000) : '',
    schemaVersion:
      typeof record['schemaVersion'] === 'number' && Number.isFinite(record['schemaVersion'])
        ? Math.max(1, Math.round(record['schemaVersion']))
        : FRONTMATTER_SCHEMA_VERSION,
    summary: typeof record['summary'] === 'string' ? record['summary'].slice(0, 20000) : '',
    sections: normalizeSections(record['sections']),
    related: normalizeStringArray(record['related'], 64),
    ...(isPlainRecord(record['extraFrontmatter']) ? { extraFrontmatter: record['extraFrontmatter'] } : {}),
    ...(typeof record['preservedBody'] === 'string' ? { preservedBody: record['preservedBody'] } : {}),
  }
  const supersededBy = typeof record['supersededBy'] === 'string' ? record['supersededBy'].trim() : ''
  if (supersededBy.length > 0) candidate['supersededBy'] = supersededBy

  const parsed = memorySchema.safeParse(candidate)
  if (!parsed.success) {
    return { ok: false, reason: `metadata failed validation: ${formatIssues(parsed.error)}` }
  }
  return { ok: true, memory: parsed.data as Memory, repairs }
}

/** Validate only the metadata half; used when a caller does not need the body. */
export function normalizeMeta(input: unknown): { ok: true; meta: MemoryMeta; repairs: string[] } | { ok: false; reason: string } {
  const result = normalizeMemory({ summary: '', sections: [], related: [], ...asRecord(input) })
  if (!result.ok) return result
  const { summary: _summary, sections: _sections, related: _related, ...meta } = result.memory
  return { ok: true, meta, repairs: result.repairs }
}

/** Normalise a single instant to `YYYY-MM-DDTHH:MM:SS.sssZ`, or `null`. */
export function normalizeInstant(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  // Accept an Obsidian-native `YYYY-MM-DD HH:MM` as well as full ISO strings.
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00.000Z`
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}${trimmed.length <= 16 ? ':00' : ''}.000Z`
      : trimmed
  const ms = Date.parse(candidate)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Create a stable, unique, human-sortable memory id.
 *
 * Shape: `mem_<UTC compact instant>_<8 random hex>`. The instant sorts
 * chronologically and the suffix keeps collisions impossible in practice.
 */
export function newMemoryId(now: Date = new Date(), random: () => number = Math.random): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .toLowerCase()
  let suffix = ''
  for (let index = 0; index < 8; index += 1) {
    suffix += Math.floor(random() * 16).toString(16)
  }
  return `mem_${stamp}_${suffix}`
}

/** Ids must be safe to embed in a file name and in a `[[wikilink]]`. */
export function isSafeMemoryId(value: string): boolean {
  return /^mem_[a-z0-9]{8,20}t?[a-z0-9]{0,10}_[a-z0-9]{4,16}$/.test(value)
}

export function defaultImportance(type: MemoryType): number {
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

/** File name stem for a memory, always `<slug>-<id>.md` so ids survive renames. */
export function memoryFileName(memory: Pick<MemoryMeta, 'id' | 'title'>): string {
  return `${slugify(memory.title)}-${memory.id}.md`
}

/** Recognise whether a file looks like one of our memory notes. */
export function looksLikeMemoryId(stem: string): string | null {
  const match = /-(mem_[a-z0-9_]+)$/.exec(stem)
  return match !== null ? (match[1] ?? null) : null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isKnownType(value: unknown): value is MemoryType {
  return typeof value === 'string' && Object.hasOwn(TYPE_DESCRIPTORS, value)
}

function isKnownStatus(value: unknown): value is MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value)
}

function isConfidence(value: unknown): value is Confidence {
  return typeof value === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(value)
}

function normalizeTags(value: unknown, type: MemoryType): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const parsed = tagSchema.safeParse(entry)
    if (!parsed.success) continue
    if (seen.has(parsed.data)) continue
    seen.add(parsed.data)
    out.push(parsed.data)
    if (out.length >= 64) break
  }
  if (out.length === 0) out.push(TYPE_DESCRIPTORS[type].defaultTag)
  return out
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' && value.length > 0 ? [value] : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed.slice(0, 300))
    if (out.length >= limit) break
  }
  return out
}

function normalizeSections(value: unknown): { heading: string; body: string }[] {
  if (!Array.isArray(value)) return []
  const out: { heading: string; body: string }[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === null) continue
    const heading = typeof record['heading'] === 'string' ? record['heading'].trim() : ''
    const body = typeof record['body'] === 'string' ? record['body'] : ''
    if (heading.length === 0 || heading.length > 200) continue
    out.push({ heading, body: body.slice(0, 20000) })
    if (out.length >= 32) break
  }
  return out
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}
