import type { AgentIdentity, AgentRecord, AgentStatusView, CrewState, TaskItem, Usage } from '../types'
import { applyCommitted, applyTouch, type Touch } from './files'
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
	nextColor: 0,
	files: {},
	lastCommit: {},
	lines: {},
	repos: {}
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
	// `isPerson` false: the turn was started by an agent message, a notification or a trigger, not by someone typing.
	| { kind: 'turnStart'; at: number; turnId: string; text: string; agentId?: string; isPerson?: boolean }
	| { kind: 'spawn'; at: number; agentId: string; description: string; subagentType: string; model?: string; parentId?: string }
	| { kind: 'step'; at: number; agentId?: string; model: string; effort?: string; usage: ApiUsage | null }
	| { kind: 'turnEnd'; at: number; agentId?: string; isAborted: boolean; reason: string }
	| { kind: 'tasks'; agentId?: string; call: TaskToolCall }
	| { kind: 'statuses'; at: number; list: readonly ListedAgent[] }
	| { kind: 'touch'; at: number; agentId?: string; path: string; touch: Touch }
	| { kind: 'action'; agentId?: string; text: string }
	| { kind: 'committed'; agentId?: string; at?: number; paths: string[]; sha?: string }
	// What `git` just said about some files and repositories; a path at [0, 0] is clean and leaves `lines`.
	| { kind: 'git'; lines: Record<string, [number, number]>; repos: Record<string, { branch: string | null; changed: number }> }

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

// A raw message envelope (`<agent-message …>`, `<task-notification>`) is never a title.
function labelOf(ev: Extract<CrewEvent, { kind: 'turnStart' }>): string {
	const line = firstLine(ev.text)
	return ev.isPerson === false || line.startsWith('<') ? 'Working' : line
}

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

type Colored = { agent: AgentRecord; nextColor: number; known: Record<string, AgentIdentity> }

// A sub-agent keeps the colour it was first given; one without takes the next, and Main never takes one.
// The colour is remembered in `known` too, so an agent first seen without a spawn keeps it through a resume.
function withColor(state: CrewState, found: AgentRecord): Colored {
	if (found.id === MAIN) return { agent: found, nextColor: state.nextColor, known: state.known }
	const isNew = found.colorIndex === undefined
	const agent = isNew ? { ...found, colorIndex: state.nextColor } : found
	const nextColor = isNew ? state.nextColor + 1 : state.nextColor
	const remembered = state.known[agent.id]
	if (remembered?.colorIndex === agent.colorIndex) return { agent, nextColor, known: state.known }
	const identity = { ...(remembered ?? identityOf(agent)), colorIndex: agent.colorIndex }
	return { agent, nextColor, known: { ...state.known, [agent.id]: identity } }
}

// The colour the next new sub-agent takes, for state saved before it was stored: past every index in use, and past
// the places in the order that stand in for an index a record never had.
function seedNextColor(state: Partial<CrewState>): number {
	const indices = [...Object.values(state.agents ?? {}), ...Object.values(state.known ?? {})]
		.map(item => item.colorIndex)
		.filter((index): index is number => typeof index === 'number')
	return Math.max(indices.length ? Math.max(...indices) + 1 : 0, state.order?.length ?? 0)
}

function endStatus(isAborted: boolean, reason: string): AgentStatusView {
	if (isAborted) return 'stopped'
	return reason === 'error' || reason === 'refusal' ? 'failed' : 'completed'
}

function startTurn(state: CrewState, ev: Extract<CrewEvent, { kind: 'turnStart' }>): CrewState {
	if (ev.agentId) {
		const found = state.agents[ev.agentId] ?? newAgent(ev.agentId, ev.at, state.known[ev.agentId] ?? {})
		const { agent, nextColor, known } = withColor(state, found)
		const { endedAt: _ended, action: _action, ...rest } = agent
		return { ...withAgent(state, { ...rest, status: 'running' }), order: withOrder(state, ev.agentId), nextColor, known }
	}
	// An empty prompt, one no person typed, or (origin unknown) a raw `<…>` envelope carries on the person's turn.
	const isEnvelope = ev.isPerson === undefined && firstLine(ev.text).startsWith('<')
	if (state.turn && (ev.text === '' || ev.isPerson === false || isEnvelope)) {
		const { endedAt: _turnEnded, ...turn } = state.turn
		const { endedAt: _mainEnded, action: _mainAction, ...main } = state.agents[MAIN] ?? newAgent(MAIN, ev.at)
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
	const files = Object.fromEntries(Object.entries(state.files).filter(([id]) => id in carried))
	// Counts go with the files that showed them.
	const kept = new Set(Object.values(files).flatMap(list => list.map(item => item.path)))
	return {
		...state,
		turn: { id: ev.turnId, label: labelOf(ev), startedAt: ev.at, isAborted: false },
		agents: { ...carried, [MAIN]: main },
		order: state.order.filter(id => id in carried),
		tasks: isListDone ? [] : state.tasks,
		// An unfinished list is kept for this prompt's updates to build on, but shown only once one arrives.
		areTasksCarried: !isListDone,
		agentTasks: Object.fromEntries(Object.entries(state.agentTasks).filter(([id]) => id in carried)),
		// Files go with their cards: kept for agents still at work, dropped with the rest and with Main's last prompt.
		files,
		lastCommit: Object.fromEntries(Object.entries(state.lastCommit).filter(([id]) => id in carried)),
		lines: Object.fromEntries(Object.entries(state.lines).filter(([path]) => kept.has(path))),
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
	const { endedAt: _ended, action: _action, ...rest } = agent
	return { ...rest, status: 'running' }
}

function addStep(state: CrewState, ev: Extract<CrewEvent, { kind: 'step' }>): CrewState {
	const id = ev.agentId ?? MAIN
	const colored = withColor(state, state.agents[id] ?? newAgent(id, ev.at, state.known[id] ?? {}))
	const existing = colored.agent
	const order = withOrder(state, id)
	const { nextColor, known } = colored
	const effort = ev.effort ?? existing.effort
	if (!ev.usage) {
		return { ...withAgent(state, { ...existing, model: ev.model, ...(effort ? { effort } : {}) }), order, nextColor, known }
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
		known,
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
		return list ? { ...state, tasks: list, areTasksCarried: false } : state
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

function addTouch(state: CrewState, ev: Extract<CrewEvent, { kind: 'touch' }>): CrewState {
	const key = ev.agentId ?? MAIN
	return { ...state, files: { ...state.files, [key]: applyTouch(state.files[key] ?? [], ev.path, ev.touch, ev.at) } }
}

function markCommitted(state: CrewState, ev: Extract<CrewEvent, { kind: 'committed' }>): CrewState {
	const key = ev.agentId ?? MAIN
	const list = state.files[key] ?? []
	const marked = applyCommitted(list, ev.paths, ev.at)
	const isMarked = marked.some((item, index) => item !== list[index])
	if (!isMarked && !ev.sha) return state
	return {
		...state,
		...(isMarked ? { files: { ...state.files, [key]: marked } } : {}),
		...(ev.sha ? { lastCommit: { ...state.lastCommit, [key]: ev.sha } } : {})
	}
}

function applyGit(state: CrewState, ev: Extract<CrewEvent, { kind: 'git' }>): CrewState {
	let lines = state.lines
	for (const [path, counts] of Object.entries(ev.lines)) {
		const before = lines[path]
		const isClean = counts[0] === 0 && counts[1] === 0
		if (isClean ? !before : before && before[0] === counts[0] && before[1] === counts[1]) continue
		if (lines === state.lines) lines = { ...lines }
		if (isClean) delete lines[path]
		else lines[path] = counts
	}
	let repos = state.repos
	for (const [top, info] of Object.entries(ev.repos)) {
		const before = repos[top]
		if (before && before.branch === info.branch && before.changed === info.changed) continue
		if (repos === state.repos) repos = { ...repos }
		repos[top] = info
	}
	return lines === state.lines && repos === state.repos ? state : { ...state, lines, repos }
}

// An agent not on the board has no card for its bubble.
function setAction(state: CrewState, ev: Extract<CrewEvent, { kind: 'action' }>): CrewState {
	const agent = state.agents[ev.agentId ?? MAIN]
	return agent && agent.action !== ev.text ? withAgent(state, { ...agent, action: ev.text }) : state
}

export function reduce(state: CrewState, ev: CrewEvent): CrewState {
	// State saved by an older build may lack keys added since; a current one passes through as itself.
	const isCurrent = Object.keys(EMPTY_STATE).every(key => key in state)
	const s: CrewState = isCurrent
		? state
		: { ...EMPTY_STATE, ...state, nextColor: 'nextColor' in state ? state.nextColor : seedNextColor(state) }
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
		case 'touch':
			return addTouch(s, ev)
		case 'action':
			return setAction(s, ev)
		case 'committed':
			return markCommitted(s, ev)
		case 'git':
			return applyGit(s, ev)
	}
}

export type Progress = { source: 'tasks' | 'agents'; done: number; total: number; fraction: number }

export function selectProgress(state: CrewState): Progress | null {
	if (!state.turn) return null
	if (state.tasks.length > 0 && !state.areTasksCarried) {
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

// A card border breathes while its agent is at work: Main through its open turn, or any running sub-agent.
export const isPulsing = (state: CrewState) =>
	state.agents[MAIN]?.status === 'running' || state.order.some(id => state.agents[id]?.status === 'running')

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
