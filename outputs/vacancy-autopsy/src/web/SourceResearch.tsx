import { useState, type FormEvent } from 'react';
import type { DiscoveryResult } from '../server/discovery';
import type { BrowserCaptureResult } from '../server/browser-capture';
import { authorizedFetch, authenticatedDownload } from './workspace-auth';
import { uniquePostingIdentity } from '../shared/posting-identity';

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await authorizedFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(50_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'The source request could not finish.');
  return value;
}
type Artifact<T> = { id: string; result: T };
export function SourceResearch({ jobUrl, onChoose, onChooseCapture, disabled = false }: { jobUrl: string;
  onChoose: (url: string) => void; disabled?: boolean;
  onChooseCapture?: (capture: { artifactId: string; advertisementUrl: string; officialUrl: string }) => void }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Artifact<DiscoveryResult> | null>(null);
  const [capture, setCapture] = useState<Artifact<BrowserCaptureResult> | null>(null);
  const [busy, setBusy] = useState<'search' | 'capture' | null>(null);
  const [error, setError] = useState('');
  const capturedPosting = uniquePostingIdentity(capture?.result.officialLinks);
  async function discover(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    setBusy('search'); setError(''); setSearch(null);
    try { setSearch(await post('/api/discovery', { query: query.trim() })); }
    catch (error) { setError(error instanceof Error ? error.message : 'Search could not finish.'); }
    finally { setBusy(null); }
  }
  async function capturePage() {
    if (busy || disabled || !jobUrl.trim()) return;
    setBusy('capture'); setError(''); setCapture(null);
    try { setCapture(await post('/api/captures', { url: jobUrl.trim() })); }
    catch (error) { setError(error instanceof Error ? error.message : 'The page could not be captured.'); }
    finally { setBusy(null); }
  }
  return <details className="source-tools">
    <summary>Find a source or capture the page <span aria-hidden="true">+</span></summary>
    <div className="source-tool-content">
      <form onSubmit={discover}>
        <label htmlFor="source-query">Role and employer</label>
        <input id="source-query" value={query} onChange={(event) => setQuery(event.target.value)} minLength={3} maxLength={240}
          placeholder="Software engineer intern · employer" required disabled={Boolean(busy) || disabled} />
        <button type="submit" className="secondary-button" disabled={Boolean(busy) || disabled}>{busy === 'search' ? 'Finding sources…' : 'Find sources'}</button>
      </form>
      {search && <div aria-live="polite">
        <p>{search.result.candidates.length ? 'Choose a lead, then investigate its source. Search snippets do not verify availability.' : 'No source candidates were returned. Try a more specific role and employer.'}</p>
        <ul className="source-candidates">{search.result.candidates.map((candidate) => <li key={candidate.url}>
          <strong>{candidate.title}</strong><small>{new URL(candidate.url).hostname}</small>
          <p>{candidate.snippet}</p><button type="button" className="text-button" disabled={disabled} onClick={() => onChoose(candidate.url)}>Use this posting</button>
        </li>)}</ul>
        <a href={`/api/research/${search.id}/report`} download onClick={(event) => void authenticatedDownload(event, `/api/research/${search.id}/report`).catch(() => setError('The source evidence could not be downloaded. Please sign in again and retry.'))}>Download search provenance</a>
      </div>}
      <div className="capture-tool">
        <p>Keep an independent browser snapshot of the URL entered above. Supported pages: OppIDX, Employbl, Greenhouse, Lever and Ashby.</p>
        <button type="button" className="secondary-button" disabled={Boolean(busy) || disabled || !jobUrl.trim()} onClick={() => void capturePage()}>{busy === 'capture' ? 'Capturing the page…' : 'Capture entered page'}</button>
      </div>
      {capture && <div aria-live="polite">
        <p><strong>Browser evidence saved.</strong> Select its posting link to attach this snapshot to your next investigation. The source check still determines availability.</p>
        {capturedPosting && onChooseCapture ? <div className="capture-link-choice">
          <p>Posting link found in the captured page:</p><code>{capturedPosting.officialUrl}</code>
          <button type="button" className="secondary-button" disabled={disabled || Boolean(busy)} onClick={() => onChooseCapture({ artifactId: capture.id,
            advertisementUrl: capture.result.requestedUrl, officialUrl: capturedPosting.officialUrl })}>Use this captured posting link</button>
          <p className="field-help">The server checks the saved snapshot, exact posting identity and 24-hour freshness before using this link.</p>
        </div> : <p className="field-help">This snapshot does not offer one unique supported posting link. Keep it as evidence; the advertisement’s opening remains unverified.</p>}
        {capture.result.cleanup === 'release_failed' && <p role="alert">Browser release could not be confirmed; its configured session timeout remains the fallback.</p>}
        {capture.result.screenshot && <img className="capture-preview" alt="Captured job page" src={`data:image/png;base64,${capture.result.screenshot.base64}`} />}
        <a href={`/api/research/${capture.id}/report`} download onClick={(event) => void authenticatedDownload(event, `/api/research/${capture.id}/report`).catch(() => setError('The source evidence could not be downloaded. Please sign in again and retry.'))}>Download browser evidence</a>
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  </details>;
}
