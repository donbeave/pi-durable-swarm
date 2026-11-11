import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareWorktree, verifyWorktree, worktreeStatus } from '../src/worktrees.ts';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-wt-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir });
  git(['init', '-q']);
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(['add', '-A']);
  git(['-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-qm', 'base']);
  // Parent dirt must never leak into a worker worktree.
  writeFileSync(join(dir, 'a.txt'), 'dirty parent\n');
  return dir;
}

test('worktree starts at recorded HEAD without parent dirt and is retained', async () => {
  const dir = repo();
  const worktree = await prepareWorktree({ cwd: dir, root: join(dir, '.swarm-wt'), agentId: 'tool:abc' });
  assert.equal(worktree.branch, 'swarm/tool-abc');
  await verifyWorktree(worktree);
  assert.equal(await worktreeStatus(worktree), '');

  writeFileSync(join(worktree.path, 'b.txt'), 'worker change\n');
  assert.match(await worktreeStatus(worktree), /b\.txt/);
  // No auto-commit: HEAD is still the recorded base.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree.path, encoding: 'utf8' }).trim();
  assert.equal(head, worktree.baseCommit);
});

test('preparing the same agent worktree twice refuses to overwrite', async () => {
  const dir = repo();
  await prepareWorktree({ cwd: dir, root: join(dir, '.swarm-wt'), agentId: 'tool:dup' });
  await assert.rejects(
    prepareWorktree({ cwd: dir, root: join(dir, '.swarm-wt'), agentId: 'tool:dup' }),
    /already exists|already checked out|is already used/,
  );
});
