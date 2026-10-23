import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentStatusView, MascotPrefs } from '../types'
import { registerBand } from './band'
import { SET_MASCOT_SPEC, SET_MASCOT_TOOL, applyMascotChange, parseMascotInput } from './mascot'
import { PANE, registerPanel } from './panel'
import { TASK_TOOLS } from './tasks'
import { EMPTY_STATE, reduce, type CrewEvent } from './tracker'

// The engine's scan follows state refs only through consts of the same file, so each file declares its own.
const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
const isBandHidden = atom({ plugin: 'crew', key: 'isBandHidden' } as const, false)
const mascots = atom({ plugin: 'crew', key: 'mascots' } as const, {} as MascotPrefs)

const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

const toolInput = (e: object): Record<string, unknown> =>
	Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))

async function apply($: EngineInterface, ev: CrewEvent) {
	await update($, model, state => reduce(state, ev))
}

export const register: Register = on => {
	let hasOpenedPane = false

	on('session.start', async ($, e, next) => {
		await $.command.register({ name: 'crew', description: 'Open the Crew agents panel' })
		await $.tool.register(SET_MASCOT_SPEC)
		const saved = await $.store.get('mascots')
		if (saved && typeof saved === 'object') await update($, mascots, () => saved as MascotPrefs)
		return next(e)
	})

	on('command.run', { command: 'crew' }, async $ => {
		await $.ui.open({ id: PANE, title: 'Agents' })
		return { text: 'Crew panel opened.' }
	})

	on('turn.start', async ($, e, next) => {
		await apply($, { kind: 'turnStart', at: await $.clock.now(), turnId: e.turnId, text: e.text, agentId: e.agentId })
		if (!e.agentId && e.text !== '') await update($, isBandHidden, () => false)
		return next(e)
	})

	on('agent.spawn', async ($, e, next) => {
		const started = await next(e)
		if (started.deny === undefined && started.agentId) {
			await apply($, {
				kind: 'spawn',
				at: await $.clock.now(),
				agentId: started.agentId,
				description: e.description,
				subagentType: e.subagentType,
				model: started.model
			})
			if (!hasOpenedPane) {
				hasOpenedPane = true
				void $.ui.open({ id: PANE, title: 'Agents' })
			}
		}
		return started
	})

	on('turn.step', async function* ($, e, next) {
		const result = yield* next(e)
		await apply($, {
			kind: 'step',
			at: await $.clock.now(),
			agentId: e.agentId,
			model: e.model,
			effort: e.effort === undefined ? undefined : String(e.effort),
			usage: result.usage
		})
		if ((await read($, model)).order.length > 0) {
			const list = await $.agent.list()
			await apply($, {
				kind: 'statuses',
				at: await $.clock.now(),
				list: list.map(agent => ({
					id: agent.id,
					status: agent.status as AgentStatusView,
					...(agent.parentId ? { parentId: agent.parentId } : {})
				}))
			})
		}
		return result
	})

	on('turn.complete', async ($, e, next) => {
		await apply($, { kind: 'turnEnd', at: await $.clock.now(), agentId: e.agentId, isAborted: e.isAborted, reason: e.reason })
		return next(e)
	})

	on('tool.call', async ($, e, next) => {
		const tool = String(e.tool)
		if (tool === SET_MASCOT_TOOL) {
			const parsed = parseMascotInput(toolInput(e))
			if ('error' in parsed) return { deny: parsed.error }
			await update($, mascots, prefs => applyMascotChange(prefs, parsed))
			const prefs = await read($, mascots)
			await $.store.set('mascots', prefs)
			return { result: { ok: true, role: parsed.role, prefs: prefs[parsed.role] ?? 'default' } }
		}
		const ran = await next(e)
		if (TASK_TOOLS.has(tool) && ran.deny === undefined && ran.isError !== true) {
			await apply($, { kind: 'tasks', agentId: e.agentId, call: { tool, input: toolInput(e), result: ran.result } })
		}
		return ran
	})

	registerBand(on)
	registerPanel(on)
}
