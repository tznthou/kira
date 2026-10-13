# CHANGELOG

[中文](CHANGELOG.md)

This file tracks notable changes to the README. Format inspired by [Keep a Changelog](https://keepachangelog.com); version numbers follow CalVer (YYYY-MM-DD).

Before the source was opened, development happened in a private repository, `kira-app`. "kira-app PR #N" and the commit hashes in those entries point there; pull requests in this repository start again at #1.

## [2026-10-09b] — Diffs move off the main thread, and what reaches the screen is capped

### Changed

- Design choices, git2-rs: the sentence now says diffs run as an async command on the thread pool, and how much of a diff reaches the screen is capped (a file over the cap is collapsed to its name and size); push / pull are still sync commands, and moving them is still queued. The earlier entry today had both as follow-up work

### Technical notes (not in the README; kept here for the record)

- The display cap: 2,000 lines or 128K characters per file, 5,000 lines or 256K characters per commit. Files are taken in path order; one over the per-file cap, or one that would push the total over, is collapsed whole, and later files that still fit are sent. A banner says how many files are not shown and why. PR diffs go through the same cap
- Characters, not UTF-8 bytes: at the same 60,300 characters, Chinese took only about 15% longer than English to lay out and paint, and a byte cap would collapse Chinese three times sooner. Characters are counted on the text as it is sent, where each run of invalid UTF-8 becomes one U+FFFD and counts as one. Counting UTF-8 lead bytes instead would let a line of 0x80 bytes count as one character however long it was, and a hostile commit could get a whole file past the cap
- Off the main thread, a request the frontend has dropped still runs in the backend, so a gate sits in front: one diff computes at a time, and a queued request already replaced by a newer selection is skipped
- Holding an arrow key through the commits, a big diff (over 500 lines or 32K characters) waits until the key is released; small ones still preview live. Lines over 2,000 characters are drawn without highlighting (highlighting made a minified-JS line about four times slower to draw)
- Verification (release build, click a commit → diff painted, median of 5 runs): a large yarn.lock change 530 → 63 ms, a large package-lock.json change 797 → 64 ms (both collapsed); the worst case inside the cap (500 files filling exactly 5,000 lines) 417 ms

## [2026-10-09] — Stale IPC, threading and theme claims corrected; v8 port status added

### Changed

- Architecture and design choices: both places that said the only path-taking command is `git_open_repo` are rewritten. That command is long gone; paths now arrive only through the Rust-side native picker (opening a repo, choosing a clone destination) or the stored recent list (`git_open_recent_repo`). The promise to "bind that one entry point to an OS file picker" goes too — it already is
- Design choices, git2-rs: "it's a sync API, but Tauri's thread pool keeps the UI responsive" was wrong. Tauri runs sync commands on the main thread, so a huge diff or a push / pull can freeze the window. The README now says that, and that moving them to async commands is queued
- Modules table, "Visual polish": ink/paper dual theme → light / dark (the switch happened in v8 Phase 3)
- Modules table: a new row for the v8 design port (shell and route map done; sidebar / right pane / diff and the dialogs next); "Safety rails" now names the route map's budgets for crossings and subject length
- Stack, "Styling": v8 design-reference CSS + Tailwind CSS while the port is underway; the project tree gains `src/styles/`
- Reflections: "shrinks the capability surface from seven entry points to one" drops the numbers, as the Chinese version never had them — more than one entry point takes paths now

### Technical notes (not in the README; kept here for the record)

- 4b's quality pipeline (serial: Codex review → simplify → security review → final verification) added three limits: the tooltip shows at most four lines of the subject (the smallest window's graph pane is 388 px, and at four lines every row has room above or below); at most 1000 UTF-16 units of a subject reach the DOM (the old graph cut at 50 characters, and once v8 left the cut to CSS a hostile repo's giant subjects went in whole); a bridge budget (20,000,000 search pairs / 50,000 holes, calibrated on the 18,331 holes in git/git's first 1000 rows, which scrolled with every frame under 50 ms)
- Off the main thread today: the GitHub network commands, clone, and the two dialogs (open a repo, choose a clone destination). Local git commands — graph, diff, push / pull and the rest — are still sync commands
- Verification: 224/224 regions match the design reference at 0 differing pixels

## [2026-10-08] — The graph becomes the v8 route map; D3.js leaves the stack

### Changed

- Stack table, "Graph rendering": D3.js + SVG (7) → React + SVG. The graph is now the v8 route map (HTML rows under an SVG route layer). Nothing had ever imported `d3`, and it leaves `package.json` here, so the old entry was simply wrong
- Modules table: "Commit Graph rendering" now says how it is drawn; the project tree's component directory `CommitGraph` is now `Graph`

### Technical notes (not in the README; kept here for the record)

- v8 Task 16, Phase 4 (4a: kira-app PR #42; 4b): lines routed by the design reference's 0 / 45 / 90° rules (combo A plus boundary joins; where lines cross, the lower one's straight run gets a gap, a bridge), each station's refs folded into a character budget, the gold-leaf "you are here" with its ripple; the graph region matches the reference at 0 differing pixels

## [2026-07-30] — T15f Motion P0: stack and animation claims corrected

### Changed

- Stack table, "Animation" row: Framer Motion (planned) → CSS transitions + @keyframes. The T15f go/no-go landed on no — motion is plain CSS with zero animation dependencies, and leaving it marked "planned" implied we still intended to adopt it
- Stack table, Zustand: 4 → 5. `package.json` has 5.0.12; the old entry was simply wrong
- Reworded the "animation as information" principle. It claimed commit arrival, branch divergence and merge collapse all carry semantic motion — **none of those exist**. Replaced with what actually ships (panel entry, hover feedback) plus the exit case, which makes the point better than any positive example: exits stay static because leaving tells you nothing

### Technical detail (CHANGELOG-only, not in README)

- T15f P0 (kira-app PR #36): `@keyframes kira-fade-in` (the project's first keyframes) + 200ms tab panel entry fade with a 3px rise + 100ms hover on FileItem/PRItem. Motion direction settled on restrained and frequency-tiered — 100-120ms for high-frequency interaction, 200-300ms for low-frequency state changes, `opacity` and `transform` only (GPU-composited), no scale
- A three-way parallel review caught a silent defect: a bare `transition-colors` falls back to `--default-transition-timing-function`, and Tailwind sets that value to the exact same curve as `--ease-in-out` — so all three hover sites were running ease-in-out, contradicting the stated ease-out direction. Explicit `ease-out` added, and the trap is now recorded in `CLAUDE.md` so it cannot recur silently
- This pass also backfills the 2026-05-21 entry that was missed at the time (see below)

## [2026-06-08b] — T15 visual polish (a–d): graph redesign + dual-theme parity

### Added

- "Visual polish" row — summarises T15a-d: shared Button/Skeleton/EmptyState/ErrorBanner components, graph bullseye nodes with pill ref labels, ink/paper dual-theme calibration
- ThemeSwitcher added to the components list — landed in T9 but was missing from the README

### Technical detail (CHANGELOG-only, not in README)

- T15a Rhythm Pass (kira-app PR #29): Button component + badge semantic tokens + row height unification
- T15b Graph Craft (kira-app PR #31, 5 review findings): bullseye node shape + pill ref labels + bezier 40% + diff overflow scroll + flex min-w-0 layout fix + memo comparator stale-render fix + BranchRef is_remote
- T15c State Design core (kira-app PR #30): Skeleton/EmptyState/ErrorBanner + cn() utility
- T15d Theme Parity (kira-app PR #32): 8 graph-specific CSS tokens, paper theme dark-badge-on-light-page strategy, merge subject textMuted → textTertiary

## [2026-06-08] — T14 complete, status table brought up to date

### Added

- "Auto-refresh" row — T9d's file watcher monitors `.git` so Kira picks up external changes (terminal commits, resets, pulls) without a manual refresh
- "Safety rails" row — summarizes T14's three hardening passes: unstaged file cap keeps large repos from tanking the UI, checkout dirty-check blocks switching on a dirty tree, PR enrichment concurrency cap prevents GitHub API floods
- `watcher.rs` in the project structure diagram — the `fs` module is no longer just `recent_repos.rs`
- DiffViewer added to the components list — T12c extracted `DiffFilesList` into its own subdirectory, which was missing from the tree

### Changed

- PR panel status promoted from 🚧 to ✅ — T12a/b/c all merged (IPC + patch parser, list UI, diff UI), description now mentions diff capability

## [2026-05-28]

### Added

- Branch operations (checkout / create / delete) and Clone Modal + Recent Repos Sidebar rows in the status table, both marked "✅" — T10 branch ops + T11a/T11b clone + T13a/T13b sidebar landed on main via kira-app PR #11-#20
- PR panel row flipped from "⏳" to "🚧 PR awaiting merge" with description "list + review/CI badges" — T12a (backend IPC + patch parser) and T12b (PR list UI + review/CI badges + tab switching) are kira-app PR #21 and #22 respectively, CI green and awaiting merge
- Project structure entries for `github/` (auth + pr + patch_parser), `fs/recent_repos.rs`, `git/branch.rs`, and `git/clone.rs` — these modules were added across T10-T13 but the README hadn't caught up

## [2026-05-21] — Reflections section added (backfilled)

> Missed when it landed; recorded on 2026-07-30.

### Added

- "Reflections" section, both languages (README.md +18 lines, README_EN.md +22) — on where a Git tool sits in the AI era: execution is outsourceable (AI writes commit messages, rebase incantations, conflict resolutions), understanding is not (topology, ancestry, why a particular rebase drops work — you have to look at it yourself). It also sharpens the line the Non-goals section left vague: not "the CLI is already fine", but execution vs understanding

## [2026-05-06]

### Changed

- Flipped Diff Viewer and GitHub OAuth Device Flow rows in the status table from "🚧 PR awaiting merge" to "✅" — kira-app PR #3 + #4 are now on main (merge commits `993876b` / `d4917e5`); cargo 126 tests + RTL 32 tests + the quality pipeline all green, and the OAuth flow's main path (modal, browser authorization, polling, token-to-keyring, username display) cleared dev smoke

## [2026-05-03]

### Added

- Commit Graph rendering, Staging Area UI, and Push / Pull with transfer-progress events in the status table — all three are landed on main now, flipped from 🚧 to ✅ so readers can tell at a glance which moves Kira can already make
- Diff Viewer and GitHub OAuth Device Flow rows in the status table, both labelled "🚧 PR awaiting merge" — CI is green and they're waiting on the hands-on dev smoke before merge, this gives readers a heads-up on what shows up next
- A realistic `src/` tree (`components/`, `stores/`, `lib/`, `tests/`) plus the backend's `git/remote.rs` (push / pull / fetch path) — the old layout only showed the scaffolding-era `App.tsx`, which had drifted far from the actual repo

### Changed

- Dropped the "(planned)" tag from D3.js and Zustand in the stack table — both are real `package.json` entries now, leaving them as planned would mislead
- Framer Motion keeps "(planned)" — still not pulled into dependencies, called out honestly
