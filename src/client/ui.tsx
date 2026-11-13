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
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react'

import { friendlyError, errCode } from './api.js'
import { t } from './i18n.js'
import type { BadgeKind } from './util.js'
import { formatTime, shortId } from './util.js'

/** Every glyph the management page draws. Stroke-only, so it inherits colour. */
export type IconName =
  | 'overview' | 'search' | 'manage' | 'inbox' | 'qq' | 'life' | 'settings'
  | 'persona' | 'sharing' | 'review' | 'stickers' | 'reminders' | 'privacy' | 'diagnostics'
  | 'refresh' | 'plus' | 'trash' | 'star' | 'starOn' | 'check' | 'back' | 'close'
  | 'spark' | 'clock' | 'image' | 'upload' | 'chevron' | 'shield' | 'bolt' | 'edit'

/**
 * A 16px line icon.
 *
 * Hand-drawn instead of an icon package: the plugin may not `require` anything
 * beyond React, and a font-based icon set would inherit the host's font stack.
 */
export function Icon(props: { name: IconName; size?: number }): ReactElement {
  const size = props.size ?? 16
  const base = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  } as const
  switch (props.name) {
    case 'overview':
      return <svg {...base}><rect x="3" y="3" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="2" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" /></svg>
    case 'search':
      return <svg {...base}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></svg>
    case 'manage':
      return <svg {...base}><path d="M4 6h16M4 12h16M4 18h10" /></svg>
    case 'inbox':
      return <svg {...base}><path d="M4 5h16v10l-4 4H8l-4-4z" /><path d="M4 14h4l1.5 2h5L16 14h4" /></svg>
    case 'qq':
      return <svg {...base}><path d="M20 15a8 8 0 1 0-4 5" /><path d="M9 10h.01M15 10h.01" /><path d="M9.5 14c.8.8 1.6 1.2 2.5 1.2s1.7-.4 2.5-1.2" /></svg>
    case 'life':
      return <svg {...base}><path d="M12 20s-7-4.3-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.7-7 9-7 9z" /></svg>
    case 'settings':
      return <svg {...base}><circle cx="12" cy="12" r="3.2" /><path d="M12 3v2.2M12 18.8V21M4.2 7.6l1.9 1.1M17.9 15.3l1.9 1.1M4.2 16.4l1.9-1.1M17.9 8.7l1.9-1.1" /></svg>
    case 'persona':
      return <svg {...base}><circle cx="12" cy="8" r="3.6" /><path d="M5 20c.9-3.6 3.6-5.4 7-5.4s6.1 1.8 7 5.4" /></svg>
    case 'sharing':
      return <svg {...base}><circle cx="6" cy="12" r="2.4" /><circle cx="18" cy="6" r="2.4" /><circle cx="18" cy="18" r="2.4" /><path d="m8.2 10.9 7.6-3.8M8.2 13.1l7.6 3.8" /></svg>
    case 'review':
      return <svg {...base}><path d="M5 4h14v16l-7-4-7 4z" /><path d="m9 10 2 2 4-4" /></svg>
    case 'stickers':
      return <svg {...base}><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8" /><path d="M9 9.5h.01M15 9.5h.01" /></svg>
    case 'reminders':
      return <svg {...base}><circle cx="12" cy="13" r="7.5" /><path d="M12 9.5V13l2.5 1.6" /><path d="M4 5.5 6 4M20 5.5 18 4" /></svg>
    case 'privacy':
      return <svg {...base}><rect x="5" y="10.5" width="14" height="9.5" rx="2.2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></svg>
    case 'diagnostics':
      return <svg {...base}><path d="M3 12h3.5l2-5 3 10 2.5-7 1.6 2h5.4" /></svg>
    case 'refresh':
      return <svg {...base}><path d="M20 11a8 8 0 1 0-1.6 5.6" /><path d="M20 4.5V11h-6.2" /></svg>
    case 'plus':
      return <svg {...base}><path d="M12 5v14M5 12h14" /></svg>
    case 'trash':
      return <svg {...base}><path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2L17.5 7" /></svg>
    case 'star':
      return <svg {...base}><path d="m12 3.8 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" /></svg>
    case 'starOn':
      return <svg {...base} fill="currentColor"><path d="m12 3.8 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" /></svg>
    case 'check':
      return <svg {...base}><path d="m5 12.5 4.5 4.5L19 7" /></svg>
    case 'back':
      return <svg {...base}><path d="M14.5 5 7.5 12l7 7" /></svg>
    case 'close':
      return <svg {...base}><path d="m6 6 12 12M18 6 6 18" /></svg>
    case 'spark':
      return <svg {...base}><path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18.2l-1.8-5.6L4.7 10.8 10.2 9z" /></svg>
    case 'clock':
      return <svg {...base}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.9" /></svg>
    case 'image':
      return <svg {...base}><rect x="3.5" y="4.5" width="17" height="15" rx="2.4" /><circle cx="9" cy="9.6" r="1.6" /><path d="m4.5 17 4.6-4.3 3.2 2.9 3-2.6 4.2 4" /></svg>
    case 'upload':
      return <svg {...base}><path d="M12 16V4.5M7.5 9 12 4.5 16.5 9" /><path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>
    case 'chevron':
      return <svg {...base}><path d="m9 5 7 7-7 7" /></svg>
    case 'shield':
      return <svg {...base}><path d="M12 3.5 19 6v6c0 4.3-3 7.2-7 8.5-4-1.3-7-4.2-7-8.5V6z" /><path d="m9 12 2 2 4-4" /></svg>
    case 'bolt':
      return <svg {...base}><path d="M13.5 3 5.5 13.5H11l-.5 7.5 8-10.5H13z" /></svg>
    case 'edit':
      return <svg {...base}><path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10z" /><path d="m14.5 6.5 3 3" /></svg>
  }
  // Unreachable for a well-typed caller; keeps the return type non-optional.
  return <svg {...base} />
}

/** A button. */
/**
 * Spawn a ripple at the pointer position (Material's feedback, tuned quieter:
 * low opacity and one slow bloom — Disney's "restraint" rule wins over a
 * splash). The span self-destructs; nothing persists between clicks.
 */
function spawnRipple(event: ReactPointerEvent<HTMLButtonElement>): void {
  const host = event.currentTarget
  if (host.disabled) return
  const rect = host.getBoundingClientRect()
  const size = Math.max(rect.width, rect.height) * 2.2
  const span = document.createElement('span')
  span.className = 'lmv-ripple'
  span.style.width = `${String(size)}px`
  span.style.height = `${String(size)}px`
  span.style.left = `${String(event.clientX - rect.left - size / 2)}px`
  span.style.top = `${String(event.clientY - rect.top - size / 2)}px`
  host.appendChild(span)
  window.setTimeout(() => { span.remove() }, 340)
}

export function Button(props: {
  children?: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
  title?: string
  ariaLabel?: string
  /** For buttons that toggle visibility (expand/collapse switches). */
  ariaExpanded?: boolean
}): ReactElement {
  const variant = props.variant ?? 'default'
  const base =
    variant === 'primary'
      ? 'lmv-btn lmv-btn-primary'
      : variant === 'ghost'
        ? 'lmv-btn lmv-btn-ghost'
        : variant === 'danger'
          ? 'lmv-btn lmv-btn-danger'
          : 'lmv-btn'
  const className = props.size === 'sm' ? `${base} lmv-btn-sm` : base
  return (
    <button
      type="button"
      className={className}
      disabled={props.disabled === true}
      title={props.title}
      aria-label={props.ariaLabel}
      aria-expanded={props.ariaExpanded}
      onPointerDown={spawnRipple}
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

/** A "nothing here" placeholder.
 *
 * The bare form stays supported because half the panes call `<Empty />` with no
 * arguments; the richer form is used where an empty state is the first thing a
 * new user sees, and there it should explain what to do next.
 */
export function Empty(props: {
  icon?: IconName
  title?: string
  hint?: string
  action?: ReactNode
  children?: ReactNode
}): ReactElement {
  const bare = props.title === undefined && props.hint === undefined && props.icon === undefined
  if (bare) return <div className="lmv-empty">{props.children ?? t('common.empty')}</div>
  return (
    <div className="lmv-empty-state">
      {props.icon === undefined ? null : (
        <span className="lmv-empty-icon" aria-hidden="true"><Icon name={props.icon} size={22} /></span>
      )}
      {props.title === undefined ? null : <span className="lmv-empty-title">{props.title}</span>}
      {props.hint === undefined ? null : <span className="lmv-empty-hint">{props.hint}</span>}
      {props.action === undefined ? null : <span className="lmv-empty-action">{props.action}</span>}
    </div>
  )
}

/** A compact "number + caption" capsule for page headers. */
export function StatPill(props: { label: string; value: ReactNode; tone?: 'plain' | 'warn' | 'error' | 'ok' }): ReactElement {
  const tone = props.tone ?? 'plain'
  return (
    <span className={`lmv-pill${tone === 'plain' ? '' : ` lmv-pill-${tone}`}`}>
      <span className="lmv-pill-value">{props.value}</span>
      <span className="lmv-pill-label">{props.label}</span>
    </span>
  )
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
  /** Enter submits. Capture fields live or die by this: reaching for the
      mouse after typing is the friction Todoist spent a decade removing. */
  onEnter?: () => void
}): ReactElement {
  return (
    <input
      className={`lmv-input${props.block === true ? ' lmv-input-block' : ''}`}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled === true}
      aria-label={props.ariaLabel}
      onKeyDown={(event) => {
        if (props.onEnter !== undefined && event.key === 'Enter' && !event.shiftKey &&
            !event.nativeEvent.isComposing) {
          event.preventDefault()
          props.onEnter()
        }
      }}
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

/**
 * A disclosure indicator that rotates instead of swapping glyphs.
 *
 * Disney's "pose-to-pose" rule: the eye follows one continuous motion, so the
 * same chevron turns 90 degrees when its panel opens. Swapping a close icon
 * for a chevron reads as a jump, not a disclosure.
 */
export function DisclosureChevron(props: { open: boolean; size?: number }): ReactElement {
  return (
    <span className={`lmv-chev${props.open ? ' lmv-chev-open' : ''}`} aria-hidden="true">
      <Icon name="chevron" size={props.size ?? 12} />
    </span>
  )
}

/**
 * Expand/collapse with a height transition, no measuring and no JS.
 *
 * `grid-template-rows: 0fr → 1fr` animates any content height in modern
 * Chromium. Motion rules this obeys (Disney): slow-in/slow-out via the shared
 * ease, one thing moving at a time (the content slides, everything else stays
 * still), and the reduced-motion media query near-zeroes the transition so
 * open/close stays effectively instant for users who opt out.
 */
export function Collapse(props: {
  open: boolean
  children: ReactNode
}): ReactElement {
  return (
    <div className={`lmv-collapse${props.open ? ' lmv-collapse-open' : ''}`} aria-hidden={!props.open}>
      <div className="lmv-collapse-inner">{props.children}</div>
    </div>
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
