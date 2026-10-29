/**
 * Client↔host RPC over the DSH web server.
 *
 * DSH offers two client↔host channels: the generated, server-owned *typert*
 * remote namespace system, and a plugin's own routes on `ctx.webServer`. A
 * third-party plugin cannot add a typert namespace without editing
 * `@deepseek-ai/dsh-api-remotes`, so this plugin uses its own routes — the same
 * approach both installed reference plugins take.
 *
 * Security: the route is fenced like the reference implementation fences its own
 * API. The `Host` header must name a loopback or trusted authority, a
 * `cross-site` fetch is refused, and a present `Origin` must match the host (the
 * desktop shell's `dsh-app://app` origin is admitted explicitly). Without this,
 * any page the user visits could read and rewrite their memory vault.
 *
 * @module dsh-longterm-memory/host/dsh/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ERROR_CODES,
  ROUTE_PREFIX,
  type RpcMethod,
} from '../../shared/protocol.js'
import type { MemoryService } from '../core/service.js'
import { ServiceError, validateMergeRequest, validateSaveRequest, validateSettingsPatch } from '../core/service.js'

/** The desktop shell serves the GUI from this origin. */
const SHELL_APP_ORIGIN = 'dsh-app://app'

const MAX_BODY_BYTES = 8 * 1024 * 1024

/** The subset of the DSH web-server service this plugin uses. */
export interface WebServerLike {
  register: (route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => unknown
  }) => unknown
}

export interface WebRuntimeLike {
  trustedHosts?: readonly string[]
}

export interface RouteResult {
  installed: boolean
  note?: string
}

/**
 * Register the plugin's API route.
 *
 * @returns whether the route is live, plus the reason when it is not, so the
 *   management page can say exactly why it cannot reach the host.
 */
export function installRoutes(ctx: { get: (name: string) => unknown; effect: (fn: () => unknown, label?: string) => unknown; logger?: { warn: (message: string, ...rest: unknown[]) => void } }, service: MemoryService, prefix: string = ROUTE_PREFIX): RouteResult {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined || typeof webServer.register !== 'function') {
    return {
      installed: false,
      note: '宿主未提供 ctx.webServer（例如无界面或纯终端 profile），管理页面无法取得数据。宿主端功能仍然可用。',
    }
  }
  const webRuntime = ctx.get('webRuntime') as WebRuntimeLike | undefined
  const trustedHosts = Array.isArray(webRuntime?.trustedHosts) ? webRuntime.trustedHosts : []
  const fence = (request: IncomingMessage): boolean => isTrustedRequest(request, trustedHosts)

  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: prefix,
          handler: async (request, response) => {
            if (!fence(request)) {
              writeJson(response, 403, {
                ok: false,
                error: { code: ERROR_CODES.forbidden, message: '请求来源未通过信任校验，已拒绝。' },
              })
              return
            }
            if (request.method !== 'POST') {
              writeJson(response, 405, {
                ok: false,
                error: { code: ERROR_CODES.invalid, message: '仅支持 POST。' },
              })
              return
            }
            const method = extractMethod(request.url ?? '/', prefix)
            if (method === null) {
              writeJson(response, 404, {
                ok: false,
                error: { code: ERROR_CODES.notFound, message: '未知的接口方法。' },
              })
              return
            }
            let payload: unknown
            try {
              const body = await readBody(request)
              payload = body.length === 0 ? {} : (JSON.parse(body) as unknown)
            } catch (error) {
              writeJson(response, 400, {
                ok: false,
                error: { code: ERROR_CODES.invalid, message: `请求体不是合法 JSON：${describeError(error)}` },
              })
              return
            }
            try {
              const data = await dispatch(service, method, asRecord(payload))
              writeJson(response, 200, { ok: true, data })
            } catch (error) {
              const code = error instanceof ServiceError ? error.code : ERROR_CODES.internal
              const message = describeError(error)
              const status = code === ERROR_CODES.forbidden ? 403 : code === ERROR_CODES.notFound ? 404 : 200
              ctx.logger?.warn('dsh-longterm-memory: RPC %s failed: %s', method, message)
              writeJson(response, status, {
                ok: false,
                error: {
                  code,
                  message,
                  ...(error instanceof ServiceError && error.detail !== undefined ? { detail: error.detail } : {}),
                },
              })
            }
          },
        }),
      'dsh-longterm-memory: /api routes',
    )
    return { installed: true }
  } catch (error) {
    return { installed: false, note: `注册接口路由失败：${describeError(error)}` }
  }
}

/** Runtime shape gate for `addCandidate` (the service slices/uses these fields). */
function validateCandidatePayload(payload: Record<string, unknown>): void {
  if (typeof payload['title'] !== 'string' || payload['title'].trim().length === 0) {
    throw new ServiceError(ERROR_CODES.invalid, '候选标题必须是非空字符串。')
  }
  if (typeof payload['summary'] !== 'string') throw new ServiceError(ERROR_CODES.invalid, '候选正文必须是字符串。')
  if (payload['tags'] !== undefined && (!Array.isArray(payload['tags']) || payload['tags'].some((tag) => typeof tag !== 'string'))) {
    throw new ServiceError(ERROR_CODES.invalid, '候选标签必须是字符串数组。')
  }
  if (payload['importance'] !== undefined && !Number.isFinite(payload['importance'])) {
    throw new ServiceError(ERROR_CODES.invalid, '重要程度必须是数字。')
  }
}
/** Route one RPC method to the service. */
export async function dispatch(service: MemoryService, method: string, payload: Record<string, unknown>): Promise<unknown> {
  switch (method as RpcMethod) {
    case 'status':
      return service.status()
    case 'discover':
      return service.getDiscovery(true)
    case 'initialize':
      return service.initialize(optionalString(payload['path']))
    case 'chooseVault':
      return service.chooseVault(requireString(payload['path'], 'path'))
    case 'overview':
      return service.overview()
    case 'search':
      return service.search({
        ...(optionalString(payload['text']) === undefined ? {} : { text: optionalString(payload['text']) }),
        ...(isRecord(payload['filters']) ? { filters: payload['filters'] as never } : {}),
        ...(typeof payload['limit'] === 'number' ? { limit: payload['limit'] } : {}),
        ...(typeof payload['includeNonCurrent'] === 'boolean' ? { includeNonCurrent: payload['includeNonCurrent'] } : {}),
      })
    case 'get':
      return service.get(requireString(payload['id'], 'id'))
    case 'readRaw':
      return service.readRaw(requireString(payload['id'], 'id'))
    case 'writeRaw':
      return service.writeRaw(
        requireString(payload['id'], 'id'),
        requireString(payload['content'], 'content', true),
        requireString(payload['expectedChecksum'], 'expectedChecksum'),
      )
    case 'save':
      validateSaveRequest(payload as unknown as Parameters<typeof validateSaveRequest>[0])
      return service.save(payload as unknown as Parameters<MemoryService['save']>[0])
    case 'confirm':
      return service.confirm(requireString(payload['id'], 'id'), optionalString(payload['reason']) ?? '用户确认该记忆有效')
    case 'reject':
      return service.reject(
        requireString(payload['id'], 'id'),
        optionalString(payload['reason']) ?? '用户拒绝该候选记忆',
        payload['keepFile'] === true,
      )
    case 'setStatus':
      return service.setStatus(
        requireString(payload['id'], 'id'),
        requireString(payload['status'], 'status') as Parameters<MemoryService['setStatus']>[1],
        optionalString(payload['reason']),
      )
    case 'setPinned':
      return service.setPinned(requireString(payload['id'], 'id'), payload['pinned'] === true)
    case 'delete':
      if (payload['confirm'] !== true) {
        throw new ServiceError(ERROR_CODES.invalid, '删除需要二次确认；请求中未携带确认标记。')
      }
      return service.remove(requireString(payload['id'], 'id'), true)
    case 'merge':
      validateMergeRequest(payload as unknown as Parameters<typeof validateMergeRequest>[0])
      return service.merge(payload as unknown as Parameters<MemoryService['merge']>[0])
    case 'resolveConflict':
      return service.resolveConflict(
        requireString(payload['id'], 'id'),
        (optionalString(payload['strategy']) ?? 'keep') as 'keep' | 'merge' | 'both',
        Array.isArray(payload['otherIds']) ? payload['otherIds'].filter((value): value is string => typeof value === 'string') : [],
        optionalString(payload['reason']),
      )
    case 'rebuildIndex':
      return service.rebuildIndex()
    case 'syncIndex':
      return service.syncIndex()
    case 'history':
      return { entries: await service.history(optionalString(payload['id']), typeof payload['limit'] === 'number' ? payload['limit'] : 100) }
    case 'candidates':
      return { candidates: service.listCandidates() }
    case 'addCandidate':
      validateCandidatePayload(payload)
      return service.addCandidate(payload as unknown as Parameters<MemoryService['addCandidate']>[0])
    case 'openVault':
      return service.openVault(optionalString(payload['target']))
    case 'getSettings':
      return service.getSettings()
    case 'setSettings':
      validateSettingsPatch(payload as unknown as Parameters<typeof validateSettingsPatch>[0])
      return service.setSettings(payload as unknown as Parameters<MemoryService['setSettings']>[0])
    case 'previewRecall':
      return service.previewRecall(optionalString(payload['query']) ?? '', typeof payload['limit'] === 'number' ? payload['limit'] : undefined)
    case 'previewStanding':
      return service.previewStandingSection()
    case 'qqLinkage':
      return service.qqLinkageReport()
    case 'setQqLinkage':
      return service.setQqLinkage(asRecord(payload['config']) as Parameters<MemoryService['setQqLinkage']>[0])
    default:
      throw new ServiceError(ERROR_CODES.notFound, `未知的接口方法：${method}`)
  }
}

/* ------------------------------------------------------------- trust fence */

function isTrustedRequest(request: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = header(request, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false

  if (header(request, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request, 'origin')
  if (origin === undefined) return true
  if (origin === SHELL_APP_ORIGIN) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const entryPort = entryUrl.port
    return entryPort === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/* ----------------------------------------------------------------- helpers */

function extractMethod(url: string, prefix: string): string | null {
  let pathname: string
  try {
    pathname = new URL(url, 'http://dsh.internal').pathname
  } catch {
    return null
  }
  if (!pathname.startsWith(`${prefix}/`)) return null
  const method = pathname.slice(prefix.length + 1)
  if (method.length === 0 || method.includes('/')) return null
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(method)) return null
  return method
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new ServiceError(ERROR_CODES.invalid, `请求体过大（上限 ${String(MAX_BODY_BYTES)} 字节）。`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function isRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new ServiceError(ERROR_CODES.invalid, `字段 ${field} 必须是字符串。`)
  if (!allowEmpty && value.trim().length === 0) throw new ServiceError(ERROR_CODES.invalid, `字段 ${field} 不能为空。`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
