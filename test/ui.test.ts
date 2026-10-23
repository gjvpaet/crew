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

// The kit's `find` matches an Svg's shown text, which is empty: its `alt` is read off the props instead.
async function svgs(ui: any, alt: RegExp): Promise<any[]> {
	return (await ui.findAll({ type: 'Svg' })).filter((svg: any) => alt.test(String(svg.props.alt)))
}

async function startTwoAgents($: any, on: any) {
	mock.clock(on, { now: 1000 })
	mock.store(on)
	on('command.register', () => ({ value: { command: 'crew' } }))
	on('tool.register', () => ({ value: { tool: 'mcp__crew__set_mascot' } }))
	on('ui.open', () => ({ value: { isPlaced: true } }))
	on('ui.toast', () => ({ value: undefined }))
	on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
	on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
	on('turn.complete', () => ({ text: '' }))
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
	const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
	expect((await terminal.find({ type: 'Text', text: /Agents 0\/2/ }))?.text).toContain('Agents 0/2')
	expect((await terminal.find({ type: 'Text', text: /running/ }))?.text).toBe('2 running')
	// Desktop drops trailing spaces inside a Text, so the gaps come from the row, never from padding.
	expect((await terminal.find({ type: 'Text', text: /%/ }))?.text).toBe('0%')
	expect((await terminal.find({ type: 'Text', text: /Agents/ }))?.text).toBe('Agents 0/2')
	expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
	await terminal.unmount()
	const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
	expect((await ui.find({ type: 'Text', text: /running/ }))?.text).toBe('2 running')
	expect((await ui.find({ type: 'Text', text: /%/ }))?.text).toBe('0%')
	await ui.press({ key: 'hide' })
	expect(await svgs(ui, /Agents 0\/2/)).toHaveLength(0)
	expect(await ui.find({ type: 'Text', text: /running/ })).toBeUndefined()
	await ui.unmount()
})

test('on desktop the band draws its bar, pill and a mini Pip as SVG', async ($, on) => {
	await startTwoAgents($, on)
	const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
	const [bar] = await svgs(ui, /Agents 0\/2/)
	expect(bar).toBeDefined()
	expect(String(bar?.props.source)).toContain('>Agents 0/2</text>')
	expect(bar?.props.height).toBe(18)
	expect(bar?.props.width).toBe(200)
	// A fill dark enough to read against the track in light mode, not lilac.
	expect(String(bar?.props.source)).toContain('fill="#7F77DD"')
	expect(String(bar?.props.source)).not.toContain('#AFA9EC')
	const [pip] = await svgs(ui, /mascot/)
	expect(String(pip?.props.source)).toContain('shape-rendering="crispEdges"')
	expect(pip?.props.width).toBe(20)
	// Sub-agents are running, so the band's Pip moves too.
	expect(pip?.props.isInteractive).toBe(true)
	expect(String(pip?.props.source)).toContain('<animateTransform')
	expect((await ui.find({ type: 'Text', text: /running/ }))?.text).toBe('2 running')
	// The pill lives in the SVG on desktop, never as a second text.
	expect(await ui.find({ type: 'Text', text: /Agents 0\/2/ })).toBeUndefined()
	await ui.unmount()
})

test('on desktop each band SVG centres itself rather than resting on the text baseline', async ($, on) => {
	await startTwoAgents($, on)
	const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
	const holders = (await ui.findAll({ type: 'Box' })).filter((box: any) =>
		box.children.some((child: any) => child?.type === 'Svg')
	)
	expect(holders).toHaveLength(2)
	for (const box of holders) {
		expect(box.props.alignSelf).toBe('center')
		expect(box.children).toHaveLength(1)
	}
	// The drawings keep their own size: no clear space added above them.
	const [bar] = await svgs(ui, /Agents 0\/2/)
	expect(bar?.props.height).toBe(18)
	await ui.unmount()
})

test('the pane lists each agent under Running', async ($, on) => {
	await startTwoAgents($, on)
	for (const surface of ['terminal', 'desktop'] as const) {
		const ui = await $.ui.mount({ ...PANE, surface })
		expect((await ui.find({ key: 'group-Running' }))?.text).toBe('▾ Running · 2')
		expect(await ui.find({ type: 'Text', text: /Research competitor launches/ })).toBeDefined()
		expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
		await ui.unmount()
	}
})

test('on desktop every agent card draws Pip and its bar as SVG', async ($, on) => {
	await startTwoAgents($, on)
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	// Main and the two sub-agents.
	const pips = await svgs(ui, /mascot/)
	expect(pips).toHaveLength(3)
	expect(pips.every(pip => String(pip.props.source).includes('shape-rendering="crispEdges"'))).toBe(true)
	expect(pips.every(pip => pip.props.width === 40 && pip.props.height === 44)).toBe(true)
	// All three are at work: each Pip is drawn live, so it can bob and blink.
	expect(pips.every(pip => pip.props.isInteractive === true)).toBe(true)
	expect(pips.every(pip => String(pip.props.source).includes('<animateTransform'))).toBe(true)
	// Two sub-agents, two different species.
	expect(new Set(pips.map(pip => String(pip.props.alt).split(' ')[0])).size).toBe(3)
	const bars = await svgs(ui, /progress/)
	expect(bars).toHaveLength(3)
	// Running with no steps: a shimmer in the agent's own accent.
	const [research] = await svgs(ui, /^Research competitor launches progress/)
	expect(String(research?.props.source)).toContain('class="shimmer"')
	expect(String(research?.props.source)).toContain('#1D9E75')
	const [landing] = await svgs(ui, /^Build the landing page progress/)
	expect(String(landing?.props.source)).toContain('#7F77DD')
	expect(await ui.find({ type: 'Text', text: /▀|▄/ })).toBeUndefined()
	await ui.unmount()
})

test('vscode and mobile draw the same SVG cards and band as desktop', async ($, on) => {
	await startTwoAgents($, on)
	for (const surface of ['vscode', 'mobile'] as const) {
		const pane = await $.ui.mount({ ...PANE, surface })
		expect(await svgs(pane, /mascot/)).toHaveLength(3)
		expect(await svgs(pane, /progress/)).toHaveLength(3)
		await pane.unmount()
		const band = await $.ui.mount({ ...BAND, surface })
		expect(await svgs(band, /Agents 0\/2/)).toHaveLength(1)
		await band.unmount()
	}
})

test('on the terminal the cards draw the half-block Pip and a text bar', async ($, on) => {
	await startTwoAgents($, on)
	const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
	expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
	expect(await ui.find({ type: 'Text', text: /▀|▄/ })).toBeDefined()
	const bar = await ui.find({ type: 'Text', text: /^[█░▓]{8,}$/ })
	expect(bar).toBeDefined()
	// Main's bar comes first, in Pip blue.
	expect(bar?.props.color).toBe('#7C9CF5')
	await ui.unmount()
})

test('Main shows it is waiting while a sub-agent still runs', async ($, on) => {
	await startTwoAgents($, on)
	await $.turn.complete({ turnId: 't1', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await ui.find({ type: 'Text', text: /waiting on/ }))?.text).toBe('waiting on 2 agents')
	// Main is inactive while it waits: its Pip is drawn live so its zzz can play.
	const [main] = await svgs(ui, /^Pip the .* mascot, paused$/)
	expect(main?.props.isInteractive).toBe(true)
	expect(String(main?.props.source)).toContain('class="z"')
	await ui.unmount()
})

test('a group header collapses and reopens its group', async ($, on) => {
	await startTwoAgents($, on)
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect(await ui.find({ type: 'Text', text: /Research competitor launches/ })).toBeDefined()
	await ui.press({ key: 'group-Running' })
	expect((await ui.find({ key: 'group-Running' }))?.text).toBe('▸ Running · 2')
	expect(await ui.find({ type: 'Text', text: /Research competitor launches/ })).toBeUndefined()
	await ui.press({ key: 'group-Running' })
	expect((await ui.find({ key: 'group-Running' }))?.text).toBe('▾ Running · 2')
	expect(await ui.find({ type: 'Text', text: /Research competitor launches/ })).toBeDefined()
	await ui.unmount()
})

test('an ended agent keeps its notes: stopped and where it came from', async ($, on) => {
	await startTwoAgents($, on)
	// The landing page agent turns out to be the research agent's child.
	await $.agent.spawn({
		prompt: 'go',
		description: 'Build the landing page',
		subagentType: 'general-purpose',
		parentAgentId: 'a1'
	} as any)
	await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'interrupted' } as any)
	for (const surface of ['terminal', 'desktop'] as const) {
		const ui = await $.ui.mount({ ...PANE, surface })
		expect((await ui.find({ key: 'group-Failed' }))?.text).toBe('▾ Failed · 2')
		expect(await ui.find({ type: 'Text', text: /↳ from Research competitor launches/ })).toBeDefined()
		// Main and both agents: one "✗ stopped" badge each, never split across lines.
		expect(await ui.findAll({ type: 'Text', text: /^✗ stopped$/ })).toHaveLength(3)
		await ui.unmount()
	}
})

test('set_mascot redraws that role\'s Pip on desktop', async ($, on) => {
	await startTwoAgents($, on)
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	const [before] = await svgs(ui, / the developer mascot, /)
	expect(before?.props.width).toBe(40)
	expect(String(before?.props.source)).not.toContain('#112233')
	await $.tool.call({ tool: 'mcp__crew__set_mascot', role: 'developer', body: '#112233' } as any)
	const [after] = await svgs(ui, / the developer mascot, /)
	expect(String(after?.props.source)).toContain('fill="#112233"')
	// Only that role changes.
	const [researcher] = await svgs(ui, / the researcher mascot, /)
	expect(String(researcher?.props.source)).not.toContain('#112233')
	await ui.unmount()
})

test('a new prompt drops the Finished fold so the default applies again', async ($, on) => {
	await startTwoAgents($, on)
	const finish = (agentId: string) =>
		$.turn.complete({ turnId: 's', agentId, answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	await finish('a1')
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	await ui.press({ key: 'group-Finished' })
	expect((await ui.find({ key: 'group-Finished' }))?.text).toBe('▸ Finished · 1')
	await ui.press({ key: 'group-Running' })
	await ui.unmount()
	await $.turn.start({ text: 'Next prompt', turnId: 't2' })
	await $.agent.spawn({ prompt: 'go', description: 'Research competitor launches', subagentType: 'Explore' })
	await finish('a1')
	const next = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await next.find({ key: 'group-Finished' }))?.text).toBe('▾ Finished · 1')
	// Only Finished is reset: the user's other folds stand.
	expect((await next.find({ key: 'group-Running' }))?.text).toBe('▸ Running · 1')
	await next.unmount()
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
		expect((await pane.find({ key: 'group-Finished' }))?.text).toBe('▾ Finished · 1')
		expect((await pane.find({ type: 'Text', text: /1\.5k/ }))?.text).toContain('1.5k')
		await pane.unmount()
		const band = await $.ui.mount({ ...BAND, surface })
		const pill =
			surface === 'terminal'
				? (await band.find({ type: 'Text', text: /Agents 1\/1/ }))?.text
				: (await svgs(band, /Agents 1\/1/))[0]?.props.alt
		expect(pill).toContain('Agents 1/1')
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

test('the pane and band redraw only while time is counting, five a second while an agent runs', async ($, on) => {
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
	// While Main runs its card border breathes: five redraws a second.
	await $.turn.start({ text: 'Go', turnId: 't1' })
	await clock.advance(3000)
	expect(redraws).toBe(15)
	await $.turn.complete({ turnId: 't1', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	await clock.advance(3000)
	expect(redraws).toBe(15)
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

test('a turn an agent message starts keeps the person prompt as the band title', async ($, on) => {
	mock.clock(on, { now: 1000 })
	mock.store(on)
	on('command.register', () => ({ value: { command: 'crew' } }))
	on('tool.register', () => ({ value: { tool: 'mcp__crew__set_mascot' } }))
	on('ui.open', () => ({ value: { isPlaced: true } }))
	on('ui.toast', () => ({ value: undefined }))
	on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
	on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
	on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
	on('turn.complete', () => ({ text: '' }))
	on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
	on('ui.render', (_$: any, e: any) => {
		const { Box } = _$.ui.resolve(e)
		return h(Box, null)
	})

	await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
	await $.prompt.submit({ text: 'Build the launch kit', origin: { kind: 'composer' }, wait: false })
	await $.turn.start({ text: 'Build the launch kit', turnId: 't1' })
	await $.agent.spawn({ prompt: 'go', description: 'Research competitor launches', subagentType: 'Explore' })
	await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
	await $.prompt.submit({ text: '<agent-message from="a1">done</agent-message>', origin: { kind: 'peer' }, wait: false })
	await $.turn.start({ text: '<agent-message from="a1">done</agent-message>', turnId: 't2' })

	for (const surface of ['terminal', 'desktop'] as const) {
		const ui = await $.ui.mount({ ...BAND, surface })
		expect(await ui.find({ type: 'Text', text: /Build the launch kit/ })).toBeDefined()
		expect(await ui.find({ type: 'Text', text: /agent-message/ })).toBeUndefined()
		await ui.unmount()
	}
})

test('the header cards share the pane width in three equal parts', async ($, on) => {
	await startTwoAgents($, on)
	for (const surface of ['terminal', 'desktop'] as const) {
		const ui = await $.ui.mount({ ...PANE, surface })
		for (const label of ['Cost', 'Tokens', 'Time']) {
			const card = await ui.find({ key: `card-${label}` })
			expect(card?.props.flexGrow).toBe(1)
			expect(card?.props.width).toBe(0)
		}
		await ui.unmount()
	}
})

test("a finished agent's Pip is a still picture", async ($, on) => {
	await startTwoAgents($, on)
	await $.turn.complete({ turnId: 's', agentId: 'a1', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	const finished = (await svgs(ui, /mascot, still$/))
	expect(finished.length).toBeGreaterThan(0)
	for (const pip of finished) {
		expect(pip.props.isInteractive).toBeFalsy()
		expect(String(pip.props.source)).not.toContain('<animate')
	}
	await ui.unmount()
})

// A turn where Main plans on its own: a task list, no sub-agent.
async function startPlanning($: any, on: any) {
	mock.clock(on, { now: 1000 })
	mock.store(on)
	on('command.register', () => ({ value: { command: 'crew' } }))
	on('tool.register', () => ({ value: { tool: 'mcp__crew__set_mascot' } }))
	on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
	on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
	on('turn.complete', () => ({ text: '' }))
	on('tool.call', () => ({ result: {} }))
	on('ui.render', (_$: any, e: any) => {
		const { Box } = _$.ui.resolve(e)
		return h(Box, null)
	})
	await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
	await $.turn.start({ text: 'Plan the updates tab', turnId: 't1' })
	await $.tool.call({
		tool: 'mcp__ccd_turn__update_plan',
		items: [
			{ content: 'Read the design', status: 'completed' },
			{ content: 'Map the design onto the card', status: 'in_progress' },
			{ content: 'Write the plan', status: 'pending' }
		]
	} as any)
}

test('while Main plans alone the band shows Main and its Pip, hopping', async ($, on) => {
	await startPlanning($, on)
	const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
	expect(await svgs(ui, /Tasks 1\/3/)).toHaveLength(1)
	expect((await ui.find({ type: 'Text', text: /^Main$/ }))?.text).toBe('Main')
	expect(await ui.find({ type: 'Text', text: /running/ })).toBeUndefined()
	const [pip] = await svgs(ui, /main agent/)
	expect(pip).toBeDefined()
	// Main's own blue, and moving while its turn runs.
	expect(String(pip?.props.source)).toContain('fill="#7C9CF5"')
	expect(pip?.props.isInteractive).toBe(true)
	expect(String(pip?.props.source)).toContain('<animateTransform')
	await ui.unmount()
	const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
	expect((await terminal.find({ type: 'Text', text: /^Main$/ }))?.text).toBe('Main')
	await terminal.unmount()
})

test("once Main's turn ends, its band Pip rests", async ($, on) => {
	await startPlanning($, on)
	await $.turn.complete({ turnId: 't1', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
	const [pip] = await svgs(ui, /main agent/)
	expect(pip).toBeDefined()
	expect(pip?.props.isInteractive).toBeFalsy()
	expect(String(pip?.props.source)).not.toContain('<animate')
	await ui.unmount()
})

test('a running card border breathes in its own colour; a finished card keeps the plain border', async ($, on) => {
	await startTwoAgents($, on)
	await $.turn.complete({ turnId: 's', agentId: 'a1', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	const running = await ui.find({ key: 'row-a2' })
	expect(String(running?.props.borderColor)).toMatch(/^rgba\(127,119,221,0\.\d+\)$/)
	expect(running?.props.borderStyle).toBe('round')
	const finished = await ui.find({ key: 'row-a1' })
	expect(finished?.props.borderColor).toBeUndefined()
	await ui.unmount()
	const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
	expect(String((await terminal.find({ key: 'row-a2' }))?.props.borderColor)).toMatch(/^#[0-9A-F]{6}$/)
	await terminal.unmount()
})

test('each sub-agent is asked to keep a task list Crew can show as its progress', async ($, on) => {
	const prompts: string[] = []
	mock.clock(on, { now: 1000 })
	mock.store(on)
	on('command.register', () => ({ value: { command: 'crew' } }))
	on('tool.register', () => ({ value: { tool: 'mcp__crew__set_mascot' } }))
	on('ui.open', () => ({ value: { isPlaced: true } }))
	on('ui.toast', () => ({ value: undefined }))
	on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
	on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
	on('agent.spawn', (_: unknown, e: any) => {
		prompts.push(e.prompt)
		return { model: 'claude-opus-5-5', agentId: 'a1' }
	})
	await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
	await $.turn.start({ text: 'Build it', turnId: 't1' })
	await $.agent.spawn({ prompt: 'Write the parser.', description: 'Write the parser', subagentType: 'general-purpose' })
	expect(prompts).toHaveLength(1)
	// The task comes first and stays whole; the ask follows it.
	expect(prompts[0].startsWith('Write the parser.')).toBe(true)
	expect(prompts[0]).toMatch(/task list/)
	expect(prompts[0]).toMatch(/TodoWrite|TaskCreate/)
	// Asked once, even when the prompt already carries the ask (a resume, say).
	await $.agent.spawn({ prompt: prompts[0], description: 'Write the parser', subagentType: 'general-purpose' })
	expect(prompts[1]).toBe(prompts[0])
})

test('the pane lists the planned steps under Planned, folding like the other groups', async ($, on) => {
	await startPlanning($, on)
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await ui.find({ key: 'group-Planned' }))?.text).toBe('▾ Planned · 1')
	expect(await ui.find({ type: 'Text', text: /^3\. Write the plan$/ })).toBeDefined()
	expect((await ui.find({ type: 'Text', text: /1\/3 · Map the design onto the card/ }))).toBeDefined()
	const [ghost] = await svgs(ui, /planned step/)
	expect(ghost).toBeDefined()
	expect(ghost?.props.isInteractive).toBeFalsy()
	await ui.press({ key: 'group-Planned' })
	expect((await ui.find({ key: 'group-Planned' }))?.text).toBe('▸ Planned · 1')
	expect(await ui.find({ type: 'Text', text: /^3\. Write the plan$/ })).toBeUndefined()
	await ui.press({ key: 'group-Planned' })
	expect(await ui.find({ type: 'Text', text: /^3\. Write the plan$/ })).toBeDefined()
	await ui.unmount()
	const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
	// The terminal lists them too, as text: no SVG there.
	expect(await terminal.find({ type: 'Text', text: /3\. Write the plan/ })).toBeDefined()
	await terminal.unmount()
})
