/**
 * The plugin's own `language` setting must control its own strings.
 *
 * Regression: when the host `locale` service was present (the desktop and web
 * apps always provide it), the bound host translator was consulted *first*, so
 * switching the plugin to English had no visible effect: the host's language
 * kept winning. The setting is an explicit user choice and must win; the bound
 * translator is only a fallback for keys this bundle does not ship.
 *
 * @module tests/unit/i18n-language.test
 */

import { afterEach, describe, expect, it } from 'vitest'
import { getLanguage, setBoundTranslator, setLanguage, subscribeLanguage, t } from '../../src/client/i18n.js'

afterEach(() => {
  setBoundTranslator(null)
  setLanguage('zh')
})

describe('plugin language vs host locale service', () => {
  it('applies the plugin language setting in both directions', () => {
    expect(t('panel')).toBe('长期记忆')
    setLanguage('en')
    expect(getLanguage()).toBe('en')
    expect(t('panel')).toBe('Long-term memory')
    expect(t('nav.inbox')).toBe('Inbox')
    setLanguage('zh')
    expect(t('panel')).toBe('长期记忆')
  })

  it('ignores the bound host translator for keys the plugin ships', () => {
    setBoundTranslator((key) => `HOST:${key}`)
    expect(t('panel')).toBe('长期记忆')
    setLanguage('en')
    expect(t('panel')).toBe('Long-term memory')
  })

  it('uses the bound host translator only for keys the plugin does not ship', () => {
    setBoundTranslator((key) => `HOST:${key}`)
    expect(t('host.only.key')).toBe('HOST:host.only.key')
  })

  it('returns the raw key when neither source knows it', () => {
    expect(t('host.only.key')).toBe('host.only.key')
  })

  it('interpolates placeholders in the active language', () => {
    setLanguage('en')
    expect(t('common.selected', { count: 3 })).toBe('3 selected')
    setLanguage('zh')
    expect(t('common.selected', { count: 3 })).toBe('已选 3 项')
  })

  it('notifies subscribers exactly once per real language change', () => {
    const calls: string[] = []
    const dispose = subscribeLanguage(() => {
      calls.push(getLanguage())
    })
    setLanguage('en')
    setLanguage('en')
    setLanguage('zh')
    dispose()
    setLanguage('en')
    expect(calls).toEqual(['en', 'zh'])
  })
})
