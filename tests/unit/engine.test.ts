/**
 * Memory-engine tests — the "intelligent management" rules.
 *
 * These assert the safety properties the product promises: no guess becomes a
 * fact, no secret is stored, nothing that contradicts an existing memory is
 * silently overwritten.
 *
 * @module tests/unit/engine.test
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPARISON,
  compareCandidate,
  comparisonTerms,
  extractFromTurn,
  isPredominantlySecret,
  maskSecret,
  mayAutoApply,
  overlapCoefficient,
  redactSecrets,
  scanSecrets,
  scanSensitive,
  splitStatements,
  termsOfRecord,
  type ExistingMemoryView,
} from '../../src/host/core/engine.js'

/** Build an `ExistingMemoryView` whose terms come from the real tokenizer. */
function viewOf(id: string, type: string, title: string, summary: string, status = 'active'): ExistingMemoryView {
  const terms: Record<string, number> = {}
  for (const term of comparisonTerms(`${title}\n${summary}`)) terms[term] = 1
  return { id, type, title, summary, status, terms }
}
import type { MemoryCandidate } from '../../src/shared/types.js'

const OPTIONS = {
  redactSecrets: true,
  sensitiveNeedsConfirmation: true,
  maxCandidates: 5,
  now: new Date('2026-10-17T03:12:00.000Z'),
  random: () => 0.5,
}

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: 'mem_20261017t031200_deadbeef',
    type: 'preference',
    title: '标题',
    summary: '内容',
    tags: ['preference'],
    confidence: 'high',
    importance: 80,
    sourceSessions: [],
    evidence: '',
    createdAt: '2026-10-17T03:12:00.000Z',
    reason: 'test',
    relatedIds: [],
    decision: { action: 'create' },
    ...overrides,
  }
}

describe('secret scanning and redaction', () => {
  it('detects an API key assignment', () => {
    const findings = scanSecrets('api_key = sk-abcdefghijklmnopqrstuvwx')
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.some((finding) => finding.severity === 'high')).toBe(true)
  })

  it('detects a Chinese password statement', () => {
    const findings = scanSecrets('我的密码是 hunter2secret')
    expect(findings.some((finding) => finding.kind === 'cjk-credential-word')).toBe(true)
  })

  it('detects a private key block and a bearer token', () => {
    expect(scanSecrets('-----BEGIN RSA PRIVATE KEY-----').some((f) => f.kind === 'private-key')).toBe(true)
    expect(scanSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123').some((f) => f.kind === 'bearer-token')).toBe(true)
  })

  it('masks a value so it can be logged safely', () => {
    const masked = maskSecret('sk-abcdefghijklmnop')
    expect(masked).not.toContain('abcdefghij')
    expect(masked.startsWith('sk-a')).toBe(true)
  })

  it('redacts every detected span', () => {
    const redacted = redactSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz01 and password: swordfish')
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz01')
    expect(redacted).not.toContain('swordfish')
    expect(redacted).toContain('已移除')
  })

  it('treats a short message that is a credential as predominantly secret', () => {
    const text = 'sk-abcdefghijklmnopqrstuvwx'
    expect(isPredominantlySecret(text, scanSecrets(text))).toBe(true)
  })

  it('does not treat a long note that merely mentions a key as predominantly secret', () => {
    const text = `${'这是一段很长的说明文字。'.repeat(20)} 配置项是 api_key = sk-abcdefghijklmnopqrstuvwx，用于本地测试。`
    expect(isPredominantlySecret(text, scanSecrets(text))).toBe(false)
  })
})

describe('sensitive categories', () => {
  it('flags health, finance, and identity content', () => {
    expect(scanSensitive('我的体检报告显示血压偏高')).toContain('health')
    expect(scanSensitive('我的工资和房贷情况')).toContain('finance')
    expect(scanSensitive('我的身份证号需要更新')).toContain('identity')
  })

  it('returns nothing for ordinary technical text', () => {
    expect(scanSensitive('我们决定使用 TypeScript 重写索引模块')).toEqual([])
  })
})

describe('extractFromTurn', () => {
  it('extracts a high-confidence preference from an explicit remember command', () => {
    const outcome = extractFromTurn(
      { userText: '请记住：我更喜欢用 PowerShell 而不是 bash。', sessionId: 'session-1' },
      OPTIONS,
    )
    expect(outcome.candidates).toHaveLength(1)
    expect(outcome.candidates[0]?.type).toBe('preference')
    expect(outcome.candidates[0]?.confidence).toBe('high')
    expect(outcome.candidates[0]?.sourceSessions).toEqual(['session-1'])
  })

  it('extracts a profile fact', () => {
    const outcome = extractFromTurn({ userText: '我是一名后端工程师，主要用 Python。' }, OPTIONS)
    expect(outcome.candidates.map((entry) => entry.type)).toContain('profile')
  })

  it('extracts a decision, an experience, and a task from separate statements', () => {
    const outcome = extractFromTurn(
      { userText: '我们决定用 SQLite。\n教训是不要在写入路径上做全量扫描。\n下一步要补索引重建的测试。' },
      OPTIONS,
    )
    const types = outcome.candidates.map((entry) => entry.type)
    expect(types).toContain('decision')
    expect(types).toContain('experience')
    expect(types).toContain('task')
  })

  it('records evidence with the session id and turn', () => {
    const outcome = extractFromTurn(
      { userText: '请记住：我习惯把配置放在 cordis.patch.yml。', sessionId: 'session-9', turn: 3, cwd: 'D:/work' },
      OPTIONS,
    )
    const evidence = outcome.candidates[0]?.evidence ?? ''
    expect(evidence).toContain('session-9')
    expect(evidence).toContain('第 3 轮')
    expect(evidence).toContain('D:/work')
  })

  it('ignores greetings and noise', () => {
    expect(extractFromTurn({ userText: '你好' }, OPTIONS).candidates).toEqual([])
    expect(extractFromTurn({ userText: '继续' }, OPTIONS).candidates).toEqual([])
  })

  it('ignores a plain question that states no durable fact', () => {
    const outcome = extractFromTurn({ userText: '我们决定用 SQLite 了吗？' }, OPTIONS)
    expect(outcome.candidates).toEqual([])
  })

  it('refuses a message that is itself a credential', () => {
    const outcome = extractFromTurn({ userText: '请记住：我的 API key 是 sk-abcdefghijklmnopqrstuvwx' }, OPTIONS)
    expect(outcome.candidates).toEqual([])
    expect(outcome.refused.length).toBeGreaterThan(0)
    expect(outcome.refused[0]?.reason).toMatch(/机密/)
  })

  it('never lets a raw credential reach a candidate, refused or redacted', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx'
    // One sentence: the whole message is essentially the credential → refused.
    const short = `请记住：我的 api_key 是 ${secret}，不要写进代码。`
    // One sentence carrying durable meaning plus a credential → kept, redacted.
    const durable = `请记住：我的 api_key 是 ${secret}，并且我偏好把密钥放在环境变量里，而不是写进代码，因为代码仓库会同步到远程。`
    const shortOutcome = extractFromTurn({ userText: short }, OPTIONS)
    const durableOutcome = extractFromTurn({ userText: durable }, OPTIONS)

    for (const outcome of [shortOutcome, durableOutcome]) {
      for (const entry of outcome.candidates) {
        expect(entry.summary).not.toContain(secret)
        expect(entry.title).not.toContain(secret)
        expect(entry.evidence).not.toContain(secret)
      }
    }
    expect(shortOutcome.refused.length).toBeGreaterThan(0)
    expect(durableOutcome.candidates.length).toBeGreaterThan(0)
    expect(durableOutcome.candidates.some((entry) => entry.summary.includes('已移除'))).toBe(true)
    expect(durableOutcome.refused).toEqual([])
  })

  it('downgrades sensitive content to medium so it waits for confirmation', () => {
    const outcome = extractFromTurn({ userText: '请记住：我的工资卡号后四位是 1234。' }, OPTIONS)
    const entry = outcome.candidates[0]
    expect(entry).toBeDefined()
    if (entry === undefined) return
    expect(entry.confidence).not.toBe('high')
    expect(entry.reason).toMatch(/敏感/)
    expect(mayAutoApply(entry)).toBe(false)
  })

  it('degrades an inferred statement so a guess is not written as a fact', () => {
    const outcome = extractFromTurn({ userText: '这个项目的进度已经完成了 60%。' }, OPTIONS)
    const entry = outcome.candidates[0]
    expect(entry).toBeDefined()
    if (entry === undefined) return
    expect(entry.confidence).toBe('low')
    expect(mayAutoApply(entry)).toBe(false)
  })

  it('caps the number of candidates per turn', () => {
    const text = Array.from({ length: 20 }, (_, index) => `请记住：我的偏好 ${String(index)} 是使用方案 ${String(index)}。`).join('\n')
    const outcome = extractFromTurn({ userText: text }, { ...OPTIONS, maxCandidates: 3 })
    expect(outcome.candidates.length).toBeLessThanOrEqual(3)
  })

  it('extracts nothing from an empty or very short message', () => {
    expect(extractFromTurn({ userText: '' }, OPTIONS).candidates).toEqual([])
    expect(extractFromTurn({ userText: '好的' }, OPTIONS).candidates).toEqual([])
  })
})

describe('splitStatements', () => {
  it('splits on Chinese and Latin sentence punctuation and list markers', () => {
    expect(splitStatements('- 第一条。第二条！第三条?')).toEqual(['第一条。', '第二条！', '第三条?'])
  })

  it('drops empty lines', () => {
    expect(splitStatements('a\n\n\nb')).toEqual(['a', 'b'])
  })
})

describe('compareCandidate', () => {
  const existing: ExistingMemoryView[] = [
    viewOf('mem_existing', 'decision', '使用 SQLite 作为索引存储', '决定使用 SQLite 保存索引'),
  ]

  it('creates a new memory when nothing is related', () => {
    const result = compareCandidate(candidate({ title: '关于前端主题', summary: '使用深色主题' }), existing)
    expect(result.decision.action).toBe('create')
  })

  it('proposes a merge for a near duplicate of the same type', () => {
    const result = compareCandidate(
      candidate({ type: 'decision', title: '使用 SQLite 作为索引存储', summary: '决定使用 SQLite 保存索引' }),
      existing,
    )
    expect(result.decision.action).toBe('merge')
    expect(result.bestId).toBe('mem_existing')
  })

  it('proposes an update for a supplement that shares the subject', () => {
    const result = compareCandidate(
      candidate({ type: 'decision', title: '索引存储改用 SQLite 的补充说明', summary: '关于使用 SQLite 保存索引，另外补充：写入走事务。' }),
      existing,
    )
    expect(['update', 'merge']).toContain(result.decision.action)
  })

  it('flags a contradiction when the new statement negates the old one', () => {
    const result = compareCandidate(
      candidate({ type: 'decision', title: '不再使用 SQLite 作为索引存储', summary: '决定不使用 SQLite，改用 JSON 保存索引' }),
      existing,
    )
    expect(result.decision.action).toBe('conflict')
  })

  it('flags a contradiction when a number changes', () => {
    const numeric: ExistingMemoryView[] = [viewOf('mem_n', 'project-state', '项目进度 60%', '当前完成 60%')]
    const result = compareCandidate(candidate({ type: 'project-state', title: '项目进度 90%', summary: '当前完成 90%' }), numeric)
    expect(result.decision.action).toBe('conflict')
  })

  it('flags a contradiction when the replacement is signalled explicitly', () => {
    const numeric: ExistingMemoryView[] = [viewOf('mem_r', 'decision', '使用 JSON 保存索引', '决定使用 JSON 保存索引')]
    const result = compareCandidate(
      candidate({ type: 'decision', title: '索引存储改为 SQLite', summary: '决定把使用 JSON 保存索引改为使用 SQLite 保存索引' }),
      numeric,
    )
    expect(result.decision.action).toBe('conflict')
  })

  it('ignores archived memories when looking for a counterpart', () => {
    const archived: ExistingMemoryView[] = [viewOf('mem_existing', 'decision', '使用 SQLite 作为索引存储', '决定使用 SQLite 保存索引', 'archived')]
    const result = compareCandidate(candidate({ type: 'decision', title: '使用 SQLite 作为索引存储', summary: '决定使用 SQLite 保存索引' }), archived)
    expect(result.decision.action).toBe('create')
  })

  it('does not treat a different category as the same subject', () => {
    const task: ExistingMemoryView[] = [viewOf('mem_t', 'task', '使用 SQLite 作为索引存储', '决定使用 SQLite 保存索引')]
    const result = compareCandidate(
      candidate({ type: 'decision', title: '使用 SQLite 作为索引存储', summary: '决定使用 SQLite 保存索引' }),
      task,
    )
    expect(result.decision.action).toBe('create')
  })

  it('reports the best similarity and id for the UI explanation', () => {
    const result = compareCandidate(
      candidate({ type: 'decision', title: '使用 SQLite 作为索引存储', summary: '决定使用 SQLite 保存索引' }),
      existing,
    )
    expect(result.bestSimilarity).toBeCloseTo(1, 3)
    expect(result.bestId).toBe('mem_existing')
  })
})

describe('mayAutoApply', () => {
  it('allows a high-confidence create', () => {
    expect(mayAutoApply(candidate({ confidence: 'high', decision: { action: 'create' } }))).toBe(true)
  })

  it('allows a high-confidence update', () => {
    expect(mayAutoApply(candidate({ confidence: 'high', decision: { action: 'update', targetId: 'x', rationale: 'r' } }))).toBe(true)
  })

  it('never allows a merge automatically', () => {
    expect(mayAutoApply(candidate({ confidence: 'high', decision: { action: 'merge', targetIds: ['x'], rationale: 'r' } }))).toBe(false)
  })

  it('never allows a conflict resolution automatically', () => {
    expect(mayAutoApply(candidate({ confidence: 'high', decision: { action: 'conflict', targetId: 'x', rationale: 'r' } }))).toBe(false)
  })

  it('never allows a medium or low confidence candidate', () => {
    expect(mayAutoApply(candidate({ confidence: 'medium' }))).toBe(false)
    expect(mayAutoApply(candidate({ confidence: 'low' }))).toBe(false)
  })

  it('never allows a refused candidate', () => {
    expect(mayAutoApply(candidate({ confidence: 'high', refused: 'secret' }))).toBe(false)
  })
})

describe('similarity primitives', () => {
  it('overlapCoefficient is 1 for identical sets and 0 for disjoint ones', () => {
    expect(overlapCoefficient(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    expect(overlapCoefficient(new Set(['a']), new Set(['b']))).toBe(0)
  })

  it('overlapCoefficient does not penalise a shorter set, unlike Jaccard', () => {
    expect(overlapCoefficient(new Set(['a', 'b']), new Set(['a', 'b', 'c', 'd', 'e']))).toBe(1)
  })

  it('is 0 when either side is empty', () => {
    expect(overlapCoefficient(new Set(), new Set(['a']))).toBe(0)
  })

  it('drops single CJK characters from comparison terms, keeping bigrams and latin words', () => {
    const terms = comparisonTerms('使用 SQLite 索引')
    expect(terms.has('sqlite')).toBe(true)
    expect(terms.has('索引')).toBe(true)
    expect(terms.has('使')).toBe(false)
  })

  it('reads comparison terms back out of an indexed record', () => {
    const terms = termsOfRecord({ 使: 8, 索引: 4, sqlite: 6 })
    expect(terms.has('索引')).toBe(true)
    expect(terms.has('sqlite')).toBe(true)
    expect(terms.has('使')).toBe(false)
  })

  it('uses the declared thresholds sensibly', () => {
    expect(DEFAULT_COMPARISON.duplicateThreshold).toBeGreaterThan(DEFAULT_COMPARISON.relatedThreshold)
  })
})
