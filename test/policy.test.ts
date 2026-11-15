import assert from 'node:assert';
import { test } from 'node:test';
import { assertThinking, ELIGIBLE_MODELS, prohibitedToken, resolveModel, ROLES, validateRoles } from '../src/policy.ts';

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
  for (const bad of ['sonnet', 'anthropic/claude-sonnet-5', 'minimax/MiniMax-M3', 'zai/glm-5.2', 'xiaomi/mimo-v2.5-pro', '']) {
    assert.throws(() => resolveModel(bad), /not eligible/, bad);
  }
});

test('supported thinking levels are accepted per model', () => {
  assert.equal(assertThinking(resolveModel('kimi-coding/k3.1-pro'), 'max'), 'max');
  assert.equal(assertThinking(resolveModel('kimi-coding/kimi-for-coding'), 'high'), 'high');
  assert.equal(assertThinking(resolveModel('zai/glm-5.3'), 'low'), 'low');
  assert.equal(assertThinking(resolveModel('xiaomi/mimo-v2.6-pro'), 'off'), 'off');
});

test('unsupported thinking levels are rejected, never clamped', () => {
  assert.throws(() => assertThinking(resolveModel('kimi-coding/k3.1-pro'), 'low'), /not supported/);
  assert.throws(() => assertThinking(resolveModel('kimi-coding/kimi-for-coding'), 'medium'), /not supported/);
  assert.throws(() => assertThinking(resolveModel('zai/glm-5.3'), 'xhigh'), /not supported/);
});

test('allowlist is exactly the flash-first matrix', () => {
  assert.deepEqual(
    ELIGIBLE_MODELS.map((m) => m.id).sort(),
    [
      'kimi-coding/k3.1-pro',
      'kimi-coding/kimi-for-coding',
      'minimax/MiniMax-M3.1-Flash',
      'openai-codex/gpt-6.1-sol',
      'xiaomi-token-plan-sgp/mimo-v2.6-flash',
      'xiaomi-token-plan-sgp/mimo-v2.6-pro',
      'zai/glm-5.3',
      'zai/glm-5.3-flash',
    ].sort(),
  );
});

test('flash models resolve exactly and are never treated as prohibited', () => {
  assert.equal(resolveModel('minimax/MiniMax-M3.1-Flash').canonical, 'minimax/MiniMax-M3.1-Flash');
  assert.equal(resolveModel('xiaomi/mimo-v2.6-flash').canonical, 'xiaomi-token-plan-sgp/mimo-v2.6-flash');
  assert.equal(resolveModel('zai/glm-5.3-flash').canonical, 'zai/glm-5.3-flash');
  assert.equal(prohibitedToken('minimax/MiniMax-M3.1-Flash'), null);
});

test('prohibited speed-optimized variants are rejected by name, never substituted', () => {
  for (const bad of [
    'kimi-coding/k3.1-pro-highspeed',
    'kimi-coding/kimi-for-coding-highspeed',
    'minimax/MiniMax-M2.7-highspeed',
    'acme/some-model-turbo',
    'acme/some-model-lite',
    'acme/fast-model',
  ]) {
    assert.throws(() => resolveModel(bad), /prohibited/, bad);
  }
});

test('no eligible model carries a prohibited token', () => {
  for (const model of ELIGIBLE_MODELS) {
    assert.equal(prohibitedToken(model.id), null, model.id);
  }
});

test('kimi roles w8/w9 pin the verified subscription models with thinking on', () => {
  assert.equal(ROLES['w8-kimi-pro'].model, 'kimi-coding/k3.1-pro');
  assert.equal(ROLES['w9-kimi-dev'].model, 'kimi-coding/kimi-for-coding');
  assert.equal(ROLES['w8-kimi-pro'].thinking, 'high');
  assert.equal(ROLES['w9-kimi-dev'].thinking, 'high');
  assert.equal(ROLES['w8-kimi-pro'].disabled, undefined);
  assert.equal(ROLES['w9-kimi-dev'].disabled, undefined);
});

test('flash roles are enabled and pin the flash-first primaries', () => {
  assert.equal(ROLES['w1-scout'].model, 'xiaomi-token-plan-sgp/mimo-v2.6-flash');
  assert.equal(ROLES['w3-impl'].model, 'minimax/MiniMax-M3.1-Flash');
  assert.equal(ROLES['w4-audit'].model, 'minimax/MiniMax-M3.1-Flash');
  assert.equal(ROLES['w5-tests'].model, 'zai/glm-5.3-flash');
  for (const name of Object.keys(ROLES)) {
    assert.equal(ROLES[name].disabled, undefined, name);
    assert.equal(prohibitedToken(ROLES[name].model), null, name);
  }
});

test('every enabled role model resolves with its thinking level (no role/model mismatch)', () => {
  validateRoles();
  for (const [name, role] of Object.entries(ROLES)) {
    if (role.disabled) continue;
    const resolved = resolveModel(role.model);
    assert.equal(assertThinking(resolved, role.thinking), role.thinking, name);
  }
});

test('GPT-6.1-SOL is eligible only as the reviewer model', async () => {
  const { ELIGIBLE_MODELS: models } = await import('../src/policy.ts');
  const reviewer = models.find((model) => model.id === 'openai-codex/gpt-6.1-sol');
  assert.ok(reviewer);
  assert.equal(reviewer.reviewOnly, true);
});
