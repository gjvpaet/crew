# Crew — per-agent Files pane (design)

Date: 2026-11-01
Status: design approved, not built

Each agent card in the Agents pane gets a chevron that opens a second Crew pane, **Files**, showing the tree of files that agent has read, edited and committed. The look borrows from the community filetree mod (data-goblin/claude-code-filetree, MIT): purple for read, orange for edited, green for committed, a "right now" header, and a shimmer on the file being worked on.

## Why not reuse filetree

filetree sees Claude's touches through `tool.call` hooks on Read, Edit, Write, NotebookEdit, Grep, Glob and Bash, but never reads `e.agentId`: every touch is "Claude". It also draws a whole-project tree, not one agent's files. Crew's own `tool.call` hook already gets `agentId` on every call, so the attribution and the pane are built natively in Crew. Nothing is copied from filetree; only its colour language and header idea are borrowed.

## What the user sees

### The chevron

- An agent card (Main, running or finished) that has touched at least one file shows a chevron button with the count at the right of its title row: `▸ 4`. A card with no files shows none.
- The one-line fallback row (drawn once the drawing budget is spent) shows the same chevron.
- Pressing it opens the Files pane on that agent. While the Files pane shows that agent the chevron reads `▾ 4` in the agent's accent colour.
- Pressing another card's chevron switches the Files pane to that agent.
- Pressing the lit `▾` closes the Files pane.

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

- **Header.** While the agent runs: `RIGHT NOW` and `Reading <file>` or `Editing <file>` for its latest touch, with `in <folder>`. Once it has ended: `DONE` and a summary, `edited 2, read 3` (with `committed N` when any). The legend lists the three states in their colours, leaving out committed until a commit is seen.
- **Tree.** Paths relative to the project folder, `$.session.cwd()` read at draw time. A chain of folders with one child folder each merges into one row (`src/pricing/`). Folders first, then files, each sorted by name. Files outside the project folder sit under a dim `outside project/` branch with their absolute paths shortened by `~`.
- **Rows.** A coloured dot, the file name, and the state word right-aligned: `read` (purple), `edited` (orange), `committed` (green).
- **Shimmer.** While the agent runs, its most recently touched file's name pulses in its state's colour on Crew's existing beat (the same blend as a running card's border). Text colour only, no SVG, so it draws the same on every surface.
- **Footer.** `● committed <sha>` once that agent has committed; absent before.
- **Clicking a file row** opens the file in the default app: `open <path>` on macOS, `xdg-open <path>` on Linux, `cmd /c start "" <path>` on Windows, through `$.process.run`. The platform is read once per session: `$.env.get('OS') === 'Windows_NT'` is Windows, otherwise `uname -s` (`Darwin` is macOS, anything else Linux). Clicking a folder row does nothing. A failed open shows the toast `Crew: couldn't open <name>`.
- **Empty.** If the shown agent has no entries (after `/clear` reset the model while the pane stayed open), the pane shows `No files yet.`
- **Terminal.** The same tree in text; the coloured dots and the pulsing name stand in for the Desktop look. Opened like the Agents pane: placed where the surface can place it, a toast otherwise.

## Tracking

Recorded in Crew's existing `tool.call` hook, after `next(e)`, only when the call was not denied and not an error. `e.agentId` undefined means Main.

| Tool call | Effect on the agent's entry for that file |
|---|---|
| `Read` (`file_path`) | `read`, unless the entry is already `edited` or `committed` |
| `Edit`, `Write` (`file_path`), `NotebookEdit` (`notebook_path`) | `edited`, including from `committed` |
| `Bash` whose `command` runs `git commit` and succeeds | the git check below |

Grep, Glob and other Bash commands are not tracked.

**Commit detection.** `isGitCommit(command)` is true when some `git` invocation in the command (split on `&&`, `||`, `;`, `|`) has `commit` as its subcommand, allowing global options before it (`git -C dir commit`, `git -c k=v commit`) and any flags after (`--amend`, `-am`). `git log --grep commit` and `echo git commit` are false.

**Git check.** After a successful commit command, without holding back the tool result:

1. `git status --porcelain -z -- <agent's edited paths>` in the project folder. Each edited path git does not list is clean: it becomes `committed`.
2. `git rev-parse --short HEAD` gives the SHA stored as the agent's `lastCommit`.

Both run through `$.process.run` with a 5 s timeout. Any failure leaves the files `edited` and the SHA unchanged.

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
| { kind: 'committed'; agentId?: string; paths: string[]; sha?: string }
```

**Caps.** At most 200 entries per agent: past that the oldest `read` entry goes first, then the oldest entry of any state. The pane draws at most 150 tree rows, then `+ N more`, keeping it well inside Desktop's limits (2,000 nodes, depth 32, 262,144 characters).

**Lifetime.** Entries live with the model: across prompts for the session, reset by `/clear` with everything else.

## Components

| File | Responsibility |
|---|---|
| `hooks/files.ts` (new, pure) | `applyTouch`, `applyCommitted` (state rules, caps); `fileTree(entries, root, home)` → rows `{ key, depth, guides, name, kind: 'dir' \| 'file', path?, state? }` with merged folders and the outside-project branch; `isGitCommit(command)`; `headline(entries, isRunning)` → `{ label, line }` |
| `hooks/tracker.ts` | `touch` and `committed` events delegating to `files.ts`; `EMPTY_STATE` gains `files: {}`, `lastCommit: {}` |
| `hooks/files-pane.tsx` (new) | `registerFilesPane(on)`: the `ui.render` hook for `crew-files`, `ui.close` clearing `filesFor`, `showFiles($, key)` (open, switch or close), row presses opening files, the live row's pulse |
| `hooks/view.ts` | `RowView` gains `fileCount` and `isFilesShown` |
| `hooks/panel.tsx` | the chevron button on the card's title row and the line row, pressing it calls `showFiles` |
| `hooks/register.tsx` | `tool.call` dispatches `touch` events and, for a successful commit, starts the git check and dispatches `committed`; the ticker also redraws while the Files pane shows a running agent |
| `types/index.d.ts` | `FileState`, `FileEntry`, `files`, `lastCommit`, `filesFor` |
| `README.md` | a short section on the Files pane |

## Error handling

- Every new path in `tool.call` sits inside the hook's existing `.catch(($, e, next) => next(e))`; recording a touch never fails a tool call.
- The git check runs after the result is returned and swallows its own errors.
- A failed file open shows a toast and changes nothing.

## Testing

Run one test file at a time.

- `test/files.test.ts`: read never downgrades edited or committed; an edit turns committed back to edited; the 200 cap drops oldest reads first; merged folders; folders before files; the outside-project branch with `~`; `isGitCommit` true for `git commit -m x`, `git -C a commit`, `git add . && git commit --amend`, false for `git log --grep commit`, `echo git commit`, `git commit-tree`.
- `test/tracker.test.ts`: touches attributed to a sub-agent and to Main; `committed` only affects listed paths and sets `lastCommit`.
- `test/ui.test.ts`: no chevron without files; chevron count; pressing opens `crew-files` showing that agent; another card switches it; pressing the lit chevron closes it; a row press runs the platform's open command with the absolute path (mocked `$.process`); a successful `git commit` Bash call with mocked `git status` output turns only the clean files green and shows the SHA; 300 files stay inside the drawing budget with `+ N more`; the terminal surface draws a text tree.

## Out of scope

Grep/Glob hits, Bash-parsed reads, uncommitted-change line counts, diffs, previews, a whole-project tree, and switching agents from inside the Files pane.
