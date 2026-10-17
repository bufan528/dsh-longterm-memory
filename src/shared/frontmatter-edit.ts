/**
 * Source-text-level frontmatter editing.
 *
 * Re-serializing a whole note cannot preserve what it did not model: YAML
 * comments, key order, quoting style, empty values and unusual indentation all
 * vanish. So writes to plugin-owned fields do **not** rebuild the frontmatter.
 * Instead this module locates the exact lines of the fields being changed and
 * replaces only those, leaving every other line byte-for-byte identical.
 *
 * When the field's boundaries cannot be determined safely (a duplicate key, an
 * unterminated document, an unrecognised continuation inside a scalar), the edit
 * is **refused** rather than guessed. Refusing is always better than silently
 * dropping something the user wrote.
 *
 * @module shared/frontmatter-edit
 */

/** Raised when a note cannot be edited without risking the user's content. */
export class UnsafeMarkdownError extends Error {
  readonly code = 'unsafe-edit'

  constructor(reason: string) {
    super(reason)
    this.name = 'UnsafeMarkdownError'
  }
}

/** One top-level frontmatter entry: its key and its raw lines (key line first). */
interface FrontmatterEntry {
  key: string | null
  lines: string[]
}

export interface FrontmatterUpdates {
  /** Single-value fields. `null` renders as an empty value. */
  scalars?: Record<string, string | number | boolean | null>
  /** List fields rendered as block sequences. */
  arrays?: Record<string, readonly string[]>
}

/** Split a document into frontmatter body lines and the remaining text. */
export function splitFrontmatterSource(source: string): { frontmatter: string[]; body: string } | null {
  // A UTF-8 BOM may precede the opening fence; it must not prevent editing and is
  // restored when the document is written back.
  const withoutBom = source.startsWith('\uFEFF') ? source.slice(1) : source
  const normalized = withoutBom.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if ((lines[0] ?? '').trim() !== '---') return null
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    // The closing fence must start at column 0. A YAML block scalar legitimately
    // contains indented lines such as `  ---`; trimming would truncate user data.
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index] ?? '')) {
      closing = index
      break
    }
  }
  if (closing === -1) return null
  return {
    frontmatter: lines.slice(1, closing),
    body: lines.slice(closing + 1).join('\n'),
  }
}

/** Restore the original document's BOM / EOL style after a local edit. */
export function restoreDocumentStyle(text: string, source: string): string {
  let out = text
  if (source.includes('\r\n')) out = out.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  const hadBom = source.startsWith('\uFEFF')
  const hasBom = out.startsWith('\uFEFF')
  if (hadBom && !hasBom) out = `\uFEFF${out}`
  if (!hadBom && hasBom) out = out.slice(1)
  return out
}

/** Rebuild a document from frontmatter lines and body text. */
export function joinFrontmatterSource(frontmatter: readonly string[], body: string): string {
  // `body` already carries the newlines that followed the closing delimiter, so
  // joining keeps the document byte-identical (no blank line added or removed).
  return ['---', ...frontmatter, '---', body].join('\n')
}

/** A YAML scalar that round-trips: bare where safe, single-quoted otherwise. */
function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value.length === 0) return "''"
  // Multi-line / control characters must survive the round-trip. YAML cannot express
  // them in a plain scalar, and flattening them to spaces silently loses lines; a
  // double-quoted scalar with escapes is lossless and stays on one line.
  if (/[\r\n\t]/.test(value)) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
    return `"${escaped}"`
  }
  // Values that YAML treats as syntax must be quoted: indicators at the start
  // (`- `, `? `, `: `), indicator characters anywhere, and scalar-like words.
  const needsQuoting =
    /^[\s]|[\s]$/.test(value) ||
    /[:#{}[\],&*?|<>=!%@`"']/.test(value) ||
    /^[-?:](?:\s|$)/.test(value) ||
    /^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/i.test(value)
  return needsQuoting ? `'${value.replace(/'/g, "''")}'` : value
}

/** Group frontmatter lines into top-level entries, keeping comments attached in place. */
function entriesOf(frontmatter: readonly string[]): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = []
  let current: FrontmatterEntry = { key: null, lines: [] }
  for (const line of frontmatter) {
    // YAML keys are arbitrary Unicode; CJK keys must not be mistaken for continuation lines.
    const match = /^([^\s:#][^:]*?):[ \t]*(.*)$/.exec(line)
    if (match !== null) {
      if (current.lines.length > 0) entries.push(current)
      current = { key: match[1] ?? null, lines: [line] }
      continue
    }
    current.lines.push(line)
  }
  if (current.lines.length > 0) entries.push(current)
  return entries
}

/** Compare a YAML scalar by value, so a quoted value is not rewritten merely to
 * drop its quotes (that would be an unrelated change to the user's file). */
function normalizeScalarText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if (first === last && (first === "'" || first === '"')) {
      const inner = trimmed.slice(1, -1)
      return first === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\"/g, '"')
    }
  }
  return trimmed
}

const isComment = (line: string): boolean => /^\s*#/.test(line)
const isBlank = (line: string): boolean => line.trim().length === 0
const isSequenceItem = (line: string): boolean => /^\s*-\s|^\s*-$/.test(line)


/**
 * Apply updates to a document's frontmatter without reformatting anything else.
 *
 * Only the lines of the fields actually being changed are rewritten. Unknown
 * fields, comments, blank lines, ordering and quoting of untouched values are
 * preserved exactly.
 *
 * @returns the new document, or a reason why the edit would be unsafe.
 */
export function editFrontmatterSource(
  source: string,
  updates: FrontmatterUpdates,
): { ok: true; source: string } | { ok: false; reason: string } {
  const split = splitFrontmatterSource(source)
  if (split === null) {
    return {
      ok: false,
      reason: '无法确定 frontmatter 的边界（缺少开头或结尾的 --- 分隔线），为避免破坏正文，拒绝覆盖该文件。',
    }
  }

  const entries = entriesOf(split.frontmatter)
  const ownedKeys = [...Object.keys(updates.scalars ?? {}), ...Object.keys(updates.arrays ?? {})]
  for (const key of ownedKeys) {
    const matches = entries.filter((entry) => entry.key === key)
    if (matches.length > 1) {
      return {
        ok: false,
        reason: `frontmatter 中存在重复的键 "${key}"，无法确定应更新哪一处，拒绝覆盖该文件。请先手工修正重复键。`,
      }
    }
  }

  const replacements = new Map<FrontmatterEntry, string[]>()
  const insertions: string[] = []

  for (const [key, value] of Object.entries(updates.scalars ?? {})) {
    const entry = entries.find((candidate) => candidate.key === key)
    const rendered = `${key}: ${yamlScalar(value)}`.trimEnd()
    if (entry === undefined) {
      insertions.push(rendered)
      continue
    }
    const extras = entry.lines.slice(1)
    const continuation = extras.filter((line) => !isComment(line) && !isBlank(line))
    if (continuation.length > 0) {
      return {
        ok: false,
        reason: `字段 "${key}" 的值跨越多行，无法在不丢失内容的前提下就地更新，拒绝覆盖该文件。`,
      }
    }
    // Split the existing line into its value and its trailing `# comment`, so a
    // rewrite replaces the value and keeps the user's comment in place.
    const original = entry.lines[0] ?? ''
    const rawValue = /^[A-Za-z0-9_.-]+:(.*)$/.exec(original)?.[1] ?? ''
    const valueOnly = rawValue.replace(/\s+#.*$/, '')
    const trailingComment = rawValue.slice(valueOnly.length)
    const renderedValue = yamlScalar(value)
    // Unchanged value: leave the line byte-for-byte as the user wrote it.
    if (normalizeScalarText(valueOnly) === normalizeScalarText(renderedValue)) continue
    replacements.set(entry, [`${key}: ${renderedValue}${trailingComment}`, ...extras])
  }

  for (const [key, values] of Object.entries(updates.arrays ?? {})) {
    const entry = entries.find((candidate) => candidate.key === key)
    const rendered = [`${key}:`, ...values.map((value) => `  - ${yamlScalar(value)}`)]
    if (entry === undefined) {
      insertions.push(...rendered)
      continue
    }
    const extras = entry.lines.slice(1)
    // Comments are positional, not part of the value: keep them after the rebuilt list.
    const comments = extras.filter(isComment)
    const body = extras.filter((line) => !isBlank(line) && !isComment(line))
    const shaped = body.length === 0 || body.every(isSequenceItem)
    if (!shaped) {
      return {
        ok: false,
        reason: `字段 "${key}" 的现有内容不是标准列表，无法安全替换，拒绝覆盖该文件。`,
      }
    }
    replacements.set(entry, [...rendered, ...comments])
  }

  // New plugin-owned keys go to the top: appending after a trailing unknown block
  // scalar would terminate it and corrupt user content.
  const output: string[] = [...insertions]
  for (const entry of entries) {
    const replacement = replacements.get(entry)
    if (replacement === undefined) {
      output.push(...entry.lines)
      continue
    }
    output.push(...replacement)
  }

  return { ok: true, source: restoreDocumentStyle(joinFrontmatterSource(output, split.body), source) }
}
