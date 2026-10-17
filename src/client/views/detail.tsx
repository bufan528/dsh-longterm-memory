/**
 * Detail (记忆详情) and the per-memory management actions.
 *
 * Renders the memory exactly as the vault stores it — headings, bullets and
 * paragraphs parsed locally, no markdown library — and exposes every action the
 * Host serves for a single memory: field edit, raw Markdown edit with checksum
 * protection, confirm/reject, status moves, pin, delete behind a second
 * confirmation, and conflict resolution.
 *
 * @module dsh-longterm-memory/client/views/detail
 */

import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { ERROR_CODES } from '../../shared/protocol.js'
import type { ConflictRequest, SaveRequest } from '../../shared/protocol.js'
import { CONFIDENCE_LEVELS, MEMORY_STATUSES, MEMORY_TYPES } from '../../shared/types.js'
import type { Confidence, MemoryStatus, MemoryType } from '../../shared/types.js'
import { call, errCode, useAsync, useMutation } from '../api.js'
import { t, useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Empty,
  ErrorNotice,
  Field,
  HistoryItem,
  KvList,
  Loading,
  Modal,
  Notice,
  NumberInput,
  Prose,
  Select,
  TextArea,
  TextInput,
} from '../ui.js'
import { clampImportance, confidenceKind, confidenceLabel, formatTime, joinList, splitList, statusKind, statusLabel, typeLabel } from '../util.js'
import { HitRow } from './hit-row.js'

interface EditForm {
  type: MemoryType
  title: string
  summary: string
  tagsText: string
  aliasesText: string
  evidence: string
  status: MemoryStatus
  confidence: Confidence
  importance: number
  pinned: boolean
}

const EMPTY_FORM: EditForm = {
  type: 'knowledge',
  title: '',
  summary: '',
  tagsText: '',
  aliasesText: '',
  evidence: '',
  status: 'active',
  confidence: 'medium',
  importance: 50,
  pinned: false,
}

/** Render the detail pane for one memory. */
export function DetailView(props: { id: string; onBack: () => void; onChanged: () => void }): ReactElement {
  const page = usePage()
  const translate = useT()
  const detail = useAsync(() => call('get', { id: props.id }), [props.id])
  const [tab, setTab] = useState<'fields' | 'raw'>('fields')
  const [form, setForm] = useState<EditForm>(EMPTY_FORM)
  const [outcome, setOutcome] = useState<{ repairs: string[]; warnings: string[] } | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)

  const raw = useAsync(() => call('readRaw', { id: props.id }), [props.id], tab === 'raw')
  const [rawText, setRawText] = useState('')
  const [rawChecksum, setRawChecksum] = useState('')
  const [rawConflict, setRawConflict] = useState(false)

  const save = useMutation((payload: SaveRequest) => call('save', payload))
  const writeRaw = useMutation((content: string, checksum: string) =>
    call('writeRaw', { id: props.id, content, expectedChecksum: checksum }),
  )
  const changeStatus = useMutation((status: MemoryStatus) => call('setStatus', { id: props.id, status }))
  const changePinned = useMutation((pinned: boolean) => call('setPinned', { id: props.id, pinned }))
  const confirmMemory = useMutation(() => call('confirm', { id: props.id }))
  const rejectMemory = useMutation(() => call('reject', { id: props.id }))
  const removeMemory = useMutation((archiveOnly: boolean) => call('delete', { id: props.id, confirm: true, archiveOnly }))
  const resolveConflict = useMutation((payload: ConflictRequest) => call('resolveConflict', payload))

  const memory = detail.data?.memory ?? null

  useEffect(() => {
    if (memory === null) return
    setForm({
      type: memory.type,
      title: memory.title,
      summary: memory.summary,
      tagsText: joinList(memory.tags),
      aliasesText: joinList(memory.aliases),
      evidence: memory.evidence,
      status: memory.status,
      confidence: memory.confidence,
      importance: memory.importance,
      pinned: memory.pinned,
    })
  }, [memory])

  useEffect(() => {
    const document = raw.data
    if (document === null) return
    setRawText(document.content)
    setRawChecksum(document.checksum)
    setRawConflict(false)
  }, [raw.data])

  const afterChange = (): void => {
    detail.reload()
    props.onChanged()
  }

  const doSave = async (): Promise<void> => {
    if (form.title.trim().length === 0) {
      page.toast(translate('edit.needTitle'), 'error')
      return
    }
    try {
      const result = await save.run({
        id: props.id,
        type: form.type,
        title: form.title.trim(),
        summary: form.summary,
        tags: splitList(form.tagsText),
        confidence: form.confidence,
        importance: clampImportance(form.importance),
        pinned: form.pinned,
        aliases: splitList(form.aliasesText),
        evidence: form.evidence,
        status: form.status,
      })
      if (result !== undefined) {
        setOutcome({ repairs: result.repairs, warnings: result.warnings })
        page.toast(translate('edit.saved', { id: result.id }), 'ok')
      }
      afterChange()
    } catch {
      /* rendered from the mutation state */
    }
  }

  const doWriteRaw = async (): Promise<void> => {
    setRawConflict(false)
    try {
      const result = await writeRaw.run(rawText, rawChecksum)
      if (result !== undefined) {
        setOutcome({ repairs: result.repairs, warnings: result.warnings })
        page.toast(translate('raw.written'), 'ok')
      }
      afterChange()
      raw.reload()
    } catch (error) {
      if (errCode(error) === ERROR_CODES.conflict) setRawConflict(true)
    }
  }

  const guard = async (work: () => Promise<unknown>, message: string): Promise<void> => {
    try {
      await work()
      page.toast(message, 'ok')
      afterChange()
    } catch {
      /* rendered from the mutation state */
    }
  }

  if (detail.loading && memory === null) {
    return (
      <div className="lmv-main">
        <Loading />
      </div>
    )
  }
  if (detail.error !== null) {
    return (
      <div className="lmv-main">
        <ErrorNotice error={detail.error} onRetry={detail.reload} />
        <Button variant="ghost" onClick={props.onBack}>
          {translate('common.back')}
        </Button>
      </div>
    )
  }
  if (memory === null) {
    return (
      <div className="lmv-main">
        <Empty>{translate('detail.notFound')}</Empty>
        <Button variant="ghost" onClick={props.onBack}>
          {translate('common.back')}
        </Button>
      </div>
    )
  }

  const history = detail.data?.history ?? []
  const related = detail.data?.related ?? []
  const linkButton = (id: string, label: string): ReactNode => (
    <Button
      key={`${label}-${id}`}
      variant="ghost"
      onClick={() => {
        page.openMemory(id)
      }}
    >
      <span className="lmv-mono">{id}</span>
    </Button>
  )

  return (
    <div className="lmv-main">
      <div className="lmv-wrap">
        <Button variant="ghost" onClick={props.onBack}>
          ← {translate('common.back')}
        </Button>
        <span className="lmv-grow lmv-row-title">{memory.title}</span>
        <Badge kind="brand">{typeLabel(memory.type)}</Badge>
        <Badge kind={statusKind(memory.status)}>{statusLabel(memory.status)}</Badge>
        <Badge kind={confidenceKind(memory.confidence)}>{confidenceLabel(memory.confidence)}</Badge>
        {memory.pinned ? <Badge kind="warn">{translate('detail.pinned')}</Badge> : null}
      </div>

      <Card
        title={translate('detail.actions')}
        actions={
          <>
            {memory.status === 'pending' ? (
              <Button
                variant="primary"
                disabled={confirmMemory.busy}
                onClick={() => void guard(() => confirmMemory.run(), t('action.confirmed', { id: memory.id }))}
              >
                {translate('action.confirm')}
              </Button>
            ) : null}
            {memory.status === 'pending' ? (
              <Button
                disabled={rejectMemory.busy}
                onClick={() => void guard(() => rejectMemory.run(), t('action.rejected', { id: memory.id }))}
              >
                {translate('action.reject')}
              </Button>
            ) : null}
            <Button
              disabled={changeStatus.busy}
              onClick={() => void guard(() => changeStatus.run('archived'), t('action.archived', { id: memory.id }))}
            >
              {translate('action.archive')}
            </Button>
            <Button
              disabled={changeStatus.busy}
              onClick={() => void guard(() => changeStatus.run('stale'), t('action.staled', { id: memory.id }))}
            >
              {translate('action.stale')}
            </Button>
            <Button
              disabled={changeStatus.busy}
              onClick={() => void guard(() => changeStatus.run('active'), t('action.restored', { id: memory.id }))}
            >
              {translate('action.restore')}
            </Button>
            <Button
              disabled={changePinned.busy}
              onClick={() =>
                void guard(
                  () => changePinned.run(!memory.pinned),
                  memory.pinned ? t('action.unpinned', { id: memory.id }) : t('action.pinned', { id: memory.id }),
                )
              }
            >
              {memory.pinned ? translate('action.unpin') : translate('action.pin')}
            </Button>
            <Button disabled={memory.conflictsWith.length === 0} onClick={() => setConflictOpen(true)}>
              {translate('action.resolve')}
            </Button>
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              {translate('action.delete')}
            </Button>
          </>
        }
      >
        <Notice kind={detail.data?.recallable === true ? 'ok' : 'warn'}>
          <strong>{detail.data?.recallable === true ? translate('detail.recallableYes') : translate('detail.recallableNo')}</strong>
          <br />
          {translate('detail.recallNote')}: {detail.data?.recallNote ?? translate('common.unknown')}
        </Notice>

        <KvList
          items={[
            { key: translate('detail.path'), value: <span className="lmv-mono">{detail.data?.relativePath ?? ''}</span> },
            { key: translate('detail.absolutePath'), value: <span className="lmv-mono">{detail.data?.absolutePath ?? ''}</span> },
            { key: translate('detail.importance'), value: String(memory.importance) },
            { key: translate('detail.createdAt'), value: formatTime(memory.createdAt) },
            { key: translate('detail.updatedAt'), value: formatTime(memory.updatedAt) },
            {
              key: translate('detail.tags'),
              value: memory.tags.length === 0 ? translate('common.none') : memory.tags.join(', '),
            },
            {
              key: translate('detail.aliases'),
              value: memory.aliases.length === 0 ? translate('common.none') : memory.aliases.join(', '),
            },
            {
              key: translate('detail.sourceSessions'),
              value:
                memory.sourceSessions.length === 0 ? (
                  translate('common.none')
                ) : (
                  <span className="lmv-mono">{memory.sourceSessions.join(', ')}</span>
                ),
            },
            {
              key: translate('detail.evidence'),
              value: memory.evidence.length === 0 ? translate('common.none') : memory.evidence,
            },
            {
              key: translate('detail.supersededBy'),
              value: memory.supersededBy === undefined ? translate('common.none') : linkButton(memory.supersededBy, 'supersededBy'),
            },
            {
              key: translate('detail.supersedes'),
              value:
                memory.supersedes.length === 0
                  ? translate('common.none')
                  : memory.supersedes.map((id) => linkButton(id, 'supersedes')),
            },
            {
              key: translate('detail.conflictsWith'),
              value:
                memory.conflictsWith.length === 0
                  ? translate('common.none')
                  : memory.conflictsWith.map((id) => linkButton(id, 'conflict')),
            },
          ]}
        />
      </Card>

      <Card title={translate('detail.summary')}>
        <Prose text={memory.summary} fallback={translate('common.none')} />
      </Card>

      {memory.sections.length === 0 ? null : (
        <Card title={translate('detail.sections')}>
          {memory.sections.map((section) => (
            <div key={section.heading}>
              <h4 className="lmv-prose-h">{section.heading}</h4>
              <Prose text={section.body} />
            </div>
          ))}
        </Card>
      )}

      <Card title={translate('detail.related')}>
        {related.length === 0 ? (
          <Empty />
        ) : (
          <div className="lmv-list">
            {related.map((hit) => (
              <HitRow
                key={hit.record.id}
                hit={hit}
                selected={page.selection.includes(hit.record.id)}
                onToggleSelect={() => {
                  page.toggleSelect(hit.record.id)
                }}
                onOpen={() => {
                  page.openMemory(hit.record.id)
                }}
              />
            ))}
          </div>
        )}
      </Card>

      <Card
        title={tab === 'raw' ? translate('raw.title') : translate('detail.tabFields')}
        actions={
          <>
            <Button variant={tab === 'fields' ? 'primary' : 'ghost'} onClick={() => setTab('fields')}>
              {translate('detail.tabFields')}
            </Button>
            <Button variant={tab === 'raw' ? 'primary' : 'ghost'} onClick={() => setTab('raw')}>
              {translate('detail.tabRaw')}
            </Button>
          </>
        }
      >
        {outcome === null ? null : (
          <>
            {outcome.repairs.length === 0 ? null : (
              <Notice kind="warn">
                {translate('edit.repairs')}: {outcome.repairs.join('; ')}
              </Notice>
            )}
            {outcome.warnings.length === 0 ? null : (
              <Notice kind="warn">
                {translate('edit.warnings')}: {outcome.warnings.join('; ')}
              </Notice>
            )}
          </>
        )}

        {tab === 'fields' ? (
          <>
            <div className="lmv-toolbar">
              <Field label={translate('edit.type')}>
                <Select<MemoryType>
                  value={form.type}
                  options={MEMORY_TYPES.map((value) => ({ value, label: typeLabel(value) }))}
                  onChange={(value) => {
                    setForm((current) => ({ ...current, type: value }))
                  }}
                />
              </Field>
              <Field label={translate('edit.status')}>
                <Select<MemoryStatus>
                  value={form.status}
                  options={MEMORY_STATUSES.map((value) => ({ value, label: statusLabel(value) }))}
                  onChange={(value) => {
                    setForm((current) => ({ ...current, status: value }))
                  }}
                />
              </Field>
              <Field label={translate('edit.confidence')}>
                <Select<Confidence>
                  value={form.confidence}
                  options={CONFIDENCE_LEVELS.map((value) => ({ value, label: confidenceLabel(value) }))}
                  onChange={(value) => {
                    setForm((current) => ({ ...current, confidence: value }))
                  }}
                />
              </Field>
              <Field label={translate('edit.importance')}>
                <NumberInput
                  value={form.importance}
                  min={0}
                  max={100}
                  onChange={(value) => {
                    setForm((current) => ({ ...current, importance: value }))
                  }}
                />
              </Field>
              <Checkbox
                checked={form.pinned}
                label={translate('edit.pinned')}
                onChange={(checked) => {
                  setForm((current) => ({ ...current, pinned: checked }))
                }}
              />
            </div>

            <Field label={translate('edit.fieldTitle')}>
              <TextInput
                value={form.title}
                block
                onChange={(value) => {
                  setForm((current) => ({ ...current, title: value }))
                }}
              />
            </Field>

            <Field label={`${translate('edit.summary')} — ${translate('edit.hint')}`}>
              <TextArea
                value={form.summary}
                rows={8}
                onChange={(value) => {
                  setForm((current) => ({ ...current, summary: value }))
                }}
              />
            </Field>

            <div className="lmv-toolbar">
              <Field label={`${translate('edit.tags')} ${translate('common.comma')}`}>
                <TextInput
                  value={form.tagsText}
                  block
                  onChange={(value) => {
                    setForm((current) => ({ ...current, tagsText: value }))
                  }}
                />
              </Field>
              <Field label={`${translate('edit.aliases')} ${translate('common.comma')}`}>
                <TextInput
                  value={form.aliasesText}
                  block
                  onChange={(value) => {
                    setForm((current) => ({ ...current, aliasesText: value }))
                  }}
                />
              </Field>
            </div>

            <Field label={translate('edit.evidence')}>
              <TextArea
                value={form.evidence}
                rows={3}
                onChange={(value) => {
                  setForm((current) => ({ ...current, evidence: value }))
                }}
              />
            </Field>

            {save.error === null ? null : <ErrorNotice error={save.error} />}

            <div className="lmv-wrap">
              <Button variant="primary" disabled={save.busy} onClick={() => void doSave()}>
                {translate('common.save')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="lmv-prose-p">{translate('raw.hint')}</p>
            <KvList
              items={[
                { key: translate('raw.path'), value: <span className="lmv-mono">{raw.data?.relativePath ?? ''}</span> },
                { key: translate('raw.checksum'), value: <span className="lmv-mono">{rawChecksum}</span> },
              ]}
            />
            {raw.loading ? <Loading /> : null}
            {raw.error === null ? null : <ErrorNotice error={raw.error} onRetry={raw.reload} />}
            {rawConflict ? (
              <Notice kind="error">
                {translate('raw.conflict')}
                <br />
                <Button variant="ghost" onClick={raw.reload}>
                  {translate('common.reload')}
                </Button>
              </Notice>
            ) : null}
            {writeRaw.error !== null && !rawConflict ? <ErrorNotice error={writeRaw.error} /> : null}
            <TextArea value={rawText} rows={20} ariaLabel={translate('raw.title')} onChange={setRawText} />
            <div className="lmv-wrap">
              <Button variant="primary" disabled={writeRaw.busy} onClick={() => void doWriteRaw()}>
                {translate('raw.write')}
              </Button>
              <Button variant="ghost" disabled={raw.loading} onClick={raw.reload}>
                {translate('common.reload')}
              </Button>
            </div>
          </>
        )}
      </Card>

      <Card title={translate('detail.history')}>
        {history.length === 0 ? (
          <Empty>{translate('detail.historyEmpty')}</Empty>
        ) : (
          <div className="lmv-history">
            {history.map((entry, index) => (
              <HistoryItem
                key={`${entry.at}-${String(index)}`}
                at={entry.at}
                op={entry.op}
                reason={entry.reason}
                {...(entry.source === undefined ? {} : { source: entry.source })}
                {...(entry.before === undefined ? {} : { before: entry.before })}
                {...(entry.after === undefined ? {} : { after: entry.after })}
              />
            ))}
          </div>
        )}
      </Card>

      {deleteOpen ? (
        <DeleteDialog
          id={memory.id}
          busy={removeMemory.busy}
          error={removeMemory.error}
          onClose={() => setDeleteOpen(false)}
          onConfirm={(archiveOnly) => {
            void (async () => {
              try {
                await removeMemory.run(archiveOnly)
                setDeleteOpen(false)
                page.toast(translate('delete.done', { id: memory.id }), 'ok')
                page.clearSelection()
                props.onChanged()
                props.onBack()
              } catch {
                /* rendered inside the dialog */
              }
            })()
          }}
        />
      ) : null}

      {conflictOpen ? (
        <ConflictDialog
          ids={memory.conflictsWith}
          busy={resolveConflict.busy}
          error={resolveConflict.error}
          onClose={() => setConflictOpen(false)}
          onResolve={(strategy, reason) => {
            void (async () => {
              try {
                const result = await resolveConflict.run({
                  id: memory.id,
                  strategy,
                  otherIds: [...memory.conflictsWith],
                  ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
                })
                setConflictOpen(false)
                if (result !== undefined) {
                  page.toast(translate('conflict.done', { count: result.archived.length }), 'ok')
                }
                afterChange()
              } catch {
                /* rendered inside the dialog */
              }
            })()
          }}
        />
      ) : null}
    </div>
  )
}

/** The two-step delete confirmation. */
function DeleteDialog(props: {
  id: string
  busy: boolean
  error: unknown
  onClose: () => void
  onConfirm: (archiveOnly: boolean) => void
}): ReactElement {
  const translate = useT()
  const [typed, setTyped] = useState('')
  const [finalStep, setFinalStep] = useState(false)
  const [archiveOnly, setArchiveOnly] = useState(false)
  const matches = typed.trim() === props.id

  return (
    <Modal
      title={translate('delete.title')}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {translate('common.cancel')}
          </Button>
          {finalStep ? (
            <Button variant="danger" disabled={props.busy} onClick={() => props.onConfirm(archiveOnly)}>
              {translate('delete.finalYes')}
            </Button>
          ) : (
            <Button variant="danger" disabled={!matches} onClick={() => setFinalStep(true)}>
              {translate('common.confirm')}
            </Button>
          )}
        </>
      }
    >
      <Notice kind="error">{translate('delete.warning')}</Notice>
      <div className="lmv-field">
        <span className="lmv-field-label">
          {translate('delete.typePrompt')} <span className="lmv-mono">{props.id}</span>
        </span>
        <TextInput value={typed} block placeholder={translate('delete.typePlaceholder')} onChange={setTyped} />
      </div>
      {typed.length > 0 && !matches ? <Notice kind="warn">{translate('delete.mismatch')}</Notice> : null}
      <Checkbox checked={archiveOnly} label={translate('delete.archiveOnly')} onChange={setArchiveOnly} />
      {finalStep ? <Notice kind="error">{translate('delete.final')}</Notice> : null}
      {props.error === null ? null : <ErrorNotice error={props.error} />}
    </Modal>
  )
}

/** The conflict-resolution dialog: keep / merge / both. */
function ConflictDialog(props: {
  ids: readonly string[]
  busy: boolean
  error: unknown
  onClose: () => void
  onResolve: (strategy: ConflictRequest['strategy'], reason: string) => void
}): ReactElement {
  const translate = useT()
  const [strategy, setStrategy] = useState<ConflictRequest['strategy']>('keep')
  const [reason, setReason] = useState('')
  const options: readonly { value: ConflictRequest['strategy']; label: string }[] = [
    { value: 'keep', label: translate('conflict.keep') },
    { value: 'merge', label: translate('conflict.merge') },
    { value: 'both', label: translate('conflict.both') },
  ]

  return (
    <Modal
      title={translate('conflict.title')}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" disabled={props.busy} onClick={() => props.onResolve(strategy, reason)}>
            {translate('common.apply')}
          </Button>
        </>
      }
    >
      <Field label={translate('conflict.others')}>
        {props.ids.length === 0 ? (
          <Notice>{translate('conflict.none')}</Notice>
        ) : (
          <span className="lmv-mono">{props.ids.join(', ')}</span>
        )}
      </Field>
      <Field label={translate('action.resolve')}>
        <Select<ConflictRequest['strategy']>
          value={strategy}
          options={options}
          onChange={setStrategy}
        />
      </Field>
      <Field label={translate('conflict.reason')}>
        <TextInput value={reason} block onChange={setReason} />
      </Field>
      {props.error === null ? null : <ErrorNotice error={props.error} />}
    </Modal>
  )
}
