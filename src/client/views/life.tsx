/**
 * Life Agent management centre (design WP-6 / §九.B).
 *
 * Eight panes. The existing Memory Vault manage/search/inbox pages remain the
 * sole authority for Markdown content and index management; this page owns
 * *product configuration* only: persona, sharing scope, review, binding and
 * diagnostics. It deliberately reuses the existing UI primitives.
 *
 * Hard rule (§六): the sharing pane has NO select-all and NO bulk apply. Every
 * historical memory stays `desktop-private` until one explicit per-id decision.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { call, errCode, useAsync, useMutation } from '../api.js'
import { useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import {
  Button, Card, Checkbox, Collapse, DisclosureChevron, Empty, ErrorNotice, Field, Icon, KvList, Loading, Notice, NumberInput, Select, Skeleton, TextArea, TextInput,
} from '../ui.js'
import type { IconName } from '../ui.js'
import { ERROR_CODES } from '../../shared/protocol.js'
import type {
  CompanionWire, PersonaExampleWire, PluginSettings, ReminderCreateRequest, RpcResultMap, StickerImportRequest, StickerWire,
  VisibilityReviewRow,
} from '../../shared/protocol.js'
import { parseReminderInput } from '../reminder-parse.js'
import { isPersonaHealthy, lintPersona } from '../persona-lint.js'
import type { PersonaIssue } from '../persona-lint.js'
import { PERSONA_BUDGET, projectPersona } from '../../shared/persona-projection.js'
import type { MemoryVisibility } from '../../shared/types.js'

type LifeTab = 'overview' | 'persona' | 'sharing' | 'review' | 'stickers' | 'reminders' | 'privacy' | 'diagnostics'

const TABS: readonly { key: LifeTab; labelKey: string; icon: IconName }[] = [
  { key: 'overview', labelKey: 'life.tab.overview', icon: 'overview' },
  { key: 'persona', labelKey: 'life.tab.persona', icon: 'persona' },
  { key: 'sharing', labelKey: 'life.tab.sharing', icon: 'sharing' },
  { key: 'review', labelKey: 'life.tab.review', icon: 'review' },
  { key: 'stickers', labelKey: 'life.tab.stickers', icon: 'stickers' },
  { key: 'reminders', labelKey: 'life.tab.reminders', icon: 'reminders' },
  { key: 'privacy', labelKey: 'life.tab.privacy', icon: 'privacy' },
  { key: 'diagnostics', labelKey: 'life.tab.diagnostics', icon: 'diagnostics' },
]

const VISIBILITY_OPTIONS: readonly { value: MemoryVisibility; label: string }[] = [
  { value: 'shared', label: '两端共享 · shared' },
  { value: 'desktop-private', label: '仅 PC · desktop-private' },
  { value: 'qq-private', label: '仅 QQ · qq-private' },
]

/** Sticker tray filters. Kept out of the component so the type stays literal. */
const STICKER_FILTERS: readonly { key: 'all' | 'enabled' | 'favorite' | 'frequent' | 'unused'; labelKey: string }[] = [
  { key: 'all', labelKey: 'life.stickers.filterAll' },
  { key: 'enabled', labelKey: 'life.stickers.filterEnabled' },
  { key: 'favorite', labelKey: 'life.stickers.filterFavorite' },
  { key: 'frequent', labelKey: 'life.stickers.filterFrequent' },
  { key: 'unused', labelKey: 'life.stickers.filterUnused' },
]

/**
 * The emotion vocabulary offered as one-click chips.
 *
 * The QQ side picks a sticker by emotion, and free-typed tags from memory tend
 * to fragment one mood into `开心 / 高兴 / happy`, none of which match the
 * others. A fixed palette is not a limitation — it is what keeps the tray
 * searchable. Users can still type anything else.
 */
const EMOTION_TAGS = [
  '开心', '晚安', '早安', '加油', '累了', '委屈', '无语',
  '害羞', '生气', '思考', '谢谢', '好的', '惊喜', '抱抱',
] as const

/**
 * The store silently slices tags to its own limit (`STICKER_TAG_LIMIT = 12`).
 * Offering more chips than the store accepts would drop the last ones without
 * telling anyone, so the panel refuses the click instead.
 */
const MAX_STICKER_TAGS = 12

/**
 * A `not-found` from a Life pane is almost never "the data is missing".
 *
 * The client bundle is fetched when the panel opens, while the Host keeps its
 * host-side modules in memory until the application is restarted. After a
 * rebuild that means a new panel can call RPCs the running Host never heard of,
 * and every one of them comes back as `not-found`. Show an actionable message
 * instead of the generic "未找到目标", which reads like lost data.
 */
function PaneError(props: { error: unknown; onRetry?: () => void }): ReactElement {
  const t = useT()
  if (errCode(props.error) === ERROR_CODES.notFound) {
    return (
      <div className="lmv-notice lmv-notice-error" role="alert">
        <span className="lmv-notice-icon" aria-hidden="true">!</span>
        <span className="lmv-grow">
          <span>{t('life.error.staleBackendTitle')}</span>
          <span className="lmv-meta">{t('life.error.staleBackend')}</span>
        </span>
        {props.onRetry === undefined ? null : (
          <Button variant="ghost" onClick={props.onRetry}>{t('common.retry')}</Button>
        )}
      </div>
    )
  }
  return <ErrorNotice error={props.error} onRetry={props.onRetry} />
}

export function LifeView(props: { onChanged: () => void }): ReactElement {
  const t = useT()
  const [tab, setTab] = useState<LifeTab>('overview')
  const active = TABS.find((entry) => entry.key === tab) ?? TABS[0]!
  const tabRank = TABS.findIndex((entry) => entry.key === tab)
  const lastRank = useRef(tabRank)
  const dir = useRef<'forward' | 'back'>('forward')
  if (lastRank.current !== tabRank) {
    dir.current = tabRank >= lastRank.current ? 'forward' : 'back'
    lastRank.current = tabRank
  }

  return (
    <div className="lmv-life">
      <nav className="lmv-life-nav" role="tablist" aria-label={t('nav.life')}>
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={`lmv-nav-btn${tab === entry.key ? ' lmv-nav-btn-on' : ''}`}
            onClick={() => { setTab(entry.key) }}
          >
            <Icon name={entry.icon} />
            <span>{t(entry.labelKey)}</span>
          </button>
        ))}
      </nav>
      <div className="lmv-life-body" data-dir={dir.current} key={tab} role="tabpanel" aria-label={t(active.labelKey)}>
        <div className="lmv-life-lead">
          <h2>{t(active.labelKey)}</h2>
          <p>{t(`life.lead.${active.key}`)}</p>
        </div>
        {tab === 'overview' ? <OverviewPane />
          : tab === 'persona' ? <PersonaPane onChanged={props.onChanged} />
            : tab === 'sharing' ? <SharingPane onChanged={props.onChanged} />
              : tab === 'review' ? <ReviewPane onChanged={props.onChanged} />
                : tab === 'stickers' ? <StickersPane />
                  : tab === 'reminders' ? <RemindersPane />
                    : tab === 'privacy' ? <PrivacyPane onChanged={props.onChanged} />
                      : <DiagnosticsPane />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ panes */

function OverviewPane(): ReactElement {
  const t = useT()
  const status = useAsync(() => call('status', {}), [])
  const owner = useAsync(() => call('ownerBindingStatus', {}), [])
  const companion = useAsync(() => call('companionStatus', {}), [])
  if (status.loading) return <Loading label={t('common.loading')} />
  if (status.error !== null) return <PaneError error={status.error} onRetry={status.reload} />
  return (
    <Card title={t('life.overview.title')}>
      <KvList items={[
        { key: t('life.overview.vault'), value: status.data?.vault?.path ?? '—' },
        { key: t('life.overview.memories'), value: status.data?.vault?.stats?.total ?? '—' },
        { key: t('life.overview.owner'), value: owner.data?.bound === true ? t('life.common.bound') : t('life.common.unbound') },
        { key: t('life.overview.persona'), value: companion.data === null ? t('life.common.unavailable')
          : companion.data.usingDefault ? t('life.common.default') : companion.data.documents.name },
      ]} />
      {owner.data?.bound !== true ? <Notice kind="warn">{t('life.overview.needBinding')}</Notice> : null}
    </Card>
  )
}

function PersonaPane(props: { onChanged: () => void }): ReactElement {
  const t = useT()
  const { toast } = usePage()
  const state = useAsync(() => call('companionStatus', {}), [])
  const presets = useAsync(() => call('companionPresets', {}), [])
  const save = useMutation((patch: Record<string, unknown>) => call('updateCompanion', patch))
  const applyPreset = useMutation((presetId: string) => call('companionApplyPreset', { presetId }))
  const fillAnchors = useMutation((presetId: string) => call('companionFillAnchors', { presetId }))
  const tryOnce = useMutation((text: string) => call('personaTry', { text }))
  const [fillPreset, setFillPreset] = useState('steady')
  const [draft, setDraft] = useState<CompanionWire['documents'] | null>(null)
  const [scenario, setScenario] = useState('')
  const [phrases, setPhrases] = useState('')
  const [avoid, setAvoid] = useState('')
  const [examples, setExamples] = useState<PersonaExampleWire[]>([])
  const [pendingPreset, setPendingPreset] = useState<string | null>(null)
  const [showAnchors, setShowAnchors] = useState(true)
  const importRef = useRef<HTMLInputElement | null>(null)
  const [importNote, setImportNote] = useState<string | null>(null)
  const [utterance, setUtterance] = useState('')
  const [tryResult, setTryResult] = useState<RpcResultMap['personaTry'] | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  /** Serialized last-known-saved state; the draft is dirty when it diverges. */
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null)

  useEffect(() => {
    if (state.data !== null && state.data !== undefined) {
      loadSaved(state.data.documents)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload the form whenever the host state changes
  }, [state.data])

  const loadSaved = (documents: CompanionWire['documents']): void => {
    const next = {
      draft: { ...documents },
      scenario: documents.scenario ?? '',
      phrases: (documents.catchphrases ?? []).join('，'),
      avoid: (documents.avoid ?? []).join('，'),
      examples: documents.examples ?? [],
    }
    setDraft(next.draft)
    setScenario(next.scenario)
    setPhrases(next.phrases)
    setAvoid(next.avoid)
    setExamples(next.examples)
    setSavedSnapshot(serializePersona(next.draft, next.scenario, next.phrases, next.avoid, next.examples))
  }

  const buildPayload = (): Record<string, unknown> => ({
    ...(draft ?? {}) as unknown as Record<string, unknown>,
    scenario,
    catchphrases: splitPhrases(phrases),
    avoid: splitPhrases(avoid),
    // Half-typed rows are dropped instead of blocking the whole save.
    examples: examples.filter((example) => example.user.trim() !== '' && example.assistant.trim() !== ''),
  })

  const saveNow = (): void => {
    if (draft === null || save.busy) return
    void save.run(buildPayload()).then(() => {
      state.reload()
      props.onChanged()
      toast(t('life.persona.savedToast'), 'ok')
    }).catch(() => undefined)
  }

  if (state.loading) return (<div className="lmv-stack"><Skeleton variant="card" /><Skeleton variant="card" /></div>)
  if (state.error !== null) return <PaneError error={state.error} onRetry={state.reload} />
  if (state.data === null || draft === null) return <Notice kind="warn">{t('life.persona.unavailable')}</Notice>
  const set = (key: keyof CompanionWire['documents'], value: string): void => {
    setDraft((current) => (current === null ? current : { ...current, [key]: value }))
  }
  // Only complete turns read as a conversation; a half-typed row would render as
  // an empty bubble and make the preview look broken.
  const previewExamples = examples
    .filter((example) => example.user.trim() !== '' && example.assistant.trim() !== '')
    .slice(0, 2)

  // The self-check reads the fields as they are typed, not as they were saved:
  // the whole point is to catch a contradiction before it reaches the model.
  // The projection is the *same* budget algorithm the QQ runtime uses, so a
  // field that will be cut before the model sees it is reported as an issue.
  const projection = projectPersona({
    name: draft.name,
    identity: draft.identity,
    temperament: draft.temperament,
    address: draft.address,
    languageHabits: draft.languageHabits,
    boundaries: draft.boundaries,
    scenario,
    catchphrases: splitPhrases(phrases),
    avoid: splitPhrases(avoid),
    examples,
    tone: draft.tone,
    notes: draft.notes,
  }, 'qq')
  const issues: PersonaIssue[] = lintPersona({
    name: draft.name,
    identity: draft.identity,
    address: draft.address,
    scenario,
    catchphrases: splitPhrases(phrases),
    avoid: splitPhrases(avoid),
    examples,
  }, projection.dropped, projection.hardTruncated)
  const healthy = isPersonaHealthy(issues)
  const anchorFields: readonly PersonaIssue['field'][] = ['avoid', 'catchphrases', 'scenario']
  /** Core budget actually used by the QQ runtime's projector. */
  const coreLimit = Math.max(PERSONA_BUDGET.minCore, PERSONA_BUDGET.textLimit - PERSONA_BUDGET.adaptationReserve)
  // Same fields the save serialises; a diff against the snapshot is the
  // honest "unsaved" signal, so leaving the panel can be trusted.
  const dirty = draft !== null &&
    savedSnapshot !== serializePersona(draft, scenario, phrases, avoid, examples)
  const budgetPct = Math.min(100, Math.round((projection.core.length / coreLimit) * 100))
  const budgetLevel = projection.core.length > coreLimit ? 'error' : budgetPct >= 85 ? 'warn' : 'ok'
  return (
    <div className="lmv-stack">
      {/* Staging: the current persona is the subject, the form below is the tool. */}
      <div className="lmv-persona-hero">
        <span className="lmv-avatar" aria-hidden="true">{initialOf(draft.name)}</span>
        <div className="lmv-persona-hero-main">
          <span className="lmv-persona-name">
            {draft.name.trim() === '' ? t('life.persona.name') : draft.name}
            <span className="lmv-badge lmv-badge-brand">{t(`life.tone.${draft.tone}`)}</span>
            {state.data.usingDefault ? <span className="lmv-badge lmv-badge-warn">{t('life.common.default')}</span> : null}
          </span>
          <span className="lmv-persona-line">
            {draft.identity.trim() === '' ? t('life.persona.hint') : draft.identity}
          </span>
          <span className="lmv-meta">
            <span>{t('life.persona.address')}：{draft.address.trim() === '' ? '—' : draft.address}</span>
            <span>{t('life.persona.temperament')}：{draft.temperament.trim() === '' ? '—' : draft.temperament}</span>
            <span>{t('life.persona.examples')}：{examples.filter((item) => item.user.trim() !== '').length}</span>
          </span>
        </div>
        {dirty ? <span className="lmv-badge lmv-badge-warn">{t('life.persona.dirtyBadge')}</span> : null}
        <Button
          variant="primary"
          disabled={save.busy}
          onClick={saveNow}
        >
          <Icon name="check" />{t('life.common.save')}
        </Button>
      </div>
      {state.data.usingDefault ? <Notice kind="warn">{t('life.persona.usingDefault')}</Notice> : null}
      {save.error !== null ? <PaneError error={save.error} /> : null}
      {applyPreset.error !== null ? <PaneError error={applyPreset.error} /> : null}
      {fillAnchors.error !== null ? <PaneError error={fillAnchors.error} /> : null}

      {/* Suggestions come from the user's own memories and are applied one by
          one — the engine never rewrites the persona on its own. */}
      <EvolutionCard onApplied={() => { state.reload(); props.onChanged() }} />

      {/* The check runs on the draft, so a contradiction is caught while typing
          rather than after it has been written into Persona.md. */}
      <Card
        title={<><Icon name="shield" />{t('life.persona.check')}</>}
        actions={
          <div className="lmv-wrap">
            <span
              className={`lmv-badge${projection.dropped.length > 0 ? ' lmv-badge-warn' : ''}`}
              title={t('life.persona.budgetHint')}
            >
              {t('life.persona.budget', { used: projection.core.length, limit: coreLimit })}
            </span>
            {healthy ? (
              <span className="lmv-badge lmv-badge-ok">{t('life.persona.checkOk')}</span>
            ) : (
              <span className="lmv-badge lmv-badge-warn">{issues.length}</span>
            )}
          </div>
        }
      >
        {/* A bar reads at a glance; the number next to it is for precision.
            Thresholds: >85% warns to trim, >100% means fields are being cut. */}
        <div
          className={`lmv-budget lmv-budget-${budgetLevel}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={coreLimit}
          aria-valuenow={projection.core.length}
          title={t('life.persona.budgetHint')}
        >
          <div className="lmv-budget-fill" style={{ width: `${String(budgetPct)}%` }} />
        </div>
        {healthy ? (
          <p className="lmv-subhead">{t('life.persona.checkOkHint')}</p>
        ) : (
          <div className="lmv-stack">
            {issues.map((issue) => (
              <div key={issue.code} className={`lmv-check-row lmv-check-${issue.severity}`}>
                <span className="lmv-check-dot" aria-hidden="true" />
                <span className="lmv-grow">
                  <span className="lmv-check-title">{t(`life.check.${issue.code}`)}</span>
                  <span className="lmv-check-hint">
                    {t(`life.check.${issue.code}.hint`, { sample: issue.sample })}
                  </span>
                </span>
                {anchorFields.includes(issue.field) ? (
                  <Button variant="ghost" onClick={() => { setShowAnchors(true) }}>
                    {t('life.persona.checkFix')}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      {presets.data?.available === true && presets.data.items.length > 0 ? (
        <Card
          title={<><Icon name="spark" />{t('life.persona.presets')}</>}
          actions={
            <div className="lmv-wrap">
              <Button
                variant="ghost"
                onClick={() => {
                  const payload = {
                    product: 'dsh-longterm-memory.persona',
                    version: 1,
                    exportedAt: new Date().toISOString(),
                    persona: {
                      ...draft,
                      scenario,
                      catchphrases: splitPhrases(phrases),
                      avoid: splitPhrases(avoid),
                      examples,
                    },
                  }
                  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
                  const url = URL.createObjectURL(blob)
                  const anchor = document.createElement('a')
                  anchor.href = url
                  anchor.download = `persona-${draft.name.trim() === '' ? 'companion' : draft.name.trim()}.json`
                  anchor.click()
                  URL.revokeObjectURL(url)
                }}
              >
                <Icon name="upload" size={13} />
                {t('life.persona.export')}
              </Button>
              <Button variant="ghost" onClick={() => { importRef.current?.click() }}>
                <Icon name="plus" size={13} />
                {t('life.persona.import')}
              </Button>
            </div>
          }
        >
          <p className="lmv-subhead">{t('life.persona.presetHint')}</p>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label={t('life.persona.import')}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file === undefined) return
              void file.text().then((text) => {
                const applied = applyPersonaFile(text, {
                  setDraftField: set,
                  setScenario,
                  setPhrases,
                  setAvoid,
                  setExamples,
                })
                setImportNote(applied === null ? 'bad' : String(applied))
                if (applied !== null) setShowAnchors(true)
              }).catch(() => { setImportNote('bad') })
            }}
          />
          {importNote === null ? null : (
            <Notice kind={importNote === 'bad' ? 'warn' : 'ok'}>
              {importNote === 'bad'
                ? t('life.persona.importBad')
                : t('life.persona.importDone', { count: importNote })}
            </Notice>
          )}
          <div className="lmv-preset-grid">
            {presets.data.items.map((preset) => {
              const armed = pendingPreset === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`lmv-preset${armed ? ' lmv-preset-armed' : ''}`}
                  disabled={applyPreset.busy}
                  title={t(`life.preset.${preset.id}.tagline`)}
                  onClick={() => {
                    // Two-step: applying a preset overwrites every field, including
                    // the user's own edits, so it never happens on a single click.
                    if (pendingPreset !== preset.id) { setPendingPreset(preset.id); return }
                    setPendingPreset(null)
                    void applyPreset.run(preset.id)
                      .then(() => { state.reload(); props.onChanged() })
                      .catch(() => undefined)
                  }}
                >
                  <span className="lmv-preset-name">{t(`life.preset.${preset.id}.label`)}</span>
                  <span className="lmv-preset-tag">{t(`life.preset.${preset.id}.tagline`)}</span>
                  {armed ? <span className="lmv-preset-flag">{t('life.persona.presetConfirm')}</span> : null}
                </button>
              )
            })}
          </div>
        </Card>
      ) : null}

      {/* One real call: the only honest answer to "does this persona sound right". */}
      <Card
        title={<><Icon name="bolt" />{t('life.persona.try')}</>}
        actions={<span className="lmv-meta">{t('life.persona.tryCost')}</span>}
      >
        <p className="lmv-subhead">{t('life.persona.tryHint')}</p>
        <div className="lmv-capture">
          <TextInput
            value={utterance}
            placeholder={t('life.persona.tryPlaceholder')}
            ariaLabel={t('life.persona.try')}
            onChange={setUtterance}
            onEnter={() => {
              if (tryOnce.busy || utterance.trim().length === 0) return
              void (async () => {
                try {
                  const result = await tryOnce.run(utterance)
                  if (result !== undefined) {
                    setTryResult(result)
                    setShowPrompt(false)
                  }
                } catch {
                  /* rendered from the mutation state */
                }
              })()
            }}
          />
          <Button
            variant="primary"
            disabled={tryOnce.busy || utterance.trim().length === 0}
            onClick={() => {
              void (async () => {
                try {
                  const result = await tryOnce.run(utterance)
                  if (result !== undefined) {
                    setTryResult(result)
                    setShowPrompt(false)
                  }
                } catch {
                  /* rendered from the mutation state */
                }
              })()
            }}
          >
            <Icon name="bolt" size={13} />
            {t('life.persona.tryRun')}
          </Button>
        </div>

        {tryOnce.busy ? <Loading label={t('life.persona.tryWorking')} /> : null}
        {tryOnce.error === null ? null : <PaneError error={tryOnce.error} />}

        {tryResult === null ? null : (
          <>
            {(tryResult.droppedLayers ?? []).length > 0 ? (
              <Notice kind="warn">
                {t('life.persona.tryDropped', {
                  fields: (tryResult.droppedLayers ?? []).map((layer) => layer.label).join('、'),
                })}
              </Notice>
            ) : null}
            {tryResult.reply === null ? (
              <Notice kind="warn">{tryResult.reason ?? t('life.persona.tryEmpty')}</Notice>
            ) : (
              <div className="lmv-chat">
                <div className="lmv-chat-turn">
                  <span className="lmv-bubble lmv-bubble-user">{tryResult.utterance}</span>
                  <span className="lmv-bubble lmv-bubble-assistant">{tryResult.reply}</span>
                </div>
              </div>
            )}
            <div className="lmv-wrap">
              {tryResult.provider === null ? null : (
                <span className="lmv-meta">{`${tryResult.provider} · ${tryResult.model ?? ''}`}</span>
              )}
              <Button variant="ghost" onClick={() => { setShowPrompt((open) => !open) }}>
                <Icon name="review" size={13} />
                {showPrompt ? t('life.persona.tryHidePrompt') : t('life.persona.tryShowPrompt')}
              </Button>
            </div>
            <Collapse open={showPrompt}>
              <pre className="lmv-pre">{tryResult.systemPrompt}</pre>
            </Collapse>          </>
        )}
      </Card>

      {/* The persona as a conversation, not as a form: this is what the voice
          actually sounds like, built from the same fields the form edits. */}
      <Card
        title={<><Icon name="spark" />{t('life.persona.preview')}</>}
        actions={
          <span className="lmv-meta">
            {t(`life.tone.${draft.tone}`)} · {draft.address.trim() === '' ? '—' : draft.address}
          </span>
        }
      >
        <p className="lmv-subhead">{t('life.persona.previewHint')}</p>
        {previewExamples.length === 0 ? (
          <Notice kind="warn">{t('life.persona.previewEmpty')}</Notice>
        ) : (
          <div className="lmv-chat">
            {previewExamples.map((example, index) => (
              <div key={`chat-${String(index)}`} className="lmv-chat-turn">
                <span className="lmv-bubble lmv-bubble-user">{example.user}</span>
                <span className="lmv-bubble lmv-bubble-assistant">{example.assistant}</span>
              </div>
            ))}
          </div>
        )}
        {splitPhrases(phrases).length === 0 && splitPhrases(avoid).length === 0 ? null : (
          <div className="lmv-chipbar">
            {splitPhrases(phrases).slice(0, 5).map((phrase) => (
              <span key={`p-${phrase}`} className="lmv-chip">{phrase}</span>
            ))}
            {splitPhrases(avoid).slice(0, 5).map((phrase) => (
              <span key={`a-${phrase}`} className="lmv-chip lmv-chip-warn">{`× ${phrase}`}</span>
            ))}
          </div>
        )}
      </Card>

      <Card title={t('life.persona.title')}>
        <Field label={t('life.persona.name')}>
          <TextInput value={draft.name} onChange={(v) => { set('name', v) }} />
        </Field>
        <Field label={t('life.persona.identity')}>
          <TextArea value={draft.identity} onChange={(v) => { set('identity', v) }} />
        </Field>
        <div className="lmv-wrap" style={{ alignItems: 'flex-start' }}>
          <Field label={t('life.persona.temperament')}>
            <TextInput value={draft.temperament} onChange={(v) => { set('temperament', v) }} />
          </Field>
          <Field label={t('life.persona.address')}>
            <TextInput value={draft.address} onChange={(v) => { set('address', v) }} />
          </Field>
          <Field label={t('life.persona.tone')}>
            <Select value={draft.tone}
              options={[
                { value: 'gentle', label: t('life.tone.gentle') },
                { value: 'lively', label: t('life.tone.lively') },
                { value: 'rational', label: t('life.tone.rational') },
                { value: 'humorous', label: t('life.tone.humorous') },
              ]}
              onChange={(v) => { set('tone', v) }} />
          </Field>
        </div>
        <Field label={t('life.persona.language')}>
          <TextArea value={draft.languageHabits} onChange={(v) => { set('languageHabits', v) }} />
        </Field>
        <Notice kind="info">{t('life.persona.boundaries')}</Notice>
      </Card>

      <Card
        title={<><Icon name="bolt" />{t('life.persona.anchors')}</>}
        actions={
          <Button
            variant="ghost"
            ariaExpanded={showAnchors}
            onClick={() => { setShowAnchors((current) => !current) }}
          >
            <DisclosureChevron open={showAnchors} />
            {showAnchors ? t('common.less') : t('common.more')}
          </Button>
        }
      >
        <p className="lmv-subhead">{t('life.persona.anchorsHint')}</p>
        <Collapse open={showAnchors}>
          <div className="lmv-anchors">
            <Field label={t('life.persona.scenario')}>
              <TextInput value={scenario} onChange={setScenario} placeholder={t('life.persona.scenarioPlaceholder')} />
            </Field>
            <Field label={t('life.persona.catchphrases')}>
              <TextInput value={phrases} onChange={setPhrases} placeholder={t('life.persona.catchphrasesPlaceholder')} />
            </Field>
            <Field label={t('life.persona.avoid')}>
              <TextInput value={avoid} onChange={setAvoid} placeholder={t('life.persona.avoidPlaceholder')} />
            </Field>
          </div>
        </Collapse>
      </Card>

      <Card title={t('life.persona.examples')}>
        <p className="lmv-subhead">{t('life.persona.examplesHint')}</p>
        {examples.length === 0 || examples.every((item) => item.user.trim() === '') ? (
          <div className="lmv-wrap">
            <Notice kind="warn">{t('life.persona.noExamples')}</Notice>
            <Select
              value={fillPreset}
              options={(presets.data?.items ?? []).map((preset) => ({
                value: preset.id,
                label: t(`life.preset.${preset.id}.label`),
              }))}
              onChange={setFillPreset}
            />
            <Button
              disabled={fillAnchors.busy}
              onClick={() => {
                void fillAnchors.run(fillPreset)
                  .then(() => { state.reload(); props.onChanged() })
                  .catch(() => undefined)
              }}
            >{t('life.persona.fillFromPreset')}</Button>
          </div>
        ) : null}
        {[0, 1, 2].map((index) => {
          const example = examples[index] ?? { user: '', assistant: '' }
          return (
            <div key={index} className="lmv-example">
              <span className="lmv-example-index">{`#${String(index + 1)}`}</span>
              <TextArea
                rows={2}
                value={example.user}
                placeholder={t('life.persona.exampleUser')}
                ariaLabel={`${t('life.persona.exampleUser')} ${String(index + 1)}`}
                onChange={(v) => { setExamples(withExample(examples, index, 'user', v)) }}
              />
              <TextArea
                rows={2}
                value={example.assistant}
                placeholder={t('life.persona.exampleAssistant')}
                ariaLabel={`${t('life.persona.exampleAssistant')} ${String(index + 1)}`}
                onChange={(v) => { setExamples(withExample(examples, index, 'assistant', v)) }}
              />
            </div>
          )
        })}
      </Card>

      {/* The save action follows the edits: edits live at the bottom of a long
          page, so the savebar appears there exactly when there is something to
          save, instead of the user scrolling back up to find the hero button. */}
      {dirty ? (
        <div className="lmv-savebar">
          <span className="lmv-grow">{t('life.persona.dirtyHint')}</span>
          <Button variant="ghost" onClick={() => { if (state.data !== null) loadSaved(state.data.documents) }}>
            {t('life.persona.revert')}
          </Button>
          <Button variant="primary" disabled={save.busy} onClick={saveNow}>
            <Icon name="check" />{t('life.common.save')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Persona evolution: a reviewable queue, never an automatic rewrite.
 *
 * The engine reads the user's memories and proposes a handful of small changes
 * (how to address them, a habitual phrase, something they said they dislike, a
 * tone shift). Each row shows its evidence count and confidence; applying is a
 * click, and applying writes `Persona.md` through the normal validated path.
 */
function EvolutionCard(props: { onApplied: () => void }): ReactElement {
  const t = useT()
  const { toast } = usePage()
  const state = useAsync(() => call('evolutionList', {}), [])
  const scan = useMutation(() => call('evolutionScan', {}))
  const apply = useMutation((id: string) => call('evolutionApply', { id }))
  const dismiss = useMutation((id: string) => call('evolutionDismiss', { id }))
  const revert = useMutation((id: string) => call('evolutionRevert', { id }))

  const all = state.data?.items ?? []
  const items = all.filter((item) => item.status === 'pending')
  // Applied rows stay visible: accepting something is a decision worth being
  // able to undo a week later, and hiding it would make the undo impossible.
  const applied = all.filter((item) => item.status === 'applied').slice(-5).reverse()

  const fieldLabel = (field: 'address' | 'catchphrases' | 'avoid' | 'tone'): string => {
    if (field === 'address') return t('life.persona.address')
    if (field === 'catchphrases') return t('life.persona.catchphrases')
    if (field === 'avoid') return t('life.persona.avoid')
    return t('life.persona.tone')
  }

  return (
    <Card
      title={<><Icon name="spark" />{t('life.persona.evolution.title')}</>}
      actions={
        <div className="lmv-wrap">
          {items.length === 0 ? null : <span className="lmv-badge lmv-badge-brand">{items.length}</span>}
          <Button
            variant="ghost"
            disabled={scan.busy}
            onClick={() => {
              void scan.run()
                .then((result) => {
                  const count = result === undefined ? 0 : result.items.length
                  toast(t('life.persona.evolution.scanToast', { count }), 'ok')
                })
                .catch(() => undefined)
            }}
          >
            <Icon name="refresh" size={13} />
            {scan.busy ? t('life.persona.evolution.scanning') : t('life.persona.evolution.scan')}
          </Button>
        </div>
      }
    >
      <p className="lmv-subhead">{t('life.persona.evolution.hint')}</p>
      {state.loading ? <Loading label={t('common.loading')} /> : null}
      {state.error !== null ? <PaneError error={state.error} onRetry={state.reload} /> : null}
      {state.data !== null && state.data !== undefined && !state.data.available ? (
        <Notice kind="warn">{state.data.reason ?? t('life.persona.evolution.unavailable')}</Notice>
      ) : null}
      {state.data?.available === true && items.length === 0 ? (
        <span className="lmv-subhead">{t('life.persona.evolution.empty')}</span>
      ) : null}

      {items.map((item) => (
        <div key={item.id} className="lmv-check-row lmv-check-tip">
          <span className="lmv-check-dot" aria-hidden="true" />
          <span className="lmv-grow">
            <span className="lmv-check-title">
              {`${fieldLabel(item.field)} → ${item.proposed}`}
            </span>
            <span className="lmv-check-hint">
              {item.reason}
              {item.evidence.length === 0 ? '' : ` · ${t('life.persona.evolution.evidence', { count: item.evidence.length })}`}
              {` · ${t(`life.persona.evolution.confidence.${item.confidence}`)}`}
            </span>
          </span>
          <div className="lmv-wrap">
            <Button
              variant="primary"
              size="sm"
              disabled={apply.busy}
              onClick={() => {
                void apply.run(item.id)
                  .then(() => { state.reload(); props.onApplied(); toast(t('life.persona.evolution.appliedToast'), 'ok') })
                  .catch(() => undefined)
              }}
            >{t('life.persona.evolution.apply')}</Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={dismiss.busy}
              onClick={() => {
                void dismiss.run(item.id).then(() => { state.reload() }).catch(() => undefined)
              }}
            >{t('life.persona.evolution.dismiss')}</Button>
          </div>
        </div>
      ))}
      {applied.length === 0 ? null : (
        <div className="lmv-stack">
          <span className="lmv-kicker">{t('life.persona.evolution.appliedTitle')}</span>
          {applied.map((item) => (
            <div key={item.id} className="lmv-check-row">
              <span className="lmv-check-dot lmv-check-dot-ok" aria-hidden="true" />
              <span className="lmv-grow">
                <span className="lmv-check-title">{`${fieldLabel(item.field)} → ${item.proposed}`}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={revert.busy}
                onClick={() => {
                  void revert.run(item.id)
                    .then(() => { state.reload(); props.onApplied(); toast(t('life.persona.evolution.revertedToast'), 'ok') })
                    .catch(() => undefined)
                }}
              >{t('life.persona.evolution.revert')}</Button>
            </div>
          ))}
        </div>
      )}
      {apply.error === null ? null : <PaneError error={apply.error} />}
      {revert.error === null ? null : <PaneError error={revert.error} />}
      {scan.error === null ? null : <PaneError error={scan.error} />}
    </Card>
  )
}

/**
 * Migration wizard. One row, one explicit decision, one RPC call. There is no
 * "select all" and no bulk endpoint (§六 / §十一).
 */
function SharingPane(props: { onChanged: () => void }): ReactElement {
  const t = useT()
  const state = useAsync(() => call('visibilityReview', {}), [])
  const apply = useMutation((id: string, visibility: MemoryVisibility) =>
    call('setVisibility', { id, visibility, reason: '用户在共享记忆页面逐条确认' }))
  const [choices, setChoices] = useState<Record<string, MemoryVisibility>>({})

  if (state.loading) return <Skeleton variant="rows" count={4} />
  if (state.error !== null) return <PaneError error={state.error} onRetry={state.reload} />
  const review: RpcResultMap['visibilityReview'] = state.data ?? { rows: [], byVisibility: { shared: 0, 'desktop-private': 0, 'qq-private': 0 } }
  const rows: readonly VisibilityReviewRow[] = review.rows
  return (
    <Card
      title={<><Icon name="sharing" />{t('life.sharing.title')}</>}
      actions={
        <>
          <span className="lmv-badge lmv-badge-brand">{`${t('life.sharing.shared')} ${String(review.byVisibility.shared)}`}</span>
          <span className="lmv-badge">{`${t('life.sharing.desktopPrivate')} ${String(review.byVisibility['desktop-private'])}`}</span>
          <span className="lmv-badge">{`${t('life.sharing.qqPrivate')} ${String(review.byVisibility['qq-private'])}`}</span>
        </>
      }
    >
      <Notice kind="warn">{t('life.sharing.warning')}</Notice>
      {apply.error !== null ? <PaneError error={apply.error} /> : null}
      {rows.length === 0 ? (
        <Empty icon="shield" title={t('life.sharing.empty')} hint={t('life.sharing.emptyHint')} />
      ) : null}
      {rows.map((row) => {
        const choice = choices[row.id] ?? row.visibility
        const changed = choice !== row.visibility
        return (
          <div key={row.id} className={`lmv-row${changed ? ' lmv-row-on' : ''}`}>
            <span className="lmv-row-main">
              <span className="lmv-row-title" title={row.id}>{row.title}</span>
              <span className="lmv-meta">
                <span className="lmv-mono">{row.id}</span>
                {changed ? <span className="lmv-badge lmv-badge-warn">{t('life.sharing.pending')}</span> : null}
              </span>
            </span>
            <Select
              value={choice}
              ariaLabel={`${row.title} ${t('life.sharing.visibility')}`}
              options={VISIBILITY_OPTIONS}
              onChange={(v) => { setChoices((current) => ({ ...current, [row.id]: v })) }}
            />
            <Button
              disabled={apply.busy || !changed}
              onClick={() => {
                void apply.run(row.id, choice).then(() => { state.reload(); props.onChanged() })
              }}
            >{t('life.sharing.apply')}</Button>
          </div>
        )
      })}
    </Card>
  )
}

/** QQ candidate review: confirm with an explicit target scope. */
function ReviewPane(props: { onChanged: () => void }): ReactElement {
  const t = useT()
  const state = useAsync(() => call('candidates', {}), [])
  const confirm = useMutation((id: string, visibility?: MemoryVisibility) =>
    call('confirm', visibility === undefined ? { id } : { id, visibility }))
  const reject = useMutation((id: string) => call('reject', { id }))
  const [shared, setShared] = useState<Record<string, boolean>>({})

  if (state.loading) return <Skeleton variant="rows" count={4} />
  if (state.error !== null) return <PaneError error={state.error} onRetry={state.reload} />
  const candidates = state.data?.candidates ?? []
  return (
    <Card
      title={<><Icon name="review" />{t('life.review.title')}</>}
      actions={candidates.length === 0 ? null : <span className="lmv-nav-count">{candidates.length}</span>}
    >
      <Notice kind="info">{t('life.review.hint')}</Notice>
      {confirm.error !== null ? <PaneError error={confirm.error} /> : null}
      {candidates.length === 0 ? (
        <Empty icon="review" title={t('life.review.empty')} hint={t('life.review.emptyHint')} />
      ) : null}
      {candidates.map((candidate) => (
        <div key={candidate.id} className="lmv-row">
          <span className="lmv-row-main">
            <span className="lmv-row-title">{candidate.title}</span>
            <span className="lmv-meta">
              <span className="lmv-mono">{candidate.id}</span>
            </span>
          </span>
          <Checkbox
            checked={shared[candidate.id] === true}
            label={t('life.review.shareOnConfirm')}
            onChange={(checked) => {
              setShared((current) => ({ ...current, [candidate.id]: checked }))
            }}
          />
          <Button variant="primary" disabled={confirm.busy} onClick={() => {
            const visibility = shared[candidate.id] === true ? 'shared' : undefined
            void confirm.run(candidate.id, visibility).then(() => { state.reload(); props.onChanged() })
          }}>{t('life.review.confirm')}</Button>
          <Button variant="danger" disabled={reject.busy} onClick={() => {
            void reject.run(candidate.id).then(() => { state.reload(); props.onChanged() })
          }}>{t('life.review.reject')}</Button>
        </div>
      ))}
    </Card>
  )
}

/**
 * Sticker library (design §八.2 / WP-6).
 *
 * The catalogue is owned by the QQ plugin; this page reaches it through the
 * `life-agent@v1` management bridge. Every mutation is per-id: there is no
 * bulk enable/disable/delete endpoint, by design.
 */
/**
 * Sticker send rhythm.
 *
 * The policy is what stops the bot from answering every message with a sticker.
 * It was already enforced by `sticker_pick`; without a control surface the user
 * could only discover the limit by hitting it. Values save explicitly (not on
 * every keystroke): a half-typed "1" for the gap would briefly mean "no gap".
 */
function StickerRhythmCard(): ReactElement | null {
  const t = useT()
  const { toast } = usePage()
  const state = useAsync(() => call('stickerPolicy', {}), [])
  const save = useMutation((patch: { minGapMinutes: number; maxPer24h: number; probability: number; quietTags: string[] }) =>
    call('stickerPolicyUpdate', patch))
  const [gap, setGap] = useState('4')
  const [cap, setCap] = useState('40')
  const [chance, setChance] = useState('100')
  const [quiet, setQuiet] = useState('')

  const data = state.data
  // Seed the form once per load, not on every render: the user may be mid-edit.
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (data === null || data === undefined || !data.available) return
    const stamp = `${data.policy.minGapMinutes}/${data.policy.maxPer24h}/${data.policy.probability}/${data.policy.quietTags.join(',')}`
    if (seeded.current === stamp) return
    seeded.current = stamp
    setGap(String(data.policy.minGapMinutes))
    setCap(String(data.policy.maxPer24h))
    setChance(String(Math.round(data.policy.probability * 100)))
    setQuiet(data.policy.quietTags.join('，'))
  }, [data])

  if (state.loading) return null
  // Absent on a bridge without a policy: the library itself still works.
  if (data === null || data === undefined || !data.available) return null

  const dirty =
    Number(gap) !== data.policy.minGapMinutes
    || Number(cap) !== data.policy.maxPer24h
    || Math.round(data.policy.probability * 100) !== Number(chance)
    || quiet !== data.policy.quietTags.join('，')

  const commit = (): void => {
    void save.run({
      minGapMinutes: Math.max(0, Math.min(720, Number(gap) || 0)),
      maxPer24h: Math.max(0, Math.min(500, Number(cap) || 0)),
      probability: Math.max(0, Math.min(100, Number(chance) || 0)) / 100,
      quietTags: quiet.split(/[,，\s]+/).map((tag) => tag.trim()).filter((tag) => tag.length > 0),
    })
      .then((result) => {
        if (result === undefined) return
        seeded.current = null
        state.reload()
        toast(t('life.stickers.rhythmSaved'), 'ok')
      })
      .catch(() => undefined)
  }

  const lastSent = data.state.lastSentAt === null
    ? t('life.stickers.rhythmNever')
    : new Date(data.state.lastSentAt).toLocaleString()

  return (
    <Card
      title={<><Icon name="clock" />{t('life.stickers.rhythmTitle')}</>}
      actions={<span className="lmv-meta">{t('life.stickers.rhythmSent', { count: data.state.sentLast24h })}</span>}
    >
      <p className="lmv-subhead">{t('life.stickers.rhythmHint')}</p>
      <div className="lmv-form-4">
        <Field label={t('life.stickers.rhythmGap')}>
          <NumberInput value={Number(gap)} min={0} max={720} ariaLabel={t('life.stickers.rhythmGap')} onChange={(value) => { setGap(String(value)) }} />
        </Field>
        <Field label={t('life.stickers.rhythmCap')}>
          <NumberInput value={Number(cap)} min={0} max={500} ariaLabel={t('life.stickers.rhythmCap')} onChange={(value) => { setCap(String(value)) }} />
        </Field>
        <Field label={t('life.stickers.rhythmChance')}>
          <NumberInput value={Number(chance)} min={0} max={100} ariaLabel={t('life.stickers.rhythmChance')} onChange={(value) => { setChance(String(value)) }} />
        </Field>
        <Field label={t('life.stickers.rhythmQuiet')}>
          <TextInput value={quiet} placeholder={t('life.stickers.rhythmQuietPlaceholder')} ariaLabel={t('life.stickers.rhythmQuiet')} onChange={setQuiet} />
        </Field>
      </div>
      <div className="lmv-wrap">
        <Button variant={dirty ? 'primary' : 'default'} disabled={!dirty || save.busy} onClick={commit}>
          {save.busy ? t('common.saving') : t('life.common.save')}
        </Button>
        <span className="lmv-meta">{t('life.stickers.rhythmLast', { at: lastSent })}</span>
      </div>
      {save.error === null ? null : <PaneError error={save.error} />}
    </Card>
  )
}

function StickersPane(): ReactElement {
  const t = useT()
  const { toast } = usePage()
  const state = useAsync(() => call('stickerLibrary', {}), [])
  const imported = useMutation((payload: StickerImportRequest) => call('stickerImport', payload))
  const update = useMutation((id: string, patch: { enabled?: boolean; favorite?: boolean; description?: string; tags?: string[] }) =>
    call('stickerUpdate', { id, ...patch }))
  const remove = useMutation((id: string) => call('stickerDelete', { id, confirm: true }))
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [metaEdit, setMetaEdit] = useState<{ id: string; description: string; tags: string } | null>(null)
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'enabled' | 'favorite' | 'frequent' | 'unused'>('all')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  /** Per-file progress: a five-file batch is ~5 RPCs, and silence reads as a hang. */
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const refresh = (): void => { state.reload() }

  if (state.loading) return (<div className="lmv-stack"><Skeleton variant="card" /><Skeleton variant="grid" count={6} /></div>)
  if (state.error !== null) return <PaneError error={state.error} onRetry={state.reload} />
  const library = state.data
  if (library === null || library === undefined) return <Notice kind="warn">{t('life.stickers.unavailable')}</Notice>
  if (!library.available) {
    return (
      <Card title={t('life.stickers.title')}>
        <Notice kind="warn">{library.reason ?? t('life.stickers.unavailable')}</Notice>
        <KvList items={[{ key: t('life.common.contract'), value: 'sticker-library@v1' }]} />
      </Card>
    )
  }

  /**
   * Multi-select upload, one request per file.
   *
   * There is deliberately no batch endpoint (§八.2: per-id operations only), so
   * the page loops and reports per-file failures instead of failing the whole
   * selection. The description/tags currently typed apply to every file in this
   * batch — that is what a user filling them in before picking files expects.
   */
  const onPick = (files: FileList | null): void => {
    if (files === null || files.length === 0) return
    setImportError(null)
    void (async () => {
      const picked = [...files]
      // The QQ side selects stickers by tag, and the usual pack convention puts
      // the emotion in the file name (`晚安_warm_01.png`). When the field is
      // empty, seed it from the first file instead of importing untagged.
      const typedTags = tags.split(/[,，\s]+/).filter((tag) => tag.length > 0)
      const inferred = typedTags.length === 0 ? tagsFromFileName(picked[0]?.name ?? '') : []
      const tagsForUpload = typedTags.length > 0 ? typedTags : inferred
      if (inferred.length > 0) setTags(inferred.join('，'))
      const problems: string[] = []
      let accepted = 0
      setImportProgress({ done: 0, total: picked.length })
      for (const [index, file] of picked.entries()) {
        try {
          const dataBase64 = await fileToBase64(file)
          const result = await imported.run({
            fileName: file.name,
            dataBase64,
            ...(description.trim() === '' ? {} : { description: description.trim() }),
            ...(tagsForUpload.length === 0 ? {} : { tags: tagsForUpload }),
          })
          if (result !== undefined && result.reason !== null) problems.push(`${file.name}: ${result.reason}`)
          else if (result !== undefined && result.id !== null) accepted += 1
        } catch {
          // `imported.error` already carries the message for the notice below.
        }
        setImportProgress({ done: index + 1, total: picked.length })
      }
      setImportProgress(null)
      if (accepted > 0) { setDescription(''); setTags('') }
      refresh()
      // Immediate summary toast; the detail stays inline for anything failed.
      if (accepted > 0) toast(t('life.stickers.importDoneToast', { count: accepted }), 'ok')
      if (problems.length > 0) {
        setImportError(problems.join('；'))
        toast(t('life.stickers.importFailedToast', { count: problems.length }), 'error')
      }
    })()
  }

  // Favourites first, then most-used: the tray should open on the ones that
  // actually get sent. Filtering is client-side because the catalogue is small
  // and every keystroke must not cost a round-trip.
  const visible: StickerWire[] = library.items
    .filter((item) =>
      filter === 'enabled'
        ? item.enabled
        : filter === 'favorite'
          ? item.favorite
          : filter === 'unused'
            ? item.usedCount === 0
            : filter === 'frequent'
              // "Frequently used" is the tray most people actually want: the ones
              // the bot has already reached for, most-used first.
              ? item.usedCount > 0
              : true,
    )
    .filter((item) => (tagFilter === null ? true : item.tags.includes(tagFilter)))
    .filter((item) => {
      const needle = query.trim().toLowerCase()
      if (needle === '') return true
      return `${item.description} ${item.tags.join(' ')} ${item.file}`.toLowerCase().includes(needle)
    })
    .slice()
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.usedCount - a.usedCount)

  // Emotion tags are the dimension the QQ side actually selects on, so they get
  // a one-click filter instead of being buried in the search box.
  const tagCounts = new Map<string, number>()
  for (const item of library.items) {
    for (const tag of item.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)
  const neverUsed = library.items.filter((item) => item.usedCount === 0).length

  const picker = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      multiple
      hidden
      aria-label={t('life.stickers.import')}
      onClick={(event) => { event.stopPropagation() }}
      onChange={(event) => { onPick(event.target.files); event.target.value = '' }}
    />
  )

  return (
    <div className="lmv-stack">
      {/* Rhythm sits above the library: it decides whether anything gets sent. */}
      <StickerRhythmCard />
      <Card
        title={<><Icon name="image" />{t('life.stickers.title')}</>}
        actions={<span className="lmv-meta">{library.source === 'vault' ? t('life.stickers.sourceVault') : t('life.stickers.sourcePlugin')}</span>}
      >
        <div className="lmv-wrap">
          <span className="lmv-badge">{t('life.stickers.total')}: {library.total}</span>
          <span className="lmv-badge lmv-badge-ok">{t('life.stickers.enabledCount')}: {library.enabledCount}</span>
          <span className="lmv-badge">{t('life.stickers.storage')}: <span className="lmv-mono">{library.storagePath ?? '—'}</span></span>
        </div>
        <p className="lmv-subhead">{t('life.stickers.owner')}</p>

        <div
          className={`lmv-drop${dragging ? ' lmv-drop-on' : ''}${library.total > 0 ? ' lmv-drop-compact' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => { fileRef.current?.click() }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              fileRef.current?.click()
            }
          }}
          onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
          onDragLeave={() => { setDragging(false) }}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            onPick(event.dataTransfer.files)
          }}
        >
          <Icon name="upload" size={20} />
          <span className="lmv-drop-title">{t('life.stickers.dropTitle')}</span>
          <span className="lmv-drop-hint">{t('life.stickers.importHint')}</span>
          {picker}
        </div>

        <div className="lmv-toolbar">
          <Field label={t('life.stickers.descPlaceholder')}>
            <TextInput
              value={description}
              onChange={setDescription}
              placeholder={t('life.stickers.descPlaceholder')}
              ariaLabel={t('life.stickers.descPlaceholder')}
            />
          </Field>
          <Field label={t('life.stickers.tags')}>
            <TextInput
              value={tags}
              onChange={setTags}
              placeholder={t('life.stickers.tagsPlaceholder')}
              ariaLabel={t('life.stickers.tagsPlaceholder')}
            />
          </Field>
        </div>

        <EmotionChipBar tags={tags} onChange={setTags} />

        {importProgress === null ? null : (
          <span className="lmv-meta" role="status">
            {t('life.stickers.importProgress', { done: importProgress.done, total: importProgress.total })}
          </span>
        )}

        {imported.error !== null ? <PaneError error={imported.error} /> : null}
        {importError !== null ? <Notice kind="warn">{importError}</Notice> : null}
        {update.error !== null ? <PaneError error={update.error} /> : null}
        {remove.error !== null ? <PaneError error={remove.error} /> : null}
        <Notice kind="info">{t('life.stickers.boundary')}</Notice>
      </Card>

      <Card
        title={<><Icon name="stickers" />{t('life.stickers.library')}</>}
        actions={
          <div className="lmv-seg" role="group" aria-label={t('life.stickers.library')}>
            {STICKER_FILTERS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`lmv-seg-btn${filter === entry.key ? ' lmv-seg-btn-on' : ''}`}
                aria-pressed={filter === entry.key}
                onClick={() => { setFilter(entry.key) }}
              >{t(entry.labelKey)}</button>
            ))}
          </div>
        }
      >
        <TextInput
          value={query}
          onChange={setQuery}
          type="search"
          block
          placeholder={t('life.stickers.search')}
          ariaLabel={t('life.stickers.search')}
        />

        {library.items.length === 0 ? null : (
          <div className="lmv-chipbar">
            {topTags.map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                className={`lmv-tag${tagFilter === tag ? ' lmv-tag-on' : ''}`}
                onClick={() => { setTagFilter(tagFilter === tag ? null : tag) }}
              >
                {`#${tag}`}
                <span className="lmv-sep">{` ${String(count)}`}</span>
              </button>
            ))}
            {neverUsed === 0 ? null : (
              <button
                type="button"
                className={`lmv-tag${filter === 'unused' ? ' lmv-tag-on' : ''}`}
                onClick={() => { setFilter(filter === 'unused' ? 'all' : 'unused') }}
              >
                {t('life.stickers.filterUnused')}
                <span className="lmv-sep">{` ${String(neverUsed)}`}</span>
              </button>
            )}
            {tagFilter === null ? null : (
              <Button variant="ghost" onClick={() => { setTagFilter(null) }}>{t('common.reset')}</Button>
            )}
          </div>
        )}

        {library.items.length === 0 ? (
          <Empty
            icon="stickers"
            title={t('life.stickers.empty')}
            hint={t('life.stickers.emptyHint')}
            action={<Button onClick={() => { fileRef.current?.click() }}><Icon name="plus" />{t('life.stickers.import')}</Button>}
          />
        ) : visible.length === 0 ? (
          <Empty icon="search" title={t('life.stickers.noMatch')} />
        ) : (
          <div className="lmv-sticker-grid">
            {visible.map((item) => (
              <div key={item.id} className={`lmv-sticker${item.enabled ? '' : ' lmv-sticker-off'}`}>
                <div className="lmv-sticker-art">
                  <StickerThumb id={item.id} />
                  <span className="lmv-sticker-ext">{extensionOf(item.file)}</span>
                </div>
                {metaEdit !== null && metaEdit.id === item.id ? (
                  <div className="lmv-sticker-edit">
                    <TextInput
                      value={metaEdit.description}
                      placeholder={t('life.stickers.descPlaceholder')}
                      ariaLabel={t('life.stickers.descPlaceholder')}
                      onChange={(value) => { setMetaEdit({ ...metaEdit, description: value }) }}
                    />
                    <TextInput
                      value={metaEdit.tags}
                      placeholder={t('life.stickers.tagsPlaceholder')}
                      ariaLabel={t('life.stickers.tagsPlaceholder')}
                      onChange={(value) => { setMetaEdit({ ...metaEdit, tags: value }) }}
                    />
                    {/* Same one-click palette as the upload area: retagging an
                        existing sticker must not be harder than creating one. */}
                    <EmotionChipBar tags={metaEdit.tags} onChange={(value) => { setMetaEdit({ ...metaEdit, tags: value }) }} />
                    <div className="lmv-sticker-foot">
                      <div className="lmv-sticker-actions">
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={update.busy}
                          onClick={() => {
                            void update
                              .run(item.id, {
                                description: metaEdit.description.trim(),
                                tags: metaEdit.tags.split(/[,，\s]+/).map((tag) => tag.trim()).filter((tag) => tag.length > 0),
                              })
                              .then(() => { setMetaEdit(null); refresh() })
                              .catch(() => undefined)
                          }}
                        >{t('common.save')}</Button>
                        <Button variant="ghost" size="sm" onClick={() => { setMetaEdit(null) }}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="lmv-sticker-name" title={item.description === '' ? item.file : item.description}>
                      {item.description === '' ? item.file : item.description}
                    </span>
                    <span className="lmv-sticker-tags">
                      {item.source === undefined ? null : (
                        <span className={`lmv-src lmv-src-${item.source}`}>{t(`life.stickers.source.${item.source}`)}</span>
                      )}
                      {item.tags.length === 0
                        ? `${t('life.stickers.used')} ${String(item.usedCount)}`
                        : `${item.tags.map((tag) => `#${tag}`).join(' ')} · ${String(item.usedCount)}`}
                    </span>
                    <div className="lmv-sticker-foot">
                      <div className="lmv-sticker-actions">
                        <Button
                          variant="ghost"
                          title={t('life.stickers.editMeta')}
                          ariaLabel={t('life.stickers.editMeta')}
                          onClick={() => {
                            setMetaEdit({ id: item.id, description: item.description, tags: item.tags.join('，') })
                          }}
                        >
                          <Icon name="edit" size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={update.busy}
                          title={t('life.stickers.favorite')}
                          ariaLabel={t('life.stickers.favorite')}
                          onClick={() => {
                            void update.run(item.id, { favorite: !item.favorite }).then(refresh).catch(() => undefined)
                          }}
                        >
                          <Icon name={item.favorite ? 'starOn' : 'star'} size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={update.busy}
                          onClick={() => {
                            void update.run(item.id, { enabled: !item.enabled }).then(refresh).catch(() => undefined)
                          }}
                        >{item.enabled ? t('life.stickers.disable') : t('life.stickers.enable')}</Button>
                      </div>
                      <Button
                        variant="danger"
                        disabled={remove.busy}
                        title={pendingDelete === item.id ? t('life.stickers.deleteConfirm') : t('common.delete')}
                        ariaLabel={t('common.delete')}
                        onClick={() => {
                          if (pendingDelete !== item.id) { setPendingDelete(item.id); return }
                          setPendingDelete(null)
                          void remove.run(item.id).then(refresh).catch(() => undefined)
                        }}
                      >
                        <Icon name={pendingDelete === item.id ? 'check' : 'trash'} size={13} />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {library.rejected > 0 ? (
          <Notice kind="warn">{`${t('life.stickers.rejected')}: ${String(library.rejected)}`}</Notice>
        ) : null}
      </Card>
    </div>
  )
}

/**
 * Reminder centre (design §八.3 / WP-5 / WP-6).
 *
 * Shows the *real* reminder rows plus the passive-window state, so a user can
 * see why a due reminder has not been delivered yet instead of assuming the
 * system forgot.
 */
/**
 * Reminder delivery rhythm.
 *
 * Only this side can decide "not at night, and not every five minutes" — the
 * chat plugin sends, but it has no idea what time it is for the user. Values
 * save explicitly so a half-typed hour cannot briefly silence everything.
 */
function ReminderRhythmCard(): ReactElement | null {
  const t = useT()
  const { toast } = usePage()
  const state = useAsync(() => call('reminderPolicy', {}), [])
  const save = useMutation((patch: { quietHours: { start: number; end: number } | null; backoffBase: number; backoffMinutes: number; maxAttempts: number }) =>
    call('reminderPolicyUpdate', patch))
  const data = state.data
  const [start, setStart] = useState('22')
  const [end, setEnd] = useState('8')
  const [base, setBase] = useState('1.6')
  const [minutes, setMinutes] = useState('15')
  const [attempts, setAttempts] = useState('5')
  const [quietOn, setQuietOn] = useState(true)
  const seeded = useRef<string | null>(null)

  useEffect(() => {
    if (data === null || data === undefined || !data.available) return
    const p = data.policy
    const stamp = `${p.quietHours === null ? 'off' : `${String(p.quietHours.start)}-${String(p.quietHours.end)}`}/${p.backoffBase}/${p.backoffMinutes}/${p.maxAttempts}`
    if (seeded.current === stamp) return
    seeded.current = stamp
    setQuietOn(p.quietHours !== null)
    if (p.quietHours !== null) {
      setStart(String(p.quietHours.start))
      setEnd(String(p.quietHours.end))
    }
    setBase(String(p.backoffBase))
    setMinutes(String(p.backoffMinutes))
    setAttempts(String(p.maxAttempts))
  }, [data])

  if (state.loading) return null
  if (data === null || data === undefined || !data.available) return null

  return (
    <Card
      title={<><Icon name="clock" />{t('life.reminders.rhythmTitle')}</>}
      actions={<span className="lmv-meta">{data.due.summary}</span>}
    >
      <p className="lmv-subhead">{t('life.reminders.rhythmHint')}</p>
      <div className="lmv-form-3">
        <Field label={t('life.reminders.rhythmQuiet')}>
          <Checkbox checked={quietOn} label={t('life.reminders.rhythmQuietOn')} onChange={setQuietOn} />
        </Field>
        <Field label={t('life.reminders.rhythmStart')}>
          <NumberInput value={Number(start)} min={0} max={23} ariaLabel={t('life.reminders.rhythmStart')} onChange={(value) => { setStart(String(value)) }} />
        </Field>
        <Field label={t('life.reminders.rhythmEnd')}>
          <NumberInput value={Number(end)} min={0} max={23} ariaLabel={t('life.reminders.rhythmEnd')} onChange={(value) => { setEnd(String(value)) }} />
        </Field>
        <Field label={t('life.reminders.rhythmBase')}>
          <NumberInput value={Number(base)} min={1} max={3} ariaLabel={t('life.reminders.rhythmBase')} onChange={(value) => { setBase(String(value)) }} />
        </Field>
        <Field label={t('life.reminders.rhythmFirst')}>
          <NumberInput value={Number(minutes)} min={1} max={720} ariaLabel={t('life.reminders.rhythmFirst')} onChange={(value) => { setMinutes(String(value)) }} />
        </Field>
        <Field label={t('life.reminders.rhythmAttempts')}>
          <NumberInput value={Number(attempts)} min={1} max={20} ariaLabel={t('life.reminders.rhythmAttempts')} onChange={(value) => { setAttempts(String(value)) }} />
        </Field>
      </div>
      <div className="lmv-wrap">
        <Button
          variant="primary"
          disabled={save.busy}
          onClick={() => {
            void save.run({
              quietHours: quietOn ? { start: Math.max(0, Math.min(23, Number(start) || 0)), end: Math.max(0, Math.min(23, Number(end) || 0)) } : null,
              backoffBase: Math.max(1, Math.min(3, Number(base) || 1.6)),
              backoffMinutes: Math.max(1, Math.min(720, Number(minutes) || 15)),
              maxAttempts: Math.max(1, Math.min(20, Number(attempts) || 5)),
            })
              .then(() => { seeded.current = null; state.reload(); toast(t('life.reminders.rhythmSaved'), 'ok') })
              .catch(() => undefined)
          }}
        >{save.busy ? t('common.saving') : t('life.common.save')}</Button>
        <span className="lmv-meta">{t('life.reminders.rhythmTakesEffect')}</span>
      </div>
      {save.error === null ? null : <PaneError error={save.error} />}
    </Card>
  )
}

function RemindersPane(): ReactElement {
  const t = useT()
  const { toast } = usePage()
  const state = useAsync(() => call('reminderList', {}), [])
  const create = useMutation((input: { title: string; dueAt: string; note: string; repeat: ReminderCreateRequest['repeat'] }) =>
    call('reminderCreate', {
      title: input.title,
      dueAt: input.dueAt,
      ...(input.note.trim() === '' ? {} : { note: input.note.trim() }),
      repeat: input.repeat,
    }))
  const cancel = useMutation((id: string) => call('reminderCancel', { id }))
  const complete = useMutation((id: string) => call('reminderComplete', { id }))
  const reschedule = useMutation((id: string, dueAt: string) => call('reminderReschedule', { id, dueAt }))
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [quick, setQuick] = useState('')
  const [title, setTitle] = useState('')
  const [due, setDue] = useState(() => defaultDueLocal())
  const [note, setNote] = useState('')
  const [lead, setLead] = useState('0')
  const [repeatUnit, setRepeatUnit] = useState<'none' | 'day' | 'week' | 'month'>('none')
  const [showOptions, setShowOptions] = useState(false)
  const [snoozeAllArmed, setSnoozeAllArmed] = useState(false)
  // Relative due times ("2 小时后") are computed at render; without this tick
  // a panel left open silently shows stale times — "即将到期" that isn't.
  const [, setTick] = useState(0)
  const [showSettled, setShowSettled] = useState(false)
  useEffect(() => {
    // Bare timer functions: this scope has a local `window` (the delivery
    // window string) that shadows the DOM global.
    const timer = setInterval(() => { setTick((n) => n + 1) }, 60_000)
    return () => { clearInterval(timer) }
  }, [])
  const parsed = parseReminderInput(quick)

  if (state.loading) return <Skeleton variant="rows" count={4} />
  if (state.error !== null) return <PaneError error={state.error} onRetry={state.reload} />
  const list = state.data
  if (list === null || list === undefined) return <Notice kind="warn">{t('life.reminders.unavailable')}</Notice>
  if (!list.available) {
    return (
      <Card title={t('life.reminders.title')}>
        <Notice kind="warn">{list.reason ?? t('life.reminders.unavailable')}</Notice>
        <KvList items={[{ key: t('life.common.contract'), value: 'reminder-service@v1' }]} />
      </Card>
    )
  }

  const window = list.delivery === null
    ? '—'
    : list.delivery.windowOpen
      ? t('life.reminders.windowOpen', { count: list.delivery.remainingReplies })
      : t('life.reminders.windowClosed')

  /**
   * Create from the already-resolved `due` + `lead`.
   *
   * `due` is the *deadline* the user is thinking about; the reminder itself
   * fires `lead` minutes earlier. Only the reminder instant is stored, because
   * the shared record shape has no second date field — so the lead is applied
   * here, at capture time, and the chip says so explicitly.
   */
  const submit = (): void => {
    const deadline = new Date(due)
    if (Number.isNaN(deadline.getTime()) || title.trim() === '') return
    const remindAt = new Date(deadline.getTime() - Number(lead) * 60_000)
    const at = remindAt.getTime() <= Date.now() ? deadline : remindAt
    void create.run({
      title: title.trim(),
      dueAt: at.toISOString(),
      note,
      repeat: repeatUnit === 'none' ? null : { unit: repeatUnit, interval: 1 },
    }).then(() => {
      setQuick('')
      setTitle('')
      setNote('')
      setDue(defaultDueLocal())
      setRepeatUnit('none')
      state.reload()
      toast(t('life.reminders.createdToast', { title: title.trim() }), 'ok')
    }).catch(() => undefined)
  }

  const pending = list.items.filter((item) => item.status === 'pending')
    .slice()
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
  const settled = list.items.filter((item) => item.status !== 'pending')

  /*
   * A flat chronological list of twelve reminders answers "what is next" but not
   * "what is today". Bucketing by the user's own day boundary and prefixing each
   * bucket with a count keeps the list scannable without hiding anything: the
   * buckets are just headings in the same list, not tabs.
   */
  const nowMs = Date.now()
  const dayMs = 86_400_000
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const dayStart = midnight.getTime()
  const dayEnd = dayStart + dayMs
  const weekEnd = dayStart + 7 * dayMs
  const dueOf = (item: (typeof pending)[number]): number => Date.parse(item.dueAt)
  const buckets: readonly { key: string; label: string; items: (typeof pending)[number][] }[] = [
    { key: 'overdue', label: t('life.reminders.groupOverdue'), items: pending.filter((item) => dueOf(item) <= nowMs) },
    {
      key: 'today',
      label: t('life.reminders.groupToday'),
      items: pending.filter((item) => dueOf(item) > nowMs && dueOf(item) < dayEnd),
    },
    {
      key: 'week',
      label: t('life.reminders.groupWeek'),
      items: pending.filter((item) => dueOf(item) >= dayEnd && dueOf(item) < weekEnd),
    },
    { key: 'later', label: t('life.reminders.groupLater'), items: pending.filter((item) => dueOf(item) >= weekEnd) },
    { key: 'settled', label: t('life.reminders.groupSettled'), items: settled },
  ]
  type ReminderRow =
    | { kind: 'head'; id: string; label: string; count: number; collapsible?: boolean; collapsed?: boolean }
    | { kind: 'item'; item: (typeof pending)[number] }
  const rows: ReminderRow[] = []
  for (const bucket of buckets) {
    if (bucket.items.length === 0) continue
    // Settled rows are history: they stay reachable but collapsed by default,
    // so the pending list keeps its signal-to-noise ratio as history grows.
    const collapsed = bucket.key === 'settled' && !showSettled
    rows.push({
      kind: 'head', id: bucket.key, label: bucket.label, count: bucket.items.length,
      collapsible: bucket.key === 'settled', collapsed,
    })
    if (collapsed) continue
    for (const item of bucket.items) rows.push({ kind: 'item', item })
  }
  const todayBucket = buckets.find((bucket) => bucket.key === 'today')
  const todayCount = todayBucket === undefined ? 0 : todayBucket.items.length
  const overdueBucket = buckets.find((bucket) => bucket.key === 'overdue')
  const overdueItems = overdueBucket === undefined ? [] : overdueBucket.items

  return (
    <div className="lmv-stack">
      <ReminderRhythmCard />
      <Card
        title={<><Icon name="plus" />{t('life.reminders.quick')}</>}
        actions={
          <Button
            variant="ghost"
            ariaExpanded={showOptions}
            onClick={() => { setShowOptions((current) => !current) }}
          >
            <Icon name="settings" size={13} />
            <DisclosureChevron open={showOptions} />
            {showOptions ? t('common.less') : t('common.more')}
          </Button>
        }
      >
        <div className="lmv-capture">
          <TextInput
            value={quick}
            placeholder={t('life.reminders.quickPlaceholder')}
            ariaLabel={t('life.reminders.quick')}
            onChange={(value) => {
              setQuick(value)
              const guess = parseReminderInput(value)
              if (guess.dueAt !== null) {
                setDue(toLocalInput(guess.dueAt))
                if (guess.title !== '') setTitle(guess.title)
              } else if (guess.title !== value) {
                setTitle(value.trim())
              }
            }}
            onEnter={submit}
          />
          <Button
            variant="primary"
            disabled={create.busy || title.trim() === '' || due === ''}
            onClick={submit}
          >
            <Icon name="check" />{t('life.reminders.add')}
          </Button>
        </div>

        <div className="lmv-chipbar">
          {quick.trim() === ''
            ? <span className="lmv-meta">{t('life.reminders.quickHint')}</span>
            : parsed.dueAt === null
              ? <span className="lmv-chip lmv-chip-warn">{t('life.reminders.parseMiss')}</span>
              : (
                <>
                  <span className="lmv-chip"><Icon name="clock" size={12} />{parsed.label}</span>
                  <span className="lmv-meta">{t('life.reminders.willCreate', { title: title.trim() === '' ? '—' : title.trim() })}</span>
                </>
              )}
        </div>

        {/* Always mounted: the toolbar slides open/closed instead of popping. */}
        <Collapse open={showOptions || (quick.trim() !== '' && parsed.dueAt === null)}>
          <div className="lmv-toolbar">
            <Field label={t('life.reminders.titleField')}>
              <TextInput
                value={title}
                onChange={setTitle}
                placeholder={t('life.reminders.titleField')}
                ariaLabel={t('life.reminders.titleField')}
              />
            </Field>
            <Field label={t('life.reminders.dueField')}>
              <input
                type="datetime-local"
                aria-label={t('life.reminders.dueField')}
                value={due}
                onChange={(event) => { setDue(event.target.value) }}
              />
            </Field>
            <Field label={t('life.reminders.lead')}>
              <Select
                value={lead}
                ariaLabel={t('life.reminders.lead')}
                options={[
                  { value: '0', label: t('life.reminders.leadOnTime') },
                  { value: '10', label: t('life.reminders.lead10') },
                  { value: '30', label: t('life.reminders.lead30') },
                  { value: '60', label: t('life.reminders.lead60') },
                  { value: '1440', label: t('life.reminders.leadDay') },
                ]}
                onChange={setLead}
              />
            </Field>
            <Field label={t('life.reminders.repeat')}>
              <Select
                value={repeatUnit}
                ariaLabel={t('life.reminders.repeat')}
                options={[
                  { value: 'none', label: t('life.reminders.repeatNone') },
                  { value: 'day', label: t('life.reminders.repeatDay') },
                  { value: 'week', label: t('life.reminders.repeatWeek') },
                  { value: 'month', label: t('life.reminders.repeatMonth') },
                ]}
                onChange={(value) => { setRepeatUnit(value as typeof repeatUnit) }}
              />
            </Field>
            <Field label={t('life.reminders.noteField')}>
              <TextInput
                value={note}
                onChange={setNote}
                placeholder={t('life.reminders.noteField')}
                ariaLabel={t('life.reminders.noteField')}
              />
            </Field>
          </div>
        </Collapse>

        <p className="lmv-subhead">{t('life.reminders.leadHint')}</p>
        {create.error !== null ? <PaneError error={create.error} /> : null}
      </Card>

      <Card
        title={<><Icon name="reminders" />{t('life.reminders.list')}</>}
        actions={
          <div className="lmv-wrap">
            <span className="lmv-badge">{t('life.reminders.queue')}: {list.queueSize}</span>
            <span className={`lmv-badge${todayCount > 0 ? ' lmv-badge-brand' : ''}`}>
              {t('life.reminders.todayBadge', { count: todayCount })}
            </span>
            <span className="lmv-badge lmv-badge-quiet">{window}</span>
            {/* One decision per overdue backlog beats fifteen identical clicks. */}
            {overdueItems.length === 0 ? null : (
              <Button
                variant={snoozeAllArmed ? 'primary' : 'ghost'}
                disabled={reschedule.busy}
                onClick={() => {
                  if (!snoozeAllArmed) {
                    setSnoozeAllArmed(true)
                    return
                  }
                  setSnoozeAllArmed(false)
                  const target = nextEveningIso()
                  void (async () => {
                    for (const item of overdueItems) {
                      await reschedule.run(item.id, target).catch(() => undefined)
                    }
                    state.reload()
                  })()
                }}
              >
                {snoozeAllArmed
                  ? t('life.reminders.snoozeAllConfirm', { count: overdueItems.length })
                  : t('life.reminders.snoozeAll', { count: overdueItems.length })}
              </Button>
            )}
          </div>
        }
      >
        <Notice kind="info">{t('life.reminders.boundary')}</Notice>
        {cancel.error !== null ? <PaneError error={cancel.error} /> : null}
        {complete.error !== null ? <PaneError error={complete.error} /> : null}
        {reschedule.error !== null ? <PaneError error={reschedule.error} /> : null}

        {list.items.length === 0 ? (
          <Empty
            icon="reminders"
            title={t('life.reminders.empty')}
            hint={t('life.reminders.emptyHint')}
          />
        ) : null}
        {rows.map((row) => {
          if (row.kind === 'head') {
            const chevron = row.collapsible === true
              ? <DisclosureChevron open={row.collapsed !== true} />
              : null
            return (
              <button
                key={`head-${row.id}`}
                type="button"
                disabled={row.collapsible !== true}
                className={`lmv-kicker lmv-kicker-row${row.id === 'overdue' ? ' lmv-kicker-warn' : ''}${row.collapsible === true ? ' lmv-kicker-toggle' : ''}`}
                aria-expanded={row.collapsible === true ? row.collapsed !== true : undefined}
                onClick={() => { if (row.collapsible === true) setShowSettled((open) => !open) }}
              >
                {row.label}
                <span className="lmv-kicker-count">{row.count}</span>
                {chevron}
              </button>
            )
          }
          const item = row.item
          const overdue = item.status === 'pending' && Date.parse(item.dueAt) <= Date.now()
          const soon = !overdue && item.status === 'pending' && Date.parse(item.dueAt) - Date.now() < 60 * 60_000
          const repeatKey = item.repeat === null
            ? null
            : item.repeat.unit === 'day' ? 'life.reminders.repeatDay'
              : item.repeat.unit === 'week' ? 'life.reminders.repeatWeek' : 'life.reminders.repeatMonth'
          return (
            <div
              key={item.id}
              className={`lmv-reminder${overdue ? ' lmv-reminder-overdue' : soon ? ' lmv-reminder-soon' : ''}${item.status === 'pending' ? '' : ' lmv-reminder-done'}`}
            >
              <span className="lmv-reminder-dot" aria-hidden="true" />
              <div className="lmv-reminder-main">
                <span className="lmv-reminder-title">{item.title}</span>
                <span className="lmv-reminder-when">
                  <span className="lmv-reminder-due" title={formatInstant(item.dueAt)}>
                    {item.status === 'pending' ? formatRelative(item.dueAt) : formatInstant(item.dueAt)}
                  </span>
                  <span>{deliveryLabel(t, item)}</span>
                  {/* "Why has it not arrived" is answered here, not by a guess. */}
                  {item.delivery === 'deferred' && item.attempts > 0 ? (
                    <span title={item.lastAttemptAt === null ? '' : formatInstant(item.lastAttemptAt)}>
                      {t('life.reminders.attempts', { count: item.attempts })}
                    </span>
                  ) : null}
                  {overdue && Math.floor((Date.now() - Date.parse(item.dueAt)) / 86_400_000) >= 1 ? (
                    <span className="lmv-reminder-late">
                      {t('life.reminders.lateDays', {
                        days: Math.floor((Date.now() - Date.parse(item.dueAt)) / 86_400_000),
                      })}
                    </span>
                  ) : null}
                  {repeatKey === null ? null : <span>{`${t('life.reminders.repeat')} · ${t(repeatKey)}`}</span>}
                  {item.note.trim() === '' ? null : <span title={item.note}>{item.note}</span>}
                </span>
              </div>
              <div className="lmv-reminder-actions">
                {editing !== null && editing.id === item.id ? (
                  <>
                    <input
                      type="datetime-local"
                      aria-label={t('life.reminders.dueField')}
                      value={editing.value}
                      onChange={(event) => { setEditing({ id: item.id, value: event.target.value }) }}
                    />
                    <Button
                      variant="primary"
                      disabled={reschedule.busy || editing.value === ''}
                      onClick={() => {
                        const parsedValue = new Date(editing.value)
                        if (Number.isNaN(parsedValue.getTime())) return
                        void reschedule.run(item.id, parsedValue.toISOString())
                          .then(() => { setEditing(null); state.reload() })
                          .catch(() => undefined)
                      }}
                    >{t('common.save')}</Button>
                    <Button variant="ghost" onClick={() => { setEditing(null) }}>{t('common.cancel')}</Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      title={t('life.reminders.snooze10')}
                      ariaLabel={t('life.reminders.snooze10')}
                      disabled={item.status !== 'pending' || reschedule.busy}
                      onClick={() => {
                        void reschedule.run(item.id, new Date(Date.now() + 10 * 60_000).toISOString())
                          .then(state.reload).catch(() => undefined)
                      }}
                    >+10m</Button>
                    <Button
                      variant="ghost"
                      title={t('life.reminders.snooze60')}
                      ariaLabel={t('life.reminders.snooze60')}
                      disabled={item.status !== 'pending' || reschedule.busy}
                      onClick={() => {
                        void reschedule.run(item.id, new Date(Date.now() + 60 * 60_000).toISOString())
                          .then(state.reload).catch(() => undefined)
                      }}
                    >+1h</Button>
                    {/* Overdue is the one case where "later today" and "tomorrow
                        morning" are the only two answers a user actually wants. */}
                    {overdue ? (
                      <>
                        <Button
                          variant="ghost"
                          title={t('life.reminders.snoozeEvening')}
                          ariaLabel={t('life.reminders.snoozeEvening')}
                          disabled={reschedule.busy}
                          onClick={() => {
                            void reschedule.run(item.id, nextEveningIso()).then(state.reload).catch(() => undefined)
                          }}
                        >{t('life.reminders.snoozeEvening')}</Button>
                        <Button
                          variant="ghost"
                          title={t('life.reminders.snoozeMorning')}
                          ariaLabel={t('life.reminders.snoozeMorning')}
                          disabled={reschedule.busy}
                          onClick={() => {
                            void reschedule.run(item.id, nextMorningIso()).then(state.reload).catch(() => undefined)
                          }}
                        >{t('life.reminders.snoozeMorning')}</Button>
                      </>
                    ) : null}
                    <Button
                      variant="ghost"
                      title={t('life.reminders.reschedule')}
                      ariaLabel={t('life.reminders.reschedule')}
                      disabled={item.status !== 'pending'}
                      onClick={() => { setEditing({ id: item.id, value: toLocalInput(item.dueAt) }) }}
                    ><Icon name="clock" size={13} /></Button>
                    <Button
                      variant="ghost"
                      title={t('life.reminders.complete')}
                      ariaLabel={t('life.reminders.complete')}
                      disabled={item.status !== 'pending' || complete.busy}
                      onClick={() => {
                        void complete.run(item.id)
                          .then(() => { state.reload(); toast(t('life.reminders.doneToast', { title: item.title }), 'ok') })
                          .catch(() => undefined)
                      }}
                    ><Icon name="check" size={13} /></Button>
                    <Button
                      variant="danger"
                      title={t('life.reminders.cancel')}
                      ariaLabel={t('life.reminders.cancel')}
                      disabled={item.status !== 'pending' || cancel.busy}
                      onClick={() => { void cancel.run(item.id).then(state.reload).catch(() => undefined) }}
                    ><Icon name="close" size={13} /></Button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </Card>
    </div>
  )
}

function deliveryLabel(t: ReturnType<typeof useT>, item: { status: string; delivery: string }): string {
  if (item.status === 'done') return t('life.reminders.delivered')
  if (item.status === 'cancelled') return t('life.reminders.cancelled')
  return item.delivery === 'deferred' ? t('life.reminders.deferred')
    : item.delivery === 'delivered' ? t('life.reminders.delivered') : t('life.reminders.waiting')
}

/** `YYYY-MM-DDTHH:mm` in local time, one hour from now — the `datetime-local` shape. */
function defaultDueLocal(): string {
  return toLocalInput(new Date(Date.now() + 60 * 60_000).toISOString())
}

/**
 * Next 21:00 local. "This evening" is a distinct answer from "tomorrow": two
 * tasks due today rarely carry the same urgency, and a priority flag is a more
 * technical way of saying the same thing (Things 3 ships exactly this split).
 */
function nextEveningIso(): string {
  const at = new Date()
  at.setHours(21, 0, 0, 0)
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1)
  return at.toISOString()
}

/** Next 09:00 local — "tomorrow morning", not "in eight hours". */
function nextMorningIso(): string {
  const at = new Date()
  at.setHours(9, 0, 0, 0)
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1)
  return at.toISOString()
}

/** ISO instant → the `datetime-local` value Obsidian/Chrome expects (local time). */
function toLocalInput(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function formatInstant(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString()
}

/**
 * The one-click emotion palette, shared by the upload area and the inline
 * meta editor so retagging is exactly as cheap as tagging.
 *
 * The store silently slices tags to its own limit, so chips past the cap
 * refuse the click (with a title) instead of vanishing later.
 */
function EmotionChipBar(props: { tags: string; onChange: (next: string) => void }): ReactElement {
  const t = useT()
  const current = props.tags.split(/[,，\s]+/).map((tag) => tag.trim()).filter((tag) => tag.length > 0)
  return (
    <div className="lmv-chipbar lmv-chipbar-scroll">
      <span className="lmv-kicker">{t('life.stickers.emotionTags')}</span>
      {EMOTION_TAGS.map((emotion) => {
        const on = current.includes(emotion)
        const full = !on && current.length >= MAX_STICKER_TAGS
        return (
          <button
            key={emotion}
            type="button"
            disabled={full}
            title={full ? t('life.stickers.tagLimit', { count: MAX_STICKER_TAGS }) : undefined}
            className={`lmv-tag${on ? ' lmv-tag-on' : ''}`}
            onClick={() => {
              props.onChange(
                on
                  ? current.filter((tag) => tag !== emotion).join('，')
                  : [...current, emotion].join('，'),
              )
            }}
          >{emotion}</button>
        )
      })}
    </div>
  )
}

/**
 * One sticker preview.
 *
 * The host returns the bytes as a data URL (ids are SHA-256 hashes, so a cached
 * preview cannot go stale). Previews are fetched lazily per tile and memoised at
 * module scope: re-opening the pane or re-sorting the grid costs nothing.
 */
const THUMB_CACHE = new Map<string, string>()

function StickerThumb(props: { id: string }): ReactElement {
  const [src, setSrc] = useState<string | null>(() => THUMB_CACHE.get(props.id) ?? null)

  useEffect(() => {
    if (src !== null) return
    let alive = true
    void call('stickerThumb', { id: props.id })
      .then((result) => {
        if (!alive || result.dataUrl === null) return
        THUMB_CACHE.set(props.id, result.dataUrl)
        setSrc(result.dataUrl)
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [props.id, src])

  if (src === null) return <Icon name="image" size={22} />
  return <img src={src} alt="" loading="lazy" decoding="async" />
}

/** First visible character of a name, used as the avatar glyph. */
function initialOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return '·'
  return [...trimmed][0] ?? '·'
}

/** Uppercase extension without the dot; a neutral tag when there is none. */
function extensionOf(file: string): string {
  const index = file.lastIndexOf('.')
  if (index < 0 || index === file.length - 1) return 'img'
  return file.slice(index + 1).toLowerCase()
}

/**
 * `晚安_warm_01.png` → `['晚安', 'warm']`.
 *
 * Sticker packs are conventionally named `emotion_variant_index`, so the file
 * name already carries the tag the QQ side will select on. Pure numbers and very
 * long fragments are dropped: they are pack indices, not emotions.
 */
function tagsFromFileName(file: string): string[] {
  const base = file.replace(/\.[^.]+$/, '')
  return base
    .split(/[_\-\s.]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= 12 && !/^\d+$/.test(part))
    .slice(0, 4)
}

/**
 * "2 小时后" / "已过期 3 小时" — a due time is only useful relative to now.
 *
 * Absolute timestamps force the user to do the subtraction on every glance,
 * and the whole point of the list is to answer "what needs attention first".
 */
function formatRelative(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const minutes = Math.round((at - Date.now()) / 60_000)
  const magnitude = (value: number): string => {
    if (value < 60) return `${value} 分钟`
    if (value < 60 * 24) return `${Math.round(value / 60)} 小时`
    return `${Math.round(value / 1440)} 天`
  }
  if (minutes < 0) return `已过期 ${magnitude(-minutes)}`
  if (minutes < 1) return '即将到期'
  return `${magnitude(minutes)}后`
}

/**
 * Comma/、/； separated phrase list.
 *
 * `catchphrases` and `avoid` are edited as one line each because they are
 * short by nature; a row-per-item editor would cost more clicks than the
 * content is worth.
 */
function splitPhrases(value: string): string[] {
  return value.split(/[,，、;；\n]+/).map((item) => item.trim()).filter((item) => item.length > 0)
}

/** Write one side of example `index`, growing the list with empty rows as needed. */
function withExample(
  list: readonly PersonaExampleWire[],
  index: number,
  side: 'user' | 'assistant',
  value: string,
): PersonaExampleWire[] {
  const next = list.map((entry) => ({ ...entry }))
  while (next.length <= index) next.push({ user: '', assistant: '' })
  next[index] = { ...next[index]!, [side]: value }
  return next
}

/**
 * Deterministic fingerprint of the editable persona state.
 *
 * Both sides go through the same serialiser, so "dirty" means the fields the
 * user actually sees differ — not that React re-rendered or the host resharded
 * whitespace. `examples` is normalised the same way the save normalises it
 * (half-typed rows are dropped on save, so they must not count as a change).
 */
function serializePersona(
  draft: CompanionWire['documents'],
  scenario: string,
  phrases: string,
  avoid: string,
  examples: readonly PersonaExampleWire[],
): string {
  const savedExamples = examples
    .filter((example) => example.user.trim() !== '' && example.assistant.trim() !== '')
  return JSON.stringify([draft, scenario, phrases, avoid, savedExamples])
}

/**
 * Apply an exported persona file back into the draft.
 *
 * Returns how many fields were filled, or `null` when the file is not one of
 * ours. Only allow-listed string fields are copied, and each is length-capped:
 * a file must not be able to smuggle arbitrary keys — or an unbounded blob —
 * into the document that is later written to `Persona.md`.
 */
function applyPersonaFile(
  text: string,
  sink: {
    setDraftField: (key: keyof CompanionWire['documents'], value: string) => void
    setScenario: (value: string) => void
    setPhrases: (value: string) => void
    setAvoid: (value: string) => void
    setExamples: (value: PersonaExampleWire[]) => void
  },
): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const raw = (parsed as Record<string, unknown>)['persona']
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const read = (key: string): string | null => (typeof source[key] === 'string' ? (source[key] as string) : null)

  let applied = 0
  // Caps mirror `LIMITS` in the Host's document model, so an over-long field
  // from a hand-edited file is trimmed here instead of failing the save later.
  const caps: Partial<Record<keyof CompanionWire['documents'], number>> = {
    name: 40, identity: 400, temperament: 200, address: 40, languageHabits: 300,
  }
  const textFields: readonly (keyof CompanionWire['documents'])[] = [
    'name', 'identity', 'temperament', 'address', 'languageHabits',
  ]
  for (const key of textFields) {
    const value = read(key)
    if (value === null) continue
    sink.setDraftField(key, value.slice(0, caps[key] ?? 400))
    applied += 1
  }
  const tone = read('tone')
  if (tone !== null && ['gentle', 'lively', 'rational', 'humorous'].includes(tone)) {
    sink.setDraftField('tone', tone)
    applied += 1
  }

  const scenario = read('scenario')
  if (scenario !== null) {
    sink.setScenario(scenario.slice(0, 200))
    applied += 1
  }

  const phraseList = (value: unknown): string | null =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 6).join('，') : null
  const phrases = phraseList(source['catchphrases'])
  if (phrases !== null) {
    sink.setPhrases(phrases)
    applied += 1
  }
  const avoid = phraseList(source['avoid'])
  if (avoid !== null) {
    sink.setAvoid(avoid)
    applied += 1
  }

  if (Array.isArray(source['examples'])) {
    const list: PersonaExampleWire[] = []
    for (const entry of (source['examples'] as unknown[]).slice(0, 3)) {
      if (entry === null || typeof entry !== 'object') continue
      const pair = entry as Record<string, unknown>
      const user = typeof pair['user'] === 'string' ? pair['user'] : ''
      const assistant = typeof pair['assistant'] === 'string' ? pair['assistant'] : ''
      if (user === '' && assistant === '') continue
      list.push({ user, assistant })
    }
    sink.setExamples(list)
    applied += 1
  }

  return applied === 0 ? null : applied
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function PrivacyPane(props: { onChanged: () => void }): ReactElement {
  const t = useT()
  const owner = useAsync(() => call('ownerBindingStatus', {}), [])
  const review = useAsync(() => call('visibilityReview', {}), [])
  const unbind = useMutation(() => call('ownerBindingUnbind', {}))
  const status = useAsync(() => call('status', {}), [])
  const save = useMutation((patch: Partial<PluginSettings>) => call('setSettings', patch))
  const trustLocal = status.data?.settings.trustLocalSessions === true
  return (
    <div className="lmv-stack">
    <Card title={t('life.privacy.title')}>
      <KvList items={[
        { key: t('life.overview.owner'), value: owner.data?.bound === true ? t('life.common.bound') : t('life.common.unbound') },
        { key: t('life.sharing.shared'), value: review.data?.byVisibility.shared ?? '—' },
      ]} />
      <Notice kind="warn">{t('life.privacy.unbindHint')}</Notice>
      {unbind.error !== null ? <PaneError error={unbind.error} /> : null}
      <Button variant="danger" disabled={owner.data?.bound !== true || unbind.busy} onClick={() => {
        void unbind.run().then(() => { owner.reload(); review.reload(); props.onChanged() })
      }}>{t('life.privacy.unbind')}</Button>
    </Card>

    {/* 桌面会话没有任何 live 来源，门禁默认拒绝；这个开关只补那一格。 */}
    <Card title={<><Icon name="privacy" />{t('life.privacy.localTitle')}</>}>
      <Checkbox
        checked={trustLocal}
        label={t('life.privacy.localTrust')}
        onChange={(checked) => {
          void save.run({ trustLocalSessions: checked })
            .then(() => { status.reload(); props.onChanged() })
            .catch(() => undefined)
        }}
      />
      <span className="lmv-subhead">{t('life.privacy.localHint')}</span>
      {save.error === null ? null : <PaneError error={save.error} />}
    </Card>
    </div>
  )
}

function DiagnosticsPane(): ReactElement {
  const t = useT()
  const status = useAsync(() => call('status', {}), [])
  const linkage = useAsync(() => call('qqLinkage', {}), [])
  const companion = useAsync(() => call('companionStatus', {}), [])
  const caps = status.data?.capabilities
  return (
    <Card title={t('life.diagnostics.title')}>
      {status.loading ? <Loading label={t('common.loading')} /> : null}
      {status.error !== null ? <PaneError error={status.error} onRetry={status.reload} /> : null}
      <KvList items={[
        { key: 'webServer', value: caps?.webServer === true ? 'OK' : '—' },
        { key: 'systemPrompt', value: caps?.systemPrompt === true ? 'OK' : '—' },
        { key: 'tools', value: caps?.registeredTools?.length ?? '—' },
        { key: t('life.diagnostics.linkage'), value: linkage.data?.config?.mode ?? '—' },
        { key: t('life.diagnostics.personaProblems'), value: companion.data?.problems.join('; ') || '—' },
      ]} />
      {companion.data?.usingDefault === true ? <Notice kind="warn">{t('life.persona.usingDefault')}</Notice> : null}
    </Card>
  )
}
