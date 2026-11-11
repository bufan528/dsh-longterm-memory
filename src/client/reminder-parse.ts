/**
 * Natural-language reminder capture (client-side, no dependency).
 *
 * Why this exists: the reminder pane used to require a title *and* a
 * `datetime-local` value before the save button enabled. That is three
 * interactions to record "tomorrow 3pm, submit the report" — enough friction
 * that the feature goes unused.
 *
 * Mature reminder apps all solve this the same way: one box, parse as you
 * type, show the parsed result as a chip, let the user correct it if the guess
 * was wrong. The parser is a pure function so it can be unit-tested without a
 * DOM, and it is deliberately rule-based rather than an LLM call:
 *
 *  - it must work offline, inside the panel, with no token cost;
 *  - a wrong date is expensive (a missed deadline), so the rules stay narrow
 *    and anything unrecognised falls back to "no time detected" and the UI
 *    keeps the explicit picker.
 *
 * Supported forms (Chinese, plus a few English shortcuts):
 *
 *   3小时后 / 半小时后 / 2天后 / 一周后     relative
 *   今天 / 明天 / 后天 / 大后天             day offset
 *   周五 / 下周一 / 这周三                  weekday
 *   11月20日 / 11/20                       month-day
 *   下午三点 / 晚上8点 / 15:30 / 9点半      clock time
 *   明天下午三点交材料                       date + time + title
 */
export interface ParsedReminder {
  /** Local ISO instant, or `null` when no time expression was found. */
  dueAt: string | null
  /** The input with the time expression removed and filler words trimmed. */
  title: string
  /** The fragment that was consumed, for the preview chip. */
  matched: string
  /** Human-readable guess ("明天 15:00"), empty when nothing matched. */
  label: string
}

const CN_DIGIT: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

const WEEKDAY: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0,
}

/** 0-99 for the shapes that appear in reminders ("十", "十一", "二十三"). */
export function chineseNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw)
  if (raw.length === 0) return null
  if (raw === '十') return 10
  if (raw.startsWith('十')) {
    const rest = CN_DIGIT[raw.slice(1)]
    return rest === undefined ? null : 10 + rest
  }
  if (raw.endsWith('十')) {
    const head = CN_DIGIT[raw.slice(0, -1)]
    return head === undefined ? null : head * 10
  }
  const parts = raw.split('十')
  if (parts.length === 2) {
    const head = CN_DIGIT[parts[0]!]
    const tail = CN_DIGIT[parts[1]!]
    if (head === undefined || tail === undefined) return null
    return head * 10 + tail
  }
  return CN_DIGIT[raw] ?? null
}

/** "下午" → the hour offset applied to a 12-hour reading. */
const MERIDIEM: Record<string, number> = {
  凌晨: 0, 早上: 0, 早晨: 0, 上午: 0,
  中午: 12, 下午: 12, 傍晚: 12, 晚上: 12, 夜里: 12, 晚: 12, 早: 0,
}

/** A bare time-of-day with no clock reading gets a plausible default hour. */
const BARE_TIME: Record<string, number> = {
  凌晨: 6, 早上: 9, 早晨: 9, 上午: 9,
  中午: 12, 下午: 15, 傍晚: 18, 晚上: 20, 夜里: 21,
}

const CLOCK = '(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|晚|早)?'
const NUMBER = '(\\d{1,2}|[零一二两三四五六七八九十]{1,3})'
const HOUR_PATTERN = new RegExp(`${CLOCK}\\s*${NUMBER}\\s*(?:点|:)(?:\\s*(半|\\d{1,2}|[零一二两三四五六七八九十]{1,3})\\s*分?)?`)
const WEEKDAY_PATTERN = new RegExp('(下下|下|这|本|这个)?\\s*(?:周|星期|礼拜)\\s*([一二三四五六日天1-7])')
const MONTH_DAY_PATTERN = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]|(\d{1,2})\/(\d{1,2})/
const DAY_WORD_PATTERN = /(大后天|后天|明天|今天|明晚|今晚|明早|今早)/
const RELATIVE_PATTERN = new RegExp(
  `(半|\\d+(?:\\.\\d+)?|[一二两三四五六七八九十]{1,3})\\s*个?\\s*(分钟|分|小时|钟头|天|周|星期|个月)\\s*(?:以?后|之后|后)`,
)

const DAY_WORD_OFFSET: Record<string, number> = {
  今天: 0, 今早: 0, 今晚: 0,
  明天: 1, 明早: 1, 明晚: 1,
  后天: 2, 大后天: 3,
}

const FILLER_HEAD = /^(?:提醒我|提醒一下|记得|帮我记一下|帮我|到时候|到点)?\s*/u
const FILLER_TAIL = /\s*(?:提醒我|提醒一下|提醒|叫我一声|叫我)?\s*$/u

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function startOfDay(base: Date, offset: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 0, 0, 0, 0)
}

/** Local instant with the given wall-clock time on the base date + offset. */
function at(base: Date, offset: number, hour: number, minute: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hour, minute, 0, 0)
}

function cleanTitle(raw: string): string {
  return raw
    .replace(FILLER_HEAD, '')
    .replace(FILLER_TAIL, '')
    .replace(/^[\s,，、。.;；:：-]+/u, '')
    .replace(/[\s,，、.;；:：]+$/u, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function formatLabel(date: Date, base: Date): string {
  const days = Math.round((startOfDay(date, 0).getTime() - startOfDay(base, 0).getTime()) / 86_400_000)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days === 0) return `今天 ${clock}`
  if (days === 1) return `明天 ${clock}`
  if (days === 2) return `后天 ${clock}`
  if (days === -1) return `昨天 ${clock}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

/**
 * Parse one line of natural language into a due instant.
 *
 * `now` is injectable so tests are deterministic and so the caller can parse
 * against the panel's clock rather than the machine's.
 */
export function parseReminderInput(input: string, now: Date = new Date()): ParsedReminder {
  const original = input.trim()
  if (original === '') return { dueAt: null, title: '', matched: '', label: '' }

  let text = original
  // Full-width digits and colons are common when typing fast on a phone IME.
  text = text.replace(/[\uFF10-\uFF19]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 0xFEE0))
  text = text.replace(/[：]/g, ':').replace(/[．]/g, '.')

  const base = new Date(now.getTime())
  const consumed: string[] = []

  const take = (pattern: RegExp): RegExpExecArray | null => {
    const match = pattern.exec(text)
    if (match === null) return null
    consumed.push(match[0])
    text = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`
    return match
  }

  let target: Date | null = null
  /** How far to roll forward if the computed instant is already past. */
  let rollDays = 0

  /* ---------------------------------------------------------- relative -- */
  const relative = take(RELATIVE_PATTERN)
  if (relative !== null) {
    const amount = relative[1] === '半' ? 0.5 : (chineseNumber(relative[1]!) ?? 0)
    const unit = relative[2]!
    const ms = unit === '分钟' || unit === '分' ? 60_000
      : unit === '小时' || unit === '钟头' ? 3_600_000
        : unit === '天' ? 86_400_000
          : unit === '周' || unit === '星期' ? 7 * 86_400_000
            : 30 * 86_400_000
    if (Number.isFinite(amount) && amount > 0) {
      const when = new Date(base.getTime() + amount * ms)
      return {
        dueAt: when.toISOString(),
        title: cleanTitle(text),
        matched: consumed.join(' '),
        label: formatLabel(when, base),
      }
    }
  }

  /* ------------------------------------------------------- day offset -- */
  let dayOffset: number | null = null
  const dayWord = take(DAY_WORD_PATTERN)
  if (dayWord !== null) {
    dayOffset = DAY_WORD_OFFSET[dayWord[1]!] ?? 0
  }

  /* ----------------------------------------------------------- weekday -- */
  if (dayOffset === null) {
    const weekday = take(WEEKDAY_PATTERN)
    if (weekday !== null) {
      const targetDow = WEEKDAY[weekday[2]!]
      if (targetDow !== undefined) {
        // Number days Monday=1 … Sunday=7 so "this week" has a fixed origin.
        const iso = (dow: number) => (dow === 0 ? 7 : dow)
        const current = iso(base.getDay())
        const target = iso(targetDow)
        const prefix = weekday[1] ?? ''
        if (prefix === '这' || prefix === '本' || prefix === '这个') {
          // "这周五" can be in the past; the user named the week explicitly.
          dayOffset = target - current
          rollDays = 0
        } else if (prefix === '下' || prefix === '下下') {
          // "下周五" spoken on a Wednesday means next week's Friday, not this
          // week's — so it is always "this week's target + 7", even when the
          // target day is still ahead of us.
          dayOffset = target - current + (prefix === '下下' ? 14 : 7)
          rollDays = 0
        } else {
          dayOffset = (target - current + 7) % 7
          rollDays = 7
        }
      }
    }
  }

  /* --------------------------------------------------------- month-day -- */
  let explicitMonth = false
  if (dayOffset === null) {
    const monthDay = take(MONTH_DAY_PATTERN)
    if (monthDay !== null) {
      const month = Number(monthDay[1] ?? monthDay[3])
      const day = Number(monthDay[2] ?? monthDay[4])
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        explicitMonth = true
        target = new Date(base.getFullYear(), month - 1, day, 0, 0, 0, 0)
      }
    }
  }

  /* ------------------------------------------------------------- clock -- */
  let hour: number | null = null
  let minute = 0
  const clock = take(HOUR_PATTERN)
  if (clock !== null) {
    const rawHour = chineseNumber(clock[1]!)
    const rawMinute = clock[2] === '半' ? 30 : clock[2] === undefined ? 0 : chineseNumber(clock[2])
    if (rawHour !== null && rawHour <= 24 && rawMinute !== null && rawMinute < 60) {
      hour = rawHour
      minute = rawMinute
      const prefix = clock[0].match(/凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|晚|早/)?.[0]
      const shift = prefix === undefined ? 0 : (MERIDIEM[prefix] ?? 0)
      if (shift === 12 && hour < 12) hour += 12
      if (shift === 12 && hour === 12 && prefix !== '中午') hour = 12
      if (prefix === '中午' && hour < 12) hour = 12
    }
  }

  /* ------------------------------------------------- bare time-of-day --- */
  if (hour === null) {
    const bare = take(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)/)
    if (bare !== null) hour = BARE_TIME[bare[1]!] ?? 9
  }

  const rest = cleanTitle(text)

  if (target !== null) {
    // Explicit month/day: keep the clock if one was given.
    const day = new Date(target)
    if (hour !== null) day.setHours(hour, minute, 0, 0)
    else day.setHours(9, 0, 0, 0)
    if (explicitMonth && day.getTime() < base.getTime()) {
      // No year given: the next occurrence is next year.
      day.setFullYear(day.getFullYear() + 1)
    }
    return {
      dueAt: day.toISOString(),
      title: rest,
      matched: consumed.join(' '),
      label: formatLabel(day, base),
    }
  }

  if (dayOffset !== null || hour !== null) {
    const offset = dayOffset ?? 0
    const candidate = at(base, offset, hour ?? 9, minute)
    if (dayOffset === null && candidate.getTime() <= base.getTime()) {
      // A bare clock time that already passed today means tomorrow.
      candidate.setDate(candidate.getDate() + 1)
    } else if (dayOffset !== null && rollDays > 0 && hour !== null && candidate.getTime() <= base.getTime()) {
      candidate.setDate(candidate.getDate() + rollDays)
    }
    return {
      dueAt: candidate.toISOString(),
      title: rest,
      matched: consumed.join(' '),
      label: formatLabel(candidate, base),
    }
  }

  return { dueAt: null, title: cleanTitle(original), matched: '', label: '' }
}
