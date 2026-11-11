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

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import type { MemoryVisibility } from '../../shared/types.js'
import type {
  CompanionWire, ReminderWire, StickerWire,
} from '../../shared/protocol.js'
import type { CompanionDocuments } from '../companion/documents.js'
import type { CompanionService } from '../companion/service.js'
import { buildVoicePreview, normalizeUtterance, sanitizeReply } from '../companion/try-voice.js'
import { createDshLlmAdapter } from './llm.js'
import type { DshLlmAdapter } from './llm.js'

/**
 * Sticker size accepted over RPC. Deliberately below the QQ plugin's own 8 MiB
 * cap so one import still fits inside the shared request-body ceiling; a chat
 * sticker has no business being larger.
 */
const MAX_STICKER_BYTES = 5 * 1024 * 1024
/** Base64 of 5 MiB (6 990 508 chars), refused before decoding. */
const MAX_STICKER_BASE64 = 7_000_000

/**
 * Largest file the page will pull back for a thumbnail.
 *
 * A preview only has to be recognisable in a 132px tile; inlining a 4 MiB GIF
 * as base64 would cost far more than it shows. Oversized files fall back to a
 * placeholder and are unaffected for sending.
 */
const MAX_THUMB_BYTES = 640 * 1024
/** Bounded cache: ids are content hashes, so an entry can never go stale. */
const THUMB_CACHE_LIMIT = 240
const THUMB_CACHE = new Map<string, string>()
const THUMB_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

function optionalStrings(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : undefined
}

/** Unlike `optionalString`, an explicit empty string is a real value (clear it). */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Example exchanges.
 *
 * A present-but-empty array clears them; a malformed entry is dropped rather
 * than failing the whole save, because the UI builds these from two text
 * fields and a half-typed row should not block the rest of the persona.
 */
function optionalExamples(value: unknown): { user: string; assistant: string }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: { user: string; assistant: string }[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const user = typeof row['user'] === 'string' ? row['user'] : ''
    const assistant = typeof row['assistant'] === 'string' ? row['assistant'] : ''
    // Half-typed rows are dropped instead of failing the save: the page writes
    // the whole persona at once, and a blank second box must not block it.
    if (user.trim() === '' || assistant.trim() === '') continue
    out.push({ user, assistant })
  }
  return out
}

function companionWire(companion: CompanionService, docs: CompanionDocuments): CompanionWire {
  const status = companion.status()
  return {
    available: status.available,
    usingDefault: status.usingDefault,
    problems: status.problems,
    revision: status.revision,
    documents: {
      name: docs.persona.name,
      identity: docs.persona.identity,
      temperament: docs.persona.temperament,
      address: docs.persona.address,
      languageHabits: docs.persona.languageHabits,
      boundaries: [...docs.persona.boundaries],
      scenario: docs.persona.scenario,
      catchphrases: [...docs.persona.catchphrases],
      avoid: [...docs.persona.avoid],
      examples: docs.persona.examples.map((example) => ({ ...example })),
      tone: docs.style.tone,
      notes: docs.style.notes,
      quietTriggers: [...docs.policy.quietTriggers],
      stopTriggers: [...docs.policy.stopTriggers],
    },
  }
}
import {
  ERROR_CODES,
  ROUTE_PREFIX,
  type OwnerBindingStatusWire,
  type OwnerPairCodeWire,
  type RpcMethod,
} from '../../shared/protocol.js'
import type { MemoryService } from '../core/service.js'
import { ServiceError, validateMergeRequest, validateSaveRequest, validateSettingsPatch } from '../core/service.js'

/** qqbotContext@v1 的最小消费面（与 dsh-qqbot-merge identity contract 对齐）。 */
export interface QqbotContextLike {
  contract?: { name?: string; version?: number }
  createPairCode(now?: Date): { code: string; expiresAt: string; ttlMs: number }
  getStatus(): {
    bound: boolean
    ownerId: string | null
    qq: { platform: string; appIdMasked: string; openidMasked: string; boundAt: string } | null
  }
  unbind(): { bound: boolean; ownerId: string | null; qq: unknown }
}

function ownerStatusFrom(service: QqbotContextLike | undefined): OwnerBindingStatusWire {
  if (!service || typeof service.getStatus !== 'function') {
    return { available: false, bound: false, ownerId: null, qq: null }
  }
  const status = service.getStatus()
  return {
    available: true,
    bound: status.bound,
    ownerId: status.ownerId,
    qq: status.qq,
  }
}

/**
 * `life-agent@v1` 的最小消费面（design §九.C）。
 *
 * 刻意只用结构化类型、不 import QQ 插件：两个插件之间不允许静态依赖，加载顺序
 * 也不能决定可用性。所有字段都当 `unknown` 校验，插件返回什么形状都不能直接
 * 透传给页面。
 */
export interface LifeAgentLike {
  contract?: unknown
  enabled?: unknown
  management?: {
    stickers?: {
      rootDir?: unknown
      droppedCount?: unknown
      list: () => unknown
      setEnabled: (id: string, enabled: boolean) => Promise<unknown>
      setFavorite: (id: string, favorite: boolean) => Promise<unknown>
      remove: (id: string) => Promise<unknown>
      importBytes?: (
        bytes: Uint8Array,
        fileName: string,
        input: { description?: string; tags?: string[] },
      ) => Promise<unknown>
    } | null
    reminders?: {
      list: () => Promise<unknown>
      create: (input: {
        title: string
        note?: string
        dueAt: string
        repeat?: { unit: 'day' | 'week' | 'month'; interval: number } | null
      }) => Promise<unknown>
      cancel: (id: string) => Promise<unknown>
      complete: (id: string) => Promise<unknown>
      reschedule: (id: string, dueAt: string) => Promise<unknown>
      queueSize?: unknown
      deliveryStatus?: unknown
    } | null
    /** Where the reminder rows actually live. */
    storeKind?: unknown
  } | null
}

/**
 * The sticker surface both owners implement: the Vault store
 * (`sticker-library@v1`) and the QQ plugin's `life-agent@v1` bridge. Structural
 * typing only — no static import across plugin boundaries (design §九.C).
 */
export interface StickerLibraryLike {
  rootDir: string | null
  droppedCount?: number
  load?: () => Promise<unknown>
  refresh?: () => Promise<unknown>
  list: () => unknown
  /** Optional: only the vault-owned store can resolve one record by id. */
  get?: (id: string) => unknown
  setEnabled: (id: string, enabled: boolean) => Promise<unknown>
  setFavorite: (id: string, favorite: boolean) => Promise<unknown>
  /** Optional: rewriting description/tags needs the row itself, not just its flags. */
  setMeta?: (id: string, input: { description?: string; tags?: string[] }) => Promise<unknown>
  remove: (id: string) => Promise<unknown>
  importBytes?: (
    bytes: Uint8Array,
    fileName: string,
    input: { description?: string; tags?: string[] },
  ) => Promise<unknown>
}

/** Same shape for reminders: Vault `reminder-service@v1` or the plugin runtime. */
export interface ReminderServiceLike {
  available?: boolean
  list: () => Promise<unknown>
  create: (input: {
    title: string
    note?: string
    dueAt: string
    repeat?: { unit: 'day' | 'week' | 'month'; interval: number } | null
  }) => Promise<unknown>
  cancel: (id: string) => Promise<unknown>
  complete: (id: string) => Promise<unknown>
  reschedule: (id: string, dueAt: string) => Promise<unknown>
  queueSize?: unknown
  deliveryStatus?: unknown
}

/** Why the management bridge is not usable, in words the page can show. */
function lifeAgentReason(life: LifeAgentLike | undefined, what: 'stickers' | 'reminders'): string | null {
  if (life === undefined || life === null) {
    return '未发现 life-agent@v1：请确认 dsh-qqbot-merge 插件已加载，且其配置中 profile 目录可解析。'
  }
  if (life.management === undefined || life.management === null) {
    return 'life-agent@v1 已加载，但该版本未暴露管理接口（需要 dsh-qqbot-merge ≥ 本版本）。'
  }
  const surface = what === 'stickers' ? life.management.stickers : life.management.reminders
  if (surface === undefined || surface === null) {
    return what === 'stickers'
      ? 'QQ 插件未建立表情图库（缺少可写的 profile 目录）。'
      : 'QQ 插件未建立提醒存储（缺少可写的 profile 目录）。'
  }
  return null
}

function toStickerWire(raw: unknown): StickerWire | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = r['id']
  const file = r['file']
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null
  // A basename only: the management page must never receive a path.
  if (typeof file !== 'string' || file.length === 0 || /[/\\]/.test(file) || file.includes('..')) return null
  return {
    id,
    file,
    description: typeof r['description'] === 'string' ? r['description'].slice(0, 200) : '',
    tags: Array.isArray(r['tags'])
      ? r['tags'].filter((t): t is string => typeof t === 'string').slice(0, 12)
      : [],
    enabled: r['enabled'] === true,
    favorite: r['favorite'] === true,
    usedCount: typeof r['usedCount'] === 'number' && Number.isFinite(r['usedCount']) ? r['usedCount'] : 0,
    bytes: typeof r['bytes'] === 'number' && Number.isFinite(r['bytes']) ? r['bytes'] : 0,
    addedAt: typeof r['addedAt'] === 'string' ? r['addedAt'] : '',
  }
}

const REMINDER_STATUSES = ['pending', 'done', 'cancelled'] as const
const REMINDER_DELIVERY = ['waiting', 'deferred', 'delivered'] as const
const REPEAT_UNITS = ['day', 'week', 'month'] as const

function toReminderWire(raw: unknown): ReminderWire | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = r['id']
  const title = r['title']
  const status = r['status']
  const delivery = r['delivery']
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) return null
  if (typeof status !== 'string' || !(REMINDER_STATUSES as readonly string[]).includes(status)) return null
  if (typeof delivery !== 'string' || !(REMINDER_DELIVERY as readonly string[]).includes(delivery)) return null
  const dueAt = r['dueAt']
  if (typeof dueAt !== 'string' || Number.isNaN(Date.parse(dueAt))) return null
  const repeatRaw = r['repeat']
  let repeat: ReminderWire['repeat'] = null
  if (repeatRaw !== null && typeof repeatRaw === 'object') {
    const rep = repeatRaw as Record<string, unknown>
    const unit = rep['unit']
    const interval = rep['interval']
    if (typeof unit === 'string' && (REPEAT_UNITS as readonly string[]).includes(unit)
      && typeof interval === 'number' && Number.isInteger(interval) && interval >= 1 && interval <= 365) {
      repeat = { unit: unit as 'day' | 'week' | 'month', interval }
    }
  }
  return {
    id,
    title,
    note: typeof r['note'] === 'string' ? r['note'].slice(0, 1000) : '',
    dueAt,
    status: status as ReminderWire['status'],
    repeat,
    delivery: delivery as ReminderWire['delivery'],
    createdAt: typeof r['createdAt'] === 'string' ? r['createdAt'] : '',
    updatedAt: typeof r['updatedAt'] === 'string' ? r['updatedAt'] : '',
    attempts: typeof r['attempts'] === 'number' && Number.isFinite(r['attempts']) ? r['attempts'] : 0,
    lastAttemptAt: typeof r['lastAttemptAt'] === 'string' ? r['lastAttemptAt'] : null,
  }
}

function normalizeDeliveryStatus(raw: unknown): { windowOpen: boolean; remainingReplies: number } | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const remaining = r['remainingReplies']
  return {
    windowOpen: r['windowOpen'] === true,
    remainingReplies: typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : 0,
  }
}

/**
 * Flatten the plugin's `ImportOutcome` union into one wire shape. An unexpected
 * shape becomes a refusal, never a silent success.
 */
function normalizeImportOutcome(raw: unknown): {
  id: string | null; duplicate: boolean; reason: string | null; item: StickerWire | null
} {
  if (raw === null || typeof raw !== 'object') {
    return { id: null, duplicate: false, reason: '导入结果无法识别。', item: null }
  }
  const r = raw as Record<string, unknown>
  if (r['ok'] !== true) {
    return {
      id: null,
      duplicate: false,
      reason: typeof r['reason'] === 'string' ? r['reason'] : '导入被拒绝。',
      item: null,
    }
  }
  const item = toStickerWire(r['record'])
  if (item === null) return { id: null, duplicate: false, reason: '导入返回的记录结构无法校验。', item: null }
  return { id: item.id, duplicate: r['duplicate'] === true, reason: null, item }
}


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
export function installRoutes(
  ctx: {
    get: (name: string) => unknown
    effect: (fn: () => unknown, label?: string) => unknown
    logger?: { warn: (message: string, ...rest: unknown[]) => void }
  },
  service: MemoryService,
  prefix: string = ROUTE_PREFIX,
  companion?: CompanionService,
): RouteResult {
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
  const getQqContext = (): QqbotContextLike | undefined => {
    try {
      return ctx.get('qqbotContext') as QqbotContextLike | undefined
    } catch {
      return undefined
    }
  }
  // Resolved per request, never at install time: the QQ plugin may load after
  // this one, and a Host restart must not require re-installing the route.
  const getLifeAgent = (): LifeAgentLike | undefined => {
    try {
      return ctx.get('lifeAgent') as LifeAgentLike | undefined
    } catch {
      return undefined
    }
  }
  // Vault-owned stores, resolved per request like the QQ bridge. They are the
  // primary source for the PC page: the page must work on an install where the
  // QQ plugin is absent, and the plugin reads the same files when it is present.
  const getStickerLibrary = (): StickerLibraryLike | undefined => {
    try {
      return ctx.get('stickerLibrary') as StickerLibraryLike | undefined
    } catch {
      return undefined
    }
  }
  const getReminderService = (): ReminderServiceLike | undefined => {
    try {
      return ctx.get('reminderService') as ReminderServiceLike | undefined
    } catch {
      return undefined
    }
  }

  /*
   * The persona preview gets its own adapter, created on first use.
   *
   * Deliberately not shared with extraction: extraction is gated by a settings
   * toggle the user turned on, while the preview is an explicit button. Sharing
   * one instance would make the preview unavailable whenever extraction happens
   * to be off, which is the common case.
   */
  let voiceAdapter: DshLlmAdapter | undefined
  const getVoiceAdapter = async (): Promise<DshLlmAdapter> => {
    if (voiceAdapter === undefined) {
      voiceAdapter = createDshLlmAdapter(ctx, { timeoutMs: 45_000, maxOutputTokens: 500 })
    }
    await voiceAdapter.init()
    return voiceAdapter
  }

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
              const data = await dispatch(
                service, method, asRecord(payload), getQqContext, companion, getLifeAgent,
                getStickerLibrary, getReminderService, getVoiceAdapter,
              )
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
export async function dispatch(
  service: MemoryService,
  method: string,
  payload: Record<string, unknown>,
  getQqContext?: () => QqbotContextLike | undefined,
  companion?: CompanionService,
  getLifeAgent?: () => LifeAgentLike | undefined,
  getStickerLibrary?: () => StickerLibraryLike | undefined,
  getReminderService?: () => ReminderServiceLike | undefined,
  /**
   * Lazy model adapter for the persona preview.
   *
   * Passed as a thunk, not an instance: the route must stay installable in a
   * test or a headless profile where `ctx.llm` does not exist, and the adapter
   * must only be constructed when someone actually presses the button.
   */
  getVoiceAdapter?: () => Promise<DshLlmAdapter>,
): Promise<unknown> {
  /** Vault library first, QQ plugin bridge second. */
  const resolveStickers = (): { surface: StickerLibraryLike; source: 'vault' | 'plugin' } | { reason: string } => {
    const local = getStickerLibrary?.()
    if (local !== undefined && local !== null && typeof local.list === 'function') {
      if (local.rootDir === null || local.rootDir === undefined) {
        return { reason: '记忆库尚未就绪，表情图库暂时不可用。' }
      }
      return { surface: local, source: 'vault' }
    }
    const life = getLifeAgent?.()
    const stickers = life?.management?.stickers
    if (stickers !== undefined && stickers !== null) {
      // The bridge is structurally compatible; its fields are typed `unknown`
      // because nothing may be trusted from another plugin's object.
      return { surface: stickers as unknown as StickerLibraryLike, source: 'plugin' }
    }
    return { reason: lifeAgentReason(life, 'stickers') ?? '表情图库不可用。' }
  }

  /** Same idea for reminders: Vault service first, plugin runtime as fallback. */
  const resolveReminders = (): { surface: ReminderServiceLike; source: 'vault' | 'plugin' } | { reason: string } => {
    const local = getReminderService?.()
    if (local !== undefined && local !== null && typeof local.list === 'function') {
      if (local.available !== true) return { reason: '记忆库尚未就绪，提醒暂时不可用。' }
      return { surface: local, source: 'vault' }
    }
    const life = getLifeAgent?.()
    const reminders = life?.management?.reminders
    if (reminders !== undefined && reminders !== null) return { surface: reminders, source: 'plugin' }
    return { reason: lifeAgentReason(life, 'reminders') ?? '提醒存储不可用。' }
  }

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
      // `shared` is only reachable through an explicit review decision from the
      // management UI. MemoryService.confirm validates the enum and keeps the
      // candidate's conservative scope when it is omitted.
      return service.confirm(
        requireString(payload['id'], 'id'),
        optionalString(payload['reason']) ?? '用户确认该记忆有效',
        optionalString(payload['visibility']) as MemoryVisibility | undefined,
      )
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
    case 'ownerBindingStatus':
      return ownerStatusFrom(getQqContext?.())
    case 'ownerBindingCreatePairCode': {
      const qq = getQqContext?.()
      if (!qq || typeof qq.createPairCode !== 'function') {
        const result: OwnerPairCodeWire = {
          available: false,
          code: null,
          expiresAt: null,
          ttlMs: 0,
          error: 'qqbotContext 服务不可用：请确认 dsh-qqbot-merge 插件已加载。',
        }
        return result
      }
      try {
        const issued = qq.createPairCode()
        const result: OwnerPairCodeWire = {
          available: true,
          code: issued.code,
          expiresAt: issued.expiresAt,
          ttlMs: issued.ttlMs,
        }
        return result
      } catch (error) {
        const result: OwnerPairCodeWire = {
          available: true,
          code: null,
          expiresAt: null,
          ttlMs: 0,
          error: describeError(error),
        }
        return result
      }
    }
    case 'ownerBindingUnbind': {
      const qq = getQqContext?.()
      if (!qq || typeof qq.unbind !== 'function') {
        return ownerStatusFrom(undefined)
      }
      const after = qq.unbind() as OwnerBindingStatusWire & { persisted?: boolean }
      if (after && after.persisted === false) {
        throw new ServiceError(ERROR_CODES.internal, '解绑未能写入配置，绑定关系未更改。')
      }
      return ownerStatusFrom(qq)
    }
    case 'visibilityReview':
      return service.visibilityReview()
    case 'setVisibility':
      // Single id only. There is intentionally no bulk endpoint: the migration
      // wizard must confirm every historical memory one at a time (§六).
      return service.setVisibility(
        requireString(payload['id'], 'id'),
        payload['visibility'] as MemoryVisibility,
        optionalString(payload['reason']) ?? undefined,
      )
    case 'companionStatus':
      if (companion === undefined) return null
      return companionWire(companion, await companion.load())
    case 'updateCompanion': {
      if (companion === undefined) {
        throw new ServiceError(ERROR_CODES.internal, 'Companion 服务不可用，无法保存人格配置。')
      }
      const docs = await companion.update({
        ...(optionalString(payload['name']) === undefined ? {} : { name: optionalString(payload['name']) }),
        ...(optionalString(payload['identity']) === undefined ? {} : { identity: optionalString(payload['identity']) }),
        ...(optionalString(payload['temperament']) === undefined ? {} : { temperament: optionalString(payload['temperament']) }),
        ...(optionalString(payload['address']) === undefined ? {} : { address: optionalString(payload['address']) }),
        ...(optionalString(payload['languageHabits']) === undefined ? {} : { languageHabits: optionalString(payload['languageHabits']) }),
        ...(optionalStrings(payload['boundaries']) === undefined ? {} : { boundaries: optionalStrings(payload['boundaries']) }),
        ...(optionalText(payload['scenario']) === undefined ? {} : { scenario: optionalText(payload['scenario']) }),
        ...(optionalStrings(payload['catchphrases']) === undefined ? {} : { catchphrases: optionalStrings(payload['catchphrases']) }),
        ...(optionalStrings(payload['avoid']) === undefined ? {} : { avoid: optionalStrings(payload['avoid']) }),
        ...(optionalExamples(payload['examples']) === undefined ? {} : { examples: optionalExamples(payload['examples']) }),
        ...(optionalString(payload['tone']) === undefined ? {} : { tone: optionalString(payload['tone']) }),
        ...(optionalString(payload['notes']) === undefined ? {} : { notes: optionalString(payload['notes']) }),
        ...(optionalStrings(payload['quietTriggers']) === undefined ? {} : { quietTriggers: optionalStrings(payload['quietTriggers']) }),
        ...(optionalStrings(payload['stopTriggers']) === undefined ? {} : { stopTriggers: optionalStrings(payload['stopTriggers']) }),
      })
      return companionWire(companion, docs)
    }
    case 'companionPresets': {
      if (companion === undefined) return { available: false, items: [] }
      return { available: true, items: companion.presets() }
    }
    case 'companionApplyPreset': {
      if (companion === undefined) {
        throw new ServiceError(ERROR_CODES.internal, 'Companion 服务不可用，无法套用预设人格。')
      }
      const presetId = requireString(payload['presetId'], 'presetId')
      if (companion.presets().every((preset) => preset.id !== presetId)) {
        throw new ServiceError(ERROR_CODES.invalid, `未知的预设人格：${presetId}`)
      }
      return companionWire(companion, await companion.applyPreset(presetId))
    }
    case 'companionFillAnchors': {
      if (companion === undefined) {
        throw new ServiceError(ERROR_CODES.internal, 'Companion 服务不可用，无法补齐示例对话。')
      }
      const presetId = requireString(payload['presetId'], 'presetId')
      if (companion.presets().every((preset) => preset.id !== presetId)) {
        throw new ServiceError(ERROR_CODES.invalid, `未知的预设人格：${presetId}`)
      }
      return companionWire(companion, await companion.fillAnchors(presetId))
    }
    case 'personaTry': {
      if (companion === undefined) {
        throw new ServiceError(ERROR_CODES.internal, 'Companion 服务不可用，无法预览人格。')
      }
      const utterance = normalizeUtterance(payload['text'])
      if (utterance.length === 0) {
        throw new ServiceError(ERROR_CODES.invalid, '请先写一句要对它说的话。')
      }
      // Read from the saved documents, not from anything the request carries:
      // a preview must describe the persona that QQ would actually use.
      const docs = await companion.load()
      const preview = buildVoicePreview(docs)
      const base = {
        provider: null as string | null,
        model: null as string | null,
        systemPrompt: preview.systemPrompt,
        utterance,
        droppedLayers: preview.projection.dropped,
      }
      const adapter = getVoiceAdapter === undefined ? undefined : await getVoiceAdapter()
      if (adapter === undefined) {
        return { ...base, available: false, reason: '当前宿主没有接线模型访问，无法预览人格。', reply: null }
      }
      if (!adapter.available) {
        return { ...base, available: false, reason: adapter.reason ?? '模型访问不可用', reply: null }
      }
      const controller = new AbortController()
      try {
        const answer = await adapter.completeText(
          { system: preview.systemPrompt, user: utterance, maxOutputTokens: 400 },
          controller.signal,
        )
        const reply = sanitizeReply(answer.text)
        return {
          ...base,
          available: true,
          reason: reply.length === 0 ? '模型返回了空内容。' : null,
          reply: reply.length === 0 ? null : reply,
          provider: answer.provider,
          model: answer.model,
        }
      } catch (error) {
        // A provider failure is not a plugin failure: report it beside the
        // preview instead of turning the whole page into an error state.
        return {
          ...base,
          available: true,
          reason: error instanceof Error ? error.message : String(error),
          reply: null,
        }
      }
    }
    /* ----------------------- WP-6 cross-plugin management (life-agent@v1) --- */
    case 'stickerLibrary': {
      const resolved = resolveStickers()
      if ('reason' in resolved) {
        return { available: false, reason: resolved.reason, storagePath: null, total: 0, enabledCount: 0, rejected: 0, items: [] }
      }
      const catalog = resolved.surface
      // A fresh read on every page load: the QQ plugin may have imported while
      // this cache was cold, and the reverse is equally true.
      if (typeof catalog.load === 'function') await catalog.load().catch(() => undefined)
      const raw = catalog.list()
      const rows: unknown[] = Array.isArray(raw) ? raw : []
      const items: StickerWire[] = []
      for (const row of rows) {
        const wire = toStickerWire(row)
        if (wire !== null) items.push(wire)
      }
      // Newest first: the page shows what was just imported at the top.
      items.sort((a, b) => (a.addedAt === b.addedAt ? a.id.localeCompare(b.id) : a.addedAt < b.addedAt ? 1 : -1))
      return {
        available: true,
        reason: null,
        storagePath: typeof catalog.rootDir === 'string' ? catalog.rootDir : null,
        total: rows.length,
        enabledCount: items.filter((item) => item.enabled).length,
        rejected: rows.length - items.length,
        items,
        source: resolved.source,
      }
    }
    case 'stickerThumb': {
      const id = requireString(payload['id'], 'id')
      const resolved = resolveStickers()
      if ('reason' in resolved) return { available: false, dataUrl: null, reason: resolved.reason }
      const catalog = resolved.surface
      const root = typeof catalog.rootDir === 'string' ? catalog.rootDir : null
      if (root === null) return { available: false, dataUrl: null, reason: '图库目录尚未就绪。' }
      if (typeof catalog.get !== 'function') {
        return { available: false, dataUrl: null, reason: '当前图库不支持按 id 取图。' }
      }
      // Path safety: the catalogue stores a basename, never a path. Re-check it
      // anyway — a hand-edited catalog.json must not become a file-read gadget.
      const record = catalog.get(id) as { file?: unknown } | null | undefined
      const file = record === null || typeof record !== 'object' ? undefined : record.file
      if (typeof file !== 'string' || file.length === 0 || basename(file) !== file) {
        return { available: false, dataUrl: null, reason: '找不到这条表情。' }
      }
      const dot = file.lastIndexOf('.')
      const mime = dot < 0 ? undefined : THUMB_MIME[file.slice(dot + 1).toLowerCase()]
      if (mime === undefined) return { available: false, dataUrl: null, reason: '不支持的图片格式。' }
      const cacheKey = `${root}|${id}`
      const hit = THUMB_CACHE.get(cacheKey)
      if (hit !== undefined) return { available: true, dataUrl: hit, reason: null }
      try {
        const bytes = await readFile(join(root, file))
        if (bytes.length > MAX_THUMB_BYTES) {
          return { available: false, dataUrl: null, reason: '图片较大，未生成预览（发送不受影响）。' }
        }
        const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
        if (THUMB_CACHE.size >= THUMB_CACHE_LIMIT) {
          const oldest = THUMB_CACHE.keys().next().value
          if (typeof oldest === 'string') THUMB_CACHE.delete(oldest)
        }
        THUMB_CACHE.set(cacheKey, dataUrl)
        return { available: true, dataUrl, reason: null }
      } catch {
        return { available: false, dataUrl: null, reason: '图片文件读取失败。' }
      }
    }
    case 'stickerImport': {
      const resolved = resolveStickers()
      if ('reason' in resolved) throw new ServiceError(ERROR_CODES.internal, resolved.reason)
      const catalog = resolved.surface
      if (typeof catalog.importBytes !== 'function') {
        throw new ServiceError(ERROR_CODES.internal, '当前表情图库实现不支持导入（缺少 importBytes 接口）。')
      }
      const fileName = requireString(payload['fileName'], 'fileName')
      const encoded = requireString(payload['dataBase64'], 'dataBase64')
      if (encoded.length > MAX_STICKER_BASE64) {
        throw new ServiceError(ERROR_CODES.invalid, `图片编码后超过上限（${String(MAX_STICKER_BASE64)} 字符）。`)
      }
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length === 0) throw new ServiceError(ERROR_CODES.invalid, '图片内容为空。')
      if (bytes.length > MAX_STICKER_BYTES) {
        throw new ServiceError(ERROR_CODES.invalid, `图片超过 ${String(MAX_STICKER_BYTES)} 字节上限。`)
      }
      const rawOutcome = await catalog.importBytes(bytes, fileName, {
        ...(optionalString(payload['description']) === undefined
          ? {} : { description: optionalString(payload['description']) }),
        ...(optionalStrings(payload['tags']) === undefined ? {} : { tags: optionalStrings(payload['tags']) }),
      })
      return normalizeImportOutcome(rawOutcome)
    }
    case 'stickerUpdate': {
      const resolved = resolveStickers()
      if ('reason' in resolved) throw new ServiceError(ERROR_CODES.internal, resolved.reason)
      const catalog = resolved.surface
      // Single id only — there is no bulk enable/disable endpoint (§八.2).
      const id = requireString(payload['id'], 'id')
      const hasEnabled = typeof payload['enabled'] === 'boolean'
      const hasFavorite = typeof payload['favorite'] === 'boolean'
      const hasDescription = typeof payload['description'] === 'string'
      const hasTags = Array.isArray(payload['tags'])
      if (!hasEnabled && !hasFavorite && !hasDescription && !hasTags) {
        throw new ServiceError(ERROR_CODES.invalid, '至少需要提供 enabled / favorite / description / tags 之一。')
      }
      let changed = false
      if (hasEnabled) changed = (await catalog.setEnabled(id, payload['enabled'] === true)) === true || changed
      if (hasFavorite) changed = (await catalog.setFavorite(id, payload['favorite'] === true)) === true || changed
      if (hasDescription || hasTags) {
        // The bridge to the QQ plugin only exposes flags; say so instead of
        // silently accepting an edit that would never be persisted.
        if (catalog.setMeta === undefined) {
          throw new ServiceError(
            ERROR_CODES.invalid,
            '当前表情库由 QQ 插件提供，暂不支持改写描述与标签；请改用记忆库自带的表情目录。',
          )
        }
        const meta: { description?: string; tags?: string[] } = {}
        if (hasDescription) meta.description = String(payload['description'])
        if (hasTags) meta.tags = (payload['tags'] as unknown[]).map(String)
        changed = (await catalog.setMeta(id, meta)) === true || changed
      }
      return { id, changed }
    }
    case 'stickerDelete': {
      const resolved = resolveStickers()
      if ('reason' in resolved) throw new ServiceError(ERROR_CODES.internal, resolved.reason)
      const catalog = resolved.surface
      if (payload['confirm'] !== true) {
        throw new ServiceError(ERROR_CODES.invalid, '删除表情需要二次确认；请求中未携带确认标记。')
      }
      const id = requireString(payload['id'], 'id')
      const removed = (await catalog.remove(id)) === true
      return { id, removed }
    }
    case 'reminderList': {
      const resolved = resolveReminders()
      if ('reason' in resolved) {
        return { available: false, reason: resolved.reason, store: null, items: [], queueSize: 0, delivery: null }
      }
      const reminders = resolved.surface
      const raw = await reminders.list()
      const rows: unknown[] = Array.isArray(raw) ? raw : []
      const items: ReminderWire[] = []
      for (const row of rows) {
        const wire = toReminderWire(row)
        if (wire !== null) items.push(wire)
      }
      items.sort((a, b) => (a.dueAt === b.dueAt ? a.id.localeCompare(b.id) : a.dueAt < b.dueAt ? -1 : 1))
      // The passive window and the deferred queue only exist inside the QQ
      // runtime. When it is absent the page still lists rows, it just has no
      // live delivery state to show.
      const life = getLifeAgent?.()
      const runtime = life?.management?.reminders
      // `store` describes where the rows actually live, not who served them:
      // the plugin bridge can itself be vault-backed (its `storeKind`).
      const pluginKind = life?.management?.storeKind
      const store = resolved.source === 'vault'
        ? 'vault' as const
        : pluginKind === 'vault' || pluginKind === 'plugin' ? pluginKind : null
      return {
        available: true,
        reason: null,
        store,
        items,
        queueSize: typeof runtime?.queueSize === 'number' && Number.isFinite(runtime.queueSize)
          ? runtime.queueSize : 0,
        delivery: normalizeDeliveryStatus(runtime?.deliveryStatus),
      }
    }
    case 'reminderCreate': {
      const resolved = resolveReminders()
      if ('reason' in resolved) throw new ServiceError(ERROR_CODES.internal, resolved.reason)
      const reminders = resolved.surface
      const title = requireString(payload['title'], 'title')
      if (title.length > 200) throw new ServiceError(ERROR_CODES.invalid, '提醒标题不得超过 200 个字符。')
      const dueAt = requireString(payload['dueAt'], 'dueAt')
      if (Number.isNaN(Date.parse(dueAt))) {
        throw new ServiceError(ERROR_CODES.invalid, '字段 dueAt 必须是合法的 ISO 时间。')
      }
      const repeat = payload['repeat']
      if (repeat !== undefined && repeat !== null) {
        if (typeof repeat !== 'object') throw new ServiceError(ERROR_CODES.invalid, '字段 repeat 必须是对象或 null。')
        const rep = repeat as Record<string, unknown>
        const unit = rep['unit']
        const interval = rep['interval']
        if (typeof unit !== 'string' || !(REPEAT_UNITS as readonly string[]).includes(unit)) {
          throw new ServiceError(ERROR_CODES.invalid, '重复单位必须是 day / week / month。')
        }
        if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > 365) {
          throw new ServiceError(ERROR_CODES.invalid, '重复间隔必须是 1..365 的整数。')
        }
      }
      const created = await reminders.create({
        title,
        ...(optionalString(payload['note']) === undefined ? {} : { note: optionalString(payload['note']) }),
        dueAt,
        repeat: repeat === undefined || repeat === null
          ? null
          : {
            unit: (repeat as Record<string, unknown>)['unit'] as 'day' | 'week' | 'month',
            interval: (repeat as Record<string, unknown>)['interval'] as number,
          },
      })
      const wire = toReminderWire(created)
      if (wire === null) throw new ServiceError(ERROR_CODES.internal, '提醒已写入，但返回结构无法校验。')
      return wire
    }
    case 'reminderCancel': {
      const resolved = resolveReminders()
      if ('reason' in resolved) throw new ServiceError(ERROR_CODES.internal, resolved.reason)
      const reminders = resolved.surface
      const id = requireString(payload['id'], 'id')
      return { id, changed: (await reminders.cancel(id)) === true }
    }
    case 'reminderComplete': {
      const resolved = resolveReminders()
      if ('reason' in resolved) throw new ServiceError(ERROR_CODES.internal, resolved.reason)
      const reminders = resolved.surface
      const id = requireString(payload['id'], 'id')
      const result = await reminders.complete(id)
      if (result === null || typeof result !== 'object') {
        throw new ServiceError(ERROR_CODES.notFound, `未找到提醒：${id}`)
      }
      const next = (result as Record<string, unknown>)['next']
      const nextWire = toReminderWire(next)
      return { id, nextId: nextWire === null ? null : nextWire.id }
    }
    case 'reminderReschedule': {
      const resolved = resolveReminders()
      if ('reason' in resolved) throw new ServiceError(ERROR_CODES.internal, resolved.reason)
      const reminders = resolved.surface
      const id = requireString(payload['id'], 'id')
      const dueAt = requireString(payload['dueAt'], 'dueAt')
      if (Number.isNaN(Date.parse(dueAt))) {
        throw new ServiceError(ERROR_CODES.invalid, '字段 dueAt 必须是合法的 ISO 时间。')
      }
      const updated = await reminders.reschedule(id, dueAt)
      if (updated === null) throw new ServiceError(ERROR_CODES.notFound, `未找到提醒：${id}`)
      const wire = toReminderWire(updated)
      if (wire === null) throw new ServiceError(ERROR_CODES.internal, '提醒已更新，但返回结构无法校验。')
      return wire
    }
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
