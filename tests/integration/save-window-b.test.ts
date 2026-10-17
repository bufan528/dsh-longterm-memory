/**
 * Save commit window B: real process termination and recovery (round 20).
 *
 * A child process performs a real `save` through the compiled plugin and is
 * force-killed (`SIGKILL`) at one of three commit boundaries. The parent then starts a
 * fresh service instance on the same vault and verifies what recovery decided from the
 * persisted commit evidence (target path + before/after checksums).
 *
 * @module tests/integration/save-window-b.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempRoot } from '../helpers.js'
import { MemoryService } from '../../src/host/core/service.js'

let root: string
let vault: string

const CHILD = join(process.cwd(), 'tests', 'support', 'child-save-crash.mjs')
const meta = () => join(vault, '.dsh-memory')
const pendingDir = () => join(meta(), 'journal-pending')

function newService(): MemoryService {
  return new MemoryService({ configuredVaultPath: vault })
}

interface ChildResult {
  code: number | null
  signal: NodeJS.Signals | null
  boundaryConfirmed: boolean
  stderr: string
}

/** Run the crash child to completion (it kills itself) and report how it ended. */
async function runCrashChild(phase: 'after-stage' | 'after-write' | 'after-commit', marker: string): Promise<ChildResult> {
  return await new Promise<ChildResult>((resolvePromise) => {
    const child = spawn(process.execPath, [CHILD, vault, phase, marker], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code, signal) => {
      resolvePromise({ code, signal, boundaryConfirmed: existsSync(join(vault, `.crash-${phase}`)), stderr })
    })
    child.on('error', () => resolvePromise({ code: null, signal: null, boundaryConfirmed: false, stderr }))
  })
}

async function notesWith(marker: string): Promise<string[]> {
  const files = await readdir(vault, { recursive: true }).catch(() => [] as string[])
  const matched: string[] = []
  for (const file of files) {
    if (!String(file).endsWith('.md') || String(file).includes('Index') || String(file).includes('.dsh-memory')) continue
    const text = await readFile(join(vault, String(file)), 'utf8').catch(() => '')
    if (text.includes(marker)) matched.push(String(file))
  }
  return matched
}

/** Pending events whose payload mentions `marker` (i.e. the save intent under test). */
async function pendingFor(marker: string): Promise<number> {
  const names = (await readdir(pendingDir()).catch(() => [] as string[])).filter((name) => name.endsWith('.json'))
  let count = 0
  for (const name of names) {
    const raw = await readFile(join(pendingDir(), name), 'utf8').catch(() => '')
    if (raw.includes(marker)) count += 1
  }
  return count
}


function monthFiles(): Promise<string[]> {
  return readdir(join(meta(), 'journal')).then((names) => names.filter((name) => name.endsWith('.jsonl')).map((name) => join(meta(), 'journal', name))).catch(() => [])
}

beforeEach(async () => {
  root = await makeTempRoot('save-window-b')
  vault = join(root, 'DSH Memory')
  // The child needs a vault whose directories exist; initialize once in-process.
  const service = newService()
  await service.initialize(vault)
})

afterEach(async () => {
  await cleanup(root)
})

describe('real process termination around the save commit boundary', () => {
  it('build output is present (the child runs the compiled plugin)', () => {
    expect(existsSync(join(process.cwd(), 'lib', 'host', 'core', 'service.js')), 'run `npm run build` before this suite').toBe(true)
  })

  it('T1: killed after PREPARED, before the memory write → intent is abandoned', async () => {
    const marker = 'WINDOW-B-T1-4411'
    const result = await runCrashChild('after-stage', marker)
    expect(result.boundaryConfirmed, `child did not reach the boundary: ${result.stderr}`).toBe(true)
    expect(result.signal === 'SIGKILL' || result.code !== 0).toBe(true)

    // Nothing was written; the crash left a PREPARED intent behind.
    expect(await notesWith(marker)).toEqual([])
    expect(await pendingFor(marker)).toBe(1)

    const recovered = newService()
    await recovered.initialize(vault)
    expect(await pendingFor(marker)).toBe(0) // safely discarded
    expect(await notesWith(marker)).toEqual([])
    expect(JSON.stringify(await recovered.history(undefined, 20))).not.toContain(marker)

    // The fault is gone: a normal save now works and is the only copy.
    await recovered.save({ type: 'knowledge', title: marker, summary: `${marker} 正文。`, tags: [], confidence: 'high', importance: 50 })
    expect((await notesWith(marker)).length).toBe(1)
  })

  it('T2: killed after the Markdown write, before COMMITTED → recovery commits history', async () => {
    const marker = 'WINDOW-B-T2-5522'
    const result = await runCrashChild('after-write', marker)
    expect(result.boundaryConfirmed, `child did not reach the boundary: ${result.stderr}`).toBe(true)
    expect(result.signal === 'SIGKILL' || result.code !== 0).toBe(true)

    // The domain write is complete and self-consistent.
    const before = await notesWith(marker)
    expect(before.length).toBe(1)
    const content = await readFile(join(vault, before[0] as string), 'utf8')
    expect(content).toContain(marker)
    expect(content).toContain('## 核心内容')
    const id = /^id: (\S+)$/m.exec(content)?.[1]
    expect(id).toBeTruthy()
    // The crash left the event PREPARED (not yet COMMITTED).
    expect(await pendingFor(marker)).toBe(1)

    // A fresh instance must promote it to committed history without re-writing.
    const recovered = newService()
    await recovered.initialize(vault)
    expect(await pendingFor(marker)).toBe(0)
    expect(await notesWith(marker)).toEqual(before) // no duplicate record, no rewrite
    const history = await recovered.history(undefined, 50)
    expect(history.some((entry) => entry.id === id)).toBe(true)

    // Re-running recovery is idempotent: one file, one archived event.
    const again = newService()
    await again.initialize(vault)
    expect(await notesWith(marker)).toEqual(before)
    let occurrences = 0
    for (const file of await monthFiles()) {
      // Count event records by id field, not raw substrings: the saved path also
      // contains the id and would double-count within a single line.
      occurrences += (await readFile(file, 'utf8')).split(`"id":"${String(id)}"`).length - 1
    }
    expect(occurrences).toBe(1)
  })

  it('T3: killed after COMMITTED, before the monthly archive → outbox finishes on start', async () => {
    const marker = 'WINDOW-B-T3-6633'
    const result = await runCrashChild('after-commit', marker)
    expect(result.boundaryConfirmed, `child did not reach the boundary: ${result.stderr}`).toBe(true)
    expect(result.signal === 'SIGKILL' || result.code !== 0).toBe(true)

    expect((await notesWith(marker)).length).toBe(1)
    expect(await pendingFor(marker)).toBe(1)

    const recovered = newService()
    await recovered.initialize(vault)
    expect(await pendingFor(marker)).toBe(0)
    expect((await notesWith(marker)).length).toBe(1)
    const history = await recovered.history(undefined, 50)
    const id = /^id: (\S+)$/m.exec(await readFile(join(vault, (await notesWith(marker))[0] as string), 'utf8'))?.[1]
    expect(history.some((entry) => entry.id === id)).toBe(true)
    let occurrences = 0
    for (const file of await monthFiles()) {
      // Count event records by id field, not raw substrings: the saved path also
      // contains the id and would double-count within a single line.
      occurrences += (await readFile(file, 'utf8')).split(`"id":"${String(id)}"`).length - 1
    }
    expect(occurrences).toBe(1)
  })

  it('a pending save whose target matches neither state is reported as a conflict', async () => {
    // Craft a PREPARED save intent whose target content matches nothing recorded.
    await mkdir(pendingDir(), { recursive: true })
    const eventId = 'conflict-event-0001'
    await writeFile(
      join(pendingDir(), `${eventId}.json`),
      JSON.stringify({
        eventId,
        at: new Date().toISOString(),
        op: 'create',
        id: 'mem_conflict_probe',
        reason: 'conflict probe',
        state: 'prepared',
        saveMetadata: { kind: 'save', path: 'Knowledge/never-written-mem_conflict_probe.md', before: 'aaaaaaaa', after: 'deadbeef' },
      }),
      'utf8',
    )
    const recovered = newService()
    await recovered.initialize(vault)
    // The event is kept (not discarded) and history refuses to look complete.
    expect(await pendingFor('mem_conflict_probe')).toBe(1)
    await expect(recovered.history(undefined, 20)).rejects.toThrow(/冲突|不完整/)
    const preserved = await readFile(join(pendingDir(), `${eventId}.json`), 'utf8')
    expect(preserved).toContain('mem_conflict_probe')
  })
})
