/**
 * Dictionary parity and coverage for the new Life Agent panes.
 *
 * The panel is bilingual by construction: Chinese is the source of truth and
 * English is kept complete. Nothing enforced that before, so a key added to one
 * dictionary and forgotten in the other silently rendered as a raw `life.*`
 * identifier (the `t()` fallback chain never fails loudly by design).
 *
 * This test is the enforcement point. It checks three things:
 *
 *  1. the two dictionaries carry exactly the same keys — no key may exist in
 *     only one language;
 *  2. no value is empty or whitespace-only (an empty string renders as nothing,
 *     which looks like a layout bug rather than a missing translation);
 *  3. every `life.*` key the panes actually call is present, in both languages.
 */
import { describe, expect, it } from 'vitest'

import { EN, ZH } from '../../src/client/i18n.js'

const keys = (dict: Record<string, string>): string[] => Object.keys(dict).sort()

/**
 * Keys the WP-6 panes pass to `t()`. Kept explicit rather than derived from
 * source because a regex over JSX would be both fragile and able to "pass" by
 * matching nothing.
 */
const LIFE_KEYS = [
  'nav.life',
  'life.tab.overview', 'life.tab.persona', 'life.tab.sharing', 'life.tab.review',
  'life.tab.stickers', 'life.tab.reminders', 'life.tab.privacy', 'life.tab.diagnostics',
  'life.common.bound', 'life.common.unbound', 'life.common.unavailable', 'life.common.default',
  'life.common.save', 'life.common.contract', 'life.common.status', 'life.common.pendingE2E',
  'life.error.staleBackendTitle', 'life.error.staleBackend',
  'life.overview.title', 'life.overview.vault', 'life.overview.memories', 'life.overview.owner',
  'life.overview.persona', 'life.overview.needBinding',
  'life.persona.title', 'life.persona.hint', 'life.persona.usingDefault', 'life.persona.unavailable',
  'life.persona.name', 'life.persona.identity', 'life.persona.temperament', 'life.persona.address',
  'life.persona.language', 'life.persona.tone', 'life.persona.boundaries',
  'life.persona.presets', 'life.persona.presetHint',
  'life.preset.steady.label', 'life.preset.steady.tagline',
  'life.preset.study.label', 'life.preset.study.tagline',
  'life.preset.coach.label', 'life.preset.coach.tagline',
  'life.preset.engineer.label', 'life.preset.engineer.tagline',
  'life.preset.warm.label', 'life.preset.warm.tagline',
  'life.preset.candid.label', 'life.preset.candid.tagline',
  'life.tone.gentle', 'life.tone.lively', 'life.tone.rational', 'life.tone.humorous',
  'life.sharing.title', 'life.sharing.warning', 'life.sharing.shared', 'life.sharing.desktopPrivate',
  'life.sharing.qqPrivate', 'life.sharing.empty', 'life.sharing.apply',
  'life.review.title', 'life.review.hint', 'life.review.empty', 'life.review.shareOnConfirm',
  'life.review.confirm', 'life.review.reject',
  'life.stickers.title', 'life.stickers.owner', 'life.stickers.boundary', 'life.stickers.default',
  'life.stickers.unavailable', 'life.stickers.storage', 'life.stickers.total',
  'life.stickers.enabledCount', 'life.stickers.rejected', 'life.stickers.empty',
  'life.stickers.import', 'life.stickers.importHint', 'life.stickers.tags',
  'life.stickers.descPlaceholder', 'life.stickers.tagsPlaceholder', 'life.stickers.used',
  'life.stickers.favorite', 'life.stickers.enable', 'life.stickers.disable',
  'life.stickers.deleteConfirm',
  'life.reminders.title', 'life.reminders.owner', 'life.reminders.boundary', 'life.reminders.default',
  'life.reminders.unavailable', 'life.reminders.store', 'life.reminders.storeVault',
  'life.reminders.storePlugin', 'life.reminders.queue', 'life.reminders.window',
  'life.reminders.windowOpen', 'life.reminders.windowClosed', 'life.reminders.empty',
  'life.reminders.create', 'life.reminders.titleField', 'life.reminders.dueField',
  'life.reminders.noteField', 'life.reminders.cancel', 'life.reminders.complete',
  'life.reminders.deferred', 'life.reminders.delivered', 'life.reminders.waiting',
  'life.reminders.cancelled', 'life.reminders.reschedule',
  'life.privacy.title', 'life.privacy.unbindHint', 'life.privacy.unbind',
  'life.diagnostics.title', 'life.diagnostics.linkage', 'life.diagnostics.personaProblems',
] as const

/** Shared primitives the panes compose with. */
const SHARED_KEYS = [
  'common.loading', 'common.cancel', 'common.save', 'common.delete', 'common.listSep',
] as const

describe('i18n dictionaries stay in lockstep', () => {
  it('zh and en define exactly the same keys', () => {
    expect(keys(EN)).toEqual(keys(ZH))
  })

  it('no entry is empty or whitespace-only', () => {
    const blank = [
      ...Object.entries(ZH).filter(([, value]) => value.trim().length === 0).map(([key]) => `zh:${key}`),
      ...Object.entries(EN).filter(([, value]) => value.trim().length === 0).map(([key]) => `en:${key}`),
    ]
    expect(blank).toEqual([])
  })

  it('every Life pane key exists in both languages', () => {
    const missing: string[] = []
    for (const key of [...LIFE_KEYS, ...SHARED_KEYS]) {
      if (ZH[key] === undefined) missing.push(`zh:${key}`)
      if (EN[key] === undefined) missing.push(`en:${key}`)
    }
    expect(missing).toEqual([])
  })

  it('placeholders match across languages for the same key', () => {
    const names = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()
    const mismatched: string[] = []
    for (const key of Object.keys(ZH)) {
      const zhValue = ZH[key]
      const enValue = EN[key]
      if (zhValue === undefined || enValue === undefined) continue
      const zhNames = names(zhValue)
      const enNames = names(enValue)
      if (zhNames.length !== enNames.length || zhNames.some((name, index) => name !== enNames[index])) {
        mismatched.push(`${key} zh={${zhNames.join(',')}} en={${enNames.join(',')}}`)
      }
    }
    expect(mismatched).toEqual([])
  })
})
