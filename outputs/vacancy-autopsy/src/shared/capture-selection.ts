import type { InvestigationInput } from './types.js';
import { parsePostingIdentity, samePostingIdentity } from './posting-identity.js';

function sourceUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (raw.trim().length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Presentation guard only; the server independently validates the replacement artifact. */
export function replacementCaptureForReport(original: InvestigationInput, selected: InvestigationInput): string | null {
  if (!selected.captureArtifactId || selected.captureArtifactId === original.captureArtifactId) return null;
  const originalSource = sourceUrl(original.url);
  if (!originalSource || sourceUrl(selected.url) !== originalSource) return null;
  return samePostingIdentity(parsePostingIdentity(original.officialUrl ?? original.url),
    parsePostingIdentity(selected.officialUrl ?? selected.url)) ? selected.captureArtifactId : null;
}
