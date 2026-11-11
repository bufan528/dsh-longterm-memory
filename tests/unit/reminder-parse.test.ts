/**
 * Natural-language reminder parsing.
 *
 * Fixed clock: Wednesday 2026-11-11 10:00 local. Every expectation below is
 * written as a wall-clock reading, not an ISO string, so the test stays
 * readable and does not depend on the machine's timezone.
 */
import { describe, expect, it } from 'vitest'

import { chineseNumber, parseReminderInput } from '../../src/client/reminder-parse.js'

const NOW = new Date(2026, 10, 11, 10, 0, 0, 0)

function parse(text: string) {
  const result = parseReminderInput(text, NOW)
  const at = result.dueAt === null ? null : new Date(result.dueAt)
  return {
    ...result,
    when: at === null
      ? null
      : `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
  }
}

describe('chineseNumber', () => {
  it('handles the shapes used in time expressions', () => {
    expect(chineseNumber('三')).toBe(3)
    expect(chineseNumber('十')).toBe(10)
    expect(chineseNumber('十一')).toBe(11)
    expect(chineseNumber('二十')).toBe(20)
    expect(chineseNumber('二十三')).toBe(23)
    expect(chineseNumber('7')).toBe(7)
    expect(chineseNumber('')).toBeNull()
  })
})

describe('parseReminderInput', () => {
  it('明天下午三点 + 标题', () => {
    const parsed = parse('明天下午三点交材料')
    expect(parsed.when).toBe('2026-11-12 15:00')
    expect(parsed.title).toBe('交材料')
    expect(parsed.label).toBe('明天 15:00')
  })

  it('相对时间：3 小时后', () => {
    const parsed = parse('3小时后给导师发邮件')
    expect(parsed.when).toBe('2026-11-11 13:00')
    expect(parsed.title).toBe('给导师发邮件')
  })

  it('相对时间：半小时后 / 一周后', () => {
    expect(parse('半小时后吃药').when).toBe('2026-11-11 10:30')
    expect(parse('一周后交报告').when).toBe('2026-11-18 10:00')
  })

  it('周几：本周五与下周一', () => {
    expect(parse('周五晚8点组会').when).toBe('2026-11-13 20:00')
    expect(parse('周五晚8点组会').title).toBe('组会')
    expect(parse('下周一9点提交').when).toBe('2026-11-16 09:00')
  })

  it('月日：11月20日，未给时间时默认 9 点', () => {
    const parsed = parse('11月20日交实验报告')
    expect(parsed.when).toBe('2026-11-20 09:00')
    expect(parsed.title).toBe('交实验报告')
  })

  it('剥掉口头的「提醒我」前缀', () => {
    const parsed = parse('提醒我明天上午十点开会')
    expect(parsed.when).toBe('2026-11-12 10:00')
    expect(parsed.title).toBe('开会')
  })

  it('只有时段也能给出合理时间', () => {
    expect(parse('晚上记得浇花').when).toBe('2026-11-11 20:00')
    expect(parse('明天浇花').when).toBe('2026-11-12 09:00')
  })

  it('时刻已过则顺延到明天', () => {
    // 现在是 10:00，说「9 点」只能是明天 9 点。
    expect(parse('9点交表').when).toBe('2026-11-12 09:00')
  })

  it('认不出时间时返回 null，标题保持原文', () => {
    const parsed = parse('整理比赛材料')
    expect(parsed.when).toBeNull()
    expect(parsed.title).toBe('整理比赛材料')
    expect(parsed.matched).toBe('')
  })

  it('空输入不产生时间', () => {
    expect(parseReminderInput('   ', NOW).dueAt).toBeNull()
  })
})
