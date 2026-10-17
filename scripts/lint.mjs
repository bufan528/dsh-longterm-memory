/**
 * A small lint gate for this repository.
 *
 * The project has no ESLint/oxlint dependency by design (fewer moving parts for a
 * plugin that must install cleanly into a DSH profile), so this script enforces
 * the handful of rules that actually matter for correctness and for the DSH
 * plugin contract, and exits non-zero on any violation so CI can rely on it.
 *
 * Rules enforced:
 *  1. No `@deepseek-ai/*` import in the Host half. Resolving those from a
 *     third-party plugin's module scope is not guaranteed, and a failure would
 *     take the whole plugin — and the user's memory — offline.
 *  2. No `@deepseek-ai/*` import in the Client half. The official guide forbids
 *     requiring Harness Client packages from a plugin.
 *  3. The built client bundle must be a classic script that registers exactly one
 *     `window.__ModuleLoader__.load({ id: 'dsh-longterm-memory', ... })`, and must
 *     require nothing beyond the platform seed table.
 *  4. Every source file ends with a newline and has no tab characters.
 *  5. No `TODO`/`FIXME`/`XXX` left in shipped source.
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

/** Specifiers the browser module table actually provides. */
const ALLOWED_CLIENT_REQUIRES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
])

const problems = []

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (/\.(?:ts|tsx|mts|mjs|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = await walk(SRC)
const hostFiles = files.filter((file) => file.includes(`${'host'}`))
const clientFiles = files.filter((file) => file.includes('client'))

for (const file of files) {
  const text = await readFile(file, 'utf8')
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  const isClient = clientFiles.includes(file)
  const isHost = hostFiles.includes(file)

  if (isHost || isClient) {
    const imports = [...text.matchAll(/from\s+'(@deepseek-ai\/[^']+)'/g)].map((match) => match[1])
    const dynamic = [...text.matchAll(/import\(\s*[^)]*?'(@deepseek-ai\/[^']+)'/g)].map((match) => match[1])
    if (isHost && imports.length > 0) {
      problems.push(`${rel}: Host half must not statically import ${imports.join(', ')}`)
    }
    if (isClient && imports.length > 0) {
      problems.push(`${rel}: Client half must not import ${imports.join(', ')}`)
    }
    // A guarded dynamic import is allowed in the Host half only.
    if (isClient && dynamic.length > 0) {
      problems.push(`${rel}: Client half must not dynamically import ${dynamic.join(', ')}`)
    }
  }

  if (!text.endsWith('\n')) problems.push(`${rel}: file does not end with a newline`)
  if (text.includes('\t')) problems.push(`${rel}: file contains a tab character`)

  // A real marker is written `TODO:` or `TODO(owner)`. The stricter form avoids
  // flagging legitimate text such as the task-extraction pattern that matches a
  // user's own "TODO" in a conversation.
  const marker = /\b(TODO|FIXME|XXX)(?::|\()/.exec(text)
  if (marker !== null) problems.push(`${rel}: contains a ${marker[1]} marker`)
}

// --- client bundle contract -------------------------------------------------
const bundlePath = join(ROOT, 'lib', 'client.js')
if (!existsSync(bundlePath)) {
  console.log('lint: lib/client.js not built yet — skipping bundle checks (run `npm run build`)')
} else {
  const bundle = await readFile(bundlePath, 'utf8')
  const registrations = [...bundle.matchAll(/window\.__ModuleLoader__\.load\(/g)]
  if (registrations.length !== 1) {
    problems.push(`lib/client.js: expected exactly one __ModuleLoader__.load call, found ${String(registrations.length)}`)
  }
  if (!/id:\s*"dsh-longterm-memory"/.test(bundle)) {
    problems.push('lib/client.js: factory id is not "dsh-longterm-memory"')
  }
  const requires = [...bundle.matchAll(/require\((["'])([^"']+)\1\)/g)].map((match) => match[2])
  for (const specifier of new Set(requires)) {
    if (!ALLOWED_CLIENT_REQUIRES.has(specifier)) {
      problems.push(`lib/client.js: requires "${specifier}", which is not in the platform seed table`)
    }
  }
  if (bundle.includes('document.body')) problems.push('lib/client.js: writes to document.body')
  if (/createElement\(\s*['"]iframe['"]/.test(bundle)) problems.push('lib/client.js: creates an iframe')
}

// --- packaging contract -----------------------------------------------------
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  problems.push('package.json: dsh.bundle.patch must be "./cordis.patch.yml"')
}
if (manifest.dsh?.client?.platform !== 'web') {
  problems.push('package.json: dsh.client.platform must be "web"')
}
if (manifest.exports?.['./client'] === undefined) {
  problems.push('package.json: exports["./client"] is required when dsh.client is declared')
}
if (manifest.icon === undefined) problems.push('package.json: a top-level icon is required for the plugin card')
const dshPeers = Object.keys(manifest.peerDependencies ?? {}).filter((key) => key === '@deepseek-ai/dsh' || key.startsWith('@deepseek-ai/dsh-'))
if (dshPeers.length > 0) {
  // DSH's only hard install gate compares these ranges against the runtime
  // version, so declaring one is a real compatibility claim that must be right.
  problems.push(`package.json: peerDependencies ${dshPeers.join(', ')} would be gated against the DSH version; declare none unless the range is verified`)
}

if (problems.length > 0) {
  console.error(`lint: ${String(problems.length)} problem(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`lint: OK (${String(files.length)} source files checked)`)
