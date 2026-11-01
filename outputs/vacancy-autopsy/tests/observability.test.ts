import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Sentry from '@sentry/node';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeObservability, traceOperation, flushObservability } from '../src/server/observability.js';
import { runInvestigation } from '../src/server/workflow.js';
import { registerExtractionRoutes } from '../src/server/extraction.js';
import { registerPriorityRoutes } from '../src/server/priority.js';
import { createActivities } from '../src/temporal/activities.js';
import { LocalStore } from '../src/server/store.js';

test('Actual Sentry SDK records bounded workflow spans and removes source content from its offline transport', async () => {
  const envelopes: unknown[] = [];
  assert.throws(() => initializeObservability({ dsn: 'https://example.com/1' }), /valid HTTPS/);
  assert.throws(() => initializeObservability({ dsn: 'https://public@example.com/1?token=discard' }), /valid HTTPS/);
  initializeObservability({ dsn: 'https://fixturepublickey@example.com/1', transport: () => ({
    send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
    flush: async () => true,
  }) });
  try {
    const report = await runInvestigation({ url: 'https://boards.greenhouse.io/example/jobs/123',
      advertisementText: 'PRIVATE_SOURCE_TEXT_MUST_NOT_BE_SENT' }, {
      fetcher: async () => new Response(JSON.stringify({ jobs: [{ id: 123, title: 'Intern', absolute_url: 'https://boards.greenhouse.io/example/jobs/123' }], meta: { total: 1 } }),
        { headers: { 'content-type': 'application/json' } }),
    });
    assert.equal(report.verdict, 'verified_open');
    await assert.rejects(traceOperation('browser.capture', async () => { throw new Error('PRIVATE_CREDENTIAL_MUST_NOT_BE_SENT'); },
      { secret: 'PRIVATE_ATTRIBUTE_MUST_NOT_BE_SENT' }));
    await traceOperation('discovery.search', async () => ({ status: 'failed' }), {}, (result) => result.status);
    await flushObservability();
    const exported = JSON.stringify(envelopes);
    assert.ok(exported.includes('investigation.run'));
    assert.ok(exported.includes('source.verify'));
    assert.ok(exported.includes('evidence.seal'));
    assert.ok(exported.includes('browser.capture'));
    assert.ok(exported.includes('verified_open'));
    assert.ok(exported.includes('Vacancy Autopsy operation failed'));
    assert.ok(!exported.includes('PRIVATE_SOURCE_TEXT_MUST_NOT_BE_SENT'));
    assert.ok(!exported.includes('PRIVATE_CREDENTIAL_MUST_NOT_BE_SENT'));
    assert.ok(!exported.includes('PRIVATE_ATTRIBUTE_MUST_NOT_BE_SENT'));
    const failedSpans: Record<string, unknown>[] = [];
    const workflowSpans: Record<string, unknown>[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const item = value as Record<string, unknown>;
        if (item.name === 'discovery.search' && item.attributes) failedSpans.push(item);
        if (['investigation.run', 'identity.resolve', 'source.verify', 'evidence.seal'].includes(String(item.name)) && item.attributes) workflowSpans.push(item);
        Object.values(item).forEach(visit);
      }
    };
    visit(envelopes);
    assert.ok(failedSpans.length > 0);
    const attrs = failedSpans[0].attributes as Record<string, unknown>;
    const unwrap = (value: unknown) => value && typeof value === 'object' && 'value' in value ? value.value : value;
    assert.equal(unwrap(attrs['va.success']), false);
    assert.equal(unwrap(attrs['va.outcome']), 'failed');
    const root = workflowSpans.find((span) => span.name === 'investigation.run');
    assert.ok(root?.trace_id);
    assert.equal(workflowSpans.length, 4);
    assert.ok(workflowSpans.every((span) => span.trace_id === root.trace_id));
  } finally { await Sentry.close(2000); }
});

test('Overlapping actions and separate Temporal activity attempts own distinct traces while their real children stay correlated', async () => {
  const envelopes: unknown[] = [];
  initializeObservability({ dsn: 'https://fixturepublickey@example.com/1', transport: () => ({
    send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
    flush: async () => true,
  }) });
  const directory = await mkdtemp(join(tmpdir(), 'va-trace-activity-'));
  const store = new LocalStore(directory);
  try {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await Promise.all(['a', 'b'].map((key) => traceOperation('investigation.run', async () => {
      entered++;
      if (entered === 2) release();
      await gate;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return traceOperation('identity.resolve', async () => key, { 'va.step': `child_${key}` });
    }, { 'va.step': `root_${key}` })));

    // Invoke the actual activity implementation with synthetic feed data. This
    // checks worker-side caller boundaries without claiming a live Temporal run.
    const activity = createActivities({ store, fetcher: async () => new Response(JSON.stringify({
      jobs: [{ id: 123, title: 'Intern', absolute_url: 'https://boards.greenhouse.io/example/jobs/123' }],
      meta: { total: 1 },
    }), { headers: { 'content-type': 'application/json' } }) });
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await activity.investigateAndSave({ operationId: randomUUID(),
        input: { url: 'https://boards.greenhouse.io/example/jobs/123' } });
      assert.equal(report.verdict, 'verified_open');
      assert.equal(report.reused, false);
    }
    await flushObservability();
    const spans: Record<string, unknown>[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const item = value as Record<string, unknown>;
        if (['investigation.run', 'identity.resolve', 'source.verify', 'evidence.seal'].includes(String(item.name)) && item.attributes) spans.push(item);
        Object.values(item).forEach(visit);
      }
    };
    visit(envelopes);
    const roots = spans.filter((span) => span.name === 'investigation.run');
    assert.equal(roots.length, 4);
    assert.equal(new Set(roots.map((span) => span.trace_id)).size, 4);
    assert.ok(roots.every((root) => !root.parent_span_id));
    const groupSizes = roots.map((root) => {
      const children = spans.filter((span) => span.trace_id === root.trace_id && span !== root);
      assert.ok(children.every((child) => child.parent_span_id === root.span_id));
      return children.length + 1;
    });
    assert.deepEqual(groupSizes.sort(), [2, 2, 4, 4]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
    await Sentry.close(2000);
  }
});

test('Model routes trace provider latency and validated outcomes without exporting listing, identity or provider diagnostics', async () => {
  const envelopes: unknown[] = [];
  initializeObservability({ dsn: 'https://fixturepublickey@example.com/1', transport: () => ({
    send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
    flush: async () => true,
  }) });
  const app = Fastify({ logger: false });
  let extractionMode: 'success' | 'invalid' | 'failure' = 'success';
  let priorityMode: 'success' | 'invalid' | 'failure' = 'success';
  await registerExtractionRoutes(app, {
    artifactPath: '/PRIVATE_CHECKPOINT_PATH/training.json', pythonPath: '/PRIVATE_SDK_PATH/python',
    apiKey: 'PRIVATE_API_CREDENTIAL', projectId: 'PRIVATE_PROJECT_ID',
    runner: async () => {
      if (extractionMode === 'failure') throw new Error('PRIVATE_PROVIDER_ERROR https://PRIVATE_PROVIDER_URL');
      if (extractionMode === 'invalid') return { invalid: 'PRIVATE_BAD_RESPONSE' };
      return { employer: 'PRIVATE_EMPLOYER', title: 'PRIVATE_ROLE', job_id: '123', ats: 'greenhouse' };
    },
  });
  await registerPriorityRoutes(app, {
    contextPath: '/PRIVATE_CONTEXT_PATH/model-context.json', pythonPath: '/PRIVATE_SDK_PATH/python',
    token: 'PRIVATE_PREDICTION_TOKEN',
    runner: async ({ rows }) => {
      if (priorityMode === 'failure') throw new Error('PRIVATE_PROVIDER_ERROR https://PRIVATE_PROVIDER_URL');
      if (priorityMode === 'invalid') return { ranked: [] };
      return { ranked: rows.map((row, index) => ({ id: row.id, rank: index + 1, priority: 1 - index / 2 })) };
    },
  });
  const extraction = {
    url: 'https://example.com/PRIVATE_AD_URL?token=PRIVATE_QUERY',
    advertisementText: 'PRIVATE_EMPLOYER seeks PRIVATE_ROLE. Greenhouse job 123. PRIVATE_AD_TEXT',
  };
  const priority = { entries: [
    { id: 'PRIVATE_ENTRY_ID_1', url: 'https://example.com/PRIVATE_AD_URL_1', role: 'PRIVATE_RANK_ROLE', daysSincePosted: 4 },
    { id: 'PRIVATE_ENTRY_ID_2', url: 'https://example.com/PRIVATE_AD_URL_2', daysSincePosted: 40 },
  ] };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/extract', payload: extraction })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/priority', payload: priority })).statusCode, 200);
    extractionMode = priorityMode = 'invalid';
    assert.equal((await app.inject({ method: 'POST', url: '/api/extract', payload: extraction })).statusCode, 502);
    assert.equal((await app.inject({ method: 'POST', url: '/api/priority', payload: priority })).statusCode, 502);
    extractionMode = priorityMode = 'failure';
    assert.equal((await app.inject({ method: 'POST', url: '/api/extract', payload: extraction })).statusCode, 502);
    assert.equal((await app.inject({ method: 'POST', url: '/api/priority', payload: priority })).statusCode, 502);
    await flushObservability();
    const exported = JSON.stringify(envelopes);
    assert.ok(!exported.includes('PRIVATE_'));
    const spans: Record<string, unknown>[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const item = value as Record<string, unknown>;
        if (['execute_tool read_listing_details', 'execute_tool prioritize_shortlist'].includes(String(item.name)) && item.attributes) spans.push(item);
        Object.values(item).forEach(visit);
      }
    };
    visit(envelopes);
    assert.equal(spans.length, 6);
    assert.equal(new Set(spans.map((span) => span.trace_id)).size, 6,
      'Unrelated model HTTP requests must not inherit one process-wide trace');
    assert.ok(spans.every((span) => typeof span.start_timestamp === 'number' &&
      typeof span.end_timestamp === 'number' && span.end_timestamp >= span.start_timestamp));
    const unwrap = (value: unknown) => value && typeof value === 'object' && 'value' in value ? value.value : value;
    for (const [operation, toolName, provider, aiProvider] of [
      ['model.extract', 'read_listing_details', 'tinker', 'tinker'],
      ['model.rank', 'prioritize_shortlist', 'tabpfn', 'prior_labs'],
    ]) {
      const modelSpans = spans.filter((span) => span.name === `execute_tool ${toolName}`);
      assert.equal(modelSpans.length, 3);
      const attributes = modelSpans.map((span) => Object.fromEntries(Object.entries(span.attributes as Record<string, unknown>).map(([key, value]) => [key, unwrap(value)])));
      assert.ok(attributes.every((attrs) => attrs['va.provider'] === provider));
      assert.ok(attributes.every((attrs) => attrs['va.step'] === operation &&
        attrs['sentry.op'] === 'gen_ai.execute_tool' && attrs['gen_ai.operation.name'] === 'execute_tool' &&
        attrs['gen_ai.tool.name'] === toolName && attrs['gen_ai.provider.name'] === aiProvider));
      assert.equal(attributes.filter((attrs) => attrs['va.success'] === true && attrs['va.outcome'] === 'success').length, 1);
      assert.ok(attributes.some((attrs) => attrs['va.failure_class'] === 'invalid_response' && attrs['va.outcome'] === 'failed'));
      assert.ok(attributes.some((attrs) => attrs['va.failure_class'] === 'provider_error' && attrs['va.outcome'] === 'failed'));
      assert.ok(attributes.filter((attrs) => attrs['va.success'] === false).every((attrs) => attrs['error.type'] === attrs['va.failure_class']));
      assert.ok(attributes.every((attrs) => !Object.keys(attrs).some((key) => /token|cost|prompt|response|url|id$/i.test(key))));
    }
  } finally {
    await app.close();
    await Sentry.close(2000);
  }
});
