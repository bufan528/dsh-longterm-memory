/**
 * `fillAnchors`: upgrade an old persona file without losing the user's text.
 *
 * Persona files written before the style anchors existed have no scenario,
 * catchphrases, avoid list or examples. Applying a preset would fix that by
 * overwriting everything; this path exists so the user does not have to choose
 * between "old persona" and "someone else's persona".
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CompanionService } from '../../src/host/companion/service.js'

const roots: string[] = []

afterEach(() => {
  roots.length = 0
})

async function makeVault(): Promise<{ root: string; service: CompanionService }> {
  const root = await mkdtemp(join(tmpdir(), 'companion-anchors-'))
  roots.push(root)
  await mkdir(join(root, 'Companion'), { recursive: true })
  return { root, service: new CompanionService(() => root) }
}

/** The file shape produced by the version before anchors existed. */
async function writeLegacyPersona(root: string, name: string): Promise<void> {
  const dir = join(root, 'Companion')
  await writeFile(join(dir, 'Persona.md'), [
    '# Companion · Persona', '',
    `name: ${name}`,
    'identity: 一个稳定、克制的个人 AI 伙伴。',
    'temperament: 温和',
    'address: 你',
    'language_habits: 简短直接。',
    'boundaries: 不假装真实人类, 不制造情感依赖',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(dir, 'Speaking Style.md'), 'tone: gentle\nnotes: ', 'utf8')
  await writeFile(join(dir, 'Behavior Policy.md'),
    'pretend_human: false\nemotional_dependency: false\nquiet_triggers: 安静\nstop_triggers: 停止', 'utf8')
}

describe('CompanionService.fillAnchors', () => {
  it('只补空项：用户写过的名字和身份不动，示例对话来自预设', async () => {
    const { root, service } = await makeVault()
    await writeLegacyPersona(root, '老步的伙伴')

    const before = await service.load()
    expect(before.persona.examples).toEqual([])

    const after = await service.fillAnchors('candid')
    expect(after.persona.name).toBe('老步的伙伴')
    expect(after.persona.identity).toBe('一个稳定、克制的个人 AI 伙伴。')
    expect(after.persona.examples.length).toBeGreaterThanOrEqual(3)
    expect(after.persona.catchphrases.length).toBeGreaterThanOrEqual(2)
    expect(after.persona.avoid.length).toBeGreaterThanOrEqual(2)
    expect(after.persona.scenario).not.toBe('')

    // Written to disk, not just in memory.
    const personaFile = await readFile(join(root, 'Companion', 'Persona.md'), 'utf8')
    expect(personaFile).toContain('example1_user:')
    expect(personaFile).toContain('catchphrases:')
    expect(personaFile).toContain('name: 老步的伙伴')
  })

  it('已有示例对话时不再覆盖', async () => {
    const { root, service } = await makeVault()
    await writeLegacyPersona(root, '伙伴')
    await service.fillAnchors('steady')
    const first = await service.load()

    await service.fillAnchors('coach')
    const second = await service.load()

    expect(second.persona.examples).toEqual(first.persona.examples)
    expect(second.persona.catchphrases).toEqual(first.persona.catchphrases)
  })

  it('未知预设被拒绝，磁盘内容保持原样', async () => {
    const { root, service } = await makeVault()
    await writeLegacyPersona(root, '伙伴')
    const before = await readFile(join(root, 'Companion', 'Persona.md'), 'utf8')

    await expect(service.fillAnchors('nope')).rejects.toThrow()
    expect(await readFile(join(root, 'Companion', 'Persona.md'), 'utf8')).toBe(before)
  })
})
