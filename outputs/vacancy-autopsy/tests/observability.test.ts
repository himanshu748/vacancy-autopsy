import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Sentry from '@sentry/node';
import { initializeObservability, traceOperation, flushObservability } from '../src/server/observability.js';
import { runInvestigation } from '../src/server/workflow.js';

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
