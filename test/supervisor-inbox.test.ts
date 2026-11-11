import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ackSupervisorDirective, prependSupervisorDirectives, readSupervisorDirectives, supervisorInboxDir } from '../src/supervisor-inbox.ts';
import { clampJoinTimeout, MAX_JOIN_TIMEOUT_MS } from '../src/workflow.ts';
import { worktreeStockpile } from '../src/worktrees.ts';

test('join timeout is clamped to 240000', () => {
  assert.equal(MAX_JOIN_TIMEOUT_MS, 240000);
  assert.equal(clampJoinTimeout(undefined), 240000);
  assert.equal(clampJoinTimeout(999999), 240000);
  assert.equal(clampJoinTimeout(5000), 5000);
});

test('supervisor inbox prepends first 40 lines, ignores acked, ack moves file', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'swarm-inbox-'));
  const dir = supervisorInboxDir(ws);
  mkdirSync(join(dir, 'acked'), { recursive: true });
  writeFileSync(join(dir, 'acked', 'old.md'), 'old\n');
  writeFileSync(join(dir, 'note.txt'), 'ignore\n');
  writeFileSync(join(dir, 'a.md'), Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n'));
  const directives = await readSupervisorDirectives(ws);
  assert.equal(directives.length, 1);
  assert.equal(directives[0]!.file, 'a.md');
  assert.equal(directives[0]!.text.split('\n').length, 40);
  const text = await prependSupervisorDirectives(ws, 'RESULT');
  assert.match(text, /^SUPERVISOR DIRECTIVES \(unacked\):\n--- a\.md ---\nline0/);
  assert.match(text, /RESULT$/);
  await ackSupervisorDirective(ws, 'a.md');
  assert.equal(existsSync(join(dir, 'a.md')), false);
  assert.equal(readFileSync(join(dir, 'acked', 'a.md'), 'utf8').startsWith('line0'), true);
  assert.equal(await prependSupervisorDirectives(ws, 'RESULT'), 'RESULT');
  await assert.rejects(ackSupervisorDirective(ws, '../a.md'), /Invalid supervisor directive/);
  await assert.rejects(ackSupervisorDirective(ws, 'sub/a.md'), /Invalid supervisor directive/);
});

test('worktree stockpile counts dirty and unpushed, -1 on error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-stock-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir });
  git(['init', '-q']);
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(['add', '-A']);
  git(['-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-qm', 'base']);
  writeFileSync(join(dir, 'b.txt'), 'new\n');
  const s = await worktreeStockpile(dir);
  assert.equal(s.dirtyFiles, 1);
  assert.equal(s.unpushedCommits, -1);
  assert.deepEqual(await worktreeStockpile(join(dir, 'missing')), { dirtyFiles: -1, unpushedCommits: -1 });
});
