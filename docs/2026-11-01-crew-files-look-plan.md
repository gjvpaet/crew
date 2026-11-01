# Crew Files pane: the filetree look — spec and plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restyle the per-agent Files pane after the interface in the filetree segment of the video, without copying code (the cards in the video are not in the filetree repository). Three things change: the file being worked on shines; a Right-now card replaces the plain header; and a Touched card with a flat list replaces the tree. Git line counts and a branch row are computed in the background.

**Architecture:**
- **Pure:** new helpers in `hooks/files.ts` turn entries, the agent status and git info into view models: the Right-now card, the Touched rows and the terminal shine colours.
- **SVG:** new helpers in `hooks/svg.ts` draw the shining name and the card icon on graphical surfaces.
- **Git:** `hooks/register.tsx` refreshes git info after edits and commits, through a new tracker event.
- **Pane:** `hooks/files-pane.tsx` draws it all, with text fallbacks for the terminal.

**Tech stack:** a Claude Code mod (TypeScript, no build), `claude-code/testing`, Claude Code 2.1.309.

**Base:** `build/v0.1` at `0916cfc`. The existing behaviour stays unless this document changes it: the chevron, `showFiles`, the safe `openFile`, the commit check, the Bash scan, lifetimes and caps. See `docs/2026-11-01-crew-files-pane-design.md`.

**Approved design (mockup shown to the owner):**

```
Files · Implement the price table
╭───────────────────────────────────────────────╮  ← outline flashes bright for ~1.2 s after a new touch
│ (✎)  RIGHT NOW                                │  icon circle: eye = reading, pencil = editing,
│      Editing PriceTable.jsx                   │  check = committed, pause = waiting, check = done
│      src/pricing  +12 −3                      │
│ ───────────────────────────────────────────── │
│ ⎇ feat/pricing                +14 −3 · 2 changed│  branch row (from git)
│ ● read   ● edited   ● committed               │
╰───────────────────────────────────────────────╯
╭ TOUCHED                                3 FILES ╮
│ ╭[JSX] PriceTable.jsx  src/pricing  +12 −3 (editing)╮ │ ← live row: outlined + tinted, name shines
│  [JS]  usePrices.js    src/pricing        (read)   │
│  [JSX] PriceTable.test.jsx  test     +2 (committed)│
╰───────────────────────────────────────────────╯
● committed a1c9e42
```

---

## Spec

### Right-now card

- **Phase and label,** from the agent's status:
  - running: `RIGHT NOW`;
  - pending, waiting or idle: `WAITING`;
  - completed, failed, killed or stopped: `DONE`.
- **Label colour:** the live file's state colour while running; amber for WAITING; the colour of the agent's dominant state when DONE (edited if any are edited, else committed if any are committed, else read).
- **Icon:** a 36 px circle tinted with the label colour and a glyph:
  - eye while running and the live file is read;
  - pencil while running and it is edited;
  - check while running and it is committed;
  - pause for WAITING;
  - check for DONE.
  - On graphical surfaces it is a small SVG (`iconSvg`). In the terminal it is a coloured glyph: `◉`, `✎`, `✓` or `‖`.
- **Title and subtitle:**
  - RIGHT NOW and WAITING: the title is `Reading`, `Editing` or `Committed <name>` of the latest touch. The subtitle is its folder (relative to the project, absolute outside it, empty at the root) plus its line counts when known (`+12 −3`).
  - DONE: the title is `Edited 2 files` / `Read 1 file` / `Committed 3 files`, naming the dominant state and its count, and the subtitle is the summary `edited 2, committed 1, read 3`.
  - No entries: the title is `No files yet` and there is no subtitle.
- **Branch row:** shown only when git info for the live file's repository is known (when DONE, the latest touch's repository).
  - Left: a branch glyph (`⎇` in the terminal, a small SVG elsewhere) and the branch name, or `detached` with no branch.
  - Right: the total `+A −D` across the agent's files with counts, then `· N changed` (the repository's dirty-file count), or `clean` when N is 0.
- **Legend:** as today. Committed appears once a commit has been seen.
- **Flash:** while the latest touch is less than 1,200 ms old, the card's border is drawn bright (`#E8E6DF`); otherwise it uses the surface's own border.

### Touched card

- **Header row:** `TOUCHED` on the left and `N FILE(S)` on the right, both caption, dim.
- **Rows:** a flat list, newest touch first, at most `MAX_ROWS = 100` rows, then `+ N more`.
- **Each row:** a type chip, the file name (semibold), the folder (dim; `.` for the project root, absolute outside it), line counts when known and non-zero (`+A` green `#7FC77F`, `−D` red `#F07A7A`), and a pill.
- **Type chip:** the upper-cased extension, at most 4 characters (`JSX`, `JS`, `MD`, `JSON`; no extension means `FILE`). Its tone is a fixed colour pair:
  - code (js jsx ts tsx mjs cjs py rb go rs java kt swift c h cpp cs php sh vue svelte css scss html) is amber;
  - docs (md mdx txt rst pdf doc docx) is blue;
  - data (json yaml yml toml csv xml sql lock env) is green;
  - anything else is gray.
- **Pill text:**
  - the live row (latest touch while the agent runs): `reading`, `editing` or `committed`;
  - other rows: `read`, `edited` or `committed`.
  - Colours: read is purple `#A371F7`, edited orange `#F0883E`, committed green `#3FB950`. A pill is a coloured label: a text span with `backgroundColor` if the surface accepts it, else coloured text in brackets.
- **Live row:** a Box with `borderStyle="round"` and `borderColor` set to its state colour. On graphical surfaces the name is drawn by `shineSvg`, a light band sweeping across the name every 1.6 s in the state colour. In the terminal each letter is a Text coloured by `shineColors(name, now, base)`, a 3-letter brighter band moving one letter per redraw.
- **Pressing a row's name** still opens the file through the existing safe `openFile` (unchanged). The Button key stays `open-<path>`, and the row Box key stays `file:<path>`.

### Footer

`● committed <sha>`, as today.

### Git info (background)

New state in `CrewState`:

```ts
lines: Record<string, [number, number]>                        // absolute path → [added, removed] vs HEAD
repos: Record<string, { branch: string | null; changed: number }> // repository top → branch, dirty-file count
```

- **Event:** `{ kind: 'git'; lines: Record<string, [number, number]>; repos: Record<string, { branch: string | null; changed: number }> }`, merged in. A path with `[0, 0]` is removed from `lines`.
- **`refreshGit($, paths)`** in register.tsx, fire-and-forget:
  1. Group the paths by repository top (`rev-parse --show-cdup` plus `joinUp`, as the commit check does; skip outside a repository).
  2. Per top, run `diff --numstat -z HEAD -- <paths>`: each record is `added\tremoved\tpath`, with `-` for binary meaning 0. Paths not listed get `[0, 0]`.
  3. Run `symbolic-ref --short -q HEAD` (exit non-zero means a detached HEAD, so `null`).
  4. Run `status --porcelain -z` and count its entries, using `dirtyPaths(...).size`.
  - Every call is `git --no-optional-locks -C <dir>` with a 5 s timeout, and any failure skips that top.
- **When it runs:**
  - after an edit touch, from a file tool or the Bash scan, for that agent's edited and committed paths, debounced per top: at most one refresh in flight per top, plus one queued;
  - after `checkCommit` dispatches, for the committed paths.
- Drawing never runs git. Lifetime: `lines` and `repos` reset with the model. A new prompt prunes `lines` to the paths still in some agent's files.

### Budget

The Files pane stays under 2,000 nodes, depth 32 and 262,144 characters with 300 touches (100 rows drawn) on graphical surfaces, measured with the `desktopMeasure` helper the tests already have. Only the live row and the icon are SVG.

### Out of scope

A whole-project tree, search, and the filetree buttons (Refresh, Collapse all and the like).

---

## File map

| File | Change |
|---|---|
| `hooks/files.ts` | add `chipOf`, `touchedRows`, `rightNow`, `shineColors`, `numstat` (parser); remove `fileTree` and `TreeRow` (replaced by the flat list) |
| `hooks/svg.ts` | add `shineSvg`, `iconSvg` |
| `hooks/tracker.ts` | `lines`, `repos` in `EMPTY_STATE`; the `git` event; prune `lines` on a new prompt |
| `types/index.d.ts` | `lines`, `repos` in `CrewState` |
| `hooks/register.tsx` | `refreshGit`, triggered after edit touches and commits |
| `hooks/files-pane.tsx` | draw the Right-now card, the Touched card, the live row and the footer |
| `test/files.test.ts`, `test/svg.test.ts`, `test/tracker.test.ts`, `test/files-pane.test.ts` | tests |

Ground rules are as in `docs/2026-11-01-crew-files-pane-plan.md`:
- **Git:** `GIT_CONFIG_GLOBAL=/dev/null`, author gjvpaet@gmail.com, no Co-Authored-By. Commit onto `build/v0.1`; never push.
- **Tests:** one test file at a time via `scripts/test-one.sh`.
- **Style:** tabs, no semicolons, single quotes, sparse why-comments.

---

### Task 1: Pure view models (`hooks/files.ts`)

Define these and test them in `test/files.test.ts`, removing the `fileTree` tests along with `fileTree`:

```ts
export type ChipTone = 'code' | 'docs' | 'data' | 'other'
export function chipOf(path: string): { label: string; tone: ChipTone }

export type TouchedRow = {
	key: string        // `file:<path>`
	path: string
	name: string
	folder: string     // relative dir, '.' at the root, absolute outside the project
	state: FileState
	pill: string       // 'reading' | 'editing' | 'committed' for the live row, else 'read' | 'edited' | 'committed'
	isLive: boolean
	added: number      // 0 when unknown
	removed: number
	chip: { label: string; tone: ChipTone }
}
export function touchedRows(entries: readonly FileEntry[], root: string, status: AgentStatusView, lines: Record<string, [number, number]>): TouchedRow[]  // newest first

export type RightNow = {
	label: 'RIGHT NOW' | 'WAITING' | 'DONE'
	tone: FileState | 'waiting'
	icon: 'eye' | 'pencil' | 'check' | 'pause'
	title: string
	subtitle: string
	added: number      // the live/latest file's counts, 0 when unknown
	removed: number
	totals: { added: number; removed: number }   // across the agent's files with counts
	repoTop: string | null   // the latest touch's repository, if known in repos
}
export function rightNow(entries: readonly FileEntry[], status: AgentStatusView, root: string, lines: Record<string, [number, number]>, repos: Record<string, { branch: string | null; changed: number }>): RightNow

// Terminal shine: one colour per letter, a 3-letter band of `bright` moving one letter per 120 ms across `base`.
export function shineColors(text: string, now: number, base: string, bright: string): string[]

// `git diff --numstat -z` output → path (relative to top, as git prints it) → [added, removed]; '-' counts as 0.
export function numstat(stdout: string): Record<string, [number, number]>
```

- **`repoTop`:** the longest key of `repos` that is a prefix of the latest path plus `/`.
- **Required cases:**
  - a chip for each tone, no extension, and a 5+ letter extension cut to 4;
  - rows ordered newest first;
  - the live row only while running;
  - the folder at the root (`.`), nested, and outside the project;
  - counts present and missing;
  - `rightNow` for each phase, icon and empty case, the DONE title choosing the dominant state, and `repoTop` resolution;
  - `shineColors` returning one entry per letter, with the band moving between two `now` values and wrapping around;
  - `numstat` with a normal record, a binary `-` record and an empty input.

Commit: `feat: add view models for the filetree look`.

### Task 2: SVG pieces (`hooks/svg.ts`)

```ts
// The live file's name as an SVG: the name in `color`, with a lighter band sweeping across it every 1.6 s (CSS keyframes
// inside the SVG; the caller draws it with isInteractive). Width from the text length so it sits in a row.
export function shineSvg(text: string, color: string, opts?: { fontSize?: number; weight?: number }): { source: string; width: number; height: number }
export function iconSvg(icon: 'eye' | 'pencil' | 'check' | 'pause' | 'branch', color: string, size: number): string
```

- **`shineSvg`:**
  - escapes the text with the existing `escapeXml`;
  - uses `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"`, 13 px, weight 600 by default;
  - estimates the width as `ceil(text.length * fontSize * 0.62) + 4`, with height `fontSize + 6`;
  - draws the base text plus a `linearGradient` (base, a light tint, base) applied to a second copy of the text and animated by a translate in `@keyframes`, clipped to the text.
- **`iconSvg`:** draws a filled circle at 22% opacity of `color`, with the glyph stroked in `color` (simple original paths).
- **Tests in `test/svg.test.ts`:**
  - the shine contains `@keyframes`, the escaped text, and a width that grows with text length;
  - every icon returns a valid-looking `<svg` with the colour.

Commit: `feat: add the shining name and card icons`.

### Task 3: Git info (`hooks/tracker.ts`, `types/index.d.ts`, `hooks/register.tsx`)

- **Tracker:** add `lines: {}` and `repos: {}` to `EMPTY_STATE`. Add the `git` event: merge `repos`; merge `lines`, deleting entries that are `[0, 0]`. A no-op returns the same state. A new person prompt prunes `lines` to the paths still in any agent's `files`. Test these in `test/tracker.test.ts`.
- **`refreshGit($, paths)` in register.tsx,** following the Git info spec above:
  - group the paths by top;
  - per top, run numstat, then symbolic-ref, then status;
  - map numstat's relative paths to `${top}/${rel}`;
  - every asked path not in numstat gets `[0, 0]`;
  - one `git` event per refresh;
  - debounce: one refresh in flight per top, plus at most one queued, with module-level maps.
- **Triggers:** after each edit touch (the file tools and the Bash scan) for that agent's current non-read paths, and after `checkCommit` for every path it marked. Keep everything fire-and-forget with `.catch`.
- **Tests in `test/files-pane.test.ts`** (stubbing `diff --numstat`, `symbolic-ref` and `status`):
  - an Edit by a1 leads to a git event whose counts later show in the pane (Task 4 asserts the drawing; here, assert the argv sequence and that a second rapid edit doesn't start a second concurrent refresh for the same top);
  - outside a repository nothing runs;
  - a failure leaves things as they were.

Commit: `feat: keep git line counts and the branch in the background`.

### Task 4: Draw the new pane (`hooks/files-pane.tsx`)

- Replace the header box and tree drawing with the Right-now card, the Touched card and the footer as specified, using Task 1's models, Task 2's SVGs (graphical only, `isInteractive` on the shine) and `state.lines` and `state.repos`. Keep:
  - the `Press ▸ …` message for no agent or a dropped one;
  - `showFiles`, `openFile`, the `ui.close` hook and the title;
  - the row keys `file:<path>` and Button keys `open-<path>`.
- Drop `MAX_ROWS` to 100.
- Remove the pulse code that only served the old dot. Keep `pulseColor` only if still used.
- **Flash:** a border colour based on `now - latest.at < 1200`.
- **Tests in `test/files-pane.test.ts`:** rewrite the drawing tests to the new structure, keeping each old behaviour and adding:
  - **Desktop:**
    - the live row has an Svg whose alt names the file, and `isInteractive`;
    - the other rows have no Svg;
    - chips show `JSX` and `MD`;
    - pills read `editing` for the live row and `read` for others;
    - counts show `+12 −3` once a git event has landed;
    - the Right-now title, icon alt, label and branch row (`feat/pricing`, `2 changed`, or `clean`);
    - the DONE summary after the agent ends;
    - WAITING for an idle agent, set with an `agent.list` stub reporting `idle` if needed.
  - **Terminal:** no Svg; the live name is split into per-letter Texts whose colours differ across two clock times; glyph icons.
  - **Flash:** a bright border right after a touch, and the plain border after advancing 1.5 s.
  - **Budget:** 300 touches stay under the limits with `+ 200 more`, which the tests already measure.
  - All existing chevron, open, reveal, commit, worktree and Bash-scan tests still pass, adapted only for structure.

Commit: `feat: draw the Files pane in the filetree look`.

### Task 5: Final review, spec and check

- Run a whole-branch review: `0916cfc..HEAD`.
- Update `docs/2026-11-01-crew-files-pane-design.md` so its "What the user sees" and "Git info" sections match.
- Validate, and run each touched test file once.
- Commit `docs: describe the filetree look`.
- The owner runs `/reload-plugins` in a working session and checks the look live.
