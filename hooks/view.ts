import type { AgentRecord, CrewState, MascotPrefs, Role, Steps } from '../types'
import { bar, clamp, fmtDuration, fmtPercent, fmtTokens, fmtUsd, prettyModel, shimmer, truncate } from './format'
import { BUBBLE_MS, phraseFor } from './bubble'
import { estimateUsd } from './pricing'
import { taskProgress } from './tasks'
import { PALETTE, SPECIES_ORDER, spriteCells, type Pose, type Species, type SpriteCell } from './sprite'
import type { BubbleTone } from './svg'
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
	// Who is at work, beside the band's mini Pip: the running count, or `Main` while it works with no sub-agent.
	agentLabel: string
	tone: 'running' | 'done' | 'aborted'
}

export function bandLine(state: CrewState, progress: Progress, columns: number): BandLine {
	const pill = `${progress.source === 'tasks' ? 'Tasks' : 'Agents'} ${progress.done}/${progress.total}`
	const percent = fmtPercent(progress.fraction)
	const runningLabel = state.order.length > 0 ? `${selectRunning(state)} running` : ''
	const agentLabel = runningLabel || 'Main'
	// Segments: dot, label, bar, pill, percent, who is at work, hide button — one cell of gap between each.
	const segments = 7
	const fixed = 1 + pill.length + percent.length + agentLabel.length + 1 + (segments - 1)
	const barWidth = clamp(Math.floor((columns - fixed) / 3), 6, 24)
	// A label stored before envelopes were filtered can still start with `<`: never draw one.
	const stored = state.turn?.label ?? ''
	const label = truncate(stored && !stored.startsWith('<') ? stored : 'Working', Math.max(6, columns - fixed - barWidth))
	const filled = Math.round(clamp(progress.fraction, 0, 1) * barWidth)
	const tone = state.turn?.isAborted ? 'aborted' : state.turn?.endedAt ? 'done' : 'running'
	return {
		label,
		filled: '█'.repeat(filled),
		empty: '░'.repeat(barWidth - filled),
		pill,
		percent,
		runningLabel,
		agentLabel,
		tone
	}
}

export type Tone = 'running' | 'waiting' | 'done' | 'failed'

// One colour per sub-agent, the index taken once when it is first seen; Main wears Pip's own blue, never one of these.
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
	// Every note in one line; `badge`, `waiting` and `aside` are where the card draws it.
	note: string
	// The side column under the time: ✓, ✗ or `✗ stopped`, short enough that the column stays narrow.
	badge: string
	// Beside the title: Main's `waiting on N agents`, held to BADGE_MAX characters.
	waiting: string
	// Beside the model on line two: `stopped`, `↳ from <parent>`.
	aside: string
	bar: string
	// 0..1 for a bar drawn to scale, null for a running agent with no steps to count (a shimmer).
	fraction: number | null
	accent: string
	tone: Tone
	role: Role
	// The mascot: its species (in the slot of its accent) and its pose, which only moves while it runs.
	species: Species
	pose: Pose
	// The speech bubble over Pip: what it is doing while it runs, a phrase for a few seconds once it ends; '' for none.
	bubble: string
	bubbleTone: BubbleTone
	// How far a running card's border has breathed toward its accent, 0 to PULSE.strength; null when it does not run.
	pulse: number | null
	// How many files the agent touched, and whether the Files pane shows them: the card's chevron.
	fileCount: number
	isFilesShown: boolean
	sprite: SpriteCell[][]
}

export type GroupView = { name: string; count: number; rows: RowView[]; isCollapsed: boolean; isCollapsible: boolean }

// A step of Main's plan not started yet, numbered as the plan numbers it.
export type PlannedStep = { number: number; title: string }

export type PanelView = {
	cost: string
	tokens: string
	time: string
	session: string
	main: RowView | null
	groups: GroupView[]
	planned: PlannedStep[]
	isPlannedCollapsed: boolean
	isEmpty: boolean
}

function toneOf(agent: AgentRecord): Tone {
	if (agent.status === 'running') return 'running'
	if (agent.status === 'completed') return 'done'
	if (agent.status === 'failed' || agent.status === 'killed' || agent.status === 'stopped') return 'failed'
	return 'waiting'
}

const BADGE_MAX = 20

// What Main is still waiting on once its own turn has ended: sub-agents at work or queued, not idle ones.
const BUSY = new Set<AgentRecord['status']>(['running', 'pending', 'waiting'])

const selectBusy = (state: CrewState) => state.order.filter(id => BUSY.has(state.agents[id]?.status ?? 'completed')).length

// This prompt's own plan: one carried from an earlier prompt and not touched since is not shown.
const planOf = (state: CrewState) => (state.tasks.length > 0 && !state.areTasksCarried ? state.tasks : [])

// A sub-agent that finished cleanly did every step, though it often stops ticking them off before it ends.
// Main is left alone: its turn can end mid-plan while it waits on the person.
function finishedSteps(agent: AgentRecord, state: CrewState): Steps | undefined {
	if (agent.id === MAIN || agent.status !== 'completed' || !agent.steps) return agent.steps
	const list = state.agentTasks?.[agent.id] ?? []
	if (list.length === 0) return { ...agent.steps, done: agent.steps.total }
	return taskProgress(list.map(item => ({ ...item, status: 'completed' as const })))
}

function fractionOf(steps: Steps | undefined, tone: Tone, isMainWaiting: boolean): number | null {
	if (steps && steps.total > 0) return steps.done / steps.total
	if (tone === 'done' || tone === 'failed') return 1
	// Main waiting on its agents is still at work: it shimmers rather than sitting empty.
	if (tone === 'running' || isMainWaiting) return null
	return 0
}

// A record saved before colours were stored has no index: its place in the order stands in.
const slotOf = (agent: AgentRecord, state: CrewState) => agent.colorIndex ?? Math.max(0, state.order.indexOf(agent.id))

function accentOf(agent: AgentRecord, state: CrewState): string {
	if (agent.id === MAIN) return PALETTE.body
	return ACCENTS[slotOf(agent, state) % ACCENTS.length]
}

// The same slot as the colour, so a species and its colour travel together and neighbours never look alike.
const speciesOf = (agent: AgentRecord, state: CrewState): Species =>
	agent.id === MAIN ? 'pip' : SPECIES_ORDER[slotOf(agent, state) % SPECIES_ORDER.length]

// A running card's border breathes: a two-second cycle, at its peak a little over halfway from rest to the accent.
export const PULSE = { cycleMs: 2000, strength: 0.55 }

const pulseAt = (now: number) => ((1 - Math.cos((2 * Math.PI * now) / PULSE.cycleMs)) / 2) * PULSE.strength

// The terminal's border at rest, which the pulse blends from: the graphical surfaces fade the accent in instead.
const TERMINAL_REST = [0x5f, 0x5e, 0x5a]
const GRAPHICAL_REST_ALPHA = 0.2

export function pulseColor(accent: string, pulse: number, surface: 'graphical' | 'terminal'): string {
	const channels = [1, 3, 5].map(at => parseInt(accent.slice(at, at + 2), 16))
	if (surface === 'graphical') {
		// The accent's own opacity, so the border sits on a light or a dark card alike.
		const alpha = Math.round((GRAPHICAL_REST_ALPHA + pulse) * 100) / 100
		return `rgba(${channels.join(',')},${alpha})`
	}
	const blend = channels.map((value, i) => Math.round(TERMINAL_REST[i] + (value - TERMINAL_REST[i]) * pulse))
	return '#' + blend.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()
}

const POSES: Record<Tone, Pose> = { running: 'running', waiting: 'paused', done: 'still', failed: 'stopped' }

export type PanelOptions = { sprites?: boolean; filesFor?: string | null }

// What Pip says: its latest action while it runs, a phrase for BUBBLE_MS once it ends, nothing while it waits (its zzz speaks for it).
function bubbleOf(
	agent: AgentRecord,
	tone: Tone,
	endedAt: number | undefined,
	now: number,
	phraseKey: string
): { text: string; tone: BubbleTone } {
	if (tone === 'running') return { text: agent.action ?? '', tone: 'running' }
	const age = endedAt === undefined ? -1 : now - endedAt
	const isFresh = age >= 0 && age < BUBBLE_MS
	if (isFresh && tone === 'done') return { text: phraseFor(phraseKey, 'done'), tone: 'done' }
	if (isFresh && tone === 'failed') return { text: phraseFor(phraseKey, 'stopped'), tone: 'stopped' }
	return { text: '', tone: 'running' }
}

function rowView(
	agent: AgentRecord,
	state: CrewState,
	prefs: MascotPrefs,
	now: number,
	barWidth: number,
	options: PanelOptions
): RowView {
	const busy = agent.id === MAIN ? selectBusy(state) : 0
	// Main's own turn has ended but its agents still work: it is waiting on them, not done.
	const isMainWaiting = agent.id === MAIN && agent.status === 'completed' && busy > 0
	const tone = isMainWaiting ? 'waiting' : toneOf(agent)
	const tokens = totalTokens(agent.usage)
	const cost = tokens > 0 ? estimateUsd(agent.usage, agent.model ?? '') : 0
	const startedAt = agent.id === MAIN ? (state.turn?.startedAt ?? agent.spawnedAt) : agent.spawnedAt
	const endedAt = agent.id === MAIN ? (state.turn?.endedAt ?? agent.endedAt) : agent.endedAt
	// Main is the planner: its steps are the plan it keeps, when it keeps one this prompt.
	const plan = agent.id === MAIN ? planOf(state) : []
	const steps = plan.length > 0 ? taskProgress(plan) : finishedSteps(agent, state)
	const parent = agent.parentId ? state.agents[agent.parentId] : undefined
	const waitingNote = isMainWaiting ? `waiting on ${busy} agent${busy === 1 ? '' : 's'}` : ''
	const asides = [parent ? `↳ from ${parent.description}` : ''].filter(Boolean)
	const mark = tone === 'done' ? '✓' : tone === 'failed' ? '✗' : ''
	// "stopped" rides in the ✗ badge, one short unit on line 1 that keeps its width and never wraps away.
	const markBadge = agent.status === 'stopped' && !isMainWaiting ? `${mark} stopped` : mark
	const fraction = fractionOf(steps, tone, isMainWaiting)
	const model = prettyModel(agent.model)
	const usageText = [`ctx ${fmtPercent(contextFraction(agent))}`, fmtTokens(tokens), fmtUsd(cost)].join(' · ')
	const elapsed = fmtDuration((endedAt ?? now) - startedAt)
	const accent = accentOf(agent, state)
	const species = speciesOf(agent, state)
	const pose = POSES[tone]
	const bubble = bubbleOf(agent, tone, endedAt, now, agent.id === MAIN ? (state.turn?.id ?? MAIN) : agent.id)
	return {
		id: agent.id,
		title: agent.description,
		mark,
		meta: [agent.effort, model].filter(Boolean).join(' · '),
		effort: agent.effort ?? '',
		effortTone: effortToneOf(agent.effort),
		model,
		stats: `${usageText} · ${elapsed}`,
		usageText,
		elapsed,
		steps: steps ? `${steps.done}/${steps.total}${steps.current ? ` · ${steps.current}` : ''}` : '',
		note: isMainWaiting ? waitingNote : [...asides, agent.status === 'stopped' ? 'stopped' : ''].filter(Boolean).join(' · '),
		badge: markBadge,
		waiting: truncate(waitingNote, BADGE_MAX),
		aside: isMainWaiting ? '' : asides.join(' · '),
		bar: fraction === null ? shimmer(barWidth, now) : bar(fraction, barWidth),
		fraction,
		accent,
		tone,
		role: agent.role,
		species,
		pose,
		bubble: bubble.text,
		bubbleTone: bubble.tone,
		pulse: tone === 'running' ? pulseAt(now) : null,
		// `?.`: a model saved before files were tracked has no `files` until its next event.
		fileCount: state.files?.[agent.id]?.length ?? 0,
		isFilesShown: options.filesFor === agent.id,
		// The terminal redraws each second while anything runs: the second's parity is a running mascot's beat.
		sprite:
			options.sprites === false
				? []
				: spriteCells(agent.role, prefs, { species, body: accent, pose, frame: Math.floor(now / 1000) % 2 })
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
	groupOpen: Record<string, boolean>,
	// `sprites: false` where the surface draws Pip as SVG: the half-block cells would go unused.
	options: PanelOptions = {}
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
		main: state.agents[MAIN] ? rowView(state.agents[MAIN], state, prefs, now, barWidth, options) : null,
		groups: named
			.filter(([, agents]) => agents.length > 0)
			.map(([name, agents]) => ({
				name,
				count: agents.length,
				rows: agents.map(agent => rowView(agent, state, prefs, now, barWidth, options)),
				isCollapsed: !(groupOpen[name] ?? isOpenByDefault(name, state)),
				isCollapsible: true
			})),
		planned: planOf(state).flatMap((task, index) =>
			task.status === 'pending' ? [{ number: index + 1, title: task.title }] : []
		),
		isPlannedCollapsed: !(groupOpen.Planned ?? true),
		isEmpty: state.order.length === 0
	}
}

// An agent's card changing group plays a move: it lands in its new group at once, sliding in from the right with its
// border lit in its colour, and a one-line note drifts off and fades where it was. The surface has no transitions,
// so the slide is stepped, one cell a frame, at the redraw rate the ticker keeps up while a move plays.
export const MOVE_MS = 1400
const SLIDE_CELLS = [3, 2, 1]
const FRAME_MS = 100
const DRIFT_MS = 350
const GROUP_ORDER = ['Running', 'Waiting', 'Finished', 'Failed']

export type Move = { id: string; title: string; accent: string; from: string; to: string; index: number; at: number }
export type Placement = Record<string, { group: string; index: number }>
export type Trail = { key: string; accent: string; to: string; index: number; drift: number; fade: number }
export type MotionGroup = GroupView & { trails: Trail[]; isGhost?: boolean }
export type MotionView = { groups: MotionGroup[]; arrivals: Record<string, { slide: number; isLit: boolean }> }

const isPlaying = (move: Move, now: number) => now - move.at < MOVE_MS

// Where each card sits now against where it sat at the last drawing: one seen in another group is a move. A card
// seen for the first time is not; a later move of the same card replaces the one still playing.
export function trackMoves(
	view: Pick<PanelView, 'groups'>,
	last: Placement,
	moves: readonly Move[],
	now: number
): { placement: Placement; moves: Move[] } {
	const placement: Placement = {}
	const started: Move[] = []
	for (const group of view.groups) {
		group.rows.forEach((row, index) => {
			placement[row.id] = { group: group.name, index }
			const before = last[row.id]
			if (before && before.group !== group.name) {
				started.push({ id: row.id, title: row.title, accent: row.accent, from: before.group, to: group.name, index: before.index, at: now })
			}
		})
	}
	const restarted = new Set(started.map(move => move.id))
	return { placement, moves: [...moves.filter(move => isPlaying(move, now) && !restarted.has(move.id)), ...started] }
}

// The groups as drawn mid-move: each with the notes left in it, plus a ghost for a group the move emptied, in that
// group's place, so its note still shows where the card was; and how each arriving card is drawn.
export function motionView(view: Pick<PanelView, 'groups'>, moves: readonly Move[], now: number): MotionView {
	const playing = moves.filter(move => isPlaying(move, now))
	const groups: MotionGroup[] = view.groups.map(group => ({ ...group, trails: [] }))
	for (const move of playing) {
		let from = groups.find(group => group.name === move.from)
		if (!from) {
			from = { name: move.from, count: 0, rows: [], isCollapsed: false, isCollapsible: false, trails: [], isGhost: true }
			const rank = GROUP_ORDER.indexOf(move.from)
			const at = groups.findIndex(group => GROUP_ORDER.indexOf(group.name) > rank)
			groups.splice(at < 0 ? groups.length : at, 0, from)
		}
		const elapsed = now - move.at
		from.trails.push({
			key: `trail-${move.id}`,
			accent: move.accent,
			to: move.to,
			index: move.index,
			drift: Math.floor(elapsed / DRIFT_MS),
			fade: Math.round((1 - elapsed / MOVE_MS) * 100) / 100
		})
	}
	const arrivals: MotionView['arrivals'] = {}
	for (const move of playing) arrivals[move.id] = { slide: SLIDE_CELLS[Math.floor((now - move.at) / FRAME_MS)] ?? 0, isLit: true }
	return { groups, arrivals }
}
