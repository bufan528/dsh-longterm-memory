import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Windows: several suites touch the same temp root; run files serially so
    // filesystem timing cannot make an unrelated suite flaky.
    fileParallelism: false,
    testTimeout: 30_000,
    env: { DSH_MEMORY_TEST_ROOT: path.resolve(process.cwd(), '.scratch') },
    hookTimeout: 30_000,
    reporters: ['default'],
  },
})
