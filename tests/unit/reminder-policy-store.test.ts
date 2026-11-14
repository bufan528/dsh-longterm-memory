/**
 * Reminder policy persistence round-trip.
 *
 * This file exists because of a real bug: `readPolicy` used to normalise the
 * `{ schemaVersion, policy }` wrapper instead of the policy itself, so every
 * read returned defaults and a user's quiet hours silently vanished. Reading
 * back what was written is the whole contract, so it gets its own test.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanup } from '../helpers.js'
import { ReminderStore } from '../../src/host/tasks/reminder-store.js'
import { ReminderService } from '../../src/host/tasks/reminder-service.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanup(root)
})

async function makeService(): Promise<{ service: ReminderService; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'reminder-policy-'))
  roots.push(dir)
  const store = new ReminderStore({ vaultPath: () => dir })
  return { service: new ReminderService(store), dir }
}

describe('reminder policy persistence', () => {
  it('reads back exactly what was written', async () => {
    const { service } = await makeService()
    const written = await service.updatePolicy({ quietHours: { start: 23, end: 7 }, backoffBase: 2, backoffMinutes: 30, maxAttempts: 3 })
    expect(written.quietHours).toEqual({ start: 23, end: 7 })
    const read = await service.policy()
    expect(read).toEqual({ quietHours: { start: 23, end: 7 }, backoffBase: 2, backoffMinutes: 30, maxAttempts: 3 })
  })

  it('keeps quiet hours of 0-23 range including zero', async () => {
    // `0` is falsy, and the previous bug dropped it along with the wrapper.
    const { service } = await makeService()
    await service.updatePolicy({ quietHours: { start: 0, end: 23 } })
    expect((await service.policy()).quietHours).toEqual({ start: 0, end: 23 })
  })

  it('turning quiet hours off survives a re-read', async () => {
    const { service } = await makeService()
    await service.updatePolicy({ quietHours: null })
    expect((await service.policy()).quietHours).toBeNull()
  })

  it('writes a versioned file beside the notes', async () => {
    const { service, dir } = await makeService()
    await service.updatePolicy({ backoffMinutes: 5 })
    const raw = JSON.parse(await readFile(join(dir, 'Reminders', 'policy.json'), 'utf8')) as Record<string, unknown>
    expect(raw['schemaVersion']).toBe(1)
    expect((raw['policy'] as Record<string, unknown>)['backoffMinutes']).toBe(5)
  })

  it('falls back to defaults when the file is corrupt', async () => {
    const { service, dir } = await makeService()
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'Reminders'), { recursive: true })
    await writeFile(join(dir, 'Reminders', 'policy.json'), '{not json', 'utf8')
    const policy = await service.policy()
    expect(policy.backoffBase).toBe(1.6)
  })
})
