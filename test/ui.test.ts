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
	on('ui.toast', () => ({ value: undefined }))
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
		expect((await ui.find({ type: 'Text', text: /running/ }))?.text).toBe('2 running')
		// Desktop drops trailing spaces inside a Text, so the gaps come from the row, never from padding.
		expect((await ui.find({ type: 'Text', text: /%/ }))?.text).toBe('0%')
		expect((await ui.find({ type: 'Text', text: /Agents/ }))?.text).toBe('Agents 0/2')
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

const fresh = () => ({ opens: 0, toasts: [] as string[], spawns: 0, modelWrites: 0 })

const SIDEBAR = { columns: 160, rows: 50, isFullscreen: true }
const USAGE = {
	input_tokens: 1000,
	output_tokens: 500,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
	model: 'claude-opus-5-5'
}

// Reads a turn.step stream to its end and hands back what the chain returned.
async function drain(stream: any) {
	let step = await stream.next()
	while (!step.done) step = await stream.next()
	return step.value
}

type Seen = ReturnType<typeof fresh>

function engine(on: any, seen: Seen) {
	on('command.register', () => ({ value: { command: 'crew' } }))
	on('tool.register', () => ({ value: { tool: 'mcp__crew__set_mascot' } }))
	on('ui.open', () => {
		seen.opens++
		return { value: { isPlaced: true } }
	})
	on('ui.toast', (_$: any, e: any) => {
		seen.toasts.push(e.text)
		return { value: undefined }
	})
	on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
	on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
	on('turn.complete', () => ({ text: '' }))
	on('agent.spawn', () => {
		seen.spawns++
		return { model: 'claude-opus-5-5', agentId: 'a1' }
	})
	on('agent.list', () => ({ value: [{ id: 'a1', description: 'Research', type: 'Explore', status: 'running' }] }))
	on('turn.step', async function* (_$: any, e: any) {
		return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
	})
	on('state.set', { plugin: 'crew', key: 'model' }, (_$: any, e: any, next: any) => {
		seen.modelWrites++
		return next(e)
	})

	on('ui.render', (_$: any, e: any) => {
		const { Box } = _$.ui.resolve(e)
		return h(Box, null)
	})
}


test('an agent run lands on the pane and the band through the engine', async ($, on) => {
	const seen = fresh()
	mock.clock(on, { now: 1000 })
	mock.store(on)
	engine(on, seen)
	await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
	await $.turn.start({ text: 'Go', turnId: 't1' })
	await $.agent.spawn({ prompt: 'go', description: 'Research', subagentType: 'Explore' } as any)
	await $.turn.start({ text: 'go', turnId: 's1', agentId: 'a1' } as any)
	const writes = seen.modelWrites
	await drain(($.turn.step as any)({ turnId: 's1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' }))
	expect(seen.modelWrites - writes).toBe(1)
	await $.turn.complete({ turnId: 's1', agentId: 'a1', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	for (const surface of ['terminal', 'desktop'] as const) {
		const pane = await $.ui.mount({ ...PANE, surface })
		expect(await pane.find({ type: 'Text', text: /Finished · 1/ })).toBeDefined()
		expect((await pane.find({ type: 'Text', text: /1\.5k/ }))?.text).toContain('1.5k')
		await pane.unmount()
		const band = await $.ui.mount({ ...BAND, surface })
		expect((await band.find({ type: 'Text', text: /Agents 1\/1/ }))?.text).toContain('Agents 1/1')
		await band.unmount()
	}
})

test('the first spawn opens the pane where it is a sidebar, once', async ($, on) => {
	const seen = await spawnTwiceAfterBand($, on, SIDEBAR)
	expect(seen.opens).toBe(1)
	expect(seen.toasts).toEqual([])
})

async function spawnTwiceAfterBand($: any, on: any, viewport?: typeof SIDEBAR) {
	const seen = fresh()
	mock.clock(on, { now: 1000 })
	mock.store(on)
	engine(on, seen)
	await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
	const band = await $.ui.mount({ ...BAND, surface: 'terminal', ...(viewport ? { viewport } : {}) })
	await band.unmount()
	await $.turn.start({ text: 'Go', turnId: 't1' })
	await $.agent.spawn({ prompt: 'go', description: 'Research', subagentType: 'Explore' })
	await $.agent.spawn({ prompt: 'go', description: 'Research', subagentType: 'Explore' })
	return seen
}

test('on the main screen the first spawn says how to open the pane, once', async ($, on) => {
	const seen = await spawnTwiceAfterBand($, on, { ...SIDEBAR, isFullscreen: false })
	expect(seen.opens).toBe(0)
	expect(seen.toasts).toEqual(['Crew: /crew opens the Agents panel'])
})

test('where the surface has not said, the first spawn only says how', async ($, on) => {
	const seen = await spawnTwiceAfterBand($, on)
	expect(seen.opens).toBe(0)
	expect(seen.toasts).toEqual(['Crew: /crew opens the Agents panel'])
})

test('the pane and band redraw each second only while time is counting', async ($, on) => {
	const seen = fresh()
	const clock = mock.clock(on, { now: 1000 })
	mock.store(on)
	engine(on, seen)
	let redraws = 0
	on('ui.invalidate', (_$: any, e: any) => {
		if (e.event === 'ui.render') redraws++
		return { value: undefined }
	})
	await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
	await clock.advance(3000)
	expect(redraws).toBe(0)
	await $.turn.start({ text: 'Go', turnId: 't1' })
	await clock.advance(3000)
	expect(redraws).toBe(3)
	await $.turn.complete({ turnId: 't1', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	await clock.advance(3000)
	expect(redraws).toBe(3)
})

// The kit guards $.state (a throwing state hook is skipped, a refused read is unset), so the failure injected here
// is the clock: nothing beneath answers $.clock.now, which Crew awaits after next(e) on a spawn and a step.
test('a failing Crew hook never fails a tool call, a spawn or a step', async ($, on) => {
	const seen = fresh()
	mock.store(on)
	engine(on, seen)
	on('tool.call', () => ({ result: { ok: true } }))
	const ran = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
	expect(ran.deny).toBeUndefined()
	expect(ran.result).toEqual({ ok: true })
	const spawned = await $.agent.spawn({ prompt: 'go', description: 'Research', subagentType: 'Explore' })
	expect(spawned.agentId).toBe('a1')
	expect(seen.spawns).toBe(1)
	const stepped = await drain($.turn.step({ turnId: 's1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' } as any))
	expect(stepped.usage).toEqual(USAGE)
	// The failure was real: none of Crew's bookkeeping for the spawn or the step landed.
	expect(seen.modelWrites).toBe(0)
})

test('mascot prefs load from the store at the start of each main turn, sanitised', async ($, on) => {
	const seen = fresh()
	mock.clock(on, { now: 1000 })
	mock.store(on, { mascots: { designer: { accessory: 'hardhat' }, researcher: { accessory: 'tophat' }, pilot: {} } })
	engine(on, seen)
	// No session.start: what /clear leaves behind, the prefs back from the store on the next turn.
	await $.turn.start({ text: 'Go', turnId: 't1' })
	await $.agent.spawn({ prompt: 'go', description: 'Design the launch graphics', subagentType: 'general-purpose' } as any)
	for (const surface of ['terminal', 'desktop'] as const) {
		const pane = await $.ui.mount({ ...PANE, surface })
		expect(await pane.find({ type: 'Text', text: /Design the launch graphics/ })).toBeDefined()
		await pane.unmount()
	}
	const designer = await $.tool.call({ tool: 'mcp__crew__set_mascot', role: 'designer', body: '#112233' } as any)
	expect(designer.result).toEqual({ ok: true, role: 'designer', prefs: { accessory: 'hardhat', body: '#112233' } })
	const researcher = await $.tool.call({ tool: 'mcp__crew__set_mascot', role: 'researcher', body: '#112233' } as any)
	expect(researcher.result).toEqual({ ok: true, role: 'researcher', prefs: { body: '#112233' } })
})
