# /ship

A hands-off delivery loop for Claude Code. You give it a task; your agent team plans it, builds it as one commit per task, has QA sign off, proves it against the repo's own typecheck, lint, build and related tests, and opens a pull request. You step in when the PR is ready.

```
/ship Add a dark mode toggle to the Settings screen, persisted per user
```

## How it works

```
 /ship <task>
     │
     ▼
 Discover ──► Plan ──► Build (one commit per task) ──► QA ──► Verify ──► PR
 checks.json   spec.md   engineer subagents             fresh    Stop-hook   gh pr create
 locked        tasks.md  Ship-Task: Tn trailer          context  gate runs
                         ▲                                │       every check
                         └──── findings / gate failures ◄─┴───────┘
```

- **You are the shareholder.** After the run starts, Claude doesn't ask you anything. It records its decisions in the spec and the progress log, and they show up in the PR.
- **Your PM runs the floor.** The main session acts as the project manager from your team (Marleene, if she's in your roster). It writes the spec and the task list, then delegates: engineers implement tasks, a designer shapes UI work, and QA reviews.
- **Your team comes from your files.** `ship.mjs roster` reads `.claude/employees/` and `.claude/agents/`, in the project first and then in your user folder, and classifies each member as pm, engineer, design or qa. Members in `agents/` with a `name` are used as registered subagent types; the rest are passed to a general-purpose subagent as a persona.
- **Done is deterministic.** When the PM claims done, a Stop hook runs every locked check itself at HEAD. The branch must typecheck, lint and build, and the tests related to the changed files must pass. QA must also have signed off on that exact commit. If anything fails, the output goes back to Claude as a new task.
- **Bounded.** The run wraps up if the gate fails 5 times, QA fails 4 rounds, 3 turns in a row make no progress, it uses 150 turns, or it runs past 8 hours. A wrap-up opens a draft `[blocked]` PR with a report, so a PR is still the only thing you have to look at.
- **Scoped.** The hooks are declared in the skill's frontmatter, so they only exist in sessions where you ran `/ship`, and they only act for the session that owns the run.

## Install

Requirements: Claude Code, Node.js 18+ and git on your PATH. To have PRs opened for you, also install the [GitHub CLI](https://cli.github.com) (`gh auth login`). Without it, the branch is pushed and the PR text is saved for you.

**Windows (PowerShell)**, from this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

**Git Bash, macOS, Linux**:

```bash
./install.sh
```

Both install to `~/.claude/skills/ship` (or `$CLAUDE_CONFIG_DIR/skills/ship`). Re-run to update; the installed copy is replaced. Use the installer rather than copying the folder: it writes the skill's absolute path into the hook configuration.

## Use

Start Claude Code in the repository, in auto mode so tool approvals don't pause the run:

```
claude --permission-mode auto
```

Then:

| Command | What it does |
|---|---|
| `/ship <task>` | Start a run on a new branch `ship/<slug>` off your current branch. Your working tree must be clean. |
| `/ship status` | Where the run is and what comes next. |
| `/ship resume` | Continue a run in a new session (after you quit, or to reopen a blocked run). |
| `/ship abort [reason]` | End the run. The branch is kept. |

To stop a run in progress, press Esc (the gate doesn't fire on interrupts), then `/ship abort`.

## What a run leaves behind

- **A branch** `ship/<slug>` with one commit per task. Each commit has a `Ship-Task: Tn` trailer, so you can cherry-pick any of them.
- **A PR** with the summary, a task-to-commit table, the gate's results (including any skipped check and its reason), QA's notes, and the full spec and progress log.
- **Run files** in `<repo>/.ship/runs/<slug>/`: `request.md`, `spec.md`, `tasks.md`, `progress.md`, `checks.json`, QA notes, a log for each gate run, `PR.md` and `state.json`. `.ship/` is added to `.git/info/exclude`, so it never shows up in `git status` or commits.

## Tuning

- **Limits** live in the run's `state.json` under `limits`. Defaults are in `skill/scripts/lib.mjs` (`DEFAULT_LIMITS`).
- **Checks** are discovered per repo and written to `checks.json` (format in `skill/reference/discovery.md`). If discovery gets one wrong, Claude fixes it and re-locks. Every re-lock is flagged in the PR, so a weakened check can't slip through quietly.
- **Role briefs** for engineer, designer, QA and discovery are in `skill/reference/roles.md`.

## Development

```bash
npm test
```

The suite drives the helper CLI and the gate against throwaway git repos. Layout:

```
skill/
  SKILL.md                 the /ship skill (hooks in frontmatter)
  scripts/ship.mjs         helper CLI Claude calls: init, lock-checks, qa, claim-done, finish, ...
  scripts/ship-gate.mjs    Stop-hook gate and post-compaction context hook
  scripts/lib.mjs          shared state, checks runner and stage logic
  reference/               role briefs and the check-discovery guide
  templates/               spec, tasks, progress and checks.json seeds
install.ps1, install.sh
test/
```
