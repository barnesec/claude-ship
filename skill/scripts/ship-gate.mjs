#!/usr/bin/env node
// Hook entry point for the /ship skill. Registered in the skill's frontmatter, so it is
// only active in sessions where /ship was invoked.
//
//   ship-gate.mjs stop     Stop hook: keeps Claude working until the run ships or is
//                          blocked, and runs every check itself when done is claimed.
//   ship-gate.mjs context  SessionStart (compact) hook: re-orients Claude after compaction.
//
// It fails open: an internal error never traps the session.

import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const REASON_LIMIT = 9000;

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function block(reason, systemMessage) {
  const text = reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT)}\n…(truncated)` : reason;
  emit(systemMessage ? { decision: 'block', reason: text, systemMessage } : { decision: 'block', reason: text });
}

function activeRunFor(input) {
  const root = L.repoRoot(input.cwd || process.cwd());
  if (!root) return null;
  const run = L.loadRun(root);
  if (!run) return null;
  const { sessionId } = run.state;
  if (sessionId && input.session_id && sessionId !== input.session_id) return null;
  return run;
}

function header(run, info) {
  const s = run.state;
  const done = info.tasks.filter((t) => t.done || t.dropped).length;
  return `[/ship] Run "${s.title}" on ${s.branch} is not finished (stage: ${info.stage}, tasks ${done}/${info.tasks.length}). The shareholder is hands-off: keep going without asking questions.`;
}

function runGate(run, info, notice) {
  const { state, root, runDir } = run;
  const S = L.SHIP_CMD;
  state.verifyRequested = false;

  const problems = [];
  if (!info.clean) problems.push('the working tree has uncommitted changes (commit or discard them)');
  if (info.branch !== state.branch) problems.push(`HEAD is on "${info.branch}", not "${state.branch}"`);
  if (!info.checksValid) problems.push('checks.json is missing or invalid');
  else if (info.checksChanged) problems.push('checks.json changed since it was locked (re-lock it; re-locks are reported in the PR)');
  if (problems.length) {
    run.save();
    return block(`[/ship] Gate not run: ${problems.join('; ')}. Fix that, get QA sign-off at the final commit, and run \`${S} claim-done\` again.`, notice);
  }

  const results = L.runChecks(root, info.checksDoc, { baseSha: state.baseSha });
  const ok = results.every((r) => r.ok);
  const n = state.gate.runs.length + 1;
  const logPath = path.join(runDir, `gate-${n}.log`);
  fs.writeFileSync(
    logPath,
    results.map((r) => `===== ${r.id}: ${r.cmd ?? '-'} => ${r.skipped ? 'skipped' : r.ok ? 'pass' : `fail (exit ${r.code})`}\n${r.note ? `${r.note}\n` : ''}${r.output}\n`).join('\n'),
  );
  state.gate.runs.push({ sha: info.head, at: L.nowIso(), ok, results: results.map(({ output, tail, ...r }) => r) });
  if (state.gate.runs.length > 20) state.gate.runs = state.gate.runs.slice(-20);
  state.progressMark += 1;
  L.appendProgress(run, `gate ${ok ? 'PASSED' : 'FAILED'} at ${L.shortSha(info.head)} (log: gate-${n}.log)`);

  if (ok) {
    state.verifiedSha = info.head;
    run.save();
    return block(`[/ship] Gate PASSED at ${L.shortSha(info.head)}:\n${L.formatResults(results)}\n\nNext: run \`${S} finish\` to push the branch and open the PR, then end your turn with a short summary and the PR link.`, notice);
  }

  state.gate.failures += 1;
  const limits = { ...L.DEFAULT_LIMITS, ...state.limits };
  const failure = `[/ship] Gate FAILED at ${L.shortSha(info.head)} (failure ${state.gate.failures} of ${limits.maxGateFailures}):\n${L.formatResults(results)}\n\n${L.failureDetails(results)}\n\nFull log: ${L.rel(root, logPath)}`;
  if (state.gate.failures >= limits.maxGateFailures) {
    L.enterWrapUp(state, `the gate failed ${state.gate.failures} times`);
    run.save();
    return block(`${failure}\n\nThe failure limit is reached. ${L.nextAction(run, L.inspect(run))}`, notice);
  }
  run.save();
  return block(`${failure}\n\nNext: add a fix task to tasks.md, have an engineer fix the root cause in one commit (never weaken the check), get QA sign-off at the new HEAD, then run \`${S} claim-done\` again.`, notice);
}

function stop(input) {
  const run = activeRunFor(input);
  if (!run) return;
  const { state } = run;

  if (L.isTerminal(state.status)) {
    if (!state.announced) {
      state.announced = true;
      run.save();
      emit({ systemMessage: L.terminalSummary(run) });
    }
    return;
  }

  const info = L.inspect(run);
  const g = state.gate;
  g.blocks += 1;
  const fp = L.fingerprint(run, info);
  g.idle = fp === g.lastFingerprint ? g.idle + 1 : 0;
  g.lastFingerprint = fp;

  let notice;
  if (!state.warnedMode && input.permission_mode && !['auto', 'bypassPermissions', 'dontAsk'].includes(input.permission_mode)) {
    state.warnedMode = true;
    notice = 'ship: this session is not in auto mode, so permission prompts will pause the hands-off run. Restart with --permission-mode auto and run /ship resume to avoid that.';
  }

  if (state.status === 'wrapping-up') {
    state.wrapUp.stops = (state.wrapUp.stops || 0) + 1;
    if (state.wrapUp.stops > 2 || g.idle >= 2) {
      state.status = 'blocked';
      state.blockedReason = `${state.wrapUp.reason}; the wrap-up did not complete`;
      state.announced = true;
      run.save();
      emit({ systemMessage: `ship: "${state.title}" stopped without a PR (${state.blockedReason}). Commits are on ${state.branch}; notes are in .ship/runs/${state.slug}/.` });
      return;
    }
    run.save();
    return block(`${header(run, info)} ${L.nextAction(run, info)}`, notice);
  }

  const limit = L.limitHit(state);
  if (limit) {
    L.enterWrapUp(state, limit);
    L.appendProgress(run, `wrap-up: ${limit}`);
    run.save();
    return block(`[/ship] Run limit reached: ${limit}. ${L.nextAction(run, L.inspect(run))}`, notice);
  }

  if (info.stage === 'verify' && state.verifyRequested) return runGate(run, info, notice);

  run.save();
  return block(`${header(run, info)}\nNext: ${L.nextAction(run, info)}\nIf you are genuinely stuck (missing access, contradictory requirements), run \`${L.SHIP_CMD} finish --blocked "<reason>"\`.`, notice);
}

function context(input) {
  const run = activeRunFor(input);
  if (!run || L.isTerminal(run.state.status)) return;
  const info = L.inspect(run);
  const s = run.state;
  process.stdout.write(
    [
      `[/ship] An autonomous /ship run is in progress in this session: "${s.title}" on branch ${s.branch} (base ${s.base}).`,
      `Run files: ${L.rel(run.root, run.runDir)}/ (request.md, spec.md, tasks.md, progress.md, checks.json). Helper: ${L.SHIP_CMD} <command>.`,
      `Stage: ${info.stage}. Next: ${L.nextAction(run, info)}`,
      'Follow the /ship skill: the shareholder is hands-off until the PR; one commit per task; QA signs off at the final commit; the Stop gate verifies every check.',
    ].join('\n') + '\n',
  );
}

function failOpen(error, input) {
  const message = `ship gate error: ${error?.stack || error}`;
  process.stderr.write(`${message}\n`);
  try {
    const root = L.repoRoot(input.cwd || process.cwd());
    if (root && fs.existsSync(L.shipDir(root))) {
      fs.appendFileSync(path.join(L.shipDir(root), 'gate-errors.log'), `${L.nowIso()} ${message}\n`);
    }
  } catch {
    // nothing more to do
  }
}

const mode = process.argv[2] || 'stop';
const input = readInput();
try {
  if (mode === 'stop') stop(input);
  else if (mode === 'context') context(input);
  else process.stderr.write(`ship-gate: unknown mode "${mode}"\n`);
} catch (e) {
  failOpen(e, input);
}
process.exitCode = 0;
