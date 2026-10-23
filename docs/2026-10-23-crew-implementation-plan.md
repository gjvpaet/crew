# Crew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Crew mod: a progress band above the prompt and a live Agents pane showing each sub-agent's model, effort, tokens, ≈cost, context % and elapsed time, each with an original pixel mascot.

**Architecture:** A single hooks module (`hooks/register.tsx`) turns engine events (`turn.start`, `agent.spawn`, `turn.step`, `turn.complete`, `tool.call`) into `CrewEvent`s. A pure reducer (`tracker.ts`) folds them into one `CrewState` kept in `$.state`. Pure view builders (`view.ts`) turn that state into display strings. Two thin `ui.render` hooks (`band.tsx`, `panel.tsx`) draw them. Mascot restyles go through a tool the model can call (`mcp__crew__set_mascot`) and persist in `$.store`.

**Tech Stack:** Claude Code mods (function hooks), Claude Code 2.1.308. TypeScript ES modules with no build step (the engine loads `.ts`/`.tsx` directly). Tests use `claude-code/testing` under `claude plugin test`. No npm dependencies.

**Spec:** `docs/2026-10-23-crew-progress-design.md`. Task 11 updates the spec for the deviations below, which the API research turned up.

| Spec said | Plan does | Why |
|---|---|---|
| Plain JS, `node:test` | TypeScript, `claude plugin test` | The mod test runner only runs `*.test.ts(x)` against the real engine, and the `$.state` contract is a `.d.ts` that `claude plugin validate` checks. |
| Effort "only if present" | Effort read from every `turn.step` | `TurnStepInput.effort` exists (absent for models without effort). |
| Task list "if observable" | Read from `tool.call` for `TodoWrite`, `TaskCreate`, `TaskUpdate`, `mcp__ccd_turn__update_plan` | `tool.call` sees every tool, with `agentId` for sub-agents. |
| "User asks Claude, which writes `$.store`" | Mod registers the tool `mcp__crew__set_mascot` | Claude cannot write a plugin's store directly. A tool is the supported way for the model to act. |
| ctx % window: 1M for `[1m]`, else 200k | Per-model table (1M for every current model, 200k for Haiku 4.5 and unknown models) | All current models have a 1M context window. |
| Researcher accessory: magnifier | Glasses | A magnifier doesn't read at 8×8. Glasses do. |

**Paths.** `CREW` means `/Users/gabpaet/Documents/Applications/claude-mods/crew` (the git repo). Every command below runs from `CREW` unless it says otherwise.

**Git config workaround.** `~/.gitconfig` has an empty `format =` under `[gpg]`, so every git command fails. Fix that line first, or run each commit as:

```bash
GIT_CONFIG_GLOBAL=/dev/null git -c user.name="Gabriel Joshua Paet" -c user.email="gabriel.paet@lumora.capital" commit -m "..."
```

(and `GIT_CONFIG_GLOBAL=/dev/null git add ...` for adds).

**API authority.** The types file `/private/tmp/claude-501/bundled-skills/2.1.308/01617630127116e9953a62b205d940ac/plugin-authoring/types/claude-code.d.ts` is the authority. After the first load, the same file is at `CREW/.claude-plugin/types/claude-code/index.d.ts`. When `claude plugin validate` or `claude plugin test` rejects a shape, grep that file for the name it reports, fix the code, and carry on.

**Test runner.** `claude plugin test CREW` runs every `*.test.ts(x)` under the folder. Run the whole suite each time, because it's fast.

---

## File structure

| File | Responsibility |
|---|---|
| `.claude-plugin/plugin.json` | Manifest: name, version, description, contract path |
| `hooks/hooks.json` | Names the one hooks module |
| `types/index.d.ts` | Shared types and the `$.state` contract (`PluginState['crew']`) |
| `hooks/format.ts` | Pure string formatting: tokens, ≈$, durations, %, bars, shimmer, truncate, pretty model names |
| `hooks/pricing.ts` | Price table (as of 2026-10-06), `priceFor`, `estimateUsd`, `contextWindow` |
| `hooks/roles.ts` | `roleFor({ type, description })` |
| `hooks/tasks.ts` | Applies task-list tool calls to a `TaskItem[]`; `taskProgress` |
| `hooks/tracker.ts` | `CrewEvent`, `EMPTY_STATE`, the `reduce` reducer, selectors |
| `hooks/sprite.ts` | The original 8×8 "Pip" sprite, accessory overlays, half-block cells |
| `hooks/mascot.ts` | `set_mascot` tool spec, input parsing, applying a change to prefs |
| `hooks/state.ts` | The four `atom`s the module reads and writes |
| `hooks/view.ts` | `bandLine` and `panelView`: state → display strings (pure) |
| `hooks/band.tsx` | `registerBand(on)`: the `AbovePrompt` render hook |
| `hooks/panel.tsx` | `registerPanel(on)`: the `Pane` render hook |
| `hooks/register.tsx` | Wires events → tracker, registers command and tool, mounts the band and panel |
| `test/*.test.ts` | One test file per pure module, plus `ui.test.ts` for the drawn band and pane |
| `.gitignore` | Ignores `.claude-plugin/types/`, which the engine writes |
| `../.claude-plugin/marketplace.json` | A local marketplace (outside the repo) used to install Crew |

---

### Task 1: Scaffold the plugin

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `hooks/hooks.json`
- Create: `hooks/register.tsx`
- Create: `types/index.d.ts`
- Create: `.gitignore`

- [ ] **Step 1: Write the manifest**

`.claude-plugin/plugin.json`:

```json
{
	"name": "crew",
	"version": "0.1.0",
	"description": "Progress band above the prompt and a live Agents pane with model, tokens and estimated cost per sub-agent.",
	"types": "./types/index.d.ts"
}
```

- [ ] **Step 2: Write the hooks manifest**

`hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

- [ ] **Step 3: Write the contract**

`types/index.d.ts`:

```ts
export type Role = 'developer' | 'designer' | 'researcher' | 'reviewer' | 'plain'

export type Accessory = 'headset' | 'beret' | 'glasses' | 'hardhat' | 'none'

export type MascotStyle = { accessory?: Accessory; body?: string; accent?: string }

export type MascotPrefs = Partial<Record<Role, MascotStyle>>

export type AgentStatusView =
	| 'pending'
	| 'running'
	| 'waiting'
	| 'idle'
	| 'completed'
	| 'failed'
	| 'killed'
	| 'stopped'

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Steps = { done: number; total: number; current?: string }

export type TaskItem = { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }

export type AgentRecord = {
	id: string
	description: string
	type: string
	role: Role
	model?: string
	effort?: string
	status: AgentStatusView
	parentId?: string
	spawnedAt: number
	endedAt?: number
	usage: Usage
	lastRequestInput: number
	steps?: Steps
}

export type TurnInfo = {
	id: string
	label: string
	startedAt: number
	endedAt?: number
	isAborted: boolean
}

export type CrewState = {
	turn: TurnInfo | null
	agents: Record<string, AgentRecord>
	order: string[]
	tasks: TaskItem[]
	agentTasks: Record<string, TaskItem[]>
	sessionByModel: Record<string, Usage>
}

declare module 'claude-code' {
	interface PluginState {
		crew: {
			model: CrewState
			isBandHidden: boolean
			isFinishedOpen: boolean
			mascots: MascotPrefs
		}
	}
}
```

- [ ] **Step 4: Write an empty hooks module so the plugin loads**

`hooks/register.tsx`:

```tsx
import type { Register } from 'claude-code'

export const register: Register = () => {}
```

- [ ] **Step 5: Ignore engine-written types**

`.gitignore`:

```
.claude-plugin/types/
.DS_Store
```

- [ ] **Step 6: Validate**

Run: `claude plugin validate /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: the manifest and module are read with no errors. It reports no hooks yet.

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin/plugin.json hooks/hooks.json hooks/register.tsx types/index.d.ts .gitignore
git commit -m "chore: scaffold crew mod"
```

---

### Task 2: Formatting helpers

**Files:**
- Create: `hooks/format.ts`
- Test: `test/format.test.ts`

- [ ] **Step 1: Write the failing test**

`test/format.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import {
	bar,
	fmtDuration,
	fmtPercent,
	fmtTokens,
	fmtUsd,
	prettyModel,
	shimmer,
	truncate
} from '../hooks/format'

test('fmtTokens rounds to k and M', async () => {
	expect(fmtTokens(950)).toBe('950')
	expect(fmtTokens(1000)).toBe('1k')
	expect(fmtTokens(1500)).toBe('1.5k')
	expect(fmtTokens(13_500)).toBe('14k')
	expect(fmtTokens(254_000)).toBe('254k')
	expect(fmtTokens(2_100_000)).toBe('2.1M')
})

test('fmtUsd always reads as an estimate', async () => {
	expect(fmtUsd(null)).toBe('≈?')
	expect(fmtUsd(0)).toBe('≈$0.00')
	expect(fmtUsd(0.004)).toBe('≈<$0.01')
	expect(fmtUsd(0.0812)).toBe('≈$0.08')
	expect(fmtUsd(1.5)).toBe('≈$1.50')
})

test('fmtDuration is m:ss, or h:mm:ss past an hour', async () => {
	expect(fmtDuration(41_000)).toBe('0:41')
	expect(fmtDuration(61_000)).toBe('1:01')
	expect(fmtDuration(3_725_000)).toBe('1:02:05')
	expect(fmtDuration(-5)).toBe('0:00')
})

test('fmtPercent clamps and rounds', async () => {
	expect(fmtPercent(0.5)).toBe('50%')
	expect(fmtPercent(0.666)).toBe('67%')
	expect(fmtPercent(1.4)).toBe('100%')
})

test('bar fills by fraction and clamps', async () => {
	expect(bar(0.5, 10)).toBe('█████░░░░░')
	expect(bar(1.2, 4)).toBe('████')
	expect(bar(-1, 3)).toBe('░░░')
})

test('shimmer moves a three-cell highlight with time', async () => {
	expect(shimmer(5, 0)).toBe('░░░░░')
	expect(shimmer(5, 600)).toBe('▓▓▓░░')
})

test('truncate ends with an ellipsis', async () => {
	expect(truncate('abcdefgh', 5)).toBe('abcd…')
	expect(truncate('abc', 5)).toBe('abc')
	expect(truncate('abc', 1)).toBe('…')
})

test('prettyModel names the family and version', async () => {
	expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
	expect(prettyModel('claude-sonnet-4-6[1m]')).toBe('Sonnet 4.6 1M')
	expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
	expect(prettyModel('claude-opus-5')).toBe('Opus 5')
	expect(prettyModel('gpt-4o')).toBe('gpt-4o')
	expect(prettyModel(undefined)).toBe('model ?')
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: FAIL, because `../hooks/format` can't be resolved.

- [ ] **Step 3: Implement**

`hooks/format.ts`:

```ts
const trimZero = (text: string) => text.replace(/\.0$/, '')

export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export function fmtTokens(count: number): string {
	if (count < 1000) return String(count)
	if (count < 10_000) return `${trimZero((count / 1000).toFixed(1))}k`
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`
	return `${trimZero((count / 1_000_000).toFixed(1))}M`
}

export function fmtUsd(value: number | null): string {
	if (value === null) return '≈?'
	if (value > 0 && value < 0.01) return '≈<$0.01'
	return `≈$${value.toFixed(2)}`
}

export function fmtDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000))
	const hours = Math.floor(total / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const seconds = String(total % 60).padStart(2, '0')
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

export const fmtPercent = (fraction: number) => `${Math.round(clamp(fraction, 0, 1) * 100)}%`

export function bar(fraction: number, width: number): string {
	const filled = Math.round(clamp(fraction, 0, 1) * width)
	return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function shimmer(width: number, now: number): string {
	const head = (Math.floor(now / 200) % (width + 3)) - 3
	let out = ''
	for (let i = 0; i < width; i++) out += i >= head && i < head + 3 ? '▓' : '░'
	return out
}

export function truncate(text: string, max: number): string {
	if (max <= 1) return '…'
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

const FAMILY = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/

export function prettyModel(model?: string): string {
	if (!model) return 'model ?'
	const match = FAMILY.exec(model.toLowerCase())
	if (!match) return model
	const name = match[1][0].toUpperCase() + match[1].slice(1)
	const version = match[3] ? `${match[2]}.${match[3]}` : match[2]
	return `${name} ${version}${/\[1m\]/i.test(model) ? ' 1M' : ''}`
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add hooks/format.ts test/format.test.ts
git commit -m "feat: formatting helpers"
```

---

### Task 3: Price table

**Files:**
- Create: `hooks/pricing.ts`
- Test: `test/pricing.test.ts`

Prices are per million tokens, from the Claude API reference cached 2026-10-06:
- **Cache writes** use the 5-minute rate (1.25 × input), because `ModelUsage` reports cache writes as one total.
- **Cache reads** are 0.1 × input, except Fable 5.1 / Mythos 5.1 ($0.25) and Opus 5.5 ($0.20).
- **Haiku 5.5** uses its ≤100K-prompt rate.

- [ ] **Step 1: Write the failing test**

`test/pricing.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { contextWindow, estimateUsd, priceFor } from '../hooks/pricing'

const ONLY_INPUT = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
const micro = (value: number | null) => (value === null ? null : Math.round(value * 1_000_000))

test('every token type is priced', async () => {
	const usage = { input: 10_000, output: 2_000, cacheRead: 100_000, cacheWrite: 20_000 }
	expect(micro(estimateUsd(usage, 'claude-opus-5-5'))).toBe(200_000)
})

test('the longest matching model id wins', async () => {
	expect(estimateUsd(ONLY_INPUT, 'claude-opus-5-5')).toBe(4)
	expect(estimateUsd(ONLY_INPUT, 'claude-opus-5')).toBe(5)
	expect(estimateUsd(ONLY_INPUT, 'claude-fable-5-1')).toBe(10)
})

test('suffixes, prefixes and aliases resolve', async () => {
	expect(estimateUsd(ONLY_INPUT, 'claude-opus-5-5[1m]')).toBe(4)
	expect(estimateUsd(ONLY_INPUT, 'us.anthropic.claude-sonnet-4-6')).toBe(3)
	expect(estimateUsd(ONLY_INPUT, 'sonnet')).toBe(2)
	expect(estimateUsd(ONLY_INPUT, 'haiku')).toBe(0.1)
})

test('an unknown model has no price', async () => {
	expect(priceFor('gpt-x')).toBeUndefined()
	expect(estimateUsd(ONLY_INPUT, 'gpt-x')).toBeNull()
})

test('context windows come from the table, 200k when unknown', async () => {
	expect(contextWindow('claude-opus-5-5')).toBe(1_000_000)
	expect(contextWindow('claude-haiku-4-5')).toBe(200_000)
	expect(contextWindow('mystery')).toBe(200_000)
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: FAIL, because `../hooks/pricing` can't be resolved.

- [ ] **Step 3: Implement**

`hooks/pricing.ts`:

```ts
import type { Usage } from '../types'

export type Price = {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	contextWindow: number
}

export const PRICES_AS_OF = '2026-10-06'

const MILLION = 1_000_000
const DEFAULT_CONTEXT = 200_000

const price = (input: number, output: number, cacheRead: number, window = 1_000_000): Price => ({
	input,
	output,
	cacheRead,
	cacheWrite: input * 1.25,
	contextWindow: window
})

const ROWS: Array<[string, Price]> = [
	['claude-fable-5-1', price(10, 50, 0.25)],
	['claude-mythos-5-1', price(10, 50, 0.25)],
	['claude-fable-5', price(10, 50, 1)],
	['claude-opus-5-5', price(4, 20, 0.2)],
	['claude-opus-5', price(5, 25, 0.5)],
	['claude-opus-4-8', price(5, 25, 0.5)],
	['claude-opus-4-7', price(5, 25, 0.5)],
	['claude-opus-4-6', price(5, 25, 0.5)],
	['claude-sonnet-5-5', price(2, 10, 0.2)],
	['claude-sonnet-5', price(2, 10, 0.2)],
	['claude-sonnet-4-6', price(3, 15, 0.3)],
	['claude-haiku-5-5', price(0.1, 0.5, 0.01)],
	['claude-haiku-4-5', price(1, 5, 0.1, 200_000)]
]

const TABLE = [...ROWS].sort((a, b) => b[0].length - a[0].length)

const ALIASES: Record<string, string> = {
	fable: 'claude-fable-5-1',
	opus: 'claude-opus-5-5',
	sonnet: 'claude-sonnet-5-5',
	haiku: 'claude-haiku-5-5'
}

export function priceFor(model: string): Price | undefined {
	const id = model.toLowerCase().replace(/\[1m\]$/, '').trim()
	const resolved = ALIASES[id] ?? id
	return TABLE.find(([prefix]) => resolved.includes(prefix))?.[1]
}

export function estimateUsd(usage: Usage, model: string): number | null {
	const rate = priceFor(model)
	if (!rate) return null
	return (
		(usage.input * rate.input +
			usage.output * rate.output +
			usage.cacheRead * rate.cacheRead +
			usage.cacheWrite * rate.cacheWrite) /
		MILLION
	)
}

export const contextWindow = (model: string) => priceFor(model)?.contextWindow ?? DEFAULT_CONTEXT
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: PASS, 13 tests in total.

- [ ] **Step 5: Commit**

```bash
git add hooks/pricing.ts test/pricing.test.ts
git commit -m "feat: price table as of 2026-10-06"
```

---

### Task 4: Roles

**Files:**
- Create: `hooks/roles.ts`
- Test: `test/roles.test.ts`

- [ ] **Step 1: Write the failing test**

`test/roles.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { roleFor } from '../hooks/roles'

const general = (description: string) => roleFor({ type: 'general-purpose', description })

test('the agent type wins over the description', async () => {
	expect(roleFor({ type: 'Explore', description: 'Build the thing' })).toBe('researcher')
	expect(roleFor({ type: 'code-reviewer', description: 'Build stuff' })).toBe('reviewer')
	expect(roleFor({ type: 'Plan', description: 'Fix the bug' })).toBe('designer')
})

test('description keywords pick a role', async () => {
	expect(general('Review the whole kit')).toBe('reviewer')
	expect(general('Design the launch graphics')).toBe('designer')
	expect(general('Research competitor launches')).toBe('researcher')
	expect(general('Summarise the notes')).toBe('researcher')
	expect(general('Build the landing page')).toBe('developer')
})

test('nothing recognisable is plain', async () => {
	expect(general('Do the thing')).toBe('plain')
	expect(roleFor({ type: '', description: '' })).toBe('plain')
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: FAIL, because `../hooks/roles` can't be resolved.

- [ ] **Step 3: Implement**

`hooks/roles.ts`:

```ts
import type { Role } from '../types'

const BY_TYPE: Array<[RegExp, Role]> = [
	[/review/, 'reviewer'],
	[/explore|research|guide/, 'researcher'],
	[/plan|design/, 'designer']
]

const BY_DESCRIPTION: Array<[RegExp, Role]> = [
	[/\b(review|audit|verif|check|critique)/, 'reviewer'],
	[/\b(design|ui\b|ux\b|mockup|layout|styl|graphic|visual|brand)/, 'designer'],
	[/\b(research|investigat|explor|search|find|look|read|analy|compar|survey|summar)/, 'researcher'],
	[/\b(build|implement|fix|code|coding|writ|refactor|test|migrat|add|creat|debug|deploy)/, 'developer']
]

export function roleFor({ type, description }: { type: string; description: string }): Role {
	const byType = BY_TYPE.find(([pattern]) => pattern.test(type.toLowerCase()))
	if (byType) return byType[1]
	const byDescription = BY_DESCRIPTION.find(([pattern]) => pattern.test(description.toLowerCase()))
	return byDescription ? byDescription[1] : 'plain'
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: PASS, 16 tests in total.

- [ ] **Step 5: Commit**

```bash
git add hooks/roles.ts test/roles.test.ts
git commit -m "feat: role from agent type and description"
```

---

### Task 5: Task-list parsing

**Files:**
- Create: `hooks/tasks.ts`
- Test: `test/tasks.test.ts`

The tool input shapes come from the types file:
- **`TodoWrite`:** `{ todos: [{ content, status, activeForm }] }`
- **`TaskCreate`:** `{ subject, description }`, with the result `{ task: { id, subject } }`
- **`TaskUpdate`:** `{ taskId, status?, subject? }`, where `status` may be `'deleted'`
- **The Desktop plan tool `mcp__ccd_turn__update_plan`:** `{ items: [{ content, status }] }`, or `{ advance: true }`, or `{ done: number[], start: number }` (1-based)

- [ ] **Step 1: Write the failing test**

`test/tasks.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { applyTaskCall, taskProgress } from '../hooks/tasks'

const PLAN = 'mcp__ccd_turn__update_plan'
const planItems = {
	items: [
		{ content: 'A', status: 'completed' },
		{ content: 'B', status: 'in_progress' },
		{ content: 'C', status: 'pending' }
	]
}

test('TodoWrite replaces the list', async () => {
	const list = applyTaskCall([], {
		tool: 'TodoWrite',
		input: {
			todos: [
				{ content: 'One', status: 'completed', activeForm: 'Doing one' },
				{ content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
				{ content: 'Three', status: 'pending', activeForm: 'Doing three' }
			]
		}
	})
	expect(list?.map(item => item.id)).toEqual(['0', '1', '2'])
	expect(taskProgress(list ?? [])).toEqual({ done: 1, total: 3, current: 'Two' })
})

test('TaskCreate appends with the id from the result, TaskUpdate changes or deletes', async () => {
	const created = applyTaskCall([], {
		tool: 'TaskCreate',
		input: { subject: 'Write tests', description: 'x' },
		result: { task: { id: '7', subject: 'Write tests' } }
	})
	expect(created).toEqual([{ id: '7', title: 'Write tests', status: 'pending' }])
	const started = applyTaskCall(created ?? [], { tool: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' } })
	expect(started?.[0].status).toBe('in_progress')
	const deleted = applyTaskCall(started ?? [], { tool: 'TaskUpdate', input: { taskId: '7', status: 'deleted' } })
	expect(deleted).toEqual([])
	const unknown = applyTaskCall(started ?? [], { tool: 'TaskUpdate', input: { taskId: '99', status: 'completed' } })
	expect(unknown).toEqual(started)
})

test('the Desktop plan tool sets items, advances, and marks by number', async () => {
	const set = applyTaskCall([], { tool: PLAN, input: planItems })
	expect(set?.map(item => item.id)).toEqual(['1', '2', '3'])
	const advanced = applyTaskCall(set ?? [], { tool: PLAN, input: { advance: true } })
	expect(advanced?.map(item => item.status)).toEqual(['completed', 'completed', 'in_progress'])
	const marked = applyTaskCall(set ?? [], { tool: PLAN, input: { done: [3], start: 1 } })
	expect(marked?.map(item => item.status)).toEqual(['in_progress', 'in_progress', 'completed'])
})

test('other tools are not task calls', async () => {
	expect(applyTaskCall([], { tool: 'Bash', input: { command: 'ls' } })).toBeNull()
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: FAIL, because `../hooks/tasks` can't be resolved.

- [ ] **Step 3: Implement**

`hooks/tasks.ts`:

```ts
import type { Steps, TaskItem } from '../types'

export type TaskToolCall = { tool: string; input: Record<string, unknown>; result?: unknown }

export const PLAN_TOOL = 'mcp__ccd_turn__update_plan'

export const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', PLAN_TOOL])

type Status = TaskItem['status']

const asStatus = (value: unknown): Status =>
	value === 'completed' || value === 'in_progress' ? value : 'pending'

const asText = (value: unknown) => (typeof value === 'string' ? value : '')

const asList = (value: unknown): Array<Record<string, unknown>> =>
	Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []

function fromTodoWrite(input: Record<string, unknown>): TaskItem[] {
	return asList(input.todos).map((todo, index) => ({
		id: String(index),
		title: asText(todo.content),
		status: asStatus(todo.status)
	}))
}

function fromTaskCreate(list: readonly TaskItem[], call: TaskToolCall): TaskItem[] {
	const result = call.result as { task?: { id?: unknown } } | undefined
	const id = typeof result?.task?.id === 'string' ? result.task.id : `new-${list.length}`
	return [...list, { id, title: asText(call.input.subject), status: 'pending' }]
}

function fromTaskUpdate(list: readonly TaskItem[], input: Record<string, unknown>): TaskItem[] {
	const id = asText(input.taskId)
	if (input.status === 'deleted') return list.filter(item => item.id !== id)
	return list.map(item =>
		item.id !== id
			? item
			: {
					...item,
					title: typeof input.subject === 'string' ? input.subject : item.title,
					status: input.status === undefined ? item.status : asStatus(input.status)
				}
	)
}

function advance(list: readonly TaskItem[]): TaskItem[] {
	const current = list.findIndex(item => item.status === 'in_progress')
	const marked = list.map((item, index) => (index === current ? { ...item, status: 'completed' as const } : item))
	const nextIndex = marked.findIndex((item, index) => index > current && item.status === 'pending')
	const fallback = nextIndex === -1 ? marked.findIndex(item => item.status === 'pending') : nextIndex
	return marked.map((item, index) => (index === fallback ? { ...item, status: 'in_progress' as const } : item))
}

function fromPlan(list: readonly TaskItem[], input: Record<string, unknown>): TaskItem[] {
	if (Array.isArray(input.items)) {
		return asList(input.items).map((item, index) => ({
			id: String(index + 1),
			title: asText(item.content),
			status: asStatus(item.status)
		}))
	}
	if (input.advance === true) return advance(list)
	const done = new Set(Array.isArray(input.done) ? input.done.filter(n => typeof n === 'number') : [])
	const start = typeof input.start === 'number' ? input.start : -1
	return list.map((item, index) => {
		if (done.has(index + 1)) return { ...item, status: 'completed' as const }
		if (start === index + 1) return { ...item, status: 'in_progress' as const }
		return item
	})
}

export function applyTaskCall(list: readonly TaskItem[], call: TaskToolCall): TaskItem[] | null {
	switch (call.tool) {
		case 'TodoWrite':
			return fromTodoWrite(call.input)
		case 'TaskCreate':
			return fromTaskCreate(list, call)
		case 'TaskUpdate':
			return fromTaskUpdate(list, call.input)
		case PLAN_TOOL:
			return fromPlan(list, call.input)
		default:
			return null
	}
}

export function taskProgress(list: readonly TaskItem[]): Steps {
	const current = list.find(item => item.status === 'in_progress')
	return {
		done: list.filter(item => item.status === 'completed').length,
		total: list.length,
		...(current ? { current: current.title } : {})
	}
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: PASS, 20 tests in total.

- [ ] **Step 5: Commit**

```bash
git add hooks/tasks.ts test/tasks.test.ts
git commit -m "feat: parse task-list tool calls"
```

---

### Task 6: Tracker (reducer and selectors)

**Files:**
- Create: `hooks/tracker.ts`
- Test: `test/tracker.test.ts`

- [ ] **Step 1: Write the failing test**

`test/tracker.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import {
	EMPTY_STATE,
	MAIN,
	contextFraction,
	reduce,
	selectGroups,
	selectProgress,
	selectRunning,
	selectSessionTotals,
	selectTurnTotals,
	type CrewEvent
} from '../hooks/tracker'

const run = (events: CrewEvent[]) => events.reduce(reduce, EMPTY_STATE)
const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, model = 'claude-opus-5-5') => ({
	input_tokens: input,
	output_tokens: output,
	cache_read_input_tokens: cacheRead,
	cache_creation_input_tokens: cacheWrite,
	model
})
const spawn = (agentId: string, description: string, subagentType = 'general-purpose'): CrewEvent => ({
	kind: 'spawn',
	at: 2000,
	agentId,
	description,
	subagentType,
	model: 'claude-opus-5-5'
})

const START: CrewEvent[] = [
	{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build the launch kit\nwith details' },
	spawn('a1', 'Research competitor launches', 'Explore'),
	spawn('a2', 'Design the launch graphics'),
	spawn('a3', 'Build the landing page')
]

test('a turn with three agents starts at 0 of 3', async () => {
	const state = run(START)
	expect(state.turn?.label).toBe('Build the launch kit')
	expect(state.agents[MAIN].description).toBe('Main')
	expect(state.agents.a1.role).toBe('researcher')
	expect(selectProgress(state)).toEqual({ source: 'agents', done: 0, total: 3, fraction: 0 })
	expect(selectRunning(state)).toBe(3)
})

test('steps add usage, model, effort and context size', async () => {
	const state = run([
		...START,
		{ kind: 'step', at: 3000, agentId: 'a1', model: 'claude-opus-5-5', effort: 'high', usage: usage(1000, 500, 10_000, 2000) }
	])
	expect(state.agents.a1.usage).toEqual({ input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 })
	expect(state.agents.a1.effort).toBe('high')
	expect(state.agents.a1.lastRequestInput).toBe(13_000)
	expect(contextFraction(state.agents.a1)).toBe(0.013)
	const totals = selectTurnTotals(state)
	expect(totals.tokens).toBe(13_500)
	expect(Math.round(totals.costUsd * 1_000_000)).toBe(26_000)
	expect(totals.isPartial).toBe(false)
	expect(selectSessionTotals(state).tokens).toBe(13_500)
})

test('ends sort agents into groups and an abort stops the rest', async () => {
	const state = run([
		...START,
		{ kind: 'turnEnd', at: 20_000, agentId: 'a1', isAborted: false, reason: 'answer' },
		{ kind: 'turnEnd', at: 21_000, agentId: 'a2', isAborted: false, reason: 'error' }
	])
	expect(selectProgress(state)).toEqual({ source: 'agents', done: 2, total: 3, fraction: 2 / 3 })
	const groups = selectGroups(state)
	expect(groups.finished.map(a => a.id)).toEqual(['a1'])
	expect(groups.failed.map(a => a.id)).toEqual(['a2'])
	expect(groups.running.map(a => a.id)).toEqual(['a3'])

	const aborted = run([
		...START,
		{ kind: 'turnEnd', at: 30_000, isAborted: true, reason: 'aborted' },
		{ kind: 'statuses', at: 31_000, list: [{ id: 'a3', status: 'completed' }] }
	])
	expect(aborted.agents.a3.status).toBe('stopped')
	expect(aborted.agents.a3.endedAt).toBe(30_000)
	expect(aborted.agents[MAIN].status).toBe('stopped')
	expect(aborted.turn?.isAborted).toBe(true)
})

test('a visible task list drives progress', async () => {
	const state = run([
		...START,
		{
			kind: 'tasks',
			call: {
				tool: 'TodoWrite',
				input: {
					todos: [
						{ content: 'One', status: 'completed', activeForm: 'x' },
						{ content: 'Two', status: 'in_progress', activeForm: 'y' }
					]
				}
			}
		}
	])
	expect(selectProgress(state)).toEqual({ source: 'tasks', done: 1, total: 2, fraction: 0.5 })
})

test('a sub-agent task list becomes its steps', async () => {
	const state = run([
		...START,
		{
			kind: 'tasks',
			agentId: 'a3',
			call: {
				tool: 'TodoWrite',
				input: { todos: [{ content: 'Hero copy', status: 'in_progress', activeForm: 'x' }] }
			}
		}
	])
	expect(state.agents.a3.steps).toEqual({ done: 0, total: 1, current: 'Hero copy' })
	expect(state.tasks).toEqual([])
})

test('an unknown model makes the cost partial', async () => {
	const state = run([...START, { kind: 'step', at: 3000, model: 'mystery', usage: usage(100, 0, 0, 0, 'mystery') }])
	expect(selectTurnTotals(state).isPartial).toBe(true)
})

test('a continuation keeps the turn; a new prompt keeps only live agents', async () => {
	const ended = run([...START, { kind: 'turnEnd', at: 20_000, agentId: 'a1', isAborted: false, reason: 'answer' }])
	const continued = reduce(ended, { kind: 'turnStart', at: 25_000, turnId: 't2', text: '' })
	expect(continued.turn?.id).toBe('t1')
	const fresh = reduce(ended, { kind: 'turnStart', at: 25_000, turnId: 't3', text: 'Next thing' })
	expect(fresh.order).toEqual(['a2', 'a3'])
	expect(fresh.agents.a1).toBeUndefined()
	expect(fresh.turn?.label).toBe('Next thing')
})

test('an agent seen before its spawn keeps its start time', async () => {
	const state = run([
		{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Go' },
		{ kind: 'turnStart', at: 1500, turnId: 'x', text: 'sub prompt', agentId: 'a9' },
		spawn('a9', 'Review the diff')
	])
	expect(state.agents.a9.spawnedAt).toBe(1500)
	expect(state.agents.a9.role).toBe('reviewer')
	expect(state.order).toEqual(['a9'])
})

test('statuses update known agents and their parents', async () => {
	const state = run([...START, { kind: 'statuses', at: 9000, list: [{ id: 'a2', status: 'failed', parentId: 'a1' }] }])
	expect(state.agents.a2.status).toBe('failed')
	expect(state.agents.a2.endedAt).toBe(9000)
	expect(state.agents.a2.parentId).toBe('a1')
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: FAIL, because `../hooks/tracker` can't be resolved.

- [ ] **Step 3: Implement**

`hooks/tracker.ts`:

```ts
import type { AgentRecord, AgentStatusView, CrewState, TaskItem, Usage } from '../types'
import { contextWindow, estimateUsd } from './pricing'
import { roleFor } from './roles'
import { applyTaskCall, taskProgress, type TaskToolCall } from './tasks'

export const MAIN = 'main'

const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const EMPTY_STATE: CrewState = {
	turn: null,
	agents: {},
	order: [],
	tasks: [],
	agentTasks: {},
	sessionByModel: {}
}

export type ApiUsage = {
	input_tokens: number
	output_tokens: number
	cache_read_input_tokens: number
	cache_creation_input_tokens: number
	model?: string
}

export type ListedAgent = { id: string; status: AgentStatusView; parentId?: string }

export type CrewEvent =
	| { kind: 'turnStart'; at: number; turnId: string; text: string; agentId?: string }
	| { kind: 'spawn'; at: number; agentId: string; description: string; subagentType: string; model?: string }
	| { kind: 'step'; at: number; agentId?: string; model: string; effort?: string; usage: ApiUsage | null }
	| { kind: 'turnEnd'; at: number; agentId?: string; isAborted: boolean; reason: string }
	| { kind: 'tasks'; agentId?: string; call: TaskToolCall }
	| { kind: 'statuses'; at: number; list: readonly ListedAgent[] }

const ENDED = new Set<AgentStatusView>(['completed', 'failed', 'killed', 'stopped'])
const FAILED = new Set<AgentStatusView>(['failed', 'killed', 'stopped'])
const WAITING = new Set<AgentStatusView>(['pending', 'waiting', 'idle'])

const isLive = (agent: AgentRecord) => !ENDED.has(agent.status)

export const totalTokens = (usage: Usage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite

const addUsage = (sum: Usage, usage: ApiUsage): Usage => ({
	input: sum.input + usage.input_tokens,
	output: sum.output + usage.output_tokens,
	cacheRead: sum.cacheRead + usage.cache_read_input_tokens,
	cacheWrite: sum.cacheWrite + usage.cache_creation_input_tokens
})

const firstLine = (text: string) => (text.split('\n').find(line => line.trim()) ?? '').trim().slice(0, 80)

function newAgent(id: string, at: number, fields: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id,
		description: id === MAIN ? 'Main' : 'Agent',
		type: id === MAIN ? 'main' : 'general-purpose',
		role: 'plain',
		status: 'running',
		spawnedAt: at,
		usage: ZERO,
		lastRequestInput: 0,
		...fields
	}
}

const withAgent = (state: CrewState, agent: AgentRecord): CrewState => ({
	...state,
	agents: { ...state.agents, [agent.id]: agent }
})

const withOrder = (state: CrewState, id: string): string[] =>
	id === MAIN || state.order.includes(id) ? state.order : [...state.order, id]

function endStatus(isAborted: boolean, reason: string): AgentStatusView {
	if (isAborted) return 'stopped'
	return reason === 'error' || reason === 'refusal' ? 'failed' : 'completed'
}

function startTurn(state: CrewState, ev: Extract<CrewEvent, { kind: 'turnStart' }>): CrewState {
	if (ev.agentId) {
		const agent = state.agents[ev.agentId] ?? newAgent(ev.agentId, ev.at)
		const { endedAt: _ended, ...rest } = agent
		return { ...withAgent(state, { ...rest, status: 'running' }), order: withOrder(state, ev.agentId) }
	}
	if (ev.text === '' && state.turn) return state
	const carried = Object.fromEntries(Object.entries(state.agents).filter(([id, agent]) => id !== MAIN && isLive(agent)))
	const previousMain = state.agents[MAIN]
	const main = newAgent(MAIN, ev.at, {
		...(previousMain?.model ? { model: previousMain.model } : {}),
		...(previousMain?.effort ? { effort: previousMain.effort } : {})
	})
	const isListDone = state.tasks.every(task => task.status === 'completed')
	return {
		...state,
		turn: { id: ev.turnId, label: firstLine(ev.text), startedAt: ev.at, isAborted: false },
		agents: { ...carried, [MAIN]: main },
		order: state.order.filter(id => id in carried),
		tasks: isListDone ? [] : state.tasks,
		agentTasks: Object.fromEntries(Object.entries(state.agentTasks).filter(([id]) => id in carried))
	}
}

function spawnAgent(state: CrewState, ev: Extract<CrewEvent, { kind: 'spawn' }>): CrewState {
	const previous = state.agents[ev.agentId]
	const agent: AgentRecord = {
		...(previous ?? newAgent(ev.agentId, ev.at)),
		description: ev.description || 'Agent',
		type: ev.subagentType,
		role: roleFor({ type: ev.subagentType, description: ev.description }),
		...(previous?.model ?? ev.model ? { model: previous?.model ?? ev.model } : {})
	}
	return { ...withAgent(state, agent), order: withOrder(state, ev.agentId) }
}

function addStep(state: CrewState, ev: Extract<CrewEvent, { kind: 'step' }>): CrewState {
	const id = ev.agentId ?? MAIN
	const previous = state.agents[id] ?? newAgent(id, ev.at)
	const order = withOrder(state, id)
	const effort = ev.effort ?? previous.effort
	if (!ev.usage) {
		return { ...withAgent(state, { ...previous, model: ev.model, ...(effort ? { effort } : {}) }), order }
	}
	const model = ev.usage.model || ev.model
	const agent: AgentRecord = {
		...previous,
		model,
		...(effort ? { effort } : {}),
		usage: addUsage(previous.usage, ev.usage),
		lastRequestInput:
			ev.usage.input_tokens + ev.usage.cache_read_input_tokens + ev.usage.cache_creation_input_tokens
	}
	const bucket = state.sessionByModel[model] ?? ZERO
	return {
		...withAgent(state, agent),
		order,
		sessionByModel: { ...state.sessionByModel, [model]: addUsage(bucket, ev.usage) }
	}
}

function endTurn(state: CrewState, ev: Extract<CrewEvent, { kind: 'turnEnd' }>): CrewState {
	if (ev.agentId) {
		const agent = state.agents[ev.agentId]
		if (!agent) return state
		return withAgent(state, { ...agent, status: endStatus(ev.isAborted, ev.reason), endedAt: ev.at })
	}
	if (!state.turn) return state
	const agents = Object.fromEntries(
		Object.entries(state.agents).map(([id, agent]) => {
			if (id === MAIN) return [id, { ...agent, status: endStatus(ev.isAborted, ev.reason), endedAt: ev.at }]
			if (ev.isAborted && isLive(agent)) return [id, { ...agent, status: 'stopped' as const, endedAt: ev.at }]
			return [id, agent]
		})
	)
	return { ...state, agents, turn: { ...state.turn, endedAt: ev.at, isAborted: ev.isAborted } }
}

function applyTasks(state: CrewState, ev: Extract<CrewEvent, { kind: 'tasks' }>): CrewState {
	if (!ev.agentId) {
		const list = applyTaskCall(state.tasks, ev.call)
		return list ? { ...state, tasks: list } : state
	}
	const list = applyTaskCall(state.agentTasks[ev.agentId] ?? [], ev.call)
	if (!list) return state
	const agentTasks: Record<string, TaskItem[]> = { ...state.agentTasks, [ev.agentId]: list }
	const agent = state.agents[ev.agentId]
	return agent ? { ...withAgent(state, { ...agent, steps: taskProgress(list) }), agentTasks } : { ...state, agentTasks }
}

function applyStatuses(state: CrewState, ev: Extract<CrewEvent, { kind: 'statuses' }>): CrewState {
	return ev.list.reduce((next, item) => {
		const agent = next.agents[item.id]
		if (!agent || agent.status === 'stopped') return next
		const isEnding = ENDED.has(item.status) && !ENDED.has(agent.status)
		return withAgent(next, {
			...agent,
			status: item.status,
			...(item.parentId ?? agent.parentId ? { parentId: item.parentId ?? agent.parentId } : {}),
			...(isEnding ? { endedAt: ev.at } : {})
		})
	}, state)
}

export function reduce(state: CrewState, ev: CrewEvent): CrewState {
	switch (ev.kind) {
		case 'turnStart':
			return startTurn(state, ev)
		case 'spawn':
			return spawnAgent(state, ev)
		case 'step':
			return addStep(state, ev)
		case 'turnEnd':
			return endTurn(state, ev)
		case 'tasks':
			return applyTasks(state, ev)
		case 'statuses':
			return applyStatuses(state, ev)
	}
}

export type Progress = { source: 'tasks' | 'agents'; done: number; total: number; fraction: number }

export function selectProgress(state: CrewState): Progress | null {
	if (!state.turn) return null
	if (state.tasks.length > 0) {
		const { done, total } = taskProgress(state.tasks)
		return { source: 'tasks', done, total, fraction: total ? done / total : 0 }
	}
	if (state.order.length === 0) return null
	const done = state.order.filter(id => ENDED.has(state.agents[id]?.status ?? 'completed')).length
	return { source: 'agents', done, total: state.order.length, fraction: done / state.order.length }
}

export const selectRunning = (state: CrewState) =>
	state.order.filter(id => state.agents[id]?.status === 'running').length

export type Groups = { running: AgentRecord[]; waiting: AgentRecord[]; finished: AgentRecord[]; failed: AgentRecord[] }

export function selectGroups(state: CrewState): Groups {
	const agents = state.order.map(id => state.agents[id]).filter((agent): agent is AgentRecord => !!agent)
	return {
		running: agents.filter(agent => agent.status === 'running'),
		waiting: agents.filter(agent => WAITING.has(agent.status)),
		finished: agents.filter(agent => agent.status === 'completed'),
		failed: agents.filter(agent => FAILED.has(agent.status))
	}
}

export type Totals = { tokens: number; costUsd: number; isPartial: boolean }

function totalsOf(entries: ReadonlyArray<{ usage: Usage; model: string }>): Totals {
	return entries.reduce<Totals>(
		(sum, { usage, model }) => {
			const tokens = totalTokens(usage)
			const cost = estimateUsd(usage, model)
			return {
				tokens: sum.tokens + tokens,
				costUsd: sum.costUsd + (cost ?? 0),
				isPartial: sum.isPartial || (cost === null && tokens > 0)
			}
		},
		{ tokens: 0, costUsd: 0, isPartial: false }
	)
}

export const selectTurnTotals = (state: CrewState) =>
	totalsOf(Object.values(state.agents).map(agent => ({ usage: agent.usage, model: agent.model ?? '' })))

export const selectSessionTotals = (state: CrewState) =>
	totalsOf(Object.entries(state.sessionByModel).map(([model, usage]) => ({ usage, model })))

export const contextFraction = (agent: AgentRecord) => agent.lastRequestInput / contextWindow(agent.model ?? '')
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: PASS, 29 tests in total.

- [ ] **Step 5: Commit**

```bash
git add hooks/tracker.ts test/tracker.test.ts
git commit -m "feat: tracker reducer and selectors"
```

---

### Task 7: The Pip sprite

**Files:**
- Create: `hooks/sprite.ts`
- Test: `test/sprite.test.ts`

Pip is an original character made for this mod: a round, bean-shaped body with two dot eyes and stubby feet. It isn't based on any existing mascot. Each grid cell is one pixel. Two pixel rows pack into one text row with half blocks (`▀` foreground = top pixel, background = bottom pixel), so the 8×8 sprite draws as 8 columns × 4 rows.

- [ ] **Step 1: Write the failing test**

`test/sprite.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { ACCENTS, PALETTE, spriteCells, spriteGrid } from '../hooks/sprite'

test('the sprite is 4 text rows of 8 cells', async () => {
	const cells = spriteCells('plain', {})
	expect(cells).toHaveLength(4)
	expect(cells.every(row => row.length === 8)).toBe(true)
})

test('half blocks pack two pixel rows', async () => {
	const cells = spriteCells('plain', {})
	expect(cells[0][0]).toEqual({ ch: ' ' })
	expect(cells[2][2]).toEqual({ ch: '▀', fg: PALETTE.eye, bg: PALETTE.body })
	expect(cells[3][1]).toEqual({ ch: '▄', fg: PALETTE.shade })
})

test('each role wears its accessory', async () => {
	expect(spriteCells('developer', {})[1][0]).toEqual({ ch: '▄', fg: ACCENTS.headset.dark })
	expect(spriteGrid('researcher', {})[4]).toBe('.AEAAEA.')
	expect(spriteGrid('reviewer', {})[2]).toBe('aAAAAAAa')
})

test('prefs override accessory and colours', async () => {
	expect(spriteCells('developer', { developer: { accessory: 'none' } })[1][0]).toEqual({ ch: ' ' })
	const recoloured = spriteCells('plain', { plain: { body: '#112233' } })
	expect(recoloured[2][2]).toEqual({ ch: '▀', fg: PALETTE.eye, bg: '#112233' })
	expect(spriteCells('reviewer', { reviewer: { accent: '#00FF00' } })[1][1].fg).toBe('#00FF00')
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: FAIL, because `../hooks/sprite` can't be resolved.

- [ ] **Step 3: Implement**

`hooks/sprite.ts`:

```ts
import type { Accessory, MascotPrefs, MascotStyle, Role } from '../types'

export type SpriteCell = { ch: string; fg?: string; bg?: string }

export const PALETTE = { body: '#7C9CF5', shade: '#5570C8', eye: '#1C1F2B' }

export const ACCENTS: Record<Exclude<Accessory, 'none'>, { main: string; dark: string }> = {
	headset: { main: '#AEB6C4', dark: '#5B6475' },
	beret: { main: '#E0566B', dark: '#B83A50' },
	glasses: { main: '#2B2F3A', dark: '#2B2F3A' },
	hardhat: { main: '#F2B705', dark: '#C99500' }
}

export const DEFAULT_ACCESSORY: Record<Role, Accessory> = {
	developer: 'headset',
	designer: 'beret',
	researcher: 'glasses',
	reviewer: 'hardhat',
	plain: 'none'
}

// B body, D shade (feet), E eye, A accessory, a accessory dark, '.' empty.
const BASE = ['........', '........', '..BBBB..', '.BBBBBB.', '.BEBBEB.', '.BBBBBB.', '..BBBB..', '.DD..DD.']

const OVERLAYS: Record<Accessory, Record<number, string>> = {
	headset: { 1: '..AAAA..', 2: '.A....A.', 3: 'a......a', 4: 'a......a' },
	beret: { 0: '....a...', 1: '..AAAAA.', 2: '.AAAAA..' },
	glasses: { 4: '.AEAAEA.' },
	hardhat: { 1: '..AAAA..', 2: 'aAAAAAAa' },
	none: {}
}

const styleFor = (role: Role, prefs: MascotPrefs): MascotStyle => prefs[role] ?? {}

export function spriteGrid(role: Role, prefs: MascotPrefs): string[] {
	const accessory = styleFor(role, prefs).accessory ?? DEFAULT_ACCESSORY[role]
	const overlay = OVERLAYS[accessory]
	return BASE.map((row, index) => {
		const layer = overlay[index]
		if (!layer) return row
		return [...row].map((ch, col) => (layer[col] === '.' ? ch : layer[col])).join('')
	})
}

function colourOf(ch: string, accessory: Accessory, style: MascotStyle): string | undefined {
	const accent = accessory === 'none' ? undefined : ACCENTS[accessory]
	switch (ch) {
		case 'B':
			return style.body ?? PALETTE.body
		case 'D':
			return style.body ?? PALETTE.shade
		case 'E':
			return PALETTE.eye
		case 'A':
			return style.accent ?? accent?.main
		case 'a':
			return style.accent ?? accent?.dark
		default:
			return undefined
	}
}

function cell(top: string | undefined, bottom: string | undefined): SpriteCell {
	if (top && bottom) return { ch: '▀', fg: top, bg: bottom }
	if (top) return { ch: '▀', fg: top }
	if (bottom) return { ch: '▄', fg: bottom }
	return { ch: ' ' }
}

export function spriteCells(role: Role, prefs: MascotPrefs): SpriteCell[][] {
	const style = styleFor(role, prefs)
	const accessory = style.accessory ?? DEFAULT_ACCESSORY[role]
	const grid = spriteGrid(role, prefs)
	const rows: SpriteCell[][] = []
	for (let r = 0; r < 4; r++) {
		const top = grid[r * 2]
		const bottom = grid[r * 2 + 1]
		rows.push([...top].map((_, col) => cell(colourOf(top[col], accessory, style), colourOf(bottom[col], accessory, style))))
	}
	return rows
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: PASS, 33 tests in total.

- [ ] **Step 5: Commit**

```bash
git add hooks/sprite.ts test/sprite.test.ts
git commit -m "feat: Pip sprite with role accessories"
```

---

### Task 8: Mascot tool parsing

**Files:**
- Create: `hooks/mascot.ts`
- Test: `test/mascot.test.ts`

- [ ] **Step 1: Write the failing test**

`test/mascot.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { applyMascotChange, parseMascotInput } from '../hooks/mascot'

test('a valid change parses', async () => {
	expect(parseMascotInput({ role: 'designer', accessory: 'hardhat', body: '#112233' })).toEqual({
		role: 'designer',
		style: { accessory: 'hardhat', body: '#112233' }
	})
	expect(parseMascotInput({ role: 'plain', reset: true })).toEqual({ role: 'plain', reset: true })
})

test('bad input is refused with a reason', async () => {
	expect(parseMascotInput({ role: 'pilot' })).toEqual({
		error: 'role must be one of developer, designer, researcher, reviewer, plain'
	})
	expect(parseMascotInput({ role: 'plain', accessory: 'cape' })).toEqual({
		error: 'accessory must be one of headset, beret, glasses, hardhat, none'
	})
	expect(parseMascotInput({ role: 'plain', body: 'blue' })).toEqual({ error: 'body must be a hex colour like #7C9CF5' })
	expect(parseMascotInput({ role: 'plain' })).toEqual({ error: 'give accessory, body, accent or reset' })
})

test('changes merge into prefs, reset removes the role', async () => {
	const once = applyMascotChange({}, { role: 'designer', style: { accessory: 'hardhat' } })
	const twice = applyMascotChange(once, { role: 'designer', style: { body: '#112233' } })
	expect(twice).toEqual({ designer: { accessory: 'hardhat', body: '#112233' } })
	expect(applyMascotChange(twice, { role: 'designer', reset: true })).toEqual({})
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: FAIL, because `../hooks/mascot` can't be resolved.

- [ ] **Step 3: Implement**

`hooks/mascot.ts`:

```ts
import type { Accessory, MascotPrefs, MascotStyle, Role } from '../types'

export const ROLES: Role[] = ['developer', 'designer', 'researcher', 'reviewer', 'plain']
export const ACCESSORIES: Accessory[] = ['headset', 'beret', 'glasses', 'hardhat', 'none']

export const SET_MASCOT_TOOL = 'mcp__crew__set_mascot'

export const SET_MASCOT_SPEC = {
	name: 'set_mascot',
	description:
		"Restyle a Crew agents-panel mascot for one role. Use when the user asks to change how the Crew mascots look (e.g. 'make the designer wear a hard hat', 'make reviewers green'). Changes persist across sessions.",
	inputSchema: {
		type: 'object',
		properties: {
			role: { type: 'string', enum: ROLES, description: 'Which role to restyle' },
			accessory: { type: 'string', enum: ACCESSORIES },
			body: { type: 'string', description: 'Body colour as #RRGGBB' },
			accent: { type: 'string', description: 'Accessory colour as #RRGGBB' },
			reset: { type: 'boolean', description: 'Back to the default look for this role' }
		},
		required: ['role'],
		additionalProperties: false
	}
}

export type MascotChange = { role: Role; reset: true } | { role: Role; style: MascotStyle }

const HEX = /^#[0-9a-fA-F]{6}$/

export function parseMascotInput(input: Record<string, unknown>): MascotChange | { error: string } {
	const role = input.role as Role
	if (!ROLES.includes(role)) return { error: `role must be one of ${ROLES.join(', ')}` }
	if (input.reset === true) return { role, reset: true }
	const style: MascotStyle = {}
	if (input.accessory !== undefined) {
		if (!ACCESSORIES.includes(input.accessory as Accessory)) {
			return { error: `accessory must be one of ${ACCESSORIES.join(', ')}` }
		}
		style.accessory = input.accessory as Accessory
	}
	for (const key of ['body', 'accent'] as const) {
		const value = input[key]
		if (value === undefined) continue
		if (typeof value !== 'string' || !HEX.test(value)) return { error: `${key} must be a hex colour like #7C9CF5` }
		style[key] = value
	}
	if (Object.keys(style).length === 0) return { error: 'give accessory, body, accent or reset' }
	return { role, style }
}

export function applyMascotChange(prefs: MascotPrefs, change: MascotChange): MascotPrefs {
	if ('reset' in change) {
		const { [change.role]: _removed, ...rest } = prefs
		return rest
	}
	return { ...prefs, [change.role]: { ...prefs[change.role], ...change.style } }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: PASS, 36 tests in total.

- [ ] **Step 5: Commit**

```bash
git add hooks/mascot.ts test/mascot.test.ts
git commit -m "feat: set_mascot tool parsing"
```

---

### Task 9: State atoms and view builders

**Files:**
- Create: `hooks/state.ts`
- Create: `hooks/view.ts`
- Test: `test/view.test.ts`

- [ ] **Step 1: Write the failing test**

`test/view.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { EMPTY_STATE, reduce, selectProgress, type CrewEvent } from '../hooks/tracker'
import { COLLAPSE_AFTER, bandLine, panelView } from '../hooks/view'

const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000, model: 'claude-opus-5-5' }
const spawn = (agentId: string, description: string): CrewEvent => ({
	kind: 'spawn',
	at: 2000,
	agentId,
	description,
	subagentType: 'general-purpose',
	model: 'claude-opus-5-5'
})
const STATE = [
	{ kind: 'turnStart', at: 1000, turnId: 't1', text: 'Build the launch kit for our new cold brew' },
	spawn('a1', 'Research competitor launches'),
	spawn('a2', 'Design the launch graphics'),
	spawn('a3', 'Build the landing page'),
	{ kind: 'step', at: 3000, agentId: 'a1', model: 'claude-opus-5-5', effort: 'high', usage },
	{ kind: 'turnEnd', at: 20_000, agentId: 'a1', isAborted: false, reason: 'answer' }
].reduce((state, ev) => reduce(state, ev as CrewEvent), EMPTY_STATE)

test('the band line fits its width', async () => {
	const progress = selectProgress(STATE)
	if (!progress) throw new Error('expected progress')
	const wide = bandLine(STATE, progress, 100)
	expect(wide.pill).toBe('Agents 1/3')
	expect(wide.percent).toBe('33%')
	expect(wide.running).toBe(2)
	expect(wide.label).toBe('Build the launch kit for our new cold brew')
	const narrow = bandLine(STATE, progress, 40)
	expect(narrow.label.endsWith('…')).toBe(true)
	expect((narrow.filled + narrow.empty).length).toBe(6)
})

test('rows carry model, effort and the stats line', async () => {
	const view = panelView(STATE, {}, 30_000, 20, false)
	const finished = view.groups.find(group => group.name === 'Finished')
	expect(finished?.count).toBe(1)
	const row = finished?.rows[0]
	expect(row?.meta).toBe('high · Opus 5.5')
	expect(row?.stats).toBe('ctx 1% · 14k · ≈$0.03 · 0:18')
	expect(row?.mark).toBe('✓')
	expect(row?.bar).toBe('█'.repeat(20))
	expect(view.groups.map(group => group.name)).toEqual(['Running', 'Finished'])
	expect(view.cost).toBe('≈$0.03')
	expect(view.tokens).toBe('14k')
	expect(view.time).toBe('0:29')
	expect(view.main?.title).toBe('Main')
})

test('a long finished list collapses until opened', async () => {
	const many = Array.from({ length: COLLAPSE_AFTER + 1 }, (_, i) => i).reduce(
		(state, i) =>
			reduce(reduce(state, spawn(`b${i}`, `Job ${i}`)), {
				kind: 'turnEnd',
				at: 5000,
				agentId: `b${i}`,
				isAborted: false,
				reason: 'answer'
			}),
		STATE
	)
	const closed = panelView(many, {}, 30_000, 20, false).groups.find(group => group.name === 'Finished')
	expect(closed?.isCollapsed).toBe(true)
	expect(closed?.isCollapsible).toBe(true)
	const open = panelView(many, {}, 30_000, 20, true).groups.find(group => group.name === 'Finished')
	expect(open?.isCollapsed).toBe(false)
})

test('an empty session says so', async () => {
	expect(panelView(EMPTY_STATE, {}, 0, 20, false).isEmpty).toBe(true)
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: FAIL, because `../hooks/view` can't be resolved.

- [ ] **Step 3: Implement the atoms**

`hooks/state.ts`:

```ts
import { atom } from 'claude-code'

import type { MascotPrefs } from '../types'
import { EMPTY_STATE } from './tracker'

export const model = atom({ plugin: 'crew', key: 'model' } as const, EMPTY_STATE)
export const isBandHidden = atom({ plugin: 'crew', key: 'isBandHidden' } as const, false)
export const isFinishedOpen = atom({ plugin: 'crew', key: 'isFinishedOpen' } as const, false)
export const mascots = atom({ plugin: 'crew', key: 'mascots' } as const, {} as MascotPrefs)
```

- [ ] **Step 4: Implement the view builders**

`hooks/view.ts`:

```ts
import type { AgentRecord, CrewState, MascotPrefs } from '../types'
import { bar, clamp, fmtDuration, fmtPercent, fmtTokens, fmtUsd, prettyModel, shimmer, truncate } from './format'
import { estimateUsd } from './pricing'
import { spriteCells, type SpriteCell } from './sprite'
import {
	MAIN,
	contextFraction,
	selectGroups,
	selectRunning,
	selectSessionTotals,
	selectTurnTotals,
	totalTokens,
	type Progress
} from './tracker'

export const COLLAPSE_AFTER = 8

export type BandLine = {
	label: string
	filled: string
	empty: string
	pill: string
	percent: string
	running: number
	tone: 'running' | 'done' | 'aborted'
}

export function bandLine(state: CrewState, progress: Progress, columns: number): BandLine {
	const pill = `${progress.source === 'tasks' ? 'Tasks' : 'Agents'} ${progress.done}/${progress.total}`
	const percent = fmtPercent(progress.fraction)
	const running = selectRunning(state)
	// "● " + " " + bar + " " + pill + "  " + percent + "  ▣×n  " + "×"
	const fixed = 2 + 1 + 1 + pill.length + 2 + percent.length + 2 + `▣×${running}`.length + 2 + 1
	const barWidth = clamp(Math.floor((columns - fixed) / 3), 6, 24)
	const label = truncate(state.turn?.label || 'Working', Math.max(6, columns - fixed - barWidth))
	const filled = Math.round(clamp(progress.fraction, 0, 1) * barWidth)
	const tone = state.turn?.isAborted ? 'aborted' : state.turn?.endedAt ? 'done' : 'running'
	return { label, filled: '█'.repeat(filled), empty: '░'.repeat(barWidth - filled), pill, percent, running, tone }
}

export type Tone = 'running' | 'waiting' | 'done' | 'failed'

export type RowView = {
	id: string
	title: string
	mark: string
	meta: string
	stats: string
	steps: string
	note: string
	bar: string
	tone: Tone
	sprite: SpriteCell[][]
}

export type GroupView = { name: string; count: number; rows: RowView[]; isCollapsed: boolean; isCollapsible: boolean }

export type PanelView = {
	cost: string
	tokens: string
	time: string
	session: string
	main: RowView | null
	groups: GroupView[]
	isEmpty: boolean
}

function toneOf(agent: AgentRecord): Tone {
	if (agent.status === 'running') return 'running'
	if (agent.status === 'completed') return 'done'
	if (agent.status === 'failed' || agent.status === 'killed' || agent.status === 'stopped') return 'failed'
	return 'waiting'
}

function rowView(agent: AgentRecord, state: CrewState, prefs: MascotPrefs, now: number, barWidth: number): RowView {
	const tone = toneOf(agent)
	const tokens = totalTokens(agent.usage)
	const cost = tokens > 0 ? estimateUsd(agent.usage, agent.model ?? '') : 0
	const startedAt = agent.id === MAIN ? (state.turn?.startedAt ?? agent.spawnedAt) : agent.spawnedAt
	const endedAt = agent.id === MAIN ? (state.turn?.endedAt ?? agent.endedAt) : agent.endedAt
	const steps = agent.steps
	const parent = agent.parentId ? state.agents[agent.parentId] : undefined
	const notes = [parent ? `↳ from ${parent.description}` : '', agent.status === 'stopped' ? 'stopped' : ''].filter(Boolean)
	let progressBar = bar(0, barWidth)
	if (steps && steps.total > 0) progressBar = bar(steps.done / steps.total, barWidth)
	else if (tone === 'running') progressBar = shimmer(barWidth, now)
	else if (tone === 'done' || tone === 'failed') progressBar = bar(1, barWidth)
	return {
		id: agent.id,
		title: agent.description,
		mark: tone === 'done' ? '✓' : tone === 'failed' ? '✗' : '',
		meta: [agent.effort, prettyModel(agent.model)].filter(Boolean).join(' · '),
		stats: [
			`ctx ${fmtPercent(contextFraction(agent))}`,
			fmtTokens(tokens),
			fmtUsd(cost),
			fmtDuration((endedAt ?? now) - startedAt)
		].join(' · '),
		steps: steps ? `${steps.done}/${steps.total}${steps.current ? ` · ${steps.current}` : ''}` : '',
		note: notes.join(' · '),
		bar: progressBar,
		tone,
		sprite: spriteCells(agent.role, prefs)
	}
}

export function panelView(
	state: CrewState,
	prefs: MascotPrefs,
	now: number,
	barWidth: number,
	isFinishedOpen: boolean
): PanelView {
	const turn = selectTurnTotals(state)
	const session = selectSessionTotals(state)
	const groups = selectGroups(state)
	const isCollapsible = state.order.length > COLLAPSE_AFTER
	const named: Array<[string, AgentRecord[]]> = [
		['Running', groups.running],
		['Waiting', groups.waiting],
		['Finished', groups.finished],
		['Failed', groups.failed]
	]
	return {
		cost: `${fmtUsd(turn.costUsd)}${turn.isPartial ? '+' : ''}`,
		tokens: fmtTokens(turn.tokens),
		time: state.turn ? fmtDuration((state.turn.endedAt ?? now) - state.turn.startedAt) : '0:00',
		session: `Session ${fmtUsd(session.costUsd)}${session.isPartial ? '+' : ''} · ${fmtTokens(session.tokens)} tokens`,
		main: state.agents[MAIN] ? rowView(state.agents[MAIN], state, prefs, now, barWidth) : null,
		groups: named
			.filter(([, agents]) => agents.length > 0)
			.map(([name, agents]) => {
				const isFinished = name === 'Finished'
				return {
					name,
					count: agents.length,
					rows: agents.map(agent => rowView(agent, state, prefs, now, barWidth)),
					isCollapsed: isFinished && isCollapsible && !isFinishedOpen,
					isCollapsible: isFinished && isCollapsible
				}
			}),
		isEmpty: state.order.length === 0
	}
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: PASS, 40 tests in total.

If `ctx 1%` comes out differently: a1's context is 13,000 / 1,000,000 = 1.3%, which rounds to 1%. Check the arithmetic before changing the test.

- [ ] **Step 6: Commit**

```bash
git add hooks/state.ts hooks/view.ts test/view.test.ts
git commit -m "feat: state atoms and view builders"
```

---

### Task 10: Band, pane and wiring

**Files:**
- Create: `hooks/band.tsx`
- Create: `hooks/panel.tsx`
- Modify: `hooks/register.tsx` (replace the whole file)
- Test: `test/ui.test.ts`

- [ ] **Step 1: Write the failing UI test**

`test/ui.test.ts`:

```ts
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
	plugin: 'crew',
	component: 'AbovePrompt',
	requestId: 'band',
	props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }
} as const

const PANE = {
	plugin: 'crew',
	component: 'Pane',
	requestId: 'crew',
	props: {
		title: 'Agents',
		isFocused: false,
		bodyColumns: 48,
		placement: 'dock',
		scroll: { offset: 0, bodyRows: 40 },
		view: {}
	}
} as const

async function startTwoAgents($: any, on: any) {
	mock.clock(on, { now: 1000 })
	mock.store(on)
	on('command.register', () => ({ value: { command: 'crew' } }))
	on('tool.register', () => ({ value: { tool: 'mcp__crew__set_mascot' } }))
	on('ui.open', () => ({ value: { isPlaced: true } }))
	on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
	on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
	on('agent.spawn', (_: unknown, e: any) => ({
		model: 'claude-opus-5-5',
		agentId: e.description === 'Research competitor launches' ? 'a1' : 'a2'
	}))

	await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
	await $.turn.start({ text: 'Build the launch kit', turnId: 't1' })
	await $.agent.spawn({ prompt: 'go', description: 'Research competitor launches', subagentType: 'Explore' })
	await $.agent.spawn({ prompt: 'go', description: 'Build the landing page', subagentType: 'general-purpose' })
}

test('the band shows agent progress and hides on ×', async ($, on) => {
	await startTwoAgents($, on)
	for (const surface of ['terminal', 'desktop'] as const) {
		const ui = await $.ui.mount({ ...BAND, surface })
		expect((await ui.find({ type: 'Text', text: /Agents 0\/2/ }))?.text).toContain('Agents 0/2')
		await ui.unmount()
	}
	const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
	await ui.press({ key: 'hide' })
	expect(await ui.find({ type: 'Text', text: /Agents 0\/2/ })).toBeUndefined()
	await ui.unmount()
})

test('the pane lists each agent under Running', async ($, on) => {
	await startTwoAgents($, on)
	for (const surface of ['terminal', 'desktop'] as const) {
		const ui = await $.ui.mount({ ...PANE, surface })
		expect(await ui.find({ type: 'Text', text: /Running · 2/ })).toBeDefined()
		expect(await ui.find({ type: 'Text', text: /Research competitor launches/ })).toBeDefined()
		expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
		await ui.unmount()
	}
})

test('set_mascot saves the change', async ($, on) => {
	await startTwoAgents($, on)
	const ran = await $.tool.call({ tool: 'mcp__crew__set_mascot', role: 'designer', accessory: 'hardhat' } as any)
	expect(ran.deny).toBeUndefined()
	expect(ran.result).toEqual({ ok: true, role: 'designer', prefs: { accessory: 'hardhat' } })
	const refused = await $.tool.call({ tool: 'mcp__crew__set_mascot', role: 'pilot' } as any)
	expect(refused.deny).toBe('role must be one of developer, designer, researcher, reviewer, plain')
})
```

The test kit raises every engine event as a call on `$` (`$.turn.start`, `$.agent.spawn`, ...). The test's own `on` hooks stand in for the engine beneath the plugin. If the kit rejects an argument shape (for example, it wants more `turn.start` fields), grep the types file for `TurnStartInput` / `AgentSpawnArgs` and add what it names. Don't change the assertions.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: FAIL. `register` is still empty, so nothing draws and the tool call is unanswered.

- [ ] **Step 3: Implement the band**

`hooks/band.tsx`:

```tsx
import { read, update } from 'claude-code'
import type { On } from 'claude-code'

import { isBandHidden, model } from './state'
import { selectProgress } from './tracker'
import { bandLine } from './view'

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
```

- [ ] **Step 4: Implement the pane**

`hooks/panel.tsx`:

```tsx
import { read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { SpriteCell } from './sprite'
import { isFinishedOpen, mascots, model } from './state'
import { panelView, type RowView, type Tone } from './view'

export const PANE = 'crew'

const TONE: Record<Tone, string> = { running: 'claude', waiting: 'inactive', done: 'success', failed: 'error' }

const cellProps = (cell: SpriteCell) => ({
	...(cell.fg ? { color: cell.fg } : {}),
	...(cell.bg ? { backgroundColor: cell.bg } : {})
})

export function registerPanel(on: On) {
	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const { Box, Button, Text } = $.ui.resolve(e)
		const state = await read($, model)
		const prefs = await read($, mascots)
		const isOpen = await read($, isFinishedOpen)
		const now = await $.clock.now()
		const view = panelView(state, prefs, now, Math.max(8, e.props.bodyColumns - 10), isOpen)

		const card = (label: string, value: string) => (
			<Box key={`card-${label}`} flexDirection="column" borderStyle="round" paddingX={1}>
				<Text dimColor size="caption">
					{label}
				</Text>
				<Text weight="semibold" tabular>
					{value}
				</Text>
			</Box>
		)

		const agentRow = (row: RowView) => (
			<Box key={`row-${row.id}`} flexDirection="row" gap={1} marginBottom={1}>
				<Box flexDirection="column">
					{row.sprite.map(cells => (
						<Text>
							{cells.map(cell => (
								<Text {...cellProps(cell)}>{cell.ch}</Text>
							))}
						</Text>
					))}
				</Box>
				<Box flexDirection="column" flexGrow={1}>
					<Text weight="semibold" wrap="truncate-end">
						{row.title}
						{row.mark ? <Text color={TONE[row.tone]}> {row.mark}</Text> : ''}
					</Text>
					<Text dimColor wrap="truncate-end">
						{row.meta}
						{row.note ? ` · ${row.note}` : ''}
					</Text>
					<Text wrap="truncate-end">
						{row.steps ? `${row.steps} · ` : ''}
						<Text dimColor tabular>
							{row.stats}
						</Text>
					</Text>
					<Text color={TONE[row.tone]}>{row.bar}</Text>
				</Box>
			</Box>
		)

		return (
			<Box flexDirection="column">
				<Box flexDirection="row" gap={1}>
					{card('Cost', view.cost)}
					{card('Tokens', view.tokens)}
					{card('Time', view.time)}
				</Box>
				<Text dimColor size="caption">
					{view.session}
				</Text>
				<Text> </Text>
				{view.main && agentRow(view.main)}
				{view.isEmpty && <Text dimColor>No sub-agents yet. They show up here as soon as one starts.</Text>}
				{view.groups.map(group => (
					<Box key={`group-${group.name}`} flexDirection="column">
						<Text dimColor weight="semibold">
							{group.name} · {group.count}
						</Text>
						{!group.isCollapsed && group.rows.map(agentRow)}
						{group.isCollapsible && (
							<Button
								key="toggle-finished"
								plain
								label={group.isCollapsed ? `Show ${group.count} finished` : 'Hide finished'}
								onPress={() => update($, isFinishedOpen, value => !value)}
							/>
						)}
					</Box>
				))}
			</Box>
		)
	})
}
```

- [ ] **Step 5: Wire the events**

Replace `hooks/register.tsx` with:

```tsx
import { read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentStatusView, MascotPrefs } from '../types'
import { registerBand } from './band'
import { SET_MASCOT_SPEC, SET_MASCOT_TOOL, applyMascotChange, parseMascotInput } from './mascot'
import { PANE, registerPanel } from './panel'
import { isBandHidden, mascots, model } from './state'
import { TASK_TOOLS } from './tasks'
import { reduce, type CrewEvent } from './tracker'

const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

const toolInput = (e: object): Record<string, unknown> =>
	Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))

export const register: Register = on => {
	let hasOpenedPane = false

	const apply = async ($: EngineInterface, ev: CrewEvent) => {
		await update($, model, state => reduce(state, ev))
	}

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
```

One `tool.call` hook does two jobs. It answers `mcp__crew__set_mascot` itself, without calling `next`, which is how a mod serves its own tool. For every other tool it runs the call and then records task-list tools. If `claude plugin validate` reports that `mcp__crew__set_mascot` is served by no matcher hook, move the `SET_MASCOT_TOOL` branch into its own `on('tool.call', { tool: SET_MASCOT_TOOL }, ...)`, registered **before** the generic hook, and have the generic hook `return next(e)` for that tool.

- [ ] **Step 6: Run the tests**

Run: `claude plugin test /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: PASS, 43 tests in total.

When a `ui.render` tree is refused, the failure names the element and prop (for example, `a tree Pane refuses: Text takes no prop X`). Fix that prop, using the `TextProps`/`BoxProps` in the types file, and run again.

- [ ] **Step 7: Validate**

Run: `claude plugin validate /Users/gabpaet/Documents/Applications/claude-mods/crew`
Expected: no errors. It lists hooks on `session.start`, `command.run`, `turn.start`, `agent.spawn`, `turn.step`, `turn.complete`, `tool.call` and `ui.render`, and the `$.state` keys `crew.model`, `crew.isBandHidden`, `crew.isFinishedOpen` and `crew.mascots`, all matching the contract.

- [ ] **Step 8: Commit**

```bash
git add hooks/band.tsx hooks/panel.tsx hooks/register.tsx test/ui.test.ts
git commit -m "feat: draw band and agents pane, wire engine events"
```

---

### Task 11: Bring the spec in line

**Files:**
- Modify: `docs/2026-10-23-crew-progress-design.md`

- [ ] **Step 1: Edit the spec**

Make these changes in the spec:
- **Platform facts:** add that `turn.step` carries `effort` and that `tool.call` sees `TodoWrite`/`TaskCreate`/`TaskUpdate`/`mcp__ccd_turn__update_plan` with `agentId`.
- **Mascots:** change the researcher accessory from magnifier to glasses. Restyling goes through the `mcp__crew__set_mascot` tool, persisted in `$.store` key `mascots`.
- **Cost and ctx %:** context windows come from the per-model table (200k only for Haiku 4.5 and unknown models). Prices are as of 2026-10-06, and cache writes use the 5-minute rate.
- **Testing:** the runner is `claude plugin test` with `claude-code/testing`, not `node:test`. Files are TypeScript.
- **Architecture table:** add `tasks.ts`, `mascot.ts`, `state.ts`, `view.ts`, `format.ts`. Change `.js` to `.ts`/`.tsx`.

- [ ] **Step 2: Commit**

```bash
git add docs/2026-10-23-crew-progress-design.md
git commit -m "docs: align spec with the mod API findings"
```

---

### Task 12: Install and check it live

This task changes the user's Claude Code configuration (adds a marketplace, installs a plugin). **Ask the user before Step 2.**

**Files:**
- Create: `/Users/gabpaet/Documents/Applications/claude-mods/.claude-plugin/marketplace.json` (outside the repo)

- [ ] **Step 1: Write the local marketplace**

`/Users/gabpaet/Documents/Applications/claude-mods/.claude-plugin/marketplace.json`:

```json
{
	"name": "claude-mods",
	"owner": { "name": "Gabriel Joshua Paet" },
	"plugins": [{ "name": "crew", "source": "./crew" }]
}
```

- [ ] **Step 2: Add the marketplace and install (after the user says yes)**

```bash
claude plugin marketplace add /Users/gabpaet/Documents/Applications/claude-mods
```

```bash
claude plugin install crew@claude-mods
```

Expected: `Installed crew`. A folder marketplace with a relative `source` is read from the folder itself, so later edits only need `/reload-plugins` in a session, with no reinstall.

- [ ] **Step 3: Check it in the Desktop Code tab**

In a fresh Code-tab session, ask: "Spawn three parallel sub-agents: one to research X, one to design Y, one to build Z, then review." Confirm:
- [ ] The band shows `Agents 0/3` and climbs to `3/3`. The dot turns green when the turn ends.
- [ ] The Agents pane opens on the first spawn. It shows the Main row, Running and then Finished groups, and the model and effort on each row.
- [ ] Tokens and ≈$ grow while agents run. ctx % is non-zero. Elapsed times stop when each agent finishes.
- [ ] Each mascot wears its role accessory.
- [ ] `×` on the band hides it until the next prompt.
- [ ] `/crew` reopens the pane after closing it.
- [ ] "Make my designer mascot wear a hard hat" makes Claude call `mcp__crew__set_mascot`, and the designer row updates. In a new session the change is still there.
- [ ] Pressing Esc mid-run marks the running agents ✗ *stopped*.

- [ ] **Step 4: Check it in the terminal**

In a terminal, run `claude` from any project and repeat the three-agent prompt. Confirm that the sprite draws as half blocks and that the pane docks at ≥110 columns in fullscreen.

- [ ] **Step 5: Fix what the live check finds**

For each problem:
1. Write a failing test in the matching `test/*.test.ts`.
2. Fix it.
3. Run `claude plugin test`.
4. Run `/reload-plugins` in the session and recheck.
5. Commit each fix separately (`fix: ...`).

- [ ] **Step 6: Tag the release**

```bash
git tag v0.1.0
```
