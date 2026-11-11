/**
 * Overview (记忆总览): everything the vault can say about itself at a glance.
 *
 * Reads only from the real `overview` RPC — no mock data anywhere — and wires
 * the two index actions plus `openVault` to their real routes.
 *
 * Layout follows three rules borrowed from the HIG:
 * 1. one band at the top answers "where am I, is it healthy, what is the one
 *    thing I should press" — so the primary action lives there and nowhere else;
 * 2. numbers that imply an action are separated from numbers that are just
 *    inventory, because mixing the two makes everything look equally urgent;
 * 3. proportions are drawn, not listed — eight equal boxes hide the fact that
 *    one category dominates.
 *
 * @module dsh-longterm-memory/client/views/overview
 */

import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import type { CapabilityReport, OverviewResponse } from '../../shared/protocol.js'
import { MEMORY_TYPES } from '../../shared/types.js'
import type { VaultInfo } from '../../shared/types.js'
import { call, useAsync, useMutation } from '../api.js'
import { useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import { Badge, Button, Card, Empty, ErrorNotice, Icon, Loading, Notice, Stat, TagChip } from '../ui.js'
import { formatTime, typeLabel } from '../util.js'
import { HitRow } from './hit-row.js'

/** One cell of the attention strip. */
function AttnCell(props: {
  value: number
  label: string
  tone?: 'plain' | 'warn' | 'error'
  onClick?: () => void
}): ReactElement {
  const tone = props.tone ?? 'plain'
  const className = `lmv-attn-cell${tone === 'plain' ? '' : ` lmv-attn-${tone}`}`
  const body = (
    <>
      <span className="lmv-attn-value">{props.value}</span>
      <span className="lmv-attn-label">{props.label}</span>
    </>
  )
  if (props.onClick === undefined) return <div className={className}>{body}</div>
  return (
    <button type="button" className={className} onClick={props.onClick}>
      {body}
    </button>
  )
}

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
  const stats = vault.stats
  const needsWork = stats.pending + stats.conflicts + stats.stale + stats.outOfSync
  const busyNow = busy || overview.loading

  // The distribution only draws categories that exist; an all-zero vault gets a
  // hint instead of eight invisible bars.
  const typeRows = MEMORY_TYPES.map((type) => ({ type, count: stats.byType[type] ?? 0 })).filter(
    (row) => row.count > 0,
  )
  const typeMax = typeRows.reduce((max, row) => Math.max(max, row.count), 0)

  const recentBlocks: { key: string; title: string; rows: OverviewResponse['recentCreated'] }[] = [
    { key: 'created', title: translate('overview.recentCreated'), rows: data?.recentCreated ?? [] },
    { key: 'updated', title: translate('overview.recentUpdated'), rows: data?.recentUpdated ?? [] },
    { key: 'pending', title: translate('overview.pendingList'), rows: data?.pending ?? [] },
    { key: 'problems', title: translate('overview.problemsList'), rows: data?.problems ?? [] },
  ]

  /** Error notices from the three mutations, stacked in one place. */
  const mutationErrors: ReactNode[] = []
  if (rebuild.error !== null) mutationErrors.push(<ErrorNotice key="rebuild" error={rebuild.error} />)
  if (sync.error !== null) mutationErrors.push(<ErrorNotice key="sync" error={sync.error} />)
  if (openVault.error !== null) mutationErrors.push(<ErrorNotice key="open" error={openVault.error} />)

  return (
    <div className="lmv-main">
      <section className="lmv-hero">
        <div className="lmv-hero-main">
          <span className="lmv-kicker">{translate('overview.vaultPath')}</span>
          <span className="lmv-hero-path">{vault.path}</span>
          <div className="lmv-hero-facts">
            <Badge kind={vault.initialized ? 'ok' : 'error'}>
              {vault.initialized ? translate('common.enabled') : translate('common.disabled')}
            </Badge>
            <Badge kind={vault.obsidianVault ? 'brand' : 'plain'}>
              Obsidian: {vault.obsidianVault ? translate('common.yes') : translate('common.no')}
            </Badge>
            <Badge kind={vault.reused ? 'plain' : 'brand'}>
              {vault.reused ? translate('init.current') : translate('init.ready')}
            </Badge>
            <Badge kind={vault.index.healthy ? 'ok' : 'warn'}>
              {vault.index.healthy
                ? translate('overview.indexHealthyYes')
                : translate('overview.indexHealthyNo')}
            </Badge>
          </div>
        </div>
        <div className="lmv-hero-actions">
          <Button variant="primary" disabled={busy} onClick={() => void doSync()}>
            <Icon name="refresh" />
            {translate('overview.sync')}
          </Button>
          <Button disabled={busy} onClick={() => void doRebuild()}>
            {translate('overview.rebuild')}
          </Button>
          <Button variant="ghost" disabled={openVault.busy} onClick={() => void doOpen()}>
            {translate('manage.openVault')}
          </Button>
        </div>
        {busy ? (
          <div className="lmv-hero-full">
            <Loading label={translate('overview.busy')} />
          </div>
        ) : null}
        {mutationErrors.length === 0 ? null : <div className="lmv-hero-full lmv-stack">{mutationErrors}</div>}
        {openNotice === null ? null : (
          <div className="lmv-hero-full">
            <Notice kind={openNotice.opened ? 'ok' : 'warn'}>{openNotice.detail}</Notice>
          </div>
        )}
      </section>

      <Card
        title={
          <>
            <Icon name="bolt" />
            {translate('overview.attention')}
          </>
        }
        actions={
          data === null || data.outOfSync.length === 0 ? null : (
            <Badge kind="warn">{translate('overview.outOfSync')}</Badge>
          )
        }
      >
        {overview.error === null ? null : <ErrorNotice error={overview.error} onRetry={overview.reload} />}
        {overview.loading && data === null ? (
          <Loading />
        ) : needsWork === 0 ? (
          <Notice kind="ok">{translate('overview.attentionClear')}</Notice>
        ) : (
          <div className="lmv-attn">
            <AttnCell
              value={stats.pending}
              label={translate('overview.pending')}
              tone={stats.pending > 0 ? 'warn' : 'plain'}
              onClick={() => {
                page.openInbox()
              }}
            />
            <AttnCell
              value={stats.conflicts}
              label={translate('overview.problems')}
              tone={stats.conflicts > 0 ? 'error' : 'plain'}
            />
            <AttnCell
              value={stats.stale}
              label={translate('overview.stale')}
              tone={stats.stale > 0 ? 'warn' : 'plain'}
            />
            <AttnCell
              value={stats.outOfSync}
              label={translate('overview.outOfSync')}
              tone={stats.outOfSync > 0 ? 'warn' : 'plain'}
            />
          </div>
        )}
      </Card>

      <div className="lmv-grid-2">
        <Card
          title={
            <>
              <Icon name="overview" />
              {translate('overview.ledger')}
            </>
          }
          actions={
            <Badge kind="brand">
              {translate('overview.indexCount')}: {vault.index.count}
            </Badge>
          }
        >
          <div className="lmv-grid">
            <Stat label={translate('overview.total')} value={stats.total} />
            <Stat label={translate('overview.pinned')} value={stats.pinned} />
            <Stat label={translate('overview.archived')} value={stats.archived} />
            <Stat label={translate('overview.outOfSync')} value={stats.outOfSync} />
          </div>
          <div className="lmv-kv">
            <span className="lmv-kv-key">{translate('overview.indexBuiltAt')}</span>
            <span className="lmv-kv-val">{formatTime(vault.index.builtAt)}</span>
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

        <Card
          title={
            <>
              <Icon name="star" />
              {translate('overview.byType')}
            </>
          }
          actions={busyNow ? null : <Badge kind="plain">{String(typeRows.length)}</Badge>}
        >
          {overview.loading && data === null ? (
            <Loading />
          ) : typeRows.length === 0 ? (
            <Empty
              icon="spark"
              title={translate('overview.noStats')}
              hint={translate('overview.distEmpty')}
            />
          ) : (
            <div className="lmv-dist">
              {typeRows.map((row) => (
                <div key={row.type} className={`lmv-dist-row${row.count === 0 ? ' lmv-dist-zero' : ''}`}>
                  <span className="lmv-dist-label">{typeLabel(row.type)}</span>
                  <span className="lmv-dist-track">
                    <span
                      className="lmv-dist-fill"
                      style={{ width: `${String(Math.max(4, Math.round((row.count / Math.max(1, typeMax)) * 100)))}%` }}
                    />
                  </span>
                  <span className="lmv-dist-value">{row.count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title={
          <>
            <Icon name="manage" />
            {translate('overview.tags')}
          </>
        }
        actions={
          tagList.length === 0 ? null : <span className="lmv-subhead">{translate('overview.tagsHint')}</span>
        }
      >
        {tagList.length === 0 ? (
          <Empty icon="manage" title={translate('overview.tags')} hint={translate('overview.tagsEmptyHint')} />
        ) : (
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
        )}
      </Card>

      <div className="lmv-grid-wide">
        {recentBlocks.map((block) => (
          <Card
            key={block.key}
            title={block.title}
            actions={<Badge kind="plain">{String(block.rows.length)}</Badge>}
          >
            {block.rows.length === 0 ? (
              <Empty />
            ) : (
              <div className="lmv-list">
                {block.rows.map((hit) => (
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
        ))}
      </div>

      <Card
        title={
          <>
            <Icon name="diagnostics" />
            {translate('overview.capabilities')}
          </>
        }
        actions={
          <Badge kind="plain">
            {translate('cap.registeredTools')}: {String(props.capabilities.registeredTools.length)}
          </Badge>
        }
      >
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
            {props.capabilities.registeredTools.length === 0
              ? translate('common.none')
              : props.capabilities.registeredTools.join(', ')}
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
