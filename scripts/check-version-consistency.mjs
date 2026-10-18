/** Lightweight drift check: README/docs verified DSH version must match engines + compatibility metadata. */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (p) => readFileSync(path.resolve(process.cwd(), p), 'utf8')
const pkg = JSON.parse(read('package.json'))
const engines = String(pkg?.engines?.dsh ?? '')
const readme = read('README.md')
const compatDoc = read('docs/compatibility.md')
const pattern = /(?:已验证的\s*DSH\s*版本|Verified DSH version)[^0-9]*([0-9][0-9A-Za-z.\-]*)/i
const readmeVersion = pattern.exec(readme)?.[1]
const docVersion = pattern.exec(compatDoc)?.[1]
const declared = Object.keys(pkg?.dsh?.compatibility?.dshReleases ?? {})
const problems = []
if (readmeVersion === undefined) problems.push('README 缺少“已验证的 DSH 版本”声明')
if (docVersion === undefined) problems.push('docs/compatibility.md 缺少“已验证的 DSH 版本”声明')
if (readmeVersion !== undefined && docVersion !== undefined && readmeVersion !== docVersion) {
  problems.push('README 与 docs/compatibility.md 的已验证版本不一致: ' + readmeVersion + ' vs ' + docVersion)
}
if (readmeVersion !== undefined && !engines.includes(readmeVersion)) {
  problems.push('已验证版本 ' + readmeVersion + ' 不在 engines.dsh 范围内: ' + engines)
}
if (declared.length > 0 && readmeVersion !== undefined && !declared.includes(readmeVersion)) {
  problems.push('dsh.compatibility 未包含已验证版本 ' + readmeVersion)
}
if (problems.length > 0) {
  console.error('version consistency: FAIL')
  for (const problem of problems) console.error(' - ' + problem)
  process.exit(1)
}
console.log('version consistency: OK (' + String(readmeVersion) + ' in ' + engines + ')')
