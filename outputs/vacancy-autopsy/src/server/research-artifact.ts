import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResearchArtifact } from './research.js';
import { evidenceSchema, publicUrlSchema, reportIdSchema } from './schemas.js';

export const MAX_RESEARCH_ARTIFACT_BYTES = 4_000_000;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime();
const candidate = z.object({
  url: publicUrlSchema, title: z.string().max(300), snippet: z.string().max(1000),
  position: z.number().int().min(1).max(1000),
  source: z.enum(['official_posting_candidate', 'advertisement_candidate']),
}).strict();
const projection = z.object({ query: z.string().min(3).max(240), candidates: z.array(candidate).max(10) }).strict();
const discovery = z.object({
  provider: z.literal('serpapi'), status: z.enum(['success', 'not_configured', 'failed', 'cancelled']),
  query: z.string().min(3).max(240), capturedAt: instant, candidates: z.array(candidate).max(10),
  provenance: z.object({ searchId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(), requestCount: z.literal(1),
    projectionBody: z.string(), projectionSha256: digest }).strict().optional(),
  detail: z.string().max(2000), limitations: z.array(z.string().max(4000)).max(40),
}).strict();
const screenshot = z.object({
  mediaType: z.literal('image/png'), base64: z.string().min(12).max(1_400_000),
  sha256: digest, byteLength: z.number().int().min(8).max(1_000_000),
}).strict();
const capture = z.object({
  provider: z.literal('browserbase'), status: z.enum(['captured', 'blocked', 'failed', 'not_configured', 'cancelled']),
  requestedUrl: publicUrlSchema, capturedAt: instant, detail: z.string().max(2000),
  limitations: z.array(z.string().max(4000)).max(40),
  evidence: evidenceSchema.extend({ kind: z.literal('browser_capture'), id: z.string().min(1).max(200),
    body: z.string().min(1), summary: z.string().max(4000) }).strict().optional(),
  screenshot: screenshot.optional(), officialLinks: z.array(publicUrlSchema).max(80).optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  cleanup: z.enum(['released', 'release_failed']).optional(),
}).strict();
const metadata = { id: reportIdSchema, createdAt: instant };
const artifactSchema = z.discriminatedUnion('kind', [
  z.object({ ...metadata, kind: z.literal('discovery'), result: discovery }).strict(),
  z.object({ ...metadata, kind: z.literal('browser_capture'), result: capture }).strict(),
]);
const hash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Validate retained bytes and metadata, without claiming their source is truthful. */
export function validatedResearchArtifact(record: unknown): ResearchArtifact {
  const encoded = JSON.stringify(record);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_RESEARCH_ARTIFACT_BYTES) {
    throw new Error('Artifact exceeds its storage budget.');
  }
  const checked = artifactSchema.parse(record);
  if (checked.kind === 'discovery') {
    const { result } = checked;
    if (result.status === 'success' && !result.provenance) throw new Error('Successful discovery requires retained provenance.');
    if (result.provenance) {
      if (hash(result.provenance.projectionBody) !== result.provenance.projectionSha256) throw new Error('Discovery body hash mismatch.');
      const retained = projection.parse(JSON.parse(result.provenance.projectionBody));
      if (JSON.stringify(retained) !== JSON.stringify(projection.parse({ query: result.query, candidates: result.candidates }))) {
        throw new Error('Discovery metadata differs from its retained body.');
      }
    }
  } else {
    const { result } = checked;
    if (result.status === 'captured' && !result.evidence) throw new Error('Captured source requires retained evidence.');
    if (result.evidence && (hash(result.evidence.body) !== result.evidence.sha256 || result.evidence.capturedAt !== result.capturedAt)) {
      throw new Error('Browser evidence body hash or capture timestamp mismatch.');
    }
    if (result.screenshot) {
      const image = Buffer.from(result.screenshot.base64, 'base64');
      if (image.toString('base64') !== result.screenshot.base64 || image.byteLength !== result.screenshot.byteLength ||
          !image.subarray(0, 8).equals(pngSignature) || hash(image) !== result.screenshot.sha256) {
        throw new Error('Screenshot bytes, length, or hash mismatch.');
      }
    }
  }
  return checked;
}
