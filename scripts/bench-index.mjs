#!/usr/bin/env node
/**
 * Reproducible baseline benchmark for the DSH long-term-memory index.
 *
 * Measures the *current* implementation; it does not optimize anything and does
 * not write outside `.scratch/bench/` (or whatever `--workdir` points at).
 *
 * The notes are written with the same renderer `MemoryService.save()` uses
 * (`renderMemory` from lib/shared/markdown.js), so their bytes are identical to
 * what the plugin writes. Indexing itself is done only by the product's own
 * `buildIndex` / `syncIndex` / `loadIndex` / `persistIndex` / `writeIndexNotes`.
 *
 * Dependency-free: Node built-ins plus the plugin's own `lib/` modules.
 *
 * Usage:
 *   node scripts/bench-index.mjs --runs 3
 *   node scripts/bench-index.mjs --runs 5 --count 1000
 *   node scripts/bench-index.mjs --runs 3 --sizes 20,200,1000 --json
 */

import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, platform, release } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import { MemoryService } from '../lib/host/core/service.js'
import { buildIndex, loadIndex, persistIndex, syncIndex, writeIndexNotes } from '../lib/host/core/indexing.js'
import { layoutFor, relativePathFor } from '../lib/host/core/layout.js'
import { scanVault } from '../lib/host/core/repository.js'
import { initializeVault } from '../lib/host/core/vault.js'
import { renderMemory } from '../lib/shared/markdown.js'
import { memoryFileName } from '../lib/shared/validate.js'
import { MEMORY_TYPES, TYPE_DESCRIPTORS } from '../lib/shared/types.js'

const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const DEFAULT_WORKDIR = join(REPO_ROOT, '.scratch', 'bench')
const DEFAULT_SEED = 20261017
const DEFAULT_SIZES = [
  { label: 'small', count: 20 },
  { label: 'medium', count: 200 },
  { label: 'large', count: 1000 },
]

const OPERATIONS = [
  ['initEmpty', '1. first initialization (empty dir -> initialize)'],
  ['fullBuild', '2. first full index build (buildIndex)'],
  ['startupNoChange', '3. startup reconcile, index exists, nothing changed'],
  ['syncNoChange', '4. repeated syncIndex(), no changes'],
  ['syncEdit', '5. edit one file externally -> syncIndex()'],
  ['syncAdd', '6. add one file externally -> syncIndex()'],
  ['syncDelete', '7. delete one file externally -> syncIndex()'],
  ['rebuildCorrupt', '8. corrupt index.json -> rebuildIndex()'],
  ['recall', '9. recall("关键词") on the resulting index'],
]

const PROFILE_KEYS = [
  ['startup', 'whole startup: new MemoryService + initialize'],
  ['initializeVault', 'initializeVault (marker/dirs/read-write probe)'],
  ['loadIndex', 'loadIndex (read + validate + derive)'],
  ['scanVault', 'scanVault (walk + read + parse + checksum)'],
  ['syncIndex', 'syncIndex, no changes (scan + compare)'],
  ['persistIndex', 'persistIndex (stringify + atomic write)'],
  ['writeIndexNotes', 'writeIndexNotes (9 generated notes)'],
  ['buildIndex', 'buildIndex (scan + tokenize + derive)'],
]

function parseArgs(argv) {
  const out = {
    runs: 3,
    sizes: null,
    count: null,
    json: false,
    seed: DEFAULT_SEED,
    profileReps: 3,
    workdir: DEFAULT_WORKDIR,
    out: join(DEFAULT_WORKDIR, 'results.json'),
    keep: false,
    profile: true,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      i += 1
      return value
    }
    if (arg === '--runs') out.runs = Number(next())
    else if (arg === '--count') out.count = Number(next())
    else if (arg === '--sizes') out.sizes = next()
    else if (arg === '--seed') out.seed = Number(next())
    else if (arg === '--profile-reps') out.profileReps = Number(next())
    else if (arg === '--workdir') out.workdir = resolve(next())
    else if (arg === '--out') out.out = resolve(next())
    else if (arg === '--json') out.json = true
    else if (arg === '--keep') out.keep = true
    else if (arg === '--no-profile') out.profile = false
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isFinite(out.runs) || out.runs < 1) throw new Error('--runs must be a positive number')
  out.runs = Math.max(3, Math.floor(out.runs)) // the task requires R >= 3
  if (!Number.isFinite(out.profileReps) || out.profileReps < 1) throw new Error('--profile-reps must be positive')
  out.profileReps = Math.floor(out.profileReps)
  if (out.sizes !== null) {
    out.sizes = out.sizes.split(',').map((part) => {
      const count = Number(part.trim())
      if (!Number.isInteger(count) || count < 1) throw new Error(`invalid size: ${part}`)
      return { label: `count-${count}`, count }
    })
  } else if (out.count !== null) {
    if (!Number.isInteger(out.count) || out.count < 1) throw new Error('--count must be a positive integer')
    out.sizes = [{ label: `count-${out.count}`, count: out.count }]
  } else {
    out.sizes = DEFAULT_SIZES
  }
  return out
}

/** Deterministic 32-bit PRNG (mulberry32). */
function mulberry32(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

async function timed(fn) {
  const started = performance.now()
  const result = await fn()
  return { ms: performance.now() - started, result }
}

async function medianOf(fn, reps) {
  const samples = []
  for (let i = 0; i < reps; i += 1) {
    const started = performance.now()
    await fn()
    samples.push(performance.now() - started)
  }
  return { medianMs: round(median(samples)), samplesMs: samples.map(round) }
}

function discoveryFor(vaultPath) {
  // Injected discovery: nothing about the real machine's Obsidian config is read.
  return {
    environment: 'desktop',
    filesystem: true,
    obsidian: { detected: false, configPath: null, vaults: [] },
    current: null,
    candidates: [vaultPath],
    needsChoice: false,
    rationale: 'benchmark (injected discovery)',
    warnings: [],
  }
}

function newService(vaultPath) {
  return new MemoryService({
    configuredVaultPath: vaultPath,
    discoveryProvider: async () => discoveryFor(vaultPath),
  })
}

const TOPICS = ['工作流', '检索', '索引', '插件', '笔记', '部署', '测试', '性能']

/**
 * One deterministic memory in the exact shape `MemoryService.save()` produces.
 * `renderMemory` is the product's own renderer; a probe against a real
 * `service.save()` note was byte-identical.
 */
function makeMemory(index, rng) {
  const type = MEMORY_TYPES[index % MEMORY_TYPES.length]
  const descriptor = TYPE_DESCRIPTORS[type]
  const status = index % 10 === 0 ? 'archived' : 'active'
  const id = `mem_20260101t000000_${(0x10000000 + index).toString(16).padStart(8, '0')}`
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 60_000).toISOString()
  const topic = TOPICS[index % TOPICS.length]
  const hasKeyword = rng() < 0.2
  const detail = ['已记录固定模板内容，用于索引基准测试。', '内容保持稳定，便于重复测量。', '来源为合成的确定性数据。'][
    index % 3
  ]
  const summary = `第 ${String(index).padStart(4, '0')} 条长期记忆，主题「${topic}」。${detail}${hasKeyword ? '关键词：关键词。' : `主题词：${topic}。`}`
  return {
    id,
    type,
    status,
    createdAt: at,
    updatedAt: at,
    title: `记忆条目-${String(index).padStart(4, '0')}-${topic}`,
    tags: ['bench', descriptor.defaultTag, `topic-${index % 8}`],
    aliases: [],
    confidence: ['high', 'medium', 'high'][index % 3],
    importance: 40 + Math.floor(rng() * 56),
    pinned: index % 50 === 0,
    sourceSessions: [],
    supersedes: [],
    conflictsWith: [],
    evidence: '',
    schemaVersion: 1,
    summary,
    sections: [],
    related: [],
  }
}

function noteRelativePath(memory) {
  return relativePathFor(memory.type, memory.status, memoryFileName(memory))
}

function absoluteFor(vaultPath, relativePath) {
  return join(vaultPath, relativePath.split('/').join(sep))
}

async function seedMemories(vaultPath, count, seed) {
  const rng = mulberry32(seed)
  const notes = []
  for (let i = 0; i < count; i += 1) {
    const memory = makeMemory(i, rng)
    const relativePath = noteRelativePath(memory)
    notes.push({ memory, relativePath, absolutePath: absoluteFor(vaultPath, relativePath), content: renderMemory(memory) })
  }
  const directories = [...new Set(notes.map((note) => dirname(note.absolutePath)))]
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })))
  // Bounded concurrency so seeding 1000 files does not exhaust Windows handles.
  const width = 32
  for (let offset = 0; offset < notes.length; offset += width) {
    await Promise.all(
      notes.slice(offset, offset + width).map((note) => writeFile(note.absolutePath, note.content, 'utf8')),
    )
  }
  return notes
}

function assert(condition, message) {
  if (!condition) throw new Error(`benchmark integrity check failed: ${message}`)
}

async function runOne(size, runIndex, config) {
  const root = await mkdtemp(join(config.workdir, `vault-${size.label}-`))
  const vaultPath = join(root, 'DSH Memory')
  await mkdir(vaultPath, { recursive: true })
  const operations = {}
  let service = null
  try {
    // 1. first initialization on an empty directory.
    const init = await timed(async () => {
      const created = newService(vaultPath)
      await created.initialize(vaultPath)
      return created
    })
    operations.initEmpty = init.ms
    assert(init.result.isReady(), 'service not ready after first initialize')
    assert(init.result.index.records.size === 0, 'fresh vault index is not empty')

    // Seed real Markdown notes (untimed setup).
    const seeded = await seedMemories(vaultPath, size.count, config.seed + runIndex)
    const layout = layoutFor(vaultPath)

    // 2. first full index build: the product's pure build path.
    const full = await timed(() => buildIndex(vaultPath))
    operations.fullBuild = full.ms
    assert(full.result.index.records.size === size.count, 'full build did not index every note')
    // Put the vault into the normal persisted state (untimed setup).
    await persistIndex(layout, full.result.index)
    await writeIndexNotes(vaultPath, full.result.index)

    // 3. startup reconciliation with an index present and no changes.
    service = newService(vaultPath)
    const startup = await timed(() => service.initialize(vaultPath))
    operations.startupNoChange = startup.ms
    assert(service.index.records.size === size.count, 'startup reconcile lost records')

    // 4. repeated no-change syncIndex().
    const noChangeSamples = []
    for (let i = 0; i < 3; i += 1) {
      const sample = await timed(() => service.syncIndex())
      noChangeSamples.push(sample.ms)
    }
    operations.syncNoChange = median(noChangeSamples)
    operations.syncNoChangeSamples = noChangeSamples

    // 5. edit one file externally, then sync.
    const editTarget = seeded.find((note) => note.memory.status === 'active') ?? seeded[0]
    assert(editTarget !== undefined, 'no note available to edit')
    await appendFile(editTarget.absolutePath, `\n\n外部编辑：第 ${runIndex} 轮追加，包含关键词。\n`, 'utf8')
    const edit = await timed(() => service.syncIndex())
    operations.syncEdit = edit.ms
    assert(edit.result.updated.length === 1, `expected 1 updated record, got ${edit.result.updated.length}`)

    // 6. add one file externally, then sync.
    const extraIndex = size.count + runIndex + 10000
    const extraMemory = makeMemory(extraIndex, mulberry32(config.seed + extraIndex))
    extraMemory.status = 'active'
    extraMemory.type = 'knowledge'
    const extraRelative = noteRelativePath(extraMemory)
    const extraAbsolute = absoluteFor(vaultPath, extraRelative)
    await mkdir(dirname(extraAbsolute), { recursive: true })
    await writeFile(extraAbsolute, renderMemory(extraMemory), 'utf8')
    const add = await timed(() => service.syncIndex())
    operations.syncAdd = add.ms
    assert(add.result.added.length === 1, `expected 1 added record, got ${add.result.added.length}`)

    // 7. delete the added file, then sync.
    await unlink(extraAbsolute)
    const del = await timed(() => service.syncIndex())
    operations.syncDelete = del.ms
    assert(del.result.removed.length === 1, `expected 1 removed record, got ${del.result.removed.length}`)

    // 8. corrupt index.json, then rebuild through the service.
    await writeFile(layout.index, '{ this is not valid json\n', 'utf8')
    const rebuild = await timed(() => service.rebuildIndex())
    operations.rebuildCorrupt = rebuild.ms
    assert(rebuild.result.records === size.count, `rebuild indexed ${rebuild.result.records} of ${size.count}`)

    // 9. retrieval on the rebuilt index. 21 iterations -> stable sub-millisecond median.
    const recallSamples = []
    let recallHits = 0
    for (let i = 0; i < 21; i += 1) {
      const sample = await timed(() => service.recall('关键词'))
      recallSamples.push(sample.ms)
      recallHits = sample.result.hits.length
    }
    operations.recall = median(recallSamples)
    operations.recallSamples = recallSamples
    operations.recallHits = recallHits
    assert(recallHits > 0, 'recall("关键词") returned no hits')

    // Profiling block: decompose the no-change startup path on the same vault.
    let profile = null
    if (config.profile) {
      const reps = config.profileReps
      profile = {}
      profile.startup = await medianOf(() => newService(vaultPath).initialize(vaultPath), reps)
      profile.initializeVault = await medianOf(() => initializeVault(vaultPath, { obsidianVaults: [] }), reps)
      profile.loadIndex = await medianOf(() => loadIndex(layout), reps)
      profile.scanVault = await medianOf(() => scanVault(vaultPath), reps)
      profile.syncIndex = await medianOf(() => syncIndex(vaultPath, service.index), reps)
      profile.persistIndex = await medianOf(() => persistIndex(layout, service.index), reps)
      profile.writeIndexNotes = await medianOf(() => writeIndexNotes(vaultPath, service.index), reps)
      profile.buildIndex = await medianOf(() => buildIndex(vaultPath), reps)

      const scan = await scanVault(vaultPath)
      const bytes = scan.documents.reduce((sum, document) => sum + document.size, 0)
      profile.dataset = {
        documents: scan.documents.length,
        ignoredMarkdown: scan.ignored,
        rejected: scan.rejected.length,
        duplicates: scan.duplicates.length,
        bytes,
        averageBytes: scan.documents.length === 0 ? 0 : Math.round(bytes / scan.documents.length),
      }
    }

    // Final integrity: the service still has exactly the seeded memories.
    assert(service.index.records.size === size.count, 'final index record count changed unexpectedly')
    return {
      size: size.label,
      count: size.count,
      run: runIndex,
      operations: Object.fromEntries(
        OPERATIONS.map(([key]) => [key, key === 'syncNoChange' || key === 'recall' ? round(operations[key]) : round(operations[key])]),
      ),
      samples: {
        syncNoChange: (operations.syncNoChangeSamples ?? []).map(round),
        recall: (operations.recallSamples ?? []).map(round),
      },
      recallHits,
      profile,
      root,
    }
  } finally {
    if (!config.keep) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
    }
  }
}

function aggregate(runs) {
  const operations = {}
  for (const [key] of OPERATIONS) {
    const values = runs.map((run) => run.operations[key])
    operations[key] = { medianMs: round(median(values)), samplesMs: values.map(round) }
  }
  let profile = null
  const firstProfile = runs[0]?.profile
  if (firstProfile !== null && firstProfile !== undefined) {
    profile = {}
    for (const [key] of PROFILE_KEYS) {
      const perRun = runs.map((run) => run.profile?.[key]?.medianMs ?? null).filter((value) => value !== null)
      profile[key] = { medianMs: round(median(perRun)), perRunMs: perRun.map(round) }
    }
    profile.dataset = firstProfile.dataset
  }
  return {
    runs: runs.length,
    operations,
    profile,
    recallHits: runs.map((run) => run.recallHits),
  }
}

function printTable(results, config) {
  console.log('')
  console.log(`DSH long-term-memory index — baseline benchmark (median of ${config.runs} runs)`)
  console.log(`node ${process.version} · ${platform()} ${release()} · ${cpus().length} logical CPUs · seed ${config.seed}`)
  console.log('')
  const sizeWidth = 8
  const countWidth = 7
  const opWidth = 58
  const msWidth = 12
  console.log(
    'size'.padEnd(sizeWidth) +
      'count'.padStart(countWidth) +
      '  ' +
      'operation'.padEnd(opWidth) +
      'median ms'.padStart(msWidth),
  )
  console.log('-'.repeat(sizeWidth + countWidth + 2 + opWidth + msWidth))
  for (const result of results) {
    for (const [key, label] of OPERATIONS) {
      const value = result.operations[key].medianMs
      console.log(
        result.size.padEnd(sizeWidth) +
          String(result.count).padStart(countWidth) +
          '  ' +
          label.padEnd(opWidth) +
          value.toFixed(2).padStart(msWidth),
      )
    }
  }

  if (config.profile && results.some((result) => result.profile !== null)) {
    console.log('')
    console.log('Profile — no-change startup and its components (median ms)')
    const nameWidth = 56
    console.log(
      'size'.padEnd(sizeWidth) +
        'count'.padStart(countWidth) +
        '  ' +
        'metric'.padEnd(nameWidth) +
        'median ms'.padStart(msWidth) +
        'share'.padStart(9),
    )
    console.log('-'.repeat(sizeWidth + countWidth + 2 + nameWidth + msWidth + 9))
    for (const result of results) {
      if (result.profile === null) continue
      for (const [key, label] of PROFILE_KEYS) {
        const medianMs = result.profile[key].medianMs
        const startup = result.profile.startup.medianMs
        const share = key === 'startup' ? '100%' : startup > 0 ? `${((medianMs / startup) * 100).toFixed(1)}%` : 'n/a'
        console.log(
          result.size.padEnd(sizeWidth) +
            String(result.count).padStart(countWidth) +
            '  ' +
            label.padEnd(nameWidth) +
            medianMs.toFixed(2).padStart(msWidth) +
            share.padStart(9),
        )
      }
      const data = result.profile.dataset
      console.log(
        result.size.padEnd(sizeWidth) +
          String(result.count).padStart(countWidth) +
          '  ' +
          `dataset: ${data.documents} notes, ${data.bytes} bytes, ${data.ignoredMarkdown} ignored .md`.padEnd(nameWidth),
      )
    }
  }
  console.log('')
  console.log('Notes: each run starts from a fresh temp vault. Op 4/9 are medians of 3/21 in-process calls.')
  console.log('Startup (op 3) includes initializeVault + attach + loadIndex + reconcile + settings write.')
  console.log('syncIndex() always persists index.json, even when nothing changed.')
}

async function main() {
  const config = parseArgs(process.argv.slice(2))
  if (config.help) {
    console.log(`Usage: node scripts/bench-index.mjs [options]

  --runs R           runs per size, minimum 3 (default 3)
  --sizes a,b,c      dataset sizes (default 20,200,1000)
  --count N          single dataset size, overrides --sizes
  --seed N           PRNG seed (default ${DEFAULT_SEED})
  --json             print JSON to stdout instead of tables
  --out PATH         JSON output path (default .scratch/bench/results.json)
  --workdir PATH     temp/work directory (default .scratch/bench)
  --profile-reps N   repetitions per profile metric (default 3)
  --no-profile       skip the profiling block
  --keep             keep temporary vault directories
`)
    return
  }
  const outPath = config.out

  await mkdir(config.workdir, { recursive: true })

  const startedAt = new Date().toISOString()
  const results = []
  for (const size of config.sizes) {
    const runs = []
    for (let runIndex = 0; runIndex < config.runs; runIndex += 1) {
      const run = await runOne(size, runIndex, config)
      runs.push(run)
      if (!config.json) {
        console.log(`  ${size.label} (${size.count}) run ${runIndex + 1}/${config.runs} done`)
      }
    }
    results.push({ size: size.label, count: size.count, ...aggregate(runs) })
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    startedAt,
    host: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      availableParallelism: availableParallelism(),
    },
    config: {
      runs: config.runs,
      seed: config.seed,
      sizes: config.sizes,
      profileReps: config.profile ? config.profileReps : 0,
      noteFormat: 'renderMemory() from lib/shared/markdown.js (byte-identical to service.save())',
    },
    results,
  }

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  if (config.json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    printTable(results, config)
    console.log(`JSON written to ${outPath}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
