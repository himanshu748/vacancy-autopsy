import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicUrlSchema } from '../src/server/schemas.js';
import { createApp } from '../src/server/app.js';
import { LocalStore } from '../src/server/store.js';

test('Public URL validation returns failures for malformed URLs without throwing', () => {
  for (const value of ['', 'not-a-url', 'https://', '//example.com/jobs/123', '/jobs/123',
    'http://example.com/jobs/123', 'https://localhost/jobs/123', 'https://127.0.0.1/jobs/123',
    'https://[::1]/jobs/123', 'https://user:password@example.com/jobs/123']) {
    assert.doesNotThrow(() => assert.equal(publicUrlSchema.safeParse(value).success, false), value);
  }
  assert.equal(publicUrlSchema.safeParse('https://example.com/jobs/123').success, true);
});

test('Malformed URLs produce API validation errors before investigation or provider execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-malformed-url-'));
  let investigations = 0;
  const app = await createApp({ store: new LocalStore(directory), executeInvestigation: async () => {
    investigations++;
    throw new Error('Malformed input must not reach investigation execution');
  } });
  try {
    for (const [url, payload] of [
      ['/api/investigations', { url: 'not-a-url' }],
      ['/api/captures', { url: 'https://' }],
      ['/api/extract', { url: '/jobs/123', advertisementText: 'Public listing text' }],
      ['/api/priority', { entries: [{ id: 'one', url: 'not-a-url' }, { id: 'two', url: 'https://example.com/jobs/123' }] }],
    ] as const) {
      const result = await app.inject({ method: 'POST', url, payload });
      assert.equal(result.statusCode, 400, url);
      assert.ok(!result.body.includes('Invalid URL'), url);
    }
    assert.equal(investigations, 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
