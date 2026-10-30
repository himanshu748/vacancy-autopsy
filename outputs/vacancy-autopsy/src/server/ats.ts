import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Evidence, Verdict } from '../shared/types.js';
import { parseIdentity, sameIdentity } from './identity.js';
import type { Identity } from './schemas.js';

export type Fetcher = typeof fetch;
export interface FeedResult {
  verdict: Verdict;
  title?: string;
  explanation: string;
  limitations: string[];
  evidence: Evidence[];
  checkedAt: string;
}

const MAX_BYTES = 2_000_000;
const MAX_REQUESTS = 10;
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 25000;
const hosts = new Set(['boards-api.greenhouse.io', 'api.lever.co', 'api.eu.lever.co', 'api.ashbyhq.com']);
const greenhouseSchema = z.object({
  jobs: z.array(z.object({ id: z.number().int().nonnegative().safe(), title: z.string().min(1),
    absolute_url: z.string().url() })),
  meta: z.object({ total: z.number().int().nonnegative().safe() }),
});
const leverPostingSchema = z.object({ id: z.string().uuid(), text: z.string().min(1), hostedUrl: z.string().url() });
const leverSchema = z.array(leverPostingSchema);
const ashbySchema = z.object({ apiVersion: z.literal('1'), jobs: z.array(z.object({
  title: z.string().min(1), jobUrl: z.string().url(), isListed: z.boolean(),
})) });

class CheckFailure extends Error {}

export function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function endpoint(identity: Identity, skip = 0): string {
  if (identity.ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${identity.board}/jobs`;
  if (identity.ats === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${identity.board}`;
  const host = identity.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  return `https://${host}/v0/postings/${identity.board}?mode=json&limit=${PAGE_SIZE}&skip=${skip}`;
}

/** Network is deliberately limited to static public ATS API hosts, GETs, no redirects. */
export async function verifyFeed(identity: Identity, options: { fetcher?: Fetcher; signal?: AbortSignal } = {}): Promise<FeedResult> {
  const fetcher = options.fetcher ?? fetch;
  const evidence: Evidence[] = [];
  const limitations = [
    'This is a timestamped public job-board observation, not evidence of employer intent or a guarantee that applications will be reviewed.',
    `The board token “${identity.board}” comes from the supplied ATS URL; company-domain ownership has not been independently confirmed.`,
    'Application submission was not attempted. A public posting may be paused internally or change after this check.',
  ];
  const totalSignal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  let bytesRead = 0;
  const notFound = Symbol('not-found');

  async function get(url: string, allowNotFound = false): Promise<unknown> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname) || parsed.port || parsed.username || parsed.password) {
      throw new CheckFailure('The source request did not match the public API allowlist.');
    }
    const signal = AbortSignal.any([totalSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal,
      headers: { accept: 'application/json', 'user-agent': 'VacancyAutopsy/0.1 (public job-board verification)' } });
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_BYTES - bytesRead) {
      await response.body?.cancel();
      throw new CheckFailure('The public board response exceeds the evidence size budget.');
    }
    if (!response.body) throw new CheckFailure('The source returned no response body.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytesRead += part.value.byteLength;
        if (bytesRead > MAX_BYTES) {
          await reader.cancel();
          throw new CheckFailure('The public board response exceeds the evidence size budget.');
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let body: string;
    try { body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
    catch { throw new CheckFailure('The source returned invalid UTF-8. No finding was inferred from a modified response.'); }
    evidence.push({ id: randomUUID(), kind: 'official_feed', url, capturedAt: new Date().toISOString(),
      sha256: hashBody(body), body, httpStatus: response.status,
      summary: `Public ${identity.ats} board response for ${identity.board}; HTTP ${response.status}.` });
    if (allowNotFound && response.status === 404) return notFound;
    if (!response.ok) throw new CheckFailure(`The official source returned HTTP ${response.status}. An access error or missing board cannot establish whether this opening is active.`);
    if (!response.headers.get('content-type')?.toLowerCase().includes('json')) {
      throw new CheckFailure('The source did not return a JSON job feed; no absence was inferred.');
    }
    try { return JSON.parse(body); } catch { throw new CheckFailure('The source returned malformed JSON; no absence was inferred.'); }
  }

  try {
    let jobs: { id: string; title: string; url: string; listed: boolean }[] = [];
    if (identity.ats === 'greenhouse') {
      const result = greenhouseSchema.safeParse(await get(endpoint(identity)));
      if (!result.success) throw new CheckFailure('The Greenhouse response does not match the complete public-board schema.');
      if (result.data.jobs.length !== result.data.meta.total) throw new CheckFailure('The Greenhouse result count is incomplete; absence cannot be established.');
      jobs = result.data.jobs.map((job) => ({ id: String(job.id), title: job.title, url: job.absolute_url, listed: true }));
    } else if (identity.ats === 'ashby') {
      const result = ashbySchema.safeParse(await get(endpoint(identity)));
      if (!result.success) throw new CheckFailure('The Ashby response does not match the published-board schema.');
      jobs = result.data.jobs.map((job) => {
        const parsed = parseIdentity(job.jobUrl);
        if (!parsed || parsed.ats !== 'ashby' || parsed.board !== identity.board) {
          throw new CheckFailure('An Ashby posting could not be resolved to this board. The feed was not treated as complete.');
        }
        return { id: parsed.jobId, title: job.title, url: job.jobUrl, listed: job.isListed };
      });
    } else {
      // A positive observation needs only the exact public posting. Absence
      // still needs the complete board; a 404 alone is never a closure claim.
      const host = identity.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
      const direct = await get(`https://${host}/v0/postings/${identity.board}/${identity.jobId}?mode=json`, true);
      if (direct !== notFound) {
        const posting = leverPostingSchema.safeParse(direct);
        if (!posting.success || posting.data.id.toLowerCase() !== identity.jobId || !sameIdentity(identity, parseIdentity(posting.data.hostedUrl))) {
          throw new CheckFailure('The exact Lever posting response does not match the requested job identity.');
        }
        return { verdict: 'verified_open', title: posting.data.text, evidence, limitations,
          explanation: `The exact posting ID ${identity.jobId} was returned by the public Lever posting API.`,
          checkedAt: new Date().toISOString() };
      }
      let complete = false;
      for (let page = 0; page < MAX_REQUESTS; page++) {
        const result = leverSchema.safeParse(await get(endpoint(identity, page * PAGE_SIZE)));
        if (!result.success || result.data.length > PAGE_SIZE) throw new CheckFailure('The Lever page does not match the expected paginated feed.');
        jobs.push(...result.data.map((job) => ({ id: job.id.toLowerCase(), title: job.text, url: job.hostedUrl, listed: true })));
        if (result.data.length < PAGE_SIZE) { complete = true; break; }
      }
      if (!complete) throw new CheckFailure('The Lever board exceeded the bounded pagination budget. Its full public inventory was not checked.');
      limitations.push('Lever uses offset pagination. The public board may change while pages are collected.');
    }
    if (new Set(jobs.map((job) => job.id)).size !== jobs.length) throw new CheckFailure('Duplicate posting IDs suggest an unstable or malformed feed; no complete-board verdict was inferred.');
    const found = jobs.find((job) => job.id === identity.jobId);
    if (found) {
      const linkedIdentity = parseIdentity(found.url);
      // Greenhouse employers can use custom career-site URLs, so the documented
      // board/id pair is authoritative there. Other adapters expose hosted URLs.
      if (identity.ats !== 'greenhouse' && !sameIdentity(identity, linkedIdentity)) {
        throw new CheckFailure('The matched posting URL disagrees with the requested board or job identity.');
      }
      if (!found.listed) return { verdict: 'inconclusive', title: found.title, evidence, limitations,
        explanation: 'This exact Ashby posting exists but is marked unlisted and available by direct link only. Unlisted does not mean closed.',
        checkedAt: new Date().toISOString() };
      return { verdict: 'verified_open', title: found.title, evidence, limitations,
        explanation: `The exact posting ID ${identity.jobId} is present in the checked public ${identity.ats} board.`,
        checkedAt: new Date().toISOString() };
    }
    return { verdict: 'not_listed', evidence, limitations: [...limitations,
      'There is no prior positive observation in this report. This ID may have never existed, moved, been reposted, or been removed.'],
      explanation: `Posting ID ${identity.jobId} was not found among ${jobs.length} postings in the complete response from this public board. This does not prove the role is closed or that the advertisement is fraudulent.`,
      checkedAt: new Date().toISOString() };
  } catch (error) {
    const explanation = error instanceof CheckFailure ? error.message :
      options.signal?.aborted ? 'The investigation was cancelled before verification completed.' :
      totalSignal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) ?
        'The official source check exceeded its time budget. Please recheck later.' :
        'The official source could not be reached without following a redirect or encountering a network failure. Please recheck later.';
    return { verdict: 'inconclusive', explanation, limitations, evidence, checkedAt: new Date().toISOString() };
  }
}
