/**
 * The management page registered into the `main` slot.
 *
 * This is the page the first-level sidebar entry opens *instead of* a new chat.
 * It owns the section switch, the shared multi-selection, the toast queue and
 * the first-run gate, and hands each section a `PageApi` through context.
 *
 * Layout follows the macOS settings idiom rather than a web dashboard: a large
 * title with a one-line status capsule row, a segmented section control, and a
 * single scrolling content column. Only one thing animates per navigation.
 *
 * @module dsh-longterm-memory/client/memory-page
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { call, useAsync } from './api.js'
import { CLIENT_BUILD_ID } from './build-info.js'
import type { SlotProps } from './context.js'
import { setLanguage, useT } from './i18n.js'
import { PageContext } from './page-api.js'
import type { PageApi, ToastKind } from './page-api.js'
import { Button, ErrorNotice, Icon, Loading, StatPill } from './ui.js'
import type { IconName } from './ui.js'
import { DetailView } from './views/detail.js'
import { InboxView } from './views/inbox.js'
import { InitView } from './views/init.js'
import { ManageView } from './views/manage.js'
import { OverviewView } from './views/overview.js'
import { QqView } from './views/qq.js'
import { SearchView } from './views/search.js'
import { SettingsView } from './views/settings-view.js'
import { LifeView } from './views/life.js'

type Section = 'overview' | 'search' | 'manage' | 'inbox' | 'qq' | 'life' | 'settings'

interface Toast {
  id: number
  message: string
  kind: ToastKind
  /** Follow-through: a toast leaves with an animation, it must not blink out. */
  leaving: boolean
}

const SECTIONS: readonly { key: Section; labelKey: string; icon: IconName }[] = [
  { key: 'overview', labelKey: 'nav.overview', icon: 'overview' },
  { key: 'search', labelKey: 'nav.search', icon: 'search' },
  { key: 'manage', labelKey: 'nav.manage', icon: 'manage' },
  { key: 'inbox', labelKey: 'nav.inbox', icon: 'inbox' },
  { key: 'qq', labelKey: 'nav.qq', icon: 'qq' },
  { key: 'life', labelKey: 'nav.life', icon: 'life' },
  { key: 'settings', labelKey: 'nav.settings', icon: 'settings' },
]

let toastSeq = 0
const TOAST_MS = 4500
/** Exit duration. CSS `lmv-toast-out` uses the same value. */
const TOAST_EXIT_MS = 260

/** The center-column page for the `longterm-memory` panel. */
export function MemoryPage(_props: SlotProps): ReactElement {
  const translate = useT()
  const status = useAsync(() => call('status', {}), [])
  const [section, setSection] = useState<Section>('overview')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tag, setTag] = useState('')
  const [selection, setSelection] = useState<readonly string[]>([])
  const [toasts, setToasts] = useState<readonly Toast[]>([])
  const navKey = selectedId ?? section
  /**
   * Arcs / anticipation: navigation has a direction. Going forward slides in
   * from the right, going back from the left. Computed during render (refs are
   * the only safe place for "previous value" without an extra paint) and fed
   * to CSS through data-dir; the keyed body remount replays the animation.
   */
  const navRank = selectedId !== null ? SECTIONS.length + 1 : SECTIONS.findIndex((entry) => entry.key === section)
  const lastRank = useRef(navRank)
  const navDir = useRef<'forward' | 'back'>('forward')
  if (lastRank.current !== navRank) {
    navDir.current = navRank >= lastRank.current ? 'forward' : 'back'
    lastRank.current = navRank
  }

  useEffect(() => {
    const loaded = status.data
    if (loaded === null) return
    setLanguage(loaded.settings.language)
  }, [status.data])

  const toast = useCallback((message: string, kind: ToastKind = 'info'): void => {
    toastSeq += 1
    const id = toastSeq
    setToasts((current) => [...current, { id, message, kind, leaving: false }])
    // Two-phase removal: mark leaving, let the exit animation finish, then
    // unmount. A toast that simply disappears breaks the motion arc.
    window.setTimeout(() => {
      setToasts((current) => current.map((item) => (item.id === id ? { ...item, leaving: true } : item)))
      window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== id))
      }, TOAST_EXIT_MS)
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
      openInbox: () => {
        setSelectedId(null)
        setSection('inbox')
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
              <span className="lmv-subtitle">
                <span>{translate('page.subtitle')}</span>
                <span className="lmv-dot" aria-hidden="true">·</span>
                <span className="lmv-build" title={translate('page.buildHint')}>
                  {translate('page.build')} {CLIENT_BUILD_ID}
                </span>
              </span>
            </div>
          </header>
          <div className="lmv-body">
            <div className="lmv-fade">
              <InitView onReady={status.reload} />
            </div>
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
    ) : section === 'qq' ? (
      <QqView vault={vault} />
    ) : section === 'life' ? (
      <LifeView onChanged={refreshStatus} />
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
              <span>{translate('page.subtitle')}</span>
              <span className="lmv-dot" aria-hidden="true">·</span>
              <span className="lmv-path" title={vault.path}>{vault.path}</span>
              <span className="lmv-dot" aria-hidden="true">·</span>
              <span className="lmv-build" title={translate('page.buildHint')}>
                {translate('page.build')} {CLIENT_BUILD_ID}
              </span>
            </span>
          </div>
          <div className="lmv-head-actions">
            <div className="lmv-health">
              <StatPill label={translate('overview.total')} value={vault.stats.total} />
              <StatPill
                label={translate('overview.pending')}
                value={vault.stats.pending}
                tone={vault.stats.pending > 0 ? 'warn' : 'plain'}
              />
              <StatPill
                label={translate('overview.problems')}
                value={vault.stats.conflicts}
                tone={vault.stats.conflicts > 0 ? 'error' : 'plain'}
              />
              <StatPill
                label={vault.index.healthy ? translate('overview.indexHealthyYes') : translate('overview.indexHealthyNo')}
                value={<Icon name={vault.index.healthy ? 'check' : 'bolt'} size={13} />}
                tone={vault.index.healthy ? 'ok' : 'warn'}
              />
            </div>
            <Button
              variant="ghost"
              title={translate('common.refresh')}
              ariaLabel={translate('common.refresh')}
              onClick={refreshStatus}
            >
              <Icon name="refresh" />
            </Button>
          </div>
        </header>

        <nav className="lmv-nav" aria-label={translate('page.title')}>
          {SECTIONS.map((entry) => {
            const active = selectedId === null && section === entry.key
            const pending = entry.key === 'inbox' ? vault.stats.pending : 0
            return (
              <button
                key={entry.key}
                type="button"
                className={`lmv-nav-btn${active ? ' lmv-nav-btn-on' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  setSelectedId(null)
                  setSection(entry.key)
                }}
              >
                <Icon name={entry.icon} />
                <span>{translate(entry.labelKey)}</span>
                {pending > 0 ? <span className="lmv-nav-count">{pending}</span> : null}
              </button>
            )
          })}
        </nav>

        <div className="lmv-body">
          <div className="lmv-fade" data-dir={navDir.current} key={navKey}>
            {sectionBody}
          </div>
        </div>
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
        <div
          key={item.id}
          className={`lmv-toast${item.kind === 'info' ? '' : ` lmv-toast-${item.kind}`}${item.leaving ? ' lmv-toast-out' : ''}`}
        >
          <Icon name={item.kind === 'ok' ? 'check' : item.kind === 'error' ? 'bolt' : 'spark'} />
          <span className="lmv-grow">{item.message}</span>
        </div>
      ))}
    </div>
  )
}
