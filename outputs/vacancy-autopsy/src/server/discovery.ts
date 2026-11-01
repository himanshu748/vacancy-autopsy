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

const candidateSchema = z.object({
  link: z.string().max(4096), title: z.string().max(1000),
  snippet: z.string().max(8000).optional().catch(undefined),
  position: z.number().int().min(1).max(1000).optional().catch(undefined),
});
const organicRowSchema = z.object({
  link: z.unknown().optional(), title: z.unknown().optional(), snippet: z.unknown().optional(),
  position: z.unknown().optional(),
  sitelinks: z.object({ inline: z.unknown().optional(), expanded: z.unknown().optional(),
    list: z.unknown().optional() }).optional().catch(undefined),
});
const responseSchema = z.object({
  search_metadata: z.object({ status: z.literal('Success'), id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() }),
  organic_results: z.array(z.unknown()).transform((rows) => rows.slice(0, 100)).optional(),
  search_information: z.object({ total_results: z.number().nonnegative().optional(), organic_results_state: z.string().optional() }).optional(),
  error: z.unknown().optional(),
});

/** One search request, no retries/pagination. Search snippets never establish a job's state. */
export async function discoverJobs(rawInput: unknown, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const input = discoveryInputSchema.parse(rawInput);
  const base = { provider: 'serpapi' as const, query: input.query, capturedAt: new Date().toISOString(), candidates: [],
    limitations: ['Search results and snippets are discovery leads, not browser captures or evidence that an opening is active.',
      'One first-page Google search is requested. Search coverage is incomplete and can reflect an earlier cached result.',
      'Only the first 100 organic rows and first 100 documented organic sitelinks are inspected. Up to ten unique leads are retained, with exact supported ATS URLs first.',
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
    const discovered: DiscoveryCandidate[] = [];
    const seen = new Set<string>();
    const redact = (value: string) => value.replaceAll(key, '[REDACTED]');
    const addCandidate = (raw: unknown, position: number) => {
      const candidate = candidateSchema.safeParse(raw);
      if (!candidate.success) return;
      const result = candidate.data;
      const valid = publicUrlSchema.safeParse(result.link);
      if (!valid.success) return;
      const target = new URL(valid.data);
      target.search = ''; target.hash = '';
      const normalized = target.href;
      if (seen.has(normalized) || normalized.includes(key)) return;
      seen.add(normalized);
      discovered.push({ url: normalized, title: redact(result.title).slice(0, 300),
        snippet: redact(result.snippet ?? '').slice(0, 1000), position,
        source: parseIdentity(normalized) ? 'official_posting_candidate' : 'advertisement_candidate' });
    };
    let inspectedSitelinks = 0;
    for (const [index, raw] of (parsed.organic_results ?? []).entries()) {
      const row = organicRowSchema.safeParse(raw);
      if (!row.success) continue;
      const result = row.data;
      const position = candidateSchema.shape.position.parse(result.position) ?? index + 1;
      addCandidate(result, position);
      // SerpApi documents these three organic-result sitelink arrays. Do not
      // traverse arbitrary metadata, redirect links, or nested provider URLs.
      for (const group of ['inline', 'expanded', 'list'] as const) {
        const links = result.sitelinks?.[group];
        if (!Array.isArray(links)) continue;
        for (const link of links.slice(0, 100 - inspectedSitelinks)) {
          inspectedSitelinks++;
          addCandidate(link, position);
        }
      }
    }
    // Stable provider order within each group; board roots cannot crowd an exact
    // supported posting out of the ten retained leads.
    const candidates = [...discovered.filter((candidate) => candidate.source === 'official_posting_candidate'),
      ...discovered.filter((candidate) => candidate.source === 'advertisement_candidate')].slice(0, 10);
    // Retain only a declared projection. Raw provider metadata can contain private
    // endpoint URLs; never persist a request URL carrying the API key.
    const projectionBody = JSON.stringify({ query: input.query, candidates });
    const searchId = parsed.search_metadata.id?.includes(key) ? undefined : parsed.search_metadata.id;
    return { ...base, status: 'success', candidates, detail: `${candidates.length} source candidates discovered; none has been verified.`,
      provenance: { ...(searchId ? { searchId } : {}), requestCount: 1, projectionBody,
        projectionSha256: createHash('sha256').update(projectionBody).digest('hex') } };
  } catch {
    return { ...base, status: options.signal?.aborted ? 'cancelled' : 'failed',
      detail: options.signal?.aborted ? 'Discovery was cancelled.' : 'SerpApi did not return a usable search within the request budget. No source finding was inferred.' };
  }
}
