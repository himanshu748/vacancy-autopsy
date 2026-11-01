import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { MongoServerError, type Collection } from 'mongodb';
import { createApp } from '../src/server/app.js';
import { createAuth0Verifier } from '../src/server/auth.js';
import { LocalStore } from '../src/server/store.js';
import { LocalApprovalStore, REVIEW_CONFIRMATION } from '../src/server/approvals.js';
import { buildPublicFinding, digestPublicFinding, LocalReleaseStore, MongoReleaseStore,
  releaseId, type ReleaseRecord, type WithdrawalRecord, type ReleaseStore } from '../src/server/releases.js';
import { PUBLIC_RELEASE_CONFIRMATION, PUBLIC_WITHDRAW_CONFIRMATION, sharedFindingSchema } from '../src/shared/public-report.js';
import type { Investigation } from '../src/shared/types.js';

const issuer = 'https://vacancy-test.auth0.com/', audience = 'https://vacancy-autopsy.example/api';
const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'sharing-key', alg: 'RS256', use: 'sig' };
const authenticator = createAuth0Verifier({ issuer, audience }, { keyResolver: createLocalJWKSet({ keys: [jwk] }) });
async function bearer(claims: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return 'Bearer ' + await new SignJWT({ iss: issuer, aud: audience, sub: 'auth0|synthetic-human', iat: now, exp: now + 600,
    permissions: ['review:reports'], ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'sharing-key' }).sign(keys.privateKey);
}
function fixture(): Investigation {
  const at = new Date().toISOString();
  const officialUrl = 'https://job-boards.greenhouse.io/example/jobs/123';
  const body = JSON.stringify({ jobs: [{ id: 123, title: 'Synthetic source engineer', absolute_url: officialUrl }], meta: { total: 1 } });
  return { id: randomUUID(), input: { url: officialUrl, advertisementText: 'PRIVATE_PASTED_INPUT' }, createdAt: at,
    checkedAt: at, verdict: 'verified_open', title: 'PRIVATE_REPORT_TITLE_IGNORED', employer: 'PRIVATE_EMPLOYER_IGNORED',
    ats: 'greenhouse', jobId: '123', officialUrl, explanation: 'PRIVATE_EXPLANATION', limitations: ['PRIVATE_LIMITATION'],
    evidence: [{ id: randomUUID(), kind: 'official_feed', url: 'https://boards-api.greenhouse.io/v1/boards/example/jobs', capturedAt: at,
      sha256: createHash('sha256').update(body).digest('hex'), body, httpStatus: 200, summary: 'PRIVATE_SUMMARY' }],
    timeline: [], mode: 'live', publication: 'private' };
}
async function harness(options: { enabled?: boolean; releases?: ReleaseStore; getReport?: () => Investigation; now?: () => Date } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-sharing-'));
  const reports = new LocalStore(join(directory, 'reports'));
  const report = fixture(); await reports.put(report);
  const approvals = new LocalApprovalStore(join(directory, 'approvals'));
  const releases = options.releases ?? new LocalReleaseStore(join(directory, 'shared'));
  const app = await createApp({ store: options.getReport ? { ...reports, kind: 'local', put: reports.put.bind(reports), list: reports.list.bind(reports),
    get: async () => options.getReport!(), close: reports.close.bind(reports) } : reports,
    rateLimit: 1000, publicOrigin: 'https://vacancy.example',
    reviewer: { issuer, audience, clientId: 'synthetic-spa', authenticator, approvals },
    sharing: options.enabled === false ? undefined : { releases, now: options.now } });
  const headers = { host: 'vacancy.example', authorization: await bearer() };
  const base = `/api/investigations/${report.id}`;
  const preview = async () => app.inject({ method: 'GET', url: `${base}/share-preview`, headers });
  const approve = async (reportDigest: string) => app.inject({ method: 'POST', url: `${base}/approvals`, headers,
    payload: { reportDigest, confirmation: REVIEW_CONFIRMATION } });
  const publish = async (snapshot: { reportDigest: string; previewDigest: string }, extra = {}) => app.inject({ method: 'POST', url: `${base}/share`, headers,
    payload: { reportDigest: snapshot.reportDigest, previewDigest: snapshot.previewDigest, confirmation: PUBLIC_RELEASE_CONFIRMATION, ...extra } });
  return { app, report, reports, releases, directory, headers, base, preview, approve, publish,
    close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('Public projection replays source bytes without network, ignores all private/free-form copy, and keeps source-only scope', async () => {
  const report = fixture();
  const finding = await buildPublicFinding(report, new Date());
  assert.equal(finding.title, 'Synthetic source engineer');
  assert.equal(finding.verdict, 'verified_open');
  assert.equal(finding.scope, 'official_source_only');
  assert.equal(JSON.stringify(finding).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(finding).includes('body'), false);
  const adReport = { ...report, input: { url: 'https://example.com/advertisement?secret=private', officialUrl: report.officialUrl },
    verdict: 'inconclusive' as const, sourceObservation: { verdict: 'verified_open' as const, checkedAt: report.checkedAt, explanation: 'PRIVATE_LINKAGE' } };
  const sourceOnly = await buildPublicFinding(adReport, new Date());
  assert.equal(sourceOnly.verdict, 'verified_open');
  assert.equal(sourceOnly.officialUrl, report.officialUrl);
  assert.equal(JSON.stringify(sourceOnly).includes('example.com'), false);
  assert.match(sourceOnly.limitations.join(' '), /linkage.*not independently established/);
});

test('Sharing is off by default even for anonymous valid-looking IDs; private routes remain protected', async () => {
  const h = await harness({ enabled: false });
  try {
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/shared-reports/${'a'.repeat(64)}`, headers: { host: h.headers.host } })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: `${h.base}/share-preview`, headers: h.headers })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: `${h.base}/report`, headers: { host: h.headers.host } })).statusCode, 401);
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/reviewer-config', headers: { host: h.headers.host } })).json().sharingEnabled, false);
  } finally { await h.close(); }
});

test('Generated JWT human approval + exact preview publish an allowlisted snapshot, persist restart, withdraw and never reactivate', async () => {
  const h = await harness();
  try {
    const previewResponse = await h.preview(); assert.equal(previewResponse.statusCode, 200);
    const preview = previewResponse.json();
    assert.equal((await h.publish(preview)).statusCode, 409);
    assert.equal((await h.approve(preview.reportDigest)).statusCode, 200);
    const published = await h.publish(preview); assert.equal(published.statusCode, 200);
    const id = published.json().release.id;
    assert.equal(id, releaseId(preview.reportDigest, preview.previewDigest));
    const retry = await h.publish(preview); assert.deepEqual(retry.json(), published.json());
    const publicResponse = await h.app.inject({ method: 'GET', url: `/api/shared-reports/${id}`, headers: { host: h.headers.host } });
    assert.equal(publicResponse.statusCode, 200); assert.equal(publicResponse.headers['cache-control'], 'no-store');
    const shared = sharedFindingSchema.parse(publicResponse.json());
    assert.deepEqual(shared.finding, preview.finding);
    for (const privateValue of ['PRIVATE_', 'reportDigest', 'previewDigest', 'approvalId', 'reviewerHash', 'advertisementText', 'timeline', 'body']) assert.equal(publicResponse.body.includes(privateValue), false);
    const reopened = new LocalReleaseStore(join(h.directory, 'shared'));
    assert.deepEqual((await reopened.get(id))?.record.finding, preview.finding);
    const denied = await h.app.inject({ method: 'POST', url: `/api/shared-reports/${id}/withdraw`, headers: { host: h.headers.host }, payload: { confirmation: PUBLIC_WITHDRAW_CONFIRMATION } });
    assert.equal(denied.statusCode, 401);
    const withdrawn = await h.app.inject({ method: 'POST', url: `/api/shared-reports/${id}/withdraw`, headers: h.headers, payload: { confirmation: PUBLIC_WITHDRAW_CONFIRMATION } });
    assert.equal(withdrawn.statusCode, 200); assert.ok(withdrawn.json().release.withdrawnAt);
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/shared-reports/${id}`, headers: { host: h.headers.host } })).statusCode, 404);
    assert.equal((await h.publish(preview)).statusCode, 409);
    assert.ok((await new LocalReleaseStore(join(h.directory, 'shared')).get(id))?.withdrawal);
    assert.equal((await h.reports.get(h.report.id))?.publication, 'private');
  } finally { await h.close(); }
});

test('Machine, missing permission, forged or missing credentials cannot preview, release or withdraw', async () => {
  const h = await harness();
  try {
    for (const [authorization, expected] of [[undefined, 401], [await bearer({ sub: 'machine@clients' }), 403],
      [await bearer({ permissions: [] }), 403], ['Bearer broken', 401], [await bearer({ gty: 'client-credentials' }), 403]] as const) {
      for (const [method, url] of [['GET', `${h.base}/share-preview`], ['POST', `${h.base}/share`], ['POST', `/api/shared-reports/${'a'.repeat(64)}/withdraw`]] as const) {
        const response = await h.app.inject({ method, url, headers: { host: h.headers.host, ...(authorization ? { authorization } : {}) }, ...(method === 'POST' ? { payload: {} } : {}) });
        assert.equal(response.statusCode, expected);
      }
    }
  } finally { await h.close(); }
});

test('Changed source/preview, stale/corrupt/mismatched evidence and absent final confirmation cannot be shared', async () => {
  const h = await harness();
  try {
    const preview = (await h.preview()).json(); await h.approve(preview.reportDigest);
    assert.equal((await h.publish({ ...preview, previewDigest: '0'.repeat(64) })).statusCode, 409);
    assert.equal((await h.publish({ ...preview, reportDigest: '0'.repeat(64) })).statusCode, 409);
    assert.equal((await h.publish(preview, { confirmation: undefined })).statusCode, 400);
    const report = h.report, now = new Date();
    const stale = new Date(now.getTime() - 25 * 3600_000).toISOString();
    const future = new Date(now.getTime() + 10 * 60_000).toISOString();
    for (const changed of [ { ...report, checkedAt: stale }, { ...report, checkedAt: future }, { ...report, mode: 'illustrative' as const },
      { ...report, evidence: [] }, { ...report, verdict: 'not_listed' as const },
      { ...report, evidence: [{ ...report.evidence[0], capturedAt: stale }] },
      { ...report, evidence: [{ ...report.evidence[0], body: 'corrupt bytes' }] },
      { ...report, evidence: [{ ...report.evidence[0], url: 'https://private.example/?token=secret' }] } ]) {
      await assert.rejects(buildPublicFinding(changed, now));
    }
  } finally { await h.close(); }
});

test('Release writes that cannot be acknowledged fail closed, with safe status reconciliation after uncertain persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-release-uncertain-'));
  const actual = new LocalReleaseStore(directory);
  const releases: ReleaseStore = { get: actual.get.bind(actual), withdraw: actual.withdraw.bind(actual), close: actual.close.bind(actual),
    putIfAbsent: async (record) => { await actual.putIfAbsent(record); throw new Error('PRIVATE_DATABASE_CREDENTIAL'); } };
  const h = await harness({ releases });
  try {
    const preview = (await h.preview()).json(); await h.approve(preview.reportDigest);
    const response = await h.publish(preview);
    assert.equal(response.statusCode, 503); assert.equal(response.body.includes('PRIVATE_DATABASE_CREDENTIAL'), false);
    const reconciled = (await h.preview()).json(); assert.ok(reconciled.release.id);
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/shared-reports/${reconciled.release.id}`, headers: { host: h.headers.host } })).statusCode, 200);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});

class MemoryCollection<T extends { id: string }> {
  values = new Map<string, T>(); acknowledged = true;
  async insertOne(value: T) {
    if (this.values.has(value.id)) throw new MongoServerError({ message: 'duplicate', code: 11000 });
    this.values.set(value.id, structuredClone(value)); return { acknowledged: this.acknowledged };
  }
  async findOne(query: { id: string }) { return structuredClone(this.values.get(query.id) ?? null); }
}
test('Mongo release adapter validates, acknowledges, restores, rejects duplicates and retains withdrawal across instances', async () => {
  const records = new MemoryCollection<ReleaseRecord>(), withdrawals = new MemoryCollection<WithdrawalRecord>();
  const store = () => new MongoReleaseStore(records as unknown as Collection<ReleaseRecord>, withdrawals as unknown as Collection<WithdrawalRecord>);
  const h = await harness({ releases: store() });
  try {
    const preview = (await h.preview()).json(); await h.approve(preview.reportDigest);
    const response = await h.publish(preview); assert.equal(response.statusCode, 200);
    const id = response.json().release.id;
    assert.deepEqual(await store().get(id), await store().get(id));
    assert.equal((await h.publish(preview)).statusCode, 200); assert.equal(records.values.size, 1);
    const withdrawal = { id, withdrawnAt: new Date().toISOString(), reviewerHash: 'a'.repeat(64) };
    assert.ok((await store().withdraw(withdrawal))?.withdrawal);
    assert.ok((await store().get(id))?.withdrawal); assert.equal((await h.publish(preview)).statusCode, 409);
    const record = records.values.get(id)!;
    records.values.set(id, { ...record, finding: { ...record.finding, statement: 'tampered' } });
    await assert.rejects(store().get(id));
    records.values.set(id, record); withdrawals.values.clear();
    withdrawals.acknowledged = false;
    await assert.rejects(store().withdraw(withdrawal));
  } finally { await h.close(); }
});

test('Local corrupt release bytes fail closed instead of exposing private or tampered content', async () => {
  const h = await harness();
  try {
    const preview = (await h.preview()).json(); await h.approve(preview.reportDigest);
    const id = (await h.publish(preview)).json().release.id;
    const filename = join(h.directory, 'shared', `${id}.json`);
    const record = JSON.parse(await readFile(filename, 'utf8'));
    await writeFile(filename, JSON.stringify({ ...record, finding: { ...record.finding, title: 'PRIVATE_TAMPER' } }));
    const response = await h.app.inject({ method: 'GET', url: `/api/shared-reports/${id}`, headers: { host: h.headers.host } });
    assert.equal(response.statusCode, 503); assert.equal(response.body.includes('PRIVATE_TAMPER'), false);
  } finally { await h.close(); }
});


test('Changed report bytes after preview and stale approval cannot authorize the old public snapshot', async () => {
  const h = await harness();
  try {
    const preview = (await h.preview()).json(); await h.approve(preview.reportDigest);
    const reportPath = join(h.directory, 'reports', `${h.report.id}.json`);
    await writeFile(reportPath, JSON.stringify({ ...h.report, explanation: 'Changed after review' }));
    assert.equal((await h.publish(preview)).statusCode, 409);
    await writeFile(reportPath, JSON.stringify(h.report));
    const files = await readdir(join(h.directory, 'approvals'));
    const filename = join(h.directory, 'approvals', files[0]);
    const approval = JSON.parse(await readFile(filename, 'utf8'));
    await writeFile(filename, JSON.stringify({ ...approval, approvedAt: new Date(Date.now() - 25 * 3600_000).toISOString() }));
    assert.equal((await h.publish(preview)).statusCode, 409);
    assert.equal((await h.preview()).json().release, null);
  } finally { await h.close(); }
});

test('Anonymous release route is exact and budgeted; mutations, encoded paths and listing need authentication', async () => {
  const h = await harness();
  try {
    const anonymous = { host: h.headers.host };
    for (const url of ['/api/shared-reports', `/api/shared-reports/${'a'.repeat(64)}/withdraw`, `/api/shared-reports/%61${'a'.repeat(63)}`, '/api/shared-reports/not-a-release', `${h.base}/share-preview`]) {
      assert.equal((await h.app.inject({ method: 'GET', url, headers: anonymous })).statusCode, 401);
    }
    for (let index = 0; index < 60; index++) assert.equal((await h.app.inject({ method: 'GET', url: `/api/shared-reports/${'b'.repeat(64)}`, headers: anonymous })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/shared-reports/${'b'.repeat(64)}`, headers: anonymous })).statusCode, 429);
  } finally { await h.close(); }
});

test('A previously shared snapshot remains withdrawable after its publication freshness window expires', async () => {
  let now = new Date();
  const h = await harness({ now: () => now });
  try {
    const preview = (await h.preview()).json(); await h.approve(preview.reportDigest);
    const published = await h.publish(preview); assert.equal(published.statusCode, 200);
    now = new Date(now.getTime() + 25 * 3600_000);
    const historical = await h.preview(); assert.equal(historical.statusCode, 200);
    assert.equal(historical.json().publishable, false);
    const id = historical.json().release.id;
    assert.equal(id, published.json().release.id);
    assert.equal((await h.publish(preview)).statusCode, 409);
    const withdrawal = await h.app.inject({ method: 'POST', url: `/api/shared-reports/${id}/withdraw`, headers: h.headers,
      payload: { confirmation: PUBLIC_WITHDRAW_CONFIRMATION } });
    assert.equal(withdrawal.statusCode, 200);
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/shared-reports/${id}`, headers: { host: h.headers.host } })).statusCode, 404);
  } finally { await h.close(); }
});

test('Sharing preserves the verifier full Lever bound: exact-posting miss plus ten complete board pages', async () => {
  const report = fixture();
  const jobId = randomUUID(), officialUrl = `https://jobs.lever.co/example/${jobId}`;
  const evidence = Array.from({ length: 11 }, (_, index) => {
    const body = index === 0 ? '{}' : JSON.stringify(Array.from({ length: index === 10 ? 0 : 100 }, () => {
      const id = randomUUID(); return { id, text: 'Synthetic other opening', hostedUrl: `https://jobs.lever.co/example/${id}` };
    }));
    return { id: randomUUID(), kind: 'official_feed' as const,
      url: index === 0 ? `https://api.lever.co/v0/postings/example/${jobId}?mode=json`
        : `https://api.lever.co/v0/postings/example?mode=json&limit=100&skip=${(index - 1) * 100}`,
      capturedAt: report.checkedAt, sha256: createHash('sha256').update(body).digest('hex'), body,
      httpStatus: index === 0 ? 404 : 200, summary: 'Synthetic bounded page' };
  });
  const finding = await buildPublicFinding({ ...report, ats: 'lever', jobId, officialUrl, input: { url: officialUrl },
    verdict: 'not_listed', evidence }, new Date());
  assert.equal(finding.verdict, 'not_listed');
  assert.equal(finding.sources.length, 11);
});
