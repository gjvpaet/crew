import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { MascotPrefs } from '../types'
import { clamp } from './format'
import type { Species, SpriteCell } from './sprite'
import { barSvg, pipHeight, pipSvg, pipWidth } from './svg'
import { EMPTY_STATE } from './tracker'
import { panelView, toggleGroup, type RowView, type Tone } from './view'

export const PANE = 'crew'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const groupOpen = atom({ plugin: 'crew', key: 'groupOpen' } as const, {} as Record<string, boolean>)
const mascots = atom({ plugin: 'crew', key: 'mascots' } as const, {} as MascotPrefs)

const TONE: Record<Tone, string> = { running: 'claude', waiting: 'inactive', done: 'success', failed: 'error' }

const PIP_PX = 32

const SPECIES_NAMES: Record<Species, string> = {
	pip: 'Pip',
	bolt: 'Bolt',
	mochi: 'Mochi',
	wisp: 'Wisp',
	sprout: 'Sprout',
	bloop: 'Bloop'
}
const BAR_PX = 6
// A card's frame, its padding, the 8-cell sprite and the gap after it: what the text bar leaves to the rest.
const CARD_CHROME = 13

const cellProps = (cell: SpriteCell) => ({
	...(cell.fg ? { color: cell.fg } : {}),
	...(cell.bg ? { backgroundColor: cell.bg } : {})
})

const barAlt = (row: RowView) =>
	`${row.title} progress ${row.fraction === null ? 'working' : `${Math.round(row.fraction * 100)}%`}`

export function registerPanel(on: On) {
	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const elements = $.ui.resolve(e)
		const { Box, Button, Text } = elements
		// Every surface but the terminal draws SVG; there the half-block text stands in.
		const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
		const state = await read($, model)
		const prefs = await read($, mascots)
		const open = await read($, groupOpen)
		const now = await $.clock.now()
		const barColumns = Math.max(8, e.props.bodyColumns - CARD_CHROME)
		const barPx = clamp(barColumns * 7, 120, 320)
		const view = panelView(state, prefs, now, barColumns, open, { sprites: !Svg })

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
						width: barPx,
						height: BAR_PX,
						color: row.accent,
						now,
						isShimmer: row.fraction === null
					})}
					alt={barAlt(row)}
					width={barPx}
					height={BAR_PX}
				/>
			) : (
				<Text color={row.accent} mono>
					{row.bar}
				</Text>
			)

		const agentCard = (row: RowView) => (
			<Box key={`row-${row.id}`} flexDirection="row" gap={1} borderStyle="round" paddingX={1} marginBottom={1}>
				{mascot(row)}
				<Box flexDirection="column" flexGrow={1}>
					<Box flexDirection="row" justifyContent="space-between" gap={1}>
						{/* The title gives way first; the time and the badge keep their width in a narrow pane. */}
						<Box flexShrink={1}>
							<Text weight="semibold" wrap="truncate-end">
								{row.title}
							</Text>
						</Box>
						<Box flexDirection="row" gap={1} flexShrink={0}>
							<Text dimColor tabular>
								{row.elapsed}
							</Text>
							{row.badge && (
								<Text color={TONE[row.tone]} wrap="truncate-end">
									{row.badge}
								</Text>
							)}
						</Box>
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
			</Box>
		)

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
				{view.groups.map(group => (
					<Box key={`section-${group.name}`} flexDirection="column">
						<Button
							key={`group-${group.name}`}
							plain
							label={`${group.isCollapsed ? '▸' : '▾'} ${group.name} · ${group.count}`}
							onPress={() => toggle($, group.name)}
						/>
						{!group.isCollapsed && group.rows.map(agentCard)}
					</Box>
				))}
			</Box>
		)
	})
}

// Reads the model at the press, not the drawing's copy, so the default it flips is the one in force now.
async function toggle($: EngineInterface, name: string) {
	const state = await read($, model)
	await update($, groupOpen, value => toggleGroup(value ?? {}, name, state))
}
