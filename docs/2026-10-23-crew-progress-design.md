# Crew — progress band + live agents panel (design)

Date: 2026-10-23
Status: implemented on branch build/v0.1, awaiting live check

A personal Claude Code mod, inspired by the community "Savvy Progress" mod: a progress band above the prompt and a live panel of every sub-agent with its model, tokens and an estimated cost, each drawn with a small original pixel mascot.

## Goals and scope

- **Audience:** one user (the author), every project on this machine. Not shared with a team, not part of any project repo.
- **v1 includes:** progress band, Agents panel, token and ≈$ estimates, role-based pixel mascots.
- **Out of scope for v1:** a planning command that declares tasks and dependencies up front (the "planned · after 1, 2, 3" view). The structure must leave room to add it later without a rewrite.

## Platform facts this design relies on

From the Claude Code mods docs (overview, reference, events, interface, api):

- Mods run in the terminal (≥ 2.1.287) and the Desktop Code tab (≥ 2.1.286). Not in `claude -p`, cloud or WSL desktop sessions.
- Surfaces: `AbovePrompt` band (terminal + Desktop), a pane that docks beside the transcript at ≥ 800px and sits inline above the prompt below that, plus status line, toast and log.
- There is no progress-bar primitive. Bars are built from `Box` and `Text`. `Raster`/`Image` are terminal-only and `Svg` is Desktop-only, so the sprite uses block cells, which render in both.
- Events: `agent.spawn` (the model comes back on the result of `next`), `turn.step` (carries `result.usage`, `result.model` and `effort`, tagged by `agentId`), `turn.start`, `turn.complete` (`durationMs`, `usage`, `isAborted`, tagged by `agentId` for sub-agents).
- `tool.call` sees `TodoWrite`, `TaskCreate`, `TaskUpdate` and `mcp__ccd_turn__update_plan`, with `agentId` set for sub-agents. That is what feeds task progress.
- `$.agent.list()` returns `id, description, type, status, parentId, spawnedBy, name`. Status is one of `pending | running | waiting | idle | completed | failed | killed`.
- Not documented: a task-list/todo event and a pricing source. The task list is read from `tool.call` (above) and prices are self-supplied.
- Storage: `$.state` lasts the session and survives hot reload (reset by `/clear`, `/resume`, `/branch`). `$.store` is a JSON store shared by every session on the machine.
- The hooks module has no Node APIs (use `$.fs`, `$.process`, `$.http`). It is TypeScript (`.ts`/`.tsx`) ES modules that the engine loads directly, with no build step.
- The engine's static scan follows `$.state` refs only through consts in the same file, so each `.tsx` declares its own `atom(...)`. Helpers that take `$` must be top-level function declarations.
- Gating hooks (`agent.spawn`, `tool.call`) carry `.catch(($, e, next) => next(e))`, so a Crew error never blocks a spawn or a tool call.

## What the user sees

### Band above the prompt

```
● Refactor deal filters ██████░░░░ Tasks 3/5 60% 3 running ×
```

Every gap between segments comes from the row's `gap`, never from spaces inside a text (Desktop drops trailing spaces).

That is the terminal. On desktop, vscode and mobile the bar is one 160×18 px SVG with the pill (`Tasks 3/5`) drawn inside it (purple pill, lilac fill), and a 16 px developer Pip sits before `N running`.

- **Shown when** a turn is running and either at least one sub-agent exists or a task list has been seen. A turn with neither shows no band.
- **Label:** the first line of the user's prompt, shortened (task lists have no title in the tool data, so it is always the prompt).
- **Count (Hybrid source):**
  - When task-list tool calls are visible: `Tasks done/total`.
  - Otherwise: `Agents finished/spawned`.
  - The label in the pill says which source is in use.
- **Percent:** done ÷ total for whichever source is active.
- **Running count:** `N running`, the sub-agents currently running. Left out entirely when the turn has no sub-agents (a task-list-only turn); reads `0 running` once every sub-agent has ended.
- **After the turn ends:** the last state stays visible until the next prompt. `×` hides the band until the next prompt.

### Agents panel

- **Header cards:** ≈Cost · Tokens · Time for the current turn only (requests are tracked per model in `turnByModel`). A small line underneath shows session totals. When some model has no price, the header cost is a partial sum marked `+`.
- **Groups, in order** (each header is a button, `▾ Running · 2` / `▸ Finished · 3`, that folds its group; the choice is kept per group):
  - Running
  - Waiting (`pending`, `waiting`, `idle`)
  - Finished (`completed`)
  - Failed (`failed`, `killed`, and agents stopped by an aborted turn, labelled *stopped*)
- **Each agent is a rounded card:** Pip on the left (a crisp 32 px SVG on desktop, vscode and mobile; half-block text on the terminal), then:
  - description, with elapsed time and ✓ (finished), ✗ (failed or stopped) or a note on the right
  - effort coloured by level (low green, medium blue, high amber, xhigh/max red), only when the event data includes it (never inferred), then model · ctx % · tokens · ≈$ for that agent's lifetime usage
  - per-agent step progress (`3/5 · step name`) only when that agent's own task-list calls are visible
  - a bar in the agent's own colour (six fixed accents, the next one taken when the agent is first seen and kept for its life, through a resume too; Main wears Pip's blue `#7C9CF5`, which no sub-agent gets): to scale with steps, full at the end, a shimmer while running without steps. An SVG off the terminal, the text bar on it.
- **A Main card** for the lead agent. Main starts from zero each turn, so it matches the header; a sub-agent that carries over from an earlier turn shows its lifetime usage, so the rows can exceed the header totals. Once Main's own turn has ended while sub-agents still run, it reads `waiting on N agents` instead of ✓.
- **Many agents:** with more than 8 sub-agents (Main not counted), Finished starts folded; every group starts open otherwise.
- **Nested agents:** listed flat, with `↳ from <parent description>` taken from `parentId`.

### Mascots

- One **original** 8×8 pixel character, "Pip", created for this mod: a round bean body with dot eyes and stubby feet. It is not based on any existing mascot or brand character, including the crabs in the inspiring mod and Anthropic's mascot.
- Drawn as half-block cells (4 rows of 8) on the terminal and as one SVG rect per pixel elsewhere, both from the same pixel list (`spritePixels`).
- Accessory by role:

  | Role | Accessory |
  |---|---|
  | Developer | Headset |
  | Designer | Beret |
  | Researcher | Glasses |
  | Reviewer | Hard hat |
  | Plain | None |

- The role comes from the agent's `type` first, then keywords in its `description` (see `roles.ts`).
- **Restyling:** the user asks Claude, which calls the model-callable tool `mcp__crew__set_mascot` (inputs: `role`, `accessory`, `body` and `accent` as `#RRGGBB`, or `reset`). The mod answers the call itself (it never reaches a real tool) and persists the role's overrides in the `$.store` key `mascots`. They are loaded on `session.start` and apply across sessions. Bad input is refused with a message that names the valid values.

## Architecture

Each unit has one job. The calculating units import nothing from the UI and are tested without drawing anything.

| Unit | Responsibility | Depends on |
|---|---|---|
| `tracker.ts` | A pure reducer: `(state, event) → state`. Holds the current turn, the main task list, per-agent task lists, an `agents` map keyed by agent id (`description, type, role, model, effort?, status, parentId, spawnedAt, endedAt, usage {input, output, cacheRead, cacheWrite}, lastRequestInput, steps?, colorIndex?`), per-model usage for the session and for the turn (`sessionByModel`, `turnByModel`) `known`, the identity of every agent seen (colour index included), and `nextColor`, the index the next new sub-agent takes. Also exports derived selectors for progress, totals and groups. | `roles.ts`, `pricing.ts`, `tasks.ts` |
| `tasks.ts` | Turns task-list tool calls (`TodoWrite`, `TaskCreate`, `TaskUpdate`, `mcp__ccd_turn__update_plan`) into a task list and `{done, total, current}`. | none |
| `pricing.ts` | Per-model price table (input, output, cacheRead, cacheWrite per MTok, plus context window) with an `asOf` date. `estimateUsd(usage, model)` returns `null` for unknown models. `contextWindow(model)` comes from the same table. | none |
| `roles.ts` | `roleFor({type, description})` returns `developer | designer | researcher | reviewer | plain`. | none |
| `sprite.ts` | The base 8×8 grid plus accessory overlays and colours. `spritePixels` lists the coloured pixels; `spriteCells` packs them into half-block cells. | none |
| `svg.ts` | Pure SVG markup builders for the non-terminal surfaces: `pipSvg` (one crisp rect per pixel), `barSvg` (rounded track, fill, deterministic shimmer from `now`), `bandBarSvg` (bar plus a centred pill), `escapeXml`. Hex/rgba only: theme names do not reach inside an SVG. | `sprite.ts`, `format.ts` |
| `mascot.ts` | The `set_mascot` tool spec, input validation and the pure function that applies a change to the saved prefs. | none |
| `format.ts` | Display helpers: token, ≈$, duration and percent formatting, text bars, the running shimmer, truncation, model names. | none |
| `view.ts` | Pure view models: `bandLine` and `panelView` (rows, groups, header cards) built from tracker selectors. A row carries its accent, effort and its theme tone, model, `fraction` (null = shimmer) and Main's waiting state; `panelView` takes the `groupOpen` overrides and `toggleGroup` computes the next one. | `tracker.ts`, `sprite.ts`, `pricing.ts`, `format.ts` |
| `band.tsx` | Draws the `AbovePrompt` band from `view.ts`: the SVG bar off the terminal, the text bar on it (`e.surface`). | `tracker.ts`, `view.ts`, `svg.ts` |
| `panel.tsx` | Draws the dock/inline Agents pane from `view.ts` as cards, SVG Pip and bars off the terminal, half-block text on it. Group headers write `groupOpen`. | `tracker.ts`, `view.ts`, `sprite.ts`, `svg.ts` |
| `register.tsx` | `register(on)`: subscribes to events, feeds the tracker, keeps state in `$.state`, registers the `/crew` command and the `set_mascot` tool, loads mascot overrides from `$.store` on `session.start`, opens the pane on the first spawn, and installs the band and pane renderers. Listed in `hooks/hooks.json`. | all |

The `$.state` contract (state types, `PluginState`) lives in `types/index.d.ts`: `model`, `isBandHidden`, `groupOpen` (per-group fold overrides, replacing `isFinishedOpen`), `mascots`, `hasAutoOpened`.

### Data flow

1. `turn.start` (main agent): opens a new turn with a fresh Main row and resets the per-turn totals. Session totals keep accumulating, and sub-agents that are still live carry over.
2. `agent.spawn`: after `next` returns the new agent id and model, adds the agent with its role and `spawnedAt`, status `running`. The first spawn also opens the pane.
3. `turn.step`: adds `result.usage` to that agent (the main agent when there is no `agentId`), to the session and turn totals for that model, sets the model and effort, and records `lastRequestInput = input + cacheRead + cacheWrite` for ctx %.
4. `turn.complete` with an `agentId`: marks that agent `completed` (or `failed` on an error or refusal) and sets `endedAt`. Without one (the main turn): marks the turn finished. If `isAborted`, agents still `running` or `pending` become *stopped*.
5. On each `turn.step`, once any sub-agent exists, reconcile against `$.agent.list()` to pick up `waiting`, `idle`, `failed` and `killed` statuses that no event announces.
6. `tool.call` for a task-list tool (when it was not denied and did not error): parse the input into the turn's task list, or into `steps` for a sub-agent. If no task list is seen, the band uses the agents count only. `mcp__crew__set_mascot` is handled here too.

Tracker behaviours worth knowing:

- An empty-text main `turn.start` is a continuation: it reopens the turn and Main instead of starting a new turn.
- Agent identity (`known`) survives prompts, so a resumed agent keeps its name and role.
- An abort stops only `running` and `pending` agents.
- A step that carries usage revives a stopped agent.
- The status list never moves an ended agent back to live.
- `idle` counts as done for band progress, but shows under Waiting in the pane.
- Usage fields are missing-safe: an absent or null field counts as 0, so a partial usage object never produces NaN totals. (A literal NaN is not filtered.)

### Cost and ctx %

- `≈$ = Σ tokens × price` per type, using cache-read and cache-write prices for cached tokens.
- Always prefixed with `≈`. Unknown model gives `≈?`.
- Prices are taken from the current Claude pricing reference at build time (not from memory) and stamped with `asOf` (2026-10-06). Cache writes use the 5-minute rate.
- `ctx % = lastRequestInput ÷ contextWindow(model)`. The window comes from the per-model table: 1M for every current model, 200k only for Haiku 4.5 and unknown models.
- Header totals cover this turn's requests only. Per-agent rows show that agent's lifetime usage.

## Edge cases

| Case | Behaviour |
|---|---|
| Unknown or new model | Tokens still count, cost shows `≈?` (the header shows a partial sum marked `+`), and ctx % uses the 200k window. |
| Aborted turn | Running agents are marked *stopped* (Failed group, ✗) and their clocks freeze. |
| No sub-agents and no visible task list | No band. The panel shows only the Main row. |
| Hot reload | State lives in `$.state`, so nothing is lost when the module reloads. |
| `/clear`, `/resume`, `/branch` | Session state resets, so the panel empties. Mascot overrides in `$.store` remain. |
| Two sessions editing mascots at once | `$.store` is not atomic. Last write wins, which is acceptable for cosmetic data. |
| Effort not present | The field is left out, never guessed. |

## Testing

- **Unit tests** run with `claude plugin test` using `claude-code/testing` (TypeScript), not `node:test`:
  - `tracker.ts`: replay recorded event fixtures (3 parallel agents, one failed, one nested agent, an aborted turn, a turn with no agents) and assert progress, groups, totals and statuses.
  - `pricing.ts`: known model, unknown model, cache-token pricing, per-model context windows.
  - `roles.ts`, `tasks.ts`, `mascot.ts`, `sprite.ts`, `format.ts`, `view.ts`: precedence and fallbacks, tool-call parsing, input validation, grid and colour output, formatting, view models.
  - UI tests mount the band and the pane on both the terminal and the desktop surface, press `×`, and call `set_mascot` and an ordinary tool through the gating hooks.
- **Live check:** with hot reload in a real session, set off a turn with 3 parallel sub-agents. Confirm the band and panel in the Desktop Code tab and in the terminal, at both docked and narrow widths.

## Location and install

- Source: `~/Documents/Applications/claude-mods/crew/`, its own git repo.
- Development: hot reload (Claude-written dev mod, or `claude --plugin-dir`).
- Daily use: installed from a small local marketplace in `claude-mods/` so it loads in every session. Each release needs a version bump and `/reload-plugins`.

## Later (not v1)

- A planning command that declares tasks and dependencies, enabling "planned · after N".
- Nested agents drawn as an indented tree instead of a flat list.
- A setting to hide $ figures.

## Not in v1 / known gaps

- Per-agent `known` identities are not pruned. That is fine at realistic sizes.
- Nested agents are shown flat.
