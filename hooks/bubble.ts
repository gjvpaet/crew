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
const baseName = (path: unknown) => text(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
const say = (verb: string, subject: string) => (subject ? `${verb} ${subject}` : undefined)

// Read-only task tools: nothing worth a bubble.
const QUIET = new Set(['TaskList', 'TaskGet'])
// A leading setup hop (`cd`, `source`, `.`, `nvm use`, `export`/`env` assignments, `NAME=value`): where or how a command ran, and possibly a secret.
const ARG = String.raw`(?:"[^"]*"|'[^']*'|\S+)`
// The value alternatives must not overlap, or a long line of quoted assignments backtracks exponentially.
const ASSIGN = String.raw`[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"']\S*)?`
const HOP = String.raw`\s*(?:&&|;)\s*`
const LEAD = new RegExp(
	String.raw`^\s*(?:(?:cd|source|\.|nvm\s+use)\s+${ARG}${HOP}|(?:export|env)(?:\s+${ASSIGN})+${HOP}|env(?:\s+${ASSIGN})+\s+|${ASSIGN}\s+)`
)

// What an agent is doing, from the tool call it just started; undefined when there is nothing to say, so the bubble stays as it was.
function describe(tool: string, input: Record<string, unknown>): string | undefined {
	if (TASK_TOOLS.has(tool) || QUIET.has(tool)) return undefined
	switch (tool) {
		case 'Read':
			return say('Reading', baseName(input.file_path))
		case 'Edit':
		case 'Write':
			return say('Editing', baseName(input.file_path))
		case 'NotebookEdit':
			return say('Editing', baseName(input.notebook_path))
		case 'Bash': {
			let command = text(input.command)
			for (let next = command.replace(LEAD, ''); next !== command; next = command.replace(LEAD, '')) command = next
			return say('Running', command.trim().split(/\s+/).slice(0, 2).filter(word => !word.includes('=')).join(' '))
		}
		case 'Grep':
			return say('Searching for', text(input.pattern) && `'${text(input.pattern)}'`)
		case 'Glob':
			return say('Finding', text(input.pattern))
		case 'WebFetch': {
			const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#]+)/i.exec(text(input.url))?.[1]
			return host ? `Reading ${host}` : 'Reading a web page'
		}
		case 'WebSearch':
			return 'Searching the web'
		case 'Agent':
			return 'Briefing a sub-agent'
		case 'Skill':
			return say('Using', text(input.skill))
	}
	const mcp = /^mcp__.+?__(.+)$/.exec(tool)
	return `Using ${mcp ? mcp[1].replace(/_+/g, ' ').trim() : tool}`
}

// Capped so a huge pattern or URL never sits whole in state.
export const actionText = (tool: string, input: Record<string, unknown>) => describe(tool, input)?.slice(0, 120)

// A phrase picked by the agent's id, so one agent keeps the same one across every redraw.
export function phraseFor(id: string, tone: 'done' | 'stopped'): string {
	const list = tone === 'done' ? SUCCESS : STOPPED
	let hash = 0
	for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
	return list[hash % list.length]
}

// Whether an agent ended recently enough that its phrase is still up, plus two seconds so the redraw that clears
// it still comes.
export const isCheering = (state: CrewState, now: number) =>
	Object.values(state.agents).some(agent => {
		const age = agent.endedAt === undefined ? -1 : now - agent.endedAt
		return age >= 0 && age < BUBBLE_MS + 2000
	})
