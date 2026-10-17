#!/usr/bin/env node
/**
 * Build the **browser half** of the plugin.
 *
 * DSH ships no bundler configuration for third-party client plugins, so the one
 * required output format is produced here by hand:
 *
 * ```js
 * window.__ModuleLoader__.load({
 *   id: '<package name>',
 *   factory: (require) => {
 *     var module = { exports: {} };
 *     var exports = module.exports;
 *     /* … bundled CommonJS body … *\/
 *     return module.exports;
 *   }
 * });
 * ```
 *
 * The file must be a *classic* script: executing it may only register the lazy
 * factory; every side effect happens when the factory is materialized. `react`
 * and `react/jsx-runtime` are resolved by the loader's platform seed table, so
 * they stay external and must never be inlined.
 *
 * The script fails loudly (non-zero exit) when the entry is missing, when
 * esbuild emits no output, when the wrapper lost its `__ModuleLoader__.load`
 * call, or when the body would need a runtime dependency outside the seed table.
 *
 * Usage: `node scripts/build-client.mjs`
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

/** The package id; it must equal `package.json`'s `name` field. */
const PACKAGE_ID = 'dsh-longterm-memory'

/** Module specifiers the DSH module loader resolves at runtime. */
const RUNTIME_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entryPoint = resolve(root, 'src', 'client', 'index.ts')
const outFile = resolve(root, 'lib', 'client.js')

/** Print a reason and stop with a non-zero exit code. */
function fail(message) {
  console.error(`build-client: ${message}`)
  process.exit(1)
}

/** Indent a block of text by two tabs, leaving blank lines untouched. */
function indent(text, tabs) {
  const prefix = '\t'.repeat(tabs)
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join('\n')
}

if (!existsSync(entryPoint)) {
  fail(`entry not found: ${entryPoint}`)
}

const result = await esbuild.build({
  entryPoints: [entryPoint],
  // `outfile` is only used to name the in-memory artifact; `write: false` keeps
  // esbuild from touching the disk so the wrapper below is the single writer.
  outfile: outFile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  write: false,
  minify: false,
  sourcemap: false,
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning',
  external: RUNTIME_EXTERNALS,
})

const output = result.outputFiles?.find((file) => file.path.endsWith('.js')) ?? result.outputFiles?.[0]
if (output === undefined) {
  fail('esbuild produced no JavaScript output')
}

const body = output.text.replace(/\n+$/, '')

const strayRequires = [...new Set([...body.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]))].filter(
  (specifier) => !RUNTIME_EXTERNALS.includes(specifier),
)
if (strayRequires.length > 0) {
  fail(
    `the bundle requires ${strayRequires.join(', ')} at runtime; only ${RUNTIME_EXTERNALS.join(', ')} are in the ` +
      'platform seed table. The factory would throw when materialized.',
  )
}

const wrapped = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(PACKAGE_ID)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  indent(body, 2),
  '',
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')

if (!wrapped.includes('__ModuleLoader__.load')) {
  fail('the wrapped bundle does not contain a __ModuleLoader__.load call')
}

await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, wrapped, 'utf8')

const bytes = Buffer.byteLength(wrapped, 'utf8')
console.log(`build-client: wrote ${outFile} (${bytes} bytes, id ${PACKAGE_ID})`)
