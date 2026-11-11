/**
 * Shared reminder store (design WP-5: "提醒属于共享的个人事项").
 *
 * Reminders are product state, not facts: both ends must see the same rows, but
 * a reminder must never surface through memory recall. These tests pin both
 * halves of that sentence, plus the failure behaviour (corrupt note, interrupted
 * write, path escape, unresolved vault).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MemoryService } from '../../src/host/core/service.js'
import { scanVault } from '../../src/host/core/repository.js'
import {
  REMINDER_STORE_CONTRACT, ReminderStore, type ReminderRecord,
} from '../../src/host/tasks/reminder-store.js'
import { VAULT_DIRS } from '../../src/shared/types.js'
import { cleanup, makeTempRoot } from '../helpers.js'

let root: string
let vault: string
let service: MemoryService
let store: ReminderStore

const record = (over: Partial<ReminderRecord> = {}): ReminderRecord => ({
  id: 'rem_abc123',
  title: '复习线性代数',
  note: '第三章 特征值与特征向量',
  dueAt: '2026-11-10T12:00:00.000Z',
  status: 'pending',
  repeat: null,
  scope: 'shared',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:00:00.000Z',
  delivery: 'waiting',
  attempts: 0,
  lastAttemptAt: null,
  ...over,
})

const reminderDir = (): string => join(vault, VAULT_DIRS.reminders)

beforeEach(async () => {
  root = await makeTempRoot('l5-reminders')
  vault = join(root, 'DSH Memory')
  service = new MemoryService({
    configuredVaultPath: vault,
    configSettings: { language: 'zh', enableAutoExtraction: false, enableLlmExtraction: false },
  })
  await service.initialize(vault)
  store = new ReminderStore({ vaultPath: () => service.getVaultPath() })
})

afterEach(async () => { await cleanup(root) })

describe('Markdown 存储与往返', () => {
  it('一条提醒 = 一个 Markdown 文件，frontmatter 存状态、正文存备注', async () => {
    await store.upsert(record())
    const path = join(reminderDir(), 'rem_abc123.md')
    const text = await readFile(path, 'utf8')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('title: 复习线性代数')
    expect(text).toContain('due_at:')
    expect(text).toContain('scope: shared')
    expect(text).toContain('第三章 特征值与特征向量')
    expect(text).toContain('delivery: waiting')
  })

  it('往返保真：重复规则、投递状态、尝试次数都不丢', async () => {
    const original = record({
      repeat: { unit: 'week', interval: 2 },
      delivery: 'deferred',
      attempts: 3,
      lastAttemptAt: '2026-11-09T10:00:00.000Z',
    })
    await store.upsert(original)
    const [loaded] = await store.list()
    expect(loaded).toEqual(original)
  })

  it('list 每次从磁盘读取：在 Obsidian 里手改的备注能被看到', async () => {
    await store.upsert(record())
    const path = join(reminderDir(), 'rem_abc123.md')
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('第三章 特征值与特征向量', '改成了第四章'), 'utf8')
    const [loaded] = await store.list()
    expect(loaded?.note).toBe('改成了第四章')
  })

  it('remove 删除单条；重复删除返回 false', async () => {
    await store.upsert(record())
    expect(await store.remove('rem_abc123')).toBe(true)
    expect(await store.remove('rem_abc123')).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('写入是原子的：并发 upsert 不会留下半截文件', async () => {
    await Promise.all([
      store.upsert(record({ id: 'rem_a', title: 'A' })),
      store.upsert(record({ id: 'rem_b', title: 'B' })),
      store.upsert(record({ id: 'rem_c', title: 'C' })),
    ])
    const names = await readdir(reminderDir())
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect((await store.list()).map((r) => r.id).sort()).toEqual(['rem_a', 'rem_b', 'rem_c'])
  })
})

describe('损坏与中断的保守修复', () => {
  it('文件名与 id 不一致的笔记被丢弃，不猜测', async () => {
    await store.upsert(record({ id: 'rem_ok', title: '正常' }))
    await writeFile(join(reminderDir(), 'rem_other.md'), await readFile(join(reminderDir(), 'rem_ok.md'), 'utf8'), 'utf8')
    const result = await store.load()
    expect(result.records.map((r) => r.id)).toEqual(['rem_ok'])
    expect(result.dropped).toBe(1)
  })

  it('frontmatter 损坏的笔记被丢弃', async () => {
    await writeFile(join(reminderDir(), 'rem_bad.md'), '这不是 frontmatter\n', 'utf8')
    const result = await store.load()
    expect(result.records).toEqual([])
    expect(result.dropped).toBe(1)
  })

  it('状态值非法的笔记被丢弃', async () => {
    await store.upsert(record({ id: 'rem_x' }))
    const path = join(reminderDir(), 'rem_x.md')
    await writeFile(path, (await readFile(path, 'utf8')).replace('status: pending', 'status: exploded'), 'utf8')
    const result = await store.load()
    expect(result.records).toEqual([])
    expect(result.dropped).toBe(1)
  })

  it('「已投递但未完成」被视为待补投递，不会静默丢失', async () => {
    await store.upsert(record({ id: 'rem_crash', status: 'pending', delivery: 'delivered' }))
    const result = await store.load()
    expect(result.records[0]?.delivery).toBe('deferred')
    expect(result.recovered).toBe(1)
    // 修复结果已写回磁盘，下一次读取不再重复计数。
    const again = await store.load()
    expect(again.recovered).toBe(0)
    expect(again.records[0]?.delivery).toBe('deferred')
  })

  it('id 越界（含路径分隔符）在写之前就被拒绝', async () => {
    await expect(store.upsert(record({ id: '../escape' }))).rejects.toThrow(/invalid reminder record/)
    expect(await store.remove('../escape')).toBe(false)
  })
})

describe('提醒不是事实：绝不进入记忆索引', () => {
  it('Reminders/ 不被 scanVault 收录', async () => {
    await store.upsert(record({ title: '复习线性代数' }))
    const scan = await scanVault(vault)
    expect(scan.documents.some((doc) => doc.relativePath.startsWith(`${VAULT_DIRS.reminders}/`))).toBe(false)
    expect(scan.documents.some((doc) => doc.memory.title === '复习线性代数')).toBe(false)
  })

  it('重建索引后与提醒同名的内容也不会被检索到', async () => {
    await store.upsert(record({ title: '复习线性代数', note: '第三章 特征值与特征向量' }))
    await service.rebuildIndex()
    const hits = service.search({ text: '特征值与特征向量', limit: 10 })
    expect(hits.hits.every((hit) => hit.record.title !== '复习线性代数')).toBe(true)
  })

  it('目录随仓库初始化一起创建', async () => {
    const names = await readdir(vault)
    expect(names).toContain(VAULT_DIRS.reminders)
  })

  it('任务类型的 Tasks/ 目录仍然照常索引（与提醒目录互不影响）', async () => {
    const instance = new MemoryService({ configuredVaultPath: vault })
    await instance.initialize(vault)
    const created = await instance.save({
      type: 'task', title: '交作业', summary: '把线性代数作业交上去，周五截止。', tags: [], confidence: 'high', importance: 60,
    })
    const detail = await instance.get(created.id)
    expect(detail.memory.status).toBe('active')
    expect(detail.relativePath.startsWith('Tasks/')).toBe(true)
  })
})

describe('未初始化仓库时的降级', () => {
  it('vaultPath 未解析时 available=false、list 为空、写入报错', async () => {
    const detached = new ReminderStore({ vaultPath: () => undefined })
    expect(detached.available).toBe(false)
    expect(await detached.list()).toEqual([])
    expect(detached.root).toBeNull()
    await expect(detached.upsert(record())).rejects.toThrow(/vault path is not resolved/)
  })

  it('契约名固定，供 QQ 插件识别', () => {
    expect(store.contract).toBe(REMINDER_STORE_CONTRACT)
    expect(store.available).toBe(true)
  })
})
