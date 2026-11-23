/**
 * Layout invariants for the Memory Graph canvas.
 *
 * The force simulation must stay finite, inside the composition band, keep the
 * local focus on screen, and be deterministic. A NaN or an off-canvas node would
 * blank or clip the whole picture, and a layout that changes on every render
 * would make the map unreadable.
 *
 * @module tests/unit/links-layout.test
 */

import { describe, expect, it } from 'vitest'

import { LAYOUT_INSETS, MAX_LAYOUT_NODES, computeLayout } from '../../src/client/views/links.js'
import { buildLinkGraphFromRecords } from '../../src/shared/links.js'
import type { LinkGraphNode } from '../../src/shared/links.js'
import { fieldTokens, termWeights, type IndexRecord } from '../../src/shared/search.js'

function record(id: string, title: string, links: string[], tags: string[] = []): IndexRecord {
  const tokens = fieldTokens({ title, aliases: [], tags, summary: '', body: '' })
  return {
    id,
    path: `Knowledge/${id}.md`,
    type: 'knowledge',
    status: 'active',
    title,
    tags,
    aliases: [],
    confidence: 'medium',
    importance: 50,
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    preview: '',
    terms: termWeights(tokens),
    links,
    size: 100,
    mtimeMs: 1000,
    checksum: 'deadbeef',
  }
}

const graph = buildLinkGraphFromRecords([
  record('a', '甲', ['乙', '丙']),
  record('b', '乙', ['甲']),
  record('c', '丙', ['甲', '丁']),
  record('d', '丁', ['丙']),
])

const SIZE = { width: 900, height: 600 }

describe('computeLayout', () => {
  it('keeps every coordinate finite and inside the canvas', () => {
    const layout = computeLayout({ ...SIZE, nodes: graph.nodes, edges: graph.edges, focusId: null })
    expect(layout.nodes).toHaveLength(4)
    for (const placed of layout.nodes) {
      expect(Number.isFinite(placed.x)).toBe(true)
      expect(Number.isFinite(placed.y)).toBe(true)
      expect(placed.x).toBeGreaterThanOrEqual(LAYOUT_INSETS.side - 0.001)
      expect(placed.x).toBeLessThanOrEqual(SIZE.width - LAYOUT_INSETS.side + 0.001)
      expect(placed.y).toBeGreaterThanOrEqual(LAYOUT_INSETS.top - 0.001)
      expect(placed.y).toBeLessThanOrEqual(SIZE.height - LAYOUT_INSETS.bottom + 0.001)
    }
  })

  it('draws curved edges between the placed nodes', () => {
    const layout = computeLayout({ ...SIZE, nodes: graph.nodes, edges: graph.edges, focusId: null })
    expect(layout.edges.length).toBe(graph.edges.length)
    for (const edge of layout.edges) {
      expect(edge.path).toMatch(/^M[\d.-]+ [\d.-]+ Q[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/)
    }
  })

  it('pins the local focus to the centre of the composition band', () => {
    const layout = computeLayout({ ...SIZE, nodes: graph.nodes, edges: graph.edges, focusId: 'a' })
    const focus = layout.nodes.find((placed) => placed.id === 'a')
    expect(focus).toBeDefined()
    expect(focus?.x).toBeCloseTo(SIZE.width / 2, 0)
    const centreY = LAYOUT_INSETS.top + (SIZE.height - LAYOUT_INSETS.top - LAYOUT_INSETS.bottom) / 2
    expect(focus?.y).toBeCloseTo(centreY, 0)
  })

  it('still places every node when the vault has no relations at all', () => {
    const isolated: LinkGraphNode[] = graph.nodes.map((node) => ({
      ...node,
      inDegree: 0,
      outDegree: 0,
    }))
    const layout = computeLayout({ ...SIZE, nodes: isolated, edges: [], focusId: null })
    expect(layout.nodes).toHaveLength(4)
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        const a = layout.nodes[i]
        const b = layout.nodes[j]
        if (a === undefined || b === undefined) continue
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        expect(distance).toBeGreaterThanOrEqual(a.r + b.r - 0.5)
      }
    }
  })

  it('is deterministic for the same input', () => {
    const first = computeLayout({ ...SIZE, nodes: graph.nodes, edges: graph.edges, focusId: 'b' })
    const second = computeLayout({ ...SIZE, nodes: graph.nodes, edges: graph.edges, focusId: 'b' })
    expect(second).toEqual(first)
  })

  it('caps the drawn nodes and reports the remainder', () => {
    const many = Array.from({ length: MAX_LAYOUT_NODES + 12 }, (_, index) =>
      record(`n${String(index).padStart(3, '0')}`, `记忆 ${String(index)}`, []),
    )
    const big = buildLinkGraphFromRecords(many)
    const layout = computeLayout({ ...SIZE, nodes: big.nodes, edges: big.edges, focusId: null })
    expect(layout.nodes).toHaveLength(MAX_LAYOUT_NODES)
    expect(layout.hidden).toBe(12)
  })
})
