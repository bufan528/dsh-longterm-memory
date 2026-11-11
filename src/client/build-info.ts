/**
 * Which client bundle is the shell actually running?
 *
 * The desktop application loads a plugin's browser bundle into memory once and
 * keeps it until the process exits. Editing `lib/client.js` on disk does **not**
 * change what an already-open panel is showing. That failure mode is invisible:
 * the page looks stale, so it gets reported as "the redesign did not work".
 *
 * `scripts/build-client.mjs` bakes a UTC build stamp into the bundle through
 * esbuild's `define`. The page shows it, so "old UI" and "missing feature" are
 * immediately distinguishable — and the user can tell whether a restart is
 * needed without asking anyone.
 *
 * @module dsh-longterm-memory/client/build-info
 */

/** Injected by the build script. Declared for the type checker only. */
declare const __LMV_BUILD_ID__: string | undefined

/** `YYYYMMDD-HHmmss` UTC, or `dev` when the source is run outside the bundle. */
export const CLIENT_BUILD_ID: string =
  typeof __LMV_BUILD_ID__ === 'string' && __LMV_BUILD_ID__.length > 0 ? __LMV_BUILD_ID__ : 'dev'
