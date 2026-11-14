/**
 * Persona evolution — suggestion engine.
 *
 * The research consensus is that a persona should not be rewritten silently.
 * GLA (2025) separates "Reflect" (synthesize experience) from "Evolve" (an
 * explicit, *traceable* edit of the personality), and MeKB-Sim (NAACL 2025)
 * splits a character into a fixed core and a variable layer that only the
 * second one drifts. This module implements exactly that split for our data:
 *
 *   fixed core      name / identity / boundaries        never proposed
 *   variable layer  address / catchphrases / avoid / tone   proposed, never applied
 *
 * Suggestions are produced by **deterministic rules over the user's own
 * memories** — no model call, no token cost, and every proposal can be traced
 * back to the memory ids that produced it. The user applies or dismisses each
 * one in the persona pane; only an explicit apply writes `Persona.md`.
 *
 * Everything here is pure or file-only so the rules can be unit-tested without
 * a vault, a clock, or an LLM.
 *
 * @module dsh-longterm-memory/host/companion/evolution
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { VAULT_DIRS } from '../../shared/types.js'
import { writeFileAtomic } from '../core/fsx.js'
import type { CompanionDocuments } from './documents.js'
import type { CompanionUpdate } from './service.js'

/** Only the variable layer is ever proposed. */
export type EvolutionField = 'address' | 'catchphrases' | 'avoid' | 'tone'

export interface EvolutionSuggestion {
  /** Stable across scans: sha256(field + proposed), so status survives a rescan. */
  id: string
  field: EvolutionField
  proposed: string
  /** Why the engine thinks so, quoting the pattern it matched. */
  reason: string
  /** Memory ids this came from. The UI links them; nothing is applied blind. */
  evidence: string[]
  confidence: 'low' | 'medium' | 'high'
  createdAt: string
  status: 'pending' | 'applied' | 'dismissed' | 'reverted'
  appliedAt?: string
  /** The value the field had when applied, so a revert is possible later. */
  previous?: string
}

/** The minimum a memory must expose for the rules. */
export interface EvolutionMemory {
  id: string
  title: string
  summary: string
  tags: string[]
}

interface EvolutionFile {
  schemaVersion: 1
  suggestions: EvolutionSuggestion[]
}

export const EVOLUTION_DIR = 'Evolution'
export const EVOLUTION_FILE = 'suggestions.json'

/** Words that show up in every memory and would otherwise look like a catchphrase. */
const STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '一下', '现在', '已经',
  '因为', '所以', '但是', '如果', '然后', '还是', '就是', '一个', '没有', '不是', '自己',
  '今天', '昨天', '明天', '时候', '东西', '问题', '需要', '觉得', '应该', '可能', '比较',
])

const VALID_TONES = ['gentle', 'lively', 'rational', 'humorous'] as const

const TONE_CUES: Record<(typeof VALID_TONES)[number], readonly string[]> = {
  gentle: ['累', '难受', '难过', '焦虑', '压力', '烦', '低落', '想哭', '撑不住', '被压'],
  lively: ['哈哈', '笑死', '太棒', '好耶', '开心', '爽', '绝了', '冲', '牛'],
  rational: ['为什么', '原理', '方案', '对比', '分析', '结论', '逻辑', '数据'],
  humorous: ['离谱', '搞笑', '吐槽', '乐子', '整活', '绷不住'],
}

function hashId(field: string, proposed: string): string {
  return createHash('sha256').update(`${field}\u0000${proposed}`).digest('hex').slice(0, 16)
}

function confidenceOf(evidence: number): EvolutionSuggestion['confidence'] {
  if (evidence >= 3) return 'high'
  if (evidence >= 2) return 'medium'
  return 'low'
}

/**
 * Trim the politeness that follows a name.
 *
 * `以后叫我川川就好` and `叫我川川吧` are the same instruction as `叫我川川`;
 * without this, three memories become three different addresses and none of them
 * reaches the confidence threshold.
 */
function cleanAddress(raw: string): string {
  return raw
    .replace(/(?:就好|就行|好了|才怪|吧|啊|呀|哦|呢|啦|了|嘛|哈|的)+$/u, '')
    .trim()
}

/** Everything the character content of one memory can be scanned in. */
function textOf(memory: EvolutionMemory): string {
  return `${memory.title}\n${memory.summary}\n${memory.tags.join(' ')}`
}

/**
 * Propose persona updates from memories.
 *
 * Each rule emits at most a couple of candidates and every candidate carries the
 * memory ids that produced it — a suggestion the user cannot trace is a
 * suggestion they cannot safely accept.
 */
export function proposeFromMemories(
  memories: readonly EvolutionMemory[],
  documents: CompanionDocuments | null,
  now: Date = new Date(),
): EvolutionSuggestion[] {
  const stamp = now.toISOString()
  const out: EvolutionSuggestion[] = []
  const persona = documents?.persona
  const currentPhrases = new Set((persona?.catchphrases ?? []).map((p) => p.trim()))
  const currentAvoid = new Set((persona?.avoid ?? []).map((p) => p.trim()))
  const currentAddress = persona?.address?.trim() ?? ''
  const currentTone = documents?.style?.tone ?? ''

  const emit = (field: EvolutionField, proposed: string, reason: string, evidence: string[]): void => {
    if (proposed.length === 0) return
    out.push({
      id: hashId(field, proposed),
      field,
      proposed,
      reason,
      evidence: [...new Set(evidence)].slice(0, 6),
      confidence: confidenceOf(new Set(evidence).size),
      createdAt: stamp,
      status: 'pending',
    })
  }

  /* ------------------------------------------------------------ 称呼 -- */
  // "以后叫我川川" / "别叫我老板" — an explicit instruction the persona must obey.
  const addressHits = new Map<string, string[]>()
  for (const memory of memories) {
    for (const match of textOf(memory).matchAll(/(?:以后)?(?:就)?叫我(?:做|为|成)?([^\s，。！？、；:：""'']{1,8})/gu)) {
      const value = cleanAddress(match[1]?.trim() ?? '')
      if (value.length === 0) continue
      if (value === currentAddress) continue
      const list = addressHits.get(value) ?? []
      list.push(memory.id)
      addressHits.set(value, list)
    }
  }
  for (const [value, ids] of addressHits) {
    if (ids.length < 1) continue
    emit('address', value, `记忆里出现「叫我${value}」${String(ids.length)} 次`, ids)
  }

  /* ------------------------------------------------------------ 禁语 -- */
  const avoidHits = new Map<string, string[]>()
  for (const memory of memories) {
    for (const match of textOf(memory).matchAll(/(?:不喜欢|讨厌|受不了|别再|不要再说|不想听)([^\s，。！？、；:：""'']{1,10})/gu)) {
      const value = match[1]?.trim()
      if (value === undefined || value.length < 2) continue
      if (currentAvoid.has(value)) continue
      const list = avoidHits.get(value) ?? []
      list.push(memory.id)
      avoidHits.set(value, list)
    }
  }
  for (const [value, ids] of avoidHits) {
    emit('avoid', value, `记忆里明确表达过「讨厌/别再说 ${value}」`, ids)
  }

  /* ---------------------------------------------------------- 口头禅 -- */
  // Count 3-5 character Chinese fragments across *distinct* memories. A phrase
  // the user repeats in three separate notes is a habit; one that appears three
  // times in the same note is just a long sentence.
  const phraseHits = new Map<string, Set<string>>()
  for (const memory of memories) {
    const text = textOf(memory).replace(/[^\u4e00-\u9fa5]/gu, ' ')
    const seenHere = new Set<string>()
    for (const chunk of text.split(/\s+/u)) {
      for (let size = 3; size <= 5; size += 1) {
        for (let start = 0; start + size <= chunk.length; start += 1) {
          const gram = chunk.slice(start, start + size)
          if (STOPWORDS.has(gram)) continue
          // Skip fragments that are a run of one character ("哈哈哈" is a laugh,
          // not a catchphrase) and anything already configured.
          if (new Set([...gram]).size === 1) continue
          if (currentPhrases.has(gram) || currentAvoid.has(gram)) continue
          seenHere.add(gram)
        }
      }
    }
    for (const gram of seenHere) {
      const ids = phraseHits.get(gram) ?? new Set<string>()
      ids.add(memory.id)
      phraseHits.set(gram, ids)
    }
  }
  const rankedPhrases = [...phraseHits.entries()]
    .filter(([, ids]) => ids.size >= 3)
    // Prefer the longer fragment when two overlap ("交材料" over "交材料吧").
    .sort((a, b) => b[1].size - a[1].size || b[0].length - a[0].length)
  const pickedPhrases: string[] = []
  for (const [gram, ids] of rankedPhrases) {
    if (pickedPhrases.length >= 2) break
    if (pickedPhrases.some((kept) => kept.includes(gram) || gram.includes(kept))) continue
    pickedPhrases.push(gram)
    emit('catchphrases', gram, `${String(ids.size)} 条不同记忆里都出现了「${gram}」`, [...ids])
  }

  /* ------------------------------------------------------------ 语气 -- */
  const scores = new Map<string, { count: number; ids: Set<string> }>()
  for (const tone of Object.keys(TONE_CUES)) {
    scores.set(tone, { count: 0, ids: new Set() })
  }
  for (const memory of memories) {
    const text = textOf(memory)
    for (const [tone, cues] of Object.entries(TONE_CUES)) {
      const hit = cues.some((cue) => text.includes(cue))
      if (!hit) continue
      const entry = scores.get(tone)!
      entry.count += 1
      entry.ids.add(memory.id)
    }
  }
  const total = [...scores.values()].reduce((sum, entry) => sum + entry.count, 0)
  const best = [...scores.entries()].sort((a, b) => b[1].count - a[1].count)[0]
  if (best !== undefined && total >= 5 && best[1].count / total >= 0.55 && best[0] !== currentTone) {
    emit(
      'tone',
      best[0],
      `最近 ${String(total)} 条带情绪线索的记忆里，${String(best[1].count)} 条偏「${best[0]}」`,
      [...best[1].ids],
    )
  }

  return out
}

export interface EvolutionStoreOptions {
  vaultPath: () => string | null | undefined
  logger?: { warn: (message: string, ...rest: unknown[]) => void }
  now?: () => Date
}

/** File-backed queue: `Companion/Evolution/suggestions.json`. */
export class EvolutionStore {
  private readonly now: () => Date
  private cache: EvolutionSuggestion[] = []
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: EvolutionStoreOptions) {
    this.now = options.now ?? (() => new Date())
  }

  get rootDir(): string | null {
    const vault = this.options.vaultPath()
    if (vault === undefined || vault === null || vault.trim().length === 0) return null
    return join(resolve(vault), VAULT_DIRS.companion, EVOLUTION_DIR)
  }

  get available(): boolean { return this.rootDir !== null }

  async load(): Promise<EvolutionSuggestion[]> {
    const root = this.rootDir
    if (root === null) return []
    let raw: unknown = null
    try {
      raw = JSON.parse(await readFile(join(root, EVOLUTION_FILE), 'utf8')) as unknown
    } catch {
      raw = null
    }
    this.cache = parseSuggestions(raw)
    return [...this.cache]
  }

  list(): EvolutionSuggestion[] { return [...this.cache] }

  /**
   * Recompute pending suggestions, keeping every decision the user already made.
   *
   * Applied/dismissed rows stay in the file (trimmed to the most recent 50) so a
   * rescan cannot resurrect something the user rejected, and so the applied list
   * doubles as the traceable drift record the research calls for.
   */
  async scan(proposals: readonly EvolutionSuggestion[]): Promise<EvolutionSuggestion[]> {
    const decided = this.cache.filter((item) => item.status !== 'pending')
    const decidedIds = new Set(decided.map((item) => item.id))
    const fresh = proposals.filter((item) => !decidedIds.has(item.id))
    const merged = [...fresh, ...decided]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-200)
    this.cache = merged
    await this.save()
    return [...merged]
  }

  async mark(id: string, status: 'applied' | 'dismissed' | 'reverted', previous?: string): Promise<EvolutionSuggestion | null> {
    const index = this.cache.findIndex((item) => item.id === id)
    if (index < 0) return null
    const next = { ...this.cache[index]! }
    next.status = status
    if (status === 'applied') {
      next.appliedAt = this.now().toISOString()
      if (previous !== undefined) next.previous = previous
    }
    const all = [...this.cache]
    all[index] = next
    this.cache = all
    await this.save()
    return next
  }

  private save(): Promise<void> {
    const root = this.rootDir
    if (root === null) return Promise.resolve()
    const body: EvolutionFile = { schemaVersion: 1, suggestions: this.cache }
    const run = this.chain.catch(() => undefined).then(async () => {
      await writeFileAtomic(join(root, EVOLUTION_FILE), `${JSON.stringify(body, null, 2)}\n`)
    })
    this.chain = run
    return run
  }
}

function parseSuggestions(raw: unknown): EvolutionSuggestion[] {
  if (raw === null || typeof raw !== 'object') return []
  const obj = raw as Record<string, unknown>
  if (obj['schemaVersion'] !== 1 || !Array.isArray(obj['suggestions'])) return []
  const fields: readonly EvolutionField[] = ['address', 'catchphrases', 'avoid', 'tone']
  const statuses = ['pending', 'applied', 'dismissed', 'reverted'] as const
  const out: EvolutionSuggestion[] = []
  for (const entry of obj['suggestions']) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    if (typeof row['id'] !== 'string' || typeof row['proposed'] !== 'string') continue
    if (!fields.includes(row['field'] as EvolutionField)) continue
    if (!statuses.includes(row['status'] as (typeof statuses)[number])) continue
    out.push({
      id: row['id'],
      field: row['field'] as EvolutionField,
      proposed: row['proposed'],
      reason: typeof row['reason'] === 'string' ? row['reason'] : '',
      evidence: Array.isArray(row['evidence']) ? row['evidence'].filter((v): v is string => typeof v === 'string').slice(0, 6) : [],
      confidence: row['confidence'] === 'high' || row['confidence'] === 'medium' ? row['confidence'] : 'low',
      createdAt: typeof row['createdAt'] === 'string' ? row['createdAt'] : new Date(0).toISOString(),
      status: row['status'] as EvolutionSuggestion['status'],
      ...(typeof row['appliedAt'] === 'string' ? { appliedAt: row['appliedAt'] } : {}),
      ...(typeof row['previous'] === 'string' ? { previous: row['previous'] } : {}),
    })
  }
  return out
}

export interface EvolutionServiceOptions {
  companion: {
    getDocuments: () => Promise<CompanionDocuments | null>
    update: (patch: CompanionUpdate) => Promise<CompanionDocuments>
  }
  listMemories: (limit: number) => Promise<EvolutionMemory[]>
  store: EvolutionStore
  now?: () => Date
}

/**
 * Ties the rules to the services: scan reads memories, apply writes the persona.
 *
 * Apply is the only write path and it is always user-triggered — the engine has
 * no timer and no hook into the conversation, so a persona can never drift while
 * the user is not looking.
 */
export class EvolutionService {
  private readonly now: () => Date

  constructor(private readonly options: EvolutionServiceOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Load the queue from disk once per process.
   *
   * The store keeps an in-memory cache; without this the list is empty after a
   * restart until the user happens to scan again, and a scan would then rewrite
   * the file from an empty cache — silently dropping every applied/dismissed
   * decision. Both were real bugs found by the round-trip smoke test.
   */
  private loaded = false

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    await this.options.store.load()
    this.loaded = true
  }

  async list(): Promise<EvolutionSuggestion[]> {
    await this.ensureLoaded()
    return this.options.store.list()
  }

  async scan(): Promise<EvolutionSuggestion[]> {
    await this.ensureLoaded()
    const [documents, memories] = await Promise.all([
      this.options.companion.getDocuments(),
      this.options.listMemories(200),
    ])
    const proposals = proposeFromMemories(memories, documents, this.now())
    return this.options.store.scan(proposals)
  }

  async apply(id: string): Promise<{ ok: boolean; reason?: string }> {
    await this.ensureLoaded()
    const suggestion = this.options.store.list().find((item) => item.id === id)
    if (suggestion === undefined) return { ok: false, reason: '建议不存在，可能已被新的扫描替换' }
    if (suggestion.status !== 'pending') return { ok: false, reason: '这条建议已经处理过' }
    const documents = await this.options.companion.getDocuments()
    if (documents === null) return { ok: false, reason: '人格文件尚未初始化' }

    const patch = buildPatch(suggestion, documents)
    if (patch === null) return { ok: false, reason: `字段 ${suggestion.field} 不支持自动应用` }
    await this.options.companion.update(patch.patch)
    await this.options.store.mark(id, 'applied', patch.previous)
    return { ok: true }
  }

  async dismiss(id: string): Promise<boolean> {
    const done = await this.options.store.mark(id, 'dismissed')
    return done !== null
  }

  /**
   * Undo an applied suggestion.
   *
   * Accepting a change is cheap; living with it for a week is not. `previous` is
   * recorded at apply time precisely so this is an exact inverse:
   *  - address / tone  → restore the recorded value
   *  - catchphrases / avoid → drop the entry that was appended
   */
  async revert(id: string): Promise<{ ok: boolean; reason?: string }> {
    await this.ensureLoaded()
    const suggestion = this.options.store.list().find((item) => item.id === id)
    if (suggestion === undefined) return { ok: false, reason: '建议不存在' }
    if (suggestion.status !== 'applied') return { ok: false, reason: '只有已采纳的建议可以撤销' }
    const documents = await this.options.companion.getDocuments()
    if (documents === null) return { ok: false, reason: '人格文件尚未初始化' }

    const persona = documents.persona
    let patch: CompanionUpdate
    switch (suggestion.field) {
      case 'address':
        patch = { address: suggestion.previous ?? '你' }
        break
      case 'tone': {
        const tone = suggestion.previous
        if (tone !== 'gentle' && tone !== 'lively' && tone !== 'rational' && tone !== 'humorous') {
          return { ok: false, reason: '没有记录可回退的语气' }
        }
        patch = { tone }
        break
      }
      case 'catchphrases':
        patch = { catchphrases: persona.catchphrases.filter((phrase) => phrase !== suggestion.proposed) }
        break
      case 'avoid':
        patch = { avoid: persona.avoid.filter((phrase) => phrase !== suggestion.proposed) }
        break
      default:
        return { ok: false, reason: `字段 ${String(suggestion.field)} 不支持撤销` }
    }
    await this.options.companion.update(patch)
    await this.options.store.mark(id, 'reverted')
    return { ok: true }
  }
}

/**
 * Translate a suggestion into a `CompanionUpdate`.
 *
 * Lists are appended (never replaced) and capped at the document limit, because
 * a suggestion is one more habit — not a rewrite of the ones already agreed on.
 */
export function buildPatch(
  suggestion: EvolutionSuggestion,
  documents: CompanionDocuments,
): { patch: CompanionUpdate; previous: string } | null {
  const persona = documents.persona
  switch (suggestion.field) {
    case 'address':
      return { patch: { address: suggestion.proposed.slice(0, 40) }, previous: persona.address }
    case 'catchphrases':
      return {
        patch: { catchphrases: [...persona.catchphrases, suggestion.proposed].slice(0, 6) },
        previous: persona.catchphrases.join('、'),
      }
    case 'avoid':
      return {
        patch: { avoid: [...persona.avoid, suggestion.proposed].slice(0, 6) },
        previous: persona.avoid.join('、'),
      }
    case 'tone': {
      if (!(VALID_TONES as readonly string[]).includes(suggestion.proposed)) return null
      return { patch: { tone: suggestion.proposed }, previous: documents.style.tone }
    }
    default:
      return null
  }
}
