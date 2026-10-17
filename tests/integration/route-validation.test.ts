/**
 * HTTP write-route runtime validation and failure atomicity (round 13, P0-2).
 *
 * Every case goes through the REAL registered route handler (trust fence, body
 * parsing, `dispatch`, service, repository, index) against a real temporary vault.
 * Rejection cases also snapshot the vault before and after, so "no side effect" is
 * proven by the filesystem rather than assumed from the error response.
 *
 * @module tests/integration/route-validation.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'
import { installRoutes } from '../../src/host/dsh/routes.js'
import { ERROR_CODES, ROUTE_PREFIX } from '../../src/shared/protocol.js'

let root: string
let vault: string
let service: MemoryService
let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | null

function fakeCtx() {
  const routes: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }[] = []
  return {
    routes,
    ctx: {
      get: (name: string) =>
        name === 'webServer'
          ? { register: (registration: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) => (routes.push(registration), () => undefined) }
          : name === 'webRuntime'
            ? { trustedHosts: [] }
            : undefined,
      effect: (fn: () => unknown) => fn(),
      logger: { warn: () => undefined },
    },
  }
}

/** Minimal IncomingMessage: async-iterable request body plus the headers the fence reads. */
function makeRequest(method: string, path: string, body: string): IncomingMessage {
  const buffer = Buffer.from(body, 'utf8')
  return {
    method,
    url: path,
    headers: { host: '127.0.0.1:1234', 'sec-fetch-site': 'same-origin', 'content-length': String(buffer.length) },
    async *[Symbol.asyncIterator]() {
      yield buffer
    },
  } as unknown as IncomingMessage
}

function makeResponse(): { response: ServerResponse; result: () => { status: number; body: any } } {
  let status = 200
  let text = ''
  const response = {
    set statusCode(value: number) {
      status = value
    },
    get statusCode() {
      return status
    },
    writeHead: (code: number) => {
      status = code
    },
    setHeader: () => undefined,
    end: (chunk?: unknown) => {
      if (chunk !== undefined) text += String(chunk)
    },
  }
  return { response: response as unknown as ServerResponse, result: () => ({ status, body: text.length === 0 ? null : JSON.parse(text) }) }
}

async function call(method: string, payload: unknown): Promise<{ status: number; body: any }> {
  if (handler === null) throw new Error('route handler was not installed')
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const { response, result } = makeResponse()
  await handler(makeRequest('POST', `${ROUTE_PREFIX}/${method}`, body), response)
  return result()
}

/** Every file under the vault with its SHA-256, so a rejection can be proven side-effect free. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const files = await readdir(vault, { recursive: true }).catch(() => [])
  for (const relative of files) {
    const path = join(vault, String(relative))
    const content = await readFile(path).catch(() => null)
    if (content !== null) out[String(relative).replace(/\\/g, '/')] = createHash('sha256').update(content).digest('hex')
  }
  return out
}

async function seed(): Promise<string> {
  const saved = await service.save({
    type: 'knowledge',
    title: '路由校验目标',
    summary: '这条记忆用于验证写入路由的输入校验，标记 ROUTE-MARK-9911。',
    tags: ['route'],
    confidence: 'high',
    importance: 60,
  })
  return saved.id
}

beforeEach(async () => {
  root = await makeTempRoot('route-validation')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({ configuredVaultPath: vault })
  await service.initialize(vault)
  const { ctx, routes } = fakeCtx()
  installRoutes(ctx as never, service)
  handler = routes[0]?.handler ?? null
})

afterEach(async () => {
  await cleanup(root)
})

/** Reject: the response must be ok:false, and the vault must be byte-identical. */
async function expectRejected(label: string, method: string, payload: unknown, code: string = ERROR_CODES.invalid): Promise<void> {
  await seedIfEmpty()
  const before = await snapshot()
  const { body } = await call(method, payload)
  const after = await snapshot()
  expect(body?.ok, `${label}: expected ok:false, got ${JSON.stringify(body)}`).toBe(false)
  expect(body?.error?.code, `${label}: error code`).toBe(code)
  expect(after, `${label}: vault changed on rejection`).toEqual(before)
}

let seeded: string | null = null
async function seedIfEmpty(): Promise<void> {
  if (seeded === null) seeded = await seed()
}
beforeEach(() => {
  seeded = null
})

describe('save route rejects bad input before writing', () => {
  it('rejects a non-array tags value instead of writing characters as tags', async () => {
    await expectRejected('tags as string', 'save', {
      type: 'knowledge',
      title: '标签类型',
      summary: '正文',
      tags: 'abc',
      confidence: 'high',
      importance: 50,
    })
  })

  it('rejects a numeric title without leaking an internal error', async () => {
    await expectRejected('title as number', 'save', {
      type: 'knowledge',
      title: 42,
      summary: '正文',
      tags: [],
      confidence: 'high',
      importance: 50,
    })
  })

  it('rejects an unknown type', async () => {
    await expectRejected('unknown type', 'save', { type: 'bogus', title: 'x', summary: 'y', tags: [], confidence: 'high', importance: 1 })
  })

  it('rejects an unknown confidence', async () => {
    await expectRejected('unknown confidence', 'save', { type: 'knowledge', title: 'x', summary: 'y', tags: [], confidence: 'sure', importance: 1 })
  })

  it('rejects an unknown status', async () => {
    await expectRejected('unknown status', 'save', { type: 'knowledge', title: 'x', summary: 'y', tags: [], confidence: 'high', importance: 1, status: 'ghost' })
  })

  it('accepts a valid save', async () => {
    const before = await snapshot()
    const { body } = await call('save', {
      type: 'knowledge',
      title: '合法保存',
      summary: '合法请求应当通过。',
      tags: ['ok'],
      confidence: 'high',
      importance: 50,
    })
    expect(body.ok).toBe(true)
    expect(await snapshot()).not.toEqual(before)
  })
})

describe('settings route validates types before touching the vault', () => {
  it('rejects a non-boolean flag instead of persisting it', async () => {
    await expectRejected('enablePerStepRecall as string', 'setSettings', { enablePerStepRecall: 'yes' })
  })

  it('rejects a non-numeric budget', async () => {
    await expectRejected('recallBudgetTokens as string', 'setSettings', { recallBudgetTokens: 'lots' })
  })

  it('rejects an unsupported language', async () => {
    await expectRejected('language as unknown', 'setSettings', { language: 'fr' })
  })

  it('does not switch vaults when the same request also carries an invalid setting', async () => {
    const other = join(root, 'Other Vault')
    await expectRejected('vaultPath plus invalid language', 'setSettings', { vaultPath: other, language: 'fr' })
    // Validation must run before any vault switch: the other vault must not exist.
    await expect(readFile(join(other, '.dsh-memory', 'config.json'), 'utf8')).rejects.toThrow()
  })

  it('accepts a valid settings patch', async () => {
    const { body } = await call('setSettings', { recallMaxItems: 4 })
    expect(body.ok).toBe(true)
    expect(body.data.recallMaxItems).toBe(4)
  })
})

describe('other write routes reject malformed payloads without side effects', () => {
  it('rejects setStatus with an unknown status', async () => {
    const id = await seed()
    const before = await snapshot()
    const { body } = await call('setStatus', { id, status: 'ghost' })
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe(ERROR_CODES.invalid)
    expect(await snapshot()).toEqual(before)
  })

  it('rejects a delete without the confirmation flag', async () => {
    const id = await seed()
    const before = await snapshot()
    const { body } = await call('delete', { id })
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe(ERROR_CODES.invalid)
    expect(await snapshot()).toEqual(before)
  })

  it('rejects merge with a non-array ids value', async () => {
    const id = await seed()
    const before = await snapshot()
    const { body } = await call('merge', { ids: id, targetId: id })
    expect(body.ok).toBe(false)
    expect(await snapshot()).toEqual(before)
  })

  it('rejects resolveConflict with an unknown strategy without archiving anything', async () => {
    const id = await seed()
    const other = await seed()
    const before = await snapshot()
    const { body } = await call('resolveConflict', { id, strategy: 'nonsense', otherIds: [other] })
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe(ERROR_CODES.invalid)
    expect(await snapshot()).toEqual(before)
  })

  it('rejects writeRaw with a missing checksum without touching the file', async () => {
    const id = await seed()
    const before = await snapshot()
    const { body } = await call('writeRaw', { id, content: '# hacked' })
    expect(body.ok).toBe(false)
    expect(await snapshot()).toEqual(before)
  })
})

describe('transport-level failures stay clean', () => {
  it('returns 400 for malformed JSON and writes nothing', async () => {
    const before = await snapshot()
    if (handler === null) throw new Error('no handler')
    const { response, result } = makeResponse()
    const request = makeRequest('POST', `${ROUTE_PREFIX}/save`, '{not json')
    await handler(request, response)
    expect(result().status).toBe(400)
    expect(result().body.ok).toBe(false)
    expect(await snapshot()).toEqual(before)
  })

  it('rejects non-POST methods with 405 and writes nothing', async () => {
    const before = await snapshot()
    if (handler === null) throw new Error('no handler')
    const { response, result } = makeResponse()
    await handler(makeRequest('GET', `${ROUTE_PREFIX}/save`, ''), response)
    expect(result().status).toBe(405)
    expect(await snapshot()).toEqual(before)
  })

  it('rejects an unknown method with 404', async () => {
    if (handler === null) throw new Error('no handler')
    const { response, result } = makeResponse()
    await handler(makeRequest('POST', `${ROUTE_PREFIX}/notARealMethod`, '{}'), response)
    expect(result().status).toBe(404)
  })
})
