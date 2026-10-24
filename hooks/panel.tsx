import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { MascotPrefs } from '../types'
import type { Species, SpriteCell } from './sprite'
import { barSvg, pipHeight, pipSvg, pipWidth } from './svg'
import { EMPTY_STATE } from './tracker'
import {
	MOVE_MS,
	motionView,
	panelView,
	pulseColor,
	toggleGroup,
	trackMoves,
	type Move,
	type Placement,
	type RowView,
	type Tone,
	type Trail
} from './view'

export const PANE = 'crew'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const groupOpen = atom({ plugin: 'crew', key: 'groupOpen' } as const, {} as Record<string, boolean>)
const mascots = atom({ plugin: 'crew', key: 'mascots' } as const, {} as MascotPrefs)
const isPaneShown = atom({ plugin: 'crew', key: 'isPaneShown' } as const, false)

const TONE: Record<Tone, string> = { running: 'claude', waiting: 'inactive', done: 'success', failed: 'error' }

const PIP_PX = 32
const PLANNED_PIP_PX = 16

const SPECIES_NAMES: Record<Species, string> = {
	pip: 'Pip',
	bolt: 'Bolt',
	mochi: 'Mochi',
	wisp: 'Wisp',
	sprout: 'Sprout',
	bloop: 'Bloop'
}
const BAR_PX = 6
// A card's frame, its padding, the 8-cell sprite and the gap after it, and the side column with the time and its
// mark (`12:34 ✗ stopped` at most) and the gap before it: what the terminal's text bar leaves to the rest.
const CARD_CHROME = 13
const SIDE_COLUMNS = 16

// Where each card sat at the last drawing and the moves still playing, kept in the module: a reload starts them
// over, which only skips a move. A drawing after a long gap (the pane was closed) starts afresh rather than
// playing every change it missed.
let placement: Placement = {}
let moves: Move[] = []
let drawnAt = 0
const STALE_MS = 2000

// While a move plays the ticker redraws every beat, so the slide steps along.
export const isMoving = (now: number) => moves.some(move => now - move.at < MOVE_MS)

// The note's grey fading out on a graphical surface; the terminal dims it instead.
const fadeColor = (fade: number) => `rgba(136,135,128,${Math.max(0, fade)})`

const cellProps = (cell: SpriteCell) => ({
	...(cell.fg ? { color: cell.fg } : {}),
	...(cell.bg ? { backgroundColor: cell.bg } : {})
})

const barAlt = (row: RowView) =>
	`${row.title} progress ${row.fraction === null ? 'working' : `${Math.round(row.fraction * 100)}%`}`

// Opens the Agents pane and notes whether a surface draws it, so the band can offer it back once it is closed.
export async function openPane($: EngineInterface) {
	const opened = await $.ui.open({ id: PANE, title: 'Agents' })
	await update($, isPaneShown, () => opened.isPlaced)
	return opened
}

// A reload can find the pane still up: the engine keeps its panes while the module starts over.
export async function syncPaneShown($: EngineInterface) {
	const panes = await $.ui.panes().catch(() => [])
	await update($, isPaneShown, () => panes.some(pane => pane.id === PANE && pane.isPlaced))
}

export function registerPanel(on: On) {
	on('ui.close', async ($, e, next) => {
		const closed = await next(e)
		// Gone with an unload, nothing is left to note it on.
		if (e.id === PANE && e.origin.kind !== 'unload') await update($, isPaneShown, () => false)
		return closed
	})

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const elements = $.ui.resolve(e)
		const { Box, Button, Text } = elements
		// Every surface but the terminal draws SVG; there the half-block text stands in.
		const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
		const state = await read($, model)
		const prefs = await read($, mascots)
		const open = await read($, groupOpen)
		const now = await $.clock.now()
		const barColumns = Math.max(8, e.props.bodyColumns - CARD_CHROME - SIDE_COLUMNS)
		const view = panelView(state, prefs, now, barColumns, open, { sprites: !Svg })
		if (now - drawnAt > STALE_MS) placement = {}
		;({ placement, moves } = trackMoves(view, placement, moves, now))
		drawnAt = now
		const motion = motionView(view, moves, now)

		const card = (label: string, value: string) => (
			// width 0 + flexGrow 1: the three cards start from nothing and grow to equal thirds of the pane.
			<Box key={`card-${label}`} flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1} width={0}>
				<Text dimColor size="caption">
					{label}
				</Text>
				<Text weight="semibold" tabular>
					{value}
				</Text>
			</Box>
		)

		const mascot = (row: RowView) =>
			Svg ? (
				<Svg
					source={pipSvg(row.role, prefs, PIP_PX, { species: row.species, body: row.accent, pose: row.pose })}
					alt={`${SPECIES_NAMES[row.species]} the ${row.role} mascot, ${row.pose}`}
					width={pipWidth(PIP_PX)}
					height={pipHeight(PIP_PX)}
					// A live frame while it runs (it hops) or sleeps (its zzz rises); every other pose is a still image.
					isInteractive={row.pose === 'running' || row.pose === 'paused'}
				/>
			) : (
				<Box flexDirection="column">
					{row.sprite.map(cells => (
						<Text mono>
							{cells.map(cell => (
								<Text mono {...cellProps(cell)}>
									{cell.ch}
								</Text>
							))}
						</Text>
					))}
				</Box>
			)

		const progress = (row: RowView) =>
			Svg ? (
				<Svg
					source={barSvg({
						fraction: row.fraction ?? 0,
						height: BAR_PX,
						color: row.accent,
						now,
						isShimmer: row.fraction === null
					})}
					alt={barAlt(row)}
					// No width: the drawing stretches to the text column, ending where the time's column begins.
					height={BAR_PX}
				/>
			) : (
				<Text color={row.accent} mono wrap="truncate-end">
					{row.bar}
				</Text>
			)

		const agentCard = (row: RowView) => {
			const arrival = motion.arrivals[row.id]
			// Just moved here: lit in its accent and sliding in from the right. Otherwise a running card's border breathes
			// in its accent, and every other card keeps the surface's own border.
			const border = arrival?.isLit
				? { borderColor: row.accent }
				: row.pulse === null
					? {}
					: { borderColor: pulseColor(row.accent, row.pulse, Svg ? 'graphical' : 'terminal') }
			return (
			<Box
				key={`row-${row.id}`}
				flexDirection="row"
				gap={1}
				borderStyle="round"
				{...border}
				paddingX={1}
				marginBottom={1}
				marginLeft={arrival?.slide ?? 0}
			>
				{mascot(row)}
				{/* width 0 + flexGrow 1: the text column takes what the mascot and the side column leave, and no more. */}
				<Box flexDirection="column" flexGrow={1} width={0}>
					<Box flexDirection="row" gap={1}>
						{/* The title gives way first; Main's waiting note keeps its width beside it. */}
						<Box flexShrink={1}>
							<Text weight="semibold" wrap="truncate-end">
								{row.title}
							</Text>
						</Box>
						{row.waiting && (
							<Box flexShrink={0}>
								<Text color={TONE[row.tone]}>{row.waiting}</Text>
							</Box>
						)}
					</Box>
					{/* One Text, so the whole line truncates as a unit instead of wrapping a piece into the next column. */}
					<Text dimColor wrap="truncate-end">
						{row.effort && (
							<Text {...(row.effortTone ? { color: row.effortTone } : {})}>{`${row.effort} · `}</Text>
						)}
						{`${row.model} · ${row.usageText}${row.aside ? ` · ${row.aside}` : ''}`}
					</Text>
					{row.steps && <Text wrap="truncate-end">{row.steps}</Text>}
					{progress(row)}
				</Box>
				{/* The time and its mark in a column of their own, so the text column (and the bar) end where it begins. */}
				<Box flexDirection="row" gap={1} flexShrink={0}>
					<Text dimColor tabular>
						{row.elapsed}
					</Text>
					{row.badge && <Text color={TONE[row.tone]}>{row.badge}</Text>}
				</Box>
			</Box>
		)
		}

		// Where a card left: its dot and where it went, drifting right a cell at a time as it fades.
		const trail = (note: Trail) => (
			<Box key={note.key} flexDirection="row" gap={1} marginLeft={note.drift} marginBottom={1}>
				<Text color={note.accent}>●</Text>
				<Text {...(Svg ? { color: fadeColor(note.fade) } : { dimColor: true })}>{`Moved to ${note.to}`}</Text>
			</Box>
		)

		// Each note goes where its card was, or at the end once the group has fewer cards than that.
		const withTrails = (cards: JSX.Element[], notes: Trail[]) => {
			const out = [...cards]
			for (const note of [...notes].sort((a, b) => a.index - b.index)) out.splice(Math.min(note.index, out.length), 0, trail(note))
			return out
		}

		return (
			<Box flexDirection="column">
				<Box flexDirection="row" gap={1} width="100%" marginBottom={1}>
					{card('Cost', view.cost)}
					{card('Tokens', view.tokens)}
					{card('Time', view.time)}
				</Box>
				<Text dimColor size="caption">
					{view.session}
				</Text>
				<Text> </Text>
				{view.main && agentCard(view.main)}
				{view.isEmpty && <Text dimColor>No sub-agents yet. They show up here as soon as one starts.</Text>}
				{motion.groups.map(group => (
					<Box key={`section-${group.name}`} flexDirection="column">
						{/* A group a move emptied keeps only its note, with no header to fold. */}
						{!group.isGhost && (
							<Button
								key={`group-${group.name}`}
								plain
								label={`${group.isCollapsed ? '▸' : '▾'} ${group.name} · ${group.count}`}
								onPress={() => toggle($, group.name)}
							/>
						)}
						{!group.isCollapsed && withTrails(group.rows.map(agentCard), group.trails)}
					</Box>
				))}
				{view.planned.length > 0 && (
					<Box key="section-Planned" flexDirection="column">
						<Button
							key="group-Planned"
							plain
							label={`${view.isPlannedCollapsed ? '▸' : '▾'} Planned · ${view.planned.length}`}
							onPress={() => toggle($, 'Planned')}
						/>
						{/* Main's steps not started yet: a faded Pip, the step as the plan numbers it, and a clock. */}
						{!view.isPlannedCollapsed &&
							view.planned.map(step => (
								<Box key={`planned-${step.number}`} flexDirection="row" gap={1} paddingX={1} alignItems="center">
									{Svg && (
										<Box alignSelf="center">
											<Svg
												source={pipSvg('plain', prefs, PLANNED_PIP_PX, { pose: 'stopped' })}
												alt="planned step"
												width={pipWidth(PLANNED_PIP_PX)}
												height={pipHeight(PLANNED_PIP_PX)}
											/>
										</Box>
									)}
									<Box flexGrow={1} flexShrink={1}>
										<Text dimColor wrap="truncate-end">
											{`${step.number}. ${step.title}`}
										</Text>
									</Box>
									<Text dimColor>◷</Text>
								</Box>
							))}
					</Box>
				)}
			</Box>
		)
	})
}

// Reads the model at the press, not the drawing's copy, so the default it flips is the one in force now.
async function toggle($: EngineInterface, name: string) {
	const state = await read($, model)
	await update($, groupOpen, value => toggleGroup(value ?? {}, name, state))
}
