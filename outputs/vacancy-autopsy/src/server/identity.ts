import type { InvestigationInput } from '../shared/types.js';
import { publicUrlSchema, type Identity } from './schemas.js';

const boardPattern = /^[A-Za-z0-9_-]{1,100}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse only documented ATS host/path forms. User input never supplies a fetch host. */
export function parseIdentity(raw: string): Identity | null {
  if (!publicUrlSchema.safeParse(raw).success) return null;
  const url = new URL(raw);
  const parts = url.pathname.split('/').filter(Boolean);
  const board = parts[0];
  if (!board || !boardPattern.test(board)) return null;
  if (['job-boards.greenhouse.io', 'boards.greenhouse.io'].includes(url.hostname) &&
      parts.length === 3 && parts[1] === 'jobs' && /^\d{1,20}$/.test(parts[2])) {
    return { ats: 'greenhouse', board, jobId: parts[2], region: 'global',
      officialUrl: `https://job-boards.greenhouse.io/${board}/jobs/${parts[2]}` };
  }
  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname) &&
      (parts.length === 2 || (parts.length === 3 && parts[2] === 'apply')) && uuidPattern.test(parts[1])) {
    return { ats: 'lever', board, jobId: parts[1].toLowerCase(),
      region: url.hostname === 'jobs.eu.lever.co' ? 'eu' : 'global',
      officialUrl: `https://${url.hostname}/${board}/${parts[1].toLowerCase()}` };
  }
  if (url.hostname === 'jobs.ashbyhq.com' &&
      (parts.length === 2 || (parts.length === 3 && parts[2] === 'application')) && uuidPattern.test(parts[1])) {
    return { ats: 'ashby', board, jobId: parts[1].toLowerCase(), region: 'global',
      officialUrl: `https://jobs.ashbyhq.com/${board}/${parts[1].toLowerCase()}` };
  }
  return null;
}

export function sameIdentity(a: Identity | null, b: Identity | null): boolean {
  return !!a && !!b && a.ats === b.ats && a.region === b.region && a.board === b.board && a.jobId === b.jobId;
}

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
    ...(input.advertisementText ? { advertisementText: input.advertisementText } : {}) };
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
