import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/server/app.js';
import { LocalStore } from '../src/server/store.js';
import { createAuth0Verifier } from '../src/server/auth.js';
import { LocalApprovalStore } from '../src/server/approvals.js';

test('Hosted workspace refuses startup without complete authentication configuration', async () => {
  const store = new LocalStore('/unused/fixture-path');
  await assert.rejects(createApp({ store, publicOrigin: 'https://desk.example.com' }), /complete reviewer/);
  await assert.rejects(createApp({ store, publicOrigin: 'http://desk.example.com' }));
});

test('Hosted workspace protects every investigation, source artifact and review route with actual signed reviewer tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-hosted-'));
  const pair = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'fixture-review-key', alg: 'RS256', use: 'sig' };
  const issuer = 'https://review.example.com/';
  const token = (permissions: string[], subject = 'auth0|fixture-human') => new SignJWT({ permissions }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer).setAudience('vacancy-autopsy-fixture').setSubject(subject)
    .setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const app = await createApp({ store: new LocalStore(directory), publicOrigin: 'https://desk.example.com', rateLimit: 6,
    reviewer: { issuer, audience: 'vacancy-autopsy-fixture', clientId: 'fixture-public-client',
      authenticator: createAuth0Verifier({ issuer, audience: 'vacancy-autopsy-fixture' }, { keyResolver: createLocalJWKSet({ keys: [jwk] }) }),
      approvals: new LocalApprovalStore(join(directory, 'approvals')) },
    fetcher: async () => new Response(JSON.stringify({ jobs: [{ id: 123, title: 'Intern', absolute_url: 'https://boards.greenhouse.io/example/jobs/123' }], meta: { total: 1 } }),
      { headers: { 'content-type': 'application/json' } }),
  });
  const host = { host: 'desk.example.com' };
  try {
    for (const url of ['/api/investigations', '/api/workspace', '/api/investigations/00000000-0000-4000-8000-000000000000/report',
      '/api/research/00000000-0000-4000-8000-000000000000/report', '/%61pi/investigations']) {
      assert.equal((await app.inject({ url, headers: host })).statusCode, 401, url);
    }
    for (const url of ['/api/discovery', '/api/captures', '/api/investigations', '/api/extract', '/api/priority']) {
      assert.equal((await app.inject({ method: 'POST', url, headers: host, payload: {} })).statusCode, 401, url);
    }
    assert.equal((await app.inject({ url: '/api/health', headers: host })).statusCode, 200);
    for (let i = 0; i < 10; i++) assert.equal((await app.inject({ url: '/api/health', headers: host })).statusCode, 200);
    const config = await app.inject({ url: '/api/reviewer-config', headers: host });
    assert.equal(config.json().requiresAuthentication, true);
    assert.ok(String(config.headers['content-security-policy']).includes('connect-src \'self\' https://review.example.com'));
    const denied = { ...host, authorization: `Bearer ${await token([])}` };
    assert.equal((await app.inject({ url: '/api/workspace', headers: denied })).statusCode, 403);
    const allowed = { ...host, authorization: `Bearer ${await token(['review:reports'])}`, origin: 'https://desk.example.com' };
    assert.equal((await app.inject({ url: '/api/workspace', headers: allowed })).statusCode, 200);
    const created = await app.inject({ method: 'POST', url: '/api/investigations', headers: allowed,
      payload: { url: 'https://boards.greenhouse.io/example/jobs/123' } });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;
    assert.equal((await app.inject({ url: `/api/investigations/${id}/report`, headers: host })).statusCode, 401);
    assert.equal((await app.inject({ url: `/api/investigations/${id}/report`, headers: allowed })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/investigations', headers: { ...allowed, origin: 'https://foreign.example.com' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/investigations', headers: { ...allowed, host: 'foreign.example.com' } })).statusCode, 403);
    for (let i = 0; i < 3; i++) assert.equal((await app.inject({ url: '/api/investigations', headers: allowed })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/investigations', headers: allowed })).statusCode, 429);
    assert.equal((await app.inject({ url: '/api/investigations', headers: { ...allowed,
      authorization: `Bearer ${await token(['review:reports'], 'auth0|another-fixture-human')}` } })).statusCode, 200);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
