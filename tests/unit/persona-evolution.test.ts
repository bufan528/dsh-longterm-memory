/**
 * Persona evolution rules.
 *
 * The engine must be predictable: same memories in, same suggestions out, every
 * proposal traceable to memory ids, and never a change to the fixed core
 * (name / identity / boundaries). These tests pin exactly that.
 */
import { describe, expect, it } from 'vitest'

import { EvolutionService, EvolutionStore, buildPatch, proposeFromMemories } from '../../src/host/companion/evolution.js'
import type { EvolutionMemory } from '../../src/host/companion/evolution.js'
import { DEFAULT_DOCUMENTS } from '../../src/host/companion/documents.js'
import type { CompanionDocuments } from '../../src/host/companion/documents.js'

const NOW = new Date(2026, 10, 13, 19, 0, 0, 0)

function memory(id: string, title: string, summary: string, tags: string[] = []): EvolutionMemory {
  return { id, title, summary, tags }
}

function documents(over: Partial<CompanionDocuments['persona']> = {}, tone: CompanionDocuments['style']['tone'] = 'gentle'): CompanionDocuments {
  return {
    ...DEFAULT_DOCUMENTS,
    persona: { ...DEFAULT_DOCUMENTS.persona, ...over },
    style: { ...DEFAULT_DOCUMENTS.style, tone },
  }
}

describe('proposeFromMemories — 称呼', () => {
  it('proposes an explicit "叫我" instruction', () => {
    const out = proposeFromMemories(
      [memory('m1', '偏好', '用户说以后叫我川川就好')],
      documents({ address: '你' }),
      NOW,
    )
    const address = out.find((item) => item.field === 'address')
    expect(address?.proposed).toBe('川川')
    expect(address?.evidence).toContain('m1')
  })

  it('does not re-propose the address already in use', () => {
    const out = proposeFromMemories(
      [memory('m1', '偏好', '以后叫我川川')],
      documents({ address: '川川' }),
      NOW,
    )
    expect(out.some((item) => item.field === 'address')).toBe(false)
  })
})

describe('proposeFromMemories — 禁语', () => {
  it('proposes a phrase the user said they dislike', () => {
    const out = proposeFromMemories(
      [memory('m1', '沟通偏好', '我讨厌被叫老板')],
      documents({ avoid: [] }),
      NOW,
    )
    const avoid = out.find((item) => item.field === 'avoid')
    expect(avoid?.proposed).toBe('被叫老板')
  })

  it('skips a phrase that is already in avoid', () => {
    const out = proposeFromMemories(
      [memory('m1', '沟通偏好', '我讨厌被叫老板')],
      documents({ avoid: ['被叫老板'] }),
      NOW,
    )
    expect(out.some((item) => item.field === 'avoid')).toBe(false)
  })
})

describe('proposeFromMemories — 口头禅', () => {
  it('needs the fragment in at least three distinct memories', () => {
    const two = proposeFromMemories(
      [memory('m1', 'a', '明天记得交材料'), memory('m2', 'b', '别忘了交材料')],
      documents(),
      NOW,
    )
    expect(two.some((item) => item.field === 'catchphrases')).toBe(false)

    const three = proposeFromMemories(
      [
        memory('m1', 'a', '明天记得交材料'),
        memory('m2', 'b', '别忘了交材料'),
        memory('m3', 'c', '周五要交材料'),
      ],
      documents(),
      NOW,
    )
    const phrase = three.find((item) => item.field === 'catchphrases')
    expect(phrase?.proposed).toBe('交材料')
    expect(phrase?.evidence.length).toBeGreaterThanOrEqual(3)
  })

  it('ignores a run of one repeated character', () => {
    const out = proposeFromMemories(
      [
        memory('m1', 'a', '哈哈哈哈太好玩了'),
        memory('m2', 'b', '哈哈哈哈真的'),
        memory('m3', 'c', '哈哈哈哈笑死'),
      ],
      documents(),
      NOW,
    )
    expect(out.some((item) => item.field === 'catchphrases' && item.proposed === '哈哈哈')).toBe(false)
  })
})

describe('proposeFromMemories — 语气', () => {
  it('proposes gentler tone when most cues are about being worn down', () => {
    const memories = [
      memory('m1', '状态', '最近好累，压力很大'),
      memory('m2', '状态', '有点焦虑，撑不住'),
      memory('m3', '状态', '难受，想哭'),
      memory('m4', '状态', '累到不想说话'),
      memory('m5', '状态', '烦'),
    ]
    const out = proposeFromMemories(memories, documents({}, 'lively'), NOW)
    const tone = out.find((item) => item.field === 'tone')
    expect(tone?.proposed).toBe('gentle')
  })

  it('stays quiet when the evidence is thin', () => {
    const out = proposeFromMemories([memory('m1', '状态', '有点累')], documents({}, 'lively'), NOW)
    expect(out.some((item) => item.field === 'tone')).toBe(false)
  })
})

describe('proposeFromMemories — 边界', () => {
  it('never proposes anything about the fixed core', () => {
    const out = proposeFromMemories(
      [
        memory('m1', '身份', '你是一个温柔的人，名字叫小助手，边界是不能假装人类'),
        memory('m2', '身份', '你的身份是伴侣，不能假装人类'),
        memory('m3', '身份', '性格要更温柔一点'),
      ],
      documents(),
      NOW,
    )
    const fields = new Set(out.map((item) => item.field))
    expect(fields.has('address')).toBe(false)
    expect(fields.has('catchphrases')).toBe(false)
    // Only the variable layer is ever in scope.
    for (const field of fields) expect(['address', 'catchphrases', 'avoid', 'tone']).toContain(field)
  })

  it('is deterministic and gives stable ids across runs', () => {
    const memories = [memory('m1', '偏好', '以后叫我川川'), memory('m2', '偏好', '我讨厌被叫老板')]
    const first = proposeFromMemories(memories, documents(), NOW)
    const second = proposeFromMemories(memories, documents(), NOW)
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id))
  })

  it('marks confidence from the amount of evidence', () => {
    const out = proposeFromMemories(
      [
        memory('m1', 'a', '以后叫我川川'),
        memory('m2', 'b', '叫我川川就行'),
        memory('m3', 'c', '叫我川川吧'),
      ],
      documents({ address: '你' }),
      NOW,
    )
    const address = out.find((item) => item.field === 'address')
    expect(address?.confidence).toBe('high')
  })
})

describe('buildPatch', () => {
  it('appends a phrase without dropping the existing ones', () => {
    const suggestion = {
      id: 'x', field: 'catchphrases' as const, proposed: '交材料', reason: '', evidence: [],
      confidence: 'high' as const, createdAt: '', status: 'pending' as const,
    }
    const built = buildPatch(suggestion, documents({ catchphrases: ['好耶'] }))
    expect(built?.patch.catchphrases).toEqual(['好耶', '交材料'])
    expect(built?.previous).toBe('好耶')
  })

  it('rejects a tone outside the vocabulary', () => {
    const suggestion = {
      id: 'x', field: 'tone' as const, proposed: 'sarcastic', reason: '', evidence: [],
      confidence: 'high' as const, createdAt: '', status: 'pending' as const,
    }
    expect(buildPatch(suggestion, documents())).toBeNull()
  })

  it('caps a list at the document limit instead of overflowing the file', () => {
    const suggestion = {
      id: 'x', field: 'catchphrases' as const, proposed: '新', reason: '', evidence: [],
      confidence: 'high' as const, createdAt: '', status: 'pending' as const,
    }
    const built = buildPatch(suggestion, documents({ catchphrases: ['1', '2', '3', '4', '5', '6'] }))
    expect(built?.patch.catchphrases).toHaveLength(6)
  })
})

describe('EvolutionService.revert', () => {
  function serviceFor(suggestion: Record<string, unknown>, documents: CompanionDocuments) {
    const calls: unknown[] = []
    const store = {
      load: async () => [suggestion as never],
      list: () => [suggestion as never],
      scan: async () => [],
      mark: async () => null,
    }
    const service = new EvolutionService({
      companion: {
        getDocuments: async () => documents,
        update: async (patch) => { calls.push(patch); return documents },
      },
      listMemories: async () => [],
      store: store as never,
    })
    return { service, calls }
  }

  it('restores the previous address', async () => {
    const { service, calls } = serviceFor(
      { id: 'a', field: 'address', proposed: '川川', previous: '你', status: 'applied', evidence: [], confidence: 'high', createdAt: '', reason: '' },
      documents({ address: '川川' }),
    )
    const result = await service.revert('a')
    expect(result.ok).toBe(true)
    expect(calls[0]).toEqual({ address: '你' })
  })

  it('drops only the appended phrase', async () => {
    const { service, calls } = serviceFor(
      { id: 'b', field: 'catchphrases', proposed: '交材料', previous: '好耶', status: 'applied', evidence: [], confidence: 'high', createdAt: '', reason: '' },
      documents({ catchphrases: ['好耶', '交材料'] }),
    )
    await service.revert('b')
    expect(calls[0]).toEqual({ catchphrases: ['好耶'] })
  })

  it('refuses to revert something that was never applied', async () => {
    const { service, calls } = serviceFor(
      { id: 'c', field: 'address', proposed: '川川', status: 'pending', evidence: [], confidence: 'low', createdAt: '', reason: '' },
      documents(),
    )
    const result = await service.revert('c')
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a tone revert without a recorded value', async () => {
    const { service, calls } = serviceFor(
      { id: 'd', field: 'tone', proposed: 'gentle', status: 'applied', evidence: [], confidence: 'high', createdAt: '', reason: '' },
      documents({}, 'gentle'),
    )
    const result = await service.revert('d')
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('EvolutionService persistence across restarts', () => {
  it('sees suggestions written by a previous process', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'evolution-'))

    const memory = (id: string, title: string, summary: string): EvolutionMemory => ({ id, title, summary, tags: [] })
    const memories = [memory('m1', '偏好', '以后叫我川川'), memory('m2', '偏好', '叫我川川就好'), memory('m3', '偏好', '称呼我川川')]
    const docs = documents({ address: '你' })

    const makeService = () => {
      const store = new EvolutionStore({ vaultPath: () => dir })
      return new EvolutionService({
        companion: { getDocuments: async () => docs, update: async () => docs },
        listMemories: async () => memories,
        store,
      })
    }

    const first = makeService()
    const scanned = await first.scan()
    expect(scanned.some((item) => item.field === 'address')).toBe(true)

    // Simulate a restart: a brand-new service over the same vault.
    const second = makeService()
    const listed = await second.list()
    expect(listed.length).toBe(scanned.length)
    expect(listed.some((item) => item.proposed === '川川')).toBe(true)
  })

  it('keeps a dismissed decision when scanning again', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'evolution2-'))
    const memories = [memory('m1', '偏好', '以后叫我川川')]
    const docs = documents({ address: '你' })

    const service = new EvolutionService({
      companion: { getDocuments: async () => docs, update: async () => docs },
      listMemories: async () => memories,
      store: new EvolutionStore({ vaultPath: () => dir }),
    })
    const [row] = await service.scan()
    expect(row).toBeDefined()
    await service.dismiss(row!.id)
    const rescanned = await service.scan()
    const after = rescanned.find((item) => item.id === row!.id)
    // A dismissed row must not come back as pending.
    expect(after?.status).toBe('dismissed')
  })
})
