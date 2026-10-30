/** Synthetic driver-contract doubles only. No MongoDB/Atlas connection or provider proof. */
import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MongoClient, MongoServerError, ObjectId, type Db, type Document } from 'mongodb';
import { connectMongoWorkspace } from '../src/server/mongo-workspace.js';
import { validatedResearchArtifact } from '../src/server/research-artifact.js';
import { validatedApproval, type ApprovalRecord } from '../src/server/approvals.js';
import { REVIEW_PERMISSION } from '../src/server/auth.js';
import { MongoStore } from '../src/server/store.js';
import type { Investigation } from '../src/shared/types.js';

const instant = '2026-10-30T06:00:00.000Z';
const sha = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
function discoveryArtifact() {
  const query = 'synthetic fixture role';
  const candidates = [{ url: 'https://jobs.lever.co/example/fixture', title: 'Synthetic example role',
    snippet: 'Synthetic discovery lead; no real finding.', position: 1, source: 'official_posting_candidate' as const }];
  const projectionBody = JSON.stringify({ query, candidates });
  return { id: randomUUID(), kind: 'discovery' as const, createdAt: instant, result: {
    provider: 'serpapi' as const, status: 'success' as const, query, capturedAt: instant, candidates,
    provenance: { requestCount: 1 as const, projectionBody, projectionSha256: sha(projectionBody) },
    detail: 'Synthetic fixture only.', limitations: ['No provider was called.'],
  } };
}
function captureArtifact() {
  // Signature-shaped synthetic bytes test integrity checks, not image rendering.
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('synthetic fixture')]);
  const body = 'Synthetic retained DOM fixture; no browser was called.';
  return { id: randomUUID(), kind: 'browser_capture' as const, createdAt: instant, result: {
    provider: 'browserbase' as const, status: 'captured' as const,
    requestedUrl: 'https://www.employbl.com/jobs/synthetic-fixture', capturedAt: instant,
    detail: 'Synthetic fixture only.', limitations: ['No provider was called.'],
    evidence: { id: randomUUID(), kind: 'browser_capture' as const,
      url: 'https://www.employbl.com/jobs/synthetic-fixture', capturedAt: instant, body, sha256: sha(body), summary: 'Synthetic fixture.' },
    screenshot: { mediaType: 'image/png' as const, base64: image.toString('base64'), byteLength: image.length, sha256: sha(image) },
  } };
}
function approval(): ApprovalRecord {
  const reportDigest = sha('synthetic report');
  const reviewerHash = sha('synthetic reviewer');
  return { id: sha(`vacancy-autopsy-approval-v1\0${reportDigest}\0${reviewerHash}`), reportDigest, reviewerHash,
    reportId: randomUUID(), approvedAt: instant, permission: REVIEW_PERMISSION, policyVersion: 1,
    purpose: 'release_readiness', publication: 'private' };
}

class SyntheticCollection {
  readonly records = new Map<string, Document>();
  readonly indexes: { keys: object; options?: object }[] = [];
  readonly reads: string[] = [];
  insertCount = 0;
  acknowledged = true;
  indexError?: Error;
  insertError?: Error;
  async createIndex(keys: object, options?: object) {
    if (this.indexError) throw this.indexError;
    this.indexes.push({ keys, ...(options ? { options } : {}) });
    return 'synthetic-index';
  }
  async insertOne(record: Document) {
    this.insertCount++;
    if (this.insertError) throw this.insertError;
    if (this.records.has(record.id)) throw new MongoServerError({ message: 'Synthetic duplicate key.', code: 11000 });
    record._id = new ObjectId(); // The real driver's default insert behavior mutates this argument.
    this.records.set(record.id, structuredClone(record));
    return { acknowledged: this.acknowledged, insertedId: record._id };
  }
  async findOne(filter: { id: string }, options: { projection: { _id: number } }) {
    assert.deepEqual(options, { projection: { _id: 0 } });
    this.reads.push(filter.id);
    const record = this.records.get(filter.id);
    if (!record) return null;
    const result = structuredClone(record);
    delete result._id;
    return result;
  }
}
function driver(t: TestContext, connectError?: Error) {
  const artifacts = new SyntheticCollection();
  const approvals = new SyntheticCollection();
  const reports = new SyntheticCollection();
  const connections: MongoClient[] = [];
  const databases: string[] = [];
  let closes = 0;
  mock.method(MongoClient.prototype, 'connect', async function (this: MongoClient) {
    connections.push(this);
    if (connectError) throw connectError;
    return this;
  });
  mock.method(MongoClient.prototype, 'db', (name?: string) => {
    databases.push(name ?? '');
    return { collection(collection: string) {
      if (collection === 'source_artifacts') return artifacts;
      if (collection === 'review_approvals') return approvals;
      if (collection === 'investigations') return reports;
      throw new Error('Unexpected synthetic collection.');
    } } as unknown as Db;
  });
  mock.method(MongoClient.prototype, 'close', async () => { closes++; });
  t.after(() => mock.restoreAll());
  return { artifacts, approvals, reports, connections, databases, closes: () => closes,
    connect: () => connectMongoWorkspace('mongodb://synthetic.invalid:27017', 'synthetic_workspace') };
}

test('Synthetic Mongo contract uses one bounded pool, immutable indexes and shared shutdown ownership', async (t) => {
  const fake = driver(t);
  const workspace = await fake.connect();
  assert.equal(fake.connections.length, 1);
  assert.deepEqual(fake.databases, ['synthetic_workspace']);
  const options = fake.connections[0].options;
  assert.equal(options.maxPoolSize, 5);
  assert.equal(options.serverSelectionTimeoutMS, 8000);
  assert.equal(options.connectTimeoutMS, 8000);
  assert.equal(options.socketTimeoutMS, 10000);
  assert.equal(fake.connections[0].bsonOptions.ignoreUndefined, true);
  assert.deepEqual(fake.artifacts.indexes, [{ keys: { id: 1 }, options: { unique: true } }, { keys: { createdAt: -1 } }]);
  assert.deepEqual(fake.approvals.indexes, [{ keys: { id: 1 }, options: { unique: true } }, { keys: { approvedAt: -1 } }]);
  await workspace.approvals.close();
  assert.equal(fake.closes(), 0);
  const first = workspace.close();
  assert.equal(workspace.close(), first);
  await first;
  assert.equal(fake.closes(), 1);
});

test('Failed connection is closed without creating collections', async (t) => {
  const failure = new Error('Synthetic connection failure.');
  const fake = driver(t, failure);
  await assert.rejects(fake.connect(), (error) => error === failure);
  assert.equal(fake.closes(), 1);
  assert.deepEqual(fake.databases, []);
});

test('Failed index creation closes the shared client and preserves the original error', async (t) => {
  const fake = driver(t);
  const failure = new Error('Synthetic index failure.');
  fake.approvals.indexError = failure;
  await assert.rejects(fake.connect(), (error) => error === failure);
  assert.equal(fake.closes(), 1);
});

test('Source artifacts round-trip and duplicate inserts cannot overwrite the original', async (t) => {
  const fake = driver(t);
  const workspace = await fake.connect();
  const record = discoveryArtifact();
  await workspace.artifacts.put(record);
  assert.ok(!('_id' in record));
  assert.deepEqual(await workspace.artifacts.get(record.id), record);
  await assert.rejects(workspace.artifacts.put({ ...record, createdAt: '2026-10-30T07:00:00.000Z' }), /cannot be overwritten/);
  assert.deepEqual(await workspace.artifacts.get(record.id), record);
  assert.equal(fake.artifacts.insertCount, 2);
  await workspace.close();
});

test('Malformed, oversized and hash-corrupted source records fail before insertion or on read', async (t) => {
  const fake = driver(t);
  const workspace = await fake.connect();
  const record = discoveryArtifact();
  const corrupt = { ...record, result: { ...record.result, provenance: { ...record.result.provenance, projectionSha256: '0'.repeat(64) } } };
  await assert.rejects(workspace.artifacts.put(corrupt), /body hash mismatch/);
  assert.throws(() => validatedResearchArtifact({ ...record, id: 'not-a-uuid' }));
  assert.throws(() => validatedResearchArtifact({ ...record, result: { ...record.result, provenance: undefined } }), /requires retained provenance/);
  await assert.rejects(workspace.artifacts.put({ ...record, result: { ...record.result, detail: 'x'.repeat(4_000_000) } }), /storage budget/);
  assert.equal(fake.artifacts.insertCount, 0);
  await workspace.artifacts.put(record);
  fake.artifacts.records.get(record.id)!.result.provenance.projectionBody += 'corruption';
  await assert.rejects(workspace.artifacts.get(record.id), /body hash mismatch/);
  await workspace.close();
});

test('Discovery metadata and browser body/screenshot integrity are checked independently', async (t) => {
  const fake = driver(t);
  const workspace = await fake.connect();
  const discovery = discoveryArtifact();
  assert.throws(() => validatedResearchArtifact({ ...discovery, result: { ...discovery.result, query: 'different synthetic query' } }), /metadata differs/);
  const capture = captureArtifact();
  await workspace.artifacts.put(capture);
  assert.deepEqual(await workspace.artifacts.get(capture.id), capture);
  for (const changes of [{ sha256: '0'.repeat(64) }, { byteLength: capture.result.screenshot.byteLength + 1 }, { base64: 'bm90IGEgcG5n' }]) {
    assert.throws(() => validatedResearchArtifact({ ...capture, result: { ...capture.result,
      screenshot: { ...capture.result.screenshot, ...changes } } }), /Screenshot/);
  }
  fake.artifacts.records.get(capture.id)!.result.screenshot.sha256 = '0'.repeat(64);
  await assert.rejects(workspace.artifacts.get(capture.id), /Screenshot/);
  assert.throws(() => validatedResearchArtifact({ ...capture, result: { ...capture.result,
    evidence: { ...capture.result.evidence, body: 'changed synthetic DOM' } } }), /body hash/);
  assert.throws(() => validatedResearchArtifact({ ...capture, result: { ...capture.result, evidence: undefined } }), /requires retained evidence/);
  await workspace.close();
});

test('Approval retry returns the original validated record and driver _id never escapes', async (t) => {
  const fake = driver(t);
  const workspace = await fake.connect();
  const record = approval();
  assert.deepEqual(await workspace.approvals.putIfAbsent(record), record);
  const retried = await workspace.approvals.putIfAbsent({ ...record, approvedAt: '2026-10-30T07:00:00.000Z' });
  assert.deepEqual(retried, record);
  assert.deepEqual(validatedApproval(retried), record);
  assert.deepEqual(await workspace.approvals.get(record.id), record);
  assert.ok(!('_id' in record));
  assert.equal(fake.approvals.insertCount, 2);
  await workspace.close();
});

test('Conflicting approval report IDs and corrupted digest/reviewer identities are rejected', async (t) => {
  const fake = driver(t);
  const workspace = await fake.connect();
  const record = approval();
  await workspace.approvals.putIfAbsent(record);
  await assert.rejects(workspace.approvals.putIfAbsent({ ...record, reportId: randomUUID() }), /Approval conflict/);
  for (const field of ['reportDigest', 'reviewerHash'] as const) {
    fake.approvals.records.set(record.id, { ...record, [field]: '0'.repeat(64) });
    await assert.rejects(workspace.approvals.get(record.id), /Approval identity/);
    await assert.rejects(workspace.approvals.putIfAbsent(record), /Approval identity/);
  }
  fake.approvals.records.clear();
  await assert.rejects(workspace.approvals.putIfAbsent({ ...record, id: '0'.repeat(64) }), /Approval identity/);
  await workspace.close();
});

test('Invalid lookup IDs avoid Mongo queries and non-duplicate storage errors propagate', async (t) => {
  const fake = driver(t);
  const workspace = await fake.connect();
  assert.equal(await workspace.artifacts.get('../not-an-id'), null);
  assert.equal(await workspace.approvals.get('not-a-digest'), null);
  assert.equal(fake.artifacts.reads.length + fake.approvals.reads.length, 0);
  assert.equal(await workspace.artifacts.get(randomUUID()), null);
  assert.equal(await workspace.approvals.get('0'.repeat(64)), null);
  const failure = new Error('Synthetic write concern failure.');
  fake.artifacts.insertError = failure;
  fake.approvals.insertError = failure;
  await assert.rejects(workspace.artifacts.put(discoveryArtifact()), (error) => error === failure);
  await assert.rejects(workspace.approvals.putIfAbsent(approval()), (error) => error === failure);
  await workspace.close();
});

test('Unacknowledged writes never claim an artifact or approval was saved', async (t) => {
  const fake = driver(t);
  const workspace = await fake.connect();
  fake.artifacts.acknowledged = false;
  fake.approvals.acknowledged = false;
  await assert.rejects(workspace.artifacts.put(discoveryArtifact()), /not acknowledged/);
  await assert.rejects(workspace.approvals.putIfAbsent(approval()), /not acknowledged/);
  await workspace.close();
});

test('Core Mongo report writes reject an unacknowledged result and succeed only after acknowledgement', async (t) => {
  const fake = driver(t);
  const report: Investigation = { id: randomUUID(), input: { url: 'https://jobs.lever.co/example/synthetic-fixture' },
    createdAt: instant, checkedAt: instant, verdict: 'inconclusive', title: 'Synthetic test role', employer: 'Example',
    explanation: 'Synthetic driver fixture; no real job finding.', limitations: ['No database or provider was contacted.'],
    evidence: [], timeline: [], mode: 'illustrative', publication: 'private' };
  const unacknowledged = await MongoStore.connect('mongodb://synthetic.invalid:27017/?w=0', 'synthetic_workspace');
  fake.reports.acknowledged = false;
  try {
    await assert.rejects(unacknowledged.put(report), /report write was not acknowledged/);
    // A write can reach storage without acknowledgement; its presence must not
    // turn an unacknowledged response into application-level success.
    assert.ok(fake.reports.records.has(report.id));
  } finally { await unacknowledged.close(); }

  const acknowledged = await MongoStore.connect('mongodb://synthetic.invalid:27017/?w=1', 'synthetic_workspace');
  fake.reports.acknowledged = true;
  const accepted = { ...report, id: randomUUID() };
  try {
    await acknowledged.put(accepted);
    assert.deepEqual(await acknowledged.get(accepted.id), accepted);
    assert.ok(!('_id' in accepted));
    assert.equal(fake.reports.insertCount, 2);
    assert.equal(fake.connections.length, 2);
    for (const client of fake.connections) {
      assert.equal(client.options.maxPoolSize, 5);
      assert.equal(client.options.connectTimeoutMS, 8000);
      assert.equal(client.options.serverSelectionTimeoutMS, 8000);
      assert.equal(client.options.socketTimeoutMS, 10000);
    }
  } finally { await acknowledged.close(); }
  assert.equal(fake.closes(), 2);
});
