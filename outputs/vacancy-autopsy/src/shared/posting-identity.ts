export interface PostingIdentity {
  ats: 'greenhouse' | 'lever' | 'ashby';
  board: string;
  jobId: string;
  officialUrl: string;
  region: 'global' | 'eu';
}
const boardPattern = /^[A-Za-z0-9_-]{1,100}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared exact ATS identity rules; parsing does not verify ownership or availability. */
export function parsePostingIdentity(raw: string): PostingIdentity | null {
  if (typeof raw !== 'string' || raw.trim().length > 2048) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
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

export function samePostingIdentity(a: PostingIdentity | null, b: PostingIdentity | null): boolean {
  return !!a && !!b && a.ats === b.ats && a.region === b.region && a.board === b.board && a.jobId === b.jobId;
}

/** One selectable identity, allowing aliases but rejecting malformed or unrelated links. */
export function uniquePostingIdentity(links: unknown): PostingIdentity | null {
  if (!Array.isArray(links) || !links.length || links.length > 80) return null;
  const identities = new Map<string, PostingIdentity>();
  for (const link of links) {
    if (typeof link !== 'string') return null;
    const identity = parsePostingIdentity(link);
    if (!identity) return null;
    identities.set(identity.officialUrl, identity);
    if (identities.size > 1) return null;
  }
  return identities.values().next().value ?? null;
}
