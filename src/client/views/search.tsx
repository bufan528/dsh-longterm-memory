/**
 * Search (记忆检索): the debounced query, every filter the model exposes, and the
 * relevance explanation that makes a keyword index trustworthy.
 *
 * The information order is deliberate: the query comes first and looks like a
 * capture field, because that is what people actually do most of the time. The
 * seven filters stay collapsed behind one disclosure that reports how many are
 * on, so the default state of this page is a single line and a list.
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
import { Badge, Button, Card, Checkbox, Collapse, DisclosureChevron, Empty, EnumChips, ErrorNotice, Field, Icon, Loading, NumberInput, TextInput } from '../ui.js'
import { statusLabel, typeLabel } from '../util.js'
import { HitRow } from './hit-row.js'
import { MergeDialog } from './merge.js'

/** One removable chip describing a filter that is currently on. */
interface ActiveChip {
  key: string
  label: string
  clear: () => void
}

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
  const [filtersOpen, setFiltersOpen] = useState(false)

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

  const resetAll = (): void => {
    setText('')
    setTypes([])
    setStatuses([])
    props.onTagChange('')
    setSince('')
    setUntil('')
    setMinImportance(0)
    setPinnedOnly(false)
    setIncludeNonCurrent(true)
    setLimit(50)
  }

  // Everything that is currently narrowing the result set, so the collapsed
  // state never hides a filter the user forgot about.
  const activeChips: ActiveChip[] = []
  for (const type of types) {
    activeChips.push({
      key: `type:${type}`,
      label: typeLabel(type),
      clear: () => {
        setTypes((current) => current.filter((item) => item !== type))
      },
    })
  }
  for (const status of statuses) {
    activeChips.push({
      key: `status:${status}`,
      label: statusLabel(status),
      clear: () => {
        setStatuses((current) => current.filter((item) => item !== status))
      },
    })
  }
  if (props.tag.trim().length > 0) {
    activeChips.push({
      key: 'tag',
      label: `#${props.tag.trim()}`,
      clear: () => {
        props.onTagChange('')
      },
    })
  }
  if (since.length > 0) {
    activeChips.push({
      key: 'since',
      label: `≥ ${since}`,
      clear: () => {
        setSince('')
      },
    })
  }
  if (until.length > 0) {
    activeChips.push({
      key: 'until',
      label: `≤ ${until}`,
      clear: () => {
        setUntil('')
      },
    })
  }
  if (pinnedOnly) {
    activeChips.push({
      key: 'pinned',
      label: translate('search.pinnedOnly'),
      clear: () => {
        setPinnedOnly(false)
      },
    })
  }
  if (minImportance > 0) {
    activeChips.push({
      key: 'importance',
      label: `${translate('detail.importance')} ≥ ${String(minImportance)}`,
      clear: () => {
        setMinImportance(0)
      },
    })
  }
  if (!includeNonCurrent) {
    activeChips.push({
      key: 'current',
      label: translate('search.includeNonCurrent'),
      clear: () => {
        setIncludeNonCurrent(true)
      },
    })
  }

  return (
    <div className="lmv-main">
      <Card>
        <div className="lmv-capture">
          <TextInput
            value={text}
            block
            type="search"
            placeholder={translate('search.textPlaceholder')}
            ariaLabel={translate('search.text')}
            onChange={setText}
          />
          <Button variant="primary" onClick={results.reload}>
            <Icon name="search" />
            {translate('search.run')}
          </Button>
        </div>
        <div className="lmv-chipbar">
          {activeChips.length === 0 ? (
            <span className="lmv-meta">{translate('search.noFilters')}</span>
          ) : (
            activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className="lmv-chip"
                title={translate('search.removeFilter')}
                onClick={chip.clear}
              >
                {chip.label}
                <Icon name="close" size={11} />
              </button>
            ))
          )}
          <Button
            variant="ghost"
            ariaExpanded={filtersOpen}
            onClick={() => {
              setFiltersOpen((open) => !open)
            }}
          >
            <Icon name="manage" size={13} />
            <DisclosureChevron open={filtersOpen} />
            {translate('search.filters')}
            {activeChips.length === 0 ? null : <span className="lmv-nav-count">{String(activeChips.length)}</span>}
          </Button>
          {activeChips.length === 0 ? null : (
            <Button variant="ghost" onClick={resetAll}>
              {translate('common.reset')}
            </Button>
          )}
        </div>

        {/* Always mounted: the filter sheet slides instead of popping. */}
        <Collapse open={filtersOpen}>
          <div className="lmv-anchors lmv-fade">
            <div className="lmv-toolbar">
              <Field label={translate('search.tag')}>
                <TextInput value={props.tag} placeholder={translate('search.tagPlaceholder')} onChange={props.onTagChange} />
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
              <Field label={`${translate('detail.importance')} ≥`}>
                <NumberInput value={minImportance} min={0} max={100} onChange={setMinImportance} />
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
            </div>
            <span className="lmv-subhead">{translate('search.selectHint')}</span>
          </div>
        </Collapse>
      </Card>

      <Card
        title={
          <>
            <Icon name="search" />
            {translate('nav.search')}
          </>
        }
        actions={
          <>
            {results.data === null ? null : (
              <Badge kind="plain">{translate('search.resultCount', { total: results.data.total, ms: results.data.tookMs })}</Badge>
            )}
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
        {results.data !== null && results.data.indexRefreshed ? (
          <span className="lmv-meta">{translate('search.indexRefreshed')}</span>
        ) : null}

        {results.loading ? <Loading /> : null}
        {results.error === null ? null : <ErrorNotice error={results.error} onRetry={results.reload} />}
        {results.error !== null || results.loading ? null : hits.length === 0 ? (
          <Empty
            icon="search"
            title={translate('search.noResults')}
            hint={translate('search.noResultsHint')}
            action={
              activeChips.length === 0 ? undefined : (
                <Button variant="ghost" onClick={resetAll}>
                  {translate('common.reset')}
                </Button>
              )
            }
          />
        ) : null}

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
