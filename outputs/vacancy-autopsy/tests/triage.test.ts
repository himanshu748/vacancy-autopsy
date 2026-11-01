import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { runTriage, LocalTriageHistory, resolveTriageHistoryPath, agentHistorySchema, type AgentHistoryRow, type TriageHistory, triageInputSchema } from '../src/server/triage.js';
import { triageResultSchema } from '../src/shared/triage.js';
import { createApp } from '../src/server/app.js';
import { createAuth0Verifier } from '../src/server/auth.js';
import { LocalApprovalStore } from '../src/server/approvals.js';
import type { InvestigationStore } from '../src/server/store.js';
import type { Investigation } from '../src/shared/types.js';
import type { PriorityRow, PriorityOptions } from '../src/server/priority.js';

const entries = Array.from({ length: 4 }, (_, index) => ({ id: `lead-${index + 1}`,
  url: `https://boards.greenhouse.io/example/jobs/${123 + index}`, role: `Role ${index + 1}` }));
const config = { pythonPath: 'python3', contextPath: '/synthetic/context.json', token: 'synthetic' };
const body = JSON.stringify({ jobs: [{ id: 123, title: 'Actual source title',
  absolute_url: 'https://boards.greenhouse.io/example/jobs/123' }], meta: { total: 1 } });
const feed = async () => new Response(body, { headers: { 'content-type': 'application/json' } });
function memoryHistory() {
  const rows: AgentHistoryRow[] = [];
  const history: TriageHistory = { count: async () => rows.length, append: async row => { rows.push(row); } };
  return { rows, history };
}
function memoryStore() {
  const reports: Investigation[] = [];
  const store: InvestigationStore = { kind: 'local', put: async report => { reports.push(report); },
    get: async id => reports.find(report => report.id === id) ?? null, list: async () => reports, close: async () => {} };
  return { reports, store };
}
function priority(observe?: (rows: PriorityRow[]) => void): PriorityOptions {
  return { ...config, runner: async ({ rows }) => {
    observe?.(rows);
    return { ranked: rows.map((row, index) => ({ id: row.id, rank: index + 1, priority: 0.99 - index / 5 })) };
  } };
}

test('Hosted history uses the persistent model mount without silently falling back to app-local files', () => {
  assert.equal(resolveTriageHistoryPath({ dataDirectory: '/app/data', explicitDataDirectory: false, hosted: true,
    priorityContextPath: '/var/lib/vacancy-autopsy/priority/model-context.json' }), '/var/lib/vacancy-autopsy/triage/history.jsonl');
  assert.equal(resolveTriageHistoryPath({ dataDirectory: '/explicit/persistent', explicitDataDirectory: true, hosted: true }),
    '/explicit/persistent/triage/history.jsonl');
  assert.equal(resolveTriageHistoryPath({ dataDirectory: '/local/data', explicitDataDirectory: false, hosted: false }),
    '/local/data/triage/history.jsonl');
  assert.equal(resolveTriageHistoryPath({ dataDirectory: '/app/data', explicitDataDirectory: false, hosted: true }), undefined);
  assert.equal(resolveTriageHistoryPath({ dataDirectory: '/app/data', explicitDataDirectory: false, hosted: true,
    priorityContextPath: 'relative/context.json' }), undefined);
});

test('Mastra triage freezes six pre-check features, respects the budget, and uses actual verification outcomes', async () => {
  const { rows, history } = memoryHistory();
  const { reports, store } = memoryStore();
  let ranked = false;
  let fetches = 0;
  const result = await runTriage(triageInputSchema.parse({ entries, budget: 1 }), {
    store, history, priority: priority(modelRows => {
      assert.equal(fetches, 0);
      assert.deepEqual(modelRows[0].features, { listing_age_days: null, repost_count: null,
        employer_name_similarity: null, title_consistency: null, ats_link_present: 1, source_type: 'official' });
      assert.ok(Object.isFrozen(modelRows[0].features));
      assert.deepEqual(Object.keys(modelRows[0].features).sort(), ['listing_age_days', 'repost_count',
        'employer_name_similarity', 'title_consistency', 'ats_link_present', 'source_type'].sort());
      ranked = true;
    }), fetcher: async () => { assert.ok(ranked); fetches++; return feed(); },
  });
  assert.equal(fetches, 1);
  assert.equal(result.checkBudget, 1);
  assert.equal(result.checksUsed, 1);
  assert.equal(result.checksSaved, 3);
  assert.equal(result.historyRows, 1);
  assert.equal(result.ranked[0].priority, 0.99);
  assert.equal(result.ranked[0].verdict, 'verified_open'); // High stale-priority is never a verdict.
  assert.equal(result.ranked[0].reportId, reports[0].id);
  assert.ok(result.ranked.slice(1).every(row => !row.checked && !row.verdict && !row.reportId));
  assert.ok(result.ranked.every(row => row.reason.length > 0));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].report_id, reports[0].id);
  assert.equal(rows[0].verification.outcome, 'verified_open');
  assert.equal(rows[0].verification.label_method, 'agent_first_party_check');
  assert.equal(rows[0].collection, 'agent_collected');
  assert.equal(rows[0].provenance, 'agent_collected');
  assert.equal(rows[0].kind, 'vacancy_autopsy_agent_history_v2');
  assert.equal(rows[0].training_eligible, false);
  assert.equal(rows[0].review_required, true);
  assert.equal(rows[0].advertisement_captured_at, null);
  assert.equal(rows[0].employer_group, null);
  assert.equal(rows[0].gold.employer, null);
  assert.ok(Date.parse(rows[0].features_captured_at) <= Date.parse(rows[0].verification.checked_at));
  assert.ok(!JSON.stringify(result).includes('Actual source title'));
  assert.ok(!JSON.stringify(result).includes('advertisement_text'));
  assert.equal(triageResultSchema.safeParse({ ...result, ranked: result.ranked.map((row, index) => index === 1
    ? { ...row, verdict: 'not_listed' } : row) }).success, false);
});

test('Default budget is three and is capped by the number of leads, with unknown inputs retained as null', async () => {
  const { history, rows } = memoryHistory();
  const { store } = memoryStore();
  let modelCalls = 0;
  const result = await runTriage(triageInputSchema.parse({ entries: entries.slice(0, 2).map(row => ({
    ...row, url: `https://public-board.example/${row.id}` })) }), {
    store, history, fetcher: async () => { throw new Error('Unresolved identity must never fetch.'); },
    priority: priority(modelRows => { modelCalls++;
      assert.ok(modelRows.every(row => row.features.listing_age_days === null && row.features.ats_link_present === null)); }),
  });
  assert.equal(result.checkBudget, 2);
  assert.equal(result.checksUsed, 2);
  assert.equal(result.checksSaved, 0);
  assert.equal(modelCalls, 1); // One prediction; no retraining or post-outcome resubmission.
  assert.ok(result.ranked.every(row => row.verdict === 'inconclusive'));
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.verification.outcome === null && !row.verification.complete && !row.verification.identity_confirmed));
  assert.ok(rows.every(row => row.features.ats_link_present === null));
});

test('A malformed model ranking cannot spend any verification budget or append history', async () => {
  const { history, rows } = memoryHistory();
  const { store, reports } = memoryStore();
  let checks = 0;
  await assert.rejects(runTriage(triageInputSchema.parse({ entries }), {
    store, history, priority: { ...config, runner: async () => ({ ranked: [] }) },
    fetcher: async () => { checks++; return feed(); },
  }));
  assert.equal(checks, 0);
  assert.equal(rows.length, 0);
  assert.equal(reports.length, 0);
});

test('Failed checks consume the explicit budget but never fabricate history or a verdict', async () => {
  const { history, rows } = memoryHistory();
  const { store } = memoryStore();
  let checks = 0;
  const result = await runTriage(triageInputSchema.parse({ entries, budget: 1 }), {
    store, history, priority: priority(), executeInvestigation: async () => { checks++; throw new Error('Synthetic failure'); },
  });
  assert.equal(checks, 1);
  assert.equal(result.checksUsed, 1);
  assert.equal(result.ranked[0].checked, true);
  assert.ok(result.ranked[0].error);
  assert.equal(result.ranked[0].verdict, undefined);
  assert.equal(rows.length, 0);
});

test('A history failure after verification preserves the saved report and warns callers to inspect the archive', async () => {
  const { store, reports } = memoryStore();
  const app = await createApp({ store, priority: priority(), fetcher: feed,
    triage: { history: { count: async () => 0, append: async () => { throw new Error('Synthetic history failure'); } } } });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/triage',
      headers: { host: '127.0.0.1:8787' }, payload: { entries, budget: 1 } });
    assert.equal(response.statusCode, 502);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].verdict, 'verified_open');
    assert.match(response.json().error, /Saved checks remain in the private archive/);
    assert.ok(!response.body.includes('Synthetic history failure'));
  } finally { await app.close(); }
});

test('Cancellation stops remaining checks without re-ranking, retrying, or labeling skipped leads', async () => {
  const { history, rows } = memoryHistory();
  const { store } = memoryStore();
  const controller = new AbortController();
  let checks = 0;
  let predictions = 0;
  const result = await runTriage(triageInputSchema.parse({ entries, budget: 3 }), {
    store, history, signal: controller.signal, priority: priority(() => { predictions++; }),
    executeInvestigation: async () => { checks++; controller.abort(); throw new Error('Synthetic cancellation'); },
  });
  assert.equal(predictions, 1);
  assert.equal(checks, 1);
  assert.equal(result.checksUsed, 1);
  assert.equal(result.checksSaved, 3);
  assert.equal(rows.length, 0);
  assert.ok(result.ranked.slice(1).every(row => !row.checked && !row.verdict && !row.reportId));
});

test('Agent history is private, serial, replay-safe, persistent, and excluded from the benchmark loader', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-triage-history-'));
  const path = join(directory, 'private', 'history.jsonl');
  const history = new LocalTriageHistory(path);
  const { store } = memoryStore();
  try {
    const result = await runTriage(triageInputSchema.parse({ entries, budget: 1 }), { store, history, priority: priority(), fetcher: feed });
    const row = JSON.parse((await readFile(path, 'utf8')).trim()) as AgentHistoryRow;
    assert.equal(result.historyRows, 1);
    await Promise.all([history.append(row), history.append({ ...row, id: `${randomUUID()}:second` })]);
    assert.equal(await new LocalTriageHistory(path).count(), 2);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
    const loader = spawnSync('python3', ['-c',
      'import sys; from pathlib import Path; from data import load_records, DataError\ntry:\n load_records(Path(sys.argv[1]))\nexcept DataError:\n sys.exit(0)\nraise SystemExit(1)', path],
    { cwd: resolve('ml'), encoding: 'utf8', timeout: 5000 });
    assert.equal(loader.status, 0, loader.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Legacy local history remains byte-preserved and countable while new writes require unreviewed agent provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-triage-legacy-'));
  const path = join(directory, 'history.jsonl');
  const { history, rows } = memoryHistory();
  const { store } = memoryStore();
  try {
    await runTriage(triageInputSchema.parse({ entries, budget: 1 }), { store, history, priority: priority(), fetcher: feed });
    const legacy = { ...rows[0], kind: 'vacancy_autopsy_agent_history_v1', provenance: 'real_public' };
    const originalBytes = `${JSON.stringify(legacy)}\n`;
    await writeFile(path, originalBytes, { mode: 0o600 });
    const persistent = new LocalTriageHistory(path);
    assert.equal(await persistent.count(), 1);
    assert.equal(agentHistorySchema.safeParse(legacy).success, false);
    await assert.rejects(persistent.append(legacy as unknown as AgentHistoryRow));
    assert.equal(await readFile(path, 'utf8'), originalBytes);
    await persistent.append({ ...rows[0], id: `${randomUUID()}:new` });
    assert.equal(await persistent.count(), 2);
    const saved = await readFile(path, 'utf8');
    assert.ok(saved.startsWith(originalBytes));
    assert.equal(JSON.parse(saved.trim().split('\n')[1]).provenance, 'agent_collected');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('A projected history byte-cap overflow is rejected before it can make saved history unreadable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-triage-cap-'));
  const path = join(directory, 'history.jsonl');
  const { history, rows } = memoryHistory();
  const { store } = memoryStore();
  try {
    await runTriage(triageInputSchema.parse({ entries, budget: 1 }), { store, history, priority: priority(), fetcher: feed });
    const line = `${JSON.stringify(rows[0])}\n`;
    // JSON allows leading whitespace. This keeps a valid one-row file at the exact byte cap.
    const original = ' '.repeat(10_000_000 - Buffer.byteLength(line)) + line;
    await writeFile(path, original, { mode: 0o600 });
    const persistent = new LocalTriageHistory(path);
    assert.equal(await persistent.count(), 1);
    await assert.rejects(persistent.append({ ...rows[0], id: `${randomUUID()}:overflow` }), /full/);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(await persistent.count(), 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Hosted triage and history are protected by the existing reviewer JWT gate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'va-triage-auth-'));
  const pair = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'triage-test', alg: 'RS256', use: 'sig' };
  const issuer = 'https://review.example.com/';
  const { history } = memoryHistory();
  const { store } = memoryStore();
  const token = await new SignJWT({ permissions: ['review:reports'] }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer).setAudience('triage-test').setSubject('auth0|triage-reviewer').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const app = await createApp({ store, publicOrigin: 'https://desk.example.com', triage: { history }, priority: priority(), fetcher: feed,
    reviewer: { issuer, audience: 'triage-test', clientId: 'synthetic-client',
      authenticator: createAuth0Verifier({ issuer, audience: 'triage-test' }, { keyResolver: createLocalJWKSet({ keys: [jwk] }) }),
      approvals: new LocalApprovalStore(join(directory, 'approvals')) } });
  try {
    const headers = { host: 'desk.example.com' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/triage', headers, payload: { entries, budget: 1 } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/triage/history', headers })).statusCode, 401);
    const authorized = { ...headers, authorization: `Bearer ${token}`, origin: 'https://desk.example.com' };
    const response = await app.inject({ method: 'POST', url: '/api/triage', headers: authorized, payload: { entries, budget: 1 } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().checksUsed, 1);
    const count = await app.inject({ url: '/api/triage/history', headers: authorized });
    assert.deepEqual(count.json(), { historyRows: 1, automaticRetraining: false });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
