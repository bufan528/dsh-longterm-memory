/**
 * Lightweight drift check: README/docs verified DSH version must match engines + compatibility metadata.
 *
 * The previous implementation tested range membership with `engines.includes(version)`,
 * a substring test. That only ever passed while the range's lower bound was spelled
 * identically to the verified version; the moment the range was widened (e.g. to admit
 * `0.2.1-rc.2` hosts) the literal disappeared and the check reported a false failure
 * even though the version was perfectly inside the range. A quiet range-widening must not
 * be able to flip this gate red, so the comparison below is real semver precedence.
 *
 * No `semver` dependency is added: this repo ships `yaml` + `zod` only, and a lint script
 * is not a good reason to grow the production dependency tree.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (p) => readFileSync(path.resolve(process.cwd(), p), 'utf8')
const pkg = JSON.parse(read('package.json'))
const engines = String(pkg?.engines?.dsh ?? '')
const readme = read('README.md')
const compatDoc = read('docs/compatibility.md')
const zhReadme = read('docs/README.zh-CN.md')
const pattern = /(?:已验证的\s*DSH\s*版本|Verified DSH version)[^0-9]*([0-9][0-9A-Za-z.\-]*)/i
const readmeVersion = pattern.exec(readme)?.[1]
const docVersion = pattern.exec(compatDoc)?.[1]
const declared = Object.keys(pkg?.dsh?.compatibility?.dshReleases ?? {})
const problems = []

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(text) {
  const match = VERSION_RE.exec(String(text).trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Semver §11 identifier precedence: numeric identifiers compare numerically and rank below alphanumeric ones. */
function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b))
  if (aNumeric) return -1
  if (bNumeric) return 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Semver §11 precedence: a prerelease ranks below the release it precedes. */
function compareVersions(a, b) {
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return Math.sign(a[field] - b[field])
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const bound = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < bound; index += 1) {
    if (a.pre[index] === undefined) return -1
    if (b.pre[index] === undefined) return 1
    const delta = compareIdentifier(a.pre[index], b.pre[index])
    if (delta !== 0) return delta
  }
  return 0
}

const OPERATORS = new Set(['>=', '<=', '>', '<', '='])

/**
 * Range support is deliberately limited to the comparator form this repo actually declares
 * (`>=x.y.z-rc.n <x.y.z`). Anything else is reported instead of silently passing, because a
 * gate that quietly accepts what it cannot parse is worse than no gate.
 */
function checkRange(version, range) {
  const parsed = parseVersion(version)
  if (parsed === null) return { ok: false, reason: `无法解析版本号 ${version}` }
  const comparators = range.trim().split(/\s+/).filter(Boolean)
  if (comparators.length === 0) return { ok: false, reason: 'engines.dsh 为空' }
  for (const comparator of comparators) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator)
    const operator = match?.[1] ?? '='
    const target = parseVersion(match?.[2] ?? '')
    if (!OPERATORS.has(operator) || target === null) {
      return { ok: false, reason: `不支持的版本范围写法 ${JSON.stringify(comparator)}（仅支持空格分隔的比较符）` }
    }
    const delta = compareVersions(parsed, target)
    const satisfied =
      operator === '>='
        ? delta >= 0
        : operator === '<='
          ? delta <= 0
          : operator === '>'
            ? delta > 0
            : operator === '<'
              ? delta < 0
              : delta === 0
    if (!satisfied) return { ok: false, reason: null }
  }
  return { ok: true, reason: null }
}

if (readmeVersion === undefined) problems.push('README 缺少“已验证的 DSH 版本”声明')
if (docVersion === undefined) problems.push('docs/compatibility.md 缺少“已验证的 DSH 版本”声明')
if (readmeVersion !== undefined && docVersion !== undefined && readmeVersion !== docVersion) {
  problems.push('README 与 docs/compatibility.md 的已验证版本不一致: ' + readmeVersion + ' vs ' + docVersion)
}
if (readmeVersion !== undefined) {
  const range = checkRange(readmeVersion, engines)
  if (!range.ok) {
    problems.push(
      `已验证版本 ${readmeVersion} 不在 engines.dsh 范围内: ${engines}` +
        (range.reason === null ? '' : `（${range.reason}）`),
    )
  }
}
if (declared.length > 0 && readmeVersion !== undefined && !declared.includes(readmeVersion)) {
  problems.push('dsh.compatibility 未包含已验证版本 ' + readmeVersion)
}

// A semver membership test alone cannot tell "the range was widened on purpose" from
// "someone quietly lowered the floor and forgot the docs". Both READMEs and
// docs/compatibility.md publish the range as the compatibility contract, so require the
// published value to equal `engines.dsh`; moving one without the other is drift either way.
const DECLARED_RANGE = /`\s*(>=[^`]+?)`/
const publishedRanges = [
  ['README.md', readme],
  ['docs/README.zh-CN.md', zhReadme],
  ['docs/compatibility.md', compatDoc],
]
for (const [label, source] of publishedRanges) {
  const published = DECLARED_RANGE.exec(source)?.[1]?.trim()
  if (published === undefined) {
    problems.push(label + ' 未声明 DSH 运行时范围（应以 `>=x.y.z` 形式出现在反引号内）')
    continue
  }
  if (published !== engines.trim()) {
    problems.push(label + ' 声明的范围与 engines.dsh 不一致: ' + published + ' vs ' + engines)
  }
}
if (problems.length > 0) {
  console.error('version consistency: FAIL')
  for (const problem of problems) console.error(' - ' + problem)
  process.exit(1)
}
console.log('version consistency: OK (' + String(readmeVersion) + ' in ' + engines + ')')
