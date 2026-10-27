<p align="center">
  <img src="icon.svg" width="88" height="88" alt="DSH Memory Vault icon" />
</p>

<h1 align="center">DSH Memory Vault · 长期记忆</h1>

<p align="center"><strong>Long-term memory for DeepSeek Harness, stored as a plain Markdown vault you own.</strong></p>

<p align="center">
  A first-level sidebar page, four model tools, token-budgeted recall, and a durable
  history journal — no database, no telemetry, no cloud. Your memories stay as
  Obsidian-compatible <code>.md</code> files on disk.
</p>

<p align="center">
  <a href="https://github.com/bufan528/dsh-longterm-memory/stargazers"><img src="https://img.shields.io/github/stars/bufan528/dsh-longterm-memory?style=flat-square" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.3%20%3C0.2.2-7C3AED?style=flat-square" alt="DSH 0.2.1-rc.3" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/status-preview-E5B650?style=flat-square" alt="Preview" />
  <a href="https://dsh.works/awesome-dsh-plugins/"><img src="https://img.shields.io/badge/listed_on-dsh.works-00c2e9?style=flat-square&labelColor=0d0d0d" alt="listed on dsh.works" /></a>
  <a href="https://dshmarket.com/"><img src="https://img.shields.io/badge/in--app_market-dshmarket-4f6ef7?style=flat-square" alt="available in dshmarket (in-app Plugin Market)" /></a>
</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> ·
  <a href="https://awesome-dsh-plugin.com/p/bufan528/dsh-longterm-memory/"><strong>DSH Plugin Market</strong></a> ·
  <a href="https://dsh.works/awesome-dsh-plugins/"><strong>dsh.works</strong></a> ·
  <a href="#features">Features</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#data-safety">Data safety</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#development">Development</a> ·
  <a href="docs/README.zh-CN.md"><strong>简体中文</strong></a>
</p>

> **Project status (2026-10-27).** `dsh-longterm-memory@0.1.5` is the newest release
> ([GitHub Release](https://github.com/bufan528/dsh-longterm-memory/releases/latest)
> with a version-agnostic `dsh-longterm-memory.tgz` asset); `0.1.4` remains the newest
> version published on npm, and the plugin is **listed in two community registries**:
> the [DSH Plugin Market](https://awesome-dsh-plugin.com/p/bufan528/dsh-longterm-memory/)
> (added 2026-10-19) and the
> [dsh.works community registry](https://dsh.works/awesome-dsh-plugins/)
> (`dshworks/awesome-dsh-plugins`, **verified**, added 2026-10-19). The in-app
> **插件市场 / Plugin Market** is the [dshmarket](https://github.com/dsh-market/dsh-market)
> plugin and reads that same catalog, so the plugin is discoverable and one-click
> installable there as well (no separate submission). Install it from the in-app
> market, or from npm with `dsh plugin add dsh-longterm-memory@latest`. The desktop-app
> plugin entry is verified end-to-end in the running desktop app (61/61 real-browser
> checks over the five pre-existing tabs, real vault, restored afterwards; the 0.1.5 QQ
> tab was verified separately on an isolated 0.2.1-rc.3 host, see
> [docs/evidence/qq-verification.md](docs/evidence/qq-verification.md)). See [Install](#install),
> [What's new](#whats-new) and [Project status & limitations](#project-status--limitations).

---

## What's new

**0.1.5** adds a sixth tab, **QQ integration**
(`记忆总览 | 记忆检索 | 记忆管理 | 收件箱 | QQ 接入 | 设置`), plus an optional
QQ ↔ long-term-memory linkage policy (three modes, four enforcement points) and a
diagnostics card. It is documented in [docs/qq-integration.md](docs/qq-integration.md).
The existing 61-check real-browser E2E suite still covers the five pre-existing tabs;
the QQ tab was verified on an isolated 0.2.1-rc.3 host (see
[docs/evidence/qq-verification.md](docs/evidence/qq-verification.md)).

**0.1.4** is a documentation release: the plugin is now **listed in the DSH Plugin
Market** (added 2026-10-19) and in the **dsh.works community registry**
(`dshworks/awesome-dsh-plugins`, verified; it powers the **插件 → DSH 社区** market in
the [dsh-armory](https://github.com/2026heshao/dsh-armory) dashboard). Install or
update from the in-app **插件市场 / Plugin Market**, or from npm. No code changes; it
ships all of the 0.1.3 fixes below.

**0.1.3** made the Inbox actionable and fixed three other user-facing bugs:
- **Inbox is actionable.** **确认入库 / Confirm** and **拒绝 / Reject** now work for
  in-memory candidates. Confirming writes an active memory (`low` confidence is raised
  to `medium`), folds a duplicate/supplement into the existing memory instead of
  duplicating it, and keeps both sides of a contradiction. Rejecting writes no file.
- **Status changes on extracted memories work.** A multi-line `evidence:` block
  scalar no longer blocks saves with `unsafe-edit`.
- **The UI language setting works** (it previously lost to the host locale).
- **No more permanent "unsaved changes" hint** on the settings page.
- **New real-browser E2E suite** (`npm run verify:e2e`) covering all five tabs,
  including the Inbox, detail, settings, batch and merge flows.

Full details: [CHANGELOG.md](CHANGELOG.md) ·
[latest release](https://github.com/bufan528/dsh-longterm-memory/releases/latest)

![Inbox confirm/reject fixed](https://raw.githubusercontent.com/bufan528/dsh-longterm-memory/main/docs/evidence/05-e2e-inbox-confirmed.png)
![Merge dialog](https://raw.githubusercontent.com/bufan528/dsh-longterm-memory/main/docs/evidence/06-e2e-merge-dialog.png)

## Why DSH Memory Vault?

Most "agent memory" features are a vector store or a black-box service. DSH Memory
Vault makes the opposite trade-off:

- **Markdown is the only source of truth.** Each memory is a human-readable note with
  YAML frontmatter. Read, edit, link and back it up in Obsidian or any text editor.
  There is no proprietary format and no export step.
- **The index is disposable.** `.dsh-memory/index.json` is derived data; delete it and
  the plugin rebuilds it from Markdown. Losing the index never loses a memory.
- **Recall is budgeted and transparent.** Injection is computed per assembly from the
  current index with explicit token/item caps; the page shows exactly what the model
  would receive.
- **History is durable.** Every change is recorded in a journal with before/after
  digests, reasons and timestamps. A write-ahead outbox keeps history safe across
  crashes — including the verified window where the Markdown is committed but the
  journal append has not happened yet.
- **Local by default.** No network requests, no model calls, no telemetry; the only
  traffic is the local RPC between the management page and the DSH host.

## Features

| | |
|---|---|
| **First-level sidebar page** | Registers a `sidebar.panellist` entry and a full management page (**overview / search / manage / inbox / QQ integration / settings**) — not a chat tab. |
| **Four model tools** | `memory_search`, `memory_get`, `memory_save`, `memory_forget` (save refuses credential-like content). |
| **Automatic extraction** | Rule-based, fully local candidate extraction at the real `turn/end` boundary. Optional model-assisted extraction is **off by default**. |
| **Ranked recall** | BM25-style lexical ranking over Markdown, with type/status/tag filters and a token budget. |
| **Memory lifecycle** | `pending → active → stale / superseded / archived / conflict`, plus `low/medium/high` confidence. Low confidence and sensitive content wait in the Inbox for human confirmation. |
| **Safe updates** | Deterministic dedupe/merge rules: duplicates merge, additions update while keeping sources, contradictions keep both sides, low confidence goes to Inbox. |
| **Conflict handling** | Conflicting facts are kept side by side, never silently overwritten; a conflict-resolution page supports keep / merge / both. |
| **Crash-safe writes** | Single-file atomic replace, per-file lock, optimistic checksum concurrency, durable journal outbox with idempotent recovery. |
| **Obsidian compatible** | The vault carries `.obsidian/`, `[[wikilinks]]`, stable frontmatter and a human-readable `Index/`. |
| **Bilingual UI** | Chinese and English (`language: zh | en`). |
| **Optional QQ integration tab** | Status / detection / linkage policy / diagnostics for the official `@tencent-connect/dsh-qqbot` — read-only where it can be, never reimplements the QQ protocol, never touches credentials. |
| **No runtime dependency on `@deepseek-ai/*`** | The host half only uses the Cordis context passed in, so DSH internals can change without breaking the bundle. |

### Interface

Real acceptance screenshots (headless Chrome, real host data — no mocks):

| Sidebar entry | Management page |
|---|---|
| ![Sidebar entry](docs/evidence/02-sidebar.png) | ![Memory page](docs/evidence/03-page.png) |

More: [overview](docs/evidence/04-1-overview.png) · [search](docs/evidence/04-2-search.png) · [manage](docs/evidence/04-3-manage.png) · [inbox](docs/evidence/04-4-inbox.png) · [settings](docs/evidence/04-5-settings.png) · [dark theme](docs/evidence/theme-dark.png)

## How it works

```mermaid
flowchart LR
  A[DSH host] -->|tools / prompt section| P[Memory Vault host plugin]
  U[Sidebar page] -->|local HTTP RPC| P
  P --> V[(Markdown vault<br/>source of truth)]
  P --> I[(index.json<br/>derived)]
  P --> J[(journal outbox<br/>history)]
  P --> Q[(quarantine<br/>unreadable notes)]
  V -. rebuild .-> I
  J -. recover .-> V
```

- The **host** owns the vault, index, journal and extraction; it never calls a model
  unless you explicitly enable model-assisted extraction with your own provider.
- The **management page** reads and writes through a loopback-only RPC surface
  (`POST /dsh-longterm-memory/api/<method>`, 29 methods) guarded by a browser-trust
  fence (loopback / trusted hosts, `Origin`, `sec-fetch-site`).
- **Recall**: `memory_search` and automatic injection share one engine; explicit
  recall may include retired memories (labelled history), injection only uses current
  facts. `POST /api/previewStanding` and `POST /api/previewRecall` return the exact
  text that would be injected.

## Install

### Option A — from the in-app market (dshmarket, recommended for desktop)

In the official desktop app, open **插件市场 / Plugin Market**, search for
**长期记忆** or **DSH Memory Vault**, then install or update from the plugin card and
restart the app when prompted. That in-app market is the
[dshmarket](https://github.com/dsh-market/dsh-market) plugin
([dshmarket.com](https://dshmarket.com/)); it reads the same
[awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/bufan528/dsh-longterm-memory/)
catalog (added 2026-10-19), so **no separate dshmarket submission or association is
needed** — the live registry already shows `0.1.4` with the five screenshots. After the
first listing, each `npm publish` makes the new version available for one-click updates.

Market page: <https://awesome-dsh-plugin.com/p/bufan528/dsh-longterm-memory/>

> **Also discoverable via dsh-armory.** The [dsh-armory](https://github.com/2026heshao/dsh-armory)
> dashboard's **插件 → DSH 社区** market reads the
> [dshworks/awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins) registry
> (browse at [dsh.works](https://dsh.works/awesome-dsh-plugins/)), where this plugin is
> listed as **verified** with npm `dsh-longterm-memory`. There is no separate submission
> to dsh-armory: keeping the npm `latest` tag current keeps both listings current.

### Option B — install the latest from npm

```bash
dsh plugin --profile web add dsh-longterm-memory@latest
```

> Latest **npm** release: `dsh-longterm-memory@0.1.4`. Use `@latest` (or omit the
> version) so an installation always fetches the newest **published** version. The
> newest **GitHub** release is `v0.1.5`; until 0.1.5 is published to npm, install it
> from the tarball below (Option C).

### Option C — download the latest packaged tarball (no build required)

Every GitHub Release ships a **versionless alias** (`dsh-longterm-memory.tgz`) next to
the versioned copy and their SHA-256 checksums, so "latest" needs no version number:

```powershell
# Stable URL — always the newest release
Invoke-WebRequest -Uri https://github.com/bufan528/dsh-longterm-memory/releases/latest/download/dsh-longterm-memory.tgz -OutFile .\dsh-longterm-memory.tgz

# optional: verify the checksum against the published .sha256 asset
Invoke-WebRequest -Uri https://github.com/bufan528/dsh-longterm-memory/releases/latest/download/dsh-longterm-memory.tgz.sha256 -OutFile .\dsh-longterm-memory.tgz.sha256
(Get-FileHash .\dsh-longterm-memory.tgz -Algorithm SHA256).Hash.ToLower() -eq ((Get-Content .\dsh-longterm-memory.tgz.sha256) -split '\s+')[0]

dsh plugin --profile web add .\dsh-longterm-memory.tgz
```

With the `gh` CLI, the same alias can be fetched version-agnostically:

```powershell
gh release download --repo bufan528/dsh-longterm-memory --pattern "dsh-longterm-memory.tgz" --dir .
dsh plugin --profile web add .\dsh-longterm-memory.tgz
```

No `gh`? Open
<https://github.com/bufan528/dsh-longterm-memory/releases/latest> and download the
asset manually.

### Option D — build this repository and install the tarball (verified)

Requires Node.js ≥ 20 and a DSH CLI. **Use an isolated `DSH_HOME`** so the test
profile cannot touch your daily DSH profile:

```bash
# 1. Build and pack
npm install
npm run build
npm pack                     # -> dsh-longterm-memory-0.1.5.tgz

# 2. Install into an isolated profile
$env:DSH_HOME = "<temporary dir>"                # PowerShell
# export DSH_HOME="<temporary dir>"              # bash
dsh plugin --profile lmv add .\dsh-longterm-memory-0.1.5.tgz

# 3. Start
dsh --profile lmv --no-open --port 0
```

Open the Web UI, click **长期记忆 / Long-term Memory** in the sidebar, and choose a
vault directory (or let the plugin initialize one). You can also pre-set it:

```yaml
# <DSH_HOME>/profiles/lmv/cordis.patch.yml
- id: longterm-memory
  name: dsh-longterm-memory
  config:
    vaultPath: 'D:/path/to/DSH Memory'
    language: zh
```

> **Data-location warning.** If `vaultPath` is unset, the plugin initializes the
> default location (`~/Documents/DSH Memory` on Windows). `DSH_HOME` isolates the
> profile, **not** the vault. Always set `vaultPath` when testing.

## Quick start

1. Install as above and open the page.
2. Click **初始化 / Initialize** and pick a folder (an existing Obsidian vault works).
3. Create a memory with **新建 / New**, or let automatic extraction collect candidates
   at the end of a turn; low-confidence items appear in **收件箱 / Inbox**.
4. Ask the model something related; the plugin injects the standing section and the
   tools return ranked hits from the vault.
5. Open **设置 / Settings** to tune budgets, per-step recall, extraction and language.

## Vault layout

```
DSH Memory/
├── README.md                  # generated; user edits are preserved
├── Memory Home.md             # entry page
├── .obsidian/                 # makes Obsidian treat it as a vault
├── Profile/  Preferences/     # profile, long-term preferences
├── Projects/  Projects/State/ # projects and project state
├── Decisions/  Knowledge/     # decisions, knowledge
├── Experiences/  Tasks/       # lessons, tasks
├── Inbox/                     # candidates awaiting confirmation
├── Archive/  Conflicts/       # retired / contradictory memories
├── Index/                     # human-readable index (regenerated)
├── History/                   # change-history notes
└── .dsh-memory/               # config.json, index.json, journal/, quarantine/
```

Memory types: `profile`, `preference`, `project`, `project-state`, `decision`,
`knowledge`, `experience`, `task`. Status: `active`, `pending`, `stale`,
`superseded`, `conflict`, `archived`. Format details:
[docs/storage-format.md](docs/storage-format.md).

## Configuration

All settings are optional; defaults live in `src/host/config.ts` and can be overridden
from your profile's `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `vaultPath` | auto-discover / initialize | Absolute memory vault path |
| `language` | `zh` | UI language (`zh` / `en`) |
| `enableTools` | `true` | Expose the four model tools |
| `enablePromptSection` | `true` | Inject the standing memory section |
| `standingBudgetTokens` | `700` | Token cap for the standing section |
| `standingMaxItems` | `12` | Item cap for the standing section |
| `recallBudgetTokens` | `600` | Token cap for one recall answer |
| `recallMaxItems` | `8` | Item cap for one recall answer |
| `enablePerStepRecall` | `false` | Splice retrieved memory into each step (replayed for the rest of the session) |
| `enableAutoExtraction` | `true` | Rule-based extraction at turn end (local) |
| `enableLlmExtraction` | `false` | Optional model-assisted extraction (sends turn text to **your** provider) |
| `redactSecrets` | `true` | Refuse credential-like candidates |
| `sensitiveNeedsConfirmation` | `true` | Health/finance/identity content waits for confirmation |
| `maxCandidatesPerTurn` | `5` | Extraction cap per turn |

## QQ integration (optional, since 0.1.5)

The sixth tab is **QQ 接入 / QQ access**; the tab order is
`记忆总览 | 记忆检索 | 记忆管理 | 收件箱 | QQ 接入 | 设置`
(overview · search · manage · inbox · QQ access · settings). It is a **status,
navigation, policy and diagnostics** page: it never reimplements the QQ protocol and
never copies the official connector's code.

### What the page does

- **Detects the official plugin** with a same-origin `GET /qqbot/im-qqbot/bind` probe
  (4 s timeout): `200` = loaded (the JSON `phase` is `bound`, `waiting`, `starting`,
  `saving` or `failed`), `404` = not installed / not loaded, anything else =
  **cannot confirm**. It does **not** use `ctx.get('im-qqbot')`: the official plugin
  registers no cordis service, so that lookup is `undefined` even when it is loaded.
- **Does not open the official binding panel for you**: the host has a generic
  main-page navigation API, but the official binding UI lives in a settings section /
  right-sidebar tab with no reliable public open path, so the page gives instructions
  for the in-app **设置 → QQ 机器人** section or the right-sidebar **QQ 机器人绑定**
  tab instead.
- **Never generates a QR code and never displays the AppSecret** (the only identity
  value it shows is the non-secret `appId` the official plugin's own status route
  returns).

### QQ ↔ memory linkage

Optional policy enforced at four points; **off by default**:

| Mode | Effect |
|---|---|
| `off` (default) | Identical to running without QQ integration |
| `deny-qq` | Sessions matching your QQ markers do not read long-term memory |
| `allowlist` | Only sessions matching your trusted markers read memory |

The four enforcement points are the standing prompt section, per-step recall,
turn-end write-back (QQ candidates go to the Inbox unless `writeMode: direct`) and the
four memory tools (`allowTools`, default `false`). QQ sessions can only be identified
by markers **you** declare — `origin`, `agentPreset` or `cwd` (for example the
`preset`/`cwd` set in the official plugin's config). **Private and group chats cannot
be told apart**: the official plugin knows the scope internally but does not write it
into the DSH session header, so this plugin does not fake per-group isolation.
Details: [docs/qq-integration.md](docs/qq-integration.md) §5.

### Credentials and vault/profile modes

- The official plugin **writes `appId`/`appSecret` as plaintext YAML into
  `<profile>/cordis.patch.yml`** (no keychain, no encryption). This plugin never reads
  that file, never stores a credential, and never displays `appSecret` (the only
  identity value it shows is the non-secret `appId` from the official status route).
- **Same profile:** QQ sessions and desktop sessions share one Vault — and therefore
  one memory. That is exactly why `deny-qq` / `allowlist` exist.
- **Separate profile:** install this plugin in the QQ profile too and point both
  `vaultPath` values at the same Vault; concurrent writes rely on the existing
  journal / atomic-write / lock machinery. **This plugin never edits any profile.**
- **Mismatched config:** different vault paths mean two independent vaults — not
  shared. Details: [docs/qq-integration.md](docs/qq-integration.md) §7.

### Compatibility caveat

The official `@tencent-connect/dsh-qqbot` lists **only DSH `0.1.0-rc.8` and
`0.2.0-rc.2`** as validated; it does **not** validate DSH `0.2.1-rc.3`. The host still
admits it because the package has no `engines.dsh` and its `@deepseek-ai/dsh-*` peer
floor is evaluated with `includePrerelease: true` — *installable is not validated*.
There are open community reports on the 0.2.1 line (issues #60 / #58). See
[docs/compatibility.md](docs/compatibility.md) §13.

### Installing the official plugin (optional)

```bash
npx @deepseek-ai/dsh plugin --profile <profile> add @tencent-connect/dsh-qqbot
```

Then bind it from the in-app **设置 → QQ 机器人** panel or the right-sidebar
**QQ 机器人绑定** tab (0.5.1+ ships the in-app UI; older versions only print a
terminal QR code). The official plugin is a separate project; this plugin only reads
its binding status.

## Data safety

- **Atomic single-file writes** (temp file + rename) and a **per-file lock** with
  stale-lock detection; the lock is released on failure, never leaked.
- **Optimistic concurrency**: edits carry the expected checksum; a stale edit is
  rejected with a reload hint instead of overwriting someone else's change.
- **Index is rebuildable**: `rebuildIndex` / `syncIndex` recover from a deleted or
  corrupt index. Corruption diagnostics are surfaced, not hidden.
- **Durable journal**: every change gets a before/after digest, reason and timestamp.
  A write-ahead outbox recovers when the monthly archive fails, with idempotent
  re-archiving and content-conflict detection (same event id + different payload is an
  explicit integrity error, never a silent merge).
- **Crash-window tests**: commit boundaries are exercised with real child-process
  SIGKILLs, not simulated exceptions — including "Markdown written, commit marker not
  yet persisted" and "recovery itself interrupted".
- **Quarantine**: notes that cannot be parsed safely are isolated, never deleted.

## Privacy

- **No telemetry and no outbound network calls by default.** Host-side acceptance runs
  showed zero network calls; the only client request targets are the local DSH RPC and,
  when the QQ tab is opened, the same-origin read-only `GET /qqbot/im-qqbot/bind` probe
  — both loopback. The 0.1.3 desktop E2E run exercised the real page and asserted zero
  page errors / uncaught exceptions; it is not a packet-level network audit.
- **Model use is opt-in**: automatic extraction is rule-based and local; model-assisted
  extraction (`enableLlmExtraction`) is off and, when enabled, uses the provider you
  configured in DSH.
- **Secrets are refused**: credential-like content (passwords, API keys, tokens,
  private keys) is blocked before it reaches the vault; sensitive categories require
  explicit confirmation.
- **Injection is data, not instructions**: memories are wrapped and labelled as
  untrusted data for the model. See [docs/privacy.md](docs/privacy.md).

## Compatibility

| | |
|---|---|
| DSH runtime | `>=0.2.1-rc.3 <0.2.2` (`engines.dsh`; `0.2.0-rc.2` is **not** supported) |
| Verified DSH version | `0.2.1-rc.3` — current desktop host; the plugin is loaded and serving RPC on it (see [docs/compatibility.md](docs/compatibility.md) §12) |
| Node.js | `>=20` |
| Platform | Windows (primary), Node path rules elsewhere |
| npm package | `dsh-longterm-memory` — **0.1.4 published** on npm; **0.1.5** is the newest GitHub Release |
| Downloads | [Latest GitHub Release](https://github.com/bufan528/dsh-longterm-memory/releases/latest) — stable alias `dsh-longterm-memory.tgz` (+ `.sha256`), or npm `@latest` (0.1.4) |
| DSH Plugin Market | **Listed** in [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/bufan528/dsh-longterm-memory/) since 2026-10-19; updates follow the npm `latest` tag |
| dshmarket (in-app market) | **Listed** through the same [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/bufan528/dsh-longterm-memory/) catalog; the live registry checks showed `0.1.4` with 5 screenshots on 2026-10-21 (no separate dshmarket submission) |
| dsh.works registry | **Listed + verified** in [dshworks/awesome-dsh-plugins](https://dsh.works/awesome-dsh-plugins/) since 2026-10-19; surfaced by the **插件 → DSH 社区** market in the [dsh-armory](https://github.com/2026heshao/dsh-armory) dashboard |

The `dsh.compatibility` field is informational; `engines.dsh` is the only decision
source. Details and evidence: [docs/compatibility.md](docs/compatibility.md).

## Development

```bash
npm install
npm run build        # tsc -> lib/host, esbuild -> lib/client.js
npm run typecheck    # tsc --noEmit
npm run lint         # contract checks + version-consistency check
npm test             # full suite (currently 41 files / 595 cases)
npm run check        # build -> typecheck -> lint -> test (clean checkout safe)
npm run pack:plugin  # build + npm pack
npm run verify:e2e -- --url "http://127.0.0.1:<port>/?token=..."   # real-browser E2E (61 checks)
```

`verify:e2e` drives a real Chrome over CDP, clicks the real management page and checks
every effect through the plugin RPC and the Markdown files on disk. For a token-guarded
desktop listener, mint the desktop launch cookie for the current machine and pass it
with `--cookie-file <name=value file>`.

Tests cover unit, integration, packaging, real HTTP-route validation, and deterministic
fault injection (including real subprocess kills). The browser acceptance scripts are
zero-dependency CDP clients using Node's built-in `WebSocket`.

## Project status & limitations

- **Preview**: API and storage format may still change; `0.1.0` was the first public
  version, and `0.1.5` (QQ integration) is the current release in this repository.
- **npm published**: `dsh-longterm-memory@0.1.4` (2026-10-20); registry installation
  verified. `0.1.5` is published here as a GitHub Release asset
  (`dsh-longterm-memory-0.1.5.tgz`); the npm `latest` dist-tag is bumped when npm
  publishing is run for this version.
- **Listed in the DSH Plugin Market**: the plugin is in the
  [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/bufan528/dsh-longterm-memory/)
  catalog (added 2026-10-19). Install it from the in-app **插件市场 / Plugin Market**;
  future releases are picked up automatically from the npm `latest` tag, so no new
  marketplace submission is needed per version. The China-region catalog mirror may lag
  the origin by up to about a day.
- **Available in dshmarket (in-app Plugin Market)**: the
  [dshmarket](https://github.com/dsh-market/dsh-market) plugin reads the same
  awesome-dsh-plugin catalog live on every open, so this plugin is already reachable in
  **插件市场 / Plugin Market** — no separate dshmarket submission, claim, or association
  step exists. The live registry on 2026-10-21 showed version `0.1.4` with 5 screenshots;
  updates follow the npm `latest` tag.
- **Also listed in dsh.works**: the entry in
  [dshworks/awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins) is
  `status: verified` with `npm: dsh-longterm-memory` (added 2026-10-19), so the
  **插件 → DSH 社区** market in the
  [dsh-armory](https://github.com/2026heshao/dsh-armory) dashboard lists and installs it
  without any separate dsh-armory submission. Both registries follow the npm `latest`
  tag; dsh-armory revalidates its catalog cache every few minutes (new installs fetch
  fresh).
- **Desktop verified**: the full real-browser E2E suite passes against the running
  desktop app (61/61 checks, the five pre-existing tabs, real vault restored afterwards).
- **QQ integration (0.1.5)**: the QQ tab, the linkage policy and the diagnostics are
  documented in [docs/qq-integration.md](docs/qq-integration.md) and were verified on an
  isolated DSH `0.2.1-rc.3` host with a real browser (see
  [docs/evidence/qq-verification.md](docs/evidence/qq-verification.md)). They are **not**
  part of the 61-check E2E suite yet. The official QQ plugin is not installed on this
  machine, so only its `404` probe branch was observed; the `200` branch and the official
  connector's actual behaviour on DSH `0.2.1-rc.3` are unverified.
- **Known follow-ups**: in-memory Inbox candidates are drafts — they are not counted in
  `待确认数量` / the `Inbox/` folder until confirmed; they leave the Inbox when
  confirmed or rejected. A few concurrency and move-atomicity edge cases remain open;
  frontmatter and lock regressions found in review were fixed in `0.1.0` and are locked
  by tests.
- **Vault location**: with `vaultPath` unset the plugin initializes
  `~/Documents/DSH Memory`. Set it explicitly to keep test data isolated.

## Documentation

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Architecture, DSH API usage, prompt assembly |
| [docs/storage-format.md](docs/storage-format.md) | Markdown / frontmatter / index / journal formats |
| [docs/privacy.md](docs/privacy.md) | Privacy and threat model |
| [docs/compatibility.md](docs/compatibility.md) | Compatibility contract and evidence |
| [docs/qq-integration.md](docs/qq-integration.md) | QQ integration tab, official-plugin detection, memory linkage, vault/profile modes |
| [docs/verification.md](docs/verification.md) | Verification log and acceptance evidence |
| [CHANGELOG.md](CHANGELOG.md) | Release notes for every published version |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Recovery and FAQ |
| [docs/evidence/](docs/evidence/) | Screenshots and raw acceptance data |

## License

[MIT](LICENSE)
