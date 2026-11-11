import assert from 'node:assert';
import { test } from 'node:test';
import { admit, type SchedulableAgent } from '../src/scheduler.ts';

const agent = (id: string, provider: string, state: SchedulableAgent['state'], queuedAt = 0): SchedulableAgent => ({
  id,
  provider,
  state,
  queuedAt,
});

test('admits up to six globally and two per provider, oldest first', () => {
  const agents = [
    agent('a', 'minimax', 'queued', 3),
    agent('b', 'minimax', 'queued', 1),
    agent('c', 'minimax', 'queued', 2),
    agent('d', 'zai', 'queued', 4),
    agent('e', 'zai', 'queued', 5),
    agent('f', 'xiaomi-token-plan-sgp', 'queued', 6),
    agent('g', 'xiaomi-token-plan-sgp', 'queued', 7),
    agent('h', 'zai', 'queued', 8),
  ];
  assert.deepEqual(admit(agents), ['b', 'c', 'd', 'e', 'f', 'g']);
});

test('running workers consume both slots', () => {
  const agents = [
    agent('r1', 'minimax', 'running'),
    agent('r2', 'minimax', 'running'),
    agent('q1', 'minimax', 'queued', 1),
    agent('q2', 'zai', 'queued', 2),
  ];
  assert.deepEqual(admit(agents), ['q2']);
});

test('terminal workers free their slots', () => {
  const agents = [
    agent('done', 'minimax', 'completed'),
    agent('failed', 'zai', 'failed'),
    agent('q1', 'minimax', 'queued', 1),
  ];
  assert.deepEqual(admit(agents), ['q1']);
});

test('custom limits are hard bounds', () => {
  const agents = [agent('q1', 'zai', 'queued', 1), agent('q2', 'zai', 'queued', 2)];
  assert.deepEqual(admit(agents, { maxConcurrent: 1, perProvider: 1 }), ['q1']);
  assert.deepEqual(admit(agents, { maxConcurrent: 0, perProvider: 2 }), []);
});
