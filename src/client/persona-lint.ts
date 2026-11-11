/**
 * Persona self-check: the rules that decide whether a persona will actually
 * behave the way its author thinks it will.
 *
 * Nothing here talks to the Host, and nothing here is a style opinion. Every
 * rule comes from how a transformer consumes a persona block:
 *
 * 1. **Negation activates the concept.** "Don't be cold" strengthens the cold
 *    embedding as much as "be cold" does, because the words are what carry
 *    attention. A forbidden-expression list full of `别…/不要…` therefore tends
 *    to produce the exact phrasing it forbids. The fix is to name the
 *    replacement ("改说成：我理解"), which is what the UI now asks for.
 *    See the Character-Card V2 field notes and the "Illusion of Life" guide.
 * 2. **Attention decays with distance.** Fields are written once but the model
 *    re-reads them at every step; a 40-item avoid-list is not 40 times stronger
 *    than a 4-item one, it is 40 items of diluted attention.
 * 3. **Examples are the strongest behavioural signal.** A card with a
 *    beautiful description and no dialogue still drifts, because dialogue is
 *    what the model has the most training signal for. SillyTavern's card spec
 *    makes `mes_example` a first-class field for this reason.
 * 4. **The description competes with the conversation for budget.** The persona
 *    is injected next to real turns; an identity paragraph that runs long
 *    silently eats recall budget.
 *
 * The linter reports contradictions and dilutions, not preferences: a
 * deliberate `<300 字` identity on a terse persona is not an error.
 *
 * @module dsh-longterm-memory/client/persona-lint
 */

/** Where the problem lives, so the page can point at the right field. */
export type PersonaField = 'name' | 'identity' | 'address' | 'scenario' | 'catchphrases' | 'avoid' | 'examples'

export type PersonaIssueCode =
  | 'catchphrase-collision'
  | 'avoid-negation'
  | 'avoid-too-many'
  | 'no-examples'
  | 'examples-half-filled'
  | 'identity-long'
  | 'address-empty'
  | 'scenario-empty'
  /** The character budget cut the example dialogue before the model saw it. */
  | 'budget-drops-examples'
  /** Some other layer was cut by the budget. */
  | 'budget-drops-fields'
  /** Even the irreducible core overflowed: the hard boundary gets sliced off. */
  | 'budget-hard-truncated'

/** `error` = the persona contradicts itself; `warn` = it will not land; `tip` = dilution. */
export type PersonaSeverity = 'error' | 'warn' | 'tip'

export interface PersonaIssue {
  code: PersonaIssueCode
  severity: PersonaSeverity
  field: PersonaField
  /** The offending fragment, already trimmed for display. May be empty. */
  sample: string
}

/** The subset of the persona document this linter needs. */
export interface PersonaLintInput {
  name: string
  identity: string
  address: string
  scenario: string
  catchphrases: readonly string[]
  avoid: readonly string[]
  examples: readonly { user: string; assistant: string }[]
}

/** A negation opener, which is the pattern that backfires most often. */
const NEGATION_OPENER = /^(?:不要|别|不许|不准|勿|禁止|避免|千万别|never|don'?t|do not|avoid|no\s)/i

/** Long identity text starts competing with real conversation for budget. */
const IDENTITY_LONG = 300

/** Beyond this the list stops being read as instructions and becomes noise. */
const AVOID_TOO_MANY = 6

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Check one persona and return its issues, most severe first.
 *
 * Deterministic and side-effect free: same input, same output, no sorting by
 * anything but severity so the UI does not jump between reloads.
 *
 * `dropped` comes from the shared persona projection — it reports which layers
 * the QQ runtime's character budget removed. This is the one failure mode a
 * text-only linter cannot see: the user wrote a fine example dialogue, and the
 * model never received it.
 */
export function lintPersona(
  input: PersonaLintInput,
  dropped: readonly { key: string; label: string }[] = [],
  hardTruncated = false,
): PersonaIssue[] {
  const issues: PersonaIssue[] = []

  // Worst case: QQ slices the core from the head, cutting the hard boundary and
  // the closing restatement off the end. The model would then receive a persona
  // with no "do not pretend to be human" instruction at all. This must be an
  // error, not a tip.
  if (hardTruncated) {
    issues.push({ code: 'budget-hard-truncated', severity: 'error', field: 'identity', sample: '' })
  }

  if (dropped.some((layer) => layer.key === 'examples')) {
    issues.push({
      code: 'budget-drops-examples',
      severity: 'error',
      field: 'examples',
      sample: dropped.map((layer) => layer.label).join('、'),
    })
  } else if (dropped.length > 0) {
    issues.push({
      code: 'budget-drops-fields',
      severity: 'warn',
      field: 'identity',
      sample: dropped.map((layer) => layer.label).join('、'),
    })
  }

  // A phrase that is both required and forbidden is a contradiction, and the
  // model resolves it arbitrarily — the single most confusing thing a user can
  // author by accident.
  const avoidSet = new Set(input.avoid.map(normalise))
  for (const phrase of input.catchphrases) {
    if (avoidSet.has(normalise(phrase))) {
      issues.push({ code: 'catchphrase-collision', severity: 'error', field: 'catchphrases', sample: phrase })
      break
    }
  }

  const negation = input.avoid.find((item) => NEGATION_OPENER.test(item.trim()))
  if (negation !== undefined) {
    issues.push({ code: 'avoid-negation', severity: 'warn', field: 'avoid', sample: negation.trim() })
  }

  if (input.avoid.length > AVOID_TOO_MANY) {
    issues.push({ code: 'avoid-too-many', severity: 'tip', field: 'avoid', sample: String(input.avoid.length) })
  }

  const complete = input.examples.filter(
    (example) => example.user.trim().length > 0 && example.assistant.trim().length > 0,
  )
  const half = input.examples.filter((example) => {
    const hasUser = example.user.trim().length > 0
    const hasAssistant = example.assistant.trim().length > 0
    return hasUser !== hasAssistant
  })
  if (complete.length === 0) {
    issues.push({ code: 'no-examples', severity: 'warn', field: 'examples', sample: '' })
  } else if (half.length > 0) {
    issues.push({ code: 'examples-half-filled', severity: 'tip', field: 'examples', sample: String(half.length) })
  }

  if (input.identity.trim().length > IDENTITY_LONG) {
    issues.push({ code: 'identity-long', severity: 'tip', field: 'identity', sample: String(input.identity.trim().length) })
  }

  if (input.address.trim().length === 0) {
    issues.push({ code: 'address-empty', severity: 'tip', field: 'address', sample: '' })
  }

  if (input.scenario.trim().length === 0) {
    issues.push({ code: 'scenario-empty', severity: 'tip', field: 'scenario', sample: '' })
  }

  const rank: Record<PersonaSeverity, number> = { error: 0, warn: 1, tip: 2 }
  return issues.slice().sort((a, b) => rank[a.severity] - rank[b.severity])
}

/** True when nothing in the persona contradicts itself or will silently misfire. */
export function isPersonaHealthy(issues: readonly PersonaIssue[]): boolean {
  return issues.every((issue) => issue.severity === 'tip')
}
