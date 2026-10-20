#!/usr/bin/env node
/**
 * ui-verify.mjs — dependency-free Chrome DevTools Protocol harness.
 *
 * This is verification infrastructure only. It drives a real Chromium-based
 * browser (Chrome by default, Edge as a fallback) over its remote debugging
 * WebSocket using Node 24's global `WebSocket`. No puppeteer / playwright.
 *
 * Module use:
 *   import { BrowserHarness } from './ui-verify.mjs';
 *   const browser = await BrowserHarness.launch({ headless: 'new' });
 *   await browser.goto(url);
 *   await browser.screenshot('out.png');
 *   await browser.clickText('长期记忆');
 *   await browser.close();
 *
 * CLI use:
 *   node scripts/ui-verify.mjs --url <url> \
 *     [--screenshot shot.png] [--eval script.js] \
 *     [--click-selector '.foo'] [--click-text '长期记忆'] \
 *     [--wait-for '.lmv-page'] [--wait-text '记忆总览'] \
 *     [--settle 800] [--headless new|old] [--browser <path>] \
 *     [--user-data-dir <dir>]
 *
 * Operations run in the order the flags appear. Any failing step exits non-zero.
 * The browser process started by this script is always killed, including on error.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..');
export const DEFAULT_USER_DATA_DIR = path.join(WORKSPACE, '.scratch', 'chrome-profile');
export const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const DEFAULT_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function redactUrl(value) {
  return String(value ?? '').replace(
    /([?&](?:token|access_token|auth|apikey|api_key)=)[^&#]*/gi,
    '$1***',
  );
}

/** Ask the OS for an unused loopback TCP port. */
export async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('could not allocate a free TCP port');
  return port;
}

function describeRemoteObject(object) {
  if (object === null || object === undefined) return 'undefined';
  if (object.type === 'undefined') return 'undefined';
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.value !== undefined) {
    if (typeof object.value === 'string') return object.value;
    try {
      return JSON.stringify(object.value);
    } catch {
      return String(object.value);
    }
  }
  return object.description ?? object.type ?? 'unknown';
}

/** Minimal id-correlated CDP client over the global WebSocket. */
export class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.closed = false;
  }

  async connect(timeoutMs = 15_000) {
    const ws = new WebSocket(this.webSocketUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WebSocket open timed out after ${timeoutMs}ms: ${this.webSocketUrl}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(new Error(`WebSocket error before open: ${event?.message ?? 'unknown'}`));
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
    ws.addEventListener('message', (event) => {
      this._onMessage(event.data).catch((error) => {
        this._notify({
          kind: 'harness',
          level: 'error',
          text: `failed to process CDP message: ${error.message}`,
        });
      });
    });
    ws.addEventListener('close', (event) => this._onClose(event));
    ws.addEventListener('error', (event) => {
      this._notify({
        kind: 'harness',
        level: 'error',
        text: `WebSocket error: ${event?.message ?? 'unknown'}`,
      });
    });
  }

  _onClose(event) {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(`CDP WebSocket closed (code ${event?.code ?? '?'})`);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
    for (const [method, list] of this.waiters) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.waiters.delete(method);
    }
  }

  async _onMessage(raw) {
    let text = raw;
    if (typeof raw !== 'string') {
      if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString('utf8');
      else if (typeof raw?.text === 'function') text = await raw.text();
      else text = String(raw);
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) {
        entry.reject(
          new Error(
            `CDP ${entry.method} failed: ${message.error.message ?? 'unknown'} (code ${message.error.code ?? '?'})`,
          ),
        );
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === 'string') {
      const list = this.waiters.get(message.method);
      if (list !== undefined && list.length > 0) {
        this.waiters.delete(message.method);
        for (const waiter of list) {
          clearTimeout(waiter.timer);
          waiter.resolve(message.params ?? {});
        }
      }
      this._notify({ kind: 'event', method: message.method, params: message.params ?? {} });
    }
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed before ${method}`));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  waitForEvent(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const list = this.waiters.get(method);
          if (list !== undefined) {
            const index = list.indexOf(waiter);
            if (index >= 0) list.splice(index, 1);
            if (list.length === 0) this.waiters.delete(method);
          }
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP event ${method}`));
        }, timeoutMs),
      };
      const list = this.waiters.get(method) ?? [];
      list.push(waiter);
      this.waiters.set(method, list);
    });
  }

  _notify(event) {
    if (typeof this.onEvent === 'function') {
      try {
        this.onEvent(event);
      } catch {
        /* a listener must never break the protocol loop */
      }
    }
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Browser-side helpers. These functions are serialised with toString()
 * and evaluated inside the page, so they must be self-contained.
 * ------------------------------------------------------------------ */

async function pageFindTextTarget(rawText, within) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const target = norm(rawText);
  const targetLower = target.toLowerCase();
  const roots = within ? Array.from(document.querySelectorAll(within)) : [document.body];
  if (roots.length === 0) return { found: false, reason: `scope not found: ${within}` };

  const selector = 'button, a, [role], li, label, summary, span, div, p, strong, td, th';
  const all = [];
  for (const root of roots) all.push(...root.querySelectorAll(selector));

  const seen = new Set();
  const candidates = [];
  for (const el of all) {
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 0 || rect.top > innerHeight) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    if (el.disabled === true) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    ) {
      continue;
    }
    const clickableish =
      el.matches('button, a, [role], li, label, summary') ||
      el.hasAttribute('tabindex') ||
      style.cursor === 'pointer' ||
      el.closest('button, a, [role="button"], [role="tab"], [role="menuitem"]') !== null;
    if (!clickableish) continue;

    const own = norm(el.innerText ?? el.textContent);
    const aria = norm(el.getAttribute('aria-label'));
    const title = norm(el.getAttribute('title'));
    const texts = [own, aria, title].filter(Boolean);
    if (texts.length === 0) continue;
    const exact = texts.some((text) => text.toLowerCase() === targetLower);
    const contains = texts.some((text) => text.toLowerCase().includes(targetLower));
    if (!exact && !contains) continue;

    candidates.push({
      el,
      rect,
      exact,
      area: rect.width * rect.height,
      text: own || aria || title,
      tag: el.tagName.toLowerCase(),
      className: typeof el.className === 'string' ? el.className : '',
    });
  }

  if (candidates.length === 0) return { found: false, reason: 'no visible element matched' };

  candidates.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    return a.area - b.area;
  });
  const chosen = candidates[0];
  chosen.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const rect = chosen.el.getBoundingClientRect();
  return {
    found: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    tag: chosen.tag,
    className: chosen.className,
    text: chosen.text,
    exact: chosen.exact,
    candidates: candidates.length,
  };
}

async function pageFindSelector(selector) {
  const el = document.querySelector(selector);
  if (el === null) return { found: false, reason: `no element for selector: ${selector}` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity) !== 0 &&
    (typeof el.checkVisibility !== 'function' ||
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  if (!visible) return { found: false, reason: `element is not visible: ${selector}` };
  return {
    found: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    tag: el.tagName.toLowerCase(),
    className: typeof el.className === 'string' ? el.className : '',
    text: String(el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

function pageSelectorVisible(selector) {
  const el = document.querySelector(selector);
  if (el === null) return { found: false, visible: false };
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity) !== 0 &&
    (typeof el.checkVisibility !== 'function' ||
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  return {
    found: true,
    visible,
    tag: el.tagName.toLowerCase(),
    className: typeof el.className === 'string' ? el.className : '',
    text: String(el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

function pageTextIncludes(text) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const haystack = norm(document.body?.innerText ?? '');
  return { found: haystack.includes(norm(text)), length: haystack.length };
}

export class BrowserHarness {
  constructor({ browserPath, headless, port, userDataDir, child, client, logPath, logHandle }) {
    this.browserPath = browserPath;
    this.headless = headless;
    this.port = port;
    this.userDataDir = userDataDir;
    this.child = child;
    this.client = client;
    this._client = client;
    this.logPath = logPath;
    this.logHandle = logHandle;
    this.consoleMessages = [];
    this.exceptions = [];
    this.logEntries = [];
    this.onEvent = null;
    this._closed = false;
    if (this._client !== null && this._client !== undefined) {
      this._client.onEvent = (event) => this._handleEvent(event);
    }
  }

  static async launch(options = {}) {
    const browserPath = options.browserPath ?? DEFAULT_CHROME;
    if (!existsSync(browserPath)) throw new Error(`browser not found: ${browserPath}`);
    const headless = options.headless ?? 'new';
    const port = options.port ?? (await getFreePort());
    const userDataDir = path.resolve(options.userDataDir ?? DEFAULT_USER_DATA_DIR);
    await mkdir(userDataDir, { recursive: true });
    const scratchDir = path.join(WORKSPACE, '.scratch');
    await mkdir(scratchDir, { recursive: true });
    const logPath = path.join(scratchDir, `chrome-launch-${port}.log`);
    const logHandle = await open(logPath, 'a');
    await logHandle.write(`\n--- launch ${new Date().toISOString()} ${browserPath} ${headless} ---\n`);

    const headlessFlag = headless === 'old' ? '--headless=old' : `--headless=${headless}`;
    const args = [
      headlessFlag,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1600,1000',
      '--hide-scrollbars',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      'about:blank',
    ];

    const child = spawn(browserPath, args, {
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      windowsHide: true,
    });

    const harness = new BrowserHarness({
      browserPath,
      headless,
      port,
      userDataDir,
      child,
      client: null,
      logPath,
      logHandle,
    });

    try {
      const target = await harness._waitForTarget(options.startupTimeoutMs ?? 25_000);
      harness.client = new CdpClient(target.webSocketDebuggerUrl);
      harness._client = harness.client;
      harness.client.onEvent = (event) => harness._handleEvent(event);
      await harness.client.connect(options.connectTimeoutMs ?? 15_000);
      await harness._init();
      return harness;
    } catch (error) {
      await harness.close();
      throw new Error(`${error.message}\nChrome log (${logPath}):\n${readFileSync(logPath, 'utf8').slice(-4000)}`);
    }
  }

  async _waitForTarget(timeoutMs) {
    const url = `http://127.0.0.1:${this.port}/json/list`;
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(
          `browser exited with code ${String(this.child.exitCode)} before CDP became available`,
        );
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          const targets = await response.json();
          const pages = targets.filter(
            (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string',
          );
          const target = pages.find((item) => item.url === 'about:blank') ?? pages[0];
          if (target !== undefined) return target;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(200);
    }
    throw new Error(
      `CDP target did not appear on ${url} within ${timeoutMs}ms${lastError ? ` (last error: ${lastError.message})` : ''}`,
    );
  }

  async _init() {
    await this.client.send('Page.enable');
    await this.client.send('Runtime.enable');
    await this.client.send('Log.enable');
    try {
      await this.client.send('Emulation.setDeviceMetricsOverride', {
        width: 1600,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } catch {
      /* viewport override is best-effort; --window-size still applies */
    }
    await this.client.send('Page.bringToFront');
  }

  _handleEvent(event) {
    if (event.kind === 'event') {
      if (event.method === 'Runtime.consoleAPICalled') {
        const params = event.params;
        const text = (params.args ?? []).map(describeRemoteObject).join(' ');
        const frame = params.stackTrace?.callFrames?.[0];
        const message = {
          kind: 'console',
          type: params.type ?? 'log',
          text,
          url: frame?.url ?? '',
          line: frame?.lineNumber ?? null,
        };
        this.consoleMessages.push(message);
        this._emit(message);
        return;
      }
      if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params?.exceptionDetails ?? {};
        const message = {
          kind: 'exception',
          type: 'error',
          text: details.exception?.description ?? details.text ?? 'unknown exception',
          url: details.url ?? '',
          line: details.lineNumber ?? null,
          column: details.columnNumber ?? null,
          stack: details.stackTrace?.callFrames ?? [],
        };
        this.exceptions.push(message);
        this._emit(message);
        return;
      }
      if (event.method === 'Log.entryAdded') {
        const entry = event.params?.entry ?? {};
        const message = {
          kind: 'log',
          type: entry.level ?? 'info',
          text: entry.text ?? '',
          url: entry.url ?? '',
          line: entry.lineNumber ?? null,
        };
        this.logEntries.push(message);
        if (message.type === 'error' || message.type === 'warning') this._emit(message);
        return;
      }
    }
    if (event.kind === 'harness') this._emit(event);
  }

  _emit(message) {
    if (typeof this.onEvent === 'function') {
      try {
        this.onEvent(message);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  async goto(url, { settleMs = 500, timeoutMs = 30_000 } = {}) {
    if (typeof url !== 'string' || url.length === 0) throw new Error('goto requires a URL');
    const loaded = this.client.waitForEvent('Page.loadEventFired', timeoutMs);
    const result = await this.client.send('Page.navigate', { url }, timeoutMs);
    if (result.errorText) throw new Error(`navigation to ${redactUrl(url)} failed: ${result.errorText}`);
    await loaded;
    if (settleMs > 0) await delay(settleMs);
  }

  async evaluate(expression) {
    const result = await this.client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: true,
    });
    if (result.exceptionDetails !== undefined) {
      const details = result.exceptionDetails;
      const description =
        details.exception?.description ?? details.text ?? 'Runtime.evaluate threw an exception';
      throw new Error(`page evaluation failed: ${description}`);
    }
    const remote = result.result ?? {};
    if (remote.type === 'undefined') return undefined;
    if (remote.unserializableValue !== undefined) return remote.unserializableValue;
    return remote.value;
  }

  async evaluateFile(filePath) {
    const expression = await readFile(filePath, 'utf8');
    return this.evaluate(expression);
  }

  async screenshot(targetPath) {
    const result = await this.client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const absolute = path.resolve(targetPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const buffer = Buffer.from(result.data, 'base64');
    await writeFile(absolute, buffer);
    return { path: absolute, bytes: buffer.length };
  }

  async _clickAt(x, y, { settleMs = 100 } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click target has no finite coordinates');
    const point = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    await this.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await delay(40);
    await this.client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await delay(40);
    await this.client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    if (settleMs > 0) await delay(settleMs);
  }

  async clickSelector(selector, options = {}) {
    const info = await this.evaluate(`(${pageFindSelector.toString()})(${JSON.stringify(selector)})`);
    if (!info?.found) throw new Error(`click-selector ${selector} failed: ${info?.reason ?? 'not found'}`);
    await this._clickAt(info.x, info.y, options);
    return info;
  }

  async clickText(text, options = {}) {
    const info = await this.evaluate(
      `(${pageFindTextTarget.toString()})(${JSON.stringify(text)}, ${JSON.stringify(options.within ?? null)})`,
    );
    if (!info?.found) throw new Error(`click-text ${JSON.stringify(text)} failed: ${info?.reason ?? 'not found'}`);
    await this._clickAt(info.x, info.y, options);
    return info;
  }

  async waitForSelector(selector, timeoutMs = 15_000, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.evaluate(`(${pageSelectorVisible.toString()})(${JSON.stringify(selector)})`);
      if (last?.found && last.visible) return last;
      await delay(intervalMs);
    }
    throw new Error(
      `wait-for ${selector} timed out after ${timeoutMs}ms (${last?.found ? 'found but not visible' : 'not found'})`,
    );
  }

  async waitForText(text, timeoutMs = 15_000, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.evaluate(`(${pageTextIncludes.toString()})(${JSON.stringify(text)})`);
      if (last?.found) return last;
      await delay(intervalMs);
    }
    throw new Error(`wait-text ${JSON.stringify(text)} timed out after ${timeoutMs}ms`);
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    const child = this.child;
    if (child !== undefined && child !== null && child.exitCode === null) {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
      await Promise.race([once(child, 'exit').catch(() => undefined), delay(3000)]);
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    try {
      await this.logHandle?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const USAGE = `Usage: node scripts/ui-verify.mjs --url <url> [operations...]

Operations (run in flag order):
  --screenshot <path>       capture a PNG
  --eval <jsFile>           evaluate a JS file in the page, print JSON result
  --click-selector <css>    click the centre of the first match
  --click-text <text>       click the smallest visible element with this text
  --wait-for <selector>     wait up to 15s for a visible selector
  --wait-text <text>        wait up to 15s for visible page text

Options:
  --settle <ms>             extra delay after load (default 500)
  --headless new|old        headless mode (default new)
  --browser <path>          browser binary (default Chrome)
  --user-data-dir <dir>     profile dir (default .scratch/chrome-profile)
  --help                    this help
`;

export function parseCliArgs(argv) {
  const config = {
    url: null,
    settleMs: 500,
    headless: 'new',
    browserPath: DEFAULT_CHROME,
    userDataDir: DEFAULT_USER_DATA_DIR,
    ops: [],
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
      case '--settle':
        config.settleMs = Number(need(index, flag));
        index += 1;
        break;
      case '--headless':
        config.headless = need(index, flag);
        if (!['new', 'old'].includes(config.headless)) throw new Error('--headless must be new or old');
        index += 1;
        break;
      case '--browser':
        config.browserPath = need(index, flag);
        index += 1;
        break;
      case '--user-data-dir':
        config.userDataDir = need(index, flag);
        index += 1;
        break;
      case '--screenshot':
        config.ops.push({ op: 'screenshot', value: need(index, flag) });
        index += 1;
        break;
      case '--eval':
        config.ops.push({ op: 'eval', value: need(index, flag) });
        index += 1;
        break;
      case '--click-selector':
        config.ops.push({ op: 'click-selector', value: need(index, flag) });
        index += 1;
        break;
      case '--click-text':
        config.ops.push({ op: 'click-text', value: need(index, flag) });
        index += 1;
        break;
      case '--wait-for':
        config.ops.push({ op: 'wait-for', value: need(index, flag) });
        index += 1;
        break;
      case '--wait-text':
        config.ops.push({ op: 'wait-text', value: need(index, flag) });
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return config;
}

export async function runHarnessCli(argv = process.argv.slice(2)) {
  const config = parseCliArgs(argv);
  if (config.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (config.url === null) throw new Error(`--url is required\n\n${USAGE}`);

  let browser = null;
  let failed = false;
  try {
    browser = await BrowserHarness.launch({
      browserPath: config.browserPath,
      headless: config.headless,
      userDataDir: config.userDataDir,
    });
    browser.onEvent = (event) => {
      if (event.kind === 'console') {
        process.stderr.write(`[console:${event.type}] ${event.text}${event.url ? ` (${event.url}:${event.line})` : ''}\n`);
      } else if (event.kind === 'exception') {
        process.stderr.write(`[exception] ${event.text}\n`);
      } else if (event.kind === 'log') {
        process.stderr.write(`[log:${event.type}] ${event.text}${event.url ? ` (${event.url}:${event.line})` : ''}\n`);
      } else if (event.kind === 'harness' && event.level === 'error') {
        process.stderr.write(`[harness] ${event.text}\n`);
      }
    };

    process.stderr.write(`[harness] chrome=${config.browserPath} headless=${config.headless} port=${browser.port}\n`);
    process.stderr.write(`[harness] navigating to ${redactUrl(config.url)}\n`);
    await browser.goto(config.url, { settleMs: config.settleMs });

    for (const item of config.ops) {
      process.stderr.write(`[harness] ${item.op}: ${item.value}\n`);
      switch (item.op) {
        case 'screenshot': {
          const shot = await browser.screenshot(item.value);
          process.stdout.write(`screenshot ${shot.path} (${shot.bytes} bytes)\n`);
          break;
        }
        case 'eval': {
          const value = await browser.evaluateFile(item.value);
          const serialized = value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
          process.stdout.write(`${serialized}\n`);
          break;
        }
        case 'click-selector': {
          const info = await browser.clickSelector(item.value);
          process.stdout.write(`clicked ${JSON.stringify(info)}\n`);
          break;
        }
        case 'click-text': {
          const info = await browser.clickText(item.value);
          process.stdout.write(`clicked ${JSON.stringify(info)}\n`);
          break;
        }
        case 'wait-for': {
          const info = await browser.waitForSelector(item.value);
          process.stdout.write(`appeared ${JSON.stringify(info)}\n`);
          break;
        }
        case 'wait-text': {
          const info = await browser.waitForText(item.value);
          process.stdout.write(`appeared ${JSON.stringify(info)}\n`);
          break;
        }
        default:
          throw new Error(`unsupported operation: ${item.op}`);
      }
    }
  } catch (error) {
    failed = true;
    process.stderr.write(`[harness] FAILED: ${error.stack ?? error.message}\n`);
  } finally {
    await browser?.close();
  }

  if (browser !== null) {
    process.stderr.write(
      `[harness] console messages=${browser.consoleMessages.length} exceptions=${browser.exceptions.length} log entries=${browser.logEntries.length}\n`,
    );
  }
  return failed ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runHarnessCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}
