/**
 * Sticker import accepts what chat platforms actually produce.
 *
 * QQ/OneBot saves incoming images as `<stem>_<ts>_<rand>.image`, so an
 * extension whitelist rejected every real chat image — the auto-collection
 * feature could not work in practice. The bytes decide the format; the name is
 * only a hint. These tests pin that, and pin that a renamed non-image is still
 * refused.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanup } from '../helpers.js'
import { StickerStore } from '../../src/host/companion/stickers.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanup(root)
})

async function makeStore(): Promise<StickerStore> {
  const dir = await mkdtemp(join(tmpdir(), 'sticker-ext-'))
  roots.push(dir)
  return new StickerStore({ vaultPath: () => dir })
}

describe('import with non-standard extensions', () => {
  it('accepts a QQ-style `.image` name and stores the sniffed extension', async () => {
    const store = await makeStore()
    const result = await store.importBytes(new Uint8Array(PNG), '1712345678_ab12cd34.image', { tags: ['开心'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.ext).toBe('png')
    expect(result.record.file.endsWith('.png')).toBe(true)
  })

  it('accepts a name with no extension at all', async () => {
    const store = await makeStore()
    const result = await store.importBytes(new Uint8Array(GIF), 'download', {})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.ext).toBe('gif')
  })

  it('accepts a mismatched but harmless extension, trusting the bytes', async () => {
    const store = await makeStore()
    const result = await store.importBytes(new Uint8Array(PNG), 'actually-a-gif.gif', {})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.ext).toBe('png')
  })

  it('still refuses a renamed executable', async () => {
    const store = await makeStore()
    const fake = Buffer.from('MZ\x90\x00not really an image', 'latin1')
    const result = await store.importBytes(new Uint8Array(fake), 'payload.image', {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/unsupported image format/)
  })

  it('refuses an empty file and an oversized one', async () => {
    const store = await makeStore()
    expect((await store.importBytes(new Uint8Array(0), 'empty.png')).ok).toBe(false)
    const huge = Buffer.alloc(5 * 1024 * 1024 + 1)
    huge.set([0x89, 0x50, 0x4e, 0x47])
    expect((await store.importBytes(new Uint8Array(huge), 'huge.png')).ok).toBe(false)
  })
})
