import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ackSupervisorDirective, prependSupervisorDirectives, readSupervisorDirectives, supervisorInboxDir } from '../src/supervisor-inbox.ts';
import { buildSupervisorSnapshot, supervisorSummaryPath, SUPERVISOR_SNAPSHOT_VERSION, writeSupervisorSnapshot } from '../src/supervisor-snapshot.ts';
import type { SupervisorSummary } from '../src/runtime.ts';
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
  writeFileSync(join(dir, 'SUP-a.md'), Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n'));
  const directives = await readSupervisorDirectives(ws);
  assert.equal(directives.length, 1);
  assert.equal(directives[0]!.file, 'SUP-a.md');
  assert.equal(directives[0]!.text.split('\n').length, 40);
  const text = await prependSupervisorDirectives(ws, 'RESULT');
  assert.match(text, /^SUPERVISOR DIRECTIVES \(unacked\):\n--- SUP-a\.md ---\nline0/);
  assert.match(text, /RESULT$/);
  await ackSupervisorDirective(ws, 'SUP-a.md');
  assert.equal(existsSync(join(dir, 'SUP-a.md')), false);
  assert.equal(readFileSync(join(dir, 'acked', 'SUP-a.md'), 'utf8').startsWith('line0'), true);
  assert.equal(await prependSupervisorDirectives(ws, 'RESULT'), 'RESULT');
  await assert.rejects(ackSupervisorDirective(ws, '../SUP-a.md'), /Invalid supervisor directive/);
  await assert.rejects(ackSupervisorDirective(ws, 'sub/SUP-a.md'), /Invalid supervisor directive/);
});

test('non-SUP inbox file is NOT surfaced and NOT ackable, SUP- file is surfaced', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'swarm-inbox-sup-'));
  const dir = supervisorInboxDir(ws);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'note.md'), 'plain note\n');
  writeFileSync(join(dir, 'SUP-directive.md'), 'do the thing\n');
  const directives = await readSupervisorDirectives(ws);
  assert.deepEqual(directives.map((d) => d.file), ['SUP-directive.md']);
  const text = await prependSupervisorDirectives(ws, 'RESULT');
  assert.match(text, /SUP-directive\.md/);
  assert.doesNotMatch(text, /plain note/);
  assert.doesNotMatch(text, /note\.md/);
  await assert.rejects(ackSupervisorDirective(ws, 'note.md'), /Invalid supervisor directive/);
  assert.equal(existsSync(join(dir, 'note.md')), true);
  await ackSupervisorDirective(ws, 'SUP-directive.md');
  assert.equal(existsSync(join(dir, 'acked', 'SUP-directive.md')), true);
});

test('snapshot file written with required keys', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'swarm-snap-'));
  const sup: SupervisorSummary = {
    generatedAt: 1234567890,
    concurrency: { running: 2, queued: 1, byProvider: { minimax: { running: 1, queued: 1, limit: 2 }, zai: { running: 1, queued: 0, limit: 2 } } },
    agents: [
      { id: '1', name: 'w-old', state: 'running', model: 'm1', provider: 'zai', ageSec: 1000 },
      { id: '2', name: 'w-new', state: 'running', model: 'm2', provider: 'minimax', ageSec: 10 },
      { id: '3', name: 'w-done', state: 'completed', model: 'm3', provider: 'zai' },
    ],
    tokensByProvider: { zai: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: 0.01 } },
    stockpileDirty: 3,
    stockpileUnpushed: 2,
  };
  const written = await writeSupervisorSnapshot(ws, sup);
  assert.equal(written, supervisorSummaryPath(ws));
  assert.equal(existsSync(join(ws, '.pi', 'durable-swarm', 'supervisor-summary.json.tmp')), false);
  const snap = JSON.parse(readFileSync(supervisorSummaryPath(ws), 'utf8'));
  assert.equal(snap.generatedAt, 1234567890);
  assert.equal(snap.version, SUPERVISOR_SNAPSHOT_VERSION);
  assert.equal(snap.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual(snap.concurrency, sup.concurrency);
  assert.deepEqual(snap.tokensByProvider, sup.tokensByProvider);
  assert.deepEqual(snap.agentsRunning, [
    { name: 'w-old', model: 'm1', provider: 'zai', ageSec: 1000, stale: true },
    { name: 'w-new', model: 'm2', provider: 'minimax', ageSec: 10, stale: false },
  ]);
  assert.deepEqual(snap.stockpile, { dirty: 3, unpushed: 2 });
  assert.deepEqual(snap.supervisorSummary, JSON.parse(JSON.stringify(sup)));
  assert.deepEqual(buildSupervisorSnapshot(sup).stockpile, { dirty: 3, unpushed: 2 });
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
