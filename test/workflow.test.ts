import assert from 'node:assert';
import { test } from 'node:test';
import { formatJoin, substitutePrevious } from '../src/workflow.ts';

test('chain substitution replaces every placeholder', () => {
  assert.equal(substitutePrevious('Review this: {previous}. Again: {previous}', 'DIFF'), 'Review this: DIFF. Again: DIFF');
});

test('first chain step keeps its task unchanged', () => {
  assert.equal(substitutePrevious('Fix it. {previous}', undefined), 'Fix it. {previous}');
});

test('join formats one section per worker and clips long results', () => {
  const text = formatJoin(
    [
      { name: 'a', status: 'completed', text: 'done' },
      { name: 'b', status: 'failed', text: 'x'.repeat(50) },
    ],
    10,
  );
  assert.match(text, /== a \[completed\] ==\ndone/);
  assert.match(text, /== b \[failed\] ==\nx{10}\n\[clipped; collect with swarm_result\]/);
});

test('worker names are made unique with numeric suffixes', async () => {
  const { uniqueName } = await import('../src/workflow.ts');
  assert.equal(uniqueName(new Set(), 'w2-impl'), 'w2-impl');
  assert.equal(uniqueName(new Set(['w2-impl']), 'w2-impl'), 'w2-impl-2');
  assert.equal(uniqueName(new Set(['w2-impl', 'w2-impl-2']), 'w2-impl'), 'w2-impl-3');
});

test('shared writer warning fires only for unisolated parallel writers in one cwd', async () => {
  const { sharedWriterWarning } = await import('../src/workflow.ts');
  const writer = (name: string, extra: object = {}) => ({ name, state: 'running', write: true, cwd: '/repo', hasWorktree: false, ...extra });
  assert.match(sharedWriterWarning([writer('a'), writer('b')], 'a') ?? '', /WARNING: a shares cwd/);
  assert.equal(sharedWriterWarning([writer('a')], 'a'), undefined);
  assert.equal(sharedWriterWarning([writer('a', { hasWorktree: true }), writer('b')], 'a'), undefined);
  assert.equal(sharedWriterWarning([writer('a'), writer('b', { write: false })], 'a'), undefined);
  assert.equal(sharedWriterWarning([writer('a'), writer('b', { cwd: '/other' })], 'a'), undefined);
});
