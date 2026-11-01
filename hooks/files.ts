import type { AgentStatusView, FileEntry, FileState } from '../types'

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

// Only files last touched by the time the check began: an edit that landed while git was being asked stays edited.
export function applyCommitted(entries: readonly FileEntry[], paths: readonly string[], until = Infinity): FileEntry[] {
	const clean = new Set(paths)
	return entries.map(item =>
		item.state === 'edited' && item.at <= until && clean.has(item.path) ? { ...item, state: 'committed' as const } : item
	)
}

// A directory climbed by `git rev-parse --show-cdup` ('', '../', '../../'), with the `..` resolved on the text alone:
// the caller's spelling of the path (/tmp or /private/tmp) is kept, which a realpath would not.
export function joinUp(dir: string, cdup: string): string {
	const parts = dir.split('/')
	for (const step of cdup.split('/')) {
		if (step === '..') parts.pop()
		else if (step !== '' && step !== '.') parts.push(step)
	}
	return parts.join('/') || '/'
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

// The folder a command starts by changing into (`cd <path>` then `&&`, `;` or a newline), where a Bash edit is then
// looked for; null when it does not start that way or the path cannot be known from the text (a variable, an
// unknown home, `cd -`). A relative path comes back as written, for the caller to resolve against its own folder.
export function cdTarget(command: string, home: string | undefined): string | null {
	const found = /^\s*cd[ \t]+(?:"([^"]*)"|'([^']*)'|([^\s;&|"'<>()]+))[ \t]*(?:&&|;|\n)/.exec(command)
	if (!found) return null
	const raw = found[1] ?? found[2] ?? found[3]
	if (raw === '' || raw === '-' || /[$`]/.test(raw)) return null
	let path = raw
	if (raw === '~' || raw.startsWith('~/')) {
		if (!home) return null
		path = home.replace(/\/+$/, '') + raw.slice(1)
	}
	return path.replace(/\/+$/, '') || '/'
}

// Folders a scan for changed files never enters: version control, dependencies, build output and caches.
export const SCAN_PRUNE = [
	'.git', 'node_modules', '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'out', 'coverage', '.turbo', '.cache',
	'.parcel-cache', '.venv', 'venv', '__pycache__', 'target', '.gradle', '.idea'
]

// The paths `find -print0` listed, less those `git check-ignore -z` named (logs, .env, output off the prune list). The
// cap counts what is left: past it, it was an install or a build rather than an agent's edit, so none count.
export function changedFiles(stdout: string, cap = 100, ignored = ''): string[] {
	const skip = new Set(ignored.split('\0').filter(Boolean).map(posix))
	const paths = stdout.split('\0').filter(Boolean).map(posix).filter(path => !skip.has(path))
	return paths.length > cap ? [] : paths
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
// The folder a file is shown under, short enough to read beside its name: relative to the project; outside it, under
// the name of the repository that holds it (`crew/docs`); outside any, its last two folders (`…/scratch/frames`).
function shownFolder(root: string, path: string, tops: readonly string[]): string {
	if (isInside(root, path)) return dirname(relativeTo(root, path))
	const top = tops.filter(top => isInside(top, path)).reduce<string | null>((best, top) => (best && best.length >= top.length ? best : top), null)
	if (top !== null) {
		const name = basename(top.replace(/\/$/, ''))
		const inner = dirname(relativeTo(top, path))
		return inner ? `${name}/${inner}` : name
	}
	const folder = dirname(path)
	const parts = folder.split('/').filter(Boolean)
	return parts.length > 2 ? `\u2026/${parts.slice(-2).join('/')}` : folder
}

export const dirname = (path: string) => {
	const at = path.lastIndexOf('/')
	return at < 0 ? '' : at === 0 ? '/' : path.slice(0, at)
}

const isEndedStatus = (status: AgentStatusView) =>
	status === 'completed' || status === 'failed' || status === 'killed' || status === 'stopped'

const VERBS: Record<FileState, string> = { read: 'Reading', edited: 'Editing', committed: 'Committed' }

export type ChipTone = 'code' | 'docs' | 'data' | 'other'

const TONES: Record<Exclude<ChipTone, 'other'>, string> = {
	code: 'js jsx ts tsx mjs cjs py rb go rs java kt swift c h cpp cs php sh vue svelte css scss html',
	docs: 'md mdx txt rst pdf doc docx',
	data: 'json yaml yml toml csv xml sql lock env'
}

const TONE_OF = new Map<string, ChipTone>(
	(['code', 'docs', 'data'] as const).flatMap(tone => TONES[tone].split(' ').map(ext => [ext, tone] as const))
)

// The type chip of a row: the extension of the file name (a dot in a folder does not count), upper-cased and cut to 4.
export function chipOf(path: string): { label: string; tone: ChipTone } {
	const name = basename(path)
	const dot = name.lastIndexOf('.')
	const ext = name.slice(dot + 1).toLowerCase()
	// A dotfile (.gitignore) is a name, not an extension, unless it is one we know (.env).
	if (dot < 0 || ext === '' || (dot === 0 && !TONE_OF.has(ext))) return { label: 'FILE', tone: 'other' }
	return { label: ext.toUpperCase().slice(0, 4), tone: TONE_OF.get(ext) ?? 'other' }
}

export type TouchedRow = {
	key: string
	path: string
	name: string
	// Relative to the project, '.' at its root; outside it, as shownFolder puts it.
	folder: string
	state: FileState
	// The live row's pill says what is happening (reading, editing); the others say what happened.
	pill: string
	isLive: boolean
	// 0 when unknown.
	added: number
	removed: number
	chip: { label: string; tone: ChipTone }
}

const PRESENT: Record<FileState, string> = { read: 'reading', edited: 'editing', committed: 'committed' }

// The agent's files as flat rows, newest touch first. Only the latest touch is live, and only while the agent runs.
export function touchedRows(
	entries: readonly FileEntry[],
	root: string,
	status: AgentStatusView,
	lines: Record<string, [number, number]>,
	// The known repository tops, which name the folder of a file outside the project.
	tops: readonly string[] = []
): TouchedRow[] {
	const live = status === 'running' ? latestOf(entries) : undefined
	// A tie goes to the later entry, as latestOf does, so the row that is live is also the first.
	return entries
		.map((item, index) => ({ item, index }))
		.sort((a, b) => b.item.at - a.item.at || b.index - a.index)
		.map(({ item }) => {
			const isLive = item === live
			const [added, removed] = lines[item.path] ?? [0, 0]
			return {
				key: `file:${item.path}`,
				path: item.path,
				name: basename(item.path),
				folder: shownFolder(root, item.path, tops) || '.',
				state: item.state,
				pill: isLive ? PRESENT[item.state] : item.state,
				isLive,
				added,
				removed,
				chip: chipOf(item.path)
			}
		})
}

export type RightNow = {
	label: 'RIGHT NOW' | 'WAITING' | 'DONE'
	tone: FileState | 'waiting'
	icon: 'eye' | 'pencil' | 'check' | 'pause'
	title: string
	// The live file's folder, or the summary of an ended agent.
	subtitle: string
	// The live file's own lines added and removed, drawn after the subtitle in their colours; 0 when unknown.
	counts: { added: number; removed: number }
	// Across the agent's files that have counts.
	totals: { added: number; removed: number }
	// The repository of the latest touch, when it is one of the known ones.
	repoTop: string | null
}

const ICON_OF: Record<FileState, RightNow['icon']> = { read: 'eye', edited: 'pencil', committed: 'check' }
const DONE_VERB: Record<FileState, string> = { read: 'Read', edited: 'Edited', committed: 'Committed' }

// What the Right-now card shows: the live file while the agent runs or waits, a summary once it has ended.
export function rightNow(
	entries: readonly FileEntry[],
	status: AgentStatusView,
	root: string,
	lines: Record<string, [number, number]>,
	repos: Record<string, { branch: string | null; changed: number }>
): RightNow {
	const latest = latestOf(entries)
	const [added, removed] = (latest && lines[latest.path]) || [0, 0]
	const totals = entries.reduce(
		(sum, item) => {
			const [a, r] = lines[item.path] ?? [0, 0]
			return { added: sum.added + a, removed: sum.removed + r }
		},
		{ added: 0, removed: 0 }
	)
	const repoTop =
		latest === undefined
			? null
			: Object.keys(repos)
					.filter(top => latest.path.startsWith(top.endsWith('/') ? top : `${top}/`))
					.reduce<string | null>((best, top) => (best === null || top.length > best.length ? top : best), null)
	const base = { totals, repoTop, counts: { added: 0, removed: 0 } }

	if (isEndedStatus(status)) {
		const counts = (['edited', 'committed', 'read'] as const)
			.map(state => [state, entries.filter(item => item.state === state).length] as const)
			.filter(([, count]) => count > 0)
		if (counts.length === 0) return { ...base, label: 'DONE', tone: 'read', icon: 'check', title: 'No files yet', subtitle: '' }
		const [state, count] = counts[0]
		return {
			...base,
			label: 'DONE',
			tone: state,
			icon: 'check',
			title: `${DONE_VERB[state]} ${count} ${count === 1 ? 'file' : 'files'}`,
			subtitle: counts.map(([name, n]) => `${name} ${n}`).join(', ')
		}
	}

	const isRunning = status === 'running'
	const label = isRunning ? 'RIGHT NOW' : 'WAITING'
	if (!latest) {
		return { ...base, label, tone: 'waiting', icon: 'pause', title: 'No files yet', subtitle: '' }
	}
	return {
		...base,
		label,
		tone: isRunning ? latest.state : 'waiting',
		icon: isRunning ? ICON_OF[latest.state] : 'pause',
		title: `${VERBS[latest.state]} ${basename(latest.path)}`,
		subtitle: shownFolder(root, latest.path, Object.keys(repos)),
		counts: { added, removed }
	}
}

// How often the terminal shine's band moves a letter: the rate the ticker redraws while an agent runs, so the band
// steps once per redraw and never skips a letter. register.tsx beats to it.
export const SHINE_STEP_MS = 200

const SHINE_BAND = 3

// Terminal shine: one colour per letter, a 3-letter band of `bright` moving a letter per step across `base`, wrapping.
// A name of 3 letters or fewer would be all band, so it stays plain.
export function shineColors(text: string, now: number, base: string, bright: string): string[] {
	const letters = Array.from(text)
	if (letters.length <= SHINE_BAND) return letters.map(() => base)
	const start = Math.floor(now / SHINE_STEP_MS) % letters.length
	return letters.map((_, at) => ((at - start + letters.length) % letters.length < SHINE_BAND ? bright : base))
}

const toCount = (text: string) => (/^\d+$/.test(text) ? Number(text) : 0)

// `git diff --numstat -z` output as path (relative to the repository top, as git prints it) to [added, removed]; a
// binary file's `-` counts as 0. A rename is printed as an empty path then the old and the new one; the new one is kept.
export function numstat(stdout: string): Record<string, [number, number]> {
	const tokens = stdout.split('\0')
	const found: Record<string, [number, number]> = {}
	for (let at = 0; at < tokens.length; at++) {
		const token = tokens[at]
		const first = token.indexOf('\t')
		const second = token.indexOf('\t', first + 1)
		if (first < 0 || second < 0) continue
		let path = token.slice(second + 1)
		if (path === '') {
			path = tokens[at + 2] ?? ''
			at += 2
		}
		if (path !== '') found[path] = [toCount(token.slice(0, first)), toCount(token.slice(first + 1, second))]
	}
	return found
}

export type OpenPlatform = 'darwin' | 'linux' | 'win32'

// What each platform's opener would run rather than show; lower-case, compared without regard to case.
const RUNNABLE: Record<OpenPlatform, Set<string>> = {
	darwin: new Set([
		'.app', '.command', '.tool', '.terminal', '.workflow', '.action', '.pkg', '.mpkg', '.jar', '.fileloc', '.inetloc',
		'.prefpane'
	]),
	win32: new Set([
		'.exe', '.com', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.msi', '.scr',
		'.lnk', '.py', '.pyw', '.cpl', '.jar', '.pif', '.msp', '.application', '.appref-ms', '.url', '.scf', '.msc',
		'.chm', '.reg', '.wsc', '.ws', '.settingcontent-ms', '.appx', '.msix'
	]),
	linux: new Set(['.desktop', '.appimage', '.run', '.sh', '.jar'])
}

// The command that shows a file from a row press, or null for a path that is not absolute (or that Windows could
// not be asked about safely). A file the platform would run, by extension or because its executable bit is set, or
// a symlink, which the opener treats as its target's type, is revealed in its folder instead (`isExecutable` says
// the macOS or Linux check found either), so a press can never start a program. Windows goes through explorer,
// never cmd.exe, which would re-read & | ^ and %VAR% in a file name; it opens folders rather than `/select,`, which
// breaks on spaces and commas once spawned, and it splits an unquoted argument at commas, so a path holding one is
// shown by its folder, or not at all.
export function openCommand(
	platform: OpenPlatform,
	path: string,
	isExecutable: boolean
): { argv: string[]; isReveal: boolean } | null {
	if (!path.startsWith('/') && !/^[A-Za-z]:\//.test(path)) return null
	// Windows ignores trailing dots and spaces, so `setup.exe.` is setup.exe.
	const name = platform === 'win32' ? basename(path).replace(/[. ]+$/, '') : basename(path)
	const dot = name.lastIndexOf('.')
	const isReveal = isExecutable || (dot >= 0 && RUNNABLE[platform].has(name.slice(dot).toLowerCase()))
	if (platform === 'darwin') return { argv: isReveal ? ['open', '-R', path] : ['open', path], isReveal }
	if (platform === 'linux') return { argv: ['xdg-open', isReveal ? dirname(path) : path], isReveal }
	const win = path.replace(/\//g, '\\')
	if (!isReveal && !win.includes(',')) return { argv: ['explorer', win], isReveal: false }
	// A drive's own folder keeps its backslash: `C:` alone is the drive's current folder.
	const folder = dirname(path).replace(/^([A-Za-z]:)$/, '$1/').replace(/\//g, '\\')
	return folder.includes(',') ? null : { argv: ['explorer', folder], isReveal: true }
}
