import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createActivities } from '../src/temporal/activities.js';
import { LocalStore } from '../src/server/store.js';
import type { Fetcher } from '../src/server/ats.js';

const input = { url: 'https://job-boards.greenhouse.io/example/jobs/123' };
function fixture(onFetch: () => void): Fetcher {
  return (async () => {
    onFetch();
    return new Response(JSON.stringify({ jobs: [{ id: 123, title: 'Synthetic Example Engineer', absolute_url: input.url }], meta: { total: 1 } }), { headers: { 'content-type': 'application/json' } });
  }) as Fetcher;
}

test('A durable retry reuses the immutable saved report without another source fetch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-temporal-'));
  const store = new LocalStore(directory);
  let fetches = 0;
  const request = { operationId: randomUUID(), input };
  try {
    const interrupted = createActivities({ store, fetcher: fixture(() => fetches++), afterPersist: async () => { throw new Error('synthetic crash after save'); } });
    await assert.rejects(interrupted.investigateAndSave(request), /could not read or save/);
    const first = await store.get(request.operationId);
    assert.ok(first);
    const recovered = createActivities({ store, fetcher: fixture(() => fetches++) });
    const result = await recovered.investigateAndSave(request);
    assert.equal(result.reportId, request.operationId);
    assert.equal(result.reused, true);
    assert.equal(fetches, 1);
    assert.deepEqual(await store.get(request.operationId), first);
    assert.equal((await store.list()).length, 1);
    assert.ok(!('body' in result));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Reusing a durable operation ID for different input fails without a source request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-conflict-'));
  const store = new LocalStore(directory);
  let fetches = 0;
  const request = { operationId: randomUUID(), input };
  try {
    const activities = createActivities({ store, fetcher: fixture(() => fetches++) });
    await activities.investigateAndSave(request);
    await assert.rejects(activities.investigateAndSave({ ...request, input: { url: input.url.replace('123', '124') } }), /already bound/);
    assert.equal(fetches, 1);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Activity errors do not put raw database credentials in Temporal history', async () => {
  const store = { kind: 'local' as const, get: async () => { throw new Error('mongodb://secret-user:secret-password@example'); }, put: async () => {}, list: async () => [], close: async () => {} };
  await assert.rejects(createActivities({ store }).investigateAndSave({ operationId: randomUUID(), input }), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /secret-user|secret-password/);
    assert.equal(error.cause, undefined);
    return true;
  });
});
