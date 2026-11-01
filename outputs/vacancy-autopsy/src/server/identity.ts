import type { InvestigationInput } from '../shared/types.js';
import { publicUrlSchema, type Identity } from './schemas.js';
import { parsePostingIdentity, samePostingIdentity } from '../shared/posting-identity.js';

/** Parse only documented ATS host/path forms. User input never supplies a fetch host. */
export function parseIdentity(raw: string): Identity | null {
  if (!publicUrlSchema.safeParse(raw).success) return null;
  return parsePostingIdentity(raw);
}

export const sameIdentity = samePostingIdentity;

export function sanitizeInput(input: InvestigationInput): InvestigationInput {
  // Query strings and fragments can contain tracking or access tokens. Canonical
  // ATS paths carry the job ID; unsupported embedded-ID URLs remain inconclusive.
  const clean = (raw: string) => {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    return url.toString();
  };
  return { url: clean(input.url), ...(input.officialUrl ? { officialUrl: clean(input.officialUrl) } : {}),
    ...(input.advertisementText ? { advertisementText: input.advertisementText } : {}),
    ...(input.captureArtifactId ? { captureArtifactId: input.captureArtifactId } : {}) };
}

export function identify(input: InvestigationInput): {
  identity: Identity | null; linkageVerified: boolean; warning?: string;
} {
  const fromSource = parseIdentity(input.url);
  const supplied = input.officialUrl ? parseIdentity(input.officialUrl) : null;
  if (input.officialUrl && !supplied) return { identity: null, linkageVerified: false,
    warning: 'The supplied official URL is not a supported Greenhouse, Lever or Ashby posting URL.' };
  if (fromSource && supplied && !sameIdentity(fromSource, supplied)) return { identity: null, linkageVerified: false,
    warning: 'The advertisement URL and supplied official URL identify different jobs. No verdict was inferred.' };
  const identity = supplied ?? fromSource;
  if (!identity) return { identity: null, linkageVerified: false,
    warning: 'A supported official posting URL is needed. This local baseline does not discover an employer source from arbitrary advertisements.' };
  // Pasted text is unverified input. Even when it names a matching URL, it cannot
  // prove that the independently hosted advertisement actually contains it.
  if (!fromSource) return { identity, linkageVerified: false,
    warning: 'The supplied official job was checked, but its relationship to the third-party advertisement has not been independently verified.' };
  return { identity, linkageVerified: true };
}
