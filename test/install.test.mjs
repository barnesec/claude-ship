import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REPO, sh, tmpdir } from './helpers.mjs';

describe('install.sh', { skip: process.platform === 'win32' && 'needs bash' }, () => {
  it('installs into CLAUDE_CONFIG_DIR with the skill path templated in', () => {
    const config = tmpdir('ship-config-');
    const run = () => sh('bash', [path.join(REPO, 'install.sh')], REPO, { CLAUDE_CONFIG_DIR: config });
    const first = run();
    assert.equal(first.code, 0, first.err);
    const dest = path.join(config, 'skills', 'ship');
    const skill = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8');
    assert.ok(!skill.includes('__SHIP_HOME__'));
    assert.ok(skill.includes(`args: ["${dest}/scripts/ship-gate.mjs", "stop"]`));
    assert.ok(skill.includes(`node "${dest}/scripts/ship.mjs"`));
    for (const f of ['scripts/lib.mjs', 'scripts/ship.mjs', 'scripts/ship-gate.mjs', 'reference/roles.md', 'reference/discovery.md', 'templates/tasks.md']) {
      assert.ok(fs.existsSync(path.join(dest, f)), f);
    }
    // Re-running updates in place and leaves no staging folder behind.
    assert.equal(run().code, 0);
    assert.deepEqual(fs.readdirSync(path.join(config, 'skills')), ['ship']);
  });
});

describe('SKILL.md', () => {
  it('keeps the frontmatter fields Claude Code needs', () => {
    const text = fs.readFileSync(path.join(REPO, 'skill', 'SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
    assert.match(fm, /^name: ship$/m);
    assert.match(fm, /^disable-model-invocation: true$/m);
    assert.match(fm, /^ {2}Stop:\n {4}- hooks:\n {8}- type: command\n {10}command: node\n {10}args: \["__SHIP_HOME__\/scripts\/ship-gate\.mjs", "stop"\]/m);
    assert.match(fm, /^ {2}SessionStart:\n {4}- matcher: compact/m);
    assert.ok(text.includes('${CLAUDE_SESSION_ID}'));
    assert.ok(text.includes('$ARGUMENTS'));
  });

  it('stays short enough to survive compaction (5,000-token re-attach budget)', () => {
    const text = fs.readFileSync(path.join(REPO, 'skill', 'SKILL.md'), 'utf8');
    assert.ok(text.length < 14000, `${text.length} chars`);
  });
});
