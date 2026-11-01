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
	// A Bash call whose command contains this comes back marked read-only by the engine, as `ls` does.
	readOnlyCommand?: string
	// A `process.run` whose joined argv starts with this throws, as a command that cannot start does.
	throwing?: string
	// Whether `ui.open` finds room for a pane; true when left out.
	isPlaced?: boolean
	// A `process.run` whose joined argv starts with this waits for `until` before it answers, as a slow command does.
	slow?: { prefix: string; until: Promise<void> }
	// What `$.agent.list` answers at a `turn.step`, which is how Crew learns an agent waits.
	listed?: Array<{ id: string; description: string; type: string; status: string }>
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
		const value = { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
		return options.slow && argv.join(' ').startsWith(options.slow.prefix)
			? options.slow.until.then(() => ({ value }))
			: { value }
	})
	on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
	on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
	on('turn.complete', () => ({ text: '' }))
	on('tool.call', (_: unknown, e: any) =>
		(options.failing && String(e.file_path ?? '').includes(options.failing)) ||
		(options.failingCommand && String(e.command ?? '').includes(options.failingCommand))
			? { result: 'File does not exist.', isError: true }
			: options.readOnlyCommand && String(e.command ?? '').includes(options.readOnlyCommand)
				? { result: {}, isReadOnly: true }
				: { result: {} }
	)
	if (options.listed) {
		on('agent.list', () => ({ value: options.listed }))
		on('turn.step', async function* (_: unknown, e: any) {
			const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
			return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
		})
	}
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

// The kit hands back keys on Boxes and Buttons only, so a row's cells are read off its keyed Box:
// [chip, name cell (the name and the folder), +added, −removed, pill], the counts only when known.
const cells = async (files: any, key: string): Promise<any[]> => (await files.find({ key }))?.children ?? []
// What a cell says: a Text's string, or the alt of the SVG Desktop draws a chip or a pill as.
const shown = (cell: any): string | undefined => (cell?.type === 'Svg' ? cell.props.alt : cell?.children?.[0])
// The pill is padded with non-breaking spaces, which trim takes off.
const pillOf = async (files: any, path: string) => shown((await cells(files, `file:${path}`)).at(-1))?.trim()
const nameCell = async (files: any, path: string): Promise<any[]> => (await cells(files, `file:${path}`))[1]?.children ?? []

test('before any card is chosen the Files pane says how to fill it', async ($, on) => {
	await start($, on)
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect((await files.find({ type: 'Text', text: /Press ▸/ }))?.text).toBe('Press ▸ on a card in the Agents pane to see its files.')
	await files.unmount()
})

test('the Files pane draws the Right-now card and a flat list of touched files, newest first', async ($, on) => {
	await start($, on)
	await $.tool.call(read('/repo/src/pricing/usePrices.js', 'a1'))
	await $.tool.call({ tool: 'Write', file_path: '/repo/test/PriceTable.test.jsx', content: 'x', agentId: 'a1' } as any)
	await $.tool.call(edit('/repo/src/pricing/PriceTable.jsx', 'a1'))
	await $.tool.call(read('/Users/me/notes.md', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	for (const surface of ['desktop', 'terminal'] as const) {
		const files = await $.ui.mount({ ...FILES, surface })
		expect((await files.find({ type: 'Text', text: /^RIGHT NOW$/ }))?.props.color).toBe(STATE_COLORS.read)
		expect((await files.find({ type: 'Text', text: /^Reading notes\.md$/ }))?.text).toBe('Reading notes.md')
		// The folder outside the project is absolute.
		expect((await files.find({ type: 'Text', text: /^\/Users\/me$/ }))?.text).toBe('/Users/me')
		expect((await files.find({ type: 'Text', text: /^TOUCHED$/ }))?.text).toBe('TOUCHED')
		expect((await files.find({ type: 'Text', text: /^4 FILES$/ }))?.text).toBe('4 FILES')
		const touched = (await files.find({ key: 'touched' }))?.children ?? []
		expect(touched.slice(1).map((row: any) => row.props.key)).toEqual([
			'file:/Users/me/notes.md',
			'file:/repo/src/pricing/PriceTable.jsx',
			'file:/repo/test/PriceTable.test.jsx',
			'file:/repo/src/pricing/usePrices.js'
		])
		expect((await files.find({ key: 'open-/repo/src/pricing/PriceTable.jsx' }))?.text).toBe('PriceTable.jsx')
		expect(shown((await nameCell(files, '/repo/src/pricing/PriceTable.jsx'))[1])).toBe('src/pricing')
		expect(shown((await nameCell(files, '/repo/test/PriceTable.test.jsx'))[1])).toBe('test')
		// Chips name the type, toned by kind.
		expect(shown((await cells(files, 'file:/repo/src/pricing/PriceTable.jsx'))[0])?.trim()).toBe('JSX')
		expect(shown((await cells(files, 'file:/Users/me/notes.md'))[0])?.trim()).toBe('MD')
		// The live row's pill says what is happening; the others say what happened.
		expect(await pillOf(files, '/Users/me/notes.md')).toBe('reading')
		expect(await pillOf(files, '/repo/src/pricing/PriceTable.jsx')).toBe('edited')
		expect(await pillOf(files, '/repo/src/pricing/usePrices.js')).toBe('read')
		const pill = (await cells(files, 'file:/repo/src/pricing/PriceTable.jsx')).at(-1)
		const livePill = (await cells(files, 'file:/Users/me/notes.md')).at(-1)
		if (surface === 'desktop') {
			// Desktop draws chips and pills as rounded SVGs in the mockup's colours: a settled pill light on a dark wash,
			// the live one dark on its solid colour.
			expect(pill.type).toBe('Svg')
			expect(pill.props.source).toContain('fill="#47301F"')
			expect(pill.props.source).toContain('fill="#FFB98A"')
			expect(livePill.props.source).toContain(`fill="${STATE_COLORS.read}"`)
			expect((await cells(files, 'file:/Users/me/notes.md'))[0].props.source).toContain('fill="#1F2F45"')
		} else expect(pill.props.backgroundColor).toBe(STATE_COLORS.edited)
		// Only the live row is outlined: light and filled with its state where SVG is drawn, in its colour in the terminal.
		const liveRow = (await files.find({ key: 'file:/Users/me/notes.md' }))?.props
		if (surface === 'desktop') expect([liveRow.borderColor, liveRow.backgroundColor]).toEqual(['#E8E6DF', '#2B2238'])
		else expect(liveRow.borderColor).toBe(STATE_COLORS.read)
		expect((await files.find({ key: 'file:/repo/src/pricing/usePrices.js' }))?.props.borderStyle).toBeUndefined()
		// The legend always names all three states; with no commit yet there is no footer.
		const legend = (await files.find({ key: 'legend' }))?.children ?? []
		expect(legend.map((item: any) => item.children.map((part: any) => (typeof part === 'string' ? part : shown(part))).join(''))).toEqual([
			'● read',
			'● edited',
			'● committed'
		])
		expect(legend[2].children[0].props.color).toBe(STATE_COLORS.committed)
		expect(await files.find({ type: 'Text', text: /^committed / })).toBeUndefined()
		await files.unmount()
	}
	await pane.unmount()
})

test('on Desktop only the live name shines, as an SVG, and its folder shows the file in its folder', async ($, on) => {
	const { ran, toasts } = await start($, on, { stdout: { 'uname -s': 'Darwin\n' } })
	await $.tool.call(read('/repo/README.md', 'a1'))
	await $.tool.call(edit('/repo/src/PriceTable.jsx', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	const [shine, folder] = await nameCell(files, '/repo/src/PriceTable.jsx')
	expect(shine.type).toBe('Svg')
	expect(shine.props.alt).toBe('PriceTable.jsx')
	expect(shine.props.isInteractive).toBe(true)
	expect(shine.props.source).toContain('@keyframes')
	// An SVG cannot sit in a Button, so the press is the folder, named after the file; it reveals rather than opens.
	expect(folder.type).toBe('Button')
	expect(folder.props.key).toBe('open-/repo/src/PriceTable.jsx')
	expect(folder.props.label).toBe('PriceTable.jsx')
	expect(shown(folder.children[0])).toBe('src')
	expect(folder.children[0].props.color).toBe('#8D8B84')
	// Nothing past the name cell but the pill: no open mark.
	expect((await cells(files, 'file:/repo/src/PriceTable.jsx')).map((cell: any) => cell.type)).toEqual(['Svg', 'Box', 'Svg'])
	await files.press({ key: 'open-/repo/src/PriceTable.jsx' })
	expect(ran.at(-1)).toEqual(['open', '-R', '/repo/src/PriceTable.jsx'])
	expect(toasts.some(toast => toast.includes('PriceTable.jsx'))).toBe(false)
	// Another row's name is still its own Button.
	expect((await nameCell(files, '/repo/README.md'))[0].props.key).toBe('open-/repo/README.md')
	expect(await pillOf(files, '/repo/src/PriceTable.jsx')).toBe('editing')
	// The other names draw no SVG.
	expect((await nameCell(files, '/repo/README.md')).some((cell: any) => cell.type === 'Svg')).toBe(false)
	const svgs = (await files.findAll({ type: 'Svg' })).map((svg: any) => svg.props.alt)
	expect(svgs).toContain('pencil icon')
	expect(svgs).toContain('divider')
	expect(svgs.filter((alt: string) => alt === 'PriceTable.jsx')).toHaveLength(1)
	expect((await files.find({ type: 'Text', text: /^Editing PriceTable\.jsx$/ }))?.text).toBe('Editing PriceTable.jsx')
	expect((await files.find({ type: 'Text', text: /^RIGHT NOW$/ }))?.props.color).toBe(STATE_COLORS.edited)
	await files.unmount()
	await pane.unmount()
})

test('in the terminal the live name is coloured letter by letter, the band moving with the clock', async ($, on) => {
	const { clock } = await start($, on)
	await $.tool.call(read('/repo/a.js', 'a1'))
	await $.tool.call(edit('/repo/PriceTable.jsx', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'terminal' })
	expect(await files.findAll({ type: 'Svg' })).toHaveLength(0)
	const letters = async () => (await nameCell(files, '/repo/PriceTable.jsx'))[0]?.children ?? []
	expect((await letters()).map(shown).join('')).toBe('PriceTable.jsx')
	const colors = async () => (await letters()).map((letter: any) => letter.props.color)
	const first = await colors()
	expect(first).toContain(STATE_COLORS.edited)
	expect(new Set(first).size).toBe(2)
	// The terminal redraws every other beat while the agent runs; the band has moved a letter or more by then.
	await clock.advance(400)
	expect(await colors()).not.toEqual(first)
	// The live name is still the Button that opens it; another row's name is one plain Text.
	expect((await files.find({ key: 'open-/repo/PriceTable.jsx' }))?.props.label).toBe('PriceTable.jsx')
	expect((await nameCell(files, '/repo/a.js'))[0]?.children).toHaveLength(1)
	// The icon is a coloured glyph.
	expect((await files.find({ type: 'Text', text: /^✎$/ }))?.props.color).toBe(STATE_COLORS.edited)
	await files.unmount()
	await pane.unmount()
})

test('the Right-now card sums up once the agent is done, and every pill turns past tense', async ($, on) => {
	await start($, on)
	await $.tool.call(read('/repo/a.js', 'a1'))
	await $.tool.call(edit('/repo/b.js', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	await $.turn.complete({ turnId: 'x', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	expect((await files.find({ type: 'Text', text: /^DONE$/ }))?.props.color).toBe(STATE_COLORS.edited)
	expect((await files.find({ type: 'Text', text: /^Edited 1 file$/ }))?.text).toBe('Edited 1 file')
	expect((await files.find({ type: 'Text', text: /^edited 1, read 1$/ }))?.text).toBe('edited 1, read 1')
	expect(await pillOf(files, '/repo/b.js')).toBe('edited')
	// Nothing is live once it is done, so no name shines.
	expect((await files.findAll({ type: 'Svg' })).some((svg: any) => svg.props.isInteractive)).toBe(false)
	expect((await files.findAll({ type: 'Svg' })).map((svg: any) => svg.props.alt)).toContain('check icon')
	await files.unmount()
	const terminal = await $.ui.mount({ ...FILES, surface: 'terminal' })
	expect(await terminal.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
	await terminal.unmount()
	await pane.unmount()
})

// Reads a turn.step stream to its end and hands back what the chain returned.
async function drain(stream: any) {
	let step = await stream.next()
	while (!step.done) step = await stream.next()
	return step.value
}

test('an idle agent shows WAITING in amber with a pause', async ($, on) => {
	await start($, on, { listed: [{ id: 'a1', description: 'Implement the price table', type: 'general-purpose', status: 'idle' }] })
	await $.tool.call(edit('/repo/a.js', 'a1'))
	await drain(($.turn.step as any)({ turnId: 's1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' }))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	for (const surface of ['desktop', 'terminal'] as const) {
		const files = await $.ui.mount({ ...FILES, surface })
		expect((await files.find({ type: 'Text', text: /^WAITING$/ }))?.props.color).toBe('#D29922')
		expect((await files.find({ type: 'Text', text: /^Editing a\.js$/ }))?.text).toBe('Editing a.js')
		// Nothing is live while it waits.
		expect(await pillOf(files, '/repo/a.js')).toBe('edited')
		if (surface === 'desktop') expect((await files.findAll({ type: 'Svg' })).map((svg: any) => svg.props.alt)).toContain('pause icon')
		else expect(await files.find({ type: 'Text', text: /^‖$/ })).toBeDefined()
		await files.unmount()
	}
	await pane.unmount()
})

test('the flash settles even when nothing runs to redraw the pane', async ($, on) => {
	const { clock } = await start($, on)
	await $.tool.call(read('/repo/a.js', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const ended = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' }
	for (const agentId of ['a1', 'a2']) await $.turn.complete({ turnId: 'x', agentId, ...ended } as any)
	await $.turn.complete({ turnId: 't1', ...ended } as any)
	await clock.advance(5000)
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect((await files.find({ key: 'now' }))?.props.borderColor).toBe('#3A3936')
	// A late touch, as a slow Bash scan lands after the turn has ended.
	await $.tool.call(read('/repo/b.js', 'a1'))
	expect((await files.find({ key: 'now' }))?.props.borderColor).toBe('#E8E6DF')
	await clock.advance(1500)
	expect((await files.find({ key: 'now' }))?.props.borderColor).toBe('#3A3936')
	await files.unmount()
	await pane.unmount()
})

test('the Right-now card is outlined light while its agent runs, as in the mockup', async ($, on) => {
	const { clock } = await start($, on)
	await $.tool.call(read('/repo/a.js', 'a1'))
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect((await files.find({ key: 'now' }))?.props).toMatchObject({ borderColor: '#E8E6DF', backgroundColor: '#232321' })
	await clock.advance(1500)
	expect((await files.find({ key: 'now' }))?.props.borderColor).toBe('#E8E6DF')
	await files.unmount()
	// The terminal keeps the theme's own outline once the flash is over, and no fill.
	await $.turn.complete({ turnId: 'x', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	const terminal = await $.ui.mount({ ...FILES, surface: 'terminal' })
	expect((await terminal.find({ key: 'now' }))?.props.borderColor).toBeUndefined()
	expect((await terminal.find({ key: 'now' }))?.props.backgroundColor).toBeUndefined()
	await terminal.unmount()
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
	// MAX_ROWS rows of the 200 files an agent keeps, then a count.
	expect(await files.findAll({ type: 'Button' })).toHaveLength(MAX_ROWS)
	expect((await files.find({ type: 'Text', text: /more$/ }))?.text).toBe(`+ ${200 - MAX_ROWS} more`)
	// What Desktop will draw: under 2,000 nodes, 32 levels and 262,144 characters.
	const measured = desktopMeasure(await files.drawn())
	expect(measured.nodes).toBeLessThan(2000)
	expect(measured.depth).toBeLessThan(32)
	expect(measured.chars).toBeLessThan(262_144)
	await files.unmount()
	await pane.unmount()
})

test('a long list of edits with line counts and a branch stays inside the budget too', async ($, on) => {
	const names = Array.from({ length: 300 }, (_, i) => `src/f${String(i).padStart(3, '0')}.js`)
	const { clock } = await start($, on, {
		stdout: {
			[`${GIT} /repo/src rev-parse --show-cdup`]: '../\n',
			[`${GIT} /repo diff`]: names.map(name => `12\t3\t${name}\0`).join(''),
			[`${GIT} /repo symbolic-ref`]: 'feat/a-rather-long-branch-name\n',
			[`${GIT} /repo status`]: ' M src/f000.js\0'
		}
	})
	for (const name of names) await $.tool.call(edit(`/repo/${name}`, 'a1'))
	await clock.settle()
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	expect(await files.find({ key: 'branch' })).toBeDefined()
	expect(shown((await cells(files, 'file:/repo/src/f298.js'))[2])).toBe('+12')
	const measured = desktopMeasure(await files.drawn())
	expect(measured.nodes).toBeLessThan(2000)
	expect(measured.depth).toBeLessThan(32)
	expect(measured.chars).toBeLessThan(262_144)
	await files.unmount()
	await pane.unmount()
})

// A normal open on macOS asks `test -x <path> -o -L <path>` first; every file but gradlew answers no.
const DARWIN = { stdout: { 'uname -s': 'Darwin\n' }, exits: { 'test -x /repo/gradlew': 0, 'test -x': 1 } }

async function openRow($: any, on: any, options: Options, paths: string[]) {
	const run = await start($, on, { ...DARWIN, ...options })
	for (const path of paths) await $.tool.call(read(path, 'a1'))
	// Ended, so no row is live and every name is its own Button.
	await $.turn.complete({ turnId: 'x', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as any)
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
	await $.turn.complete({ turnId: 'x', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as any)
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

// A row's state read off its pill: the live row says what is happening (editing), the others what happened.
const PAST: Record<string, string> = { reading: 'read', editing: 'edited' }
const stateOf = async (files: any, path: string) => {
	const pill = await pillOf(files, path)
	return pill === undefined ? undefined : (PAST[pill] ?? pill)
}

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
	const committed = (await cells(files, 'file:/repo/test/PriceTable.test.jsx')).at(-1)
	expect(shown(committed)?.trim()).toBe('committed')
	expect(committed.props.source).toContain('fill="#7FDC8F"')
	expect(await stateOf(files, '/repo/src/pricing/PriceTable.jsx')).toBe('edited')
	expect(await stateOf(files, '/repo/src/pricing/usePrices.js')).toBe('read')
	expect(await stateOf(files, '/Users/me/notes.md')).toBe('edited')
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
	// Neither command is a finished commit, so the commit check never ran (the edits' own refresh asks no ls-files).
	expect(ran.some(argv => argv.includes('ls-files') || (argv.includes('status') && argv.includes('--')))).toBe(false)
	await $.tool.call({ tool: 'Bash', command: 'git commit -am x', agentId: 'a1' } as any)
	await clock.settle()
	// Checked, but nothing turned clean: no HEAD lookup.
	expect(ran.some(argv => argv.join(' ').startsWith(`${GIT} /repo status`))).toBe(true)
	expect(ran.some(argv => argv.includes('--short') && argv.includes('rev-parse'))).toBe(false)
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
	// The commit check's status names its files; the refresh's does not.
	const statuses = ran.filter(argv => argv.join(' ').startsWith(`${GIT} /repo status`) && argv.includes('--'))
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

test('a command the engine marks read-only is not scanned, and its marker is removed', async ($, on) => {
	const { clock, ran } = await start($, on, {
		readOnlyCommand: 'ls',
		stdout: { mktemp: `${MARK}\n`, [`${GIT} /repo rev-parse --show-cdup`]: '\n', 'find /repo': found('/repo/a.ts') }
	})
	await $.tool.call(bash('ls -la', 'a1'))
	await clock.settle()
	expect(ran).toContainEqual(['mktemp', '-t', 'crew-mark.XXXXXX'])
	expect(ran.some(argv => argv[0] === 'find')).toBe(false)
	expect(ran).toContainEqual(['rm', '-f', MARK])
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect(await pane.find({ key: 'files-a1' })).toBeUndefined()
	await pane.unmount()
})

// The git refresh behind the Files pane's line counts and branch: what it asks git, and when.
const gitCalls = (ran: string[][]) => ran.filter(argv => argv[0] === 'git').map(argv => argv.slice(4))
const subcommands = (ran: string[][]) => gitCalls(ran).map(args => args[0])
const numstats = (ran: string[][]) => gitCalls(ran).filter(args => args[0] === 'diff')
// Lets work that has no clock to settle on (a stub held open) run as far as it can.
const idle = () => new Promise(resolve => setTimeout(resolve, 20))

const REFRESH = {
	[`${GIT} /repo rev-parse --show-cdup`]: '\n',
	[`${GIT} /repo diff`]: '12\t3\ta.js\0',
	[`${GIT} /repo symbolic-ref`]: 'feat/pricing\n',
	[`${GIT} /repo status`]: ' M a.js\0?? new.js\0'
}

test('an edit asks git for the numbers, the branch and the dirty files, in that order', async ($, on) => {
	const { clock, ran } = await start($, on, { stdout: REFRESH })
	await $.tool.call(edit('/repo/a.js', 'a1'))
	await clock.settle()
	expect(subcommands(ran)).toEqual(['rev-parse', 'diff', 'symbolic-ref', 'status'])
	expect(ran).toContainEqual([
		'git', '--no-optional-locks', '-C', '/repo', 'diff', '--numstat', '-z', 'HEAD', '--', '/repo/a.js'
	])
	expect(gitCalls(ran)[2]).toEqual(['symbolic-ref', '--short', '-q', 'HEAD'])
	expect(gitCalls(ran)[3]).toEqual(['status', '--porcelain', '-z'])
	// A Write and the agent's earlier edits go in the next ask.
	await $.tool.call({ tool: 'Write', file_path: '/repo/b.js', content: 'x', agentId: 'a1' } as any)
	await clock.settle()
	expect(numstats(ran).at(-1)?.slice(-2)).toEqual(['/repo/a.js', '/repo/b.js'])
})

test('a Read asks git nothing, and neither does an edit that failed', async ($, on) => {
	const { clock, ran } = await start($, on, { stdout: REFRESH, failing: 'missing' })
	await $.tool.call(read('/repo/a.js', 'a1'))
	await $.tool.call(edit('/repo/missing.js', 'a1'))
	await clock.settle()
	expect(gitCalls(ran)).toEqual([])
})

test('an edit outside a repository runs no numbers, branch or status', async ($, on) => {
	const { clock, ran } = await start($, on, { exits: { [`${GIT} /outside rev-parse`]: 128 } })
	await $.tool.call(edit('/outside/a.js', 'a1'))
	await clock.settle()
	expect(subcommands(ran)).toEqual(['rev-parse'])
})

test('rapid edits in one repository never run two refreshes at once, and the queued one unions their files', async ($, on) => {
	let release = () => {}
	const until = new Promise<void>(resolve => (release = resolve))
	const { clock, ran } = await start($, on, { stdout: REFRESH, slow: { prefix: `${GIT} /repo diff`, until } })
	await $.tool.call(edit('/repo/a.js', 'a1'))
	await idle()
	expect(numstats(ran)).toHaveLength(1)
	await $.tool.call(edit('/repo/b.js', 'a1'))
	await $.tool.call(edit('/repo/c.js', 'a2'))
	await $.tool.call(edit('/repo/d.js', 'a1'))
	await idle()
	// The first is still held open: the rest wait their turn.
	expect(numstats(ran)).toHaveLength(1)
	expect(subcommands(ran).filter(name => name === 'status')).toHaveLength(0)
	release()
	await idle()
	await clock.settle()
	// One more run, for every file asked about meanwhile; nothing per edit.
	expect(numstats(ran)).toHaveLength(2)
	expect(numstats(ran)[1].slice(numstats(ran)[1].indexOf('--') + 1).sort()).toEqual([
		'/repo/a.js', '/repo/b.js', '/repo/c.js', '/repo/d.js'
	])
})

test('a refresh that fails leaves things as they were, and a later edit asks again', async ($, on) => {
	const { clock, ran } = await start($, on, { stdout: REFRESH, exits: { [`${GIT} /repo diff`]: 128 } })
	await $.tool.call(edit('/repo/a.js', 'a1'))
	await clock.settle()
	// No branch or status after a failed numstat.
	expect(subcommands(ran)).toEqual(['rev-parse', 'diff'])
	await $.tool.call(edit('/repo/b.js', 'a1'))
	await clock.settle()
	expect(numstats(ran)).toHaveLength(2)
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await pane.find({ key: 'files-a1' }))?.text).toBe('▸ 2')
	await pane.unmount()
})

test('a git command that cannot start skips that refresh and never stops the next', async ($, on) => {
	const { clock, ran } = await start($, on, { stdout: REFRESH, throwing: `${GIT} /repo symbolic-ref` })
	const result = await $.tool.call(edit('/repo/a.js', 'a1'))
	await clock.settle()
	expect(result).toEqual({ result: {} })
	await $.tool.call(edit('/repo/b.js', 'a1'))
	await clock.settle()
	expect(numstats(ran)).toHaveLength(2)
	expect(subcommands(ran)).not.toContain('status')
})

test('the Bash scan’s edits are refreshed', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: { ...REFRESH, mktemp: `${MARK}\n`, 'find /repo': found('/repo/a.js') }
	})
	await $.tool.call(bash("sed -i '' s/a/b/ a.js", 'a1'))
	await clock.settle()
	expect(numstats(ran)).toEqual([['diff', '--numstat', '-z', 'HEAD', '--', '/repo/a.js']])
})

test('a Bash scan that found nothing asks git for no numbers', async ($, on) => {
	const { clock, ran } = await start($, on, { stdout: { ...REFRESH, mktemp: `${MARK}\n` } })
	await $.tool.call(bash('make', 'a1'))
	await clock.settle()
	expect(numstats(ran)).toEqual([])
})

test('a commit refreshes the files it marked, after its own check', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: {
			...REFRESH,
			[`${GIT} /repo status`]: '',
			[`${GIT} /repo ls-files`]: 'a.js\0',
			[`${GIT} /repo rev-parse --short HEAD`]: 'abc1234\n'
		}
	})
	await $.tool.call(edit('/repo/a.js', 'a1'))
	await clock.settle()
	expect(numstats(ran)).toHaveLength(1)
	await $.tool.call({ tool: 'Bash', command: 'git commit -am x', agentId: 'a1' } as any)
	await clock.settle()
	const names = gitCalls(ran).map(args => args.join(' '))
	const checked = names.indexOf('rev-parse --short HEAD')
	expect(checked).toBeGreaterThan(-1)
	// The refresh that follows the commit asks about the committed file only.
	expect(numstats(ran)).toHaveLength(2)
	expect(names.lastIndexOf('diff --numstat -z HEAD -- /repo/a.js')).toBeGreaterThan(checked)
})

test('once git has answered, the rows show their line counts and the card its branch', async ($, on) => {
	const { clock } = await start($, on, { stdout: REFRESH })
	await $.tool.call(read('/repo/b.md', 'a1'))
	await $.tool.call(edit('/repo/a.js', 'a1'))
	await clock.settle()
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	for (const surface of ['desktop', 'terminal'] as const) {
		const files = await $.ui.mount({ ...FILES, surface })
		// The live row's counts sit just before its pill.
		const [added, removed] = (await cells(files, 'file:/repo/a.js')).slice(-3, -1)
		expect([shown(added), shown(removed)]).toEqual(['+12', '\u22123'])
		expect([added.props.color, removed.props.color]).toEqual(['#7FC77F', '#F07A7A'])
		// A row with no counts draws none.
		expect(await cells(files, 'file:/repo/b.md')).toHaveLength(3)
		// At the project root the subtitle is the counts alone, each in its colour.
		const sub = (await files.find({ key: 'now-sub' }))?.children ?? []
		expect(sub.map(shown)).toEqual(['+12', '\u22123'])
		expect(sub.map((part: any) => part.props.color)).toEqual(['#7FC77F', '#F07A7A'])
		const branch = (await files.find({ key: 'branch' }))?.children ?? []
		expect(branch[0].type).toBe(surface === 'desktop' ? 'Svg' : 'Text')
		expect(shown(branch[1].children[0])).toBe('feat/pricing')
		expect(branch.slice(2).map(shown).join(' ')).toBe('+12 \u22123 · 2 changed')
		expect(branch.at(-1).props.color).toBe('#E6C463')
		await files.unmount()
	}
	await pane.unmount()
})

test('a clean repository and a detached HEAD read as such on the branch row', async ($, on) => {
	const { clock } = await start($, on, {
		stdout: { ...REFRESH, [`${GIT} /repo diff`]: '', [`${GIT} /repo status`]: '' },
		exits: { [`${GIT} /repo symbolic-ref`]: 1 }
	})
	await $.tool.call(edit('/repo/a.js', 'a1'))
	await clock.settle()
	const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await pane.press({ key: 'files-a1' })
	const files = await $.ui.mount({ ...FILES, surface: 'desktop' })
	const branch = (await files.find({ key: 'branch' }))?.children ?? []
	expect(shown(branch[1].children[0])).toBe('detached')
	expect(branch.slice(2).map(shown)).toEqual(['clean'])
	await files.unmount()
	await pane.unmount()
})

test('edits in many folders ask git for each folder’s repository once, not once per edit', async ($, on) => {
	const dirs = Array.from({ length: 20 }, (_, i) => `/repo/d${i}`)
	const { clock, ran } = await start($, on, {
		stdout: { ...REFRESH, ...Object.fromEntries(dirs.map(dir => [`${GIT} ${dir} rev-parse --show-cdup`, '../\n'])) }
	})
	for (const dir of dirs) await $.tool.call(edit(`${dir}/a.js`, 'a1'))
	await clock.settle()
	const cdups = ran.filter(argv => argv.includes('--show-cdup'))
	expect(cdups.length).toBeLessThanOrEqual(dirs.length)
	expect(new Set(cdups.map(argv => argv[3])).size).toBe(cdups.length)
	// Every file was still asked about.
	expect(numstats(ran).flatMap(args => args.slice(args.indexOf('--') + 1))).toContain('/repo/d19/a.js')
})

test('a commit refreshes its files in the repository it checked, without asking for it again', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: {
			...REFRESH,
			[`${GIT} /repo/src rev-parse --show-cdup`]: '../\n',
			[`${GIT} /repo status`]: '',
			[`${GIT} /repo ls-files`]: 'src/a.js\0',
			[`${GIT} /repo rev-parse --short HEAD`]: 'abc1234\n'
		}
	})
	await $.tool.call(edit('/repo/src/a.js', 'a1'))
	await clock.settle()
	await $.tool.call({ tool: 'Bash', command: 'git commit -am x', agentId: 'a1' } as any)
	await clock.settle()
	expect(ran.filter(argv => argv.includes('--show-cdup') && argv[3] === '/repo/src')).toHaveLength(1)
	expect(numstats(ran).at(-1)).toEqual(['diff', '--numstat', '-z', 'HEAD', '--', '/repo/src/a.js'])
})

test('the Bash scan hands the repository it found straight to the refresh', async ($, on) => {
	const { clock, ran } = await start($, on, {
		stdout: { ...REFRESH, mktemp: `${MARK}\n`, 'find /repo': found('/repo/lib/deep/x.ts', '/repo/y.ts') }
	})
	await $.tool.call(bash("sed -i '' s/a/b/ lib/deep/x.ts y.ts", 'a1'))
	await clock.settle()
	// Only the scan's own folder is asked; the folders of the files it found are not.
	expect(ran.filter(argv => argv.includes('--show-cdup')).map(argv => argv[3])).toEqual(['/repo'])
	expect(numstats(ran)).toHaveLength(1)
	expect(numstats(ran)[0].slice(-2).sort()).toEqual(['/repo/lib/deep/x.ts', '/repo/y.ts'])
})
