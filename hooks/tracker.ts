import type { AgentIdentity, AgentRecord, AgentStatusView, CrewState, TaskItem, Usage } from '../types'
import { contextWindow, estimateUsd } from './pricing'
import { roleFor } from './roles'
import { applyTaskCall, taskProgress, type TaskToolCall } from './tasks'

export const MAIN = 'main'

const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const EMPTY_STATE: CrewState = {
	turn: null,
	agents: {},
	order: [],
	tasks: [],
	agentTasks: {},
	sessionByModel: {},
	turnByModel: {},
	known: {},
	nextColor: 0
}

export type ApiUsage = {
	input_tokens: number
	output_tokens: number
	cache_read_input_tokens: number
	cache_creation_input_tokens: number
	model?: string
}

export type ListedAgent = { id: string; status: AgentStatusView; parentId?: string }

export type CrewEvent =
	| { kind: 'turnStart'; at: number; turnId: string; text: string; agentId?: string }
	| { kind: 'spawn'; at: number; agentId: string; description: string; subagentType: string; model?: string; parentId?: string }
	| { kind: 'step'; at: number; agentId?: string; model: string; effort?: string; usage: ApiUsage | null }
	| { kind: 'turnEnd'; at: number; agentId?: string; isAborted: boolean; reason: string }
	| { kind: 'tasks'; agentId?: string; call: TaskToolCall }
	| { kind: 'statuses'; at: number; list: readonly ListedAgent[] }

const ENDED = new Set<AgentStatusView>(['completed', 'failed', 'killed', 'stopped'])
const FAILED = new Set<AgentStatusView>(['failed', 'killed', 'stopped'])
const WAITING = new Set<AgentStatusView>(['pending', 'waiting', 'idle'])
const ABORTABLE = new Set<AgentStatusView>(['running', 'pending'])
const DONE_FOR_PROGRESS = new Set<AgentStatusView>([...ENDED, 'idle'])

const isLive = (agent: AgentRecord) => !ENDED.has(agent.status)

export const totalTokens = (usage: Usage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite

const addUsage = (sum: Usage, usage: ApiUsage): Usage => ({
	input: sum.input + (usage.input_tokens ?? 0),
	output: sum.output + (usage.output_tokens ?? 0),
	cacheRead: sum.cacheRead + (usage.cache_read_input_tokens ?? 0),
	cacheWrite: sum.cacheWrite + (usage.cache_creation_input_tokens ?? 0)
})

const firstLine = (text: string) => (text.split('\n').find(line => line.trim()) ?? '').trim().slice(0, 80)

function newAgent(id: string, at: number, fields: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id,
		description: id === MAIN ? 'Main' : 'Agent',
		type: id === MAIN ? 'main' : 'general-purpose',
		role: 'plain',
		status: 'running',
		spawnedAt: at,
		usage: ZERO,
		lastRequestInput: 0,
		...fields
	}
}

const identityOf = (agent: AgentRecord): AgentIdentity => ({
	description: agent.description,
	type: agent.type,
	role: agent.role,
	...(agent.model ? { model: agent.model } : {}),
	...(agent.parentId ? { parentId: agent.parentId } : {}),
	...(agent.colorIndex !== undefined ? { colorIndex: agent.colorIndex } : {})
})

const withAgent = (state: CrewState, agent: AgentRecord): CrewState => ({
	...state,
	agents: { ...state.agents, [agent.id]: agent }
})

const withOrder = (state: CrewState, id: string): string[] =>
	id === MAIN || state.order.includes(id) ? state.order : [...state.order, id]

// A sub-agent keeps the colour it was first given; one without takes the next, and Main never takes one.
function withColor(state: CrewState, agent: AgentRecord): { agent: AgentRecord; nextColor: number } {
	if (agent.id === MAIN || agent.colorIndex !== undefined) return { agent, nextColor: state.nextColor }
	return { agent: { ...agent, colorIndex: state.nextColor }, nextColor: state.nextColor + 1 }
}

function endStatus(isAborted: boolean, reason: string): AgentStatusView {
	if (isAborted) return 'stopped'
	return reason === 'error' || reason === 'refusal' ? 'failed' : 'completed'
}

function startTurn(state: CrewState, ev: Extract<CrewEvent, { kind: 'turnStart' }>): CrewState {
	if (ev.agentId) {
		const found = state.agents[ev.agentId] ?? newAgent(ev.agentId, ev.at, state.known[ev.agentId] ?? {})
		const { agent, nextColor } = withColor(state, found)
		const { endedAt: _ended, ...rest } = agent
		return { ...withAgent(state, { ...rest, status: 'running' }), order: withOrder(state, ev.agentId), nextColor }
	}
	if (ev.text === '' && state.turn) {
		const { endedAt: _turnEnded, ...turn } = state.turn
		const { endedAt: _mainEnded, ...main } = state.agents[MAIN] ?? newAgent(MAIN, ev.at)
		return { ...withAgent(state, { ...main, status: 'running' }), turn: { ...turn, isAborted: false } }
	}
	const carried = Object.fromEntries(Object.entries(state.agents).filter(([id, agent]) => id !== MAIN && isLive(agent)))
	const previousMain = state.agents[MAIN]
	const main = newAgent(MAIN, ev.at, {
		...(previousMain?.model ? { model: previousMain.model } : {}),
		...(previousMain?.effort ? { effort: previousMain.effort } : {}),
		lastRequestInput: previousMain?.lastRequestInput ?? 0
	})
	const isListDone = state.tasks.every(task => task.status === 'completed')
	return {
		...state,
		turn: { id: ev.turnId, label: firstLine(ev.text), startedAt: ev.at, isAborted: false },
		agents: { ...carried, [MAIN]: main },
		order: state.order.filter(id => id in carried),
		tasks: isListDone ? [] : state.tasks,
		agentTasks: Object.fromEntries(Object.entries(state.agentTasks).filter(([id]) => id in carried)),
		turnByModel: {}
	}
}

function spawnAgent(state: CrewState, ev: Extract<CrewEvent, { kind: 'spawn' }>): CrewState {
	const previous = state.agents[ev.agentId]
	const model = previous?.model ?? ev.model
	const parentId = ev.parentId ?? previous?.parentId ?? state.known[ev.agentId]?.parentId
	const keptColor = previous?.colorIndex ?? state.known[ev.agentId]?.colorIndex
	const colorIndex = keptColor ?? state.nextColor
	const agent: AgentRecord = {
		...(previous ?? newAgent(ev.agentId, ev.at)),
		description: ev.description || 'Agent',
		type: ev.subagentType,
		role: roleFor({ type: ev.subagentType, description: ev.description }),
		...(model ? { model } : {}),
		...(parentId ? { parentId } : {}),
		colorIndex
	}
	return {
		...withAgent(state, agent),
		order: withOrder(state, ev.agentId),
		known: { ...state.known, [ev.agentId]: identityOf(agent) },
		nextColor: keptColor === undefined ? state.nextColor + 1 : state.nextColor
	}
}

function revive(agent: AgentRecord): AgentRecord {
	if (agent.status !== 'stopped') return agent
	const { endedAt: _ended, ...rest } = agent
	return { ...rest, status: 'running' }
}

function addStep(state: CrewState, ev: Extract<CrewEvent, { kind: 'step' }>): CrewState {
	const id = ev.agentId ?? MAIN
	const colored = withColor(state, state.agents[id] ?? newAgent(id, ev.at, state.known[id] ?? {}))
	const existing = colored.agent
	const order = withOrder(state, id)
	const nextColor = colored.nextColor
	const effort = ev.effort ?? existing.effort
	if (!ev.usage) {
		return { ...withAgent(state, { ...existing, model: ev.model, ...(effort ? { effort } : {}) }), order, nextColor }
	}
	// Only a step that carries usage proves the agent is alive again.
	const previous = revive(existing)
	const model = ev.usage.model || ev.model
	const agent: AgentRecord = {
		...previous,
		model,
		...(effort ? { effort } : {}),
		usage: addUsage(previous.usage, ev.usage),
		lastRequestInput:
			(ev.usage.input_tokens ?? 0) +
			(ev.usage.cache_read_input_tokens ?? 0) +
			(ev.usage.cache_creation_input_tokens ?? 0)
	}
	return {
		...withAgent(state, agent),
		order,
		nextColor,
		sessionByModel: { ...state.sessionByModel, [model]: addUsage(state.sessionByModel[model] ?? ZERO, ev.usage) },
		turnByModel: { ...state.turnByModel, [model]: addUsage(state.turnByModel[model] ?? ZERO, ev.usage) }
	}
}

function endTurn(state: CrewState, ev: Extract<CrewEvent, { kind: 'turnEnd' }>): CrewState {
	if (ev.agentId) {
		const agent = state.agents[ev.agentId]
		if (!agent) return state
		return withAgent(state, { ...agent, status: endStatus(ev.isAborted, ev.reason), endedAt: ev.at })
	}
	if (!state.turn) return state
	const agents = Object.fromEntries(
		Object.entries(state.agents).map(([id, agent]) => {
			if (id === MAIN) return [id, { ...agent, status: endStatus(ev.isAborted, ev.reason), endedAt: ev.at }]
			if (ev.isAborted && ABORTABLE.has(agent.status)) return [id, { ...agent, status: 'stopped' as const, endedAt: ev.at }]
			return [id, agent]
		})
	)
	return { ...state, agents, turn: { ...state.turn, endedAt: ev.at, isAborted: ev.isAborted } }
}

function applyTasks(state: CrewState, ev: Extract<CrewEvent, { kind: 'tasks' }>): CrewState {
	if (!ev.agentId) {
		const list = applyTaskCall(state.tasks, ev.call)
		return list ? { ...state, tasks: list } : state
	}
	const list = applyTaskCall(state.agentTasks[ev.agentId] ?? [], ev.call)
	if (!list) return state
	const agentTasks: Record<string, TaskItem[]> = { ...state.agentTasks, [ev.agentId]: list }
	const agent = state.agents[ev.agentId]
	return agent ? { ...withAgent(state, { ...agent, steps: taskProgress(list) }), agentTasks } : { ...state, agentTasks }
}

function applyStatuses(state: CrewState, ev: Extract<CrewEvent, { kind: 'statuses' }>): CrewState {
	return ev.list.reduce((next, item) => {
		const agent = next.agents[item.id]
		if (!agent || agent.status === 'stopped') return next
		// A lagging list never un-ends an agent; revival belongs to startTurn(agentId) and addStep.
		if (ENDED.has(agent.status) && !ENDED.has(item.status)) return next
		const isParentKnown =
			!item.parentId || (agent.parentId === item.parentId && next.known[item.id]?.parentId === item.parentId)
		if (item.status === agent.status && isParentKnown) return next
		const isEnding = ENDED.has(item.status) && !ENDED.has(agent.status)
		const parentId = item.parentId ?? agent.parentId
		const updated = withAgent(next, {
			...agent,
			status: item.status,
			...(parentId ? { parentId } : {}),
			...(isEnding ? { endedAt: ev.at } : {})
		})
		if (!item.parentId || next.known[item.id]?.parentId === item.parentId) return updated
		const identity = next.known[item.id] ?? identityOf(agent)
		return { ...updated, known: { ...next.known, [item.id]: { ...identity, parentId: item.parentId } } }
	}, state)
}

export function reduce(state: CrewState, ev: CrewEvent): CrewState {
	// State saved by an older build may lack keys added since; a current one passes through as itself.
	const isCurrent = Object.keys(EMPTY_STATE).every(key => key in state)
	const s: CrewState = isCurrent ? state : { ...EMPTY_STATE, ...state }
	switch (ev.kind) {
		case 'turnStart':
			return startTurn(s, ev)
		case 'spawn':
			return spawnAgent(s, ev)
		case 'step':
			return addStep(s, ev)
		case 'turnEnd':
			return endTurn(s, ev)
		case 'tasks':
			return applyTasks(s, ev)
		case 'statuses':
			return applyStatuses(s, ev)
	}
}

export type Progress = { source: 'tasks' | 'agents'; done: number; total: number; fraction: number }

export function selectProgress(state: CrewState): Progress | null {
	if (!state.turn) return null
	if (state.tasks.length > 0) {
		const { done, total } = taskProgress(state.tasks)
		return { source: 'tasks', done, total, fraction: total ? done / total : 0 }
	}
	if (state.order.length === 0) return null
	const done = state.order.filter(id => DONE_FOR_PROGRESS.has(state.agents[id]?.status ?? 'completed')).length
	return { source: 'agents', done, total: state.order.length, fraction: done / state.order.length }
}

// The clock only matters while something on screen counts time: an open turn or a live agent.
export const isTicking = (state: CrewState) =>
	(!!state.turn && state.turn.endedAt === undefined) ||
	state.order.some(id => {
		const agent = state.agents[id]
		return !!agent && isLive(agent)
	})

export const selectRunning = (state: CrewState) =>
	state.order.filter(id => state.agents[id]?.status === 'running').length

export type Groups = { running: AgentRecord[]; waiting: AgentRecord[]; finished: AgentRecord[]; failed: AgentRecord[] }

export function selectGroups(state: CrewState): Groups {
	const agents = state.order.map(id => state.agents[id]).filter((agent): agent is AgentRecord => !!agent)
	return {
		running: agents.filter(agent => agent.status === 'running'),
		waiting: agents.filter(agent => WAITING.has(agent.status)),
		finished: agents.filter(agent => agent.status === 'completed'),
		failed: agents.filter(agent => FAILED.has(agent.status))
	}
}

export type Totals = { tokens: number; costUsd: number; isPartial: boolean }

function totalsOf(entries: ReadonlyArray<{ usage: Usage; model: string }>): Totals {
	return entries.reduce<Totals>(
		(sum, { usage, model }) => {
			const tokens = totalTokens(usage)
			const cost = estimateUsd(usage, model)
			return {
				tokens: sum.tokens + tokens,
				costUsd: sum.costUsd + (cost ?? 0),
				isPartial: sum.isPartial || (cost === null && tokens > 0)
			}
		},
		{ tokens: 0, costUsd: 0, isPartial: false }
	)
}

export const selectTurnTotals = (state: CrewState) =>
	totalsOf(Object.entries(state.turnByModel).map(([model, usage]) => ({ usage, model })))

export const selectSessionTotals = (state: CrewState) =>
	totalsOf(Object.entries(state.sessionByModel).map(([model, usage]) => ({ usage, model })))

export const contextFraction = (agent: AgentRecord) => agent.lastRequestInput / contextWindow(agent.model ?? '')
