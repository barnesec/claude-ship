import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHIP = path.join(REPO, 'skill', 'scripts', 'ship.mjs');
export const GATE = path.join(REPO, 'skill', 'scripts', 'ship-gate.mjs');

export function tmpdir(prefix = 'ship-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function sh(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

export function git(cwd, ...args) {
  const r = sh('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.err}`);
  return r.out;
}

// A small repo whose checks are controlled by SHIP_TEST_FAIL=<id,id>.
export function makeRepo() {
  const dir = tmpdir();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "fixture", "private": true }\n');
  fs.writeFileSync(path.join(dir, 'src', 'greet.js'), 'export const greet = (n) => `hi ${n}`;\n');
  fs.writeFileSync(
    path.join(dir, 'tools', 'check.mjs'),
    [
      'const [id, ...rest] = process.argv.slice(2);',
      "const failing = (process.env.SHIP_TEST_FAIL || '').split(',');",
      "console.log(`${id} ran with: ${rest.join(' ') || '(no args)'}`);",
      "if (failing.includes(id)) { console.error(`${id} broke: simulated failure`); process.exit(1); }",
      '',
    ].join('\n'),
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

export const FIXTURE_CHECKS = {
  version: 1,
  checks: [
    { id: 'typecheck', cmd: 'node tools/check.mjs typecheck' },
    { id: 'lint', cmd: 'node tools/check.mjs lint' },
    { id: 'build', skip: 'fixture has no build step' },
    { id: 'tests', cmd: 'node tools/check.mjs tests {files}', fallback: 'node tools/check.mjs tests --all' },
  ],
};

export function ship(cwd, args, env = {}) {
  return sh(process.execPath, [SHIP, ...args], cwd, env);
}

export function gate(mode, input, env = {}) {
  const r = spawnSync(process.execPath, [GATE, mode], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const out = (r.stdout || '').trim();
  let json = null;
  if (mode === 'stop' && out) json = JSON.parse(out);
  return { code: r.status, out, err: (r.stderr || '').trim(), json };
}

export function runDir(repo) {
  const { slug } = JSON.parse(fs.readFileSync(path.join(repo, '.ship', 'active.json'), 'utf8'));
  return path.join(repo, '.ship', 'runs', slug);
}

export function state(repo) {
  return JSON.parse(fs.readFileSync(path.join(runDir(repo), 'state.json'), 'utf8'));
}

export function patchState(repo, patch) {
  const p = path.join(runDir(repo), 'state.json');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  patch(s);
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
}

export function writeRunFile(repo, name, content) {
  fs.writeFileSync(path.join(runDir(repo), name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

export const SPEC = `# Spec: Greeting

## Summary

Make greetings friendlier.

## Acceptance criteria

1. greet("Ana") returns "hello Ana".

## Out of scope

Nothing else.

## Design notes

n/a

## Verification

Unit test.

## Decisions

None.
`;

export function tasksMd(lines) {
  return `# Tasks\n\n## Tasks\n\n${lines.join('\n')}\n`;
}

// Commit a change to src/ as one task commit.
export function commitTask(repo, id, body = `// ${id}\n`) {
  fs.appendFileSync(path.join(repo, 'src', 'greet.js'), body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `feat(greet): change for ${id}`, '-m', `Ship-Task: ${id}`);
  return git(repo, 'rev-parse', 'HEAD');
}

// Drive a fresh run to the point where QA has passed at HEAD with all tasks done.
export function runToVerify(repo, session = 's1') {
  const init = ship(repo, ['init', '--title', 'Friendlier greeting', '--session', session]);
  if (init.code !== 0) throw new Error(init.err);
  writeRunFile(repo, 'checks.json', FIXTURE_CHECKS);
  const lock = ship(repo, ['lock-checks']);
  if (lock.code !== 0) throw new Error(lock.err);
  writeRunFile(repo, 'spec.md', SPEC);
  writeRunFile(repo, 'tasks.md', tasksMd(['- [ ] T1: change greeting | owner: engineer']));
  commitTask(repo, 'T1');
  writeRunFile(repo, 'tasks.md', tasksMd(['- [x] T1: change greeting | owner: engineer']));
  const qa = ship(repo, ['qa', '--verdict', 'pass', '--notes', 'All acceptance criteria met; checks green.']);
  if (qa.code !== 0) throw new Error(qa.err);
}
