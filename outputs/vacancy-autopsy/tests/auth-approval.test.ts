import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createApp } from '../src/server/app.js';
import { createAuth0Verifier, ReviewAuthorizationError } from '../src/server/auth.js';
import { digestReport, LocalApprovalStore, registerApprovalRoutes, REVIEW_CONFIRMATION } from '../src/server/approvals.js';
import { LocalStore } from '../src/server/store.js';
import type { Investigation } from '../src/shared/types.js';

// Generated keys and synthetic reports prove authorization logic, not a live
// Auth0 tenant, human identity, or a completed public-release workflow.
const issuer = 'https://vacancy-test.auth0.com/';
const audience = 'https://vacancy-autopsy.example/api';
const keys = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(keys.publicKey), kid: 'reviewer-key', alg: 'RS256', use: 'sig' };
const resolver = createLocalJWKSet({ keys: [publicJwk] });
const verifier = createAuth0Verifier({ issuer, audience }, { keyResolver: resolver });
async function token(overrides: JWTPayload = {}, key = keys.privateKey, kid = 'reviewer-key') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: audience, sub: 'auth0|human-reviewer', iat: now,
    exp: now + 600, permissions: ['review:reports'], ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid }).sign(key);
}
async function denied(value: string | undefined, status: number) {
  await assert.rejects(verifier.verify(value), (error: unknown) => error instanceof ReviewAuthorizationError && error.statusCode === status);
}
function reportFixture(): Investigation {
  const at = new Date().toISOString();
  const body = JSON.stringify({ jobs: [{ id: 123, title: 'Synthetic Engineer' }] });
  return { id: randomUUID(), input: { url: 'https://job-boards.greenhouse.io/example/jobs/123' },
    createdAt: at, checkedAt: at, verdict: 'verified_open', title: 'Synthetic Engineer', employer: 'example',
    jobId: '123', ats: 'greenhouse', officialUrl: 'https://job-boards.greenhouse.io/example/jobs/123',
    explanation: 'Synthetic authorization test report.', limitations: ['Fixture only.'],
    evidence: [{ id: randomUUID(), kind: 'official_feed', url: 'https://boards-api.greenhouse.io/v1/boards/example/jobs',
      capturedAt: at, sha256: createHash('sha256').update(body).digest('hex'), body, summary: 'Synthetic source.', httpStatus: 200 }],
    timeline: [], mode: 'live', publication: 'private' };
}

test('Auth0 verifier validates generated RS256/JWKS signatures and minimizes persisted identity', async () => {
  const principal = await verifier.verify(`Bearer ${await token()}`);
  assert.equal(principal.permission, 'review:reports');
  assert.match(principal.subjectHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(principal).includes('human-reviewer'), false);
  assert.equal(JSON.stringify(principal).includes('Bearer'), false);
});

test('Auth0 verifier denies missing, malformed, expired, future, wrong-issuer and wrong-audience tokens', async () => {
  await denied(undefined, 401);
  await denied('Bearer not-a-token', 401);
  await denied(`Basic ${await token()}`, 401);
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { iss: 'https://different.auth0.com/' }, { aud: 'id-token-client-id' }, { exp: now - 10 },
    { iat: now + 60 }, { nbf: now + 60 }, { exp: undefined }, { iat: undefined }, { sub: undefined },
  ]) await denied(`Bearer ${await token(claims)}`, 401);
});

test('Auth0 verifier denies forged signatures, unmatched keys, and symmetric algorithms', async () => {
  const forged = await generateKeyPair('RS256');
  await denied(`Bearer ${await token({}, forged.privateKey)}`, 401);
  await denied(`Bearer ${await token({}, keys.privateKey, 'unknown-key')}`, 401);
  const symmetric = await new SignJWT({ iss: issuer, aud: audience, sub: 'auth0|human', exp: Math.floor(Date.now() / 1000) + 60 })
    .setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('synthetic-test-secret-at-least-thirty-two-bytes'));
  await denied(`Bearer ${symmetric}`, 401);
});

test('Reviewer permission is required and client-credentials identities cannot approve', async () => {
  for (const claims of [
    { permissions: [] }, { permissions: ['review:reports:other'] }, { permissions: undefined, scope: 'review:reports' },
    { permissions: ['review:reports', 1] }, { sub: 'machine@clients' }, { gty: 'client-credentials' },
  ]) await denied(`Bearer ${await token(claims)}`, 403);
  assert.throws(() => createAuth0Verifier({ issuer: 'http://vacancy-test.auth0.com/', audience }));
  assert.throws(() => createAuth0Verifier({ issuer: 'https://vacancy-test.auth0.com', audience }));
  assert.throws(() => createAuth0Verifier({ issuer, audience: '' }));
});

test('Report digest is order-independent and binds evidence, verdict, ID and limitations', () => {
  const report = reportFixture();
  const digest = digestReport(report);
  const reordered = Object.fromEntries(Object.entries(report).reverse()) as unknown as Investigation;
  assert.equal(digestReport(reordered), digest);
  for (const changed of [
    { ...report, id: randomUUID() }, { ...report, verdict: 'inconclusive' as const },
    { ...report, limitations: ['Changed limitation'] },
    { ...report, evidence: [{ ...report.evidence[0], body: 'Changed evidence body' }] },
  ]) assert.notEqual(digestReport(changed), digest);
});

test('Real local API gate records one immutable, digest-bound private approval and rejects changed evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-review-'));
  const reports = new LocalStore(join(directory, 'reports'));
  const approvals = new LocalApprovalStore(join(directory, 'approvals'));
  const report = reportFixture();
  await reports.put(report);
  const app = await createApp({ store: reports, rateLimit: 100 });
  await registerApprovalRoutes(app, { reports, approvals, authenticator: verifier });
  const headers = { host: '127.0.0.1:8787', authorization: `Bearer ${await token()}` };
  const base = `/api/investigations/${report.id}`;
  try {
    const unauthorized = await app.inject({ method: 'GET', url: `${base}/review`, headers: { host: headers.host } });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.headers['www-authenticate'], 'Bearer');
    const forbidden = await app.inject({ method: 'GET', url: `${base}/review`, headers: { ...headers, authorization: `Bearer ${await token({ permissions: [] })}` } });
    assert.equal(forbidden.statusCode, 403);
    const rebound = await app.inject({ method: 'GET', url: `${base}/review`, headers: { ...headers, host: 'attacker.example' } });
    assert.equal(rebound.statusCode, 403);
    const snapshot = await app.inject({ method: 'GET', url: `${base}/review`, headers });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().reportDigest, digestReport(report));
    assert.equal(snapshot.json().approval, null);
    const request = { method: 'POST' as const, url: `${base}/approvals`, headers,
      payload: { reportDigest: snapshot.json().reportDigest, confirmation: REVIEW_CONFIRMATION } };
    const absentConfirmation = await app.inject({ ...request, payload: { reportDigest: snapshot.json().reportDigest } });
    assert.equal(absentConfirmation.statusCode, 400);
    const staleDigest = await app.inject({ ...request, payload: { ...request.payload, reportDigest: '0'.repeat(64) } });
    assert.equal(staleDigest.statusCode, 409);
    const approved = await app.inject(request);
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().publication, 'private');
    const retry = await app.inject(request);
    assert.deepEqual(retry.json(), approved.json());
    assert.equal((await readdir(join(directory, 'approvals'))).length, 1);
    const storedFile = join(directory, 'approvals', `${approved.json().approval.id}.json`);
    assert.equal((await stat(storedFile)).mode & 0o777, 0o600);
    const stored = await readFile(storedFile, 'utf8');
    assert.equal(stored.includes(headers.authorization), false);
    assert.equal(stored.includes('human-reviewer'), false);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/review`, headers })).json().approval.id, approved.json().approval.id);
    const newReviewer = { ...headers, authorization: `Bearer ${await token({ sub: 'auth0|another-reviewer' })}` };
    assert.equal((await app.inject({ method: 'GET', url: `${base}/review`, headers: newReviewer })).json().approval, null);
    assert.equal((await reports.get(report.id))?.publication, 'private');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('A report changed after review cannot be approved with its former digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-review-change-'));
  const store = new LocalStore(join(directory, 'reports'));
  const approvals = new LocalApprovalStore(join(directory, 'approvals'));
  let report = reportFixture();
  const app = await createApp({ store, rateLimit: 100 });
  await registerApprovalRoutes(app, { reports: { get: async () => report }, approvals, authenticator: verifier });
  const headers = { host: '127.0.0.1:8787', authorization: `Bearer ${await token()}` };
  const oldDigest = digestReport(report);
  try {
    const initial = await app.inject({ method: 'POST', url: `/api/investigations/${report.id}/approvals`, headers,
      payload: { reportDigest: oldDigest, confirmation: REVIEW_CONFIRMATION } });
    assert.equal(initial.statusCode, 200);
    report = { ...report, explanation: 'Changed after the reviewer approved it.' };
    const changed = await app.inject({ method: 'GET', url: `/api/investigations/${report.id}/review`, headers });
    assert.equal(changed.json().approval, null);
    const response = await app.inject({ method: 'POST', url: `/api/investigations/${report.id}/approvals`, headers,
      payload: { reportDigest: oldDigest, confirmation: REVIEW_CONFIRMATION } });
    assert.equal(response.statusCode, 409);
    assert.equal((await readdir(join(directory, 'approvals'))).length, 1);
    report = { ...report, mode: 'illustrative' };
    const illustrative = await app.inject({ method: 'POST', url: `/api/investigations/${report.id}/approvals`, headers,
      payload: { reportDigest: digestReport(report), confirmation: REVIEW_CONFIRMATION } });
    assert.equal(illustrative.statusCode, 409);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Auth and approval-storage failures are closed and do not expose underlying credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-review-failure-'));
  const reports = new LocalStore(join(directory, 'reports'));
  const report = reportFixture();
  await reports.put(report);
  const app = await createApp({ store: reports, rateLimit: 100 });
  const safe = { get: async () => null, close: async () => undefined,
    putIfAbsent: async () => { throw new Error('mongodb://fixture-user:fixture-password@private.invalid'); } };
  await registerApprovalRoutes(app, { reports, approvals: safe, authenticator: verifier });
  const headers = { host: '127.0.0.1:8787', authorization: `Bearer ${await token()}` };
  try {
    const response = await app.inject({ method: 'POST', url: `/api/investigations/${report.id}/approvals`, headers,
      payload: { reportDigest: digestReport(report), confirmation: REVIEW_CONFIRMATION } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes('fixture-password'), false);
    assert.equal((await reports.get(report.id))?.publication, 'private');
    const unavailable = createAuth0Verifier({ issuer, audience }, { keyResolver: async () => { throw new TypeError('private network error'); } });
    await assert.rejects(unavailable.verify(headers.authorization), (error: unknown) => error instanceof ReviewAuthorizationError && error.statusCode === 503 && !error.message.includes('private network'));
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
