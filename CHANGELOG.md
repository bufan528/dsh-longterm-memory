# Changelog

All notable changes to **DSH Memory Vault (`dsh-longterm-memory`)** are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-14

### Added

- **Sticker and reminder tools for the model.** `sticker_pick`, `sticker_ingest`,
  `reminder_create`, `reminder_list` and `reminder_complete` join the four memory tools, so
  "remind me at three tomorrow" and "send a sticker for that" finally have something to call.
  They live in `host/dsh/life-tools.ts` and are built from duck-typed surfaces, which keeps them
  testable without a vault. Stickers are deliberately **not** owner-gated (they are user-curated
  images meant for public chat); reminders are, because a schedule is personal.
- **Sticker send policy.** `shared/sticker-pick.ts` scores candidates (exact tag > substring >
  description; favourites up, over-used down, used-moments-ago penalised), then applies a
  cooldown, a rolling 24 h ceiling, quiet tags and an optional probability gate. A refusal is a
  useful answer: it carries the reason and the retry instant, so the model can say "give it a few
  minutes" instead of inventing a sticker. Policy and counters live in
  `Companion/Stickers/policy.json`, deliberately outside `catalog.json` — that file is shared
  byte-for-byte with the QQ plugin.
- **Persona evolution, review-gated.** `host/companion/evolution.ts` proposes small changes to
  the *variable* layer only (address, catchphrases, avoid, tone) from the user's own memories
  with deterministic rules — no model call, every proposal traceable to memory ids and labelled
  with a confidence. Suggestions queue in `Companion/Evolution/suggestions.json`; the persona
  pane grows an "进化建议" card where each row is accepted or dismissed, and accepting writes
  `Persona.md` through the normal validated path. The fixed core (name / identity / boundaries)
  is never proposed, and nothing applies without a click: the research consensus (GLA, MeKB-Sim)
  is that a persona may drift, but traceably and on purpose.
- Four RPCs back the queue: `evolutionList` / `evolutionScan` / `evolutionApply` /
  `evolutionDismiss` (59 host methods in total, 35 Life-page calls, all with branches).
- **伙伴中心（Life Agent）.** An eighth first-level tab with eight panes — overview, persona,
  sharing, review, stickers, reminders, privacy, diagnostics — backed by Vault-owned stores
  (`companion@v1`, `sticker-library@v1`, `reminder-service@v1`). Stickers and reminders moved
  out of the QQ plugin so the PC page no longer depends on another plugin being installed;
  QQ keeps delivery, Vault keeps the rows.
- **Persona documents with voice anchors.** `Companion/` gains optional `scenario`,
  `catchphrases`, `avoid` and `examples` fields (numbered `example1_user` / `example1_assistant`
  keys, so the file stays one-field-per-line in Obsidian). Six presets ship with three example
  dialogues each; applying one is a two-step confirmation because it overwrites every field.
  `companionFillAnchors` fills only empty slots and never rewrites user text.
- **Persona preview.** The examples are rendered as a two-sided conversation, with
  catchphrases and forbidden phrases as chips, so the voice can be judged before saving.
- **Sticker previews.** New `stickerThumb` RPC returns a `data:` URL for one sticker
  (640 KiB cap, MIME allow-list, `basename` path check, bounded LRU). Ids are SHA-256, so a
  cached preview can never go stale.
- **Natural-language reminder capture.** `src/client/reminder-parse.ts` (pure function) resolves
  `3小时后` / `明天下午三点` / `周五晚8点` / `11月20日` / `9点半` into an instant, shows the guess
  as a chip, and never guesses when no time was found. Reminders are grouped by the user's own
  local midnight: overdue / today / next seven days / later / settled.

### Changed

- **This release is breaking for anything that pinned the old surface.** The management page went
  from 6 to 7 first-level tabs (`伙伴中心` inserted before `设置`), `RPC_METHODS` grew to 59, and
  the model now has 9 tools instead of 4. Settings, vault layout and stored files stay backward
  compatible; the JSON RPC names did not change, only grew. Version bumped 0.1.8 → **0.2.0**.
- **The entire management UI was rebuilt** against two explicit references: the Apple HIG
  (one primary action per view, content before chrome, depth through surfaces rather than
  outlines) and Disney's animation principles (press-scale as anticipation, a blurred backdrop
  as staging, spring overshoot on entry only, secondary action on lift, nothing over 400 ms,
  full cancellation under `prefers-reduced-motion`). `styles.ts` is now layered as
  tokens → shell → card → controls → surfaces → feedback → companion → motion and derives every
  translucent colour with `color-mix()`, which the existing bundle test requires.
- Overview became a status band plus an attention strip, a ledger and a proportional
  category bar; search hides its seven filters behind one disclosure that reports how many are
  on; settings splits fourteen controls into four groups with a sticky save bar; detail reads
  content first and groups its actions; the inbox keeps its manual form **expanded by default**
  (collapsible) so the primary action of the page needs no extra click.
- Motion, fourth pass: toasts now have a full enter → dwell → 260 ms exit arc instead of
  blinking out; section and Life-tab switches slide directionally (forward from the right,
  back from the left); disclosure indicators rotate one chevron 90° instead of swapping two
  icons; themed text selection, hairline scrollbars and a soft focus halo finish the chrome.
  Every new animation is covered by the existing `prefers-reduced-motion` rule.

- **Sticker rhythm is now adjustable.** A "发送节奏" card in the sticker pane edits the gap,
  the daily ceiling, the send probability and the quiet tags, with the live 24 h count and the
  last-sent instant beside it. Backed by `stickerPolicy` / `stickerPolicyUpdate`; the file stays
  `Companion/Stickers/policy.json` so `catalog.json` remains byte-compatible with the QQ plugin.
- **Sticker provenance.** The catalogue records where a row came from (`import` / `incoming` /
  `stolen` / `other`), imports from the page now carry `import`, and the tray shows a quiet tinted
  chip. A "常用" filter joins the tray so the ones that actually get sent are one click away.
- **Persona evolution is undoable.** Accepted suggestions stay listed and can be reverted:
  address and tone restore the recorded value, phrase lists drop only the appended entry. New
  `evolutionRevert` RPC, `reverted` status, and a regression test for the post-restart queue.
- **Reminder delivery rhythm.** Quiet hours (22:00-08:00 by default), an exponential backoff
  (15 min × 1.6 per unanswered nudge, five attempts), and a live "what is waiting" summary.
  `reminderPolicy` / `reminderPolicyUpdate` back a card in the reminder pane, and
  `reminder_list` now tells the model when a row may actually be sent, so it can answer
  "not before 08:00" instead of implying it will speak at night. Delivery itself remains the
  chat plugin's call; this side provides the decision.

- **Desktop sessions can read memory (opt-in).** The Owner gate's only positive evidence was a
  live QQ source, which a desktop session never has — so a single-user install saw nothing. New
  `trustLocalSessions` switch (Settings → 本机会话, **off by default**) treats a session with no
  live provenance as local, but only when it is not a known QQ session and the QQ registry is
  readable. QQ groups, QQ sessions whose live source vanished, a broken registry and unrecognised
  platforms stay refused; the switch fills one gap instead of opening the gate. Design record
  and the rejected alternatives are in `docs/architecture.md` §11.
- **Automatic sticker capture from chats.** The chat plugin already downloads incoming images
  and renders `Image: <path>` into the model's context, so capture needs no change on that side:
  the standing prompt block now tells the model when a reusable reaction image is worth keeping,
  which paths may not be saved (screenshots, documents, real photos, QR codes, duplicates), and
  that at most three self-initiated captures happen per conversation. An explicit user request
  can pass `source: import`, which is not capped. Toggle it in 设置 → 自动提取
  (`enableStickerAutoCollect`), and the management preview shows exactly what the model receives.

- **Interface pass: surfaces, rhythm, motion and touch targets.** Measured on a live host rather
  than eyeballed — page, cards and nav were all `rgb(255,255,255)` in light mode, so hierarchy came
  from a 4% border and nothing else. Surfaces are now mixed *relative to the label colour*
  (`--lmv-tray`, `--lmv-border`, `--lmv-lift`), which darkens them in light mode and lightens them
  in dark mode from one rule. Form rows that used `auto-fit` (three columns plus an orphan on a
  1044px card) now use purpose-built 4- and 3-column grids that collapse at 1180px and 560px.
  Titles balance their line breaks; numeric columns stay tabular.
- **Motion follows the doctrine it claims to follow.** Three `linear` animations became `ease-out`
  (the stylesheet says "no linear motion" and then used it). Buttons gain anticipation on hover,
  squash on press and follow-through on release, with the icon trailing by a beat — and dense icon
  buttons explicitly opt out, because a row of jumping buttons reads as jitter. Empty-state float
  now runs once instead of forever.
- **Loading looks like the arriving content.** A new `Skeleton` (rows / grid / card) replaces the
  spinner in the sticker library, the reminder list, the inbox, shared memory and search results, so
  nothing jumps when data lands. Toasts cap at three, and the stack no longer intercepts clicks
  meant for the page underneath.
- **Reachability and restraint.** Coarse pointers get 34px hit targets; `hover:none` keeps
  hover-revealed row actions visible; narrow navs fade at the edges to signal scrollability; scroll
  containers reserve their gutter and stop scroll chaining; `:focus-visible` is a single ring
  instead of an outline plus a 4px halo; nav items carry `aria-current`. Under
  `prefers-reduced-motion` the collapse panel keeps its delayed-visibility timing (the blanket 1ms
  rule broke it) and skeletons drop their shimmer.
- **Less first-screen noise.** The sticker drop zone collapses to one row once the library has
  content, the twelve emotion chips scroll in a single row instead of wrapping, the inner list is
  renamed 全部表情 to stop duplicating 表情包图库, and context badges like 今晚 lost their border so
  they stop competing with counts.

### Fixed

- `ReminderStore.readPolicy` normalised the `{ schemaVersion, policy }` wrapper instead of the
  policy itself, so every read returned defaults and a user's quiet hours silently vanished on
  the next restart. Reading back what was written now has its own test, including the `0` hour
  that a truthiness check would have dropped.
- **Sticker import no longer trusts the declared extension.** QQ/OneBot saves incoming images
  as `1712345678_ab12cd34.image`, and the old whitelist rejected every one of them with
  "unsupported extension: image" — auto-collection could not work on a real chat. The magic
  bytes decide the format (a renamed executable is still refused), and the stored file is always
  `<sha256>.<sniffed>`.
- `EvolutionService` listed from an in-memory cache that was never loaded on boot: after a
  restart the suggestion queue appeared empty, and a scan would then rewrite the file from that
  empty cache and erase every applied/dismissed decision. The service now loads once per process
  before list/scan/apply/revert.
- The inbox manual form had been collapsed by default in a previous pass, which broke the
  "add a candidate by hand" path (caught by the real-browser E2E flow). It opens by default
  again; the slide-out transition stays.
- List rows, reminder rows and sticker tiles used an entrance keyframe whose first frame was
  `opacity: 0` with a stagger delay, leaving freshly created candidates invisible and
  unclickable for a few hundred ms. They now use a translate-only `lmv-slide-in`.
- `scripts/ui-e2e-flows.mjs` had drifted from the current markup: the health capsules render
  `0 记忆总数` rather than `记忆总数: 0`, and the search box is a bare input with an
  `aria-label` rather than a labelled `Field`. Both assertions were updated without weakening
  them — the live service total is still required on screen.

### Verified

- `npx tsc --noEmit` clean (both configs); `npm run lint` clean (69 source files);
  `client-bundle` + `i18n-parity` + `dispatch-validation` green; `check-rpc-contract`
  reports 59 host methods and every Life-page call (35) has a branch.
- **Full suite** (`scripts/run-isolated-suite.mjs all`, each suite in its own process):
  **78/78 suites, 1148 cases passed, 0 failed, 0 skipped**, no guard interception.
- **Real-browser E2E** (`ui-e2e-flows.mjs` against an isolated profile + CLI host + Chrome
  over CDP): **61/61 checks passed**, no error panel, no uncaught page exceptions —
  covering inbox confirm/reject/merge, search → detail → archive/restore/pin, raw Markdown
  write, two-step delete, settings persistence and zh/en switching, batch pin and the merge
  dialog. `ui-acceptance.mjs` also opened the page with all seven tabs and no step errors.
- As always, the panel needs a full DeepSeek Harness restart: the client bundle is read from
  disk on demand, but the host keeps its modules in memory.

## [0.1.8] - 2026-10-29


### Removed

- **Experimental QQ message-merge control surface.** The QQ tab no longer carries a merge
  settings card, its cross-plugin contract/bridge, or the two related RPC methods. The tab
  is back to what this plugin owns: connection status, memory-linkage policy, session
  isolation, inbox wiring, diagnostics and security.

### Verified

- `npm run check` green: build + typecheck + lint + 46 files / tests (all existing memory,
  index, tools, prompt-injection and QQ-tab behaviour unchanged).


## [0.1.5] - 2026-10-27

### Added

- **QQ integration tab.** A sixth first-level tab
  (`记忆总览 | 记忆检索 | 记忆管理 | 收件箱 | QQ 接入 | 设置`) that shows the status of
  the official `@tencent-connect/dsh-qqbot` plugin, a QQ ↔ long-term-memory linkage
  policy, a session-permission preview, inbox wiring and a diagnostics card. Status
  detection uses a read-only same-origin `GET /qqbot/im-qqbot/bind` probe (`200` =
  loaded, with the binding `phase`; `404` = not installed/loaded; anything else =
  cannot confirm). The page does not reimplement the QQ protocol, generate QR codes,
  open the official binding panel (there is no reliable public path to its settings
  section / sidebar tab), or read/store/echo the AppSecret.
- **QQ ↔ memory linkage policy.** Three modes (`off` / `deny-qq` / `allowlist`) and four
  enforcement points (standing prompt section, per-step recall, turn-end write-back,
  memory tools), driven by one shared pure-function module (`src/shared/qq-linkage.ts`)
  so the page preview and the host enforcement cannot disagree. QQ sessions are
  identified only by explicitly configured `origin` / `agentPreset` / `cwd` markers;
  private and group chats are **not** distinguishable because the official plugin does
  not write its scope into the DSH session header. Safe defaults: `mode: off`,
  `writeMode: inbox-only`, `allowTools: false`.
- **New RPC methods** `qqLinkage` / `setQqLinkage`, returning a `QqLinkageReport`
  (config, runtime capability notes, enforcement registration, host facts, recent
  session samples, per-point counters). RPC surface: 27 → 29 methods.
- **Documentation**: new `docs/qq-integration.md` (Chinese), QQ sections in `README.md`
  and `docs/README.zh-CN.md`, a "QQ 接入联动" section in `docs/architecture.md`, and
  host-compatibility records in `docs/compatibility.md` §12–§14.

### Changed

- **Verified DSH version is now `0.2.1-rc.3`** (the current desktop host; the plugin is
  loaded and serving RPC on it). `engines.dsh` moves to `>=0.2.1-rc.3 <0.2.2`;
  `dsh.compatibility.dshReleases` keeps the historical `0.2.1-rc.2` entry and adds
  `0.2.1-rc.3`. The host decides admission from `engines.dsh` / peer ranges only —
  `dsh.compatibility` is documentation — so "declared" and "admitted" are separate
  matters.

### Known limitations

- The official QQ plugin's compatibility list still covers only DSH `0.1.0-rc.8` and
  `0.2.0-rc.2`; `0.2.1-rc.3` is admitted by the host's peer-range check, **not**
  officially validated, and the 0.2.1 line has open community reports (issues #60 / #58).
- The QQ tab and linkage policy have not been exercised by the real-browser E2E suite;
  the official QQ plugin was not installed during development, so only the probe's
  `404` branch was observed.

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

