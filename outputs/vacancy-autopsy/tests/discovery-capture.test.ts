import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { discoverJobs } from '../src/server/discovery.js';
import { captureAdvertisement, isPublicAddress, type CdpConnection, type CdpEvent } from '../src/server/browser-capture.js';

// These are provider-contract fixtures, not live search/browser evidence.
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const key = 'synthetic_provider_secret_for_tests';
const jobUrl = 'https://jobs.ashbyhq.com/semgrep/8e64dc7f-e925-4361-86d5-b01ee518c987';
const adUrl = 'https://www.employbl.com/jobs/example-public-job';
const id = '17e6d46a-cb26-4d83-9388-befbc9d4da90';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ioAAAAASUVORK5CYII=';

test('Discovery makes one bounded provider search and records a credential-free candidate projection', async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const result = await discoverJobs({ query: 'Semgrep software engineer intern' }, { apiKey: key, fetcher: (async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return jsonResponse({ search_metadata: { status: 'Success', id: 'synthetic_search' }, organic_results: [
      { link: `${jobUrl}?utm_source=example#apply`, title: 'Software Engineer Intern', position: 1 },
      { link: adUrl, title: 'Advertisement', snippet: 'Public snippet', position: 2 },
      { link: 'http://127.0.0.1/private', title: 'Rejected unsafe link' },
      { link: jobUrl, title: 'Duplicate' },
    ] });
  }) as typeof fetch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://serpapi.com/search.json');
  assert.equal(calls[0].url.searchParams.get('api_key'), key);
  assert.equal(calls[0].url.searchParams.get('no_cache'), 'false');
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(result.status, 'success');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].url, jobUrl);
  assert.equal(result.candidates[0].source, 'official_posting_candidate');
  assert.equal(result.candidates[1].source, 'advertisement_candidate');
  assert.equal(createHash('sha256').update(result.provenance!.projectionBody).digest('hex'), result.provenance?.projectionSha256);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.match(result.limitations.join(' '), /not browser captures/);
});

test('Discovery refuses missing configuration without a call and does not treat malformed/error responses as empty search success', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error(`Failure at https://serpapi.com/search.json?api_key=${key}`); }) as typeof fetch;
  assert.equal((await discoverJobs({ query: 'public job query' }, { fetcher })).status, 'not_configured');
  assert.equal(calls, 0);
  const failed = await discoverJobs({ query: 'public job query' }, { apiKey: key, fetcher });
  assert.equal(failed.status, 'failed');
  assert.ok(!JSON.stringify(failed).includes(key));
  assert.equal((await discoverJobs({ query: 'public job query' }, { apiKey: key,
    fetcher: (async () => jsonResponse({ search_metadata: { status: 'Success' } })) as typeof fetch })).status, 'failed');
  assert.equal((await discoverJobs({ query: 'public job query' }, { apiKey: key,
    fetcher: (async () => jsonResponse({ search_metadata: { status: 'Success' }, search_information: { total_results: 0 } })) as typeof fetch })).status, 'success');
  await assert.rejects(() => discoverJobs({ query: 'x', apiKey: key }), /./);
});

test('Discovery caps retained results and rejects oversized or invalid UTF-8 responses', async () => {
  const result = await discoverJobs({ query: 'public job query' }, { apiKey: key, fetcher: (async () => jsonResponse({
    search_metadata: { status: 'Success' }, organic_results: Array.from({ length: 20 }, (_, n) => ({ link: `https://example.com/jobs/${n}`, title: 'Public result' })),
  })) as typeof fetch });
  assert.equal(result.candidates.length, 10);
  for (const response of [new Response('x'.repeat(1_000_001), { headers: { 'content-type': 'application/json' } }),
    new Response(Uint8Array.from([0xff, 0xfe]), { headers: { 'content-type': 'application/json' } })]) {
    assert.equal((await discoverJobs({ query: 'public job query' }, { apiKey: key, fetcher: (async () => response) as typeof fetch })).status, 'failed');
  }
});

class FakeCdp implements CdpConnection {
  calls: { method: string; params: Record<string, unknown>; sid?: string }[] = [];
  listeners = new Map<string, Set<(event: CdpEvent) => void>>();
  closed = false;
  snapshot = { url: adUrl, title: 'Public job advertisement', text: 'Software Engineer Intern. Apply at original source.', links: [jobUrl, 'https://unrelated.example.com/'] };
  status = 200;
  requests = [{ requestId: 'document', request: { url: adUrl, method: 'GET' } },
    { requestId: 'private', request: { url: 'http://127.0.0.1/private', method: 'GET' } },
    { requestId: 'external', request: { url: 'https://outside.example.com/resource', method: 'GET' } },
    { requestId: 'post', request: { url: adUrl, method: 'POST' } }];
  async command(method: string, params: Record<string, unknown> = {}, sid?: string): Promise<Record<string, unknown>> {
    this.calls.push({ method, params, sid });
    if (method === 'Target.createTarget') return { targetId: 'target' };
    if (method === 'Target.attachToTarget') return { sessionId: 'cdp-session' };
    if (method === 'Page.navigate') {
      for (const request of this.requests) this.emit('Fetch.requestPaused', request);
      this.emit('Network.responseReceived', { frameId: 'main', type: 'Document', response: { status: this.status } });
      // An iframe must not overwrite the main document's observed status.
      this.emit('Network.responseReceived', { frameId: 'iframe', type: 'Document', response: { status: 403 } });
      queueMicrotask(() => this.emit('Page.domContentEventFired', {}));
      return { frameId: 'main' };
    }
    if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify(this.snapshot) } };
    if (method === 'Page.captureScreenshot') return { data: png };
    return {};
  }
  emit(method: string, params: Record<string, unknown>) { for (const listener of this.listeners.get(method) ?? []) listener({ params, sessionId: 'cdp-session' }); }
  on(method: string, listener: (event: CdpEvent) => void) {
    const bucket = this.listeners.get(method) ?? new Set(); bucket.add(listener); this.listeners.set(method, bucket);
    return () => { bucket.delete(listener); };
  }
  close() { this.closed = true; }
}
function browserFixture(cdp = new FakeCdp(), connectUrl = `wss://connect.browserbase.com?sessionId=${id}&apiKey=${key}`) {
  const calls: { url: string; body: Record<string, unknown>; init?: RequestInit }[] = [];
  const fetcher = (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), init });
    return calls.length === 1 ? jsonResponse({ id, connectUrl }) : jsonResponse({ id, status: 'COMPLETED' });
  }) as typeof fetch;
  return { cdp, calls, options: { apiKey: key, fetcher, resolver: async () => [{ address: '93.184.216.34', family: 4 }], connect: async () => cdp } };
}

test('Capture enforces restricted session settings, captures actual adapter observation and releases the session', async () => {
  const fixture = browserFixture();
  const result = await captureAdvertisement({ url: `${adUrl}?tracking=discarded` }, fixture.options);
  assert.equal(result.status, 'captured');
  assert.equal(result.cleanup, 'released');
  assert.equal(result.requestedUrl, adUrl);
  assert.equal(result.evidence?.httpStatus, 200);
  assert.equal(result.evidence?.kind, 'browser_capture');
  assert.deepEqual(result.officialLinks, [jobUrl]);
  assert.equal(result.evidence?.sha256, createHash('sha256').update(result.evidence!.body!).digest('hex'));
  assert.equal(result.screenshot?.sha256, createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex'));
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[0].url, 'https://api.browserbase.com/v1/sessions');
  assert.equal(fixture.calls[0].body.timeout, 60);
  assert.equal(fixture.calls[0].body.keepAlive, false);
  assert.equal(fixture.calls[0].body.proxies, false);
  const settings = fixture.calls[0].body.browserSettings as Record<string, unknown>;
  assert.equal(settings.solveCaptchas, false);
  assert.equal(settings.ignoreCertificateErrors, false);
  assert.ok(Array.isArray(settings.allowedDomains));
  assert.deepEqual(fixture.calls[1].body, { status: 'REQUEST_RELEASE' });
  const methods = fixture.cdp.calls.map((call) => call.method);
  assert.ok(methods.indexOf('Emulation.setScriptExecutionDisabled') < methods.indexOf('Page.navigate'));
  assert.ok(methods.indexOf('Fetch.enable') < methods.indexOf('Page.navigate'));
  assert.ok(fixture.cdp.calls.some((call) => call.method === 'Network.setBypassServiceWorker' && call.params.bypass === true));
  assert.equal(fixture.cdp.calls.filter((call) => call.method === 'Fetch.failRequest').length, 3);
  assert.equal(fixture.cdp.closed, true);
  assert.ok(!JSON.stringify(result).includes(key));
});

test('Capture rejects unsupported hosts, reserved DNS and missing configuration before creating a billable session', async () => {
  const fixture = browserFixture();
  await assert.rejects(() => captureAdvertisement({ url: 'https://arbitrary.example.com/job' }, fixture.options));
  const missing = await captureAdvertisement({ url: adUrl }, { fetcher: fixture.options.fetcher });
  assert.equal(missing.status, 'not_configured');
  const blocked = await captureAdvertisement({ url: adUrl }, { ...fixture.options, resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
  assert.equal(blocked.status, 'failed');
  assert.equal(fixture.calls.length, 0);
  for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001::1', '2001:1::1', '2001:db8::1', '2002:7f00:1::', '3fff::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

test('Capture fails closed on an untrusted CDP endpoint or unsafe final redirect and still releases the known session', async () => {
  for (const transport of ['wss://attacker.example.com/cdp', 'ws://connect.browserbase.com/cdp', 'wss://connect.browserbase.com.attacker.example.com/cdp']) {
    const fixture = browserFixture(new FakeCdp(), transport);
    let connected = false;
    const result = await captureAdvertisement({ url: adUrl }, { ...fixture.options, connect: async () => { connected = true; return fixture.cdp; } });
    assert.equal(result.status, 'failed'); assert.equal(result.cleanup, 'released'); assert.equal(connected, false);
  }
  const fixture = browserFixture();
  fixture.cdp.snapshot.url = 'https://outside.example.com/redirected';
  const result = await captureAdvertisement({ url: adUrl }, fixture.options);
  assert.equal(result.status, 'failed'); assert.equal(result.evidence, undefined); assert.equal(result.cleanup, 'released');
});

test('Access restrictions remain captured blocks, and cleanup failures remain visible without leaking provider errors', async () => {
  const fixture = browserFixture();
  fixture.cdp.status = 403;
  fixture.cdp.snapshot.text = 'Access denied';
  const result = await captureAdvertisement({ url: adUrl }, fixture.options);
  assert.equal(result.status, 'blocked'); assert.equal(result.evidence?.httpStatus, 403);
  const second = browserFixture();
  const failed = await captureAdvertisement({ url: adUrl }, { ...second.options, fetcher: (async (url, init) => {
    if (String(url).endsWith('/sessions')) return second.options.fetcher(url, init);
    throw new Error(`Private provider URL?apiKey=${key}`);
  }) as typeof fetch });
  assert.equal(failed.status, 'captured'); assert.equal(failed.cleanup, 'release_failed');
  assert.ok(!JSON.stringify(failed).includes(key)); assert.match(failed.limitations.join(' '), /60 seconds/);
});

test('Missing CDP connection data releases a known session; cancelled capture makes no provider request', async () => {
  const fixture = browserFixture();
  const result = await captureAdvertisement({ url: adUrl }, { ...fixture.options, fetcher: (async (url, init) => {
    if (String(url).endsWith('/sessions')) return jsonResponse({ id });
    await fixture.options.fetcher(url, init);
    return jsonResponse({ id, status: 'COMPLETED' });
  }) as typeof fetch });
  assert.equal(result.status, 'failed'); assert.equal(result.cleanup, 'released');
  const controller = new AbortController(); controller.abort();
  const cancelled = await captureAdvertisement({ url: adUrl }, { ...fixture.options, signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
  // The only fixture call above is the explicit release, not session creation.
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].url, `https://api.browserbase.com/v1/sessions/${id}`);
});

test('HTTP success with a still-running release response never claims confirmed cleanup', async () => {
  const fixture = browserFixture();
  const result = await captureAdvertisement({ url: adUrl }, { ...fixture.options, fetcher: (async (url, init) =>
    String(url).endsWith('/sessions') ? fixture.options.fetcher(url, init) : jsonResponse({ id, status: 'RUNNING' })) as typeof fetch });
  assert.equal(result.status, 'captured');
  assert.equal(result.cleanup, 'release_failed');
});

test('A job mentioning CAPTCHA work does not become an unsupported access-denied finding', async () => {
  const fixture = browserFixture();
  fixture.cdp.snapshot.text = 'Software Engineer Intern. Help build accessible CAPTCHA alternatives and authentication features.';
  assert.equal((await captureAdvertisement({ url: adUrl }, fixture.options)).status, 'captured');
});
