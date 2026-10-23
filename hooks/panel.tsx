import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { MascotPrefs } from '../types'
import type { SpriteCell } from './sprite'
import { EMPTY_STATE } from './tracker'
import { panelView, type RowView, type Tone } from './view'

export const PANE = 'crew'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const isFinishedOpen = atom({ plugin: 'crew', key: 'isFinishedOpen' } as const, false)
const mascots = atom({ plugin: 'crew', key: 'mascots' } as const, {} as MascotPrefs)

const TONE: Record<Tone, string> = { running: 'claude', waiting: 'inactive', done: 'success', failed: 'error' }

const cellProps = (cell: SpriteCell) => ({
	...(cell.fg ? { color: cell.fg } : {}),
	...(cell.bg ? { backgroundColor: cell.bg } : {})
})

export function registerPanel(on: On) {
	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const { Box, Button, Text } = $.ui.resolve(e)
		const state = await read($, model)
		const prefs = await read($, mascots)
		const isOpen = await read($, isFinishedOpen)
		const now = await $.clock.now()
		const view = panelView(state, prefs, now, Math.max(8, e.props.bodyColumns - 10), isOpen)

		const card = (label: string, value: string) => (
			<Box key={`card-${label}`} flexDirection="column" borderStyle="round" paddingX={1}>
				<Text dimColor size="caption">
					{label}
				</Text>
				<Text weight="semibold" tabular>
					{value}
				</Text>
			</Box>
		)

		const agentRow = (row: RowView) => (
			<Box key={`row-${row.id}`} flexDirection="row" gap={1} marginBottom={1}>
				<Box flexDirection="column">
					{row.sprite.map(cells => (
						<Text>
							{cells.map(cell => (
								<Text {...cellProps(cell)}>{cell.ch}</Text>
							))}
						</Text>
					))}
				</Box>
				<Box flexDirection="column" flexGrow={1}>
					<Text weight="semibold" wrap="truncate-end">
						{row.title}
						{row.mark ? <Text color={TONE[row.tone]}> {row.mark}</Text> : ''}
					</Text>
					<Text dimColor wrap="truncate-end">
						{row.meta}
						{row.note ? ` · ${row.note}` : ''}
					</Text>
					<Text wrap="truncate-end">
						{row.steps ? `${row.steps} · ` : ''}
						<Text dimColor tabular>
							{row.stats}
						</Text>
					</Text>
					<Text color={TONE[row.tone]}>{row.bar}</Text>
				</Box>
			</Box>
		)

		return (
			<Box flexDirection="column">
				<Box flexDirection="row" gap={1}>
					{card('Cost', view.cost)}
					{card('Tokens', view.tokens)}
					{card('Time', view.time)}
				</Box>
				<Text dimColor size="caption">
					{view.session}
				</Text>
				<Text> </Text>
				{view.main && agentRow(view.main)}
				{view.isEmpty && <Text dimColor>No sub-agents yet. They show up here as soon as one starts.</Text>}
				{view.groups.map(group => (
					<Box key={`group-${group.name}`} flexDirection="column">
						<Text dimColor weight="semibold">
							{group.name} · {group.count}
						</Text>
						{!group.isCollapsed && group.rows.map(agentRow)}
						{group.isCollapsible && (
							<Button
								key="toggle-finished"
								plain
								label={group.isCollapsed ? `Show ${group.count} finished` : 'Hide finished'}
								onPress={() => update($, isFinishedOpen, value => !value)}
							/>
						)}
					</Box>
				))}
			</Box>
		)
	})
}
