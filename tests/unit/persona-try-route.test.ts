/**
 * The persona preview's RPC degradation path.
 *
 * A preview is a *button*, not a prerequisite for using the plugin. If no model
 * route exists — a headless profile, a test, a provider that failed to init —
 * the route must still answer with a readable reason, and the page must not
 * turn into an error state. A provider that throws mid-call is the same story.
 *
 * @module tests/unit/persona-try-route
 */

import { describe, expect, it } from 'vitest'

import { dispatch } from '../../src/host/dsh/routes.js'
import type { MemoryService } from '../../src/host/core/service.js'
import type { CompanionService } from '../../src/host/companion/service.js'
import type { CompanionDocuments } from '../../src/host/companion/documents.js'
import type { DshLlmAdapter } from '../../src/host/dsh/llm.js'

const DOCUMENTS: CompanionDocuments = {
  persona: {
    name: '小满',
    identity: '一个安静的倾听者。',
    temperament: '温和、清晰',
    address: '你',
    languageHabits: '短句，不堆客套话。',
    scenario: '日常闲聊',
    catchphrases: ['慢慢来'],
    avoid: ['居高临下的说教'],
    examples: [{ user: '今天好累', assistant: '那就先歇着。' }],
    boundaries: ['不假装真实人类'],
  },
  style: { tone: 'gentle', notes: '' },
  policy: { pretendHuman: false, emotionalDependency: false, quietTriggers: [], stopTriggers: [] },
  revision: 'test',
}

function fakeCompanion(): CompanionService {
  return { load: async () => DOCUMENTS } as unknown as CompanionService
}

const service = {} as MemoryService

interface TryResult {
  available: boolean
  reason: string | null
  reply: string | null
  provider: string | null
  model: string | null
  systemPrompt: string
  utterance: string
  droppedLayers: readonly { key: string; label: string }[]
}

/** All optional collaborators are left out except the ones under test. */
async function tryPersona(text: string, adapter?: () => Promise<DshLlmAdapter>): Promise<TryResult> {
  const result = await dispatch(
    service,
    'personaTry',
    { text },
    undefined,
    fakeCompanion(),
    undefined,
    undefined,
    undefined,
    adapter,
  )
  return result as TryResult
}

function adapterWith(overrides: {
  available: boolean
  reason?: string
  text?: string
  throws?: boolean
}): DshLlmAdapter {
  return {
    available: overrides.available,
    reason: overrides.reason,
    init: async () => undefined,
    complete: async () => ({ text: '', provider: 'test', model: 'test' }),
    completeText: async () => {
      if (overrides.throws === true) throw new Error('provider refused the request')
      return { text: overrides.text ?? '', provider: 'mock-provider', model: 'mock-model' }
    },
  } as unknown as DshLlmAdapter
}

describe('dispatch personaTry', () => {
  it('refuses an empty utterance before touching the model', async () => {
    await expect(tryPersona('   ')).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(tryPersona('')).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('degrades cleanly when the host wired no model adapter at all', async () => {
    const result = await tryPersona('今天有点累')
    expect(result.available).toBe(false)
    expect(result.reply).toBeNull()
    expect(result.reason).toContain('没有接线模型访问')
    // Even the failed preview must show what would have been sent.
    expect(result.systemPrompt).toContain('小满')
    expect(result.systemPrompt).toContain('示例对话')
    expect(result.systemPrompt).toContain('[伙伴规则]')
    expect(result.droppedLayers).toEqual([])
  })

  it('reports the projected persona section rather than an invented prompt', async () => {
    const result = await tryPersona('在吗')
    expect(result.systemPrompt).toContain('常用句式：慢慢来')
    expect(result.systemPrompt).toContain('不要说：居高临下的说教')
    expect(result.systemPrompt).toContain('不可假装真实人类')
  })

  it('passes the adapter reason through when the model route is unavailable', async () => {
    const result = await tryPersona('在吗', async () =>
      adapterWith({ available: false, reason: '宿主未提供 ctx.llm' }),
    )
    expect(result.available).toBe(false)
    expect(result.reason).toBe('宿主未提供 ctx.llm')
    expect(result.reply).toBeNull()
  })

  it('returns a cleaned reply and the route that produced it', async () => {
    const result = await tryPersona('  今天   有点累  ', async () =>
      adapterWith({ available: true, text: '“那就先歇着，剩下的我帮你理。”\n\n（以上为示例）' }),
    )
    expect(result.available).toBe(true)
    expect(result.reply).toBe('那就先歇着，剩下的我帮你理。')
    expect(result.provider).toBe('mock-provider')
    expect(result.model).toBe('mock-model')
    expect(result.utterance).toBe('今天 有点累')
    expect(result.reason).toBeNull()
  })

  it('reports a provider failure beside the preview instead of throwing', async () => {
    const result = await tryPersona('在吗', async () =>
      adapterWith({ available: true, throws: true }),
    )
    expect(result.available).toBe(true)
    expect(result.reply).toBeNull()
    expect(result.reason).toContain('provider refused the request')
  })

  it('reports an empty model answer as a readable reason, not a blank bubble', async () => {
    const result = await tryPersona('在吗', async () =>
      adapterWith({ available: true, text: '   ' }),
    )
    expect(result.reply).toBeNull()
    expect(result.reason).toContain('空内容')
  })
})
