/**
 * Life tools: capture throttle and pick passthrough.
 *
 * The capture cap is the only thing standing between "the bot saves memes" and
 * "the bot saved 400 screenshots", so it is asserted directly. Each case uses its
 * own session id because the counter is process-wide per session.
 */
import { describe, expect, it } from 'vitest'

import { autoCollectKey, buildLifeTools } from '../../src/host/dsh/life-tools.js'
import type { StickerToolSurface } from '../../src/host/dsh/life-tools.js'
import type { ToolDefinition, ToolExecContext } from '../../src/host/dsh/tools.js'

function makeStickers(): { surface: StickerToolSurface; calls: string[] } {
  const calls: string[] = []
  let seq = 0
  return {
    calls,
    surface: {
      pick: async (query) => {
        if (query.emotion === '抱歉') {
          return { ok: false, blocked: 'no-match', reason: '没有匹配的表情' } as never
        }
        return {
          ok: true,
          id: 'abc',
          path: '/tmp/abc.png',
          description: '开心 猫猫',
          tags: ['开心'],
          reason: '命中「开心」',
        }
      },
      importPath: async (path, input) => {
        calls.push(`${path}:${input?.source ?? 'none'}`)
        seq += 1
        return {
          ok: true,
          duplicate: false,
          record: { id: `id${String(seq)}`, description: input?.description ?? 'sticker', tags: input?.tags ?? [] },
        } as never
      },
    },
  }
}

function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`tool ${name} not built`)
  return found
}

const exec = (sessionId: string): ToolExecContext => ({ agent: { session: { id: sessionId } } })

describe('sticker_ingest capture cap', () => {
  it('allows three self-initiated captures and refuses the fourth', async () => {
    const { surface } = makeStickers()
    const tool = toolNamed(buildLifeTools({ stickers: surface }), 'sticker_ingest')

    for (let index = 0; index < 3; index += 1) {
      const result = (await tool.execute({ path: `/tmp/${String(index)}.png`, description: '反应图', tags: ['开心'] }, exec('sess-a'))) as { ok: boolean }
      expect(result.ok).toBe(true)
    }
    const fourth = (await tool.execute({ path: '/tmp/3.png' }, exec('sess-a'))) as { ok: boolean; reason?: string }
    expect(fourth.ok).toBe(false)
    expect(fourth.reason).toContain('3')
  })

  it('resets the allowance on a new day, so a long-lived chat is not silenced forever', () => {
    const day1 = autoCollectKey('group-1', new Date(2026, 10, 14, 9, 0, 0))
    const day2 = autoCollectKey('group-1', new Date(2026, 10, 15, 9, 0, 0))
    expect(day1).not.toBe(day2)
    expect(day1.startsWith('group-1:')).toBe(true)
  })

  it('counts per session, not globally', async () => {
    const { surface } = makeStickers()
    const tool = toolNamed(buildLifeTools({ stickers: surface }), 'sticker_ingest')
    for (let index = 0; index < 3; index += 1) {
      await tool.execute({ path: `/tmp/x${String(index)}.png` }, exec('sess-b'))
    }
    const otherSession = (await tool.execute({ path: '/tmp/y.png' }, exec('sess-c'))) as { ok: boolean }
    expect(otherSession.ok).toBe(true)
  })

  it('does not cap an explicit user request (source=import)', async () => {
    const { surface, calls } = makeStickers()
    const tool = toolNamed(buildLifeTools({ stickers: surface }), 'sticker_ingest')
    for (let index = 0; index < 4; index += 1) {
      await tool.execute({ path: `/tmp/imp${String(index)}.png` }, exec('sess-d'))
    }
    const fifth = (await tool.execute({ path: '/tmp/imp4.png', source: 'import' }, exec('sess-d'))) as { ok: boolean }
    expect(fifth.ok).toBe(true)
    expect(calls.at(-1)).toContain(':import')
  })

  it('defaults an unknown source to incoming so it is still capped', async () => {
    const { surface, calls } = makeStickers()
    const tool = toolNamed(buildLifeTools({ stickers: surface }), 'sticker_ingest')
    await tool.execute({ path: '/tmp/z.png', source: 'nonsense' }, exec('sess-e'))
    expect(calls.at(-1)).toContain(':incoming')
  })

  it('reports a failure from the store instead of throwing', async () => {
    const tool = toolNamed(
      buildLifeTools({ stickers: { pick: makeStickers().surface.pick, importPath: async () => ({ ok: false, reason: 'file not found' }) as never } }),
      'sticker_ingest',
    )
    const result = (await tool.execute({ path: '/nope.png' }, exec('sess-f'))) as { ok: boolean; reason?: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('file not found')
  })
})

describe('sticker_pick tool', () => {
  it('passes a refusal through with its reason', async () => {
    const tool = toolNamed(buildLifeTools({ stickers: makeStickers().surface }), 'sticker_pick')
    const result = (await tool.execute({ emotion: '抱歉' }, exec('sess-g'))) as { ok: boolean; reason?: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('没有匹配')
  })

  it('requires something to match on', async () => {
    const tool = toolNamed(buildLifeTools({ stickers: makeStickers().surface }), 'sticker_pick')
    await expect(tool.execute({}, exec('sess-h'))).rejects.toThrow(/emotion/)
  })
})

describe('reminder_create tool', () => {
  function reminderTool() {
    const created: { title: string; dueAt: string }[] = []
    const tools = buildLifeTools({
      reminders: {
        list: async () => [],
        create: async (input) => {
          created.push({ title: input.title, dueAt: input.dueAt })
          return { id: 'r1', title: input.title, dueAt: input.dueAt, repeat: input.repeat ?? null }
        },
        complete: async () => null,
      },
      assertAllowed: () => undefined,
    })
    return { tool: toolNamed(tools, 'reminder_create'), created }
  }

  it('accepts a relative deadline', async () => {
    const { tool, created } = reminderTool()
    const before = Date.now()
    await tool.execute({ title: '交材料', inMinutes: 30 }, exec('sess-i'))
    expect(created).toHaveLength(1)
    const due = Date.parse(created[0]!.dueAt)
    expect(due - before).toBeGreaterThan(29 * 60_000)
    expect(due - before).toBeLessThan(31 * 60_000)
  })

  it('rejects a reminder with no time at all', async () => {
    const { tool } = reminderTool()
    await expect(tool.execute({ title: '没时间' }, exec('sess-j'))).rejects.toThrow(/dueAt|inMinutes/)
  })

  it('rejects an unparseable instant instead of guessing', async () => {
    const { tool } = reminderTool()
    await expect(tool.execute({ title: 'x', dueAt: 'tomorrow-ish' }, exec('sess-k'))).rejects.toThrow(/not a valid instant/)
  })
})
