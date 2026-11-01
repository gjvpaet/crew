# Crew — per-agent Files pane (design)

Date: 2026-11-01
Status: implemented on branch build/v0.1, awaiting live check

Each agent card in the Agents pane gets a chevron that opens a second Crew pane, **Files**, listing the files that agent has read, edited and committed. The look follows the filetree segment of the video that introduced the community filetree mod (data-goblin/claude-code-filetree, MIT): purple for read, orange for edited, green for committed, a Right-now card, a Touched card, and a shine on the file being worked on. The cards in that video are not in the filetree repository; Crew's are its own.

## Why not reuse filetree

filetree sees Claude's touches through `tool.call` hooks on Read, Edit, Write, NotebookEdit, Grep, Glob and Bash, but never reads `e.agentId`: every touch is "Claude". It also draws a whole-project tree, not one agent's files. Crew's own `tool.call` hook already gets `agentId` on every call, so the attribution and the pane are built natively in Crew. Nothing is copied from filetree; only its colour language is borrowed, and the cards follow the video's look.

## What the user sees

### The chevron

- An agent card (Main, running or finished) that has touched at least one file shows a chevron button with the count at the right of its title row: `▸ 4`. A card with no files shows none.
- The one-line fallback row (drawn once the drawing budget is spent) shows the same chevron.
- Pressing it opens the Files pane on that agent. While the Files pane shows that agent the chevron reads `▾ 4` at full brightness; the others stay dimmed. (`Button` takes no colour, so brightness is the highlight.)
- Pressing another card's chevron switches the Files pane to that agent.
- Pressing the lit `▾` closes the Files pane.
- If no surface can place the pane (or the open fails), the chevron stays unlit and a toast says the Files pane has no room here.

### The Files pane

Pane id `crew-files`, title `Files · <agent title>`.

```
╭───────────────────────────────────────────────╮  ← bright for 1.2 s after a new touch
│ (✎)  RIGHT NOW                                │
│      Editing PriceTable.jsx                   │
│      src/pricing  +12 −3                      │
│ ⎇ feat/pricing                +14 −3 · 2 changed│
│ ● read   ● edited   ● committed               │
╰───────────────────────────────────────────────╯
╭ TOUCHED                                3 FILES ╮
│ ╭ JSX  PriceTable.jsx ↗ src/pricing +12 −3 editing ╮ │ ← live row: outlined, name shines
│   JS   usePrices.js    src/pricing        read     │
│   JSX  PriceTable.test.jsx  test     +2 committed  │
╰───────────────────────────────────────────────╯
● committed a1c9e42
```

**Right-now card.**
- **Phase and label,** from the agent's status:
  - running: `RIGHT NOW`;
  - pending, waiting or idle: `WAITING`;
  - completed, failed, killed or stopped: `DONE`.
- **Label colour:** the live file's state colour; amber for WAITING; the dominant state's colour when DONE (edited, then committed, then read).
- **Icon:** a 36 px tinted circle, an SVG on graphical surfaces and a coloured glyph in the terminal (`◉ ✎ ✓ ‖`):
  - eye, pencil or check for the live file's state while running;
  - pause while waiting, and for a running agent with no files yet;
  - check when done.
- **Title and subtitle:**
  - running or waiting: the title is `Reading`, `Editing` or `Committed <name>` of the latest touch, and the subtitle is its folder (relative, absolute outside the project, empty at the root) and its non-zero counts (`+12 −3`, Unicode minus);
  - done: the title is `Edited 2 files` / `Read 1 file` / `Committed 3 files`, naming the dominant state, and the subtitle is the summary `edited 2, committed 1, read 3`;
  - no entries: the title is `No files yet`.
- **Branch row:** shown when git info for the latest touch's repository is known. The branch name (or `detached`) with a branch glyph, then the agent's total `+A −D` and `· N changed`, or `clean`. There is no divider line above it: the elements have no top-only border.
- **Legend:** committed appears once a commit is seen.
- **Flash:** the card's border is bright (`#E8E6DF`) while the latest touch is under 1,200 ms old. Crew's clock keeps redrawing until it fades, even with nothing else running.

**Touched card.**
- **Header row:** `TOUCHED` and `N FILE(S)`.
- **Rows:** a flat list, newest touch first, at most 100 rows, then `+ N more`.
- **Each row:**
  - a type chip: the upper-cased extension, at most 4 letters, or `FILE`. Dotfiles count only when known (`.env` gives `ENV`). The colour by kind: code is amber, docs blue, data green, other gray.
  - the name, semibold;
  - the folder, dim (`.` at the root, absolute outside the project);
  - non-zero `+A` (green) and `−D` (red);
  - a pill: `reading`, `editing` or `committed` on the live row, and `read`, `edited` or `committed` elsewhere, in purple, orange or green. Pills and chips are text spans with a tinted background.
- **Live row:** the latest touch while the agent runs. It gets a round border in its state colour, tinted on graphical surfaces.
  - On graphical surfaces its name is an animated SVG (`shineSvg`, `isInteractive`): a light band sweeps across the letters every 1.6 s. Since a Button cannot hold an SVG, a small `↗` Button beside the name opens the file.
  - In the terminal the name is the Button. Each letter is coloured by `shineColors`, a 3-letter band of the state colour blended 60% toward white, stepping one letter per 200 ms redraw. Names under 4 letters stay plain.
- **Other rows:** the name is the Button that opens the file.

**Footer.** `● committed <sha>` once that agent has committed; absent before.

**Nothing to show.** With no agent chosen, or once the chosen card is gone (dropped by a new prompt, or after `/clear`), the pane reads `Press ▸ on a card in the Agents pane to see its files.`

**Terminal.** The same cards in text: glyph icons, the per-letter shine and solid-colour pills. Opened like the Agents pane: placed where the surface can place it, a toast otherwise.

### Clicking a file row

A press must never start a program. Pressing a file (its name, or the live row's `↗`):

1. **Refuses** a path that is not absolute (`/…`, or a drive letter on Windows): the toast `Crew: couldn't open <name>`.
2. **Reveals the file in its folder instead of opening it** when opening would run something:
   - by extension, per platform (case-insensitive; on Windows after stripping trailing dots and spaces, which Windows ignores). For example `.app .command .tool .terminal .jar` on macOS, `.exe .bat .cmd .ps1 .vbs .js .msi .lnk .url .reg` and more on Windows, and `.desktop .sh .run .appimage .jar` on Linux.
   - on macOS and Linux, when `test -x <path> -o -L <path>` succeeds: an executable bit (an extensionless script like `gradlew`), or a symlink, which the opener would treat as its target's type (`README.md -> x.terminal`). A check that cannot run counts as a yes.
   - A reveal shows the toast `Crew: showed <name> in its folder rather than running it`.
3. **Otherwise opens it** in the default app.

| Platform | Open | Reveal |
|---|---|---|
| macOS | `open <path>` | `open -R <path>` |
| Linux | `xdg-open <path>` | `xdg-open <folder>` |
| Windows | `explorer <path>` (never `cmd /c start`, which re-reads `& \| ^ %VAR%` in a name) | `explorer <folder>`; a path with a comma (which explorer splits on) is shown by its folder, or refused if the folder has one too |

The platform is read once per module and only a real answer is cached: `$.env.get('OS') === 'Windows_NT'` is Windows, otherwise `uname -s` (exit 0 and `Darwin` is macOS, else Linux). Explorer's exit code is ignored (it returns 1 on success); any other non-zero exit shows the "couldn't open" toast.

## Tracking

Recorded in Crew's existing `tool.call` hook, after `next(e)`, only when the call was not denied and not an error. `e.agentId` undefined means Main.

| Tool call | Effect on the agent's entry for that file |
|---|---|
| `Read` (`file_path`) | `read`, unless the entry is already `edited` or `committed` |
| `Edit`, `Write` (`file_path`), `NotebookEdit` (`notebook_path`) | `edited`, including from `committed` |
| Any foreground `Bash` command the engine doesn't mark read-only | each file it changed: `edited` (the Bash scan below) |
| `Bash` (by any agent) whose `command` runs `git commit` and succeeds, not `run_in_background` | the git check below, over every agent's files |

Grep and Glob hits and reads through `cat` or `sed -n` are not tracked.

**Bash scan.** Agents often edit through Bash (`sed -i`, a heredoc'd script, `cat >`), which the file tools never see.
1. **Marker:** before a foreground Bash call, Crew makes a marker file with `mktemp -t crew-mark.XXXXXX` (a template GNU accepts; macOS takes it as a prefix). If that fails, it skips the scan; it never delays or blocks the command.
2. **Afterwards, in the background,** unless the call was denied or the engine marked it read-only (`isReadOnly`, as for `ls`):
   - **Directory:** a leading `cd <path>` (`&&`, `;` or a newline after it; `~` and relative paths resolved) is where the command worked; otherwise the session folder.
   - **Repository only:** the repository top comes from `rev-parse --show-cdup`. Outside a repository nothing is scanned, since that could be the home folder.
   - **Scan:** `find <top> ( -name .git -o -name node_modules -o … ) -prune -o -type f -newer <marker> -print0`, 5 s, pruning `.git node_modules .next .nuxt .svelte-kit dist build out coverage .turbo .cache .parcel-cache .venv venv __pycache__ target .gradle .idea`.
   - **Ignored files:** paths git ignores (`check-ignore -z --stdin`) are dropped. More than 100 left means an install or a build, so nothing is recorded.
   - **Record:** each remaining file becomes an `edited` touch for the agent that ran the command.
   - **Clean up:** the marker is always removed.
3. **Commit check:** for a command that also commits, the git check runs after the scan, so the files it just changed can turn green.

**Commit detection.** `isGitCommit(command)` is a word-split heuristic that ignores quoting. It is true when some `git` invocation in the command (split on `&&`, `||`, `;`, `|` and newlines), after any leading `NAME=value` words and global options (`-C dir`, `-c k=v`, `--git-dir x`, `--no-pager`, …), has `commit` as its subcommand. `git log --grep commit`, `echo git commit` and `git commit-tree` are false. A false positive only costs one extra check.

**Git check.** After a successful commit command by any agent, without holding back the tool result, Crew checks the edited files of **every** agent, not only the committer's: Main often commits its sub-agents' work.

1. Note the time, `checkedAt`.
2. For each distinct folder of all agents' edited files (each path once), run `rev-parse --show-cdup` there. Its top is `joinUp(folder, output)`, which keeps the path's own spelling (`/tmp` stays `/tmp`). A folder where it fails (outside any repository, deleted) is skipped. So an agent working in a git worktree or submodule is checked in that worktree, never in the session's checkout.
3. Per top: `status --porcelain -z -- <its edited paths>`. Listed paths are dirty. Of the rest, only those `ls-files -z --full-name` lists count as clean, so a file git never tracked (written then deleted, ignored or untracked) never shows as committed.
4. Only in a top with clean files: `rev-parse --short HEAD` for the SHA.
5. Each agent with clean files gets its own `committed` event: its clean paths, the SHA of its last clean path's repository, and `at: checkedAt`. An agent with nothing clean gets no event, so no SHA. Only entries touched at or before `checkedAt` turn committed, so an edit made while the check ran stays edited.

Every git call is `git --no-optional-locks -C <dir> …` (so it never takes `index.lock` from under the agent's next git command), through `$.process.run` with a 5 s timeout. Any failure skips that top and leaves its files `edited`.

**Known limits.**
- The Bash scan attributes every file changed in the repository while the command ran to the agent that ran it, so a write by another agent, a dev server or an editor in that window lands on it too. On a filesystem with 1-second timestamps, a file written in the same second as the marker is missed. Deleted files are not seen.
- A file whose deletion was committed (`git rm x && git commit`) stays `edited`: git no longer tracks it.
- With an agent's clean files in several repositories, the SHA of its last clean path's repository is shown.

## Git info

Drawn counts and the branch row come from state that git fills in the background; drawing never runs git.

- **`refreshGit($, paths)`** (in register.tsx):
  1. Groups the paths by repository top. A module-level folder → top cache means each folder's `rev-parse --show-cdup` runs once; the Bash scan and the commit check pass their known tops straight through.
  2. Per top, runs `diff --numstat -z HEAD -- <paths>` (a path not listed means `[0, 0]`; binary `-` means 0), then `symbolic-ref --short -q HEAD` (a failure means detached), then `status --porcelain -z`, counting entries with `dirtyPaths`.
  3. Dispatches one `git` event per top.
- **Debounce:** one run in flight per top, plus one queued run holding the union of paths. A failure skips that top.
- **Triggers:** after an edit touch, from a file tool or the Bash scan, for that agent's edited and committed paths; and after the commit check, for the paths it marked.
- **Known limits:** a new untracked file shows no counts until git tracks it (`diff HEAD` doesn't list it), a repository with no commits gives nothing, and the answer can be one edit behind. The folder → top cache lasts the session (it clears on `session.start` and on reload), so a folder that becomes a repository mid-session isn't seen as one until then.

## State

Additions to `CrewState` (`types/index.d.ts`):

```ts
export type FileState = 'read' | 'edited' | 'committed'
export type FileEntry = { path: string; state: FileState; at: number }

// in CrewState
files: Record<string, FileEntry[]>      // keyed like agentTasks: agent id, or 'main'
lastCommit: Record<string, string>      // same keys, short SHA
lines: Record<string, [number, number]> // absolute path → [added, removed] vs HEAD
repos: Record<string, { branch: string | null; changed: number }> // repository top → branch, dirty count
```

Paths are stored absolute (POSIX separators); the pane makes them relative when drawing.

A new atom `filesFor` (`string | null`, plugin `crew`) holds the agent key the Files pane shows, declared in `PluginState`.

New tracker events, reduced by the same `reduce()`:

```ts
| { kind: 'touch'; at: number; agentId?: string; path: string; touch: 'read' | 'edit' }
| { kind: 'committed'; agentId?: string; at?: number; paths: string[]; sha?: string }
| { kind: 'git'; lines: Record<string, [number, number]>; repos: Record<string, { branch: string | null; changed: number }> }
```

The `git` event merges `repos` and merges `lines`, deleting `[0, 0]` entries.

A `committed` event that changes nothing returns the same state object.

**Caps.** At most 200 entries per agent: past that the oldest `read` entry goes first, then the oldest entry of any state, never the entry just touched. The pane draws at most 100 rows, then `+ N more`, keeping it well inside Desktop's limits (2,000 nodes, depth 32, 262,144 characters).

**Lifetime.** Entries go with their cards. A new person prompt keeps the files of sub-agents still at work and drops the rest, Main's included (Main's card starts afresh each prompt). A turn no person started, and a resumed sub-agent, keep theirs. A new prompt also prunes `lines` to the paths still listed. `/clear` resets everything with the model. State saved before this feature gets `files` and `lastCommit` from `EMPTY_STATE`.

## Components

| File | Responsibility |
|---|---|
| `hooks/files.ts` (new, pure) | `applyTouch`, `applyCommitted` (state rules, caps, the `until` guard); `latestOf`; `touchOf`; `posix`; `dirname`; `chipOf(path)`; `touchedRows(entries, root, status, lines)` → the flat Touched rows, newest first; `rightNow(entries, status, root, lines, repos)` → the card's label, tone, icon, title, subtitle, totals and repository; `countsText`; `shineColors(text, now, base, bright)` for the terminal shine; `numstat(stdout)`; `isGitCommit(command)`; `dirtyPaths(porcelainZ)`; `joinUp(dir, cdup)`; `openCommand(platform, path, isExecutable)`; `cdTarget(command, home)`, `changedFiles(stdout, cap, ignored)`, `SCAN_PRUNE` for the Bash scan |
| `hooks/tracker.ts` | `touch` and `committed` events delegating to `files.ts`; `EMPTY_STATE` gains `files: {}`, `lastCommit: {}`; a new prompt drops files with their cards |
| `hooks/files-pane.tsx` (new) | `registerFilesPane(on)`: the `ui.render` hook for `crew-files`, `ui.close` (matched on its id) clearing `filesFor`, `showFiles($, key)` (open, switch or close), the platform check and the safe `openFile`, the Right-now card, the Touched card, the live row (SVG shine and `↗` open on graphical surfaces, per-letter shine in the terminal) and the footer |
| `hooks/view.ts` | `RowView` gains `fileCount` and `isFilesShown`; keeps `PULSE` and `pulseColor` for the Agents pane |
| `hooks/panel.tsx` | the chevron button on the card's title row and the line row; pressing it calls `showFiles` |
| `hooks/register.tsx` | `tool.call` dispatches `touch` events, marks and scans foreground Bash calls for the files they changed, and, for a finished commit by any agent, runs `checkCommit` over every agent's edited files and dispatches one `committed` per agent with clean files; `refreshGit` (with its per-top debounce and folder → top cache) for the git info; registers the Files pane. The ticker redraws while an agent runs (the terminal shine) and while a flash is fading |
| `hooks/svg.ts` | `shineSvg` (the live name with a sweeping band, CSS keyframes, hashed ids) and `iconSvg` (eye, pencil, check, pause, branch) |
| `types/index.d.ts` | `FileState`, `FileEntry`, `files`, `lastCommit`, `lines`, `repos`, `filesFor` |
| `scripts/test-one.sh` (new) | runs only the named test files, from a scratch copy of the mod |

## Error handling

- Every new path in `tool.call` runs after `next(e)`; if Crew's bookkeeping throws, the hook's `.catch(($, e, next) => next(e))` replays the call's result, so a tool never fails or runs twice because of Crew.
- The git check runs after the result is returned and swallows its own errors.
- A failed open shows a toast and changes nothing; a failed executable check reveals rather than opens; a reveal shows a toast.

## Testing

Run one test file at a time (`scripts/test-one.sh <file>`).

- `test/files.test.ts`:
  - **File states:** read never downgrades edited or committed; an edit turns committed back to edited.
  - **Cap:** the 200 cap drops the oldest reads first and never the entry just touched.
  - **Rows and card:** `chipOf` tones, dotfiles and long extensions; `touchedRows` order, live row, folders and counts; `rightNow` phases, icons, empty cases, dominant state and `repoTop`; `shineColors`; `numstat` (binary, renames, tabs in names).
  - **Headline:** all three phases.
  - **`isGitCommit`:**
    - true: env prefixes, global options, `&&`, `||`, `|`, newlines, `--git-dir=`;
    - false: `git log --grep commit`, `echo git commit`, `git commit-tree`.
  - **Git output:** `dirtyPaths` with renames and copies in either column; `joinUp`.
  - **`openCommand`:** per platform, including the reveal rules, refused paths, Windows commas and trailing dots.
  - **Card rows:** the file-count fields.
- `test/tracker.test.ts`:
  - touches attributed to a sub-agent and to Main;
  - `committed` only affects listed paths, sets `lastCommit`, and respects `at`;
  - no-op commits return the same state;
  - lifetime across a new prompt, a turn no person started, and a resume;
  - state saved before files existed.
- `test/files-pane.test.ts`:
  - **Chevron:**
    - none without files;
    - failed calls and searches don't count;
    - Main's own files appear on Main's card;
    - the terminal draws the chevron too;
    - pressing opens, switches and closes the pane;
    - an unplaced pane leaves it unlit.
  - **Pane content:**
    - the how-to message with no agent, or a dropped one;
    - the live row: an `isInteractive` shine SVG with `↗` on desktop, per-letter colours in the terminal; chips and pills; `+/−` counts and the branch row (`clean`, `detached`) once git answers; RIGHT NOW, WAITING and DONE; the flash fading even with nothing running;
    - `WAITING` and `DONE` headers;
    - 300 files stay inside the drawing budget (nodes, characters, depth) with `+ N more`.
  - **Clicking a file:**
    - open, and a failed open;
    - reveal by executable bit, by symlink, and when the check fails.
  - **Bash scan:** a heredoc'd script's edits recorded; no leading cd uses the session folder; a relative cd; outside a repository nothing is scanned; past 100 files nothing is recorded; ignored files dropped (and kept when check-ignore exits 1, fails or throws); background and read-only commands not scanned; a failed `mktemp` never stops the command; a failed command still scanned; edit-and-commit turns its files green.
  - **Commits:**
    - a commit turns only clean, tracked files green and shows the SHA;
    - Main committing turns a sub-agent's clean files green too, with the SHA in both panes, and leaves another agent's dirty file edited;
    - a worktree is checked in itself;
    - a written-then-deleted file stays edited;
    - no check, a failed check, or nothing clean stamps nothing.
  - **Untested:** the kit cannot fire a user close, so the `ui.close` hook is untested.

## Out of scope

Grep/Glob hits, reads through Bash, diffs, previews, a whole-project tree, and switching agents from inside the Files pane.
