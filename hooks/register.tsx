import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentStatusView, MascotPrefs } from '../types'
import { registerBand } from './band'
import { SCAN_PRUNE, cdTarget, changedFiles, dirname, dirtyPaths, isGitCommit, joinUp, posix, touchOf } from './files'
import { registerFilesPane } from './files-pane'
import { SET_MASCOT_SPEC, SET_MASCOT_TOOL, applyMascotChange, parseMascotInput, sanitizeMascots } from './mascot'
import { isMoving, openPane, registerPanel, syncPaneShown } from './panel'
import { TASK_TOOLS } from './tasks'
import { EMPTY_STATE, MAIN, isPulsing, isTicking, reduce, type CrewEvent } from './tracker'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const isBandHidden = atom({ plugin: 'crew', key: 'isBandHidden' } as const, false)
const mascots = atom({ plugin: 'crew', key: 'mascots' } as const, {} as MascotPrefs)
const hasAutoOpened = atom({ plugin: 'crew', key: 'hasAutoOpened' } as const, false)
const groupOpen = atom({ plugin: 'crew', key: 'groupOpen' } as const, {} as Record<string, boolean>)

// The clock beats ten times a second. While a card moves between groups every beat redraws, so its slide steps
// along; while an agent runs every second beat does, so its card border breathes; otherwise once a second, for the
// elapsed times.
const BEAT_MS = 100
const BEATS_PER_SECOND = 10
const BEATS_PER_PULSE = 2

// Sub-agents keep no task list of their own unless asked, which leaves their bars nothing to measure. Each one is
// asked, after its task, to keep a short one: Crew reads it off the task-list tool calls as the agent's steps.
const STEPS_NOTE =
	'\n\n(Progress for the Crew panel: before you start, write your plan as a task list of 3 to 7 short steps with ' +
	'your task-list tool (TodoWrite, or TaskCreate and TaskUpdate), then mark each step in progress and completed as you go.)'

// A tool Claude can call to bring up the Agents pane, as /crew does for a person: a skill opens it as work begins.
const OPEN_PANEL_TOOL = 'mcp__crew__open_panel'
const OPEN_PANEL_SPEC = {
	name: 'open_panel',
	description:
		'Open the Crew Agents panel, which shows the plan, each sub-agent with its progress, tokens and cost. Call it when starting multi-step or sub-agent work so the user can follow along.',
	inputSchema: { type: 'object', properties: {}, additionalProperties: false }
}
const OPENED = 'The Crew Agents panel is open.'
const NOT_PLACED = 'No surface here can show the Crew Agents panel; the user can type /crew to open it.'

const mascotSaved = (role: string, style: object | undefined) =>
	style ? `Saved the ${role} mascot: ${JSON.stringify(style)}.` : `The ${role} mascot is back to its default look.`

// Origins where a person typed the prompt; every other origin (agents, notifications, triggers) continues a turn.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

const toolInput = (e: object): Record<string, unknown> =>
	Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))

async function apply($: EngineInterface, ev: CrewEvent) {
	await update($, model, state => reduce(state, ev))
}

// The store is the source of truth across sessions and /clear; what it holds is sanitised before it is drawn.
async function loadMascots($: EngineInterface) {
	const saved = sanitizeMascots(await $.store.get('mascots'))
	const same = (prefs: MascotPrefs) => JSON.stringify(prefs) === JSON.stringify(saved)
	if (!same(await read($, mascots))) await update($, mascots, prefs => (same(prefs) ? prefs : saved))
}

// A new prompt lets Finished fold again by itself past COLLAPSE_AFTER; the user's other folds stand.
async function dropFinishedFold($: EngineInterface) {
	if (!('Finished' in (await read($, groupOpen)))) return
	await update($, groupOpen, ({ Finished: _dropped, ...rest } = {}) => rest)
}

// Redraw the pane and band at the rate what is on them needs: a move, a breathing border, or a counting clock.
async function tick($: EngineInterface, beat: number) {
	const state = await read($, model)
	const isDue =
		isMoving(await $.clock.now()) ||
		(beat % BEATS_PER_PULSE === 0 && isPulsing(state)) ||
		(beat % BEATS_PER_SECOND === 0 && isTicking(state))
	if (isDue) $.ui.invalidate('ui.render')
}

// The first spawn of a session opens the pane only where it would be a sidebar; elsewhere it says how to open it.
async function introducePane($: EngineInterface, isSidebar: boolean | undefined) {
	let isFirst = false
	await update($, hasAutoOpened, wasOpened => {
		isFirst = !wasOpened
		return true
	})
	if (!isFirst) return
	if (isSidebar === true) void openPane($)
	else $.ui.toast('Crew: /crew opens the Agents panel')
}

// What an agent reads and edits through the file tools, for its Files pane.
async function recordFiles($: EngineInterface, tool: string, input: Record<string, unknown>, agentId: string | undefined) {
	const touch = touchOf(tool)
	const path =
		typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
	if (touch && path) await apply($, { kind: 'touch', at: await $.clock.now(), agentId, path: posix(path), touch })
}

const MARK_MS = 3_000
const SCAN_MS = 5_000

// Before a Bash command runs: an empty file whose mtime is "before", for `find -newer` to compare against afterwards.
// The X's make it a template for GNU mktemp, which refuses a bare name; BSD/macOS takes it as a prefix.
// Undefined when it cannot be made, which skips the scan; it can never keep the command from running.
async function markBash($: EngineInterface): Promise<string | undefined> {
	try {
		const made = await $.process.run(['mktemp', '-t', 'crew-mark.XXXXXX'], { timeoutMs: MARK_MS })
		return made.exitCode === 0 ? made.stdout.trim() || undefined : undefined
	} catch {
		return undefined
	}
}

const dropMarker = ($: EngineInterface, marker: string) =>
	$.process.run(['rm', '-f', marker], { timeoutMs: MARK_MS }).catch(() => undefined)

// After a Bash command: the files it changed become the caller's edits (the file tools never see a `sed -i`, a
// heredoc'd script or a `cat >`), then, for a commit, the check that turns clean edits green, so it sees them.
async function afterBash($: EngineInterface, command: string, agentId: string | undefined, marker: string | undefined, isCommit: boolean) {
	if (marker) {
		try {
			await recordBashEdits($, command, agentId, marker)
		} catch {
			// A scan that cannot run leaves the files as they are.
		} finally {
			await dropMarker($, marker)
		}
	}
	if (isCommit) await checkCommit($)
}

// What git ignores among these paths, as its NUL-separated output. Exit 1 is "none ignored"; any other failure, or a
// throw, leaves every path counting, since an edit shown wrongly beats one lost.
async function ignoredAmong($: EngineInterface, top: string, paths: string[]): Promise<string> {
	try {
		const asked = await $.process.run(['git', '--no-optional-locks', '-C', top, 'check-ignore', '-z', '--stdin'], {
			stdin: paths.map(path => `${path}\0`).join(''),
			timeoutMs: GIT_MS
		})
		return asked.exitCode === 0 ? asked.stdout : ''
	} catch {
		return ''
	}
}

async function recordBashEdits($: EngineInterface, command: string, agentId: string | undefined, marker: string) {
	// A leading `cd` is where the command worked: the session folder is only where it began.
	const cwd = posix(await $.session.cwd())
	const target = cdTarget(command, await $.env.get('HOME'))
	const dir = target === null ? cwd : target.startsWith('/') ? target : joinUp(cwd, target)
	const up = await $.process.run(['git', '--no-optional-locks', '-C', dir, 'rev-parse', '--show-cdup'], { timeoutMs: GIT_MS })
	// Never scan outside a repository: that could be the home folder.
	if (up.exitCode !== 0) return
	const top = joinUp(dir, up.stdout.trim())
	const prune = SCAN_PRUNE.flatMap((name, at) => (at === 0 ? ['-name', name] : ['-o', '-name', name]))
	const scan = await $.process.run(
		['find', top, '(', ...prune, ')', '-prune', '-o', '-type', 'f', '-newer', marker, '-print0'],
		{ timeoutMs: SCAN_MS }
	)
	// find exits non-zero over one unreadable folder yet still lists the rest, so its output counts either way.
	const candidates = changedFiles(scan.stdout, Infinity)
	if (candidates.length === 0) return
	for (const path of changedFiles(scan.stdout, undefined, await ignoredAmong($, top, candidates))) {
		await apply($, { kind: 'touch', at: await $.clock.now(), agentId, path, touch: 'edit' })
	}
}

const GIT_MS = 5_000

// Which of every agent's edited files git now holds clean: those turn committed, with the commit's short SHA. A commit by
// any agent checks them all, because Main often commits its sub-agents' work. Each file is asked in its own repository,
// since an agent in a git worktree works outside the checkout the session started in.
// --no-optional-locks keeps these reads from taking index.lock under the agent's next git command. `ls-files` is what
// keeps untracked, ignored and deleted files from counting as committed: status lists none of them as dirty.
async function checkCommit($: EngineInterface) {
	const checkedAt = await $.clock.now()
	const files = (await read($, model)).files ?? {}
	const editedBy = Object.entries(files).map(
		([key, list]) => [key, list.filter(item => item.state === 'edited').map(item => item.path)] as const
	)
	const edited = [...new Set(editedBy.flatMap(([, paths]) => paths))]
	if (edited.length === 0) return
	const git = (dir: string, ...args: string[]) =>
		$.process.run(['git', '--no-optional-locks', '-C', dir, ...args], { timeoutMs: GIT_MS })
	const tops = new Map<string, string[]>()
	for (const dir of new Set(edited.map(dirname))) {
		const up = await git(dir, 'rev-parse', '--show-cdup').catch(() => null)
		// Not in a repository, or a directory since deleted: those files are left as they are.
		if (!up || up.exitCode !== 0) continue
		const top = joinUp(dir, up.stdout.trim())
		tops.set(top, [...(tops.get(top) ?? []), ...edited.filter(path => dirname(path) === dir)])
	}
	// Each clean path with the SHA of its own repository's HEAD, which is unknown if HEAD could not be read.
	const clean = new Map<string, string | undefined>()
	for (const [top, paths] of tops) {
		try {
			const status = await git(top, 'status', '--porcelain', '-z', '--', ...paths)
			if (status.exitCode !== 0) continue
			const dirty = new Set([...dirtyPaths(status.stdout)].map(path => `${top}/${path}`))
			const unlisted = paths.filter(path => !dirty.has(path))
			if (unlisted.length === 0) continue
			// Status lists nothing for a file that was written, deleted and never committed, so a clean file counts
			// as committed only if git tracks it.
			const tracked = await git(top, 'ls-files', '-z', '--full-name', '--', ...unlisted)
			if (tracked.exitCode !== 0) continue
			const known = new Set(tracked.stdout.split('\0').filter(Boolean).map(path => `${top}/${path}`))
			const found = unlisted.filter(path => known.has(path))
			if (found.length === 0) continue
			const head = await git(top, 'rev-parse', '--short', 'HEAD')
			const sha = head.exitCode === 0 ? head.stdout.trim() : undefined
			for (const path of found) clean.set(path, sha)
		} catch {
			// One repository that cannot be asked leaves the rest to be checked.
		}
	}
	// An agent with nothing clean gets no event, so no SHA is stamped on it either.
	for (const [key, paths] of editedBy) {
		const mine = paths.filter(path => clean.has(path))
		if (mine.length === 0) continue
		const sha = clean.get(mine[mine.length - 1])
		await apply($, {
			kind: 'committed',
			agentId: key === MAIN ? undefined : key,
			at: checkedAt,
			paths: mine,
			...(sha ? { sha } : {})
		})
	}
}

export const register: Register = on => {
	// Last seen from the band's drawing: the spawn hook has no viewport of its own.
	let isSidebar: boolean | undefined
	let ticker: Timer | undefined
	// The prompt whose main turn has not started yet, and whether a person typed it; null when none was seen,
	// in which case the turn falls back to the tracker's text rule.
	let submitted: { text: string; isPerson: boolean } | null = null

	// Noted before `next`: the prompt's turn can start before `next` resolves.
	on('prompt.submit', async ($, e, next) => {
		const mine = { text: e.text, isPerson: !e.command && !e.isMeta && PERSON_ORIGINS.has(e.origin.kind) }
		submitted = mine
		const entered = await next(e)
		if (entered.drop !== undefined && submitted === mine) submitted = null
		return entered
	}).catch(($, e, next) => next(e))

	on('session.start', async ($, e, next) => {
		await $.command.register({ name: 'crew', description: 'Open the Crew agents panel' })
		await $.tool.register(SET_MASCOT_SPEC)
		await $.tool.register(OPEN_PANEL_SPEC)
		await loadMascots($)
		await syncPaneShown($)
		ticker?.cancel()
		let beat = 0
		ticker = $.clock.every(BEAT_MS, () => void tick($, ++beat).catch(() => undefined))
		return next(e)
	})

	on('command.run', { command: 'crew' }, async $ => {
		await openPane($)
		return { text: 'Crew panel opened.' }
	})

	on('turn.start', async ($, e, next) => {
		const seen = e.agentId ? null : submitted
		if (!e.agentId) submitted = null
		const isPerson = seen?.isPerson
		const text = isPerson ? (seen as { text: string }).text : e.text
		await apply($, {
			kind: 'turnStart',
			at: await $.clock.now(),
			turnId: e.turnId,
			text,
			agentId: e.agentId,
			...(isPerson === undefined ? {} : { isPerson })
		})
		if (!e.agentId) await loadMascots($)
		if (!e.agentId && isPerson !== false && text !== '') {
			await update($, isBandHidden, () => false)
			await dropFinishedFold($)
		}
		return next(e)
	})

	on('agent.spawn', async ($, e, next) => {
		const started = await next(e.prompt.includes(STEPS_NOTE) ? e : { ...e, prompt: e.prompt + STEPS_NOTE })
		if (started.deny === undefined && started.agentId) {
			await apply($, {
				kind: 'spawn',
				at: await $.clock.now(),
				agentId: started.agentId,
				description: e.description,
				subagentType: e.subagentType,
				model: started.model,
				...(e.parentAgentId ? { parentId: e.parentAgentId } : {})
			})
			await introducePane($, isSidebar)
		}
		return started
	}).catch(($, e, next) => next(e)) // a Crew failure never fails a spawn

	on('turn.step', async function* ($, e, next) {
		const result = yield* next(e)
		try {
			const at = await $.clock.now()
			const step: CrewEvent = {
				kind: 'step',
				at,
				agentId: e.agentId,
				model: e.model,
				effort: e.effort === undefined ? undefined : String(e.effort),
				usage: result.usage
			}
			const hasAgents = e.agentId !== undefined || (await read($, model)).order.length > 0
			const list = hasAgents ? await $.agent.list() : null
			const statuses: CrewEvent | null = list && {
				kind: 'statuses',
				at,
				list: list.map(agent => ({
					id: agent.id,
					status: agent.status as AgentStatusView,
					...(agent.parentId ? { parentId: agent.parentId } : {})
				}))
			}
			// One write per step: the usage and the statuses land together.
			await update($, model, state => {
				const stepped = reduce(state, step)
				return statuses ? reduce(stepped, statuses) : stepped
			})
		} catch {
			// Crew's bookkeeping never fails a step.
		}
		return result
	})

	on('turn.complete', async ($, e, next) => {
		await apply($, { kind: 'turnEnd', at: await $.clock.now(), agentId: e.agentId, isAborted: e.isAborted, reason: e.reason })
		return next(e)
	})

	on('tool.call', async ($, e, next) => {
		const tool = String(e.tool)
		// Crew's tools reach Claude as MCP tools, whose result must be text or content blocks: the engine refuses an
		// object with an output-shape error.
		if (tool === OPEN_PANEL_TOOL) {
			const { isPlaced } = await openPane($)
			if (!isPlaced) $.ui.toast('Crew: /crew opens the Agents panel')
			return { result: isPlaced ? OPENED : NOT_PLACED }
		}
		if (tool === SET_MASCOT_TOOL) {
			const parsed = parseMascotInput(toolInput(e))
			if ('error' in parsed) return { deny: parsed.error }
			await update($, mascots, prefs => applyMascotChange(prefs, parsed))
			const prefs = await read($, mascots)
			await $.store.set('mascots', prefs)
			return { result: mascotSaved(parsed.role, prefs[parsed.role]) }
		}
		const input = toolInput(e)
		const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : undefined
		// A background command has not finished when the call returns: its files and its HEAD are not settled yet.
		const isForeground = command !== undefined && input.run_in_background !== true
		const marker = isForeground ? await markBash($) : undefined
		let ran: Awaited<ReturnType<typeof next>>
		try {
			ran = await next(e)
		} catch (error) {
			if (marker) void dropMarker($, marker)
			throw error
		}
		if (ran.deny === undefined && ran.isError !== true) {
			if (TASK_TOOLS.has(tool)) await apply($, { kind: 'tasks', agentId: e.agentId, call: { tool, input, result: ran.result } })
			await recordFiles($, tool, input, e.agentId)
		}
		if (isForeground) {
			// Even a failed command is scanned: a script that fails may have written files first. Only a successful
			// commit is checked. A denied call ran nothing, so its marker is just removed.
			const isRun = ran.deny === undefined
			const isCommit = isRun && ran.isError !== true && isGitCommit(command)
			void afterBash($, command, e.agentId, isRun ? marker : undefined, isCommit).catch(() => undefined)
			if (!isRun && marker) void dropMarker($, marker)
		}
		return ran
	}).catch(($, e, next) => next(e)) // a Crew failure never fails a tool call

	registerBand(on, isFullscreen => {
		isSidebar = isFullscreen
	})
	registerPanel(on)
	registerFilesPane(on)
}
