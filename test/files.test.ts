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
	openCommand,
	posix,
	touchOf
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

test('the scan skips folders that hold dependencies, builds and caches', () => {
	expect(SCAN_PRUNE.slice(0, 2)).toEqual(['.git', 'node_modules'])
	expect(SCAN_PRUNE).toContain('__pycache__')
	expect(new Set(SCAN_PRUNE).size).toBe(SCAN_PRUNE.length)
})
