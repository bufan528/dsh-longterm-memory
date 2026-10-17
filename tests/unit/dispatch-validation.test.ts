/**
 * HTTP boundary validation for write routes (RR-8 / P0-2).
 *
 * `dispatch` must reject malformed payloads before delegating to the service, so a
 * bad HTTP body can never reach a write path through a type-only cast.
 *
 * @module tests/unit/dispatch-validation.test.ts
 */

import { describe, expect, it } from 'vitest'
import { dispatch } from '../../src/host/dsh/routes.js'
import type { MemoryService } from '../../src/host/core/service.js'

interface Calls {
  save: number
  merge: number
  addCandidate: number
  setSettings: number
}

function fakeService(calls: Calls): MemoryService {
  return {
    save: async () => {
      calls.save += 1
      return { id: 'mem_x', created: true, repairs: [], warnings: [] }
    },
    merge: async () => {
      calls.merge += 1
      return { id: 'mem_x', mergedIds: [] }
    },
    addCandidate: (input: unknown) => {
      calls.addCandidate += 1
      void input
      return { id: 'mem_x' }
    },
    setSettings: async () => {
      calls.setSettings += 1
      return {}
    },
  } as unknown as MemoryService
}

function emptyCalls(): Calls {
  return { save: 0, merge: 0, addCandidate: 0, setSettings: 0 }
}

describe('dispatch rejects malformed write payloads before the service', () => {
  it('rejects a merge whose ids is not a string array', async () => {
    const calls = emptyCalls()
    await expect(dispatch(fakeService(calls), 'merge', { ids: 'mem_a,mem_b' })).rejects.toMatchObject({ code: 'invalid-request' })
    expect(calls.merge).toBe(0)
  })

  it('rejects a merge with non-string ids', async () => {
    const calls = emptyCalls()
    await expect(dispatch(fakeService(calls), 'merge', { ids: [1, 2], targetId: 2 })).rejects.toMatchObject({ code: 'invalid-request' })
    expect(calls.merge).toBe(0)
  })

  it('rejects an addCandidate with a non-string title or summary', async () => {
    const calls = emptyCalls()
    await expect(dispatch(fakeService(calls), 'addCandidate', { type: 'knowledge', title: 42, summary: 'x' })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(dispatch(fakeService(calls), 'addCandidate', { type: 'knowledge', title: 'ok', summary: ['x'] })).rejects.toMatchObject({ code: 'invalid-request' })
    expect(calls.addCandidate).toBe(0)
  })

  it('rejects a save with wrong field types', async () => {
    const calls = emptyCalls()
    await expect(
      dispatch(fakeService(calls), 'save', { type: 'knowledge', title: 42, summary: 'x', tags: 'a', confidence: 'high', importance: 50 }),
    ).rejects.toMatchObject({ code: 'invalid-request' })
    expect(calls.save).toBe(0)
  })

  it('rejects invalid settings types', async () => {
    const calls = emptyCalls()
    await expect(dispatch(fakeService(calls), 'setSettings', { recallMaxItems: 'many' })).rejects.toMatchObject({ code: 'invalid-request' })
    expect(calls.setSettings).toBe(0)
  })

  it('accepts a well-formed save payload', async () => {
    const calls = emptyCalls()
    await dispatch(fakeService(calls), 'save', {
      type: 'knowledge',
      title: '合法标题',
      summary: '合法正文。',
      tags: [],
      confidence: 'high',
      importance: 50,
    })
    expect(calls.save).toBe(1)
  })
})
