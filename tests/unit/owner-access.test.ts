/**
 * Owner 记忆访问 + 统一 Gate 测试（WP-2A-R1：A2/A3/A4 + fail-closed 矩阵）。
 * 每个用例断言实际 ALLOW/DENY，不只断言标签。
 */
import { describe, expect, it } from 'vitest'
import {
  classifySessionProvenance,
  decideByProvenance,
  decideOwnerMemoryAccess,
  requiresOwnerGate,
  type OwnerSourceView,
} from '../../src/shared/owner-access.js'
import { createOwnerGate, sessionIdOfAgent } from '../../src/host/owner-gate.js'

const qqC2cBound: OwnerSourceView = {
  platform: 'qq',
  conversationType: 'c2c',
  isPrivate: true,
  ownerId: 'owner-uuid',
  identified: true,
}

const qqC2cUnbound: OwnerSourceView = {
  platform: 'qq',
  conversationType: 'c2c',
  isPrivate: true,
  ownerId: null,
  identified: true,
}

const qqGroup: OwnerSourceView = {
  platform: 'qq',
  conversationType: 'group',
  isPrivate: false,
  ownerId: 'owner-uuid',
  identified: true,
}

const liveTrustedPc: OwnerSourceView = {
  platform: 'desktop',
  conversationType: 'c2c',
  isPrivate: true,
  ownerId: null,
  identified: true,
}

describe('decideOwnerMemoryAccess matrix', () => {
  it('missing provenance → DENY', () => {
    expect(decideOwnerMemoryAccess(null).allowed).toBe(false)
    expect(decideOwnerMemoryAccess(undefined).allowed).toBe(false)
  })

  it('unknown platform → DENY', () => {
    expect(
      decideOwnerMemoryAccess({
        platform: 'mystery',
        conversationType: 'c2c',
        isPrivate: true,
        ownerId: 'x',
        identified: true,
      }).allowed,
    ).toBe(false)
  })

  it('live trusted PC platforms → ALLOW (positive evidence only)', () => {
    for (const platform of ['desktop', 'pc', 'local', 'trusted-pc']) {
      expect(
        decideOwnerMemoryAccess({
          platform,
          conversationType: 'c2c',
          isPrivate: true,
          ownerId: null,
          identified: true,
        }).allowed,
      ).toBe(true)
    }
  })

  it('QQ group → DENY even if bound', () => {
    expect(decideOwnerMemoryAccess(qqGroup).allowed).toBe(false)
  })

  it('QQ c2c unbound → DENY', () => {
    expect(decideOwnerMemoryAccess(qqC2cUnbound).allowed).toBe(false)
  })

  it('QQ c2c bound → ALLOW with ownerId', () => {
    const d = decideOwnerMemoryAccess(qqC2cBound)
    expect(d.allowed).toBe(true)
    expect(d.ownerId).toBe('owner-uuid')
  })

  it('A4: QQ c2c after unbind (ownerId null) → DENY', () => {
    expect(decideOwnerMemoryAccess({ ...qqC2cBound, ownerId: null }).allowed).toBe(false)
  })
})

describe('classifySessionProvenance — R1/R2 fail-closed', () => {
  it('R2: service missing → unknown → DENY (not trusted-pc)', () => {
    const p = classifySessionProvenance({
      serviceAvailable: false,
      source: null,
      knownQqSession: false,
    })
    expect(p.kind).toBe('unknown')
    expect(decideByProvenance(p).allowed).toBe(false)
  })

  it('R1: service on, no source, NOT in registry → unknown → DENY', () => {
    const p = classifySessionProvenance({
      serviceAvailable: true,
      source: null,
      knownQqSession: false,
      registryHealthy: true,
    })
    expect(p.kind).toBe('unknown')
    expect(decideByProvenance(p).allowed).toBe(false)
  })

  it('A3: known QQ, no live source → qq-missing → DENY', () => {
    const p = classifySessionProvenance({
      serviceAvailable: true,
      source: null,
      knownQqSession: true,
      registryHealthy: true,
    })
    expect(p.kind).toBe('qq-missing')
    expect(decideByProvenance(p).allowed).toBe(false)
  })

  it('registry unhealthy + not known → unknown → DENY', () => {
    const p = classifySessionProvenance({
      serviceAvailable: true,
      source: null,
      knownQqSession: false,
      registryHealthy: false,
    })
    expect(p.kind).toBe('unknown')
    expect(decideByProvenance(p).allowed).toBe(false)
  })

  it('registry unhealthy + known (live sources still work) → qq-missing → DENY', () => {
    const p = classifySessionProvenance({
      serviceAvailable: true,
      source: null,
      knownQqSession: true,
      registryHealthy: false,
    })
    expect(p.kind).toBe('qq-missing')
    expect(decideByProvenance(p).allowed).toBe(false)
  })

  it('live qq bound → qq → ALLOW', () => {
    const p = classifySessionProvenance({
      serviceAvailable: true,
      source: qqC2cBound,
      knownQqSession: true,
    })
    expect(p.kind).toBe('qq')
    expect(decideByProvenance(p).allowed).toBe(true)
  })

  it('live qq unbound → qq → DENY', () => {
    const p = classifySessionProvenance({
      serviceAvailable: true,
      source: qqC2cUnbound,
      knownQqSession: true,
    })
    expect(p.kind).toBe('qq')
    expect(decideByProvenance(p).allowed).toBe(false)
  })

  it('live trusted-pc → ALLOW', () => {
    const p = classifySessionProvenance({
      serviceAvailable: true,
      source: liveTrustedPc,
      knownQqSession: false,
    })
    expect(p.kind).toBe('trusted-pc')
    expect(decideByProvenance(p).allowed).toBe(true)
  })

  it('live unknown platform → DENY', () => {
    const p = classifySessionProvenance({
      serviceAvailable: true,
      source: {
        platform: 'weird',
        conversationType: 'c2c',
        isPrivate: true,
        ownerId: null,
        identified: true,
      },
      knownQqSession: false,
    })
    expect(p.kind).toBe('unknown')
    expect(decideByProvenance(p).allowed).toBe(false)
  })
})

describe('requiresOwnerGate — 不存在跳过门禁的 fail-open', () => {
  it('service missing → gate required', () => {
    expect(
      requiresOwnerGate({ serviceAvailable: false, source: null, knownQqSession: false }),
    ).toBe(true)
  })

  it('unregistered session → gate required', () => {
    expect(
      requiresOwnerGate({
        serviceAvailable: true,
        source: null,
        knownQqSession: false,
        registryHealthy: true,
      }),
    ).toBe(true)
  })

  it('known QQ no live → gate required', () => {
    expect(
      requiresOwnerGate({
        serviceAvailable: true,
        source: null,
        knownQqSession: true,
        registryHealthy: true,
      }),
    ).toBe(true)
  })

  it('only live trusted-pc skips gate', () => {
    expect(
      requiresOwnerGate({
        serviceAvailable: true,
        source: liveTrustedPc,
        knownQqSession: false,
      }),
    ).toBe(false)
    expect(
      requiresOwnerGate({
        serviceAvailable: true,
        source: qqC2cBound,
        knownQqSession: true,
      }),
    ).toBe(true)
  })
})

describe('createOwnerGate — A2/A3/A4 实际 ALLOW/DENY', () => {
  function makeCtx(opts: {
    context?: {
      platform: string
      conversationType: string
      isPrivate: boolean
      ownerId: string | null
      identified: boolean
    } | null
    known?: boolean
    registryHealthy?: boolean
    missingService?: boolean
  }) {
    return () =>
      opts.missingService
        ? undefined
        : ({
            getContext: () => opts.context ?? null,
            isKnownQqSession: () => opts.known ?? false,
            isRegistryHealthy: () => opts.registryHealthy ?? true,
          } as never)
  }

  it('A2: unbound qq live → DENY', () => {
    const gate = createOwnerGate(makeCtx({ context: qqC2cUnbound as never, known: true }))
    expect(gate({ sessionId: 's1' }).allowed).toBe(false)
  })

  it('A2: group qq live → DENY', () => {
    const gate = createOwnerGate(makeCtx({ context: qqGroup as never, known: true }))
    expect(gate({ sessionId: 's1' }).allowed).toBe(false)
  })

  it('A2: bound qq live → ALLOW', () => {
    const gate = createOwnerGate(makeCtx({ context: qqC2cBound as never, known: true }))
    const d = gate({ sessionId: 's1' })
    expect(d.allowed).toBe(true)
    expect(d.ownerId).toBe('owner-uuid')
  })

  it('A3: known QQ, live source gone → DENY', () => {
    const gate = createOwnerGate(makeCtx({ context: null, known: true }))
    expect(gate({ sessionId: 's1' }).allowed).toBe(false)
  })

  it('A3: not registered, service on → DENY (not trusted-pc)', () => {
    const gate = createOwnerGate(makeCtx({ context: null, known: false }))
    expect(gate({ sessionId: 'pc-1' }).allowed).toBe(false)
  })

  it('R2: service missing → DENY (no null skip)', () => {
    const gate = createOwnerGate(makeCtx({ missingService: true }))
    const d = gate({ sessionId: 's1' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('服务缺失')
  })

  it('registry unhealthy → DENY', () => {
    const gate = createOwnerGate(makeCtx({ context: null, known: false, registryHealthy: false }))
    expect(gate({ sessionId: 's1' }).allowed).toBe(false)
  })

  it('no sessionId → DENY', () => {
    const gate = createOwnerGate(makeCtx({ context: null, known: false }))
    expect(gate({ sessionId: null }).allowed).toBe(false)
  })

  it('A4: bound then unbound (live ownerId null) → DENY', () => {
    const gate = createOwnerGate(
      makeCtx({ context: { ...qqC2cBound, ownerId: null }, known: true }),
    )
    expect(gate({ sessionId: 's1' }).allowed).toBe(false)
  })

  it('A4: getContext throws → DENY', () => {
    const gate = createOwnerGate(() => {
      return {
        getContext: () => {
          throw new Error('boom')
        },
        isKnownQqSession: () => true,
      } as never
    })
    expect(gate({ sessionId: 's1' }).allowed).toBe(false)
  })

  it('getService throws → DENY', () => {
    const gate = createOwnerGate(() => {
      throw new Error('ctx down')
    })
    expect(gate({ sessionId: 's1' }).allowed).toBe(false)
  })

  it('live trusted-pc → ALLOW', () => {
    const gate = createOwnerGate(makeCtx({ context: liveTrustedPc as never, known: false }))
    expect(gate({ sessionId: 's1' }).allowed).toBe(true)
  })

  it('gate never returns null (no skip path)', () => {
    const cases = [
      createOwnerGate(makeCtx({ missingService: true })),
      createOwnerGate(makeCtx({ context: null, known: false })),
      createOwnerGate(makeCtx({ context: qqC2cBound as never, known: true })),
    ]
    for (const gate of cases) {
      const d = gate({ sessionId: 'x' })
      expect(d).not.toBeNull()
      expect(typeof d.allowed).toBe('boolean')
      expect(typeof d.reason).toBe('string')
    }
  })
})

describe('sessionIdOfAgent', () => {
  it('reads session.id', () => {
    expect(sessionIdOfAgent({ session: { id: 'abc' } })).toBe('abc')
  })
  it('reads header.id fallback', () => {
    expect(sessionIdOfAgent({ session: { header: { id: 'hdr' } } })).toBe('hdr')
  })
  it('null for garbage', () => {
    expect(sessionIdOfAgent(null)).toBeNull()
    expect(sessionIdOfAgent({})).toBeNull()
  })
})
