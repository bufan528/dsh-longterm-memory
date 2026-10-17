/**
 * Official manifest metadata checks (RR-8 / G1).
 *
 * DSH reads display metadata from `locale/<lang>.json` under `meta.title` /
 * `meta.description`; a flat `{ title, description }` file silently falls back to
 * `package.json.name`. These tests pin the official shape and the packaging fields.
 *
 * @module tests/unit/locale-manifest.test.ts
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  icon?: string
  files?: string[]
  exports?: Record<string, unknown>
  engines?: Record<string, string>
  dsh?: Record<string, unknown>
}

describe('DSH manifest display metadata', () => {
  for (const language of ['en', 'zh']) {
    it(`locale/${language}.json uses the official meta.title/meta.description shape`, () => {
      const file = join(root, 'locale', `${language}.json`)
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        meta?: { title?: unknown; description?: unknown }
        title?: unknown
      }
      expect(parsed.meta, `${language}: must nest display metadata under "meta"`).toBeDefined()
      expect(typeof parsed.meta?.title).toBe('string')
      expect((parsed.meta?.title as string).trim().length).toBeGreaterThan(0)
      expect(typeof parsed.meta?.description).toBe('string')
      expect((parsed.meta?.description as string).trim().length).toBeGreaterThan(0)
      // A flat title is the exact mistake that made DSH fall back to the package name.
      expect(parsed.title, `${language}: legacy flat title must not remain`).toBeUndefined()
    })
  }

  it('declares a self-contained icon within the official size limit', () => {
    expect(typeof pkg.icon).toBe('string')
    const icon = join(root, pkg.icon as string)
    expect(existsSync(icon)).toBe(true)
    expect(statSync(icon).size).toBeLessThanOrEqual(256 * 1024)
    expect((pkg.files ?? []).some((entry) => entry.replace(/^\.\//, '') === pkg.icon?.replace(/^\.\//, ''))).toBe(true)
  })

  it('publishes locale files and the package manifest', () => {
    expect((pkg.files ?? []).some((entry) => entry.includes('locale/'))).toBe(true)
    expect((pkg.exports ?? {})['./locale/*.json']).toBeDefined()
    expect((pkg.exports ?? {})['./package.json']).toBeDefined()
  })

  it('keeps engines.dsh as the single compatibility source', () => {
    const range = pkg.engines?.['dsh'] ?? ''
    expect(range).toMatch(/^>=/)
    expect(range).toContain('0.2.1-rc.2')
    // dsh.bundle/dsh.client are the official bundle declarations.
    expect(pkg.dsh?.['bundle']).toBeDefined()
    expect(pkg.dsh?.['client']).toBeDefined()
  })
})
