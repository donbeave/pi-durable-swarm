import assert from 'node:assert';
import { test } from 'node:test';
import { buildInterruptedSummary, formatInterruptedLine, formatRecoveryNotice, formatStaleNotice, sweepInterruptedAgents } from '../src/recovery.ts';
import type { AgentRecord } from '../src/state.ts';

function agent(partial: Partial<AgentRecord> & { id: string; name: string; state: AgentRecord['state'] }): AgentRecord {
  return {
    role: 'w3-impl',
    model: 'minimax/MiniMax-M3.1-Flash',
    provider: 'minimax',
    thinking: 'high',
    write: true,
    cwd: '/tmp/work',
    conversationId: 'conv-1' as unknown as AgentRecord['conversationId'],
    ownerTask: 'task-1' as unknown as AgentRecord['ownerTask'],
    tasks: [],
    queuedAt: 1000,
    ...partial,
  } as AgentRecord;
}

test('sweep transitions running and queued to interrupted, leaves terminal states untouched', () => {
  const now = 1_700_000_000_000;
  const agents: Record<string, AgentRecord> = {
    a: agent({ id: 'a', name: 'run-1', state: 'running', startedAt: 500 }),
    b: agent({ id: 'b', name: 'queue-1', state: 'queued', pendingTask: 'do it' }),
    c: agent({ id: 'c', name: 'done-1', state: 'completed' }),
    d: agent({ id: 'd', name: 'fail-1', state: 'failed' }),
    e: agent({ id: 'e', name: 'stop-1', state: 'stopped' }),
  };
  const count = sweepInterruptedAgents(agents, now);
  assert.equal(count, 2);
  assert.equal(agents.a!.state, 'interrupted');
  assert.equal(agents.a!.interruptedReason, 'coordinator-stop');
  assert.equal(agents.a!.interruptedAt, now);
  assert.equal(agents.b!.state, 'interrupted');
  assert.equal(agents.b!.interruptedReason, 'coordinator-stop');
  assert.equal(agents.b!.interruptedAt, now);
  assert.equal(agents.c!.state, 'completed');
  assert.equal(agents.c!.interruptedReason, undefined);
  assert.equal(agents.c!.interruptedAt, undefined);
  assert.equal(agents.d!.state, 'failed');
  assert.equal(agents.d!.interruptedAt, undefined);
  assert.equal(agents.e!.state, 'stopped');
  assert.equal(agents.e!.interruptedAt, undefined);
  // Idempotent: second sweep touches nothing already interrupted.
  assert.equal(sweepInterruptedAgents(agents, now + 1), 0);
  assert.equal(agents.a!.interruptedAt, now);
});

test('summary counts interrupted with worktree info, line and notice render only when >0', () => {
  const agents = [
    agent({ id: 'a', name: 'alpha', state: 'interrupted', worktree: { repository: '/repo', path: '/wt/alpha', branch: 'swarm/alpha', baseCommit: 'abc' } }),
    agent({ id: 'b', name: 'beta', state: 'interrupted' }),
    agent({ id: 'c', name: 'gamma', state: 'completed' }),
    agent({ id: 'd', name: 'delta', state: 'running' }),
  ];
  const summary = buildInterruptedSummary(agents);
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.agents, [
    { name: 'alpha', model: 'minimax/MiniMax-M3.1-Flash', provider: 'minimax', worktreePath: '/wt/alpha', branch: 'swarm/alpha' },
    { name: 'beta', model: 'minimax/MiniMax-M3.1-Flash', provider: 'minimax' },
  ]);
  assert.equal(formatInterruptedLine(summary), 'Interrupted (coordinator stop): 2 — resume or respawn before new work');
  const notice = formatRecoveryNotice(summary);
  assert.match(notice, /^RECOVERY NOTICE:/);
  assert.match(notice, /alpha/);
  assert.match(notice, /beta/);
  assert.match(notice, /swarm_steer/);
  assert.match(notice, /swarm_stop/);
  const empty = buildInterruptedSummary([agent({ id: 'x', name: 'x', state: 'completed' })]);
  assert.equal(empty.count, 0);
  assert.equal(formatInterruptedLine(empty), '');
  assert.equal(formatRecoveryNotice(empty), '');
});

test('stale notice lists only running agents past threshold, oldest first', () => {
  const agents = [
    { name: 'fresh', model: 'xiaomi/mimo-v2.6-flash', state: 'running', ageSec: 60 },
    { name: 'old-a', model: 'zai/glm-5.3-flash', state: 'running', ageSec: 1800 },
    { name: 'old-b', model: 'minimax/MiniMax-M3.1-Flash', state: 'running', ageSec: 3600 },
    { name: 'done-old', model: 'zai/glm-5.3-flash', state: 'completed', ageSec: 9999 },
    { name: 'no-age', model: 'zai/glm-5.3-flash', state: 'running' },
  ];
  const notice = formatStaleNotice(agents);
  assert.match(notice, /^STALE WORKER NOTICE: 2 /);
  assert.ok(notice.indexOf('old-b') < notice.indexOf('old-a'), 'oldest first');
  assert.match(notice, /old-b \(minimax\/MiniMax-M3\.1-Flash, 60m\)/);
  assert.doesNotMatch(notice, /fresh|done-old|no-age/);
  assert.equal(formatStaleNotice([agents[0], agents[3]]), '');
  assert.match(formatStaleNotice(agents, 59), /3 running/);
});
