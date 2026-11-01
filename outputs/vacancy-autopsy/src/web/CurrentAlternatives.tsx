import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Investigation } from '../shared/types';
import { alternativesResultSchema, type AlternativesResult } from '../shared/alternatives';
import { authorizedFetch } from './workspace-auth';
import { publicSourceLink } from './investigation-view';

const reasons = {
  role_similarity: 'Potentially related role',
  seniority_similarity: 'Potentially related level',
  location_similarity: 'Potentially related location',
} as const;

/** Optional, explicit comparison with the report's retained employer inventory. */
export function CurrentAlternatives({ record, disabled = false }: { record: Investigation; disabled?: boolean }) {
  const [configured, setConfigured] = useState(false);
  const [role, setRole] = useState(/^Posting\s|^Unresolved/i.test(record.title) ? '' : record.title.slice(0, 160));
  const [location, setLocation] = useState('');
  const [result, setResult] = useState<AlternativesResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<AbortController | null>(null);
  const results = useRef<HTMLDivElement>(null);
  const eligible = record.mode === 'live' && record.verdict === 'not_listed';
  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    void authorizedFetch('/api/alternatives-config', { signal: controller.signal })
      .then(async response => {
        const body: unknown = response.ok ? await response.json() : null;
        if (!controller.signal.aborted) setConfigured(Boolean(body && typeof body === 'object' &&
          Object.keys(body).join(',') === 'configured' && 'configured' in body && body.configured === true));
      }).catch(() => { if (!controller.signal.aborted) setConfigured(false); });
    return () => controller.abort();
  }, [eligible]);
  useEffect(() => () => current.current?.abort(), []);
  if (!eligible || !configured) return null;

  async function compare(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled || !role.trim()) return;
    const controller = new AbortController();
    current.current = controller;
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await authorizedFetch(`/api/investigations/${record.id}/alternatives`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: role.trim(), ...(location.trim() ? { location: location.trim() } : {}) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]),
      });
      if (!response.ok) throw new Error(response.status === 429 ? 'busy' : response.status === 503 ? 'unavailable' : 'failed');
      const parsed = alternativesResultSchema.parse(await response.json());
      if (parsed.checkedAt !== record.checkedAt || parsed.alternatives.some(item => !publicSourceLink(item.url))) throw new Error('invalid_response');
      if (current.current === controller && !controller.signal.aborted) {
        setResult(parsed);
        requestAnimationFrame(() => results.current?.focus());
      }
    } catch (failure) {
      if (current.current !== controller || controller.signal.aborted) return;
      setError(failure instanceof Error && failure.message === 'busy'
        ? 'Another comparison is running. Wait for it before trying again.'
        : failure instanceof Error && failure.message === 'unavailable'
          ? 'This comparison is not connected right now. You can still recheck the source.'
          : 'The comparison did not complete. Recheck the source for a recent inventory, or try again later. Your original finding is unchanged.');
    } finally {
      if (current.current === controller) { current.current = null; setBusy(false); }
    }
  }
  return (
    <section className="current-alternatives source-details" aria-labelledby={`alternatives-${record.id}`}>
      <p className="eyebrow">YOUR NEXT OPPORTUNITY</p>
      <h3 id={`alternatives-${record.id}`}>Could another opening fit?</h3>
      <p>Compare your role with other postings in this employer’s saved source inventory.</p>
      <form onSubmit={event => void compare(event)}>
        <label htmlFor={`alternative-role-${record.id}`}>Public role title</label>
        <input id={`alternative-role-${record.id}`} value={role} maxLength={160} minLength={2} required
          placeholder="For example, Brand Design Intern" disabled={busy || disabled}
          onChange={event => { setRole(event.target.value); setResult(null); }} />
        <label htmlFor={`alternative-location-${record.id}`}>Preferred location <span>optional</span></label>
        <input id={`alternative-location-${record.id}`} value={location} maxLength={160}
          placeholder="Only if you want a location comparison" disabled={busy || disabled}
          onChange={event => { setLocation(event.target.value); setResult(null); }} />
        <p className="field-help">Only enter public role and location details. Ultramarine receives these details and current source titles, never your advertisement text.</p>
        <button className="secondary-button" type="submit" disabled={busy || disabled || !role.trim()}>
          {busy ? 'Comparing current postings…' : 'Find possible alternatives'}
        </button>
      </form>
      {busy && <p role="status">Comparing the role with the retained official-source titles…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {result && <div ref={results} tabIndex={-1} aria-label="Possible alternative openings">
        <h4>{result.alternatives.length ? 'Possible alternatives to explore' : 'No alternative selected from this comparison'}</h4>
        <p>{result.qualification}</p>
        {result.alternatives.length > 0 && <ul>
          {result.alternatives.map(item => <li key={item.jobId}>
            <a href={publicSourceLink(item.url)} target="_blank" rel="noreferrer">{item.title} ↗</a>
            <p>{item.location ? `${item.location} · ` : ''}{reasons[item.reason]}</p>
          </li>)}
        </ul>}
        <p className="field-help">Compared {result.candidatesConsidered} of {result.candidatesAvailable} retained public postings after title-based preselection. Source checked <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString()}</time>.</p>
        <p className="field-help">Suggested with Ultramarine. Open the employer’s posting to assess the role and its current application route.</p>
      </div>}
    </section>
  );
}
