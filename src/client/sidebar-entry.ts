/**
 * The first-level left-sidebar entry: its stable id and its icon.
 *
 * The id is load-bearing. `sidebar.panellist` renders one button per list entry
 * and calls `layout.selectPanel(id)` on click, while the center column renders
 * the `main` slot keyed by the active panel id. Registering the same string as
 * this entry's `id` and as the `main` entry's `key` is the whole wiring.
 *
 * @module dsh-longterm-memory/client/sidebar-entry
 */

import { createElement } from 'react'
import type { ReactElement } from 'react'

/** Panel id; equals the `main` slot key and the sidebar entry id. */
export const PANEL_ID = 'longterm-memory'

/** Props the sidebar passes to a panellist icon. */
export interface PanelIconProps {
  /** Icon edge length in pixels, chosen by the sidebar (16 wide, 18 narrow). */
  size?: number
  /** Whether this panel is the active one. */
  active?: boolean
}

/**
 * The sidebar icon: a bookmark with two text lines, drawn inline so it follows
 * the theme through `currentColor` and needs no icon package.
 */
export function MemoryPanelIcon(props: PanelIconProps): ReactElement {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
  const strokeWidth = props.active === true ? 1.7 : 1.4
  return createElement(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: size,
      height: size,
      'aria-hidden': true,
      focusable: 'false',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { display: 'block' },
    },
    createElement('path', { d: 'M3.75 2.5h8.5v11l-4.25-2.5-4.25 2.5z' }),
    createElement('path', { d: 'M6.1 5.6h3.8M6.1 7.9h2.4' }),
  )
}
