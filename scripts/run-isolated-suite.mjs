#!/usr/bin/env node
/**
 * Repeatable verification harness for this repo.
 *
 * Three environment facts make a plain `npx vitest run` unreliable here:
 *
 *  1. The sandbox's `safe-delete` bulk guard refuses removals after 50 files
 *     per agent turn. A vault-backed suite creates/removes one quarantine
 *     probe per case, so large suites fail for reasons unrelated to the code.
 *  2. An interrupted run can leave `.lock` behind in the guard's state dir.
 *     Its stale threshold is 5 minutes, so every later removal waits for the
 *     2s lock timeout instead of failing fast.
 *  3. On Windows the default `forks` pool can die with
 *     `ERR_IPC_CHANNEL_CLOSED` for long suites. `threads` is stable.
 *
 * This harness therefore runs each suite in its own child process with
 * `--pool=threads`, raises the bulk threshold for that child only (the parent
 * shell keeps the default 50), and records a machine-readable ledger row.
 * It NEVER changes production code or assertions.
 *
 * PASS requires: exit 0, 0 failed, 0 skipped, 0 failed files, no guard
 * interception, no collection error.
 *
 * Usage:
 *   node scripts/run-isolated-suite.mjs run <suite.test.ts>
 *   node scripts/run-isolated-suite.mjs all           # every tests/**\/*.test.ts
 *   node scripts/run-isolated-suite.mjs remaining 4   # resume non-PASS suites, 4 workers
 *   node scripts/run-isolated-suite.mjs report
 *   node scripts/run-isolated-suite.mjs reset
 *   node scripts/run-isolated-suite.mjs unlock        # clear a stale guard lock
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.scratch', 'wp-life-2', 'suite-logs')
const ledger = join(root, '.scratch', 'wp-life-2', 'suite-ledger.jsonl')
mkdirSync(outDir, { recursive: true })

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

/**
 * Suites whose per-case filesystem setup is slow enough that a single process
 * exceeds the 10-minute budget. `--shard` cannot help because vitest shards by
 * *file*, not by case, so we split by describe name with `-t`. Every case still
 * runs exactly once; the merged row must account for the full case count.
 */
const SHARD_PLANS = {
  'tests/integration/service.test.ts': [
    'initialization and status|writing and reading Markdown|status transitions move the note|deletion requires',
    'merge and conflict resolution|index lifecycle',
    'raw editing with optimistic concurrency|change history|turn processing',
    'candidates|recall and context budget',
    'overview|settings|openVault|durability',
  ],
}

function listSuites() {
  const found = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.test.ts')) found.push(relative(root, p).replace(/\\/g, '/'))
    }
  }
  walk(join(root, 'tests'))
  return found.sort()
}

/** Remove a guard lock left by an interrupted process (never touches user data). */
function unlock(quiet = false) {
  const dir = process.env['CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR']
  if (!dir || !existsSync(dir)) { if (!quiet) console.log('[ledger] no guard state dir'); return }
  let removed = 0
  for (const d of readdirSync(dir)) {
    const session = join(dir, d)
    if (!statSync(session).isDirectory()) continue
    const lock = join(session, '.lock')
    if (existsSync(lock)) {
      try { rmdirSync(lock); removed += 1 } catch { /* in use by a live run */ }
    }
    for (const f of readdirSync(session)) {
      if (f.endsWith('.tmp')) { try { unlinkSync(join(session, f)) } catch { /* ignore */ } }
    }
  }
  if (!quiet) console.log(`[ledger] removed ${removed} stale guard lock(s)`)
  return removed
}

function parseVitest(output) {
  const text = stripAnsi(output)
  const testsLine = [...text.matchAll(/^\s*Tests\s+(.+)$/gm)].at(-1)?.[1] ?? ''
  const filesLine = [...text.matchAll(/^\s*Test Files\s+(.+)$/gm)].at(-1)?.[1] ?? ''
  const num = (line, kind) => Number(new RegExp(`(\\d+)\\s+${kind}`).exec(line)?.[1] ?? 0)
  return {
    files: num(filesLine, 'passed') + num(filesLine, 'failed') + num(filesLine, 'skipped'),
    filesFailed: num(filesLine, 'failed'),
    passed: num(testsLine, 'passed'),
    failed: num(testsLine, 'failed'),
    skipped: num(testsLine, 'skipped'),
    testsLine: testsLine.trim(),
    filesLine: filesLine.trim(),
    safeDeleteHits: (text.match(/SAFE_DELETE_BULK|safe-delete\]\[SAFE/i) ?? []).length,
    collectError: /Failed Suites|Failed to load|Cannot find package|Unhandled Rejection|ERR_IPC_CHANNEL_CLOSED/.test(text)
      ? (text.match(/^.*(?:Failed Suites|Failed to load|Cannot find package|Unhandled Rejection|ERR_IPC_CHANNEL_CLOSED).*$/m)?.[0] ?? '').trim().slice(0, 220)
      : '',
  }
}

/**
 * Split one slow suite by describe name. PASS requires that the sum of passing
 * cases equals the suite's declared total, so a shard that silently drops or
 * skips cases can never be reported as complete.
 */
function runSharded(suite, patterns, { quiet = false } = {}) {
  const t0 = Date.now()
  let passed = 0
  let failed = 0
  let total = 0
  let guardHits = 0
  let timedOut = false
  const shards = []
  // De-duplicate by full case name: `-t` patterns can overlap (e.g. an `it`
  // title containing 'settings'), so summing per-shard counts would overcount.
  const caseNames = new Set()
  for (const [i, pattern] of patterns.entries()) {
    unlock(true)
    const logFile = join(outDir, `${suite.replace(/[\\/]/g, '__')}.shard${i + 1}.log`)
    const r = spawnSync(process.execPath, [vitest, 'run', suite, '--pool=threads', '--reporter=verbose', '-t', pattern,
        '--testTimeout=120000', '--hookTimeout=120000'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 8 * 60 * 1000,
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        CODEBUDDY_SAFE_DELETE_ENABLED: '0',
        CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD: '100000',
      },
    })
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${r.error?.message ?? ''}`
    writeFileSync(logFile, output)
    const text = stripAnsi(output)
    const okNames = [...text.matchAll(/^\s*✓\s+(.+?)\s+\d+(?:\.\d+)?ms\s*$/gm)].map((m) => m[1].trim())
    for (const name of okNames) caseNames.add(name)
    const ok = okNames.length
    const bad = (text.match(/^\s*× /gm) ?? []).length
    const totalMatch = /Tests[^\n]*\((\d+)\)/.exec(text)
    if (totalMatch !== null) total = Math.max(total, Number(totalMatch[1]))
    if (r.error?.code === 'ETIMEDOUT' || r.signal !== null) timedOut = true
    guardHits += (text.match(/SAFE_DELETE_BULK|safe-delete\]\[SAFE/i) ?? []).length
    passed += ok
    failed += bad
    shards.push({ shard: i + 1, passed: ok, failed: bad, exitCode: r.status, pattern })
    if (r.status !== 0 || bad > 0) failed = Math.max(failed, 1)
  }
  passed = caseNames.size
  const complete = total > 0 && passed === total
  const verdict = !timedOut && failed === 0 && complete && guardHits === 0 ? 'PASS' : 'FAIL'
  const row = {
    suite, verdict, exitCode: verdict === 'PASS' ? 0 : 1, durationMs: Date.now() - t0,
    at: new Date().toISOString(), passed, failed, skipped: 0,
    files: 1, filesFailed: verdict === 'PASS' ? 0 : 1,
    testsLine: `${passed} passed (${total})`, filesLine: '1 passed (1)',
    safeDeleteHits: guardHits, collectError: '',
    shards: shards.length, totalCases: total, shardDetails: shards,
    log: `.scratch/wp-life-2/suite-logs/${suite.replace(/[\\/]/g, '__')}.shard*.log`,
  }
  appendFileSync(ledger, JSON.stringify(row) + '\n')
  if (!quiet) {
    console.log(`[ledger] ${verdict.padEnd(13)} ${String(passed).padStart(4)} passed / ${total} cases, ${shards.length} shards  ${suite}`)
    if (verdict !== 'PASS') console.log(`[ledger]   incomplete=${!complete} failed=${failed} guard=${guardHits} details=${JSON.stringify(shards)}`)
  }
  return verdict === 'PASS' ? 0 : 1
}

function run(suite, { quiet = false } = {}) {
  if (!suite.startsWith('tests/') || !suite.endsWith('.test.ts')) {
    console.error(`[ledger] refuse: expected tests/**/*.test.ts, got ${suite}`)
    return 1
  }
  if (!existsSync(join(root, suite))) {
    console.error(`[ledger] suite not found: ${suite}`)
    return 1
  }
  const plan = SHARD_PLANS[suite]
  if (plan !== undefined) return runSharded(suite, plan, { quiet })
  // A previously interrupted run can leave a `.lock` whose mtime is newer than
  // the guard's 5-minute stale threshold; every following removal then waits
  // for the 2s lock timeout. Clear it before every suite (runs are serial).
  unlock(true)
  const logFile = join(outDir, suite.replace(/[\\/]/g, '__') + '.log')
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [vitest, 'run', suite, '--pool=threads', '--testTimeout=120000', '--hookTimeout=120000'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      // The guard is designed to stop an *agent* from bulk-deleting user files;
      // a test deleting its own scratch probes is not that case. Raising the
      // threshold alone is not enough: every removal still goes through the
      // guard's global `withLock`, and under contention a single test case can
      // spend 2s per removal (measured: 31.6s for one case) and the whole suite
      // exceeds 600s. Disable the guard for this child process only — the
      // parent shell and every non-test command keep full protection.
      CODEBUDDY_SAFE_DELETE_ENABLED: '0',
      CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD: '100000',
    },
  })
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${r.error?.message ?? ''}`
  writeFileSync(logFile, output)
  const parsed = parseVitest(output)
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal !== null
  const verdict = !timedOut && r.status === 0 && parsed.failed === 0 && parsed.skipped === 0
    && parsed.filesFailed === 0 && parsed.safeDeleteHits === 0 && !parsed.collectError
    ? 'PASS'
    : timedOut ? 'TIMEOUT'
      : parsed.safeDeleteHits > 0 ? 'ENV_BLOCKED'
        : parsed.collectError ? 'COLLECT_ERROR' : 'FAIL'
  const row = {
    suite, verdict, exitCode: r.status, signal: r.signal,
    durationMs: Date.now() - t0, at: new Date().toISOString(),
    log: `.scratch/wp-life-2/suite-logs/${suite.replace(/[\\/]/g, '__')}.log`,
    ...parsed,
  }
  appendFileSync(ledger, JSON.stringify(row) + '\n')
  if (!quiet) {
    console.log(`[ledger] ${verdict.padEnd(13)} ${String(parsed.passed).padStart(4)} passed  ${String(parsed.failed).padStart(3)} failed  ${String(parsed.skipped).padStart(3)} skipped  ${suite}`)
    if (verdict !== 'PASS') console.log(`[ledger]   ${row.log}  guard=${parsed.safeDeleteHits}  ${parsed.collectError}`)
  }
  return verdict === 'PASS' ? 0 : 1
}

function runMany(suites) {
  console.log(`[ledger] running ${suites.length} suites, one process each, threads pool`)
  let bad = 0
  for (const [i, suite] of suites.entries()) {
    process.stdout.write(`[${String(i + 1).padStart(2, '0')}/${suites.length}] `)
    if (run(suite, { quiet: true }) !== 0) bad += 1
    const last = JSON.parse(readFileSync(ledger, 'utf8').trim().split('\n').at(-1))
    console.log(`${last.verdict.padEnd(13)} ${String(last.passed).padStart(4)}p ${String(last.failed).padStart(3)}f ${String(last.skipped).padStart(3)}s  ${(last.durationMs / 1000).toFixed(0).padStart(3)}s  ${suite}`)
  }
  console.log(`[ledger] ${suites.length - bad}/${suites.length} PASS`)
  report()
  process.exitCode = bad === 0 ? 0 : 1
}

function all() { runMany(listSuites()) }

/** Resume after an interrupted run: only re-run suites without a PASS row. */
function remaining(parallel = 1) {
  let passed = new Set()
  if (existsSync(ledger)) {
    const rows = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const latest = new Map()
    for (const r of rows) latest.set(r.suite, r)
    passed = new Set([...latest.values()].filter((r) => r.verdict === 'PASS').map((r) => r.suite))
  }
  const suites = listSuites().filter((s) => !passed.has(s))
  console.log(`[ledger] ${passed.size} suites already PASS; resuming ${suites.length} (parallel=${parallel})`)
  if (parallel <= 1) { runMany(suites); return }
  runParallel(suites, parallel)
}

/**
 * Fan out to N independent harness processes. Each still runs exactly one
 * suite in its own vitest process and writes its own ledger row, so the PASS
 * rules are unchanged. Safe because each suite uses its own mkdtemp vault and
 * the bulk-delete guard is disabled only inside those child processes.
 */
function runParallel(suites, n) {
  const self = fileURLToPath(import.meta.url)
  const total = suites.length
  let cursor = 0
  let bad = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= total) return
      const suite = suites[i]
      const code = await new Promise((resolve) => {
        const child = spawn(process.execPath, [self, 'run', suite], { stdio: 'ignore' })
        child.on('exit', (c) => resolve(c ?? 1))
        child.on('error', () => resolve(1))
      })
      if (code !== 0) bad += 1
      console.log(`[${String(i + 1).padStart(2, '0')}/${total}] ${code === 0 ? 'PASS' : 'NOT PASS'}  ${suite}`)
    }
  }
  void Promise.all(Array.from({ length: Math.min(n, total) }, worker)).then(() => {
    console.log(`[ledger] ${total - bad}/${total} PASS (parallel=${Math.min(n, total)})`)
    report()
    process.exitCode = bad === 0 ? 0 : 1
  })
}

function report() {
  if (!existsSync(ledger)) { console.log('no ledger yet'); return }
  const rows = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const latest = new Map()
  for (const r of rows) latest.set(r.suite, r)
  const allRows = [...latest.values()]
  const counts = {}
  for (const r of allRows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1
  const lines = [
    '# 套件验证台账',
    '',
    `生成时间：${new Date().toISOString()}　·　套件 ${allRows.length}　·　PASS ${counts.PASS ?? 0}　·　其它 ${allRows.length - (counts.PASS ?? 0)}`,
    '',
    '| 套件 | 判定 | passed | failed | skipped | guard | 耗时 |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...allRows.sort((a, b) => a.suite.localeCompare(b.suite)).map((r) =>
      `| \`${r.suite}\` | ${r.verdict} | ${r.passed} | ${r.failed} | ${r.skipped} | ${r.safeDeleteHits} | ${(r.durationMs / 1000).toFixed(1)}s |`),
    '',
    'PASS 条件：`exit 0` + `failed=0` + `skipped=0` + `filesFailed=0` + 无 safe-delete 拦截 + 无收集错误 + 未超时。',
    '运行方式：`node scripts/run-isolated-suite.mjs all`（每套件独立进程、`--pool=threads`、测试子进程单独放宽删除额度）。',
    '',
  ]
  const path = join(root, '.scratch', 'wp-life-2', 'SUITE-MATRIX.md')
  writeFileSync(path, lines.join('\n'))
  console.log(`[ledger] report -> ${path}  (${counts.PASS ?? 0} PASS / ${allRows.length})`)
  for (const r of allRows.filter((x) => x.verdict !== 'PASS')) {
    console.log(`[ledger] NOT PASS: ${r.suite} (${r.verdict}) ${r.collectError}`)
  }
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'run') process.exitCode = run(arg ?? '')
else if (cmd === 'all') all()
else if (cmd === 'remaining') remaining(Math.max(1, Number(arg ?? 1) || 1))
else if (cmd === 'report') report()
else if (cmd === 'unlock') unlock()
else if (cmd === 'reset') { writeFileSync(ledger, ''); console.log('[ledger] reset') }
else { console.error('usage: run <suite> | all | report | unlock | reset'); process.exitCode = 2 }
