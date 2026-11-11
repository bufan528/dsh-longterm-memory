/**
 * WP-6 management centre — the cross-plugin bridge to `life-agent@v1`.
 *
 * Design §九.C requires the two plugins to talk through dynamic
 * provide/inject, never a static import. That means the Vault side must treat
 * everything the QQ plugin returns as untrusted data:
 *
 *  - a missing service degrades to `available: false` with a human reason,
 *    it never throws at the page;
 *  - every returned row is re-validated before it reaches the wire, so a
 *    corrupt catalogue or a forged `file` path cannot escape;
 *  - every mutation is per-id — there is no bulk endpoint anywhere (§八.2).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryService } from '../../src/host/core/service.js'
import { dispatch, type LifeAgentLike } from '../../src/host/dsh/routes.js'
import { ERROR_CODES, RPC_METHODS } from '../../src/shared/protocol.js'

let service: MemoryService

/** A stand-in for the QQ plugin's `lifeAgent` service. */
interface FakeSticker {
  id: string
  file: string
  description: string
  tags: string[]
  enabled: boolean
  favorite: boolean
  usedCount: number
  bytes: number
  addedAt: string
}

interface FakeReminder {
  id: string
  title: string
  note: string
  dueAt: string
  status: string
  repeat: { unit: string; interval: number } | null
  delivery: string
  createdAt: string
  updatedAt: string
  attempts: number
  lastAttemptAt: string | null
}

function fakeLifeAgent(seed?: {
  stickers?: unknown[]
  reminders?: unknown[]
  storeKind?: unknown
  importResult?: unknown
}): LifeAgentLike {
  const stickers = seed?.stickers ?? []
  const reminders = (seed?.reminders ?? []) as FakeReminder[]
  return {
    contract: 'life-agent@v1',
    management: {
      storeKind: seed?.storeKind ?? 'vault',
      stickers: {
        rootDir: '/tmp/life-agent/stickers',
        droppedCount: 0,
        list: () => stickers,
        setEnabled: async (id: string, enabled: boolean) => {
          const row = stickers.find((s) => (s as FakeSticker).id === id) as FakeSticker | undefined
          if (row === undefined) return false
          row.enabled = enabled
          return true
        },
        setFavorite: async (id: string, favorite: boolean) => {
          const row = stickers.find((s) => (s as FakeSticker).id === id) as FakeSticker | undefined
          if (row === undefined) return false
          row.favorite = favorite
          return true
        },
        remove: async (id: string) => {
          const index = stickers.findIndex((s) => (s as FakeSticker).id === id)
          if (index < 0) return false
          stickers.splice(index, 1)
          return true
        },
        importBytes: async (bytes: Uint8Array, fileName: string) => seed?.importResult ?? {
          ok: true,
          duplicate: false,
          record: {
            id: 'a'.repeat(64),
            file: `aaaa.${fileName.split('.').pop() ?? 'png'}`,
            description: fileName,
            tags: [],
            enabled: true,
            favorite: false,
            usedCount: 0,
            bytes: bytes.byteLength,
            addedAt: '2026-11-09T10:00:00.000Z',
          },
        },
      },
      reminders: {
        list: async () => reminders,
        create: async (input) => ({
          id: 'remnew',
          title: input.title,
          note: input.note ?? '',
          dueAt: input.dueAt,
          status: 'pending',
          repeat: input.repeat ?? null,
          delivery: 'waiting',
          createdAt: '2026-11-09T10:00:00.000Z',
          updatedAt: '2026-11-09T10:00:00.000Z',
          attempts: 0,
          lastAttemptAt: null,
        }),
        cancel: async (id: string) => reminders.some((r) => r.id === id),
        complete: async (id: string) => {
          const row = reminders.find((r) => r.id === id)
          return row === undefined ? null : { completed: { ...row, status: 'done' }, next: { ...row, id: 'remnext' } }
        },
        reschedule: async (id: string, dueAt: string) => {
          const row = reminders.find((r) => r.id === id)
          return row === undefined ? null : { ...row, dueAt }
        },
        queueSize: 2,
        deliveryStatus: { windowOpen: true, remainingReplies: 3 },
      },
    },
  }
}

const sticker = (over: Partial<FakeSticker> = {}): FakeSticker => ({
  id: 'b'.repeat(64),
  file: `${'b'.repeat(64)}.png`,
  description: '开心',
  tags: ['happy'],
  enabled: true,
  favorite: false,
  usedCount: 0,
  bytes: 1024,
  addedAt: '2026-11-09T09:00:00.000Z',
  ...over,
})

const reminder = (over: Partial<FakeReminder> = {}): FakeReminder => ({
  id: 'rem1',
  title: '复习线性代数',
  note: '',
  dueAt: '2026-11-10T12:00:00.000Z',
  status: 'pending',
  repeat: null,
  delivery: 'waiting',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:00:00.000Z',
  attempts: 0,
  lastAttemptAt: null,
  ...over,
})

function run(method: string, payload: Record<string, unknown> = {}, life?: LifeAgentLike): Promise<unknown> {
  return dispatch(service, method, payload, undefined, undefined, life === undefined ? undefined : () => life)
}

beforeEach(() => {
  service = new MemoryService({ configSettings: { language: 'zh' } })
})

describe('life-agent 缺失时的降级（不抛错、不伪造数据）', () => {
  it('stickerLibrary 返回 available:false 与可读原因', async () => {
    const result = await run('stickerLibrary') as { available: boolean; reason: string; items: unknown[] }
    expect(result.available).toBe(false)
    expect(result.reason).toContain('life-agent@v1')
    expect(result.items).toEqual([])
  })

  it('reminderList 返回 available:false 且 store 为 null', async () => {
    const result = await run('reminderList') as { available: boolean; store: unknown; items: unknown[] }
    expect(result.available).toBe(false)
    expect(result.store).toBeNull()
    expect(result.items).toEqual([])
  })

  it('写操作在服务缺失时报 internal，而不是静默成功', async () => {
    await expect(run('stickerImport', { fileName: 'a.png', dataBase64: 'AAAA' }))
      .rejects.toMatchObject({ code: ERROR_CODES.internal })
    await expect(run('reminderCreate', { title: 't', dueAt: '2026-11-10T12:00:00.000Z' }))
      .rejects.toMatchObject({ code: ERROR_CODES.internal })
    await expect(run('stickerDelete', { id: 'x', confirm: true }))
      .rejects.toMatchObject({ code: ERROR_CODES.internal })
  })

  it('新增的 RPC 里没有任何批量方法', () => {
    const bridge = RPC_METHODS.filter((m) => /^sticker|^reminder/.test(m))
    expect(bridge.length).toBeGreaterThan(0)
    expect(bridge.filter((m) => /bulk|batch|all|many/i.test(m))).toEqual([])
  })
})

describe('读投影：只接受可校验的数据', () => {
  it('越权 file 路径与非法 id 的行被丢弃，且计入 rejected', async () => {
    const life = fakeLifeAgent({
      stickers: [
        sticker(),
        sticker({ id: 'c'.repeat(64), file: '../../etc/passwd' }),
        sticker({ id: 'not a hash!' }),
      ],
    })
    const result = await run('stickerLibrary', {}, life) as {
      available: boolean; total: number; rejected: number; items: { id: string }[]
    }
    expect(result.available).toBe(true)
    expect(result.total).toBe(3)
    expect(result.rejected).toBe(2)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.id).toBe('b'.repeat(64))
  })

  it('按 addedAt 倒序（最新导入在前）', async () => {
    const life = fakeLifeAgent({
      stickers: [
        sticker({ id: 'd'.repeat(64), file: `${'d'.repeat(64)}.png`, addedAt: '2026-11-01T00:00:00.000Z' }),
        sticker({ id: 'e'.repeat(64), file: `${'e'.repeat(64)}.png`, addedAt: '2026-11-09T00:00:00.000Z' }),
      ],
    })
    const result = await run('stickerLibrary', {}, life) as { items: { id: string }[] }
    expect(result.items.map((i) => i.id)).toEqual(['e'.repeat(64), 'd'.repeat(64)])
  })

  it('reminderList 归一化 store / queue / 被动窗口，并按 dueAt 升序', async () => {
    const life = fakeLifeAgent({
      storeKind: 'vault',
      reminders: [
        reminder({ id: 'late', dueAt: '2026-12-01T00:00:00.000Z' }),
        reminder({ id: 'early', dueAt: '2026-11-10T00:00:00.000Z' }),
      ],
    })
    const result = await run('reminderList', {}, life) as {
      available: boolean
      store: string
      queueSize: number
      delivery: { windowOpen: boolean; remainingReplies: number }
      items: { id: string }[]
    }
    expect(result.available).toBe(true)
    expect(result.store).toBe('vault')
    expect(result.queueSize).toBe(2)
    expect(result.delivery).toEqual({ windowOpen: true, remainingReplies: 3 })
    expect(result.items.map((i) => i.id)).toEqual(['early', 'late'])
  })

  it('状态或投递值非法的提醒被丢弃', async () => {
    const life = fakeLifeAgent({
      reminders: [
        reminder(),
        reminder({ id: 'bad', status: 'exploded' }),
        reminder({ id: 'bad2', delivery: 'pushed' }),
        reminder({ id: 'bad3', dueAt: 'not-a-date' }),
      ],
    })
    const result = await run('reminderList', {}, life) as { items: { id: string }[] }
    expect(result.items.map((i) => i.id)).toEqual(['rem1'])
  })

  it('storeKind 缺失时 store 为 null，不猜测', async () => {
    const life = fakeLifeAgent({ storeKind: 'mystery' })
    const result = await run('reminderList', {}, life) as { store: unknown }
    expect(result.store).toBeNull()
  })
})

describe('写操作：单条、显式、可校验', () => {
  it('stickerUpdate 至少需要 enabled 或 favorite', async () => {
    await expect(run('stickerUpdate', { id: 'x' }, fakeLifeAgent()))
      .rejects.toMatchObject({ code: ERROR_CODES.invalid })
  })

  it('stickerUpdate 只改指定字段并返回 changed', async () => {
    const life = fakeLifeAgent({ stickers: [sticker()] })
    const result = await run('stickerUpdate', { id: 'b'.repeat(64), enabled: false }, life)
    expect(result).toEqual({ id: 'b'.repeat(64), changed: true })
    const after = await run('stickerLibrary', {}, life) as { items: { enabled: boolean }[] }
    expect(after.items[0]?.enabled).toBe(false)
  })

  it('stickerDelete 必须二次确认', async () => {
    await expect(run('stickerDelete', { id: 'b'.repeat(64) }, fakeLifeAgent()))
      .rejects.toMatchObject({ code: ERROR_CODES.invalid })
    const life = fakeLifeAgent({ stickers: [sticker()] })
    expect(await run('stickerDelete', { id: 'b'.repeat(64), confirm: true }, life))
      .toEqual({ id: 'b'.repeat(64), removed: true })
  })

  it('stickerImport 拒绝空内容与超限编码', async () => {
    await expect(run('stickerImport', { fileName: 'a.png', dataBase64: '' }, fakeLifeAgent()))
      .rejects.toMatchObject({ code: ERROR_CODES.invalid })
    const huge = 'A'.repeat(11_200_001)
    await expect(run('stickerImport', { fileName: 'a.png', dataBase64: huge }, fakeLifeAgent()))
      .rejects.toMatchObject({ code: ERROR_CODES.invalid })
  })

  it('stickerImport 把去重结果与拒绝原因原样上报', async () => {
    const duplicate = fakeLifeAgent({
      importResult: { ok: true, duplicate: true, record: sticker() },
    })
    const result = await run('stickerImport', { fileName: 'a.png', dataBase64: 'AAAA' }, duplicate) as {
      id: string | null; duplicate: boolean; reason: string | null
    }
    expect(result.duplicate).toBe(true)
    expect(result.id).toBe('b'.repeat(64))

    const refused = fakeLifeAgent({ importResult: { ok: false, reason: 'unsupported extension .txt' } })
    const failed = await run('stickerImport', { fileName: 'a.txt', dataBase64: 'AAAA' }, refused) as {
      id: string | null; reason: string | null
    }
    expect(failed.id).toBeNull()
    expect(failed.reason).toContain('unsupported extension')
  })

  it('reminderCreate 校验 dueAt 与重复规则', async () => {
    const life = fakeLifeAgent()
    await expect(run('reminderCreate', { title: 't', dueAt: 'tomorrow' }, life))
      .rejects.toMatchObject({ code: ERROR_CODES.invalid })
    await expect(run('reminderCreate', {
      title: 't', dueAt: '2026-11-10T12:00:00.000Z', repeat: { unit: 'year', interval: 1 },
    }, life)).rejects.toMatchObject({ code: ERROR_CODES.invalid })
    await expect(run('reminderCreate', {
      title: 't', dueAt: '2026-11-10T12:00:00.000Z', repeat: { unit: 'day', interval: 0 },
    }, life)).rejects.toMatchObject({ code: ERROR_CODES.invalid })
  })

  it('reminderCreate 成功后返回可校验的 wire', async () => {
    const result = await run('reminderCreate', {
      title: '交作业', dueAt: '2026-11-10T12:00:00.000Z', note: '算法',
    }, fakeLifeAgent()) as { id: string; title: string; status: string; delivery: string }
    expect(result.id).toBe('remnew')
    expect(result.title).toBe('交作业')
    expect(result.status).toBe('pending')
    expect(result.delivery).toBe('waiting')
  })

  it('reminderCancel 对未知 id 返回 changed:false（不抛错）', async () => {
    expect(await run('reminderCancel', { id: 'nope' }, fakeLifeAgent())).toEqual({ id: 'nope', changed: false })
  })

  it('reminderComplete 返回下一次的 id；未知 id 报 notFound', async () => {
    const life = fakeLifeAgent({ reminders: [reminder()] })
    expect(await run('reminderComplete', { id: 'rem1' }, life)).toEqual({ id: 'rem1', nextId: 'remnext' })
    await expect(run('reminderComplete', { id: 'ghost' }, life))
      .rejects.toMatchObject({ code: ERROR_CODES.notFound })
  })

  it('reminderReschedule 更新到期时间；未知 id 报 notFound', async () => {
    const life = fakeLifeAgent({ reminders: [reminder()] })
    const updated = await run('reminderReschedule', { id: 'rem1', dueAt: '2026-11-11T12:00:00.000Z' }, life) as {
      dueAt: string
    }
    expect(updated.dueAt).toBe('2026-11-11T12:00:00.000Z')
    await expect(run('reminderReschedule', { id: 'ghost', dueAt: '2026-11-11T12:00:00.000Z' }, life))
      .rejects.toMatchObject({ code: ERROR_CODES.notFound })
  })
})
