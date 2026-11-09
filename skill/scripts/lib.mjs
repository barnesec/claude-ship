// Shared logic for the /ship helper CLI (ship.mjs) and the Stop-hook gate (ship-gate.mjs).
// No dependencies: Node >= 18 and git on PATH.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHIP_CMD = `node "${toPosix(path.join(SKILL_DIR, 'scripts', 'ship.mjs'))}"`;
export const FILL_MARKER = '<!-- ship:fill -->';
export const REQUIRED_CHECKS = ['typecheck', 'lint', 'build', 'tests'];
export const DEFAULT_MATCH = '\\.(?:[cm]?[jt]sx?)$';
export const DEFAULT_LIMITS = Object.freeze({
  maxGateFailures: 5, // gate runs that fail before the run wraps up
  maxQaRounds: 4, // QA "fail" verdicts before the run wraps up
  maxIdleStops: 3, // consecutive turns with no change to code or run files
  maxGateBlocks: 150, // total turns the gate will keep the run going
  maxHours: 8, // wall-clock budget for one run
});

const TERMINAL = new Set(['done', 'ready-local', 'blocked', 'aborted']);
const MAX_CMDLINE = 7000; // stay well under cmd.exe's 8191-character limit

export class ShipError extends Error {}

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function toPosix(p) {
  return p.replace(/\\/g, '/');
}

export function nowIso() {
  return new Date().toISOString();
}

export function shortSha(sha) {
  return sha ? sha.slice(0, 8) : '-';
}

// ---------------------------------------------------------------- git

export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || r.error?.message || '').trim(),
  };
}

export function gitOrThrow(args, cwd) {
  const r = git(args, cwd);
  if (!r.ok) throw new ShipError(`git ${args.join(' ')} failed: ${r.err || `exit ${r.code}`}`);
  return r.out;
}

export function repoRoot(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  return r.ok && r.out ? path.resolve(r.out) : null;
}

export function porcelain(root) {
  return git(['status', '--porcelain'], root).out;
}

export function isClean(root) {
  return porcelain(root) === '';
}

export function currentBranch(root) {
  const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  return r.ok ? r.out : null;
}

export function branchExists(root, branch) {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root).ok;
}

// Files changed since the run's base commit, including uncommitted and untracked
// files, so engineers can run related tests before committing. At gate time the
// tree is clean, so this is exactly the branch diff.
export function changedFiles(root, baseSha) {
  const tracked = git(['diff', '--name-only', '--diff-filter=ACMR', baseSha], root).out;
  const untracked = git(['ls-files', '--others', '--exclude-standard'], root).out;
  const all = new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean));
  return [...all].filter((f) => fs.existsSync(path.join(root, f))).sort();
}

// ---------------------------------------------------------------- files

export function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (arguments.length > 1) return fallback;
    throw e;
  }
}

export function writeJsonAtomic(p, obj) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function shipDir(root) {
  return path.join(root, '.ship');
}

export function runDirFor(root, slug) {
  return path.join(shipDir(root), 'runs', slug);
}

export function activePath(root) {
  return path.join(shipDir(root), 'active.json');
}

export function runFiles(runDir) {
  return {
    request: path.join(runDir, 'request.md'),
    spec: path.join(runDir, 'spec.md'),
    tasks: path.join(runDir, 'tasks.md'),
    progress: path.join(runDir, 'progress.md'),
    checks: path.join(runDir, 'checks.json'),
    state: path.join(runDir, 'state.json'),
  };
}

// Paths shown to Claude: relative to the repo root, forward slashes.
export function rel(root, p) {
  return toPosix(path.relative(root, p)) || '.';
}

export function loadRun(root) {
  const active = readJson(activePath(root), null);
  if (!active || typeof active.slug !== 'string') return null;
  const runDir = runDirFor(root, active.slug);
  const statePath = path.join(runDir, 'state.json');
  if (!fs.existsSync(statePath)) return null;
  const state = readJson(statePath);
  return {
    root,
    runDir,
    statePath,
    state,
    save() {
      this.state.updatedAt = nowIso();
      writeJsonAtomic(statePath, this.state);
    },
  };
}

export function appendProgress(run, message) {
  const line = `- ${nowIso()} ${message.replace(/\s*\n\s*/g, ' ')}\n`;
  fs.appendFileSync(runFiles(run.runDir).progress, line);
}

// Keep run files out of commits without touching the repo's .gitignore.
export function ensureExcluded(root) {
  const p = path.resolve(root, gitOrThrow(['rev-parse', '--git-path', 'info/exclude'], root));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const current = readText(p);
  if (!current.split(/\r?\n/).some((l) => l.trim() === '.ship/')) {
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(p, `${sep}# /ship run state (local only)\n.ship/\n`);
  }
}

export function slugify(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let slug = '';
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 40) break;
    slug = next;
  }
  return slug || (words[0] || 'task').slice(0, 40);
}

// ---------------------------------------------------------------- tasks & plan

const TASK_RE = /^\s*[-*]\s+\[([ xX~-])\]\s+(T\d+)\b[\s:.)\-–—]*(.*)$/;

export function parseTasks(md) {
  const tasks = [];
  for (const line of md.split(/\r?\n/)) {
    const m = TASK_RE.exec(line);
    if (!m) continue;
    const mark = m[1];
    tasks.push({
      id: m[2],
      title: m[3].trim(),
      done: mark === 'x' || mark === 'X',
      dropped: mark === '-' || mark === '~',
    });
  }
  return tasks;
}

export function openTasks(tasks) {
  return tasks.filter((t) => !t.done && !t.dropped);
}

export function section(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(l));
  if (start < 0) return '';
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

// ---------------------------------------------------------------- checks

export function validateChecks(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['checks.json must be a JSON object'];
  const errors = [];
  if (!Array.isArray(doc.checks) || doc.checks.length === 0) {
    errors.push('"checks" must be a non-empty array');
  }
  const ids = new Set();
  for (const [i, c] of (Array.isArray(doc.checks) ? doc.checks : []).entries()) {
    const where = `checks[${i}]`;
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) {
      errors.push(`${where}: "id" must be a lowercase slug such as "typecheck"`);
      continue;
    }
    if (ids.has(c.id)) errors.push(`${where}: duplicate id "${c.id}"`);
    ids.add(c.id);
    const hasCmd = typeof c.cmd === 'string' && c.cmd.trim() !== '';
    const hasSkip = typeof c.skip === 'string' && c.skip.trim().length >= 10;
    if (hasCmd === hasSkip) {
      errors.push(`${where} (${c.id}): give exactly one of "cmd" or "skip" (a reason of at least 10 characters)`);
    }
    if (c.cwd !== undefined) {
      const bad = typeof c.cwd !== 'string' || path.isAbsolute(c.cwd) || c.cwd.split(/[\\/]/).includes('..');
      if (bad) errors.push(`${where} (${c.id}): "cwd" must be a relative path inside the repo`);
    }
    if (c.timeoutSec !== undefined && !(Number.isFinite(c.timeoutSec) && c.timeoutSec > 0 && c.timeoutSec <= 7200)) {
      errors.push(`${where} (${c.id}): "timeoutSec" must be a number between 1 and 7200`);
    }
    if (c.fallback !== undefined && (typeof c.fallback !== 'string' || !c.fallback.trim())) {
      errors.push(`${where} (${c.id}): "fallback" must be a command string`);
    }
    if (c.match !== undefined) {
      try {
        new RegExp(c.match);
      } catch {
        errors.push(`${where} (${c.id}): "match" is not a valid regular expression`);
      }
    }
  }
  for (const id of REQUIRED_CHECKS) {
    if (!ids.has(id)) errors.push(`missing required check "${id}" (give it a "cmd", or a "skip" reason)`);
  }
  return errors;
}

export function checksHash(doc) {
  return sha256(JSON.stringify(doc.checks));
}

export function quoteArg(s) {
  if (process.platform === 'win32') return `"${s}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function tail(text, lines = 60, chars = 3500) {
  let t = text.split(/\r?\n/).slice(-lines).join('\n');
  if (t.length > chars) t = `…${t.slice(-chars)}`;
  return t.trim();
}

// Resolve one check into the command line to run, or a skip/failure without running.
export function resolveCheck(root, check, baseSha, changed) {
  if (check.skip) return { skip: `skipped: ${check.skip}` };
  let cmd = check.cmd;
  let note;
  if (cmd.includes('{files}')) {
    const cwdAbs = path.join(root, check.cwd || '.');
    const re = new RegExp(check.match || DEFAULT_MATCH);
    const files = changed
      .filter((f) => re.test(f))
      .map((f) => toPosix(path.relative(cwdAbs, path.join(root, f))))
      .filter((f) => f && !f.startsWith('..'));
    if (files.length === 0) return { skip: 'no changed files match, so there are no related tests to run' };
    const joined = files.map(quoteArg).join(' ');
    if (cmd.length + joined.length > MAX_CMDLINE) {
      if (!check.fallback) {
        return { fail: `${files.length} changed files are too many for one command line and no "fallback" command is set` };
      }
      cmd = check.fallback;
      note = `${files.length} changed files: ran the fallback command`;
    } else {
      cmd = cmd.split('{files}').join(joined);
    }
  }
  if (baseSha) cmd = cmd.split('{base}').join(baseSha);
  return { cmd, note };
}

export function runChecks(root, doc, { baseSha, only, onStart } = {}) {
  const changed = baseSha ? changedFiles(root, baseSha) : [];
  const results = [];
  for (const check of doc.checks) {
    if (only && !only.includes(check.id)) continue;
    const plan = resolveCheck(root, check, baseSha, changed);
    if (plan.skip) {
      results.push({ id: check.id, ok: true, skipped: true, note: plan.skip, output: '', tail: '' });
      continue;
    }
    if (plan.fail) {
      results.push({ id: check.id, ok: false, cmd: check.cmd, code: null, note: plan.fail, output: '', tail: '' });
      continue;
    }
    onStart?.(check.id, plan.cmd);
    const t0 = Date.now();
    const r = spawnSync(plan.cmd, {
      cwd: path.join(root, check.cwd || '.'),
      shell: true,
      encoding: 'utf8',
      timeout: (check.timeoutSec || 900) * 1000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, CI: process.env.CI || '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const output = stripAnsi([r.stdout, r.stderr].filter(Boolean).join('\n'));
    const timedOut = r.error?.code === 'ETIMEDOUT';
    results.push({
      id: check.id,
      cmd: plan.cmd,
      ok: r.status === 0 && !r.error,
      code: r.status,
      timedOut,
      ms: Date.now() - t0,
      note: plan.note || (r.error && !timedOut ? r.error.message : undefined),
      output,
      tail: tail(output),
    });
  }
  return results;
}

export function formatResults(results) {
  return results
    .map((r) => {
      if (r.skipped) return `- ${r.id}: ${r.note}`;
      const secs = r.ms !== undefined ? ` (${(r.ms / 1000).toFixed(1)}s)` : '';
      const status = r.ok ? 'PASS' : r.timedOut ? 'TIMED OUT' : `FAIL (exit ${r.code ?? '-'})`;
      const note = r.note ? ` — ${r.note}` : '';
      return `- ${r.id}: ${status}${secs} \`${r.cmd}\`${note}`;
    })
    .join('\n');
}

export function failureDetails(results) {
  return results
    .filter((r) => !r.ok)
    .map((r) => `--- ${r.id}: \`${r.cmd}\`${r.note ? ` (${r.note})` : ''}\n${r.tail || '(no output)'}`)
    .join('\n\n');
}

// ---------------------------------------------------------------- run inspection

export function inspect(run) {
  const { root, runDir, state } = run;
  const files = runFiles(runDir);
  const head = git(['rev-parse', 'HEAD'], root).out;
  const clean = isClean(root);
  const branch = currentBranch(root);
  const specText = readText(files.spec);
  const tasksText = readText(files.tasks);
  const tasks = parseTasks(tasksText);
  const planned = tasks.length > 0 && !specText.includes(FILL_MARKER) && !tasksText.includes(FILL_MARKER);
  const checksDoc = readJson(files.checks, null);
  const checksValid = checksDoc !== null && validateChecks(checksDoc).length === 0;
  const checksChanged = Boolean(state.checksHash && (!checksValid || checksHash(checksDoc) !== state.checksHash));
  const qaAtHead = state.qa && state.qa.sha === head ? state.qa : null;

  let stage;
  if (isTerminal(state.status)) stage = state.status;
  else if (state.status === 'wrapping-up') stage = 'wrap-up';
  else if (!state.checksHash) stage = 'discover';
  else if (!planned) stage = 'plan';
  else if (openTasks(tasks).length > 0) stage = 'build';
  else if (state.verifiedSha === head && clean) stage = 'ship';
  else if (!qaAtHead || qaAtHead.verdict !== 'pass') stage = 'qa';
  else stage = 'verify';

  return { head, clean, branch, tasks, planned, checksDoc, checksValid, checksChanged, qaAtHead, stage, files };
}

export function nextAction(run, info) {
  const { root, state } = run;
  const S = SHIP_CMD;
  const notes = [];
  if (!isTerminal(state.status) && info.branch !== state.branch) {
    notes.push(`HEAD is on "${info.branch ?? 'a detached HEAD'}"; switch back to the run branch "${state.branch}" first.`);
  }
  if (info.checksChanged && !['discover', 'wrap-up'].includes(info.stage)) {
    notes.push(`checks.json changed since it was locked; run \`${S} lock-checks\` again (re-locks are reported in the PR) or revert the change.`);
  }
  if (!info.clean && ['qa', 'verify', 'ship'].includes(info.stage)) {
    notes.push('The working tree has uncommitted changes: commit them as part of a task or discard them.');
  }

  const open = openTasks(info.tasks);
  let action;
  switch (info.stage) {
    case 'discover':
      action = `Discover this repo's checks (reference/discovery.md): write ${rel(root, info.files.checks)} with typecheck, lint, build and tests entries, then run \`${S} lock-checks\`.`;
      break;
    case 'plan':
      action = `Plan as PM: fill ${rel(root, info.files.spec)} (summary, acceptance criteria, out of scope, verification) and ${rel(root, info.files.tasks)} (T1..Tn, one commit each), and remove the ${FILL_MARKER} markers.`;
      break;
    case 'build': {
      const t = open[0];
      const more = open.length - 1;
      action = `Build ${t.id}${t.title ? ` (${t.title})` : ''}: delegate it to an engineer subagent (reference/roles.md), confirm it landed as one commit with the trailer "Ship-Task: ${t.id}", then tick it in tasks.md.${more ? ` ${more} more open task(s) after this one.` : ' It is the last open task.'}`;
      break;
    }
    case 'qa':
      action = info.qaAtHead?.verdict === 'fail'
        ? `QA failed at ${shortSha(info.head)}: add each finding as a new task in tasks.md and build it.`
        : `Run QA at ${shortSha(info.head)}: a QA subagent in a fresh context reviews \`git diff ${shortSha(state.baseSha)}..HEAD\` against spec.md, runs \`${S} run-checks\`, and records \`${S} qa --verdict pass|fail --notes-file <file>\`.`;
      break;
    case 'verify':
      action = state.verifyRequested
        ? 'Done is claimed: end your turn now so the Stop gate can verify this commit.'
        : `QA passed at ${shortSha(info.head)}. Run \`${S} claim-done\`, then end your turn so the Stop gate can verify.`;
      break;
    case 'ship':
      action = `The gate passed at ${shortSha(info.head)}. Run \`${S} finish\` to push the branch and open the PR, then end your turn with a short summary and the PR link.`;
      break;
    case 'wrap-up':
      action = `Stop feature work: ${state.wrapUp?.reason}. Run \`${S} finish --blocked "<one-line reason>"\` to push the branch and open a draft PR with a report, then end your turn. If there are uncommitted changes, commit finished work or discard the rest first.`;
      break;
    default:
      action = `This run is ${info.stage}. Nothing to do.`;
  }
  return [...notes, action].join(' ');
}

export function fingerprint(run, info) {
  return sha256(
    [
      info.head,
      porcelain(run.root),
      readText(info.files.tasks),
      readText(info.files.spec),
      readText(info.files.progress),
      readText(info.files.checks),
      String(run.state.progressMark),
    ].join('\0'),
  );
}

export function limitHit(state, now = Date.now()) {
  const l = { ...DEFAULT_LIMITS, ...state.limits };
  const g = state.gate;
  if (g.idle >= l.maxIdleStops) return `no progress across ${g.idle} consecutive turns`;
  if (g.failures >= l.maxGateFailures) return `the gate failed ${g.failures} times`;
  if (state.qaRounds >= l.maxQaRounds) return `QA failed ${state.qaRounds} rounds`;
  if (g.blocks > l.maxGateBlocks) return `the run used more than ${l.maxGateBlocks} turns`;
  const hours = (now - Date.parse(state.createdAt)) / 36e5;
  if (hours > l.maxHours) return `the run passed its ${l.maxHours}h time budget`;
  return null;
}

export function enterWrapUp(state, reason) {
  state.status = 'wrapping-up';
  state.wrapUp = { reason, at: nowIso(), stops: 0 };
  state.gate.idle = 0;
}

export function terminalSummary(run) {
  const { state } = run;
  const where = `.ship/runs/${state.slug}/`;
  switch (state.status) {
    case 'done':
      return `ship: "${state.title}" is ready for review: ${state.pr?.url ?? state.branch}`;
    case 'ready-local':
      return `ship: "${state.title}" passed the gate on ${state.branch}, but no PR was opened (${state.pr?.note ?? 'see the run notes'}). PR text is in ${where}PR.md.`;
    case 'blocked':
      return `ship: "${state.title}" is blocked (${state.blockedReason ?? 'see the report'}). ${state.pr?.url ? `Draft PR: ${state.pr.url}` : `Notes in ${where}`}`;
    case 'aborted':
      return `ship: "${state.title}" was aborted. Branch ${state.branch} is kept.`;
    default:
      return `ship: "${state.title}" is ${state.status}.`;
  }
}

// ---------------------------------------------------------------- roster

const ROLE_PATTERNS = [
  ['pm', /\b(project manager|product manager|program manager|delivery (lead|manager)|scrum master|pm)\b/i],
  ['qa', /\b(qa|quality assurance|quality engineer|test engineer|sdet|tester)\b/i],
  ['design', /\b(designer|design|ux|ui\/ux|ui)\b/i],
  ['engineer', /\b(engineer|developer|swe|programmer|architect|dev)\b/i],
];

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}

// Most specific field first; within a field, the role named earliest wins, so
// "React Native engineer who builds UI" is an engineer, not a designer.
function classify(meta, body, file) {
  const tiers = [
    meta.role,
    meta.title,
    `${meta.name || ''} ${path.basename(file, '.md').replace(/[-_]/g, ' ')}`,
    meta.description,
    body.slice(0, 600),
  ];
  for (const text of tiers) {
    if (!text) continue;
    let best = null;
    for (const [role, re] of ROLE_PATTERNS) {
      const m = re.exec(text);
      if (m && (best === null || m.index < best.index)) best = { role, index: m.index };
    }
    if (best) return best.role;
  }
  return 'other';
}

function listMarkdown(dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 1) out.push(...listMarkdown(p, depth + 1));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !/^readme\.md$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

export function userClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function roster(root) {
  const user = userClaudeDir();
  const sources = [
    root && { dir: path.join(root, '.claude', 'employees'), kind: 'employees' },
    { dir: path.join(user, 'employees'), kind: 'employees' },
    root && { dir: path.join(root, '.claude', 'agents'), kind: 'agents' },
    { dir: path.join(user, 'agents'), kind: 'agents' },
  ].filter(Boolean);
  const seen = new Set();
  const members = [];
  for (const { dir, kind } of sources) {
    for (const file of listMarkdown(dir)) {
      const { meta, body } = parseFrontmatter(readText(file));
      const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
      const name = meta.name || heading || path.basename(file, '.md');
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      members.push({
        name,
        role: classify(meta, body, file),
        description: (meta.description || '').slice(0, 160),
        path: toPosix(file),
        // Files under an agents/ folder with a frontmatter name are registered subagent types.
        agentType: kind === 'agents' && meta.name ? meta.name : undefined,
      });
    }
  }
  return members;
}
