/**
 * 版本一致性门禁的端到端测试。
 *
 * 这个脚本原来的范围判断是 `engines.includes(version)`（子串匹配）：
 * 只要范围下界与「已验证版本」字面量不一致，就会误报失败——即使版本确实在范围内。
 * 修好后必须证明两件事，缺一不可：
 *   1. 版本在范围内时放行（不再误报）；
 *   2. 版本真的越界、或范围写法无法解析时仍然拦下（没有把门禁变成空壳）。
 *
 * @module tests/unit/version-consistency-gate.test
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'check-version-consistency.mjs')

interface GateResult {
  code: number
  output: string
}

function runGate(workdir: string): GateResult {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { code: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function makeWorkdir(options: {
  engines: string
  readmeVersion?: string
  docVersion?: string
  releases?: string[]
  publishedRange?: string
}): string {
  const dir = mkdtempSync(path.join(repoRoot, '.scratch', 'vergate-'))
  const readmeVersion = options.readmeVersion ?? '0.2.1-rc.3'
  const docVersion = options.docVersion ?? readmeVersion
  const releases = options.releases ?? [readmeVersion]
  const publishedRange = options.publishedRange ?? options.engines

  const manifest: Record<string, unknown> = { name: 'gate-probe', version: '0.0.0' }
  manifest['engines'] = { node: '>=20', dsh: options.engines }
  if (releases.length > 0) {
    manifest['dsh'] = {
      compatibility: {
        dshReleases: Object.fromEntries(releases.map((version) => [version, { verified: true }])),
      },
    }
  }

  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(
    path.join(dir, 'README.md'),
    `| DSH runtime | \`${publishedRange}\` (\`engines.dsh\`)\n\n已验证的 DSH 版本：${readmeVersion}\n`,
  )
  mkdirSync(path.join(dir, 'docs'), { recursive: true })
  writeFileSync(
    path.join(dir, 'docs', 'README.zh-CN.md'),
    `| DSH 运行时 | \`${publishedRange}\`（\`engines.dsh\`） |\n`,
  )
  writeFileSync(
    path.join(dir, 'docs', 'compatibility.md'),
    `| 本包 \`engines.dsh\` 声明 | \`${publishedRange}\` |\n\n已验证的 DSH 版本：${docVersion}\n`,
  )
  return dir
}

describe('版本一致性门禁', () => {
  it('下界被放宽后不再误报：0.2.1-rc.3 落在 >=0.2.1-rc.2 <0.2.2 内', () => {
    // 这正是旧实现失败的那一例：字面量 "0.2.1-rc.3" 不是范围串的子串。
    const dir = makeWorkdir({ engines: '>=0.2.1-rc.2 <0.2.2' })
    const result = runGate(dir)
    expect(result.output).toContain('version consistency: OK')
    expect(result.code).toBe(0)
  })

  it('已验证版本低于下界时仍然拦下', () => {
    const dir = makeWorkdir({ engines: '>=0.2.1-rc.3 <0.2.2', readmeVersion: '0.2.1-rc.2' })
    const result = runGate(dir)
    expect(result.code).toBe(1)
    expect(result.output).toContain('不在 engines.dsh 范围内')
  })

  it('已验证版本达到上界时仍然拦下（prerelease 不得越界）', () => {
    const dir = makeWorkdir({ engines: '>=0.2.1-rc.3 <0.2.2', readmeVersion: '0.2.2' })
    const result = runGate(dir)
    expect(result.code).toBe(1)
    expect(result.output).toContain('不在 engines.dsh 范围内')
  })

  it('0.2.2 的 prerelease 按 semver 视为小于 0.2.2，因此允许', () => {
    const dir = makeWorkdir({ engines: '>=0.2.1-rc.3 <0.2.2', readmeVersion: '0.2.2-rc.1' })
    const result = runGate(dir)
    expect(result.code).toBe(0)
  })

  it('无法解析的范围写法如实报错，而不是静默通过', () => {
    const dir = makeWorkdir({ engines: '^0.2.1' })
    const result = runGate(dir)
    expect(result.code).toBe(1)
    expect(result.output).toContain('不支持的版本范围写法')
  })

  it('README 与兼容性文档的已验证版本不一致时拦下', () => {
    const dir = makeWorkdir({
      engines: '>=0.2.1-rc.2 <0.2.2',
      readmeVersion: '0.2.1-rc.3',
      docVersion: '0.2.1-rc.2',
    })
    const result = runGate(dir)
    expect(result.code).toBe(1)
    expect(result.output).toContain('不一致')
  })

  it('manifest 悄悄放宽下界而文档未改时拦下', () => {
    // 这正是工作区里实际发生过的漂移：engines 从 rc.3 放宽到 rc.2，
    // 三份文档仍写 rc.3。纯 semver 成员判断会放过它，所以必须比对文档。
    const dir = makeWorkdir({
      engines: '>=0.2.1-rc.2 <0.2.2',
      readmeVersion: '0.2.1-rc.3',
      publishedRange: '>=0.2.1-rc.3 <0.2.2',
    })
    const result = runGate(dir)
    expect(result.code).toBe(1)
    expect(result.output).toContain('声明的范围与 engines.dsh 不一致')
  })

  it('仓库自身的真实清单通过', () => {
    const result = runGate(repoRoot)
    expect(result.output).toContain('version consistency: OK')
    expect(result.code).toBe(0)
  })
})
