/**
 * One search/overview result row.
 *
 * Shared by the overview lists and the search results so the relevance
 * explanation (`hit.reasons`, which the product requires) is rendered in exactly
 * one place.
 *
 * @module dsh-longterm-memory/client/views/hit-row
 */

import type { ReactElement } from 'react'

import type { WireHit } from '../../shared/protocol.js'
import { useT } from '../i18n.js'
import { Badge, MemoryRow } from '../ui.js'
import { confidenceKind, formatTime, shortId, statusKind, statusLabel, typeLabel } from '../util.js'

/** Render one wire hit. */
export function HitRow(props: {
  hit: WireHit
  onOpen?: () => void
  onToggleSelect?: () => void
  selected?: boolean
}): ReactElement {
  const translate = useT()
  const record = props.hit.record
  return (
    <MemoryRow
      id={record.id}
      title={record.title}
      preview={record.preview}
      selected={props.selected}
      onOpen={props.onOpen}
      onToggleSelect={props.onToggleSelect}
      badges={
        <>
          <Badge kind="brand">{typeLabel(record.type)}</Badge>
          <Badge kind={statusKind(record.status)}>{statusLabel(record.status)}</Badge>
          {record.pinned ? <Badge kind="warn">{translate('detail.pinned')}</Badge> : null}
          <Badge kind={confidenceKind(record.confidence)}>{record.confidence}</Badge>
          <span>{formatTime(record.updatedAt)}</span>
          <span>
            {translate('search.score')}: <span className="lmv-mono">{String(props.hit.score)}</span>
          </span>
          <span className="lmv-mono">{shortId(record.id, 26)}</span>
        </>
      }
      reasons={props.hit.reasons}
    />
  )
}
