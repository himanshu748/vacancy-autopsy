import test from 'node:test';
import assert from 'node:assert/strict';
import type { MouseEvent } from 'react';
import { authorizedFetch, authenticatedDownload, getWorkspaceConfig, getReviewerReturnReportId,
  restoredWorkspaceReport } from '../src/web/workspace-auth.js';

// Synthetic browser/config fixtures exercise transport boundaries. They never
// initialize the Auth0 SDK or establish a real tenant login or hosted receipt.
test('Workspace transport confines requests and fails closed before authentication', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { origin: 'https://workspace.example', search: '', href: 'https://workspace.example/' },
    sessionStorage: { getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
    dispatchEvent: () => true,
  } });
  let configuration: unknown = { configured: false, requiresAuthentication: false };
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (path, init) => {
    calls.push({ path: String(path), init });
    return new Response(JSON.stringify(path === '/api/reviewer-config' ? configuration : { ok: true }),
      { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await getWorkspaceConfig(true);
    await t.test('Local API requests remain uncredentialled and refuse redirects', async () => {
      const response = await authorizedFetch('/api/investigations', { redirect: 'follow', credentials: 'include' });
      assert.equal(response.status, 200);
      assert.equal(new Headers(calls.at(-1)?.init?.headers).has('authorization'), false);
      assert.equal(calls.at(-1)?.init?.redirect, 'error');
      assert.equal(calls.at(-1)?.init?.credentials, 'same-origin');
    });
    await t.test('External, credentialed and escaped paths are refused before config or SDK access', async () => {
      const previous = calls.length;
      for (const path of ['https://evil.example/api/private', '//evil.example/api/private',
        '/api/../outside', 'https://user:password@workspace.example/api/private']) {
        await assert.rejects(authorizedFetch(path));
      }
      assert.equal(calls.length, previous);
    });
    await t.test('Local evidence downloads retain native link behavior', async () => {
      let prevented = false;
      const event = { currentTarget: { download: '' }, preventDefault: () => { prevented = true; } } as unknown as MouseEvent<HTMLAnchorElement>;
      const previous = calls.length;
      await authenticatedDownload(event, '/api/investigations/id/report');
      assert.equal(prevented, false);
      assert.equal(calls.length, previous);
    });
    await t.test('External evidence download is prevented and cannot receive credentials', async () => {
      let prevented = false;
      const event = { currentTarget: { download: '' }, preventDefault: () => { prevented = true; } } as unknown as MouseEvent<HTMLAnchorElement>;
      const previous = calls.length;
      await assert.rejects(authenticatedDownload(event, 'https://evil.example/api/private'));
      assert.equal(prevented, true);
      assert.equal(calls.length, previous);
    });
    await t.test('Case restoration accepts only a UUID and clears it after the report mounts', () => {
      stored.set('vacancy-autopsy:review-report', 'javascript:bad');
      assert.equal(getReviewerReturnReportId(), null);
      const id = '01234567-1234-4123-8123-012345678901';
      stored.set('vacancy-autopsy:review-report', id);
      assert.equal(getReviewerReturnReportId(), id);
      restoredWorkspaceReport(id);
      assert.equal(stored.size, 0);
    });
    await t.test('Missing authentication mode never silently selects local access', async () => {
      configuration = { configured: false };
      await assert.rejects(getWorkspaceConfig(true));
    });
    await t.test('Hosted mode without auth configuration cannot issue a data request', async () => {
      configuration = { configured: false, requiresAuthentication: true };
      await getWorkspaceConfig(true);
      const previous = calls.length;
      await assert.rejects(authorizedFetch('/api/investigations'));
      assert.equal(calls.length, previous);
      assert.ok(calls.every((call) => call.path.startsWith('/api/')));
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
