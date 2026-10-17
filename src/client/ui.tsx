/**
 * Hand-written UI primitives.
 *
 * The plugin guide forbids `require('@deepseek-ai/dsh-client-ui-primitives')`,
 * so every control the page needs is implemented here with plain elements,
 * theme tokens and no dependency beyond `react` itself. Modal focus handling and
 * the Escape key are implemented locally.
 *
 * @module dsh-longterm-memory/client/ui
 */

import { Fragment, useEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { friendlyError, errCode } from './api.js'
import { t } from './i18n.js'
import type { BadgeKind } from './util.js'
import { formatTime, shortId } from './util.js'

/** A button. */
export function Button(props: {
  children?: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  title?: string
  ariaLabel?: string
}): ReactElement {
  const variant = props.variant ?? 'default'
  const className =
    variant === 'primary'
      ? 'lmv-btn lmv-btn-primary'
      : variant === 'ghost'
        ? 'lmv-btn lmv-btn-ghost'
        : variant === 'danger'
          ? 'lmv-btn lmv-btn-danger'
          : 'lmv-btn'
  return (
    <button
      type="button"
      className={className}
      disabled={props.disabled === true}
      title={props.title}
      aria-label={props.ariaLabel}
      onClick={() => {
        props.onClick?.()
      }}
    >
      {props.children}
    </button>
  )
}

/** An inline activity indicator. */
export function Spinner(): ReactElement {
  return <span className="lmv-spin" aria-hidden="true" />
}

/** A "loading" line with an optional label. */
export function Loading(props: { label?: string }): ReactElement {
  return (
    <div className="lmv-loading" role="status">
      <Spinner />
      <span>{props.label ?? t('common.loading')}</span>
    </div>
  )
}

/** A "nothing here" placeholder. */
export function Empty(props: { children?: ReactNode }): ReactElement {
  return <div className="lmv-empty">{props.children ?? t('common.empty')}</div>
}

/** A coloured inline notice. */
export function Notice(props: { kind?: 'info' | 'warn' | 'error' | 'ok'; children?: ReactNode }): ReactElement {
  const kind = props.kind ?? 'info'
  const icon = kind === 'error' ? '!' : kind === 'warn' ? '!' : kind === 'ok' ? '✓' : 'i'
  return (
    <div className={`lmv-notice${kind === 'info' ? '' : ` lmv-notice-${kind}`}`}>
      <span className="lmv-notice-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="lmv-grow">{props.children}</span>
    </div>
  )
}

/** An error notice with an optional retry, wired to the RPC error shape. */
export function ErrorNotice(props: { error: unknown; onRetry?: () => void }): ReactElement {
  const code = errCode(props.error)
  return (
    <div className="lmv-notice lmv-notice-error" role="alert">
      <span className="lmv-notice-icon" aria-hidden="true">
        !
      </span>
      <span className="lmv-grow">
        <span>{friendlyError(props.error)}</span>
        <span className="lmv-meta">
          <span>
            {t('error.code')}: <span className="lmv-mono">{code}</span>
          </span>
        </span>
      </span>
      {props.onRetry === undefined ? null : (
        <Button variant="ghost" onClick={props.onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}

/** A titled card with an actions row. */
export function Card(props: { title?: ReactNode; actions?: ReactNode; children?: ReactNode }): ReactElement {
  return (
    <section className="lmv-card">
      {props.title === undefined && props.actions === undefined ? null : (
        <header className="lmv-card-head">
          {props.title === undefined ? null : <span className="lmv-card-title">{props.title}</span>}
          {props.actions === undefined ? null : <span className="lmv-card-actions">{props.actions}</span>}
        </header>
      )}
      {props.children}
    </section>
  )
}

/** A label above a control. */
export function Field(props: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="lmv-field">
      <span className="lmv-field-label">{props.label}</span>
      {props.children}
    </label>
  )
}

/** A single-line text input. */
export function TextInput(props: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'date' | 'number' | 'search'
  block?: boolean
  disabled?: boolean
  ariaLabel?: string
}): ReactElement {
  return (
    <input
      className={`lmv-input${props.block === true ? ' lmv-input-block' : ''}`}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled === true}
      aria-label={props.ariaLabel}
      onChange={(event) => {
        props.onChange(event.target.value)
      }}
    />
  )
}

/** A multi-line text input; used for summaries and the raw editor. */
export function TextArea(props: {
  value: string
  onChange: (value: string) => void
  rows?: number
  placeholder?: string
  ariaLabel?: string
}): ReactElement {
  return (
    <textarea
      className="lmv-textarea"
      rows={props.rows ?? 6}
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      onChange={(event) => {
        props.onChange(event.target.value)
      }}
    />
  )
}

/** A dropdown over a fixed option list. */
export function Select<T extends string>(props: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  ariaLabel?: string
}): ReactElement {
  return (
    <select
      className="lmv-select"
      value={props.value}
      aria-label={props.ariaLabel}
      onChange={(event) => {
        props.onChange(event.target.value as T)
      }}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/** A checkbox with an inline label. */
export function Checkbox(props: { checked: boolean; onChange: (checked: boolean) => void; label: ReactNode }): ReactElement {
  return (
    <label className="lmv-check">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => {
          props.onChange(event.target.checked)
        }}
      />
      <span>{props.label}</span>
    </label>
  )
}

/** A numeric input that keeps intermediate text editable. */
export function NumberInput(props: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  ariaLabel?: string
}): ReactElement {
  return (
    <input
      className="lmv-input lmv-number"
      type="number"
      value={String(props.value)}
      min={props.min}
      max={props.max}
      aria-label={props.ariaLabel}
      onChange={(event) => {
        const parsed = Number(event.target.value)
        props.onChange(Number.isFinite(parsed) ? parsed : 0)
      }}
    />
  )
}

/** A small status chip. */
export function Badge(props: { kind?: BadgeKind; children?: ReactNode; title?: string }): ReactElement {
  const kind = props.kind ?? 'plain'
  return (
    <span className={`lmv-badge${kind === 'plain' ? '' : ` lmv-badge-${kind}`}`} title={props.title}>
      {props.children}
    </span>
  )
}

/** A clickable tag chip; `on` marks it as an active filter. */
export function TagChip(props: { tag: string; on?: boolean; count?: number; onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      className={`lmv-tag${props.on === true ? ' lmv-tag-on' : ''}`}
      onClick={() => {
        props.onClick()
      }}
    >
      {props.tag}
      {props.count === undefined ? null : <span className="lmv-sep">{` ${String(props.count)}`}</span>}
    </button>
  )
}

/** A multi-select chip row over a fixed value list. */
export function EnumChips<T extends string>(props: {
  values: readonly T[]
  selected: readonly T[]
  labelOf: (value: T) => string
  onToggle: (value: T) => void
}): ReactElement {
  return (
    <div className="lmv-chips">
      {props.values.map((value) => (
        <TagChip
          key={value}
          tag={props.labelOf(value)}
          on={props.selected.includes(value)}
          onClick={() => {
            props.onToggle(value)
          }}
        />
      ))}
    </div>
  )
}

/** One number with a caption. */
export function Stat(props: { label: string; value: ReactNode }): ReactElement {
  return (
    <div className="lmv-stat">
      <span className="lmv-stat-value">{props.value}</span>
      <span className="lmv-stat-label">{props.label}</span>
    </div>
  )
}

/** A key/value definition list. */
export function KvList(props: { items: readonly { key: string; value: ReactNode }[] }): ReactElement {
  return (
    <div className="lmv-kv">
      {props.items.map((item) => (
        <Fragment key={item.key}>
          <span className="lmv-kv-key">{item.key}</span>
          <span className="lmv-kv-val">{item.value}</span>
        </Fragment>
      ))}
    </div>
  )
}

/** A clickable memory row used by the overview, search and manage views. */
export function MemoryRow(props: {
  id: string
  title: string
  preview?: string
  badges?: ReactNode
  meta?: ReactNode
  reasons?: readonly string[]
  selected?: boolean
  onOpen?: () => void
  onToggleSelect?: () => void
  trailing?: ReactNode
}): ReactElement {
  const body = (
    <span className="lmv-row-main">
      <span className="lmv-row-title">{props.title}</span>
      {props.preview === undefined || props.preview.length === 0 ? null : (
        <span className="lmv-row-preview">{props.preview}</span>
      )}
      {props.badges === undefined ? null : <span className="lmv-meta">{props.badges}</span>}
      {props.meta === undefined ? null : <span className="lmv-meta">{props.meta}</span>}
      {props.reasons === undefined || props.reasons.length === 0 ? null : (
        <span className="lmv-meta">
          <span>
            {t('search.reasons')}: {props.reasons.join(t('common.listSep'))}
          </span>
        </span>
      )}
    </span>
  )

  return (
    <div className={`lmv-row${props.selected === true ? ' lmv-row-on' : ''}`}>
      {props.onToggleSelect === undefined ? null : (
        <input
          type="checkbox"
          checked={props.selected === true}
          aria-label={`${t('search.select')}: ${props.id}`}
          onChange={() => {
            props.onToggleSelect?.()
          }}
        />
      )}
      {props.onOpen === undefined ? (
        body
      ) : (
        <button
          type="button"
          className="lmv-row-click"
          onClick={() => {
            props.onOpen?.()
          }}
        >
          {body}
        </button>
      )}
      {props.trailing}
    </div>
  )
}

/** A journal entry line. */
export function HistoryItem(props: {
  at: string
  op: string
  reason: string
  source?: string
  before?: string
  after?: string
}): ReactElement {
  return (
    <div className="lmv-history-item">
      <span className="lmv-meta">
        <span>{formatTime(props.at)}</span>
        <Badge kind="brand">{props.op}</Badge>
        {props.source === undefined || props.source.length === 0 ? null : (
          <span>
            {t('detail.source')}: <span className="lmv-mono">{shortId(props.source, 26)}</span>
          </span>
        )}
      </span>
      <span>{props.reason}</span>
      {props.before === undefined ? null : (
        <span className="lmv-meta">
          <span>
            {t('detail.before')}: {props.before}
          </span>
        </span>
      )}
      {props.after === undefined ? null : (
        <span className="lmv-meta">
          <span>
            {t('detail.after')}: {props.after}
          </span>
        </span>
      )}
    </div>
  )
}

/**
 * Render a memory body without a markdown library: headings, bullet lines and
 * paragraphs only, which is exactly the structure the vault writer emits.
 */
export function Prose(props: { text: string; fallback?: string }): ReactElement {
  const lines = props.text.split(/\r?\n/)
  const nodes: ReactNode[] = []
  let bullets: string[] = []
  let key = 0

  const flush = (): void => {
    if (bullets.length === 0) return
    const items = bullets
    bullets = []
    key += 1
    nodes.push(
      <ul className="lmv-prose-ul" key={`ul-${String(key)}`}>
        {items.map((item, index) => (
          <li key={`li-${String(key)}-${String(index)}`}>{item}</li>
        ))}
      </ul>,
    )
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim().length === 0) {
      flush()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flush()
      key += 1
      nodes.push(
        <h4 className="lmv-prose-h" key={`h-${String(key)}`}>
          {heading[2]}
        </h4>,
      )
      continue
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet !== null) {
      bullets.push(bullet[1] ?? '')
      continue
    }
    flush()
    key += 1
    nodes.push(
      <p className="lmv-prose-p" key={`p-${String(key)}`}>
        {line}
      </p>,
    )
  }
  flush()

  if (nodes.length === 0) {
    return <p className="lmv-prose-p">{props.fallback ?? ''}</p>
  }
  return <div className="lmv-prose">{nodes}</div>
}

const FOCUSABLE =
  'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * A modal dialog with its own focus trap, Escape handling and focus restore.
 *
 * @param props.title - the dialog heading.
 * @param props.onClose - called by Escape, the close button, or the backdrop.
 */
export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }): ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<Element | null>(null)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose

  useEffect(() => {
    restoreRef.current = document.activeElement
    const node = boxRef.current
    const focusable = node?.querySelectorAll<HTMLElement>(FOCUSABLE)
    if (focusable !== undefined && focusable.length > 0) focusable[0]?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || node === null) return
      const list = node.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (list.length === 0) {
        event.preventDefault()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const restore = restoreRef.current
      if (restore instanceof HTMLElement) restore.focus()
    }
  }, [])

  return (
    <div
      className="lmv-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="lmv-modal" role="dialog" aria-modal="true" aria-label={props.title} ref={boxRef}>
        <header className="lmv-modal-head">
          <span className="lmv-grow">{props.title}</span>
          <Button variant="ghost" onClick={props.onClose} ariaLabel={t('common.close')}>
            ✕
          </Button>
        </header>
        <div className="lmv-modal-body">{props.children}</div>
        {props.footer === undefined ? null : <footer className="lmv-modal-foot">{props.footer}</footer>}
      </div>
    </div>
  )
}
