# Crew — per-agent Files pane (design)

Date: 2026-11-01
Status: implemented on branch build/v0.1, awaiting live check

Each agent card in the Agents pane gets a chevron that opens a second Crew pane, **Files**, showing the tree of files that agent has read, edited and committed. The look borrows from the community filetree mod (data-goblin/claude-code-filetree, MIT): purple for read, orange for edited, green for committed, a "right now" header, and a pulse on the file being worked on.

## Why not reuse filetree

filetree sees Claude's touches through `tool.call` hooks on Read, Edit, Write, NotebookEdit, Grep, Glob and Bash, but never reads `e.agentId`: every touch is "Claude". It also draws a whole-project tree, not one agent's files. Crew's own `tool.call` hook already gets `agentId` on every call, so the attribution and the pane are built natively in Crew. Nothing is copied from filetree; only its colour language and header idea are borrowed.

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
╭──────────────────────────────────────────╮
│ ● RIGHT NOW                               │
│   Editing PriceTable.jsx  in src/pricing  │
│   ● read  ● edited  ● committed           │
╰──────────────────────────────────────────╯
TOUCHED · 3 FILES
├ src/pricing/
│ ├ ● PriceTable.jsx          edited
│ └ ● usePrices.js            read
└ test/
  └ ● PriceTable.test.jsx     committed
──────────────────────────────────────────
● committed a1c9e42
```

- **Header.** Three phases, by the agent's status:
  - **Running:** `RIGHT NOW` and `Reading`, `Editing` or `Committed <file>` for its latest touch, with `in <folder>` (relative to the project, or absolute outside it).
  - **Waiting, pending or idle:** `WAITING` with the same latest-touch line, and no pulse.
  - **Ended** (completed, failed, killed, stopped): `DONE` and a summary, `edited 2, committed 1, read 3`, with zero counts left out.
  - A live agent with no entries shows `No files yet.` as the header line. The legend lists the three states in their colours, leaving out committed until a commit is seen.
- **Tree.** Paths relative to the project folder, `$.session.cwd()` read at draw time. A chain of folders with one child folder each merges into one row (`src/pricing/`). Folders first, then files, each sorted by name. Files outside the project folder sit under a dim `outside project/` branch, last, by their absolute paths (merged like any other folders; its keys are prefixed `out:` so a project folder of that name never collides). Empty path segments are dropped. Guide lines use non-breaking spaces so a surface that trims spaces keeps the indent.
- **Rows.** A coloured dot, the file name, and the state word right-aligned: `read` (purple), `edited` (orange), `committed` (green).
- **Pulse.** While the agent runs, the dot of its most recently touched file pulses in its state's colour on Crew's existing beat, reaching the full colour at the peak on both graphical surfaces and the terminal. The name is a `Button`, whose label takes no colour, so the dot carries it. Text only, no SVG, so it draws the same on every surface.
- **Footer.** `● committed <sha>` once that agent has committed; absent before.
- **Nothing to show.** With no agent chosen, or once the chosen card is gone (dropped by a new prompt, or after `/clear`), the pane reads `Press ▸ on a card in the Agents pane to see its files.`
- **Terminal.** The same tree in text; the coloured dots stand in for the Desktop look. Opened like the Agents pane: placed where the surface can place it, a toast otherwise.

### Clicking a file row

A press must never start a program. Clicking a folder row does nothing. A file row:

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
| `Bash` whose `command` runs `git commit` and succeeds, not `run_in_background` | the git check below |

Grep, Glob and other Bash commands are not tracked.

**Commit detection.** `isGitCommit(command)` is a word-split heuristic that ignores quoting. It is true when some `git` invocation in the command (split on `&&`, `||`, `;`, `|` and newlines), after any leading `NAME=value` words and global options (`-C dir`, `-c k=v`, `--git-dir x`, `--no-pager`, …), has `commit` as its subcommand. `git log --grep commit`, `echo git commit` and `git commit-tree` are false. A false positive only costs one extra check.

**Git check.** After a successful commit command, without holding back the tool result:

1. Note the time, `checkedAt`.
2. For each distinct folder of the agent's edited files, run `rev-parse --show-cdup` there. Its top is `joinUp(folder, output)`, which keeps the path's own spelling (`/tmp` stays `/tmp`). A folder where it fails (outside any repository, deleted) is skipped. So an agent working in a git worktree or submodule is checked in that worktree, never in the session's checkout.
3. Per top: `status --porcelain -z -- <its edited paths>`. Listed paths are dirty. Of the rest, only those `ls-files -z --full-name` lists count as clean, so a file git never tracked (written then deleted, ignored or untracked) never shows as committed.
4. Only in a top with clean files: `rev-parse --short HEAD` for the SHA.
5. If nothing turned clean anywhere, nothing is dispatched: no green files, no SHA. Otherwise dispatch `committed` with `at: checkedAt`. Only entries touched at or before `checkedAt` turn committed, so an edit made while the check ran stays edited.

Every git call is `git --no-optional-locks -C <dir> …` (so it never takes `index.lock` from under the agent's next git command), through `$.process.run` with a 5 s timeout. Any failure skips that top and leaves its files `edited`.

**Known limits.**
- A file whose deletion was committed (`git rm x && git commit`) stays `edited`: git no longer tracks it.
- With clean files in several repositories, the SHA of the last one checked is shown.
- The check covers the committing agent's own edited files only: when Main commits a sub-agent's edits, the sub-agent's files stay `edited`.

## State

Additions to `CrewState` (`types/index.d.ts`):

```ts
export type FileState = 'read' | 'edited' | 'committed'
export type FileEntry = { path: string; state: FileState; at: number }

// in CrewState
files: Record<string, FileEntry[]>      // keyed like agentTasks: agent id, or 'main'
lastCommit: Record<string, string>      // same keys, short SHA
```

Paths are stored absolute (POSIX separators); the pane makes them relative when drawing.

A new atom `filesFor` (`string | null`, plugin `crew`) holds the agent key the Files pane shows, declared in `PluginState`.

New tracker events, reduced by the same `reduce()`:

```ts
| { kind: 'touch'; at: number; agentId?: string; path: string; touch: 'read' | 'edit' }
| { kind: 'committed'; agentId?: string; at?: number; paths: string[]; sha?: string }
```

A `committed` event that changes nothing returns the same state object.

**Caps.** At most 200 entries per agent: past that the oldest `read` entry goes first, then the oldest entry of any state, never the entry just touched. The pane draws at most 150 tree rows, then `+ N more`, keeping it well inside Desktop's limits (2,000 nodes, depth 32, 262,144 characters).

**Lifetime.** Entries go with their cards. A new person prompt keeps the files of sub-agents still at work and drops the rest, Main's included (Main's card starts afresh each prompt). A turn no person started, and a resumed sub-agent, keep theirs. `/clear` resets them with the model. State saved before this feature gets `files` and `lastCommit` from `EMPTY_STATE`.

## Components

| File | Responsibility |
|---|---|
| `hooks/files.ts` (new, pure) | `applyTouch`, `applyCommitted` (state rules, caps, the `until` guard); `latestOf`; `touchOf`; `posix`; `dirname`; `fileTree(entries, root)` → rows (`dir` or `file`, each with `key`, `prefix` guides and `name`) with merged folders and the outside-project branch; `headline(entries, status, root)` → `{ label, line, where }` (label `RIGHT NOW`, `WAITING` or `DONE`); `isGitCommit(command)`; `dirtyPaths(porcelainZ)`; `joinUp(dir, cdup)`; `openCommand(platform, path, isExecutable)` |
| `hooks/tracker.ts` | `touch` and `committed` events delegating to `files.ts`; `EMPTY_STATE` gains `files: {}`, `lastCommit: {}`; a new prompt drops files with their cards |
| `hooks/files-pane.tsx` (new) | `registerFilesPane(on)`: the `ui.render` hook for `crew-files`, `ui.close` (matched on its id) clearing `filesFor`, `showFiles($, key)` (open, switch or close), the platform check and the safe `openFile`, the live row's pulse |
| `hooks/view.ts` | `RowView` gains `fileCount` and `isFilesShown`; exports `agentAccent`, `pulseAt`, `GRAPHICAL_REST_ALPHA` |
| `hooks/panel.tsx` | the chevron button on the card's title row and the line row; pressing it calls `showFiles` |
| `hooks/register.tsx` | `tool.call` dispatches `touch` events and, for a finished commit, runs `checkCommit` and dispatches `committed`; registers the Files pane. The existing ticker already redraws every `ui.render` hook while an agent runs, so the pulse needs no change |
| `types/index.d.ts` | `FileState`, `FileEntry`, `files`, `lastCommit`, `filesFor` |
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
  - **Tree:** merged folders; folders before files; the outside-project branch last, with `out:` keys; empty segments; roots `/` and `/repo/`.
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
    - the tree, states and colours on desktop and terminal;
    - the live dot's full colour at the pulse peak;
    - `WAITING` and `DONE` headers;
    - 300 files stay inside the drawing budget (nodes, characters, depth) with `+ N more`.
  - **Clicking a file:**
    - open, and a failed open;
    - reveal by executable bit, by symlink, and when the check fails.
  - **Commits:**
    - a commit turns only clean, tracked files green and shows the SHA;
    - a worktree is checked in itself;
    - a written-then-deleted file stays edited;
    - no check, a failed check, or nothing clean stamps nothing.
  - **Untested:** the kit cannot fire a user close, so the `ui.close` hook is untested.

## Out of scope

Grep/Glob hits, Bash-parsed reads, uncommitted-change line counts, diffs, previews, a whole-project tree, and switching agents from inside the Files pane.
