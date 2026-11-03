import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { MascotPrefs } from '../types'
import { clipName } from './files'
import { showFiles } from './files-pane'
import type { Species, SpriteCell } from './sprite'
import { barSvg, bubbleSvg, pipHeight, pipSvg, pipWidth } from './svg'
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
const filesFor = atom({ plugin: 'crew', key: 'filesFor' } as const, null as string | null)

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
// Desktop drops a whole drawing past 2,000 nodes, 32 levels or 262,144 characters (text, props and every Svg source
// together), and the pane is left reading "Nothing to show yet". A card is about 10 KB of SVG, so a few dozen agents
// in an open group would cross it. Cards are drawn in full while the drawing stays inside this budget, well under
// those limits; past it an agent is a one-line row, and past the nodes a count. Cards stop at a lower ceiling than
// lines, so the lines that follow them always have room. Rough per-element costs for the parts of a card that are
// not its SVG sources (text, props, the Boxes around them).
const DRAW_BUDGET = { cardChars: 180_000, chars: 230_000, nodes: 1_600 }
const COST = {
	header: { chars: 3_000, nodes: 40 },
	card: { chars: 900, nodes: 30 },
	line: { chars: 200, nodes: 10 },
	planned: { chars: 300, nodes: 8 },
	group: { chars: 120, nodes: 4 },
	bubble: { nodes: 3 }
}
// Past this many letters a bubble's drawing is shortened in the middle; its alt keeps the whole text.
const BUBBLE_LETTERS = 28
// Past this many, cards drop their bubble: a few hundred would push the terminal past its 20,000-node ceiling.
const MAX_BUBBLES = 24
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

// The chevron that opens an agent's files: bright while the Files pane shows that agent, dimmed otherwise.
const chevronProps = (row: RowView) => ({
	plain: true,
	...(row.isFilesShown ? {} : { dimColor: true }),
	label: `${row.isFilesShown ? '▾' : '▸'} ${row.fileCount}`
})

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
		const shownFiles = await read($, filesFor)
		const now = await $.clock.now()
		const barColumns = Math.max(8, e.props.bodyColumns - CARD_CHROME - SIDE_COLUMNS)
		const view = panelView(state, prefs, now, barColumns, open, { sprites: !Svg, filesFor: shownFiles })
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

		// Each card's two SVG sources, made once a drawing: they are what the budget is mostly spent on.
		const sources = new Map<string, { mascot: string; bar: string }>()
		const sourcesOf = (row: RowView) => {
			const known = sources.get(row.id)
			if (known) return known
			const made = {
				mascot: pipSvg(row.role, prefs, PIP_PX, { species: row.species, body: row.accent, pose: row.pose }),
				bar: barSvg({ fraction: row.fraction ?? 0, height: BAR_PX, color: row.accent, now, isShimmer: row.fraction === null })
			}
			sources.set(row.id, made)
			return made
		}

		const mascot = (row: RowView) =>
			Svg ? (
				<Svg
					source={sourcesOf(row).mascot}
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
					source={sourcesOf(row).bar}
					alt={barAlt(row)}
					// No width: the drawing stretches to the text column, ending where the time's column begins.
					height={BAR_PX}
				/>
			) : (
				<Text color={row.accent} mono wrap="truncate-end">
					{row.bar}
				</Text>
			)

		// The bubble over Pip: an SVG where the surface draws one, a dim line in the terminal.
		const bubbleArt = (row: RowView) =>
			Svg && row.bubble ? bubbleSvg(clipName(row.bubble, BUBBLE_LETTERS), row.bubbleTone) : undefined
		const bubbleRow = (row: RowView) => {
			const art = bubbleArt(row)
			return (
				<Box key={`bubble-${row.id}`} flexDirection="row">
					{art && Svg ? (
						<Svg source={art.source} alt={row.bubble} width={art.width} height={art.height} />
					) : (
						<Text wrap="truncate-end" {...(row.bubbleTone === 'done' ? { color: TONE.done } : { dimColor: true })}>
							{`▸ ${row.bubble}`}
						</Text>
					)}
				</Box>
			)
		}

		const agentCard = (row: RowView) => {
			const arrival = motion.arrivals[row.id]
			// Just moved here: lit in its accent and sliding in from the right. Otherwise a running card's border breathes
			// in its accent, and every other card keeps the surface's own border.
			const border = arrival?.isLit
				? { borderColor: row.accent }
				: row.pulse === null
					? {}
					: { borderColor: pulseColor(row.accent, row.pulse, Svg ? 'graphical' : 'terminal') }
			const frame = { borderStyle: 'round', ...border, paddingX: 1, marginBottom: 1, marginLeft: arrival?.slide ?? 0 } as const
			const parts = [
				mascot(row),
				// width 0 + flexGrow 1: the text column takes what the mascot and the side column leave, and no more.
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
						{/* The spacer pushes the chevron to the row's right end, past the waiting note. */}
						{row.fileCount > 0 && <Box flexGrow={1} />}
						{row.fileCount > 0 && (
							<Box flexShrink={0}>
								<Button key={`files-${row.id}`} {...chevronProps(row)} onPress={() => showFiles($, row.id)} />
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
				</Box>,
				// The time and its mark in a column of their own, so the text column (and the bar) end where it begins.
				<Box flexDirection="row" gap={1} flexShrink={0}>
					<Text dimColor tabular>
						{row.elapsed}
					</Text>
					{row.badge && <Text color={TONE[row.tone]}>{row.badge}</Text>}
				</Box>
			]
			// With a bubble the card stacks it over its usual row, so it sits on Pip's head; without one it is that row.
			return row.bubble ? (
				<Box key={`row-${row.id}`} flexDirection="column" {...frame}>
					{bubbleRow(row)}
					<Box flexDirection="row" gap={1}>
						{parts[0]}
						{parts[1]}
						{parts[2]}
					</Box>
				</Box>
			) : (
				<Box key={`row-${row.id}`} flexDirection="row" gap={1} {...frame}>
					{parts[0]}
					{parts[1]}
					{parts[2]}
				</Box>
			)
		}

		// One line in place of a card once the budget is spent: the agent's colour, title, time and mark.
		const lineRow = (row: RowView) => (
			<Box key={`row-${row.id}`} flexDirection="row" gap={1} paddingX={1}>
				<Text color={row.accent}>●</Text>
				<Box flexGrow={1} width={0}>
					<Text wrap="truncate-end">{row.title}</Text>
				</Box>
				{row.fileCount > 0 && (
					<Button key={`files-${row.id}`} {...chevronProps(row)} onPress={() => showFiles($, row.id)} />
				)}
				<Text dimColor tabular>
					{row.elapsed}
				</Text>
				{row.badge && <Text color={TONE[row.tone]}>{row.badge}</Text>}
			</Box>
		)

		// What the drawing has spent of the budget so far, in the order it is laid out. The terminal has no such
		// limit, so only a surface drawing SVG is held to it.
		type Cost = { chars: number; nodes: number }
		const spent: Cost = { ...COST.header }
		let bubbles = 0
		const spend = (cost: Cost, ceiling = DRAW_BUDGET.chars) => {
			const fits = !Svg || (spent.chars + cost.chars <= ceiling && spent.nodes + cost.nodes <= DRAW_BUDGET.nodes)
			if (fits) Object.assign(spent, { chars: spent.chars + cost.chars, nodes: spent.nodes + cost.nodes })
			return fits
		}
		const cardCost = (row: RowView): Cost => {
			const svg = Svg ? sourcesOf(row) : { mascot: '', bar: '' }
			const text = row.title.length + row.steps.length + row.usageText.length
			const bubble = bubbleArt(row)
			return {
				chars:
					COST.card.chars + svg.mascot.length + svg.bar.length + text + (bubble ? bubble.source.length + row.bubble.length : 0),
				nodes: COST.card.nodes + (row.bubble ? COST.bubble.nodes : 0)
			}
		}
		// A card while it fits, a line once it does not, and nothing once even a line does not.
		const drawRow = (full: RowView) => {
			// Main's card is drawn outside this, so its bubble is never dropped and not counted.
			const row = full.bubble && bubbles >= MAX_BUBBLES ? { ...full, bubble: '' } : full
			if (spend(cardCost(row), DRAW_BUDGET.cardChars)) {
				if (row.bubble) bubbles++
				return agentCard(row)
			}
			return spend({ chars: COST.line.chars + row.title.length, nodes: COST.line.nodes }) ? lineRow(row) : null
		}
		// A group's rows as the budget allows, with a count of any it had to leave out.
		const groupRows = (name: string, rows: RowView[]) => {
			spend(COST.group)
			const drawn = rows.map(drawRow)
			const shown = drawn.filter((row): row is JSX.Element => row !== null)
			const left = drawn.length - shown.length
			if (left === 0) return shown
			return [
				...shown,
				<Box key={`more-${name}`} paddingX={1}>
					<Text dimColor>{`+ ${left} more`}</Text>
				</Box>
			]
		}
		const plannedPip = Svg ? pipSvg('plain', prefs, PLANNED_PIP_PX, { pose: 'stopped' }) : ''

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
				{/* Main always draws in full, first: the budget is spent in the order the pane is laid out. */}
				{view.main && (spend(cardCost(view.main)), agentCard(view.main))}
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
						{!group.isCollapsed && withTrails(groupRows(group.name, group.rows), group.trails)}
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
									{/* Its little Pip while the budget allows; past it, the step alone. */}
									{Svg && spend({ chars: COST.planned.chars + plannedPip.length + step.title.length, nodes: COST.planned.nodes }, DRAW_BUDGET.cardChars) && (
										<Box alignSelf="center">
											<Svg
												source={plannedPip}
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
