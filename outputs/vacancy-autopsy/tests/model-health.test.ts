import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import type { InvestigationStore } from '../src/server/store.js';
import type { Health } from '../src/shared/types.js';

// Synthetic runners test runtime bookkeeping, not provider availability.
const store: InvestigationStore = {
  kind: 'local', put: async () => {}, get: async () => null,
  list: async () => [], close: async () => {},
};
const headers = { host: '127.0.0.1:8787' };
const listing = {
  url: 'https://job-boards.greenhouse.io/example/jobs/123',
  advertisementText: 'Example Software Engineer. Greenhouse posting 123.',
};
const entries = [
  { id: 'one', url: listing.url },
  { id: 'two', url: 'https://public-board.example/role' },
];

test('Model health requires a validated completed response and resets with the process', async () => {
  let valid = false;
  const options = {
    store,
    rateLimit: 100,
    extraction: {
      artifactPath: '/synthetic/training.json', pythonPath: 'python3',
      apiKey: 'synthetic', projectId: 'synthetic',
      runner: async () => valid
        ? { employer: 'Example', title: 'Software Engineer', job_id: '123', ats: 'greenhouse' }
        : { verdict: 'verified_open' },
    },
    priority: {
      contextPath: '/synthetic/context.json', pythonPath: 'python3', token: 'synthetic',
      runner: async () => valid
        ? { ranked: [{ id: 'one', rank: 1, priority: 0.8 }, { id: 'two', rank: 2, priority: 0.2 }] }
        : { ranked: [{ id: 'unknown', rank: 1, priority: 0.8 }] },
    },
  };
  const app = await createApp(options);
  async function modelStates() {
    const response = await app.inject({ method: 'GET', url: '/api/health', headers });
    return (response.json() as Health).sponsors
      .filter(({ name }) => ['Tinker', 'TabPFN'].includes(name))
      .map(({ status }) => status);
  }
  try {
    assert.deepEqual(await modelStates(), ['configured_unverified', 'configured_unverified']);
    assert.equal((await app.inject({ method: 'POST', url: '/api/extract', headers, payload: listing })).statusCode, 502);
    assert.equal((await app.inject({ method: 'POST', url: '/api/priority', headers, payload: { entries } })).statusCode, 502);
    assert.deepEqual(await modelStates(), ['configured_unverified', 'configured_unverified']);
    valid = true;
    assert.equal((await app.inject({ method: 'POST', url: '/api/extract', headers, payload: listing })).statusCode, 200);
    assert.deepEqual(await modelStates(), ['runtime_verified', 'configured_unverified']);
    assert.equal((await app.inject({ method: 'POST', url: '/api/priority', headers, payload: { entries } })).statusCode, 200);
    assert.deepEqual(await modelStates(), ['runtime_verified', 'runtime_verified']);
    // A historical success remains an observation, not a promise of current uptime.
    valid = false;
    assert.equal((await app.inject({ method: 'POST', url: '/api/extract', headers, payload: listing })).statusCode, 502);
    assert.deepEqual(await modelStates(), ['runtime_verified', 'runtime_verified']);
  } finally { await app.close(); }
  const restarted = await createApp(options);
  try {
    const health = (await restarted.inject({ method: 'GET', url: '/api/health', headers })).json() as Health;
    assert.deepEqual(health.sponsors.filter(({ name }) => ['Tinker', 'TabPFN'].includes(name)).map(({ status }) => status),
      ['configured_unverified', 'configured_unverified']);
  } finally { await restarted.close(); }
});

test('A failing runtime observer cannot invalidate a validated model response', async () => {
  const observer = () => { throw new Error('Synthetic observer failure'); };
  const app = await createApp({ store, extraction: {
    artifactPath: '/synthetic/training.json', pythonPath: 'python3',
    apiKey: 'synthetic', projectId: 'synthetic', onVerified: observer,
    runner: async () => ({ employer: 'Example', title: 'Software Engineer', job_id: '123', ats: 'greenhouse' }),
  }, priority: {
    contextPath: '/synthetic/context.json', pythonPath: 'python3', token: 'synthetic', onVerified: observer,
    runner: async () => ({ ranked: [{ id: 'one', rank: 1, priority: 0.8 }, { id: 'two', rank: 2, priority: 0.2 }] }),
  } });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/extract', headers, payload: listing })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/priority', headers, payload: { entries } })).statusCode, 200);
    const health = (await app.inject({ method: 'GET', url: '/api/health', headers })).json() as Health;
    assert.deepEqual(health.sponsors.filter(({ name }) => ['Tinker', 'TabPFN'].includes(name)).map(({ status }) => status),
      ['runtime_verified', 'runtime_verified']);
  } finally { await app.close(); }
});
