import type { FileEntry, FileState } from '../types'

// Past this many files an agent's list drops its oldest reads first, then its oldest files of any kind.
export const MAX_FILES = 200

export type Touch = 'read' | 'edit'

const TOUCHES: Record<string, Touch> = { Read: 'read', Edit: 'edit', Write: 'edit', NotebookEdit: 'edit' }

export const touchOf = (tool: string): Touch | null =>
	Object.prototype.hasOwnProperty.call(TOUCHES, tool) ? TOUCHES[tool] : null

export const posix = (path: string) => path.replace(/\\/g, '/')

// A read never takes a file back from edited or committed; an edit always makes it edited, a committed file included.
// The touched file moves to the end, so the list runs oldest to latest, and it is never the one a cap drops.
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
	while (next.length > cap && next.length > 1) {
		const others = next.slice(0, -1)
		const reads = others.filter(item => item.state === 'read')
		const pool = reads.length > 0 ? reads : others
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

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// True when some git command in the line, past any leading NAME=value words and its global options, has `commit` as
// its subcommand. A word-split heuristic that ignores quoting: a false positive only costs one extra `git status`.
export function isGitCommit(command: string): boolean {
	return command.split(/&&|\|\||[;|\n]/).some(part => {
		const words = part.trim().split(/\s+/)
		let start = 0
		while (start < words.length && ASSIGNMENT.test(words[start])) start++
		if (words[start] !== 'git') return false
		let at = start + 1
		while (at < words.length && words[at].startsWith('-')) at += VALUED.has(words[at]) ? 2 : 1
		return words[at] === 'commit'
	})
}

// `git status --porcelain -z`: `XY path` entries split by NUL, a rename or copy (in either column) followed by its old path.
export function dirtyPaths(porcelainZ: string): Set<string> {
	const tokens = porcelainZ.split('\0')
	const dirty = new Set<string>()
	for (let at = 0; at < tokens.length; at++) {
		const token = tokens[at]
		if (token.length < 4) continue
		dirty.add(token.slice(3))
		if ('RC'.includes(token[0]) || 'RC'.includes(token[1])) at++
	}
	return dirty
}

const isInside = (root: string, path: string) => root !== '' && path.startsWith(root.endsWith('/') ? root : `${root}/`)
const relativeTo = (root: string, path: string) => path.slice(root.replace(/\/$/, '').length + 1)
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const dirname = (path: string) => {
	const at = path.lastIndexOf('/')
	return at < 0 ? '' : at === 0 ? '/' : path.slice(0, at)
}

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
		if (isInside(root, item.path)) place(top, relativeTo(root, item.path).split('/').filter(Boolean), item)
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
			rows.push({ kind: 'dir', key: `${child.dir.isOutside ? 'out' : 'dir'}:${path}`, prefix, name: `${name}/`, ...(child.dir.isOutside ? { isOutside: true as const } : {}) })
			walk(inner, `${guides}${isLast ? NB : '│'}${NB}`, path)
		})
	}
	walk(top, '', '')
	return rows
}
