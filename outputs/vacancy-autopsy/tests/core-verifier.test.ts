import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseIdentity, identify, sanitizeInput } from '../src/server/identity.js';
import { hashBody, verifyFeed, type Fetcher } from '../src/server/ats.js';
import { LocalStore } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { runInvestigation } from '../src/server/workflow.js';

// Synthetic contract fixtures exercise failure behavior, never model accuracy.
const url = 'https://job-boards.greenhouse.io/example/jobs/123';
const identity = parseIdentity(url)!;
const leverId = '12345678-1234-4321-8123-123456789012';
const leverUrl = `https://jobs.lever.co/example/${leverId}`;
const ashbyUrl = `https://jobs.ashbyhq.com/Example/${leverId}`;
function fixture(data: unknown, status = 200): Fetcher {
  return (async () => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  })) as Fetcher;
}
const openFeed = { jobs: [{ id: 123, title: 'Example Engineer', absolute_url: url }], meta: { total: 1 } };

test('Only exact supported ATS URL hosts and posting paths resolve', () => {
  assert.equal(parseIdentity(url)?.jobId, '123');
  assert.equal(parseIdentity(`${url}/extra`), null);
  assert.equal(parseIdentity('https://job-boards.greenhouse.io.attacker.com/example/jobs/123'), null);
  assert.equal(parseIdentity('https://job-boards.greenhouse.io:8443/example/jobs/123'), null);
  assert.equal(parseIdentity('http://job-boards.greenhouse.io/example/jobs/123'), null);
  assert.equal(parseIdentity('https://user:password@job-boards.greenhouse.io/example/jobs/123'), null);
  assert.equal(parseIdentity(leverUrl + '/apply')?.ats, 'lever');
  assert.equal(parseIdentity(ashbyUrl + '/application')?.ats, 'ashby');
});

test('Unrelated advertisements cannot inherit a supplied open posting verdict', () => {
  assert.equal(identify({ url: 'https://example.com/jobs/old', officialUrl: url }).linkageVerified, false);
  assert.equal(identify({ url, officialUrl: url.replace('123', '124') }).identity, null);
  assert.equal(identify({ url: 'https://example.com/jobs/old', officialUrl: url, advertisementText: url }).linkageVerified, false);
  assert.equal(sanitizeInput({ url: `${url}?token=secret#private` }).url, url);
});

test('Exact posting IDs support an open verdict; title similarity does not', async () => {
  const result = await verifyFeed(identity, { fetcher: fixture(openFeed) });
  assert.equal(result.verdict, 'verified_open');
  assert.equal(result.title, 'Example Engineer');
  assert.equal(result.evidence[0].sha256, hashBody(result.evidence[0].body!));
  const otherId = { ...openFeed, jobs: [{ ...openFeed.jobs[0], id: 1234 }] };
  assert.equal((await verifyFeed(identity, { fetcher: fixture(otherId) })).verdict, 'not_listed');
});

test('Absent from a complete valid feed is qualified and does not prove removal', async () => {
  const result = await verifyFeed(identity, { fetcher: fixture({ jobs: [], meta: { total: 0 } }) });
  assert.equal(result.verdict, 'not_listed');
  assert.match(result.explanation, /does not prove/);
  assert.ok(result.limitations.some((value) => value.includes('may have never existed')));
});

test('Partial, malformed, duplicate, and non-JSON responses remain inconclusive', async () => {
  for (const data of [
    { jobs: [], meta: { total: 2 } },
    { jobs: [{ id: '123', title: 'Wrong type' }], meta: { total: 1 } },
    { jobs: [openFeed.jobs[0], openFeed.jobs[0]], meta: { total: 2 } },
    { error: 'rate limited' },
  ]) assert.equal((await verifyFeed(identity, { fetcher: fixture(data) })).verdict, 'inconclusive');
  const html = (async () => new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } })) as Fetcher;
  assert.equal((await verifyFeed(identity, { fetcher: html })).verdict, 'inconclusive');
  const invalidJson = (async () => new Response('{', { headers: { 'content-type': 'application/json' } })) as Fetcher;
  assert.equal((await verifyFeed(identity, { fetcher: invalidJson })).verdict, 'inconclusive');
});

test('HTTP access errors preserve the evidence without declaring absence', async () => {
  for (const status of [403, 404, 429, 500]) {
    const result = await verifyFeed(identity, { fetcher: fixture({ error: 'blocked' }, status) });
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.evidence[0].httpStatus, status);
  }
});

test('Network failures and oversized evidence remain inconclusive', async () => {
  const failed = (async () => { throw new Error('network unavailable'); }) as Fetcher;
  assert.equal((await verifyFeed(identity, { fetcher: failed })).verdict, 'inconclusive');
  const oversized = (async () => new Response('large', { headers: {
    'content-length': '2000001', 'content-type': 'application/json',
  } })) as Fetcher;
  assert.equal((await verifyFeed(identity, { fetcher: oversized })).verdict, 'inconclusive');
});

test('Network calls use the static ATS API endpoint and prohibit redirects', async () => {
  let requested = '';
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requested = String(input);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify(openFeed), { headers: { 'content-type': 'application/json' } });
  }) as Fetcher;
  await verifyFeed(identity, { fetcher });
  assert.equal(requested, 'https://boards-api.greenhouse.io/v1/boards/example/jobs');
});

test('Lever paginates through a complete final page before inferring absence', async () => {
  const lever = parseIdentity(leverUrl)!;
  const seen: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const address = String(input); seen.push(address);
    if (address.includes(`/${leverId}?`)) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    const rows = new URL(address).searchParams.get('skip') === '0' ? Array.from({ length: 100 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, text: 'Fixture job',
      hostedUrl: `https://jobs.lever.co/example/00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    })) : [];
    return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
  }) as Fetcher;
  assert.equal((await verifyFeed(lever, { fetcher })).verdict, 'not_listed');
  assert.equal(seen.length, 3);
  assert.match(seen[2], /skip=100/);
});

test('Lever unstable pagination does not turn duplicate rows into an absence claim', async () => {
  const rows = Array.from({ length: 100 }, () => ({ id: leverId, text: 'Fixture', hostedUrl: leverUrl }));
  let calls = 0;
  const fetcher = (async (input: string | URL | Request) => String(input).includes(`/${leverId}?`)
    ? new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify(calls++ === 0 ? rows : []), { headers: { 'content-type': 'application/json' } })) as Fetcher;
  assert.equal((await verifyFeed(parseIdentity(leverUrl)!, { fetcher })).verdict, 'inconclusive');
});

test('Lever verifies an exact public posting without downloading the entire board', async () => {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ id: leverId, text: 'Example role', hostedUrl: leverUrl }), { headers: { 'content-type': 'application/json' } });
  }) as Fetcher;
  const result = await verifyFeed(parseIdentity(leverUrl)!, { fetcher });
  assert.equal(result.verdict, 'verified_open');
  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(`/postings/example/${leverId}`));
  const wrong = await verifyFeed(parseIdentity(leverUrl)!, { fetcher: fixture({ id: leverId, text: 'Wrong board', hostedUrl: leverUrl.replace('/example/', '/unrelated/') }) });
  assert.equal(wrong.verdict, 'inconclusive');
});

test('Ashby direct-link-only postings are not labeled closed', async () => {
  const result = await verifyFeed(parseIdentity(ashbyUrl)!, { fetcher: fixture({ apiVersion: '1', jobs: [
    { title: 'Example role', jobUrl: ashbyUrl, isListed: false },
  ] }) });
  assert.equal(result.verdict, 'inconclusive');
  assert.match(result.explanation, /Unlisted does not mean closed/);
});

test('Mastra workflow preserves user-supplied provenance and cautious verdict', async () => {
  const report = await runInvestigation({ url: 'https://example.com/old', officialUrl: url, advertisementText: 'Unverified source text' }, { fetcher: fixture(openFeed) });
  assert.equal(report.verdict, 'inconclusive');
  assert.equal(report.publication, 'private');
  assert.equal(report.mode, 'live');
  assert.match(report.evidence[0].summary, /User-supplied/);
  assert.equal(report.evidence.filter((item) => item.kind === 'official_feed').length, 1);
  assert.equal(report.timeline.length, 4);
});

test('Reports are immutable, retrievable, and omit evidence bodies from history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-core-'));
  const store = new LocalStore(directory);
  try {
    const report = await runInvestigation({ url }, { fetcher: fixture(openFeed) });
    await store.put(report);
    assert.equal((await store.get(report.id))?.evidence[0].body, report.evidence[0].body);
    await assert.rejects(store.put(report), { code: 'EEXIST' });
    assert.equal((await store.list())[0].evidence[0].body, undefined);
    assert.equal(await store.get('../outside'), null);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('API real entry point saves, downloads and rechecks into a linked immutable report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-api-'));
  const app = await createApp({ store: new LocalStore(directory), fetcher: fixture(openFeed), rateLimit: 100 });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/investigations', payload: { url: 'http://localhost/private' } })).statusCode, 400);
    const response = await app.inject({ method: 'POST', url: '/api/investigations', payload: { url: `${url}?token=secret` } });
    assert.equal(response.statusCode, 201, response.body);
    const report = response.json();
    assert.equal(report.verdict, 'verified_open');
    assert.equal(report.input.url, url);
    const downloaded = await app.inject(`/api/investigations/${report.id}/report`);
    assert.equal(downloaded.statusCode, 200);
    assert.match(downloaded.headers['content-disposition']!, /attachment/);
    assert.equal(downloaded.json().evidence[0].sha256, report.evidence[0].sha256);
    const recheck = await app.inject({ method: 'POST', url: `/api/investigations/${report.id}/recheck` });
    assert.equal(recheck.statusCode, 201);
    assert.notEqual(recheck.json().id, report.id);
    assert.equal(recheck.json().previousInvestigationId, report.id);
    assert.equal((await app.inject('/api/investigations')).json().length, 2);
    assert.equal((await app.inject('/api/health')).json().sponsors[0].status, 'local_verified');
    assert.equal((await app.inject('/api/investigations/not-a-uuid')).statusCode, 404);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Local API rejects rebinding hosts and foreign or opaque origins before accessing reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-origin-'));
  const app = await createApp({ store: new LocalStore(directory), fetcher: fixture(openFeed), rateLimit: 100 });
  try {
    for (const host of ['attacker.example:8787', '127.0.0.1.attacker.example:8787', 'localhost.attacker.example']) {
      assert.equal((await app.inject({ method: 'GET', url: '/api/investigations', headers: { host } })).statusCode, 403);
    }
    for (const origin of ['https://attacker.example', 'null', 'http://127.0.0.1:9999']) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/investigations', headers: { origin }, payload: { url } })).statusCode, 403);
    }
    const accepted = await app.inject({ method: 'POST', url: '/api/investigations', headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:5173' }, payload: { url, advertisementText: 'अ'.repeat(16000) } });
    assert.equal(accepted.statusCode, 201, accepted.body);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Invalid UTF-8 cannot be silently modified into verified evidence', async () => {
  const prefix = Buffer.from('{"jobs":[{"id":123,"title":"');
  const suffix = Buffer.from(`","absolute_url":"${url}"}],"meta":{"total":1}}`);
  const fetcher = (async () => new Response(Buffer.concat([prefix, Buffer.from([0xff]), suffix]), { headers: { 'content-type': 'application/json' } })) as Fetcher;
  const result = await verifyFeed(identity, { fetcher });
  assert.equal(result.verdict, 'inconclusive');
  assert.match(result.explanation, /invalid UTF-8/);
  assert.equal(result.evidence.length, 0);
});

test('API accepts durable persistence and preserves linked rechecks without a second write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-durable-api-'));
  const store = new LocalStore(directory);
  const app = await createApp({ store, rateLimit: 100,
    executeInvestigation: async (input, options) => {
      const report = await runInvestigation(input, { fetcher: fixture(openFeed), previousInvestigationId: options?.previousInvestigationId });
      await store.put(report);
      return report;
    },
  });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/investigations', payload: { url } });
    assert.equal(created.statusCode, 201, created.body);
    const first = created.json();
    const recheck = await app.inject({ method: 'POST', url: `/api/investigations/${first.id}/recheck` });
    assert.equal(recheck.statusCode, 201, recheck.body);
    assert.equal(recheck.json().previousInvestigationId, first.id);
    assert.equal((await store.list()).length, 2);
    assert.equal((await app.inject('/api/health')).json().sponsors.find((item: { name: string }) => item.name === 'Temporal').status, 'local_verified');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
