import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onceCleanup, settleCleanup } from '../src/server/shutdown.js';

test('A failed dependency close does not skip other cleanup, and shared close is attempted once', async () => {
  const calls: string[] = [];
  const shared = onceCleanup(async () => { calls.push('shared'); throw new Error('synthetic private driver error'); });
  const result = await settleCleanup([shared, async () => { calls.push('workspace'); }, shared,
    async () => { calls.push('store'); }]);
  assert.equal(result, false);
  assert.deepEqual(calls.sort(), ['shared', 'store', 'workspace']);
  assert.equal(await settleCleanup([async () => undefined]), true);
});
