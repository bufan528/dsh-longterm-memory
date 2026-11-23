/**
 * Memory Graph (记忆图谱): a three-column workbench over the real memory index.
 *
 * The page never invents a relation. Every solid edge is a `[[wikilink]]` that a
 * note really contains (or the plugin really wrote into its generated block);
 * shared-tag suggestions are a separate, off-by-default layer drawn with a
 * dotted line. The structural filters (isolated / hub / bridge / community) are
 * computed from that real graph, so a pretty picture can never claim a link that
 * the vault does not have.
 *
 * The canvas is plain SVG: the vault is small enough that a WebGL graph library
 * would add a dependency without adding a capability. The layout is computed
 * once per filter change with a deterministic force simulation, then frozen —
 * no perpetual animation. Motion is reserved for state changes (hover spotlight,
 * selection ring, programmatic fit).
 *
 * @module dsh-longterm-memory/client/views/links
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'

import {
  LINK_RENDER_LIMIT,
  analyseLinkGraph,
  buildLinkGraphFromRecords,
  selectLinkGraph,
  shortestLinkPath,
} from '../../shared/links.js'
import type {
  DerivedTagEdge,
  LinkGraphAnalysis,
  LinkGraphEdge,
  LinkGraphNode,
  LinkGraphResponse,
  LinkRelationFilter,
  LinkSpecialFilter,
} from '../../shared/links.js'
import { ERROR_CODES } from '../../shared/protocol.js'
import { TYPE_DESCRIPTORS } from '../../shared/types.js'
import { call, errCode, useAsync, useMutation } from '../api.js'
import { useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import { Badge, Button, Empty, ErrorNotice, Icon, Notice, Skeleton, TextInput } from '../ui.js'
import { formatTime, statusKind, statusLabel, typeLabel } from '../util.js'

/** The canvas refuses to draw more than this many nodes at once. */
export const MAX_LAYOUT_NODES = LINK_RENDER_LIMIT

/** Composition insets, exported so layout tests can assert the same band. */
export const LAYOUT_INSETS = { top: 84, bottom: 68, side: 60 } as const

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const ITERATIONS = 200
const MIN_ZOOM = 0.35
const MAX_ZOOM = 3.2
const TOP_PAD = LAYOUT_INSETS.top
const BOTTOM_PAD = LAYOUT_INSETS.bottom
const SIDE_PAD = LAYOUT_INSETS.side
const TIME_WINDOWS = [
  { key: 'timeAll', days: 0 },
  { key: 'time30', days: 30 },
  { key: 'time90', days: 90 },
  { key: 'time365', days: 365 },
] as const

type TimeKey = (typeof TIME_WINDOWS)[number]['key']
type Scope = 'global' | 'local'
type Depth = 1 | 2 | 3
type ViewCommandKind = 'fit' | 'center' | 'reset' | 'zoomIn' | 'zoomOut'

interface ViewCommand {
  kind: ViewCommandKind
  seq: number
}

interface GraphLoad {
  graph: LinkGraphResponse
  /** True when the running host predates the `links` method. */
  compat: boolean
}

export interface LayoutInput {
  nodes: readonly LinkGraphNode[]
  edges: readonly LinkGraphEdge[]
  derivedEdges?: readonly DerivedTagEdge[]
  width: number
  height: number
  /** Only set in local scope: the node pinned to the centre. */
  focusId: string | null
}

export interface PlacedNode {
  id: string
  x: number
  y: number
  r: number
  /** False when the label should be suppressed above the density budget. */
  label: boolean
}

export interface PlacedEdge {
  key: string
  source: string
  target: string
  path: string
  auto: boolean
  derived: boolean
}

export interface LayoutResult {
  nodes: PlacedNode[]
  edges: PlacedEdge[]
  /** Nodes dropped because of {@link MAX_LAYOUT_NODES}. */
  hidden: number
  width: number
  height: number
}

/** Render the memory graph workbench. */
export function LinksView(props: { focus: string | null }): ReactElement {
  const page = usePage()
  const translate = useT()
  const graphState = useAsync<GraphLoad>(async () => {
    try {
      return { graph: await call('links', {}), compat: false }
    } catch (error) {
      if (errCode(error) !== ERROR_CODES.notFound) throw error
      const result = await call('search', { limit: 500 })
      return { graph: buildLinkGraphFromRecords(result.hits.map((hit) => hit.record)), compat: true }
    }
  }, [])

  const [picked, setPicked] = useState<string | null>(props.focus)
  const [scope, setScope] = useState<Scope>(props.focus === null ? 'global' : 'local')
  const [depth, setDepth] = useState<Depth>(2)
  const [query, setQuery] = useState('')
  const [types, setTypes] = useState<readonly string[]>([])
  const [tags, setTags] = useState<readonly string[]>([])
  const [time, setTime] = useState<TimeKey>('timeAll')
  const [relation, setRelation] = useState<LinkRelationFilter>('all')
  const [derived, setDerived] = useState(false)
  const [special, setSpecial] = useState<LinkSpecialFilter>('none')
  const [cluster, setCluster] = useState<number | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(props.focus !== null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [pathMode, setPathMode] = useState(false)
  const [pathStart, setPathStart] = useState<string | null>(null)
  const [pathEnd, setPathEnd] = useState<string | null>(null)
  const [command, setCommand] = useState<ViewCommand>({ kind: 'fit', seq: 0 })
  const relink = useMutation(() => call('relink', {}))
  const autoPicked = useRef(false)

  const data = graphState.data?.graph ?? null
  const compat = graphState.data?.compat === true
  const nodeById = useMemo(() => {
    const map = new Map<string, LinkGraphNode>()
    for (const node of data?.nodes ?? []) map.set(node.id, node)
    return map
  }, [data])
  const analysis = useMemo<LinkGraphAnalysis | null>(() => (data === null ? null : analyseLinkGraph(data)), [data])

  const effectiveFocus = useMemo(() => {
    if (picked !== null && nodeById.has(picked)) return picked
    if (scope === 'local') return data?.nodes[0]?.id ?? null
    return null
  }, [picked, nodeById, scope, data])
  const focusNode = effectiveFocus === null ? null : (nodeById.get(effectiveFocus) ?? null)

  const since = useMemo(() => {
    const window = TIME_WINDOWS.find((entry) => entry.key === time)
    if (window === undefined || window.days === 0) return null
    return new Date(Date.now() - window.days * 86_400_000).toISOString()
  }, [time])

  const view = useMemo(() => {
    if (data === null) return null
    return selectLinkGraph(data, {
      query,
      types,
      tags,
      since,
      relation,
      derived,
      special,
      scope,
      focusId: effectiveFocus,
      depth,
      cluster,
    })
  }, [data, query, types, tags, since, relation, derived, special, scope, effectiveFocus, depth, cluster])

  const path = useMemo(() => {
    if (data === null || pathStart === null || pathEnd === null) return null
    return shortestLinkPath(data, pathStart, pathEnd)
  }, [data, pathStart, pathEnd])

  useEffect(() => {
    if (autoPicked.current || data === null || data.nodes.length === 0) return
    autoPicked.current = true
    if (picked === null && props.focus === null) setPicked(data.nodes[0]?.id ?? null)
  }, [data, picked, props.focus])

  useEffect(() => {
    if (data === null || picked === null) return
    if (!nodeById.has(picked)) setPicked(null)
  }, [data, nodeById, picked])

  useEffect(() => {
    if (cluster === null || analysis === null) return
    if (!analysis.clusters.some((entry) => entry.key === cluster)) setCluster(null)
  }, [analysis, cluster])

  useEffect(() => {
    if (!pathMode) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPathMode(false)
        setPathStart(null)
        setPathEnd(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pathMode])

  const runView = useCallback((kind: ViewCommandKind): void => {
    setCommand((previous) => ({ kind, seq: previous.seq + 1 }))
  }, [])

  const handleSelect = useCallback(
    (id: string | null): void => {
      if (id === null) {
        setPicked(null)
        return
      }
      setPicked(id)
      if (!pathMode) setDetailOpen(true)
      if (pathMode) {
        if (pathStart === null) {
          setPathStart(id)
          setPathEnd(null)
        } else if (pathEnd === null && id !== pathStart) {
          setPathEnd(id)
        } else {
          setPathStart(id)
          setPathEnd(null)
        }
      }
    },
    [pathMode, pathStart, pathEnd],
  )

  const handleSearchPick = useCallback(
    (id: string): void => {
      setPicked(id)
      setDetailOpen(true)
      setSearchOpen(false)
      window.setTimeout(() => runView('center'), 30)
    },
    [runView],
  )

  /** Inspect a memory from the detail rail without changing path endpoints. */
  const handleInspect = useCallback((id: string): void => {
    setPicked(id)
    setDetailOpen(true)
  }, [])

  const runRelink = async (): Promise<void> => {
    try {
      const result = await relink.run()
      if (result === undefined) return
      page.toast(translate('links.relinkDone', { changed: result.changed, links: result.links }), 'ok')
      graphState.reload()
      page.refreshStatus()
    } catch {
      /* rendered from the mutation state */
    }
  }

  const toggleType = (type: string): void => {
    setTypes((current) => (current.includes(type) ? current.filter((item) => item !== type) : [...current, type]))
  }
  const toggleTag = (tag: string): void => {
    setTags((current) => (current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]))
  }
  const pickCluster = (key: number | null): void => {
    setCluster(key)
    setSpecial('none')
  }
  const exitPath = (): void => {
    setPathMode(false)
    setPathStart(null)
    setPathEnd(null)
  }

  if (graphState.error !== null) {
    return (
      <div className="lmv-wb lmv-wb-state">
        <ErrorNotice error={graphState.error} onRetry={graphState.reload} />
      </div>
    )
  }
  if (data === null || view === null || analysis === null) {
    return (
      <div className="lmv-wb lmv-wb-state">
        <Skeleton variant="card" />
        <Skeleton variant="rows" count={5} />
      </div>
    )
  }
  if (data.nodes.length === 0) {
    return (
      <div className="lmv-wb">
        <WorkbenchHeader
          query={query}
          onQuery={setQuery}
          onSearch={handleSearchPick}
          searchOpen={searchOpen}
          onSearchOpen={setSearchOpen}
          results={[]}
          scope={scope}
          onScope={setScope}
          depth={depth}
          onDepth={setDepth}
          pathMode={pathMode}
          onTogglePath={() => {
            if (pathMode) {
              exitPath()
              return
            }
            // Path picking happens on the canvas; on a phone the detail drawer
            // would cover the very nodes the user needs to tap next.
            setDetailOpen(false)
            setPathMode(true)
          }}
          onFilters={() => setFiltersOpen(true)}
          stats={translate('links.filteredCount', { count: 0, total: 0 })}
          onClearQuery={() => setQuery('')}
        />
        <div className="lmv-wb-empty">
          <Empty icon="links" title={translate('links.noMemories')} hint={translate('links.noMemoriesHint')} />
        </div>
      </div>
    )
  }

  const searchResults = data.nodes.filter((node) => matchesNode(node, query)).slice(0, 6)
  const autoEdges = data.edges.filter((edge) => edge.auto).length

  return (
    <div className={`lmv-wb${filtersOpen ? ' is-filters-open' : ''}${detailOpen ? ' is-detail-open' : ''}`}>
      <WorkbenchHeader
        query={query}
        onQuery={(next) => {
          setQuery(next)
          setSearchOpen(next.trim().length > 0)
        }}
        onSearch={handleSearchPick}
        searchOpen={searchOpen}
        onSearchOpen={setSearchOpen}
        results={searchResults}
        scope={scope}
        onScope={(next) => {
          setScope(next)
          if (next === 'global') setCluster(null)
        }}
        depth={depth}
        onDepth={setDepth}
        pathMode={pathMode}
        onTogglePath={() => {
          if (pathMode) {
            exitPath()
            return
          }
          setDetailOpen(false)
          setPathMode(true)
        }}
        onFilters={() => setFiltersOpen(true)}
        stats={
          query.trim().length === 0
            ? translate('links.filteredCount', { count: view.nodes.length, total: data.nodes.length })
            : `${translate('links.filteredCount', { count: view.nodes.length, total: data.nodes.length })} · ${translate('links.matchedCount', { count: view.matched.length })}`
        }
        onClearQuery={() => {
          setQuery('')
          setSearchOpen(false)
        }}
      />

      <div className="lmv-wb-cols">
        <FilterRail
          data={data}
          view={view}
          analysis={analysis}
          types={types}
          onType={toggleType}
          tags={tags}
          onTag={toggleTag}
          onAllTags={() => setTags([])}
          time={time}
          onTime={setTime}
          relation={relation}
          onRelation={setRelation}
          derived={derived}
          onDerived={setDerived}
          special={special}
          onSpecial={(next) => {
            setSpecial(next)
            setCluster(null)
          }}
          scope={scope}
          depth={depth}
          onDepth={setDepth}
          cluster={cluster}
          onCluster={pickCluster}
          compat={compat}
          relinkBusy={relink.busy}
          relinkError={relink.error}
          onRelink={() => void runRelink()}
          onRefresh={() => {
            graphState.reload()
            page.refreshStatus()
          }}
          onClose={() => setFiltersOpen(false)}
          autoEdges={autoEdges}
        />

        <GraphStage
          data={data}
          view={view}
          analysis={analysis}
          focusId={effectiveFocus}
          scope={scope}
          command={command}
          pathMode={pathMode}
          pathStart={pathStart}
          pathEnd={pathEnd}
          path={path}
          onSelect={handleSelect}
          onOpen={page.openMemory}
          onCluster={pickCluster}
          onClearPath={exitPath}
          onPathDetails={() => setDetailOpen(true)}
          onZeroRelink={() => void runRelink()}
          relinkBusy={relink.busy}
          compat={compat}
          cluster={cluster}
        />

        <DetailRail
          data={data}
          node={focusNode}
          compat={compat}
          pathMode={pathMode}
          pathStart={pathStart}
          pathEnd={pathEnd}
          path={path}
          onInspect={handleInspect}
          onOpen={page.openMemory}
          onExplore={(id) => {
            setPicked(id)
            setScope('local')
            setDepth(2)
            setCluster(null)
            setSpecial('none')
            setDetailOpen(true)
            setPathMode(false)
            setPathStart(null)
            setPathEnd(null)
            window.setTimeout(() => runView('fit'), 30)
          }}
          onLocate={() => runView('center')}
          onPickTag={(tag) => {
            setTags([tag])
            setFiltersOpen(false)
          }}
          onClearPath={exitPath}
          onClose={() => setDetailOpen(false)}
        />
      </div>
    </div>
  )
}

/* ================================================================ header === */

interface HeaderProps {
  query: string
  onQuery: (value: string) => void
  onSearch: (id: string) => void
  searchOpen: boolean
  onSearchOpen: (open: boolean) => void
  results: readonly LinkGraphNode[]
  scope: Scope
  onScope: (scope: Scope) => void
  depth: Depth
  onDepth: (depth: Depth) => void
  pathMode: boolean
  onTogglePath: () => void
  onFilters: () => void
  stats: string
  onClearQuery: () => void
}

function WorkbenchHeader(props: HeaderProps): ReactElement {
  const translate = useT()
  const searchRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!props.searchOpen) return
    const onDown = (event: PointerEvent): void => {
      if (searchRef.current?.contains(event.target as Node) === true) return
      props.onSearchOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [props.searchOpen, props.onSearchOpen])

  useEffect(() => {
    if (!props.searchOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onSearchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.searchOpen, props.onSearchOpen])

  return (
    <header className="lmv-wb-top">
      <div className="lmv-wb-ident">
        <span className="lmv-wb-title">{translate('links.title')}</span>
        <span className="lmv-wb-subtitle">{translate('links.subtitle')}</span>
        <span className="lmv-wb-stat">{props.stats}</span>
      </div>

      <div className="lmv-wb-search" ref={searchRef}>
        <span className="lmv-wb-search-icon" aria-hidden="true">
          <Icon name="search" size={14} />
        </span>
        <TextInput
          value={props.query}
          onChange={props.onQuery}
          placeholder={translate('links.searchPlaceholder')}
          ariaLabel={translate('links.searchPlaceholder')}
          type="search"
          block
          onEnter={() => {
            const first = props.results[0]
            if (first !== undefined) props.onSearch(first.id)
          }}
        />
        {props.query.trim().length > 0 ? (
          <button
            type="button"
            className="lmv-wb-search-clear"
            aria-label={translate('links.clearSearch')}
            title={translate('links.clearSearch')}
            onClick={props.onClearQuery}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
        {props.searchOpen && props.query.trim().length > 0 ? (
          <div className="lmv-wb-search-menu" role="listbox">
            {props.results.length === 0 ? (
              <span className="lmv-wb-search-empty">{translate('links.searchEmpty')}</span>
            ) : (
              props.results.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="lmv-wb-search-item"
                  onClick={() => props.onSearch(node.id)}
                >
                  <span className={`lmv-wb-dot lmv-wb-tone-${toneOfType(node.type)}`} aria-hidden="true" />
                  <span className="lmv-wb-search-item-main">
                    <span className="lmv-wb-search-item-title">{node.title}</span>
                    <span className="lmv-wb-search-item-meta">
                      {typeLabel(node.type)}
                      <span className="lmv-sep">·</span>
                      {translate('links.degrees', { in: node.inDegree, out: node.outDegree })}
                    </span>
                  </span>
                </button>
              ))
            )}
            <span className="lmv-wb-search-hint">{translate('links.searchHint')}</span>
          </div>
        ) : null}
      </div>

      <div className="lmv-wb-actions">
        <div className="lmv-wb-seg" role="group" aria-label={translate('links.scopeHint')}>
          <button
            type="button"
            className={`lmv-wb-seg-btn${props.scope === 'global' ? ' is-on' : ''}`}
            onClick={() => props.onScope('global')}
          >
            {translate('links.scopeGlobal')}
          </button>
          <button
            type="button"
            className={`lmv-wb-seg-btn${props.scope === 'local' ? ' is-on' : ''}`}
            onClick={() => props.onScope('local')}
          >
            {translate('links.scopeLocal')}
          </button>
        </div>
        {props.scope === 'local' ? (
          <div className="lmv-wb-seg" role="group" aria-label={translate('links.depth')}>
            {([1, 2, 3] as const).map((level) => (
              <button
                key={level}
                type="button"
                className={`lmv-wb-seg-btn${props.depth === level ? ' is-on' : ''}`}
                title={translate('links.depthHint')}
                onClick={() => props.onDepth(level)}
              >
                {level}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className={`lmv-wb-chip-btn${props.pathMode ? ' is-on' : ''}`}
          onClick={props.onTogglePath}
        >
          <Icon name="route" size={13} />
          <span>{translate('links.path')}</span>
        </button>
        <button type="button" className="lmv-wb-chip-btn lmv-wb-only-narrow" onClick={props.onFilters}>
          <Icon name="filter" size={13} />
          <span>{translate('links.filters')}</span>
        </button>
      </div>
    </header>
  )
}

/* =============================================================== filters === */

interface FilterRailProps {
  data: LinkGraphResponse
  view: ReturnType<typeof selectLinkGraph>
  analysis: LinkGraphAnalysis
  types: readonly string[]
  onType: (type: string) => void
  tags: readonly string[]
  onTag: (tag: string) => void
  onAllTags: () => void
  time: TimeKey
  onTime: (time: TimeKey) => void
  relation: LinkRelationFilter
  onRelation: (relation: LinkRelationFilter) => void
  derived: boolean
  onDerived: (on: boolean) => void
  special: LinkSpecialFilter
  onSpecial: (special: LinkSpecialFilter) => void
  scope: Scope
  depth: Depth
  onDepth: (depth: Depth) => void
  cluster: number | null
  onCluster: (key: number | null) => void
  compat: boolean
  relinkBusy: boolean
  relinkError: unknown
  onRelink: () => void
  onRefresh: () => void
  onClose: () => void
  autoEdges: number
}

function FilterRail(props: FilterRailProps): ReactElement {
  const translate = useT()
  const typeFacets = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of props.data.nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
  }, [props.data])
  const tagFacets = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of props.data.nodes) {
      for (const tag of new Set(node.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
      .slice(0, 10)
  }, [props.data])

  return (
    <aside className="lmv-wb-left" aria-label={translate('links.filters')}>
      <div className="lmv-wb-left-head">
        <span className="lmv-kicker">{translate('links.kickerExplore')}</span>
        <span className="lmv-wb-rail-title">{translate('links.filters')}</span>
        <button
          type="button"
          className="lmv-wb-icon-btn lmv-wb-only-narrow"
          aria-label={translate('links.filtersClose')}
          title={translate('links.filtersClose')}
          onClick={props.onClose}
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="lmv-wb-facets">
        <section className="lmv-wb-facet">
          <span className="lmv-kicker">{translate('links.typeSection')}</span>
          <div className="lmv-wb-chips">
            {typeFacets.map(([type, count]) => (
              <button
                key={type}
                type="button"
                className={`lmv-wb-chip lmv-wb-tone-${toneOfType(type)}${props.types.includes(type) ? ' is-on' : ''}`}
                onClick={() => props.onType(type)}
              >
                <span className="lmv-wb-dot" aria-hidden="true" />
                <span>{typeLabel(type)}</span>
                <span className="lmv-wb-chip-count">{count}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="lmv-wb-facet">
          <span className="lmv-kicker">{translate('links.tagSection')}</span>
          <div className="lmv-wb-chips">
            <button
              type="button"
              className={`lmv-wb-chip${props.tags.length === 0 ? ' is-on' : ''}`}
              onClick={props.onAllTags}
            >
              {translate('links.allTags')}
            </button>
            {tagFacets.map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                className={`lmv-wb-chip${props.tags.includes(tag) ? ' is-on' : ''}`}
                onClick={() => props.onTag(tag)}
              >
                <span>#{tag}</span>
                <span className="lmv-wb-chip-count">{count}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="lmv-wb-facet">
          <span className="lmv-kicker">{translate('links.timeSection')}</span>
          <div className="lmv-wb-seg lmv-wb-seg-block">
            {TIME_WINDOWS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`lmv-wb-seg-btn${props.time === entry.key ? ' is-on' : ''}`}
                onClick={() => props.onTime(entry.key)}
              >
                {translate(`links.${entry.key}`)}
              </button>
            ))}
          </div>
        </section>

        <section className="lmv-wb-facet">
          <span className="lmv-kicker">{translate('links.relationSection')}</span>
          <div className="lmv-wb-seg lmv-wb-seg-block">
            {(
              [
                ['all', 'links.relAll'],
                ['manual', 'links.relManual'],
                ['auto', 'links.relAuto'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`lmv-wb-seg-btn${props.relation === key ? ' is-on' : ''}`}
                onClick={() => props.onRelation(key)}
              >
                {translate(label)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`lmv-wb-switch${props.derived ? ' is-on' : ''}`}
            role="switch"
            aria-checked={props.derived}
            onClick={() => props.onDerived(!props.derived)}
          >
            <span className="lmv-wb-switch-track" aria-hidden="true"><span /></span>
            <span>{translate('links.derivedToggle')}</span>
          </button>
          <span className="lmv-wb-hint">{translate('links.derivedHint')}</span>
        </section>

        <section className="lmv-wb-facet">
          <span className="lmv-kicker">{translate('links.structureSection')}</span>
          <div className="lmv-wb-struct">
            <button
              type="button"
              className={`lmv-wb-struct-row${props.special === 'none' ? ' is-on' : ''}`}
              onClick={() => props.onSpecial('none')}
            >
              <span>{translate('links.structAll')}</span>
              <span>{props.data.nodes.length}</span>
            </button>
            <button
              type="button"
              className={`lmv-wb-struct-row${props.special === 'isolated' ? ' is-on' : ''}`}
              onClick={() => props.onSpecial('isolated')}
            >
              <span>{translate('links.structIsolated')}</span>
              <span>{props.analysis.isolated.length}</span>
            </button>
            <button
              type="button"
              className={`lmv-wb-struct-row${props.special === 'hubs' ? ' is-on' : ''}`}
              onClick={() => props.onSpecial('hubs')}
            >
              <span>{translate('links.structHubs')}</span>
              <span>{props.analysis.hubs.length}</span>
            </button>
            <button
              type="button"
              className={`lmv-wb-struct-row${props.special === 'bridges' ? ' is-on' : ''}`}
              onClick={() => props.onSpecial('bridges')}
            >
              <span>{translate('links.structBridges')}</span>
              <span>{props.analysis.bridges.length}</span>
            </button>
          </div>
          <span className="lmv-wb-hint">{translate('links.structHint')}</span>
        </section>

        {props.analysis.clusters.length > 0 ? (
          <section className="lmv-wb-facet">
            <span className="lmv-kicker">{translate('links.clusters')}</span>
            <div className="lmv-wb-chips">
              <button
                type="button"
                className={`lmv-wb-chip${props.cluster === null ? ' is-on' : ''}`}
                onClick={() => props.onCluster(null)}
              >
                {translate('links.allClusters')}
              </button>
              {props.analysis.clusters.slice(0, 6).map((entry, index) => (
                <button
                  key={entry.key}
                  type="button"
                  className={`lmv-wb-chip${props.cluster === entry.key ? ' is-on' : ''}`}
                  onClick={() => props.onCluster(entry.key)}
                >
                  {translate('links.clusterLabel', { index: index + 1 })}
                  <span className="lmv-wb-chip-count">{entry.nodeIds.length}</span>
                </button>
              ))}
            </div>
            <span className="lmv-wb-hint">{translate('links.clusterHint')}</span>
          </section>
        ) : null}

        {props.scope === 'local' ? (
          <section className="lmv-wb-facet">
            <span className="lmv-kicker">{translate('links.depth')}</span>
            <div className="lmv-wb-seg lmv-wb-seg-block">
              {([1, 2, 3] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  className={`lmv-wb-seg-btn${props.depth === level ? ' is-on' : ''}`}
                  onClick={() => props.onDepth(level)}
                >
                  {level}
                </button>
              ))}
            </div>
            <span className="lmv-wb-hint">{translate('links.depthHint')}</span>
          </section>
        ) : null}
      </div>

      <div className="lmv-wb-left-foot">
        <div className="lmv-wb-mini-stats">
          <MiniStat label={translate('links.statsNodes')} value={props.view.nodes.length} />
          <MiniStat label={translate('links.statsEdges')} value={props.view.edges.length} />
          <MiniStat label={translate('links.statsAuto')} value={props.autoEdges} />
          <MiniStat label={translate('links.statsOrphans')} value={props.analysis.isolated.length} />
          <MiniStat label={translate('links.statsDangling')} value={props.data.stats.dangling} />
          <MiniStat label={translate('links.statsComponents')} value={props.analysis.components.length} />
          <MiniStat label={translate('links.statsClusters')} value={props.analysis.clusters.length} />
        </div>
        <div className="lmv-wb-foot-actions">
          <span className="lmv-wb-only-narrow">
            <Button variant="primary" size="sm" onClick={props.onClose}>
              {translate('links.viewCanvas')}
            </Button>
          </span>
          <Button variant="ghost" size="sm" disabled={props.compat || props.relinkBusy} onClick={props.onRelink}>
            <Icon name="spark" size={13} />
            {translate('links.relink')}
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onRefresh}>
            <Icon name="refresh" size={13} />
            {translate('links.refresh')}
          </Button>
        </div>
        <span className="lmv-wb-hint">{translate('links.relinkHint')}</span>
        {props.compat ? <Notice kind="warn">{translate('links.compat')}</Notice> : null}
        {props.relinkError === null ? null : <ErrorNotice error={props.relinkError} />}
      </div>
    </aside>
  )
}

function MiniStat(props: { label: string; value: number }): ReactElement {
  return (
    <span className="lmv-wb-mini-stat">
      <b>{String(props.value)}</b>
      <span>{props.label}</span>
    </span>
  )
}

/* ================================================================= canvas === */

interface StageProps {
  data: LinkGraphResponse
  view: ReturnType<typeof selectLinkGraph>
  analysis: LinkGraphAnalysis
  focusId: string | null
  scope: Scope
  command: ViewCommand
  pathMode: boolean
  pathStart: string | null
  pathEnd: string | null
  path: readonly string[] | null
  onSelect: (id: string | null) => void
  onOpen: (id: string) => void
  onCluster: (key: number | null) => void
  onClearPath: () => void
  onPathDetails: () => void
  onZeroRelink: () => void
  relinkBusy: boolean
  compat: boolean
  cluster: number | null
}

interface Transform {
  x: number
  y: number
  k: number
}

interface PointerState {
  mode: 'pan' | 'node'
  id: string
  startX: number
  startY: number
  originX: number
  originY: number
  moved: boolean
}

function GraphStage(props: StageProps): ReactElement {
  const translate = useT()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<string | null>(null)
  const [tip, setTip] = useState<{ id: string; x: number; y: number; below: boolean } | null>(null)
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [animate, setAnimate] = useState(false)
  const [manual, setManual] = useState<Map<string, { x: number; y: number }>>(new Map())
  const pointer = useRef<PointerState | null>(null)
  const animateTimer = useRef<number | null>(null)
  const handledSeq = useRef(0)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box === undefined) return
      const w = Math.max(0, Math.round(box.width))
      const h = Math.max(0, Math.round(box.height))
      setSize((current) => (current.w === w && current.h === h ? current : { w, h }))
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    return () => {
      if (animateTimer.current !== null) window.clearTimeout(animateTimer.current)
    }
  }, [])

  const graphKey = useMemo(() => {
    const nodes = props.view.nodes.map((node) => node.id).join(',')
    const edges = props.view.edges
      .map((edge) => `${edge.source}>${edge.target}:${edge.auto ? 'a' : 'm'}`)
      .join(',')
    const derived = props.view.derivedEdges.map((edge) => `${edge.source}>${edge.target}`).join(',')
    const centre = props.scope === 'local' ? (props.focusId ?? '') : ''
    return `${props.scope}|${centre}|${nodes}|${edges}|${derived}`
  }, [props.view, props.scope, props.focusId])

  const layout = useMemo<LayoutResult>(() => {
    if (size.w === 0 || size.h === 0) {
      return { nodes: [], edges: [], hidden: 0, width: size.w, height: size.h }
    }
    return computeLayout({
      nodes: props.view.nodes,
      edges: props.view.edges,
      derivedEdges: props.view.derivedEdges,
      width: size.w,
      height: size.h,
      focusId: props.scope === 'local' ? props.focusId : null,
    })
    // The view object is recreated for highlight-only changes (search text,
    // selection). Keying on the actual graph contents keeps typing from
    // re-running the force simulation and jumping the canvas.
  }, [graphKey, size])

  const placedById = useMemo(() => {
    const map = new Map<string, PlacedNode>()
    for (const node of layout.nodes) map.set(node.id, node)
    return map
  }, [layout])

  const nodeMap = useMemo(() => {
    const map = new Map<string, LinkGraphNode>()
    for (const node of props.data.nodes) map.set(node.id, node)
    return map
  }, [props.data])

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const edge of props.view.edges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set())
      if (!map.has(edge.target)) map.set(edge.target, new Set())
      map.get(edge.source)?.add(edge.target)
      map.get(edge.target)?.add(edge.source)
    }
    for (const edge of props.view.derivedEdges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set())
      if (!map.has(edge.target)) map.set(edge.target, new Set())
      map.get(edge.source)?.add(edge.target)
      map.get(edge.target)?.add(edge.source)
    }
    return map
  }, [props.view])

  const activeId = hover ?? props.focusId
  const neighbours = useMemo(
    () => (activeId === null ? new Set<string>() : new Set(adjacency.get(activeId) ?? [])),
    [activeId, adjacency],
  )

  const pathNodes = useMemo(() => new Set(props.path ?? []), [props.path])
  const pathEdges = useMemo(() => {
    const set = new Set<string>()
    if (props.path === null) return set
    for (let index = 0; index + 1 < props.path.length; index += 1) {
      const a = props.path[index]
      const b = props.path[index + 1]
      if (a !== undefined && b !== undefined) set.add(pairKey(a, b))
    }
    return set
  }, [props.path])

  const matched = useMemo(() => new Set(props.view.matched), [props.view.matched])
  const isolated = useMemo(() => new Set(props.analysis.isolated), [props.analysis.isolated])

  const clusters = useMemo(() => {
    if (props.cluster === null) return []
    return props.analysis.clusters
      .filter((cluster) => cluster.key === props.cluster)
      .map((cluster) => ({ cluster, points: cluster.nodeIds.map((id) => placedById.get(id)).filter(isPlaced) }))
      .filter((entry) => {
        if (entry.points.length < 3) return false
        const xs = entry.points.map((point) => point.x)
        const ys = entry.points.map((point) => point.y)
        const width = Math.max(...xs) - Math.min(...xs)
        const height = Math.max(...ys) - Math.min(...ys)
        // A community that spans most of the canvas is not a readable cluster;
        // its hull would just be a large shaded triangle behind everything.
        return width <= size.w * 0.56 && height <= size.h * 0.6
      })
  }, [props.analysis.clusters, props.cluster, placedById, size])

  const stopAnimate = useCallback((): void => {
    if (animateTimer.current !== null) window.clearTimeout(animateTimer.current)
    animateTimer.current = null
    setAnimate(false)
  }, [])

  const animateTo = useCallback(
    (next: Transform): void => {
      stopAnimate()
      setAnimate(true)
      setTransform(next)
      animateTimer.current = window.setTimeout(() => {
        animateTimer.current = null
        setAnimate(false)
      }, 340)
    },
    [stopAnimate],
  )

  const fitAll = useCallback((): void => {
    if (layout.nodes.length === 0) return
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const node of layout.nodes) {
      minX = Math.min(minX, node.x - node.r)
      minY = Math.min(minY, node.y - node.r)
      maxX = Math.max(maxX, node.x + node.r)
      maxY = Math.max(maxY, node.y + node.r + 18)
    }
    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)
    const k = clamp(
      Math.min((size.w - SIDE_PAD) / width, (size.h - TOP_PAD - BOTTOM_PAD) / height),
      MIN_ZOOM,
      1.6,
    )
    animateTo({
      k,
      x: size.w / 2 - ((minX + maxX) / 2) * k,
      y: TOP_PAD + (size.h - TOP_PAD - BOTTOM_PAD) / 2 - ((minY + maxY) / 2) * k,
    })
  }, [layout, size, animateTo])

  const centerOn = useCallback(
    (id: string | null): void => {
      if (id === null) return
      const node = placedById.get(id)
      if (node === undefined) return
      setTransform((previous) => ({
        k: previous.k,
        x: size.w / 2 - node.x * previous.k,
        y: size.h / 2 - node.y * previous.k,
      }))
    },
    [placedById, size],
  )

  const zoomBy = useCallback(
    (factor: number): void => {
      stopAnimate()
      setTransform((previous) => {
        const k = clamp(previous.k * factor, MIN_ZOOM, MAX_ZOOM)
        const scale = k / previous.k
        const cx = size.w / 2
        const cy = size.h / 2
        return { k, x: cx - (cx - previous.x) * scale, y: cy - (cy - previous.y) * scale }
      })
    },
    [size, stopAnimate],
  )

  const layoutKey = useMemo(() => layout.nodes.map((node) => node.id).join('|'), [layout])
  useEffect(() => {
    setManual(new Map())
    if (layout.nodes.length === 0) return
    const frame = window.requestAnimationFrame(() => fitAll())
    return () => window.cancelAnimationFrame(frame)
  }, [layoutKey, size.w, size.h, fitAll, layout.nodes.length])

  useEffect(() => {
    if (props.command.seq <= handledSeq.current) return
    handledSeq.current = props.command.seq
    const kind = props.command.kind
    if (kind === 'fit') fitAll()
    else if (kind === 'center') centerOn(props.focusId)
    else if (kind === 'reset') {
      setManual(new Map())
      fitAll()
    } else if (kind === 'zoomIn') zoomBy(1.3)
    else zoomBy(1 / 1.3)
  }, [props.command, props.focusId, fitAll, centerOn, zoomBy])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      stopAnimate()
      const rect = host.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      setTransform((previous) => {
        const k = clamp(previous.k * Math.exp(-event.deltaY * 0.0014), MIN_ZOOM, MAX_ZOOM)
        const scale = k / previous.k
        return { k, x: mx - (mx - previous.x) * scale, y: my - (my - previous.y) * scale }
      })
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [stopAnimate])

  const startNodeDrag = (event: ReactPointerEvent<SVGGElement>, id: string): void => {
    event.stopPropagation()
    if (event.button !== 0) return
    const placed = placedById.get(id)
    if (placed === undefined) return
    const current = manual.get(id) ?? placed
    pointer.current = {
      mode: 'node',
      id,
      startX: event.clientX,
      startY: event.clientY,
      originX: current.x,
      originY: current.y,
      moved: false,
    }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const startPan = (event: ReactPointerEvent<SVGRectElement>): void => {
    if (event.button !== 0) return
    stopAnimate()
    pointer.current = {
      mode: 'pan',
      id: '',
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
      moved: false,
    }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const state = pointer.current
    if (state === null) return
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    if (!state.moved && Math.hypot(dx, dy) > 3) state.moved = true
    if (state.mode === 'pan') {
      setTransform((previous) => ({ ...previous, x: state.originX + dx, y: state.originY + dy }))
      return
    }
    setManual((previous) => {
      const next = new Map(previous)
      next.set(state.id, { x: state.originX + dx / transform.k, y: state.originY + dy / transform.k })
      return next
    })
  }

  const onPointerUp = (): void => {
    const state = pointer.current
    pointer.current = null
    if (state === null) return
    if (!state.moved) {
      if (state.mode === 'node') props.onSelect(state.id)
      else props.onSelect(null)
    }
  }

  const positionOf = (node: PlacedNode): { x: number; y: number } => manual.get(node.id) ?? node

  const labelPlacement = useMemo(() => {
    const accepted: { x0: number; x1: number; y0: number; y1: number }[] = layout.nodes.map((placed) => {
      const position = positionOf(placed)
      return {
        x0: position.x - placed.r - 3,
        x1: position.x + placed.r + 3,
        y0: position.y - placed.r - 3,
        y1: position.y + placed.r + 3,
      }
    })
    const out = new Map<string, { x: number; anchor: 'start' | 'middle' | 'end'; text: string }>()
    const candidates = layout.nodes
      .map((placed, index) => {
        const node = nodeMap.get(placed.id)
        if (node === undefined) return null
        const forced = placed.id === props.focusId || placed.id === hover
        const neighbour = activeId !== null && neighbours.has(placed.id)
        const isMatch = matched.has(placed.id)
        if (!forced && !neighbour && !isMatch) {
          if (transform.k < 0.55 || !placed.label) return null
        }
        const position = positionOf(placed)
        const text = shortTitle(node.title)
        const width = Math.min(13, text.length) * 7 + 4
        const anchor: 'start' | 'middle' | 'end' =
          position.x < width / 2 + 66 ? 'start' : position.x > layout.width - width / 2 - 66 ? 'end' : 'middle'
        const x =
          anchor === 'start' ? position.x + placed.r + 4 : anchor === 'end' ? position.x - placed.r - 4 : position.x
        const rectX = anchor === 'middle' ? x - width / 2 : anchor === 'start' ? x : x - width
        const y = position.y + placed.r + 15
        return {
          id: placed.id,
          text,
          x,
          anchor,
          rect: { x0: rectX - 2, x1: rectX + width + 2, y0: y - 11, y1: y + 3 },
          priority: forced ? 3000 : neighbour ? 2000 : isMatch ? 1500 : 1000 - index,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.priority - a.priority)

    for (const candidate of candidates) {
      if (out.size >= 28) break
      if (candidate.rect.x0 < 4 || candidate.rect.x1 > layout.width - 4) continue
      const clash = accepted.some(
        (other) =>
          !(
            candidate.rect.x1 < other.x0 ||
            candidate.rect.x0 > other.x1 ||
            candidate.rect.y1 < other.y0 ||
            candidate.rect.y0 > other.y1
          ),
      )
      if (clash && candidate.priority < 3000) continue
      accepted.push(candidate.rect)
      out.set(candidate.id, { x: candidate.x, anchor: candidate.anchor, text: candidate.text })
    }
    return out
  }, [layout, activeId, hover, neighbours, matched, transform.k, manual, nodeMap, props.focusId])

  const hovered = hover === null ? null : nodeMap.get(hover) ?? null
  const hoveredPlaced = hover === null ? null : placedById.get(hover) ?? null

  return (
    <section className={`lmv-wb-stage${props.compat ? ' is-compat' : ''}`} ref={hostRef} aria-label={translate('links.graph')}>
      {size.w === 0 ? null : (
        <svg
          ref={svgRef}
          className="lmv-wb-svg"
          viewBox={`0 0 ${String(size.w)} ${String(size.h)}`}
          role="img"
          aria-label={translate('links.graph')}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            pointer.current = null
          }}
        >
          <defs>
            <marker id="lmv-wb-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
              <path className="lmv-wb-arrow-shape" d="M0 0 6 3 0 6z" />
            </marker>
          </defs>
          <rect
            className="lmv-wb-bg"
            width={size.w}
            height={size.h}
            onPointerDown={startPan}
          />
          <g
            className={`lmv-wb-viewport${animate ? ' is-animating' : ''}`}
            style={{ transform: `translate(${String(transform.x)}px, ${String(transform.y)}px) scale(${String(transform.k)})` }}
          >
            {clusters.map((entry) => {
              const points = entry.points.map((point) => positionOf(point))
              const path = hullPath(points)
              if (path === null) return null
              return (
                <path
                  key={entry.cluster.key}
                  className="lmv-wb-hull"
                  d={path}
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onCluster(entry.cluster.key)
                  }}
                />
              )
            })}

            {layout.edges.map((edge) => {
              const hot =
                (activeId !== null && (edge.source === activeId || edge.target === activeId)) ||
                pathEdges.has(pairKey(edge.source, edge.target))
              const dim =
                (activeId !== null && !hot) ||
                (pathNodes.size > 0 && !pathEdges.has(pairKey(edge.source, edge.target)))
              const classes = [
                'lmv-wb-edge',
                edge.auto ? 'is-auto' : '',
                edge.derived ? 'is-derived' : '',
                hot ? 'is-hot' : '',
                dim ? 'is-dim' : '',
                pathEdges.has(pairKey(edge.source, edge.target)) ? 'is-path' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <path
                  key={edge.key}
                  className={classes}
                  d={edge.path}
                  markerEnd={hot && !edge.derived ? 'url(#lmv-wb-arrow)' : undefined}
                />
              )
            })}

            {layout.nodes.map((placed) => {
              const node = nodeMap.get(placed.id)
              if (node === undefined) return null
              const position = positionOf(placed)
              const selected = placed.id === props.focusId
              const isHover = placed.id === hover
              const isNeighbour = activeId !== null && neighbours.has(placed.id)
              const dim =
                (activeId !== null && placed.id !== activeId && !isNeighbour) ||
                (pathNodes.size > 0 && activeId === null && !pathNodes.has(placed.id))
              const classes = [
                'lmv-wb-node',
                `lmv-wb-tone-${toneOfType(node.type)}`,
                selected ? 'is-selected' : '',
                isHover ? 'is-hover' : '',
                isNeighbour ? 'is-neighbour' : '',
                dim ? 'is-dim' : '',
                matched.has(placed.id) ? 'is-match' : '',
                pathNodes.has(placed.id) ? 'is-path' : '',
                isolated.has(placed.id) ? 'is-isolated' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <g
                  key={placed.id}
                  className={classes}
                  role="button"
                  tabIndex={0}
                  aria-label={node.title}
                  onPointerDown={(event) => startNodeDrag(event, placed.id)}
                  onPointerEnter={() => {
                    setHover(placed.id)
                    const host = hostRef.current?.getBoundingClientRect()
                    if (host === undefined) return
                    const x = transform.x + position.x * transform.k
                    const y = transform.y + position.y * transform.k
                    setTip({
                      id: placed.id,
                      x: clamp(x, 140, Math.max(140, size.w - 140)),
                      y,
                      below: y < 132,
                    })
                  }}
                  onPointerLeave={() => {
                    setHover(null)
                    setTip(null)
                  }}
                  onFocus={() => setHover(placed.id)}
                  onBlur={() => setHover(null)}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    props.onOpen(placed.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      props.onSelect(placed.id)
                    }
                  }}
                >
                  <title>{`${node.title} · ${typeLabel(node.type)} · ${statusLabel(node.status)}`}</title>
                  <circle className="lmv-wb-halo" cx={position.x} cy={position.y} r={placed.r * 2.5} />
                  <circle className="lmv-wb-core" cx={position.x} cy={position.y} r={placed.r} />
                  {selected ? <circle className="lmv-wb-ring" cx={position.x} cy={position.y} r={placed.r + 6} /> : null}
                  {isolated.has(placed.id) ? (
                    <circle className="lmv-wb-hollow" cx={position.x} cy={position.y} r={placed.r + 3.5} />
                  ) : null}
                  {labelPlacement.get(placed.id) === undefined ? null : (
                    <text
                      className="lmv-wb-label"
                      x={labelPlacement.get(placed.id)?.x}
                      y={position.y + placed.r + 15}
                      textAnchor={labelPlacement.get(placed.id)?.anchor}
                    >
                      {labelPlacement.get(placed.id)?.text}
                    </text>
                  )}
                  {selected && props.scope === 'local' && props.view.nodes.length === 1 ? (
                    <text className="lmv-wb-label lmv-wb-label-hint" x={position.x} y={position.y + placed.r + 34}>
                      {translate('links.localIsolated')}
                    </text>
                  ) : null}
                </g>
              )
            })}
          </g>
        </svg>
      )}

      {layout.hidden > 0 ? (
        <span className="lmv-wb-note lmv-wb-note-top">{translate('links.hidden', { count: layout.hidden })}</span>
      ) : null}

      {props.pathMode ? (
        <div className="lmv-wb-pathbar" role="status">
          <Icon name="route" size={14} />
          <span>
            {props.pathStart === null
              ? translate('links.pathStart')
              : props.pathEnd === null
                ? translate('links.pathEnd')
                : props.path === null
                  ? translate('links.pathNone')
                  : translate('links.pathFound', { count: Math.max(0, props.path.length - 1) })}
          </span>
          {props.path !== null ? (
            <button type="button" className="lmv-wb-pathbar-clear" onClick={props.onPathDetails}>
              {translate('links.pathDetails')}
            </button>
          ) : null}
          <button type="button" className="lmv-wb-pathbar-clear" onClick={props.onClearPath}>
            {translate('links.pathClear')}
          </button>
        </div>
      ) : null}

      <div className="lmv-wb-legend">
        <span className="lmv-wb-legend-item"><span className="lmv-wb-legend-line" />{translate('links.legendManual')}</span>
        <span className="lmv-wb-legend-item"><span className="lmv-wb-legend-line is-auto" />{translate('links.legendAuto')}</span>
        {props.view.derivedEdges.length > 0 ? (
          <span className="lmv-wb-legend-item"><span className="lmv-wb-legend-line is-derived" />{translate('links.legendDerived')}</span>
        ) : null}
        <span className="lmv-wb-legend-item"><span className="lmv-wb-legend-hollow" />{translate('links.legendIsolated')}</span>
      </div>

      <div className="lmv-wb-zoombar" role="group" aria-label={`${translate('links.kickerView')}`}>
        <button type="button" title={translate('links.zoomIn')} aria-label={translate('links.zoomIn')} onClick={() => zoomBy(1.3)}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" title={translate('links.zoomOut')} aria-label={translate('links.zoomOut')} onClick={() => zoomBy(1 / 1.3)}>
          <Icon name="minus" size={14} />
        </button>
        <button type="button" title={translate('links.fit')} aria-label={translate('links.fit')} onClick={fitAll}>
          <Icon name="fit" size={14} />
        </button>
        <button type="button" title={translate('links.center')} aria-label={translate('links.center')} onClick={() => centerOn(props.focusId)}>
          <Icon name="target" size={14} />
        </button>
        <button
          type="button"
          title={translate('links.reset')}
          aria-label={translate('links.reset')}
          onClick={() => {
            setManual(new Map())
            fitAll()
          }}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {props.compat ? <span className="lmv-wb-compat-chip" title={translate('links.compat')}>{translate('links.compatShort')}</span> : null}

      {!props.pathMode && props.data.stats.edges === 0 && layout.nodes.length > 0 ? (
        <div className="lmv-wb-zero">
          <div className="lmv-wb-zero-text">
            <b>{translate('links.zeroLinks')}</b>
            <span>{translate('links.zeroLinksHint')}</span>
          </div>
          <Button variant="primary" size="sm" disabled={props.compat || props.relinkBusy} onClick={props.onZeroRelink}>
            <Icon name="spark" size={13} />
            {translate('links.relink')}
          </Button>
        </div>
      ) : null}

      {size.w > 0 && layout.nodes.length === 0 && props.data.nodes.length > 0 ? (
        <div className="lmv-wb-no-results">
          <Empty title={translate('links.noResults')} hint={translate('links.noResultsHint')} />
        </div>
      ) : null}

      {hovered !== null && hoveredPlaced !== null && tip !== null ? (
        <div className={`lmv-wb-tip${tip.below ? ' is-below' : ''}`} style={{ left: tip.x, top: tip.y }}>
          <span className="lmv-wb-tip-title">{hovered.title}</span>
          <span className="lmv-wb-tip-meta">
            {typeLabel(hovered.type)}
            <span className="lmv-sep">·</span>
            {statusLabel(hovered.status)}
            <span className="lmv-sep">·</span>
            {translate('links.degrees', { in: hovered.inDegree, out: hovered.outDegree })}
          </span>
          {hovered.preview.length === 0 ? null : <span className="lmv-wb-tip-preview">{hovered.preview}</span>}
          <span className="lmv-wb-tip-hint">{translate('links.doubleClick')}</span>
        </div>
      ) : null}
    </section>
  )
}

/* ================================================================= detail === */

interface DetailProps {
  data: LinkGraphResponse
  node: LinkGraphNode | null
  compat: boolean
  pathMode: boolean
  pathStart: string | null
  pathEnd: string | null
  path: readonly string[] | null
  onInspect: (id: string) => void
  onOpen: (id: string) => void
  onExplore: (id: string) => void
  onLocate: () => void
  onPickTag: (tag: string) => void
  onClearPath: () => void
  onClose: () => void
}

function DetailRail(props: DetailProps): ReactElement {
  const translate = useT()
  const node = props.node
  const nodeMap = useMemo(() => {
    const map = new Map<string, LinkGraphNode>()
    for (const item of props.data.nodes) map.set(item.id, item)
    return map
  }, [props.data])

  const related = useMemo(() => {
    if (node === null) {
      return { outgoing: [], auto: [], backlinks: [], shared: [] }
    }
    const outgoing = props.data.edges.filter((edge) => edge.source === node.id && !edge.auto)
    const auto = props.data.edges.filter((edge) => edge.auto && (edge.source === node.id || edge.target === node.id))
    const backlinks = props.data.edges.filter((edge) => edge.target === node.id && !edge.auto)
    const connected = new Set<string>()
    for (const edge of [...outgoing, ...auto, ...backlinks]) {
      connected.add(edge.source)
      connected.add(edge.target)
    }
    const generic = new Set(Object.values(TYPE_DESCRIPTORS).map((descriptor) => descriptor.defaultTag))
    const sharedFiltered: { peer: LinkGraphNode; tag: string }[] = []
    for (const peer of props.data.nodes) {
      if (peer.id === node.id || connected.has(peer.id)) continue
      const tag = peer.tags.find((candidate) => node.tags.includes(candidate) && !generic.has(candidate))
      if (tag === undefined) continue
      sharedFiltered.push({ peer, tag })
      if (sharedFiltered.length >= 8) break
    }
    return { outgoing, auto, backlinks, shared: sharedFiltered }
  }, [node, props.data])

  return (
    <aside className="lmv-wb-right" aria-label={translate('links.kickerDetail')}>
      <div className="lmv-wb-right-head">
        <span className="lmv-kicker">{translate('links.kickerDetail')}</span>
        <button
          type="button"
          className="lmv-wb-icon-btn lmv-wb-only-narrow"
          aria-label={translate('links.detailClose')}
          title={translate('links.detailClose')}
          onClick={props.onClose}
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="lmv-wb-detail">
        {props.pathMode ? (
          <div className="lmv-wb-path-panel">
            <span className="lmv-kicker">{translate('links.pathMode')}</span>
            {props.pathStart === null ? (
              <span className="lmv-wb-hint">{translate('links.pathStart')}</span>
            ) : props.pathEnd === null ? (
              <span className="lmv-wb-hint">{translate('links.pathEnd')}</span>
            ) : props.path === null ? (
              <Notice kind="warn">{translate('links.pathNone')}</Notice>
            ) : (
              <>
                <span className="lmv-wb-path-count">{translate('links.pathFound', { count: Math.max(0, props.path.length - 1) })}</span>
                <div className="lmv-wb-path-list">
                  {props.path.map((id, index) => (
                    <button key={`${id}-${String(index)}`} type="button" className="lmv-wb-path-node" onClick={() => props.onInspect(id)}>
                      <span className="lmv-wb-path-index">{index + 1}</span>
                      <span>{nodeMap.get(id)?.title ?? id}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="lmv-wb-path-actions">
              <span className="lmv-wb-hint">{translate('links.pathHint')}</span>
              <Button variant="ghost" size="sm" onClick={props.onClearPath}>
                {translate('links.pathClear')}
              </Button>
            </div>
          </div>
        ) : null}

        {node === null ? (
          <div className="lmv-wb-detail-empty">
            <Empty title={translate('links.noneSelected')} hint={translate('links.noneSelectedHint')} />
          </div>
        ) : (
          <>
            <div className="lmv-wb-detail-title-row">
              <span className={`lmv-wb-dot lmv-wb-tone-${toneOfType(node.type)}`} aria-hidden="true" />
              <h2 className="lmv-wb-detail-title">{node.title}</h2>
            </div>
            <div className="lmv-wb-detail-badges">
              <Badge kind="plain">{typeLabel(node.type)}</Badge>
              <Badge kind={statusKind(node.status)}>{statusLabel(node.status)}</Badge>
              {node.pinned ? <Badge kind="warn">{translate('detail.pinned')}</Badge> : null}
            </div>
            {node.preview.length === 0 ? null : <p className="lmv-wb-detail-preview">{node.preview}</p>}
            <span className="lmv-wb-detail-meta">
              {translate('links.metaUpdated')} {formatTime(node.updatedAt)}
            </span>
            <div className="lmv-wb-detail-tags">
              {node.tags.length === 0 ? (
                <span className="lmv-wb-hint">{translate('links.noTags')}</span>
              ) : (
                node.tags.map((tag) => (
                  <button key={tag} type="button" className="lmv-wb-tag" onClick={() => props.onPickTag(tag)}>
                    #{tag}
                  </button>
                ))
              )}
            </div>

            <div className="lmv-wb-detail-stats">
              <MiniStat label={translate('links.statOut')} value={node.outDegree} />
              <MiniStat label={translate('links.statIn')} value={node.inDegree} />
              <MiniStat label={translate('links.statAuto')} value={related.auto.length} />
              <MiniStat label={translate('links.statTag')} value={related.shared.length} />
            </div>

            <div className="lmv-wb-detail-actions">
              <Button variant="primary" size="sm" onClick={() => props.onOpen(node.id)}>
                {translate('links.open')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => props.onExplore(node.id)}>
                <Icon name="route" size={13} />
                {translate('links.focusExplore')}
              </Button>
              <button
                type="button"
                className="lmv-wb-icon-btn"
                title={translate('links.locate')}
                aria-label={translate('links.locate')}
                onClick={props.onLocate}
              >
                <Icon name="target" size={14} />
              </button>
            </div>

            <RelationGroup
              title={translate('links.outgoing')}
              empty={translate('links.noOutgoing')}
              rows={related.outgoing.map((edge) => ({
                key: `${edge.source}-${edge.target}`,
                direction: 'out',
                peer: nodeMap.get(edge.target),
                detail: edge.context.trim().length === 0 ? translate('links.noContext') : edge.context,
                kind: 'manual',
                onClick: () => props.onInspect(edge.target),
              }))}
            />
            {related.auto.length === 0 ? null : (
              <RelationGroup
                title={translate('links.autoLinks')}
                empty={translate('links.noAutoLinks')}
                rows={related.auto.map((edge) => {
                  const outgoing = edge.source === node.id
                  const peerId = outgoing ? edge.target : edge.source
                  return {
                    key: `auto-${edge.source}-${edge.target}`,
                    direction: outgoing ? 'out' : 'in',
                    peer: nodeMap.get(peerId),
                    detail: edge.reason ?? translate('links.noContext'),
                    kind: 'auto',
                    onClick: () => props.onInspect(peerId),
                  }
                })}
              />
            )}
            <RelationGroup
              title={translate('links.backlinks')}
              empty={translate('links.noBacklinks')}
              rows={related.backlinks.map((edge) => ({
                key: `${edge.source}-${edge.target}`,
                direction: 'in',
                peer: nodeMap.get(edge.source),
                detail: edge.context.trim().length === 0 ? translate('links.noContext') : edge.context,
                kind: 'manual',
                onClick: () => props.onInspect(edge.source),
              }))}
            />
            {related.shared.length === 0 ? null : (
              <RelationGroup
                title={translate('links.sharedTags')}
                empty={translate('links.noSharedTags')}
                rows={related.shared.map((entry) => ({
                  key: `tag-${entry.peer.id}`,
                  direction: 'tag',
                  peer: entry.peer,
                  detail: `#${entry.tag}`,
                  kind: 'derived',
                  onClick: () => props.onInspect(entry.peer.id),
                }))}
              />
            )}
            {props.compat ? <span className="lmv-wb-hint">{translate('links.compat')}</span> : null}
          </>
        )}
      </div>
    </aside>
  )
}

interface RelationRow {
  key: string
  direction: string
  peer: LinkGraphNode | undefined
  detail: string
  kind: string
  onClick: () => void
}

function RelationGroup(props: { title: string; empty: string; rows: readonly RelationRow[] }): ReactElement {
  const translate = useT()
  return (
    <section className="lmv-wb-rel-group">
      <div className="lmv-wb-rel-head">
        <span className="lmv-kicker">{props.title}</span>
        <span className="lmv-wb-chip-count">{props.rows.length}</span>
      </div>
      {props.rows.length === 0 ? (
        <span className="lmv-wb-hint">{props.empty}</span>
      ) : (
        <div className="lmv-wb-rel-list">
          {props.rows.map((row) => (
            <button key={row.key} type="button" className="lmv-wb-rel" onClick={row.onClick}>
              <span className={`lmv-wb-rel-dir lmv-wb-rel-dir-${row.direction}`} aria-hidden="true">
                {row.direction === 'in' ? '←' : row.direction === 'out' ? '→' : '◇'}
              </span>
              <span className="lmv-wb-rel-main">
                <span className="lmv-wb-rel-title">
                  {row.peer?.title ?? '—'}
                  {row.kind === 'auto' ? <span className="lmv-wb-badge">{translate('links.autoBadge')}</span> : null}
                  {row.kind === 'derived' ? <span className="lmv-wb-badge">{translate('links.derivedBadge')}</span> : null}
                </span>
                <span className="lmv-wb-rel-meta">{row.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

/* ================================================================= layout === */

/**
 * Place the visible graph.
 *
 * Deterministic: the same nodes always land in the same pixels. That matters
 * more than it sounds — a layout that jitters on every filter change makes the
 * picture unreadable, and a layout that is random makes "I saw it over there"
 * useless.
 */
export function computeLayout(input: LayoutInput): LayoutResult {
  const width = Math.max(240, input.width)
  const height = Math.max(220, input.height)
  const ordered = [...input.nodes].sort(
    (a, b) => degreeOf(b) - degreeOf(a) || a.id.localeCompare(b.id),
  )
  let kept = ordered.slice(0, MAX_LAYOUT_NODES)
  const focusId = input.focusId
  if (focusId !== null && !kept.some((node) => node.id === focusId)) {
    const focusNode = ordered.find((node) => node.id === focusId)
    if (focusNode !== undefined) {
      kept = [focusNode, ...ordered.filter((node) => node.id !== focusId).slice(0, MAX_LAYOUT_NODES - 1)]
    }
  }
  const hidden = Math.max(0, input.nodes.length - kept.length)
  if (kept.length === 0) return { nodes: [], edges: [], hidden: 0, width, height }

  const usableW = Math.max(80, width - SIDE_PAD * 2)
  const usableH = Math.max(80, height - TOP_PAD - BOTTOM_PAD)
  const cx = width / 2
  const cy = TOP_PAD + usableH / 2
  const count = kept.length
  const spread = Math.min(usableW, usableH) * 0.42
  const positions = new Map<string, { x: number; y: number }>()

  kept.forEach((node, index) => {
    if (node.id === focusId) {
      positions.set(node.id, { x: cx, y: cy })
      return
    }
    const angle = hashAngle(node.id) + index * GOLDEN_ANGLE
    const radius = spread * Math.sqrt((index + 0.7) / count)
    positions.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius })
  })

  const keptIds = new Set(kept.map((node) => node.id))
  const springs: { source: string; target: string; weight: number }[] = []
  for (const edge of input.edges) {
    if (!keptIds.has(edge.source) || !keptIds.has(edge.target)) continue
    springs.push({ source: edge.source, target: edge.target, weight: edge.auto ? 0.05 : 0.07 })
  }
  for (const edge of input.derivedEdges ?? []) {
    if (!keptIds.has(edge.source) || !keptIds.has(edge.target)) continue
    springs.push({ source: edge.source, target: edge.target, weight: 0.018 })
  }

  const iterations = count <= 120 ? ITERATIONS : count <= 240 ? 120 : 80
  const area = usableW * usableH
  const k = Math.sqrt(area / Math.max(1, count)) * 0.74

  for (let step = 0; step < iterations; step += 1) {
    const temperature = (1 - step / iterations) * Math.min(usableW, usableH) * 0.09
    const disp = new Map<string, { x: number; y: number }>()
    for (const node of kept) disp.set(node.id, { x: 0, y: 0 })

    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const a = kept[i]
        const b = kept[j]
        if (a === undefined || b === undefined) continue
        const pa = positions.get(a.id)
        const pb = positions.get(b.id)
        if (pa === undefined || pb === undefined) continue
        let dx = pa.x - pb.x
        let dy = pa.y - pb.y
        let distance = Math.hypot(dx, dy)
        if (distance < 0.01) {
          dx = 0.11 * (i - j + 0.5)
          dy = 0.13
          distance = Math.hypot(dx, dy)
        }
        const force = (k * k) / distance
        const ux = dx / distance
        const uy = dy / distance
        push(disp, a.id, ux * force, uy * force)
        push(disp, b.id, -ux * force, -uy * force)
      }
    }

    for (const spring of springs) {
      const pa = positions.get(spring.source)
      const pb = positions.get(spring.target)
      if (pa === undefined || pb === undefined) continue
      const dx = pa.x - pb.x
      const dy = pa.y - pb.y
      const distance = Math.max(0.01, Math.hypot(dx, dy))
      const force = ((distance * distance) / k) * spring.weight
      const ux = dx / distance
      const uy = dy / distance
      push(disp, spring.source, -ux * force, -uy * force)
      push(disp, spring.target, ux * force, uy * force)
    }

    for (const node of kept) {
      if (node.id === focusId) continue
      const point = positions.get(node.id)
      if (point === undefined) continue
      push(disp, node.id, (cx - point.x) * 0.014, (cy - point.y) * 0.014)
    }

    for (const node of kept) {
      if (node.id === focusId) continue
      const point = positions.get(node.id)
      const delta = disp.get(node.id)
      if (point === undefined || delta === undefined) continue
      const length = Math.hypot(delta.x, delta.y)
      if (length < 0.0001) continue
      const travel = Math.min(length, temperature)
      point.x = Math.min(width - SIDE_PAD, Math.max(SIDE_PAD, point.x + (delta.x / length) * travel))
      point.y = Math.min(height - BOTTOM_PAD, Math.max(TOP_PAD, point.y + (delta.y / length) * travel))
    }
  }

  fitPositions(
    kept.map((node) => node.id),
    positions,
    { width, height, usableW, usableH, cx, cy, focusId },
  )
  relax(kept, positions, focusId)
  for (const node of kept) {
    const point = positions.get(node.id)
    if (point === undefined) continue
    point.x = Math.min(width - SIDE_PAD, Math.max(SIDE_PAD, point.x))
    point.y = Math.min(height - BOTTOM_PAD, Math.max(TOP_PAD, point.y))
  }

  const placedNodes: PlacedNode[] = kept.map((node, index) => {
    const point = positions.get(node.id) ?? { x: cx, y: cy }
    return {
      id: node.id,
      x: point.x,
      y: point.y,
      r: radiusOf(node, node.id === focusId),
      label: count <= 24 || index < 18,
    }
  })
  const placedById = new Map<string, PlacedNode>()
  for (const placed of placedNodes) placedById.set(placed.id, placed)

  const placedEdges: PlacedEdge[] = []
  const seen = new Set<string>()
  const addEdge = (edge: { source: string; target: string; auto: boolean }, derived: boolean): void => {
    const key = `${edge.source}->${edge.target}:${derived ? 'd' : edge.auto ? 'a' : 'm'}`
    if (seen.has(key)) return
    seen.add(key)
    const from = placedById.get(edge.source)
    const to = placedById.get(edge.target)
    if (from === undefined || to === undefined) return
    placedEdges.push({
      key,
      source: edge.source,
      target: edge.target,
      path: edgePath(from, to, edge.source < edge.target ? 1 : -1, derived),
      auto: edge.auto,
      derived,
    })
  }
  for (const edge of input.edges) {
    if (!keptIds.has(edge.source) || !keptIds.has(edge.target)) continue
    addEdge(edge, false)
  }
  for (const edge of input.derivedEdges ?? []) {
    if (!keptIds.has(edge.source) || !keptIds.has(edge.target)) continue
    addEdge({ source: edge.source, target: edge.target, auto: false }, true)
  }

  return { nodes: placedNodes, edges: placedEdges, hidden, width, height }
}

function fitPositions(
  ids: readonly string[],
  positions: Map<string, { x: number; y: number }>,
  context: { width: number; height: number; usableW: number; usableH: number; cx: number; cy: number; focusId: string | null },
): void {
  if (ids.length <= 1) {
    const only = ids[0]
    if (only !== undefined) positions.set(only, { x: context.cx, y: context.cy })
    return
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const id of ids) {
    const point = positions.get(id)
    if (point === undefined) continue
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const scale = Math.min(context.usableW / spanX, context.usableH / spanY, 1.45)
  const anchor = context.focusId === null ? null : positions.get(context.focusId)
  const originX = anchor?.x ?? (minX + maxX) / 2
  const originY = anchor?.y ?? (minY + maxY) / 2
  for (const id of ids) {
    const point = positions.get(id)
    if (point === undefined) continue
    point.x = context.cx + (point.x - originX) * scale
    point.y = context.cy + (point.y - originY) * scale
    point.x = Math.min(context.width - SIDE_PAD, Math.max(SIDE_PAD, point.x))
    point.y = Math.min(context.height - BOTTOM_PAD, Math.max(TOP_PAD, point.y))
  }
}

/** A short relaxation pass so node cores never overlap, even in a dense cluster. */
function relax(
  nodes: readonly LinkGraphNode[],
  positions: Map<string, { x: number; y: number }>,
  focusId: string | null,
): void {
  const placed = nodes.map((node) => ({
    id: node.id,
    r: radiusOf(node, node.id === focusId),
  }))
  for (let pass = 0; pass < 18; pass += 1) {
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i]
        const b = placed[j]
        if (a === undefined || b === undefined) continue
        const pa = positions.get(a.id)
        const pb = positions.get(b.id)
        if (pa === undefined || pb === undefined) continue
        const min = a.r + b.r + 8
        let dx = pb.x - pa.x
        let dy = pb.y - pa.y
        let distance = Math.hypot(dx, dy)
        if (distance >= min) continue
        if (distance < 0.01) {
          dx = 0.2 * (i - j + 0.5)
          dy = 0.2
          distance = Math.hypot(dx, dy)
        }
        const shift = (min - distance) / 2
        const ux = dx / distance
        const uy = dy / distance
        if (a.id !== focusId) {
          pa.x -= ux * shift
          pa.y -= uy * shift
        }
        if (b.id !== focusId) {
          pb.x += ux * shift
          pb.y += uy * shift
        }
      }
    }
  }
}

/** A quadratic between two node boundaries; reciprocal links bend opposite ways. */
function edgePath(from: PlacedNode, to: PlacedNode, sign: number, derived: boolean): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / distance
  const uy = dy / distance
  const startX = from.x + ux * (from.r + 2)
  const startY = from.y + uy * (from.r + 2)
  const endX = to.x - ux * (to.r + 4)
  const endY = to.y - uy * (to.r + 4)
  if (derived) return `M${round(startX)} ${round(startY)} L${round(endX)} ${round(endY)}`
  const bend = Math.min(34, distance * 0.13) * sign
  const midX = (startX + endX) / 2 - uy * bend
  const midY = (startY + endY) / 2 + ux * bend
  return `M${round(startX)} ${round(startY)} Q${round(midX)} ${round(midY)} ${round(endX)} ${round(endY)}`
}

/** Convex hull with a soft margin, or null when the cluster is too small. */
function hullPath(points: readonly { x: number; y: number }[]): string | null {
  if (points.length < 3) return null
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: { x: number; y: number }[] = []
  for (const point of sorted) {
    while (lower.length >= 2) {
      const a = lower[lower.length - 2]
      const b = lower[lower.length - 1]
      if (a === undefined || b === undefined || cross(a, b, point) > 0) break
      lower.pop()
    }
    lower.push(point)
  }
  const upper: { x: number; y: number }[] = []
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index]
    if (point === undefined) continue
    while (upper.length >= 2) {
      const a = upper[upper.length - 2]
      const b = upper[upper.length - 1]
      if (a === undefined || b === undefined || cross(a, b, point) > 0) break
      upper.pop()
    }
    upper.push(point)
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1))
  if (hull.length < 3) return null
  const centroid = hull.reduce((acc, point) => ({ x: acc.x + point.x / hull.length, y: acc.y + point.y / hull.length }), { x: 0, y: 0 })
  const margin = hull.map((point) => {
    const dx = point.x - centroid.x
    const dy = point.y - centroid.y
    const length = Math.max(0.01, Math.hypot(dx, dy))
    return { x: point.x + (dx / length) * 16, y: point.y + (dy / length) * 16 }
  })
  const first = margin[0]
  if (first === undefined) return null
  return `M${round(first.x)} ${round(first.y)}${margin
    .slice(1)
    .map((point) => ` L${round(point.x)} ${round(point.y)}`)
    .join('')} Z`
}

function push(map: Map<string, { x: number; y: number }>, id: string, x: number, y: number): void {
  const entry = map.get(id)
  if (entry === undefined) return
  entry.x += x
  entry.y += y
}

function isPlaced(value: PlacedNode | undefined): value is PlacedNode {
  return value !== undefined
}

function radiusOf(node: LinkGraphNode, focus: boolean): number {
  const base = 6 + Math.sqrt(node.inDegree + node.outDegree) * 2.2
  return Math.min(19, base) + (focus ? 3 : 0)
}

function degreeOf(node: LinkGraphNode): number {
  return node.inDegree + node.outDegree
}

function toneOfType(type: string): string {
  if (type === 'profile' || type === 'preference') return 'blue'
  if (type === 'project' || type === 'project-state') return 'green'
  if (type === 'decision') return 'amber'
  if (type === 'task') return 'orange'
  if (type === 'knowledge') return 'teal'
  if (type === 'experience') return 'violet'
  return 'muted'
}

function matchesNode(node: LinkGraphNode, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return false
  return node.title.toLowerCase().includes(needle) || node.tags.some((tag) => tag.toLowerCase().includes(needle))
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function shortTitle(title: string): string {
  return title.length > 13 ? `${title.slice(0, 13)}…` : title
}

function hashAngle(seed: string): number {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (((hash >>> 0) % 10_000) / 10_000) * Math.PI * 2
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
