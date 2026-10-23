import { expect, test } from 'claude-code/testing'

import { PALETTE, SPECIES_ORDER } from '../hooks/sprite'
import { EMPTY_STATE, reduce, selectProgress, type CrewEvent } from '../hooks/tracker'
import { ACCENTS, COLLAPSE_AFTER, PULSE, bandLine, effortToneOf, panelView, pulseColor, toggleGroup } from '../hooks/view'

const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000, model: 'claude-opus-5-5' }
const spawn = (agentId: string, description: string): CrewEvent => ({
	kind: 'spawn',
	at: 2000,
	agentId,
	description,
	subagentType: 'general-purpose',
	model: 'claude-opus-5-5'
})
const STATE = [
	{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build the launch kit for our new cold brew' },
	spawn('a1', 'Research competitor launches'),
	spawn('a2', 'Design the launch graphics'),
	spawn('a3', 'Build the landing page'),
	{ kind: 'step', at: 3000, agentId: 'a1', model: 'claude-opus-5-5', effort: 'high', usage },
	{ kind: 'turnEnd', at: 20_000, agentId: 'a1', isAborted: false, reason: 'answer' }
].reduce((state, ev) => reduce(state, ev as CrewEvent), EMPTY_STATE)

test('the band line fits its width', async () => {
	const progress = selectProgress(STATE)
	if (!progress) throw new Error('expected progress')
	const wide = bandLine(STATE, progress, 100)
	expect(wide.pill).toBe('Agents 1/3')
	expect(wide.percent).toBe('33%')
	expect(wide.runningLabel).toBe('2 running')
	expect(wide.agentLabel).toBe('2 running')
	expect(wide.label).toBe('Build the launch kit for our new cold brew')
	const narrow = bandLine(STATE, progress, 40)
	expect(narrow.label.endsWith('…')).toBe(true)
	expect((narrow.filled + narrow.empty).length).toBe(6)
})

test('the running count is hidden when the turn has no sub-agents', async () => {
	const tasksOnly = reduce(reduce(EMPTY_STATE, { kind: 'turnStart', at: 1000, turnId: 't1', text: 'Plan the board' }), {
		kind: 'tasks',
		call: { tool: 'TodoWrite', input: { todos: [{ content: 'Read notes', status: 'in_progress', activeForm: 'x' }] } }
	})
	const progress = selectProgress(tasksOnly)
	if (!progress) throw new Error('expected progress')
	expect(progress.source).toBe('tasks')
	expect(bandLine(tasksOnly, progress, 100).runningLabel).toBe('')
	// With no sub-agent, the agent at work is Main: the band names it.
	expect(bandLine(tasksOnly, progress, 100).agentLabel).toBe('Main')
})

test('the running count reads 0 running once every sub-agent has ended', async () => {
	const ended = ['a2', 'a3'].reduce(
		(state, agentId) => reduce(state, { kind: 'turnEnd', at: 21_000, agentId, isAborted: false, reason: 'answer' }),
		STATE
	)
	const progress = selectProgress(ended)
	if (!progress) throw new Error('expected progress')
	expect(bandLine(ended, progress, 100).runningLabel).toBe('0 running')
})

test('rows carry model, effort and the stats line', async () => {
	const view = panelView(STATE, {}, 30_000, 20, {})
	const finished = view.groups.find(group => group.name === 'Finished')
	expect(finished?.count).toBe(1)
	const row = finished?.rows[0]
	expect(row?.meta).toBe('high · Opus 5.5')
	expect(row?.effort).toBe('high')
	expect(row?.model).toBe('Opus 5.5')
	expect(row?.effortTone).toBe('warning')
	expect(row?.stats).toBe('ctx 1% · 14k · ≈$0.03 · 0:18')
	expect(row?.usageText).toBe('ctx 1% · 14k · ≈$0.03')
	expect(row?.elapsed).toBe('0:18')
	expect(row?.mark).toBe('✓')
	expect(row?.bar).toBe('█'.repeat(20))
	expect(view.groups.map(group => group.name)).toEqual(['Running', 'Finished'])
	expect(view.cost).toBe('≈$0.03')
	expect(view.tokens).toBe('14k')
	expect(view.time).toBe('0:29')
	expect(view.main?.title).toBe('Main')
})

test('effort maps to a theme tone', async () => {
	expect(effortToneOf('low')).toBe('success')
	expect(effortToneOf('medium')).toBe('suggestion')
	expect(effortToneOf('high')).toBe('warning')
	expect(effortToneOf('xhigh')).toBe('error')
	expect(effortToneOf('max')).toBe('error')
	expect(effortToneOf('turbo')).toBeUndefined()
	expect(effortToneOf(undefined)).toBeUndefined()
	const running = panelView(STATE, {}, 30_000, 20, {}).groups.find(group => group.name === 'Running')?.rows[0]
	expect(running?.effort).toBe('')
	expect(running?.effortTone).toBeUndefined()
})

test('each agent takes the next accent at spawn; Main wears Pip blue', async () => {
	const seven = ['a4', 'a5', 'a6', 'a7'].reduce((state, id) => reduce(state, spawn(id, `Job ${id}`)), STATE)
	const view = panelView(seven, {}, 30_000, 20, {})
	const rows = view.groups.flatMap(group => group.rows)
	const accentOf = (id: string) => rows.find(row => row.id === id)?.accent
	expect(view.main?.accent).toBe(PALETTE.body)
	expect(view.main?.accent).toBe('#7C9CF5')
	expect(rows.map(row => row.accent)).not.toContain(PALETTE.body)
	expect(accentOf('a1')).toBe(ACCENTS[0])
	expect(accentOf('a2')).toBe(ACCENTS[1])
	expect(accentOf('a6')).toBe(ACCENTS[5])
	expect(accentOf('a7')).toBe(ACCENTS[0])
})

const accentsOf = (state: typeof STATE) =>
	Object.fromEntries(panelView(state, {}, 30_000, 20, {}).groups.flatMap(group => group.rows).map(row => [row.id, row.accent]))

test('agents keep their colour after a new prompt drops finished agents before them', async () => {
	expect(accentsOf(STATE)).toEqual({ a1: ACCENTS[0], a2: ACCENTS[1], a3: ACCENTS[2] })
	const next = reduce(STATE, { kind: 'turnStart', at: 30_000, turnId: 't2', text: 'Now the email' })
	expect(next.order).toEqual(['a2', 'a3'])
	const later = reduce(next, spawn('a4', 'Write the email'))
	expect(accentsOf(later)).toEqual({ a2: ACCENTS[1], a3: ACCENTS[2], a4: ACCENTS[3] })
})

test('a resumed agent keeps its colour', async () => {
	const next = reduce(STATE, { kind: 'turnStart', at: 30_000, turnId: 't2', text: 'Again' })
	expect(next.agents.a1).toBeUndefined()
	const fresh = reduce(next, spawn('a4', 'Something new'))
	// Resumed through its own turn, then through a second spawn of the same id.
	const resumed = reduce(fresh, { kind: 'turnStart', at: 31_000, turnId: 's1', text: 'go on', agentId: 'a1' })
	expect(accentsOf(resumed).a1).toBe(ACCENTS[0])
	const respawned = reduce(fresh, spawn('a1', 'Research competitor launches'))
	expect(accentsOf(respawned).a1).toBe(ACCENTS[0])
	expect(accentsOf(respawned).a4).toBe(ACCENTS[3])
})

test('six agents get six different colours, the seventh repeats the first', async () => {
	const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']
	const state = ids.reduce((acc, id) => reduce(acc, spawn(id, `Job ${id}`)), EMPTY_STATE)
	const accents = accentsOf(state)
	expect(new Set(ids.slice(0, 6).map(id => accents[id])).size).toBe(6)
	expect(accents.c7).toBe(accents.c1)
	expect(Object.values(accents)).not.toContain(PALETTE.body)
})

test('agents first seen without a spawn take the next colour; Main never does', async () => {
	const stepped = reduce(STATE, { kind: 'step', at: 4000, agentId: 'x1', model: 'claude-opus-5-5', usage })
	const started = reduce(stepped, { kind: 'turnStart', at: 5000, turnId: 's2', text: 'go', agentId: 'x2' })
	const mainStep = reduce(started, { kind: 'step', at: 6000, model: 'claude-opus-5-5', usage })
	const view = panelView(mainStep, {}, 30_000, 20, {})
	const accents = accentsOf(mainStep)
	expect(new Set(Object.values(accents)).size).toBe(5)
	expect(view.main?.accent).toBe(PALETTE.body)
	// A later spawn takes the colour after them.
	expect(accentsOf(reduce(mainStep, spawn('a9', 'Late job'))).a9).toBe(ACCENTS[5])
})

test('an agent first seen without a spawn keeps its colour through a resume', async () => {
	const stepped = reduce(STATE, { kind: 'step', at: 4000, agentId: 'x1', model: 'claude-opus-5-5', usage })
	const colour = accentsOf(stepped).x1
	const ended = reduce(stepped, { kind: 'turnEnd', at: 5000, agentId: 'x1', isAborted: false, reason: 'answer' })
	const next = reduce(ended, { kind: 'turnStart', at: 6000, turnId: 't2', text: 'Next prompt' })
	expect(next.agents.x1).toBeUndefined()
	const busy = reduce(next, spawn('a8', 'Another job'))
	const resumed = reduce(busy, { kind: 'turnStart', at: 7000, turnId: 's3', text: 'again', agentId: 'x1' })
	expect(accentsOf(resumed).x1).toBe(colour)
	const stepAgain = reduce(busy, { kind: 'step', at: 7000, agentId: 'x1', model: 'claude-opus-5-5', usage })
	expect(accentsOf(stepAgain).x1).toBe(colour)
})

test('state saved before colours were stored seeds the next colour past those in use', async () => {
	// Older shape: no nextColor, one agent already holding index 4.
	const { nextColor: _dropped, ...older } = reduce(STATE, spawn('a4', 'Fourth'))
	const withHigh = { ...older, agents: { ...older.agents, a4: { ...older.agents.a4, colorIndex: 4 } } } as any
	expect(accentsOf(reduce(withHigh, spawn('n1', 'New one'))).n1).toBe(ACCENTS[5])
	// No stored indices at all: the colours the order gives must not be handed out again.
	const bare = {
		...older,
		agents: Object.fromEntries(
			Object.entries(older.agents).map(([id, { colorIndex: _c, ...agent }]) => [id, agent])
		),
		known: Object.fromEntries(Object.entries(older.known).map(([id, { colorIndex: _c, ...who }]) => [id, who]))
	} as any
	const seeded = accentsOf(reduce(bare, spawn('n1', 'New one')))
	expect(seeded.n1).toBe(ACCENTS[4])
	expect(Object.values(seeded).filter(colour => colour === seeded.n1)).toHaveLength(1)
})

test('the row fraction drives the bar: steps, done, shimmer, waiting', async () => {
	const withSteps = reduce(
		reduce(STATE, {
			kind: 'tasks',
			agentId: 'a2',
			call: {
				tool: 'TodoWrite',
				input: {
					todos: [
						{ content: 'One', status: 'completed', activeForm: 'x' },
						{ content: 'Two', status: 'in_progress', activeForm: 'y' },
						{ content: 'Three', status: 'pending', activeForm: 'z' },
						{ content: 'Four', status: 'pending', activeForm: 'w' }
					]
				}
			}
		}),
		{ kind: 'statuses', at: 4000, list: [{ id: 'a3', status: 'pending' }] }
	)
	const rows = panelView(withSteps, {}, 30_000, 20, {}).groups.flatMap(group => group.rows)
	const fractionOf = (id: string) => rows.find(row => row.id === id)?.fraction
	expect(fractionOf('a1')).toBe(1)
	expect(fractionOf('a2')).toBe(0.25)
	expect(fractionOf('a3')).toBe(0)
	const running = panelView(STATE, {}, 30_000, 20, {}).groups.find(group => group.name === 'Running')?.rows[0]
	expect(running?.fraction).toBeNull()
})

test('Main waits on its running agents, then shows done', async () => {
	const mainEnded = reduce(STATE, { kind: 'turnEnd', at: 21_000, isAborted: false, reason: 'answer' })
	const waiting = panelView(mainEnded, {}, 30_000, 20, {}).main
	expect(waiting?.tone).toBe('waiting')
	expect(waiting?.mark).toBe('')
	expect(waiting?.note).toBe('waiting on 2 agents')
	expect(waiting?.badge).toBe('waiting on 2 agents')
	expect(waiting?.aside).toBe('')
	// Main keeps moving while it waits.
	expect(waiting?.fraction).toBeNull()
	expect(waiting?.bar).not.toBe('░'.repeat(20))
	const oneLeft = reduce(mainEnded, { kind: 'turnEnd', at: 22_000, agentId: 'a2', isAborted: false, reason: 'answer' })
	expect(panelView(oneLeft, {}, 30_000, 20, {}).main?.note).toBe('waiting on 1 agent')
	const allDone = reduce(oneLeft, { kind: 'turnEnd', at: 23_000, agentId: 'a3', isAborted: false, reason: 'answer' })
	const done = panelView(allDone, {}, 30_000, 20, {}).main
	expect(done?.tone).toBe('done')
	expect(done?.mark).toBe('✓')
	expect(done?.note).toBe('')
	expect(done?.badge).toBe('✓')
	expect(done?.fraction).toBe(1)
})

test('Main waits on pending and waiting agents too, not idle ones', async () => {
	const mainEnded = reduce(STATE, { kind: 'turnEnd', at: 21_000, isAborted: false, reason: 'answer' })
	const queued = reduce(mainEnded, {
		kind: 'statuses',
		at: 22_000,
		list: [
			{ id: 'a2', status: 'pending' },
			{ id: 'a3', status: 'waiting' }
		]
	})
	expect(panelView(queued, {}, 30_000, 20, {}).main?.note).toBe('waiting on 2 agents')
	const idle = reduce(queued, { kind: 'statuses', at: 23_000, list: [{ id: 'a3', status: 'idle' }] })
	expect(panelView(idle, {}, 30_000, 20, {}).main?.note).toBe('waiting on 1 agent')
})

test('a row keeps its mark on line one and its note beside the model', async () => {
	const nested = reduce(STATE, { ...spawn('a4', 'Check the hero image'), parentId: 'a2' } as CrewEvent)
	const aborted = reduce(nested, { kind: 'turnEnd', at: 21_000, isAborted: true, reason: 'interrupted' })
	const view = panelView(aborted, {}, 30_000, 20, {})
	const rows = view.groups.flatMap(group => group.rows)
	// "stopped" travels with the ✗ as one badge, so it can never wrap away from it.
	const stopped = rows.find(row => row.id === 'a3')
	expect(stopped?.badge).toBe('✗ stopped')
	expect(stopped?.aside).toBe('')
	const child = rows.find(row => row.id === 'a4')
	expect(child?.badge).toBe('✗ stopped')
	expect(child?.aside).toBe('↳ from Design the launch graphics')
	expect(view.main?.badge).toBe('✗ stopped')
	expect(view.main?.aside).toBe('')
	const finished = rows.find(row => row.id === 'a1')
	expect(finished?.badge).toBe('✓')
	expect(finished?.aside).toBe('')
})

test('the badge on line one is held to about 20 characters', async () => {
	const many = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10'].reduce(
		(state, id) => reduce(state, spawn(id, `Job ${id}`)),
		STATE
	)
	const ended = reduce(many, { kind: 'turnEnd', at: 21_000, isAborted: false, reason: 'answer' })
	const main = panelView(ended, {}, 30_000, 20, {}).main
	expect(main?.note).toBe('waiting on 12 agents')
	expect(main?.badge.length).toBeLessThanOrEqual(20)
})

test('rows skip the half-block sprite where the surface draws SVG', async () => {
	const rows = (sprites: boolean) =>
		panelView(STATE, {}, 30_000, 20, {}, { sprites }).groups.flatMap(group => group.rows)
	expect(rows(false).every(row => row.sprite.length === 0)).toBe(true)
	expect(rows(true).every(row => row.sprite.length === 4)).toBe(true)
	expect(panelView(STATE, {}, 30_000, 20, {}).main?.sprite).toHaveLength(4)
})

const MANY = Array.from({ length: COLLAPSE_AFTER + 1 }, (_, i) => i).reduce(
	(state, i) =>
		reduce(reduce(state, spawn(`b${i}`, `Job ${i}`)), {
			kind: 'turnEnd',
			at: 5000,
			agentId: `b${i}`,
			isAborted: false,
			reason: 'answer'
		}),
	STATE
)

test('a long finished list collapses until opened', async () => {
	const closed = panelView(MANY, {}, 30_000, 20, {}).groups.find(group => group.name === 'Finished')
	expect(closed?.isCollapsed).toBe(true)
	expect(closed?.isCollapsible).toBe(true)
	const open = panelView(MANY, {}, 30_000, 20, { Finished: true }).groups.find(group => group.name === 'Finished')
	expect(open?.isCollapsed).toBe(false)
	// A short finished list starts open.
	expect(panelView(STATE, {}, 30_000, 20, {}).groups.find(group => group.name === 'Finished')?.isCollapsed).toBe(false)
})

test('every group starts open and collapses on its own override', async () => {
	const view = panelView(MANY, {}, 30_000, 20, { Running: false })
	const byName = (name: string) => view.groups.find(group => group.name === name)
	expect(byName('Running')?.isCollapsed).toBe(true)
	expect(byName('Running')?.isCollapsible).toBe(true)
	expect(byName('Finished')?.isCollapsed).toBe(true)
	expect(panelView(MANY, {}, 30_000, 20, {}).groups.find(group => group.name === 'Running')?.isCollapsed).toBe(false)
})

test('toggling a group flips what it shows and nothing else', async () => {
	const find = (open: Record<string, boolean>, name: string) =>
		panelView(MANY, {}, 30_000, 20, open).groups.find(group => group.name === name)
	const opened = toggleGroup({}, 'Finished', MANY)
	expect(opened).toEqual({ Finished: true })
	expect(find(opened, 'Finished')?.isCollapsed).toBe(false)
	expect(find(opened, 'Running')?.isCollapsed).toBe(false)
	const closedAgain = toggleGroup(opened, 'Finished', MANY)
	expect(find(closedAgain, 'Finished')?.isCollapsed).toBe(true)
	const running = toggleGroup(closedAgain, 'Running', MANY)
	expect(running).toEqual({ Finished: false, Running: false })
	expect(find(running, 'Running')?.isCollapsed).toBe(true)
	expect(find(running, 'Finished')?.isCollapsed).toBe(true)
	// A short list's Finished starts open, so its first press collapses it.
	expect(toggleGroup({}, 'Finished', STATE)).toEqual({ Finished: false })
})

test('an empty session says so', async () => {
	expect(panelView(EMPTY_STATE, {}, 0, 20, {}).isEmpty).toBe(true)
	expect(panelView(STATE, {}, 0, 20, {}).isEmpty).toBe(false)
})

test('a stored envelope label is never drawn', async () => {
	const stale = { ...STATE, turn: { ...STATE.turn!, label: '<agent-message from="a0d530c7c7f0">' } }
	const progress = selectProgress(stale)
	if (!progress) throw new Error('expected progress')
	expect(bandLine(stale, progress, 100).label).toBe('Working')
})

test('each sub-agent takes the species in the slot of its colour; Main is Pip', async () => {
	const view = panelView(STATE, {}, 30_000, 20, {})
	expect(view.main?.species).toBe('pip')
	const rows = view.groups.flatMap(group => group.rows)
	expect(new Set(rows.map(row => row.species)).size).toBe(rows.length)
	for (const row of rows) expect(row.species).toBe(SPECIES_ORDER[ACCENTS.indexOf(row.accent)])
})

test('the pose follows the state: running, still, paused or stopped', async () => {
	const view = panelView(STATE, {}, 30_000, 20, {})
	const byId = Object.fromEntries(view.groups.flatMap(group => group.rows).map(row => [row.id, row.pose]))
	expect(byId.a1).toBe('still')
	expect(byId.a2).toBe('running')
	expect(view.main?.pose).toBe('running')
	const waiting = reduce(STATE, { kind: 'turnEnd', at: 21_000, isAborted: false, reason: 'answer' } as CrewEvent)
	expect(panelView(waiting, {}, 30_000, 20, {}).main?.pose).toBe('paused')
	const stopped = reduce(STATE, { kind: 'statuses', at: 22_000, list: [{ id: 'a3', status: 'stopped' }] })
	const rowsAfter = panelView(stopped, {}, 30_000, 20, {}).groups.flatMap(group => group.rows)
	expect(rowsAfter.find(row => row.id === 'a3')?.pose).toBe('stopped')
})

test('on the terminal a running mascot changes from one second to the next; a finished one does not', async () => {
	const at = (now: number) => panelView(STATE, {}, now, 20, {}).groups.flatMap(group => group.rows)
	const [a, b] = [at(30_000), at(31_000)]
	expect(a.find(row => row.id === 'a2')?.sprite).not.toEqual(b.find(row => row.id === 'a2')?.sprite)
	expect(a.find(row => row.id === 'a1')?.sprite).toEqual(b.find(row => row.id === 'a1')?.sprite)
})

// The kit has no toBeCloseTo: within a millionth is close enough for a colour level.
const near = (value: number | null | undefined, target: number) => value !== null && value !== undefined && Math.abs(value - target) < 1e-6

test('a running row breathes on a two-second cycle; any other row holds still', async () => {
	const pulseAt = (now: number, id: string) =>
		panelView(STATE, {}, now, 20, {}).groups.flatMap(group => group.rows).find(row => row.id === id)?.pulse
	// At rest at the top of a cycle, at its peak half way, and back.
	expect(near(pulseAt(30_000, 'a2'), 0)).toBe(true)
	expect(near(pulseAt(31_000, 'a2'), PULSE.strength)).toBe(true)
	expect(near(pulseAt(30_500, 'a2'), PULSE.strength / 2)).toBe(true)
	expect(near(pulseAt(32_000, 'a2'), 0)).toBe(true)
	expect(PULSE.strength).toBe(0.55)
	expect(PULSE.cycleMs).toBe(2000)
	// a1 has finished.
	expect(pulseAt(31_000, 'a1')).toBeNull()
	expect(near(panelView(STATE, {}, 31_000, 20, {}).main?.pulse, PULSE.strength)).toBe(true)
})

test('the pulse colour: the accent at a rising opacity on desktop, a solid blend on the terminal', async () => {
	expect(pulseColor('#1D9E75', 0, 'graphical')).toBe('rgba(29,158,117,0.2)')
	expect(pulseColor('#1D9E75', 0.55, 'graphical')).toBe('rgba(29,158,117,0.75)')
	// The terminal has no opacity: a grey that blends toward the accent.
	expect(pulseColor('#1D9E75', 0, 'terminal')).toBe('#5F5E5A')
	expect(pulseColor('#1D9E75', 1, 'terminal')).toBe('#1D9E75')
	expect(pulseColor('#1D9E75', 0.55, 'terminal')).toMatch(/^#[0-9A-F]{6}$/)
})

const PLANNED = reduce(STATE, {
	kind: 'tasks',
	call: {
		tool: 'mcp__ccd_turn__update_plan',
		input: {
			items: [
				{ content: 'Read the design artifact', status: 'completed' },
				{ content: 'Map the design onto the card', status: 'in_progress' },
				{ content: 'Write the task plan', status: 'pending' },
				{ content: 'Verify in Chrome', status: 'pending' }
			]
		}
	}
})

test("Main's card follows the plan it keeps: its step and a bar to scale", async () => {
	const main = panelView(PLANNED, {}, 30_000, 20, {}).main
	expect(main?.steps).toBe('1/4 · Map the design onto the card')
	expect(main?.fraction).toBe(0.25)
	// Without a plan of its own this prompt, Main has no steps.
	expect(panelView(STATE, {}, 30_000, 20, {}).main?.steps).toBe('')
})

test('Planned lists the plan steps not started yet, numbered as in the plan', async () => {
	const view = panelView(PLANNED, {}, 30_000, 20, {})
	expect(view.planned).toEqual([
		{ number: 3, title: 'Write the task plan' },
		{ number: 4, title: 'Verify in Chrome' }
	])
	expect(view.isPlannedCollapsed).toBe(false)
	expect(panelView(PLANNED, {}, 30_000, 20, { Planned: false }).isPlannedCollapsed).toBe(true)
	// A started step leaves the list.
	const started = reduce(PLANNED, { kind: 'tasks', call: { tool: 'mcp__ccd_turn__update_plan', input: { advance: true } } })
	expect(panelView(started, {}, 30_000, 20, {}).planned.map(step => step.number)).toEqual([4])
	// No plan this prompt, nothing planned; a list carried from an earlier prompt is not this prompt's plan.
	expect(panelView(STATE, {}, 30_000, 20, {}).planned).toEqual([])
	const carried = reduce(PLANNED, { kind: 'turnStart', at: 40_000, turnId: 't2', text: 'Next thing', isPerson: true })
	expect(panelView(carried, {}, 40_000, 20, {}).planned).toEqual([])
})
