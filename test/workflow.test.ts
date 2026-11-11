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
