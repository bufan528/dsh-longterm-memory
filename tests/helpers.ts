/**
 * Test helpers: real temporary directories under the project's own scratch area.
 *
 * Nothing here writes outside the workspace, and every created root is removed
 * by the caller's `afterEach`.
 *
 * @module tests/helpers
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const SCRATCH = resolve(import.meta.dirname, '..', '.scratch')

export async function makeTempRoot(label: string): Promise<string> {
  await mkdir(SCRATCH, { recursive: true })
  return mkdtemp(join(SCRATCH, `${label}-`))
}

export async function cleanup(root: string): Promise<void> {
  // A sandboxed runner refuses bulk recursive deletes (the guard trips at ~50
  // removals in one turn). Keeping the temp roots is harmless — they live under
  // `tests/../.scratch` — so an opt-out is available instead of a flaky suite.
  if (process.env['DSH_MEMORY_KEEP_TMP'] === '1') return
  // Windows can hold a transient handle on a just-written file; retry briefly.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 60))
    }
  }
}

export async function readIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null
  return readFile(path, 'utf8')
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

export function osTemp(): string {
  return tmpdir()
}
