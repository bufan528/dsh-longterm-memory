#!/usr/bin/env node
/**
 * ui-e2e-flows.mjs — real-browser end-to-end user flows for the DSH Memory Vault
 * (长期记忆) plugin.
 *
 * This is verification infrastructure, not product code. It drives a real Chrome
 * over the dependency-free CDP harness in `ui-verify.mjs`, clicks the plugin's
 * real UI, and verifies every effect through the plugin's own HTTP RPC plus the
 * Markdown files on disk. It is the end-to-end complement to the rendering-only
 * acceptance scripts: it actually *does* the things a user does.
 *
 *   node scripts/ui-e2e-flows.mjs --url "http://127.0.0.1:<port>/?token=..." \
 *     [--out .scratch/e2e-flows] [--browser <path>] [--headless new|old]
 *
 * Covered flows:
 *   shell     sidebar entry opens the page; all five tabs render without errors
 *   overview  manual index rebuild + index sync succeed
 *   inbox     add candidate → confirm  (the reported "buttons do nothing" bug)
 *   inbox     add candidate → reject   (must not write a file)
 *   inbox     confirm a duplicate candidate → merged, no duplicate record
 *   search    find → open detail → archive/restore → pin/unpin
 *   detail    raw Markdown read → edit → write
 *   detail    two-step delete
 *   settings  change a budget, save, reload, verify persistence
 *   settings  language switch zh → en → zh
 *   settings  preview recall renders text
 *   manage    batch pin selected search results
 *
 * Exit code 0 = every check passed, 1 = at least one failed, 2 = harness failure.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { BrowserHarness, WORKSPACE, delay, redactUrl } from './ui-verify.mjs'

const API = '/dsh-longterm-memory/api'
const DEFAULT_OUT = path.join(WORKSPACE, '.scratch', 'e2e-flows')
const STAMP = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
const TAG = `E2E${STAMP}`

const usage = `Usage: node scripts/ui-e2e-flows.mjs --url <dsh-web-url> [--out <dir>] [--browser <path>] [--headless new|old] [--cookie-file <path>]

The desktop app's web listener requires its launch cookie. When the app is
already running, mint one for this machine from the persisted browser-session
secret and pass it with --cookie-file (file content: one "name=value" line).
`
const argv = process.argv.slice(2)
function arg(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
const url = arg('url')
const outDir = path.resolve(arg('out', DEFAULT_OUT))
const browserPath = arg('browser', undefined)
const headless = arg('headless', 'new')
const cookieFile = arg('cookie-file', undefined)
if (!url) {
  console.error(usage)
  process.exit(2)
}

/* ------------------------------------------------------------------ *
 * Results / assertions
 * ------------------------------------------------------------------ */

const results = []
const shots = []
function check(name, ok, detail = '') {
  const entry = { name, ok: ok === true, ...(detail ? { detail: String(detail).slice(0, 500) } : {}) }
  results.push(entry)
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).slice(0, 300)}` : ''}`)
  return entry.ok
}
function summarize() {
  const failed = results.filter((entry) => !entry.ok)
  return { passed: results.length - failed.length, failed: failed.length, floor: results.length }
}

/* ------------------------------------------------------------------ *
 * Page-side helpers (serialised with toString(); must be self-contained)
 * ------------------------------------------------------------------ */

const pageVisible = `(el) => {
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
  return true
}`
void pageVisible

function pageClickText(scope, text, exact) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    return true
  }
  const root = scope === null || scope === undefined ? document : document.querySelector(scope)
  if (root === null) return { found: false, reason: `no scope ${scope}` }
  const target = norm(text).toLowerCase()
  const matches = []
  for (const el of root.querySelectorAll('button, a, [role="button"], .lmv-row-click, .lmv-nav-btn')) {
    if (!visible(el)) continue
    if (el.disabled === true) continue
    const own = norm(el.innerText ?? el.textContent).toLowerCase()
    if (exact === true ? own !== target : !own.includes(target)) continue
    const rect = el.getBoundingClientRect()
    matches.push({ el, rect, area: rect.width * rect.height, text: norm(el.innerText ?? el.textContent).slice(0, 80) })
  }
  if (matches.length === 0) return { found: false, count: 0 }
  matches.sort((left, right) => left.area - right.area)
  const chosen = matches[0]
  chosen.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  chosen.el.click()
  return { found: true, count: matches.length, text: chosen.text, tag: chosen.el.tagName.toLowerCase() }
}

function pageClickNav(tab) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const button = [...document.querySelectorAll('.lmv-nav-btn')].find((el) => norm(el.innerText) === tab)
  if (button === undefined) return { found: false }
  button.click()
  return { found: true }
}

function pageClickRowAction(title, buttonText) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
  }
  const rows = [...document.querySelectorAll('.lmv-row')].filter(visible)
  const row = rows.find((el) => norm(el.querySelector('.lmv-row-title')?.textContent).includes(title))
  if (row === undefined) return { found: false, reason: 'row not found', rows: rows.map((el) => norm(el.querySelector('.lmv-row-title')?.textContent).slice(0, 40)) }
  const button = [...row.querySelectorAll('button')].find((el) => norm(el.innerText) === buttonText)
  if (button === undefined) return { found: false, reason: 'button not found', buttons: [...row.querySelectorAll('button')].map((el) => norm(el.innerText)) }
  if (button.disabled === true) return { found: false, reason: 'button disabled' }
  button.scrollIntoView({ block: 'center', behavior: 'instant' })
  button.click()
  return { found: true }
}

function pageClickRow(title) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
  }
  const rows = [...document.querySelectorAll('.lmv-row')].filter(visible)
  const row = rows.find((el) => norm(el.querySelector('.lmv-row-title')?.textContent).includes(title))
  if (row === undefined) return { found: false, reason: 'row not found', rows: rows.map((el) => norm(el.querySelector('.lmv-row-title')?.textContent).slice(0, 40)) }
  const clickable = row.querySelector('.lmv-row-click')
  const target = clickable ?? row.querySelector('button')
  if (target === undefined) return { found: false, reason: 'row is not clickable' }
  target.click()
  return { found: true }
}

function pageSetField(label, value) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const fields = [...document.querySelectorAll('.lmv-field')]
  const field = fields.find((el) => norm(el.querySelector('.lmv-field-label')?.textContent).startsWith(label))
  if (field === undefined) return { ok: false, reason: `no field ${label}`, labels: fields.map((el) => norm(el.querySelector('.lmv-field-label')?.textContent).slice(0, 20)) }
  const el = field.querySelector('input, textarea, select')
  if (el === null) return { ok: false, reason: 'field has no control' }
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter === undefined) return { ok: false, reason: 'no value setter' }
  el.focus()
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, tag: el.tagName.toLowerCase(), value: String(el.value).slice(0, 60) }
}

function pageSetCheckbox(label, checked) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const labelEl = [...document.querySelectorAll('label.lmv-check')].find((el) => norm(el.innerText).includes(label))
  if (labelEl === undefined) return { ok: false, reason: `no checkbox ${label}` }
  const input = labelEl.querySelector('input')
  if (input === null) return { ok: false, reason: 'no input' }
  if (input.checked !== checked) input.click()
  return { ok: true, checked: input.checked }
}

function pageFillPlaceholder(placeholder, value) {
  const el = [...document.querySelectorAll('input, textarea')].find((candidate) => candidate.getAttribute('placeholder') === placeholder)
  if (el === undefined) return { ok: false, reason: `no placeholder ${placeholder}` }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true, value: el.value }
}

function pageSnapshot() {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
  }
  const page = document.querySelector('.lmv-page')
  const activeTab = page === null ? '' : norm(page.querySelector('.lmv-nav-btn-on')?.innerText)
  const rows = page === null ? [] : [...page.querySelectorAll('.lmv-row-title')].filter(visible).map((el) => norm(el.textContent))
  const toasts = [...document.querySelectorAll('.lmv-toasts')].filter(visible).map((el) => norm(el.innerText))
  const errors = [...document.querySelectorAll('.lmv-notice-error')].filter(visible).map((el) => norm(el.innerText))
  const modal = [...document.querySelectorAll('.lmv-modal')].filter(visible).map((el) => norm(el.innerText).slice(0, 300))
  const text = page === null ? '' : norm(page.innerText)
  const buttons = page === null ? [] : [...page.querySelectorAll('button')].filter(visible).map((el) => norm(el.innerText))
  return { hasPage: page !== null, activeTab, rows, toasts, errors, modal, text, buttons }
}

function pageFillRaw(value) {
  const area = [...document.querySelectorAll('textarea')].find((el) => el.closest('.lmv-main') !== null)
  if (area === undefined) return { ok: false, reason: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter.call(area, value)
  area.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true, length: area.value.length }
}

function pageReadRaw() {
  const area = [...document.querySelectorAll('textarea')].find((el) => el.closest('.lmv-main') !== null)
  return area === undefined ? null : area.value
}

/* ------------------------------------------------------------------ *
 * Node-side driver helpers
 * ------------------------------------------------------------------ */

let browser = null
let shotIndex = 0

async function call(pageFn, ...args) {
  const callArgs = args.map((value) => JSON.stringify(value)).join(', ')
  return await browser.evaluate(`(${pageFn.toString()})(${callArgs})`)
}

async function rpc(method, payload = {}) {
  const expression = `fetch(${JSON.stringify(`${API}/${method}`)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: ${JSON.stringify(JSON.stringify(payload))}
  }).then((response) => response.json())`
  const envelope = await browser.evaluate(expression)
  if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) {
    const error = envelope?.error
    throw new Error(`RPC ${method} failed: ${error?.code ?? 'bad-envelope'} ${error?.message ?? JSON.stringify(envelope)}`)
  }
  return envelope.data
}

async function snapshot() {
  return await call(pageSnapshot)
}

async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await predicate()
      if (last !== false && last !== null && last !== undefined) return last
    } catch (error) {
      last = { error: String(error) }
    }
    await delay(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)?.slice(0, 400)}`)
}

async function waitText(text, options = {}) {
  return await waitFor(async () => {
    const state = await snapshot()
    return state.text.includes(text) ? state : null
  }, { label: `text ${JSON.stringify(text)}`, ...options })
}

async function waitDetail() {
  return await waitFor(async () => {
    const state = await snapshot()
    return state.buttons.includes('归档') && state.text.includes('字段编辑') ? state : null
  }, { label: 'detail page', timeoutMs: 12_000 })
}

async function waitToast(fragment, options = {}) {
  return await waitFor(async () => {
    const state = await snapshot()
    const toast = state.toasts.find((entry) => entry.includes(fragment))
    return toast === undefined ? null : toast
  }, { label: `toast ${JSON.stringify(fragment)}`, timeoutMs: 8000, ...options })
}

async function shot(name) {
  shotIndex += 1
  const file = path.join(outDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`)
  const info = await browser.screenshot(file)
  shots.push({ name, path: info.path, bytes: info.bytes })
  return info.path
}

async function openPluginPage({ reload = false } = {}) {
  if (reload) await browser.goto(url, { settleMs: 3000 })
  // Dismiss blocking first-run dialogs (preview notice, account onboarding, …)
  // before the sidebar is clickable. DOM clicks are used here instead of CDP
  // pointer events: the desktop shell layers its own widgets over the sidebar,
  // and a coordinate click can land on the wrong element.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dismissed = await browser.evaluate(`(() => {
      const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim()
      const visible = (el) => {
        const rect = el.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      }
      const buttons = [...document.querySelectorAll('button')].filter(visible)
      const close = buttons.find((el) => el.getAttribute('aria-label') === '关闭' || norm(el.innerText) === '关闭')
      const cont = buttons.find((el) => norm(el.innerText) === '继续')
      const target = close ?? cont
      if (target === undefined) return false
      target.click()
      return true
    })()`)
    if (dismissed !== true) break
    await delay(600)
  }
  await waitFor(async () => {
    const state = await browser.evaluate(`(() => {
      const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
      const visible = (el) => {
        const rect = el.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      }
      return [...document.querySelectorAll('button, a, [role="button"], [data-panel-id]')]
        .some((el) => visible(el) && norm(el.innerText) === '长期记忆')
    })()`)
    return state === true ? true : null
  }, { timeoutMs: 20000, label: 'sidebar 长期记忆 entry' })
  const clicked = await browser.evaluate(`(() => {
    const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return false
      const style = getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
    }
    const buttons = [...document.querySelectorAll('button, a, [role="button"], [data-panel-id]')].filter(visible)
    const target = buttons.find((el) => norm(el.innerText) === '长期记忆')
    if (target === undefined) return false
    target.click()
    return true
  })()`)
  if (clicked !== true) throw new Error('sidebar 长期记忆 entry could not be clicked')
  await waitFor(async () => (await snapshot()).hasPage, { timeoutMs: 20000, label: 'plugin page' })
  await delay(600)
}

async function setField(label, value) {
  const result = await call(pageSetField, label, value)
  if (result?.ok !== true) throw new Error(`setField ${label} failed: ${JSON.stringify(result)}`)
  return result
}

async function clickText(text, { scope = '.lmv-page', exact = true } = {}) {
  const result = await call(pageClickText, scope, text, exact)
  if (result?.found !== true) throw new Error(`clickText ${JSON.stringify(text)} failed: ${JSON.stringify(result)}`)
  return result
}

/** Wait until a visible, enabled button with this exact label exists. */
async function waitButtonEnabled(text) {
  return await waitFor(async () => {
    const ready = await browser.evaluate(`(() => {
      const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim()
      const button = [...document.querySelectorAll('.lmv-page button')].find((el) => norm(el.innerText) === ${JSON.stringify(text)})
      if (button === undefined) return false
      const rect = button.getBoundingClientRect()
      return button.disabled !== true && rect.width >= 2 && rect.height >= 2 ? true : false
    })()`)
    return ready === true ? true : null
  }, { label: `enabled button ${JSON.stringify(text)}`, timeoutMs: 12_000 })
}

/**
 * Click Save and wait for the mutation to finish (dirty hint gone, button idle).
 * Waiting only for the toast is unreliable: an older toast can satisfy it while
 * the current save is still running, leaving the button disabled for the next
 * click.
 */
async function saveSettings(label = '保存', dirtyLabel = '有未保存的修改') {
  await waitButtonEnabled(label)
  await clickText(label)
  await delay(400)
  await waitFor(async () => !(await snapshot()).text.includes(dirtyLabel), { label: 'settings save finished', timeoutMs: 10_000 })
}

async function clickNav(tab) {
  const result = await call(pageClickNav, tab)
  if (result?.found !== true) throw new Error(`nav ${tab} not found`)
  await delay(500)
}

async function rowAction(title, button) {
  const result = await call(pageClickRowAction, title, button)
  if (result?.found !== true) throw new Error(`row action ${JSON.stringify(title)}/${JSON.stringify(button)} failed: ${JSON.stringify(result)}`)
  await delay(300)
}

async function recordFor(title) {
  const data = await rpc('search', { text: title, limit: 50, includeNonCurrent: true })
  return data.hits.map((hit) => hit.record).find((record) => record.title.includes(title)) ?? null
}

async function candidates() {
  const data = await rpc('candidates')
  return data.candidates
}

async function addCandidateViaUi(title, summary, tags) {
  await clickNav('收件箱')
  await setField('标题', title)
  await setField('摘要', summary)
  if (tags !== undefined) await setField('标签', tags)
  const before = (await candidates()).length
  await clickText('手动添加')
  await waitFor(async () => (await candidates()).length === before + 1, { label: `candidate ${title} added` })
  await waitText(title)
}

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

async function scenarioShell() {
  const state = await snapshot()
  check('shell: plugin page renders', state.hasPage === true)
  const tabs = ['记忆总览', '记忆检索', '记忆管理', '收件箱', '设置']
  for (const tab of tabs) {
    await clickNav(tab)
    const current = await snapshot()
    check(`shell: tab ${tab} switches`, current.activeTab === tab, `active=${current.activeTab}`)
  }
  check('shell: no error panel on first load', (await snapshot()).errors.length === 0, JSON.stringify((await snapshot()).errors))
  await shot('shell-tabs')
}

async function scenarioOverview() {
  await clickNav('记忆总览')
  const before = await snapshot()
  check('overview: tab renders title', before.text.includes('记忆总览'), before.text.slice(0, 80))
  await clickText('手动重建索引', { scope: '.lmv-page' })
  const rebuildToast = await waitToast('重建')
  check('overview: manual index rebuild succeeds', rebuildToast !== undefined, rebuildToast)
  await clickText('同步索引', { scope: '.lmv-page' })
  const syncToast = await waitToast('同步')
  check('overview: index sync succeeds', syncToast !== undefined, syncToast)
  const indexState = await rpc('overview')
  check('overview: no out-of-sync records after the index actions', indexState.outOfSync.length === 0, JSON.stringify(indexState.outOfSync))
  const vaultStatus = await rpc('status')
  const state = await snapshot()
  check('overview: headline count matches the service stat', state.text.includes(`记忆总数: ${vaultStatus.vault.stats.total}`), `expected ${vaultStatus.vault.stats.total}`)
  check('overview: no error panel after index actions', state.errors.length === 0, JSON.stringify(state.errors))
  await shot('overview-index')
}

async function scenarioInboxConfirm() {
  const title = `${TAG} 候选确认`
  const summary = '端到端测试：这条候选应该能被确认入库。'
  await addCandidateViaUi(title, summary, 'e2e,confirm')
  await shot('inbox-candidate-added')
  const candidateList = await candidates()
  check('inbox: manual candidate appears in the list', candidateList.some((entry) => entry.title === title), String(candidateList.length))
  check('inbox: candidate is not a memory file yet', (await recordFor(title)) === null)

  await rowAction(title, '确认入库')
  await waitFor(async () => !(await candidates()).some((entry) => entry.title === title), { label: 'candidate leaves inbox' })
  const confirmedToast = await waitToast('已确认入库')
  check('inbox: confirm shows success toast', confirmedToast !== undefined, confirmedToast)
  const record = await waitFor(async () => await recordFor(title), { label: 'confirmed memory in index' })
  check('inbox: confirmed candidate becomes an active memory', record.status === 'active', `status=${record.status}`)
  check('inbox: confirmed candidate is searchable', record.id.length > 0)
  const detail = await rpc('get', { id: record.id })
  check('inbox: confirmed memory landed in a category directory, not Inbox/', !detail.relativePath.startsWith('Inbox/'), detail.relativePath)
  check('inbox: low confidence is promoted to medium on confirm', detail.memory.confidence === 'medium' || detail.memory.confidence === 'high', detail.memory.confidence)
  const after = await snapshot()
  check('inbox: no error panel after confirm', after.errors.length === 0, JSON.stringify(after.errors))
  await shot('inbox-after-confirm')
}

async function scenarioInboxReject() {
  const title = `${TAG} 候选拒绝`
  await addCandidateViaUi(title, '端到端测试：这条候选应该被拒绝且不写文件。', 'e2e,reject')
  await rowAction(title, '拒绝')
  await waitFor(async () => !(await candidates()).some((entry) => entry.title === title), { label: 'candidate leaves inbox after reject' })
  const rejectedToast = await waitToast('已拒绝')
  check('inbox: reject shows success toast', rejectedToast !== undefined, rejectedToast)
  check('inbox: rejected candidate writes no memory', (await recordFor(title)) === null)
  const state = await snapshot()
  check('inbox: no error panel after reject', state.errors.length === 0, JSON.stringify(state.errors))
  await shot('inbox-after-reject')
}

async function scenarioInboxMerge() {
  const title = `${TAG} 合并目标`
  const summary = '端到端测试：重复候选确认后应合并进已有记忆。'
  const seeded = await rpc('save', { type: 'knowledge', title, summary, tags: ['e2e', 'merge'], confidence: 'high', importance: 60 })
  const beforeTotal = (await rpc('status')).vault.stats.total
  await addCandidateViaUi(title, summary, 'e2e,merge')
  await rowAction(title, '确认入库')
  await waitFor(async () => !(await candidates()).some((entry) => entry.title === title), { label: 'duplicate candidate leaves inbox' })
  await waitToast('已确认入库')
  await delay(800)
  const found = await rpc('search', { text: title, limit: 50, includeNonCurrent: true })
  const matching = found.hits.map((hit) => hit.record).filter((record) => record.title === title)
  check('inbox: confirming a duplicate keeps exactly one record', matching.length === 1, `count=${matching.length}`)
  check('inbox: duplicate confirm returns the existing memory id', matching[0]?.id === seeded.id, `expected=${seeded.id} got=${matching[0]?.id}`)
  const afterTotal = (await rpc('status')).vault.stats.total
  check('inbox: duplicate confirm does not increase the memory total', afterTotal === beforeTotal, `${beforeTotal} → ${afterTotal}`)
  const state = await snapshot()
  check('inbox: no error panel after duplicate confirm', state.errors.length === 0, JSON.stringify(state.errors))
  await shot('inbox-after-merge')
}

async function scenarioSearchDetail() {
  const title = `${TAG} 合并目标`
  await clickNav('记忆检索')
  await setField('关键词', title)
  await waitFor(async () => (await snapshot()).rows.some((row) => row.includes(title)), { label: 'search result row' })
  const state = await snapshot()
  check('search: keyword returns the seeded record', state.rows.some((row) => row.includes(title)), JSON.stringify(state.rows.slice(0, 5)))
  const rowClick = await call(pageClickRow, title)
  check('search: result row opens detail', rowClick?.found === true, JSON.stringify(rowClick))
  await waitDetail()
  check('detail: page renders the memory title', (await snapshot()).text.includes(title))
  await shot('detail-open')

  await clickText('归档')
  await waitToast('已归档')
  const archived = await waitFor(async () => {
    const record = await recordFor(title)
    return record?.status === 'archived' ? record : null
  }, { label: 'archived status' })
  check('detail: archive changes status to archived', archived.status === 'archived')
  await clickText('恢复为当前')
  await waitToast('已恢复')
  const restored = await waitFor(async () => {
    const record = await recordFor(title)
    return record?.status === 'active' ? record : null
  }, { label: 'restored status' })
  check('detail: restore changes status back to active', restored.status === 'active')

  await clickText('置顶')
  await waitToast('已置顶')
  const pinned = await waitFor(async () => {
    const record = await recordFor(title)
    return record?.pinned === true ? record : null
  }, { label: 'pinned flag' })
  check('detail: pin sets the pinned flag', pinned.pinned === true)
  // The action bar re-renders from the reloaded detail; wait for the toggled label.
  await waitFor(async () => (await snapshot()).buttons.includes('取消置顶'), { label: 'unpin button label' })
  await clickText('取消置顶')
  await waitToast('已取消置顶')
  const unpinned = await waitFor(async () => {
    const record = await recordFor(title)
    return record?.pinned === false ? record : null
  }, { label: 'unpinned flag' })
  check('detail: unpin clears the pinned flag', unpinned.pinned === false)

  // Raw Markdown read → edit → write. The raw tab loads the file itself.
  const memoryRecord = await recordFor(title)
  await clickText('原文 Markdown')
  await waitFor(async () => {
    const value = await call(pageReadRaw)
    return typeof value === 'string' && value.includes(memoryRecord.id) ? value : null
  }, { label: 'raw markdown loaded' })
  const original = await call(pageReadRaw)
  const edited = `${original}\n\n## E2E 追加\n\n端到端原文编辑验证。\n`
  const filled = await call(pageFillRaw, edited)
  check('detail: raw textarea accepts edits', filled?.ok === true, JSON.stringify(filled))
  await clickText('写入文件')
  await waitToast('原文已写入')
  const rawAfter = await rpc('readRaw', { id: (await recordFor(title)).id })
  check('detail: raw write persists to disk', rawAfter.content.includes('端到端原文编辑验证'), `len=${rawAfter.content.length}`)
  const stateAfterRaw = await snapshot()
  check('detail: no error panel after raw write', stateAfterRaw.errors.length === 0, JSON.stringify(stateAfterRaw.errors))
  await shot('detail-raw-written')

  // Two-step delete of a throwaway memory.
  const deleteTitle = `${TAG} 删除目标`
  const deletable = await rpc('save', { type: 'task', title: deleteTitle, summary: '端到端删除测试。', tags: ['e2e'], confidence: 'high', importance: 40 })
  await clickNav('记忆检索')
  await setField('关键词', deleteTitle)
  await waitFor(async () => (await snapshot()).rows.some((row) => row.includes(deleteTitle)), { label: 'delete target row' })
  await call(pageClickRow, deleteTitle)
  await waitDetail()
  await clickText('删除')
  await waitFor(async () => (await snapshot()).modal.length > 0, { label: 'delete dialog' })
  const typed = await call(pageFillPlaceholder, '粘贴记忆 ID', deletable.id)
  check('detail: delete dialog accepts the id', typed?.ok === true, JSON.stringify(typed))
  await delay(400)
  await clickText('确认', { scope: '.lmv-modal' })
  await waitFor(async () => (await snapshot()).buttons.includes('我确定，删除'), { label: 'delete final-step button' })
  await clickText('我确定，删除', { scope: '.lmv-modal' })
  await waitToast('已删除')
  await waitFor(async () => (await recordFor(deleteTitle)) === null, { label: 'deleted record gone' })
  check('detail: two-step delete removes the memory', (await recordFor(deleteTitle)) === null)
  await shot('detail-deleted')
}

async function scenarioSettings() {
  await clickNav('设置')
  const before = await rpc('getSettings')
  const initial = await snapshot()
  check('settings: no false unsaved-changes hint on load', !initial.text.includes('有未保存的修改'), initial.text.slice(0, 100))
  const target = before.recallMaxItems === 6 ? 7 : 6
  await setField('单次召回最大条数', target)
  const edited = await snapshot()
  check('settings: editing a field shows the unsaved-changes hint', edited.text.includes('有未保存的修改'), edited.text.slice(0, 100))
  await saveSettings()
  check('settings: saving clears the unsaved-changes hint', !(await snapshot()).text.includes('有未保存的修改'))
  const saved = await rpc('getSettings')
  check('settings: recall max items is persisted through the UI', saved.recallMaxItems === target, `${before.recallMaxItems} → ${saved.recallMaxItems}`)

  await openPluginPage({ reload: true })
  await clickNav('设置')
  const state = await snapshot()
  check('settings: value survives a page reload', state.text.includes('单次召回最大条数'), state.text.slice(0, 120))
  const fieldValue = await browser.evaluate(`(() => {
    const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim()
    const field = [...document.querySelectorAll('.lmv-field')].find((el) => norm(el.querySelector('.lmv-field-label')?.textContent).startsWith('单次召回最大条数'))
    return field?.querySelector('input')?.value ?? null
  })()`)
  check('settings: reloaded form shows the saved value', String(fieldValue) === String(target), `${fieldValue} vs ${target}`)
  await setField('单次召回最大条数', before.recallMaxItems)
  await saveSettings()

  // A boolean toggle round-trips too.
  const redactBefore = (await rpc('getSettings')).redactSecrets
  const toggled = await call(pageSetCheckbox, '拒绝看起来像密钥/口令的内容', !redactBefore)
  check('settings: checkbox toggles are clickable', toggled?.ok === true, JSON.stringify(toggled))
  await saveSettings()
  await waitFor(async () => (await rpc('getSettings')).redactSecrets === !redactBefore, { label: 'redactSecrets toggled' })
  check('settings: checkbox toggle is persisted', (await rpc('getSettings')).redactSecrets === !redactBefore, `expected ${!redactBefore}`)
  await call(pageSetCheckbox, '拒绝看起来像密钥/口令的内容', redactBefore)
  await saveSettings()

  // Language switch zh → en → zh. The panel relabels immediately on the select
  // change (the setting is previewed live), and Save persists it.
  await setField('界面语言', 'en')
  await waitText('Settings', { timeoutMs: 5000 })
  const english = await snapshot()
  check('settings: switching to English relabels the page', english.text.includes('Settings') && english.text.includes('Inbox'), english.text.slice(0, 120))
  await saveSettings('Save', 'Unsaved changes')
  await waitFor(async () => (await rpc('getSettings')).language === 'en', { label: 'language=en persisted' })
  check('settings: English language persists to the vault', (await rpc('getSettings')).language === 'en')
  await setField('Interface language', 'zh')
  await waitText('设置', { timeoutMs: 5000 })
  await saveSettings()
  await waitFor(async () => (await rpc('getSettings')).language === 'zh', { label: 'language=zh persisted' })
  await delay(300)
  const chinese = await snapshot()
  check('settings: switching back to Chinese relabels the page', chinese.text.includes('收件箱'), chinese.text.slice(0, 120))

  // Recall preview renders a block.
  await setField('预览查询', 'E2E')
  await clickText('预览')
  await waitFor(async () => {
    const current = await snapshot()
    return current.text.includes('预计 token') || current.text.includes('当前不会注入任何记忆内容') ? current : null
  }, { label: 'recall preview output', timeoutMs: 10000 })
  const previewState = await snapshot()
  check('settings: recall preview renders without an error', previewState.errors.length === 0, JSON.stringify(previewState.errors))
  await shot('settings-preview')
}

async function scenarioBatchManage() {
  const first = await rpc('save', { type: 'knowledge', title: `${TAG} 批量一`, summary: '批量操作测试一。', tags: ['e2e', 'bulk'], confidence: 'high', importance: 30 })
  const second = await rpc('save', { type: 'knowledge', title: `${TAG} 批量二`, summary: '批量操作测试二。', tags: ['e2e', 'bulk'], confidence: 'high', importance: 30 })
  await clickNav('记忆检索')
  await setField('关键词', '批量')
  await waitFor(async () => {
    const state = await snapshot()
    return state.rows.filter((row) => row.includes('批量')).length >= 2 ? state : null
  }, { label: 'two bulk rows' })
  const checked = await browser.evaluate(`(() => {
    const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim()
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return false
      const style = getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
    }
    // Only the active search result list: the page keeps the other tabs mounted,
    // so an unfiltered .lmv-row query would also tick hidden rows.
    const boxes = [...document.querySelectorAll('.lmv-row')]
      .filter((row) => visible(row) && norm(row.querySelector('.lmv-row-title')?.textContent).includes(${JSON.stringify(TAG)}))
      .filter((row) => norm(row.querySelector('.lmv-row-title')?.textContent).includes('批量'))
      .map((row) => row.querySelector('input[type="checkbox"]'))
      .filter((input) => input !== null)
    for (const box of boxes) box.click()
    return boxes.length
  })()`)
  check('manage: search rows expose selection checkboxes', checked === 2, `checked=${checked}`)
  await clickNav('记忆管理')
  await waitButtonEnabled('批量置顶')
  await clickText('批量置顶')
  const batchRows = async () => {
    const data = await rpc('search', { text: '批量', limit: 50, includeNonCurrent: true })
    return data.hits.map((hit) => hit.record).filter((record) => record.title.includes('批量'))
  }
  const pinnedIds = await waitFor(async () => {
    const records = await batchRows()
    return records.length >= 2 && records.every((record) => record.pinned === true) ? records : null
  }, { label: 'batch pin applied', timeoutMs: 12000 })
  check('manage: batch pin applies to selected memories', pinnedIds.length >= 2, JSON.stringify(pinnedIds.map((record) => ({ id: record.id, pinned: record.pinned }))))
  await waitButtonEnabled('批量取消置顶')
  await clickText('批量取消置顶')
  const unpinnedIds = await waitFor(async () => {
    const records = await batchRows()
    return records.length >= 2 && records.every((record) => record.pinned === false) ? records : null
  }, { label: 'batch unpin applied', timeoutMs: 12000 })
  check('manage: batch unpin applies to selected memories', unpinnedIds.every((record) => record.pinned === false), JSON.stringify(unpinnedIds.map((record) => record.pinned)))
  await shot('manage-batch')
  void first
  void second
}

async function scenarioMergeDialog() {
  const marker = '合并对话框'
  await rpc('save', { type: 'knowledge', title: `${TAG} ${marker}A`, summary: '合并对话框测试 A。', tags: ['e2e'], confidence: 'high', importance: 50 })
  await rpc('save', { type: 'knowledge', title: `${TAG} ${marker}B`, summary: '合并对话框测试 B。', tags: ['e2e'], confidence: 'high', importance: 50 })
  await clickNav('记忆检索')
  // The batch scenario left its selection in place; clear it before selecting again.
  const clear = await call(pageClickText, '.lmv-page', '清除选择', true)
  if (clear?.found === true) await delay(300)
  await setField('关键词', marker)
  await waitFor(async () => {
    const state = await snapshot()
    return state.rows.filter((row) => row.includes(marker)).length >= 2 ? state : null
  }, { label: 'merge dialog rows' })
  const checked = await browser.evaluate(`(() => {
    const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim()
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return false
      const style = getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
    }
    const boxes = [...document.querySelectorAll('.lmv-row')]
      .filter((row) => visible(row) && norm(row.querySelector('.lmv-row-title')?.textContent).includes(${JSON.stringify(marker)}))
      .map((row) => row.querySelector('input[type="checkbox"]'))
      .filter((input) => input !== null)
    for (const box of boxes) box.click()
    return boxes.length
  })()`)
  check('merge: both duplicates can be selected', checked === 2, `checked=${checked}`)
  await waitButtonEnabled('合并重复记忆')
  await clickText('合并重复记忆')
  await waitFor(async () => (await snapshot()).modal.length > 0, { label: 'merge dialog' })
  await clickText('执行合并', { scope: '.lmv-modal' })
  const mergedToast = await waitToast('已合并到')
  check('merge: dialog reports the survivor', mergedToast !== undefined, mergedToast)
  const after = await rpc('search', { text: marker, limit: 50, includeNonCurrent: true })
  const records = after.hits.map((hit) => hit.record).filter((record) => record.title.includes(marker))
  check('merge: dialog keeps exactly one active survivor', records.filter((record) => record.status === 'active').length === 1, JSON.stringify(records.map((record) => ({ title: record.title, status: record.status }))))
  check('merge: dialog retires the folded memory', records.some((record) => record.status === 'superseded' || record.status === 'archived'), JSON.stringify(records.map((record) => record.status)))
  await shot('merge-dialog')
}

async function cleanup() {
  try {
    const all = await rpc('search', { limit: 200, includeNonCurrent: true })
    for (const hit of all.hits) {
      if (hit.record.title.startsWith('E2E')) await rpc('delete', { id: hit.record.id, confirm: true })
    }
    for (const candidate of await candidates()) {
      if (candidate.title.startsWith('E2E')) await rpc('reject', { id: candidate.id })
    }
  } catch {
    /* cleanup is best-effort */
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  await mkdir(outDir, { recursive: true })
  browser = await BrowserHarness.launch({ headless, ...(browserPath === undefined ? {} : { browserPath }) })
  const started = Date.now()
  try {
    if (cookieFile !== undefined) {
      const raw = (await readFile(cookieFile, 'utf8')).trim()
      const at = raw.indexOf('=')
      if (at <= 0) throw new Error(`cookie file ${cookieFile} must contain one name=value line`)
      await browser.client.send('Network.enable')
      const set = await browser.client.send('Network.setCookie', {
        name: raw.slice(0, at),
        value: raw.slice(at + 1),
        url,
        httpOnly: true,
        secure: false,
      })
      if (set !== undefined && set !== null && set.success === false) throw new Error(`Network.setCookie failed for ${redactUrl(url)}`)
    }
    await browser.goto(url, { settleMs: 3000 })
    await openPluginPage()
    // A previous failed run may have persisted English; the smoke checks expect zh.
    await rpc('setSettings', { language: 'zh' }).catch(() => undefined)
    await cleanup()
    await openPluginPage({ reload: true })
    await scenarioShell()
    await scenarioOverview()
    await scenarioInboxConfirm()
    await scenarioInboxReject()
    await scenarioInboxMerge()
    await scenarioSearchDetail()
    await scenarioSettings()
    await scenarioBatchManage()
    await scenarioMergeDialog()
    const state = await snapshot()
    check('e2e: page still has no error panel at the end', state.errors.length === 0, JSON.stringify(state.errors))
    check('e2e: no uncaught page exceptions', browser.exceptions.length === 0, JSON.stringify(browser.exceptions.slice(0, 2)))
    await cleanup()
  } catch (error) {
    check('e2e: harness completed without throwing', false, String(error?.stack ?? error))
    try {
      await shot('failure')
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close()
  }
  const summary = summarize()
  const report = {
    url: redactUrl(url),
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    tag: TAG,
    ...summary,
    consoleErrors: browser.consoleMessages.filter((message) => message.type === 'error').slice(0, 10),
    pageExceptions: browser.exceptions.slice(0, 5),
    screenshots: shots,
    results,
  }
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...summary, report: path.join(outDir, 'report.json') }))
  console.log(summary.failed === 0 ? 'E2E RESULT: ALL CHECKS PASSED' : `E2E RESULT: ${summary.failed} CHECK(S) FAILED`)
  process.exit(summary.failed === 0 ? 0 : 1)
}

await main()

