import { expect, mock, test } from 'claude-code/testing'

import { MAX_ROWS, STATE_COLORS } from '../hooks/files-pane'

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
	// A Bash call whose command contains this fails, as a script that exits non-zero does.
	failingCommand?: string
	// A `process.run` whose joined argv starts with this throws, as a command that cannot start does.
	throwing?: string
	// Whether `ui.open` finds room for a pane; true when left out.
	isPlaced?: boolean
}

const answer = (table: Record<string, string | number> | undefined, argv: string[]) =>
	Object.entries(table ?? {}).find(([prefix]) => argv.join(' ').startsWith(prefix))?.[1]

async function start($: any, on: any, options: Options = {}) {
	const clock = mock.clock(on, { now: 1000 })
	mock.store(on)
	const opened: Array<{ id: string; title: string }> = []
	const closed: string[] = []
	const ran: string[][] = []
	const stdins: Array<{ argv: string[]; stdin: string | undefined }> = []
	const toasts: string[] = []
	on('command.register', () => ({ value: { command: 'crew' } }))
	on('tool.register', () => ({ value: { tool: 'mcp__crew__set_mascot' } }))
	on('ui.open', (_: unknown, e: any) => {
		opened.push({ id: e.id, title: e.title })
		return { value: { isPlaced: options.isPlaced ?? true } }
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
		// The kit hands `$.process.run`'s second argument to its hooks as `e.init`.
		stdins.push({ argv, stdin: e.init?.stdin })
		if (options.throwing && argv.join(' ').startsWith(options.throwing)) throw new Error('could not start')
		const stdout = String(answer(options.stdout, argv) ?? '')
		const exitCode = Number(answer(options.exits, argv) ?? 0)
		return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
	})
	on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
	on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
	on('turn.complete', () => ({ text: '' }))
	on('tool.call', (_: unknown, e: any) =>
		(options.failing && String(e.file_path ?? '').includes(options.failing)) ||
		(options.failingCommand && String(e.command ?? '').includes(options.failingCommand))
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
	return { clock, opened, closed, ran, stdins, toasts }
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

test('a Files pane nobody sees leaves the chevron unlit and says so', async ($, on) => {
	const { toasts } = await start($, on, { isPlaced: false })
	await $.tool.call(read('/repo/a.js', 'a1'))
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await ui.press({ key: 'files-a1' })
	expect((await ui.find({ key: 'files-a1' }))?.text).toBe('▸ 1')
	expect(toasts.some(toast => toast.includes('Files pane'))).toBe(true)
	await ui.unmount()
})

const NB = '\u00a0'

// The kit hands back keys on Boxes and Buttons only, so a row's cells are read off its keyed Box: for a file
// [guide, dot, name cell, state word], for a folder [guide, name].
const cells = async (files: any, key: string): Promise<any[]> => (await files.find({ key }))?.children ?? []
const shown = (cell: any): string | undefined => cell?.children?.[0]

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
		expect(shown((await cells(files, 'dir:/src/pricing'))[1])).toBe('src/pricing/')
		expect(shown((await cells(files, 'file:/repo/src/pricing/usePrices.js'))[0])).toBe(`│${NB}└`)
		expect((await files.find({ key: 'open-/repo/src/pricing/PriceTable.jsx' }))?.text).toBe('PriceTable.jsx')
		const state = (await cells(files, 'file:/repo/src/pricing/PriceTable.jsx'))[3]
		expect(shown(state)).toBe('edited')
		expect(state.props.color).toBe(STATE_COLORS.edited)
		expect((await cells(files, 'file:/repo/src/pricing/usePrices.js'))[3].props.color).toBe(STATE_COLORS.read)
		expect((await cells(files, 'out:/outside project'))[1].props.dimColor).toBe(true)
		// No commit yet: the legend leaves committed out, and there is no footer.
		expect(await files.find({ type: 'Text', text: /^● committed$/ })).toBeUndefined()
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
	const dotOf = async (path: string) => (await cells(files, `file:${path}`))[1]?.props.color
	const first = await dotOf('/repo/b.js')
	await clock.advance(500)
	const second = await dotOf('/repo/b.js')
	expect(first).not.toBe(second)
	// Only the live file pulses.
	expect(await dotOf('/repo/a.js')).toBe(STATE_COLORS.read)
	await $.turn.complete({ turnId: 'x', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	expect((await files.find({ type: 'Text', text: /^DONE$/ }))?.text).toBe('DONE')
	expect((await files.find({ type: 'Text', text: /^edited 1, read 1$/ }))?.text).toBe('edited 1, read 1')
	expect(await dotOf('/repo/b.js')).toBe(STATE_COLORS.edited)
	await files.unmount()
	await pane.unmount()
})

// Copied from test/ui.test.ts: Desktop drops a whole drawing at 2,000 nodes, 32 levels or 262,144 characters, so each
// element and each text child counts as a node and every string in props or children toward the characters.
function desktopMeasure(node: any, depth = 1): { nodes: number; chars: number; depth: number } {
	if (typeof node === 'string') return { nodes: 1, chars: node.length, depth }
	const own = Object.values(node?.props ?? {}).reduce(
		(sum: number, value: any) => sum + (typeof value === 'string' ? value.length : String(value ?? '').length),
		0
	)
	return (node?.children ?? []).reduce(
		(sum: any, child: any) => {
			const inner = desktopMeasure(child, depth + 1)
			return { nodes: sum.nodes + inner.nodes, chars: sum.chars + inner.chars, depth: Math.max(sum.depth, inner.depth) }
		},
		{ nodes: 1, chars: own, depth }
	)
}

test('a long file list stays inside the drawing budget with a count of the rest', async ($, on) => {
	await start($, on)
	for (let i = 0; i < 300; i++) await $.tool.call(read(`/repo/src/f${String(i).padStart(3, '0')}.js`, 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await pane.find({ key: 'files-a1' }))?.text).toBe('▸ 200')
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	// MAX_ROWS rows: the src/ folder and the files after it, up to the cap.
	expect(await files.findAll({ type: 'Button' })).toHaveLength(MAX_ROWS - 1)
	expect((await files.find({ type: 'Text', text: /more$/ }))?.text).toBe(`+ ${201 - MAX_ROWS} more`)
	// What Desktop will draw: under 2,000 nodes, 32 levels and 262,144 characters.
	const measured = desktopMeasure(await files.drawn())
	expect(measured.nodes).toBeLessThan(2000)
	expect(measured.depth).toBeLessThan(32)
	expect(measured.chars).toBeLessThan(262_144)
	await files.unmount()
	await pane.unmount()
})

test('the live dot reaches its full colour at the pulse’s peak on both surfaces', async ($, on) => {
	const { clock } = await start($, on)
	await $.tool.call(edit('/repo/b.js', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const hex = STATE_COLORS.edited
	const rgba = `rgba(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(',')},1)`
	const desktop = await $.ui.mount({ ...FILES, surface: 'desktop' })
	const terminal = await $.ui.mount({ ...FILES, surface: 'terminal' })
	// The clock starts on the peak of the two-second cycle.
	expect((await cells(desktop, 'file:/repo/b.js'))[1].props.color).toBe(rgba)
	expect((await cells(terminal, 'file:/repo/b.js'))[1].props.color).toBe(hex)
	await clock.advance(1000)
	expect((await cells(desktop, 'file:/repo/b.js'))[1].props.color).not.toBe(rgba)
	expect((await cells(terminal, 'file:/repo/b.js'))[1].props.color).not.toBe(hex)
	await desktop.unmount()
	await terminal.unmount()
	await pane.unmount()
})

// A normal open on macOS asks `test -x <path> -o -L <path>` first; every file but gradlew answers no.
const DARWIN = { stdout: { 'uname -s': 'Darwin\n' }, exits: { 'test -x /repo/gradlew': 0, 'test -x': 1 } }

async function openRow($: any, on: any, options: Options, paths: string[]) {
	const run = await start($, on, { ...DARWIN, ...options })
	for (const path of paths) await $.tool.call(read(path, 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	return { ...run, files, pane }
}

test('a file the platform would run is shown in its folder, any other opens', async ($, on) => {
	const { ran, toasts, files, pane } = await openRow($, on, {}, ['/repo/a.js', '/repo/run.command'])
	await files.press({ key: 'open-/repo/a.js' })
	expect(ran.at(-1)).toEqual(['open', '/repo/a.js'])
	expect(toasts.some(toast => toast.includes('a.js'))).toBe(false)
	await files.press({ key: 'open-/repo/run.command' })
	expect(ran.at(-1)).toEqual(['open', '-R', '/repo/run.command'])
	expect(toasts.some(toast => toast.includes('showed run.command in its folder rather than running it'))).toBe(true)
	await files.unmount()
	await pane.unmount()
})

test('an executable file is shown in its folder whatever its name', async ($, on) => {
	const { ran, toasts, files, pane } = await openRow($, on, {}, ['/repo/gradlew', '/repo/a.js'])
	await files.press({ key: 'open-/repo/gradlew' })
	expect(ran).toContainEqual(['test', '-x', '/repo/gradlew', '-o', '-L', '/repo/gradlew'])
	expect(ran.at(-1)).toEqual(['open', '-R', '/repo/gradlew'])
	expect(toasts.some(toast => toast.includes('showed gradlew in its folder rather than running it'))).toBe(true)
	await files.press({ key: 'open-/repo/a.js' })
	expect(ran.at(-1)).toEqual(['open', '/repo/a.js'])
	await files.unmount()
	await pane.unmount()
})

test('a symlink is shown in its folder, since opening it opens its target', async ($, on) => {
	const link = '/repo/README.md'
	const exits = { [`test -x ${link} -o -L ${link}`]: 0, 'test -x': 1 }
	const { ran, toasts, files, pane } = await openRow($, on, { exits }, [link, '/repo/a.js'])
	await files.press({ key: `open-${link}` })
	expect(ran.at(-1)).toEqual(['open', '-R', link])
	expect(toasts.some(toast => toast.includes('showed README.md in its folder rather than running it'))).toBe(true)
	await files.press({ key: 'open-/repo/a.js' })
	expect(ran.at(-1)).toEqual(['open', '/repo/a.js'])
	await files.unmount()
	await pane.unmount()
})

test('a file whose executable check cannot run is treated as executable', async ($, on) => {
	const { ran, files, pane } = await openRow($, on, { throwing: 'test -x' }, ['/repo/a.js'])
	await files.press({ key: 'open-/repo/a.js' })
	expect(ran.at(-1)).toEqual(['open', '-R', '/repo/a.js'])
	await files.unmount()
	await pane.unmount()
})

test('a card dropped by a new prompt leaves the Files pane with its how-to message', async ($, on) => {
	await start($, on)
	await $.tool.call(read('/repo/a.js', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect(await files.find({ type: 'Text', text: /^RIGHT NOW$|^DONE$/ })).toBeDefined()
	await $.turn.complete({ turnId: 'x', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	await $.turn.start({ text: 'Next', turnId: 't2' })
	expect((await files.find({ type: 'Text', text: /Press ▸/ }))?.text).toBe('Press ▸ on a card in the Agents pane to see its files.')
	await files.unmount()
	await pane.unmount()
})

test('pressing a file row opens it in the default app, and a failed open says so', async ($, on) => {
	// Not executable (`test -x` exits 1), so both rows open rather than reveal.
	const { clock, ran, toasts } = await start($, on, {
		stdout: { uname: 'Darwin\n' },
		exits: { 'test -x': 1, 'open /repo/gone.js': 1 }
	})
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

const stateOf = async (files: any, path: string) => shown((await cells(files, `file:${path}`))[3])

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
		'--',
		'/repo/src/pricing/PriceTable.jsx',
		'/repo/test/PriceTable.test.jsx'
	])
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	const committed = (await cells(files, 'file:/repo/test/PriceTable.test.jsx'))[3]
	expect(shown(committed)).toBe('committed')
	expect(committed.props.color).toBe(STATE_COLORS.committed)
	expect(await stateOf(files, '/repo/src/pricing/PriceTable.jsx')).toBe('edited')
	expect(await stateOf(files, '/repo/src/pricing/usePrices.js')).toBe('read')
	expect(await stateOf(files, '/Users/me/notes.md')).toBe('edited')
	expect(await files.find({ type: 'Text', text: /^● committed$/ })).toBeDefined()
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
	expect(await stateOf(files, `${worktree}/b.js`)).toBe('committed')
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
	expect(ran).toContainEqual([
		'git',
		'--no-optional-locks',
		'-C',
		'/repo',
		'ls-files',
		'-z',
		'--full-name',
		'--',
		'/repo/kept.js',
		'/repo/probe.js'
	])
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect(await stateOf(files, '/repo/kept.js')).toBe('committed')
	expect(await stateOf(files, '/repo/probe.js')).toBe('edited')
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
	expect(await stateOf(files, '/repo/src/a.js')).toBe('edited')
	expect(await stateOf(files, '/repo/src/dist.js')).toBe('edited')
	expect(await files.find({ type: 'Text', text: /^committed / })).toBeUndefined()
	await files.unmount()
	await pane.unmount()
})

test('Main committing turns a sub-agent’s clean edit green too, and every pane shows the SHA', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: {
			[`${GIT} /repo/src rev-parse --show-cdup`]: '../\n',
			[`${GIT} /repo rev-parse --show-cdup`]: '\n',
			[`${GIT} /repo ls-files`]: 'src/a.js\0README.md\0',
			[`${GIT} /repo rev-parse --short HEAD`]: 'abc1234\n'
		}
	})
	await $.tool.call(edit('/repo/src/a.js', 'a1'))
	await $.tool.call(edit('/repo/README.md'))
	await $.tool.call({ tool: 'Bash', command: 'git commit -am x' } as any)
	await clock.settle()
	const statuses = ran.filter(argv => argv.join(' ').startsWith(`${GIT} /repo status`))
	expect(statuses).toHaveLength(1)
	expect(statuses[0].slice(-2).sort()).toEqual(['/repo/README.md', '/repo/src/a.js'])
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	for (const [key, path] of [
		['files-a1', '/repo/src/a.js'],
		['files-main', '/repo/README.md']
	]) {
		await pane.press({ key })
		const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
		expect(await stateOf(files, path)).toBe('committed')
		expect((await files.find({ type: 'Text', text: /^committed abc1234$/ }))?.text).toBe('committed abc1234')
		await files.unmount()
	}
	await pane.unmount()
})

test('a commit leaves another agent’s still-dirty file edited, with no footer in its pane', async ($, on) => {
	const { clock } = await start($, on, {
		stdout: {
			[`${GIT} /repo rev-parse --show-cdup`]: '\n',
			[`${GIT} /repo status`]: ' M wip.js\0',
			[`${GIT} /repo ls-files`]: 'a.js\0',
			[`${GIT} /repo rev-parse --short HEAD`]: 'abc1234\n'
		}
	})
	await $.tool.call(edit('/repo/a.js', 'a1'))
	await $.tool.call(edit('/repo/wip.js', 'a2'))
	await $.tool.call({ tool: 'Bash', command: 'git commit -am x', agentId: 'a1' } as any)
	await clock.settle()
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a2' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect(await stateOf(files, '/repo/wip.js')).toBe('edited')
	expect(await files.find({ type: 'Text', text: /^committed / })).toBeUndefined()
	await files.unmount()
	await pane.press({ key: 'files-a1' })
	const first = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect(await stateOf(first, '/repo/a.js')).toBe('committed')
	await first.unmount()
	await pane.unmount()
})

const MARK = '/tmp/crew-mark.abc'
const bash = (command: string, agentId?: string, extra: object = {}) =>
	({ tool: 'Bash', command, ...(agentId ? { agentId } : {}), ...extra }) as any
// What `find` prints: each path ended by a NUL.
const found = (...paths: string[]) => paths.map(path => `${path}\0`).join('')
const finds = (ran: string[][]) => ran.filter(argv => argv[0] === 'find')

test('the files a Bash command rewrote are recorded as edited for the agent that ran it', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: {
			mktemp: `${MARK}\n`,
			[`${GIT} /repo rev-parse --show-cdup`]: '\n',
			'find /repo': found('/repo/lib/notebook.ts', '/repo/components/card.tsx')
		}
	})
	await $.tool.call(bash("cd /repo && python3 - <<'EOF'\nopen('lib/notebook.ts', 'w').write('x')\nEOF", 'a1'))
	await clock.settle()
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await pane.find({ key: 'files-a1' }))?.text).toBe('▸ 2')
	expect(await pane.find({ key: 'files-a2' })).toBeUndefined()
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect(await stateOf(files, '/repo/lib/notebook.ts')).toBe('edited')
	expect(await stateOf(files, '/repo/components/card.tsx')).toBe('edited')
	// The marker is made before the command and removed once the scan is done.
	expect(ran).toContainEqual(['mktemp', '-t', 'crew-mark.XXXXXX'])
	expect(ran).toContainEqual(['rm', '-f', MARK])
	const [scan] = finds(ran)
	expect(scan.slice(0, 2)).toEqual(['find', '/repo'])
	expect(scan).toContain('-newer')
	expect(scan[scan.indexOf('-newer') + 1]).toBe(MARK)
	expect(scan).toContain('-print0')
	expect(scan[scan.indexOf('node_modules') - 1]).toBe('-name')
	await files.unmount()
	await pane.unmount()
})

test('a Bash command that starts with no cd is scanned in the session folder', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: { mktemp: `${MARK}\n`, [`${GIT} /repo rev-parse --show-cdup`]: '\n', 'find /repo': found('/repo/lib/x.ts') }
	})
	await $.tool.call(bash("sed -i '' s/a/b/ lib/x.ts", 'a1'))
	await clock.settle()
	expect(ran).toContainEqual(['git', '--no-optional-locks', '-C', '/repo', 'rev-parse', '--show-cdup'])
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await pane.find({ key: 'files-a1' }))?.text).toBe('▸ 1')
	await pane.unmount()
})

test('a relative cd and a Main call land in the folder git finds, on Main’s card', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: { mktemp: `${MARK}\n`, [`${GIT} /repo/app rev-parse --show-cdup`]: '../\n', 'find /repo': found('/repo/app/y.ts') }
	})
	await $.tool.call(bash('cd app; touch y.ts'))
	await clock.settle()
	expect(finds(ran)).toHaveLength(1)
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await pane.find({ key: 'files-main' }))?.text).toBe('▸ 1')
	await pane.unmount()
})

test('outside a git repository nothing is scanned, and the marker is still removed', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: { mktemp: `${MARK}\n`, 'find /repo': found('/repo/a.ts') },
		exits: { [`${GIT} /repo rev-parse`]: 128 }
	})
	await $.tool.call(bash('sed -i x a.ts', 'a1'))
	await clock.settle()
	expect(finds(ran)).toHaveLength(0)
	expect(ran).toContainEqual(['rm', '-f', MARK])
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect(await pane.find({ key: 'files-a1' })).toBeUndefined()
	await pane.unmount()
})

test('more than 100 changed files is an install or a build, so none are recorded', async ($, on) => {
	const paths = Array.from({ length: 101 }, (_, at) => `/repo/gen/f${at}.js`)
	const { clock, ran } = await start($, on, {
		stdout: { mktemp: `${MARK}\n`, [`${GIT} /repo rev-parse --show-cdup`]: '\n', 'find /repo': found(...paths) }
	})
	await $.tool.call(bash('npm run generate', 'a1'))
	await clock.settle()
	expect(finds(ran)).toHaveLength(1)
	expect(ran).toContainEqual(['rm', '-f', MARK])
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect(await pane.find({ key: 'files-a1' })).toBeUndefined()
	await pane.unmount()
})

test('a background command makes no marker and is not scanned', async ($, on) => {
	const { clock, ran } = await start($, on, { stdout: { mktemp: `${MARK}\n` } })
	await $.tool.call(bash('npm run dev', 'a1', { run_in_background: true }))
	await clock.settle()
	expect(ran.some(argv => argv[0] === 'mktemp' || argv[0] === 'find' || argv[0] === 'rm')).toBe(false)
})

test('a marker that cannot be made skips the scan and never stops the command', async ($, on) => {
	const { clock, ran } = await start($, on, { throwing: 'mktemp' })
	const result = await $.tool.call(bash('sed -i x a.ts', 'a1'))
	await clock.settle()
	expect(result).toEqual({ result: {} })
	expect(ran.some(argv => argv[0] === 'find' || argv[0] === 'rm')).toBe(false)
})

test('a command that failed is still scanned, since its script may have written files first', async ($, on) => {
	const { clock } = await start($, on, {
		failingCommand: 'broken',
		stdout: { mktemp: `${MARK}\n`, [`${GIT} /repo rev-parse --show-cdup`]: '\n', 'find /repo': found('/repo/partial.py') }
	})
	await $.tool.call(bash('python3 broken.py', 'a1'))
	await clock.settle()
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await pane.find({ key: 'files-a1' }))?.text).toBe('▸ 1')
	await pane.unmount()
})

test('a command that edits and commits records its files before the commit check turns them green', async ($, on) => {
	const { clock } = await start($, on, {
		stdout: {
			mktemp: `${MARK}\n`,
			[`${GIT} /repo rev-parse --show-cdup`]: '\n',
			[`${GIT} /repo/src rev-parse --show-cdup`]: '../\n',
			'find /repo': found('/repo/src/a.js'),
			[`${GIT} /repo status`]: '',
			[`${GIT} /repo ls-files`]: 'src/a.js\0',
			[`${GIT} /repo rev-parse --short HEAD`]: 'abc1234\n'
		}
	})
	await $.tool.call(bash("sed -i '' s/a/b/ src/a.js && git commit -am x", 'a1'))
	await clock.settle()
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect(await stateOf(files, '/repo/src/a.js')).toBe('committed')
	expect((await files.find({ type: 'Text', text: /^committed abc1234$/ }))?.text).toBe('committed abc1234')
	await files.unmount()
	await pane.unmount()
})

const IGNORE = `${GIT} /repo check-ignore`

test('git-ignored files a Bash command wrote are dropped from what it is recorded as editing', async ($, on) => {
	const { clock, ran, stdins } = await start($, on, {
		stdout: {
			mktemp: `${MARK}\n`,
			[`${GIT} /repo rev-parse --show-cdup`]: '\n',
			'find /repo': found('/repo/src/a.ts', '/repo/server.log'),
			[IGNORE]: found('/repo/server.log')
		},
		// check-ignore exits 0 when some path is ignored.
		exits: { [IGNORE]: 0 }
	})
	await $.tool.call(bash('node build.js', 'a1'))
	await clock.settle()
	expect(ran).toContainEqual(['git', '--no-optional-locks', '-C', '/repo', 'check-ignore', '-z', '--stdin'])
	const asked = stdins.find(item => item.argv.includes('check-ignore'))
	expect(asked?.stdin).toBe(found('/repo/src/a.ts', '/repo/server.log'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await pane.find({ key: 'files-a1' }))?.text).toBe('▸ 1')
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect(await stateOf(files, '/repo/src/a.ts')).toBe('edited')
	expect(await files.find({ key: 'file:/repo/server.log' })).toBeUndefined()
	await files.unmount()
	await pane.unmount()
})

// One path git ignores and one it does not, with check-ignore failing the way `options` says; both stay recorded.
async function keepsBoth($: any, on: any, options: Options) {
	const { clock } = await start($, on, {
		...options,
		stdout: {
			mktemp: `${MARK}\n`,
			[`${GIT} /repo rev-parse --show-cdup`]: '\n',
			'find /repo': found('/repo/src/a.ts', '/repo/server.log'),
			...options.stdout
		}
	})
	await $.tool.call(bash('node build.js', 'a1'))
	await clock.settle()
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await pane.find({ key: 'files-a1' }))?.text).toBe('▸ 2')
	await pane.unmount()
}

test('check-ignore exiting 1 means nothing is ignored, so every path stays', async ($, on) => {
	await keepsBoth($, on, { exits: { [IGNORE]: 1 } })
})

test('a check-ignore that fails, or cannot run, keeps every path', async ($, on) => {
	// Whatever it printed before failing is not to be trusted.
	await keepsBoth($, on, { exits: { [IGNORE]: 128 }, stdout: { [IGNORE]: found('/repo/server.log') } })
})

test('a check-ignore that throws keeps every path', async ($, on) => {
	await keepsBoth($, on, { throwing: IGNORE })
})

test('the cap counts what is left once the ignored files are gone', async ($, on) => {
	const paths = Array.from({ length: 101 }, (_, at) => `/repo/gen/f${at}.js`)
	const { clock } = await start($, on, {
		stdout: {
			mktemp: `${MARK}\n`,
			[`${GIT} /repo rev-parse --show-cdup`]: '\n',
			'find /repo': found(...paths),
			[IGNORE]: found(paths[0])
		}
	})
	await $.tool.call(bash('npm run generate', 'a1'))
	await clock.settle()
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await pane.find({ key: 'files-a1' }))?.text).toBe('▸ 100')
	await pane.unmount()
})
