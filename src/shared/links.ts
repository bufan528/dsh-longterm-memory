/**
 * The link graph: nodes, directed edges, graph analysis and view selection.
 *
 * Everything here is derived from the in-memory index, so it can never disagree
 * with search or recall. The page uses it for the canvas, the relation lists and
 * the structural filters; nothing reads a file or persists state.
 *
 * Truthfulness rules encoded in this module:
 * - an edge exists only when the note really recorded a `[[wikilink]]` (manual)
 *   or the plugin really wrote one into its generated block (automatic);
 * - shared tags are only ever *derived* suggestions, returned separately and
 *   never mixed into `edges`;
 * - "isolated", "hub", "bridge" and "component" are computed from the real
 *   undirected graph, never guessed from titles or text length.
 *
 * @module dsh-longterm-memory/shared/links
 */

import { TYPE_DESCRIPTORS } from './types.js'
import { createLinkResolver, deriveIndex, emptyIndex, type IndexRecord, type MemoryIndex } from './search.js'

/** Above this many visible nodes the canvas draws the most connected subset. */
export const LINK_RENDER_LIMIT = 320

/** One memory in the graph. */
export interface LinkGraphNode {
  id: string
  title: string
  type: string
  status: string
  pinned: boolean
  tags: string[]
  /** First ~320 characters of the summary, for the node inspector. */
  preview: string
  createdAt: string
  updatedAt: string
  /** Links pointing at this memory. */
  inDegree: number
  /** Links this memory points at. */
  outDegree: number
}

/** One resolved `source → target` relation. */
export interface LinkGraphEdge {
  source: string
  target: string
  /** The line the link was written on, or an empty string for `related`. */
  context: string
  /** True when the plugin inferred this edge; false when the user wrote it. */
  auto: boolean
  /** The extractor's explanation, when an automatic edge recorded one. */
  reason?: string
}

/** A `[[target]]` that matches no memory. */
export interface LinkGraphDangling {
  source: string
  sourceTitle: string
  target: string
  context: string
  auto: boolean
}

export interface LinkGraphStats {
  nodes: number
  edges: number
  /** Nodes with at least one incoming or outgoing link. */
  linked: number
  /** Nodes with neither. */
  orphans: number
  dangling: number
  /** Edges the plugin inferred. */
  auto: number
}

export interface LinkGraphResponse {
  nodes: LinkGraphNode[]
  edges: LinkGraphEdge[]
  dangling: LinkGraphDangling[]
  /** When the index this graph came from was built. */
  builtAt: string
  stats: LinkGraphStats
}

/**
 * Build the graph from bare records.
 *
 * The `links` RPC only exists on a current host. When the page is served by an
 * older backend, the client gets the same records from `search` and derives the
 * graph here, so the feature degrades instead of showing "not found".
 */
export function buildLinkGraphFromRecords(records: readonly IndexRecord[]): LinkGraphResponse {
  const index = emptyIndex('')
  for (const record of records) index.records.set(record.id, record)
  deriveIndex(index)
  return buildLinkGraph(index)
}

/** Build the complete graph for one index. */
export function buildLinkGraph(index: MemoryIndex): LinkGraphResponse {
  const resolve = createLinkResolver(index)
  const edges: LinkGraphEdge[] = []
  const dangling: LinkGraphDangling[] = []
  const inDegree = new Map<string, number>()
  const outDegree = new Map<string, number>()

  for (const record of index.records.values()) {
    inDegree.set(record.id, 0)
    outDegree.set(record.id, 0)
  }

  for (const record of index.records.values()) {
    const seen = new Set<string>()
    const autoTargets = new Set(record.autoLinks ?? [])
    for (const target of record.links) {
      const context = record.linkContexts?.[target]?.[0] ?? ''
      const auto = autoTargets.has(target)
      const targetId = resolve(target)
      if (targetId === undefined) {
        dangling.push({ source: record.id, sourceTitle: record.title, target, context, auto })
        continue
      }
      if (targetId === record.id || seen.has(targetId)) continue
      seen.add(targetId)
      const reason = auto ? record.autoLinkReasons?.[target] : undefined
      edges.push({
        source: record.id,
        target: targetId,
        context,
        auto,
        ...(reason === undefined ? {} : { reason }),
      })
      outDegree.set(record.id, (outDegree.get(record.id) ?? 0) + 1)
      inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1)
    }
  }

  const nodes: LinkGraphNode[] = []
  for (const record of index.records.values()) {
    nodes.push({
      id: record.id,
      title: record.title,
      type: record.type,
      status: record.status,
      pinned: record.pinned,
      tags: [...record.tags],
      preview: record.preview.slice(0, 320),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      inDegree: inDegree.get(record.id) ?? 0,
      outDegree: outDegree.get(record.id) ?? 0,
    })
  }
  nodes.sort((a, b) => {
    const degreeA = a.inDegree + a.outDegree
    const degreeB = b.inDegree + b.outDegree
    if (degreeB !== degreeA) return degreeB - degreeA
    return a.title.localeCompare(b.title, 'zh-Hans-CN')
  })

  const linked = nodes.filter((node) => node.inDegree + node.outDegree > 0).length
  dangling.sort((a, b) => a.sourceTitle.localeCompare(b.sourceTitle, 'zh-Hans-CN'))
  return {
    nodes,
    edges,
    dangling,
    builtAt: index.builtAt,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      linked,
      orphans: nodes.length - linked,
      dangling: dangling.length,
      auto: edges.filter((edge) => edge.auto).length,
    },
  }
}

/** One algorithm-detected community. */
export interface GraphCluster {
  /** Stable index after sorting by size; used only as a React key. */
  key: number
  nodeIds: string[]
}

/** Structural facts about the real graph. */
export interface LinkGraphAnalysis {
  /** Undirected weight: in-degree + out-degree. */
  degree: Record<string, number>
  /** Nodes with no incoming or outgoing relation. */
  isolated: string[]
  /** Nodes with degree >= 3, most connected first. */
  hubs: string[]
  /** Articulation points with degree >= 2. */
  bridges: string[]
  /** Groups of mutually reachable nodes, largest first. */
  components: string[][]
  /** Label-propagation communities with at least two members. */
  clusters: GraphCluster[]
  avgDegree: number
}

/** Build the undirected adjacency used by paths, components and communities. */
function undirectedAdjacency(graph: LinkGraphResponse): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  for (const node of graph.nodes) adjacency.set(node.id, new Set())
  for (const edge of graph.edges) {
    const from = adjacency.get(edge.source)
    const to = adjacency.get(edge.target)
    if (from === undefined || to === undefined || edge.source === edge.target) continue
    from.add(edge.target)
    to.add(edge.source)
  }
  return adjacency
}

/** Analyse the graph. Nothing here consults titles, tags or text length. */
export function analyseLinkGraph(graph: LinkGraphResponse): LinkGraphAnalysis {
  const adjacency = undirectedAdjacency(graph)
  const ids = [...adjacency.keys()].sort(compareId)
  const degree: Record<string, number> = {}
  for (const node of graph.nodes) {
    degree[node.id] = node.inDegree + node.outDegree
  }

  const isolated = ids.filter((id) => adjacency.get(id)?.size === 0)
  const hubs = ids
    .filter((id) => (degree[id] ?? 0) >= 3)
    .sort((a, b) => (degree[b] ?? 0) - (degree[a] ?? 0) || compareId(a, b))

  const components: string[][] = []
  const seen = new Set<string>()
  for (const start of ids) {
    if (seen.has(start)) continue
    const component: string[] = []
    const queue = [start]
    seen.add(start)
    while (queue.length > 0) {
      const id = queue.shift()
      if (id === undefined) continue
      component.push(id)
      for (const neighbour of adjacency.get(id) ?? []) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        queue.push(neighbour)
      }
    }
    components.push(component)
  }
  components.sort((a, b) => b.length - a.length || compareId(a[0] ?? '', b[0] ?? ''))

  const bridges = articulationPoints(ids, adjacency).filter((id) => (adjacency.get(id)?.size ?? 0) >= 2)

  const totalDegree = Object.values(degree).reduce((sum, value) => sum + value, 0)
  return {
    degree,
    isolated,
    hubs,
    bridges: bridges.sort(compareId),
    components,
    clusters: labelPropagation(ids, adjacency),
    avgDegree: ids.length === 0 ? 0 : totalDegree / ids.length,
  }
}

/**
 * Tarjan articulation points, iterative on the recursion stack's simple form.
 *
 * The vault graph is small (hundreds of nodes at most), and this runs once per
 * graph load, never per pointer move.
 */
function articulationPoints(ids: readonly string[], adjacency: Map<string, Set<string>>): string[] {
  const discovery = new Map<string, number>()
  const low = new Map<string, number>()
  const parent = new Map<string, string | null>()
  const points = new Set<string>()
  let clock = 0

  const visit = (id: string): void => {
    clock += 1
    discovery.set(id, clock)
    low.set(id, clock)
    let children = 0
    for (const neighbour of [...(adjacency.get(id) ?? [])].sort(compareId)) {
      if (!discovery.has(neighbour)) {
        children += 1
        parent.set(neighbour, id)
        visit(neighbour)
        low.set(id, Math.min(low.get(id) ?? 0, low.get(neighbour) ?? 0))
        const parentOfId = parent.get(id) ?? null
        if (parentOfId === null && children > 1) points.add(id)
        if (parentOfId !== null && (low.get(neighbour) ?? 0) >= (discovery.get(id) ?? 0)) points.add(id)
      } else if (neighbour !== parent.get(id)) {
        low.set(id, Math.min(low.get(id) ?? 0, discovery.get(neighbour) ?? 0))
      }
    }
  }

  for (const id of ids) {
    if (discovery.has(id)) continue
    parent.set(id, null)
    visit(id)
  }
  return [...points]
}

/**
 * Deterministic label propagation.
 *
 * Isolated nodes are excluded from communities: a "cluster" of one says nothing.
 */
function labelPropagation(ids: readonly string[], adjacency: Map<string, Set<string>>): GraphCluster[] {
  const labels = new Map<string, string>()
  for (const id of ids) labels.set(id, id)

  for (let round = 0; round < 10; round += 1) {
    let changed = false
    for (const id of ids) {
      const neighbours = adjacency.get(id)
      if (neighbours === undefined || neighbours.size === 0) continue
      const counts = new Map<string, number>()
      for (const neighbour of neighbours) {
        const label = labels.get(neighbour) ?? neighbour
        counts.set(label, (counts.get(label) ?? 0) + 1)
      }
      let best: string | null = null
      let bestCount = 0
      for (const [label, count] of counts) {
        if (count > bestCount || (count === bestCount && best !== null && compareId(label, best) < 0)) {
          best = label
          bestCount = count
        }
      }
      if (best !== null && labels.get(id) !== best) {
        labels.set(id, best)
        changed = true
      }
    }
    if (!changed) break
  }

  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const label = labels.get(id) ?? id
    const bucket = groups.get(label)
    if (bucket === undefined) groups.set(label, [id])
    else bucket.push(id)
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .sort((a, b) => b.length - a.length || compareId(a[0] ?? '', b[0] ?? ''))
    .map((nodeIds, key) => ({ key, nodeIds: nodeIds.sort(compareId) }))
}

/**
 * Shortest path over recorded edges, ignoring direction.
 *
 * Directions are dropped because "is there a path between these two memories"
 * is a connectivity question; the relation list still shows the true arrow.
 */
export function shortestLinkPath(graph: LinkGraphResponse, from: string, to: string): string[] | null {
  if (from === to) return graph.nodes.some((node) => node.id === from) ? [from] : null
  const adjacency = undirectedAdjacency(graph)
  if (!adjacency.has(from) || !adjacency.has(to)) return null
  const parent = new Map<string, string | null>([[from, null]])
  const queue = [from]
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) continue
    if (id === to) break
    for (const neighbour of [...(adjacency.get(id) ?? [])].sort(compareId)) {
      if (parent.has(neighbour)) continue
      parent.set(neighbour, id)
      queue.push(neighbour)
    }
  }
  if (!parent.has(to)) return null
  const path: string[] = []
  let cursor: string | null = to
  while (cursor !== null) {
    path.push(cursor)
    cursor = parent.get(cursor) ?? null
  }
  return path.reverse()
}

/** A relation inferred only from a shared tag. Never a recorded edge. */
export interface DerivedTagEdge {
  source: string
  target: string
  tag: string
}

/**
 * Connect memories that share a meaningful tag.
 *
 * Built as a chain per tag (not a clique) so one popular tag cannot explode into
 * a complete subgraph. Generic type tags (`project`, `preference`, …) are
 * ignored: every note of a type carries one, so it carries no relation.
 */
export function buildTagDerivedEdges(nodes: readonly LinkGraphNode[], limitPerNode = 2): DerivedTagEdge[] {
  if (nodes.length < 2) return []
  const generic = new Set(Object.values(TYPE_DESCRIPTORS).map((descriptor) => descriptor.defaultTag))
  const byTag = new Map<string, string[]>()
  for (const node of nodes) {
    for (const tag of new Set(node.tags)) {
      if (tag.trim().length === 0 || generic.has(tag)) continue
      const bucket = byTag.get(tag)
      if (bucket === undefined) byTag.set(tag, [node.id])
      else bucket.push(node.id)
    }
  }

  const hubFloor = Math.max(5, Math.ceil(nodes.length * 0.45))
  const tags = [...byTag.entries()]
    .filter(([, members]) => members.length >= 2 && members.length < hubFloor)
    .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0], 'zh-Hans-CN'))

  const perNode = new Map<string, number>()
  const seen = new Set<string>()
  const out: DerivedTagEdge[] = []
  for (const [tag, members] of tags) {
    const sorted = [...members].sort(compareId)
    for (let index = 0; index + 1 < sorted.length; index += 1) {
      const source = sorted[index]
      const target = sorted[index + 1]
      if (source === undefined || target === undefined) continue
      if ((perNode.get(source) ?? 0) >= limitPerNode || (perNode.get(target) ?? 0) >= limitPerNode) continue
      const key = source < target ? `${source}|${target}` : `${target}|${source}`
      if (seen.has(key)) continue
      seen.add(key)
      perNode.set(source, (perNode.get(source) ?? 0) + 1)
      perNode.set(target, (perNode.get(target) ?? 0) + 1)
      out.push({ source, target, tag })
    }
  }
  return out
}

/** Which recorded edges the canvas shows. */
export type LinkRelationFilter = 'all' | 'manual' | 'auto'

/** Structural node filters computed from the real graph. */
export type LinkSpecialFilter = 'none' | 'isolated' | 'hubs' | 'bridges'

export interface LinkViewOptions {
  /** Highlight query; does not remove nodes. */
  query?: string
  /** Allowed types; empty means every type. */
  types?: readonly string[]
  /** Allowed tags (any match); empty means every tag. */
  tags?: readonly string[]
  /** Inclusive ISO lower bound on `updatedAt`. */
  since?: string | null
  relation?: LinkRelationFilter
  /** Include shared-tag derived edges (never recorded edges). */
  derived?: boolean
  special?: LinkSpecialFilter
  scope?: 'global' | 'local'
  focusId?: string | null
  depth?: 1 | 2 | 3
  /** Restrict to one detected community, when a hull was clicked. */
  cluster?: number | null
}

export interface LinkViewResult {
  /** Visible nodes, in the graph's existing degree order. */
  nodes: LinkGraphNode[]
  /** Visible recorded edges, after the relation filter. */
  edges: LinkGraphEdge[]
  /** Shared-tag suggestions, only when `derived` is on. */
  derivedEdges: DerivedTagEdge[]
  /** Search matches among the visible nodes, for highlight. */
  matched: string[]
  /** Visible nodes before the canvas render cap. */
  totalNodes: number
  /** How many nodes the canvas will not draw. */
  hiddenByCap: number
}

/**
 * Apply the page's filters to the graph.
 *
 * This is the single place where "what the user sees" is decided, so a test can
 * prove that a control actually changes data instead of only its own styling.
 */
export function selectLinkGraph(graph: LinkGraphResponse, options: LinkViewOptions = {}): LinkViewResult {
  const relation = options.relation ?? 'all'
  const special = options.special ?? 'none'
  const scope = options.scope ?? 'global'
  const depth = options.depth ?? 2
  const query = (options.query ?? '').trim().toLowerCase()
  const types = new Set(options.types ?? [])
  const tags = options.tags ?? []
  const since = options.since === null || options.since === undefined ? null : Date.parse(options.since)
  const analysis = analyseLinkGraph(graph)

  const matchesQuery = (node: LinkGraphNode): boolean => {
    if (query.length === 0) return false
    return node.title.toLowerCase().includes(query) || node.tags.some((tag) => tag.toLowerCase().includes(query))
  }

  const passesFacets = (node: LinkGraphNode): boolean => {
    if (types.size > 0 && !types.has(node.type)) return false
    if (tags.length > 0 && !tags.some((tag) => node.tags.includes(tag))) return false
    if (since !== null && !Number.isNaN(since) && Date.parse(node.updatedAt) < since) return false
    return true
  }

  const specialSet =
    special === 'isolated'
      ? new Set(analysis.isolated)
      : special === 'hubs'
        ? new Set(analysis.hubs)
        : special === 'bridges'
          ? new Set(analysis.bridges)
          : null
  const clusterSet =
    options.cluster === null || options.cluster === undefined
      ? null
      : new Set(analysis.clusters.find((cluster) => cluster.key === options.cluster)?.nodeIds ?? [])

  const passesSpecial = (id: string): boolean => {
    if (specialSet !== null && !specialSet.has(id)) return false
    if (clusterSet !== null && !clusterSet.has(id)) return false
    return true
  }

  let visibleIds = new Set(
    graph.nodes.filter((node) => passesFacets(node) && passesSpecial(node.id)).map((node) => node.id),
  )
  const focusId = options.focusId ?? null

  if (scope === 'local' && focusId !== null && graph.nodes.some((node) => node.id === focusId)) {
    const adjacency = undirectedAdjacency(graph)
    const reached = new Set<string>([focusId])
    let frontier = [focusId]
    for (let level = 0; level < depth; level += 1) {
      const next: string[] = []
      for (const id of frontier) {
        for (const neighbour of adjacency.get(id) ?? []) {
          if (reached.has(neighbour)) continue
          reached.add(neighbour)
          next.push(neighbour)
        }
      }
      frontier = next
    }
    // The focus is always kept: a local view that filters out its own centre is
    // not a local view.
    visibleIds = new Set([...visibleIds].filter((id) => reached.has(id)))
    visibleIds.add(focusId)
  }

  const nodes = graph.nodes.filter((node) => visibleIds.has(node.id))
  const kept = new Set(nodes.map((node) => node.id))
  const edges = graph.edges.filter((edge) => {
    if (!kept.has(edge.source) || !kept.has(edge.target)) return false
    if (relation === 'manual') return !edge.auto
    if (relation === 'auto') return edge.auto
    return true
  })
  const connected = new Set<string>()
  for (const edge of edges) {
    connected.add(edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`)
  }
  const derivedEdges =
    options.derived === true
      ? buildTagDerivedEdges(nodes).filter((edge) => {
          const key = edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`
          return !connected.has(key)
        })
      : []
  const matched = nodes.filter(matchesQuery).map((node) => node.id)

  return {
    nodes,
    edges,
    derivedEdges,
    matched,
    totalNodes: nodes.length,
    hiddenByCap: Math.max(0, nodes.length - LINK_RENDER_LIMIT),
  }
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
