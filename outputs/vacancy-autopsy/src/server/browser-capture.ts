import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Evidence } from '../shared/types.js';
import { parseIdentity } from './identity.js';
import { publicUrlSchema } from './schemas.js';

/** Deliberately fixed: arbitrary domains are not browser destinations in this MVP. */
export const CAPTURE_HOSTS = Object.freeze(['www.employbl.com', 'employbl.com', 'www.oppidx.com', 'oppidx.com', 'job-boards.greenhouse.io',
  'boards.greenhouse.io', 'jobs.lever.co', 'jobs.eu.lever.co', 'jobs.ashbyhq.com']);
const RESOURCE_HOSTS = new Set([...CAPTURE_HOSTS, 'boards-api.greenhouse.io', 'api.lever.co', 'api.eu.lever.co', 'api.ashbyhq.com']);
export const captureInputSchema = z.object({ url: publicUrlSchema.refine((value) =>
  CAPTURE_HOSTS.includes(new URL(value).hostname), 'Browser capture supports the listed job-board hosts only.') }).strict();

export interface CaptureArtifact {
  mediaType: 'image/png';
  base64: string;
  sha256: string;
  byteLength: number;
}
export interface BrowserCaptureResult {
  provider: 'browserbase';
  status: 'captured' | 'blocked' | 'failed' | 'not_configured' | 'cancelled';
  requestedUrl: string;
  capturedAt: string;
  detail: string;
  limitations: string[];
  evidence?: Evidence;
  screenshot?: CaptureArtifact;
  officialLinks?: string[];
  sessionId?: string;
  cleanup?: 'released' | 'release_failed';
}
export interface CdpEvent { params: Record<string, unknown>; sessionId?: string }
export interface CdpConnection {
  command(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  on(method: string, listener: (event: CdpEvent) => void): () => void;
  close(): void;
}
export type HostResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
export interface BrowserCaptureOptions {
  apiKey?: string;
  projectId?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  resolver?: HostResolver;
  /** Test seam; production uses a native WebSocket to the validated vendor CDP URL. */
  connect?: (url: string, signal: AbortSignal) => Promise<CdpConnection>;
}
const sha = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const publicResolver: HostResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });
let activeCaptures = 0;

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
      !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
  }
  if (version === 6) {
    const [firstText, secondText] = address.toLowerCase().split(':');
    const first = parseInt(firstText, 16);
    const second = parseInt(secondText || '0', 16);
    // Allow global-unicast only, excluding documentation and special-use space.
    return first >= 0x2000 && first <= 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && first !== 0x2002 &&
      !(first === 0x3fff && second < 0x1000);
  }
  return false;
}

function cleanUrl(value: string): string {
  const url = new URL(publicUrlSchema.parse(value));
  url.search = ''; url.hash = '';
  return url.href;
}

async function assertPublicHost(hostname: string, resolver: HostResolver, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answers = await Promise.race([
    resolver(hostname),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS budget exceeded.')), 2500); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (signal.aborted || !answers.length || answers.some((answer) => !isPublicAddress(answer.address))) throw new Error('Public DNS validation failed.');
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.headers.get('content-type')?.includes('json') || !response.body) {
    await response.body?.cancel(); throw new Error('Browser provider request failed.');
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64_000) { await reader.cancel(); throw new Error('Browser provider response exceeded its budget.'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

/** Credentials in connectUrl are kept in memory and sent only to Browserbase. */
async function connectCdp(url: string, signal: AbortSignal): Promise<CdpConnection> {
  const socket = new WebSocket(url);
  let sequence = 0;
  const listeners = new Map<string, Set<(event: CdpEvent) => void>>();
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const close = () => {
    socket.close();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser connection closed.')); }
    pending.clear();
  };
  socket.addEventListener('close', close);
  signal.addEventListener('abort', close, { once: true });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || event.data.length > 2_000_000) { close(); return; }
    try {
      const message = JSON.parse(event.data) as { id?: number; result?: Record<string, unknown>; error?: unknown;
        method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (typeof message.id === 'number') {
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); pending.delete(message.id);
        if (message.error) request.reject(new Error('A browser protocol command failed.'));
        else request.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of listeners.get(message.method) ?? []) listener({ params: message.params ?? {}, sessionId: message.sessionId });
      }
    } catch { close(); }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { close(); reject(new Error('Browser connect budget exceeded.')); }, 8000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); close(); reject(new Error('Browser connection failed.')); }, { once: true });
    signal.addEventListener('abort', () => { clearTimeout(timer); close(); reject(new Error('Browser capture cancelled.')); }, { once: true });
  });
  return {
    command(method, params = {}, sessionId) {
      if (signal.aborted || socket.readyState !== WebSocket.OPEN || pending.size >= 128) return Promise.reject(new Error('Browser connection unavailable.'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser command exceeded its time budget.')); }, 8000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(method, listener) {
      const bucket = listeners.get(method) ?? new Set();
      bucket.add(listener); listeners.set(method, bucket);
      return () => { bucket.delete(listener); };
    },
    close,
  };
}

const snapshotSchema = z.object({ url: z.string().max(4096), title: z.string().max(300),
  text: z.string().max(16000), links: z.array(z.string().max(2048)).max(80) });
const SNAPSHOT_EXPRESSION = `JSON.stringify({url:location.href,title:document.title.slice(0,300),text:(document.body?.innerText||'').slice(0,16000),links:Array.from(document.querySelectorAll('a[href]')).slice(0,80).map(a=>a.href.slice(0,2048))})`;

/** Static/no-JS browser observation. Never submits applications or solves access restrictions. */
export async function captureAdvertisement(rawInput: unknown, options: BrowserCaptureOptions = {}): Promise<BrowserCaptureResult> {
  const input = captureInputSchema.parse(rawInput);
  const requestedUrl = cleanUrl(input.url);
  const base = { provider: 'browserbase' as const, requestedUrl, capturedAt: new Date().toISOString(),
    limitations: ['This is a restricted static-browser observation: page JavaScript is disabled, and dynamic application state is not verified.',
      'Only fixed trusted hosts and GET requests are allowed. Other resources are blocked, so styling or content may be incomplete.',
      'The observation retains at most 16,000 text characters, the first 80 anchor links, and a viewport screenshot below 1 MB; it is not a complete page archive.',
      'DOM text and links are untrusted page content. A linked ATS URL is a candidate, not independent proof of employer ownership or an active opening.',
      'Application submission, authentication, CAPTCHA solving, proxies and stealth modes were not used.',
      'Local public-IP checks do not pin Browserbase DNS. Fixed trusted hosts, provider main-frame policy and CDP request interception are used together.'] };
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return { ...base, status: 'not_configured', detail: 'Remote capture is unavailable until BROWSERBASE_API_KEY is configured.' };
  if (activeCaptures >= 1) return { ...base, status: 'failed', detail: 'The single remote capture slot is busy. Retry after the current capture finishes.' };
  activeCaptures++;
  let sessionId: string | undefined;
  let cdp: CdpConnection | undefined;
  let result: BrowserCaptureResult = { ...base, status: 'failed', detail: 'The remote browser did not produce usable evidence within its budget.' };
  const signal = AbortSignal.any([AbortSignal.timeout(35_000), ...(options.signal ? [options.signal] : [])]);
  const resolver = options.resolver ?? publicResolver;
  const fetcher = options.fetcher ?? fetch;
  const projectId = options.projectId?.trim();
  const api = async (path: string, body: object, release = false) => fetcher(`https://api.browserbase.com/v1/sessions${path}`, {
    method: 'POST', redirect: 'error', signal: release ? AbortSignal.timeout(8000) : AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: { 'content-type': 'application/json', 'X-BB-API-Key': apiKey }, body: JSON.stringify(body),
  });
  try {
    await assertPublicHost(new URL(requestedUrl).hostname, resolver, signal);
    const created = await readJson(await api('', { ...(projectId ? { projectId } : {}), timeout: 60, keepAlive: false, proxies: false,
      browserSettings: { viewport: { width: 1280, height: 900 }, solveCaptchas: false, advancedStealth: false,
        verified: false, ignoreCertificateErrors: false, recordSession: true, logSession: true, allowedDomains: CAPTURE_HOSTS } }));
    sessionId = z.object({ id: sessionIdSchema }).parse(created).id;
    const record = z.object({ connectUrl: z.string().url() }).parse(created);
    const connectUrl = new URL(record.connectUrl);
    if (connectUrl.protocol !== 'wss:' || connectUrl.username || connectUrl.password || connectUrl.port ||
      !(connectUrl.hostname === 'connect.browserbase.com' || connectUrl.hostname.endsWith('.browserbase.com'))) throw new Error('Invalid browser transport host.');
    cdp = await (options.connect ?? connectCdp)(record.connectUrl, signal);
    const target = z.object({ targetId: z.string().min(1).max(200) }).parse(await cdp.command('Target.createTarget', { url: 'about:blank' }));
    const attached = z.object({ sessionId: z.string().min(1).max(200) }).parse(await cdp.command('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
    const sid = attached.sessionId;
    await cdp.command('Emulation.setScriptExecutionDisabled', { value: true }, sid);
    await cdp.command('Network.setBypassServiceWorker', { bypass: true }, sid);
    await cdp.command('Page.enable', {}, sid);
    await cdp.command('Network.enable', {}, sid);
    const checkedHosts = new Set([new URL(requestedUrl).hostname]);
    let blockedRequests = 0;
    let observedRequests = 0;
    let interceptionFailed = false;
    let mainFrameId: string | undefined;
    const documentStatuses = new Map<string, number>();
    cdp.on('Network.responseReceived', (event) => {
      if (event.sessionId !== sid || event.params.type !== 'Document') return;
      const response = event.params.response as { status?: unknown } | undefined;
      if (typeof response?.status === 'number' && typeof event.params.frameId === 'string') documentStatuses.set(event.params.frameId, response.status);
    });
    cdp.on('Fetch.requestPaused', (event) => {
      if (event.sessionId !== sid) return;
      void (async () => {
        const parsed = z.object({ requestId: z.string(), request: z.object({ url: z.string(), method: z.string() }) }).parse(event.params);
        let allow = false;
        try {
          const url = new URL(publicUrlSchema.parse(parsed.request.url));
          if (++observedRequests <= 80 && parsed.request.method === 'GET' && RESOURCE_HOSTS.has(url.hostname)) {
            if (!checkedHosts.has(url.hostname)) { await assertPublicHost(url.hostname, resolver, signal); checkedHosts.add(url.hostname); }
            allow = true;
          }
        } catch { /* Default deny, including redirects and non-HTTPS resource URLs. */ }
        if (!allow) blockedRequests++;
        await cdp!.command(allow ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          allow ? { requestId: parsed.requestId } : { requestId: parsed.requestId, errorReason: 'BlockedByClient' }, sid);
      })().catch(() => { interceptionFailed = true; cdp?.close(); });
    });
    await cdp.command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid);
    let removeLoadListener: (() => void) | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Promise<void>((resolve, reject) => {
      removeLoadListener = cdp!.on('Page.domContentEventFired', (event) => { if (event.sessionId === sid) resolve(); });
      loadTimer = setTimeout(() => reject(new Error('Page load budget exceeded.')), 15_000);
    });
    // Attach the rejection handler before navigating, so an early navigation
    // error cannot leave an unhandled load timeout behind.
    void loaded.catch(() => {});
    try {
      const navigation = await cdp.command('Page.navigate', { url: requestedUrl }, sid);
      if (navigation.errorText) throw new Error('Page navigation was blocked.');
      mainFrameId = z.object({ frameId: z.string() }).parse(navigation).frameId;
      await loaded;
    } finally { removeLoadListener?.(); if (loadTimer) clearTimeout(loadTimer); }
    await cdp.command('Page.stopLoading', {}, sid);
    const evaluated = await cdp.command('Runtime.evaluate', { expression: SNAPSHOT_EXPRESSION, returnByValue: true }, sid);
    const serialized = z.object({ result: z.object({ value: z.string().max(200_000) }) }).parse(evaluated).result.value;
    const snapshot = snapshotSchema.parse(JSON.parse(serialized));
    const finalUrl = cleanUrl(snapshot.url);
    if (!CAPTURE_HOSTS.includes(new URL(finalUrl).hostname) || interceptionFailed) throw new Error('Capture origin could not be verified.');
    const officialLinks = [...new Set(snapshot.links.flatMap((link) => {
      try { const clean = cleanUrl(link); return parseIdentity(clean) ? [clean] : []; } catch { return []; }
    }))];
    const capturedAt = new Date().toISOString();
    const httpStatus = mainFrameId ? documentStatuses.get(mainFrameId) : undefined;
    const body = JSON.stringify({ requestedUrl, url: finalUrl, title: snapshot.title, text: snapshot.text,
      officialLinks, pageJavaScript: 'disabled', blockedRequests, observedRequests });
    const challengeHeading = /^(?:verify (?:that )?you are human|access denied|captcha challenge|complete the captcha|checking your browser|just a moment)\b/i;
    const blocked = [401, 403, 407, 429].includes(httpStatus ?? 0) ||
      challengeHeading.test(snapshot.title.trim()) || challengeHeading.test(snapshot.text.trim());
    result = { ...base, capturedAt, sessionId, status: blocked ? 'blocked' : snapshot.text.trim() ? 'captured' : 'failed', officialLinks,
      detail: blocked ? 'The page exposed an access restriction. It was captured without attempting to bypass it.' :
        snapshot.text.trim() ? 'Restricted static browser text and links were captured. Dynamic application state remains unverified.' : 'The static page exposed no readable text; no job-state finding was inferred.',
      evidence: { id: randomUUID(), kind: 'browser_capture', url: finalUrl, capturedAt, sha256: sha(body), body,
        ...(httpStatus ? { httpStatus } : {}), summary: 'Restricted no-JavaScript browser DOM observation; not an application-state verdict.' } };
    const image = await cdp.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
    if (typeof image.data === 'string' && image.data.length <= 1_400_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.length <= 1_000_000 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        result.screenshot = { mediaType: 'image/png', base64: image.data, byteLength: bytes.length, sha256: sha(bytes) };
      }
    }
    if (!result.screenshot) result.limitations.push('The screenshot exceeded the image budget or was invalid; only the retained DOM observation is available.');
  } catch {
    if (!result.evidence) result = { ...base, status: options.signal?.aborted ? 'cancelled' : 'failed', ...(sessionId ? { sessionId } : {}),
      detail: options.signal?.aborted ? 'Remote capture was cancelled.' : 'The remote browser did not produce usable evidence within its safety and time budgets. No job-state finding was inferred.' };
    else result.limitations.push('Screenshot capture did not complete; the earlier DOM observation was retained.');
  } finally {
    try { cdp?.close(); } catch { /* Release must still be attempted if transport close fails. */ }
    if (sessionId) {
      try {
        const released = z.object({ id: sessionIdSchema, status: z.enum(['COMPLETED', 'TIMED_OUT', 'ERROR', 'PENDING', 'RUNNING']) })
          .parse(await readJson(await api(`/${sessionId}`, { status: 'REQUEST_RELEASE', ...(projectId ? { projectId } : {}) }, true)));
        result.cleanup = released.id === sessionId && ['COMPLETED', 'TIMED_OUT', 'ERROR'].includes(released.status) ? 'released' : 'release_failed';
      } catch { result.cleanup = 'release_failed'; }
      if (result.cleanup === 'release_failed') result.limitations.push('Session release could not be confirmed. Its requested provider timeout is 60 seconds.');
    }
    activeCaptures--;
  }
  return result;
}
