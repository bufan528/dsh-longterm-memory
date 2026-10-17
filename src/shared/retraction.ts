/**
 * Retraction notices for memories that were injected earlier in a session.
 *
 * A plugin cannot rewrite session history: once a recall block has been sent to the
 * model it is part of the durable conversation and there is no supported way to
 * edit or delete it. Claiming otherwise would be false.
 *
 * What *is* supported is appending. So when a previously injected memory is no
 * longer current (archived, superseded, conflicting, stale, or its file deleted),
 * the next step appends a short, explicit notice naming the affected ids and their
 * current state. The old copy stays in history — visibly, honestly — and the model
 * is told which source wins.
 *
 * @module dsh-longterm-memory/shared/retraction
 */

import { FENCE_CLOSE, FENCE_OPEN } from './recall.js'

/** One previously-injected memory that is no longer current fact. */
export interface RetiredMemory {
  id: string
  status: string
}

/** Human label for a memory status, in the language of the product UI. */
export function statusLabel(status: string): string {
  switch (status) {
    case 'archived':
      return '已归档'
    case 'superseded':
      return '已被替代'
    case 'conflict':
      return '存在冲突待裁决'
    case 'stale':
      return '已过时'
    case 'missing':
      return '文件已不存在'
    default:
      return status
  }
}

/**
 * Render the notice that retires earlier injected content.
 *
 * The fence matches the recall block's fence so the model can tell this apart from
 * ordinary user text, and the wording states the precedence rule explicitly.
 */
export function renderRetiredNotice(entries: readonly RetiredMemory[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map((entry) => `- ${entry.id}（当前状态：${statusLabel(entry.status)}）`)
  return [
    FENCE_OPEN,
    '以下记忆此前在本会话中被检索注入过，但现在已不是当前有效事实。',
    '请勿再把这些内容当作当前事实；它们可能已被归档、被替代、存在冲突或已被删除。',
    '如果本通知与先前的记忆块冲突，以本通知为准。',
    '',
    ...lines,
    FENCE_CLOSE,
  ].join('\n')
}
