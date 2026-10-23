import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { MascotPrefs } from '../types'
import { bandBarSvg, pipHeight, pipSvg } from './svg'
import { PALETTE } from './sprite'
import { EMPTY_STATE, MAIN, selectProgress, selectRunning } from './tracker'
import { bandLine } from './view'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const isBandHidden = atom({ plugin: 'crew', key: 'isBandHidden' } as const, false)
const mascots = atom({ plugin: 'crew', key: 'mascots' } as const, {} as MascotPrefs)

const DOT = { running: 'claude', done: 'success', aborted: 'error' } as const

const FAILED = new Set(['failed', 'killed', 'stopped'])

// The SVG bar's look on desktop, vscode and mobile: a violet fill (readable on the light track) and a purple pill.
const BAR = { width: 200, height: 18, fill: '#7F77DD', pillBg: '#534AB7', pillFg: '#EEEDFE' }
const MINI_PIP_PX = 16
// Desktop lines the band's items up on the text baseline, whatever the row's `alignItems`, and an image's
// baseline is its bottom edge, so a bare Svg rides high. Each one sits in a Box that centres itself instead.

// `onViewport` hears whether the surface docks a pane beside the transcript, each time the band is drawn where it said.
export function registerBand(on: On, onViewport: (isFullscreen: boolean) => void) {
	on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
		if (e.viewport?.isFullscreen !== undefined) onViewport(e.viewport.isFullscreen)
		const state = await read($, model)
		const progress = selectProgress(state)
		if (e.props.hasSurvey || !progress || (await read($, isBandHidden))) return next(e)

		const elements = $.ui.resolve(e)
		const { Box, Button, Text } = elements
		const line = bandLine(state, progress, e.props.bodyColumns)

		// Desktop drops trailing spaces inside a Text, so on every surface each gap comes from the row's `gap`.
		// Every surface but the terminal draws the bar, its pill and a mini Pip as SVG.
		if (e.surface !== 'terminal' && 'Svg' in elements) {
			const { Svg } = elements
			const prefs = await read($, mascots)
			const isAnyRunning = selectRunning(state) > 0
			const main = state.agents[MAIN]
			// With no sub-agent, Main is the one at work: its own Pip, moving while its turn runs.
			const mainPose = main?.status === 'running' ? 'running' : FAILED.has(main?.status ?? 'completed') ? 'stopped' : 'still'
			const mini = line.runningLabel
				? {
						source: pipSvg('developer', prefs, MINI_PIP_PX, { pose: isAnyRunning ? 'running' : 'still' }),
						alt: 'developer mascot',
						isMoving: isAnyRunning
					}
				: {
						source: pipSvg(main?.role ?? 'plain', prefs, MINI_PIP_PX, { species: 'pip', body: PALETTE.body, pose: mainPose }),
						alt: `Pip the main agent mascot, ${mainPose}`,
						isMoving: mainPose === 'running'
					}
			return (
				<Box flexDirection="row" gap={1} alignItems="center">
					<Text color={DOT[line.tone]}>●</Text>
					<Text weight="semibold" wrap="truncate-end">
						{line.label}
					</Text>
					<Box alignSelf="center">
						<Svg
							source={bandBarSvg({
								fraction: progress.fraction,
								width: BAR.width,
								height: BAR.height,
								color: BAR.fill,
								pill: line.pill,
								pillBg: BAR.pillBg,
								pillFg: BAR.pillFg
							})}
							alt={`${line.pill}, ${line.percent}`}
							width={BAR.width}
							height={BAR.height}
						/>
					</Box>
					<Text tabular>{line.percent}</Text>
					<Box alignSelf="center">
						<Svg
							source={mini.source}
							alt={mini.alt}
							width={MINI_PIP_PX}
							height={pipHeight(MINI_PIP_PX)}
							// It moves while whoever it stands for is at work, and rests once they are not.
							isInteractive={mini.isMoving}
						/>
					</Box>
					<Text dimColor tabular>
						{line.agentLabel}
					</Text>
					<Button key="hide" label="×" plain onPress={() => update($, isBandHidden, () => true)} />
				</Box>
			)
		}

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
				<Text dimColor tabular>
					{line.agentLabel}
				</Text>
				<Button key="hide" label="×" plain onPress={() => update($, isBandHidden, () => true)} />
			</Box>
		)
	})
}
