import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserCaptureResult } from '../src/server/browser-capture.js';
import { CaptureLinkageError, loadCapturedLinkage } from '../src/server/capture-linkage.js';
import { type ArtifactStore, type ResearchArtifact, LocalArtifactStore } from '../src/server/research.js';
import { runInvestigation } from '../src/server/workflow.js';
import { createApp } from '../src/server/app.js';
import { LocalStore } from '../src/server/store.js';
import { createActivities } from '../src/temporal/activities.js';
import type { Fetcher } from '../src/server/ats.js';

// Synthetic source bytes exercise trust boundaries, never real employer findings.
const adUrl = 'https://www.oppidx.com/opportunities/synthetic-engineer';
const officialUrl = 'https://job-boards.greenhouse.io/example/jobs/123';
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
function captureFixture(): ResearchArtifact {
  const at = new Date().toISOString();
  const body = JSON.stringify({ requestedUrl: adUrl, url: adUrl, title: 'Synthetic Engineer', text: 'Synthetic advertisement. Apply at its posting link.',
    officialLinks: [officialUrl], pageJavaScript: 'disabled', blockedRequests: 0, observedRequests: 1 });
  return { id: randomUUID(), kind: 'browser_capture', createdAt: at, result: {
    provider: 'browserbase', status: 'captured', requestedUrl: adUrl, capturedAt: at,
    detail: 'Synthetic adapter observation', limitations: ['Synthetic fixture: not a real job.'], officialLinks: [officialUrl],
    evidence: { id: randomUUID(), kind: 'browser_capture', url: adUrl, capturedAt: at, body, sha256: hash(body), httpStatus: 200, summary: 'Synthetic capture' },
  } };
}
const result = (artifact: ResearchArtifact) => artifact.result as BrowserCaptureResult;
function mutateBody(artifact: ResearchArtifact, change: (body: Record<string, unknown>) => void) {
  const evidence = result(artifact).evidence!;
  const body = JSON.parse(evidence.body!);
  change(body); evidence.body = JSON.stringify(body); evidence.sha256 = hash(evidence.body);
}
function memory(artifact: ResearchArtifact | null): ArtifactStore {
  return { get: async () => artifact, put: async () => { throw new Error('Fixture is read-only.'); } };
}
function sourceFixture(onFetch = () => {}): Fetcher {
  return (async () => { onFetch(); return new Response(JSON.stringify({ jobs: [], meta: { total: 0 } }),
    { headers: { 'content-type': 'application/json' } }); }) as Fetcher;
}

test('A fresh saved browser snapshot binds one exact ATS link and preserves both sources in a qualified report', async () => {
  const artifact = captureFixture();
  const input = { url: `${adUrl}?tracking=removed#fragment`, officialUrl, captureArtifactId: artifact.id };
  const report = await runInvestigation(input, { artifacts: memory(artifact), fetcher: sourceFixture() });
  assert.equal(report.verdict, 'not_listed');
  assert.equal(report.input.url, adUrl);
  assert.equal(report.input.captureArtifactId, artifact.id);
  assert.deepEqual(report.evidence.map(item => item.kind), ['browser_capture', 'official_feed']);
  assert.equal(report.evidence[0].body, result(artifact).evidence!.body);
  assert.equal(report.evidence[0].sha256, hash(report.evidence[0].body!));
  assert.ok(report.timeline.some(item => item.name === 'Advertisement posting link captured'));
  assert.ok(report.limitations.some(item => /does not independently establish company-domain ownership/.test(item)));
  assert.ok(report.limitations.some(item => /prior removal/.test(item)));
  const unlinked = await runInvestigation({ url: adUrl, officialUrl, advertisementText: officialUrl }, { fetcher: sourceFixture() });
  assert.equal(unlinked.verdict, 'inconclusive');
  assert.equal(unlinked.sourceObservation?.verdict, 'not_listed');
});

test('Missing capture references, disabled artifact storage and non-capture artifacts cannot prove linkage', async () => {
  const artifact = captureFixture();
  const input = { url: adUrl, officialUrl, captureArtifactId: artifact.id };
  await assert.rejects(loadCapturedLinkage(input), CaptureLinkageError);
  await assert.rejects(loadCapturedLinkage(input, memory(null)), CaptureLinkageError);
  await assert.rejects(loadCapturedLinkage(input, memory({ ...artifact, id: randomUUID() })), CaptureLinkageError);
  await assert.rejects(loadCapturedLinkage(input, memory({ ...artifact, kind: 'discovery' } as ResearchArtifact)), CaptureLinkageError);
  assert.equal(await loadCapturedLinkage({ url: adUrl, officialUrl }, memory(artifact)), undefined);
});

test('Corrupt hashes, metadata disagreement and blocked or unsuccessful observations fail before any feed request', async () => {
  const edits: ((artifact: ResearchArtifact) => void)[] = [
    artifact => { result(artifact).evidence!.body += 'tampered'; },
    artifact => { result(artifact).officialLinks = [officialUrl.replace('123', '124')]; },
    artifact => { result(artifact).status = 'blocked'; },
    artifact => { result(artifact).evidence!.httpStatus = 403; },
    artifact => { result(artifact).evidence!.capturedAt = new Date(Date.now() - 1000).toISOString(); },
    artifact => { mutateBody(artifact, body => { body.pageJavaScript = 'enabled'; }); },
    artifact => { mutateBody(artifact, body => { body.extraClientEvidence = 'untrusted'; }); },
  ];
  for (const edit of edits) {
    const artifact = captureFixture(); edit(artifact); let fetches = 0;
    await assert.rejects(runInvestigation({ url: adUrl, officialUrl, captureArtifactId: artifact.id },
      { artifacts: memory(artifact), fetcher: sourceFixture(() => fetches++) }), CaptureLinkageError);
    assert.equal(fetches, 0);
  }
});

test('The captured source and final page must match this advertisement, and the explicit ATS URL must match its retained link', async () => {
  const variants = [
    { url: adUrl + '-different', officialUrl },
    { url: adUrl, officialUrl: officialUrl.replace('123', '124') },
    { url: adUrl, officialUrl: 'https://job-boards.greenhouse.io/other/jobs/123' },
    { url: adUrl, officialUrl: 'https://jobs.lever.co/example/12345678-1234-4321-8123-123456789012' },
    { url: adUrl },
  ];
  for (const input of variants) {
    const artifact = captureFixture();
    await assert.rejects(loadCapturedLinkage({ ...input, captureArtifactId: artifact.id }, memory(artifact)), CaptureLinkageError);
  }
  for (const field of ['requestedUrl', 'url']) {
    const artifact = captureFixture();
    mutateBody(artifact, body => { body[field] = adUrl + '-other'; });
    await assert.rejects(loadCapturedLinkage({ url: adUrl, officialUrl, captureArtifactId: artifact.id }, memory(artifact)), CaptureLinkageError);
  }
});

test('Missing and multiple ATS identities cannot be selected; equivalent canonical links remain one identity', async () => {
  for (const links of [[], [officialUrl, officialUrl.replace('123', '124')], [officialUrl, 'https://not-an-ats.example.com/123']]) {
    const artifact = captureFixture(); result(artifact).officialLinks = links;
    mutateBody(artifact, body => { body.officialLinks = links; });
    await assert.rejects(loadCapturedLinkage({ url: adUrl, officialUrl, captureArtifactId: artifact.id }, memory(artifact)), CaptureLinkageError);
  }
  const artifact = captureFixture();
  const equivalent = [officialUrl, officialUrl.replace('job-boards.greenhouse.io', 'boards.greenhouse.io')];
  result(artifact).officialLinks = equivalent; mutateBody(artifact, body => { body.officialLinks = equivalent; });
  assert.equal((await loadCapturedLinkage({ url: adUrl, officialUrl, captureArtifactId: artifact.id }, memory(artifact)))?.identity.jobId, '123');
});

test('Capture freshness is bounded to 24 hours with five minutes of clock tolerance and consistent artifact timestamps', async () => {
  const artifact = captureFixture(); const at = Date.parse(artifact.createdAt);
  const input = { url: adUrl, officialUrl, captureArtifactId: artifact.id };
  assert.ok(await loadCapturedLinkage(input, memory(artifact), at + 24 * 60 * 60 * 1000));
  await assert.rejects(loadCapturedLinkage(input, memory(artifact), at + 24 * 60 * 60 * 1000 + 1), CaptureLinkageError);
  await assert.rejects(loadCapturedLinkage(input, memory(artifact), at - 5 * 60 * 1000 - 1), CaptureLinkageError);
  for (const offset of [-1, 5 * 60 * 1000 + 1]) {
    const invalid = structuredClone(artifact); invalid.createdAt = new Date(at + offset).toISOString();
    await assert.rejects(loadCapturedLinkage(input, memory(invalid), at), CaptureLinkageError);
  }
});

test('The actual local API attaches immutable stored evidence, downloads it and rechecks without overwriting the prior report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-capture-link-'));
  const artifacts = new LocalArtifactStore(join(directory, 'sources'));
  const artifact = captureFixture(); await artifacts.put(artifact);
  const app = await createApp({ store: new LocalStore(directory), research: { artifacts }, fetcher: sourceFixture() });
  try {
    const input = { url: adUrl, officialUrl, captureArtifactId: artifact.id };
    const first = await app.inject({ method: 'POST', url: '/api/investigations', payload: input });
    assert.equal(first.statusCode, 201); const report = first.json();
    assert.equal(report.verdict, 'not_listed');
    const second = await app.inject({ method: 'POST', url: `/api/investigations/${report.id}/recheck`, payload: {} });
    assert.equal(second.statusCode, 201); const rechecked = second.json();
    assert.notEqual(rechecked.id, report.id); assert.equal(rechecked.previousInvestigationId, report.id);
    assert.equal(rechecked.input.captureArtifactId, artifact.id);
    assert.deepEqual((await app.inject(`/api/investigations/${report.id}/report`)).json(), report);
    assert.deepEqual(await artifacts.get(artifact.id), artifact);
    const forged = await app.inject({ method: 'POST', url: '/api/investigations', payload: { ...input, capturedEvidence: result(artifact).evidence } });
    assert.equal(forged.statusCode, 400);
    const absent = await app.inject({ method: 'POST', url: '/api/investigations', payload: { ...input, captureArtifactId: randomUUID() } });
    assert.equal(absent.statusCode, 409);
    assert.deepEqual((await app.inject('/api/investigations')).json().map((item: { id: string }) => item.id).sort(), [report.id, rechecked.id].sort());
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Durable retries reuse a saved attachment report without rereading expired evidence; only references leave the Activity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-capture-durable-'));
  const store = new LocalStore(directory); const artifact = captureFixture(); let reads = 0, fetches = 0;
  const artifacts: ArtifactStore = { put: async () => {}, get: async () => { reads++; if (reads > 1) throw new Error('Synthetic evidence now unavailable'); return artifact; } };
  const request = { operationId: randomUUID(), input: { url: adUrl, officialUrl, captureArtifactId: artifact.id } };
  try {
    const interrupted = createActivities({ store, artifacts, fetcher: sourceFixture(() => fetches++), afterPersist: async () => { throw new Error('synthetic crash after save'); } });
    await assert.rejects(interrupted.investigateAndSave(request), /could not read or save/);
    const saved = await store.get(request.operationId); assert.equal(saved?.evidence[0].kind, 'browser_capture');
    const recovered = createActivities({ store, artifacts, fetcher: sourceFixture(() => fetches++) });
    const reference = await recovered.investigateAndSave(request);
    assert.equal(reference.reused, true); assert.equal(reads, 1); assert.equal(fetches, 1);
    assert.deepEqual(Object.keys(reference).sort(), ['checkedAt', 'reportId', 'reused', 'verdict']);
    assert.ok(!JSON.stringify(request).includes(result(artifact).evidence!.body!));
    assert.ok(!JSON.stringify(reference).includes(result(artifact).evidence!.body!));
    await assert.rejects(recovered.investigateAndSave({ ...request, input: { ...request.input, captureArtifactId: randomUUID() } }), /already bound/);
    assert.deepEqual(await store.get(request.operationId), saved);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('A bad capture reference is a permanent durable validation failure and never fetches a source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-capture-invalid-')); const store = new LocalStore(directory); let fetches = 0;
  try {
    await assert.rejects(createActivities({ store, artifacts: memory(null), fetcher: sourceFixture(() => fetches++) }).investigateAndSave({
      operationId: randomUUID(), input: { url: adUrl, officialUrl, captureArtifactId: randomUUID() },
    }), (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'nonRetryable' in error && error.nonRetryable === true);
      return true;
    });
    assert.equal(fetches, 0); assert.deepEqual(await store.list(), []);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('The durable API preflights capture references and sends only ordinary input plus the artifact ID to its executor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-capture-api-durable-'));
  const store = new LocalStore(directory); const artifact = captureFixture(); const artifacts = memory(artifact);
  let executions = 0;
  const activities = createActivities({ store, artifacts, fetcher: sourceFixture() });
  const app = await createApp({ store, research: { artifacts }, executeInvestigation: async input => {
    executions++;
    assert.deepEqual(Object.keys(input).sort(), ['captureArtifactId', 'officialUrl', 'url']);
    const reference = await activities.investigateAndSave({ operationId: randomUUID(), input });
    return (await store.get(reference.reportId))!;
  } });
  try {
    const invalid = await app.inject({ method: 'POST', url: '/api/investigations', payload: { url: adUrl, officialUrl, captureArtifactId: randomUUID() } });
    assert.equal(invalid.statusCode, 409); assert.equal(executions, 0);
    const valid = await app.inject({ method: 'POST', url: '/api/investigations', payload: { url: adUrl, officialUrl, captureArtifactId: artifact.id } });
    assert.equal(valid.statusCode, 201); assert.equal(executions, 1);
    assert.equal(valid.json().evidence[0].kind, 'browser_capture');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('An expired saved case can recheck with a fresh capture reference while its source, posting identity and original report remain pinned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-capture-refresh-'));
  const store = new LocalStore(directory); const artifacts = new LocalArtifactStore(join(directory, 'sources'));
  const old = captureFixture();
  const priorTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  old.createdAt = priorTime; result(old).capturedAt = priorTime; result(old).evidence!.capturedAt = priorTime;
  await artifacts.put(old);
  // Seed a clearly synthetic historical report; no current provider call creates it.
  const previous = await runInvestigation({ url: officialUrl }, { fetcher: sourceFixture() });
  previous.input = { url: adUrl, officialUrl, captureArtifactId: old.id };
  previous.createdAt = priorTime; previous.checkedAt = priorTime;
  previous.evidence = [result(old).evidence!, ...previous.evidence.map(evidence => ({ ...evidence, capturedAt: priorTime }))];
  if (previous.sourceObservation) previous.sourceObservation.checkedAt = priorTime;
  previous.timeline = previous.timeline.map(step => ({ ...step, at: priorTime }));
  await store.put(previous);
  const fresh = captureFixture(); await artifacts.put(fresh);
  const wrongSource = captureFixture();
  result(wrongSource).requestedUrl = adUrl + '-other'; result(wrongSource).evidence!.url = adUrl + '-other';
  mutateBody(wrongSource, body => { body.requestedUrl = adUrl + '-other'; body.url = adUrl + '-other'; });
  await artifacts.put(wrongSource);
  const wrongIdentity = captureFixture(); const otherUrl = officialUrl.replace('123', '124');
  result(wrongIdentity).officialLinks = [otherUrl]; mutateBody(wrongIdentity, body => { body.officialLinks = [otherUrl]; });
  await artifacts.put(wrongIdentity);
  let fetches = 0;
  const app = await createApp({ store, research: { artifacts }, fetcher: sourceFixture(() => fetches++) });
  try {
    const endpoint = `/api/investigations/${previous.id}/recheck`;
    assert.equal((await app.inject({ method: 'POST', url: endpoint, payload: {} })).statusCode, 409);
    for (const captureArtifactId of [wrongSource.id, wrongIdentity.id]) {
      assert.equal((await app.inject({ method: 'POST', url: endpoint, payload: { captureArtifactId } })).statusCode, 409);
    }
    for (const payload of [{ captureArtifactId: 'not-a-uuid' }, { captureArtifactId: fresh.id, url: adUrl + '-other' },
      { captureArtifactId: fresh.id, officialUrl: otherUrl }, { captureArtifactId: fresh.id, linkageVerified: true }]) {
      assert.equal((await app.inject({ method: 'POST', url: endpoint, payload })).statusCode, 400);
    }
    assert.equal(fetches, 0);
    const response = await app.inject({ method: 'POST', url: endpoint, payload: { captureArtifactId: fresh.id } });
    assert.equal(response.statusCode, 201); const rechecked = response.json();
    assert.equal(fetches, 1); assert.notEqual(rechecked.id, previous.id);
    assert.equal(rechecked.previousInvestigationId, previous.id);
    assert.deepEqual(rechecked.input, { ...previous.input, captureArtifactId: fresh.id });
    assert.equal(rechecked.evidence[0].sha256, result(fresh).evidence!.sha256);
    assert.deepEqual(await store.get(previous.id), previous);
    assert.deepEqual((await app.inject(`/api/investigations/${previous.id}/report`)).json(), previous);
    assert.deepEqual(await artifacts.get(old.id), old);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
