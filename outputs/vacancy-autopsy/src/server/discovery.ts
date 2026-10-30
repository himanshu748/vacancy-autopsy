import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseIdentity } from './identity.js';
import { publicUrlSchema } from './schemas.js';

export const discoveryInputSchema = z.object({
  query: z.string().trim().min(3).max(240).refine((value) => !/[\x00-\x1f]/.test(value), 'Use a single-line public job search.'),
}).strict();
export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
export interface DiscoveryCandidate {
  url: string;
  title: string;
  snippet: string;
  position: number;
  source: 'official_posting_candidate' | 'advertisement_candidate';
}
export interface DiscoveryResult {
  provider: 'serpapi';
  status: 'success' | 'not_configured' | 'failed' | 'cancelled';
  query: string;
  capturedAt: string;
  candidates: DiscoveryCandidate[];
  provenance?: { searchId?: string; requestCount: 1; projectionBody: string; projectionSha256: string };
  detail: string;
  limitations: string[];
}
export interface DiscoveryOptions { apiKey?: string; fetcher?: typeof fetch; signal?: AbortSignal }

const responseSchema = z.object({
  search_metadata: z.object({ status: z.literal('Success'), id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() }),
  organic_results: z.array(z.object({ link: z.string().max(4096), title: z.string().max(1000),
    snippet: z.string().max(8000).optional(), position: z.number().int().min(1).max(1000).optional() })).max(100).optional(),
  search_information: z.object({ total_results: z.number().nonnegative().optional(), organic_results_state: z.string().optional() }).optional(),
  error: z.unknown().optional(),
});

/** One search request, no retries/pagination. Search snippets never establish a job's state. */
export async function discoverJobs(rawInput: unknown, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const input = discoveryInputSchema.parse(rawInput);
  const base = { provider: 'serpapi' as const, query: input.query, capturedAt: new Date().toISOString(), candidates: [],
    limitations: ['Search results and snippets are discovery leads, not browser captures or evidence that an opening is active.',
      'One first-page Google search is requested. Search coverage is incomplete and can reflect an earlier cached result.',
      'Result URL queries and fragments are discarded. No advertised employer or source linkage is inferred from ranking.'] };
  const key = options.apiKey?.trim();
  if (!key) return { ...base, status: 'not_configured', detail: 'SerpApi discovery is unavailable until SERPAPI_API_KEY is configured.' };
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', input.query);
  url.searchParams.set('api_key', key);
  url.searchParams.set('start', '0');
  url.searchParams.set('no_cache', 'false');
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]);
  try {
    const response = await (options.fetcher ?? fetch)(url, { method: 'GET', redirect: 'error', signal,
      headers: { accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Provider request failed.'); }
    if (!response.headers.get('content-type')?.toLowerCase().includes('json') || !response.body) {
      await response.body?.cancel(); throw new Error('Provider response was not JSON.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1_000_000) { await reader.cancel(); throw new Error('Search response exceeded its budget.'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const parsed = responseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    if (parsed.error !== undefined || (!parsed.organic_results && parsed.search_information?.total_results !== 0 &&
      parsed.search_information?.organic_results_state !== 'Fully empty')) throw new Error('Search was incomplete.');
    const candidates: DiscoveryCandidate[] = [];
    const seen = new Set<string>();
    const redact = (value: string) => value.replaceAll(key, '[REDACTED]');
    for (const result of parsed.organic_results ?? []) {
      if (candidates.length === 10) break;
      const valid = publicUrlSchema.safeParse(result.link);
      if (!valid.success) continue;
      const target = new URL(valid.data);
      target.search = ''; target.hash = '';
      const normalized = target.href;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      candidates.push({ url: normalized, title: redact(result.title).slice(0, 300),
        snippet: redact(result.snippet ?? '').slice(0, 1000), position: result.position ?? candidates.length + 1,
        source: parseIdentity(normalized) ? 'official_posting_candidate' : 'advertisement_candidate' });
    }
    // Retain only a declared projection. Raw provider metadata can contain private
    // endpoint URLs; never persist a request URL carrying the API key.
    const projectionBody = JSON.stringify({ query: input.query, candidates });
    const searchId = parsed.search_metadata.id === key ? undefined : parsed.search_metadata.id;
    return { ...base, status: 'success', candidates, detail: `${candidates.length} source candidates discovered; none has been verified.`,
      provenance: { ...(searchId ? { searchId } : {}), requestCount: 1, projectionBody,
        projectionSha256: createHash('sha256').update(projectionBody).digest('hex') } };
  } catch {
    return { ...base, status: options.signal?.aborted ? 'cancelled' : 'failed',
      detail: options.signal?.aborted ? 'Discovery was cancelled.' : 'SerpApi did not return a usable search within the request budget. No source finding was inferred.' };
  }
}
