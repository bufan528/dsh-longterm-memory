/**
 * Overview (记忆总览): everything the vault can say about itself at a glance.
 *
 * Reads only from the real `overview` RPC — no mock data anywhere — and wires
 * the two index actions plus `openVault` to their real routes.
 *
 * @module dsh-longterm-memory/client/views/overview
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import type { CapabilityReport, OverviewResponse } from '../../shared/protocol.js'
import { MEMORY_TYPES } from '../../shared/types.js'
import type { VaultInfo } from '../../shared/types.js'
import { call, useAsync, useMutation } from '../api.js'
import { useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import { Badge, Button, Card, Empty, ErrorNotice, Loading, Notice, Stat, TagChip } from '../ui.js'
import { formatTime, typeLabel } from '../util.js'
import { HitRow } from './hit-row.js'

/** Render the overview pane. */
export function OverviewView(props: { vault: VaultInfo; capabilities: CapabilityReport }): ReactElement {
  const page = usePage()
  const translate = useT()
  const overview = useAsync(() => call('overview', {}), [])
  const rebuild = useMutation(() => call('rebuildIndex', {}))
  const sync = useMutation(() => call('syncIndex', {}))
  const openVault = useMutation(() => call('openVault', {}))
  const [openNotice, setOpenNotice] = useState<{ opened: boolean; detail: string } | null>(null)

  const data: OverviewResponse | null = overview.data
  const vault = data?.vault ?? props.vault
  const busy = data?.busy === true || rebuild.busy || sync.busy

  const refresh = (): void => {
    overview.reload()
    page.refreshStatus()
  }

  const doRebuild = async (): Promise<void> => {
    try {
      const result = await rebuild.run()
      if (result !== undefined) {
        page.toast(
          `${translate('overview.rebuildDone', {
            records: result.records,
            repaired: result.repairedFiles,
            ms: result.tookMs,
          })}${result.quarantined.length > 0 ? ` — ${translate('manage.quarantined')}: ${String(result.quarantined.length)}` : ''}`,
          'ok',
        )
      }
      refresh()
    } catch {
      /* rendered from the mutation state */
    }
  }

  const doSync = async (): Promise<void> => {
    try {
      const result = await sync.run()
      if (result !== undefined) {
        page.toast(
          translate('overview.syncDone', {
            added: result.added.length,
            updated: result.updated.length,
            removed: result.removed.length,
            unchanged: result.unchanged,
          }),
          'ok',
        )
      }
      refresh()
    } catch {
      /* rendered from the mutation state */
    }
  }

  const doOpen = async (): Promise<void> => {
    try {
      const result = await openVault.run()
      if (result !== undefined) setOpenNotice(result)
    } catch {
      /* rendered from the mutation state */
    }
  }

  const tagList = data?.tags ?? []

  return (
    <div className="lmv-main">
      <Card
        title={translate('overview.vaultPath')}
        actions={
          <>
            <Button disabled={busy} onClick={() => void doRebuild()}>
              {translate('overview.rebuild')}
            </Button>
            <Button disabled={busy} onClick={() => void doSync()}>
              {translate('overview.sync')}
            </Button>
            <Button disabled={openVault.busy} onClick={() => void doOpen()}>
              {translate('manage.openVault')}
            </Button>
          </>
        }
      >
        <span className="lmv-mono">{vault.path}</span>
        <div className="lmv-wrap">
          <Badge kind={vault.initialized ? 'ok' : 'error'}>
            {vault.initialized ? translate('common.enabled') : translate('common.disabled')}
          </Badge>
          <Badge kind={vault.obsidianVault ? 'brand' : 'plain'}>
            Obsidian: {vault.obsidianVault ? translate('common.yes') : translate('common.no')}
          </Badge>
          <Badge kind={vault.reused ? 'plain' : 'brand'}>
            {vault.reused ? translate('init.current') : translate('init.ready')}
          </Badge>
        </div>

        {busy ? <Loading label={translate('overview.busy')} /> : null}
        {rebuild.error === null ? null : <ErrorNotice error={rebuild.error} />}
        {sync.error === null ? null : <ErrorNotice error={sync.error} />}
        {openVault.error === null ? null : <ErrorNotice error={openVault.error} />}
        {openNotice === null ? null : (
          <Notice kind={openNotice.opened ? 'ok' : 'warn'}>{openNotice.detail}</Notice>
        )}
      </Card>

      <Card title={translate('nav.overview')}>
        {overview.loading && data === null ? <Loading /> : null}
        {overview.error === null ? null : <ErrorNotice error={overview.error} onRetry={overview.reload} />}
        <div className="lmv-grid">
          <Stat label={translate('overview.total')} value={vault.stats.total} />
          <Stat label={translate('overview.pending')} value={vault.stats.pending} />
          <Stat label={translate('overview.problems')} value={vault.stats.conflicts} />
          <Stat label={translate('overview.pinned')} value={vault.stats.pinned} />
          <Stat label={translate('overview.stale')} value={vault.stats.stale} />
          <Stat label={translate('overview.archived')} value={vault.stats.archived} />
          <Stat label={translate('overview.outOfSync')} value={vault.stats.outOfSync} />
          <Stat label={translate('overview.indexCount')} value={vault.index.count} />
        </div>
      </Card>

      <Card title={translate('overview.byType')}>
        <div className="lmv-grid">
          {MEMORY_TYPES.map((type) => (
            <Stat key={type} label={typeLabel(type)} value={vault.stats.byType[type] ?? 0} />
          ))}
        </div>
      </Card>

      <Card title={translate('overview.indexHealthy')}>
        <div className="lmv-kv">
          <span className="lmv-kv-key">{translate('overview.indexBuiltAt')}</span>
          <span className="lmv-kv-val">{formatTime(vault.index.builtAt)}</span>
          <span className="lmv-kv-key">{translate('overview.indexHealthy')}</span>
          <span className="lmv-kv-val">
            <Badge kind={vault.index.healthy ? 'ok' : 'warn'}>
              {vault.index.healthy ? translate('overview.indexHealthyYes') : translate('overview.indexHealthyNo')}
            </Badge>
          </span>
          <span className="lmv-kv-key">{translate('overview.indexPath')}</span>
          <span className="lmv-kv-val lmv-mono">{vault.index.path}</span>
        </div>

        {data !== null && data.outOfSync.length > 0 ? (
          <>
            <span className="lmv-field-label">{translate('overview.outOfSyncList')}</span>
            <div className="lmv-list">
              {data.outOfSync.map((path) => (
                <span key={path} className="lmv-mono">
                  {path}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </Card>

      <Card title={translate('overview.tags')}>
        {tagList.length === 0 ? (
          <Empty />
        ) : (
          <>
            <span className="lmv-field-label">{translate('overview.tagsHint')}</span>
            <div className="lmv-chips lmv-chips-scroll">
              {tagList.map((entry) => (
                <TagChip
                  key={entry.tag}
                  tag={entry.tag}
                  count={entry.count}
                  onClick={() => {
                    page.searchTag(entry.tag)
                  }}
                />
              ))}
            </div>
          </>
        )}
      </Card>

      <div className="lmv-grid-wide">
        <Card title={translate('overview.recentCreated')}>
          {data === null || data.recentCreated.length === 0 ? (
            <Empty />
          ) : (
            <div className="lmv-list">
              {data.recentCreated.map((hit) => (
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

        <Card title={translate('overview.recentUpdated')}>
          {data === null || data.recentUpdated.length === 0 ? (
            <Empty />
          ) : (
            <div className="lmv-list">
              {data.recentUpdated.map((hit) => (
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

        <Card title={translate('overview.pendingList')}>
          {data === null || data.pending.length === 0 ? (
            <Empty />
          ) : (
            <div className="lmv-list">
              {data.pending.map((hit) => (
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

        <Card title={translate('overview.problemsList')}>
          {data === null || data.problems.length === 0 ? (
            <Empty />
          ) : (
            <div className="lmv-list">
              {data.problems.map((hit) => (
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
      </div>

      <Card title={translate('overview.capabilities')}>
        <div className="lmv-wrap">
          <Badge kind={props.capabilities.filesystem ? 'ok' : 'error'}>{translate('cap.filesystem')}</Badge>
          <Badge kind={props.capabilities.webServer ? 'ok' : 'error'}>{translate('cap.webServer')}</Badge>
          <Badge kind={props.capabilities.systemPrompt ? 'ok' : 'warn'}>{translate('cap.systemPrompt')}</Badge>
          <Badge kind={props.capabilities.tools ? 'ok' : 'warn'}>{translate('cap.tools')}</Badge>
          <Badge kind={props.capabilities.sessionEvents ? 'ok' : 'warn'}>{translate('cap.sessionEvents')}</Badge>
          <Badge kind={props.capabilities.llmExtraction ? 'ok' : 'plain'}>{translate('cap.llmExtraction')}</Badge>
        </div>
        <div className="lmv-kv">
          <span className="lmv-kv-key">{translate('cap.registeredTools')}</span>
          <span className="lmv-kv-val lmv-mono">
            {props.capabilities.registeredTools.length === 0 ? translate('common.none') : props.capabilities.registeredTools.join(', ')}
          </span>
        </div>
        {Object.keys(props.capabilities.notes).length === 0 ? null : (
          <div className="lmv-list">
            <span className="lmv-field-label">{translate('overview.notes')}</span>
            {Object.entries(props.capabilities.notes).map(([key, note]) => (
              <Notice key={key} kind="warn">
                {key}: {note}
              </Notice>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
