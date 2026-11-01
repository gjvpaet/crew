# Crew Files Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each agent card in Crew's Agents pane gets a `▸ N` chevron that opens a second pane, **Files**, listing the files that agent read, edited and committed as a nested tree.

**Architecture:** Crew's existing `tool.call` hook files each Read/Edit/Write/NotebookEdit under the calling agent (`e.agentId`, or Main) as a new `touch` tracker event. After a successful `git commit` it asks git which of the agent's edited files are clean and sends a `committed` event. All the rules live in a new pure module, `hooks/files.ts`. A new `hooks/files-pane.tsx` draws the `crew-files` pane and opens files. `hooks/panel.tsx` draws the chevron.

**Tech Stack:** Claude Code mods (TypeScript ES modules loaded directly by the engine, no build), `claude-code/testing` under `claude plugin test`, Claude Code 2.1.309.

**Spec:** `docs/2026-11-01-crew-files-pane-design.md`

---

## Ground rules for every task

- **Repo:** `/Users/gabpaet/Documents/Applications/claude-mods/crew`, branch `build/v0.1`. Commit straight onto it. Never push, tag or merge.
- **Git on this machine:** `~/.gitconfig` is broken, so every git command is prefixed with `GIT_CONFIG_GLOBAL=/dev/null`. Commits use the author `Gabriel Joshua Paet <gjvpaet@gmail.com>` and carry **no** `Co-Authored-By` line:

  ```bash
  GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "<message>"
  ```

- **Tests run one file at a time** through `scripts/test-one.sh <file>` (Task 0). Never run the whole suite unless a step says so. The owner's machine bogs down otherwise.
- **Style:** tabs, no semicolons, single quotes, comments only where the *why* isn't obvious, written as plain sentences like the surrounding code.
- **The engine's state scan** follows `$.state` refs only through `atom(...)` consts in the same file. Every `.tsx` that reads an atom declares its own copy. Helpers that take `$` are top-level `function` declarations.
- **Kit facts:**
  - `ui.find({ key })` returns the node with that `key`, and `.text` gives its shown text (a Button's label).
  - `ui.press({ key })` presses a Button.
  - `on('<event>', stub)` in a test answers an engine call (`session.cwd`, `process.run`, `ui.open`, …).
  - `console.log` output goes to stderr.
- **If the kit or `claude plugin validate` rejects a shape**, read the error, fix the code, and carry on. The engine types sit at `.claude-plugin/types/claude-code/index.d.ts` once the mod has loaded.

## File map

| File | Status | Responsibility |
|---|---|---|
| `scripts/test-one.sh` | create | run chosen test files in a scratch copy of the mod |
| `types/index.d.ts` | modify | `FileState`, `FileEntry`, `CrewState.files`, `CrewState.lastCommit`, `PluginState.crew.filesFor` |
| `hooks/files.ts` | create | pure rules: touch/commit state, caps, tree rows, headline, commit detection, porcelain parsing |
| `hooks/tracker.ts` | modify | `touch` and `committed` events; files dropped with their cards on a new prompt |
| `hooks/view.ts` | modify | `RowView.fileCount`, `RowView.isFilesShown`, `PanelOptions.filesFor`; export `pulseAt`, `agentAccent` |
| `hooks/files-pane.tsx` | create | the `crew-files` pane, `showFiles`, opening files |
| `hooks/panel.tsx` | modify | the chevron on the card and the one-line row |
| `hooks/register.tsx` | modify | record touches, run the git check, register the Files pane |
| `test/files.test.ts` | create | pure tests for `files.ts` and the row fields |
| `test/tracker.test.ts` | modify | the new events |
| `test/files-pane.test.ts` | create | chevron, pane, tree, open, commit, budget |

---

### Task 0: One-file test runner

**Files:**
- Create: `scripts/test-one.sh`

`claude plugin test` only takes a folder and runs every test in it. This script copies the mod with just the named test files into a scratch folder and runs those.

- [ ] **Step 1: Write the script**

```sh
#!/bin/sh
# `claude plugin test` runs every test under a folder; this runs only the named files, from a scratch copy of the mod.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cp -R "$here/.claude-plugin" "$here/hooks" "$here/types" "$dir/"
[ -d "$here/skills" ] && cp -R "$here/skills" "$dir/"
mkdir "$dir/test"
for file in "$@"; do cp "$here/test/$file" "$dir/test/"; done
~/.bun/bin/bun x claude plugin test "$dir"
```

- [ ] **Step 2: Make it executable and try it on a small existing test**

Run: `chmod +x scripts/test-one.sh && scripts/test-one.sh roles.test.ts`
Expected: the roles tests pass, and no other test file runs.

- [ ] **Step 3: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add scripts/test-one.sh
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "chore: run one test file at a time"
```

---

### Task 1: Types and the pure file rules

**Files:**
- Modify: `types/index.d.ts`
- Create: `hooks/files.ts`
- Test: `test/files.test.ts`

- [ ] **Step 1: Add the types**

In `types/index.d.ts`, after the `TaskItem` type, add:

```ts
export type FileState = 'read' | 'edited' | 'committed'

// A file an agent touched, by absolute POSIX path; `at` is its latest touch.
export type FileEntry = { path: string; state: FileState; at: number }
```

In `CrewState`, after `nextColor: number`, add:

```ts
	// The files each agent read and edited, keyed like agentTasks: an agent id, or 'main'.
	files: Record<string, FileEntry[]>
	// The short SHA of each agent's latest commit, same keys.
	lastCommit: Record<string, string>
```

In `PluginState.crew`, after `groupOpen: Record<string, boolean>`, add:

```ts
			// The agent whose files the Files pane shows, or null with none chosen.
			filesFor: string | null
```

- [ ] **Step 2: Write the failing tests**

Create `test/files.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import type { FileEntry } from '../types'
import {
	MAX_FILES,
	applyCommitted,
	applyTouch,
	dirtyPaths,
	fileTree,
	headline,
	isGitCommit,
	latestOf,
	posix,
	touchOf
} from '../hooks/files'

const NB = '\u00a0'
const entry = (path: string, state: FileEntry['state'], at = 1): FileEntry => ({ path, state, at })

test('a read adds a file as read and never takes one back from edited or committed', () => {
	const read = applyTouch([], '/r/a.js', 'read', 1)
	expect(read).toEqual([entry('/r/a.js', 'read', 1)])
	const edited = applyTouch(read, '/r/a.js', 'edit', 2)
	expect(edited).toEqual([entry('/r/a.js', 'edited', 2)])
	expect(applyTouch(edited, '/r/a.js', 'read', 3)).toEqual([entry('/r/a.js', 'edited', 3)])
	expect(applyTouch([entry('/r/a.js', 'committed')], '/r/a.js', 'read', 4)).toEqual([entry('/r/a.js', 'committed', 4)])
})

test('an edit turns a committed file back to edited, and every touch makes its file the latest', () => {
	const list = applyTouch([entry('/r/a.js', 'committed', 1), entry('/r/b.js', 'read', 2)], '/r/a.js', 'edit', 3)
	expect(list.map(item => [item.path, item.state])).toEqual([
		['/r/b.js', 'read'],
		['/r/a.js', 'edited']
	])
	expect(latestOf(list)?.path).toBe('/r/a.js')
	expect(latestOf([])).toBeUndefined()
})

test('past the cap the oldest read goes first, then the oldest of any state', () => {
	const start = [entry('/r/e1', 'edited', 1), entry('/r/r1', 'read', 2), entry('/r/r2', 'read', 3)]
	expect(applyTouch(start, '/r/n', 'read', 4, 3).map(item => item.path)).toEqual(['/r/e1', '/r/r2', '/r/n'])
	const edits = [entry('/r/e1', 'edited', 1), entry('/r/e2', 'edited', 2)]
	expect(applyTouch(edits, '/r/e3', 'edit', 3, 2).map(item => item.path)).toEqual(['/r/e2', '/r/e3'])
	expect(MAX_FILES).toBe(200)
})

test('a commit turns only the listed edited files committed', () => {
	const list = [entry('/r/a', 'edited'), entry('/r/b', 'edited'), entry('/r/c', 'read')]
	expect(applyCommitted(list, ['/r/a', '/r/c']).map(item => item.state)).toEqual(['committed', 'edited', 'read'])
})

test('only Read, Edit, Write and NotebookEdit touch files', () => {
	expect(touchOf('Read')).toBe('read')
	expect(touchOf('Edit')).toBe('edit')
	expect(touchOf('Write')).toBe('edit')
	expect(touchOf('NotebookEdit')).toBe('edit')
	expect(touchOf('Grep')).toBeNull()
	expect(touchOf('toString')).toBeNull()
	expect(posix('C:\\repo\\a.js')).toBe('C:/repo/a.js')
})

test('a git commit is spotted through global options and chains, and nothing else is', () => {
	for (const command of [
		'git commit -m x',
		'git -C app commit -am x',
		'git add . && git commit --amend',
		'git -c user.email=a@b commit -m x',
		'cd x; git --no-pager commit'
	])
		expect(isGitCommit(command)).toBe(true)
	for (const command of ['git log --grep commit', 'echo git commit', 'git commit-tree abc', 'git status', 'npm run commit'])
		expect(isGitCommit(command)).toBe(false)
})

test('git status -z output gives the dirty paths, skipping a rename’s old name', () => {
	expect([...dirtyPaths(' M src/a.js\0?? new.txt\0R  b.js\0old-b.js\0')]).toEqual(['src/a.js', 'new.txt', 'b.js'])
	expect(dirtyPaths('').size).toBe(0)
})

test('the tree merges single-folder chains, lists folders before files and puts outside files last', () => {
	const rows = fileTree(
		[
			entry('/repo/src/pricing/usePrices.js', 'read'),
			entry('/repo/README.md', 'read'),
			entry('/repo/src/pricing/PriceTable.jsx', 'edited'),
			entry('/repo/test/PriceTable.test.jsx', 'committed'),
			entry('/Users/me/notes.md', 'read')
		],
		'/repo'
	)
	expect(rows.map(row => [row.prefix, row.name, row.kind === 'file' ? row.state : 'dir'])).toEqual([
		['├', 'src/pricing/', 'dir'],
		[`│${NB}├`, 'PriceTable.jsx', 'edited'],
		[`│${NB}└`, 'usePrices.js', 'read'],
		['├', 'test/', 'dir'],
		[`│${NB}└`, 'PriceTable.test.jsx', 'committed'],
		['├', 'README.md', 'read'],
		['└', 'outside project/', 'dir'],
		[`${NB}${NB}└`, 'Users/me/', 'dir'],
		[`${NB}${NB}${NB}${NB}└`, 'notes.md', 'read']
	])
	expect(rows[1]).toEqual({
		kind: 'file',
		key: 'file:/repo/src/pricing/PriceTable.jsx',
		prefix: `│${NB}├`,
		name: 'PriceTable.jsx',
		path: '/repo/src/pricing/PriceTable.jsx',
		state: 'edited'
	})
	expect(rows[0]).toEqual({ kind: 'dir', key: 'dir:/src/pricing', prefix: '├', name: 'src/pricing/' })
	expect(rows[6]).toMatchObject({ kind: 'dir', isOutside: true })
	expect(fileTree([], '/repo')).toEqual([])
})

test('the headline names the live file while the agent runs and sums the files once it is done', () => {
	const list = [
		entry('/repo/src/a.js', 'edited', 1),
		entry('/repo/b.js', 'read', 2),
		entry('/repo/c.js', 'committed', 3),
		entry('/repo/src/d.js', 'read', 4)
	]
	expect(headline(list, true, '/repo')).toEqual({ label: 'RIGHT NOW', line: 'Reading d.js', where: 'src' })
	expect(headline([entry('/repo/x.js', 'edited', 1)], true, '/repo')).toEqual({ label: 'RIGHT NOW', line: 'Editing x.js', where: '' })
	expect(headline([entry('/elsewhere/y.md', 'read', 1)], true, '/repo')).toEqual({
		label: 'RIGHT NOW',
		line: 'Reading y.md',
		where: '/elsewhere'
	})
	expect(headline(list, false, '/repo')).toEqual({ label: 'DONE', line: 'edited 1, committed 1, read 2', where: '' })
	expect(headline([], false, '/repo').line).toBe('No files yet.')
	expect(headline([], true, '/repo').line).toBe('No files yet.')
})
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `scripts/test-one.sh files.test.ts`
Expected: FAIL, because `../hooks/files` cannot be found.

- [ ] **Step 4: Write `hooks/files.ts`**

```ts
import type { FileEntry, FileState } from '../types'

// Past this many files an agent's list drops its oldest reads first, then its oldest files of any kind.
export const MAX_FILES = 200

export type Touch = 'read' | 'edit'

const TOUCHES: Record<string, Touch> = { Read: 'read', Edit: 'edit', Write: 'edit', NotebookEdit: 'edit' }

export const touchOf = (tool: string): Touch | null =>
	Object.prototype.hasOwnProperty.call(TOUCHES, tool) ? TOUCHES[tool] : null

export const posix = (path: string) => path.replace(/\\/g, '/')

// A read never takes a file back from edited or committed; an edit always makes it edited, a committed file included.
// The touched file moves to the end, so the list runs oldest to latest.
export function applyTouch(
	entries: readonly FileEntry[],
	path: string,
	touch: Touch,
	at: number,
	cap = MAX_FILES
): FileEntry[] {
	const found = entries.find(item => item.path === path)
	const state: FileState = touch === 'edit' ? 'edited' : (found?.state ?? 'read')
	const next = [...entries.filter(item => item.path !== path), { path, state, at }]
	while (next.length > cap) {
		const reads = next.filter(item => item.state === 'read')
		const pool = reads.length > 0 ? reads : next
		const oldest = pool.reduce((a, b) => (b.at < a.at ? b : a))
		next.splice(next.indexOf(oldest), 1)
	}
	return next
}

export function applyCommitted(entries: readonly FileEntry[], paths: readonly string[]): FileEntry[] {
	const clean = new Set(paths)
	return entries.map(item => (item.state === 'edited' && clean.has(item.path) ? { ...item, state: 'committed' as const } : item))
}

export const latestOf = (entries: readonly FileEntry[]) =>
	entries.reduce<FileEntry | undefined>((latest, item) => (!latest || item.at >= latest.at ? item : latest), undefined)

// Global options that take the next word as their value, so the word after them is still not the subcommand.
const VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

// True when some git command in the line, past its global options, has `commit` as its subcommand.
export function isGitCommit(command: string): boolean {
	return command.split(/&&|\|\||[;|\n]/).some(part => {
		const words = part.trim().split(/\s+/)
		if (words[0] !== 'git') return false
		let at = 1
		while (at < words.length && words[at].startsWith('-')) at += VALUED.has(words[at]) ? 2 : 1
		return words[at] === 'commit'
	})
}

// `git status --porcelain -z`: `XY path` entries split by NUL, a rename or copy followed by its old path.
export function dirtyPaths(porcelainZ: string): Set<string> {
	const tokens = porcelainZ.split('\0')
	const dirty = new Set<string>()
	for (let at = 0; at < tokens.length; at++) {
		const token = tokens[at]
		if (token.length < 4) continue
		dirty.add(token.slice(3))
		if (token[0] === 'R' || token[0] === 'C') at++
	}
	return dirty
}

const isInside = (root: string, path: string) => root !== '' && path.startsWith(root.endsWith('/') ? root : `${root}/`)
const relativeTo = (root: string, path: string) => path.slice(root.replace(/\/$/, '').length + 1)
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const dirname = (path: string) => (path.lastIndexOf('/') < 0 ? '' : path.slice(0, path.lastIndexOf('/')))

export type Headline = { label: 'RIGHT NOW' | 'DONE'; line: string; where: string }

const VERBS: Record<FileState, string> = { read: 'Reading', edited: 'Editing', committed: 'Committed' }

// While the agent runs: what it touched last and where. Once it has ended: how many files of each kind.
export function headline(entries: readonly FileEntry[], isRunning: boolean, root: string): Headline {
	if (isRunning) {
		const live = latestOf(entries)
		if (!live) return { label: 'RIGHT NOW', line: 'No files yet.', where: '' }
		const shown = isInside(root, live.path) ? relativeTo(root, live.path) : live.path
		return { label: 'RIGHT NOW', line: `${VERBS[live.state]} ${basename(shown)}`, where: dirname(shown) }
	}
	const counts = (['edited', 'committed', 'read'] as const)
		.map(state => [state, entries.filter(item => item.state === state).length] as const)
		.filter(([, count]) => count > 0)
		.map(([state, count]) => `${state} ${count}`)
	return { label: 'DONE', line: counts.length > 0 ? counts.join(', ') : 'No files yet.', where: '' }
}

export type TreeRow =
	| { kind: 'dir'; key: string; prefix: string; name: string; isOutside?: true }
	| { kind: 'file'; key: string; prefix: string; name: string; path: string; state: FileState }

type Node = { name: string; dirs: Map<string, Node>; files: FileEntry[]; isOutside: boolean }

const newNode = (name: string, isOutside: boolean): Node => ({ name, dirs: new Map(), files: [], isOutside })

function place(top: Node, segments: string[], item: FileEntry) {
	let node = top
	for (const segment of segments.slice(0, -1)) {
		let next = node.dirs.get(segment)
		if (!next) {
			next = newNode(segment, node.isOutside)
			node.dirs.set(segment, next)
		}
		node = next
	}
	node.files.push(item)
}

// A folder holding nothing but one folder merges with it into one row: `src/pricing/`.
function merged(node: Node): { name: string; node: Node } {
	let name = node.name
	let at = node
	while (at.files.length === 0 && at.dirs.size === 1) {
		const [only] = at.dirs.values()
		name = `${name}/${only.name}`
		at = only
	}
	return { name, node: at }
}

// Non-breaking, so a surface that trims spaces still keeps the tree's indent.
const NB = '\u00a0'

// The agent's files as tree rows, relative to the project folder: folders then files, each by name, with files
// outside the project under a last `outside project/` branch. `prefix` holds the guide lines to draw before the row.
export function fileTree(entries: readonly FileEntry[], root: string): TreeRow[] {
	const top = newNode('', false)
	const outside = newNode('outside project', true)
	for (const item of entries) {
		if (isInside(root, item.path)) place(top, relativeTo(root, item.path).split('/'), item)
		else place(outside, item.path.split('/').filter(Boolean), item)
	}
	const hasOutside = outside.files.length > 0 || outside.dirs.size > 0
	const rows: TreeRow[] = []
	const walk = (node: Node, guides: string, keyPath: string) => {
		const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
		const files = [...node.files].sort((a, b) => basename(a.path).localeCompare(basename(b.path)))
		// Folders, then files, then (at the top only) the outside branch, so it always comes last.
		const children: Array<{ dir: Node } | { file: FileEntry }> = [
			...dirs.map(dir => ({ dir })),
			...files.map(file => ({ file })),
			...(node === top && hasOutside ? [{ dir: outside }] : [])
		]
		children.forEach((child, index) => {
			const isLast = index === children.length - 1
			const prefix = `${guides}${isLast ? '└' : '├'}`
			if ('file' in child) {
				const { path, state } = child.file
				rows.push({ kind: 'file', key: `file:${path}`, prefix, name: basename(path), path, state })
				return
			}
			// The outside branch keeps its own name: merging it into the folders under it would hide what it is.
			const { name, node: inner } = child.dir === outside ? { name: outside.name, node: outside } : merged(child.dir)
			const path = `${keyPath}/${name}`
			rows.push({ kind: 'dir', key: `dir:${path}`, prefix, name: `${name}/`, ...(child.dir.isOutside ? { isOutside: true as const } : {}) })
			walk(inner, `${guides}${isLast ? NB : '│'}${NB}`, path)
		})
	}
	walk(top, '', '')
	return rows
}
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `scripts/test-one.sh files.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add types/index.d.ts hooks/files.ts test/files.test.ts
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "feat: add the rules for each agent's files"
```

---

### Task 2: Tracker events

**Files:**
- Modify: `hooks/tracker.ts`
- Test: `test/tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/tracker.test.ts`. It already defines `run`, `START` (a turn plus spawns of `a1`, `a2`, `a3`) and imports `MAIN`.

```ts
test('touches are filed under their agent, or Main without one', () => {
	const state = run([
		...START,
		{ kind: 'touch', at: 3000, agentId: 'a1', path: '/repo/a.js', touch: 'read' },
		{ kind: 'touch', at: 3100, agentId: 'a1', path: '/repo/a.js', touch: 'edit' },
		{ kind: 'touch', at: 3200, path: '/repo/README.md', touch: 'read' }
	])
	expect(state.files.a1).toEqual([{ path: '/repo/a.js', state: 'edited', at: 3100 }])
	expect(state.files[MAIN]).toEqual([{ path: '/repo/README.md', state: 'read', at: 3200 }])
})

test('a commit marks only the listed files and keeps the SHA', () => {
	const state = run([
		...START,
		{ kind: 'touch', at: 3000, agentId: 'a1', path: '/repo/a.js', touch: 'edit' },
		{ kind: 'touch', at: 3100, agentId: 'a1', path: '/repo/b.js', touch: 'edit' },
		{ kind: 'committed', agentId: 'a1', paths: ['/repo/a.js'], sha: 'a1c9e42' }
	])
	expect(state.files.a1.map(item => item.state)).toEqual(['committed', 'edited'])
	expect(state.lastCommit.a1).toBe('a1c9e42')
	// No SHA and no files: nothing is written.
	const quiet = run([...START, { kind: 'committed', agentId: 'a2', paths: [] }])
	expect(quiet.lastCommit).toEqual({})
	expect(quiet.files).toEqual({})
})

test('a new prompt keeps the files of agents still at work and drops the rest with their cards', () => {
	const state = run([
		...START,
		{ kind: 'touch', at: 3000, agentId: 'a1', path: '/repo/a.js', touch: 'read' },
		{ kind: 'touch', at: 3000, agentId: 'a2', path: '/repo/b.js', touch: 'read' },
		{ kind: 'touch', at: 3000, path: '/repo/c.js', touch: 'read' },
		{ kind: 'committed', agentId: 'a2', paths: [], sha: 'abc1234' },
		{ kind: 'turnEnd', at: 4000, agentId: 'a2', isAborted: false, reason: 'answer' },
		{ kind: 'turnStart', at: 5000, turnId: 't2', text: 'Next thing' }
	])
	expect(Object.keys(state.files)).toEqual(['a1'])
	expect(state.lastCommit).toEqual({})
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `scripts/test-one.sh tracker.test.ts`
Expected: the three new tests FAIL (`state.files` is undefined). The older tests still pass.

- [ ] **Step 3: Implement**

In `hooks/tracker.ts`:

1. Extend the import: `import { applyCommitted, applyTouch, type Touch } from './files'`.
2. In `EMPTY_STATE`, after `nextColor: 0`, add `files: {},` and `lastCommit: {}` (watch the commas).
3. Add to the `CrewEvent` union, after the `statuses` line:

```ts
	| { kind: 'touch'; at: number; agentId?: string; path: string; touch: Touch }
	| { kind: 'committed'; agentId?: string; paths: string[]; sha?: string }
```

4. In `startTurn`, in the object returned for a new person prompt (the one that sets `agentTasks: Object.fromEntries(...)`), add after `agentTasks`:

```ts
		// Files go with their cards: kept for agents still at work, dropped with the rest and with Main's last prompt.
		files: Object.fromEntries(Object.entries(state.files).filter(([id]) => id in carried)),
		lastCommit: Object.fromEntries(Object.entries(state.lastCommit).filter(([id]) => id in carried)),
```

5. Add these functions above `reduce`:

```ts
function addTouch(state: CrewState, ev: Extract<CrewEvent, { kind: 'touch' }>): CrewState {
	const key = ev.agentId ?? MAIN
	return { ...state, files: { ...state.files, [key]: applyTouch(state.files[key] ?? [], ev.path, ev.touch, ev.at) } }
}

function markCommitted(state: CrewState, ev: Extract<CrewEvent, { kind: 'committed' }>): CrewState {
	const key = ev.agentId ?? MAIN
	const list = state.files[key]
	return {
		...state,
		...(list ? { files: { ...state.files, [key]: applyCommitted(list, ev.paths) } } : {}),
		...(ev.sha ? { lastCommit: { ...state.lastCommit, [key]: ev.sha } } : {})
	}
}
```

6. In `reduce`'s `switch`, add:

```ts
		case 'touch':
			return addTouch(s, ev)
		case 'committed':
			return markCommitted(s, ev)
```

`reduce` already fills in keys missing from older saved state (its `isCurrent` check reads `EMPTY_STATE`'s keys), so a session saved before this change picks up `files` and `lastCommit` by itself.

- [ ] **Step 4: Run the tests and see them pass**

Run: `scripts/test-one.sh tracker.test.ts`
Expected: PASS, the whole file. If an older test spells out a full state object and now misses `files`/`lastCommit`, add `files: {}, lastCommit: {}` to that expectation, and nothing else.

- [ ] **Step 5: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add hooks/tracker.ts test/tracker.test.ts
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "feat: track the files each agent touches"
```

---

### Task 3: Row fields in the view

**Files:**
- Modify: `hooks/view.ts`
- Test: `test/files.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/files.test.ts`, and add these imports at the top of the file, under the existing ones:

```ts
import { EMPTY_STATE, reduce, type CrewEvent } from '../hooks/tracker'
import { agentAccent, panelView, pulseAt, ACCENTS } from '../hooks/view'
```

```ts
test('a card row carries its file count and whether the Files pane shows it', () => {
	const events: CrewEvent[] = [
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build it' },
		{ kind: 'spawn', at: 1500, agentId: 'a1', description: 'Implement', subagentType: 'general-purpose' },
		{ kind: 'touch', at: 2000, agentId: 'a1', path: '/repo/a.js', touch: 'read' },
		{ kind: 'touch', at: 2100, agentId: 'a1', path: '/repo/b.js', touch: 'edit' }
	]
	const state = events.reduce(reduce, EMPTY_STATE)
	const shown = panelView(state, {}, 3000, 20, {}, { filesFor: 'a1' })
	expect(shown.groups[0].rows[0]).toMatchObject({ fileCount: 2, isFilesShown: true })
	expect(shown.main).toMatchObject({ fileCount: 0, isFilesShown: false })
	expect(panelView(state, {}, 3000, 20, {}).groups[0].rows[0].isFilesShown).toBe(false)
	expect(agentAccent(state, 'a1')).toBe(ACCENTS[0])
	expect(agentAccent(state, 'gone')).toBe(agentAccent(state, 'main'))
	expect(pulseAt(1000)).toBeCloseTo(0.55)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `scripts/test-one.sh files.test.ts`
Expected: FAIL. `agentAccent` and `pulseAt` are not exported, and `fileCount` is missing.

- [ ] **Step 3: Implement**

In `hooks/view.ts`:

1. In `RowView`, after `pulse: number | null`, add:

```ts
	// How many files the agent touched, and whether the Files pane shows them: the card's chevron.
	fileCount: number
	isFilesShown: boolean
```

2. Change `const pulseAt = …` to `export const pulseAt = …`.
3. Under `accentOf`, add:

```ts
// The colour of an agent's card by its key, Main's blue for one no longer listed.
export const agentAccent = (state: CrewState, id: string) => {
	const agent = state.agents[id]
	return agent ? accentOf(agent, state) : PALETTE.body
}
```

4. Change `export type PanelOptions = { sprites?: boolean }` to:

```ts
export type PanelOptions = { sprites?: boolean; filesFor?: string | null }
```

5. In `rowView`'s returned object, after `pulse: …,`, add:

```ts
		// `?.`: a model saved before files were tracked has no `files` until its next event.
		fileCount: state.files?.[agent.id]?.length ?? 0,
		isFilesShown: options.filesFor === agent.id,
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `scripts/test-one.sh files.test.ts`, then `scripts/test-one.sh view.test.ts`
Expected: both PASS. If a `view.test.ts` expectation lists a whole `RowView` with `toEqual`, add `fileCount: 0, isFilesShown: false` to it.

- [ ] **Step 5: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add hooks/view.ts test/files.test.ts
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "feat: give each card row its file count"
```

---

### Task 4: Record touches and draw the chevron

**Files:**
- Create: `hooks/files-pane.tsx` (only `showFiles` and the atom for now; the pane comes in Task 5)
- Modify: `hooks/register.tsx`, `hooks/panel.tsx`
- Test: `test/files-pane.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/files-pane.test.ts`:

```ts
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
	plugin: 'crew',
	component: 'Pane',
	requestId: 'crew',
	props: {
		title: 'Agents',
		isFocused: false,
		bodyColumns: 48,
		placement: 'dock',
		scroll: { offset: 0, bodyRows: 40 },
		view: {}
	}
} as const

const FILES = { ...PANE, requestId: 'crew-files', props: { ...PANE.props, title: 'Files' } } as const

type Options = {
	// `process.run` answers by the start of the joined argv.
	stdout?: Record<string, string>
	exits?: Record<string, number>
	// A tool call on a path containing this fails, as Read does on a missing file.
	failing?: string
}

const answer = (table: Record<string, string | number> | undefined, argv: string[]) =>
	Object.entries(table ?? {}).find(([prefix]) => argv.join(' ').startsWith(prefix))?.[1]

async function start($: any, on: any, options: Options = {}) {
	const clock = mock.clock(on, { now: 1000 })
	mock.store(on)
	const opened: Array<{ id: string; title: string }> = []
	const closed: string[] = []
	const ran: string[][] = []
	const toasts: string[] = []
	on('command.register', () => ({ value: { command: 'crew' } }))
	on('tool.register', () => ({ value: { tool: 'mcp__crew__set_mascot' } }))
	on('ui.open', (_: unknown, e: any) => {
		opened.push({ id: e.id, title: e.title })
		return { value: { isPlaced: true } }
	})
	on('ui.close', (_: unknown, e: any) => {
		closed.push(e.id)
		return { value: undefined }
	})
	on('ui.toast', (_: unknown, e: any) => {
		toasts.push(JSON.stringify(e))
		return { value: undefined }
	})
	on('session.cwd', () => ({ value: '/repo' }))
	on('env.get', () => ({ value: undefined }))
	on('process.run', (_: unknown, e: any) => {
		const argv: string[] = [...e.argv]
		ran.push(argv)
		const stdout = String(answer(options.stdout, argv) ?? '')
		const exitCode = Number(answer(options.exits, argv) ?? 0)
		return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
	})
	on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
	on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
	on('turn.complete', () => ({ text: '' }))
	on('tool.call', (_: unknown, e: any) =>
		options.failing && String(e.file_path ?? '').includes(options.failing)
			? { result: 'File does not exist.', isError: true }
			: { result: {} }
	)
	on('agent.spawn', (_: unknown, e: any) => ({
		model: 'claude-opus-5-5',
		agentId: e.description.startsWith('Implement') ? 'a1' : 'a2'
	}))
	on('ui.render', (_$: any, e: any) => {
		const { Box } = _$.ui.resolve(e)
		return h(Box, null)
	})
	await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
	await $.turn.start({ text: 'Build the pricing page', turnId: 't1' })
	await $.agent.spawn({ prompt: 'go', description: 'Implement the price table', subagentType: 'general-purpose' })
	await $.agent.spawn({ prompt: 'go', description: 'Research competitor pricing', subagentType: 'Explore' })
	return { clock, opened, closed, ran, toasts }
}

const read = (path: string, agentId?: string) => ({ tool: 'Read', file_path: path, ...(agentId ? { agentId } : {}) }) as any
const edit = (path: string, agentId?: string) =>
	({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) }) as any

test('a card shows a chevron with its file count once its agent touches a file', async ($, on) => {
	await start($, on, { failing: 'missing' })
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect(await ui.find({ key: 'files-a1' })).toBeUndefined()
	await $.tool.call(read('/repo/src/pricing/usePrices.js', 'a1'))
	await $.tool.call(edit('/repo/src/pricing/PriceTable.jsx', 'a1'))
	await $.tool.call(read('/repo/src/pricing/usePrices.js', 'a1'))
	// A failed call touched nothing.
	await $.tool.call(read('/repo/missing.js', 'a1'))
	// Search hits are not touches.
	await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'a1' } as any)
	const chevron = await ui.find({ key: 'files-a1' })
	expect(chevron?.text).toBe('▸ 2')
	expect(chevron?.props.dimColor).toBe(true)
	expect(await ui.find({ key: 'files-a2' })).toBeUndefined()
	// Main's own reads land on Main's card.
	await $.tool.call(read('/repo/README.md'))
	expect((await ui.find({ key: 'files-main' }))?.text).toBe('▸ 1')
	await ui.unmount()
})

test('the terminal card draws the same chevron', async ($, on) => {
	await start($, on)
	await $.tool.call(read('/repo/a.js', 'a1'))
	const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
	expect((await ui.find({ key: 'files-a1' }))?.text).toBe('▸ 1')
	await ui.unmount()
})

test('the chevron opens the Files pane on its agent, switches it and closes it', async ($, on) => {
	const { opened, closed } = await start($, on)
	await $.tool.call(read('/repo/a.js', 'a1'))
	await $.tool.call(read('/repo/b.js', 'a2'))
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await ui.press({ key: 'files-a1' })
	expect(opened.at(-1)).toEqual({ id: 'crew-files', title: 'Files · Implement the price table' })
	expect((await ui.find({ key: 'files-a1' }))?.text).toBe('▾ 1')
	expect((await ui.find({ key: 'files-a1' }))?.props.dimColor).toBeUndefined()
	await ui.press({ key: 'files-a2' })
	expect(opened.at(-1)).toEqual({ id: 'crew-files', title: 'Files · Research competitor pricing' })
	expect((await ui.find({ key: 'files-a1' }))?.text).toBe('▸ 1')
	expect((await ui.find({ key: 'files-a2' }))?.text).toBe('▾ 1')
	await ui.press({ key: 'files-a2' })
	expect(closed).toEqual(['crew-files'])
	expect((await ui.find({ key: 'files-a2' }))?.text).toBe('▸ 1')
	await ui.unmount()
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `scripts/test-one.sh files-pane.test.ts`
Expected: FAIL, because `files-a1` is never found.

- [ ] **Step 3: Create `hooks/files-pane.tsx` with `showFiles`**

```tsx
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { EMPTY_STATE } from './tracker'

export const FILES_PANE = 'crew-files'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const filesFor = atom({ plugin: 'crew', key: 'filesFor' } as const, null as string | null)

const titleOf = (description: string | undefined) => `Files · ${description ?? 'Agent'}`

// A card's chevron: opens the Files pane on its agent, switches it from another one, or closes it when it shows
// this one already.
export async function showFiles($: EngineInterface, key: string) {
	if ((await read($, filesFor)) === key) {
		await update($, filesFor, () => null)
		await $.ui.close({ id: FILES_PANE }).catch(() => undefined)
		return
	}
	await update($, filesFor, () => key)
	const agent = (await read($, model)).agents[key]
	const opened = await $.ui.open({ id: FILES_PANE, title: titleOf(agent?.description) })
	if (!opened.isPlaced) $.ui.toast('Crew: the Files pane has no room here')
}
```

- [ ] **Step 4: Record touches in `hooks/register.tsx`**

1. Change the tracker import to `import { EMPTY_STATE, MAIN, isPulsing, isTicking, reduce, type CrewEvent } from './tracker'`.
2. Add `import { dirtyPaths, isGitCommit, posix, touchOf } from './files'`.
3. Above `export const register`, add:

```ts
// What an agent reads and edits, for its Files pane; a commit it makes is checked against git once the call returns.
async function recordFiles($: EngineInterface, tool: string, input: Record<string, unknown>, agentId: string | undefined) {
	const touch = touchOf(tool)
	const path =
		typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
	if (touch && path) {
		await apply($, { kind: 'touch', at: await $.clock.now(), agentId, path: posix(path), touch })
		return
	}
	if (tool === 'Bash' && typeof input.command === 'string' && isGitCommit(input.command)) {
		void checkCommit($, agentId).catch(() => undefined)
	}
}

const GIT_MS = 5_000

// Which of the agent's edited files git now holds clean: those turn committed, with the commit's short SHA. Paths
// outside the repository are left out, since git refuses a status that names one.
async function checkCommit($: EngineInterface, agentId: string | undefined) {
	const files = (await read($, model)).files?.[agentId ?? MAIN] ?? []
	const edited = files.filter(item => item.state === 'edited').map(item => item.path)
	if (edited.length === 0) return
	const cwd = posix(await $.session.cwd())
	const top = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_MS })
	if (top.exitCode !== 0) return
	const root = posix(top.stdout.trim())
	const inRepo = edited.filter(path => path.startsWith(`${root}/`))
	if (inRepo.length === 0) return
	const status = await $.process.run(['git', '-C', cwd, 'status', '--porcelain', '-z', '--', ...inRepo], { timeoutMs: GIT_MS })
	if (status.exitCode !== 0) return
	const dirty = new Set([...dirtyPaths(status.stdout)].map(path => `${root}/${path}`))
	const head = await $.process.run(['git', '-C', cwd, 'rev-parse', '--short', 'HEAD'], { timeoutMs: GIT_MS })
	await apply($, {
		kind: 'committed',
		agentId,
		paths: inRepo.filter(path => !dirty.has(path)),
		...(head.exitCode === 0 ? { sha: head.stdout.trim() } : {})
	})
}
```

4. In the `tool.call` hook, replace:

```ts
		const ran = await next(e)
		if (TASK_TOOLS.has(tool) && ran.deny === undefined && ran.isError !== true) {
			await apply($, { kind: 'tasks', agentId: e.agentId, call: { tool, input: toolInput(e), result: ran.result } })
		}
		return ran
```

with:

```ts
		const ran = await next(e)
		if (ran.deny === undefined && ran.isError !== true) {
			const input = toolInput(e)
			if (TASK_TOOLS.has(tool)) await apply($, { kind: 'tasks', agentId: e.agentId, call: { tool, input, result: ran.result } })
			await recordFiles($, tool, input, e.agentId)
		}
		return ran
```

The git check is tested in Task 6. It is written here because it shares this hook.

- [ ] **Step 5: Draw the chevron in `hooks/panel.tsx`**

1. Add imports: `import { showFiles } from './files-pane'`.
2. Under the other atoms, add:

```ts
const filesFor = atom({ plugin: 'crew', key: 'filesFor' } as const, null as string | null)
```

3. In the `ui.render` hook, after `const open = await read($, groupOpen)`, add `const shownFiles = await read($, filesFor)`, and change the `panelView(...)` call's last argument to `{ sprites: !Svg, filesFor: shownFiles }`.
4. Under `barAlt`, add a module-level helper for the button's props:

```ts
// The chevron that opens an agent's files: bright while the Files pane shows that agent, dimmed otherwise.
const chevronProps = (row: RowView) => ({
	plain: true,
	...(row.isFilesShown ? {} : { dimColor: true }),
	label: `${row.isFilesShown ? '▾' : '▸'} ${row.fileCount}`
})
```

5. In `agentCard`, the title row is:

```tsx
					<Box flexDirection="row" gap={1}>
						{/* The title gives way first; Main's waiting note keeps its width beside it. */}
						<Box flexShrink={1}>
```

Change the title Box to `<Box flexShrink={1} flexGrow={1}>`, so the chevron sits at the row's right end. After the `{row.waiting && (…)}` block, still inside the title row, add:

```tsx
						{row.fileCount > 0 && (
							<Box flexShrink={0}>
								<Button key={`files-${row.id}`} {...chevronProps(row)} onPress={() => showFiles($, row.id)} />
							</Box>
						)}
```

6. In `lineRow`, after the title's `<Box flexGrow={1} width={0}>…</Box>`, add:

```tsx
				{row.fileCount > 0 && (
					<Button key={`files-${row.id}`} {...chevronProps(row)} onPress={() => showFiles($, row.id)} />
				)}
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `scripts/test-one.sh files-pane.test.ts`
Expected: PASS, 3 tests.

Then run: `scripts/test-one.sh ui.test.ts`
Expected: PASS. The Agents pane tests are unchanged.

- [ ] **Step 7: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add hooks/files-pane.tsx hooks/register.tsx hooks/panel.tsx test/files-pane.test.ts
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "feat: show a chevron on cards whose agent touched files"
```

---

### Task 5: The Files pane

**Files:**
- Modify: `hooks/files-pane.tsx`, `hooks/register.tsx`
- Test: `test/files-pane.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/files-pane.test.ts`:

```ts
const NB = '\u00a0'

test('before any card is chosen the Files pane says how to fill it', async ($, on) => {
	await start($, on)
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect((await files.find({ type: 'Text', text: /Press ▸/ }))?.text).toBe('Press ▸ on a card in the Agents pane to see its files.')
	await files.unmount()
})

test('the Files pane draws a nested tree with merged folders and each file state', async ($, on) => {
	await start($, on)
	await $.tool.call(read('/repo/src/pricing/usePrices.js', 'a1'))
	await $.tool.call({ tool: 'Write', file_path: '/repo/test/PriceTable.test.jsx', content: 'x', agentId: 'a1' } as any)
	await $.tool.call(edit('/repo/src/pricing/PriceTable.jsx', 'a1'))
	await $.tool.call(read('/Users/me/notes.md', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	for (const surface of ['desktop', 'terminal'] as const) {
		const files = await $.ui.mount({ ...FILES, surface })
		expect((await files.find({ type: 'Text', text: /^RIGHT NOW$/ }))?.text).toBe('RIGHT NOW')
		expect((await files.find({ type: 'Text', text: /^Reading notes\.md$/ }))?.text).toBe('Reading notes.md')
		expect((await files.find({ type: 'Text', text: /^in / }))?.text).toBe('in /Users/me')
		expect((await files.find({ type: 'Text', text: /TOUCHED/ }))?.text).toBe('TOUCHED · 4 FILES')
		expect((await files.find({ key: 'name-dir:/src/pricing' }))?.text).toBe('src/pricing/')
		expect((await files.find({ key: 'guide-file:/repo/src/pricing/usePrices.js' }))?.text).toBe(`│${NB}└`)
		expect((await files.find({ key: 'open-/repo/src/pricing/PriceTable.jsx' }))?.text).toBe('PriceTable.jsx')
		const state = await files.find({ key: 'state-/repo/src/pricing/PriceTable.jsx' })
		expect(state?.text).toBe('edited')
		expect(state?.props.color).toBe('#F0883E')
		expect((await files.find({ key: 'state-/repo/src/pricing/usePrices.js' }))?.props.color).toBe('#A371F7')
		expect((await files.find({ key: 'name-out:/outside project' }))?.props.dimColor).toBe(true)
		// No commit yet: the legend leaves committed out, and there is no footer.
		expect(await files.find({ key: 'legend-committed' })).toBeUndefined()
		expect(await files.find({ type: 'Text', text: /^committed / })).toBeUndefined()
		expect(await files.findAll({ type: 'Svg' })).toHaveLength(0)
		await files.unmount()
	}
	await pane.unmount()
})

test('the live file’s dot pulses while its agent runs, and the header sums up once it is done', async ($, on) => {
	const { clock } = await start($, on)
	await $.tool.call(read('/repo/a.js', 'a1'))
	await $.tool.call(edit('/repo/b.js', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	const first = (await files.find({ key: 'dot-/repo/b.js' }))?.props.color
	await clock.advance(500)
	const second = (await files.find({ key: 'dot-/repo/b.js' }))?.props.color
	expect(first).not.toBe(second)
	// Only the live file pulses.
	expect((await files.find({ key: 'dot-/repo/a.js' }))?.props.color).toBe('#A371F7')
	await $.turn.complete({ turnId: 'x', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	expect((await files.find({ type: 'Text', text: /^DONE$/ }))?.text).toBe('DONE')
	expect((await files.find({ type: 'Text', text: /^edited 1, read 1$/ }))?.text).toBe('edited 1, read 1')
	expect((await files.find({ key: 'dot-/repo/b.js' }))?.props.color).toBe('#F0883E')
	await files.unmount()
	await pane.unmount()
})

test('closing the Files pane lets the chevron open it again', async ($, on) => {
	const { opened } = await start($, on)
	await $.tool.call(read('/repo/a.js', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	await $.ui.close({ id: 'crew-files', origin: { kind: 'user' } } as any)
	expect((await pane.find({ key: 'files-a1' }))?.text).toBe('▸ 1')
	await pane.press({ key: 'files-a1' })
	expect(opened.filter(item => item.id === 'crew-files')).toHaveLength(2)
	await pane.unmount()
})

test('a long file list stays inside the drawing budget with a count of the rest', async ($, on) => {
	await start($, on)
	for (let i = 0; i < 300; i++) await $.tool.call(read(`/repo/src/f${String(i).padStart(3, '0')}.js`, 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await pane.find({ key: 'files-a1' }))?.text).toBe('▸ 200')
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	// 150 rows: the src/ folder and 149 of its 200 files.
	expect(await files.findAll({ type: 'Button' })).toHaveLength(149)
	expect((await files.find({ type: 'Text', text: /more$/ }))?.text).toBe('+ 51 more')
	await files.unmount()
	await pane.unmount()
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `scripts/test-one.sh files-pane.test.ts`
Expected: the five new tests FAIL, because nothing draws `crew-files`. The Task 4 tests still pass.

- [ ] **Step 3: Draw the pane**

Replace `hooks/files-pane.tsx` with:

```tsx
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { FileState } from '../types'
import { fileTree, headline, latestOf, posix, type TreeRow } from './files'
import { EMPTY_STATE } from './tracker'
import { agentAccent, pulseAt, pulseColor } from './view'

export const FILES_PANE = 'crew-files'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const filesFor = atom({ plugin: 'crew', key: 'filesFor' } as const, null as string | null)

// The community filetree mod's colours: purple for a read, orange for an edit, green once committed.
export const STATE_COLORS: Record<FileState, string> = { read: '#A371F7', edited: '#F0883E', committed: '#3FB950' }

// Past this many rows the tree stops with a count, keeping the pane well inside what Desktop will draw.
export const MAX_ROWS = 150

// Added to the card pulse so the live dot never fades past readable; at the pulse's peak it is the full colour.
const PULSE_FLOOR = 0.25

const titleOf = (description: string | undefined) => `Files · ${description ?? 'Agent'}`

// A card's chevron: opens the Files pane on its agent, switches it from another one, or closes it when it shows
// this one already.
export async function showFiles($: EngineInterface, key: string) {
	if ((await read($, filesFor)) === key) {
		await update($, filesFor, () => null)
		await $.ui.close({ id: FILES_PANE }).catch(() => undefined)
		return
	}
	await update($, filesFor, () => key)
	const agent = (await read($, model)).agents[key]
	const opened = await $.ui.open({ id: FILES_PANE, title: titleOf(agent?.description) })
	if (!opened.isPlaced) $.ui.toast('Crew: the Files pane has no room here')
}

type Platform = 'darwin' | 'linux' | 'win32'

let platform: Promise<Platform> | null = null

// Read once a session: Windows names itself in OS; elsewhere uname tells macOS from Linux.
function osName($: EngineInterface): Promise<Platform> {
	platform ??= (async () => {
		try {
			if ((await $.env.get('OS')) === 'Windows_NT') return 'win32'
			const uname = await $.process.run(['uname', '-s'], { timeoutMs: 3_000 })
			return uname.stdout.trim() === 'Darwin' ? 'darwin' : 'linux'
		} catch {
			return 'linux'
		}
	})()
	return platform
}

const OPENERS: Record<Platform, (path: string) => string[]> = {
	darwin: path => ['open', path],
	linux: path => ['xdg-open', path],
	win32: path => ['cmd', '/c', 'start', '', path]
}

// A file row opens its file in the default app; a failure is only a toast.
async function openFile($: EngineInterface, path: string) {
	try {
		const ran = await $.process.run(OPENERS[await osName($)](path), { timeoutMs: 5_000 })
		if (ran.exitCode === 0) return
	} catch {
		// Falls through to the toast.
	}
	$.ui.toast(`Crew: couldn't open ${path.slice(path.lastIndexOf('/') + 1)}`)
}

export function registerFilesPane(on: On) {
	on('ui.close', async ($, e, next) => {
		const closed = await next(e)
		// Gone with an unload, the pane comes back with the module, still showing the same agent.
		if (e.id === FILES_PANE && e.origin.kind !== 'unload') await update($, filesFor, () => null)
		return closed
	})

	on('ui.render', { component: 'Pane', requestId: FILES_PANE }, async ($, e) => {
		const { Box, Button, Text } = $.ui.resolve(e)
		const key = await read($, filesFor)
		if (!key) {
			return (
				<Box>
					<Text dimColor>Press ▸ on a card in the Agents pane to see its files.</Text>
				</Box>
			)
		}
		const state = await read($, model)
		// `?.`: a model saved before files were tracked has neither until its next event.
		const entries = state.files?.[key] ?? []
		const sha = state.lastCommit?.[key]
		const isRunning = state.agents[key]?.status === 'running'
		const root = posix(await $.session.cwd())
		const now = await $.clock.now()
		const head = headline(entries, isRunning, root)
		const rows = fileTree(entries, root)
		const live = isRunning ? latestOf(entries)?.path : undefined
		const surface = e.surface === 'terminal' ? 'terminal' : 'graphical'
		const legend: FileState[] = entries.some(item => item.state === 'committed')
			? ['read', 'edited', 'committed']
			: ['read', 'edited']

		const dotColor = (path: string, fileState: FileState) =>
			path === live ? pulseColor(STATE_COLORS[fileState], PULSE_FLOOR + pulseAt(now), surface) : STATE_COLORS[fileState]

		const treeRow = (row: TreeRow) => (
			<Box key={row.key} flexDirection="row" gap={1}>
				<Text key={`guide-${row.key}`} dimColor mono>
					{row.prefix}
				</Text>
				{row.kind === 'dir' ? (
					<Text key={`name-${row.key}`} {...(row.isOutside ? { dimColor: true } : {})} wrap="truncate-end">
						{row.name}
					</Text>
				) : (
					[
						<Text key={`dot-${row.path}`} color={dotColor(row.path, row.state)}>
							●
						</Text>,
						// width 0 + flexGrow 1: the name takes what the dot and the state word leave.
						<Box key={`cell-${row.path}`} flexGrow={1} width={0}>
							<Button key={`open-${row.path}`} plain label={row.name} onPress={() => openFile($, row.path)} />
						</Box>,
						<Text key={`state-${row.path}`} color={STATE_COLORS[row.state]}>
							{row.state}
						</Text>
					]
				)}
			</Box>
		)

		return (
			<Box flexDirection="column">
				<Box key="head" flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
					<Box flexDirection="row" gap={1}>
						<Text color={agentAccent(state, key)}>●</Text>
						<Text dimColor size="caption">
							{head.label}
						</Text>
					</Box>
					<Text weight="semibold" wrap="truncate-end">
						{head.line}
					</Text>
					{head.where && (
						<Text dimColor wrap="truncate-end">
							{`in ${head.where}`}
						</Text>
					)}
					<Box flexDirection="row" gap={2}>
						{legend.map(fileState => (
							<Text key={`legend-${fileState}`} color={STATE_COLORS[fileState]}>
								{`● ${fileState}`}
							</Text>
						))}
					</Box>
				</Box>
				{entries.length > 0 && (
					<Text key="touched" dimColor size="caption">
						{`TOUCHED · ${entries.length} FILE${entries.length === 1 ? '' : 'S'}`}
					</Text>
				)}
				{rows.slice(0, MAX_ROWS).map(treeRow)}
				{rows.length > MAX_ROWS && (
					<Text key="more" dimColor>
						{`+ ${rows.length - MAX_ROWS} more`}
					</Text>
				)}
				{sha && (
					<Box key="commit" flexDirection="row" gap={1} marginTop={1}>
						<Text color={STATE_COLORS.committed}>●</Text>
						<Text dimColor>{`committed ${sha}`}</Text>
					</Box>
				)}
			</Box>
		)
	})
}
```

- [ ] **Step 4: Register the pane in `hooks/register.tsx`**

Add `import { registerFilesPane } from './files-pane'`, and at the end of `register`, after `registerPanel(on)`, add `registerFilesPane(on)`.

The pane needs no ticker change. Crew's clock already redraws every `ui.render` hook (`$.ui.invalidate('ui.render')`) every second beat while any agent runs, and that drives the live dot.

- [ ] **Step 5: Run the tests and see them pass**

Run: `scripts/test-one.sh files-pane.test.ts`
Expected: PASS, 8 tests.

If `$.ui.close({...})` in the "closing" test is not how the kit fires a user close, use the kit's own way. Grep `test/ui.test.ts` for `ui.close` and copy what it does. If the kit can't fire one, drop that test and note it in the report.

- [ ] **Step 6: Validate the module**

Run: `~/.bun/bin/bun x claude plugin validate .`
Expected: no errors. In particular there must be no complaint about the `filesFor` state key, which `types/index.d.ts` declares since Task 1.

- [ ] **Step 7: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add hooks/files-pane.tsx hooks/register.tsx test/files-pane.test.ts
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "feat: draw each agent's files in a Files pane"
```

---

### Task 6: Open files, and commits turn green

**Files:**
- Test: `test/files-pane.test.ts`. The code was written in Tasks 4 and 5; this task proves it, and fixes it where a test shows a gap.

How the commit check runs, since the Task 4 review (`hooks/register.tsx`, `checkCommit`):
- Every git call is `['git', '--no-optional-locks', '-C', <dir>, ...]` with `{ timeoutMs: 5000 }`.
- For each distinct folder of the agent's edited files it runs `rev-parse --show-cdup` in that folder. If that exits non-zero, the folder's files are skipped (outside any repository). Otherwise the repository top is `joinUp(folder, stdout.trim())`.
- For each top it runs `status --porcelain -z --ignored --untracked-files=all -- <that top's edited paths>`. Listed paths are dirty; the rest are clean.
- **New in this task:** a clean file only counts as committed if git tracks it. For each top with clean files, run `ls-files -z --full-name -- <those clean paths>` there (same `['git', '--no-optional-locks', '-C', top, ...]` form). Keep only the clean paths it lists, mapping each listed path back as `${top}/${path}`. If `ls-files` fails, skip that top. This stops a file the agent wrote, then deleted, and never committed from showing as committed: git's status lists nothing for it.
- Only in a top where something is still clean after that does it run `rev-parse --short HEAD` for the SHA.
- Nothing turned clean anywhere means nothing is dispatched: no green files and no SHA.
- A Bash call with `run_in_background: true` is not checked at all.

The test helper `start()` answers `process.run` by the start of the joined argv (`stdout` and `exits` options); unmatched calls exit 0 with empty stdout.


**Test plumbing since Task 5 (read before writing the tests):**
- The kit's `find({ key })` cannot see `key` props on `Text` elements. The tests below look up `state-<path>`, `legend-committed` and similar `Text` keys, and those lookups return undefined.
- `test/files-pane.test.ts` already has helpers for this. `cells(files, key)` returns the children of the keyed row Box, and `shown(cell)` gives a cell's text.
  - A file row's Box is keyed `file:<path>`, and its cells are [guide, dot, name cell, state]. So a file's state word is `shown((await cells(files, 'file:<path>'))[3])`, and its colour is that cell's `props.color`.
  - Find the committed legend item by text (`/^● committed$/`) and the footer by `/^committed /`.
- Adapt every `state-…` and `legend-…` lookup below to these helpers, keeping the same assertions. Look at how the existing Task 5 tests in that file do it, and copy their style.
- Opening a file on darwin and linux first runs `test -x <path>`. `start()` answers unmatched calls with exit 0, which means "executable" and so a reveal. Any test that expects a plain `['open', path]` therefore stubs `'test -x': 1` (a more specific `'test -x <path>'` key goes before it, since matching is by prefix and the first match wins).
- `STATE_COLORS` is exported from `hooks/files-pane.tsx` and the test file already imports it. Use `STATE_COLORS.committed` instead of `'#3FB950'`.

- [ ] **Step 1: Write the tests** (they include the tracked-only rule, so the commit tests fail until Step 2 adds it)

Append to `test/files-pane.test.ts`:

```ts
test('pressing a file row opens it in the default app, and a failed open says so', async ($, on) => {
	// Not executable (`test -x` exits 1), so both rows open rather than reveal.
	const { clock, ran, toasts } = await start($, on, { stdout: { uname: 'Darwin\n' }, exits: { 'test -x': 1, 'open /repo/gone.js': 1 } })
	await $.tool.call(read('/repo/a.js', 'a1'))
	await $.tool.call(read('/repo/gone.js', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	await files.press({ key: 'open-/repo/a.js' })
	await clock.settle()
	expect(ran).toContainEqual(['open', '/repo/a.js'])
	expect(toasts.some(toast => toast.includes("couldn't open"))).toBe(false)
	await files.press({ key: 'open-/repo/gone.js' })
	await clock.settle()
	expect(toasts.some(toast => toast.includes("couldn't open gone.js"))).toBe(true)
	await files.unmount()
	await pane.unmount()
})

const GIT = 'git --no-optional-locks -C'

test('a successful git commit turns the clean edited files green and shows the SHA', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: {
			[`${GIT} /repo/src/pricing rev-parse --show-cdup`]: '../../\n',
			[`${GIT} /repo/test rev-parse --show-cdup`]: '../\n',
			[`${GIT} /repo status`]: ' M src/pricing/PriceTable.jsx\0',
			[`${GIT} /repo ls-files`]: 'test/PriceTable.test.jsx\0',
			[`${GIT} /repo rev-parse --short HEAD`]: 'a1c9e42\n'
		},
		// Outside any repository.
		exits: { [`${GIT} /Users/me rev-parse`]: 128 }
	})
	await $.tool.call(edit('/repo/src/pricing/PriceTable.jsx', 'a1'))
	await $.tool.call({ tool: 'Write', file_path: '/repo/test/PriceTable.test.jsx', content: 'x', agentId: 'a1' } as any)
	await $.tool.call(read('/repo/src/pricing/usePrices.js', 'a1'))
	await $.tool.call(edit('/Users/me/notes.md', 'a1'))
	await $.tool.call({
		tool: 'Bash',
		command: 'GIT_CONFIG_GLOBAL=/dev/null git add test && GIT_CONFIG_GLOBAL=/dev/null git commit -m "Add the test"',
		agentId: 'a1'
	} as any)
	await clock.settle()
	expect(ran).toContainEqual([
		'git',
		'--no-optional-locks',
		'-C',
		'/repo',
		'status',
		'--porcelain',
		'-z',
		'--ignored',
		'--untracked-files=all',
		'--',
		'/repo/src/pricing/PriceTable.jsx',
		'/repo/test/PriceTable.test.jsx'
	])
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	const committed = await files.find({ key: 'state-/repo/test/PriceTable.test.jsx' })
	expect(committed?.text).toBe('committed')
	expect(committed?.props.color).toBe('#3FB950')
	expect((await files.find({ key: 'state-/repo/src/pricing/PriceTable.jsx' }))?.text).toBe('edited')
	expect((await files.find({ key: 'state-/repo/src/pricing/usePrices.js' }))?.text).toBe('read')
	expect((await files.find({ key: 'state-/Users/me/notes.md' }))?.text).toBe('edited')
	expect(await files.find({ key: 'legend-committed' })).toBeDefined()
	expect((await files.find({ type: 'Text', text: /^committed a1c9e42$/ }))?.text).toBe('committed a1c9e42')
	await files.unmount()
	await pane.unmount()
})

test('an agent working in a git worktree is checked in that worktree', async ($, on) => {
	const worktree = '/repo/.claude/worktrees/w1'
	const { clock, ran } = await start($, on, {
		stdout: {
			// The folder is the worktree's own top: show-cdup prints an empty line.
			[`${GIT} ${worktree} rev-parse --show-cdup`]: '\n',
			[`${GIT} ${worktree} ls-files`]: 'b.js\0',
			[`${GIT} ${worktree} rev-parse --short HEAD`]: 'f00ba47\n'
		}
	})
	await $.tool.call(edit(`${worktree}/b.js`, 'a1'))
	await $.tool.call({ tool: 'Bash', command: 'git commit -am "b"', agentId: 'a1' } as any)
	await clock.settle()
	expect(ran.some(argv => argv.join(' ').startsWith(`${GIT} ${worktree} status`))).toBe(true)
	// Never checked against the main checkout.
	expect(ran.some(argv => argv.join(' ').startsWith(`${GIT} /repo status`))).toBe(false)
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect((await files.find({ key: `state-${worktree}/b.js` }))?.text).toBe('committed')
	expect((await files.find({ type: 'Text', text: /^committed f00ba47$/ }))?.text).toBe('committed f00ba47')
	await files.unmount()
	await pane.unmount()
})

test('a file the agent wrote and deleted without committing never shows as committed', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: {
			[`${GIT} /repo rev-parse --show-cdup`]: '\n',
			// git lists nothing for either file: one is committed, the other is gone and was never tracked.
			[`${GIT} /repo status`]: '',
			[`${GIT} /repo ls-files`]: 'kept.js\0',
			[`${GIT} /repo rev-parse --short HEAD`]: 'c0ffee1\n'
		}
	})
	await $.tool.call(edit('/repo/kept.js', 'a1'))
	await $.tool.call({ tool: 'Write', file_path: '/repo/probe.js', content: 'x', agentId: 'a1' } as any)
	await $.tool.call({ tool: 'Bash', command: 'git commit -am kept', agentId: 'a1' } as any)
	await clock.settle()
	expect(ran).toContainEqual(['git', '--no-optional-locks', '-C', '/repo', 'ls-files', '-z', '--full-name', '--', '/repo/kept.js', '/repo/probe.js'])
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect((await files.find({ key: 'state-/repo/kept.js' }))?.text).toBe('committed')
	expect((await files.find({ key: 'state-/repo/probe.js' }))?.text).toBe('edited')
	await files.unmount()
	await pane.unmount()
})

test('no check, a failed check or nothing clean leaves the files edited and stamps no SHA', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: {
			[`${GIT} /repo/src rev-parse --show-cdup`]: '../\n',
			// Still dirty after the commit, and its new sibling ignored.
			[`${GIT} /repo status`]: ' M src/a.js\0!! src/dist.js\0'
		},
		exits: { [`${GIT} /elsewhere rev-parse`]: 128 }
	})
	await $.tool.call(edit('/repo/src/a.js', 'a1'))
	await $.tool.call({ tool: 'Write', file_path: '/repo/src/dist.js', content: 'x', agentId: 'a1' } as any)
	await $.tool.call({ tool: 'Bash', command: 'git log --grep commit', agentId: 'a1' } as any)
	await $.tool.call({ tool: 'Bash', command: 'git commit -am x', run_in_background: true, agentId: 'a1' } as any)
	await clock.settle()
	// Neither command is a finished commit, so git was never asked.
	expect(ran.some(argv => argv[0] === 'git')).toBe(false)
	await $.tool.call({ tool: 'Bash', command: 'git commit -am x', agentId: 'a1' } as any)
	await clock.settle()
	// Checked, but nothing turned clean: no HEAD lookup.
	expect(ran.some(argv => argv.join(' ').startsWith(`${GIT} /repo status`))).toBe(true)
	expect(ran.some(argv => argv.includes('HEAD'))).toBe(false)
	// An agent whose files sit outside any repository is never asked for a status.
	await $.tool.call(edit('/elsewhere/c.js', 'a2'))
	await $.tool.call({ tool: 'Bash', command: 'git commit -am y', agentId: 'a2' } as any)
	await clock.settle()
	expect(ran.some(argv => argv.join(' ').startsWith(`${GIT} /elsewhere status`))).toBe(false)
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect((await files.find({ key: 'state-/repo/src/a.js' }))?.text).toBe('edited')
	expect((await files.find({ key: 'state-/repo/src/dist.js' }))?.text).toBe('edited')
	expect(await files.find({ type: 'Text', text: /^committed / })).toBeUndefined()
	await files.unmount()
	await pane.unmount()
})
```

- [ ] **Step 2: Add the tracked-only rule, then run the tests**

In `hooks/register.tsx`'s `checkCommit`, inside the per-top loop and after the clean paths are known: if any are clean, run `ls-files -z --full-name -- <clean paths>` in that top. Narrow clean to the listed ones (`stdout.split('\0').filter(Boolean).map(path => `${top}/${path}`)`), and skip the top if the call fails. Then run `rev-parse --short HEAD` only if clean is still non-empty. Add a short why-comment.

Run: `scripts/test-one.sh files-pane.test.ts`
Expected: PASS, every test in the file.

If the commit tests fail because the git check hadn't finished, `clock.settle()` may not flush the fire-and-forget promise. Replace that `await clock.settle()` with `for (let i = 0; i < 5; i++) await clock.settle()`. If that still fails, use `await new Promise(resolve => setTimeout(resolve, 0))` repeated five times. Don't make the check blocking: the spec requires it to run after the tool result.

If a test fails because the behaviour under test is wrong (not the test's plumbing), fix the code in `hooks/register.tsx` or `hooks/files-pane.tsx` and report it.

- [ ] **Step 3: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add test/files-pane.test.ts hooks/files-pane.tsx hooks/register.tsx
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "test: cover opening files and commits turning green"
```

---

### Task 7: Final checks

- [ ] **Step 1: Validate**

Run: `~/.bun/bin/bun x claude plugin validate .`
Expected: no errors.

- [ ] **Step 2: Run the touched test files, one at a time**

Run each of these and wait for it to finish before the next:

- `scripts/test-one.sh files.test.ts`
- `scripts/test-one.sh tracker.test.ts`
- `scripts/test-one.sh view.test.ts`
- `scripts/test-one.sh files-pane.test.ts`
- `scripts/test-one.sh ui.test.ts`

Expected: every one passes.

- [ ] **Step 3: Mark the spec built**

In `docs/2026-11-01-crew-files-pane-design.md`, change `Status: design approved, not built` to `Status: implemented on branch build/v0.1, awaiting live check`.

- [ ] **Step 4: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add docs/2026-11-01-crew-files-pane-design.md
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "docs: mark the Files pane design built"
```

- [ ] **Step 5: Live check (the owner does this)**

Run `/reload-plugins` in the Desktop app, start work that spawns a sub-agent, then check the following:
- The card gets `▸ N` after the agent's first Read or Edit.
- Pressing it docks a Files pane with the tree.
- The live dot pulses.
- Pressing a file opens it.
- After the agent commits, its committed files turn green and the footer shows the SHA.
