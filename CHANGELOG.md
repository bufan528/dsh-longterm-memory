# Changelog

All notable changes to **DSH Memory Vault (`dsh-longterm-memory`)** are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.4] - 2026-10-20

### Changed

- **DSH Plugin Market listing.** The plugin is listed in the
  [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/bufan528/dsh-longterm-memory/)
  catalog (added 2026-10-19). The README now documents installation from the in-app
  **插件市场 / Plugin Market**; later releases need no new marketplace submission and
  are picked up automatically from the npm `latest` tag.
- **Repository privacy cleanup.** Personal Windows user paths, real Obsidian/DSH vault
  paths, live DSH session ids, local ports and local install paths were replaced with
  generic placeholders; the two 0.1.3 E2E screenshots were regenerated in an isolated
  profile (neutral vault path; no conversation titles or account name); the git history
  was rewritten to remove the same data and to use a GitHub noreply commit identity.
- No runtime code changes.

## [0.1.3] - 2026-10-19

### Fixed

- **Inbox items could not be confirmed or rejected.** Inbox rows are in-memory
  `MemoryCandidate` objects, but `confirm`/`reject` resolved ids against the persisted
  index only, so both buttons failed with `not-found` ("未找到目标"). Confirming a
  candidate now writes it as an active memory (promoting `low` confidence to `medium`);
  a duplicate/supplement is merged into the memory it belongs to instead of creating a
  duplicate; a contradiction keeps both sides. Rejecting a candidate removes it without
  writing a file. The dead `materializeCandidate` path is now used for `reject(keepFile)`.
- **Any status change on an automatically extracted memory failed with `unsafe-edit`.**
  Extracted memories carry a multi-line `evidence: |-` block scalar, and the in-place
  frontmatter editor refused to rewrite a multi-line scalar even when its value was
  unchanged. Unchanged literal block scalars are now left byte-identical; changed ones
  are still refused conservatively.
- **The plugin's `language` setting had no visible effect in the desktop/web app.** The
  host `locale` translator was consulted before the plugin's own dictionary, so the
  host language always won. The plugin dictionary (an explicit user choice) now takes
  precedence; the host translator is only a fallback for keys the plugin does not ship.
- **The settings page always claimed "unsaved changes".** The hint is now rendered only
  when the draft actually differs from the persisted settings.

### Added

- **Real-browser end-to-end suite** (`scripts/ui-e2e-flows.mjs`, `npm run verify:e2e`):
  61 checks over all five tabs — Inbox confirm/reject/duplicate-merge, search → detail,
  archive/restore/pin, raw-Markdown write, two-step delete, settings persistence,
  language switching, recall preview, batch operations, and the merge dialog. It can
  drive a token-guarded desktop listener via `--cookie-file`.
- Desktop-app end-to-end verification: the full suite passes against the running
  desktop app (61/61) with the real vault, and the vault is restored afterwards.
- Index-consistency assertions (out-of-sync records, headline count vs service stat).

### Verified

- 41 test files / 595 cases pass; `tsc --noEmit`, `npm run lint`, and `npm run build`
  pass. Desktop app: 61/61 E2E checks, no console errors, no uncaught exceptions.

## [0.1.2] - 2026-10-19

### Changed

- Keep the npm README in English (the Simplified Chinese README moved to
  `docs/README.zh-CN.md`); refresh version references.

## [0.1.1] - 2026-10-19

### Fixed

- npm README metadata and version references so the published page renders correctly.

## [0.1.0] - 2026-10-18

### Added

- First public release: Markdown/Obsidian-compatible long-term memory vault, four
  model tools (`memory_search`, `memory_get`, `memory_save`, `memory_forget`),
  first-level sidebar management page (overview / search / detail / manage / inbox /
  settings), token-budgeted recall, durable journal with a crash-safe outbox,
  deterministic extraction and dedupe/merge rules, bilingual UI (zh/en), and
  rebuildable index.
