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
		expect(state.props.color).toBe('#F0883E')
		expect((await cells(files, 'file:/repo/src/pricing/usePrices.js'))[3].props.color).toBe('#A371F7')
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
	expect(await dotOf('/repo/a.js')).toBe('#A371F7')
	await $.turn.complete({ turnId: 'x', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	expect((await files.find({ type: 'Text', text: /^DONE$/ }))?.text).toBe('DONE')
	expect((await files.find({ type: 'Text', text: /^edited 1, read 1$/ }))?.text).toBe('edited 1, read 1')
	expect(await dotOf('/repo/b.js')).toBe('#F0883E')
	await files.unmount()
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
