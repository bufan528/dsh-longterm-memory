/**
 * Model-assisted extraction tests.
 *
 * Two halves are covered:
 * - the **pure** half (prompt building, response parsing, bounds) with no model;
 * - the **wired** half through `MemoryService`, using an injected fake adapter, so
 *   the full chain (model answer → policy → persistence → index) is exercised
 *   without a single real model call or any user content leaving the machine.
 *
 * The real DSH adapter is also tested for its unavailable path, which is what
 * happens in this workspace because `@deepseek-ai/dsh-llm` is not resolvable here.
 *
 * @module tests/unit/llm-extraction.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import {
  LLM_LIMITS,
  buildExtractionUserText,
  byteLength,
  extractJsonPayload,
  parseModelAnswer,
  truncateBytes,
  type LlmAdapter,
  type LlmExtractionRequest,
} from '../../src/host/core/llm-extraction.js'
import { candidatesFromModel, extractFromTurn } from '../../src/host/core/engine.js'
import { collectAssistantText, createDshLlmAdapter } from '../../src/host/dsh/llm.js'
import type { VaultDiscovery } from '../../src/shared/types.js'

const EXTRACTION_OPTIONS = {
  redactSecrets: true,
  sensitiveNeedsConfirmation: true,
  maxCandidates: 5,
  now: new Date('2026-10-17T03:12:00.000Z'),
  random: () => 0.5,
}

describe('prompt building', () => {
  const request: LlmExtractionRequest = {
    userText: '请记住：我更喜欢用 PowerShell 而不是 bash。',
    assistantText: '好的，我记下了。',
    existing: [{ id: 'mem_1', type: 'preference', title: '编辑器偏好', preview: '偏好 VS Code' }],
    maxCandidates: 3,
  }

  it('includes both sides of the turn and the existing memory context', () => {
    const text = buildExtractionUserText(request)
    expect(text).toContain('PowerShell')
    expect(text).toContain('好的，我记下了。')
    expect(text).toContain('[mem_1]')
    expect(text).toContain('Return at most 3 memories')
  })

  it('marks the assistant reply as context only', () => {
    expect(buildExtractionUserText(request)).toMatch(/do not treat assistant claims as user facts/)
  })

  it('bounds the user and assistant text by byte budget', () => {
    const huge = '字'.repeat(20_000)
    const text = buildExtractionUserText({ ...request, userText: huge, assistantText: huge })
    expect(byteLength(text)).toBeLessThan(LLM_LIMITS.maxUserBytes + LLM_LIMITS.maxAssistantBytes + 2_000)
    expect(text).toContain('已截断')
  })

  it('handles an empty vault', () => {
    expect(buildExtractionUserText({ ...request, existing: [] })).toContain('尚无记忆')
  })
})

describe('truncateBytes', () => {
  it('leaves short text alone', () => {
    expect(truncateBytes('abc', 100)).toBe('abc')
  })

  it('never splits a multi-byte code point', () => {
    const out = truncateBytes('字字字字字', 10)
    expect(out).toContain('字')
    expect(Buffer.from(out.replace('\n…（已截断）', ''), 'utf8').toString('utf8')).not.toContain('\uFFFD')
  })
})

describe('extractJsonPayload', () => {
  it('returns a bare object', () => {
    expect(extractJsonPayload('{"a":1}')).toBe('{"a":1}')
  })

  it('unwraps a markdown fence', () => {
    expect(extractJsonPayload('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('ignores prose around the JSON', () => {
    expect(extractJsonPayload('好的，结果如下：\n{"a":1}\n希望有用。')).toBe('{"a":1}')
  })

  it('handles an array payload', () => {
    expect(extractJsonPayload('here: [{"a":1}] done')).toBe('[{"a":1}]')
  })

  it('returns null when there is no JSON at all', () => {
    expect(extractJsonPayload('我无法完成')).toBeNull()
  })
})

describe('parseModelAnswer', () => {
  const valid = {
    memories: [
      {
        type: 'preference',
        title: '偏好 PowerShell',
        summary: '用户更喜欢用 PowerShell 而不是 bash。',
        tags: ['shell'],
        confidence: 'high',
        importance: 85,
        evidence: '请记住：我更喜欢用 PowerShell 而不是 bash。',
      },
    ],
  }

  it('parses the documented wrapped shape', () => {
    const result = parseModelAnswer(JSON.stringify(valid))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.type).toBe('preference')
    expect(result.candidates[0]?.importance).toBe(85)
  })

  it('parses a bare array', () => {
    const result = parseModelAnswer(JSON.stringify(valid.memories))
    expect(result.ok).toBe(true)
  })

  it('parses a fenced answer', () => {
    const result = parseModelAnswer(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)
    expect(result.ok).toBe(true)
  })

  it('accepts an empty list as a correct answer', () => {
    const result = parseModelAnswer('{"memories":[]}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.candidates).toEqual([])
    expect(result.dropped).toBe(0)
  })

  it('fails on non-JSON instead of guessing', () => {
    const result = parseModelAnswer('我记住了用户的偏好。')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/没有找到 JSON/)
  })

  it('fails on malformed JSON', () => {
    const result = parseModelAnswer('{"memories":[')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/无法解析/)
  })

  it('fails when the payload is neither an array nor {memories:[]}', () => {
    const result = parseModelAnswer('{"items":[{"type":"preference"}]}')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/memories/)
  })

  it('drops an entry with an unknown type', () => {
    const result = parseModelAnswer(
      JSON.stringify({ memories: [{ ...valid.memories[0], type: 'banana' }, { ...valid.memories[0], title: '合法的一条' }] }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.title).toBe('合法的一条')
    expect(result.dropped).toBe(1)
  })

  it('drops an entry whose title or summary is too long', () => {
    const result = parseModelAnswer(
      JSON.stringify({ memories: [{ ...valid.memories[0], title: 'x'.repeat(LLM_LIMITS.maxTitleLength + 1) }] }),
    )
    expect(result.ok).toBe(false)
  })

  it('fails when every entry is structurally invalid', () => {
    const result = parseModelAnswer(JSON.stringify({ memories: [{ type: 'nope' }, 42, null] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/全部不合法/)
  })

  it('caps the number of candidates and reports the surplus', () => {
    const many = Array.from({ length: LLM_LIMITS.maxCandidates + 4 }, (_, index) => ({
      type: 'knowledge',
      title: `条目 ${String(index)}`,
      summary: `内容 ${String(index)}`,
    }))
    const result = parseModelAnswer(JSON.stringify({ memories: many }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.candidates).toHaveLength(LLM_LIMITS.maxCandidates)
    expect(result.dropped).toBe(4)
  })

  it('rejects an oversized answer before parsing it', () => {
    const result = parseModelAnswer('x'.repeat(LLM_LIMITS.maxResponseBytes + 1))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/过大/)
  })
})

describe('candidatesFromModel policy', () => {
  const input = { userText: '请记住：我更喜欢用 PowerShell 而不是 bash。', sessionId: 'session-model', turn: 2 }

  it('maps a grounded, explicitly asserted candidate and keeps high confidence', () => {
    const { candidates, refused } = candidatesFromModel(
      [
        {
          type: 'preference',
          title: '偏好 PowerShell 而不是 bash',
          summary: '我更喜欢用 PowerShell 而不是 bash。',
          tags: ['shell'],
          confidence: 'high',
          importance: 80,
          evidence: '请记住：我更喜欢用 PowerShell 而不是 bash。',
        },
      ],
      input,
      EXTRACTION_OPTIONS,
    )
    expect(refused).toEqual([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.confidence).toBe('high')
    expect(candidates[0]?.sourceSessions).toEqual(['session-model'])
    expect(candidates[0]?.evidence).toContain('session-model')
  })

  it('degrades a candidate that the conversation does not support', () => {
    const { candidates } = candidatesFromModel(
      [
        {
          type: 'project',
          title: '用户在做一个量子计算项目',
          summary: '用户正在推进量子纠错码研究。',
          tags: [],
          confidence: 'high',
          importance: 80,
          evidence: '',
        },
      ],
      input,
      EXTRACTION_OPTIONS,
    )
    expect(candidates).toHaveLength(1)
    // Not grounded in the turn, so it cannot be promoted to a stated fact.
    expect(candidates[0]?.confidence).toBe('low')
    expect(candidates[0]?.reason).toMatch(/未能.*定位/)
  })

  it('degrades a claim supported only by the assistant reply', () => {
    const { candidates } = candidatesFromModel(
      [
        {
          type: 'preference',
          title: 'PowerShell 偏好',
          summary: '用户更喜欢用 PowerShell 而不是 bash。',
          tags: [],
          confidence: 'high',
          importance: 80,
          evidence: '',
        },
      ],
      { userText: '你好', assistantText: '我记下了：你更喜欢用 PowerShell 而不是 bash。' },
      EXTRACTION_OPTIONS,
    )
    expect(candidates[0]?.confidence).toBe('medium')
    expect(candidates[0]?.reason).toMatch(/仅出现在助手回复/)
  })

  it('refuses a candidate that is mostly a credential', () => {
    const { candidates, refused } = candidatesFromModel(
      [
        {
          type: 'knowledge',
          title: 'API 密钥',
          summary: 'api_key = sk-abcdefghijklmnopqrstuvwx',
          tags: [],
          confidence: 'high',
          importance: 50,
          evidence: '',
        },
      ],
      input,
      EXTRACTION_OPTIONS,
    )
    expect(candidates).toEqual([])
    expect(refused).toHaveLength(1)
    expect(refused[0]?.reason).toMatch(/机密/)
  })

  it('redacts a credential mentioned inside a real fact', () => {
    const { candidates } = candidatesFromModel(
      [
        {
          type: 'preference',
          title: '密钥管理偏好',
          summary: '我更喜欢把密钥放在环境变量里，而不是写进代码；示例 api_key = sk-abcdefghijklmnopqrstuvwx 不该保存。',
          tags: [],
          confidence: 'medium',
          importance: 60,
          evidence: '我更喜欢把密钥放在环境变量里。',
        },
      ],
      { userText: '我更喜欢把密钥放在环境变量里，而不是写进代码。' },
      EXTRACTION_OPTIONS,
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.summary).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(candidates[0]?.summary).toContain('已移除')
  })

  it('forces sensitive content to wait for confirmation', () => {
    const { candidates } = candidatesFromModel(
      [
        {
          type: 'profile',
          title: '体检情况',
          summary: '体检报告显示血压偏高。',
          tags: [],
          confidence: 'high',
          importance: 60,
          evidence: '',
        },
      ],
      { userText: '我的体检报告显示血压偏高，请记住。' },
      EXTRACTION_OPTIONS,
    )
    expect(candidates[0]?.confidence).not.toBe('high')
    expect(candidates[0]?.reason).toMatch(/敏感/)
  })

  it('respects the candidate cap', () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      type: 'knowledge' as const,
      title: `知识 ${String(index)}`,
      summary: '请记住：我更喜欢用 PowerShell 而不是 bash。',
      tags: [],
      confidence: 'high' as const,
      importance: 50,
      evidence: '',
    }))
    const { candidates } = candidatesFromModel(many, input, { ...EXTRACTION_OPTIONS, maxCandidates: 2 })
    expect(candidates).toHaveLength(2)
  })
})

describe('collectAssistantText', () => {
  it('reads the text-chunks shape', () => {
    expect(collectAssistantText([{ type: 'text-chunks', texts: ['a', 'b'] }])).toBe('ab')
  })

  it('reads a top-level text-delta', () => {
    expect(collectAssistantText([{ type: 'text-delta', text: 'a' }, { type: 'text-delta', text: 'b' }])).toBe('ab')
  })

  it('reads a nested text-delta', () => {
    expect(collectAssistantText([{ chunk: { type: 'text-delta', text: 'a' } }])).toBe('a')
  })

  it('ignores shapes it does not understand rather than misreading them', () => {
    expect(collectAssistantText([{ type: 'image' }, { weird: true }, null, 42])).toBe('')
  })
})

describe('real DSH adapter when the model module is not resolvable', () => {
  it('reports unavailable with a reason instead of throwing on activation', async () => {
    const ctx = {
      get: () => undefined,
      logger: { info: () => undefined, warn: () => undefined },
    }
    const adapter = createDshLlmAdapter(ctx, { timeoutMs: 1000, maxOutputTokens: 100 })
    expect(adapter.available).toBe(false)
    await adapter.init()
    // In this workspace `@deepseek-ai/dsh-llm` is not installed, so the guarded
    // dynamic import must fail softly.
    expect(adapter.available).toBe(false)
    expect(typeof adapter.reason).toBe('string')
    expect((adapter.reason ?? '').length).toBeGreaterThan(0)
    await expect(
      adapter.complete({ userText: 'x', assistantText: '', existing: [], maxCandidates: 1 }, new AbortController().signal),
    ).rejects.toThrow()
  })
})

/* ------------------------------------------------------------ service wiring */

let root: string
let vault: string

beforeEach(async () => {
  root = await makeTempRoot('llm-service')
  vault = join(root, 'DSH Memory')
})

afterEach(async () => {
  await cleanup(root)
})

function discoveryFor(path: string): VaultDiscovery {
  return {
    environment: 'desktop',
    filesystem: true,
    obsidian: { detected: false, configPath: null, vaults: [] },
    current: null,
    candidates: [path],
    needsChoice: false,
    rationale: 'test',
    warnings: [],
  }
}

function fakeAdapter(answer: string | (() => Promise<string>), opts: { available?: boolean } = {}): LlmAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    available: opts.available ?? true,
    reason: opts.available === false ? '测试：模型不可用' : undefined,
    async complete(): Promise<{ text: string; provider: string; model: string }> {
      this.calls += 1
      const text = typeof answer === 'function' ? await answer() : answer
      return { text, provider: 'test-provider', model: 'test-model' }
    },
  }
  return adapter as LlmAdapter & { calls: number }
}

async function serviceWith(adapter: LlmAdapter): Promise<MemoryService> {
  const service = new MemoryService({
    configuredVaultPath: vault,
    discoveryProvider: async () => discoveryFor(vault),
    configSettings: { enableLlmExtraction: true },
    llmAdapter: adapter,
  })
  await service.initialize(vault)
  return service
}

const MODEL_ANSWER = JSON.stringify({
  memories: [
    {
      type: 'preference',
      title: '偏好 PowerShell 而不是 bash',
      summary: '用户更喜欢用 PowerShell 而不是 bash。',
      tags: ['shell'],
      confidence: 'high',
      importance: 85,
      evidence: '请记住：我更喜欢用 PowerShell 而不是 bash。',
    },
  ],
})

describe('service: model-driven extraction end to end', () => {
  const turn = {
    userText: '请记住：我更喜欢用 PowerShell 而不是 bash。',
    assistantText: '好的，我记下了。',
    sessionId: 'session-model',
    turn: 1,
  }

  it('turns a model answer into a persisted, indexed, searchable memory', async () => {
    const adapter = fakeAdapter(MODEL_ANSWER)
    const service = await serviceWith(adapter)

    const result = await service.processTurn(turn)
    expect(adapter.calls).toBe(1)
    expect(result.modelNote).toMatch(/模型辅助提取：采纳 1 条/)
    expect(result.applied.length).toBe(1)

    const id = result.applied[0]?.id ?? ''
    const detail = await service.get(id)
    expect(detail.memory.title).toBe('偏好 PowerShell 而不是 bash')
    expect(detail.memory.status).toBe('active')
    expect(detail.memory.sourceSessions).toEqual(['session-model'])

    // The index saw it, so retrieval works.
    const hits = service.search({ text: 'PowerShell' })
    expect(hits.hits.map((hit) => hit.record.id)).toContain(id)

    // The change is in the audit journal.
    const history = await service.history(id, 10)
    expect(history.some((entry) => entry.op === 'create' && entry.source === 'session-model')).toBe(true)
  })

  it('does not call the adapter when the feature is off', async () => {
    const adapter = fakeAdapter(MODEL_ANSWER)
    const service = new MemoryService({
      configuredVaultPath: vault,
      discoveryProvider: async () => discoveryFor(vault),
      configSettings: { enableLlmExtraction: false },
      llmAdapter: adapter,
    })
    await service.initialize(vault)
    const result = await service.processTurn({ ...turn, assistantText: '' })
    expect(adapter.calls).toBe(0)
    expect(result.modelNote).toBeUndefined()
    // The rule extractor still ran.
    expect(result.applied.length).toBe(1)
  })

  it('falls back to the rule extractor when the model returns garbage', async () => {
    const adapter = fakeAdapter('抱歉，我无法完成这个任务。')
    const service = await serviceWith(adapter)
    const result = await service.processTurn({ ...turn, assistantText: '' })
    expect(result.modelNote).toMatch(/已跳过/)
    expect(result.applied.length).toBe(1)
    const hits = service.search({ text: 'PowerShell' })
    expect(hits.hits.length).toBe(1)
  })

  it('falls back when the adapter throws, and still records the turn', async () => {
    const adapter = fakeAdapter(async () => {
      throw new Error('provider exploded')
    })
    const service = await serviceWith(adapter)
    const result = await service.processTurn({ ...turn, assistantText: '' })
    expect(result.modelNote).toMatch(/失败.*回退/)
    expect(result.applied.length).toBe(1)
  })

  it('reports the adapter as unavailable without losing the rule result', async () => {
    const adapter = fakeAdapter(MODEL_ANSWER, { available: false })
    const service = await serviceWith(adapter)
    const result = await service.processTurn({ ...turn, assistantText: '' })
    expect(adapter.calls).toBe(0)
    expect(result.modelNote).toMatch(/不可用/)
    expect(result.applied.length).toBe(1)
  })

  it('is idempotent for a retried turn', async () => {
    const adapter = fakeAdapter(MODEL_ANSWER)
    const service = await serviceWith(adapter)
    const first = await service.processTurn(turn)
    expect(first.applied.length).toBe(1)

    const second = await service.processTurn(turn)
    expect(second.skippedAsDuplicate).toBe(true)
    expect(second.applied).toEqual([])
    expect(adapter.calls).toBe(1)

    expect(service.search({ text: 'PowerShell', includeNonCurrent: true }).hits).toHaveLength(1)
  })

  it('does not stack duplicate pending candidates across different turns', async () => {
    // A medium-confidence, ungrounded answer lands in the Inbox.
    const inboxAnswer = JSON.stringify({
      memories: [
        {
          type: 'project',
          title: '用户在做一个代号 Omicron 的项目',
          summary: '用户正在推进代号 Omicron 的项目，具体细节未知。',
          tags: [],
          confidence: 'high',
          importance: 50,
          evidence: '',
        },
      ],
    })
    const adapter = fakeAdapter(inboxAnswer)
    const service = await serviceWith(adapter)

    const first = await service.processTurn({ userText: '我们聊聊别的吧。', sessionId: 's', turn: 1 })
    const second = await service.processTurn({ userText: '继续聊。', sessionId: 's', turn: 2 })
    expect(first.pending.length + second.pending.length).toBe(1)
    expect(service.listCandidates()).toHaveLength(1)
  })

  it('persists nothing when the model answer is structurally invalid and the rules find nothing', async () => {
    const adapter = fakeAdapter('{"memories":[{"type":"banana"}]}')
    const service = await serviceWith(adapter)
    const result = await service.processTurn({ userText: '今天天气不错，随便聊聊。', sessionId: 's', turn: 1 })
    expect(result.applied).toEqual([])
    expect(result.pending).toEqual([])
    expect(service.search({ limit: 50, includeNonCurrent: true }).total).toBe(0)
  })

  it('surfaces the model note for the audit trail', async () => {
    const adapter = fakeAdapter(MODEL_ANSWER)
    const service = await serviceWith(adapter)
    await service.processTurn(turn)
    expect(service.getLastModelNote()).toMatch(/test-provider\/test-model/)
  })

  it('never persists a credential the model proposed', async () => {
    const adapter = fakeAdapter(
      JSON.stringify({
        memories: [
          {
            type: 'knowledge',
            title: 'API key',
            summary: 'api_key = sk-abcdefghijklmnopqrstuvwx',
            confidence: 'high',
            importance: 50,
          },
        ],
      }),
    )
    const service = await serviceWith(adapter)
    const result = await service.processTurn({ userText: '请记住：我的 api_key 是 sk-abcdefghijklmnopqrstuvwx', sessionId: 's', turn: 1 })
    expect(result.applied).toEqual([])
    expect(service.search({ limit: 50, includeNonCurrent: true }).total).toBe(0)
  })

  it('does not call the model twice for the same turn even when the answer is empty', async () => {
    const adapter = fakeAdapter('{"memories":[]}')
    const service = await serviceWith(adapter)
    await service.processTurn(turn)
    const spy = vi.spyOn(adapter, 'complete')
    await service.processTurn(turn)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('rule extraction still works untouched', () => {
  it('produces the same candidates with the model feature off', () => {
    const outcome = extractFromTurn(
      { userText: '请记住：我更喜欢用 PowerShell 而不是 bash。', sessionId: 's' },
      EXTRACTION_OPTIONS,
    )
    expect(outcome.candidates).toHaveLength(1)
    expect(outcome.candidates[0]?.type).toBe('preference')
  })
})
