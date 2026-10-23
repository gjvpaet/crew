import { expect, test } from 'claude-code/testing'

import {
	EMPTY_STATE,
	MAIN,
	contextFraction,
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
