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
