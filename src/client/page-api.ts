/**
 * The small surface the page hands down to its views.
 *
 * It lives in its own module so views never import `memory-page.tsx` (which
 * would create a cycle) and so a view can be rendered in isolation in a test.
 *
 * @module dsh-longterm-memory/client/page-api
 */

import { createContext, useContext } from 'react'

/** How a toast is coloured. */
export type ToastKind = 'info' | 'ok' | 'error'

/** What `MemoryPage` provides to every view. */
export interface PageApi {
  /** Show a transient message. */
  toast: (message: string, kind?: ToastKind) => void
  /** Switch the body to the detail view for `id`. */
  openMemory: (id: string) => void
  /** Jump to Search with `tag` pre-filled as the tag filter. */
  searchTag: (tag: string) => void
  /** Re-read the `status` RPC (vault stats, index state, settings). */
  refreshStatus: () => void
  /** Ids currently ticked for bulk actions and merging. */
  selection: readonly string[]
  /** Tick or untick one memory id. */
  toggleSelect: (id: string) => void
  /** Drop the whole selection. */
  clearSelection: () => void
}

const FALLBACK: PageApi = {
  toast: () => undefined,
  openMemory: () => undefined,
  searchTag: () => undefined,
  refreshStatus: () => undefined,
  selection: [],
  toggleSelect: () => undefined,
  clearSelection: () => undefined,
}

/** Context carrying the {@link PageApi}. */
export const PageContext = createContext<PageApi>(FALLBACK)

/** Read the page API. Returns a no-op API outside the page. */
export function usePage(): PageApi {
  return useContext(PageContext)
}
