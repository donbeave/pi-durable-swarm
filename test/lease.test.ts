import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai';
import { acquireLease } from '../src/lease.ts';
import { openRuntime } from '../src/runtime.ts';

test('a live owner rejects a second lease; release frees it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-lease-'));
  const first = await acquireLease(dir);
  await assert.rejects(acquireLease(dir), /already owns the swarm store/);
  await first.release();
  const second = await acquireLease(dir);
  await second.release();
});

test('a lock left by a dead process is reclaimed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-lease-'));
  writeFileSync(join(dir, 'owner.lock'), JSON.stringify({ pid: 999_999, at: 0 }));
  const lease = await acquireLease(dir);
  await lease.release();
});

test('second runtime on one store is rejected; reopen after close works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-runtime-'));
  const models = createModels();
  const first = await openRuntime({ directory: dir, models });
  await assert.rejects(openRuntime({ directory: dir, models }), /already owns the swarm store/);
  await first.close();
  const reopened = await openRuntime({ directory: dir, models });
  await reopened.close();
});

test('spawn rejects an eligible model that the registry does not have, before creating state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-runtime-'));
  const runtime = await openRuntime({ directory: dir, models: createModels() });
  await assert.rejects(
    runtime.spawn({ requestId: 'test:1', name: 'x', task: 'say hi', role: 'w3-impl', cwd: dir }),
    /not available in the Pi model registry/,
  );
  const fleet = await runtime.snapshot();
  assert.equal(Object.keys(fleet?.agents ?? {}).length, 0);
  await runtime.close();
});
