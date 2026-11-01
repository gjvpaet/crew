import { expect, test } from 'claude-code/testing'

import type { FileEntry } from '../types'
import {
	MAX_FILES,
	SCAN_PRUNE,
	applyCommitted,
	applyTouch,
	cdTarget,
	changedFiles,
	dirtyPaths,
	fileTree,
	headline,
	isGitCommit,
	joinUp,
	latestOf,
	numstat,
	openCommand,
	posix,
	rightNow,
	shineColors,
	touchOf,
	touchedRows,
	chipOf
} from '../hooks/files'
import { EMPTY_STATE, reduce, type CrewEvent } from '../hooks/tracker'
import { agentAccent, panelView, pulseAt, ACCENTS } from '../hooks/view'

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

test('the cap never evicts the file just touched', () => {
	const full = [entry('/r/e1', 'edited', 1), entry('/r/e2', 'edited', 2)]
	expect(applyTouch(full, '/r/new', 'read', 3, 2).map(item => [item.path, item.state, item.at])).toEqual([
		['/r/e2', 'edited', 2],
		['/r/new', 'read', 3]
	])
})

test('a commit turns only the listed edited files committed', () => {
	const list = [entry('/r/a', 'edited'), entry('/r/b', 'edited'), entry('/r/c', 'read')]
	expect(applyCommitted(list, ['/r/a', '/r/c']).map(item => item.state)).toEqual(['committed', 'edited', 'read'])
})

test('a commit leaves a file edited after the check began', () => {
	const list = [entry('/r/a', 'edited', 5), entry('/r/b', 'edited', 9)]
	expect(applyCommitted(list, ['/r/a', '/r/b'], 5).map(item => item.state)).toEqual(['committed', 'edited'])
})

test('joinUp climbs a directory by what git prints for the way up, keeping the spelling', () => {
	expect(joinUp('/repo/src/pricing', '../../')).toBe('/repo')
	expect(joinUp('/repo', '')).toBe('/repo')
	expect(joinUp('/tmp/x/a', '../')).toBe('/tmp/x')
})

test('only Read, Edit, Write and NotebookEdit touch files', () => {
	expect(touchOf('Read')).toBe('read')
	expect(touchOf('Edit')).toBe('edit')
	expect(touchOf('Write')).toBe('edit')
	expect(touchOf('NotebookEdit')).toBe('edit')
	expect(touchOf('Grep')).toBeNull()
	expect(touchOf('toString')).toBeNull()
})

test('posix turns backslashes into slashes', () => {
	expect(posix('C:\\repo\\a.js')).toBe('C:/repo/a.js')
})

test('a git commit is spotted through global options and chains, and nothing else is', () => {
	for (const command of [
		'git commit -m x',
		'git -C app commit -am x',
		'git add . && git commit --amend',
		'git -c user.email=a@b commit -m x',
		'cd x; git --no-pager commit',
		'GIT_CONFIG_GLOBAL=/dev/null git -c user.email=a@b commit -m x',
		'cd /x && GIT_EDITOR=true git commit',
		'a || git commit',
		'x | git commit',
		'make\ngit commit',
		'git --git-dir=.git commit'
	])
		expect(isGitCommit(command)).toBe(true)
	for (const command of ['git log --grep commit', 'echo git commit', 'git commit-tree abc', 'git status', 'npm run commit'])
		expect(isGitCommit(command)).toBe(false)
})

test('git status -z output gives the dirty paths, skipping a rename’s old name', () => {
	expect([...dirtyPaths(' M src/a.js\0?? new.txt\0R  b.js\0old-b.js\0')]).toEqual(['src/a.js', 'new.txt', 'b.js'])
	expect(dirtyPaths('').size).toBe(0)
})

test('a rename or copy in either status column skips its old name', () => {
	expect([...dirtyPaths(' R new.js\0src/old.js\0 M z.js\0')]).toEqual(['new.js', 'z.js'])
	expect([...dirtyPaths('C  copy.js\0orig.js\0')]).toEqual(['copy.js'])
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
	expect(rows[6]).toEqual({ kind: 'dir', key: 'out:/outside project', prefix: '└', name: 'outside project/', isOutside: true })
	expect(rows[7]).toMatchObject({ key: 'out:/outside project/Users/me', isOutside: true })
	expect(fileTree([], '/repo')).toEqual([])
})

test('the headline names the live file while the agent runs and sums the files once it is done', () => {
	const list = [
		entry('/repo/src/a.js', 'edited', 1),
		entry('/repo/b.js', 'read', 2),
		entry('/repo/c.js', 'committed', 3),
		entry('/repo/src/d.js', 'read', 4)
	]
	expect(headline(list, 'running', '/repo')).toEqual({ label: 'RIGHT NOW', line: 'Reading d.js', where: 'src' })
	expect(headline([entry('/repo/x.js', 'edited', 1)], 'running', '/repo')).toEqual({ label: 'RIGHT NOW', line: 'Editing x.js', where: '' })
	expect(headline([entry('/elsewhere/y.md', 'read', 1)], 'running', '/repo')).toEqual({
		label: 'RIGHT NOW',
		line: 'Reading y.md',
		where: '/elsewhere'
	})
	expect(headline(list, 'completed', '/repo')).toEqual({ label: 'DONE', line: 'edited 1, committed 1, read 2', where: '' })
	expect(headline([], 'completed', '/repo').line).toBe('No files yet.')
	expect(headline([], 'running', '/repo').line).toBe('No files yet.')
})

test('a project folder named like the outside branch keeps its own keys', () => {
	const rows = fileTree([entry('/repo/outside project/a.js', 'read'), entry('/tmp/b.js', 'read')], '/repo')
	expect(rows.map(row => row.key)).toEqual([
		'dir:/outside project',
		'file:/repo/outside project/a.js',
		'out:/outside project',
		'out:/outside project/tmp',
		'file:/tmp/b.js'
	])
	expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
})

test('empty path segments are ignored inside and outside the project', () => {
	const rows = fileTree([entry('/repo/src//a.js', 'read'), entry('/x//y/b.js', 'read')], '/repo')
	expect(rows.map(row => [row.kind, row.name])).toEqual([
		['dir', 'src/'],
		['file', 'a.js'],
		['dir', 'outside project/'],
		['dir', 'x/y/'],
		['file', 'b.js']
	])
})

test('the tree and headline read a root of / or one with a trailing slash', () => {
	const list = [entry('/repo/src/a.js', 'read')]
	expect(fileTree(list, '/repo/')).toEqual(fileTree(list, '/repo'))
	expect(headline(list, 'running', '/repo/')).toEqual(headline(list, 'running', '/repo'))
	expect(fileTree(list, '/').map(row => [row.name, row.kind])).toEqual([
		['repo/src/', 'dir'],
		['a.js', 'file']
	])
	expect(headline(list, 'running', '/')).toEqual({ label: 'RIGHT NOW', line: 'Reading a.js', where: 'repo/src' })
})

test('a file directly under / outside the project keeps / as its folder', () => {
	expect(headline([entry('/notes.md', 'read')], 'running', '/repo')).toEqual({
		label: 'RIGHT NOW',
		line: 'Reading notes.md',
		where: '/'
	})
})

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
	expect(pulseAt(1000)).toBe(0.55)
})

test('openCommand opens a document with the platform’s opener and nothing else', () => {
	expect(openCommand('darwin', '/repo/a.js', false)).toEqual({ argv: ['open', '/repo/a.js'], isReveal: false })
	expect(openCommand('linux', '/repo/notes.md', false)).toEqual({ argv: ['xdg-open', '/repo/notes.md'], isReveal: false })
	// Never cmd.exe: it would re-read & | ^ and %VAR% inside the name.
	expect(openCommand('win32', 'C:/repo/a & b.md', false)).toEqual({ argv: ['explorer', 'C:\\repo\\a & b.md'], isReveal: false })
})

test('openCommand refuses a path that is not absolute', () => {
	for (const path of ['', 'a.js', './a.js', '../a.js', '-rf', 'src/a.js']) {
		expect(openCommand('darwin', path, false)).toBeNull()
		expect(openCommand('linux', path, false)).toBeNull()
		expect(openCommand('win32', path, false)).toBeNull()
	}
})

test('openCommand reveals what the platform would run instead of showing', () => {
	expect(openCommand('darwin', '/repo/Deploy.COMMAND', false)).toEqual({ argv: ['open', '-R', '/repo/Deploy.COMMAND'], isReveal: true })
	expect(openCommand('darwin', '/Apps/Tool.app', false)?.isReveal).toBe(true)
	// Windows reveals by opening the folder: explorer's /select, breaks on spaces and commas once spawned.
	expect(openCommand('win32', 'C:/repo/my tools/setup.exe', false)).toEqual({ argv: ['explorer', 'C:\\repo\\my tools'], isReveal: true })
	expect(openCommand('win32', 'C:/setup.exe', false)).toEqual({ argv: ['explorer', 'C:\\'], isReveal: true })
	expect(openCommand('win32', 'C:/repo/run.PS1', false)?.isReveal).toBe(true)
	expect(openCommand('linux', '/repo/bin/run.sh', false)).toEqual({ argv: ['xdg-open', '/repo/bin'], isReveal: true })
	expect(openCommand('linux', '/run.sh', false)).toEqual({ argv: ['xdg-open', '/'], isReveal: true })
	expect(openCommand('linux', '/home/me/x.AppImage', false)?.isReveal).toBe(true)
})

test('openCommand judges the extension per platform', () => {
	// A script on macOS is shown by open; a .command is not.
	expect(openCommand('darwin', '/repo/run.sh', false)?.isReveal).toBe(false)
	expect(openCommand('linux', '/repo/a.exe', false)?.isReveal).toBe(false)
	expect(openCommand('win32', 'C:/repo/a.sh', false)?.isReveal).toBe(false)
	// Only the last extension counts, and a name that merely contains one is a document.
	expect(openCommand('win32', 'C:/repo/a.exe.txt', false)?.isReveal).toBe(false)
	expect(openCommand('win32', 'C:/repo/exe', false)?.isReveal).toBe(false)
})

test('openCommand reveals anything executable, whatever its extension', () => {
	expect(openCommand('darwin', '/repo/gradlew', true)).toEqual({ argv: ['open', '-R', '/repo/gradlew'], isReveal: true })
	expect(openCommand('darwin', '/repo/.git/hooks/pre-commit', true)?.isReveal).toBe(true)
	expect(openCommand('linux', '/repo/bin/rails', true)).toEqual({ argv: ['xdg-open', '/repo/bin'], isReveal: true })
	expect(openCommand('linux', '/repo/notes.md', true)?.isReveal).toBe(true)
	// Not executable and no runnable extension: opened.
	expect(openCommand('darwin', '/repo/gradlew', false)?.isReveal).toBe(false)
})

test('openCommand never opens a Windows path explorer would split at a comma', () => {
	// A comma in the name: the folder is shown instead.
	expect(openCommand('win32', 'C:/repo/a,b.md', false)).toEqual({ argv: ['explorer', 'C:\\repo'], isReveal: true })
	// A comma in the folder too: nothing safe is left to run.
	expect(openCommand('win32', 'C:/re,po/a,b.md', false)).toBeNull()
	expect(openCommand('win32', 'C:/re,po/setup.exe', false)).toBeNull()
})

test('openCommand ignores the trailing dots and spaces Windows ignores', () => {
	expect(openCommand('win32', 'C:/repo/setup.exe.', false)?.isReveal).toBe(true)
	expect(openCommand('win32', 'C:/repo/setup.exe ', false)?.isReveal).toBe(true)
	expect(openCommand('win32', 'C:/repo/setup.exe. . ', false)?.isReveal).toBe(true)
	expect(openCommand('win32', 'C:/repo/notes.md.', false)?.isReveal).toBe(false)
	// Elsewhere a trailing dot is part of the name.
	expect(openCommand('darwin', '/repo/run.command.', false)?.isReveal).toBe(false)
})

test('openCommand knows the other launchers', () => {
	for (const name of ['a.pif', 'a.msp', 'a.application', 'a.appref-ms', 'a.URL', 'a.scf', 'a.msc', 'a.chm', 'a.reg', 'a.wsc', 'a.ws', 'a.settingcontent-ms', 'a.appx', 'a.msix', 'a.jar']) {
		expect(openCommand('win32', `C:/repo/${name}`, false)?.isReveal).toBe(true)
	}
	for (const name of ['a.jar', 'a.fileloc', 'a.inetloc', 'a.prefpane']) expect(openCommand('darwin', `/repo/${name}`, false)?.isReveal).toBe(true)
	expect(openCommand('linux', '/repo/a.jar', false)?.isReveal).toBe(true)
})

test('cdTarget reads the folder a command starts by changing to', () => {
	expect(cdTarget('cd /a && x', '/h')).toBe('/a')
	expect(cdTarget('cd /a; x', '/h')).toBe('/a')
	expect(cdTarget('cd /a\nx', '/h')).toBe('/a')
	expect(cdTarget('  cd /a/ && x', '/h')).toBe('/a')
	expect(cdTarget('cd ~/w; x', '/h')).toBe('/h/w')
	expect(cdTarget('cd ~ && x', '/h')).toBe('/h')
	expect(cdTarget('cd "/a b" && x', '/h')).toBe('/a b')
	expect(cdTarget("cd '/a b' && x", '/h')).toBe('/a b')
	expect(cdTarget('cd rel/dir && x', '/h')).toBe('rel/dir')
})

test('cdTarget is null without a leading cd, or one it cannot resolve', () => {
	expect(cdTarget('sed -i s/a/b/ x.ts', '/h')).toBeNull()
	expect(cdTarget('echo hi && cd /a && x', '/h')).toBeNull()
	expect(cdTarget('cd', '/h')).toBeNull()
	expect(cdTarget('cd /a', '/h')).toBeNull()
	expect(cdTarget('cd /a | tee x', '/h')).toBeNull()
	expect(cdTarget('cdx /a && x', '/h')).toBeNull()
	expect(cdTarget('cd - && x', '/h')).toBeNull()
	expect(cdTarget('cd $HOME/w && x', '/h')).toBeNull()
	// A home that is not known leaves a ~ unresolved.
	expect(cdTarget('cd ~/w && x', undefined)).toBeNull()
})

test('changedFiles splits find’s NUL output, drops empties and gives up past the cap', () => {
	expect(changedFiles('/r/a.ts\0/r/b dir/c.ts\0')).toEqual(['/r/a.ts', '/r/b dir/c.ts'])
	expect(changedFiles('\0\0/r/a.ts\0\0')).toEqual(['/r/a.ts'])
	expect(changedFiles('')).toEqual([])
	expect(changedFiles('C:\\r\\a.ts\0')).toEqual(['C:/r/a.ts'])
	const many = (count: number) => Array.from({ length: count }, (_, at) => `/r/f${at}.js\0`).join('')
	expect(changedFiles(many(100))).toHaveLength(100)
	expect(changedFiles(many(101))).toEqual([])
	expect(changedFiles(many(3), 2)).toEqual([])
})

test('changedFiles leaves out the ignored paths before it counts against the cap', () => {
	expect(changedFiles('/r/a.ts\0/r/s.log\0', 100, '/r/s.log\0')).toEqual(['/r/a.ts'])
	expect(changedFiles('/r/a.ts\0', 100, '')).toEqual(['/r/a.ts'])
	const many = (count: number) => Array.from({ length: count }, (_, at) => `/r/f${at}.js\0`).join('')
	expect(changedFiles(many(102), 100, '/r/f0.js\0/r/f1.js\0')).toHaveLength(100)
	expect(changedFiles(many(102), 100, '/r/f0.js\0')).toEqual([])
})

test('the scan skips folders that hold dependencies, builds and caches', () => {
	expect(SCAN_PRUNE.slice(0, 2)).toEqual(['.git', 'node_modules'])
	expect(SCAN_PRUNE).toContain('__pycache__')
	expect(new Set(SCAN_PRUNE).size).toBe(SCAN_PRUNE.length)
})

test('a chip is the upper-cased extension, cut to 4, toned by kind', () => {
	expect(chipOf('/r/a.jsx')).toEqual({ label: 'JSX', tone: 'code' })
	expect(chipOf('/r/a.test.JS')).toEqual({ label: 'JS', tone: 'code' })
	expect(chipOf('/r/README.md')).toEqual({ label: 'MD', tone: 'docs' })
	expect(chipOf('/r/package.json')).toEqual({ label: 'JSON', tone: 'data' })
	expect(chipOf('/r/.env')).toEqual({ label: 'ENV', tone: 'data' })
	// A dotfile has an extension only when it is one we know; one with a real last extension keeps it.
	expect(chipOf('/r/.gitignore')).toEqual({ label: 'FILE', tone: 'other' })
	expect(chipOf('/r/.eslintrc')).toEqual({ label: 'FILE', tone: 'other' })
	expect(chipOf('/r/.env.local')).toEqual({ label: 'LOCA', tone: 'other' })
	expect(chipOf('/r/logo.png')).toEqual({ label: 'PNG', tone: 'other' })
	expect(chipOf('/r/Makefile')).toEqual({ label: 'FILE', tone: 'other' })
	expect(chipOf('/r/trailing.')).toEqual({ label: 'FILE', tone: 'other' })
	expect(chipOf('/r/notes.markdown')).toEqual({ label: 'MARK', tone: 'other' })
	// The dot of a folder is not an extension.
	expect(chipOf('/r/v1.2/Makefile')).toEqual({ label: 'FILE', tone: 'other' })
})

const list = [
	entry('/repo/src/pricing/PriceTable.jsx', 'edited', 3),
	entry('/repo/README.md', 'read', 1),
	entry('/repo/test/a.test.jsx', 'committed', 2),
	entry('/elsewhere/x.json', 'read', 4)
]

test('the touched rows run newest first and carry name, folder, chip and counts', () => {
	const rows = touchedRows(list, '/repo', 'completed', { '/repo/src/pricing/PriceTable.jsx': [12, 3] })
	expect(rows.map(row => row.path)).toEqual([
		'/elsewhere/x.json',
		'/repo/src/pricing/PriceTable.jsx',
		'/repo/test/a.test.jsx',
		'/repo/README.md'
	])
	expect(rows[1]).toEqual({
		key: 'file:/repo/src/pricing/PriceTable.jsx',
		path: '/repo/src/pricing/PriceTable.jsx',
		name: 'PriceTable.jsx',
		folder: 'src/pricing',
		state: 'edited',
		pill: 'edited',
		isLive: false,
		added: 12,
		removed: 3,
		chip: { label: 'JSX', tone: 'code' }
	})
	// Missing counts are 0; the root is '.', and outside the project the folder is absolute.
	expect(rows.map(row => row.folder)).toEqual(['/elsewhere', 'src/pricing', 'test', '.'])
	expect(rows[0]).toMatchObject({ added: 0, removed: 0 })
	expect(touchedRows([entry('/top.js', 'read')], '/repo', 'running', {})[0].folder).toBe('/')
})

test('equal touch times keep the later entry first', () => {
	const rows = touchedRows([entry('/r/a', 'read', 5), entry('/r/b', 'read', 5)], '/r', 'completed', {})
	expect(rows.map(row => row.name)).toEqual(['b', 'a'])
	const running = touchedRows([entry('/r/a', 'read', 5), entry('/r/b', 'read', 5)], '/r', 'running', {})
	expect(running.map(row => [row.name, row.isLive])).toEqual([
		['b', true],
		['a', false]
	])
})

test('only the latest touch is live, and only while the agent runs, with its own pill words', () => {
	const running = touchedRows(list, '/repo', 'running', {})
	expect(running.map(row => [row.isLive, row.pill])).toEqual([
		[true, 'reading'],
		[false, 'edited'],
		[false, 'committed'],
		[false, 'read']
	])
	expect(touchedRows([entry('/r/a', 'edited')], '/r', 'running', {})[0].pill).toBe('editing')
	expect(touchedRows([entry('/r/a', 'committed')], '/r', 'running', {})[0].pill).toBe('committed')
	for (const status of ['idle', 'waiting', 'pending', 'completed', 'failed', 'killed', 'stopped'] as const)
		expect(touchedRows(list, '/repo', status, {}).some(row => row.isLive)).toBe(false)
	expect(touchedRows([], '/repo', 'running', {})).toEqual([])
})

test('the touched rows read a root with a trailing slash or of /', () => {
	expect(touchedRows(list, '/repo/', 'running', {})).toEqual(touchedRows(list, '/repo', 'running', {}))
	expect(touchedRows([entry('/repo/src/a.js', 'read')], '/', 'completed', {})[0].folder).toBe('repo/src')
})

test('right now names the live file with its folder and counts while the agent runs', () => {
	const lines = { '/repo/src/pricing/PriceTable.jsx': [12, 3] as [number, number] }
	const now = rightNow([entry('/repo/src/pricing/PriceTable.jsx', 'edited', 3)], 'running', '/repo', lines, {})
	expect(now).toEqual({
		label: 'RIGHT NOW',
		tone: 'edited',
		icon: 'pencil',
		title: 'Editing PriceTable.jsx',
		subtitle: 'src/pricing  +12 \u22123',
		added: 12,
		removed: 3,
		totals: { added: 12, removed: 3 },
		repoTop: null
	})
	expect(rightNow([entry('/repo/a.js', 'read')], 'running', '/repo', {}, {})).toMatchObject({
		tone: 'read',
		icon: 'eye',
		title: 'Reading a.js',
		subtitle: '',
		added: 0,
		removed: 0
	})
	expect(rightNow([entry('/repo/a.js', 'committed')], 'running', '/repo', {}, {})).toMatchObject({
		tone: 'committed',
		icon: 'check',
		title: 'Committed a.js'
	})
})

test('the subtitle is the folder, the counts, or both, and an outside folder is absolute', () => {
	const at = (path: string, counts: Record<string, [number, number]>) =>
		rightNow([entry(path, 'edited')], 'running', '/repo', counts, {}).subtitle
	expect(at('/repo/a.js', {})).toBe('')
	expect(at('/repo/a.js', { '/repo/a.js': [2, 0] })).toBe('+2')
	expect(at('/repo/a.js', { '/repo/a.js': [0, 5] })).toBe('\u22125')
	expect(at('/repo/src/a.js', {})).toBe('src')
	expect(at('/elsewhere/a.js', {})).toBe('/elsewhere')
	expect(at('/a.js', {})).toBe('/')
})

test('an agent that waits shows WAITING in amber with a pause, whatever it touched last', () => {
	for (const status of ['pending', 'waiting', 'idle'] as const)
		expect(rightNow([entry('/repo/a.js', 'edited')], status, '/repo', {}, {})).toMatchObject({
			label: 'WAITING',
			tone: 'waiting',
			icon: 'pause',
			title: 'Editing a.js'
		})
	expect(rightNow([], 'idle', '/repo', {}, {})).toMatchObject({ label: 'WAITING', icon: 'pause', title: 'No files yet', subtitle: '' })
	// A running agent that has touched nothing yet has nothing to shine on either.
	expect(rightNow([], 'running', '/repo', {}, {})).toMatchObject({
		label: 'RIGHT NOW',
		tone: 'waiting',
		icon: 'pause',
		title: 'No files yet',
		subtitle: ''
	})
})

test('an ended agent shows DONE, titled by its dominant state and summed by state', () => {
	const mixed = [entry('/repo/a', 'read', 1), entry('/repo/b', 'edited', 2), entry('/repo/c', 'committed', 3), entry('/repo/d', 'edited', 4)]
	for (const status of ['completed', 'failed', 'killed', 'stopped'] as const)
		expect(rightNow(mixed, status, '/repo', {}, {})).toMatchObject({
			label: 'DONE',
			tone: 'edited',
			icon: 'check',
			title: 'Edited 2 files',
			subtitle: 'edited 2, committed 1, read 1'
		})
	expect(rightNow([entry('/r/a', 'committed'), entry('/r/b', 'read'), entry('/r/c', 'committed')], 'completed', '/r', {}, {})).toMatchObject({
		tone: 'committed',
		title: 'Committed 2 files',
		subtitle: 'committed 2, read 1'
	})
	expect(rightNow([entry('/r/a', 'read')], 'completed', '/r', {}, {})).toMatchObject({ tone: 'read', title: 'Read 1 file', subtitle: 'read 1' })
	expect(rightNow([], 'completed', '/r', {}, {})).toMatchObject({ label: 'DONE', icon: 'check', title: 'No files yet', subtitle: '' })
})

test('right now totals the counts of every file and shows the latest file’s own', () => {
	const files = [entry('/r/a', 'edited', 1), entry('/r/b', 'edited', 2), entry('/r/c', 'read', 3)]
	const lines: Record<string, [number, number]> = { '/r/a': [10, 1], '/r/b': [2, 4], '/r/gone': [99, 99] }
	expect(rightNow(files, 'running', '/r', lines, {})).toMatchObject({ added: 0, removed: 0, totals: { added: 12, removed: 5 } })
	expect(rightNow(files.slice(0, 2), 'completed', '/r', lines, {})).toMatchObject({ added: 2, removed: 4, totals: { added: 12, removed: 5 } })
})

test('the repository is the longest known top above the latest file', () => {
	const repos = {
		'/repo': { branch: 'main', changed: 1 },
		'/repo/packages/app': { branch: 'feat/x', changed: 0 },
		'/repository': { branch: 'other', changed: 2 }
	}
	const top = (path: string, known = repos) => rightNow([entry(path, 'read')], 'running', '/repo', {}, known).repoTop
	expect(top('/repo/packages/app/src/a.js')).toBe('/repo/packages/app')
	expect(top('/repo/src/a.js')).toBe('/repo')
	// A sibling that merely starts with the same letters is not above the file.
	expect(top('/repository/a.js')).toBe('/repository')
	expect(top('/repo-two/a.js')).toBeNull()
	expect(top('/repo/src/a.js', {})).toBeNull()
	expect(rightNow([], 'running', '/repo', {}, repos).repoTop).toBeNull()
	// While DONE it is the latest touch's repository.
	expect(rightNow([entry('/repo/packages/app/a', 'read', 2), entry('/repo/b', 'read', 1)], 'completed', '/repo', {}, repos).repoTop).toBe('/repo/packages/app')
})

test('the terminal shine gives each letter a colour, with a 3-letter band moving every 120 ms', () => {
	const colors = (now: number) => shineColors('abcdef', now, 'B', 'W')
	expect(colors(0)).toEqual(['W', 'W', 'W', 'B', 'B', 'B'])
	expect(colors(119)).toEqual(colors(0))
	expect(colors(120)).toEqual(['B', 'W', 'W', 'W', 'B', 'B'])
	// The band wraps past the last letter, and the sweep repeats after one pass.
	expect(colors(120 * 4)).toEqual(['W', 'B', 'B', 'B', 'W', 'W'])
	expect(colors(120 * 5)).toEqual(['W', 'W', 'B', 'B', 'B', 'W'])
	expect(colors(120 * 6)).toEqual(colors(0))
	expect(shineColors('', 500, 'B', 'W')).toEqual([])
	expect(shineColors('ab', 0, 'B', 'W')).toEqual(['W', 'W'])
})

test('numstat reads added and removed counts by path, a binary file as 0 and 0', () => {
	expect(numstat('12\t3\tsrc/PriceTable.jsx\0')).toEqual({ 'src/PriceTable.jsx': [12, 3] })
	expect(numstat('1\t0\ta.js\0-\t-\timg/logo.png\0')).toEqual({ 'a.js': [1, 0], 'img/logo.png': [0, 0] })
	expect(numstat('')).toEqual({})
	expect(numstat('\0')).toEqual({})
	// A tab inside the name stays in the name.
	expect(numstat('2\t1\ta\tb.js\0')).toEqual({ 'a\tb.js': [2, 1] })
})

test('numstat takes a rename’s new path, which -z prints after an empty name and the old path', () => {
	expect(numstat('0\t0\t\0old.js\0new.js\0' + '5\t1\tz.js\0')).toEqual({ 'new.js': [0, 0], 'z.js': [5, 1] })
})
