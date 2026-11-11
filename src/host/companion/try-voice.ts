/**
 * "Say one line" — the persona, actually executed once.
 *
 * Every persona editor has the same blind spot: the fields look reasonable and
 * still produce a voice nobody wants. The only reliable check is to spend one
 * model call and read the answer. Persona-building tools converge on this
 * (`Persona Crafter` ships a live preview; `Digital Twin Lab` is built entirely
 * around "see the prompt, see the result").
 *
 * The prompt here is **not** invented. It is built from `projectPersona` in
 * `shared/persona-projection.ts`, which mirrors the QQ runtime's real
 * `projectPersona` + `[伙伴规则]` section, including the character budget and
 * whole-layer cuts. A preview assembled from a different prompt would report a
 * voice the user does not actually have in QQ — worse than no preview at all.
 *
 * Two rules shape this module:
 *
 * 1. **The prompt is built from the saved documents, not from the draft.**
 * 2. **A model failure is data, not an exception** — see the route layer.
 *
 * @module dsh-longterm-memory/host/companion/try-voice
 */

import type { CompanionDocuments } from './documents.js'
import {
  PERSONA_BUDGET,
  buildPersonaContextSection,
  projectPersona,
  toProjectionInput,
} from '../../shared/persona-projection.js'
import type { PersonaProjection } from '../../shared/persona-projection.js'

/** Hard bounds on what one preview may send and show. */
export const VOICE_LIMITS = {
  /** Characters of the user's utterance accepted. */
  maxUtterance: 200,
  /** Characters of the model's reply kept. */
  maxReply: 600,
  /** Characters of the persona section sent to the model. */
  personaSection: PERSONA_BUDGET.contextSectionLimit,
} as const

/** Trimmed utterance, or an empty string when nothing usable was sent. */
export function normalizeUtterance(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, VOICE_LIMITS.maxUtterance)
}

export interface VoicePreview {
  /** The exact instruction sent to the model. */
  systemPrompt: string
  /** The projected persona, including which layers the budget removed. */
  projection: PersonaProjection
}

/**
 * Assemble the real persona section plus a minimal one-line output contract.
 *
 * The output contract is appended *after* the QQ section: it only constrains
 * the preview's presentation, not the persona itself, so it cannot alter which
 * persona layers survive the budget.
 */
export function buildVoicePreview(docs: CompanionDocuments): VoicePreview {
  const projection = projectPersona(toProjectionInput(docs), 'qq')
  const section = buildPersonaContextSection(projection)
  const systemPrompt = [
    section,
    '',
    '# 输出要求',
    '- 只输出这一句回复本身。',
    '- 不要解释，不要加引号，不要写旁白、动作或表情描写。',
    `- 不超过 ${String(VOICE_LIMITS.maxReply)} 字，通常一两句话就够。`,
    '- 不要提到你在扮演角色，也不要说自己是 AI 或模型。',
  ].join('\n')
  return { systemPrompt, projection }
}

/** Backwards-compatible helper: the instruction text for one preview reply. */
export function buildVoiceSystemPrompt(docs: CompanionDocuments): string {
  return buildVoicePreview(docs).systemPrompt
}

/** Remove one layer of wrapping quotes from a single line. */
function unquote(text: string): string {
  let out = text
  for (const [open, close] of [['"', '"'], ['“', '”'], ['「', '」'], ["'", "'"]] as const) {
    if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
      out = out.slice(open.length, out.length - close.length).trim()
    }
  }
  return out
}

/**
 * Clean a raw model answer down to the line a user would actually see.
 *
 * Models habitually wrap short answers in quotes or a fenced block even when
 * told not to, and sometimes append a "（以上是示例）" line afterwards. The
 * order here matters: pick the line first, *then* unquote it — unwrapping the
 * whole answer before splitting would miss the common case where the quotes
 * sit on line one but the trailing noise breaks the `endsWith` check.
 */
export function sanitizeReply(raw: string): string {
  let text = raw.trim()
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced !== null && fenced[1] !== undefined) text = fenced[1].trim()
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  const line = unquote(firstLine.length > 0 ? firstLine : unquote(text))
  return line.slice(0, VOICE_LIMITS.maxReply)
}
