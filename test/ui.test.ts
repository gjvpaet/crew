import { expect, mock, test } from 'claude-code/testing'

const BAND = {
	plugin: 'crew',
	component: 'AbovePrompt',
	requestId: 'band',
	props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }
} as const

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

async function startTwoAgents($: any, on: any) {
	mock.clock(on, { now: 1000 })
	mock.store(on)
	on('command.register', () => ({ value: { command: 'crew' } }))
	on('tool.register', () => ({ value: { tool: 'mcp__crew__set_mascot' } }))
	on('ui.open', () => ({ value: { isPlaced: true } }))
	on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
	on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
	on('agent.spawn', (_: unknown, e: any) => ({
		model: 'claude-opus-5-5',
		agentId: e.description === 'Research competitor launches' ? 'a1' : 'a2'
	}))
	// Stands for the engine's own band, which a hidden band hands the drawing on to.
	on('ui.render', (_$: any, e: any) => {
		const { Box } = _$.ui.resolve(e)
		return h(Box, null)
	})

	await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
	await $.turn.start({ text: 'Build the launch kit', turnId: 't1' })
	await $.agent.spawn({ prompt: 'go', description: 'Research competitor launches', subagentType: 'Explore' })
	await $.agent.spawn({ prompt: 'go', description: 'Build the landing page', subagentType: 'general-purpose' })
}

test('the band shows agent progress and hides on ×', async ($, on) => {
	await startTwoAgents($, on)
	for (const surface of ['terminal', 'desktop'] as const) {
		const ui = await $.ui.mount({ ...BAND, surface })
		expect((await ui.find({ type: 'Text', text: /Agents 0\/2/ }))?.text).toContain('Agents 0/2')
		await ui.unmount()
	}
	const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
	await ui.press({ key: 'hide' })
	expect(await ui.find({ type: 'Text', text: /Agents 0\/2/ })).toBeUndefined()
	await ui.unmount()
})

test('the pane lists each agent under Running', async ($, on) => {
	await startTwoAgents($, on)
	for (const surface of ['terminal', 'desktop'] as const) {
		const ui = await $.ui.mount({ ...PANE, surface })
		expect(await ui.find({ type: 'Text', text: /Running · 2/ })).toBeDefined()
		expect(await ui.find({ type: 'Text', text: /Research competitor launches/ })).toBeDefined()
		expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
		await ui.unmount()
	}
})

test('set_mascot saves the change', async ($, on) => {
	await startTwoAgents($, on)
	const ran = await $.tool.call({ tool: 'mcp__crew__set_mascot', role: 'designer', accessory: 'hardhat' } as any)
	expect(ran.deny).toBeUndefined()
	expect(ran.result).toEqual({ ok: true, role: 'designer', prefs: { accessory: 'hardhat' } })
	const refused = await $.tool.call({ tool: 'mcp__crew__set_mascot', role: 'pilot' } as any)
	expect(refused.deny).toBe('role must be one of developer, designer, researcher, reviewer, plain')
})

test('the gating hooks hand an ordinary tool call on', async ($, on) => {
	mock.clock(on, { now: 1000 })
	mock.store(on)
	on('tool.call', () => ({ result: {} }))
	const ran = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
	expect(ran.deny).toBeUndefined()
})
