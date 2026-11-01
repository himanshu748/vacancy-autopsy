import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { LocalStore } from '../src/server/store.js';
import { LocalArtifactStore } from '../src/server/research.js';

test('Unconfigured source tools fail clearly without creating findings or bypassing local access guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-source-routes-'));
  const app = await createApp({ store: new LocalStore(directory) });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/discovery', payload: { query: 'intern employer' } })).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/api/captures', payload: { url: 'https://jobs.ashbyhq.com/example/abc' } })).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/api/captures', payload: { url: 'https://127.0.0.1/' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/discovery', headers: { host: 'foreign.example' }, payload: { query: 'intern employer' } })).statusCode, 403);
    assert.deepEqual((await app.inject('/api/reviewer-config')).json(), { configured: false, requiresAuthentication: false, sharingEnabled: false });
    assert.deepEqual((await app.inject('/api/investigations')).json(), []);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Discovery entry point saves a credential-free artifact and its exact downloadable provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-source-artifact-'));
  const artifacts = new LocalArtifactStore(join(directory, 'sources'));
  let requests = 0;
  const app = await createApp({ store: new LocalStore(directory), research: { artifacts,
    discovery: { apiKey: 'synthetic-search-credential', fetcher: async () => {
      requests++;
      return new Response(JSON.stringify({ search_metadata: { status: 'Success', id: 'fixture-search' }, organic_results: [
        { title: 'Software Engineer Intern', link: 'https://boards.greenhouse.io/example/jobs/123?tracking=discarded', snippet: 'A discovery lead', position: 1 },
      ] }), { headers: { 'content-type': 'application/json' } });
    } } } });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/discovery', payload: { query: 'intern employer' } });
    assert.equal(response.statusCode, 201);
    assert.equal(requests, 1);
    const artifact = response.json();
    assert.equal(artifact.result.candidates[0].url, 'https://boards.greenhouse.io/example/jobs/123');
    const download = await app.inject(`/api/research/${artifact.id}/report`);
    assert.equal(download.statusCode, 200);
    assert.ok(download.headers['content-disposition']?.includes(artifact.id));
    assert.deepEqual(download.json(), artifact);
    assert.ok(!download.body.includes('synthetic-search-credential'));
    assert.equal(createHash('sha256').update(artifact.result.provenance.projectionBody).digest('hex'), artifact.result.provenance.projectionSha256);
    await assert.rejects(artifacts.put(artifact), /cannot be overwritten/);
    assert.deepEqual((await app.inject('/api/investigations')).json(), []);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
