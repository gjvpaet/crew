import { expect, test } from 'claude-code/testing'

import { EMPTY_STATE, reduce, selectProgress, type CrewEvent } from '../hooks/tracker'
import { COLLAPSE_AFTER, bandLine, panelView } from '../hooks/view'

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
	expect(wide.running).toBe(2)
	expect(wide.label).toBe('Build the launch kit for our new cold brew')
	const narrow = bandLine(STATE, progress, 40)
	expect(narrow.label.endsWith('…')).toBe(true)
	expect((narrow.filled + narrow.empty).length).toBe(6)
})

test('rows carry model, effort and the stats line', async () => {
	const view = panelView(STATE, {}, 30_000, 20, false)
	const finished = view.groups.find(group => group.name === 'Finished')
	expect(finished?.count).toBe(1)
	const row = finished?.rows[0]
	expect(row?.meta).toBe('high · Opus 5.5')
	expect(row?.stats).toBe('ctx 1% · 14k · ≈$0.03 · 0:18')
	expect(row?.mark).toBe('✓')
	expect(row?.bar).toBe('█'.repeat(20))
	expect(view.groups.map(group => group.name)).toEqual(['Running', 'Finished'])
	expect(view.cost).toBe('≈$0.03')
	expect(view.tokens).toBe('14k')
	expect(view.time).toBe('0:29')
	expect(view.main?.title).toBe('Main')
})

test('a long finished list collapses until opened', async () => {
	const many = Array.from({ length: COLLAPSE_AFTER + 1 }, (_, i) => i).reduce(
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
	const closed = panelView(many, {}, 30_000, 20, false).groups.find(group => group.name === 'Finished')
	expect(closed?.isCollapsed).toBe(true)
	expect(closed?.isCollapsible).toBe(true)
	const open = panelView(many, {}, 30_000, 20, true).groups.find(group => group.name === 'Finished')
	expect(open?.isCollapsed).toBe(false)
})

test('an empty session says so', async () => {
	expect(panelView(EMPTY_STATE, {}, 0, 20, false).isEmpty).toBe(true)
})
