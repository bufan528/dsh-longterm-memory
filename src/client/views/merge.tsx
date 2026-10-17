/**
 * Merge dialog (合并重复记忆).
 *
 * Takes a set of memory ids from the shared selection, resolves their real
 * titles over `get`, and calls `merge` with an explicit survivor.
 *
 * @module dsh-longterm-memory/client/views/merge
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { call, useAsync, useMutation } from '../api.js'
import { useT } from '../i18n.js'
import { Button, ErrorNotice, Field, Loading, Modal, Notice, TextInput } from '../ui.js'

/** Render the merge dialog for `props.ids`. */
export function MergeDialog(props: { ids: readonly string[]; onClose: () => void; onDone: (id: string) => void }): ReactElement {
  const translate = useT()
  const ids = [...props.ids]
  const titles = useAsync(
    () =>
      Promise.all(
        ids.map(async (id) => {
          const detail = await call('get', { id })
          return { id, title: detail.memory.title }
        }),
      ),
    [ids.join('|')],
  )
  const [survivor, setSurvivor] = useState<string>(ids[0] ?? '')
  const [reason, setReason] = useState('')
  const merge = useMutation((targetId: string, reasonText: string) =>
    call('merge', {
      ids,
      targetId,
      ...(reasonText.trim().length > 0 ? { reason: reasonText.trim() } : {}),
    }),
  )

  const run = async (): Promise<void> => {
    try {
      const result = await merge.run(survivor, reason)
      if (result !== undefined) props.onDone(result.id)
    } catch {
      /* rendered from the mutation state */
    }
  }

  return (
    <Modal
      title={translate('merge.title')}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" disabled={merge.busy || ids.length < 2} onClick={() => void run()}>
            {translate('merge.run')}
          </Button>
        </>
      }
    >
      <p className="lmv-prose-p">{translate('merge.hint')}</p>
      {ids.length < 2 ? <Notice kind="warn">{translate('merge.needTwo')}</Notice> : null}
      {titles.loading ? <Loading /> : null}
      {titles.error === null ? null : <ErrorNotice error={titles.error} onRetry={titles.reload} />}

      <div className="lmv-list">
        {(titles.data ?? ids.map((id) => ({ id, title: id }))).map((item) => (
          <label key={item.id} className="lmv-row">
            <input
              type="radio"
              name="lmv-merge-survivor"
              checked={survivor === item.id}
              onChange={() => {
                setSurvivor(item.id)
              }}
            />
            <span className="lmv-row-main">
              <span className="lmv-row-title">{item.title}</span>
              <span className="lmv-meta">
                <span className="lmv-mono">{item.id}</span>
                <span>{survivor === item.id ? translate('merge.survivor') : translate('merge.folded')}</span>
              </span>
            </span>
          </label>
        ))}
      </div>

      <Field label={translate('merge.reason')}>
        <TextInput value={reason} block onChange={setReason} />
      </Field>

      {merge.error === null ? null : <ErrorNotice error={merge.error} />}
    </Modal>
  )
}
