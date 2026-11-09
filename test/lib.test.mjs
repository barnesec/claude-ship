import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as L from '../skill/scripts/lib.mjs';
import { git, makeRepo, tmpdir } from './helpers.mjs';

describe('parseTasks', () => {
  it('reads open, done and dropped tasks and ignores other lines', () => {
    const tasks = L.parseTasks([
      '- [ ] T1: open one',
      '- [x] T2 — done one',
      '* [-] T3: dropped, criteria still hold',
      '- [X] T10. upper-case done',
      '- [ ] not a task',
      '`- [ ] T9: inside an example`',
    ].join('\n'));
    assert.deepEqual(tasks.map((t) => [t.id, t.done, t.dropped]), [
      ['T1', false, false],
      ['T2', true, false],
      ['T3', false, true],
      ['T10', true, false],
    ]);
    assert.equal(tasks[1].title, 'done one');
    assert.deepEqual(L.openTasks(tasks).map((t) => t.id), ['T1']);
  });
});

describe('validateChecks', () => {
  const good = {
    checks: [
      { id: 'typecheck', cmd: 'tsc' },
      { id: 'lint', cmd: 'eslint .' },
      { id: 'build', skip: 'library consumed as source' },
      { id: 'tests', cmd: 'jest {files}', fallback: 'jest' },
    ],
  };

  it('accepts a complete document', () => {
    assert.deepEqual(L.validateChecks(good), []);
  });

  it('requires all four checks and a cmd or a real skip reason', () => {
    const errors = L.validateChecks({
      checks: [
        { id: 'typecheck', cmd: 'tsc', skip: 'and a skip reason' },
        { id: 'lint', skip: 'short' },
        { id: 'Build!', cmd: 'x' },
        { id: 'tests', cmd: 'jest', cwd: '../elsewhere', timeoutSec: 0, match: '(' },
      ],
    });
    const text = errors.join('\n');
    assert.match(text, /typecheck\): give exactly one/);
    assert.match(text, /lint\): give exactly one/);
    assert.match(text, /lowercase slug/);
    assert.match(text, /"cwd" must be a relative path/);
    assert.match(text, /"timeoutSec"/);
    assert.match(text, /"match" is not a valid/);
    assert.match(text, /missing required check "build"/);
  });

  it('hashes only the checks array', () => {
    assert.equal(L.checksHash({ ...good, notes: 'a' }), L.checksHash({ ...good, notes: 'b' }));
    const changed = structuredClone(good);
    changed.checks[1].cmd = 'eslint src';
    assert.notEqual(L.checksHash(good), L.checksHash(changed));
  });
});

describe('slugify', () => {
  it('makes short branch-safe slugs', () => {
    assert.equal(L.slugify('Add a Dark-Mode toggle to Settings!'), 'add-a-dark-mode-toggle-to-settings');
    assert.equal(L.slugify('???'), 'task');
    assert.ok(L.slugify('word '.repeat(30)).length <= 40);
  });
});

describe('resolveCheck', () => {
  const repo = makeRepo();
  const base = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src', 'new.ts'), 'export {};\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# hi\n');
  const changed = L.changedFiles(repo, base);

  it('includes untracked files in the changed set', () => {
    assert.deepEqual(changed, ['README.md', 'src/new.ts']);
  });

  it('substitutes matching changed files, quoted', () => {
    const plan = L.resolveCheck(repo, { id: 'tests', cmd: 'jest {files}' }, base, changed);
    assert.equal(plan.cmd, process.platform === 'win32' ? 'jest "src/new.ts"' : "jest 'src/new.ts'");
  });

  it('skips when nothing related changed', () => {
    const plan = L.resolveCheck(repo, { id: 'tests', cmd: 'jest {files}', match: '\\.py$' }, base, changed);
    assert.match(plan.skip, /no changed files match/);
  });

  it('falls back when the file list is too long, or fails without a fallback', () => {
    const many = Array.from({ length: 400 }, (_, i) => `src/some/deep/folder/file-${i}.ts`);
    const withFallback = L.resolveCheck(repo, { id: 'tests', cmd: 'jest {files}', fallback: 'jest' }, base, many);
    assert.equal(withFallback.cmd, 'jest');
    const without = L.resolveCheck(repo, { id: 'tests', cmd: 'jest {files}' }, base, many);
    assert.match(without.fail, /too many/);
  });

  it('expands {base} and {tmp}', () => {
    const plan = L.resolveCheck(repo, { id: 'build', cmd: 'build --since {base} --out {tmp}' }, base, changed);
    assert.ok(plan.cmd.includes(base));
    assert.ok(!plan.cmd.includes('{tmp}'));
    assert.ok(!plan.cmd.includes(repo), 'build output must live outside the repo');
  });

  it('makes {files} relative to the check cwd and drops files outside it', () => {
    const plan = L.resolveCheck(repo, { id: 'tests', cmd: 'jest {files}', cwd: 'src', match: '.' }, base, changed);
    assert.equal(plan.cmd, process.platform === 'win32' ? 'jest "new.ts"' : "jest 'new.ts'");
  });
});

describe('roster', () => {
  it('finds employees and agents and classifies their roles', () => {
    const home = tmpdir('ship-home-');
    const emp = path.join(home, 'employees');
    const agents = path.join(home, 'agents');
    fs.mkdirSync(emp, { recursive: true });
    fs.mkdirSync(path.join(emp, 'engineering'), { recursive: true });
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(emp, 'marleene.md'), '---\nname: Marleene\ndescription: Project Manager who runs delivery\n---\nPlans work.');
    fs.writeFileSync(path.join(emp, 'engineering', 'alex.md'), '---\nname: Alex\ndescription: React Native engineer who builds UI\n---\n');
    fs.writeFileSync(path.join(emp, 'quinn.md'), '# Quinn\n\nQA Engineer focused on mobile.');
    fs.writeFileSync(path.join(emp, 'dana.md'), '---\nname: Dana\ndescription: Senior UX Designer\n---\n');
    fs.writeFileSync(path.join(emp, 'README.md'), 'not a member');
    fs.writeFileSync(path.join(agents, 'reviewer.md'), '---\nname: code-reviewer\ndescription: Reviews code as a senior engineer\n---\n');
    fs.writeFileSync(path.join(agents, 'marleene-copy.md'), '---\nname: Marleene\ndescription: duplicate\n---\n');

    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      const members = L.roster(null);
      const byName = Object.fromEntries(members.map((m) => [m.name, m]));
      assert.deepEqual(Object.keys(byName).sort(), ['Alex', 'Dana', 'Marleene', 'Quinn', 'code-reviewer']);
      assert.equal(byName.Marleene.role, 'pm');
      assert.equal(byName.Alex.role, 'engineer');
      assert.equal(byName.Quinn.role, 'qa');
      assert.equal(byName.Dana.role, 'design');
      assert.equal(byName['code-reviewer'].agentType, 'code-reviewer');
      assert.equal(byName.Marleene.agentType, undefined);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});
