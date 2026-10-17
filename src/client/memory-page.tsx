/**
 * The management page registered into the `main` slot.
 *
 * This is the page the first-level sidebar entry opens *instead of* a new chat.
 * It owns the section switch, the shared multi-selection, the toast queue and
 * the first-run gate, and hands each section a `PageApi` through context.
 *
 * @module dsh-longterm-memory/client/memory-page
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'

import { call, useAsync } from './api.js'
import type { SlotProps } from './context.js'
import { setLanguage, useT } from './i18n.js'
import { PageContext } from './page-api.js'
import type { PageApi, ToastKind } from './page-api.js'
import { Badge, Button, ErrorNotice, Loading } from './ui.js'
import { DetailView } from './views/detail.js'
import { InboxView } from './views/inbox.js'
import { InitView } from './views/init.js'
import { ManageView } from './views/manage.js'
import { OverviewView } from './views/overview.js'
import { SearchView } from './views/search.js'
import { SettingsView } from './views/settings-view.js'

type Section = 'overview' | 'search' | 'manage' | 'inbox' | 'settings'

interface Toast {
  id: number
  message: string
  kind: ToastKind
}

const SECTIONS: readonly { key: Section; labelKey: string }[] = [
  { key: 'overview', labelKey: 'nav.overview' },
  { key: 'search', labelKey: 'nav.search' },
  { key: 'manage', labelKey: 'nav.manage' },
  { key: 'inbox', labelKey: 'nav.inbox' },
  { key: 'settings', labelKey: 'nav.settings' },
]

let toastSeq = 0
const TOAST_MS = 4500

/** The center-column page for the `longterm-memory` panel. */
export function MemoryPage(_props: SlotProps): ReactElement {
  const translate = useT()
  const status = useAsync(() => call('status', {}), [])
  const [section, setSection] = useState<Section>('overview')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tag, setTag] = useState('')
  const [selection, setSelection] = useState<readonly string[]>([])
  const [toasts, setToasts] = useState<readonly Toast[]>([])

  useEffect(() => {
    const loaded = status.data
    if (loaded === null) return
    setLanguage(loaded.settings.language)
  }, [status.data])

  const toast = useCallback((message: string, kind: ToastKind = 'info'): void => {
    toastSeq += 1
    const id = toastSeq
    setToasts((current) => [...current, { id, message, kind }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id))
    }, TOAST_MS)
  }, [])

  const refreshStatus = status.reload
  const api: PageApi = useMemo(
    () => ({
      toast,
      openMemory: (id: string) => {
        setSelectedId(id)
      },
      searchTag: (next: string) => {
        setTag(next)
        setSelectedId(null)
        setSection('search')
      },
      refreshStatus,
      selection,
      toggleSelect: (id: string) => {
        setSelection((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
      },
      clearSelection: () => {
        setSelection([])
      },
    }),
    [toast, refreshStatus, selection],
  )

  if (status.data === null) {
    return (
      <div className="lmv-page">
        <div className="lmv-main">
          {status.error === null ? (
            <Loading label={translate('state.loadingPage')} />
          ) : (
            <ErrorNotice error={status.error} onRetry={status.reload} />
          )}
        </div>
      </div>
    )
  }

  const info = status.data
  const vault = info.vault

  if (vault === null || !vault.initialized) {
    return (
      <PageContext.Provider value={api}>
        <div className="lmv-page">
          <header className="lmv-head">
            <div className="lmv-head-titles">
              <h1 className="lmv-title">{translate('page.title')}</h1>
              <span className="lmv-subtitle">{translate('page.subtitle')}</span>
            </div>
          </header>
          <div className="lmv-body">
            <InitView onReady={status.reload} />
          </div>
          <Toasts toasts={toasts} />
        </div>
      </PageContext.Provider>
    )
  }

  const sectionBody =
    selectedId !== null ? (
      <DetailView key={selectedId} id={selectedId} onBack={() => setSelectedId(null)} onChanged={refreshStatus} />
    ) : section === 'overview' ? (
      <OverviewView vault={vault} capabilities={info.capabilities} />
    ) : section === 'search' ? (
      <SearchView tag={tag} onTagChange={setTag} />
    ) : section === 'manage' ? (
      <ManageView vault={vault} onVaultChanged={refreshStatus} />
    ) : section === 'inbox' ? (
      <InboxView />
    ) : (
      <SettingsView vault={vault} onChanged={refreshStatus} />
    )

  return (
    <PageContext.Provider value={api}>
      <div className="lmv-page">
        <header className="lmv-head">
          <div className="lmv-head-titles">
            <h1 className="lmv-title">{translate('page.title')}</h1>
            <span className="lmv-subtitle">
              {translate('page.subtitle')} · <span className="lmv-mono">{vault.path}</span>
            </span>
          </div>
          <div className="lmv-head-actions">
            <Badge kind="brand">
              {translate('overview.total')}: {vault.stats.total}
            </Badge>
            <Badge kind="brand">
              {translate('overview.pending')}: {vault.stats.pending}
            </Badge>
            <Badge kind={vault.stats.conflicts > 0 ? 'error' : 'plain'}>
              {translate('overview.problems')}: {vault.stats.conflicts}
            </Badge>
            <Badge kind={vault.index.healthy ? 'ok' : 'warn'}>
              {vault.index.healthy ? translate('overview.indexHealthyYes') : translate('overview.indexHealthyNo')}
            </Badge>
            <Button variant="ghost" onClick={refreshStatus}>
              {translate('common.refresh')}
            </Button>
          </div>
        </header>

        <nav className="lmv-nav" aria-label={translate('page.title')}>
          {SECTIONS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`lmv-nav-btn${selectedId === null && section === entry.key ? ' lmv-nav-btn-on' : ''}`}
              aria-current={selectedId === null && section === entry.key}
              onClick={() => {
                setSelectedId(null)
                setSection(entry.key)
              }}
            >
              {translate(entry.labelKey)}
              {entry.key === 'inbox' && vault.stats.pending > 0 ? ` (${String(vault.stats.pending)})` : ''}
            </button>
          ))}
        </nav>

        <div className="lmv-body">{sectionBody}</div>
        <Toasts toasts={toasts} />
      </div>
    </PageContext.Provider>
  )
}

/** The transient message stack. */
function Toasts(props: { toasts: readonly Toast[] }): ReactElement | null {
  if (props.toasts.length === 0) return null
  return (
    <div className="lmv-toasts" role="status" aria-live="polite">
      {props.toasts.map((item) => (
        <div key={item.id} className={`lmv-toast${item.kind === 'info' ? '' : ` lmv-toast-${item.kind}`}`}>
          {item.message}
        </div>
      ))}
    </div>
  )
}
