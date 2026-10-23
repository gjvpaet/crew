import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentStatusView, MascotPrefs } from '../types'
import { registerBand } from './band'
import { SET_MASCOT_SPEC, SET_MASCOT_TOOL, applyMascotChange, parseMascotInput, sanitizeMascots } from './mascot'
import { openPane, registerPanel, syncPaneShown } from './panel'
import { TASK_TOOLS } from './tasks'
import { EMPTY_STATE, isPulsing, isTicking, reduce, type CrewEvent } from './tracker'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const isBandHidden = atom({ plugin: 'crew', key: 'isBandHidden' } as const, false)
const mascots = atom({ plugin: 'crew', key: 'mascots' } as const, {} as MascotPrefs)
const hasAutoOpened = atom({ plugin: 'crew', key: 'hasAutoOpened' } as const, false)
const groupOpen = atom({ plugin: 'crew', key: 'groupOpen' } as const, {} as Record<string, boolean>)

// The clock beats five times a second. While an agent runs every beat redraws, so its card border breathes;
// otherwise only every fifth does, once a second, for the elapsed times.
const BEAT_MS = 200
const BEATS_PER_SECOND = 5

// Sub-agents keep no task list of their own unless asked, which leaves their bars nothing to measure. Each one is
// asked, after its task, to keep a short one: Crew reads it off the task-list tool calls as the agent's steps.
const STEPS_NOTE =
	'\n\n(Progress for the Crew panel: before you start, write your plan as a task list of 3 to 7 short steps with ' +
	'your task-list tool (TodoWrite, or TaskCreate and TaskUpdate), then mark each step in progress and completed as you go.)'

// A tool Claude can call to bring up the Agents pane, as /crew does for a person: a skill opens it as work begins.
const OPEN_PANEL_TOOL = 'mcp__crew__open_panel'
const OPEN_PANEL_SPEC = {
	name: 'open_panel',
	description:
		'Open the Crew Agents panel, which shows the plan, each sub-agent with its progress, tokens and cost. Call it when starting multi-step or sub-agent work so the user can follow along.',
	inputSchema: { type: 'object', properties: {}, additionalProperties: false }
}

// Origins where a person typed the prompt; every other origin (agents, notifications, triggers) continues a turn.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

const toolInput = (e: object): Record<string, unknown> =>
	Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))

async function apply($: EngineInterface, ev: CrewEvent) {
	await update($, model, state => reduce(state, ev))
}

// The store is the source of truth across sessions and /clear; what it holds is sanitised before it is drawn.
async function loadMascots($: EngineInterface) {
	const saved = sanitizeMascots(await $.store.get('mascots'))
	const same = (prefs: MascotPrefs) => JSON.stringify(prefs) === JSON.stringify(saved)
	if (!same(await read($, mascots))) await update($, mascots, prefs => (same(prefs) ? prefs : saved))
}

// A new prompt lets Finished fold again by itself past COLLAPSE_AFTER; the user's other folds stand.
async function dropFinishedFold($: EngineInterface) {
	if (!('Finished' in (await read($, groupOpen)))) return
	await update($, groupOpen, ({ Finished: _dropped, ...rest } = {}) => rest)
}

// Redraw the pane and band once a second while a clock on them is counting.
async function tick($: EngineInterface, beat: number) {
	const state = await read($, model)
	if (isPulsing(state) || (beat % BEATS_PER_SECOND === 0 && isTicking(state))) $.ui.invalidate('ui.render')
}

// The first spawn of a session opens the pane only where it would be a sidebar; elsewhere it says how to open it.
async function introducePane($: EngineInterface, isSidebar: boolean | undefined) {
	let isFirst = false
	await update($, hasAutoOpened, wasOpened => {
		isFirst = !wasOpened
		return true
	})
	if (!isFirst) return
	if (isSidebar === true) void openPane($)
	else $.ui.toast('Crew: /crew opens the Agents panel')
}

export const register: Register = on => {
	// Last seen from the band's drawing: the spawn hook has no viewport of its own.
	let isSidebar: boolean | undefined
	let ticker: Timer | undefined
	// The prompt whose main turn has not started yet, and whether a person typed it; null when none was seen,
	// in which case the turn falls back to the tracker's text rule.
	let submitted: { text: string; isPerson: boolean } | null = null

	// Noted before `next`: the prompt's turn can start before `next` resolves.
	on('prompt.submit', async ($, e, next) => {
		const mine = { text: e.text, isPerson: !e.command && !e.isMeta && PERSON_ORIGINS.has(e.origin.kind) }
		submitted = mine
		const entered = await next(e)
		if (entered.drop !== undefined && submitted === mine) submitted = null
		return entered
	}).catch(($, e, next) => next(e))

	on('session.start', async ($, e, next) => {
		await $.command.register({ name: 'crew', description: 'Open the Crew agents panel' })
		await $.tool.register(SET_MASCOT_SPEC)
		await $.tool.register(OPEN_PANEL_SPEC)
		await loadMascots($)
		await syncPaneShown($)
		ticker?.cancel()
		let beat = 0
		ticker = $.clock.every(BEAT_MS, () => void tick($, ++beat).catch(() => undefined))
		return next(e)
	})

	on('command.run', { command: 'crew' }, async $ => {
		await openPane($)
		return { text: 'Crew panel opened.' }
	})

	on('turn.start', async ($, e, next) => {
		const seen = e.agentId ? null : submitted
		if (!e.agentId) submitted = null
		const isPerson = seen?.isPerson
		const text = isPerson ? (seen as { text: string }).text : e.text
		await apply($, {
			kind: 'turnStart',
			at: await $.clock.now(),
			turnId: e.turnId,
			text,
			agentId: e.agentId,
			...(isPerson === undefined ? {} : { isPerson })
		})
		if (!e.agentId) await loadMascots($)
		if (!e.agentId && isPerson !== false && text !== '') {
			await update($, isBandHidden, () => false)
			await dropFinishedFold($)
		}
		return next(e)
	})

	on('agent.spawn', async ($, e, next) => {
		const started = await next(e.prompt.includes(STEPS_NOTE) ? e : { ...e, prompt: e.prompt + STEPS_NOTE })
		if (started.deny === undefined && started.agentId) {
			await apply($, {
				kind: 'spawn',
				at: await $.clock.now(),
				agentId: started.agentId,
				description: e.description,
				subagentType: e.subagentType,
				model: started.model,
				...(e.parentAgentId ? { parentId: e.parentAgentId } : {})
			})
			await introducePane($, isSidebar)
		}
		return started
	}).catch(($, e, next) => next(e)) // a Crew failure never fails a spawn

	on('turn.step', async function* ($, e, next) {
		const result = yield* next(e)
		try {
			const at = await $.clock.now()
			const step: CrewEvent = {
				kind: 'step',
				at,
				agentId: e.agentId,
				model: e.model,
				effort: e.effort === undefined ? undefined : String(e.effort),
				usage: result.usage
			}
			const hasAgents = e.agentId !== undefined || (await read($, model)).order.length > 0
			const list = hasAgents ? await $.agent.list() : null
			const statuses: CrewEvent | null = list && {
				kind: 'statuses',
				at,
				list: list.map(agent => ({
					id: agent.id,
					status: agent.status as AgentStatusView,
					...(agent.parentId ? { parentId: agent.parentId } : {})
				}))
			}
			// One write per step: the usage and the statuses land together.
			await update($, model, state => {
				const stepped = reduce(state, step)
				return statuses ? reduce(stepped, statuses) : stepped
			})
		} catch {
			// Crew's bookkeeping never fails a step.
		}
		return result
	})

	on('turn.complete', async ($, e, next) => {
		await apply($, { kind: 'turnEnd', at: await $.clock.now(), agentId: e.agentId, isAborted: e.isAborted, reason: e.reason })
		return next(e)
	})

	on('tool.call', async ($, e, next) => {
		const tool = String(e.tool)
		if (tool === OPEN_PANEL_TOOL) {
			const { isPlaced } = await openPane($)
			if (!isPlaced) $.ui.toast('Crew: /crew opens the Agents panel')
			return { result: { ok: true, isPlaced } }
		}
		if (tool === SET_MASCOT_TOOL) {
			const parsed = parseMascotInput(toolInput(e))
			if ('error' in parsed) return { deny: parsed.error }
			await update($, mascots, prefs => applyMascotChange(prefs, parsed))
			const prefs = await read($, mascots)
			await $.store.set('mascots', prefs)
			return { result: { ok: true, role: parsed.role, prefs: prefs[parsed.role] ?? 'default' } }
		}
		const ran = await next(e)
		if (TASK_TOOLS.has(tool) && ran.deny === undefined && ran.isError !== true) {
			await apply($, { kind: 'tasks', agentId: e.agentId, call: { tool, input: toolInput(e), result: ran.result } })
		}
		return ran
	}).catch(($, e, next) => next(e)) // a Crew failure never fails a tool call

	registerBand(on, isFullscreen => {
		isSidebar = isFullscreen
	})
	registerPanel(on)
}
