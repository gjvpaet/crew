import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { CrewState, FileState } from '../types'
import {
	countsText,
	latestOf,
	openCommand,
	posix,
	rightNow,
	shineColors,
	touchedRows,
	type ChipTone,
	type OpenPlatform,
	type RightNow,
	type TouchedRow
} from './files'
import { iconSvg, shineSvg } from './svg'
import { EMPTY_STATE } from './tracker'

const FILES_PANE = 'crew-files'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const filesFor = atom({ plugin: 'crew', key: 'filesFor' } as const, null as string | null)

// The community filetree mod's colours: purple for a read, orange for an edit, green once committed.
export const STATE_COLORS: Record<FileState, string> = { read: '#A371F7', edited: '#F0883E', committed: '#3FB950' }

// Past this many rows the list stops with a count. A row is at most 15 nodes, so 100 of them and the card above stay
// under the 2,000 Desktop will draw.
export const MAX_ROWS = 100

const WAITING_COLOR = '#D29922'
const ADDED_COLOR = '#7FC77F'
const REMOVED_COLOR = '#F07A7A'
const QUIET_COLOR = '#8B949E'
// The card's outline right after a touch, so a new file is noticed from the corner of an eye.
const FLASH_COLOR = '#E8E6DF'
export const FLASH_MS = 1200
const CHIP_COLORS: Record<ChipTone, string> = { code: '#E3B341', docs: '#58A6FF', data: '#56D364', other: QUIET_COLOR }

const ICON_PX = 36
const BRANCH_PX = 14
const TERMINAL_ICONS: Record<RightNow['icon'], string> = { eye: '◉', pencil: '✎', check: '✓', pause: '‖' }

type Surface = 'graphical' | 'terminal'

const channels = (hex: string) => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
const alpha = (hex: string, opacity: number) => `rgba(${channels(hex).join(',')},${opacity})`
const toHex = (values: number[]) => '#' + values.map(value => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase()
// The terminal shine's band: the state colour most of the way to white, so it still reads as that colour.
const brighter = (hex: string) => toHex(channels(hex).map(value => value + (255 - value) * 0.6))

// A chip or a pill: the colour on a faint wash of itself where the surface blends colours, and dark on the solid
// colour in the terminal, which reads on a light or a dark theme alike.
const badge = (hex: string, surface: Surface) =>
	surface === 'graphical' ? { color: hex, backgroundColor: alpha(hex, 0.18) } : { color: '#000000', backgroundColor: hex }

// Non-breaking, so the badge's padding survives a surface that trims spaces; chips pad to 4 so the names line up.
const NB = '\u00a0'
const chipText = (label: string) => `${NB}${label.padEnd(4, NB)}${NB}`
const pillText = (pill: string) => `${NB}${pill}${NB}`

// True while the agent's latest touch is new enough to light the card; the ticker redraws until it is not, since
// nothing else may (a slow Bash scan's touch can land after every agent has ended).
export function isFlashing(state: CrewState, key: string | null, now: number) {
	const latest = key ? latestOf(state.files?.[key] ?? []) : undefined
	return latest !== undefined && now - latest.at < FLASH_MS
}

const titleOf = (description: string | undefined) => `Files · ${description ?? 'Agent'}`

// A card's chevron: opens the Files pane on its agent, switches it from another one, or closes it when it shows
// this one already.
export async function showFiles($: EngineInterface, key: string) {
	if ((await read($, filesFor)) === key) {
		await update($, filesFor, () => null)
		await $.ui.close({ id: FILES_PANE }).catch(() => undefined)
		return
	}
	await update($, filesFor, () => key)
	const agent = (await read($, model)).agents[key]
	const opened = await $.ui.open({ id: FILES_PANE, title: titleOf(agent?.description) }).catch(() => ({ isPlaced: false }))
	if (opened.isPlaced) return
	// Nothing shows the pane, so the chevron must not stay lit for it.
	await update($, filesFor, () => null)
	$.ui.toast('Crew: the Files pane has no room here')
}

let platform: OpenPlatform | null = null

// Read once per module: Windows names itself in OS; elsewhere uname tells macOS from Linux. Only an answer that was
// really given is kept; a failed look is Linux for that press and is asked again at the next.
async function osName($: EngineInterface): Promise<OpenPlatform> {
	if (platform) return platform
	try {
		if ((await $.env.get('OS')) === 'Windows_NT') return (platform = 'win32')
		const uname = await $.process.run(['uname', '-s'], { timeoutMs: 3_000 })
		if (uname.exitCode === 0) return (platform = uname.stdout.trim() === 'Darwin' ? 'darwin' : 'linux')
	} catch {
		// Falls through to the guess.
	}
	return 'linux'
}

// An opener on macOS or Linux runs a file whose executable bit is set, whatever it is called, and opens a symlink as
// its target's type (`README.md -> x.terminal` runs the profile). `-L` looks at the last path component only, which
// is the link itself. A check that cannot run counts as a yes: the file is shown in its folder rather than risked.
async function wouldRunOrIsLink($: EngineInterface, path: string) {
	try {
		return (await $.process.run(['test', '-x', path, '-o', '-L', path], { timeoutMs: 3_000 })).exitCode === 0
	} catch {
		return true
	}
}

// A file row shows its file in the default app, or its folder for a file that app would run; a failure is only a
// toast.
async function openFile($: EngineInterface, path: string) {
	const name = path.slice(path.lastIndexOf('/') + 1)
	const os = await osName($)
	// Windows runs by extension alone, which openCommand judges; the first call only tells a path it refuses.
	const plain = openCommand(os, path, false)
	const command = plain && os !== 'win32' && (await wouldRunOrIsLink($, path)) ? openCommand(os, path, true) : plain
	if (command) {
		try {
			const ran = await $.process.run(command.argv, { timeoutMs: 5_000 })
			// explorer exits 1 even when it showed the file.
			if (command.argv[0] === 'explorer' || ran.exitCode === 0) {
				if (command.isReveal) $.ui.toast(`Crew: showed ${name} in its folder rather than running it`)
				return
			}
		} catch {
			// Falls through to the toast.
		}
	}
	$.ui.toast(`Crew: couldn't open ${name}`)
}

export function registerFilesPane(on: On) {
	// Matched on the pane: the engine refuses two unmatched hooks on one event, and the Agents pane has the other.
	on('ui.close', { id: FILES_PANE }, async ($, e, next) => {
		const closed = await next(e)
		// Gone with an unload, the pane comes back with the module, still showing the same agent.
		if (e.origin.kind !== 'unload') await update($, filesFor, () => null)
		return closed
	})

	on('ui.render', { component: 'Pane', requestId: FILES_PANE }, async ($, e) => {
		const elements = $.ui.resolve(e)
		const { Box, Button, Text } = elements
		// Every surface but the terminal draws SVG; there coloured glyphs and letters stand in.
		const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
		const surface: Surface = Svg ? 'graphical' : 'terminal'
		const key = await read($, filesFor)
		const state = await read($, model)
		// A card dropped by a new prompt leaves the pane showing nothing to open.
		if (!key || !state.agents[key]) {
			return (
				<Box>
					<Text dimColor>Press ▸ on a card in the Agents pane to see its files.</Text>
				</Box>
			)
		}
		// `?.`: a model saved before files or git info were tracked has none until its next event.
		const entries = state.files?.[key] ?? []
		const lines = state.lines ?? {}
		const repos = state.repos ?? {}
		const sha = state.lastCommit?.[key]
		const status = state.agents[key].status
		const root = posix(await $.session.cwd())
		const now = await $.clock.now()
		const card = rightNow(entries, status, root, lines, repos)
		const rows = touchedRows(entries, root, status, lines)
		const repo = card.repoTop === null ? undefined : repos[card.repoTop]
		const labelColor = card.tone === 'waiting' ? WAITING_COLOR : STATE_COLORS[card.tone]
		const legend: FileState[] = entries.some(item => item.state === 'committed')
			? ['read', 'edited', 'committed']
			: ['read', 'edited']

		const icon = Svg ? (
			<Svg source={iconSvg(card.icon, labelColor, ICON_PX)} alt={`${card.icon} icon`} width={ICON_PX} height={ICON_PX} />
		) : (
			<Text color={labelColor}>{TERMINAL_ICONS[card.icon]}</Text>
		)

		const counts = (added: number, removed: number) => [
			added > 0 && (
				<Text key="added" color={ADDED_COLOR}>
					{`+${added}`}
				</Text>
			),
			removed > 0 && (
				<Text key="removed" color={REMOVED_COLOR}>
					{`\u2212${removed}`}
				</Text>
			)
		]

		const branchRow = (known: { branch: string | null; changed: number }) => (
			<Box key="branch" flexDirection="row" gap={1} marginTop={1} alignItems="center">
				{Svg ? (
					<Svg source={iconSvg('branch', QUIET_COLOR, BRANCH_PX)} alt="branch" width={BRANCH_PX} height={BRANCH_PX} />
				) : (
					<Text color={QUIET_COLOR}>⎇</Text>
				)}
				<Box flexGrow={1} width={0}>
					<Text wrap="truncate-end">{known.branch || 'detached'}</Text>
				</Box>
				<Text dimColor>
					{[countsText(card.totals.added, card.totals.removed), known.changed === 0 ? 'clean' : `${known.changed} changed`]
						.filter(Boolean)
						.join(' · ')}
				</Text>
			</Box>
		)

		// `isMark`: the live row's dim ↗, which stands in for its name as what a press opens.
		const openButton = (row: TouchedRow, children: JSX.Element | JSX.Element[], isMark = false) => (
			<Button
				key={`open-${row.path}`}
				plain
				{...(isMark ? { dimColor: true } : {})}
				label={row.name}
				onPress={() => openFile($, row.path)}
			>
				{children}
			</Button>
		)

		const folder = (row: TouchedRow) => (
			<Text dimColor wrap="truncate-end">
				{row.folder}
			</Text>
		)

		// The live file's name is lit by a band sweeping across it: an animated SVG where the surface draws one, a colour
		// per letter in the terminal, the band moving a letter at each redraw.
		const nameParts = (row: TouchedRow) => {
			const base = STATE_COLORS[row.state]
			if (!row.isLive) return [openButton(row, <Text weight="semibold">{row.name}</Text>), folder(row)]
			if (Svg) {
				const shine = shineSvg(row.name, base)
				return [
					<Svg source={shine.source} alt={row.name} width={shine.width} height={shine.height} isInteractive />,
					folder(row)
				]
			}
			const colors = shineColors(row.name, now, base, brighter(base))
			const letters = Array.from(row.name).map((letter, at) => (
				<Text color={colors[at]} weight="semibold">
					{letter}
				</Text>
			))
			return [openButton(row, letters), folder(row)]
		}

		// The live row is outlined in its state colour (and tinted where the surface blends); the others are padded by
		// as much, so every chip starts in the same column.
		const touchedRow = (row: TouchedRow) => (
			<Box
				key={row.key}
				flexDirection="row"
				gap={1}
				{...(row.isLive
					? {
							borderStyle: 'round',
							borderColor: STATE_COLORS[row.state],
							...(Svg ? { backgroundColor: alpha(STATE_COLORS[row.state], 0.08) } : {})
						}
					: { paddingX: 1 })}
			>
				<Text mono {...badge(CHIP_COLORS[row.chip.tone], surface)}>
					{chipText(row.chip.label)}
				</Text>
				{/* width 0 + flexGrow 1: the name and folder take what the chip, counts and pill leave. */}
				<Box key="name" flexDirection="row" gap={1} flexGrow={1} width={0}>
					{nameParts(row)}
				</Box>
				{/* An SVG cannot sit in a Button, so the shining name opens through a mark of its own, outside the name cell
				    so a long name never squeezes it away. */}
				{row.isLive && Svg && openButton(row, <Text>{'\u2197'}</Text>, true)}
				{counts(row.added, row.removed)}
				<Text {...badge(STATE_COLORS[row.state], surface)}>{pillText(row.pill)}</Text>
			</Box>
		)

		return (
			<Box flexDirection="column">
				<Box
					key="now"
					flexDirection="column"
					borderStyle="round"
					{...(isFlashing(state, key, now) ? { borderColor: FLASH_COLOR } : {})}
					paddingX={1}
					marginBottom={1}
				>
					<Box key="now-head" flexDirection="row" gap={1} alignItems="center">
						{icon}
						<Box flexDirection="column" flexGrow={1} width={0}>
							<Text color={labelColor} size="caption" weight="semibold">
								{card.label}
							</Text>
							<Text weight="semibold" wrap="truncate-end">
								{card.title}
							</Text>
							{card.subtitle ? (
								<Text dimColor wrap="truncate-end">
									{card.subtitle}
								</Text>
							) : null}
						</Box>
					</Box>
					{repo && branchRow(repo)}
					<Box key="legend" flexDirection="row" gap={2} marginTop={1}>
						{legend.map(fileState => (
							<Text key={`legend-${fileState}`} color={STATE_COLORS[fileState]}>
								{`● ${fileState}`}
							</Text>
						))}
					</Box>
				</Box>
				{rows.length > 0 && (
					<Box key="touched" flexDirection="column" borderStyle="round" paddingX={1}>
						<Box key="touched-head" flexDirection="row">
							<Box flexGrow={1}>
								<Text dimColor size="caption">
									TOUCHED
								</Text>
							</Box>
							<Text dimColor size="caption">
								{`${rows.length} FILE${rows.length === 1 ? '' : 'S'}`}
							</Text>
						</Box>
						{rows.slice(0, MAX_ROWS).map(touchedRow)}
						{rows.length > MAX_ROWS && (
							<Text dimColor>
								{`+ ${rows.length - MAX_ROWS} more`}
							</Text>
						)}
					</Box>
				)}
				{sha && (
					<Box key="commit" flexDirection="row" gap={1} marginTop={1}>
						<Text color={STATE_COLORS.committed}>●</Text>
						<Text dimColor>{`committed ${sha}`}</Text>
					</Box>
				)}
			</Box>
		)
	})
}
