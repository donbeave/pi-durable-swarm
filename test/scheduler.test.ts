import assert from 'node:assert';
import { test } from 'node:test';
import { admit, type SchedulableAgent } from '../src/scheduler.ts';

const agent = (id: string, provider: string, state: SchedulableAgent['state'], queuedAt = 0): SchedulableAgent => ({
  id,
  provider,
  state,
  queuedAt,
});

test('admits up to twelve globally and four per provider, oldest first', () => {
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
  assert.deepEqual(admit(agents), ['b', 'c', 'a', 'd', 'e', 'f', 'g', 'h']);
});

test('running workers consume both slots', () => {
  const agents = [
    agent('r1', 'kimi-coding', 'running'),
    agent('q1', 'kimi-coding', 'queued', 1),
    agent('q2', 'zai', 'queued', 2),
  ];
  // Kimi cap is 2, so one running worker leaves exactly one slot for q1;
  // zai q2 follows in queued order.
  assert.deepEqual(admit(agents), ['q1', 'q2']);
});

test('kimi cap is two while other providers stay at four', () => {
  const kimi = Array.from({ length: 6 }, (_, i) => agent(`k${i}`, 'kimi-coding', 'queued', i + 1));
  assert.equal(admit(kimi).length, 2);
  const zai = Array.from({ length: 6 }, (_, i) => agent(`z${i}`, 'zai', 'queued', i + 1));
  assert.equal(admit(zai).length, 4);
});

test('four providers fit the global cap with kimi held at two', () => {
  const both = [
    ...Array.from({ length: 4 }, (_, i) => agent(`m${i}`, 'xiaomi-token-plan-sgp', 'queued', i + 1)),
    ...Array.from({ length: 2 }, (_, i) => agent(`k${i}`, 'kimi-coding', 'queued', 20 + i)),
    ...Array.from({ length: 4 }, (_, i) => agent(`z${i}`, 'zai', 'queued', 40 + i)),
  ];
  assert.equal(admit(both).length, 10);
});

test('providerCaps override admits beyond the default per-provider cap only for that provider', () => {
  const agents = [
    ...Array.from({ length: 6 }, (_, i) => agent(`m${i}`, 'minimax', 'queued', i + 1)),
    ...Array.from({ length: 6 }, (_, i) => agent(`z${i}`, 'zai', 'queued', 10 + i)),
  ];
  const admitted = admit(agents, { maxConcurrent: 16, perProvider: 2 });
  assert.equal(admitted.filter((id) => id.startsWith('m')).length, 2);
  assert.equal(admitted.filter((id) => id.startsWith('z')).length, 2);
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
