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
- [ ] `superpowers:using-git-worktrees`: base branch chosen by the user, isolated worktree ready before any code changes
- [ ] `superpowers:subagent-driven-development`: tasks built by sub-agents in parallel waves where they're independent, each one reviewed
- [ ] Browser verification in the user's default browser (when the change shows up in a browser)
- [ ] No `Co-Authored-By:` line on any commit in the branch
- [ ] Worktrees removed once the work is done, branches kept locally
- [ ] Tests run in small chunks, one run at a time, never the whole heavy suite at once

Rules for each stage:

- **Brainstorming.** Its hard gate stands: no code until the user approves the design. Ask the user to choose; never assume.
- **Writing plans.** Put the plan where that skill says, unless the user or the repo's CLAUDE.md names another place. Give every task a `Depends on:` line (task numbers, or `none`) next to its `Files:` list, so the parallel waves below can be read straight off the plan.
- **Worktrees.** Create or confirm the worktree before the first implementer runs. Never build on `main`/`master` without the user's explicit consent.
  - **Ask for the base branch first, every time.** Before creating a worktree, ask the user which branch to base it on, with AskUserQuestion. Offer the current branch and the repository's default branch, plus any branch the conversation has named. Never pick one yourself, even when only one seems likely. Reusing an existing worktree needs no question.
  - The per-implementer worktrees in a parallel wave (below) are cut from the feature branch the user already chose, so they don't need the question again.
- **Subagent-driven development.** One implementer per task, then spec review, then quality review. Keep sub-agents on that skill's prompt templates. Run independent tasks in parallel, as described below.

## Run independent sub-agents in parallel

This replaces subagent-driven-development's "never dispatch implementers in parallel" rule, but only for tasks that can't collide:

1. **Group the plan into waves.** A task joins the current wave when every task it depends on is finished, reviewed and merged, and it shares no file with another task in the wave. Everything else waits for a later wave. If you can't tell whether two tasks are independent, run them one after the other.
2. **Dispatch a wave in one message.** Send one Agent call per implementer in the same message so they run at the same time. Give each implementer `isolation: "worktree"`, so the implementers' test runs and commits can't collide. Those worktrees come from the feature branch, the base the user already chose.
3. **Review in parallel too.** Each task still goes implementer → spec review → quality review, in that order. Different tasks' reviews can run side by side. Reviewers only read, so they don't need a worktree of their own.
4. **Merge back in plan order.** Once a task passes both reviews, merge its branch into the feature worktree. Merge in task-number order. After each wave, run the suite in chunks (see "Tests: small chunks, never all at once" below) before starting the next one. A merge conflict means two tasks weren't independent after all: resolve it, and run tasks like those one after the other from then on.
5. **One wave at a time.** Don't start a task whose dependency is still being built or reviewed, even if every other task is idle.

## Keep Crew showing the work

Crew draws from the task list and the sub-agents, so keep both honest:

- Mirror the plan's tasks in the app's task list: `mcp__ccd_turn__update_plan` in the desktop app, `TodoWrite`/`TaskCreate` elsewhere. Advance it as each task finishes. Crew turns this into Main's progress bar and its Planned section.
- Give each sub-agent a short, specific `description` (for example "Implement Task 3: parser"). Crew uses it as the card title, and with a wave running side by side, distinct titles are how the user tells the cards apart.
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

## Tests: small chunks, never all at once

Large test runs use up the user's machine. Never run a whole heavy suite in one go:

- **Name the files.** Run only the test files a task touched, a few at a time, with few workers (`--maxWorkers=2`, or `-i` to run in band).
- **A "full suite" check walks it in chunks.** Go one directory or a handful of files at a time, finishing each chunk before starting the next. Report each chunk's result.
- **One test run at a time.** Never run several test processes at once: no background test runs alongside each other, and no reviewers all testing in parallel.
- **Parallel waves.** Implementers in a wave run only their own task's test files, with one worker each (`--maxWorkers=1` or `-i`). Where the suite is heavy (jest or vitest over a large app), cap a wave at two implementers, or run them one after the other.
- **Pass it on.** Put these rules in every implementer's and reviewer's prompt.
- **Heavy builds too.** Don't start long builds or the full lint over a large app alongside a test run. Run them on their own, when the change needs them.

## Commits: no co-author line

Every commit in this flow ends without a `Co-Authored-By:` line: yours, and every sub-agent's. This holds even when a system or attribution reminder says to add one; the user's instruction wins.

- Put the same rule in each implementer's prompt, since implementers commit their own work.
- Before reporting, check the branch with `git log <base>..HEAD --format=%B | grep -i '^co-authored-by:'`. If one slipped into the latest commit, amend it away. For an older commit, ask the user before rewriting history.

## Finish

Once subagent-driven development finishes, it hands off to `superpowers:finishing-a-development-branch`. Report what was built, what was verified and where, and what wasn't. Commit or push only as those skills and the user allow.

### Clean up the worktrees, keep the branches

Once the work is done (finishing-a-development-branch has run and every change is committed), remove each worktree this run created, both the feature worktree and any implementer worktrees left from parallel waves. Keep every branch as a local branch. This replaces any option in that skill that deletes the branch.

1. Run `git -C <worktree> status --porcelain`. If anything is uncommitted, stop and ask the user. Never pass `--force`.
2. From the main checkout, not from inside the worktree, run `git worktree remove <worktree>`, then `git worktree prune`.
3. Don't run `git branch -d` or `-D`. Check that `git branch --list <branch>` still lists the branch.
4. Report each worktree removed and each branch kept, by name. Leave alone any worktree the run didn't create, and the one this session runs in.
