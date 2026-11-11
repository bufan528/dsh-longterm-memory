/**
 * The persona text that actually reaches a model.
 *
 * This is a faithful, dependency-free reimplementation of the QQ plugin's
 * `projectPersona` (`dist/life/persona/context.js`) plus the section wrapper in
 * `dist/life/conversation/context-builder.js`. It lives in `shared/` because
 * both halves need the same answer:
 *
 *  - the Host uses it to run a one-line persona preview;
 *  - the management page uses it to warn when a field the user carefully wrote
 *    is **silently dropped** by the character budget.
 *
 * Why reimplement instead of importing: the QQ plugin is a separate bundle
 * reached through Cordis at runtime, and a static import would make this plugin
 * uninstallable on a machine without it. The contract we mirror is textual, so
 * reimplementation is the only shape that keeps both plugins independent.
 *
 * ## The behaviour that matters
 *
 * Layers are dropped **whole, by weight, from the least essential first** until
 * the text fits. A half-printed example teaches worse style than no example.
 * `weight: 0` layers are irreducible. Once the budget is exceeded, the first to
 * go is the scenario (3), then catchphrases / avoid (2), then examples (1).
 *
 * That means a user can fill in a beautiful example dialogue and have it never
 * reach the model. `dropped` exposes exactly that, so the page can say so
 * instead of leaving the user to wonder why the persona "does not stick".
 *
 * ## A known sharp edge in the QQ runtime we deliberately preserve
 *
 * When even the `weight: 0` core exceeds the budget, `assemble` slices from the
 * head — which cuts off the *tail*, including the hard boundary and the closing
 * anti-drift restatement. The QQ source comment claims those must survive every
 * cut, but the implementation does not. We do **not** silently "fix" it here:
 * the preview's whole value is describing the voice QQ will actually produce.
 * `hardTruncated` reports this case so the self-check can tell the user to
 * shorten `identity` / `languageHabits` instead.
 *
 * @module dsh-longterm-memory/shared/persona-projection
 */

/** Mirrors the QQ runtime's constants. */
export const PERSONA_BUDGET = {
  /** Total character budget for the persona section. */
  textLimit: 760,
  /** Room reserved for the channel adaptation line, so core is cut earlier. */
  adaptationReserve: 120,
  /** Never shrink the core below this, even if the budget says otherwise. */
  minCore: 320,
  /** Wrapper budget for the whole `[伙伴规则]` section. */
  contextSectionLimit: 900,
} as const

/**
 * QQ plugin's `dist/life/persona/context.js` declares `PERSONA_TEXT_LIMIT = 760`
 * at runtime while its shipped `context.d.ts` still says 600 — the two are out
 * of sync. The runtime value is what actually governs behaviour, so that is the
 * one mirrored here.
 */

/** The fields a projection needs; structurally compatible with `CompanionDocuments`. */
export interface PersonaProjectionInput {
  name: string
  identity: string
  temperament: string
  address: string
  languageHabits: string
  boundaries: readonly string[]
  scenario: string
  catchphrases: readonly string[]
  avoid: readonly string[]
  examples: readonly { user: string; assistant: string }[]
  tone: string
  notes: string
}

export interface PersonaLayer {
  /** Stable id used in diagnostics. */
  key: string
  /** Human label for the "this was cut" message. */
  label: string
  text: string
  /** 0 = irreducible; larger = dropped sooner. */
  weight: number
}

export interface DroppedLayer {
  key: string
  label: string
}

export interface PersonaProjection {
  /** `core` plus the channel adaptation, bounded by `textLimit`. */
  text: string
  core: string
  adaptation: string
  /** Layers removed by the budget, in cut order. */
  dropped: readonly DroppedLayer[]
  maxChars: number
  allowStickers: boolean
  /** True when even the irreducible core had to be sliced. */
  hardTruncated: boolean
}

const HARD_BOUNDARY = '不可假装真实人类，不可制造情感依赖。'
const CLOSING = '按上面的语气说话；不要解释这些规则，也不要复述设定。'

/** Build the ordered layers exactly as the QQ runtime does. */
export function buildPersonaLayers(docs: PersonaProjectionInput): PersonaLayer[] {
  const layers: PersonaLayer[] = [
    { key: 'name', label: '名字', weight: 0, text: `伙伴：${docs.name}` },
    { key: 'identity', label: '身份', weight: 0, text: `身份：${docs.identity}` },
    { key: 'temperament', label: '性格与风格', weight: 0, text: `性格：${docs.temperament}｜表达风格：${docs.tone}` },
    { key: 'address', label: '称呼', weight: 0, text: `称呼用户：${docs.address}` },
    { key: 'languageHabits', label: '说话方式', weight: 0, text: `说话方式：${docs.languageHabits}` },
    { key: 'boundaries', label: '行为边界', weight: 0, text: `行为边界：${docs.boundaries.join('；')}` },
  ]

  const scenario = docs.scenario.trim()
  if (scenario !== '') layers.push({ key: 'scenario', label: '适用场景', weight: 3, text: `适用场景：${scenario}` })

  const catchphrases = docs.catchphrases.filter((phrase) => phrase.trim() !== '')
  if (catchphrases.length > 0) {
    layers.push({ key: 'catchphrases', label: '口头禅', weight: 2, text: `常用句式：${catchphrases.join('；')}` })
  }

  const avoid = docs.avoid.filter((phrase) => phrase.trim() !== '')
  if (avoid.length > 0) {
    layers.push({ key: 'avoid', label: '禁用表达', weight: 2, text: `不要说：${avoid.join('；')}` })
  }

  const examples = docs.examples.filter((example) => example.user !== '' && example.assistant !== '')
  if (examples.length > 0) {
    layers.push({
      key: 'examples',
      label: '示例对话',
      weight: 1,
      text: [
        '示例对话（学语气，不要照抄内容）：',
        ...examples.map((example) => `用户：${example.user}\n你：${example.assistant}`),
      ].join('\n'),
    })
  }

  layers.push({ key: 'closing', label: '收尾复述', weight: 0, text: CLOSING })
  return layers
}

/** Join layers, discarding the highest-weight layers whole until the text fits. */
export function assemblePersonaLayers(
  layers: readonly PersonaLayer[],
  limit: number,
): { text: string; dropped: DroppedLayer[]; hardTruncated: boolean } {
  let kept = [...layers]
  const dropped: DroppedLayer[] = []
  for (;;) {
    const text = kept.map((layer) => layer.text).join('\n')
    if (text.length <= limit) return { text, dropped, hardTruncated: false }
    const droppable = kept.filter((layer) => layer.weight > 0)
    if (droppable.length === 0) {
      return { text: `${text.slice(0, Math.max(0, limit - 1))}…`, dropped, hardTruncated: text.length > limit }
    }
    const heaviest = Math.max(...droppable.map((layer) => layer.weight))
    for (const layer of kept) {
      if (layer.weight === heaviest) dropped.push({ key: layer.key, label: layer.label })
    }
    kept = kept.filter((layer) => layer.weight !== heaviest)
  }
}

/**
 * Project one persona for a channel.
 *
 * The hard boundary is inserted *before* the closing restatement inside the
 * core, so it survives every budget cut — the QQ runtime does exactly this,
 * because anything appended after the core can be trimmed with the adaptation.
 */
export function projectPersona(
  docs: PersonaProjectionInput,
  channel: 'qq' | 'pc' = 'qq',
): PersonaProjection {
  const layers = buildPersonaLayers(docs)
  const closing = layers.pop()
  layers.push({ key: 'hardBoundary', label: '硬性边界', weight: 0, text: HARD_BOUNDARY })
  if (closing !== undefined) layers.push(closing)

  const coreResult = assemblePersonaLayers(
    layers,
    Math.max(PERSONA_BUDGET.minCore, PERSONA_BUDGET.textLimit - PERSONA_BUDGET.adaptationReserve),
  )
  const core = coreResult.text

  const adaptation = channel === 'qq'
    ? 'QQ 私聊：简短自然，通常一到三句；可使用表情包；不输出长篇分析。'
    : `PC 桌面：可较详细，允许分点与展开；不使用表情包。${docs.notes}`
  const room = PERSONA_BUDGET.textLimit - core.length - 1
  const fitted = adaptation.length > room
    ? `${adaptation.slice(0, Math.max(0, room - 1))}…`
    : adaptation

  return {
    text: fitted === '' ? core : `${core}\n${fitted}`,
    core,
    adaptation: fitted,
    dropped: coreResult.dropped,
    maxChars: channel === 'qq' ? 220 : 1200,
    allowStickers: channel === 'qq',
    hardTruncated: coreResult.hardTruncated,
  }
}

/**
 * Wrap a projection in the `[伙伴规则]` section the QQ runtime injects.
 *
 * `directive` / mood mirror `decideConversation(…, 'normal')` and the neutral
 * mood line, i.e. the most common real conversation, so the preview describes
 * an ordinary turn rather than a special scenario.
 */
export function buildPersonaContextSection(projection: PersonaProjection): string {
  const parts = [
    '[伙伴规则]',
    projection.text,
    '当前语境：中性。',
    '本轮：自然回应这一句，不刻意增加内容，不主动引入新话题。',
    `长度上限：约 ${String(projection.maxChars)} 字。`,
  ].filter((part) => part.length > 0)
  const full = parts.join('\n')
  return full.length > PERSONA_BUDGET.contextSectionLimit
    ? `${full.slice(0, PERSONA_BUDGET.contextSectionLimit - 1)}…`
    : full
}

/** Convert the wire/host document shape into the projection input. */
export function toProjectionInput(docs: {
  persona: {
    name: string; identity: string; temperament: string; address: string; languageHabits: string
    boundaries: readonly string[]; scenario: string; catchphrases: readonly string[]
    avoid: readonly string[]; examples: readonly { user: string; assistant: string }[]
  }
  style: { tone: string; notes: string }
}): PersonaProjectionInput {
  return {
    name: docs.persona.name,
    identity: docs.persona.identity,
    temperament: docs.persona.temperament,
    address: docs.persona.address,
    languageHabits: docs.persona.languageHabits,
    boundaries: docs.persona.boundaries,
    scenario: docs.persona.scenario,
    catchphrases: docs.persona.catchphrases,
    avoid: docs.persona.avoid,
    examples: docs.persona.examples,
    tone: docs.style.tone,
    notes: docs.style.notes,
  }
}
