#!/usr/bin/env node
/**
 * Child process for the save window-B crash tests (round 20).
 *
 * Runs a real `save` through the compiled plugin and force-kills itself at a specific
 * commit boundary. The parent observes the exit and then starts a fresh instance to
 * verify recovery. The boundary is selected by argv, so nothing in production code can
 * trigger it.
 *
 *   node tests/support/child-save-crash.mjs <vault> <phase> <marker>
 *   phase: after-stage | after-write | after-commit
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [vault, phase, marker] = process.argv.slice(2)
if (vault === undefined || phase === undefined || marker === undefined) {
  process.stderr.write('usage: child-save-crash.mjs <vault> <phase> <marker>\n')
  process.exit(2)
}

const lib = await import('../../lib/host/core/service.js').catch(() => null)
if (lib === null) {
  process.stderr.write('lib/host/core/service.js is missing; run `npm run build` first\n')
  process.exit(3)
}

const op = process.argv[5] ?? 'save'
const barrier = async (current) => {
  if (current !== phase) return
  // Confirm the boundary to the parent, then terminate for real (no thrown error).
  await writeFile(join(vault, `.crash-${phase}`), String(process.pid), 'utf8')
  process.kill(process.pid, 'SIGKILL')
}

if (op === 'save') {
  const service = new lib.MemoryService({ configuredVaultPath: vault, commitBarrier: barrier })
  await service.initialize(vault)
  await service.save({
    type: 'knowledge',
    title: marker,
    summary: `${marker} 崩溃恢复测试正文。`,
    tags: [],
    confidence: 'high',
    importance: 50,
  })
} else if (op === 'recover') {
  // Recovery-only child: attach to the vault and let startup recovery run. The barrier
  // fires inside the recovery executor, so a kill here happens *during recovery*.
  const recovery = new lib.MemoryService({ configuredVaultPath: vault, commitBarrier: barrier })
  await recovery.initialize(vault)
} else {
  // Seed the record without any barrier, then run the operation under test.
  const seed = new lib.MemoryService({ configuredVaultPath: vault })
  await seed.initialize(vault)
  const created = await seed.save({
    type: 'knowledge',
    title: `${marker}-seed`,
    summary: `${marker} 种子记忆正文。`,
    tags: [],
    confidence: 'high',
    importance: 50,
  })
  // The parent must assert on the record the child actually operates on.
  await writeFile(join(vault, '.child-id'), created.id, 'utf8')
  const service = new lib.MemoryService({ configuredVaultPath: vault, commitBarrier: barrier })
  await service.initialize(vault)
  if (op === 'writeRaw') {
    const raw = await service.readRaw(created.id)
    if (raw === null) throw new Error('seed memory could not be read')
    await service.writeRaw(created.id, `${raw.content}\n外部编辑标记 ${marker}。\n`, raw.checksum)
  } else if (op === 'transition') {
    await service.setStatus(created.id, 'archived', `崩溃恢复测试迁移 ${marker}`)
  } else if (op === 'merge') {
    const second = await seed.save({ type: 'knowledge', title: `${marker}-second`, summary: `${marker} 第二条正文。`, tags: [], confidence: 'high', importance: 50 })
    await writeFile(join(vault, '.child-ids'), JSON.stringify([created.id, second.id]), 'utf8')
    const planning = new lib.MemoryService({ configuredVaultPath: vault, commitBarrier: barrier })
    await planning.initialize(vault)
    await planning.merge({ ids: [created.id, second.id], targetId: created.id })  } else if (op === 'remove') {
    await service.remove(created.id, true, `崩溃恢复测试删除 ${marker}`)
  } else {
    throw new Error(`unknown op: ${op}`)
  }
}
process.stderr.write('child completed without being killed\n')
process.exit(4)
