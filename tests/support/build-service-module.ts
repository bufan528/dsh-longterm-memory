/**
 * Build an importable module from the *current* plugin source.
 *
 * Several crash-recovery tests need a second OS process running the same code as
 * the test itself. That child used to import `lib/host/core/service.js`, i.e. the
 * last released build — so once `src/` changed, parent and child disagreed about
 * the on-disk format and recovery checks failed for a reason that had nothing to
 * do with the code under test.
 *
 * Bundling `src/host/core/service.ts` into a single ESM file fixes the mismatch
 * without touching the release build (`lib/`), which stays frozen. The bundle is
 * written to the OS temp directory: nothing is added to the repository, and the
 * file name is per-process so parallel suites cannot collide.
 */
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let cached: string | undefined

export async function buildServiceModule(): Promise<string> {
  if (cached !== undefined) return cached
  const directory = join(tmpdir(), 'dsh-mv-service-under-test')
  await mkdir(directory, { recursive: true })
  const outfile = join(directory, `service-${String(process.pid)}.cjs`)
  await build({
    entryPoints: [join(process.cwd(), 'src', 'host', 'core', 'service.ts')],
    bundle: true,
    platform: 'node',
    // CommonJS on purpose: bundling `yaml` into an ESM file leaves esbuild's
    // `__require` shim, which throws "Dynamic require of process is not supported".
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    sourcemap: false,
  })
  cached = outfile
  return outfile
}

/** Best-effort cleanup; a leftover temp file is harmless. */
export async function removeServiceModule(): Promise<void> {
  if (cached === undefined) return
  await rm(cached, { force: true }).catch(() => undefined)
  cached = undefined
}
