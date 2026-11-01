import { z } from 'zod';
import type { Evidence, InvestigationInput } from '../shared/types.js';
import type { ArtifactStore } from './research.js';
import { validatedResearchArtifact } from './research-artifact.js';
import { CAPTURE_HOSTS } from './browser-capture.js';
import { parseIdentity, sameIdentity } from './identity.js';
import { publicUrlSchema, type Identity } from './schemas.js';
import { uniquePostingIdentity } from '../shared/posting-identity.js';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const snapshotSchema = z.object({
  requestedUrl: publicUrlSchema, url: publicUrlSchema,
  title: z.string().max(300), text: z.string().min(1).max(16000),
  officialLinks: z.array(publicUrlSchema).max(80), pageJavaScript: z.literal('disabled'),
  blockedRequests: z.number().int().min(0).max(10000), observedRequests: z.number().int().min(1).max(10000),
}).strict();

export class CaptureLinkageError extends Error {
  readonly statusCode = 409;
  constructor() {
    super('This saved browser capture cannot support this check. Capture the advertisement again, then select its unique posting link.');
  }
}
export interface CapturedLinkage {
  identity: Identity;
  evidence: Evidence;
  limitations: string[];
}
function canonical(raw: string): string {
  const url = new URL(publicUrlSchema.parse(raw));
  url.search = ''; url.hash = '';
  return url.href;
}

/** Resolve only server-retained artifacts. User text and search/model output never prove linkage. */
export async function loadCapturedLinkage(input: InvestigationInput, artifacts?: ArtifactStore,
  now = Date.now()): Promise<CapturedLinkage | undefined> {
  if (!input.captureArtifactId) return undefined;
  if (!artifacts) throw new CaptureLinkageError();
  // Storage failures remain unavailable/retryable; malformed or missing evidence
  // is a fixed input failure. Never copy a driver error into user/Temporal output.
  const retained = await artifacts.get(input.captureArtifactId);
  try {
    if (!retained) throw new CaptureLinkageError();
    const artifact = validatedResearchArtifact(retained);
    if (artifact.id !== input.captureArtifactId || artifact.kind !== 'browser_capture') throw new CaptureLinkageError();
    const result = artifact.result;
    if (!('requestedUrl' in result) || result.status !== 'captured' || !result.evidence?.body) throw new CaptureLinkageError();
    const capturedAt = Date.parse(result.capturedAt);
    const createdAt = Date.parse(artifact.createdAt);
    if (!Number.isFinite(now) || now - capturedAt > MAX_AGE_MS || capturedAt > now + CLOCK_TOLERANCE_MS ||
      createdAt < capturedAt || createdAt > capturedAt + CLOCK_TOLERANCE_MS || createdAt > now + CLOCK_TOLERANCE_MS) throw new CaptureLinkageError();
    const snapshot = snapshotSchema.parse(JSON.parse(result.evidence.body));
    const source = canonical(input.url);
    if (!CAPTURE_HOSTS.includes(new URL(source).hostname) || canonical(result.requestedUrl) !== source ||
      canonical(result.evidence.url) !== source || canonical(snapshot.requestedUrl) !== source || canonical(snapshot.url) !== source ||
      (result.evidence.httpStatus !== undefined && (result.evidence.httpStatus < 200 || result.evidence.httpStatus >= 300)) ||
      JSON.stringify(snapshot.officialLinks) !== JSON.stringify(result.officialLinks)) throw new CaptureLinkageError();
    const expected = parseIdentity(input.officialUrl ?? input.url);
    const identity = uniquePostingIdentity(snapshot.officialLinks);
    if (!identity) throw new CaptureLinkageError();
    if (!sameIdentity(expected, identity) || (parseIdentity(input.url) && !sameIdentity(parseIdentity(input.url), identity))) throw new CaptureLinkageError();
    return { identity, evidence: { ...result.evidence,
      summary: 'Independently captured static advertisement containing one unique supported ATS posting identity. This proves a link was present, not employer intent or prior removal.' },
      limitations: [...result.limitations,
        'The retained advertisement snapshot contains a link to this exact ATS posting. A link does not independently establish company-domain ownership, an application being accepted, employer intent, or prior removal.',
        'Browser linkage is accepted only for a matching saved snapshot captured within the preceding 24 hours. A later recheck requires a fresh capture after that window.'] };
  } catch { throw new CaptureLinkageError(); }
}
