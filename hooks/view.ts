import type { AgentRecord, CrewState, MascotPrefs } from '../types'
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

export type RowView = {
	id: string
	title: string
	mark: string
	meta: string
	stats: string
	steps: string
	note: string
	bar: string
	tone: Tone
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

function rowView(agent: AgentRecord, state: CrewState, prefs: MascotPrefs, now: number, barWidth: number): RowView {
	const tone = toneOf(agent)
	const tokens = totalTokens(agent.usage)
	const cost = tokens > 0 ? estimateUsd(agent.usage, agent.model ?? '') : 0
	const startedAt = agent.id === MAIN ? (state.turn?.startedAt ?? agent.spawnedAt) : agent.spawnedAt
	const endedAt = agent.id === MAIN ? (state.turn?.endedAt ?? agent.endedAt) : agent.endedAt
	const steps = agent.steps
	const parent = agent.parentId ? state.agents[agent.parentId] : undefined
	const notes = [parent ? `↳ from ${parent.description}` : '', agent.status === 'stopped' ? 'stopped' : ''].filter(Boolean)
	let progressBar = bar(0, barWidth)
	if (steps && steps.total > 0) progressBar = bar(steps.done / steps.total, barWidth)
	else if (tone === 'running') progressBar = shimmer(barWidth, now)
	else if (tone === 'done' || tone === 'failed') progressBar = bar(1, barWidth)
	return {
		id: agent.id,
		title: agent.description,
		mark: tone === 'done' ? '✓' : tone === 'failed' ? '✗' : '',
		meta: [agent.effort, prettyModel(agent.model)].filter(Boolean).join(' · '),
		stats: [
			`ctx ${fmtPercent(contextFraction(agent))}`,
			fmtTokens(tokens),
			fmtUsd(cost),
			fmtDuration((endedAt ?? now) - startedAt)
		].join(' · '),
		steps: steps ? `${steps.done}/${steps.total}${steps.current ? ` · ${steps.current}` : ''}` : '',
		note: notes.join(' · '),
		bar: progressBar,
		tone,
		sprite: spriteCells(agent.role, prefs)
	}
}

export function panelView(
	state: CrewState,
	prefs: MascotPrefs,
	now: number,
	barWidth: number,
	isFinishedOpen: boolean
): PanelView {
	const turn = selectTurnTotals(state)
	const session = selectSessionTotals(state)
	const groups = selectGroups(state)
	const isCollapsible = state.order.length > COLLAPSE_AFTER
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
			.map(([name, agents]) => {
				const isFinished = name === 'Finished'
				return {
					name,
					count: agents.length,
					rows: agents.map(agent => rowView(agent, state, prefs, now, barWidth)),
					isCollapsed: isFinished && isCollapsible && !isFinishedOpen,
					isCollapsible: isFinished && isCollapsible
				}
			}),
		isEmpty: state.order.length === 0
	}
}
