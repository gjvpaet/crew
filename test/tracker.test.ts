import { expect, test } from 'claude-code/testing'

import {
	EMPTY_STATE,
	MAIN,
	contextFraction,
	isPulsing,
	isTicking,
	reduce,
	selectGroups,
	selectProgress,
	selectRunning,
	selectSessionTotals,
	selectTurnTotals,
	type CrewEvent
} from '../hooks/tracker'

const run = (events: CrewEvent[]) => events.reduce(reduce, EMPTY_STATE)
const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, model = 'claude-opus-5-5') => ({
	input_tokens: input,
	output_tokens: output,
	cache_read_input_tokens: cacheRead,
	cache_creation_input_tokens: cacheWrite,
	model
})
const spawn = (agentId: string, description: string, subagentType = 'general-purpose'): CrewEvent => ({
	kind: 'spawn',
	at: 2000,
	agentId,
	description,
	subagentType,
	model: 'claude-opus-5-5'
})

const START: CrewEvent[] = [
	{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build the launch kit\nwith details' },
	spawn('a1', 'Research competitor launches', 'Explore'),
	spawn('a2', 'Design the launch graphics'),
	spawn('a3', 'Build the landing page')
]

test('a turn with three agents starts at 0 of 3', async () => {
	const state = run(START)
	expect(state.turn?.label).toBe('Build the launch kit')
	expect(state.agents[MAIN].description).toBe('Main')
	expect(state.agents.a1.role).toBe('researcher')
	expect(selectProgress(state)).toEqual({ source: 'agents', done: 0, total: 3, fraction: 0 })
	expect(selectRunning(state)).toBe(3)
})

test('steps add usage, model, effort and context size', async () => {
	const state = run([
		...START,
		{ kind: 'step', at: 3000, agentId: 'a1', model: 'claude-opus-5-5', effort: 'high', usage: usage(1000, 500, 10_000, 2000) }
	])
	expect(state.agents.a1.usage).toEqual({ input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 })
	expect(state.agents.a1.effort).toBe('high')
	expect(state.agents.a1.lastRequestInput).toBe(13_000)
	expect(contextFraction(state.agents.a1)).toBe(0.013)
	const totals = selectTurnTotals(state)
	expect(totals.tokens).toBe(13_500)
	expect(Math.round(totals.costUsd * 1_000_000)).toBe(26_000)
	expect(totals.isPartial).toBe(false)
	expect(selectSessionTotals(state).tokens).toBe(13_500)
})

test('ends sort agents into groups and an abort stops the rest', async () => {
	const state = run([
		...START,
		{ kind: 'turnEnd', at: 20_000, agentId: 'a1', isAborted: false, reason: 'answer' },
		{ kind: 'turnEnd', at: 21_000, agentId: 'a2', isAborted: false, reason: 'error' }
	])
	expect(selectProgress(state)).toEqual({ source: 'agents', done: 2, total: 3, fraction: 2 / 3 })
	const groups = selectGroups(state)
	expect(groups.finished.map(a => a.id)).toEqual(['a1'])
	expect(groups.failed.map(a => a.id)).toEqual(['a2'])
	expect(groups.running.map(a => a.id)).toEqual(['a3'])

	const aborted = run([
		...START,
		{ kind: 'turnEnd', at: 30_000, isAborted: true, reason: 'aborted' },
		{ kind: 'statuses', at: 31_000, list: [{ id: 'a3', status: 'completed' }] }
	])
	expect(aborted.agents.a3.status).toBe('stopped')
	expect(aborted.agents.a3.endedAt).toBe(30_000)
	expect(aborted.agents[MAIN].status).toBe('stopped')
	expect(aborted.turn?.isAborted).toBe(true)
})

test('a visible task list drives progress', async () => {
	const state = run([
		...START,
		{
			kind: 'tasks',
			call: {
				tool: 'TodoWrite',
				input: {
					todos: [
						{ content: 'One', status: 'completed', activeForm: 'x' },
						{ content: 'Two', status: 'in_progress', activeForm: 'y' }
					]
				}
			}
		}
	])
	expect(selectProgress(state)).toEqual({ source: 'tasks', done: 1, total: 2, fraction: 0.5 })
})

test('a sub-agent task list becomes its steps', async () => {
	const state = run([
		...START,
		{
			kind: 'tasks',
			agentId: 'a3',
			call: {
				tool: 'TodoWrite',
				input: { todos: [{ content: 'Hero copy', status: 'in_progress', activeForm: 'x' }] }
			}
		}
	])
	expect(state.agents.a3.steps).toEqual({ done: 0, total: 1, current: 'Hero copy' })
	expect(state.tasks).toEqual([])
})

test('an unknown model makes the cost partial', async () => {
	const state = run([...START, { kind: 'step', at: 3000, model: 'mystery', usage: usage(100, 0, 0, 0, 'mystery') }])
	expect(selectTurnTotals(state).isPartial).toBe(true)
})

test('a continuation keeps the turn; a new prompt keeps only live agents', async () => {
	const ended = run([...START, { kind: 'turnEnd', at: 20_000, agentId: 'a1', isAborted: false, reason: 'answer' }])
	const continued = reduce(ended, { kind: 'turnStart', at: 25_000, turnId: 't2', text: '' })
	expect(continued.turn?.id).toBe('t1')
	const fresh = reduce(ended, { kind: 'turnStart', at: 25_000, turnId: 't3', text: 'Next thing' })
	expect(fresh.order).toEqual(['a2', 'a3'])
	expect(fresh.agents.a1).toBeUndefined()
	expect(fresh.turn?.label).toBe('Next thing')
})

test('an agent seen before its spawn keeps its start time', async () => {
	const state = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Go' },
		{ kind: 'turnStart', at: 1500, turnId: 'x', text: 'sub prompt', agentId: 'a9' },
		spawn('a9', 'Review the diff')
	])
	expect(state.agents.a9.spawnedAt).toBe(1500)
	expect(state.agents.a9.role).toBe('reviewer')
	expect(state.order).toEqual(['a9'])
})

test('statuses update known agents and their parents', async () => {
	const state = run([...START, { kind: 'statuses', at: 9000, list: [{ id: 'a2', status: 'failed', parentId: 'a1' }] }])
	expect(state.agents.a2.status).toBe('failed')
	expect(state.agents.a2.endedAt).toBe(9000)
	expect(state.agents.a2.parentId).toBe('a1')
})

test('a continuation after a background agent reopens the turn', async () => {
	const state = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'go' },
		spawn('bg', 'Run the background check'),
		{ kind: 'turnEnd', at: 3000, isAborted: false, reason: 'answer' },
		{ kind: 'turnEnd', at: 4000, agentId: 'bg', isAborted: false, reason: 'answer' },
		{ kind: 'turnStart', at: 5000, turnId: 't2', text: '' }
	])
	expect(state.turn?.id).toBe('t1')
	expect(state.turn?.endedAt).toBeUndefined()
	expect(state.turn?.isAborted).toBe(false)
	expect(state.agents[MAIN].status).toBe('running')
	expect(state.agents[MAIN].endedAt).toBeUndefined()
})

test('an agent resumed by a new prompt keeps its identity', async () => {
	const state = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'go' },
		spawn('a', 'Review the diff'),
		{ kind: 'turnEnd', at: 3000, agentId: 'a', isAborted: false, reason: 'answer' },
		{ kind: 'turnEnd', at: 4000, isAborted: false, reason: 'answer' },
		{ kind: 'turnStart', at: 5000, turnId: 't2', text: 'ask a again' },
		{ kind: 'turnStart', at: 5500, turnId: 'x', text: 'again', agentId: 'a' }
	])
	expect(state.agents.a.description).toBe('Review the diff')
	expect(state.agents.a.role).toBe('reviewer')
	expect(state.order).toEqual(['a'])
})

test('an abort spares idle teammates and a step revives a stopped agent', async () => {
	const aborted = run([
		...START,
		spawn('tm', 'Teammate on standby'),
		{ kind: 'statuses', at: 2500, list: [{ id: 'tm', status: 'idle' }] },
		{ kind: 'turnEnd', at: 3000, isAborted: true, reason: 'aborted' }
	])
	expect(aborted.agents.tm.status).toBe('idle')
	expect(aborted.agents.a1.status).toBe('stopped')
	const revived = reduce(aborted, {
		kind: 'step',
		at: 4000,
		agentId: 'a1',
		model: 'claude-opus-5-5',
		usage: usage(10, 0, 0, 0)
	})
	expect(revived.agents.a1.status).toBe('running')
	expect(revived.agents.a1.endedAt).toBeUndefined()
})

test('turn totals count only this turn while the session counts everything', async () => {
	const state = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'go' },
		spawn('bg', 'Run the background check'),
		{ kind: 'step', at: 3000, agentId: 'bg', model: 'claude-opus-5-5', usage: usage(1_000_000, 0, 0, 0) },
		{ kind: 'turnStart', at: 4000, turnId: 't2', text: 'hi' },
		{ kind: 'step', at: 5000, model: 'claude-opus-5-5', usage: usage(100, 0, 0, 0) }
	])
	expect(selectTurnTotals(state).tokens).toBe(100)
	expect(selectSessionTotals(state).tokens).toBe(1_000_100)
})

test('an idle teammate counts as done and an ended agent is not regressed', async () => {
	const ended = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'go' },
		spawn('tm', 'Teammate on standby'),
		{ kind: 'turnEnd', at: 5000, agentId: 'tm', isAborted: false, reason: 'answer' },
		{ kind: 'statuses', at: 6000, list: [{ id: 'tm', status: 'idle' }] }
	])
	expect(ended.agents.tm.status).toBe('completed')
	expect(ended.agents.tm.endedAt).toBe(5000)
	expect(selectProgress(ended)?.done).toBe(1)
	expect(selectProgress(ended)?.total).toBe(1)

	const idle = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'go' },
		spawn('tm', 'Teammate on standby'),
		{ kind: 'statuses', at: 6000, list: [{ id: 'tm', status: 'idle' }] }
	])
	expect(selectProgress(idle)?.done).toBe(1)
})

test('missing usage fields do not poison totals', async () => {
	const state = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'go' },
		{
			kind: 'step',
			at: 2000,
			model: 'claude-opus-5-5',
			usage: { input_tokens: 10, output_tokens: 5 } as any
		}
	])
	expect(selectSessionTotals(state).tokens).toBe(15)
})

test('the main context size carries across prompts', async () => {
	const state = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'go' },
		{ kind: 'step', at: 2000, model: 'claude-opus-5-5', usage: usage(1000, 0, 9000, 0) },
		{ kind: 'turnStart', at: 3000, turnId: 't2', text: 'next' }
	])
	expect(state.agents[MAIN].lastRequestInput).toBe(10_000)
})

test('a step without usage does not revive a stopped agent', async () => {
	const state = run([
		...START,
		{ kind: 'turnEnd', at: 4000, isAborted: true, reason: 'aborted' },
		{ kind: 'step', at: 5000, agentId: 'a1', model: 'claude-opus-5-5', usage: null }
	])
	expect(state.agents.a1.status).toBe('stopped')
})

test('a partial usage still gives a numeric context size', async () => {
	const state = run([
		...START,
		{ kind: 'step', at: 3000, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } as any }
	])
	expect(state.agents.main.lastRequestInput).toBe(10)
})

test('state from an older shape reduces without throwing', async () => {
	const old = { turn: null, agents: {}, order: [], tasks: [], agentTasks: {}, sessionByModel: {} } as any
	const started = reduce(old, { kind: 'turnStart', at: 1000, turnId: 't1', text: 'Go' })
	const spawned = reduce(started, spawn('a1', 'Research'))
	const stepped = reduce(spawned, { kind: 'step', at: 1100, agentId: 'a1', model: 'claude-opus-5-5', usage: usage(10, 5, 0, 0) })
	expect(stepped.known.a1?.description).toBe('Research')
	expect(stepped.turnByModel['claude-opus-5-5']?.input).toBe(10)
})

test('statuses that change nothing return the same state', async () => {
	const state = run([...START, { kind: 'statuses', at: 3000, list: [{ id: 'a1', status: 'running', parentId: 'p1' }] }])
	expect(reduce(state, { kind: 'statuses', at: 4000, list: [{ id: 'a1', status: 'running', parentId: 'p1' }] })).toBe(state)
	expect(reduce(state, { kind: 'statuses', at: 4000, list: [{ id: 'a2', status: 'running' }, { id: 'zz', status: 'completed' }] })).toBe(state)
	expect(reduce(state, { kind: 'statuses', at: 4000, list: [{ id: 'a2', status: 'completed' }] })).not.toBe(state)
})

test('a spawn carries its parent', async () => {
	const state = run([...START, { ...spawn('a4', 'Nested'), parentId: 'a1' } as CrewEvent])
	expect(state.agents.a4?.parentId).toBe('a1')
	expect(state.known.a4?.parentId).toBe('a1')
})

test('time moves while a turn is open or an agent runs', async () => {
	expect(isTicking(EMPTY_STATE)).toBe(false)
	const started = run(START)
	expect(isTicking(started)).toBe(true)
	const ended = reduce(started, { kind: 'turnEnd', at: 5000, isAborted: false, reason: 'answer' })
	expect(isTicking(ended)).toBe(true)
	const allDone = ['a1', 'a2', 'a3'].reduce(
		(state, agentId) => reduce(state, { kind: 'turnEnd', at: 6000, agentId, isAborted: false, reason: 'answer' }),
		ended
	)
	expect(isTicking(allDone)).toBe(false)
})

test('a turn no person started continues the current one', async () => {
	const ended = run([
		...START,
		{ kind: 'step', at: 3000, model: 'claude-opus-5-5', usage: usage(1000, 0, 0, 0) },
		{ kind: 'turnEnd', at: 20_000, isAborted: false, reason: 'answer' }
	])
	const next = reduce(ended, {
		kind: 'turnStart',
		at: 25_000,
		turnId: 't2',
		text: '<agent-message from="a670999281b9">done</agent-message>',
		isPerson: false
	})
	expect(next.turn?.id).toBe('t1')
	expect(next.turn?.label).toBe('Build the launch kit')
	expect(next.turn?.startedAt).toBe(1000)
	expect(next.turn?.endedAt).toBeUndefined()
	expect(next.agents[MAIN].status).toBe('running')
	expect(next.order).toEqual(['a1', 'a2', 'a3'])
	expect(selectTurnTotals(next).tokens).toBe(1000)
})

test('a person prompt still starts a fresh turn', async () => {
	const ended = run([...START, { kind: 'turnEnd', at: 20_000, isAborted: false, reason: 'answer' }])
	const next = reduce(ended, { kind: 'turnStart', at: 25_000, turnId: 't2', text: 'Next thing', isPerson: true })
	expect(next.turn?.id).toBe('t2')
	expect(next.turn?.label).toBe('Next thing')
})

test('a label never shows a raw message envelope', async () => {
	const fromAgent = reduce(EMPTY_STATE, {
		kind: 'turnStart',
		at: 1000,
		turnId: 't1',
		text: '<task-notification>\n<task-id>x</task-id>',
		isPerson: false
	})
	expect(fromAgent.turn?.label).toBe('Working')
	const unmarked = reduce(EMPTY_STATE, { kind: 'turnStart', at: 1000, turnId: 't1', text: '<agent-message from="a6">hi' })
	expect(unmarked.turn?.label).toBe('Working')
})

test('an envelope turn of unknown origin continues the current turn', async () => {
	const next = reduce(run(START), {
		kind: 'turnStart',
		at: 25_000,
		turnId: 't2',
		text: '<agent-message from="a0d530c7c7f0">Task 6 done</agent-message>'
	})
	expect(next.turn?.id).toBe('t1')
	expect(next.turn?.label).toBe('Build the launch kit')
})

const plan = (statuses: string[]): CrewEvent => ({
	kind: 'tasks',
	call: { tool: 'mcp__ccd_turn__update_plan', input: { items: statuses.map((status, i) => ({ content: `Step ${i + 1}`, status })) } }
})
const prompt = (turnId: string, text: string): CrewEvent => ({ kind: 'turnStart', at: 50_000, turnId, text, isPerson: true })
const SOLO: CrewEvent[] = [{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Fix the lane gutter', isPerson: true }]

test('a plan closed by wrap_up reads as done, then leaves with the next prompt', async () => {
	const wrapped = run([
		...SOLO,
		plan(['in_progress', 'pending', 'pending', 'pending']),
		{ kind: 'tasks', call: { tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'Nothing to fix.' } } }
	])
	expect(selectProgress(wrapped)).toEqual({ source: 'tasks', done: 4, total: 4, fraction: 1 })
	expect(selectProgress(reduce(wrapped, prompt('t2', 'Stop the servers')))).toBeNull()
})

test('a list left unfinished by an earlier prompt is not shown until this prompt touches it', async () => {
	const left = run([...SOLO, plan(['in_progress', 'pending', 'pending', 'pending'])])
	const next = reduce(left, prompt('t2', 'Stop the servers'))
	// No task call and no sub-agent this prompt: nothing to show, so the band stays away.
	expect(selectProgress(next)).toBeNull()
	// With a sub-agent the band counts agents, not the stale list.
	expect(selectProgress(reduce(next, spawn('a1', 'Check the ports')))?.source).toBe('agents')
	// Picked up again this prompt, the kept list shows with its progress.
	const resumed = reduce(next, { kind: 'tasks', call: { tool: 'mcp__ccd_turn__update_plan', input: { advance: true } } })
	expect(selectProgress(resumed)).toEqual({ source: 'tasks', done: 1, total: 4, fraction: 0.25 })
	// A continuation of the same prompt (an agent message) keeps showing the list it already had.
	const continued = reduce(resumed, { kind: 'turnStart', at: 60_000, turnId: 't3', text: '<agent-message>', isPerson: false })
	expect(selectProgress(continued)?.source).toBe('tasks')
})

test('borders pulse while any agent runs, Main included, and not while they only wait', async () => {
	expect(isPulsing(EMPTY_STATE)).toBe(false)
	const started = run(START)
	expect(isPulsing(started)).toBe(true)
	const mainDone = reduce(started, { kind: 'turnEnd', at: 5000, isAborted: false, reason: 'answer' })
	// Main has ended but its sub-agents still run.
	expect(isPulsing(mainDone)).toBe(true)
	const queued = reduce(
		['a1', 'a2'].reduce(
			(state, agentId) => reduce(state, { kind: 'turnEnd', at: 6000, agentId, isAborted: false, reason: 'answer' }),
			mainDone
		),
		{ kind: 'statuses', at: 6500, list: [{ id: 'a3', status: 'pending' }] }
	)
	// Time still counts for the queued agent, but nothing is at work: no pulse.
	expect(isTicking(queued)).toBe(true)
	expect(isPulsing(queued)).toBe(false)
})

test('touches are filed under their agent, or Main without one', () => {
	const state = run([
		...START,
		{ kind: 'touch', at: 3000, agentId: 'a1', path: '/repo/a.js', touch: 'read' },
		{ kind: 'touch', at: 3100, agentId: 'a1', path: '/repo/a.js', touch: 'edit' },
		{ kind: 'touch', at: 3200, path: '/repo/README.md', touch: 'read' }
	])
	expect(state.files.a1).toEqual([{ path: '/repo/a.js', state: 'edited', at: 3100 }])
	expect(state.files[MAIN]).toEqual([{ path: '/repo/README.md', state: 'read', at: 3200 }])
})

test('a commit marks only the listed files and keeps the SHA', () => {
	const state = run([
		...START,
		{ kind: 'touch', at: 3000, agentId: 'a1', path: '/repo/a.js', touch: 'edit' },
		{ kind: 'touch', at: 3100, agentId: 'a1', path: '/repo/b.js', touch: 'edit' },
		{ kind: 'committed', agentId: 'a1', paths: ['/repo/a.js'], sha: 'a1c9e42' }
	])
	expect(state.files.a1.map(item => item.state)).toEqual(['committed', 'edited'])
	expect(state.lastCommit.a1).toBe('a1c9e42')
	// A later commit without a SHA leaves the kept one alone.
	expect(reduce(state, { kind: 'committed', agentId: 'a1', paths: [] }).lastCommit.a1).toBe('a1c9e42')
	// No SHA and no files: nothing is written.
	const quiet = run([...START, { kind: 'committed', agentId: 'a2', paths: [] }])
	expect(Object.keys(quiet.lastCommit)).toEqual([])
	expect(quiet.files).toEqual({})
})

test('a file touched after the commit check began stays edited', () => {
	const state = run([
		...START,
		{ kind: 'touch', at: 3000, agentId: 'a1', path: '/repo/a.js', touch: 'edit' },
		{ kind: 'touch', at: 3500, agentId: 'a1', path: '/repo/b.js', touch: 'edit' },
		{ kind: 'committed', agentId: 'a1', at: 3000, paths: ['/repo/a.js', '/repo/b.js'] }
	])
	expect(state.files.a1.map(item => item.state)).toEqual(['committed', 'edited'])
})

test('a new prompt keeps the files of agents still at work and drops the rest with their cards', () => {
	const state = run([
		...START,
		{ kind: 'touch', at: 3000, agentId: 'a1', path: '/repo/a.js', touch: 'read' },
		{ kind: 'touch', at: 3000, agentId: 'a2', path: '/repo/b.js', touch: 'read' },
		{ kind: 'touch', at: 3000, path: '/repo/c.js', touch: 'read' },
		{ kind: 'committed', agentId: 'a1', paths: [], sha: 'a1c9e42' },
		{ kind: 'committed', agentId: 'a2', paths: [], sha: 'abc1234' },
		{ kind: 'turnEnd', at: 4000, agentId: 'a2', isAborted: false, reason: 'answer' },
		{ kind: 'turnStart', at: 5000, turnId: 't2', text: 'Next thing' }
	])
	expect(Object.keys(state.files)).toEqual(['a1'])
	expect(state.lastCommit).toEqual({ a1: 'a1c9e42' })
})

test('a commit that changes nothing returns the same state', () => {
	const state = run([...START, { kind: 'touch', at: 3000, agentId: 'a1', path: '/repo/a.js', touch: 'edit' }])
	// No files for the agent and no SHA.
	expect(reduce(state, { kind: 'committed', agentId: 'a2', paths: ['/repo/a.js'] })).toBe(state)
	// Paths that match no edited entry, and no SHA.
	expect(reduce(state, { kind: 'committed', agentId: 'a1', paths: ['/repo/other.js'] })).toBe(state)
	// A SHA alone keeps the files list as it is.
	const stamped = reduce(state, { kind: 'committed', agentId: 'a1', paths: ['/repo/other.js'], sha: 'a1c9e42' })
	expect(stamped.files).toBe(state.files)
	expect(stamped.lastCommit.a1).toBe('a1c9e42')
})

test('touches and commits work on state saved before files existed', () => {
	const old = { turn: null, agents: {}, order: [], tasks: [], agentTasks: {}, sessionByModel: {} } as any
	const touched = reduce(old, { kind: 'touch', at: 1000, agentId: 'a1', path: '/repo/a.js', touch: 'edit' })
	expect(touched.files.a1).toEqual([{ path: '/repo/a.js', state: 'edited', at: 1000 }])
	const committed = reduce(old, { kind: 'committed', agentId: 'a1', paths: [], sha: 'a1c9e42' })
	expect(committed.lastCommit).toEqual({ a1: 'a1c9e42' })
	expect(committed.files).toEqual({})
})

test("Main's files survive a turn no person started", () => {
	const state = run([
		...START,
		{ kind: 'touch', at: 3000, path: '/repo/c.js', touch: 'read' },
		{ kind: 'turnStart', at: 4000, turnId: 't2', text: '', isPerson: false }
	])
	expect(state.files[MAIN]).toEqual([{ path: '/repo/c.js', state: 'read', at: 3000 }])
})

test("an ended sub-agent's files and SHA survive its resume", () => {
	const state = run([
		...START,
		{ kind: 'touch', at: 3000, agentId: 'a1', path: '/repo/a.js', touch: 'edit' },
		{ kind: 'committed', agentId: 'a1', paths: ['/repo/a.js'], sha: 'a1c9e42' },
		{ kind: 'turnEnd', at: 4000, agentId: 'a1', isAborted: false, reason: 'answer' },
		{ kind: 'turnStart', at: 5000, turnId: 't1', text: '', agentId: 'a1' }
	])
	expect(state.agents.a1.status).toBe('running')
	expect(state.files.a1).toEqual([{ path: '/repo/a.js', state: 'committed', at: 3000 }])
	expect(state.lastCommit.a1).toBe('a1c9e42')
})

const git = (lines: Record<string, [number, number]>, repos = {}): CrewEvent => ({ kind: 'git', lines, repos })

test('a git event merges line counts and repositories, and a clean file leaves the counts', () => {
	const state = run([
		...START,
		git({ '/repo/a.js': [12, 3], '/repo/b.js': [1, 0] }, { '/repo': { branch: 'feat/pricing', changed: 2 } }),
		git({ '/repo/b.js': [0, 0], '/repo/c.js': [0, 4] }, { '/other': { branch: null, changed: 0 } })
	])
	expect(state.lines).toEqual({ '/repo/a.js': [12, 3], '/repo/c.js': [0, 4] })
	expect(state.repos).toEqual({ '/repo': { branch: 'feat/pricing', changed: 2 }, '/other': { branch: null, changed: 0 } })
	// A newer answer replaces the older one.
	expect(reduce(state, git({ '/repo/a.js': [13, 3] }, { '/repo': { branch: 'main', changed: 0 } })).lines['/repo/a.js']).toEqual([13, 3])
})

test('a git event that changes nothing returns the same state', () => {
	const state = run([...START, git({ '/repo/a.js': [12, 3] }, { '/repo': { branch: 'main', changed: 1 } })])
	expect(reduce(state, git({ '/repo/a.js': [12, 3] }, { '/repo': { branch: 'main', changed: 1 } }))).toBe(state)
	// A clean file that was never counted, and an empty event.
	expect(reduce(state, git({ '/repo/never.js': [0, 0] }))).toBe(state)
	expect(reduce(state, git({}))).toBe(state)
	// Only the part that changed is copied.
	const moved = reduce(state, git({}, { '/repo': { branch: 'main', changed: 0 } }))
	expect(moved.lines).toBe(state.lines)
	expect(moved.repos['/repo'].changed).toBe(0)
})

test('a new prompt prunes line counts to the files still in some agent’s list', () => {
	const state = run([
		...START,
		{ kind: 'touch', at: 3000, agentId: 'a1', path: '/repo/a.js', touch: 'edit' },
		{ kind: 'touch', at: 3000, agentId: 'a2', path: '/repo/b.js', touch: 'edit' },
		{ kind: 'touch', at: 3000, path: '/repo/c.js', touch: 'edit' },
		git({ '/repo/a.js': [1, 1], '/repo/b.js': [2, 2], '/repo/c.js': [3, 3] }, { '/repo': { branch: 'main', changed: 3 } }),
		{ kind: 'turnEnd', at: 4000, agentId: 'a2', isAborted: false, reason: 'answer' },
		{ kind: 'turnStart', at: 5000, turnId: 't2', text: 'Next thing' }
	])
	expect(state.lines).toEqual({ '/repo/a.js': [1, 1] })
	// The repositories are kept.
	expect(state.repos).toEqual({ '/repo': { branch: 'main', changed: 3 } })
	// A turn no person started prunes nothing.
	expect(reduce(state, { kind: 'turnStart', at: 6000, turnId: 't2', text: '', isPerson: false }).lines).toBe(state.lines)
})

test('git events work on state saved before line counts existed', () => {
	const old = { turn: null, agents: {}, order: [], tasks: [], agentTasks: {}, sessionByModel: {} } as any
	expect(reduce(old, git({ '/repo/a.js': [1, 0] }, { '/repo': { branch: null, changed: 1 } })).lines).toEqual({ '/repo/a.js': [1, 0] })
})

test('an action event keeps the agent’s latest action, and a later one replaces it', async () => {
	const state = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build it' },
		spawn('a1', 'Implement Task 1'),
		{ kind: 'action', agentId: 'a1', text: 'Reading band.tsx' },
		{ kind: 'action', agentId: 'a1', text: 'Editing band.tsx' },
		{ kind: 'action', text: 'Running bun test' }
	])
	expect(state.agents.a1?.action).toBe('Editing band.tsx')
	expect(state.agents[MAIN]?.action).toBe('Running bun test')
	expect(reduce(state, { kind: 'action', agentId: 'a1', text: 'Editing band.tsx' })).toBe(state)
})

test('an action for an agent not on the board changes nothing, and a new prompt starts Main without one', async () => {
	const before = run([{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build it' }])
	expect(reduce(before, { kind: 'action', agentId: 'ghost', text: 'Reading x.ts' })).toBe(before)
	const next = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build it' },
		{ kind: 'action', text: 'Reading x.ts' },
		{ kind: 'turnEnd', at: 2000, isAborted: false, reason: 'answer' },
		{ kind: 'turnStart', at: 3000, turnId: 't2', text: 'Next prompt' }
	])
	expect(next.agents[MAIN]?.action).toBeUndefined()
})

test('a turn that reopens an agent starts it without its last run’s action', async () => {
	const state = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build it' },
		spawn('a1', 'Implement Task 1'),
		{ kind: 'action', text: 'Running bun test' },
		{ kind: 'action', agentId: 'a1', text: 'Editing band.tsx' },
		{ kind: 'turnEnd', at: 2000, agentId: 'a1', isAborted: false, reason: 'answer' },
		{ kind: 'turnEnd', at: 2500, isAborted: false, reason: 'answer' },
		{ kind: 'turnStart', at: 3000, turnId: 't1', text: 'A note arrived', isPerson: false },
		{ kind: 'turnStart', at: 3100, turnId: 's2', text: 'More', agentId: 'a1' }
	])
	expect(state.agents[MAIN]?.action).toBeUndefined()
	expect(state.agents.a1?.action).toBeUndefined()
})
