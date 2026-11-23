/**
 * Link graph tests: resolution rules, backlink direction, dangling targets and
 * the context snippets the panel shows.
 *
 * @module tests/unit/links.test
 */

import { describe, expect, it } from 'vitest'

import {
  analyseLinkGraph,
  buildLinkGraph,
  buildLinkGraphFromRecords,
  buildTagDerivedEdges,
  selectLinkGraph,
  shortestLinkPath,
} from '../../src/shared/links.js'
import {
  createLinkResolver,
  deriveIndex,
  emptyIndex,
  fieldTokens,
  termWeights,
  type IndexRecord,
  type MemoryIndex,
} from '../../src/shared/search.js'

function makeRecord(overrides: Partial<IndexRecord> & { id: string; title: string }): IndexRecord {
  const tokens = fieldTokens({
    title: overrides.title,
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? [],
    summary: '',
    body: '',
  })
  return {
    id: overrides.id,
    path: overrides.path ?? `Knowledge/${overrides.id}.md`,
    type: overrides.type ?? 'knowledge',
    status: overrides.status ?? 'active',
    title: overrides.title,
    tags: overrides.tags ?? [],
    aliases: overrides.aliases ?? [],
    confidence: overrides.confidence ?? 'medium',
    importance: overrides.importance ?? 50,
    pinned: overrides.pinned ?? false,
    createdAt: overrides.createdAt ?? '2026-10-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-10-01T00:00:00.000Z',
    preview: overrides.preview ?? '',
    terms: termWeights(tokens),
    links: overrides.links ?? [],
    ...(overrides.autoLinks === undefined ? {} : { autoLinks: overrides.autoLinks }),
    ...(overrides.autoLinkReasons === undefined ? {} : { autoLinkReasons: overrides.autoLinkReasons }),
    ...(overrides.linkContexts === undefined ? {} : { linkContexts: overrides.linkContexts }),
    size: overrides.size ?? 100,
    mtimeMs: overrides.mtimeMs ?? 1000,
    checksum: overrides.checksum ?? 'deadbeef',
  }
}

function makeIndex(records: IndexRecord[]): MemoryIndex {
  const index = emptyIndex('/tmp/vault')
  for (const record of records) index.records.set(record.id, record)
  deriveIndex(index)
  return index
}

describe('createLinkResolver', () => {
  const index = makeIndex([
    makeRecord({ id: 'mem_a', title: '甲', aliases: ['Alpha'] }),
    makeRecord({ id: 'mem_b', title: '乙', path: 'Knowledge/b-note.md' }),
  ])

  it('resolves id, title, alias, vault path and file stem', () => {
    const resolve = createLinkResolver(index)
    expect(resolve('mem_a')).toBe('mem_a')
    expect(resolve('甲')).toBe('mem_a')
    expect(resolve('alpha')).toBe('mem_a')
    expect(resolve('Knowledge/b-note')).toBe('mem_b')
    expect(resolve('b-note.md')).toBe('mem_b')
  })

  it('folds case, width and surrounding whitespace', () => {
    const resolve = createLinkResolver(index)
    expect(resolve('  ALPHA ')).toBe('mem_a')
    expect(resolve('Ａｌｐｈａ')).toBe('mem_a')
  })

  it('returns undefined for an unknown target', () => {
    expect(createLinkResolver(index)('不存在的标题')).toBeUndefined()
  })
})

describe('buildLinkGraph', () => {
  it('builds directed edges, degrees and backlinks', () => {
    const index = makeIndex([
      makeRecord({ id: 'a', title: '甲', links: ['乙'] }),
      makeRecord({ id: 'b', title: '乙', links: ['甲'] }),
      makeRecord({ id: 'c', title: '丙', links: ['甲'] }),
    ])
    const graph = buildLinkGraph(index)
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: 'a', target: 'b', context: '', auto: false },
        { source: 'b', target: 'a', context: '', auto: false },
        { source: 'c', target: 'a', context: '', auto: false },
      ]),
    )
    const a = graph.nodes.find((node) => node.id === 'a')
    expect(a).toMatchObject({ inDegree: 2, outDegree: 1 })
    expect(graph.stats).toEqual({ nodes: 3, edges: 3, linked: 3, orphans: 0, dangling: 0, auto: 0 })
  })

  it('reports dangling targets instead of inventing an edge', () => {
    const index = makeIndex([makeRecord({ id: 'a', title: '甲', links: ['还没写的标题'] })])
    const graph = buildLinkGraph(index)
    expect(graph.edges).toEqual([])
    expect(graph.dangling).toEqual([
      { source: 'a', sourceTitle: '甲', target: '还没写的标题', context: '', auto: false },
    ])
    expect(graph.stats).toMatchObject({ edges: 0, linked: 0, orphans: 1, dangling: 1 })
  })

  it('drops self-links and duplicate targets that resolve to the same record', () => {
    const index = makeIndex([
      makeRecord({ id: 'a', title: '甲', aliases: ['甲别名'], links: ['甲', '甲别名', '乙'] }),
      makeRecord({ id: 'b', title: '乙' }),
    ])
    const graph = buildLinkGraph(index)
    expect(graph.edges).toEqual([{ source: 'a', target: 'b', context: '', auto: false }])
    expect(graph.stats).toMatchObject({ edges: 1, dangling: 0 })
  })

  it('marks an inferred target as an automatic edge', () => {
    const index = makeIndex([
      makeRecord({ id: 'a', title: '甲', links: ['乙'], autoLinks: ['乙'] }),
      makeRecord({ id: 'b', title: '乙' }),
    ])
    expect(buildLinkGraph(index).edges[0]).toMatchObject({ source: 'a', target: 'b', auto: true })
  })

  it('carries the recorded context line onto the edge', () => {
    const index = makeIndex([
      makeRecord({
        id: 'a',
        title: '甲',
        links: ['乙'],
        linkContexts: { 乙: ['上次讨论过 [[乙]] 的存储格式'] },
      }),
      makeRecord({ id: 'b', title: '乙' }),
    ])
    expect(buildLinkGraph(index).edges[0]?.context).toBe('上次讨论过 [[乙]] 的存储格式')
  })

  it('derives the same graph from bare records, for an older host', () => {
    const records = [
      makeRecord({ id: 'a', title: '甲', links: ['乙'] }),
      makeRecord({ id: 'b', title: '乙' }),
      makeRecord({ id: 'c', title: '丙', links: ['不存在'] }),
    ]
    const direct = buildLinkGraph(makeIndex(records))
    const fallback = buildLinkGraphFromRecords(records)
    expect(fallback.edges).toEqual(direct.edges)
    expect(fallback.dangling).toEqual(direct.dangling)
    expect(fallback.stats).toEqual(direct.stats)
  })

  it('sorts nodes by degree so the list opens on the connected ones', () => {
    const index = makeIndex([
      makeRecord({ id: 'a', title: '甲', links: ['乙'] }),
      makeRecord({ id: 'b', title: '乙', links: ['甲', '丙', '丁'] }),
      makeRecord({ id: 'c', title: '丙' }),
      makeRecord({ id: 'd', title: '丁' }),
    ])
    const graph = buildLinkGraph(index)
    expect(graph.nodes.map((node) => node.id).slice(0, 2)).toEqual(['b', 'a'])
  })

  it('carries the inferred reason onto the automatic edge', () => {
    const index = makeIndex([
      makeRecord({
        id: 'a',
        title: '甲',
        links: ['乙'],
        autoLinks: ['乙'],
        autoLinkReasons: { 乙: '共享标签：架构' },
      }),
      makeRecord({ id: 'b', title: '乙' }),
    ])
    expect(buildLinkGraph(index).edges[0]).toMatchObject({
      source: 'a',
      target: 'b',
      auto: true,
      reason: '共享标签：架构',
    })
  })

  it('does not invent a reason for a manual edge', () => {
    const index = makeIndex([
      makeRecord({ id: 'a', title: '甲', links: ['乙'], autoLinkReasons: { 乙: '不该出现' } }),
      makeRecord({ id: 'b', title: '乙' }),
    ])
    expect(buildLinkGraph(index).edges[0]?.reason).toBeUndefined()
  })

  it('exposes createdAt on the node so the canvas can filter by time', () => {
    const index = makeIndex([
      makeRecord({ id: 'a', title: '甲', createdAt: '2026-09-01T00:00:00.000Z' }),
    ])
    expect(buildLinkGraph(index).nodes[0]?.createdAt).toBe('2026-09-01T00:00:00.000Z')
  })
})

describe('analyseLinkGraph', () => {
  const index = makeIndex([
    makeRecord({ id: 'a', title: '甲', links: ['乙', '丙'] }),
    makeRecord({ id: 'b', title: '乙', links: ['丙'] }),
    makeRecord({ id: 'c', title: '丙' }),
    makeRecord({ id: 'd', title: '丁' }),
    makeRecord({ id: 'e', title: '戊', links: ['己'] }),
    makeRecord({ id: 'f', title: '己' }),
  ])
  const graph = buildLinkGraph(index)

  it('finds isolated nodes, components and communities from the real edges', () => {
    const analysis = analyseLinkGraph(graph)
    expect(analysis.isolated).toEqual(['d'])
    expect(analysis.components.map((component) => component.length).sort()).toEqual([1, 2, 3])
    expect(analysis.clusters.map((cluster) => cluster.nodeIds.length).sort()).toEqual([2, 3])
    expect(analysis.degree.a).toBe(2)
    expect(analysis.degree.d).toBe(0)
  })

  it('marks a degree-three star centre as a hub and a path middle as a bridge', () => {
    const star = buildLinkGraph(
      makeIndex([
        makeRecord({ id: 'a', title: '甲', links: ['乙', '丙', '丁'] }),
        makeRecord({ id: 'b', title: '乙' }),
        makeRecord({ id: 'c', title: '丙' }),
        makeRecord({ id: 'd', title: '丁' }),
      ]),
    )
    expect(analyseLinkGraph(star).hubs).toEqual(['a'])

    const path = buildLinkGraph(
      makeIndex([
        makeRecord({ id: 'a', title: '甲', links: ['乙'] }),
        makeRecord({ id: 'b', title: '乙', links: ['丙'] }),
        makeRecord({ id: 'c', title: '丙' }),
      ]),
    )
    expect(analyseLinkGraph(path).bridges).toEqual(['b'])
  })
})

describe('shortestLinkPath', () => {
  const graph = buildLinkGraph(
    makeIndex([
      makeRecord({ id: 'a', title: '甲', links: ['乙'] }),
      makeRecord({ id: 'b', title: '乙', links: ['丙'] }),
      makeRecord({ id: 'c', title: '丙', links: ['丁'] }),
      makeRecord({ id: 'd', title: '丁' }),
      makeRecord({ id: 'e', title: '戊' }),
    ]),
  )

  it('returns the intermediate memories in order', () => {
    expect(shortestLinkPath(graph, 'a', 'd')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns null when the graph records no path', () => {
    expect(shortestLinkPath(graph, 'a', 'e')).toBeNull()
  })

  it('returns the node itself for a zero-length request', () => {
    expect(shortestLinkPath(graph, 'a', 'a')).toEqual(['a'])
  })
})

describe('buildTagDerivedEdges', () => {
  const graph = buildLinkGraph(
    makeIndex([
      makeRecord({ id: 'n1', title: '一', tags: ['project', 'campuslink'] }),
      makeRecord({ id: 'n2', title: '二', tags: ['campuslink', 'hfut'] }),
      makeRecord({ id: 'n3', title: '三', tags: ['campuslink', 'hfut', 'review'] }),
      makeRecord({ id: 'n4', title: '四', tags: ['project'] }),
    ]),
  )

  it('ignores the generic type tag and never returns duplicates', () => {
    const edges = buildTagDerivedEdges(graph.nodes)
    expect(edges.some((edge) => edge.tag === 'project')).toBe(false)
    const keys = edges.map((edge) => [edge.source, edge.target].sort().join('|'))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('honours the per-node budget', () => {
    const edges = buildTagDerivedEdges(graph.nodes, 1)
    const counts = new Map<string, number>()
    for (const edge of edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1)
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1)
    }
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(1)
    expect(edges.length).toBe(1)
  })
})

describe('selectLinkGraph', () => {
  const graph = buildLinkGraph(
    makeIndex([
      makeRecord({ id: 'a', title: '甲', type: 'knowledge', tags: ['alpha'], links: ['乙'] }),
      makeRecord({
        id: 'b',
        title: '乙',
        type: 'decision',
        tags: ['beta'],
        links: ['甲'],
        autoLinks: ['甲'],
        updatedAt: '2026-10-02T00:00:00.000Z',
      }),
      makeRecord({ id: 'c', title: '丙', type: 'knowledge', tags: ['alpha', 'beta'] }),
      makeRecord({ id: 'd', title: '丁', type: 'task', tags: ['gamma'], updatedAt: '2026-08-01T00:00:00.000Z' }),
    ]),
  )

  it('filters by type, tag and update time', () => {
    expect(selectLinkGraph(graph, { types: ['knowledge'] }).nodes.map((node) => node.id).sort()).toEqual(['a', 'c'])
    expect(selectLinkGraph(graph, { tags: ['alpha'] }).nodes.map((node) => node.id).sort()).toEqual(['a', 'c'])
    expect(selectLinkGraph(graph, { since: '2026-09-01T00:00:00.000Z' }).nodes.map((node) => node.id).sort()).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('shows only the requested relation provenance', () => {
    const manual = selectLinkGraph(graph, { relation: 'manual' })
    expect(manual.edges).toHaveLength(1)
    expect(manual.edges[0]).toMatchObject({ source: 'a', target: 'b', auto: false })
    const auto = selectLinkGraph(graph, { relation: 'auto' })
    expect(auto.edges).toHaveLength(1)
    expect(auto.edges[0]).toMatchObject({ source: 'b', target: 'a', auto: true })
  })

  it('finds the isolated memories from the full graph', () => {
    expect(selectLinkGraph(graph, { special: 'isolated' }).nodes.map((node) => node.id)).toEqual(['c', 'd'])
  })

  it('expands one or two hops around the focus', () => {
    expect(selectLinkGraph(graph, { scope: 'local', focusId: 'a', depth: 1 }).nodes.map((node) => node.id).sort()).toEqual([
      'a',
      'b',
    ])
    expect(selectLinkGraph(graph, { scope: 'local', focusId: 'a', depth: 2 }).nodes.map((node) => node.id).sort()).toEqual([
      'a',
      'b',
    ])
  })

  it('keeps the focus even when its own type is filtered out', () => {
    expect(
      selectLinkGraph(graph, { scope: 'local', focusId: 'b', depth: 1, types: ['knowledge'] }).nodes.map((node) => node.id).sort(),
    ).toEqual(['a', 'b'])
  })

  it('adds derived shared-tag edges only when asked', () => {
    expect(selectLinkGraph(graph, {}).derivedEdges).toEqual([])
    const withDerived = selectLinkGraph(graph, { derived: true })
    expect(withDerived.derivedEdges).toHaveLength(2)
    expect(withDerived.derivedEdges).toEqual(
      expect.arrayContaining([
        { source: 'a', target: 'c', tag: 'alpha' },
        { source: 'b', target: 'c', tag: 'beta' },
      ]),
    )
  })

  it('reports search matches without dropping non-matching nodes', () => {
    const view = selectLinkGraph(graph, { query: '丙' })
    expect(view.matched).toEqual(['c'])
    expect(view.nodes).toHaveLength(4)
  })
})
