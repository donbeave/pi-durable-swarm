import assert from 'node:assert';
import { test } from 'node:test';
import { assertThinking, ELIGIBLE_MODELS, resolveModel } from '../src/policy.ts';

test('every eligible model resolves exactly', () => {
  for (const model of ELIGIBLE_MODELS) {
    const resolved = resolveModel(model.id);
    assert.equal(resolved.canonical, model.id);
    assert.equal(resolved.provider, model.provider);
    assert.equal(resolved.modelId, model.modelId);
  }
});

test('xiaomi alias maps to the local token-plan provider, deterministically', () => {
  assert.equal(resolveModel('xiaomi/mimo-v2.6-pro').canonical, 'xiaomi-token-plan-sgp/mimo-v2.6-pro');
});

test('fuzzy names, bare ids, other providers and old generations are rejected', () => {
  for (const bad of ['sonnet', 'MiniMax-M3.1-Flash', 'anthropic/claude-sonnet-5', 'minimax/MiniMax-M3', 'zai/glm-5.2', 'xiaomi/mimo-v2.5-pro', '']) {
    assert.throws(() => resolveModel(bad), /not eligible/, bad);
  }
});

test('supported thinking levels are accepted per model', () => {
  assert.equal(assertThinking(resolveModel('minimax/MiniMax-M3.1-Flash'), 'max'), 'max');
  assert.equal(assertThinking(resolveModel('zai/glm-5.3'), 'low'), 'low');
  assert.equal(assertThinking(resolveModel('xiaomi/mimo-v2.6-flash'), 'off'), 'off');
});

test('unsupported thinking levels are rejected, never clamped', () => {
  assert.throws(() => assertThinking(resolveModel('xiaomi/mimo-v2.6-flash'), 'max'), /not supported/);
  assert.throws(() => assertThinking(resolveModel('zai/glm-5.3-flash'), 'medium'), /not supported/);
  assert.throws(() => assertThinking(resolveModel('zai/glm-5.3'), 'xhigh'), /not supported/);
});

test('GPT-6.1-SOL is eligible only as the reviewer model', async () => {
  const { ELIGIBLE_MODELS: models } = await import('../src/policy.ts');
  const reviewer = models.find((model) => model.id === 'openai-codex/gpt-6.1-sol');
  assert.ok(reviewer);
  assert.equal(reviewer.reviewOnly, true);
});
