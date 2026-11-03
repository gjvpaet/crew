# Crew speech bubbles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each agent card in the Crew Agents panel shows a speech bubble over its Pip. While the agent runs, the bubble says what it's doing now. For 6 seconds after it ends, the bubble shows a success phrase, or a gentle line if it stopped.

**Architecture:**
- A pure `hooks/bubble.ts` turns a tool call into bubble text and picks the phrases.
- The tracker stores each agent's latest action (`AgentRecord.action`) from a new `action` event, which `register.tsx` dispatches before each tool call runs.
- `view.ts` derives `bubble` and `bubbleTone` for each card.
- `panel.tsx` stacks the bubble above the card's usual row: an SVG from the new `bubbleSvg` in `svg.ts` on graphical surfaces, a `▸` line in the terminal.
- The redraw ticker keeps a once-a-second beat going while a finished agent's bubble is up.

**Tech Stack:** a Claude Code mod in TypeScript and TSX: `$.state` atoms, `ui.render`, and Svg elements. Tests use the `claude-code/testing` kit, run with `sh scripts/test-one.sh <file>`.

**Spec:** `docs/2026-11-03-crew-speech-bubbles-design.md`

---

## Ground rules for every task

- **Repository:** `/Users/gabpaet/Documents/Applications/claude-mods/crew`. Work only in the worktree you're given.
- **Code style:** tabs, single quotes, no semicolons, and a one-line comment only for a "why" the code can't show. Match the surrounding code.
- **Run only the named test files,** one run at a time: `sh scripts/test-one.sh <file>.test.ts` (it runs from a scratch copy, so it's safe to repeat).
- **Validate the mod after code changes:** `~/.bun/bin/bun x claude plugin validate .`. Expect `✔ Validation passed with warnings`.
- **Commit from the worktree, with this identity and no `Co-Authored-By:` line:**
  ```bash
  GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "<message>"
  ```
  The user's global gitconfig has a line that breaks some git commands, so always pass `GIT_CONFIG_GLOBAL=/dev/null`.
- **Never use `git stash`.**

## File map

| File | Responsibility | Task |
| --- | --- | --- |
| `hooks/bubble.ts` (new) | `actionText`, `phraseFor`, `BUBBLE_MS`, `isCheering` | 1 |
| `test/bubble.test.ts` (new) | tests for the above | 1 |
| `types/index.d.ts` | `AgentRecord.action` | 2 |
| `hooks/tracker.ts` | the `action` event and its reducer | 2 |
| `test/tracker.test.ts` | the `action` event's tests | 2 |
| `hooks/svg.ts` | `bubbleSvg`, `BUBBLE_TONES`, `BubbleTone` | 3 |
| `test/svg.test.ts` | `bubbleSvg` tests | 3 |
| `hooks/view.ts` | `RowView.bubble` and `bubbleTone` | 4 |
| `hooks/register.tsx` | dispatches `action` before a tool runs; the ticker beats while a bubble is up | 4 |
| `test/view.test.ts`, `test/ui.test.ts` | view bubble tests; the redraw test updated | 4 |
| `hooks/panel.tsx` | draws the bubble row, and counts it in the drawing budget | 5 |
| `test/ui.test.ts` | the panel bubble tests | 5 |

**Waves:** Tasks 1, 2 and 3 run in parallel; then Task 4; then Task 5.

---

### Task 1: bubble text and phrases

**Files:**
- Create: `hooks/bubble.ts`
- Test: `test/bubble.test.ts`

**Depends on:** none

- [ ] **Step 1: Write the failing test** in `test/bubble.test.ts`:

```ts
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

test('the task tools change nothing: the steps line already shows them', async () => {
	for (const tool of ['TodoWrite', 'TaskCreate', 'TaskUpdate']) expect(actionText(tool, {})).toBeUndefined()
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
	expect(isCheering(ended, 2000 + BUBBLE_MS)).toBe(true)
	// One beat past the bubble, so the redraw that clears it still comes.
	expect(isCheering(ended, 2000 + BUBBLE_MS + 1000)).toBe(false)
	expect(isCheering(EMPTY_STATE, 2000)).toBe(false)
})
```

- [ ] **Step 2: Run it to make sure it fails.**

Run: `sh scripts/test-one.sh bubble.test.ts`
Expected: FAIL, because `../hooks/bubble` can't be resolved.

- [ ] **Step 3: Write `hooks/bubble.ts`:**

```ts
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
```

- [ ] **Step 4: Run the tests and make sure they pass.**

Run: `sh scripts/test-one.sh bubble.test.ts`
Expected: `4 pass`, `0 fail`.

- [ ] **Step 5: Commit.**

```bash
git add hooks/bubble.ts test/bubble.test.ts
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "feat: speech bubble text from tool calls, and the finished phrases"
```

---

### Task 2: the tracker remembers each agent's latest action

**Files:**
- Modify: `types/index.d.ts` (`AgentRecord`, around line 30)
- Modify: `hooks/tracker.ts` (the `CrewEvent` union around line 37, a new reducer function before `reduce`, and the `switch` in `reduce`)
- Test: `test/tracker.test.ts` (append at the end)

**Depends on:** none

- [ ] **Step 1: Write the failing test.** Append to `test/tracker.test.ts`. The file already defines `run` and `spawn`:

```ts
test('an action event keeps the agent’s latest action, and a later one replaces it', async () => {
	const state = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build it' },
		spawn('a1', 'Implement Task 1'),
		{ kind: 'action', agentId: 'a1', text: 'Reading band.tsx' },
		{ kind: 'action', agentId: 'a1', text: 'Editing band.tsx' },
		{ kind: 'action', text: 'Running bun test' }
	])
	expect(state.agents.a1?.action).toBe('Editing band.tsx')
	expect(state.agents[MAIN]?.action).toBe('Running bun test')
})

test('an action for an agent not on the board changes nothing, and a new prompt starts Main without one', async () => {
	const before = run([{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build it' }])
	expect(reduce(before, { kind: 'action', agentId: 'ghost', text: 'Reading x.ts' })).toBe(before)
	const next = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build it' },
		{ kind: 'action', text: 'Reading x.ts' },
		{ kind: 'turnEnd', at: 2000, isAborted: false, reason: 'answer' },
		{ kind: 'turnStart', at: 3000, turnId: 't2', text: 'Next prompt' }
	])
	expect(next.agents[MAIN]?.action).toBeUndefined()
})
```

- [ ] **Step 2: Run it to make sure it fails.**

Run: `sh scripts/test-one.sh tracker.test.ts`
Expected: the two new tests FAIL, because `action` is `undefined` where a value is expected. The rest pass.

- [ ] **Step 3: Add the field to `AgentRecord` in `types/index.d.ts`,** after `endedAt?: number`:

```ts
	// What it is doing now, from its latest tool call, for the speech bubble on its card.
	action?: string
```

- [ ] **Step 4: Add the event to the `CrewEvent` union in `hooks/tracker.ts`,** after the `touch` line:

```ts
	| { kind: 'action'; agentId?: string; text: string }
```

- [ ] **Step 5: Add the reducer in `hooks/tracker.ts`,** just before `export function reduce`:

```ts
// An agent not on the board has no card for its bubble.
function setAction(state: CrewState, ev: Extract<CrewEvent, { kind: 'action' }>): CrewState {
	const agent = state.agents[ev.agentId ?? MAIN]
	return agent && agent.action !== ev.text ? withAgent(state, { ...agent, action: ev.text }) : state
}
```

Then add a case to the `switch` in `reduce`, after `case 'touch':`:

```ts
		case 'action':
			return setAction(s, ev)
```

A new prompt already builds Main with `newAgent`, so it starts without an `action`. No change is needed in `startTurn`.

- [ ] **Step 6: Run the tests and make sure they pass.**

Run: `sh scripts/test-one.sh tracker.test.ts`
Expected: every test passes, `0 fail`.

- [ ] **Step 7: Commit.**

```bash
git add types/index.d.ts hooks/tracker.ts test/tracker.test.ts
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "feat: the tracker keeps each agent's latest action"
```

---

### Task 3: the bubble SVG

**Files:**
- Modify: `hooks/svg.ts`. Append at the end of the file, after `ruleSvg`. `textEms`, `SHINE_FONT`, `svgOpen`, `num` and `escapeXml` are already defined in this file.
- Test: `test/svg.test.ts`. Add `bubbleSvg` to the import from `'../hooks/svg'`, and append the test.

**Depends on:** none

- [ ] **Step 1: Write the failing test.** Append to `test/svg.test.ts`, and add `bubbleSvg` to its `../hooks/svg` import list:

```ts
test('a speech bubble fits its text, has a tail over Pip and takes its tone’s colours', async () => {
	const short = bubbleSvg('Ta-da!', 'done')
	const long = bubbleSvg('Editing files-pane.tsx', 'running')
	expect(long.width).toBeGreaterThan(short.width)
	expect(short.width).toBeGreaterThanOrEqual(40)
	expect(short.height).toBe(27)
	// The tail's tip points down at the head, below the 20px body.
	expect(short.source).toContain('L 13 26.5')
	expect(short.source).toContain('fill="#C0DD97"')
	expect(short.source).toContain('fill="#173404"')
	expect(long.source).toContain('fill="#F4F4F2"')
	expect(bubbleSvg('Hit a snag', 'stopped').source).toContain('fill="#D3D1C7"')
	// One edge colour on every tone, so it reads on light and dark panels.
	expect(long.source).toContain('stroke="#C7C4BF"')
	expect(bubbleSvg("Searching for '<a>'", 'running').source).toContain('&apos;&lt;a&gt;&apos;')
})
```

- [ ] **Step 2: Run it to make sure it fails.**

Run: `sh scripts/test-one.sh svg.test.ts`
Expected: FAIL, because `bubbleSvg` is not exported.

- [ ] **Step 3: Append to `hooks/svg.ts`:**

```ts
// A speech bubble over a Pip: rounded ends and a tail at its bottom-left, over the head. One path, so its edge runs
// round the tail without a seam; the Cool Greige edge keeps a light bubble readable on a light panel.
export const BUBBLE_TONES = {
	running: { fill: '#F4F4F2', color: '#2C2C2A' },
	done: { fill: '#C0DD97', color: '#173404' },
	stopped: { fill: '#D3D1C7', color: '#444441' }
} as const
export type BubbleTone = keyof typeof BUBBLE_TONES
const BUBBLE = { fontSize: 12, padX: 9, body: 20, tail: 6, edge: '#C7C4BF', minWidth: 40 }

export function bubbleSvg(text: string, tone: BubbleTone): { source: string; width: number; height: number } {
	const { fontSize, padX, body, tail, edge, minWidth } = BUBBLE
	const { fill, color } = BUBBLE_TONES[tone]
	const width = Math.max(minWidth, Math.ceil(textEms(text) * fontSize) + padX * 2)
	const height = body + tail + 1
	const radius = body / 2
	const top = 0.5
	const bottom = body + 0.5
	const left = 0.5 + radius
	const right = width - 0.5 - radius
	const outline =
		`M ${num(left)} ${top} H ${num(right)} A ${radius} ${radius} 0 0 1 ${num(right)} ${bottom} ` +
		`H 22 L 13 ${num(bottom + tail)} L 12 ${bottom} H ${num(left)} A ${radius} ${radius} 0 0 1 ${num(left)} ${top} Z`
	const source =
		`${svgOpen(width, height)}<path d="${outline}" fill="${fill}" stroke="${edge}" stroke-width="1"/>` +
		`<text x="${num(width / 2)}" y="${num(top + radius)}" text-anchor="middle" dominant-baseline="central" ` +
		`font-family="${SHINE_FONT}" font-size="${fontSize}" font-weight="500" fill="${color}">${escapeXml(text)}</text></svg>`
	return { source, width, height }
}
```

- [ ] **Step 4: Run the tests and make sure they pass.**

Run: `sh scripts/test-one.sh svg.test.ts`
Expected: every test passes, `0 fail`.

- [ ] **Step 5: Commit.**

```bash
git add hooks/svg.ts test/svg.test.ts
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "feat: a speech bubble SVG with a tail, in three tones"
```

---

### Task 4: each card's bubble, and the action fed in

**Files:**
- Modify: `hooks/view.ts`:
  - the imports at the top;
  - the `RowView` type (line 76 onward);
  - a new `bubbleOf` function just above `function rowView`;
  - `rowView`'s return object.
- Modify: `hooks/register.tsx`:
  - the imports;
  - `tick` (around line 88);
  - the `tool.call` hook, just after `const input = toolInput(e)` (around line 488).
- Test: `test/view.test.ts` (append), and `test/ui.test.ts` (the test `'the pane and band redraw only while time is counting, five a second while an agent runs'`).

**Depends on:** 1, 2, 3

- [ ] **Step 1: Write the failing view tests.** Append to `test/view.test.ts`. It already defines `STATE`, which has:
  - a turn started at 1000;
  - agents `a1`, `a2` and `a3`;
  - `a1` finished at 20_000.

  Add `import { BUBBLE_MS, phraseFor } from '../hooks/bubble'` to the imports at the top.

```ts
const rowIn = (view: ReturnType<typeof panelView>, id: string) =>
	[view.main, ...view.groups.flatMap(group => group.rows)].find(row => row?.id === id)

test('a running agent’s bubble says what it is doing; with no action yet it has none', async () => {
	const state = reduce(STATE, { kind: 'action', agentId: 'a2', text: 'Editing hero.tsx' })
	const view = panelView(state, {}, 21_000, 20, {})
	expect(rowIn(view, 'a2')?.bubble).toBe('Editing hero.tsx')
	expect(rowIn(view, 'a2')?.bubbleTone).toBe('running')
	expect(rowIn(view, 'a3')?.bubble).toBe('')
})

test('a finished agent shows its phrase for six seconds, then no bubble', async () => {
	// a1 ended at 20_000.
	const during = rowIn(panelView(STATE, {}, 20_000 + BUBBLE_MS - 1, 20, {}), 'a1')
	expect(during?.bubble).toBe(phraseFor('a1', 'done'))
	expect(during?.bubbleTone).toBe('done')
	expect(rowIn(panelView(STATE, {}, 20_000 + BUBBLE_MS, 20, {}), 'a1')?.bubble).toBe('')
})

test('a stopped agent shows a gentle line', async () => {
	const stopped = reduce(STATE, { kind: 'turnEnd', at: 21_000, agentId: 'a2', isAborted: true, reason: 'interrupted' })
	const row = rowIn(panelView(stopped, {}, 22_000, 20, {}), 'a2')
	expect(row?.bubble).toBe(phraseFor('a2', 'stopped'))
	expect(row?.bubbleTone).toBe('stopped')
})
```

- [ ] **Step 2: Run them to make sure they fail.**

Run: `sh scripts/test-one.sh view.test.ts`
Expected: the three new tests FAIL, because `bubble` is `undefined`.

- [ ] **Step 3: Add the bubble to the view in `hooks/view.ts`.**

  - **Imports:** add these two lines next to the existing ones:

    ```ts
    import { BUBBLE_MS, phraseFor } from './bubble'
    import type { BubbleTone } from './svg'
    ```

  - **`RowView`:** add these fields after `pose: Pose`:

    ```ts
    	// The speech bubble over Pip: what it is doing while it runs, a phrase for a few seconds once it ends; '' for none.
    	bubble: string
    	bubbleTone: BubbleTone
    ```

  - **`bubbleOf`:** add this function just above `function rowView`:

    ```ts
    // A sleeping or waiting agent says nothing: its zzz already speaks for it.
    function bubbleOf(agent: AgentRecord, tone: Tone, endedAt: number | undefined, now: number): { text: string; tone: BubbleTone } {
    	if (tone === 'running') return { text: agent.action ?? '', tone: 'running' }
    	const isFresh = endedAt !== undefined && now - endedAt < BUBBLE_MS
    	if (isFresh && tone === 'done') return { text: phraseFor(agent.id, 'done'), tone: 'done' }
    	if (isFresh && tone === 'failed') return { text: phraseFor(agent.id, 'stopped'), tone: 'stopped' }
    	return { text: '', tone: 'running' }
    }
    ```

  - **`rowView`:** after `const pose = POSES[tone]`, add:

    ```ts
    	const bubble = bubbleOf(agent, tone, endedAt, now)
    ```

    In its returned object, after `pose,`, add:

    ```ts
    		bubble: bubble.text,
    		bubbleTone: bubble.tone,
    ```

  `Tone` (exported from `view.ts` itself) and `AgentRecord` (imported from `../types`) are already in scope.

- [ ] **Step 4: Run the view tests and make sure they pass.**

Run: `sh scripts/test-one.sh view.test.ts`
Expected: every test passes, `0 fail`.

- [ ] **Step 5: Update the redraw test in `test/ui.test.ts`.** Main's success bubble now keeps a once-a-second redraw for about 7 seconds after its turn ends. In `'the pane and band redraw only while time is counting, five a second while an agent runs'`, replace the last two lines:

```ts
	await clock.advance(3000)
	expect(redraws).toBe(15)
```

with:

```ts
	// Main's success bubble keeps a once-a-second redraw going until it has been cleared, then everything stops.
	await clock.advance(10_000)
	const cheered = redraws - 15
	expect(cheered).toBeGreaterThanOrEqual(6)
	expect(cheered).toBeLessThanOrEqual(8)
	await clock.advance(3000)
	expect(redraws).toBe(15 + cheered)
```

- [ ] **Step 6: Run it to make sure it fails.**

Run: `sh scripts/test-one.sh ui.test.ts`
Expected: that test FAILS, with `cheered` at 0, because `register.tsx` doesn't beat for the bubble yet.

- [ ] **Step 7: Feed the action in, and beat while a bubble shows, in `hooks/register.tsx`.**

  - **Imports:** add this line next to the other `./…` imports:

    ```ts
    import { actionText, isCheering } from './bubble'
    ```

  - **`tick`:** change the last condition in `isDue` from:

    ```ts
    		(beat % BEATS_PER_SECOND === 0 && isTicking(state))
    ```

    to:

    ```ts
    		(beat % BEATS_PER_SECOND === 0 && (isTicking(state) || isCheering(state, now)))
    ```

  - **The `tool.call` hook:** directly after the line `const input = toolInput(e)`, add:

    ```ts
    		// Before the call runs, so the bubble reads as what the agent is doing now.
    		const action = actionText(tool, input)
    		if (action) await apply($, { kind: 'action', agentId: e.agentId, text: action })
    ```

  Crew's own two tools (`open_panel` and `set_mascot`) return earlier in the hook, so they never reach this line.

- [ ] **Step 8: Run the touched tests, one file at a time.**

Run: `sh scripts/test-one.sh ui.test.ts`, then `sh scripts/test-one.sh view.test.ts`, then `sh scripts/test-one.sh files-pane.test.ts`
Expected: each run ends with `0 fail`.

- [ ] **Step 9: Validate the mod.**

Run: `~/.bun/bin/bun x claude plugin validate .`
Expected: `✔ Validation passed with warnings`

- [ ] **Step 10: Commit.**

```bash
git add hooks/view.ts hooks/register.tsx test/view.test.ts test/ui.test.ts
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "feat: each card knows its bubble, fed from the agent's tool calls"
```

---

### Task 5: draw the bubble on the card

**Files:**
- Modify: `hooks/panel.tsx`:
  - the imports;
  - `COST` (line 53);
  - `agentCard` (around line 195);
  - `cardCost` (around line 290).
- Modify: `test/ui.test.ts`:
  - make `startTwoAgents` return its clock;
  - add the panel bubble tests.

**Depends on:** 4

- [ ] **Step 1: Make `startTwoAgents` return its clock.** In `test/ui.test.ts`, inside `async function startTwoAgents($: any, on: any)`, change `mock.clock(on, { now: 1000 })` to `const clock = mock.clock(on, { now: 1000 })`. Then add `return clock` as the function's last line. Existing callers ignore the result.

- [ ] **Step 2: Write the failing tests.** Append to `test/ui.test.ts`, and add `import { phraseFor } from '../hooks/bubble'` to its imports:

```ts
test('a running agent’s card shows what it is doing in a bubble over Pip, the whole text in its alt', async ($, on) => {
	await startTwoAgents($, on)
	on('tool.call', () => ({ result: {} }))
	await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/band.tsx', agentId: 'a1' } as any)
	await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/a-very-long-file-name-for-the-bubble.tsx', agentId: 'a2' } as any)
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect(await svgs(ui, /^Reading band\.tsx$/)).toHaveLength(1)
	// The card stacks its bubble over its usual row.
	expect((await ui.find({ key: 'row-a1' }))?.props.flexDirection).toBe('column')
	expect(await ui.find({ key: 'bubble-a1' })).toBeDefined()
	// A long action is shortened in the drawing, never in its alt.
	const [long] = await svgs(ui, /^Reading a-very-long-file-name-for-the-bubble\.tsx$/)
	expect(String(long?.props.source)).toContain('…')
	await ui.unmount()
	const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
	expect(await terminal.find({ type: 'Text', text: '▸ Reading band.tsx' })).toBeDefined()
	await terminal.unmount()
})

test('a card with nothing to say keeps its single row', async ($, on) => {
	await startTwoAgents($, on)
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	expect((await ui.find({ key: 'row-a1' }))?.props.flexDirection).toBe('row')
	expect(await ui.find({ key: 'bubble-a1' })).toBeUndefined()
	await ui.unmount()
})

test('a finished agent cheers for six seconds, then its bubble goes', async ($, on) => {
	const clock = await startTwoAgents($, on)
	await $.turn.complete({ turnId: 's', agentId: 'a1', answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as any)
	const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
	const phrase = phraseFor('a1', 'done')
	expect(await svgs(ui, new RegExp(`^${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))).toHaveLength(1)
	await clock.advance(7000)
	expect(await ui.find({ key: 'bubble-a1' })).toBeUndefined()
	await ui.unmount()
})
```

- [ ] **Step 3: Run them to make sure they fail.**

Run: `sh scripts/test-one.sh ui.test.ts`
Expected: the new bubble tests FAIL, because no bubble Svg and no `bubble-a1` are drawn. "Keeps its single row" may already pass.

- [ ] **Step 4: Draw the bubble in `hooks/panel.tsx`.**

  - **Imports:** change `import { barSvg, pipHeight, pipSvg, pipWidth } from './svg'` to:

    ```ts
    import { barSvg, bubbleSvg, pipHeight, pipSvg, pipWidth } from './svg'
    ```

    Change `import { showFiles } from './files-pane'` to:

    ```ts
    import { showFiles } from './files-pane'
    import { clipName } from './files'
    ```

  - **Constants:** after the `COST` object, add:

    ```ts
    // Past this many letters a bubble's drawing is shortened in the middle; its alt keeps the whole text.
    const BUBBLE_LETTERS = 28
    ```

    Add `bubble: { nodes: 3 }` as the last entry of `COST`, after `group`, so it reads:

    ```ts
    	group: { chars: 120, nodes: 4 },
    	bubble: { nodes: 3 }
    ```

  - **`agentCard`:** replace the whole `const agentCard = (row: RowView) => { … }` function, from its first line to its closing `}`, with the code below. The border logic, the text column and the side column are unchanged; they're only gathered into `parts`.

```tsx
		// The bubble over Pip: an SVG where the surface draws one, a dim line in the terminal.
		const bubbleArt = (row: RowView) =>
			Svg && row.bubble ? bubbleSvg(clipName(row.bubble, BUBBLE_LETTERS), row.bubbleTone) : undefined
		const bubbleRow = (row: RowView) => {
			const art = bubbleArt(row)
			return (
				<Box key={`bubble-${row.id}`} flexDirection="row">
					{art && Svg ? (
						<Svg source={art.source} alt={row.bubble} width={art.width} height={art.height} />
					) : (
						<Text wrap="truncate-end" {...(row.bubbleTone === 'done' ? { color: TONE.done } : { dimColor: true })}>
							{`▸ ${row.bubble}`}
						</Text>
					)}
				</Box>
			)
		}

		const agentCard = (row: RowView) => {
			const arrival = motion.arrivals[row.id]
			// Just moved here: lit in its accent and sliding in from the right. Otherwise a running card's border breathes
			// in its accent, and every other card keeps the surface's own border.
			const border = arrival?.isLit
				? { borderColor: row.accent }
				: row.pulse === null
					? {}
					: { borderColor: pulseColor(row.accent, row.pulse, Svg ? 'graphical' : 'terminal') }
			const frame = { borderStyle: 'round', ...border, paddingX: 1, marginBottom: 1, marginLeft: arrival?.slide ?? 0 } as const
			const parts = [
				mascot(row),
				// width 0 + flexGrow 1: the text column takes what the mascot and the side column leave, and no more.
				<Box flexDirection="column" flexGrow={1} width={0}>
					<Box flexDirection="row" gap={1}>
						{/* The title gives way first; Main's waiting note keeps its width beside it. */}
						<Box flexShrink={1}>
							<Text weight="semibold" wrap="truncate-end">
								{row.title}
							</Text>
						</Box>
						{row.waiting && (
							<Box flexShrink={0}>
								<Text color={TONE[row.tone]}>{row.waiting}</Text>
							</Box>
						)}
						{/* The spacer pushes the chevron to the row's right end, past the waiting note. */}
						{row.fileCount > 0 && <Box flexGrow={1} />}
						{row.fileCount > 0 && (
							<Box flexShrink={0}>
								<Button key={`files-${row.id}`} {...chevronProps(row)} onPress={() => showFiles($, row.id)} />
							</Box>
						)}
					</Box>
					{/* One Text, so the whole line truncates as a unit instead of wrapping a piece into the next column. */}
					<Text dimColor wrap="truncate-end">
						{row.effort && (
							<Text {...(row.effortTone ? { color: row.effortTone } : {})}>{`${row.effort} · `}</Text>
						)}
						{`${row.model} · ${row.usageText}${row.aside ? ` · ${row.aside}` : ''}`}
					</Text>
					{row.steps && <Text wrap="truncate-end">{row.steps}</Text>}
					{progress(row)}
				</Box>,
				// The time and its mark in a column of their own, so the text column (and the bar) end where it begins.
				<Box flexDirection="row" gap={1} flexShrink={0}>
					<Text dimColor tabular>
						{row.elapsed}
					</Text>
					{row.badge && <Text color={TONE[row.tone]}>{row.badge}</Text>}
				</Box>
			]
			// With a bubble the card stacks it over its usual row, so it sits on Pip's head; without one it is that row.
			return row.bubble ? (
				<Box key={`row-${row.id}`} flexDirection="column" {...frame}>
					{bubbleRow(row)}
					<Box flexDirection="row" gap={1}>
						{parts[0]}
						{parts[1]}
						{parts[2]}
					</Box>
				</Box>
			) : (
				<Box key={`row-${row.id}`} flexDirection="row" gap={1} {...frame}>
					{parts[0]}
					{parts[1]}
					{parts[2]}
				</Box>
			)
		}
```

  - **`cardCost`:** count the bubble in the drawing budget. Replace the body of `const cardCost = (row: RowView): Cost => { … }` with:

```ts
			const svg = Svg ? sourcesOf(row) : { mascot: '', bar: '' }
			const text = row.title.length + row.steps.length + row.usageText.length
			const bubble = bubbleArt(row)
			return {
				chars:
					COST.card.chars + svg.mascot.length + svg.bar.length + text + (bubble ? bubble.source.length + row.bubble.length : 0),
				nodes: COST.card.nodes + (row.bubble ? COST.bubble.nodes : 0)
			}
```

  `lineRow`, the one-line fallback once the budget runs out, stays as it is, with no bubble.

- [ ] **Step 5: Run the touched tests, one file at a time.**

Run: `sh scripts/test-one.sh ui.test.ts`, then `sh scripts/test-one.sh view.test.ts`
Expected: each run ends with `0 fail`. This includes the existing drawing-budget test, `desktopMeasure`, whose 56 just-finished agents now all carry a success bubble.

- [ ] **Step 6: Validate the mod.**

Run: `~/.bun/bin/bun x claude plugin validate .`
Expected: `✔ Validation passed with warnings`

- [ ] **Step 7: Commit.**

```bash
git add hooks/panel.tsx test/ui.test.ts
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email=gjvpaet@gmail.com commit -m "feat: agent cards show a speech bubble over Pip"
```

---

## After the last task

Run each test file on its own, one after another:

`bubble`, `tracker`, `svg`, `view`, `ui`, `files-pane`, `files`, `format`, `mascot`, `pricing`, `roles`, `sprite` and `tasks` (`sh scripts/test-one.sh <name>.test.ts`).

Then validate the mod once more. The look in the Desktop app can't be checked from tests: the user checks it after `/reload-plugins`.
