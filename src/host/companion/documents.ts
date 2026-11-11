/**
 * Companion document model (design §七).
 *
 * These three Markdown files are product configuration, not long-term facts.
 * They live in `Companion/`, are excluded from the memory index by
 * `SCAN_SKIP_DIRS`, and can only be written by `CompanionService.update()`
 * (management UI). The extraction engine has no path to them.
 *
 * The shape mirrors `dsh-qqbot-merge/src/life/types.ts` structurally, so the
 * two plugins talk over Cordis without a static dependency (design §九.C).
 *
 * ## Why the extra fields
 *
 * A six-line description ("温和、清晰、不过度热情") is a *label*, not a voice.
 * Every mature persona system converges on the same finding — the model learns
 * style from **examples**, not adjectives:
 *
 *  - Character Card V2 (`mes_example`) is consistently rated the strongest
 *    style anchor: a few short exchanges outperform a paragraph of prose, and
 *    formatting habits (line length, punctuation, sentence openers) propagate
 *    from the examples into live output.
 *  - `post_history_instructions` exists because a persona stated once at the
 *    top of a long context drifts; a short restatement at the *end* of the
 *    prompt is what keeps it in voice.
 *  - MemGPT/Letta's `persona` block is deliberately small and concrete, and
 *    hard boundaries are read-only for the agent.
 *
 * So the persona carries four more things: a scenario sentence (when this
 * persona shows up), catchphrases (concrete defaults instead of vague tone
 * words), an explicit *avoid* list (negative examples shape output more
 * sharply than positive ones), and 1–3 example exchanges.
 *
 * All four are optional, so an existing hand-written `Persona.md` keeps
 * working unchanged.
 */
export type SpeakingTone = 'gentle' | 'lively' | 'rational' | 'humorous'

/** One exchange. The strongest style anchor the file format has. */
export interface PersonaExample {
  user: string
  assistant: string
}

export interface CompanionPersona {
  name: string
  identity: string
  temperament: string
  address: string
  languageHabits: string
  /** When this persona shows up, in one sentence. Empty means "always". */
  scenario: string
  /** Recurring sentence patterns — concrete beats "friendly". */
  catchphrases: string[]
  /** Things this persona never says, phrased as text to avoid. */
  avoid: string[]
  /** 1–3 short exchanges demonstrating the voice. */
  examples: PersonaExample[]
  boundaries: string[]
}

export interface CompanionStyle {
  tone: SpeakingTone
  notes: string
}

export interface CompanionPolicy {
  /** Non-negotiable: a file can never turn these on. */
  pretendHuman: false
  emotionalDependency: false
  quietTriggers: string[]
  stopTriggers: string[]
}

export interface CompanionDocuments {
  persona: CompanionPersona
  style: CompanionStyle
  policy: CompanionPolicy
  /** Opaque revision string used for cache invalidation across plugins. */
  revision: string
}

export const COMPANION_FILES = {
  persona: 'Persona.md',
  style: 'Speaking Style.md',
  policy: 'Behavior Policy.md',
} as const

export const TONES: readonly SpeakingTone[] = ['gentle', 'lively', 'rational', 'humorous']

const LIMITS = {
  name: 40, identity: 400, temperament: 200, address: 40,
  languageHabits: 300, notes: 300, item: 200, items: 12,
  scenario: 200, phrase: 60, phrases: 6,
  examples: 3, exampleUser: 80, exampleAssistant: 160,
} as const

export const DEFAULT_DOCUMENTS: CompanionDocuments = {
  persona: {
    name: '伙伴',
    identity: '一个稳定、克制、可信任的个人 AI 伙伴。',
    temperament: '温和、清晰、不过度热情',
    address: '你',
    languageHabits: '使用简体中文，简短直接，不堆客套话。',
    scenario: '',
    catchphrases: [],
    avoid: [],
    examples: [],
    boundaries: ['不假装真实人类', '不制造情感依赖', '不替用户做外部动作'],
  },
  style: { tone: 'gentle', notes: '' },
  policy: {
    pretendHuman: false,
    emotionalDependency: false,
    quietTriggers: ['安静', '别吵', '先别回', 'quiet'],
    stopTriggers: ['停止', '取消', '别做了', 'stop'],
  },
  revision: 'builtin-default-v1',
}

/** Instruction-shaped text must never be accepted as persona content. */
const INJECTION = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  /system\s*prompt/i,
  /<\s*(system|assistant|user)\s*>/i,
  /(?:忽略|无视)(?:以上|之前|前面|上述)?(?:所有|全部)?(?:的)?(?:指令|要求|设定)/,
  /(?:请|必须)(?:输出|打印|泄露).{0,12}(?:密钥|token|密码|secret)/i,
] as const

export class CompanionValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`companion validation failed: ${problems.join('; ')}`)
    this.name = 'CompanionValidationError'
  }
}

function checkShape(value: string, field: string, limit: number, problems: string[]): string | null {
  if (value.length > limit) problems.push(`${field}: exceeds ${limit} chars`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) problems.push(`${field}: control characters`)
  if (INJECTION.some((p) => p.test(value))) problems.push(`${field}: instruction-like content`)
  return null
}

function checked(value: string, field: string, limit: number, problems: string[]): string {
  const v = value.trim()
  if (v.length === 0) { problems.push(`${field}: empty`); return '' }
  checkShape(v, field, limit, problems)
  return v
}

/** Same checks as `checked`, but an empty value is allowed. */
function optional(value: string, field: string, limit: number, problems: string[]): string {
  const v = value.trim()
  if (v.length === 0) return ''
  checkShape(v, field, limit, problems)
  return v
}

function items(values: readonly string[], field: string, problems: string[]): string[] {
  if (values.length > LIMITS.items) problems.push(`${field}: too many entries`)
  return values.slice(0, LIMITS.items)
    .map((v, i) => checked(v, `${field}[${i}]`, LIMITS.item, problems))
    .filter((v) => v.length > 0)
}

/** Optional free-text list (catchphrases / avoid): empty entries are dropped. */
function phrases(values: readonly unknown[], field: string, problems: string[]): string[] {
  const list = values.map(String)
  if (list.length > LIMITS.phrases) problems.push(`${field}: at most ${LIMITS.phrases} entries`)
  return list.slice(0, LIMITS.phrases)
    .map((v, i) => optional(v, `${field}[${i}]`, LIMITS.phrase, problems))
    .filter((v) => v.length > 0)
}

/**
 * Example exchanges.
 *
 * A half-filled pair is an error rather than a silent drop: the user typed
 * something, and losing it on save is worse than being told to finish the line.
 */
function examples(list: unknown, problems: string[]): PersonaExample[] {
  if (!Array.isArray(list)) return []
  if (list.length > LIMITS.examples) problems.push(`persona.examples: at most ${LIMITS.examples}`)
  const out: PersonaExample[] = []
  for (const [index, raw] of list.slice(0, LIMITS.examples).entries()) {
    if (raw === null || typeof raw !== 'object') {
      problems.push(`persona.examples[${index}]: expected object`)
      continue
    }
    const entry = raw as Record<string, unknown>
    const user = optional(typeof entry['user'] === 'string' ? entry['user'] : '', `persona.examples[${index}].user`, LIMITS.exampleUser, problems)
    const assistant = optional(typeof entry['assistant'] === 'string' ? entry['assistant'] : '', `persona.examples[${index}].assistant`, LIMITS.exampleAssistant, problems)
    if (user === '' && assistant === '') continue
    if (user === '' || assistant === '') {
      problems.push(`persona.examples[${index}]: both sides required`)
      continue
    }
    out.push({ user, assistant })
  }
  return out
}

/** Validate and normalise documents from any source (disk file or UI input). */
export function validateDocuments(raw: unknown): CompanionDocuments {
  if (raw === null || typeof raw !== 'object') throw new CompanionValidationError(['documents: expected object'])
  const input = raw as Record<string, unknown>
  const p = (input['persona'] ?? {}) as Record<string, unknown>
  const s = (input['style'] ?? {}) as Record<string, unknown>
  const b = (input['policy'] ?? {}) as Record<string, unknown>
  const problems: string[] = []
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])

  const persona: CompanionPersona = {
    name: checked(str(p['name']), 'persona.name', LIMITS.name, problems),
    identity: checked(str(p['identity']), 'persona.identity', LIMITS.identity, problems),
    temperament: checked(str(p['temperament']), 'persona.temperament', LIMITS.temperament, problems),
    address: checked(str(p['address']), 'persona.address', LIMITS.address, problems),
    languageHabits: checked(str(p['languageHabits']), 'persona.languageHabits', LIMITS.languageHabits, problems),
    scenario: optional(str(p['scenario']), 'persona.scenario', LIMITS.scenario, problems),
    catchphrases: phrases(Array.isArray(p['catchphrases']) ? p['catchphrases'] : [], 'persona.catchphrases', problems),
    avoid: phrases(Array.isArray(p['avoid']) ? p['avoid'] : [], 'persona.avoid', problems),
    examples: examples(p['examples'], problems),
    boundaries: items(list(p['boundaries']), 'persona.boundaries', problems),
  }
  if (persona.boundaries.length === 0) problems.push('persona.boundaries: at least one required')
  const toneRaw = str(s['tone'])
  const tone: SpeakingTone = (TONES as readonly string[]).includes(toneRaw) ? toneRaw as SpeakingTone : 'gentle'
  if (!(TONES as readonly string[]).includes(toneRaw)) problems.push('style.tone: unknown tone')
  const style: CompanionStyle = { tone, notes: str(s['notes']).trim().slice(0, LIMITS.notes) }
  if (INJECTION.some((x) => x.test(style.notes))) problems.push('style.notes: instruction-like content')
  const quiet = items(list(b['quietTriggers']), 'policy.quietTriggers', problems)
  const stop = items(list(b['stopTriggers']), 'policy.stopTriggers', problems)
  const policy: CompanionPolicy = {
    pretendHuman: false,
    emotionalDependency: false,
    quietTriggers: quiet.length > 0 ? quiet : [...DEFAULT_DOCUMENTS.policy.quietTriggers],
    stopTriggers: stop.length > 0 ? stop : [...DEFAULT_DOCUMENTS.policy.stopTriggers],
  }
  const revision = typeof input['revision'] === 'string' ? input['revision'] : 'unversioned'
  if (problems.length > 0) throw new CompanionValidationError(problems)
  return { persona, style, policy, revision }
}

/** Never-throwing read: a bad file degrades to the conservative default. */
export function safeDocuments(raw: unknown): { documents: CompanionDocuments; problems: string[] } {
  try {
    return { documents: validateDocuments(raw), problems: [] }
  } catch (error) {
    const problems = error instanceof CompanionValidationError ? error.problems : ['documents: unreadable']
    return { documents: DEFAULT_DOCUMENTS, problems }
  }
}

const splitList = (value: string): string[] => value.split(/[,，、]/).map((v) => v.trim()).filter((v) => v.length > 0)

/** Parse the key: value form used by the three editable Markdown files. */
export function parseDocument(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    // `example1_user` needs digits, so the key class includes them.
    const m = /^\s*([a-z][a-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (m !== null) out[m[1]!] = m[2]!.trim()
  }
  return out
}

/**
 * Rebuild example pairs from `example1_user` / `example1_assistant` keys.
 *
 * Numbered keys are used instead of one delimited blob so a hand edit in
 * Obsidian stays line-oriented and a diff stays readable.
 */
function examplesFromFile(p: Record<string, string>, limit: number): PersonaExample[] {
  const out: PersonaExample[] = []
  for (let index = 1; index <= limit; index += 1) {
    const user = p[`example${index}_user`] ?? ''
    const assistant = p[`example${index}_assistant`] ?? ''
    // A hand-written file mid-edit may have one side only. Skip the pair rather
    // than rejecting the whole file and silently falling back to the default
    // persona — losing a good persona because of one blank line is worse.
    if (user === '' || assistant === '') continue
    out.push({ user, assistant })
  }
  return out
}

export function documentsFromFiles(files: { persona: string; style: string; policy: string }, revision: string): unknown {
  const p = parseDocument(files.persona)
  const s = parseDocument(files.style)
  const b = parseDocument(files.policy)
  return {
    persona: {
      name: p['name'] ?? '', identity: p['identity'] ?? '', temperament: p['temperament'] ?? '',
      address: p['address'] ?? '', languageHabits: p['language_habits'] ?? '',
      scenario: p['scenario'] ?? '',
      catchphrases: splitList(p['catchphrases'] ?? ''),
      avoid: splitList(p['avoid'] ?? ''),
      examples: examplesFromFile(p, LIMITS.examples),
      boundaries: splitList(p['boundaries'] ?? ''),
    },
    style: { tone: s['tone'] ?? 'gentle', notes: s['notes'] ?? '' },
    // pretend_human / emotional_dependency are intentionally NOT read from the
    // file: those two boundaries are hard-coded and cannot be disabled.
    policy: {
      pretendHuman: false, emotionalDependency: false,
      quietTriggers: splitList(b['quiet_triggers'] ?? ''),
      stopTriggers: splitList(b['stop_triggers'] ?? ''),
    },
    revision,
  }
}

export function renderFiles(docs: CompanionDocuments): { persona: string; style: string; policy: string } {
  const personaLines = [
    '# Companion · Persona', '',
    `name: ${docs.persona.name}`,
    `identity: ${docs.persona.identity}`,
    `temperament: ${docs.persona.temperament}`,
    `address: ${docs.persona.address}`,
    `language_habits: ${docs.persona.languageHabits}`,
  ]
  if (docs.persona.scenario !== '') personaLines.push(`scenario: ${docs.persona.scenario}`)
  if (docs.persona.catchphrases.length > 0) personaLines.push(`catchphrases: ${docs.persona.catchphrases.join(', ')}`)
  if (docs.persona.avoid.length > 0) personaLines.push(`avoid: ${docs.persona.avoid.join(', ')}`)
  personaLines.push(`boundaries: ${docs.persona.boundaries.join(', ')}`)
  if (docs.persona.examples.length > 0) {
    personaLines.push('', '# 示例对话：模型主要从这里学语气，比上面的形容词更有用。')
    docs.persona.examples.forEach((example, index) => {
      personaLines.push(`example${index + 1}_user: ${example.user}`)
      personaLines.push(`example${index + 1}_assistant: ${example.assistant}`)
    })
  }
  personaLines.push('', '> 由 PC 管理页面编辑；本目录不属于长期事实记忆索引。', '')

  return {
    persona: personaLines.join('\n'),
    style: [
      '# Companion · Speaking Style', '',
      `tone: ${docs.style.tone}`,
      `notes: ${docs.style.notes}`, '',
    ].join('\n'),
    policy: [
      '# Companion · Behavior Policy', '',
      'pretend_human: false', 'emotional_dependency: false',
      `quiet_triggers: ${docs.policy.quietTriggers.join(', ')}`,
      `stop_triggers: ${docs.policy.stopTriggers.join(', ')}`, '',
      '> 前两项为硬性边界，文件内的取值不会被读取。', '',
    ].join('\n'),
  }
}
