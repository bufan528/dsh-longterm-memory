/**
 * The memory engine: turning conversation into durable memory, safely.
 *
 * Split deliberately into pure decision functions so every rule can be tested
 * without a filesystem, a model, or a DSH host. The engine never writes; it
 * returns a decision that `MemoryService` executes.
 *
 * Guarantees this module enforces:
 * - No guess becomes a stated fact: a low-confidence candidate is parked in the
 *   Inbox with status `pending` instead of being written as `active`.
 * - Secrets are not persisted; high-severity secrets refuse the whole candidate.
 * - Contradictions are preserved on both sides rather than silently overwritten.
 * - Duplicates are folded rather than re-created.
 *
 * @module dsh-longterm-memory/host/core/engine
 */

import type {
  CandidateDecision,
  Confidence,
  MemoryCandidate,
  MemoryType,
} from '../../shared/types.js'
import { TYPE_DESCRIPTORS } from '../../shared/types.js'
import type { RawModelCandidate, RefusedModelCandidate } from './llm-extraction.js'
import { defaultImportance, newMemoryId } from '../../shared/validate.js'
import { tokenize } from '../../shared/search.js'
import type { MemoryIndex } from '../../shared/search.js'

/* ------------------------------------------------------------------ secrets */

export type SecretKind =
  | 'private-key'
  | 'bearer-token'
  | 'api-key'
  | 'password'
  | 'jwt'
  | 'aws-key'
  | 'github-token'
  | 'openai-key'
  | 'credential-assignment'
  | 'long-opaque-blob'
  | 'cjk-credential-word'

export interface SecretFinding {
  kind: SecretKind
  /** Severity `high` refuses the candidate; `low` only redacts. */
  severity: 'high' | 'low'
  /** Position in the scanned text. */
  index: number
  /** Exclusive end offset, used to merge overlapping detections. */
  end: number
  /** A masked sample, safe to show a human and to log. */
  masked: string
}

interface SecretPattern {
  kind: SecretKind
  severity: 'high' | 'low'
  pattern: RegExp
}

/**
 * Patterns are intentionally explicit rather than clever: a false positive only
 * costs the user a confirmation, a false negative leaks a credential into a
 * plain-text vault.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'private-key', severity: 'high', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'bearer-token', severity: 'high', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: 'openai-key', severity: 'high', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'github-token', severity: 'high', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'aws-key', severity: 'high', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'jwt', severity: 'high', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: 'api-key',
    severity: 'high',
    pattern:
      /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|app[_-]?secret)\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{8,})/gi,
  },
  {
    kind: 'password',
    severity: 'high',
    pattern: /\b(?:password|passwd|pwd|passphrase)\b\s*[:=]\s*["']?(\S{4,})/gi,
  },
  {
    kind: 'credential-assignment',
    severity: 'low',
    pattern: /\b(?:token|secret|credential)\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{12,})/gi,
  },
  { kind: 'cjk-credential-word', severity: 'high', pattern: /(?:密码|密钥|私钥|口令|访问令牌|令牌)\s*(?:是|为|：|:)\s*(\S{4,})/g },
  { kind: 'long-opaque-blob', severity: 'low', pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g },
]

/** Mask a matched value so it can be shown without leaking it. */
export function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 8) return '*'.repeat(Math.max(4, trimmed.length))
  return `${trimmed.slice(0, 4)}${'*'.repeat(Math.min(12, trimmed.length - 8))}${trimmed.slice(-4)}`
}

/** Find credential-looking content. Overlapping detections are merged. */
export function scanSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const { kind, severity, pattern } of SECRET_PATTERNS) {
    // Every pattern is global; reset defensively because they are module-level.
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const matched = match[1] ?? match[0]
      // Report the span of the sensitive VALUE, not the whole assignment, so two
      // patterns matching the same credential merge into one finding.
      const valueIndex = match[1] !== undefined ? match.index + match[0].indexOf(match[1]) : match.index
      findings.push({
        kind,
        severity,
        index: valueIndex,
        end: valueIndex + matched.length,
        masked: maskSecret(matched),
      })
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1
      if (findings.length > 200) break
    }
  }
  return mergeFindings(findings)
}

/**
 * Merge overlapping detections into disjoint spans.
 *
 * This matters for the "is this message mostly a secret?" judgement: `sk-…`
 * matches both the provider-specific pattern and the generic `api_key =` one, so
 * counting raw matches would report one credential twice and refuse a long note
 * that merely mentions a key.
 */
export function mergeFindings(findings: readonly SecretFinding[]): SecretFinding[] {
  if (findings.length === 0) return []
  const sorted = [...findings].sort((a, b) => (a.index !== b.index ? a.index - b.index : b.end - a.end))
  const merged: SecretFinding[] = []
  for (const finding of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && finding.index < last.end) {
      // Keep the higher severity and the longer span; drop the duplicate.
      if (finding.severity === 'high' && last.severity !== 'high') last.severity = 'high'
      if (finding.end > last.end) last.end = finding.end
      continue
    }
    merged.push({ ...finding })
  }
  return merged
}

/**
 * Replace every secret span with a placeholder.
 *
 * Kept separate from scanning so the caller can decide: a long note that merely
 * mentions a key can be redacted and kept, while a note that *is* a key is
 * refused.
 */
export function redactSecrets(text: string): string {
  const spans = mergeFindings(scanSecrets(text))
  if (spans.length === 0) return text
  let out = ''
  let cursor = 0
  for (const span of spans) {
    out += text.slice(cursor, span.index)
    out += `[已移除:${span.masked}]`
    cursor = span.end
  }
  out += text.slice(cursor)
  return out
}

/**
 * Whether the text is *predominantly* a secret.
 *
 * A message that is mostly a credential must not be turned into a memory note
 * even in redacted form, because the surrounding prose usually says what it is
 * for and where it is used.
 */
export function isPredominantlySecret(text: string, findings: readonly SecretFinding[]): boolean {
  const high = mergeFindings(findings).filter((finding) => finding.severity === 'high')
  if (high.length === 0) return false
  // Two distinct high-severity credentials in one message is never a memory.
  if (high.length >= 2) return true
  const contentChars = text.replace(/\s+/g, '').length
  if (contentChars === 0) return false
  const secretChars = high.reduce((total, finding) => total + (finding.end - finding.index), 0)
  // When the credential is at least half of the message there is not enough
  // surrounding prose for a memory note to carry any other meaning, so the whole
  // candidate is refused rather than stored in redacted form.
  return secretChars / contentChars >= 0.5
}

/* --------------------------------------------------------------- sensitivity */

export type SensitiveCategory = 'health' | 'finance' | 'identity' | 'relationship' | 'legal'

const SENSITIVE_PATTERNS: readonly { category: SensitiveCategory; pattern: RegExp }[] = [
  { category: 'health', pattern: /(病历|诊断|确诊|处方|用药|手术|抑郁症|焦虑症|血糖|血压|化疗|体检报告|diagnosis|prescription|medical record)/i },
  { category: 'finance', pattern: /(工资|薪资|存款|余额|流水|贷款|房贷|信用卡号|银行卡|投资组合|持仓|税号|年薪|salary|bank account|credit card|mortgage)/i },
  { category: 'identity', pattern: /(身份证|护照|社保号|户籍|家庭住址|手机号|电话号码|\bSSN\b|\bpassport\b|social security)/i },
  { category: 'relationship', pattern: /(离婚|婚姻|家庭矛盾|子女|抚养|relationship|divorce)/i },
  { category: 'legal', pattern: /(诉讼|律师|合同纠纷|判决|仲裁|lawsuit|litigation)/i },
]

export function scanSensitive(text: string): SensitiveCategory[] {
  const out: SensitiveCategory[] = []
  for (const { category, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) out.push(category)
  }
  return out
}

/* ---------------------------------------------------------------- extraction */

/** Signals that the user is stating something durable. */
interface SignalRule {
  type: MemoryType
  /** Confidence when this rule is the strongest match. */
  confidence: Confidence
  patterns: readonly RegExp[]
  /** Higher wins when several rules match. */
  weight: number
}

const SIGNAL_RULES: readonly SignalRule[] = [
  {
    type: 'preference',
    confidence: 'high',
    weight: 100,
    patterns: [
      /(请)?记住[：:，,]?\s*(我|我的|本人)?/,
      /\bremember\b/i,
      /(以后|今后|下次)(都|请|要|不要|别)/,
      /我(更)?(喜欢|偏好|习惯|倾向于)/,
      /我(不|讨厌|不喜欢)/,
      /(prefer|I always|I never|from now on)/i,
    ],
  },
  {
    type: 'profile',
    confidence: 'high',
    weight: 95,
    patterns: [
      /我(是|叫|从事|在做)/,
      /我(的)?(职业|职位|岗位|专业|背景|方向|技能栈|技术栈)/,
      /我(住|在)(北京|上海|广州|深圳|杭州|成都|中国|美国)/,
      /\bI am a\b/i,
      /my (role|profession|job|background|timezone) is/i,
    ],
  },
  {
    type: 'decision',
    confidence: 'high',
    weight: 90,
    patterns: [
      /(我们|我)(已经)?(决定|确定|敲定|选定|拍板)/,
      /(最终|就)(决定|选择|采用|用)/,
      /(放弃|不再使用|停止使用|改为|换成|迁移到|切换到)/,
      /(理由|原因)(是|：|:)/,
      /\bwe (decided|chose|settled on)\b/i,
      /\bthe decision is\b/i,
    ],
  },
  {
    type: 'experience',
    confidence: 'medium',
    weight: 80,
    patterns: [
      /(教训|踩坑|踩了|坑点|经验是|以后不要|不要再|避免|根因|复盘)/,
      /\b(lesson learned|gotcha|pitfall|root cause)\b/i,
    ],
  },
  {
    type: 'task',
    confidence: 'medium',
    weight: 70,
    patterns: [
      /(待办|TODO|下一步|接下来要|还需要|必须完成|记得要)/i,
      /\b(todo|next step|action item)\b/i,
    ],
  },
  {
    type: 'project-state',
    confidence: 'medium',
    weight: 65,
    patterns: [
      /(进度|阶段|已完成|尚未完成|阻塞|卡在|当前状态|里程碑|下一步计划)/,
      /\b(progress|milestone|blocked|in progress)\b/i,
    ],
  },
  {
    type: 'project',
    confidence: 'medium',
    weight: 60,
    patterns: [/(我(们)?(的)?项目|正在(做|开发|推进)|新项目|这个项目)/, /\b(my|our) project\b/i],
  },
  {
    type: 'knowledge',
    confidence: 'medium',
    weight: 50,
    patterns: [/(事实|结论|结论是|证明了|验证了|实测|文档说明|根据)/, /\b(verified|confirmed|according to)\b/i],
  },
]

/** Messages that must never become memories on their own. */
const NOISE_PATTERNS: readonly RegExp[] = [
  /^(你好|您好|hi|hello|hey|谢谢|thanks|thank you|ok|好的|收到|嗯+|哈哈+)[!！。.~～]*$/i,
  /^(继续|go on|continue|接着|然后呢)[?？!！。.]*$/i,
]

export interface TurnInput {
  /** The user's message for this turn, already reduced to text. */
  userText: string
  /** The assistant's reply, used only as evidence context. */
  assistantText?: string
  /** Session id, when the host supplied one. */
  sessionId?: string
  /** Turn number, used in the evidence string. */
  turn?: number
  /** Session working directory, when known. */
  cwd?: string
}

export interface ExtractionOptions {
  /** Refuse candidates containing secrets. */
  redactSecrets: boolean
  /** Force confirmation for health/finance/identity content. */
  sensitiveNeedsConfirmation: boolean
  /** Maximum candidates per turn. */
  maxCandidates: number
  /** Injectable clock/id source for deterministic tests. */
  now?: Date
  random?: () => number
}

export interface ExtractionOutcome {
  candidates: MemoryCandidate[]
  /** Candidates dropped entirely, with the reason, for the audit log. */
  refused: { reason: string; excerpt: string }[]
  /** Secret kinds seen, masked. */
  secrets: SecretFinding[]
  sensitive: SensitiveCategory[]
}

/**
 * Map model-proposed candidates through exactly the same policy as the rule path.
 *
 * The model's answer is untrusted: it may echo a credential, invent a fact, or
 * be talked into proposing something sensitive. Every candidate therefore goes
 * through the same secret scan and sensitivity downgrade as a rule candidate, and
 * a candidate the model claims with `high` confidence is still capped at `medium`
 * unless the text it cites actually appears in the conversation — a model that
 * fabricates support for its own claim does not get to promote it to fact.
 */
export function candidatesFromModel(
  raw: readonly RawModelCandidate[],
  input: TurnInput,
  options: ExtractionOptions,
): { candidates: MemoryCandidate[]; refused: RefusedModelCandidate[] } {
  const now = options.now ?? new Date()
  const random = options.random ?? Math.random
  const candidates: MemoryCandidate[] = []
  const refused: RefusedModelCandidate[] = []

  // The conversation is the only evidence a candidate may cite.
  const conversation = `${input.userText}\n${input.assistantText ?? ''}`.toLowerCase()

  for (const item of raw) {
    if (candidates.length >= options.maxCandidates) break

    let title = item.title.trim()
    let summary = item.summary.trim()
    if (title.length === 0 || summary.length === 0) {
      refused.push({ title: title.length > 0 ? title : '(无标题)', reason: '标题或正文为空' })
      continue
    }

    const findings = scanSecrets(`${title}\n${summary}\n${item.evidence}`)
    if (findings.length > 0) {
      if (!options.redactSecrets) {
        // Explicitly configured to allow it; record that fact.
      } else if (isPredominantlySecret(`${title}\n${summary}`, findings)) {
        refused.push({ title: maskText(title), reason: '模型提出的候选主要由机密内容构成，已拒绝' })
        continue
      } else {
        title = redactSecrets(title)
        summary = redactSecrets(summary)
      }
    }

    const sensitive = scanSensitive(`${title}\n${summary}`)
    let confidence: Confidence = item.confidence
    const notes: string[] = ['模型提取']

    // Ground the claim: if neither the title nor the summary is supported by the
    // conversation text at all, the model inferred or invented it.
    const grounded = isGrounded(title, summary, conversation)
    if (!grounded) {
      confidence = 'low'
      notes.push('模型给出的内容未能在对话原文中定位到依据，已降级为 low')
    } else if (confidence === 'high') {
      // A grounded, explicitly-asserted fact may stay high only when the user's
      // own words carry the statement; the assistant's text alone is context.
      const userOnly = input.userText.toLowerCase()
      if (!isGrounded(title, summary, userOnly)) {
        confidence = 'medium'
        notes.push('依据仅出现在助手回复中，置信度降为 medium')
      }
    }

    if (sensitive.length > 0 && options.sensitiveNeedsConfirmation) {
      confidence = confidence === 'high' ? 'medium' : confidence
      notes.push(`涉及敏感类别（${sensitive.join('、')}），需人工确认`)
    }

    candidates.push({
      id: newMemoryId(now, random),
      type: item.type,
      title: title.slice(0, 200),
      summary: summary.slice(0, 2000),
      tags: [...new Set([TYPE_DESCRIPTORS[item.type].defaultTag, ...item.tags.map(normalizeTag)])].filter(
        (tag) => tag.length > 0,
      ),
      confidence,
      importance:
        item.importance > 0 ? clampImportance(item.importance) : clampImportance(defaultImportance(item.type)),
      sourceSessions: input.sessionId !== undefined && input.sessionId.length > 0 ? [input.sessionId] : [],
      evidence:
        item.evidence.length > 0
          ? `${buildEvidence(input, item.evidence)}\n模型提出的依据：${maskText(item.evidence)}`
          : buildEvidence(input, summary),
      createdAt: now.toISOString(),
      reason: notes.join('；'),
      relatedIds: item.relatedId === undefined ? [] : [item.relatedId],
      decision: { action: 'inbox', rationale: '尚未与现有记忆比对' },
    })
  }

  return { candidates, refused }
}

/** Whether some distinctive part of the claim actually appears in `haystack`. */
function isGrounded(title: string, summary: string, haystack: string): boolean {
  const terms = [...comparisonTerms(title), ...comparisonTerms(summary)]
  if (terms.length === 0) return false
  let hits = 0
  for (const term of terms) {
    if (haystack.includes(term)) hits += 1
  }
  // Demand a real share of the claim's distinctive terms, not a single lucky word.
  return hits / terms.length >= 0.5
}

function normalizeTag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 48)
}

/**
 * Extract candidate memories from one completed turn.
 *
 * Rule-based and deterministic by design: it runs on every turn with no network
 * call, no cost, and no privacy implication. `candidatesFromModel` layers an
 * optional model pass on top; this function stays the default and the fallback.
 */
export function extractFromTurn(input: TurnInput, options: ExtractionOptions): ExtractionOutcome {
  const now = options.now ?? new Date()
  const random = options.random ?? Math.random
  const refused: ExtractionOutcome['refused'] = []

  const userText = input.userText.replace(/\r\n/g, '\n').trim()
  const assistantText = (input.assistantText ?? '').replace(/\r\n/g, '\n').trim()
  const combined = [userText, assistantText].filter((part) => part.length > 0).join('\n\n')

  const findings = scanSecrets(combined)
  const sensitive = scanSensitive(combined)

  if (userText.length < 6) {
    return { candidates: [], refused, secrets: findings, sensitive }
  }
  if (NOISE_PATTERNS.some((pattern) => pattern.test(userText))) {
    return { candidates: [], refused, secrets: findings, sensitive }
  }

  // Split the user's message into statements so one long message can yield
  // several independent memories.
  const statements = splitStatements(userText).filter((statement) => statement.length >= 6)
  const candidates: MemoryCandidate[] = []

  for (const statement of statements) {
    if (candidates.length >= options.maxCandidates) break

    const rule = bestRule(statement)
    if (rule === null) continue
    if (isQuestion(statement) && rule.weight < 95) continue

    let title = deriveTitle(statement)
    let summary = statement
    let confidence: Confidence = rule.confidence
    const notes: string[] = [`规则匹配：${TYPE_DESCRIPTORS[rule.type].labelZh}`]

    // Secrets: refuse a message that *is* a credential, otherwise redact.
    const statementFindings = scanSecrets(statement)
    if (statementFindings.length > 0) {
      if (!options.redactSecrets) {
        notes.push('检测到疑似机密内容，但当前设置允许保存')
      } else if (isPredominantlySecret(statement, statementFindings) || isPredominantlySecret(combined, findings)) {
        refused.push({ reason: '包含高置信度机密（API Key/密码/令牌/私钥），已拒绝写入长期记忆', excerpt: maskText(statement) })
        continue
      } else {
        summary = redactSecrets(statement)
        title = redactSecrets(title)
        confidence = degrade(confidence)
        notes.push(`已移除 ${String(statementFindings.length)} 处疑似机密内容`)
      }
    }

    const statementSensitive = scanSensitive(statement)
    if (statementSensitive.length > 0 && options.sensitiveNeedsConfirmation) {
      confidence = 'medium'
      notes.push(`涉及敏感类别（${statementSensitive.join('、')}），需人工确认`)
    }

    // A statement the user did not assert as durable, inferred only from a weak
    // rule, stays low confidence so it cannot become a stated fact.
    if (rule.confidence === 'medium' && !/(记住|remember)/i.test(statement)) confidence = degrade(confidence)

    candidates.push({
      id: newMemoryId(now, random),
      type: rule.type,
      title: title.slice(0, 120),
      summary: summary.slice(0, 2000),
      tags: [TYPE_DESCRIPTORS[rule.type].defaultTag, ...deriveTags(statement)],
      confidence,
      importance: clampImportance(defaultImportance(rule.type) + (rule.confidence === 'high' ? 10 : -5)),
      sourceSessions: input.sessionId !== undefined && input.sessionId.length > 0 ? [input.sessionId] : [],
      evidence: buildEvidence(input, statement),
      createdAt: now.toISOString(),
      reason: notes.join('；'),
      relatedIds: [],
      decision: { action: 'inbox', rationale: '尚未与现有记忆比对' },
    })
  }

  return { candidates, refused, secrets: findings, sensitive }
}

function bestRule(statement: string): SignalRule | null {
  let best: SignalRule | null = null
  for (const rule of SIGNAL_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(statement))) continue
    if (best === null || rule.weight > best.weight) best = rule
  }
  return best
}

/** Split a message into assertion-sized statements. */
export function splitStatements(text: string): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim()
    if (trimmed.length === 0) continue
    // Chinese full stop / semicolon and Latin sentence punctuation both delimit.
    const parts = trimmed.split(/(?<=[。！？!?；;])\s*/)
    for (const part of parts) {
      const statement = part.trim()
      if (statement.length > 0) out.push(statement)
    }
  }
  return out
}

function isQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text)
}

function deriveTitle(statement: string): string {
  const cleaned = statement
    .replace(/^(?:请)?记住[：:，,]?\s*/, '')
    .replace(/^\s*(?:我(?:们)?(?:已经)?(?:觉得|认为|决定|确定)|我觉得)\s*/, '')
    .trim()
  const firstSentence = cleaned.split(/[。！？!?\n]/)[0] ?? cleaned
  const clipped = firstSentence.length > 60 ? `${firstSentence.slice(0, 60)}…` : firstSentence
  return clipped.length > 0 ? clipped : cleaned.slice(0, 60)
}

function deriveTags(statement: string): string[] {
  const tags: string[] = []
  const pairs: readonly [RegExp, string][] = [
    [/TypeScript|typescript|ts\b/, 'typescript'],
    [/Python|python/, 'python'],
    [/Rust|rust/, 'rust'],
    [/React|react/, 'react'],
    [/Obsidian|obsidian/, 'obsidian'],
    [/Windows|windows/, 'windows'],
    [/macOS|macos|Mac\b/, 'macos'],
    [/Linux|linux/, 'linux'],
    [/数据库|database|sqlite|postgres/i, 'database'],
    [/前端|frontend/i, 'frontend'],
    [/后端|backend/i, 'backend'],
  ]
  for (const [pattern, tag] of pairs) {
    if (pattern.test(statement)) tags.push(tag)
    if (tags.length >= 4) break
  }
  return tags
}

function buildEvidence(input: TurnInput, statement: string): string {
  const parts: string[] = []
  parts.push(`来源：会话 ${input.sessionId !== undefined && input.sessionId.length > 0 ? input.sessionId : '（宿主未提供会话 ID）'}`)
  if (input.turn !== undefined) parts.push(`轮次：第 ${String(input.turn)} 轮`)
  if (input.cwd !== undefined && input.cwd.length > 0) parts.push(`工作目录：${input.cwd}`)
  parts.push(`用户原话摘要：${maskText(statement)}`)
  return parts.join('\n')
}

function maskText(text: string): string {
  const redacted = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted
}

function degrade(level: Confidence): Confidence {
  if (level === 'high') return 'medium'
  return 'low'
}

function clampImportance(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/* ------------------------------------------------------- comparison & policy */

export interface ComparisonOptions {
  /** Minimum token-set similarity to consider two memories the same subject. */
  duplicateThreshold: number
  /** Minimum similarity for a supplement rather than a new memory. */
  relatedThreshold: number
}

export const DEFAULT_COMPARISON: ComparisonOptions = { duplicateThreshold: 0.82, relatedThreshold: 0.45 }

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Whether a token carries enough signal to judge topical similarity.
 *
 * Single CJK characters are excluded: the tokenizer emits them so that substring
 * search works, but "的"/"是"/"用" are far too common to mean two notes are about
 * the same thing. CJK bigrams and latin words are kept.
 */
export function isComparisonTerm(token: string): boolean {
  if (/^[a-z0-9][a-z0-9_]*$/.test(token)) return token.length > 1 || /[0-9]/.test(token)
  return token.length >= 2
}

/** Build the topical term set used for duplicate/conflict judgement. */
export function comparisonTerms(text: string): Set<string> {
  const out = new Set<string>()
  for (const token of tokenize(text)) {
    if (isComparisonTerm(token)) out.add(token)
  }
  return out
}

/**
 * Overlap coefficient: |A∩B| / min(|A|,|B|).
 *
 * Preferred over Jaccard here because CJK notes about the same subject differ
 * wildly in length, and Jaccard penalises a short supplement to a long memory.
 */
export function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / Math.min(a.size, b.size)
}

/** The topical term set of an indexed record, from its stored term keys. */
export function termsOfRecord(terms: Readonly<Record<string, number>>): Set<string> {
  const out = new Set<string>()
  for (const key of Object.keys(terms)) {
    if (isComparisonTerm(key)) out.add(key)
  }
  return out
}

const NEGATION = /(不|不要|不再|没有|别|取消|放弃|停止|禁止|never|not|no longer|cancel|stop|disable)/i
const COUNTER = /(改为|换成|取代|替代|重新|instead|switch to|replace)/i

function numbersIn(text: string): Set<string> {
  const out = new Set<string>()
  for (const match of text.matchAll(/\d+(?:\.\d+)?/g)) out.add(match[0])
  return out
}

export interface ExistingMemoryView {
  id: string
  type: string
  title: string
  summary: string
  status: string
  terms: Record<string, number>
}

export interface ComparisonResult {
  decision: CandidateDecision
  /** Similarity of the closest existing memory, for the UI's explanation. */
  bestSimilarity: number
  bestId: string | null
}

/**
 * Decide what a candidate should do, given what already exists.
 *
 * Order matters: contradiction is checked before duplication, so a note that
 * reverses an existing fact is never treated as a harmless restatement.
 */
export function compareCandidate(
  candidate: MemoryCandidate,
  existing: readonly ExistingMemoryView[],
  options: ComparisonOptions = DEFAULT_COMPARISON,
): ComparisonResult {
  const candidateTerms = comparisonTerms(`${candidate.title}\n${candidate.summary}`)
  let best: { view: ExistingMemoryView; similarity: number } | null = null

  for (const view of existing) {
    if (view.status === 'archived') continue
    const similarity = overlapCoefficient(candidateTerms, termsOfRecord(view.terms))
    if (best === null || similarity > best.similarity) best = { view, similarity }
  }

  if (best === null || best.similarity < options.relatedThreshold) {
    return { decision: { action: 'create' }, bestSimilarity: best?.similarity ?? 0, bestId: best?.view.id ?? null }
  }

  const sameType = best.view.type === candidate.type
  const candidateText = `${candidate.title}\n${candidate.summary}`
  const existingText = `${best.view.title}\n${best.view.summary}`
  const negationDiffers = NEGATION.test(candidateText) !== NEGATION.test(existingText)
  const counterSignal = COUNTER.test(candidateText)
  const candidateNumbers = numbersIn(candidateText)
  const existingNumbers = numbersIn(existingText)
  const numbersDiffer =
    candidateNumbers.size > 0 &&
    existingNumbers.size > 0 &&
    [...candidateNumbers].some((value) => !existingNumbers.has(value))

  if (sameType && (negationDiffers || counterSignal || numbersDiffer) && best.similarity >= 0.3) {
    return {
      decision: {
        action: 'conflict',
        targetId: best.view.id,
        rationale: [
          '与现有记忆高度相关但内容相互矛盾',
          negationDiffers ? '存在否定表述差异' : '',
          counterSignal ? '包含替换/更改语义' : '',
          numbersDiffer ? '数值不一致' : '',
        ]
          .filter((part) => part.length > 0)
          .join('；'),
      },
      bestSimilarity: best.similarity,
      bestId: best.view.id,
    }
  }

  if (sameType && best.similarity >= options.duplicateThreshold) {
    return {
      decision: {
        action: 'merge',
        targetIds: [best.view.id],
        rationale: `与现有记忆 ${best.view.id} 高度相似（${(best.similarity * 100).toFixed(0)}%），建议合并而不是重复创建`,
      },
      bestSimilarity: best.similarity,
      bestId: best.view.id,
    }
  }

  // A supplement is only a supplement of the *same kind* of memory; folding a
  // decision into a task note would destroy both.
  if (!sameType) {
    return {
      decision: { action: 'create' },
      bestSimilarity: best.similarity,
      bestId: best.view.id,
    }
  }

  return {
    decision: {
      action: 'update',
      targetId: best.view.id,
      rationale: `是现有记忆 ${best.view.id} 的补充（相似度 ${(best.similarity * 100).toFixed(0)}%），建议并入并保留来源`,
    },
    bestSimilarity: best.similarity,
    bestId: best.view.id,
  }
}

/**
 * Whether a decision may be applied without asking the user.
 *
 * Only an explicitly asserted, high-confidence **new** fact or supplement is
 * auto-applied. Merges, conflicts, and anything the user did not assert
 * confidently wait in the Inbox.
 */
export function mayAutoApply(candidate: MemoryCandidate): boolean {
  if (candidate.refused !== undefined) return false
  if (candidate.confidence !== 'high') return false
  return candidate.decision.action === 'create' || candidate.decision.action === 'update'
}

/** Turn existing index records into the compact view the comparison needs. */
export function viewsFromIndex(index: MemoryIndex, records?: readonly string[]): ExistingMemoryView[] {
  const allowed = records === undefined ? null : new Set(records)
  const out: ExistingMemoryView[] = []
  for (const record of index.records.values()) {
    if (allowed !== null && !allowed.has(record.id)) continue
    out.push({
      id: record.id,
      type: record.type,
      title: record.title,
      summary: record.preview,
      status: record.status,
      terms: record.terms,
    })
  }
  return out
}
