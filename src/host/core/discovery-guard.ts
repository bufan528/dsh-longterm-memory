/**
 * Test-mode discovery confinement.
 *
 * Discovery is how a vault at a user-default location (Documents, Desktop) becomes
 * a write target. In production that behaviour is intended: the user asked the
 * plugin to find their vault. In tests it is a hazard.
 *
 * When `DSH_MEMORY_TEST_ROOT` is set, every discovery result is narrowed to that
 * root: candidates outside it are dropped and a `current` outside it is ignored, so
 * the service can never silently adopt a real user vault during a test run.
 *
 * @module dsh-longterm-memory/host/core/discovery-guard
 */

import {
  filterCandidatesForTestMode,
  isInsideRoot,
  testRootFromEnv,
  userDefaultDirectories,
} from '../../shared/path-safety.js'
import type { VaultDiscovery } from '../../shared/types.js'

/**
 * Confine a discovery result to the configured test root.
 *
 * With no test root configured this returns the input unchanged, so production
 * discovery keeps its documented behaviour.
 */
export function confineDiscoveryToTestRoot(
  discovery: VaultDiscovery,
  env: NodeJS.ProcessEnv = process.env,
): VaultDiscovery {
  const testRoot = testRootFromEnv(env)
  if (testRoot === null) return discovery

  const defaults = userDefaultDirectories()
  const isForbidden = (candidate: string): boolean =>
    defaults.some((forbidden) => isInsideRoot(candidate, forbidden) || isInsideRoot(forbidden, candidate))

  const candidates = filterCandidatesForTestMode(discovery.candidates, testRoot).filter((candidate) => !isForbidden(candidate))
  const current =
    discovery.current !== null && isInsideRoot(discovery.current, testRoot) && !isForbidden(discovery.current)
      ? discovery.current
      : null

  return {
    ...discovery,
    current,
    candidates,
    // Nothing safe to offer means the caller must not auto-create anything.
    needsChoice: candidates.length === 0 ? false : discovery.needsChoice,
    warnings: [...discovery.warnings, '测试模式：自动发现结果已限制在测试根目录内。'],
  }
}
