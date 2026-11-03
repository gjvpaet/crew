# Crew speech bubbles — design

Date: 2026-11-03 · Branch: `feat/speech-bubbles` (from `build/v0.1`)

## Goal

Each agent card in the Agents panel gets a speech bubble above its Pip. While the agent runs, the bubble says what it is doing right now. When it finishes, the bubble says a short success phrase for a few seconds, then goes away.

## Behaviour

### While running: the latest action

The bubble shows the agent's latest tool call, set when the call **starts**, so it reads as "doing now". It stays until the next tool call replaces it.

| Tool | Bubble text |
| --- | --- |
| `Read` | `Reading <file name>` |
| `Edit`, `Write`, `NotebookEdit` | `Editing <file name>` |
| `Bash` | `Running <command>`: the first two words of the command, after any leading `cd <dir> &&` (`Running bun test`, `Running git status`) |
| `Grep` | `Searching for '<pattern>'` |
| `Glob` | `Finding <pattern>` |
| `WebFetch` | `Reading <host>` |
| `WebSearch` | `Searching the web` |
| `Agent` | `Briefing a sub-agent` |
| `Skill` | `Using <skill name>` |
| Task-list tools (`TodoWrite`, `TaskCreate`, `TaskUpdate`, …) | no change: the steps line already shows them |
| Crew's own tools (`open_panel`, `set_mascot`) | no change |
| An MCP tool `mcp__<server>__<tool>` | `Using <tool>`, with underscores as spaces |
| Any other tool | `Using <Tool>` |

- `<file name>` is the base name of the path (`band.tsx`, not the full path).
- Text longer than 28 letters is shortened in the middle with `…`, keeping its end, the same way the Files pane shortens long names (`clipName`).
- An agent that has made no tool call yet has no bubble.
- A tool call that is denied or fails still counts: the bubble said what the agent set out to do.
- Main gets a bubble too, from its own tool calls. When Main is idle (the sleeping zzz pose), it has no bubble.

### When finished: a success phrase

- When an agent's turn ends normally, its bubble changes to a success phrase for **6 seconds**, then disappears and the card shrinks back to its usual height.
- The phrase comes from a fixed list of 12 (below). It's picked by hashing the agent's id, so one agent always shows the same phrase, and the bubble doesn't change on every redraw.
- When an agent stops or fails, its bubble shows a gentle line from a list of 4 for the same 6 seconds.
- Main follows the same rule when its turn ends.

Success phrases: `Nailed it!`, `Ship it!`, `All green`, `Ta-da!`, `Done and dusted`, `Easy peasy`, `That's a wrap`, `Mission complete`, `Sorted!`, `Boom, done`, `Like a charm`, `High five!`.

Stopped phrases: `Hit a snag`, `Ran out of road`, `Taking a breather`, `Not this time`.

## Look

### Desktop (and any surface that draws SVG)

- The card becomes two rows: the bubble on its own line at the top, then today's row (Pip, text column, time column) unchanged.
- The bubble is an SVG drawn by a new `bubbleSvg(text, tone)` in `hooks/svg.ts`:
  - 12px sans text, 20px tall body with fully rounded ends, padX 9.
  - Its width comes from `textEms` (the same letter-width table the shine and badges use).
  - A 6px tail at its bottom-left, sitting over Pip's head.
  - A 1px edge in Cool Greige `#C7C4BF`, so it reads on light and dark panels alike.
- Fills by tone:

| Tone | Fill | Text |
| --- | --- | --- |
| Running | `#F4F4F2` | `#2C2C2A` |
| Finished | `#C0DD97` | `#173404` |
| Stopped or failed | `#D3D1C7` | `#444441` |

- The `alt` is the bubble's full text, before shortening.

### Terminal

- In the same spot, a line `▸ <text>` above the card's row.
- Dim while running, green when finished, dim grey when stopped.

### Budget

- The bubble's SVG source and its nodes count towards the card's cost in the panel's drawing budget (`cardCost`).
- Rows already shrunk to a single line, because the budget ran out, get no bubble.

## Data

- A new tracker event `{ kind: 'action'; agentId?: string; text: string }`.
- It sets `action` on the agent's record (`AgentRecord.action?: string`, declared in `types/index.d.ts`). An absent `agentId` means Main, as for every other event.
- Because the record lives in `$.state`, a `/reload-plugins` keeps the latest action.
- `register.tsx`'s `tool.call` hook dispatches the event **before** `next(e)`.
  - The tool-to-text mapping is a pure function, `actionText(tool, input)`, in a new `hooks/bubble.ts`.
  - It returns `undefined` for the tools that change nothing; then no event is dispatched.
- The view (`hooks/view.ts`) adds two fields to `RowView`:
  - `bubble: string`, empty for no bubble;
  - `bubbleTone: 'running' | 'done' | 'stopped'`.
- The view derives them:
  - **Running:** the record's `action` while the agent runs.
  - **Finished or stopped:** `phraseFor(id, tone)` while `now - endedAt < 6000`.
  - **Otherwise:** empty.
- `phraseFor` lives in `hooks/bubble.ts`.
- The panel already redraws every second, so the 6-second bubble needs no timer of its own.

## Files

- **New:** `hooks/bubble.ts` (`actionText`, `phraseFor`, the two phrase lists), with `test/bubble.test.ts`.
- **Changed:**
  - `hooks/tracker.ts`: the `action` event in `CrewEvent` and the reducer.
  - `types/index.d.ts`: `AgentRecord.action`.
  - `hooks/register.tsx`: dispatch before `next`.
  - `hooks/view.ts`: `bubble` and `bubbleTone`.
  - `hooks/svg.ts`: `bubbleSvg`.
  - `hooks/panel.tsx`: the bubble row and its budget cost.
- **Tests:** extend `test/tracker.test.ts`, `test/view.test.ts`, `test/svg.test.ts` and `test/ui.test.ts`.

## Testing

- `actionText`: one case per row of the table, including `cd x && bun test`, an MCP tool, a task tool (`undefined`), and shortening past 28 letters.
- `phraseFor`: the same id always gives the same phrase, and the phrase is always from the matching list.
- Tracker: an `action` event sets the record's `action`, and a later one replaces it.
- View, with a running agent:
  - its bubble is its action;
  - with no action yet, there's no bubble.
- View, after an agent ends:
  - a finished agent shows its phrase until 6 seconds after `endedAt`, and none after;
  - a stopped agent shows a stopped phrase.
- Panel, on Desktop: the card holds a bubble `Svg` whose alt is the full text, above the row.
- Panel, in the terminal: the `▸` line.
- Panel, a long panel: it stays inside the drawing budget, and shrunk single-line rows have no bubble.
- `bubbleSvg`: the width follows the text, there's a tail, and each tone's fill is used.

## Out of scope

- The task bar above the prompt gets no bubble.
- No bubble animation: no pop-in and no typing dots.
- No settings to turn the bubble off, or to change the phrases.

## As built

Where the build differs from the design above, from the reviews:

- **At most 24 bubbles per drawing** (`MAX_BUBBLES`). The first 24 cards drawn get them, running agents first; later cards drop theirs. Main's card is never capped. Uncapped, 220 agents pushed the terminal pane past its 20,000-node ceiling.
- **The redraw ticker keeps a once-a-second beat** while a finished agent's phrase is up (`isCheering`), for `BUBBLE_MS + 2000`. Without it, the bubble wouldn't clear once nothing else is live. Like `bubbleOf`, it treats a clock that moved backwards as "not fresh".
- **An empty subject changes nothing.** A missing file path, an empty pattern, an empty command after stripping, or a missing skill name sends no event, so the previous bubble stays up.
- **Bash text skips setup hops:**
  - leading `cd <dir>` (quoted or not), `source <file>`, `. <file>` and `nvm use <version>` hops, followed by `&&` or `;`;
  - `export` and `env` assignments, and bare `NAME=value` assignments;
  - any shown word that contains `=` is dropped, so an assignment's value never reaches the bubble.
- **Bubble text is capped at 120 characters** in state. The drawing shortens it to 28 letters, while the alt and the terminal line keep up to 120.
- **`TaskList` and `TaskGet` are quiet** too, along with the task tools.
- **WebFetch shows only the host,** never `user:pass@`.
- **MCP tool names:** runs of underscores become one space.
- **Main's phrase is picked by the turn id,** so it changes from prompt to prompt. Sub-agents still use their own id.
- **A run starts without an action.** A resumed sub-agent, Main's continuation turn and a revived agent all start with no bubble until their next tool call.
- **`apply` skips any event that changes nothing,** so a repeated action writes and redraws nothing.
- **In the terminal,** a stopped bubble is plain dim, the same as a running one.

Left for later:

- **Pip's hop may restart** when its card switches between one row and two.
- **"Briefing a sub-agent" stays up** on the parent for the whole of a foreground sub-agent's run.
- **The terminal's node ceiling** at around 220 agents, which predates this feature.
