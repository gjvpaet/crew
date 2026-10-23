import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import { EMPTY_STATE, selectProgress } from './tracker'
import { bandLine } from './view'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const isBandHidden = atom({ plugin: 'crew', key: 'isBandHidden' } as const, false)

const DOT = { running: 'claude', done: 'success', aborted: 'error' } as const

export function registerBand(on: On) {
	on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
		const state = await read($, model)
		const progress = selectProgress(state)
		if (e.props.hasSurvey || !progress || (await read($, isBandHidden))) return next(e)

		const { Box, Button, Text } = $.ui.resolve(e)
		const line = bandLine(state, progress, e.props.bodyColumns)

		return (
			<Box flexDirection="row">
				<Text color={DOT[line.tone]}>● </Text>
				<Text weight="semibold">{line.label} </Text>
				<Text color="claude">{line.filled}</Text>
				<Text dimColor>{line.empty}</Text>
				<Text tabular>
					{' '}
					{line.pill} {line.percent}{' '}
				</Text>
				<Text color="suggestion">▣</Text>
				<Text tabular>×{line.running} </Text>
				<Button key="hide" label="×" plain onPress={() => update($, isBandHidden, () => true)} />
			</Box>
		)
	})
}
