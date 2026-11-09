#!/usr/bin/env node
// /ship helper CLI. Claude calls this from the /ship skill to start a run, lock the
// checks, record QA, claim done and open the PR. Run state lives in <repo>/.ship/.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const USAGE = `usage: ship.mjs <command> [options]

  init --title "<title>" --session <id> [--base <branch>] [--json]
                          start a run on a new branch ship/<slug>
  status [--json]         where the run is and what comes next
  next                    print only the next action
  roster [--json]         list team members from employees/ and agents/ folders
  lock-checks             validate checks.json and lock it for the gate
  run-checks [--only a,b] run the locked checks now (exit 1 on failure)
  log "<message>"         append a line to progress.md
  qa --verdict pass|fail (--notes-file <file> | --notes "<text>")
                          record QA's verdict for the current commit
  claim-done              ask the Stop gate to verify the current commit
  finish [--blocked "<reason>"]
                          push the branch and open the PR (draft if blocked)
  adopt --session <id>    bind the run to this session (resume, reopen)
  abort ["<reason>"]      end the run, keeping the branch`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseArgs(rest);
const cwd = process.cwd();

function requireRoot() {
  const root = L.repoRoot(cwd);
  if (!root) throw new L.ShipError('not inside a git repository');
  return root;
}

function requireRun() {
  const run = L.loadRun(requireRoot());
  if (!run) throw new L.ShipError('no /ship run in this repository. Start one with /ship <task>.');
  return run;
}

function requireActive(run) {
  if (L.isTerminal(run.state.status)) {
    throw new L.ShipError(`run "${run.state.slug}" is ${run.state.status}. Use /ship resume to reopen it, or start a new run.`);
  }
}

function bump(run, message) {
  run.state.progressMark = (run.state.progressMark || 0) + 1;
  if (message) L.appendProgress(run, message);
  run.save();
}

function print(text) {
  process.stdout.write(`${text}\n`);
}

// ---------------------------------------------------------------- commands

function init() {
  const title = typeof flags.title === 'string' ? flags.title.trim() : '';
  if (!title) throw new L.ShipError('--title "<short imperative title>" is required');
  const root = requireRoot();

  const existing = L.loadRun(root);
  if (existing && !L.isTerminal(existing.state.status)) {
    throw new L.ShipError(`run "${existing.state.slug}" is still active (${existing.state.status}). Use /ship resume to continue it or /ship abort to end it.`);
  }
  if (!L.isClean(root)) {
    throw new L.ShipError('the working tree has uncommitted changes. Commit or stash them, then start the run again.');
  }
  const base = typeof flags.base === 'string' ? flags.base : L.currentBranch(root);
  if (!base) throw new L.ShipError('HEAD is detached: check out the branch to build on, or pass --base <branch>');
  const baseSha = L.gitOrThrow(['rev-parse', '--verify', `${base}^{commit}`], root);

  const stem = L.slugify(typeof flags.slug === 'string' ? flags.slug : title);
  let slug = stem;
  for (let n = 2; L.branchExists(root, `ship/${slug}`) || fs.existsSync(L.runDirFor(root, slug)); n += 1) {
    slug = `${stem}-${n}`;
  }
  const branch = `ship/${slug}`;
  L.gitOrThrow(['checkout', '-q', '-b', branch, baseSha], root);

  const runDir = L.runDirFor(root, slug);
  fs.mkdirSync(runDir, { recursive: true });
  L.ensureExcluded(root);
  const files = L.runFiles(runDir);
  const templates = path.join(L.SKILL_DIR, 'templates');
  for (const name of ['spec.md', 'tasks.md', 'progress.md', 'checks.json']) {
    const text = L.readText(path.join(templates, name)).split('{{title}}').join(title);
    fs.writeFileSync(path.join(runDir, name), text);
  }
  fs.writeFileSync(files.request, '');

  const now = L.nowIso();
  const state = {
    version: 1,
    slug,
    title,
    branch,
    base,
    baseSha,
    sessionId: typeof flags.session === 'string' ? flags.session : null,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    limits: { ...L.DEFAULT_LIMITS },
    checksHash: null,
    checksLockedAt: null,
    checksRelocks: 0,
    qa: null,
    qaHistory: [],
    qaRounds: 0,
    verifyRequested: false,
    verifiedSha: null,
    progressMark: 0,
    gate: { blocks: 0, idle: 0, failures: 0, lastFingerprint: null, runs: [] },
    wrapUp: null,
    pr: null,
    blockedReason: null,
    warnedMode: false,
    announced: false,
  };
  L.writeJsonAtomic(files.state, state);
  L.writeJsonAtomic(L.activePath(root), { slug });

  const run = L.loadRun(root);
  L.appendProgress(run, `run started on ${branch} from ${base} @ ${L.shortSha(baseSha)}`);
  const info = L.inspect(run);
  if (flags.json) {
    print(JSON.stringify({ slug, branch, base, baseSha, runDir: L.toPosix(runDir), files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, L.toPosix(v)])) }, null, 2));
    return;
  }
  print(`ship: run "${slug}" started`);
  print(`  branch:  ${branch} (from ${base} @ ${L.shortSha(baseSha)})`);
  print(`  run dir: ${L.toPosix(runDir)}`);
  print(`  files:   request.md spec.md tasks.md progress.md checks.json`);
  print(`Next: write the request verbatim to ${L.rel(root, files.request)}. Then: ${L.nextAction(run, info)}`);
}

function status() {
  const root = requireRoot();
  const run = L.loadRun(root);
  if (!run) {
    print('No /ship run in this repository.');
    return;
  }
  const { state } = run;
  const info = L.inspect(run);
  if (flags.json) {
    print(JSON.stringify({ ...state, stage: info.stage, head: info.head, clean: info.clean, tasks: info.tasks, next: L.nextAction(run, info) }, null, 2));
    return;
  }
  const done = info.tasks.filter((t) => t.done).length;
  const dropped = info.tasks.filter((t) => t.dropped).length;
  const lastGate = state.gate.runs.at(-1);
  print(`/ship run "${state.title}" [${state.status}]`);
  print(`  branch: ${state.branch} (base ${state.base} @ ${L.shortSha(state.baseSha)}), HEAD ${L.shortSha(info.head)}${info.clean ? '' : ' + uncommitted changes'}`);
  print(`  stage:  ${info.stage} | tasks ${done}/${info.tasks.length} done${dropped ? `, ${dropped} dropped` : ''}`);
  print(`  QA:     ${state.qa ? `${state.qa.verdict} at ${L.shortSha(state.qa.sha)}${state.qa.sha === info.head ? ' (HEAD)' : ' (stale)'}` : 'not run'}, ${state.qaRounds} failed round(s)`);
  print(`  gate:   ${lastGate ? `last ${lastGate.ok ? 'PASSED' : 'FAILED'} at ${L.shortSha(lastGate.sha)}` : 'not run yet'}, ${state.gate.failures} failure(s), ${state.gate.blocks} turn(s)`);
  if (state.pr?.url) print(`  PR:     ${state.pr.url}`);
  if (state.wrapUp) print(`  wrap-up: ${state.wrapUp.reason}`);
  print(`  run dir: ${L.toPosix(run.runDir)}`);
  print(`Next: ${L.nextAction(run, info)}`);
}

function next() {
  const run = requireRun();
  print(L.nextAction(run, L.inspect(run)));
}

function roster() {
  const root = L.repoRoot(cwd);
  const members = L.roster(root);
  if (flags.json) {
    print(JSON.stringify(members, null, 2));
    return;
  }
  if (members.length === 0) {
    print('No team members found in .claude/employees/ or .claude/agents/ (project or user). Use the generic roles in reference/roles.md.');
    return;
  }
  for (const m of members) {
    print(`${m.role.padEnd(9)} ${m.name.padEnd(24)} ${m.path}${m.agentType ? `  [subagent type: ${m.agentType}]` : ''}`);
  }
}

function loadChecksOrThrow(run) {
  const file = L.runFiles(run.runDir).checks;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new L.ShipError(`${L.rel(run.root, file)} is not valid JSON: ${e.message}`);
  }
  const errors = L.validateChecks(doc);
  if (errors.length) throw new L.ShipError(`${L.rel(run.root, file)} is not ready:\n  - ${errors.join('\n  - ')}`);
  return doc;
}

function lockChecks() {
  const run = requireRun();
  requireActive(run);
  const doc = loadChecksOrThrow(run);
  const hash = L.checksHash(doc);
  const { state } = run;
  if (state.checksHash === hash) {
    print('checks.json is already locked with this content.');
    return;
  }
  const relock = Boolean(state.checksHash);
  state.checksHash = hash;
  state.checksLockedAt = L.nowIso();
  if (relock) state.checksRelocks += 1;
  const summary = doc.checks.map((c) => `${c.id}: ${c.skip ? `skip (${c.skip})` : c.cmd}`).join('; ');
  bump(run, `${relock ? 'checks RE-LOCKED' : 'checks locked'}: ${summary}`);
  print(`${relock ? 'Re-locked' : 'Locked'} ${doc.checks.length} checks:`);
  for (const c of doc.checks) print(`  - ${c.id}: ${c.skip ? `skip (${c.skip})` : c.cmd}`);
  if (relock) print('Note: re-locks are reported in the PR. Log why with the log command.');
  print(`Next: ${L.nextAction(run, L.inspect(run))}`);
}

function runChecksCmd() {
  const run = requireRun();
  const doc = loadChecksOrThrow(run);
  const only = typeof flags.only === 'string' ? flags.only.split(',').map((s) => s.trim()) : undefined;
  const results = L.runChecks(run.root, doc, {
    baseSha: run.state.baseSha,
    only,
    onStart: (id, cmd) => process.stderr.write(`ship: running ${id}: ${cmd}\n`),
  });
  const ok = results.every((r) => r.ok);
  fs.writeFileSync(
    path.join(run.runDir, 'last-checks.json'),
    `${JSON.stringify({ at: L.nowIso(), head: L.git(['rev-parse', 'HEAD'], run.root).out, ok, results: results.map(({ output, ...r }) => r) }, null, 2)}\n`,
  );
  print(L.formatResults(results));
  if (!ok) {
    print(`\n${L.failureDetails(results)}`);
    process.exitCode = 1;
  } else {
    print('\nAll checks passed.');
  }
}

function log() {
  const run = requireRun();
  const message = positional.join(' ').trim();
  if (!message) throw new L.ShipError('log needs a message');
  bump(run, message);
  print('Logged.');
}

function qa() {
  const run = requireRun();
  requireActive(run);
  const verdict = flags.verdict;
  if (verdict !== 'pass' && verdict !== 'fail') throw new L.ShipError('--verdict must be pass or fail');
  let notes = '';
  if (typeof flags['notes-file'] === 'string') {
    notes = L.readText(path.resolve(cwd, flags['notes-file'])).trim();
    if (!notes) throw new L.ShipError(`notes file ${flags['notes-file']} is empty or missing`);
  } else if (typeof flags.notes === 'string') {
    notes = flags.notes.trim();
  }
  if (verdict === 'fail' && notes.length < 20) throw new L.ShipError('a fail verdict needs notes that list the findings');
  if (!L.isClean(run.root)) throw new L.ShipError('QA reviews committed work: commit or discard uncommitted changes, then record the verdict');
  const info = L.inspect(run);
  if (L.openTasks(info.tasks).length) {
    throw new L.ShipError(`open tasks remain (${L.openTasks(info.tasks).map((t) => t.id).join(', ')}); QA runs after every task is done or dropped`);
  }
  const { state } = run;
  const record = { sha: info.head, verdict, notes: notes.slice(0, 6000), at: L.nowIso() };
  state.qa = record;
  state.qaHistory.push({ ...record, notes: record.notes.slice(0, 1500) });
  if (verdict === 'fail') state.qaRounds += 1;
  state.verifyRequested = false;
  fs.writeFileSync(path.join(run.runDir, `qa-${state.qaHistory.length}.md`), `# QA ${verdict} at ${info.head}\n\n${notes}\n`);
  bump(run, `QA ${verdict.toUpperCase()} at ${L.shortSha(info.head)}`);
  print(`Recorded QA ${verdict} for ${L.shortSha(info.head)}.`);
  print(`Next: ${L.nextAction(run, L.inspect(run))}`);
}

function claimDone() {
  const run = requireRun();
  requireActive(run);
  const info = L.inspect(run);
  if (info.checksChanged) throw new L.ShipError('checks.json changed since it was locked. Re-lock it (reported in the PR) or revert it first.');
  if (info.stage !== 'verify') {
    throw new L.ShipError(`not ready to claim done (stage: ${info.stage}). ${L.nextAction(run, info)}`);
  }
  if (info.branch !== run.state.branch) throw new L.ShipError(`switch back to ${run.state.branch} first`);
  run.state.verifyRequested = true;
  bump(run, `done claimed at ${L.shortSha(info.head)}`);
  print(`Claimed done at ${L.shortSha(info.head)}. End your turn now: the Stop gate runs every check at this commit.`);
}

// ---------------------------------------------------------------- finish

function commitsWithTasks(run) {
  const raw = L.git(['log', `${run.state.baseSha}..HEAD`, '--reverse', '--format=%h%x1f%s%x1f%B%x1e'], run.root).out;
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body] = r.split('\x1f');
      const task = /^Ship-Task:\s*(T\d+)/im.exec(body || '')?.[1];
      return { sha, subject, task };
    });
}

function mdCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n\n…(truncated)` : text;
}

function prBody(run, info, blocked) {
  const { state } = run;
  const files = L.runFiles(run.runDir);
  const spec = L.readText(files.spec);
  const summary = L.section(spec, 'Summary') || state.title;
  const commits = commitsWithTasks(run);
  const out = [];

  if (blocked) {
    out.push(`> **Blocked:** ${blocked}`, '>', '> This draft PR holds the work completed so far. It did not pass the full gate.', '');
  }
  out.push('## Summary', '', summary, '');

  out.push('## Tasks', '', '| | Task | Commit |', '|---|---|---|');
  for (const t of info.tasks) {
    const c = commits.filter((x) => x.task === t.id).map((x) => `\`${x.sha}\``).join(' ');
    const mark = t.done ? 'done' : t.dropped ? 'dropped' : 'open';
    out.push(`| ${mark} | ${t.id}: ${mdCell(t.title)} | ${c || '-'} |`);
  }
  out.push('');

  out.push('## Commits', '', 'One commit per task, so each can be reviewed or cherry-picked on its own.', '');
  for (const c of commits) out.push(`- \`${c.sha}\` ${c.subject}${c.task ? ` (${c.task})` : ''}`);
  if (commits.length === 0) out.push('- (no commits)');
  out.push('');

  const gate = [...state.gate.runs].reverse().find((r) => r.sha === info.head) || state.gate.runs.at(-1);
  out.push('## Definition of done', '');
  if (gate) {
    out.push(`Stop-gate run at \`${L.shortSha(gate.sha)}\`: **${gate.ok ? 'PASSED' : 'FAILED'}**`, '', '| Check | Command | Result |', '|---|---|---|');
    for (const r of gate.results) {
      const result = r.skipped ? `skipped: ${r.note.replace(/^skipped: /, '')}` : r.ok ? 'pass' : r.timedOut ? 'timed out' : `fail (exit ${r.code ?? '-'})`;
      out.push(`| ${r.id} | ${r.cmd ? `\`${mdCell(r.cmd)}\`` : '-'} | ${mdCell(result)} |`);
    }
  } else {
    out.push('The gate has not run on this branch.');
  }
  if (state.checksRelocks > 0) {
    out.push('', `> **Note:** checks.json was re-locked ${state.checksRelocks} time(s) during the run. See the progress log below for why.`);
  }
  out.push('');

  out.push('## QA sign-off', '');
  if (state.qa) {
    out.push(`**${state.qa.verdict}** at \`${L.shortSha(state.qa.sha)}\`${state.qa.sha === info.head ? '' : ' (not the final commit)'}, after ${state.qaRounds} failed round(s).`, '', clip(state.qa.notes || '(no notes)', 2500));
  } else {
    out.push('QA has not signed off.');
  }
  out.push('');

  const hours = ((Date.now() - Date.parse(state.createdAt)) / 36e5).toFixed(1);
  out.push(
    '## Run',
    '',
    `- Branch \`${state.branch}\` from \`${state.base}\` @ \`${L.shortSha(state.baseSha)}\``,
    `- Gate failures: ${state.gate.failures} · QA failed rounds: ${state.qaRounds} · Turns: ${state.gate.blocks} · Elapsed: ${hours}h`,
    '',
    '<details><summary>Spec</summary>',
    '',
    clip(spec.trim(), 12000),
    '',
    '</details>',
    '',
    '<details><summary>Progress log</summary>',
    '',
    clip(L.readText(files.progress).trim().split('\n').slice(-80).join('\n'), 8000),
    '',
    '</details>',
    '',
    'Opened by the /ship workflow.',
  );
  return `${out.join('\n')}\n`;
}

function hasGh() {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

function gh(args, root) {
  const r = spawnSync('gh', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}

function finish() {
  const run = requireRun();
  const { state, root } = run;
  if (['done', 'aborted'].includes(state.status)) throw new L.ShipError(`run is already ${state.status}`);
  const info = L.inspect(run);
  const blocked = flags.blocked;
  if (blocked !== undefined && (typeof blocked !== 'string' || blocked.trim().length < 5)) {
    throw new L.ShipError('--blocked needs a one-line reason');
  }
  if (!info.clean) throw new L.ShipError('commit or discard uncommitted changes first');
  if (info.branch !== state.branch) throw new L.ShipError(`switch back to ${state.branch} first`);
  if (!blocked && !(state.verifiedSha === info.head)) {
    throw new L.ShipError(`the Stop gate has not passed at HEAD ${L.shortSha(info.head)} (stage: ${info.stage}). ${L.nextAction(run, info)}`);
  }

  const reason = blocked ? blocked.trim() : null;
  const bodyFile = path.join(run.runDir, 'PR.md');
  fs.writeFileSync(bodyFile, prBody(run, info, reason));
  const title = reason ? `[blocked] ${state.title}` : state.title;

  const settle = (status, pr, message) => {
    state.status = status;
    state.pr = pr;
    if (reason) state.blockedReason = reason;
    state.announced = false;
    state.verifyRequested = false;
    bump(run, `finished: ${status}${pr.url ? ` ${pr.url}` : ''}${pr.note ? ` (${pr.note})` : ''}`);
    print(message);
  };
  const localStatus = reason ? 'blocked' : 'ready-local';

  const remotes = L.git(['remote'], root).out.split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) {
    settle(localStatus, { url: null, note: 'no git remote' }, `No git remote configured. Branch ${state.branch} is ready locally; PR text is in ${L.rel(root, bodyFile)}.`);
    return;
  }
  const push = L.git(['push', '-u', remote, state.branch], root);
  if (!push.ok) {
    settle(localStatus, { url: null, note: `push failed: ${push.err.split('\n')[0]}` }, `Push failed: ${push.err}\nBranch ${state.branch} is ready locally; PR text is in ${L.rel(root, bodyFile)}.`);
    return;
  }
  if (!hasGh()) {
    settle(localStatus, { url: null, note: 'pushed; GitHub CLI (gh) not installed' }, `Pushed ${state.branch} to ${remote}. Install the GitHub CLI (gh) to have PRs opened automatically; PR text is in ${L.rel(root, bodyFile)}.`);
    return;
  }
  const args = ['pr', 'create', '--base', state.base, '--head', state.branch, '--title', title, '--body-file', bodyFile];
  let r = gh(reason ? [...args, '--draft'] : args, root);
  if (!r.ok && reason && /draft/i.test(r.err)) r = gh(args, root);
  let url = /https?:\/\/\S+/.exec(r.out)?.[0];
  if (!r.ok && /already exists/i.test(r.err)) {
    gh(['pr', 'edit', state.branch, '--title', title, '--body-file', bodyFile], root);
    url = /https?:\/\/\S+/.exec(gh(['pr', 'view', state.branch, '--json', 'url', '--jq', '.url'], root).out)?.[0];
  }
  if (!url) {
    settle(localStatus, { url: null, note: `gh pr create failed: ${r.err.split('\n')[0]}` }, `Pushed ${state.branch}, but opening the PR failed: ${r.err}\nPR text is in ${L.rel(root, bodyFile)}.`);
    return;
  }
  settle(reason ? 'blocked' : 'done', { url, draft: Boolean(reason) }, `${reason ? 'Draft PR' : 'PR'} ready for review: ${url}`);
}

function adopt() {
  const run = requireRun();
  const { state } = run;
  if (typeof flags.session !== 'string' || !flags.session) throw new L.ShipError('--session <id> is required');
  if (['done', 'aborted'].includes(state.status)) {
    throw new L.ShipError(`run "${state.slug}" is ${state.status}; start a new run instead`);
  }
  const reopened = state.status !== 'running';
  state.sessionId = flags.session;
  if (reopened) {
    state.status = 'running';
    state.wrapUp = null;
    state.blockedReason = null;
    state.gate.failures = 0;
    state.qaRounds = 0;
  }
  state.gate.idle = 0;
  state.gate.blocks = 0;
  state.announced = false;
  bump(run, reopened ? 'run reopened and adopted by a new session' : 'run adopted by a new session');
  print(`Adopted run "${state.slug}"${reopened ? ' (reopened)' : ''}.`);
  print(`Next: ${L.nextAction(run, L.inspect(run))}`);
}

function abort() {
  const run = requireRun();
  const { state } = run;
  if (L.isTerminal(state.status) && state.status !== 'ready-local' && state.status !== 'blocked') {
    throw new L.ShipError(`run is already ${state.status}`);
  }
  const reason = positional.join(' ').trim() || 'aborted by request';
  state.status = 'aborted';
  state.blockedReason = reason;
  state.announced = true;
  bump(run, `run aborted: ${reason}`);
  print(`Aborted run "${state.slug}". Branch ${state.branch} is kept; \`git checkout ${state.base}\` to leave it.`);
}

const COMMANDS = {
  init,
  status,
  next,
  roster,
  'lock-checks': lockChecks,
  'run-checks': runChecksCmd,
  log,
  qa,
  'claim-done': claimDone,
  finish,
  adopt,
  abort,
};

try {
  const fn = COMMANDS[command];
  if (!fn) {
    print(USAGE);
    process.exitCode = command && command !== 'help' && command !== '--help' ? 2 : 0;
  } else {
    fn();
  }
} catch (e) {
  if (e instanceof L.ShipError) {
    process.stderr.write(`ship: ${e.message}\n`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
