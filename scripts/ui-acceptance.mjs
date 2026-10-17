#!/usr/bin/env node
/**
 * ui-acceptance.mjs — real-browser acceptance scenario for the DSH Memory Vault
 * (长期记忆) sidebar entry and its independent management page.
 *
 * Verification infrastructure only; it does not modify the plugin.
 *
 *   node scripts/ui-acceptance.mjs --url "http://127.0.0.1:<port>/?token=..."
 *
 * Screenshots and text dumps are written to .scratch/ui/.
 * A compact JSON summary is printed on stdout; diagnostics go to stderr.
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserHarness,
  DEFAULT_CHROME,
  DEFAULT_EDGE,
  WORKSPACE,
  delay,
  normalizeWhitespace,
  redactUrl,
} from './ui-verify.mjs';

const OUT_DIR = path.join(WORKSPACE, '.scratch', 'ui');
const CHROME_PROFILE = path.join(WORKSPACE, '.scratch', 'chrome-profile');
const EDGE_PROFILE = path.join(WORKSPACE, '.scratch', 'edge-profile');

const USAGE = `Usage: node scripts/ui-acceptance.mjs --url <dsh-web-url> [options]

Options:
  --out <dir>        screenshot output dir (default .scratch/ui)
  --settle <ms>      settle delay after load (default 1500)
  --browser <path>   force one browser binary (disables fallback)
  --headless new|old force one headless mode (default new)
  --help             this help
`;

/* ------------------------------------------------------------------ *
 * Browser-side extractors (serialised with toString()).
 * ------------------------------------------------------------------ */

export function pageSidebarEntries() {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    ) {
      return false;
    }
    return true;
  };

  const vw = innerWidth;
  const containers = Array.from(
    document.querySelectorAll(
      'aside, nav, [role="navigation"], [role="complementary"], [class*="sidebar" i], [class*="rail" i], [class*="panellist" i], [data-slot*="sidebar" i], [data-testid*="sidebar" i]',
    ),
  ).filter((el) => {
    if (!visible(el)) return false;
    const rect = el.getBoundingClientRect();
    return rect.left < vw * 0.25 && rect.width > 40 && rect.width < vw * 0.45;
  });

  let roots = containers;
  let fallback = false;
  if (roots.length === 0) {
    roots = [document.body];
    fallback = true;
  }

  const entries = [];
  const seen = new Set();
  for (const root of roots) {
    for (const el of root.querySelectorAll(
      'button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="listitem"], [role="treeitem"], [role="option"], [data-panel-id], li',
    )) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.right < 0 || rect.top < 0 || rect.bottom > innerHeight + 4) continue;
      if (fallback && rect.left >= vw * 0.25) continue;
      if (rect.left + rect.width / 2 >= vw * 0.25) continue;
      if (rect.width > vw * 0.4 || rect.height > 140) continue;

      const textContent = norm(el.textContent);
      const innerText = norm(el.innerText);
      const ariaLabel = norm(el.getAttribute('aria-label'));
      const title = norm(el.getAttribute('title'));
      if (!textContent && !ariaLabel && !title) continue;

      const dedupeKey = [
        ariaLabel || title || innerText || textContent,
        Math.round(rect.left / 4),
        Math.round(rect.top / 4),
      ].join('|');
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      entries.push({
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === 'string' ? el.className : '',
        textContent,
        innerText,
        ariaLabel,
        title,
        rect: {
          x: Math.round(rect.x * 100) / 100,
          y: Math.round(rect.y * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        },
      });
    }
  }

  entries.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return {
    viewport: { width: vw, height: innerHeight },
    sidebarContainers: containers.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === 'string' ? el.className : '',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    }),
    usedFallback: fallback,
    count: entries.length,
    entries: entries.slice(0, 100),
  };
}

export function pageInspect() {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    ) {
      return false;
    }
    return true;
  };

  const page = document.querySelector('.lmv-page');
  const scope = page ?? document.body;
  const text = norm(scope?.innerText ?? '');
  const bodyText = norm(document.body?.innerText ?? '');
  const navLabels = Array.from(document.querySelectorAll('.lmv-nav-btn'))
    .filter(visible)
    .map((el) => norm(el.innerText || el.textContent));
  const errorPanels = Array.from(document.querySelectorAll('.lmv-notice-error'))
    .filter(visible)
    .map((el) => norm(el.innerText));

  const rawHints = [];
  const hints = {
    typeError: /TypeError/i,
    cannotRead: /Cannot read propert/i,
    uncaught: /Uncaught/i,
    appError: /Application error|Something went wrong|Unexpected Application Error/i,
    backend: /无法连接记忆库后端/,
  };
  for (const [name, pattern] of Object.entries(hints)) {
    if (pattern.test(text)) rawHints.push(name);
  }

  let initPanelExcerpt = '';
  const initMatch = text.match(/初始化记忆库|尚未初始化记忆库/);
  if (initMatch !== null) {
    const start = Math.max(0, (initMatch.index ?? 0) - 40);
    initPanelExcerpt = text.slice(start, start + 220);
  }

  return {
    lmvPage: page !== null,
    pageVisible: page !== null ? visible(page) : false,
    lmvClassCount: document.querySelectorAll('[class*="lmv-"]').length,
    title: norm(document.querySelector('.lmv-title')?.textContent ?? ''),
    subtitle: norm(document.querySelector('.lmv-subtitle')?.textContent ?? ''),
    navLabels,
    hasOverviewText: /记忆总览|总览|Overview/.test(text),
    hasSearchText: /记忆检索|检索|Search/.test(text),
    initPanel: initMatch !== null,
    initPanelExcerpt,
    errorPanels,
    rawHints,
    rawError: errorPanels.length > 0 || rawHints.length > 0,
    text,
    bodyTextLength: bodyText.length,
    activeNav: norm(
      Array.from(document.querySelectorAll('.lmv-nav-btn')).find(
        (el) => el.getAttribute('aria-current') === 'true',
      )?.innerText ?? '',
    ),
  };
}

export function pageViewText() {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const body = document.querySelector('.lmv-body');
  return {
    text: norm(body?.innerText ?? ''),
    activeNav: norm(
      Array.from(document.querySelectorAll('.lmv-nav-btn')).find(
        (el) => el.getAttribute('aria-current') === 'true',
      )?.innerText ?? '',
    ),
  };
}

export function pagePreflight() {
  const text = String(document.body?.innerText ?? '');
  return {
    url: location.href,
    title: document.title,
    textLength: text.trim().length,
    elements: document.querySelectorAll('*').length,
    authRequired: /authentication required|unauthorized|reopen the url printed by dsh web/i.test(text),
    excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}

export function pageDialogs() {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 &&
      (typeof el.checkVisibility !== 'function' ||
        el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    );
  };
  return Array.from(document.querySelectorAll('[role="dialog"]'))
    .filter(visible)
    .map((el) => ({
      aria: norm(el.getAttribute('aria-label')),
      text: norm(el.innerText).slice(0, 300),
      buttons: Array.from(el.querySelectorAll('button'))
        .filter(visible)
        .map((button) => ({
          text: norm(button.innerText || button.textContent),
          aria: norm(button.getAttribute('aria-label')),
        })),
    }));
}

/**
 * Dismiss real first-run overlays the same way a user would: the preview
 * notice ("继续") and the optional sign-in gate (close button). These belong
 * to the DSH shell, not to the plugin under test.
 */
export async function dismissBlockingDialogs(browser) {
  const dismissed = [];
  for (let round = 0; round < 8; round += 1) {
    const dialogs = await browser.evaluate(`(${pageDialogs.toString()})()`);
    if (dialogs.length === 0) break;
    const dialog = dialogs[0];
    let action = null;

    if (/预览版说明/.test(dialog.aria)) {
      for (const text of ['继续', '知道了', '开始使用', '跳过']) {
        try {
          await browser.clickText(text, { within: '[role="dialog"]', settleMs: 350 });
          action = { kind: 'text', value: text };
          break;
        } catch {
          /* try next */
        }
      }
    }

    if (action === null) {
      const safeAria = dialog.aria.replace(/["\\]/g, '\\$&');
      for (const selector of [
        `[role="dialog"][aria-label="${safeAria}"] button[aria-label="关闭"]`,
        '[role="dialog"] button[aria-label="关闭"]',
        '[role="dialog"] button[aria-label="Close"]',
      ]) {
        try {
          await browser.clickSelector(selector, { settleMs: 350 });
          action = { kind: 'selector', value: selector };
          break;
        } catch {
          /* try next */
        }
      }
    }

    if (action === null) {
      for (const text of ['继续', '知道了', '跳过', '关闭', 'Close']) {
        try {
          await browser.clickText(text, { settleMs: 350 });
          action = { kind: 'text', value: text };
          break;
        } catch {
          /* try next */
        }
      }
    }

    dismissed.push({ aria: dialog.aria, text: dialog.text.slice(0, 120), action });
    if (action === null) break;
    await delay(400);
  }
  return dismissed;
}


/* ------------------------------------------------------------------ *
 * Scenario
 * ------------------------------------------------------------------ */

function routeOf(value) {
  try {
    const url = new URL(value);
    const params = new URLSearchParams(url.search);
    for (const key of ['token', 'access_token', 'auth', 'apikey', 'api_key']) params.delete(key);
    const query = params.toString();
    return `${url.pathname}${query ? `?${query}` : ''}${url.hash}`;
  } catch {
    return String(value);
  }
}

function conversationRoute(value) {
  try {
    const url = new URL(value);
    if (/\/(chat|chats|conversation|conversations|c|session|sessions)(\/|$)/i.test(url.pathname)) {
      return true;
    }
    const params = new URLSearchParams(url.search);
    return ['conversation', 'conversationId', 'chat', 'session', 'sessionId'].some((key) =>
      params.has(key),
    );
  } catch {
    return false;
  }
}

function slugForLabel(label) {
  const text = normalizeWhitespace(label);
  if (/总览|Overview/i.test(text)) return 'overview';
  if (/检索|Search/i.test(text)) return 'search';
  if (/详情|Detail/i.test(text)) return 'detail';
  if (/管理|Manage/i.test(text)) return 'manage';
  if (/收件箱|Inbox/i.test(text)) return 'inbox';
  if (/设置|Settings/i.test(text)) return 'settings';
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'view'
  );
}

async function runScenario(browser, startedUrl, outDir, meta) {
  const screenshots = [];
  const stepErrors = [];
  const pageErrors = [];
  const viewsVisited = [];

  const notePageError = (message) => {
    const text = normalizeWhitespace(message);
    if (text.length === 0) return;
    if (!pageErrors.includes(text)) pageErrors.push(text);
  };

  browser.onEvent = (event) => {
    if (event.kind === 'console' && event.type === 'error') {
      notePageError(`console.error: ${event.text}`);
      process.stderr.write(`[browser console.error] ${event.text}\n`);
    } else if (event.kind === 'exception') {
      notePageError(`exception: ${event.text}`);
      process.stderr.write(`[browser exception] ${event.text}\n`);
    } else if (event.kind === 'log' && event.type === 'error') {
      notePageError(`log.error: ${event.text}`);
      process.stderr.write(`[browser log.error] ${event.text}${event.url ? ` (${event.url})` : ''}\n`);
    } else if (event.kind === 'harness' && event.level === 'error') {
      process.stderr.write(`[harness] ${event.text}\n`);
    }
  };

  const shot = async (name) => {
    const info = await browser.screenshot(path.join(outDir, name));
    screenshots.push({ name, path: info.path, bytes: info.bytes });
    process.stderr.write(`[scenario] screenshot ${name} (${info.bytes} bytes)\n`);
    return info;
  };

  /* -- step 1: load root, screenshot, clear first-run overlays -------- */
  await shot('01-loaded.png');

  const initialDialogs = await browser.evaluate(`(${pageDialogs.toString()})()`);
  const dialogsDismissed = await dismissBlockingDialogs(browser);
  if (dialogsDismissed.length > 0) {
    process.stderr.write(
      `[scenario] dismissed ${String(dialogsDismissed.length)} first-run dialog(s): ${dialogsDismissed
        .map((item) => item.aria || '(no aria-label)')
        .join(', ')}\n`,
    );
  }
  if (initialDialogs.length > 0) await delay(400);

  /* -- step 2: screenshot sidebar, click the entry ------------------- */
  await shot('02-sidebar.png');

  const sidebar = await browser.evaluate(`(${pageSidebarEntries.toString()})()`);
  await writeFile(
    path.join(outDir, 'sidebar-entries.json'),
    `${JSON.stringify(sidebar, null, 2)}\n`,
  );
  process.stderr.write(
    `[scenario] sidebar entries: ${sidebar.count} (fallback=${String(sidebar.usedFallback)})\n`,
  );
  for (const entry of sidebar.entries) {
    process.stderr.write(
      `  - ${JSON.stringify(entry.ariaLabel || entry.title || entry.innerText || entry.textContent)} ` +
        `[${entry.tag}] ${String(entry.rect.width)}x${String(entry.rect.height)} @ ${String(entry.rect.x)},${String(entry.rect.y)}\n`,
    );
  }

  let clickedEntry = null;
  const clickAttempts = [];
  const textCandidates = ['长期记忆', 'Long-term Memory'];
  for (const candidate of textCandidates) {
    try {
      clickedEntry = await browser.clickText(candidate, { settleMs: 350 });
      clickAttempts.push({ candidate, ok: true });
      break;
    } catch (error) {
      clickAttempts.push({ candidate, ok: false, error: error.message });
      process.stderr.write(`[scenario] click-text ${JSON.stringify(candidate)} failed: ${error.message}\n`);
    }
  }
  if (clickedEntry === null) {
    for (const selector of [
      '[data-panel-id="longterm-memory"]',
      '[data-slot-id="longterm-memory"]',
      '[aria-label="长期记忆"]',
      '[title="长期记忆"]',
    ]) {
      try {
        clickedEntry = await browser.clickSelector(selector, { settleMs: 350 });
        clickedEntry = { ...clickedEntry, selector };
        clickAttempts.push({ selector, ok: true });
        break;
      } catch (error) {
        clickAttempts.push({ selector, ok: false, error: error.message });
      }
    }
  }
  if (clickedEntry === null) {
    stepErrors.push('could not click the 长期记忆 sidebar entry with any selector');
  }

  /* -- step 3: wait for the page, screenshot ------------------------- */
  let pageAppeared = false;
  try {
    await browser.waitForSelector('.lmv-page', 15_000);
    pageAppeared = true;
  } catch (error) {
    process.stderr.write(`[scenario] .lmv-page did not appear: ${error.message}\n`);
  }
  if (!pageAppeared) {
    try {
      await browser.waitForText('记忆总览', 5_000);
      pageAppeared = true;
    } catch {
      /* keep pageAppeared false */
    }
  }
  await delay(700);
  await shot('03-page.png');

  /* -- step 4: DOM assertions ---------------------------------------- */
  const info = await browser.evaluate(`(${pageInspect.toString()})()`);
  const afterUrl = await browser.evaluate('location.href');
  const urlChanged = afterUrl !== startedUrl;
  const routeChanged = routeOf(afterUrl) !== routeOf(startedUrl);
  const newConversation = !conversationRoute(startedUrl) && conversationRoute(afterUrl);
  const pageOpened =
    info.lmvPage && (info.hasOverviewText || info.navLabels.length > 0 || info.initPanel);
  if (!pageOpened) stepErrors.push('management page did not open (no .lmv-page / overview / nav)');
  if (info.rawError) stepErrors.push('management page is showing a raw error');

  /* -- step 5: click every available view tab ------------------------ */
  for (let index = 0; index < info.navLabels.length; index += 1) {
    const label = info.navLabels[index];
    if (label.length === 0) continue;
    const name = slugForLabel(label);
    try {
      const clicked = await browser.clickText(label, { within: '.lmv-nav', settleMs: 550 });
      const view = await browser.evaluate(`(${pageViewText.toString()})()`);
      const file = `04-${String(index + 1)}-${name}.png`;
      await shot(file);
      viewsVisited.push({
        index: index + 1,
        label,
        name,
        clicked: { tag: clicked.tag, className: clicked.className, text: clicked.text },
        activeNav: view.activeNav,
        text: view.text.slice(0, 500),
        screenshot: path.join(outDir, file),
      });
      process.stderr.write(`[scenario] view ${label} -> ${file}\n`);
    } catch (error) {
      stepErrors.push(`view tab ${JSON.stringify(label)} could not be clicked: ${error.message}`);
      process.stderr.write(`[scenario] view ${JSON.stringify(label)} failed: ${error.message}\n`);
    }
  }
  if (info.navLabels.length === 0 && pageOpened) {
    stepErrors.push('management page opened but no view tabs were found');
  }

  /* -- step 6: dump visible page text -------------------------------- */
  const overviewText = info.text;
  const pageText = [
    '=== DSH Memory Vault / 长期记忆 — visible management page text ===',
    `URL: ${redactUrl(startedUrl)}`,
    `TITLE: ${info.title}`,
    `SUBTITLE: ${info.subtitle}`,
    `NAV: ${info.navLabels.join(' | ')}`,
    '',
    '=== 记忆总览 / initial view ===',
    overviewText,
    '',
    ...viewsVisited.map(
      (view) => `=== ${view.label} (${view.name}) ===\n${view.text}\n`,
    ),
  ].join('\n');
  const pageTextFile = path.join(outDir, 'page-text.txt');
  await writeFile(pageTextFile, `${pageText}\n`);

  // Include anything the browser reported during the initial load as well as
  // during the scenario. Favicon 404s are recorded but not treated as UI errors.
  for (const message of browser.consoleMessages) {
    if (message.type === 'error') notePageError(`console.error: ${message.text}`);
  }
  for (const exception of browser.exceptions) notePageError(`exception: ${exception.text}`);
  for (const entry of browser.logEntries) {
    if (entry.type === 'error') notePageError(`log.error: ${entry.text}`);
  }

  const summary = {
    url: redactUrl(startedUrl),
    urlBefore: redactUrl(startedUrl),
    urlAfter: redactUrl(afterUrl),
    urlChanged,
    routeChanged,
    routeBefore: routeOf(startedUrl),
    routeAfter: routeOf(afterUrl),
    newConversation,
    initialDialogs,
    dialogsDismissed,
    sidebarEntries: sidebar.entries,
    sidebarContainerCount: sidebar.sidebarContainers.length,
    sidebarFallback: sidebar.usedFallback,
    clickedEntry,
    clickAttempts,
    pageOpened,
    pageTitle: info.title,
    pageSubtitle: info.subtitle,
    navLabels: info.navLabels,
    hasOverviewText: info.hasOverviewText,
    initPanel: info.initPanel,
    initPanelExcerpt: info.initPanelExcerpt,
    rawError: info.rawError,
    rawHints: info.rawHints,
    errorPanels: info.errorPanels,
    lmvClassCount: info.lmvClassCount,
    viewsVisited,
    errors: [...stepErrors, ...pageErrors],
    stepErrors,
    pageErrors,
    screenshots,
    browser: meta,
    pageTextFile,
    pageText: overviewText.slice(0, 5000),
  };
  return summary;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const config = {
    url: null,
    out: OUT_DIR,
    settleMs: 1500,
    browser: null,
    headless: 'new',
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
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return config;
}

function buildAttempts(config) {
  if (config.browser !== null) {
    return [
      {
        name: 'explicit-browser',
        browserPath: config.browser,
        headless: config.headless,
        userDataDir: /msedge/i.test(config.browser) ? EDGE_PROFILE : CHROME_PROFILE,
      },
    ];
  }
  const altHeadless = config.headless === 'new' ? 'old' : 'new';
  return [
    {
      name: `chrome-headless-${config.headless}`,
      browserPath: DEFAULT_CHROME,
      headless: config.headless,
      userDataDir: CHROME_PROFILE,
    },
    {
      name: `chrome-headless-${altHeadless}`,
      browserPath: DEFAULT_CHROME,
      headless: altHeadless,
      userDataDir: CHROME_PROFILE,
    },
    {
      name: `edge-headless-${config.headless}`,
      browserPath: DEFAULT_EDGE,
      headless: config.headless,
      userDataDir: EDGE_PROFILE,
    },
    {
      name: `edge-headless-${altHeadless}`,
      browserPath: DEFAULT_EDGE,
      headless: altHeadless,
      userDataDir: EDGE_PROFILE,
    },
  ];
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (config.url === null) throw new Error(`--url is required\n\n${USAGE}`);
  await mkdir(config.out, { recursive: true });

  const attempts = [];
  let browser = null;
  let meta = null;
  let loadedUrl = null;

  for (const attempt of buildAttempts(config)) {
    const record = { name: attempt.name, status: 'starting' };
    attempts.push(record);
    let candidate = null;
    try {
      process.stderr.write(`[scenario] launching ${attempt.name} (${attempt.browserPath})\n`);
      candidate = await BrowserHarness.launch({
        browserPath: attempt.browserPath,
        headless: attempt.headless,
        userDataDir: attempt.userDataDir,
      });
      await candidate.goto(config.url, { settleMs: config.settleMs });
      const preflight = await candidate.evaluate(`(${pagePreflight.toString()})()`);
      record.preflight = {
        textLength: preflight.textLength,
        elements: preflight.elements,
        authRequired: preflight.authRequired,
        excerpt: preflight.excerpt,
      };
      if (preflight.authRequired) {
        throw new Error(`GUI requires authentication: ${preflight.excerpt}`);
      }
      if (preflight.textLength < 5 || preflight.elements < 20) {
        throw new Error(
          `blank page after load (textLength=${String(preflight.textLength)}, elements=${String(preflight.elements)})`,
        );
      }
      record.status = 'ok';
      browser = candidate;
      loadedUrl = preflight.url;
      meta = {
        name: attempt.name,
        browserPath: attempt.browserPath,
        headless: attempt.headless,
        port: candidate.port,
        userDataDir: attempt.userDataDir,
      };
      break;
    } catch (error) {
      record.status = 'failed';
      record.error = error.message;
      process.stderr.write(`[scenario] attempt ${attempt.name} failed: ${error.message}\n`);
      await candidate?.close();
      if (/requires authentication/i.test(error.message)) break;
    }
  }

  if (browser === null) {
    const summary = {
      url: redactUrl(config.url),
      pageOpened: false,
      sidebarEntries: [],
      clickedEntry: null,
      viewsVisited: [],
      errors: attempts.map((attempt) => `${attempt.name}: ${attempt.error ?? attempt.status}`),
      screenshots: [],
      attempts,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 1;
  }

  let summary;
  let exitCode = 0;
  try {
    summary = await runScenario(browser, loadedUrl ?? config.url, config.out, meta);
    summary.attempts = attempts;
    if (!summary.pageOpened) exitCode = 1;
    if (summary.sidebarEntries.length === 0) exitCode = 1;
    if (summary.stepErrors.length > 0) exitCode = 1;
  } catch (error) {
    summary = {
      url: redactUrl(config.url),
      pageOpened: false,
      sidebarEntries: [],
      clickedEntry: null,
      viewsVisited: [],
      errors: [error.stack ?? error.message],
      screenshots: [],
      attempts,
      browser: meta,
    };
    process.stderr.write(`[scenario] FAILED: ${error.stack ?? error.message}\n`);
    exitCode = 1;
  } finally {
    await browser.close();
  }

  for (const shot of summary.screenshots) {
    try {
      const info = await stat(shot.path);
      shot.bytesOnDisk = info.size;
    } catch {
      shot.bytesOnDisk = null;
    }
  }
  await writeFile(path.join(config.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}
