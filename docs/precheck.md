# Phase 0 — Read-only precheck report

Date of reconnaissance: this session. All facts below were read from the **installed** DSH
application and the live profile on this machine. Where the task book pointed at GitHub
sources, the installed artefacts were used instead, because the installed build is the
authority for what actually loads (`cordis-plugin-development` skill: *"the installed
Harness is the authority"*, `references/practices.md:3`).

## 1. Environment and baseline

| Fact | Value | How verified |
|---|---|---|
| Working directory | `<repo>` | `pwd` |
| Git root | **none** — not a Git repository | `git rev-parse --show-toplevel` → `fatal: not a git repository` |
| Existing project in workspace | **no** — directory was empty | `Get-ChildItem -Force` |
| Node.js | `v24.13.0` (system), `24.18.1` bundled | `node --version`; `<DSH install>\resources\runtime\versions.json` |
| pnpm | `10.30.3` (system), `11.7.0` bundled | `pnpm --version`; `versions.json` |
| npm | `11.6.2`, registry `https://registry.npmmirror.com` | `npm --version`, `npm config get registry` |
| DSH application | `<DSH install>` (Electron, `DeepSeek Harness.exe`) | `<DSH install>\resources\app.asar` |
| DSH runtime version | **`0.2.0-rc.2`** | `@deepseek-ai/*/package.json` `version` fields |
| DSH home | `%USERPROFILE%\.dsh` (`$env:DSH_HOME`) | environment |
| DSH profile | `desktop` (`$env:DSH_PROFILE`), `%USERPROFILE%\.dsh\profiles\desktop` | environment |
| Session id | `session-<redacted>-8437-4c5e-8a96-bd65a398f372` | environment |
| Web GUI | `http://127.0.0.1:<port>` (`$env:DSH_WEB_URL`) | environment |
| DSH CLI | `<DSH install>\resources\runtime\cli\bin\dsh.cmd` | file + `--help` output |
| Reference plugin A | `dsh-context@0.72.0` — installed in the live profile | `node_modules\dsh-context\package.json` |
| Reference plugin B | `dsh-better-sidebar@0.26.1` — installed in the live profile | `node_modules\dsh-better-sidebar\package.json` |
| Other installed plugin | `dshmarket@^1.66.32` | profile `package.json` |

The DSH application code inside `app.asar` was extracted **read-only** to
`.recon/dsh-app/` (12 967 files) so its source could be read with ordinary file tools.
No file outside this workspace was modified.

### Authoritative in-application documentation found

`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/` — the **official DSH
plugin-authoring skill**, shipped with the application:

- `SKILL.md` — the install/verify workflow
- `references/host-plugin.md` — bundle manifest, Host plugin export forms, Config
- `references/ui-plugin.md` — Client manifest, module loader, slot registration
- `references/practices.md` — extension-point selection, stability, performance, UI rules
- `references/verification.md` — verification limits
- `templates/decoration/{package.json,cordis.patch.yml,index.js,client.js}` — official starting point

This is the highest-quality evidence available and it supersedes README-level inference.

## 2. Official package inventory

`app.asar` ships **236** `@deepseek-ai/*` packages, including every one the task book
asked about:

`dsh-client-ui-slots`, `dsh-client-modules`, `dsh-client-connection`, `dsh-client-locale`,
`dsh-client-ui-layout`, `dsh-client-ui-sidebar`, `dsh-client-ui-sidebar-right`,
`dsh-client-ui-primitives`, `dsh-client-ui-renderer`, `dsh-client-ui-plugin-manager`,
`dsh-fs`, `dsh-fs-local`, `dsh-fs-sandbox`, `dsh-fs-observation-policy`,
`dsh-storage`, `dsh-storage-json`, `dsh-storage-domain`, `dsh-settings`,
`dsh-system-prompt`, `dsh-agent`, `dsh-agent-loop`, `dsh-agent-instructions`,
`dsh-tools`, `dsh-tool-*`, `dsh-session*`, `dsh-home-paths`, `dsh-atomic-write`,
`dsh-plugin-manager`, `dsh-host-open-in-app`, `dsh-host-directory-picker-auto`,
`dsh-host-webserver`, `dsh-web-app`, `dsh-web-frontend`, `dsh-typert-*`.

## 3. Key interfaces — evidence table

See `docs/compatibility.md` for the frozen contract. Summary of what was proven:

| Capability | Real interface | Evidence |
|---|---|---|
| Plugin bundle declaration | `package.json` → `dsh.bundle.patch` | `SKILL.md:5`, `dsh-context/package.json` |
| Client half declaration | `package.json` → `dsh.client` `{platform, immediately, inject/external}` | `templates/decoration/package.json:7-14`, `dsh-client-modules/README.md:34` |
| Host plugin export | `export function apply(ctx, config)`, optional `export const inject = [...]` | `references/host-plugin.md:49-53` |
| Client plugin export | bundle returns `{ inject, apply }` via `window.__ModuleLoader__.load({id, factory})` | `templates/decoration/client.js`, all 87 shipped `lib/client.js` |
| **Left sidebar first-level entry** | `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id, order, label, locale }, Icon))` | `dsh-client-ui-sidebar/lib/client.js:503-506,454-461`; real usages in `dsh-client-ui-plugin-manager/lib/client.js:3769-3775` and `dsh-client-ui-schedule/lib/client.js:6804-6810` |
| **Main management page** | `ctx.slots.register({ name:'main', key:<same id>, locale, children:{...} }, Page)` | `dsh-client-ui-layout/lib/client.js:609-612,116-119`; usage `dsh-client-ui-plugin-manager/lib/client.js:3712-3754` |
| Panel ordering | `order` ascending; Plugins `0`, Automation tasks `10`, workspaces is a separate seat below the list | `plugin-manager:3772`, `schedule:6807`, `dsh-client-ui-sidebar/lib/client.js:461` |
| Prompt section | `ctx.systemPrompt.section({ name, order, text })`, `text` may be a function evaluated per assembly | `dsh-system-prompt/lib/index.js:240-243,342` |
| Prompt order table | `HARNESS_IDENTITY:-1000 … TOOLS_SDK:5000 … HARNESS_SOURCE:10000 … DEPLOYMENT_PERSONA_SUFFIX:10200` | `dsh-system-prompt/lib/index.js:10-43` |
| Durable non-session storage | `ctx.storageDomain` behind `dsh-storage` + `dsh-storage-json` + `dsh-storage-domain` | `dsh-storage/README.md`; all three rows present in composed web profile |
| Host HTTP route (client↔host RPC) | `ctx.webServer.register({ kind:'prefix'\|'exact', path, handler(req,res) })`, disposed by effect | `dsh-better-sidebar/lib/index.js:3413,8081,8121` |
| Trusted-host fence | `ctx.webRuntime.trustedHosts` + loopback/origin check | `dsh-better-sidebar/lib/index.js:3230-3301,8012` |
| Full Node FS in a host plugin | `import { readFile } from 'node:fs/promises'` etc. | `dsh-better-sidebar/lib/index.js:1-13` |
| Atomic replace + cross-process lock | `writeFileAtomic`, `withFileLock` | `dsh-atomic-write` source inlined at `runtime/cli/command-manager.js:14-80` |
| Official install | `dsh plugin --profile <name> add <package-or-path>` — installs **and** registers the bundle | `dsh --help`; executed successfully (see §5) |
| Composed-tree inspection | `dsh --profile <name> --dump-config` | `dsh --help`; executed successfully |
| Isolated profile creation | `dsh --profile <new> --from-default-profile <template>` | `dsh --help`; executed successfully |

## 4. Client bundle format (frozen)

Every shipped client bundle is a single script that registers a lazy factory:

```js
window.__ModuleLoader__.load({
  id: '@scope/package-name',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require('react')
    // ... module body ...
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
```

Evidence: `dsh-client-ui-sidebar/lib/client.js:1-11,530-532`; `templates/decoration/client.js`.

- `require()` resolves **only** the frozen platform seed table plus declared externals.
  Platform baseline: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`
  (`dsh-web-frontend/dist/assets/index-5SrrfWpU.js:126`, `dsh-client-modules/README.md:46`).
- The host serves bundles under `/plugins`; **`lib/client.js` must be built before launch**
  or activation fails loudly (`dsh-client-modules/README.md:50`).
- `references/practices.md:35` forbids `require('@deepseek-ai/dsh-client-ui-primitives')`
  from a plugin; the plugin must write its own controls and use `--dsw-alias-*` theme tokens.

## 5. Actions actually executed during Phase 0

All writes were confined to `<repo>\.recon\`.

1. Extracted `app.asar` → `.recon/dsh-app/` (read of the installed app; no mutation).
2. `dsh --profile desktop --dump-config` → **refused**:
   `error: profile "desktop" is managed exclusively by the Electron application`.
   The real profile cannot be inspected or modified by the CLI — a hard boundary.
3. `DSH_HOME=<workspace>\.recon\isolated-home dsh --profile mvp --from-default-profile web --dump-config`
   → created and dumped an isolated profile (1262 lines of composed tree). **Exit 0.**
4. Installed a throw-away smoke bundle into the isolated profile:
   `dsh plugin --profile mvp add file:<repo>/.recon/smoke` → **exit 0**;
   pnpm reported `+ dsh-smoke-bundle` and the CLI automatically appended
   `dsh-smoke-bundle` to `dsh.profile.bundles` in the profile `package.json`.
5. `dsh --profile mvp --dump-config` again → the composed tree contains
   `# == dsh-smoke-bundle` / `- id: smoke-bundle` / `name: dsh-smoke-bundle`.
   **The complete official install-and-load path is thus verified end to end in isolation.**

The real profile `%USERPROFILE%\.dsh\profiles\desktop` was **not** modified.
No Git command other than read-only queries was issued. No npm publish occurred.

## 6. Blocking boundary discovered, and how it is handled

`DSH_PROFILE=desktop` is *managed exclusively by the Electron application*. Every route
into the running GUI's own profile is therefore closed to this session:

- `dsh --profile desktop …` refuses.
- The `plugin_manager` tool that `SKILL.md:8` prescribes for installation is **not in this
  session's tool set**.
- Approval prompts are disabled in this session, so anything needing approval is auto-rejected.

Consequence, stated plainly: I can build the plugin and prove that it installs and composes
into a profile, and I can prove host/client behaviour with unit and integration tests, but I
**cannot** make the "长期记忆" entry appear in the sidebar of the already-running GUI at
`http://127.0.0.1:<port>` in this session, and I must not claim that I did. What is proven is
recorded in `docs/compatibility.md` and the final report; the isolated-profile install is the
strongest available substitute.

## 7. Name collision — recorded, not worked around silently

`npm view dsh-memory-vault` returns a **published, unrelated package**:

| Field | Value |
|---|---|
| name | `dsh-memory-vault` |
| latest | `0.1.5` (6 versions, 2026-08-14) |
| maintainer | `flymysql` |
| description | "Cross-session memory vault for DeepSeek Harness: remember / recall / forget tools, per-turn prompt injection, and a browser management page." |
| peer deps | `@deepseek-ai/dsh-*` `^0.1.0-rc.6` — an **older DSH generation** than the installed `0.2.0-rc.2` |
| client inject | `["@deepseek-ai/dsh-client-runtime"]` — that package **does not exist** in `0.2.0-rc.2` |

That package is both a same-concept competitor and built against an API generation this
installation no longer ships. Taking its name for an unpublished local build would make the
"installable via the official Add-plugin flow" claim false, so the product name is kept
(**DSH Memory Vault**, display name **长期记忆**) and a **verified-free** npm name is used
instead:

| Candidate | `npm view` result |
|---|---|
| `dsh-memory-vault` | taken (0.1.5) |
| `dsh-memory` | taken (0.1.0) |
| **`dsh-longterm-memory`** | **free — E404** |
| `dsh-memory-vault-plugin` | free |
| `dsh-obsidian-memory` | free |
| `dsh-vault-memory` | free |

`dsh-longterm-memory` is the selected package name. Nothing is published under it.
