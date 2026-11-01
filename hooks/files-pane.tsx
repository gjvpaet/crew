import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { FileState } from '../types'
import { fileTree, headline, latestOf, posix, type TreeRow } from './files'
import { EMPTY_STATE } from './tracker'
import { agentAccent, pulseAt, pulseColor } from './view'

export const FILES_PANE = 'crew-files'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const filesFor = atom({ plugin: 'crew', key: 'filesFor' } as const, null as string | null)

// The community filetree mod's colours: purple for a read, orange for an edit, green once committed.
export const STATE_COLORS: Record<FileState, string> = { read: '#A371F7', edited: '#F0883E', committed: '#3FB950' }

// Past this many rows the tree stops with a count, keeping the pane well inside what Desktop will draw.
export const MAX_ROWS = 150

// Added to the card pulse so the live dot never fades past readable; at the pulse's peak it is the full colour.
const PULSE_FLOOR = 0.25

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

type Platform = 'darwin' | 'linux' | 'win32'

let platform: Promise<Platform> | null = null

// Read once a session: Windows names itself in OS; elsewhere uname tells macOS from Linux.
function osName($: EngineInterface): Promise<Platform> {
	platform ??= (async () => {
		try {
			if ((await $.env.get('OS')) === 'Windows_NT') return 'win32'
			const uname = await $.process.run(['uname', '-s'], { timeoutMs: 3_000 })
			return uname.stdout.trim() === 'Darwin' ? 'darwin' : 'linux'
		} catch {
			return 'linux'
		}
	})()
	return platform
}

const OPENERS: Record<Platform, (path: string) => string[]> = {
	darwin: path => ['open', path],
	linux: path => ['xdg-open', path],
	win32: path => ['cmd', '/c', 'start', '', path]
}

// A file row opens its file in the default app; a failure is only a toast.
async function openFile($: EngineInterface, path: string) {
	try {
		const ran = await $.process.run(OPENERS[await osName($)](path), { timeoutMs: 5_000 })
		if (ran.exitCode === 0) return
	} catch {
		// Falls through to the toast.
	}
	$.ui.toast(`Crew: couldn't open ${path.slice(path.lastIndexOf('/') + 1)}`)
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
		const { Box, Button, Text } = $.ui.resolve(e)
		const key = await read($, filesFor)
		if (!key) {
			return (
				<Box>
					<Text dimColor>Press ▸ on a card in the Agents pane to see its files.</Text>
				</Box>
			)
		}
		const state = await read($, model)
		// `?.`: a model saved before files were tracked has neither until its next event.
		const entries = state.files?.[key] ?? []
		const sha = state.lastCommit?.[key]
		const isRunning = state.agents[key]?.status === 'running'
		const root = posix(await $.session.cwd())
		const now = await $.clock.now()
		const head = headline(entries, isRunning, root)
		const rows = fileTree(entries, root)
		const live = isRunning ? latestOf(entries)?.path : undefined
		const surface = e.surface === 'terminal' ? 'terminal' : 'graphical'
		const legend: FileState[] = entries.some(item => item.state === 'committed')
			? ['read', 'edited', 'committed']
			: ['read', 'edited']

		const dotColor = (path: string, fileState: FileState) =>
			path === live ? pulseColor(STATE_COLORS[fileState], PULSE_FLOOR + pulseAt(now), surface) : STATE_COLORS[fileState]

		const treeRow = (row: TreeRow) => (
			<Box key={row.key} flexDirection="row" gap={1}>
				<Text key={`guide-${row.key}`} dimColor mono>
					{row.prefix}
				</Text>
				{row.kind === 'dir' ? (
					<Text key={`name-${row.key}`} {...(row.isOutside ? { dimColor: true } : {})} wrap="truncate-end">
						{row.name}
					</Text>
				) : (
					[
						<Text key={`dot-${row.path}`} color={dotColor(row.path, row.state)}>
							●
						</Text>,
						// width 0 + flexGrow 1: the name takes what the dot and the state word leave.
						<Box key={`cell-${row.path}`} flexGrow={1} width={0}>
							<Button key={`open-${row.path}`} plain label={row.name} onPress={() => openFile($, row.path)} />
						</Box>,
						<Text key={`state-${row.path}`} color={STATE_COLORS[row.state]}>
							{row.state}
						</Text>
					]
				)}
			</Box>
		)

		return (
			<Box flexDirection="column">
				<Box key="head" flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
					<Box flexDirection="row" gap={1}>
						<Text color={agentAccent(state, key)}>●</Text>
						<Text dimColor size="caption">
							{head.label}
						</Text>
					</Box>
					<Text weight="semibold" wrap="truncate-end">
						{head.line}
					</Text>
					{head.where && (
						<Text dimColor wrap="truncate-end">
							{`in ${head.where}`}
						</Text>
					)}
					<Box flexDirection="row" gap={2}>
						{legend.map(fileState => (
							<Text key={`legend-${fileState}`} color={STATE_COLORS[fileState]}>
								{`● ${fileState}`}
							</Text>
						))}
					</Box>
				</Box>
				{entries.length > 0 && (
					<Text key="touched" dimColor size="caption">
						{`TOUCHED · ${entries.length} FILE${entries.length === 1 ? '' : 'S'}`}
					</Text>
				)}
				{rows.slice(0, MAX_ROWS).map(treeRow)}
				{rows.length > MAX_ROWS && (
					<Text key="more" dimColor>
						{`+ ${rows.length - MAX_ROWS} more`}
					</Text>
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
