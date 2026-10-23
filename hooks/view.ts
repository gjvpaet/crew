import type { AgentRecord, CrewState, MascotPrefs, Role } from '../types'
import { bar, clamp, fmtDuration, fmtPercent, fmtTokens, fmtUsd, prettyModel, shimmer, truncate } from './format'
import { estimateUsd } from './pricing'
import { spriteCells, type SpriteCell } from './sprite'
import {
	MAIN,
	contextFraction,
	selectGroups,
	selectRunning,
	selectSessionTotals,
	selectTurnTotals,
	totalTokens,
	type Progress
} from './tracker'

export const COLLAPSE_AFTER = 8

export type BandLine = {
	label: string
	filled: string
	empty: string
	pill: string
	percent: string
	// '' when the turn has no sub-agents, so the band leaves the count out.
	runningLabel: string
	tone: 'running' | 'done' | 'aborted'
}

export function bandLine(state: CrewState, progress: Progress, columns: number): BandLine {
	const pill = `${progress.source === 'tasks' ? 'Tasks' : 'Agents'} ${progress.done}/${progress.total}`
	const percent = fmtPercent(progress.fraction)
	const runningLabel = state.order.length > 0 ? `${selectRunning(state)} running` : ''
	// Segments: dot, label, bar, pill, percent, [running], hide button — one cell of gap between each.
	const segments = runningLabel ? 7 : 6
	const fixed = 1 + pill.length + percent.length + runningLabel.length + 1 + (segments - 1)
	const barWidth = clamp(Math.floor((columns - fixed) / 3), 6, 24)
	const label = truncate(state.turn?.label || 'Working', Math.max(6, columns - fixed - barWidth))
	const filled = Math.round(clamp(progress.fraction, 0, 1) * barWidth)
	const tone = state.turn?.isAborted ? 'aborted' : state.turn?.endedAt ? 'done' : 'running'
	return { label, filled: '█'.repeat(filled), empty: '░'.repeat(barWidth - filled), pill, percent, runningLabel, tone }
}

export type Tone = 'running' | 'waiting' | 'done' | 'failed'

// One colour per sub-agent, by its place in the spawn order; Main wears the first.
export const ACCENTS = ['#1D9E75', '#7F77DD', '#D85A30', '#378ADD', '#D4537E', '#BA7517']

export type EffortTone = 'success' | 'suggestion' | 'warning' | 'error'

const EFFORT_TONES: Record<string, EffortTone> = {
	low: 'success',
	medium: 'suggestion',
	high: 'warning',
	xhigh: 'error',
	max: 'error'
}

export const effortToneOf = (effort: string | undefined): EffortTone | undefined =>
	effort && Object.prototype.hasOwnProperty.call(EFFORT_TONES, effort) ? EFFORT_TONES[effort] : undefined

export type RowView = {
	id: string
	title: string
	mark: string
	// `effort · model`, kept whole for readers that draw it in one style.
	meta: string
	effort: string
	effortTone: EffortTone | undefined
	model: string
	// `ctx · tokens · cost · elapsed`; `usageText` and `elapsed` are its two halves.
	stats: string
	usageText: string
	elapsed: string
	steps: string
	note: string
	bar: string
	// 0..1 for a bar drawn to scale, null for a running agent with no steps to count (a shimmer).
	fraction: number | null
	accent: string
	tone: Tone
	role: Role
	sprite: SpriteCell[][]
}

export type GroupView = { name: string; count: number; rows: RowView[]; isCollapsed: boolean; isCollapsible: boolean }

export type PanelView = {
	cost: string
	tokens: string
	time: string
	session: string
	main: RowView | null
	groups: GroupView[]
	isEmpty: boolean
}

function toneOf(agent: AgentRecord): Tone {
	if (agent.status === 'running') return 'running'
	if (agent.status === 'completed') return 'done'
	if (agent.status === 'failed' || agent.status === 'killed' || agent.status === 'stopped') return 'failed'
	return 'waiting'
}

function fractionOf(agent: AgentRecord, tone: Tone): number | null {
	const steps = agent.steps
	if (steps && steps.total > 0) return steps.done / steps.total
	if (tone === 'done' || tone === 'failed') return 1
	if (tone === 'running') return null
	return 0
}

const accentOf = (agent: AgentRecord, state: CrewState) =>
	agent.id === MAIN ? ACCENTS[0] : ACCENTS[Math.max(0, state.order.indexOf(agent.id)) % ACCENTS.length]

function rowView(agent: AgentRecord, state: CrewState, prefs: MascotPrefs, now: number, barWidth: number): RowView {
	const running = agent.id === MAIN ? selectRunning(state) : 0
	// Main's own turn has ended but its agents still work: it is waiting on them, not done.
	const isMainWaiting = agent.id === MAIN && agent.status === 'completed' && running > 0
	const tone = isMainWaiting ? 'waiting' : toneOf(agent)
	const tokens = totalTokens(agent.usage)
	const cost = tokens > 0 ? estimateUsd(agent.usage, agent.model ?? '') : 0
	const startedAt = agent.id === MAIN ? (state.turn?.startedAt ?? agent.spawnedAt) : agent.spawnedAt
	const endedAt = agent.id === MAIN ? (state.turn?.endedAt ?? agent.endedAt) : agent.endedAt
	const steps = agent.steps
	const parent = agent.parentId ? state.agents[agent.parentId] : undefined
	const notes = isMainWaiting
		? [`waiting on ${running} agent${running === 1 ? '' : 's'}`]
		: [parent ? `↳ from ${parent.description}` : '', agent.status === 'stopped' ? 'stopped' : ''].filter(Boolean)
	const fraction = fractionOf(agent, tone)
	const model = prettyModel(agent.model)
	const usageText = [`ctx ${fmtPercent(contextFraction(agent))}`, fmtTokens(tokens), fmtUsd(cost)].join(' · ')
	const elapsed = fmtDuration((endedAt ?? now) - startedAt)
	return {
		id: agent.id,
		title: agent.description,
		mark: tone === 'done' ? '✓' : tone === 'failed' ? '✗' : '',
		meta: [agent.effort, model].filter(Boolean).join(' · '),
		effort: agent.effort ?? '',
		effortTone: effortToneOf(agent.effort),
		model,
		stats: `${usageText} · ${elapsed}`,
		usageText,
		elapsed,
		steps: steps ? `${steps.done}/${steps.total}${steps.current ? ` · ${steps.current}` : ''}` : '',
		note: notes.join(' · '),
		bar: fraction === null ? shimmer(barWidth, now) : bar(fraction, barWidth),
		fraction,
		accent: accentOf(agent, state),
		tone,
		role: agent.role,
		sprite: spriteCells(agent.role, prefs)
	}
}

// Every group starts open but Finished, which folds away once the list is long.
const isOpenByDefault = (name: string, state: CrewState) => !(name === 'Finished' && state.order.length > COLLAPSE_AFTER)

// The override a press on a group's header writes, from the state at the press: open what is collapsed, and back.
export const toggleGroup = (groupOpen: Record<string, boolean>, name: string, state: CrewState) => ({
	...groupOpen,
	[name]: !(groupOpen[name] ?? isOpenByDefault(name, state))
})

export function panelView(
	state: CrewState,
	prefs: MascotPrefs,
	now: number,
	barWidth: number,
	groupOpen: Record<string, boolean>
): PanelView {
	const turn = selectTurnTotals(state)
	const session = selectSessionTotals(state)
	const groups = selectGroups(state)
	const named: Array<[string, AgentRecord[]]> = [
		['Running', groups.running],
		['Waiting', groups.waiting],
		['Finished', groups.finished],
		['Failed', groups.failed]
	]
	return {
		cost: `${fmtUsd(turn.costUsd)}${turn.isPartial ? '+' : ''}`,
		tokens: fmtTokens(turn.tokens),
		time: state.turn ? fmtDuration((state.turn.endedAt ?? now) - state.turn.startedAt) : '0:00',
		session: `Session ${fmtUsd(session.costUsd)}${session.isPartial ? '+' : ''} · ${fmtTokens(session.tokens)} tokens`,
		main: state.agents[MAIN] ? rowView(state.agents[MAIN], state, prefs, now, barWidth) : null,
		groups: named
			.filter(([, agents]) => agents.length > 0)
			.map(([name, agents]) => ({
				name,
				count: agents.length,
				rows: agents.map(agent => rowView(agent, state, prefs, now, barWidth)),
				isCollapsed: !(groupOpen[name] ?? isOpenByDefault(name, state)),
				isCollapsible: true
			})),
		isEmpty: state.order.length === 0
	}
}
