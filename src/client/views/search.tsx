/**
 * Search (记忆检索): the debounced query, every filter the model exposes, and the
 * relevance explanation that makes a keyword index trustworthy.
 *
 * @module dsh-longterm-memory/client/views/search
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import type { SearchRequest } from '../../shared/protocol.js'
import type { QueryFilters } from '../../shared/search.js'
import { MEMORY_STATUSES, MEMORY_TYPES } from '../../shared/types.js'
import type { MemoryStatus, MemoryType } from '../../shared/types.js'
import { call, useAsync, useDebounced } from '../api.js'
import { useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import { Button, Card, Checkbox, Empty, EnumChips, ErrorNotice, Field, Loading, NumberInput, TextInput } from '../ui.js'
import { statusLabel, typeLabel } from '../util.js'
import { HitRow } from './hit-row.js'
import { MergeDialog } from './merge.js'

/** Render the search pane. */
export function SearchView(props: { tag: string; onTagChange: (tag: string) => void }): ReactElement {
  const page = usePage()
  const translate = useT()

  const [text, setText] = useState('')
  const debounced = useDebounced(text, 250)
  const [types, setTypes] = useState<readonly MemoryType[]>([])
  const [statuses, setStatuses] = useState<readonly MemoryStatus[]>([])
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [minImportance, setMinImportance] = useState(0)
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [includeNonCurrent, setIncludeNonCurrent] = useState(true)
  const [limit, setLimit] = useState(50)
  const [mergeOpen, setMergeOpen] = useState(false)

  const filters: QueryFilters = {}
  if (types.length > 0) filters.types = [...types]
  if (statuses.length > 0) filters.statuses = [...statuses]
  if (props.tag.trim().length > 0) filters.tags = [props.tag.trim()]
  if (since.length > 0) filters.since = since
  if (until.length > 0) filters.until = until
  if (pinnedOnly) filters.pinnedOnly = true
  if (minImportance > 0) filters.minImportance = minImportance

  const request: SearchRequest = {
    filters,
    limit: Math.max(1, Math.min(500, Math.round(limit))),
    includeNonCurrent,
  }
  if (debounced.length > 0) request.text = debounced

  const queryKey = JSON.stringify(request)
  const results = useAsync(() => call('search', request), [queryKey])

  const hits = results.data?.hits ?? []
  const selectedCount = page.selection.length

  return (
    <div className="lmv-main">
      <Card title={translate('search.text')}>
        <div className="lmv-toolbar">
          <Field label={`${translate('search.text')} (${translate('search.debounceHint')})`}>
            <TextInput
              value={text}
              block
              type="search"
              placeholder={translate('search.textPlaceholder')}
              onChange={setText}
            />
          </Field>
          <Field label={translate('search.tag')}>
            <TextInput
              value={props.tag}
              placeholder={translate('search.tagPlaceholder')}
              onChange={props.onTagChange}
            />
          </Field>
          <Field label={translate('search.since')}>
            <TextInput value={since} type="date" onChange={setSince} />
          </Field>
          <Field label={translate('search.until')}>
            <TextInput value={until} type="date" onChange={setUntil} />
          </Field>
          <Field label={translate('search.limit')}>
            <NumberInput value={limit} min={1} max={500} onChange={setLimit} ariaLabel={translate('search.limit')} />
          </Field>
        </div>

        <Field label={translate('search.types')}>
          <EnumChips
            values={MEMORY_TYPES}
            selected={types}
            labelOf={(value) => typeLabel(value)}
            onToggle={(value) => {
              setTypes((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]))
            }}
          />
        </Field>

        <Field label={translate('search.statuses')}>
          <EnumChips
            values={MEMORY_STATUSES}
            selected={statuses}
            labelOf={(value) => statusLabel(value)}
            onToggle={(value) => {
              setStatuses((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]))
            }}
          />
        </Field>

        <div className="lmv-wrap">
          <Checkbox checked={pinnedOnly} label={translate('search.pinnedOnly')} onChange={setPinnedOnly} />
          <Checkbox
            checked={includeNonCurrent}
            label={translate('search.includeNonCurrent')}
            onChange={setIncludeNonCurrent}
          />
          <Field label={`${translate('detail.importance')} ≥`}>
            <NumberInput value={minImportance} min={0} max={100} onChange={setMinImportance} />
          </Field>
          <Button variant="primary" onClick={results.reload}>
            {translate('search.run')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setText('')
              setTypes([])
              setStatuses([])
              props.onTagChange('')
              setSince('')
              setUntil('')
              setMinImportance(0)
              setPinnedOnly(false)
              setIncludeNonCurrent(true)
            }}
          >
            {translate('common.reset')}
          </Button>
        </div>

        <span className="lmv-field-label">{translate('search.selectHint')}</span>
      </Card>

      <Card
        title={translate('nav.search')}
        actions={
          <>
            <span className="lmv-meta">{translate('common.selected', { count: selectedCount })}</span>
            <Button disabled={selectedCount < 2} onClick={() => setMergeOpen(true)}>
              {translate('search.merge')}
            </Button>
            <Button variant="ghost" disabled={selectedCount === 0} onClick={page.clearSelection}>
              {translate('search.clearSelection')}
            </Button>
          </>
        }
      >
        {results.data === null ? null : (
          <span className="lmv-meta">
            <span>
              {translate('search.resultCount', { total: results.data.total, ms: results.data.tookMs })}
            </span>
            {results.data.indexRefreshed ? <span>{translate('search.indexRefreshed')}</span> : null}
          </span>
        )}

        {results.loading ? <Loading /> : null}
        {results.error === null ? null : <ErrorNotice error={results.error} onRetry={results.reload} />}
        {results.error !== null || results.loading ? null : hits.length === 0 ? <Empty>{translate('search.noResults')}</Empty> : null}

        <div className="lmv-list">
          {hits.map((hit) => (
            <HitRow
              key={hit.record.id}
              hit={hit}
              selected={page.selection.includes(hit.record.id)}
              onToggleSelect={() => {
                page.toggleSelect(hit.record.id)
              }}
              onOpen={() => {
                page.openMemory(hit.record.id)
              }}
            />
          ))}
        </div>
      </Card>

      {mergeOpen ? (
        <MergeDialog
          ids={page.selection}
          onClose={() => setMergeOpen(false)}
          onDone={(id) => {
            setMergeOpen(false)
            page.clearSelection()
            page.toast(translate('merge.done', { id }), 'ok')
            results.reload()
            page.refreshStatus()
          }}
        />
      ) : null}
    </div>
  )
}
