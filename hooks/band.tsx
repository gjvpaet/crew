import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import { EMPTY_STATE, selectProgress } from './tracker'
import { bandLine } from './view'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const isBandHidden = atom({ plugin: 'crew', key: 'isBandHidden' } as const, false)

const DOT = { running: 'claude', done: 'success', aborted: 'error' } as const

// `onViewport` hears whether the surface docks a pane beside the transcript, each time the band is drawn where it said.
export function registerBand(on: On, onViewport: (isFullscreen: boolean) => void) {
	on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
		if (e.viewport?.isFullscreen !== undefined) onViewport(e.viewport.isFullscreen)
		const state = await read($, model)
		const progress = selectProgress(state)
		if (e.props.hasSurvey || !progress || (await read($, isBandHidden))) return next(e)

		const { Box, Button, Text } = $.ui.resolve(e)
		const line = bandLine(state, progress, e.props.bodyColumns)

		// Desktop drops trailing spaces inside a Text, so every gap comes from the row's `gap`.
		return (
			<Box flexDirection="row" gap={1}>
				<Text color={DOT[line.tone]}>●</Text>
				<Text weight="semibold" wrap="truncate-end">
					{line.label}
				</Text>
				<Text mono>
					<Text color="claude">{line.filled}</Text>
					<Text dimColor>{line.empty}</Text>
				</Text>
				<Text tabular wrap="truncate-end">
					{line.pill}
				</Text>
				<Text tabular>{line.percent}</Text>
				{line.runningLabel && (
					<Text dimColor tabular>
						{line.runningLabel}
					</Text>
				)}
				<Button key="hide" label="×" plain onPress={() => update($, isBandHidden, () => true)} />
			</Box>
		)
	})
}
