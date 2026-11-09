import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  FIXTURE_CHECKS, SPEC, commitTask, gate, git, makeRepo, patchState, runDir, runToVerify,
  ship, state, tasksMd, tmpdir, writeRunFile,
} from './helpers.mjs';

const input = (repo, session = 's1', extra = {}) => ({ session_id: session, cwd: repo, permission_mode: 'auto', ...extra });

describe('init', () => {
  it('refuses a dirty tree', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'src', 'greet.js'), '// edited\n');
    const r = ship(repo, ['init', '--title', 'x', '--session', 's1']);
    assert.equal(r.code, 1);
    assert.match(r.err, /uncommitted changes/);
  });

  it('branches off the current branch, git-excludes .ship and refuses a second active run', () => {
    const repo = makeRepo();
    const r = ship(repo, ['init', '--title', 'Friendlier greeting', '--session', 's1']);
    assert.equal(r.code, 0, r.err);
    assert.equal(git(repo, 'branch', '--show-current'), 'ship/friendlier-greeting');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.ship\/$/m);
    const s = state(repo);
    assert.equal(s.base, 'main');
    assert.equal(s.sessionId, 's1');
    for (const f of ['request.md', 'spec.md', 'tasks.md', 'progress.md', 'checks.json']) {
      assert.ok(fs.existsSync(path.join(runDir(repo), f)), f);
    }
    const again = ship(repo, ['init', '--title', 'Another', '--session', 's1']);
    assert.equal(again.code, 1);
    assert.match(again.err, /still active/);
  });
});

describe('gate scoping', () => {
  it('is silent outside a run and for other sessions', () => {
    const repo = makeRepo();
    assert.equal(gate('stop', input(repo)).out, '');
    ship(repo, ['init', '--title', 'x', '--session', 's1']);
    assert.equal(gate('stop', input(repo, 'someone-else')).out, '');
    assert.equal(gate('context', input(repo, 'someone-else')).out, '');
    assert.ok(gate('stop', input(repo)).json.decision === 'block');
  });

  it('fails open on garbage input', () => {
    const r = gate('stop', { cwd: '/definitely/not/a/repo' });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
  });
});

describe('a full run', () => {
  it('walks discover → plan → build → qa → verify → ship and opens nothing without a remote', () => {
    const repo = makeRepo();
    ship(repo, ['init', '--title', 'Friendlier greeting', '--session', 's1']);
    const stageHint = () => gate('stop', input(repo)).json.reason;

    assert.match(stageHint(), /stage: discover[\s\S]*discovery\.md/);

    writeRunFile(repo, 'checks.json', FIXTURE_CHECKS);
    assert.equal(ship(repo, ['run-checks']).code, 0);
    assert.equal(ship(repo, ['lock-checks']).code, 0);
    assert.match(stageHint(), /stage: plan/);

    writeRunFile(repo, 'spec.md', SPEC);
    writeRunFile(repo, 'tasks.md', tasksMd(['- [ ] T1: first change | owner: engineer', '- [ ] T2: second change | owner: engineer']));
    assert.match(stageHint(), /Build T1 \(first change/);

    commitTask(repo, 'T1');
    writeRunFile(repo, 'tasks.md', tasksMd(['- [x] T1: first change | owner: engineer', '- [ ] T2: second change | owner: engineer']));
    assert.match(stageHint(), /Build T2[\s\S]*last open task/);

    // QA can't sign off while tasks are open.
    assert.equal(ship(repo, ['qa', '--verdict', 'pass']).code, 1);

    commitTask(repo, 'T2');
    writeRunFile(repo, 'tasks.md', tasksMd(['- [x] T1: first change | owner: engineer', '- [x] T2: second change | owner: engineer']));
    assert.match(stageHint(), /stage: qa/);

    // Claiming done before QA is refused.
    assert.equal(ship(repo, ['claim-done']).code, 1);

    assert.equal(ship(repo, ['qa', '--verdict', 'pass', '--notes', 'Criteria met.']).code, 0);
    assert.match(stageHint(), /Run `[^`]*claim-done`/);

    assert.equal(ship(repo, ['claim-done']).code, 0);
    const verdict = gate('stop', input(repo)).json;
    assert.match(verdict.reason, /Gate PASSED/);
    assert.match(verdict.reason, /build: skipped: fixture has no build step/);
    const head = git(repo, 'rev-parse', 'HEAD');
    assert.equal(state(repo).verifiedSha, head);

    // The related-tests check received the changed source file.
    const log = fs.readFileSync(path.join(runDir(repo), 'gate-1.log'), 'utf8');
    assert.match(log, /tests ran with: .*src\/greet\.js/);

    const fin = ship(repo, ['finish']);
    assert.equal(fin.code, 0, fin.err);
    assert.match(fin.out, /No git remote/);
    assert.equal(state(repo).status, 'ready-local');

    const body = fs.readFileSync(path.join(runDir(repo), 'PR.md'), 'utf8');
    assert.match(body, /## Summary\n\nMake greetings friendlier\./);
    assert.match(body, /\| done \| T1: first change \| `[0-9a-f]{7,}` \|/);
    assert.match(body, /Stop-gate run at `[0-9a-f]{8}`: \*\*PASSED\*\*/);
    assert.match(body, /\*\*pass\*\* at/);

    const announce = gate('stop', input(repo));
    assert.match(announce.json.systemMessage, /passed the gate/);
    assert.equal(gate('stop', input(repo)).out, '', 'announces only once');
  });
});

describe('the gate', () => {
  it('returns failing output, counts the failure and needs a new claim', () => {
    const repo = makeRepo();
    runToVerify(repo);
    ship(repo, ['claim-done']);
    const r = gate('stop', input(repo), { SHIP_TEST_FAIL: 'lint' });
    assert.match(r.json.reason, /Gate FAILED/);
    assert.match(r.json.reason, /lint: FAIL \(exit 1\)/);
    assert.match(r.json.reason, /lint broke: simulated failure/);
    assert.match(r.json.reason, /add a fix task/);
    const s = state(repo);
    assert.equal(s.gate.failures, 1);
    assert.equal(s.verifyRequested, false);
    assert.equal(s.verifiedSha, null);
    assert.match(gate('stop', input(repo)).json.reason, /claim-done/);
  });

  it('refuses to run on a dirty tree', () => {
    const repo = makeRepo();
    runToVerify(repo);
    ship(repo, ['claim-done']);
    fs.writeFileSync(path.join(repo, 'stray.txt'), 'oops');
    const r = gate('stop', input(repo));
    assert.match(r.json.reason, /Gate not run: the working tree has uncommitted changes/);
    assert.equal(state(repo).gate.runs.length, 0);
  });

  it('treats QA sign-off as stale after a new commit', () => {
    const repo = makeRepo();
    runToVerify(repo);
    writeRunFile(repo, 'tasks.md', tasksMd(['- [x] T1: change greeting | owner: engineer', '- [x] T2: late fix | owner: engineer']));
    commitTask(repo, 'T2');
    assert.equal(ship(repo, ['claim-done']).code, 1);
    assert.match(gate('stop', input(repo)).json.reason, /stage: qa/);
  });

  it('notices checks.json edits after locking', () => {
    const repo = makeRepo();
    runToVerify(repo);
    const weakened = structuredClone(FIXTURE_CHECKS);
    weakened.checks[1] = { id: 'lint', skip: 'lint was annoying today' };
    writeRunFile(repo, 'checks.json', weakened);
    const claim = ship(repo, ['claim-done']);
    assert.equal(claim.code, 1);
    assert.match(claim.err, /checks\.json changed/);
    assert.match(gate('stop', input(repo)).json.reason, /checks\.json changed since it was locked/);
    assert.equal(ship(repo, ['lock-checks']).code, 0);
    assert.equal(state(repo).checksRelocks, 1);
  });

  it('wraps up after the failure limit', () => {
    const repo = makeRepo();
    runToVerify(repo);
    patchState(repo, (s) => { s.limits.maxGateFailures = 1; });
    ship(repo, ['claim-done']);
    const r = gate('stop', input(repo), { SHIP_TEST_FAIL: 'typecheck' });
    assert.match(r.json.reason, /failure limit is reached[\s\S]*finish --blocked/);
    assert.equal(state(repo).status, 'wrapping-up');
  });

  it('wraps up an idle run, then lets the session stop if the wrap-up stalls too', () => {
    const repo = makeRepo();
    ship(repo, ['init', '--title', 'Idle', '--session', 's1']);
    const seen = [];
    for (let i = 0; i < 10; i += 1) {
      const r = gate('stop', input(repo));
      if (!r.json?.decision) {
        seen.push(r.json?.systemMessage ?? '');
        break;
      }
      seen.push(r.json.reason);
    }
    assert.ok(seen.length <= 8, `stopped after ${seen.length} turns (Claude Code caps consecutive blocks at 8)`);
    assert.ok(seen.some((t) => /Run limit reached: no progress/.test(t)));
    assert.match(seen.at(-1), /stopped without a PR/);
    assert.equal(state(repo).status, 'blocked');
    assert.equal(gate('stop', input(repo)).out, '');
  });

  it('warns the user once when the session is not in auto mode', () => {
    const repo = makeRepo();
    ship(repo, ['init', '--title', 'x', '--session', 's1']);
    const first = gate('stop', input(repo, 's1', { permission_mode: 'default' })).json;
    assert.match(first.systemMessage, /not in auto mode/);
    const second = gate('stop', input(repo, 's1', { permission_mode: 'default' })).json;
    assert.equal(second.systemMessage, undefined);
  });
});

describe('finish', () => {
  it('refuses before the gate passes, and opens a blocked report on request', () => {
    const repo = makeRepo();
    runToVerify(repo);
    const early = ship(repo, ['finish']);
    assert.equal(early.code, 1);
    assert.match(early.err, /has not passed/);
    const blocked = ship(repo, ['finish', '--blocked', 'needs a Stripe test key']);
    assert.equal(blocked.code, 0, blocked.err);
    const s = state(repo);
    assert.equal(s.status, 'blocked');
    assert.equal(s.blockedReason, 'needs a Stripe test key');
    assert.match(fs.readFileSync(path.join(runDir(repo), 'PR.md'), 'utf8'), /^> \*\*Blocked:\*\* needs a Stripe test key/);
    assert.match(gate('stop', input(repo)).json.systemMessage, /blocked \(needs a Stripe test key\)/);
  });

  it('pushes the branch to the remote', () => {
    const repo = makeRepo();
    const remote = tmpdir('ship-remote-');
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    runToVerify(repo);
    ship(repo, ['claim-done']);
    assert.match(gate('stop', input(repo)).json.reason, /Gate PASSED/);
    const fin = ship(repo, ['finish'], { PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin:/bin' });
    assert.equal(fin.code, 0, fin.err);
    assert.match(git(remote, 'branch', '--list'), /ship\/friendlier-greeting/);
    assert.equal(state(repo).status, 'ready-local');
    assert.match(state(repo).pr.note, /gh/);
  });
});

describe('resume and abort', () => {
  it('rebinds a run to a new session and reopens a blocked one', () => {
    const repo = makeRepo();
    runToVerify(repo, 'old');
    ship(repo, ['finish', '--blocked', 'needs credentials']);
    assert.equal(gate('stop', input(repo, 'new')).out, '');
    const r = ship(repo, ['adopt', '--session', 'new']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /reopened/);
    assert.equal(state(repo).status, 'running');
    assert.match(gate('stop', input(repo, 'new')).json.reason, /claim-done/);
  });

  it('aborts and goes quiet', () => {
    const repo = makeRepo();
    ship(repo, ['init', '--title', 'x', '--session', 's1']);
    assert.equal(ship(repo, ['abort', 'changed', 'my', 'mind']).code, 0);
    assert.equal(state(repo).blockedReason, 'changed my mind');
    assert.equal(gate('stop', input(repo)).out, '');
  });
});

describe('context hook', () => {
  it('re-orients Claude after compaction', () => {
    const repo = makeRepo();
    ship(repo, ['init', '--title', 'Friendlier greeting', '--session', 's1']);
    const r = gate('context', input(repo));
    assert.match(r.out, /\/ship run is in progress[\s\S]*Stage: discover/);
  });
});
