import type { CrewState } from '../types'
import { TASK_TOOLS } from './tasks'

// How long a finished agent's bubble stays up, in milliseconds.
export const BUBBLE_MS = 6_000

const SUCCESS = [
	'Nailed it!',
	'Ship it!',
	'All green',
	'Ta-da!',
	'Done and dusted',
	'Easy peasy',
	"That's a wrap",
	'Mission complete',
	'Sorted!',
	'Boom, done',
	'Like a charm',
	'High five!'
]
const STOPPED = ['Hit a snag', 'Ran out of road', 'Taking a breather', 'Not this time']

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const baseName = (path: unknown) => text(path).slice(text(path).lastIndexOf('/') + 1)

// What an agent is doing, from the tool call it just started; undefined for the task tools, which the steps line shows.
export function actionText(tool: string, input: Record<string, unknown>): string | undefined {
	if (TASK_TOOLS.has(tool)) return undefined
	switch (tool) {
		case 'Read':
			return `Reading ${baseName(input.file_path)}`
		case 'Edit':
		case 'Write':
			return `Editing ${baseName(input.file_path)}`
		case 'NotebookEdit':
			return `Editing ${baseName(input.notebook_path)}`
		case 'Bash': {
			const words = text(input.command).replace(/^\s*cd\s+\S+\s*&&\s*/, '').trim().split(/\s+/)
			return `Running ${words.slice(0, 2).join(' ')}`
		}
		case 'Grep':
			return `Searching for '${text(input.pattern)}'`
		case 'Glob':
			return `Finding ${text(input.pattern)}`
		case 'WebFetch': {
			const host = /^[a-z]+:\/\/([^/?#]+)/i.exec(text(input.url))?.[1]
			return host ? `Reading ${host}` : 'Reading a web page'
		}
		case 'WebSearch':
			return 'Searching the web'
		case 'Agent':
			return 'Briefing a sub-agent'
		case 'Skill':
			return `Using ${text(input.skill)}`
	}
	const mcp = /^mcp__.+?__(.+)$/.exec(tool)
	return `Using ${mcp ? mcp[1].replace(/_/g, ' ') : tool}`
}

// A phrase picked by the agent's id, so one agent keeps the same one across every redraw.
export function phraseFor(id: string, tone: 'done' | 'stopped'): string {
	const list = tone === 'done' ? SUCCESS : STOPPED
	let hash = 0
	for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
	return list[hash % list.length]
}

// Whether an agent ended recently enough that its phrase is still up, plus one beat for the redraw that clears it.
export const isCheering = (state: CrewState, now: number) =>
	Object.values(state.agents).some(agent => agent.endedAt !== undefined && now - agent.endedAt < BUBBLE_MS + 1000)
