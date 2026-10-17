/**
 * Management (记忆管理): index maintenance, storage location, vault switching,
 * bulk status changes over the shared selection, and the vault-wide journal.
 *
 * @module dsh-longterm-memory/client/views/manage
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import type { RebuildIndexResponse, SyncIndexResponse } from '../../shared/protocol.js'
import type { MemoryStatus, VaultInfo } from '../../shared/types.js'
import { call, useAsync, useMutation } from '../api.js'
import { useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import { Button, Card, Empty, ErrorNotice, Field, HistoryItem, KvList, Loading, Notice, TextInput } from '../ui.js'
import { formatTime, statusLabel } from '../util.js'
import { MergeDialog } from './merge.js'

/** Render the management pane. */
export function ManageView(props: { vault: VaultInfo; onVaultChanged: () => void }): ReactElement {
  const page = usePage()
  const translate = useT()
  const overview = useAsync(() => call('overview', {}), [])
  const journal = useAsync(() => call('history', { limit: 50 }), [])
  const rebuild = useMutation(() => call('rebuildIndex', {}))
  const sync = useMutation(() => call('syncIndex', {}))
  const openVault = useMutation(() => call('openVault', {}))
  const chooseVault = useMutation((path: string) => call('chooseVault', { path }))
  const bulkStatus = useMutation(async (status: MemoryStatus) => {
    for (const id of page.selection) await call('setStatus', { id, status })
  })
  const bulkPin = useMutation(async (pinned: boolean) => {
    for (const id of page.selection) await call('setPinned', { id, pinned })
  })

  const [openNotice, setOpenNotice] = useState<{ opened: boolean; detail: string } | null>(null)
  const [vaultPath, setVaultPath] = useState('')
  const [rebuildResult, setRebuildResult] = useState<RebuildIndexResponse | null>(null)
  const [syncResult, setSyncResult] = useState<SyncIndexResponse | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)

  const refresh = (): void => {
    overview.reload()
    journal.reload()
    page.refreshStatus()
    props.onVaultChanged()
  }

  const runRebuild = async (): Promise<void> => {
    try {
      const result = await rebuild.run()
      if (result !== undefined) setRebuildResult(result)
      refresh()
    } catch {
      /* rendered from the mutation state */
    }
  }

  const runSync = async (): Promise<void> => {
    try {
      const result = await sync.run()
      if (result !== undefined) setSyncResult(result)
      refresh()
    } catch {
      /* rendered from the mutation state */
    }
  }

  const runBulk = async (work: () => Promise<unknown>): Promise<void> => {
    try {
      await work()
      page.toast(translate('action.done'), 'ok')
      refresh()
    } catch {
      /* rendered from the mutation state */
    }
  }

  const selected = page.selection

  return (
    <div className="lmv-main">
      <Card
        title={translate('manage.index')}
        actions={
          <>
            <Button disabled={rebuild.busy || sync.busy} onClick={() => void runRebuild()}>
              {translate('manage.rebuild')}
            </Button>
            <Button disabled={rebuild.busy || sync.busy} onClick={() => void runSync()}>
              {translate('manage.sync')}
            </Button>
          </>
        }
      >
        {overview.data?.busy === true || rebuild.busy || sync.busy ? (
          <Loading label={translate('overview.busy')} />
        ) : null}
        <KvList
          items={[
            { key: translate('overview.indexBuiltAt'), value: formatTime(props.vault.index.builtAt) },
            { key: translate('overview.indexCount'), value: String(props.vault.index.count) },
            {
              key: translate('overview.indexHealthy'),
              value: props.vault.index.healthy ? translate('overview.indexHealthyYes') : translate('overview.indexHealthyNo'),
            },
          ]}
        />

        {rebuildResult === null ? null : (
          <Notice kind="ok">
            {translate('overview.rebuildDone', {
              records: rebuildResult.records,
              repaired: rebuildResult.repairedFiles,
              ms: rebuildResult.tookMs,
            })}
            {rebuildResult.quarantined.length === 0
              ? ''
              : ` · ${translate('manage.quarantined')}: ${rebuildResult.quarantined
                  .map((entry) => `${entry.path} (${entry.reason})`)
                  .join('; ')}`}
          </Notice>
        )}
        {syncResult === null ? null : (
          <Notice kind="ok">
            {translate('overview.syncDone', {
              added: syncResult.added.length,
              updated: syncResult.updated.length,
              removed: syncResult.removed.length,
              unchanged: syncResult.unchanged,
            })}
          </Notice>
        )}
        {rebuild.error === null ? null : <ErrorNotice error={rebuild.error} />}
        {sync.error === null ? null : <ErrorNotice error={sync.error} />}
      </Card>

      <Card
        title={translate('manage.storage')}
        actions={
          <Button
            disabled={openVault.busy}
            onClick={() => {
              void (async () => {
                try {
                  const result = await openVault.run()
                  if (result !== undefined) setOpenNotice(result)
                } catch {
                  /* rendered from the mutation state */
                }
              })()
            }}
          >
            {translate('manage.openVault')}
          </Button>
        }
      >
        <KvList
          items={[
            { key: translate('manage.vaultPath'), value: <span className="lmv-mono">{props.vault.path}</span> },
            { key: translate('manage.indexPath'), value: <span className="lmv-mono">{props.vault.index.path}</span> },
            { key: translate('manage.records'), value: String(props.vault.stats.total) },
            { key: translate('manage.repaired'), value: String(props.vault.stats.outOfSync) },
            { key: translate('settings.lastIndexRebuild'), value: formatTime(props.vault.index.builtAt) },
          ]}
        />
        {openNotice === null ? null : <Notice kind={openNotice.opened ? 'ok' : 'warn'}>{openNotice.detail}</Notice>}
        {openVault.error === null ? null : <ErrorNotice error={openVault.error} />}
      </Card>

      <Card title={translate('manage.switchVault')}>
        <Field label={translate('manage.vaultPath')}>
          <TextInput value={vaultPath} block placeholder={translate('init.manualPlaceholder')} onChange={setVaultPath} />
        </Field>
        {chooseVault.error === null ? null : <ErrorNotice error={chooseVault.error} />}
        <div className="lmv-wrap">
          <Button
            variant="primary"
            disabled={chooseVault.busy || vaultPath.trim().length === 0}
            onClick={() => {
              void (async () => {
                try {
                  await chooseVault.run(vaultPath.trim())
                  page.toast(translate('init.done'), 'ok')
                  setVaultPath('')
                  refresh()
                } catch {
                  /* rendered from the mutation state */
                }
              })()
            }}
          >
            {translate('manage.chooseVault')}
          </Button>
        </div>
      </Card>

      <Card title={translate('manage.selection')}>
        <span className="lmv-field-label">{translate('manage.selectionHint')}</span>
        {selected.length === 0 ? (
          <Empty>{translate('manage.selectionEmpty')}</Empty>
        ) : (
          <span className="lmv-mono">{selected.join(', ')}</span>
        )}
        <div className="lmv-wrap">
          <Button disabled={selected.length === 0 || bulkStatus.busy} onClick={() => void runBulk(() => bulkStatus.run('archived'))}>
            {translate('manage.bulkArchive')}
          </Button>
          <Button disabled={selected.length === 0 || bulkStatus.busy} onClick={() => void runBulk(() => bulkStatus.run('stale'))}>
            {translate('manage.bulkStale')}
          </Button>
          <Button disabled={selected.length === 0 || bulkStatus.busy} onClick={() => void runBulk(() => bulkStatus.run('active'))}>
            {translate('manage.bulkRestore')}
          </Button>
          <Button disabled={selected.length === 0 || bulkPin.busy} onClick={() => void runBulk(() => bulkPin.run(true))}>
            {translate('manage.bulkPin')}
          </Button>
          <Button disabled={selected.length === 0 || bulkPin.busy} onClick={() => void runBulk(() => bulkPin.run(false))}>
            {translate('manage.bulkUnpin')}
          </Button>
          <Button variant="primary" disabled={selected.length < 2} onClick={() => setMergeOpen(true)}>
            {translate('manage.bulkMerge')}
          </Button>
          <Button variant="ghost" disabled={selected.length === 0} onClick={page.clearSelection}>
            {translate('search.clearSelection')}
          </Button>
        </div>
        <span className="lmv-meta">
          {translate('search.statuses')}: {statusLabel('active')} / {statusLabel('stale')} / {statusLabel('archived')}
        </span>
        {bulkStatus.error === null ? null : <ErrorNotice error={bulkStatus.error} />}
        {bulkPin.error === null ? null : <ErrorNotice error={bulkPin.error} />}
      </Card>

      <Card
        title={translate('manage.journal')}
        actions={
          <Button variant="ghost" onClick={journal.reload}>
            {translate('common.refresh')}
          </Button>
        }
      >
        {journal.loading ? <Loading /> : null}
        {journal.error === null ? null : <ErrorNotice error={journal.error} onRetry={journal.reload} />}
        {journal.data === null || journal.data.entries.length === 0 ? (
          <Empty>{translate('manage.journalEmpty')}</Empty>
        ) : (
          <div className="lmv-history">
            {journal.data.entries.map((entry, index) => (
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

      {mergeOpen ? (
        <MergeDialog
          ids={selected}
          onClose={() => setMergeOpen(false)}
          onDone={(id) => {
            setMergeOpen(false)
            page.clearSelection()
            page.toast(translate('merge.done', { id }), 'ok')
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}
