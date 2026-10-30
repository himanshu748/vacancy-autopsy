import type { Auth0Client } from '@auth0/auth0-spa-js';
import type { MouseEvent } from 'react';

export type WorkspaceConfig = { configured: false; requiresAuthentication: boolean } |
  { configured: true; requiresAuthentication: boolean; issuer: string; clientId: string; audience: string };
export const WORKSPACE_ACCESS_EVENT = 'vacancy-autopsy:workspace-access';
const RETURN_REPORT_KEY = 'vacancy-autopsy:review-report';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const clients = new Map<string, Promise<Auth0Client>>();
let configRequest: Promise<WorkspaceConfig> | null = null;
let currentConfig: WorkspaceConfig | null = null;
let currentReportId: string | null = null;

export class WorkspaceAuthError extends Error {
  constructor(readonly status: number, message = 'Workspace access is unavailable.') { super(message); }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function needsWorkspaceSignIn(error: unknown): boolean {
  return (error instanceof WorkspaceAuthError && error.status === 401) ||
    (object(error) && typeof error.error === 'string' && ['login_required', 'consent_required', 'interaction_required'].includes(error.error));
}
function notifyAccess(status: 401 | 403) {
  if (currentConfig?.requiresAuthentication) window.dispatchEvent(new CustomEvent(WORKSPACE_ACCESS_EVENT, { detail: { status } }));
}
function readConfig(value: unknown): WorkspaceConfig {
  if (!object(value) || typeof value.configured !== 'boolean' || typeof value.requiresAuthentication !== 'boolean') {
    throw new WorkspaceAuthError(503, 'Workspace configuration could not be read.');
  }
  if (!value.configured) return { configured: false, requiresAuthentication: value.requiresAuthentication };
  if (typeof value.issuer !== 'string' || typeof value.clientId !== 'string' || !value.clientId ||
      typeof value.audience !== 'string' || !value.audience) throw new WorkspaceAuthError(503);
  const issuer = new URL(value.issuer);
  if (issuer.protocol !== 'https:' || issuer.origin + '/' !== value.issuer || issuer.username || issuer.password || issuer.port) throw new WorkspaceAuthError(503);
  return { configured: true, requiresAuthentication: value.requiresAuthentication,
    issuer: value.issuer, clientId: value.clientId, audience: value.audience };
}
export function getWorkspaceConfig(refresh = false): Promise<WorkspaceConfig> {
  if (refresh) configRequest = null;
  if (!configRequest) {
    const pending = (async () => {
      const response = await fetch('/api/reviewer-config', { cache: 'no-store', redirect: 'error', credentials: 'same-origin', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new WorkspaceAuthError(response.status);
      const config = readConfig(await response.json());
      currentConfig = config;
      return config;
    })();
    configRequest = pending;
    void pending.catch(() => { if (configRequest === pending) configRequest = null; });
  }
  return configRequest;
}
export function hasWorkspaceCallback(): boolean {
  const query = new URLSearchParams(window.location.search);
  return query.has('state') && (query.has('code') || query.has('error'));
}
function clearCallbackParameters() {
  const url = new URL(window.location.href);
  for (const key of ['code', 'state', 'error', 'error_description', 'iss']) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}
export async function getWorkspaceClient(config?: WorkspaceConfig): Promise<Auth0Client> {
  const selected = config ?? await getWorkspaceConfig();
  if (!selected.configured) throw new WorkspaceAuthError(503, 'Reviewer sign-in is not connected.');
  const key = JSON.stringify([selected.issuer, selected.clientId, selected.audience]);
  let pending = clients.get(key);
  if (!pending) {
    pending = (async () => {
      const { createAuth0Client } = await import('@auth0/auth0-spa-js');
      const client = await createAuth0Client({ domain: new URL(selected.issuer).hostname, clientId: selected.clientId,
        cacheLocation: 'memory', useRefreshTokens: false, httpTimeoutInSeconds: 10, authorizeTimeoutInSeconds: 10,
        authorizationParams: { audience: selected.audience, scope: 'openid review:reports', redirect_uri: window.location.origin + '/' } });
      if (hasWorkspaceCallback()) {
        try { await client.handleRedirectCallback(window.location.href); }
        finally { clearCallbackParameters(); }
      }
      // appState never chooses a navigation destination. The case UUID stays
      // available until the restored report mounts, after the gate completes.
      return client;
    })();
    clients.set(key, pending);
    void pending.catch(() => { if (clients.get(key) === pending) clients.delete(key); });
  }
  return pending;
}
export async function getWorkspaceAccessToken(refresh = false): Promise<string> {
  try {
    const token = await (await getWorkspaceClient()).getTokenSilently(refresh ? { cacheMode: 'off' } : undefined);
    if (typeof token !== 'string' || !token || token.length > 16_000) throw new WorkspaceAuthError(401);
    return token;
  } catch (error) {
    if (needsWorkspaceSignIn(error)) { notifyAccess(401); throw new WorkspaceAuthError(401, 'Please sign in again.'); }
    throw new WorkspaceAuthError(503, 'Reviewer sign-in is unavailable.');
  }
}
function apiPath(path: string): string {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/') || url.username || url.password) {
    throw new WorkspaceAuthError(400, 'Evidence requests must remain in this workspace.');
  }
  return url.pathname + url.search;
}
async function fetchApi(path: string, options: RequestInit, token?: string): Promise<Response> {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(apiPath(path), { ...options, headers, credentials: 'same-origin', redirect: 'error',
    cache: 'no-store', signal: options.signal ?? AbortSignal.timeout(30_000) });
  if (response.status === 401 || response.status === 403) notifyAccess(response.status);
  return response;
}
/** All callers remain same-origin; hosted mode adds its in-memory bearer. */
export async function authorizedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const target = apiPath(path);
  const config = await getWorkspaceConfig();
  const token = config.requiresAuthentication ? await getWorkspaceAccessToken() : undefined;
  return fetchApi(target, options, token);
}
/** Review routes require a reviewer token even in the ordinary local desk. */
export async function reviewerFetch(path: string, options: RequestInit = {}, refreshToken = false): Promise<Response> {
  const target = apiPath(path);
  return fetchApi(target, options, await getWorkspaceAccessToken(refreshToken));
}
export function getReviewerReturnReportId(): string | null {
  try { const id = window.sessionStorage.getItem(RETURN_REPORT_KEY); return id && UUID.test(id) ? id : null; }
  catch { return null; }
}
export function noteWorkspaceReport(id: string): void { if (UUID.test(id)) currentReportId = id; }
export function restoredWorkspaceReport(id: string): void {
  noteWorkspaceReport(id);
  if (getReviewerReturnReportId() === id) {
    try { window.sessionStorage.removeItem(RETURN_REPORT_KEY); } catch { /* No sensitive data is stored. */ }
  }
}
export async function signInToWorkspace(reportId = currentReportId): Promise<void> {
  if (reportId && UUID.test(reportId)) window.sessionStorage.setItem(RETURN_REPORT_KEY, reportId);
  await (await getWorkspaceClient()).loginWithRedirect({ appState: { returnTo: '/' }, authorizationParams: { redirect_uri: window.location.origin + '/' } });
}
export async function signOutOfWorkspace(): Promise<void> {
  await (await getWorkspaceClient()).logout({ openUrl: false });
  try { window.sessionStorage.removeItem(RETURN_REPORT_KEY); } catch { /* No token storage. */ }
  currentReportId = null;
  notifyAccess(401);
}

/** Local native links pass through. Hosted JSON is fetched with a bearer and
 * downloaded verbatim via a temporary blob URL, never a token-bearing URL. */
export function authenticatedDownload(event: MouseEvent<HTMLAnchorElement>, path: string): Promise<void> {
  let target: string;
  try { target = apiPath(path); }
  catch (error) { event.preventDefault(); return Promise.reject(error); }
  if (currentConfig && !currentConfig.requiresAuthentication) return Promise.resolve();
  event.preventDefault();
  const requestedName = event.currentTarget.download;
  return (async () => {
    const response = await authorizedFetch(target);
    if (!response.ok) throw new WorkspaceAuthError(response.status, 'Evidence could not be downloaded.');
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new WorkspaceAuthError(503, 'The evidence download was not a JSON report.');
    const disposition = response.headers.get('content-disposition')?.match(/filename="([^"\r\n]{1,200})"/i)?.[1];
    const base = (disposition || requestedName || 'vacancy-autopsy-evidence.json').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '') || 'vacancy-autopsy-evidence.json';
    const filename = base.toLowerCase().endsWith('.json') ? base : `${base}.json`;
    const objectUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = objectUrl; anchor.download = filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  })();
}
