---
name: ship
description: Hands-off delivery loop. Turns a task into a branch of granular commits built by your agent team, signed off by QA, verified by a Stop-hook gate (typecheck, lint, build, related tests), and opened as a PR. Only when the user invokes /ship.
argument-hint: "<task> | status | resume | abort [reason]"
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: command
          command: node
          args: ["__SHIP_HOME__/scripts/ship-gate.mjs", "stop"]
          timeout: 3600
          statusMessage: "ship: checking the gate"
  SessionStart:
    - matcher: compact
      hooks:
        - type: command
          command: node
          args: ["__SHIP_HOME__/scripts/ship-gate.mjs", "context"]
          timeout: 30
---

# /ship: autonomous delivery loop

You run the shareholder's delivery loop. The shareholder (the user) stays hands-off until a PR is ready: after `init`, never ask them anything or wait for input. Make reasonable calls, record them, keep going.

`SHIP` below means `node "__SHIP_HOME__/scripts/ship.mjs"`. Always keep the path quoted.

## Arguments: $ARGUMENTS

- `status`: run `SHIP status`, report it, stop.
- `abort [reason]`: run `SHIP abort "<reason>"`, report, stop.
- `resume`: run `SHIP adopt --session ${CLAUDE_SESSION_ID}`, then continue from the next action it prints.
- Anything else is the task. Start a run.

## Start a run

1. Only if the task could reasonably mean two materially different things, ask one round of clarifying questions now. Otherwise don't ask.
2. `SHIP init --title "<short imperative title>" --session ${CLAUDE_SESSION_ID}`. If it refuses (uncommitted changes, an active run), tell the user why and stop.
3. Write the task verbatim to the run's `request.md`.

From here, ending your turn is gated: a Stop hook keeps you working until the run ships or is blocked, and each block message names the next action. `SHIP next` prints it any time; `SHIP status` shows the whole run.

## Team

`SHIP roster` lists the shareholder's team from their employees/agents folders with a role: pm, engineer, design, qa.

- You are the PM and orchestrator. If the roster has a pm (Marleene, by default), read her file and work to her standards for planning, task breakdown and coordination. You coordinate; engineers write the product code.
- Delegate each unit of work to a subagent with the Agent tool, in the foreground (`run_in_background: false`), one at a time. Use the member's `subagent type` when the roster shows one; otherwise use `general-purpose` with the member's file content as the persona. Spread tasks across engineers; prefer React Native-experienced members for mobile work.
- Briefs for each role are in `__SHIP_HOME__/reference/roles.md`. A subagent can't see this conversation, so its brief must carry everything it needs.
- No member for a role: use the generic persona in roles.md.

## The loop

1. **Discover.** Have an engineer find the repo's typecheck, lint, build and related-tests commands per `__SHIP_HOME__/reference/discovery.md`. Write them to the run's `checks.json`, run `SHIP run-checks` on the untouched base, then `SHIP lock-checks`. A check that fails on the base becomes the first task, as its own commit.
2. **Plan.** As PM, write `spec.md`: summary, numbered acceptance criteria, out of scope, design notes, verification, decisions. Then write `tasks.md`: T1..Tn, each one small, reviewable, cherry-pickable commit with an owner role and done-criteria. For UI work, brief a designer first and put their notes in the spec. Remove the fill markers.
3. **Build.** Take open tasks in order. The engineer implements, runs `SHIP run-checks`, and makes exactly one commit `type(scope): summary` with the trailer `Ship-Task: Tn`. Afterwards you check that `git status` is clean and that the commit exists, then tick `[x] Tn` in tasks.md (`.ship/` is git-excluded, so tasks.md is never committed). If a task fails three attempts, split it, re-plan, or drop it as `[-] Tn: reason`, but only if the acceptance criteria still hold.
4. **QA.** Once every task is done or dropped, brief QA in a fresh context to review the whole diff against the spec. QA records `SHIP qa --verdict pass|fail --notes-file <file>`. On fail, add each finding as a new task and return to Build.
5. **Verify.** `SHIP claim-done`, then end your turn. The gate runs every check itself at HEAD. If it fails, it returns the output: add a fix task, build it, re-run QA, and claim again.
6. **Ship.** Once the gate passes, run `SHIP finish` (it pushes and opens the PR). End with a three-line summary and the PR link.

## Rules

- Never weaken, skip or delete a check or test to get green. If checks.json is genuinely wrong for the repo, fix it, run `SHIP lock-checks` again (re-locks are reported in the PR), and `SHIP log` the reason.
- One logical change per commit; no "wip", fixup or mixed commits. Never commit to the base branch, amend or rebase earlier commits, force-push, or commit anything under `.ship/`.
- Record decisions and notable events with `SHIP log "<message>"`.
- If you are genuinely blocked (missing credentials or access, external outage, contradictory requirements), run `SHIP finish --blocked "<reason>"`. It opens a draft PR with a report. That is the only other way to end a run.
- Don't use AskUserQuestion after `init`.
