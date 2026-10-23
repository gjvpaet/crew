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
