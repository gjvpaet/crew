---
name: crew-build
description: Takes a feature or multi-step change from idea to a finished branch with the superpowers flow (brainstorming, writing-plans, using-git-worktrees, subagent-driven-development) while the Crew agents panel shows the plan and every sub-agent's progress, and verifies browser-visible changes in the user's real default browser. Use when the user asks to build, implement or ship a feature end to end, says "crew build", or wants planned, sub-agent-driven work they can watch in the Agents panel.
---

# Crew build

One run, four superpowers skills in order, with the Crew panel open the whole way.

## Quick start

1. Open the panel: call `mcp__crew__open_panel` (no inputs). If it is deferred, load it first with ToolSearch `select:mcp__crew__open_panel`. If it doesn't exist, Crew isn't installed or enabled here; say so in one line and carry on.
2. Invoke `superpowers:brainstorming` with the user's request.
3. Follow each skill through to the next one, as listed in the workflow below.

## Workflow

Copy this checklist into the task list and tick it off as you go:

- [ ] Open the Crew panel (`mcp__crew__open_panel`)
- [ ] `superpowers:brainstorming`: design agreed with the user, spec written
- [ ] `superpowers:writing-plans`: implementation plan written (brainstorming hands off here)
- [ ] `superpowers:using-git-worktrees`: isolated worktree ready before any code changes
- [ ] `superpowers:subagent-driven-development`: tasks built by sub-agents, each one reviewed
- [ ] Browser verification in the user's default browser (when the change shows up in a browser)

Rules for each stage:

- **Brainstorming.** Its hard gate stands: no code until the user approves the design. Ask the user to choose; never assume.
- **Writing plans.** Put the plan where that skill says, unless the user or the repo's CLAUDE.md names another place.
- **Worktrees.** Create or confirm the worktree before the first implementer runs. Never build on `main`/`master` without the user's explicit consent.
- **Subagent-driven development.** One implementer per task, then spec review, then quality review. Keep sub-agents on that skill's prompt templates.

## Keep Crew showing the work

Crew draws from the task list and the sub-agents, so keep both honest:

- Mirror the plan's tasks in the app's task list: `mcp__ccd_turn__update_plan` in the desktop app, `TodoWrite`/`TaskCreate` elsewhere. Advance it as each task finishes. Crew turns this into Main's progress bar and its Planned section.
- Give each sub-agent a short, specific `description` (for example "Implement Task 3: parser"). Crew uses it as the card title.
- Crew asks every sub-agent to keep its own task list, which becomes that card's progress bar. Leave that note in their prompts.

## Browser verification: the user's real default browser

Verify in the browser the user actually uses, not the built-in browser pane (`mcp__Claude_Browser__*`) and not headless Chrome.

1. Find the default browser (macOS):
   ```bash
   plutil -convert json -o - ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist | python3 -I -c "import json,sys; print(next((h['LSHandlerRoleAll'] for h in json.load(sys.stdin).get('LSHandlers',[]) if h.get('LSHandlerURLScheme')=='https'),'unknown'))"
   ```
2. If it prints `com.google.chrome`, use Claude in Chrome (`mcp__claude-in-chrome__*`). Load the core set in one ToolSearch call: `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp`. Add `read_console_messages` and `read_network_requests` when you're debugging.
3. If it's another browser, or Claude in Chrome isn't connected, tell the user which browser is the default and that it can't be driven. Ask whether to open the page there with `open <url>` for them to check, or to fall back to the built-in pane. Never switch browsers without asking.
4. When a sub-agent does the verifying, put these same instructions in its prompt.
5. The user's sign-ins in their real browser are theirs. Don't sign out, change settings, or act on an account beyond what the check needs. Ask before submitting forms or taking irreversible actions.

## Finish

Once subagent-driven development finishes, it hands off to `superpowers:finishing-a-development-branch`. Report what was built, what was verified and where, and what wasn't. Commit or push only as those skills and the user allow.
