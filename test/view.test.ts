import { expect, test } from 'claude-code/testing'

import { EMPTY_STATE, reduce, selectProgress, type CrewEvent } from '../hooks/tracker'
import { ACCENTS, COLLAPSE_AFTER, bandLine, effortToneOf, panelView, toggleGroup } from '../hooks/view'

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

test('each agent keeps its accent by spawn order, Main the first', async () => {
	expect(ACCENTS).toEqual(['#1D9E75', '#7F77DD', '#D85A30', '#378ADD', '#D4537E', '#BA7517'])
	const seven = ['a4', 'a5', 'a6', 'a7'].reduce((state, id) => reduce(state, spawn(id, `Job ${id}`)), STATE)
	const view = panelView(seven, {}, 30_000, 20, {})
	const rows = view.groups.flatMap(group => group.rows)
	const accentOf = (id: string) => rows.find(row => row.id === id)?.accent
	expect(view.main?.accent).toBe('#1D9E75')
	expect(accentOf('a1')).toBe(ACCENTS[0])
	expect(accentOf('a2')).toBe(ACCENTS[1])
	expect(accentOf('a6')).toBe(ACCENTS[5])
	expect(accentOf('a7')).toBe(ACCENTS[0])
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
	const oneLeft = reduce(mainEnded, { kind: 'turnEnd', at: 22_000, agentId: 'a2', isAborted: false, reason: 'answer' })
	expect(panelView(oneLeft, {}, 30_000, 20, {}).main?.note).toBe('waiting on 1 agent')
	const allDone = reduce(oneLeft, { kind: 'turnEnd', at: 23_000, agentId: 'a3', isAborted: false, reason: 'answer' })
	const done = panelView(allDone, {}, 30_000, 20, {}).main
	expect(done?.tone).toBe('done')
	expect(done?.mark).toBe('✓')
	expect(done?.note).toBe('')
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
