/**
 * Candidates and inbox (收件箱): the pending extracted memories with per-item
 * confirm/reject, plus the manual add form.
 *
 * @module dsh-longterm-memory/client/views/inbox
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import type { AddCandidateRequest, SaveRequest } from '../../shared/protocol.js'
import { CONFIDENCE_LEVELS, MEMORY_TYPES } from '../../shared/types.js'
import type { Confidence, MemoryType } from '../../shared/types.js'
import { call, useAsync, useMutation } from '../api.js'
import { useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import { Badge, Button, Card, Checkbox, Empty, ErrorNotice, Field, Loading, Notice, NumberInput, Select, TextArea, TextInput } from '../ui.js'
import { clampImportance, confidenceKind, confidenceLabel, decisionLabel, formatTime, splitList, typeLabel } from '../util.js'

/** Render the inbox pane. */
export function InboxView(): ReactElement {
  const page = usePage()
  const translate = useT()
  const candidates = useAsync(() => call('candidates', {}), [])
  const confirm = useMutation((id: string) => call('confirm', { id }))
  const reject = useMutation((id: string) => call('reject', { id }))
  const addCandidate = useMutation((payload: AddCandidateRequest) => call('addCandidate', payload))
  const saveMemory = useMutation((payload: SaveRequest) => call('save', payload))

  const [asMemory, setAsMemory] = useState(false)
  const [type, setType] = useState<MemoryType>('knowledge')
  const [confidence, setConfidence] = useState<Confidence>('medium')
  const [importance, setImportance] = useState(50)
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [evidence, setEvidence] = useState('')
  const [reason, setReason] = useState('')

  const refresh = (): void => {
    candidates.reload()
    page.refreshStatus()
  }

  const act = async (id: string, kind: 'confirm' | 'reject'): Promise<void> => {
    try {
      if (kind === 'confirm') {
        await confirm.run(id)
        page.toast(translate('inbox.confirmed', { id }), 'ok')
      } else {
        await reject.run(id)
        page.toast(translate('inbox.rejected', { id }), 'ok')
      }
      refresh()
    } catch {
      /* rendered from the mutation state */
    }
  }

  const submit = async (): Promise<void> => {
    if (title.trim().length === 0) {
      page.toast(translate('edit.needTitle'), 'error')
      return
    }
    const base = {
      type,
      title: title.trim(),
      summary,
      tags: splitList(tagsText),
      confidence,
      importance: clampImportance(importance),
      evidence,
      ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
    }
    try {
      const result = asMemory ? await saveMemory.run(base) : await addCandidate.run(base)
      if (result !== undefined) page.toast(translate('inbox.addDone', { id: result.id }), 'ok')
      setTitle('')
      setSummary('')
      setTagsText('')
      setEvidence('')
      setReason('')
      refresh()
    } catch {
      /* rendered from the mutation state */
    }
  }

  const pending = candidates.data?.candidates ?? []
  const writeError = asMemory ? saveMemory.error : addCandidate.error

  return (
    <div className="lmv-main">
      <Card
        title={translate('inbox.title')}
        actions={
          <Button variant="ghost" onClick={candidates.reload}>
            {translate('common.refresh')}
          </Button>
        }
      >
        {candidates.loading ? <Loading /> : null}
        {candidates.error === null ? null : <ErrorNotice error={candidates.error} onRetry={candidates.reload} />}
        {confirm.error === null ? null : <ErrorNotice error={confirm.error} />}
        {reject.error === null ? null : <ErrorNotice error={reject.error} />}

        {candidates.loading || candidates.error !== null ? null : pending.length === 0 ? (
          <Empty>{translate('inbox.empty')}</Empty>
        ) : (
          <div className="lmv-list">
            {pending.map((candidate) => (
              <div key={candidate.id} className="lmv-row">
                <span className="lmv-row-main">
                  <span className="lmv-row-title">{candidate.title}</span>
                  <span className="lmv-row-preview">{candidate.summary}</span>
                  <span className="lmv-meta">
                    <Badge kind="brand">{typeLabel(candidate.type)}</Badge>
                    <Badge kind={confidenceKind(candidate.confidence)}>{confidenceLabel(candidate.confidence)}</Badge>
                    <span>
                      {translate('detail.importance')}: {String(candidate.importance)}
                    </span>
                    <span>
                      {translate('inbox.decision')}: {decisionLabel(candidate.decision)}
                    </span>
                    <span>
                      {translate('inbox.createdAt')}: {formatTime(candidate.createdAt)}
                    </span>
                  </span>
                  <span className="lmv-meta">
                    {candidate.tags.length === 0 ? null : <span>{candidate.tags.join(', ')}</span>}
                    {candidate.relatedIds.length === 0 ? null : (
                      <span className="lmv-mono">
                        {translate('inbox.related')}: {candidate.relatedIds.join(', ')}
                      </span>
                    )}
                  </span>
                  <span className="lmv-meta">
                    {translate('inbox.why')}: {candidate.reason}
                  </span>
                  {candidate.refused === undefined ? null : (
                    <Notice kind="warn">{translate('inbox.refused', { reason: candidate.refused })}</Notice>
                  )}
                </span>
                <span className="lmv-wrap">
                  <Button
                    variant="primary"
                    disabled={confirm.busy || candidate.refused !== undefined}
                    onClick={() => void act(candidate.id, 'confirm')}
                  >
                    {translate('inbox.confirm')}
                  </Button>
                  <Button disabled={reject.busy} onClick={() => void act(candidate.id, 'reject')}>
                    {translate('inbox.reject')}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={translate('inbox.add')}>
        <span className="lmv-prose-p">{translate('inbox.addHint')}</span>
        <div className="lmv-toolbar">
          <Checkbox checked={asMemory} label={asMemory ? translate('inbox.addModeMemory') : translate('inbox.addModeCandidate')} onChange={setAsMemory} />
          <Field label={translate('edit.type')}>
            <Select<MemoryType>
              value={type}
              options={MEMORY_TYPES.map((value) => ({ value, label: typeLabel(value) }))}
              onChange={setType}
            />
          </Field>
          <Field label={translate('edit.confidence')}>
            <Select<Confidence>
              value={confidence}
              options={CONFIDENCE_LEVELS.map((value) => ({ value, label: confidenceLabel(value) }))}
              onChange={setConfidence}
            />
          </Field>
          <Field label={translate('edit.importance')}>
            <NumberInput value={importance} min={0} max={100} onChange={setImportance} />
          </Field>
        </div>

        <Field label={translate('inbox.formTitle')}>
          <TextInput value={title} block onChange={setTitle} />
        </Field>
        <Field label={translate('inbox.formSummary')}>
          <TextArea value={summary} rows={6} onChange={setSummary} />
        </Field>
        <div className="lmv-toolbar">
          <Field label={`${translate('inbox.formTags')} ${translate('common.comma')}`}>
            <TextInput value={tagsText} block onChange={setTagsText} />
          </Field>
          <Field label={translate('inbox.formEvidence')}>
            <TextInput value={evidence} block onChange={setEvidence} />
          </Field>
          <Field label={translate('inbox.formReason')}>
            <TextInput value={reason} block onChange={setReason} />
          </Field>
        </div>

        {writeError === null ? null : <ErrorNotice error={writeError} />}

        <div className="lmv-wrap">
          <Button
            variant="primary"
            disabled={addCandidate.busy || saveMemory.busy}
            onClick={() => void submit()}
          >
            {translate('inbox.add')}
          </Button>
        </div>
      </Card>
    </div>
  )
}
