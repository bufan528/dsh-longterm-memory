#!/usr/bin/env node
/**
 * ui-acceptance-extra.mjs — additional real-browser acceptance scenarios for the
 * DSH Memory Vault (长期记忆) plugin.
 *
 * Verification infrastructure only: it never imports or edits product code. It
 * reuses the browser/CDP harness from `ui-verify.mjs` and the shell-dialog
 * dismissal from `ui-acceptance.mjs`, drives a real Chrome over CDP, and seeds
 * the vault exclusively through the plugin's public HTTP RPC.
 *
 *   node scripts/ui-acceptance-extra.mjs --url "http://127.0.0.1:<port>/?token=..." \
 *     [--out .scratch/ui3] [--settle 1500] [--browser <path>] [--headless new|old]
 *     [--only all|sidebar] [--label <name>]
 *
 * Scenarios:
 *   1 five page entries load without an error panel (per-tab screenshots)
 *   2 search with no results shows an explicit empty state
 *   3 ~8000 CJK-char summary renders without horizontal overflow and scrolls
 *   4 empty inbox shows an explicit empty state
 *   5 write conflict (stale checksum) surfaces an error + retry path
 *   6 archive / restore, verified through the UI and /api/search
 *   7 Chinese interface + light/dark host theme
 *   8 page-load failure display when the plugin API is unreachable (CDP fault injection)
 *   9 exactly one sidebar entry and one main panel (plus `--only sidebar` helper
 *     used around a real plugin remove/add cycle)
 *
 * Results and screenshots go to `.scratch/ui3/` (or --out). A JSON summary is
 * printed on stdout; diagnostics go to stderr. Exit code 0 = every executed
 * scenario passed, 1 = at least one failed, 2 = harness/setup failure.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserHarness, DEFAULT_CHROME, WORKSPACE, delay, redactUrl } from './ui-verify.mjs';
import { dismissBlockingDialogs } from './ui-acceptance.mjs';

const USAGE = `Usage: node scripts/ui-acceptance-extra.mjs --url <dsh-web-url> [options]

Options:
  --out <dir>        output directory (default .scratch/ui3)
  --settle <ms>      settle delay after load (default 1500)
  --browser <path>   browser binary (default Chrome)
  --headless new|old headless mode (default new)
  --only all|sidebar run every scenario, or only the sidebar-count check
  --label <name>     label for --only sidebar output (default sidebar)
  --expect <n>       with --only sidebar, assert the entry count equals n
  --help             this help
`;

const OUT_DEFAULT = path.join(WORKSPACE, '.scratch', 'ui3');
const API_PREFIX = '/dsh-longterm-memory/api';
const SEED_TAG = 'ui3seed';

/* ------------------------------------------------------------------ *
 * Page-side helpers. Serialised with toString(), so self-contained.
 * ------------------------------------------------------------------ */

function pageFindRect(selector, rawText, exact) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return false;
    }
    return true;
  };
  const target = norm(rawText).toLowerCase();
  const matches = [];
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue;
    if (el.disabled === true) continue;
    if (target.length > 0) {
      const text = norm(el.innerText ?? el.textContent).toLowerCase();
      if (exact === true ? text !== target : !text.includes(target)) continue;
    }
    const rect = el.getBoundingClientRect();
    matches.push({ el, rect, area: rect.width * rect.height, text: norm(el.innerText ?? el.textContent).slice(0, 120) });
  }
  if (matches.length === 0) return { found: false, count: 0 };
  matches.sort((a, b) => a.area - b.area);
  const chosen = matches[0];
  chosen.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = chosen.el.getBoundingClientRect();
  return {
    found: true,
    count: matches.length,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    text: chosen.text,
    tag: chosen.el.tagName.toLowerCase(),
    className: typeof chosen.el.className === 'string' ? chosen.el.className.slice(0, 100) : '',
  };
}

function pageSetInput(selector, value) {
  const el = document.querySelector(selector);
  if (el === null) return { ok: false, reason: `not found: ${selector}` };
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter === undefined) return { ok: false, reason: 'no value setter' };
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true, value: el.value, length: el.value.length, tag: el.tagName.toLowerCase() };
}

function pageLmvState() {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return false;
    }
    return true;
  };
  const page = document.querySelector('.lmv-page');
  const main = document.querySelector('.lmv-main');
  const navButtons = Array.from(document.querySelectorAll('.lmv-nav-btn')).filter(visible);
  const rows = Array.from(document.querySelectorAll('.lmv-row')).filter(visible);
  const mainText = norm(main?.innerText);
  return {
    hasPage: page !== null,
    pageVisible: page !== null ? visible(page) : false,
    pageCount: document.querySelectorAll('.lmv-page').length,
    navCount: navButtons.length,
    nav: navButtons.map((el) => norm(el.innerText)),
    activeNav: norm(navButtons.find((el) => el.getAttribute('aria-current') === 'true')?.innerText ?? ''),
    errors: Array.from(document.querySelectorAll('.lmv-notice-error')).filter(visible).map((el) => norm(el.innerText)),
    notices: Array.from(document.querySelectorAll('.lmv-notice')).filter(visible).map((el) => norm(el.innerText)),
    empties: Array.from(document.querySelectorAll('.lmv-empty')).filter(visible).map((el) => norm(el.innerText)),
    toasts: Array.from(document.querySelectorAll('.lmv-toast')).filter(visible).map((el) => norm(el.innerText)),
    rowCount: rows.length,
    rowTitles: rows.map((row) => norm(row.querySelector('.lmv-row-title')?.innerText)).filter(Boolean),
    checks: Array.from(document.querySelectorAll('.lmv-check')).filter(visible).map((el) => ({
      label: norm(el.innerText),
      checked: el.querySelector('input')?.checked === true,
    })),
    hasLoading: Array.from(document.querySelectorAll('.lmv-loading')).some(visible),
    mainTextLength: mainText.length,
    mainText: mainText.slice(0, 1800),
    bodyTextLength: norm(document.querySelector('.lmv-body')?.innerText).length,
    resultCount: (mainText.match(/共\s*\d+\s*条结果[^。]*?ms/) ?? [''])[0],
    pageTitle: norm(document.querySelector('.lmv-title')?.innerText),
    pageBg: page !== null ? getComputedStyle(page).backgroundColor : null,
    pageColor: page !== null ? getComputedStyle(page).color : null,
  };
}

function pageDetailState() {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };
  const cards = Array.from(document.querySelectorAll('.lmv-card'));
  const summaryCard = cards.find((card) => norm(card.querySelector('.lmv-card-title')?.innerText) === '核心内容');
  const prose = summaryCard?.querySelector('.lmv-prose');
  return {
    title: norm(document.querySelector('.lmv-main .lmv-row-title')?.innerText),
    badges: Array.from(document.querySelectorAll('.lmv-main .lmv-badge')).filter(visible).map((el) => norm(el.innerText)),
    buttons: Array.from(document.querySelectorAll('.lmv-main .lmv-btn')).filter(visible).map((el) => norm(el.innerText)),
    noticeTexts: Array.from(document.querySelectorAll('.lmv-main .lmv-notice')).filter(visible).map((el) => norm(el.innerText)),
    errorTexts: Array.from(document.querySelectorAll('.lmv-main .lmv-notice-error')).filter(visible).map((el) => norm(el.innerText)),
    summaryLength: prose !== null && prose !== undefined ? norm(prose.innerText).length : 0,
    summaryParagraphs: summaryCard === undefined ? 0 : summaryCard.querySelectorAll('.lmv-prose-p').length,
    kvKeys: Array.from(document.querySelectorAll('.lmv-main .lmv-kv-key')).filter(visible).map((el) => norm(el.innerText)),
    toasts: Array.from(document.querySelectorAll('.lmv-toast')).filter(visible).map((el) => norm(el.innerText)),
  };
}

function pageRawState() {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const textarea = document.querySelector('.lmv-main textarea.lmv-textarea');
  const keys = Array.from(document.querySelectorAll('.lmv-main .lmv-kv-key'));
  const checksumKey = keys.find((el) => norm(el.innerText) === '校验和');
  let checksum = '';
  if (checksumKey !== undefined) {
    const next = checksumKey.nextElementSibling;
    if (next !== null) checksum = norm(next.innerText);
  }
  const retry = Array.from(document.querySelectorAll('.lmv-notice-error .lmv-btn'))
    .filter(visible)
    .map((el) => norm(el.innerText));
  return {
    textareaPresent: textarea !== null,
    ariaLabel: textarea?.getAttribute('aria-label') ?? '',
    length: textarea !== null ? textarea.value.length : 0,
    includesMarker: textarea !== null ? textarea.value.includes('外部程序追加') : false,
    checksum,
    errors: Array.from(document.querySelectorAll('.lmv-notice-error')).filter(visible).map((el) => norm(el.innerText)),
    notices: Array.from(document.querySelectorAll('.lmv-notice')).filter(visible).map((el) => norm(el.innerText)),
    retryButtons: retry,
    toasts: Array.from(document.querySelectorAll('.lmv-toast')).filter(visible).map((el) => norm(el.innerText)),
  };
}

function pageOverflow() {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const main = document.querySelector('.lmv-main');
  const mainRect = main?.getBoundingClientRect();
  const offenders = [];
  for (const el of document.querySelectorAll('.lmv-page *')) {
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.right > innerWidth + 1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
        right: Math.round(rect.right * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
      });
      if (offenders.length >= 10) break;
    }
  }
  const prose = Array.from(document.querySelectorAll('.lmv-prose-p')).filter(visible).map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      length: (el.innerText ?? '').length,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      right: Math.round(rect.right * 10) / 10,
      overflowWrap: getComputedStyle(el).overflowWrap,
    };
  });
  return {
    innerWidth,
    innerHeight,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    main: main === null ? null : {
      clientWidth: main.clientWidth,
      scrollWidth: main.scrollWidth,
      clientHeight: main.clientHeight,
      scrollHeight: main.scrollHeight,
      overflowY: getComputedStyle(main).overflowY,
      right: mainRect !== null && mainRect !== undefined ? Math.round(mainRect.right) : null,
    },
    offenders,
    prose,
    hasHorizontalScrollbar: document.documentElement.scrollWidth > innerWidth + 1,
  };
}

function pageSidebarCount() {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };
  const vw = innerWidth;
  const found = new Set();
  const details = [];
  for (const el of document.querySelectorAll('button, a, [role="button"], [role="menuitem"], li')) {
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.left + rect.width / 2 >= vw * 0.25) continue;
    const text = norm(el.innerText ?? el.textContent);
    const aria = norm(el.getAttribute('aria-label'));
    if (text !== '长期记忆' && aria !== '长期记忆') continue;
    if (found.has(el)) continue;
    found.add(el);
    details.push({ tag: el.tagName.toLowerCase(), text, aria, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
  }
  return {
    count: found.size,
    entries: details,
    lmvPages: document.querySelectorAll('.lmv-page').length,
    dataPanelIds: Array.from(document.querySelectorAll('[data-panel-id]')).map((el) => el.getAttribute('data-panel-id')),
  };
}

function pageThemeState() {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const page = document.querySelector('.lmv-page');
  const style = page !== null ? getComputedStyle(page) : null;
  return {
    source: document.documentElement.getAttribute('data-ds-theme-source'),
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    htmlStyle: document.documentElement.getAttribute('style'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    pageBg: style !== null ? style.backgroundColor : null,
    pageColor: style !== null ? style.color : null,
    lang: document.documentElement.lang,
    nav: Array.from(document.querySelectorAll('.lmv-nav-btn')).map((el) => norm(el.innerText)),
    title: norm(document.querySelector('.lmv-title')?.innerText),
    hasPage: page !== null,
  };
}

function pageScrollToCard(title) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const card = Array.from(document.querySelectorAll('.lmv-card')).find(
    (el) => norm(el.querySelector('.lmv-card-title')?.innerText) === norm(title),
  );
  if (card === undefined) return { ok: false, reason: `card not found: ${title}` };
  card.scrollIntoView({ block: 'start', behavior: 'instant' });
  return { ok: true, scrollTop: document.querySelector('.lmv-main')?.scrollTop ?? null };
}

function pageCheckboxRect(rawText) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && getComputedStyle(el).display !== 'none';
  };
  const label = Array.from(document.querySelectorAll('.lmv-check'))
    .filter(visible)
    .find((el) => norm(el.innerText).includes(norm(rawText)));
  if (label === undefined) return { found: false, reason: 'checkbox label not found' };
  const input = label.querySelector('input');
  if (input === null) return { found: false, reason: 'input not found in label' };
  const rect = input.getBoundingClientRect();
  return {
    found: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    checked: input.checked,
    label: norm(label.innerText),
  };
}

/* ------------------------------------------------------------------ *
 * Harness helpers
 * ------------------------------------------------------------------ */

async function eva(browser, fn, ...args) {
  const call = `(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(', ')})`;
  return browser.evaluate(call);
}

async function waitForExpression(browser, expression, timeoutMs = 12_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await browser.evaluate(expression);
    } catch {
      last = null;
    }
    if (last) return last;
    await delay(intervalMs);
  }
  return last;
}

async function settle(ms = 600) {
  await delay(ms);
}

function summarizeDetail(detail) {
  return detail === undefined || detail === null || detail === '' ? null : String(detail).slice(0, 500);
}

function makeScenario(id, name) {
  return { id, name, result: 'PASS', assertions: [], notes: [], screenshots: [], defects: [] };
}

function check(scenario, ok, label, detail) {
  scenario.assertions.push({ ok: ok === true, label, detail: summarizeDetail(detail) });
  if (ok !== true && scenario.result === 'PASS') scenario.result = 'FAIL';
  return ok === true;
}

/* ------------------------------------------------------------------ *
 * Host RPC (same public HTTP API the UI uses)
 * ------------------------------------------------------------------ */

function makeRpc(url) {
  const origin = new URL(url).origin;
  const base = `${origin}${API_PREFIX}`;
  const call = async (method, payload = {}) => {
    const response = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`RPC ${method}: non-JSON response (HTTP ${String(response.status)}): ${text.slice(0, 200)}`);
    }
    return { status: response.status, envelope };
  };
  const ok = async (method, payload = {}) => {
    const { envelope } = await call(method, payload);
    if (envelope?.ok !== true) {
      const error = new Error(`RPC ${method} failed: ${envelope?.error?.code ?? '?'} ${envelope?.error?.message ?? ''}`);
      error.code = envelope?.error?.code;
      throw error;
    }
    return envelope.data;
  };
  return { base, call, ok };
}

function buildLongSummary(target = 8000) {
  const unit = '这是一段用于验证超长记忆内容在详情页中的布局、换行与滚动行为的中文文本。';
  let text = '';
  while (text.length < target) text += unit;
  return text.slice(0, target);
}

async function seedVault(rpc) {
  const existing = await rpc.ok('search', { text: SEED_TAG, includeNonCurrent: true, limit: 100 });
  for (const hit of existing.hits) {
    await rpc.ok('delete', { id: hit.record.id, confirm: true });
  }
  const seeds = [
    {
      key: 'alpha',
      type: 'knowledge',
      title: '种子记忆 Alpha',
      summary: '这是一条用于验收的种子记忆，包含唯一检索词 seedalpha，用于搜索与原始 Markdown 写入场景。',
      tags: [SEED_TAG, 'seedalpha'],
      confidence: 'high',
      importance: 60,
    },
    {
      key: 'long',
      type: 'knowledge',
      title: '超长内容验收记忆',
      summary: buildLongSummary(8000),
      tags: [SEED_TAG, 'longmem'],
      confidence: 'medium',
      importance: 50,
    },
    {
      key: 'beta',
      type: 'knowledge',
      title: '可归档记忆 Beta',
      summary: '这条记忆专门用于归档与恢复验收，唯一检索词 archivebeta。',
      tags: [SEED_TAG, 'archivebeta'],
      confidence: 'medium',
      importance: 40,
    },
  ];
  const ids = {};
  for (const seed of seeds) {
    const saved = await rpc.ok('save', seed);
    ids[seed.key] = saved.id;
    process.stderr.write(`[seed] ${seed.key} -> ${saved.id} (summary ${String(seed.summary.length)} chars)\n`);
  }
  return { ids, seeds };
}

/* ------------------------------------------------------------------ *
 * Browser interaction helpers
 * ------------------------------------------------------------------ */

async function openPluginPage(browser, readyExpression = `document.querySelectorAll('.lmv-nav-btn').length >= 5`, timeoutMs = 15_000) {
  let lastReason = 'no attempt';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dismissBlockingDialogs(browser);
    await waitForExpression(browser, `document.querySelector('[role="dialog"]') === null`, 5_000);
    await settle(attempt === 0 ? 500 : 900);
    const entry = await eva(browser, pageFindRect, 'button[aria-label="长期记忆"], [role="button"][aria-label="长期记忆"]', '', true);
    if (entry.found) {
      await browser._clickAt(entry.x, entry.y, { settleMs: 500 });
    } else {
      try {
        await browser.clickText('长期记忆', { settleMs: 500 });
      } catch (error) {
        lastReason = error.message;
        continue;
      }
    }
    const ready = await waitForExpression(browser, readyExpression, timeoutMs);
    if (ready) return true;
    lastReason = `attempt ${String(attempt + 1)}: page did not become ready`;
    process.stderr.write(`[harness] ${lastReason}; retrying the sidebar click\n`);
  }
  throw new Error(`management page did not open after clicking the 长期记忆 sidebar entry (${lastReason})`);
}

async function clickRect(browser, selector, text, exact = true, settleMs = 600) {
  const info = await eva(browser, pageFindRect, selector, text, exact);
  if (!info.found) throw new Error(`no visible ${selector} matching ${JSON.stringify(text)}`);
  await browser._clickAt(info.x, info.y, { settleMs });
  return info;
}

async function clickNav(browser, label) {
  let info = await eva(browser, pageFindRect, '.lmv-nav-btn', label, true);
  if (!info.found) info = await eva(browser, pageFindRect, '.lmv-nav-btn', label, false);
  if (!info.found) throw new Error(`no visible navigation tab matching ${JSON.stringify(label)}`);
  await browser._clickAt(info.x, info.y, { settleMs: 700 });
  await waitForExpression(
    browser,
    `(() => { const b = Array.from(document.querySelectorAll('.lmv-nav-btn')).find((el) => el.getAttribute('aria-current') === 'true'); return b !== undefined && (b.innerText || '').trim().includes(${JSON.stringify(label)}); })()`,
    6_000,
  );
}

async function setSearch(browser, text) {
  const set = await eva(browser, pageSetInput, '.lmv-main input[type="search"]', text);
  if (!set.ok) throw new Error(`could not set the search box: ${set.reason}`);
  await settle(1_100);
  return set;
}

async function openHostSettings(browser) {
  await browser.clickSelector('[aria-label="账号菜单"]', { settleMs: 700 });
  const item = await eva(browser, pageFindRect, '[role="menuitem"]', '设置', false);
  if (!item.found) throw new Error('could not find the 设置 menu item in the account menu');
  await browser._clickAt(item.x, item.y, { settleMs: 1_100 });
  const ready = await waitForExpression(
    browser,
    `(() => { const d = document.querySelector('[role="dialog"]'); return d !== null && (d.innerText || '').includes('外观'); })()`,
    8_000,
  );
  if (!ready) throw new Error('host settings dialog did not open');
}

async function closeHostSettings(browser) {
  const close = await eva(browser, pageFindRect, '[role="dialog"] button', '关闭', true);
  if (!close.found) throw new Error('could not find the 关闭 button in the settings dialog');
  await browser._clickAt(close.x, close.y, { settleMs: 800 });
  await waitForExpression(browser, `document.querySelector('[role="dialog"]') === null`, 6_000);
}

async function setHostTheme(browser, label) {
  const option = await eva(browser, pageFindRect, '[role="dialog"] button', label, true);
  if (!option.found) throw new Error(`could not find the ${label} theme button`);
  await browser._clickAt(option.x, option.y, { settleMs: 900 });
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const config = {
    url: null,
    out: OUT_DEFAULT,
    settleMs: 1500,
    browser: DEFAULT_CHROME,
    headless: 'new',
    only: 'all',
    label: 'sidebar',
    expect: null,
    help: false,
  };
  const need = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--help':
      case '-h':
        config.help = true;
        break;
      case '--url':
        config.url = need(index, flag);
        index += 1;
        break;
      case '--out':
        config.out = path.resolve(need(index, flag));
        index += 1;
        break;
      case '--settle':
        config.settleMs = Number(need(index, flag));
        index += 1;
        break;
      case '--browser':
        config.browser = need(index, flag);
        index += 1;
        break;
      case '--headless':
        config.headless = need(index, flag);
        if (!['new', 'old'].includes(config.headless)) throw new Error('--headless must be new or old');
        index += 1;
        break;
      case '--only':
        config.only = need(index, flag);
        if (!['all', 'sidebar'].includes(config.only)) throw new Error('--only must be all or sidebar');
        index += 1;
        break;
      case '--label':
        config.label = need(index, flag);
        index += 1;
        break;
      case '--expect':
        config.expect = Number(need(index, flag));
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return config;
}

async function runSidebarOnly(browser, config, scenario) {
  const count = await eva(browser, pageSidebarCount);
  if (config.expect !== null) {
    check(scenario, count.count === config.expect, `sidebar entry count is ${String(config.expect)}`, JSON.stringify(count));
  } else {
    scenario.assertions.push({ ok: true, label: 'sidebar entry count captured', detail: JSON.stringify(count) });
  }
  scenario.data = count;
  const shot = await browser.screenshot(path.join(config.out, `${config.label}.png`));
  scenario.screenshots.push({ name: `${config.label}.png`, path: shot.path, bytes: shot.bytes });
  await writeFile(path.join(config.out, `${config.label}.json`), `${JSON.stringify(count, null, 2)}\n`);
  return count;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (config.url === null) throw new Error(`--url is required\n\n${USAGE}`);
  await mkdir(config.out, { recursive: true });

  const rpc = makeRpc(config.url);
  const scenarios = [];
  const defects = [];
  const observations = [];
  const consoleErrors = [];
  const exceptions = [];
  let seeded = null;
  let browser = null;
  let fetchHook = null;

  const recordConsole = (event) => {
    if (event.kind === 'console' && event.type === 'error') consoleErrors.push(event.text);
    else if (event.kind === 'exception') exceptions.push(event.text);
    else if (event.kind === 'log' && event.type === 'error') consoleErrors.push(event.text);
  };

  try {
    /* -- seed the vault purely through the public HTTP API ------------- */
    if (config.only === 'all') {
      const status = await rpc.ok('status', {});
      if (status.vault === null || status.vault.initialized !== true) {
        throw new Error(`vault is not initialized: ${JSON.stringify(status.vault)}`);
      }
      seeded = await seedVault(rpc);
      const settings = await rpc.ok('getSettings', {});
      process.stderr.write(`[seed] language=${settings.language} vault=${settings.vaultPath}\n`);
    }

    browser = await BrowserHarness.launch({
      browserPath: config.browser,
      headless: config.headless,
      userDataDir: path.join(WORKSPACE, '.scratch', 'ui3-chrome-profile'),
    });
    browser.onEvent = recordConsole;
    // BrowserHarness filters CDP events down to console/exception/log before
    // calling browser.onEvent, so fetch a raw CDP event tap through CdpClient for
    // Fetch.requestPaused (scenario 8). This wraps, never replaces, the harness
    // handler, so console/exception capture keeps working.
    const baseClientHandler = browser.client.onEvent;
    browser.client.onEvent = (event) => {
      if (fetchHook !== null && event.kind === 'event' && event.method === 'Fetch.requestPaused') {
        fetchHook(event.params);
        return;
      }
      baseClientHandler(event);
    };
    await browser.goto(config.url, { settleMs: config.settleMs });

    const initialDialogs = await browser.evaluate(`(${(() => {
      const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter((el) => el.getBoundingClientRect().width > 2)
        .map((el) => ({ aria: el.getAttribute('aria-label'), text: norm(el.innerText).slice(0, 160) }));
    }).toString()})()`);
    const dismissed = await dismissBlockingDialogs(browser);
    await settle(500);
    process.stderr.write(`[shell] dialogs initially=${String(initialDialogs.length)} dismissed=${String(dismissed.length)}\n`);

    /* -- sidebar-only mode (used around a real plugin remove/add) ----- */
    if (config.only === 'sidebar') {
      const scenario = makeScenario('9', 'Plugin duplicate load — sidebar count');
      await runSidebarOnly(browser, config, scenario);
      scenarios.push(scenario);
      const summary = {
        mode: 'sidebar',
        label: config.label,
        url: redactUrl(config.url),
        scenarios,
        consoleErrors,
        exceptions,
        screenshots: scenario.screenshots,
      };
      await writeFile(path.join(config.out, `${config.label}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return scenario.result === 'PASS' ? 0 : 1;
    }

    /* -- Scenario 9a: exactly one sidebar entry before opening ------- */
    const s9 = makeScenario('9', 'Plugin duplicate load and cleanup');
    const beforeOpen = await eva(browser, pageSidebarCount);
    check(s9, beforeOpen.count === 1, 'exactly one 长期记忆 sidebar entry', JSON.stringify(beforeOpen));
    const sidebarShot = await browser.screenshot(path.join(config.out, 's9-sidebar-single.png'));
    s9.screenshots.push({ name: 's9-sidebar-single.png', path: sidebarShot.path, bytes: sidebarShot.bytes });

    /* -- Open the management page once -------------------------------- */
    await openPluginPage(browser);
    await settle(800);
    const opened = await eva(browser, pageLmvState);
    const afterOpen = await eva(browser, pageSidebarCount);
    check(s9, afterOpen.count === 1, 'still exactly one 长期记忆 sidebar entry while open', JSON.stringify(afterOpen));
    check(s9, opened.pageCount === 1, 'exactly one .lmv-page panel mounted', `pageCount=${String(opened.pageCount)}`);
    check(s9, opened.navCount === 5, 'exactly one five-tab navigation', `navCount=${String(opened.navCount)}`);
    check(s9, afterOpen.lmvPages === 1, 'only one plugin page instance in the DOM', `lmvPages=${String(afterOpen.lmvPages)}`);
    const panelShot = await browser.screenshot(path.join(config.out, 's9-panel-single.png'));
    s9.screenshots.push({ name: 's9-panel-single.png', path: panelShot.path, bytes: panelShot.bytes });

    /* -- Scenario 1: five page entries -------------------------------- */
    const s1 = makeScenario('1', 'Five page entries load without an error panel');
    const anchors = {
      记忆总览: ['存储路径', '记忆总览'],
      记忆检索: ['关键词', '检索'],
      记忆管理: ['索引维护', '存储位置'],
      收件箱: ['候选与收件箱'],
      设置: ['插件设置', '界面语言'],
    };
    const tabScreens = [];
    for (let index = 0; index < opened.nav.length; index += 1) {
      const label = opened.nav[index];
      await clickNav(browser, label);
      await settle(900);
      const state = await eva(browser, pageLmvState);
      const expected = anchors[label] ?? [];
      const anchor = expected.find((text) => state.mainText.includes(text)) ?? null;
      const name = `s1-${String(index + 1)}-${['overview', 'search', 'manage', 'inbox', 'settings'][index] ?? 'tab'}.png`;
      const shot = await browser.screenshot(path.join(config.out, name));
      tabScreens.push({ name, path: shot.path, bytes: shot.bytes });
      check(s1, state.activeNav === label, `tab ${label} is marked active`, `activeNav=${state.activeNav}`);
      check(s1, state.mainTextLength > 30, `tab ${label} rendered content`, `mainTextLength=${String(state.mainTextLength)}`);
      check(s1, state.errors.length === 0, `tab ${label} shows no error panel`, JSON.stringify(state.errors));
      check(s1, state.hasLoading === false, `tab ${label} finished loading`, 'hasLoading=' + String(state.hasLoading));
      check(s1, anchor !== null, `tab ${label} shows its expected content`, `anchor=${String(anchor)} excerpt=${state.mainText.slice(0, 160)}`);
      process.stderr.write(`[s1] ${label} active=${state.activeNav} errors=${String(state.errors.length)} anchor=${String(anchor)}\n`);
    }
    s1.screenshots.push(...tabScreens);
    s1.notes.push('Each tab was clicked through the real .lmv-nav buttons and captured individually.');

    /* -- Scenario 2: search with no results --------------------------- */
    const s2 = makeScenario('2', 'Search with no results shows an explicit empty state');
    await clickNav(browser, '记忆检索');
    await setSearch(browser, 'zzzz-no-such-memory-42');
    await waitForExpression(
      browser,
      `(() => { const t = document.querySelector('.lmv-main')?.innerText ?? ''; return t.includes('没有匹配的记忆') || t.includes('共 0 条结果'); })()`,
      8_000,
    );
    const noResultState = await eva(browser, pageLmvState);
    check(s2, noResultState.empties.includes('没有匹配的记忆'), 'explicit no-results text is visible', JSON.stringify(noResultState.empties));
    check(s2, noResultState.resultCount.replace(/\s/g, '').includes('共0条结果'), 'result count reports 0', noResultState.resultCount);
    check(s2, noResultState.rowCount === 0, 'no memory rows are rendered', `rowCount=${String(noResultState.rowCount)}`);
    check(s2, noResultState.errors.length === 0, 'the empty state is not an error panel', JSON.stringify(noResultState.errors));
    const s2shot = await browser.screenshot(path.join(config.out, 's2-search-no-results.png'));
    s2.screenshots.push({ name: 's2-search-no-results.png', path: s2shot.path, bytes: s2shot.bytes });
    await setSearch(browser, '');

    /* -- Scenario 3: very long memory content ------------------------- */
    const s3 = makeScenario('3', 'Very long (~8000 CJK chars) memory content renders safely');
    await clickNav(browser, '记忆检索');
    await setSearch(browser, 'longmem');
    const longRow = await waitForExpression(
      browser,
      `(() => { const r = Array.from(document.querySelectorAll('.lmv-row-title')).find((el) => (el.innerText || '').includes('超长内容验收记忆')); return r !== undefined; })()`,
      8_000,
    );
    check(s3, longRow === true, 'long memory appears in search results', 'row found');
    await clickRect(browser, '.lmv-row-click', '超长内容验收记忆', false, 1_000);
    await waitForExpression(browser, `(document.querySelector('.lmv-main')?.innerText ?? '').includes('核心内容')`, 8_000);
    await settle(900);
    const longDetail = await eva(browser, pageDetailState);
    const overflow = await eva(browser, pageOverflow);
    check(s3, longDetail.title.includes('超长内容验收记忆'), 'detail view opened for the long memory', longDetail.title);
    check(s3, longDetail.summaryLength >= 7900, 'full ~8000-char summary is rendered', `summaryLength=${String(longDetail.summaryLength)}`);
    check(s3, overflow.hasHorizontalScrollbar === false, 'document has no horizontal overflow', `docScrollWidth=${String(overflow.docScrollWidth)} innerWidth=${String(overflow.innerWidth)}`);
    check(s3, overflow.main !== null && overflow.main.scrollWidth <= overflow.main.clientWidth + 1, 'main column has no horizontal overflow', JSON.stringify(overflow.main));
    check(s3, overflow.offenders.length === 0, 'no element extends past the viewport right edge', JSON.stringify(overflow.offenders));
    check(s3, overflow.main !== null && overflow.main.scrollHeight > overflow.main.clientHeight, 'detail content is vertically scrollable', JSON.stringify(overflow.main));
    check(s3, overflow.main !== null && ['auto', 'scroll'].includes(overflow.main.overflowY), 'main column owns the scroll', `overflowY=${String(overflow.main?.overflowY)}`);
    check(s3, longDetail.summaryParagraphs >= 1 && overflow.prose.every((p) => p.scrollWidth <= p.clientWidth + 1), 'the long paragraph wraps inside its card', JSON.stringify(overflow.prose));
    const s3top = await browser.screenshot(path.join(config.out, 's3-long-detail-top.png'));
    s3.screenshots.push({ name: 's3-long-detail-top.png', path: s3top.path, bytes: s3top.bytes });
    const scrolled = await eva(browser, pageScrollToCard, '核心内容');
    check(s3, scrolled.ok === true, 'scrolled to the 核心内容 card', JSON.stringify(scrolled));
    await settle(500);
    const s3summary = await browser.screenshot(path.join(config.out, 's3-long-detail-summary.png'));
    s3.screenshots.push({ name: 's3-long-detail-summary.png', path: s3summary.path, bytes: s3summary.bytes });
    await clickRect(browser, '.lmv-main .lmv-btn', '返回', false, 800);

    /* -- Scenario 4: empty inbox -------------------------------------- */
    const s4 = makeScenario('4', 'Empty inbox shows an explicit empty state');
    const candidates = await rpc.ok('candidates', {});
    check(s4, candidates.candidates.length === 0, 'host reports zero pending candidates', `count=${String(candidates.candidates.length)}`);
    await clickNav(browser, '收件箱');
    await settle(700);
    const inboxState = await eva(browser, pageLmvState);
    check(s4, inboxState.empties.includes('没有待处理的候选记忆'), 'explicit empty-inbox text is visible', JSON.stringify(inboxState.empties));
    check(s4, inboxState.errors.length === 0, 'inbox empty state is not an error panel', JSON.stringify(inboxState.errors));
    check(s4, inboxState.rowCount === 0, 'no candidate rows are rendered', `rowCount=${String(inboxState.rowCount)}`);
    const s4shot = await browser.screenshot(path.join(config.out, 's4-inbox-empty.png'));
    s4.screenshots.push({ name: 's4-inbox-empty.png', path: s4shot.path, bytes: s4shot.bytes });

    /* -- Scenario 5: write conflict / error display ------------------- */
    const s5 = makeScenario('5', 'Write failure (write-conflict) surfaces error + retry path');
    await clickNav(browser, '记忆检索');
    await setSearch(browser, 'seedalpha');
    await waitForExpression(
      browser,
      `Array.from(document.querySelectorAll('.lmv-row-title')).some((el) => (el.innerText || '').includes('种子记忆 Alpha'))`,
      8_000,
    );
    await clickRect(browser, '.lmv-row-click', '种子记忆 Alpha', false, 900);
    await waitForExpression(browser, `(document.querySelector('.lmv-main')?.innerText ?? '').includes('原文 Markdown')`, 8_000);
    const alphaGet = await rpc.ok('get', { id: seeded.ids.alpha });
    const rawBefore = await rpc.ok('readRaw', { id: seeded.ids.alpha });
    await clickRect(browser, '.lmv-main .lmv-btn', '原文 Markdown', true, 900);
    await waitForExpression(browser, `document.querySelector('.lmv-main textarea.lmv-textarea') !== null`, 8_000);
    await settle(700);
    const rawUiBefore = await eva(browser, pageRawState);
    check(s5, rawUiBefore.textareaPresent === true, 'raw Markdown editor is open', `length=${String(rawUiBefore.length)}`);
    check(s5, rawUiBefore.checksum === rawBefore.checksum, 'UI checksum matches the host checksum', `${rawUiBefore.checksum} vs ${rawBefore.checksum}`);

    // Someone else changes the file on disk, behind the plugin's back: insert an
    // extra paragraph into the 核心内容 section so the edit is a real, in-section
    // Markdown change rather than unrecognised trailing text.
    const absolutePath = alphaGet.absolutePath;
    const markerLine = '外部程序追加的一行（用于制造写入冲突）。';
    const diskBefore = await readFile(absolutePath, 'utf8');
    const diskAfter = diskBefore.replace(/(## 核心内容\r?\n\r?\n)([^\n]*)/, `$1$2\n\n${markerLine}`);
    if (diskAfter === diskBefore) throw new Error('could not inject the external edit into the summary section');
    await writeFile(absolutePath, diskAfter, 'utf8');
    process.stderr.write(`[s5] externally modified ${absolutePath}\n`);

    await clickRect(browser, '.lmv-main .lmv-btn', '写入文件', true, 1_000);
    await waitForExpression(browser, `document.querySelector('.lmv-notice-error') !== null`, 8_000);
    await settle(400);
    const conflictState = await eva(browser, pageRawState);
    check(s5, conflictState.errors.some((text) => text.includes('写入冲突')), 'write-conflict error text is visible', JSON.stringify(conflictState.errors));
    check(s5, conflictState.retryButtons.includes('重新读取'), 'a retry (重新读取) path is offered', JSON.stringify(conflictState.retryButtons));
    check(s5, conflictState.textareaPresent === true, 'editor content is preserved after the failure', `length=${String(conflictState.length)}`);
    const directConflict = await rpc.call('writeRaw', {
      id: seeded.ids.alpha,
      content: rawBefore.content,
      expectedChecksum: rawBefore.checksum,
    });
    check(s5, directConflict.envelope?.error?.code === 'write-conflict', 'host returns write-conflict for the stale checksum', JSON.stringify(directConflict.envelope?.error ?? null));
    const s5shot = await browser.screenshot(path.join(config.out, 's5-write-conflict.png'));
    s5.screenshots.push({ name: 's5-write-conflict.png', path: s5shot.path, bytes: s5shot.bytes });

    // Retry path: reload, then write again. This is where the product is expected
    // to recover. The checks below are recorded as a defect when they do not.
    await clickRect(browser, '.lmv-notice-error .lmv-btn', '重新读取', true, 1_000);
    await settle(900);
    const afterReload = await eva(browser, pageRawState);
    const reloadKeptChecksum = afterReload.checksum === rawUiBefore.checksum;
    const reloadGotDiskContent = afterReload.includesMarker === true;
    check(s5, reloadGotDiskContent, '重新读取 refreshes the editor from disk', `includesMarker=${String(afterReload.includesMarker)}`);
    await clickRect(browser, '.lmv-main .lmv-btn', '写入文件', true, 1_000);
    await waitForExpression(browser, `document.querySelector('.lmv-notice-error') !== null`, 6_000);
    await settle(400);
    const secondConflict = await eva(browser, pageRawState);
    const retryResolved = secondConflict.errors.length === 0 && secondConflict.toasts.some((text) => text.includes('原文已写入'));
    const s5again = await browser.screenshot(path.join(config.out, 's5-conflict-again.png'));
    s5.screenshots.push({ name: 's5-conflict-again.png', path: s5again.path, bytes: s5again.bytes });
    if (retryResolved) {
      check(s5, true, 'retry after 重新读取 resolves the conflict', JSON.stringify(secondConflict.toasts));
    } else {
      const detail = {
        reloadKeptStaleChecksum: reloadKeptChecksum,
        checksumBefore: rawUiBefore.checksum,
        checksumAfterReload: afterReload.checksum,
        errorsAfterSecondWrite: secondConflict.errors,
      };
      s5.defects.push({
        id: 'D1',
        severity: 'medium',
        summary:
          'After an external disk edit, the UI retry path (重新读取) cannot resolve a write-conflict: readRaw returns the stale index checksum, so the next 写入文件 fails again. Only syncIndex/rebuildIndex updates the checksum, and the conflict message only tells the user to reload.',
        evidence: detail,
      });
      defects.push(s5.defects[s5.defects.length - 1]);
      s5.notes.push('D1: reload refreshes content but not the checksum; the retry fails until the index is synced.');
      process.stderr.write(`[s5] DEFECT D1: retry after 重新读取 still conflicts (checksum ${rawUiBefore.checksum} -> ${afterReload.checksum})\n`);
    }

    // Prove there is a working recovery: sync the index, reload, write.
    const syncResult = await rpc.ok('syncIndex', {});
    process.stderr.write(`[s5] syncIndex updated=${JSON.stringify(syncResult.updated)}\n`);
    await settle(300);
    await clickRect(browser, '.lmv-notice-error .lmv-btn', '重新读取', true, 900);
    await settle(900);
    const afterSyncRead = await eva(browser, pageRawState);
    check(s5, afterSyncRead.checksum !== rawUiBefore.checksum, 'checksum refreshes after an index sync', `${rawUiBefore.checksum} -> ${afterSyncRead.checksum}`);
    await clickRect(browser, '.lmv-main .lmv-btn', '写入文件', true, 1_000);
    await settle(900);
    const recovered = await eva(browser, pageRawState);
    const writeRecovered = recovered.errors.length === 0 && recovered.toasts.some((text) => text.includes('原文已写入'));
    check(s5, writeRecovered, 'write succeeds after the index is synced', JSON.stringify({ errors: recovered.errors, toasts: recovered.toasts }));
    const finalRaw = await rpc.ok('readRaw', { id: seeded.ids.alpha });
    check(s5, recovered.checksum === finalRaw.checksum, 'host checksum matches the UI checksum after the write', `${recovered.checksum} vs ${finalRaw.checksum}`);
    const occurrences = finalRaw.content.split('外部程序追加的一行').length - 1;
    check(s5, occurrences === 1, 'the in-section raw edit is preserved exactly once', `occurrences=${String(occurrences)}`);
    const s5ok = await browser.screenshot(path.join(config.out, 's5-write-recovered.png'));
    s5.screenshots.push({ name: 's5-write-recovered.png', path: s5ok.path, bytes: s5ok.bytes });

    // Secondary observation (API-level): writeRaw parses and re-renders, so raw
    // text outside the recognised sections is silently discarded even though the
    // editor is labelled "原文 Markdown" / "edit the file on disk directly".
    const fidelityBefore = await rpc.ok('readRaw', { id: seeded.ids.alpha });
    const trailingLine = '尾部附加内容（原文保真性探针）。';
    await rpc.ok('writeRaw', {
      id: seeded.ids.alpha,
      content: `${fidelityBefore.content}\n\n${trailingLine}\n`,
      expectedChecksum: fidelityBefore.checksum,
    });
    const fidelityAfter = await rpc.ok('readRaw', { id: seeded.ids.alpha });
    const trailingPreserved = fidelityAfter.content.includes(trailingLine);
    if (!trailingPreserved) {
      const observation = {
        id: 'D2',
        severity: 'low',
        summary:
          'Raw Markdown saves are parsed and re-rendered: text a user adds outside the recognised sections is silently dropped, although the tab is labelled 原文 Markdown and its hint says it edits the file on disk directly. No warning is shown.',
        evidence: {
          appended: trailingLine,
          survivedWrite: trailingPreserved,
          writeAccepted: true,
          checksumBefore: fidelityBefore.checksum,
          checksumAfter: fidelityAfter.checksum,
        },
      };
      s5.observations = s5.observations ?? [];
      s5.observations.push(observation);
      observations.push(observation);
      process.stderr.write(`[s5] OBSERVATION D2: trailing raw text silently dropped by writeRaw\n`);
    }
    await clickRect(browser, '.lmv-main .lmv-btn', '返回', false, 800);

    /* -- Scenario 6: archive and restore ------------------------------ */
    const s6 = makeScenario('6', 'Archive and restore from the UI, verified through /api/search');
    await clickNav(browser, '记忆检索');
    await setSearch(browser, 'archivebeta');
    await waitForExpression(browser, `Array.from(document.querySelectorAll('.lmv-row-title')).some((el) => (el.innerText || '').includes('可归档记忆 Beta'))`, 8_000);
    await clickRect(browser, '.lmv-row-click', '可归档记忆 Beta', false, 900);
    await waitForExpression(browser, `(document.querySelector('.lmv-main')?.innerText ?? '').includes('归档')`, 8_000);
    await settle(600);
    const betaBefore = await eva(browser, pageDetailState);
    check(s6, betaBefore.badges.includes('当前'), 'memory starts in the active state', JSON.stringify(betaBefore.badges));

    await clickRect(browser, '.lmv-main .lmv-btn', '归档', true, 1_200);
    await settle(900);
    const afterArchive = await eva(browser, pageDetailState);
    const archiveGet = await rpc.ok('get', { id: seeded.ids.beta });
    const searchActiveArchived = await rpc.ok('search', { text: 'archivebeta', includeNonCurrent: false });
    const searchAllArchived = await rpc.ok('search', { text: 'archivebeta', includeNonCurrent: true });
    check(s6, afterArchive.badges.includes('已归档'), 'detail badge switches to 已归档', JSON.stringify(afterArchive.badges));
    check(s6, afterArchive.toasts.some((text) => text.includes('已归档')), 'archive toast is shown', JSON.stringify(afterArchive.toasts));
    check(s6, archiveGet.memory.status === 'archived', 'host memory status is archived', archiveGet.memory.status);
    check(s6, searchActiveArchived.total === 0, '/api/search (active only) no longer returns it', `total=${String(searchActiveArchived.total)}`);
    check(s6, searchAllArchived.total === 1, '/api/search (include non-current) still returns it', `total=${String(searchAllArchived.total)}`);
    const s6arch = await browser.screenshot(path.join(config.out, 's6-archived-detail.png'));
    s6.screenshots.push({ name: 's6-archived-detail.png', path: s6arch.path, bytes: s6arch.bytes });

    await clickRect(browser, '.lmv-main .lmv-btn', '返回', false, 800);
    await clickNav(browser, '记忆检索');
    await setSearch(browser, 'archivebeta');
    await waitForExpression(browser, `Array.from(document.querySelectorAll('.lmv-row-title')).some((el) => (el.innerText || '').includes('可归档记忆 Beta'))`, 8_000);
    const archivedListing = await eva(browser, pageLmvState);
    check(s6, archivedListing.rowTitles.includes('可归档记忆 Beta'), 'archived memory is listed when non-current memories are included', JSON.stringify(archivedListing.rowTitles));
    check(s6, archivedListing.mainText.includes('已归档'), 'archived row is labelled 已归档', archivedListing.mainText.slice(0, 200));
    const s6list = await browser.screenshot(path.join(config.out, 's6-archived-search.png'));
    s6.screenshots.push({ name: 's6-archived-search.png', path: s6list.path, bytes: s6list.bytes });

    const checkbox = await eva(browser, pageCheckboxRect, '包含非当前记忆');
    check(s6, checkbox.found === true && checkbox.checked === true, 'non-current inclusion starts enabled', JSON.stringify(checkbox));
    await browser._clickAt(checkbox.x, checkbox.y, { settleMs: 1_100 });
    const activeOnly = await eva(browser, pageLmvState);
    check(s6, activeOnly.empties.includes('没有匹配的记忆'), 'archived memory disappears from the active-only listing', JSON.stringify(activeOnly.empties));
    check(s6, activeOnly.rowTitles.length === 0, 'active-only listing has no rows', JSON.stringify(activeOnly.rowTitles));
    const s6empty = await browser.screenshot(path.join(config.out, 's6-active-listing-empty.png'));
    s6.screenshots.push({ name: 's6-active-listing-empty.png', path: s6empty.path, bytes: s6empty.bytes });

    const checkbox2 = await eva(browser, pageCheckboxRect, '包含非当前记忆');
    await browser._clickAt(checkbox2.x, checkbox2.y, { settleMs: 1_100 });
    await waitForExpression(browser, `Array.from(document.querySelectorAll('.lmv-row-title')).some((el) => (el.innerText || '').includes('可归档记忆 Beta'))`, 8_000);
    await clickRect(browser, '.lmv-row-click', '可归档记忆 Beta', false, 900);
    await waitForExpression(browser, `(document.querySelector('.lmv-main')?.innerText ?? '').includes('恢复为当前')`, 8_000);
    await clickRect(browser, '.lmv-main .lmv-btn', '恢复为当前', true, 1_200);
    await settle(900);
    const afterRestore = await eva(browser, pageDetailState);
    const restoreGet = await rpc.ok('get', { id: seeded.ids.beta });
    const searchActiveRestored = await rpc.ok('search', { text: 'archivebeta', includeNonCurrent: false });
    check(s6, afterRestore.badges.includes('当前'), 'detail badge returns to 当前', JSON.stringify(afterRestore.badges));
    check(s6, afterRestore.toasts.some((text) => text.includes('恢复')), 'restore toast is shown', JSON.stringify(afterRestore.toasts));
    check(s6, restoreGet.memory.status === 'active', 'host memory status is active again', restoreGet.memory.status);
    check(s6, searchActiveRestored.total === 1, '/api/search (active only) returns it again', `total=${String(searchActiveRestored.total)}`);
    const s6rest = await browser.screenshot(path.join(config.out, 's6-restored-detail.png'));
    s6.screenshots.push({ name: 's6-restored-detail.png', path: s6rest.path, bytes: s6rest.bytes });

    await clickRect(browser, '.lmv-main .lmv-btn', '返回', false, 800);
    await clickNav(browser, '记忆检索');
    await setSearch(browser, 'archivebeta');
    await waitForExpression(browser, `Array.from(document.querySelectorAll('.lmv-row-title')).some((el) => (el.innerText || '').includes('可归档记忆 Beta'))`, 8_000);
    const checkbox3 = await eva(browser, pageCheckboxRect, '包含非当前记忆');
    await browser._clickAt(checkbox3.x, checkbox3.y, { settleMs: 1_100 });
    const restoredActiveOnly = await eva(browser, pageLmvState);
    check(s6, restoredActiveOnly.rowTitles.includes('可归档记忆 Beta'), 'restored memory is back in the active-only listing', JSON.stringify(restoredActiveOnly.rowTitles));
    const s6active = await browser.screenshot(path.join(config.out, 's6-restored-search.png'));
    s6.screenshots.push({ name: 's6-restored-search.png', path: s6active.path, bytes: s6active.bytes });

    /* -- Scenario 7: Chinese UI + light/dark theme -------------------- */
    const s7 = makeScenario('7', 'Chinese interface and light/dark host theme');
    await clickNav(browser, '记忆总览');
    await settle(500);
    const settings = await rpc.ok('getSettings', {});
    check(s7, settings.language === 'zh', 'plugin setting language is zh', settings.language);
    const zhState = await eva(browser, pageLmvState);
    const chineseNav = ['记忆总览', '记忆检索', '记忆管理', '收件箱', '设置'];
    check(s7, chineseNav.every((label) => zhState.nav.includes(label)), 'all five navigation labels are Chinese', JSON.stringify(zhState.nav));
    check(s7, await browser.evaluate('document.documentElement.lang') === 'zh-CN', 'document language is zh-CN', await browser.evaluate('document.documentElement.lang'));

    await openHostSettings(browser);
    await setHostTheme(browser, '浅色');
    await closeHostSettings(browser);
    await settle(700);
    const lightState = await eva(browser, pageThemeState);
    const s7light = await browser.screenshot(path.join(config.out, 's7-theme-light.png'));
    s7.screenshots.push({ name: 's7-theme-light.png', path: s7light.path, bytes: s7light.bytes });
    check(s7, lightState.source === 'light', 'host theme source is light', JSON.stringify(lightState.source));
    check(s7, lightState.colorScheme.includes('light'), 'color-scheme is light', lightState.colorScheme);
    check(s7, lightState.hasPage === true, 'plugin page is present in light mode', String(lightState.hasPage));

    await openHostSettings(browser);
    await setHostTheme(browser, '深色');
    await closeHostSettings(browser);
    await settle(900);
    const darkState = await eva(browser, pageThemeState);
    const s7dark = await browser.screenshot(path.join(config.out, 's7-theme-dark.png'));
    s7.screenshots.push({ name: 's7-theme-dark.png', path: s7dark.path, bytes: s7dark.bytes });
    check(s7, darkState.source === 'dark', 'host theme source is dark', JSON.stringify(darkState.source));
    check(s7, darkState.colorScheme.includes('dark'), 'color-scheme is dark', darkState.colorScheme);
    check(s7, darkState.pageBg !== lightState.pageBg, 'plugin page background follows the host theme', `${lightState.pageBg} -> ${darkState.pageBg}`);
    check(s7, darkState.pageBg !== null && /rgb/.test(darkState.pageBg), 'dark page background is a concrete colour', String(darkState.pageBg));
    check(s7, chineseNav.every((label) => darkState.nav.includes(label)), 'navigation stays Chinese in dark mode', JSON.stringify(darkState.nav));
    const luminance = (value) => {
      const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(value));
      if (match === null) return null;
      return 0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3]);
    };
    check(s7, luminance(darkState.pageBg) !== null && luminance(darkState.pageBg) < 100, 'dark background is actually dark', `luminance=${String(luminance(darkState.pageBg))}`);
    s7.data = { light: lightState, dark: darkState };

    await openHostSettings(browser);
    await setHostTheme(browser, '浅色');
    await closeHostSettings(browser);
    await settle(600);

    /* -- Scenario 8: page-load failure display ------------------------ */
    const s8 = makeScenario('8', 'Page load failure display when the plugin API is unreachable');
    const intercepted = [];
    fetchHook = (params) => {
      const url = params.request?.url ?? '';
      if (url.includes(`${API_PREFIX}/`)) {
        intercepted.push(url.replace(/^https?:\/\/[^/]+/, ''));
        browser.client
          .send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' })
          .catch(() => undefined);
      } else {
        browser.client.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => undefined);
      }
    };
    await browser.client.send('Fetch.enable', { patterns: [{ urlPattern: '*dsh-longterm-memory/api/*', requestStage: 'Request' }] });
    await browser.goto(config.url, { settleMs: 1_500 });
    await dismissBlockingDialogs(browser);
    await settle(600);
    await openPluginPage(
      browser,
      `document.querySelector('.lmv-notice-error') !== null || document.querySelectorAll('.lmv-nav-btn').length >= 5`,
      10_000,
    ).catch((error) => {
      process.stderr.write(`[s8] the plugin page did not settle: ${error.message}\n`);
    });
    const failureAppeared = await waitForExpression(
      browser,
      `(() => { const e = document.querySelector('.lmv-notice-error'); return e !== null && (e.innerText || '').includes('操作失败'); })()`,
      12_000,
    );
    await settle(500);
    const failureState = await eva(browser, pageLmvState);
    const failureText = failureState.errors.join(' | ');
    const s8shot = await browser.screenshot(path.join(config.out, 's8-api-unreachable.png'));
    s8.screenshots.push({ name: 's8-api-unreachable.png', path: s8shot.path, bytes: s8shot.bytes });
    check(s8, failureAppeared === true, 'an error panel is displayed when the API is unreachable', failureAppeared === true ? 'panel appeared' : 'no panel');
    check(s8, /操作失败/.test(failureText), 'error text names the failed operation', failureText);
    check(s8, /错误码/.test(failureText) && /internal/.test(failureText), 'error code is rendered (internal)', failureText);
    check(s8, failureState.errors.length > 0, 'the failure is not a blank area', `errors=${String(failureState.errors.length)}`);
    const retryInfo = await eva(browser, pageFindRect, '.lmv-notice-error .lmv-btn', '重试', true);
    check(s8, retryInfo.found === true, 'a 重试 button is offered', JSON.stringify(retryInfo));
    check(s8, failureState.navCount === 0, 'failed load does not pretend the page succeeded', `navCount=${String(failureState.navCount)}`);
    check(s8, intercepted.length > 0, 'the failure was produced by failing only the plugin API route', `intercepted=${String(intercepted.length)} ${intercepted.slice(0, 3).join(', ')}`);

    fetchHook = null;
    await browser.client.send('Fetch.disable');
    await settle(300);
    if (retryInfo.found) await browser._clickAt(retryInfo.x, retryInfo.y, { settleMs: 1_200 });
    const recoveredNav = await waitForExpression(browser, `document.querySelectorAll('.lmv-nav-btn').length >= 5`, 12_000);
    const recoveredState = await eva(browser, pageLmvState);
    check(s8, recoveredNav === true, '重试 recovers the page once the API is reachable again', `navCount=${String(recoveredState.navCount)}`);
    check(s8, recoveredState.errors.length === 0, 'no error panel after recovery', JSON.stringify(recoveredState.errors));
    const s8ok = await browser.screenshot(path.join(config.out, 's8-recovered.png'));
    s8.screenshots.push({ name: 's8-recovered.png', path: s8ok.path, bytes: s8ok.bytes });
    s8.notes.push('The plugin API was made unreachable with CDP Fetch.failRequest scoped to */dsh-longterm-memory/api/*, so the shell stayed up and only the plugin RPC failed.');

    scenarios.push(s1, s2, s3, s4, s5, s6, s7, s8, s9);

    /* -- Write the summary ------------------------------------------- */
    const summary = {
      generatedAt: new Date().toISOString(),
      url: redactUrl(config.url),
      out: config.out,
      seedIds: seeded.ids,
      scenarios: scenarios.map((scenario) => ({
        id: scenario.id,
        name: scenario.name,
        result: scenario.result,
        assertions: scenario.assertions,
        defects: scenario.defects,
        observations: scenario.observations ?? [],
        notes: scenario.notes,
        screenshots: scenario.screenshots,
        ...(scenario.data === undefined ? {} : { data: scenario.data }),
      })),
      defects,
      observations,
      consoleErrors,
      exceptions,
      totals: {
        scenarios: scenarios.length,
        passed: scenarios.filter((scenario) => scenario.result === 'PASS').length,
        failed: scenarios.filter((scenario) => scenario.result === 'FAIL').length,
        assertions: scenarios.reduce((sum, scenario) => sum + scenario.assertions.length, 0),
        failedAssertions: scenarios.reduce(
          (sum, scenario) => sum + scenario.assertions.filter((item) => item.ok !== true).length,
          0,
        ),
      },
      browser: { name: path.basename(config.browser), headless: config.headless, userDataDir: path.join(WORKSPACE, '.scratch', 'ui3-chrome-profile') },
    };
    await writeFile(path.join(config.out, 'extra-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.totals.failed === 0 ? 0 : 1;
  } finally {
    if (fetchHook !== null && browser !== null) {
      try {
        await browser.client.send('Fetch.disable');
      } catch {
        /* ignore */
      }
    }
    await browser?.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
