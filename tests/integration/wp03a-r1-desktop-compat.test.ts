/**
 * Desktop compatibility: what the prompt layer does when the gate says no.
 *
 * The distinction this suite exists to make, because three different things were
 * being described with one sentence ("PC memory broke"):
 *
 * 1. **A prompt regression** — the presentation layer would have to be reverted.
 * 2. **A missing producer** — the gate allows a trusted PC source, but nothing in
 *    production ever creates one, so the branch is unreachable.
 * 3. **A test-runtime artefact** — a test that notes a `desktop` source itself and
 *    then reports "PC works", which is what WP-NEXT-01F's PC cases do.
 *
 * Every assertion below drives the **unmodified production** `install.ts` section
 * (`installStandingSection`) through the **unmodified production** Owner gate, with a
 * stub identity service so the outcome depends only on provenance. No vault, no
 * filesystem, no model call.
 *
 * @module tests/integration/wp03a-r1-desktop-compat
 */

import { describe, expect, it } from 'vitest'

import type { MemoryService } from '../../src/host/core/service.js'
import { installStandingSection, STANDING_SECTION_NAME, type CordisLike } from '../../src/host/dsh/inject.js'
import type { IndexRecord, MemoryIndex } from '../../src/shared/search.js'
import { standingFacts } from '../../src/host/core/retrieval.js'

const NOW = new Date('2026-11-08T12:00:00Z')
const OWNER_ID = 'owner-8f2c'

function rec(partial: Partial<IndexRecord> & { id: string; title: string }): IndexRecord {
  return {
    path: `profile/${partial.id}.md`,
    type: 'profile',
    status: 'active',
    tags: [],
    aliases: [],
    confidence: 'high',
    importance: 70,
    pinned: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    preview: '',
    terms: {},
    links: [],
    size: 10,
    mtimeMs: 0,
    checksum: partial.id,
    ...partial,
  } as IndexRecord
}

const INDEX: MemoryIndex = {
  version: 1,
  builtAt: NOW.toISOString(),
  vaultPath: 'D:/tmp/fixture-vault',
  records: new Map(
    [
      rec({ id: 'mem_p1', type: 'profile', title: '在读软件工程', preview: '方向偏大模型算法。' }),
      rec({ id: 'mem_p2', type: 'preference', title: '先给结论再给过程' }),
    ].map((record) => [record.id, record]),
  ),
  postings: new Map(),
  resolvedLinks: new Map(),
}

/** The exact block the prompt layer would contribute if it were allowed to. */
function realStanding() {
  return standingFacts(INDEX, { budgetTokens: 700, maxItems: 12, now: NOW })
}

interface Facts {
  platform: string
  conversationType: string
  isPrivate: boolean
  ownerId: string | null
  identified: boolean
}

/**
 * Minimal but faithful stand-in for the QQ plugin's identity service.
 *
 * `noteSource` is the *only* way a source enters, exactly as in
 * `dsh-qqbot-merge/dist/identity/service.js`; production only ever calls it from the
 * QQ inbound path with `platform: 'qq'`.
 */
function identityService(options: { healthy?: boolean } = {}) {
  const sources = new Map<string, Facts>()
  const known = new Set<string>()
  return {
    sources,
    noteSource(sessionId: string, facts: Facts) {
      sources.set(sessionId, facts)
      known.add(sessionId)
    },
    getContext(sessionId: string): Facts | null {
      return sources.get(sessionId) ?? null
    },
    isKnownQqSession(sessionId: string): boolean {
      return known.has(sessionId)
    },
    isRegistryHealthy(): boolean {
      return options.healthy !== false
    },
  }
}

interface Harness {
  logs: string[]
  /** Invoke the registered section callback the way the prompt pipeline does. */
  text(sessionId: string): string
  ctx: CordisLike
}

function harness(identity: ReturnType<typeof identityService> | undefined, standing = realStanding()): Harness {
  const logs: string[] = []
  let registered: Record<string, unknown> | undefined
  const ctx = {
    get: (name: string) => {
      if (name === 'systemPrompt') {
        return {
          section: (section: Record<string, unknown>) => {
            registered = section
            return () => undefined
          },
        }
      }
      if (name === 'qqbotContext') return identity
      if (name === 'hostPluginIngress') return undefined
      return undefined
    },
    on: () => () => undefined,
    effect: (execute: () => unknown) => execute(),
    logger: {
      info: (message: string, ...rest: unknown[]) => logs.push(`${message} ${rest.map(String).join(' ')}`),
      warn: (message: string, ...rest: unknown[]) => logs.push(`${message} ${rest.map(String).join(' ')}`),
    },
  } as unknown as CordisLike

  const service = {
    isReady: () => true,
    standing: () => standing,
    setStandingSectionProbe: () => undefined,
  } as unknown as MemoryService

  installStandingSection(ctx, service, {}, undefined)
  return {
    logs,
    ctx,
    text: (sessionId: string) => {
      const fn = registered?.['text'] as ((context: unknown) => string) | undefined
      if (fn === undefined) throw new Error('section was not registered')
      return fn({ agent: { session: { id: sessionId } } })
    },
  }
}

describe('desktop sessions today (no trusted PC producer exists)', () => {
  it('contributes nothing at all, and says why', () => {
    const identity = identityService()
    const gate = harness(identity)
    expect(gate.text('sess-desktop-1')).toBe('')
    expect(gate.logs.join('\n')).toContain('无可信 PC 正向证明')
  })

  it('still contributes nothing when the identity service is missing entirely', () => {
    const gate = harness(undefined)
    expect(gate.text('sess-desktop-2')).toBe('')
    expect(gate.logs.join('\n')).toContain('服务缺失')
  })

  it('is denied for an unregistered session even with a healthy registry', () => {
    const gate = harness(identityService({ healthy: true }))
    expect(gate.text('sess-desktop-3')).toBe('')
  })

  it('does not turn a broken registry into an allow', () => {
    const gate = harness(identityService({ healthy: false }))
    expect(gate.text('sess-desktop-4')).toBe('')
    expect(gate.logs.join('\n')).toContain('注册表读取失败')
  })
})

describe('the gate itself is not the regression', () => {
  it('renders the block as soon as a trusted desktop source exists', () => {
    // This is exactly the condition WP-NEXT-01F's PC cases manufacture in-test
    // (`context.noteSource({ platform: 'desktop' })`). It proves the allow branch and
    // the presentation layer both work; it does not prove production has a producer.
    const identity = identityService()
    identity.noteSource('sess-desktop-ok', {
      platform: 'desktop',
      conversationType: 'c2c',
      isPrivate: true,
      ownerId: null,
      identified: true,
    })
    const gate = harness(identity)
    const text = gate.text('sess-desktop-ok')
    expect(text).toContain('## 长期记忆')
    expect(text).toContain('在读软件工程')
    expect(gate.logs.join('\n')).not.toContain('withheld')
  })

  it('never allows a session whose only claim is a session-id prefix', () => {
    // A prefix such as `sess-desktop-*` must not be evidence. There is no such rule
    // in the gate, and this pins that no one adds one by accident.
    const identity = identityService()
    const gate = harness(identity)
    expect(gate.text('sess-desktop-anything')).toBe('')
    expect(gate.text('pc-local-trusted')).toBe('')
  })
})

describe('QQ paths keep working', () => {
  it('contributes the block for a bound owner in C2C', () => {
    const identity = identityService()
    identity.noteSource('sess-qq-c2c', {
      platform: 'qq',
      conversationType: 'c2c',
      isPrivate: true,
      ownerId: OWNER_ID,
      identified: true,
    })
    const text = harness(identity).text('sess-qq-c2c')
    expect(text).toContain('## 长期记忆')
    expect(text).toContain('### 交流偏好')
  })

  it('withholds the block in a QQ group', () => {
    const identity = identityService()
    identity.noteSource('sess-qq-group', {
      platform: 'qq',
      conversationType: 'group',
      isPrivate: false,
      ownerId: OWNER_ID,
      identified: true,
    })
    const gate = harness(identity)
    expect(gate.text('sess-qq-group')).toBe('')
    expect(gate.logs.join('\n')).toContain('群聊')
  })

  it('withholds the block when the QQ account is not bound to an owner', () => {
    const identity = identityService()
    identity.noteSource('sess-qq-unbound', {
      platform: 'qq',
      conversationType: 'c2c',
      isPrivate: true,
      ownerId: null,
      identified: true,
    })
    expect(harness(identity).text('sess-qq-unbound')).toBe('')
  })

  it('withholds the block from a remembered session whose live source vanished', () => {
    const identity = identityService()
    identity.noteSource('sess-qq-stale', {
      platform: 'qq',
      conversationType: 'c2c',
      isPrivate: true,
      ownerId: OWNER_ID,
      identified: true,
    })
    // Simulate a restart: the session is still known, the live facts are gone.
    identity.sources.delete('sess-qq-stale')
    const gate = harness(identity)
    expect(gate.text('sess-qq-stale')).toBe('')
    expect(gate.logs.join('\n')).toContain('缺少实时来源')
  })
})

describe('section registration', () => {
  it('registers under the documented name and order', () => {
    const gate = harness(identityService())
    const systemPrompt = gate.ctx.get('systemPrompt') as { section: (s: Record<string, unknown>) => unknown }
    const captured: Record<string, unknown>[] = []
    systemPrompt.section = (section: Record<string, unknown>) => {
      captured.push(section)
      return () => undefined
    }
    let seen: Record<string, unknown> | undefined
    const ctx2 = {
      ...(gate.ctx as unknown as Record<string, unknown>),
      get: (name: string) =>
        name === 'systemPrompt'
          ? {
              section: (section: Record<string, unknown>) => {
                seen = section
                return () => undefined
              },
            }
          : name === 'qqbotContext'
            ? identityService()
            : undefined,
    } as unknown as CordisLike
    const service = {
      isReady: () => true,
      standing: realStanding,
      setStandingSectionProbe: () => undefined,
    } as unknown as MemoryService
    installStandingSection(ctx2, service, {}, undefined)
    expect(seen?.['name']).toBe(STANDING_SECTION_NAME)
    expect(seen?.['order']).toBe(9500)
    expect(seen?.['interpolate']).toBe(false)
  })

  it('returns an empty string instead of throwing when the service is not ready', () => {
    const logs: string[] = []
    let registered: Record<string, unknown> | undefined
    const ctx = {
      get: (name: string) =>
        name === 'systemPrompt'
          ? {
              section: (section: Record<string, unknown>) => {
                registered = section
                return () => undefined
              },
            }
          : undefined,
      on: () => () => undefined,
      effect: (execute: () => unknown) => execute(),
      logger: { info: () => undefined, warn: (message: string) => logs.push(message) },
    } as unknown as CordisLike
    const service = {
      isReady: () => false,
      standing: () => {
        throw new Error('must not be called')
      },
      setStandingSectionProbe: () => undefined,
    } as unknown as MemoryService
    installStandingSection(ctx, service, {}, undefined)
    const fn = registered?.['text'] as (context: unknown) => string
    expect(fn({ agent: { session: { id: 's' } } })).toBe('')
    expect(logs).toEqual([])
  })
})
