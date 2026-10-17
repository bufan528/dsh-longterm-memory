/**
 * Small presentation helpers shared by the views.
 *
 * Everything here is pure and token-free: labels come from
 * {@link TYPE_DESCRIPTORS} plus the local dictionary, never from a hardcoded
 * palette or a markdown library.
 *
 * @module dsh-longterm-memory/client/util
 */

import {
  CONFIDENCE_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  TYPE_DESCRIPTORS,
  isMemoryStatus,
  isMemoryType,
} from '../shared/types.js'
import type { CandidateDecision, MemoryStatus, MemoryType } from '../shared/types.js'
import { getLanguage, t } from './i18n.js'

/** How a badge should be coloured. */
export type BadgeKind = 'plain' | 'ok' | 'warn' | 'error' | 'brand'

/** Format an ISO instant for display, or the dictionary's "never" for an empty value. */
export function formatTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return t('common.never')
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return iso
  const date = new Date(parsed)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The human label of a memory category, in the active language. */
export function typeLabel(type: string): string {
  if (!isMemoryType(type)) return type
  const descriptor = TYPE_DESCRIPTORS[type]
  return getLanguage() === 'en' ? descriptor.labelEn : descriptor.labelZh
}

/** The human label of a memory status. */
export function statusLabel(status: string): string {
  if (!isMemoryStatus(status)) return status
  return t(`status.${status}`)
}

/** The human label of a confidence level. */
export function confidenceLabel(value: string): string {
  const known = (CONFIDENCE_LEVELS as readonly string[]).includes(value)
  return known ? t(`confidence.${value}`) : value
}

/** The badge colour a status deserves. */
export function statusKind(status: string): BadgeKind {
  if (status === 'active') return 'ok'
  if (status === 'pending') return 'brand'
  if (status === 'stale' || status === 'superseded') return 'warn'
  if (status === 'conflict') return 'error'
  return 'plain'
}

/** The badge colour a confidence level deserves. */
export function confidenceKind(value: string): BadgeKind {
  if (value === 'high') return 'ok'
  if (value === 'medium') return 'plain'
  if (value === 'low') return 'warn'
  return 'plain'
}

/** Split a comma/、-separated user string into a de-duplicated tag list. */
export function splitList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[,，、]/)) {
    const trimmed = part.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Render a tag list back into the comma-separated form the editors use. */
export function joinList(values: readonly string[]): string {
  return values.join(', ')
}

/** Clamp a user-typed importance into the 0-100 integer range. */
export function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return 50
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** The category list, for filter chips and editors. */
export const ALL_TYPES: readonly MemoryType[] = MEMORY_TYPES

/** The status list, for filter chips and editors. */
export const ALL_STATUSES: readonly MemoryStatus[] = MEMORY_STATUSES

/** One line describing what the extractor proposed for a candidate. */
export function decisionLabel(decision: CandidateDecision): string {
  switch (decision.action) {
    case 'create':
      return t('inbox.decision.create')
    case 'update':
      return t('inbox.decision.update', { id: decision.targetId })
    case 'merge':
      return t('inbox.decision.merge', { ids: decision.targetIds.join(', ') })
    case 'conflict':
      return t('inbox.decision.conflict', { id: decision.targetId })
    default:
      return t('inbox.decision.inbox')
  }
}

/** Shorten a long id or path for a badge without hiding its tail. */
export function shortId(id: string, max = 22): string {
  if (id.length <= max) return id
  return `${id.slice(0, max - 1)}…`
}
