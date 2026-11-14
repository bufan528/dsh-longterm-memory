/**
 * The sticker-capture prompt hint.
 *
 * A prompt block is behaviour: it decides whether the model saves nothing or
 * saves everything. These assertions pin the three parts that make it safe — the
 * path it must use, the things it must not capture, and the cap.
 */
import { describe, expect, it } from 'vitest'

import { composeStandingBlock, stickerCollectHint } from '../../src/host/dsh/inject.js'

describe('stickerCollectHint', () => {
  it('tells the model which path to use', () => {
    expect(stickerCollectHint('zh')).toContain('Image: <路径>')
    expect(stickerCollectHint('en')).toContain('Image: <path>')
  })

  it('names the tool it is allowed to call', () => {
    expect(stickerCollectHint('zh')).toContain('sticker_ingest')
    expect(stickerCollectHint('en')).toContain('sticker_ingest')
  })

  it('lists the things that must not be captured', () => {
    const zh = stickerCollectHint('zh')
    for (const negative of ['截图', '文档', '真人照片', '二维码']) expect(zh).toContain(negative)
    const en = stickerCollectHint('en')
    for (const negative of ['screenshots', 'document', 'real people', 'QR']) expect(en).toContain(negative)
  })

  it('states the per-day cap', () => {
    expect(stickerCollectHint('zh')).toContain('3 张')
    expect(stickerCollectHint('en')).toContain('three per day')
  })

  it('stays short enough to ride along every turn', () => {
    // Roughly 200 tokens is the ceiling; longer than that and it competes with
    // the memory block it is appended to.
    expect(stickerCollectHint('zh').length).toBeLessThan(600)
    expect(stickerCollectHint('en').length).toBeLessThan(800)
  })

  it('starts on a new line so it cannot glue itself to the last memory item', () => {
    expect(stickerCollectHint('zh').startsWith('\n')).toBe(true)
    expect(stickerCollectHint('en').startsWith('\n')).toBe(true)
  })
})

describe('composeStandingBlock', () => {
  it('leaves the memory block untouched when capture is off', () => {
    expect(composeStandingBlock('长期记忆：偏好简体中文。', { stickerCollect: false, language: 'zh' }))
      .toBe('长期记忆：偏好简体中文。')
  })

  it('appends the hint after the memory block when on', () => {
    const composed = composeStandingBlock('长期记忆：偏好简体中文。', { stickerCollect: true, language: 'zh' })
    expect(composed.startsWith('长期记忆：偏好简体中文。')).toBe(true)
    expect(composed).toContain('## 表情收录')
  })

  it('never turns an empty block into a hint-only block', () => {
    // The host treats "empty text" as "no section"; a hint alone would break that.
    expect(composeStandingBlock('', { stickerCollect: true, language: 'en' })).toBe('')
    expect(composeStandingBlock('   ', { stickerCollect: true, language: 'zh' })).toBe('   ')
  })

  it('uses the language it is given', () => {
    expect(composeStandingBlock('记忆', { stickerCollect: true, language: 'en' })).toContain('Sticker capture')
    expect(composeStandingBlock('记忆', { stickerCollect: true, language: 'zh' })).toContain('表情收录')
  })
})
