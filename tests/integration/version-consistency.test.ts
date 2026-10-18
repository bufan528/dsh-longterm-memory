/** F1 regression: version declarations cannot drift from engines.dsh (RR-3). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'

const SCRIPT = join(process.cwd(), 'scripts', 'check-version-consistency.mjs')
let root: string

function runIn(cwd: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, output }
  } catch (error) {
    const caught = error as { status?: number; stdout?: string; stderr?: string }
    return { code: caught.status ?? 1, output: `${caught.stdout ?? ''}${caught.stderr ?? ''}` }
  }
}

async function fixture(modify: (dir: string) => Promise<void>): Promise<string> {
  const dir = await makeTempRoot('version-consistency')
  await mkdir(join(dir, 'docs'), { recursive: true })
  await cp(join(process.cwd(), 'package.json'), join(dir, 'package.json'))
  await cp(join(process.cwd(), 'README.md'), join(dir, 'README.md'))
  await cp(join(process.cwd(), 'docs', 'compatibility.md'), join(dir, 'docs', 'compatibility.md'))
  await modify(dir)
  return dir
}

beforeEach(async () => { root = await makeTempRoot('version-root') })
afterEach(async () => { await cleanup(root) })

describe('version consistency check', () => {
  it('accepts the current declarations', () => {
    expect(runIn(process.cwd()).code).toBe(0)
  })

  it('detects a stale compatibility entry', async () => {
    const dir = await fixture(async (target) => {
      const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
      pkg.dsh.compatibility.dshReleases = { '0.2.0-rc.2': 'compatible' }
      await writeFile(join(target, 'package.json'), JSON.stringify(pkg), 'utf8')
    })
    expect(runIn(dir).code).toBe(1)
    await cleanup(dir)
  })

  it('detects README drift from engines.dsh', async () => {
    const dir = await fixture(async (target) => {
      const readme = await readFile(join(target, 'README.md'), 'utf8')
      const drifted = readme
        .replace(/(Verified DSH version\s*\|\s*`?)([0-9][^`|\s]*)/, '$19.9.9')
        .replace(/(已验证的\s*DSH\s*版本[^0-9]*)([0-9][^`|\s]*)/, '$19.9.9')
      await writeFile(join(target, 'README.md'), drifted, 'utf8')
    })
    expect(runIn(dir).code).toBe(1)
    await cleanup(dir)
  })
})
