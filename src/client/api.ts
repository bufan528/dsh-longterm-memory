/**
 * The Host RPC client plus the tiny async-state helpers every view uses.
 *
 * The Host half serves this plugin's own routes under {@link ROUTE_PREFIX}; one
 * route per {@link RpcMethod}, one JSON envelope per response, exactly as
 * `src/shared/protocol.ts` freezes it. There is no `ctx.remote` namespace for a
 * third-party plugin, so plain `fetch` is the only channel.
 *
 * @module dsh-longterm-memory/client/api
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { ERROR_CODES, ROUTE_PREFIX } from '../shared/protocol.js'
import type { RpcMethod, RpcRequestMap, RpcResultMap } from '../shared/protocol.js'
import { t } from './i18n.js'

/** A failure raised by {@link call}, carrying the wire error code. */
export class ApiError extends Error {
  /** Machine-readable code, either a host {@link ERROR_CODES} value or `internal`. */
  readonly code: string
  /** Optional extra detail the host supplied. */
  readonly detail?: string

  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

/** Narrow a dotted-path error code out of an `unknown` value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/**
 * Call one Host RPC method.
 *
 * @param method - the RPC method name.
 * @param payload - its request payload; use `{}` for methods that take none.
 * @returns the unwrapped result on `{ ok: true }`.
 * @throws {ApiError} with the host's `code` on `{ ok: false }`, and with
 * `ERROR_CODES.internal` when the request never produced a parseable envelope.
 */
export async function call<M extends RpcMethod>(method: M, payload: RpcRequestMap[M]): Promise<RpcResultMap[M]> {
  let response: Response
  try {
    response = await fetch(`${ROUTE_PREFIX}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload ?? {}),
    })
  } catch (error) {
    throw new ApiError(ERROR_CODES.internal, `${t('common.error')}: ${method} — ${messageOf(error)}`)
  }

  let envelope: unknown
  try {
    envelope = await response.json()
  } catch (error) {
    throw new ApiError(
      ERROR_CODES.internal,
      `${t('common.error')}: ${method} — HTTP ${String(response.status)} ${messageOf(error)}`,
    )
  }

  if (typeof envelope !== 'object' || envelope === null) {
    throw new ApiError(ERROR_CODES.internal, `${t('common.error')}: ${method} — malformed envelope`)
  }
  const shaped = envelope as {
    ok?: unknown
    data?: unknown
    error?: { code?: unknown; message?: unknown; detail?: unknown }
  }
  if (shaped.ok === true) {
    return shaped.data as RpcResultMap[M]
  }
  const failure = shaped.error
  const code = typeof failure?.code === 'string' ? failure.code : ERROR_CODES.internal
  const message = typeof failure?.message === 'string' ? failure.message : `${t('common.error')}: ${method}`
  const detail = typeof failure?.detail === 'string' ? failure.detail : undefined
  throw new ApiError(code, message, detail)
}

/** The wire code of `error`, or `internal` when it did not come from {@link call}. */
export function errCode(error: unknown): string {
  if (error instanceof ApiError) return error.code
  return ERROR_CODES.internal
}

/** A short human sentence for `error`, always non-empty. */
export function errMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  const message = messageOf(error)
  return message.length > 0 ? message : t('error.unknown')
}

/** A localized sentence for a known code, falling back to the host's message. */
export function friendlyError(error: unknown): string {
  const code = errCode(error)
  if (code === ERROR_CODES.notInitialized) return t('error.vaultNotInitialized')
  if (code === ERROR_CODES.needsChoice) return t('error.needsChoice')
  if (code === ERROR_CODES.busy) return t('error.busy')
  if (code === ERROR_CODES.notFound) return t('error.notFound')
  if (code === ERROR_CODES.conflict) return t('error.conflict')
  return errMessage(error)
}

/** What {@link useAsync} tracks. */
export interface AsyncState<T> {
  loading: boolean
  error: unknown
  data: T | null
  /** Re-run the loader. */
  reload: () => void
}

/**
 * Run `loader` on mount and whenever `deps` change.
 *
 * Stale responses are dropped, so a fast retry can never overwrite a newer
 * result. Pass `enabled: false` to hold the query (used while a view is
 * inactive or the vault is not initialized yet).
 *
 * @param loader - the async work to perform.
 * @param deps - dependency list; the query re-runs when it changes.
 * @param enabled - set to `false` to skip the query entirely.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[], enabled = true): AsyncState<T> {
  const [state, setState] = useState<{ loading: boolean; error: unknown; data: T | null }>({
    loading: enabled,
    error: null,
    data: null,
  })
  const [nonce, setNonce] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, error: null, data: null })
      return
    }
    let cancelled = false
    setState((previous) => ({ loading: true, error: null, data: previous.data }))
    loaderRef.current().then(
      (data) => {
        if (!cancelled) setState({ loading: false, error: null, data })
      },
      (error: unknown) => {
        if (!cancelled) setState({ loading: false, error, data: null })
      },
    )
    return () => {
      cancelled = true
    }
    // The caller owns the dependency list; `deps` is spread by design.
  }, [...deps, nonce, enabled])

  const reload = useCallback(() => {
    setNonce((value) => value + 1)
  }, [])

  return { loading: state.loading, error: state.error, data: state.data, reload }
}

/** What {@link useMutation} tracks. */
export interface MutationState {
  busy: boolean
  error: unknown
  /** Clear the last error. */
  reset: () => void
}

/**
 * Wrap a write operation so a view can disable its controls while it runs.
 *
 * @param action - the async write.
 * @returns `{ run, busy, error, reset }`; `run` rethrows so the caller can
 * branch on {@link errCode} (for example on `write-conflict`).
 */
export function useMutation<A extends unknown[], R>(
  action: (...args: A) => Promise<R>,
): MutationState & { run: (...args: A) => Promise<R | undefined> } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const actionRef = useRef(action)
  actionRef.current = action
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setBusy(true)
    setError(null)
    try {
      const result = await actionRef.current(...args)
      return result
    } catch (caught: unknown) {
      if (mounted.current) setError(caught)
      throw caught
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])

  const reset = useCallback(() => {
    setError(null)
  }, [])

  return { run, busy, error, reset }
}

/**
 * Debounce a value (used by the search box, ~250 ms).
 *
 * @param value - the fast-changing value.
 * @param delayMs - the quiet period.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebounced(value)
    }, delayMs)
    return () => {
      window.clearTimeout(handle)
    }
  }, [value, delayMs])
  return debounced
}
