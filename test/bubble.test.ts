import { expect, test } from 'claude-code/testing'

import { BUBBLE_MS, actionText, isCheering, phraseFor } from '../hooks/bubble'
import { EMPTY_STATE, reduce, type CrewEvent } from '../hooks/tracker'

test('a tool call becomes what the agent is doing', async () => {
	expect(actionText('Read', { file_path: '/repo/hooks/band.tsx' })).toBe('Reading band.tsx')
	expect(actionText('Edit', { file_path: '/repo/a.ts' })).toBe('Editing a.ts')
	expect(actionText('Write', { file_path: '/repo/b.md' })).toBe('Editing b.md')
	expect(actionText('NotebookEdit', { notebook_path: '/repo/n.ipynb' })).toBe('Editing n.ipynb')
	expect(actionText('Bash', { command: 'bun test --watch' })).toBe('Running bun test')
	// A leading `cd <dir> &&` is where the command ran, not what it does.
	expect(actionText('Bash', { command: 'cd /repo/crew && git status --short' })).toBe('Running git status')
	expect(actionText('Grep', { pattern: 'flag' })).toBe("Searching for 'flag'")
	expect(actionText('Glob', { pattern: '**/*.ts' })).toBe('Finding **/*.ts')
	expect(actionText('WebFetch', { url: 'https://github.com/Graphify-Labs/graphify' })).toBe('Reading github.com')
	expect(actionText('WebFetch', { url: 'not a url' })).toBe('Reading a web page')
	expect(actionText('WebSearch', { query: 'x' })).toBe('Searching the web')
	expect(actionText('Agent', { description: 'x' })).toBe('Briefing a sub-agent')
	expect(actionText('Skill', { skill: 'ponytail' })).toBe('Using ponytail')
	expect(actionText('mcp__claude-in-chrome__tabs_context_mcp', {})).toBe('Using tabs context mcp')
	expect(actionText('NewTool', {})).toBe('Using NewTool')
})

test('a command shows what it runs, not its cd hops or env vars', async () => {
	const bash = (command: string) => actionText('Bash', { command })
	expect(bash('TOKEN=sk-abc curl https://x')).toBe('Running curl https://x')
	expect(bash('GIT_CONFIG_GLOBAL=/dev/null git log -1')).toBe('Running git log')
	expect(bash('cd "dir with spaces" && bun test')).toBe('Running bun test')
	expect(bash('cd a && cd b && ls -la')).toBe('Running ls -la')
	expect(bash('cd a; make build')).toBe('Running make build')
	expect(bash('cd /r && FOO=1 bun test')).toBe('Running bun test')
	expect(bash('source ~/.nvm/nvm.sh && nvm use 24 && npm test')).toBe('Running npm test')
	expect(bash('export PATH=/opt/bin:$PATH && bun test')).toBe('Running bun test')
	expect(bash('export TOKEN=sk-abc; curl https://x')).toBe('Running curl https://x')
	expect(bash('env FOO=1 BAR=2 make build')).toBe('Running make build')
	expect(bash('. ./env.sh && ls')).toBe('Running ls')
	expect(bash('curl X=1')).toBe('Running curl')
})

test('the text is capped at 120 characters', async () => {
	expect(actionText('Grep', { pattern: 'x'.repeat(300) })!.length).toBeLessThanOrEqual(120)
})

test('an empty subject leaves the bubble alone', async () => {
	expect(actionText('Read', {})).toBeUndefined()
	expect(actionText('Read', { file_path: '/' })).toBeUndefined()
	expect(actionText('Read', { file_path: '/repo/dir/' })).toBe('Reading dir')
	expect(actionText('Bash', { command: '' })).toBeUndefined()
	expect(actionText('Grep', { pattern: '' })).toBeUndefined()
	expect(actionText('Skill', {})).toBeUndefined()
})

test('mcp tool names and url userinfo read cleanly', async () => {
	expect(actionText('mcp__ccd_session__mark_chapter', {})).toBe('Using mark chapter')
	expect(actionText('mcp__plugin_claude-mem_mcp-search____IMPORTANT', {})).toBe('Using IMPORTANT')
	expect(actionText('WebFetch', { url: 'https://user:token@example.com/x' })).toBe('Reading example.com')
})

test('the task tools change nothing: the steps line already shows them', async () => {
	for (const tool of ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) expect(actionText(tool, {})).toBeUndefined()
})

test('an agent always gets the same phrase, from the list for how it ended', async () => {
	expect(phraseFor('a1', 'done')).toBe(phraseFor('a1', 'done'))
	const done = new Set(['a1', 'a2', 'a3', 'main', 'agent-77'].map(id => phraseFor(id, 'done')))
	expect(done.size).toBeGreaterThan(1)
	for (const phrase of done) expect(phrase.length).toBeGreaterThan(0)
	expect(['Hit a snag', 'Ran out of road', 'Taking a breather', 'Not this time']).toContain(phraseFor('a1', 'stopped'))
})

test('the panel keeps beating while a just-finished agent still shows its phrase', async () => {
	const ended = [
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Go' },
		{ kind: 'turnEnd', at: 2000, isAborted: false, reason: 'answer' }
	].reduce((state, ev) => reduce(state, ev as CrewEvent), EMPTY_STATE)
	expect(isCheering(ended, 2000 + BUBBLE_MS + 1000)).toBe(true)
	// Two beats past the bubble, so the redraw that clears it still comes.
	expect(isCheering(ended, 2000 + BUBBLE_MS + 2000)).toBe(false)
	expect(isCheering(EMPTY_STATE, 2000)).toBe(false)
})
