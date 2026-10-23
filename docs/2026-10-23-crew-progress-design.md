# Crew — progress band + live agents panel (design)

Date: 2026-10-23
Status: approved in brainstorming, awaiting spec review

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
- Events: `agent.spawn` (carries the model), `turn.step` (carries `result.usage` and `result.model`, tagged by `agentId`), `turn.start`, `turn.complete` (`durationMs`, `usage`, `isAborted`, tagged by `agentId` for sub-agents).
- `$.agent.list()` returns `id, description, type, status, parentId, spawnedBy, name`. Status is one of `pending | running | waiting | idle | completed | failed | killed`.
- Not documented: a task-list/todo event, per-agent reasoning effort, a pricing source. The design treats all three as optional or self-supplied.
- Storage: `$.state` lasts the session and survives hot reload (reset by `/clear`, `/resume`, `/branch`). `$.store` is a JSON store shared by every session on the machine.
- The hooks module has no Node APIs (use `$.fs`, `$.process`, `$.http`). It is plain ES modules with no build step.

## What the user sees

### Band above the prompt

```
● Refactor deal filters   [██████░░░░ Tasks 3/5]  60%   ▣×3   ×
```

- **Shown when** a turn is running and either at least one sub-agent exists or a task list has been seen. A turn with neither shows no band.
- **Label:** the task list's title when visible, otherwise the first line of the user's prompt, shortened.
- **Count (Hybrid source):**
  - When task-list tool calls are visible: `Tasks done/total`.
  - Otherwise: `Agents finished/spawned`.
  - The label in the pill says which source is in use.
- **Percent:** done ÷ total for whichever source is active.
- **Mascot count:** sub-agents currently running.
- **After the turn ends:** the last state stays visible until the next prompt. `×` hides the band until the next turn that would show it.

### Agents panel

- **Header cards:** ≈Cost · Tokens · Time for the current turn. A small line underneath shows session totals.
- **Groups, in order:**
  - Running
  - Waiting (`pending`, `waiting`, `idle`)
  - Finished (`completed`)
  - Failed (`failed`, `killed`, and agents stopped by an aborted turn, labelled *stopped*)
- **Each row:**
  - mascot and description
  - model, plus effort only when the event data includes it (never inferred)
  - tokens · ctx % · ≈$ · elapsed
  - a bar that shimmers while running and fills at the end, with ✓ (finished) or ✗ (failed or stopped)
  - per-agent step progress (`3/5 · step name`) only when that agent's own task-list calls are visible
- **A Main row** for the lead agent, so the rows sum to the header totals.
- **Many agents:** with more than 8 rows, Finished collapses to a single expandable `Finished · N` line.
- **Nested agents:** listed flat, with `↳ from <parent description>` taken from `parentId`.

### Mascots

- One **original** 8×8 pixel character created for this mod. It is not based on any existing mascot or brand character, including the crabs in the inspiring mod and Anthropic's mascot.
- Drawn as block cells so the terminal and Desktop render it the same way.
- Accessory by role:

  | Role | Accessory |
  |---|---|
  | Developer | Headset |
  | Designer | Beret |
  | Researcher | Magnifier |
  | Reviewer | Hard hat |
  | Plain | None |

- The role comes from the agent's `type` first, then keywords in its `description` (see `roles.js`).
- **Restyling:** the user asks Claude, which writes the choice into the `$.store` key `crew.mascots`. The role → accessory/colour overrides apply across sessions.

## Architecture

Each unit has one job. The calculating units import nothing from the UI and are tested without drawing anything.

| Unit | Responsibility | Depends on |
|---|---|---|
| `tracker.js` | A pure reducer: `(state, event) → state`. Holds the current turn, task-list snapshot and an `agents` map keyed by agent id: `description, type, role, model, effort?, status, parentId, spawnedAt, endedAt, usage {input, output, cacheRead, cacheWrite}, lastRequestInput, steps?`. Also exports derived selectors for progress, totals and groups. | `roles.js` |
| `pricing.js` | Price table per model family × {input, output, cacheRead, cacheWrite} per MTok, with an `asOf` date. `estimate(usage, model)` returns `null` for unknown models. `contextWindow(model)` returns 1M for `[1m]` variants and 200k otherwise. | none |
| `roles.js` | `roleFor({type, description})` returns `developer | designer | researcher | reviewer | plain`. | none |
| `sprite.js` | The base 8×8 grid plus accessory overlays and colours. Returns rows of cells. | none |
| `band.js` | Draws the `AbovePrompt` band from tracker selectors. | `tracker.js`, `sprite.js` |
| `panel.js` | Draws the dock/inline Agents pane from tracker selectors. | `tracker.js`, `sprite.js`, `pricing.js` |
| `index.js` | `register(on, options)`: subscribes to events, feeds the tracker, keeps state in `$.state`, loads mascot overrides from `$.store`, triggers re-draws. | all |

### Data flow

1. `turn.start` (main agent): opens a new turn and resets per-turn totals. Session totals keep accumulating.
2. `agent.spawn`: adds the agent with its model, role, `spawnedAt` and status `running` (or `pending` if the event says it hasn't started).
3. `turn.step`: adds `result.usage` to that agent (the main agent when there is no `agentId`), sets the model if missing, and records `lastRequestInput = input + cacheRead + cacheWrite` for ctx %.
4. `turn.complete` with an `agentId`: marks that agent `completed` and sets `endedAt`. Without one (the main turn): marks the turn finished. If `isAborted`, agents still running become *stopped*.
5. On each `turn.step`, reconcile against `$.agent.list()` to pick up `waiting`, `failed` and `killed` statuses that no event announces.
6. Task-list tool calls, if the mod can observe tool use: parse the tool input into `{title, done, total}` for the turn (or into `steps` for a sub-agent). Candidate tools: TodoWrite, TaskCreate/TaskUpdate, and the Desktop app's plan tool. Which ones are observable is confirmed in the first build step. If none are, the band uses the agents count only.

### Cost and ctx %

- `≈$ = Σ tokens × price` per type, using cache-read and cache-write prices for cached tokens.
- Always prefixed with `≈`. Unknown model gives `≈?`.
- Prices are taken from the current Claude pricing reference at build time (not from memory) and stamped with `asOf`.
- `ctx % = lastRequestInput ÷ contextWindow(model)`.

## Edge cases

| Case | Behaviour |
|---|---|
| Unknown or new model | Tokens still count, cost shows `≈?`, and ctx % uses the 200k window. |
| Aborted turn | Running agents are marked *stopped* (Failed group, ✗) and their clocks freeze. |
| No sub-agents and no visible task list | No band. The panel shows only the Main row. |
| Hot reload | State lives in `$.state`, so nothing is lost when the module reloads. |
| `/clear`, `/resume`, `/branch` | Session state resets, so the panel empties. Mascot overrides in `$.store` remain. |
| Two sessions editing mascots at once | `$.store` is not atomic. Last write wins, which is acceptable for cosmetic data. |
| Effort not present | The field is left out, never guessed. |

## Testing

- **Unit tests** with Node's built-in `node:test` (no dependencies):
  - `tracker.js`: replay recorded event fixtures (3 parallel agents, one failed, one nested agent, an aborted turn, a turn with no agents) and assert progress, groups, totals and statuses.
  - `pricing.js`: known model, unknown model, cache-token pricing, the `[1m]` context window.
  - `roles.js`: type-first precedence, keyword matching, fallback to plain.
- **Live check:** with hot reload in a real session, set off a turn with 3 parallel sub-agents. Confirm the band and panel in the Desktop Code tab and in the terminal, at both docked and narrow widths.

## Location and install

- Source: `~/Documents/Applications/claude-mods/crew/`, its own git repo.
- Development: hot reload (Claude-written dev mod, or `claude --plugin-dir`).
- Daily use: installed from a small local marketplace in `claude-mods/` so it loads in every session. Each release needs a version bump and `/reload-plugins`.

## Later (not v1)

- A planning command that declares tasks and dependencies, enabling "planned · after N".
- Nested agents drawn as an indented tree instead of a flat list.
- A setting to hide $ figures.
