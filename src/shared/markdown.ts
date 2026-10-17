/**
 * Markdown + YAML-frontmatter codec for memory notes.
 *
 * The Markdown file is the single source of truth. Everything here is pure and
 * byte-deterministic so that a file written by the plugin, edited by a human in
 * Obsidian, and re-read by the plugin round-trips without surprises.
 *
 * @module dsh-longterm-memory/shared/markdown
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  UnsafeMarkdownError,
  editFrontmatterSource,
  restoreDocumentStyle,
  joinFrontmatterSource,
  splitFrontmatterSource,
  type FrontmatterUpdates,
} from './frontmatter-edit.js'
import type { Memory, MemoryMeta, MemorySection } from './types.js'

/** Section headings the plugin owns; other sections are preserved verbatim. */
export const SECTION_SUMMARY = '核心内容'
export const SECTION_EVIDENCE = '来源与依据'
export const SECTION_RELATED = '相关记忆'

const FRONTMATTER_FENCE = '---'

export class FrontmatterError extends Error {
  readonly kind: 'no-frontmatter' | 'unterminated' | 'invalid-yaml' | 'not-an-object'

  constructor(kind: FrontmatterError['kind'], message: string) {
    super(message)
    this.name = 'FrontmatterError'
    this.kind = kind
  }
}

export interface ParsedDocument {
  meta: Record<string, unknown>
  body: string
}

/** Split a Markdown file into its frontmatter mapping and its body. */
export function splitFrontmatter(source: string): ParsedDocument {
  // Tolerate a UTF-8 BOM and CRLF, both of which Obsidian may write on Windows.
  let text = source.startsWith('\uFEFF') ? source.slice(1) : source
  text = text.replace(/\r\n/g, '\n')

  if (!text.startsWith(FRONTMATTER_FENCE)) {
    throw new FrontmatterError('no-frontmatter', 'document does not start with a `---` frontmatter fence')
  }
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd === -1 || text.slice(0, firstLineEnd).trim() !== FRONTMATTER_FENCE) {
    throw new FrontmatterError('no-frontmatter', 'document does not start with a `---` frontmatter fence')
  }
  const rest = text.slice(firstLineEnd + 1)
  // The closing fence must be a line that is exactly `---` (or `...`).
  const closeMatch = /^(?:---|\.\.\.)[ \t]*$/m.exec(rest)
  if (closeMatch === null || closeMatch.index === undefined) {
    throw new FrontmatterError('unterminated', 'frontmatter fence is never closed')
  }
  const yamlText = rest.slice(0, closeMatch.index)
  const body = rest.slice(closeMatch.index + closeMatch[0].length).replace(/^\n/, '')

  let parsed: unknown
  try {
    parsed = parseYaml(yamlText)
  } catch (error) {
    throw new FrontmatterError('invalid-yaml', `frontmatter is not valid YAML: ${describeError(error)}`)
  }
  if (parsed === null || parsed === undefined) return { meta: {}, body }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrontmatterError('not-an-object', 'frontmatter must be a YAML mapping')
  }
  return { meta: parsed as Record<string, unknown>, body }
}

/** Render frontmatter + body deterministically. */
export function joinFrontmatter(meta: Record<string, unknown>, body: string): string {
  const yamlText = stringifyYaml(meta, {
    // Stable, human-diffable output; no line wrapping so a long tag list stays one line.
    lineWidth: 0,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
    // Keep key order exactly as given rather than re-sorting.
    sortMapEntries: false,
  }).trimEnd()
  const normalizedBody = body.replace(/\r\n/g, '\n').replace(/^\n+/, '').trimEnd()
  return `${FRONTMATTER_FENCE}\n${yamlText}\n${FRONTMATTER_FENCE}\n\n${normalizedBody}\n`
}

/** Metadata keys the plugin writes, in a stable order. */
const META_KEY_ORDER: readonly string[] = [
  'id',
  'type',
  'status',
  'title',
  'created_at',
  'updated_at',
  'tags',
  'confidence',
  'importance',
  'pinned',
  'source_sessions',
  'aliases',
  'supersedes',
  'superseded_by',
  'conflicts_with',
  'evidence',
  'schema_version',
]

/** Project a validated memory meta into the on-disk snake_case frontmatter mapping. */
export function metaToFrontmatter(meta: MemoryMeta): Record<string, unknown> {
  const all: Record<string, unknown> = {
    id: meta.id,
    type: meta.type,
    status: meta.status,
    title: meta.title,
    created_at: meta.createdAt,
    updated_at: meta.updatedAt,
    tags: [...meta.tags],
    confidence: meta.confidence,
    importance: meta.importance,
    pinned: meta.pinned,
    source_sessions: [...meta.sourceSessions],
    aliases: [...meta.aliases],
    supersedes: [...meta.supersedes],
    superseded_by: meta.supersededBy ?? null,
    conflicts_with: [...meta.conflictsWith],
    evidence: meta.evidence,
    schema_version: meta.schemaVersion,
  }
  const ordered: Record<string, unknown> = {}
  for (const key of META_KEY_ORDER) {
    const value = all[key]
    // Drop empty collections and null scalars: a sparse note is easier to read and diff.
    if (Array.isArray(value) && value.length === 0) continue
    if (value === null) continue
    if (typeof value === 'string' && value.length === 0) continue
    ordered[key] = value
  }
  return ordered
}

/** Turn one frontmatter mapping back into the camelCase metadata shape (before validation). */
export function frontmatterToMetaRaw(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const read = (...names: string[]): unknown => {
    for (const name of names) {
      if (Object.hasOwn(frontmatter, name)) return frontmatter[name]
    }
    return undefined
  }
  return {
    id: read('id'),
    type: read('type'),
    status: read('status'),
    title: read('title'),
    createdAt: read('created_at', 'createdAt'),
    updatedAt: read('updated_at', 'updatedAt'),
    tags: read('tags'),
    confidence: read('confidence'),
    importance: read('importance'),
    pinned: read('pinned'),
    sourceSessions: read('source_sessions', 'sourceSessions'),
    aliases: read('aliases'),
    supersedes: read('supersedes'),
    supersededBy: read('superseded_by', 'supersededBy'),
    conflictsWith: read('conflicts_with', 'conflictsWith'),
    evidence: read('evidence'),
    schemaVersion: read('schema_version', 'schemaVersion'),
  }
}

/** Extract `[[wikilink]]` targets from a body. */
export function extractWikilinks(body: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    const target = (match[1] ?? '').trim()
    if (target.length === 0) continue
    if (seen.has(target)) continue
    seen.add(target)
    found.push(target)
  }
  return found
}

/**
 * Parse a memory body into the summary plus any extra sections.
 *
 * The plugin writes `## 核心内容`, `## 来源与依据` and `## 相关记忆`; a human may add
 * any further `## …` sections, which are preserved as-is.
 */
export function parseBody(body: string): { summary: string; sections: MemorySection[]; related: string[] } {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const sections: MemorySection[] = []
  let current: { heading: string; lines: string[] } | null = null
  const preamble: string[] = []

  for (const line of lines) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line)
    const h1 = /^#[ \t]+(.+?)[ \t]*$/.exec(line)
    if (heading !== null) {
      if (current !== null) sections.push({ heading: current.heading, body: current.lines.join('\n').trim() })
      current = { heading: (heading[1] ?? '').trim(), lines: [] }
      continue
    }
    if (h1 !== null) continue // the H1 is the title and is re-rendered from metadata
    if (current === null) preamble.push(line)
    else current.lines.push(line)
  }
  if (current !== null) sections.push({ heading: current.heading, body: current.lines.join('\n').trim() })

  const summaryParts = preamble.join('\n').trim()
  const summarySection = sections.find((section) => section.heading === SECTION_SUMMARY)
  const summary = summarySection !== undefined ? summarySection.body : summaryParts
  const extra = sections.filter(
    (section) => section.heading !== SECTION_SUMMARY && section.heading !== SECTION_RELATED,
  )
  const evidenceSection = sections.find((section) => section.heading === SECTION_EVIDENCE)
  const relatedSection = sections.find((section) => section.heading === SECTION_RELATED)
  const related =
    relatedSection !== undefined
      ? extractWikilinks(relatedSection.body)
      : extractWikilinks(body)
  return {
    summary,
    sections: evidenceSection !== undefined && evidenceSection.body.length > 0
      ? extra.filter((section) => section.heading !== SECTION_EVIDENCE)
      : extra,
    related,
  }
}

/**
 * Frontmatter keys this plugin owns. Any other key belongs to the user and is
 * preserved verbatim across every write.
 */
const KNOWN_FRONTMATTER_KEYS = new Set([
  'id', 'type', 'status', 'title', 'created_at', 'createdat', 'updated_at', 'updatedat',
  'tags', 'confidence', 'importance', 'pinned', 'source_sessions', 'sourcesessions',
  'aliases', 'supersedes', 'superseded_by', 'supersededby', 'conflicts_with',
  'conflictswith', 'evidence', 'schema_version', 'schemaversion',
])

/** Split frontmatter into the keys this plugin owns and the keys it must keep. */
export function splitUnknownFrontmatter(meta: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (KNOWN_FRONTMATTER_KEYS.has(key.toLowerCase())) continue
    extra[key] = value
  }
  return extra
}

/** Merge the plugin-owned projection with preserved unknown keys, keeping their order. */
function withExtraFrontmatter(owned: Record<string, unknown>, memory: Memory): Record<string, unknown> {
  const extra = memory.extraFrontmatter
  if (extra === undefined || Object.keys(extra).length === 0) return owned
  const merged: Record<string, unknown> = { ...owned }
  for (const [key, value] of Object.entries(extra)) {
    if (Object.hasOwn(merged, key)) continue
    merged[key] = value
  }
  return merged
}

/**
 * Rewrite only the sections this plugin owns, leaving every other line byte-for-byte
 * as the user left it.
 *
 * The plugin owns the H1 title and the three named sections (`核心内容`,
 * `来源与依据`, `相关记忆`). Everything else — unknown `##` sections, block quotes,
 * custom markers, stray paragraphs, blank lines — is copied through untouched, in
 * its original order. This is what makes "edit one field, keep my notes" true.
 *
 * Frontmatter *comments* cannot survive: YAML is parsed and re-emitted. Body
 * comments and unknown keys do survive.
 */
export function spliceBody(preserved: string, memory: Memory): string {
  const lines = preserved.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let sawTitle = false
  let sawSummary = false
  let sawEvidence = false
  let sawRelated = false
  const relatedLines =
    memory.related.length === 0 ? ['（暂无）'] : memory.related.map((target) => `- [[${target}]]`)

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const h1 = /^#[ \t]+(.+?)[ \t]*$/.exec(line)
    if (h1 !== null) {
      out.push(`# ${memory.title}`)
      sawTitle = true
      index += 1
      continue
    }
    const h2 = /^##[ \t]+(.+?)[ \t]*$/.exec(line)
    if (h2 === null) {
      out.push(line)
      index += 1
      continue
    }
    const heading = (h2[1] ?? '').trim()
    let end = index + 1
    while (end < lines.length && !/^#{1,2}[ \t]+/.test(lines[end] ?? '')) end += 1
    // Preserve the section's own trailing blank-line count so re-rendering an
    // edited section does not reflow the rest of the document.
    let trailingBlanks = 0
    for (let probe = end - 1; probe >= index + 1; probe -= 1) {
      if ((lines[probe] ?? '').trim() !== '') break
      trailingBlanks += 1
    }
    const tail: string[] = Array<string>(Math.max(1, trailingBlanks)).fill('')
    if (heading === SECTION_SUMMARY) {
      out.push(line, '', memory.summary.trim(), ...tail)
      sawSummary = true
    } else if (heading === SECTION_EVIDENCE) {
      out.push(line, '', memory.evidence.trim().length > 0 ? memory.evidence.trim() : '（暂无可追溯来源）', ...tail)
      sawEvidence = true
    } else if (heading === SECTION_RELATED) {
      out.push(line, '', ...relatedLines, ...tail)
      sawRelated = true
    } else {
      // A section the plugin does not own: copy the heading and its body verbatim.
      for (let copy = index; copy < end; copy += 1) {
        const source = lines[copy]
        if (source !== undefined) out.push(source)
      }
    }
    index = end
  }

  if (!sawTitle) out.unshift(`# ${memory.title}`, '')
  if (!sawSummary) out.push('', `## ${SECTION_SUMMARY}`, '', memory.summary.trim(), '')
  if (!sawEvidence) {
    out.push('', `## ${SECTION_EVIDENCE}`, '', memory.evidence.trim().length > 0 ? memory.evidence.trim() : '（暂无可追溯来源）', '')
  }
  if (!sawRelated) out.push('', `## ${SECTION_RELATED}`, '', ...relatedLines, '')
  return out.join('\n').trimEnd()
}
/**
 * Render a note for a direct raw-Markdown edit: canonicalise the plugin-owned
 * frontmatter, but keep the user's body byte-for-byte.
 *
 * `renderMemory` regenerates the plugin-owned sections, which would silently drop
 * edits a user made *inside* those sections (e.g. appending a line after
 * "## 相关记忆"). Direct source editing must not lose user text.
 */
export function renderMemoryPreservingBody(memory: Memory): string {
  if (memory.preservedSource === undefined) return renderMemory(memory)
  const edited = editFrontmatterSource(memory.preservedSource, ownedFrontmatterUpdates(memory))
  if (!edited.ok) throw new UnsafeMarkdownError(edited.reason)
  const split = splitFrontmatterSource(edited.source)
  if (split === null) throw new UnsafeMarkdownError('无法解析 frontmatter 的边界，拒绝覆盖该文件。')
  return restoreDocumentStyle(joinFrontmatterSource(split.frontmatter, split.body), memory.preservedSource)
}
/** Render a complete memory note. */
/** Build the frontmatter updates the plugin owns, from the memory projection. */
function ownedFrontmatterUpdates(memory: Memory): FrontmatterUpdates {
  return {
    scalars: {
      id: memory.id,
      type: memory.type,
      status: memory.status,
      title: memory.title,
      created_at: memory.createdAt,
      updated_at: memory.updatedAt,
      confidence: memory.confidence,
      importance: memory.importance,
      pinned: memory.pinned,
      superseded_by: memory.supersededBy ?? null,
      evidence: memory.evidence,
      schema_version: memory.schemaVersion,
    },
    arrays: {
      tags: memory.tags,
      aliases: memory.aliases,
      source_sessions: memory.sourceSessions,
      supersedes: memory.supersedes,
      conflicts_with: memory.conflictsWith,
    },
  }
}

export function renderMemory(memory: Memory): string {
  // Source-text path: edit only the plugin-owned fields, then splice only the
  // plugin-owned sections. Everything else stays byte-for-byte as the user left it.
  if (memory.preservedSource !== undefined) {
    const edited = editFrontmatterSource(memory.preservedSource, ownedFrontmatterUpdates(memory))
    if (!edited.ok) throw new UnsafeMarkdownError(edited.reason)
    const split = splitFrontmatterSource(edited.source)
    if (split === null) throw new UnsafeMarkdownError('无法解析 frontmatter 的边界，拒绝覆盖该文件。')
    return restoreDocumentStyle(joinFrontmatterSource(split.frontmatter, spliceBody(split.body, memory)), memory.preservedSource)
  }
  const bodyParts: string[] = [`# ${memory.title}`, '', `## ${SECTION_SUMMARY}`, '', memory.summary.trim(), '']

  for (const section of memory.sections) {
    if (section.body.trim().length === 0) continue
    bodyParts.push(`## ${section.heading}`, '', section.body.trim(), '')
  }

  bodyParts.push(`## ${SECTION_EVIDENCE}`, '', memory.evidence.trim().length > 0 ? memory.evidence.trim() : '（暂无可追溯来源）', '')

  bodyParts.push(`## ${SECTION_RELATED}`, '')
  if (memory.related.length === 0) bodyParts.push('（暂无）')
  else for (const target of memory.related) bodyParts.push(`- [[${target}]]`)
  bodyParts.push('')

  const frontmatter = withExtraFrontmatter(metaToFrontmatter(memory), memory)
  const body = memory.preservedBody === undefined ? bodyParts.join('\n') : spliceBody(memory.preservedBody, memory)
  return joinFrontmatter(frontmatter, body)
}

/**
 * The result of reading a memory note: a flat, unvalidated input for
 * `normalizeMemory` plus the body for callers that need it verbatim.
 */
export interface ParsedMemory {
  /**
   * Flat candidate input: the frontmatter fields in camelCase plus `title`,
   * `summary`, `sections`, and `related`. Feed this straight to
   * `normalizeMemory`, which repairs or quarantines anything unusable.
   */
  raw: Record<string, unknown>
  /** The H1 title, falling back to the frontmatter `title`. */
  title: string
  /** The document body exactly as read. */
  body: string
  /** Frontmatter keys the plugin does not own; preserved across writes. */
  unknownFrontmatter: Record<string, unknown>
}

/** Parse a complete memory note into a flat, unvalidated memory input. */
export function parseMemoryDocument(source: string): ParsedMemory {
  const { meta, body } = splitFrontmatter(source)
  const rawMeta = frontmatterToMetaRaw(meta)
  const h1 = /^#[ \t]+(.+?)[ \t]*$/m.exec(body)
  const parsed = parseBody(body)
  const h1Title = h1 !== null ? (h1[1] ?? '').trim() : ''
  const declaredTitle = typeof rawMeta['title'] === 'string' ? rawMeta['title'].trim() : ''
  const title = declaredTitle.length > 0 ? declaredTitle : h1Title

  return {
    unknownFrontmatter: splitUnknownFrontmatter(meta),
    raw: {
      ...rawMeta,
      title,
      summary: parsed.summary,
      sections: parsed.sections,
      related: parsed.related,
    },
    title,
    body,
  }
}

/** Windows-reserved device names that must never be used as a file stem. */
const RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/**
 * Build a filesystem-safe file stem from a title.
 *
 * Non-ASCII (CJK) characters are preserved because the vault is meant to be read
 * by the user; only characters that are illegal on Windows or that confuse
 * Obsidian's link parser are replaced.
 */
export function slugify(title: string, fallback = 'memory'): string {
  let stem = title
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/-{2,}/g, '-')
    // A title made only of illegal characters collapses to dashes; trim them so
    // the fallback below can take over.
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .trim()

  if (stem.length > 80) stem = stem.slice(0, 80).trim()
  if (stem.length === 0) stem = fallback
  if (RESERVED_STEMS.has(stem.toLowerCase())) stem = `${stem}-note`
  return stem
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
