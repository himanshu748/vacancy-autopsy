import { useEffect, useState } from 'react';
import { publicFindingSchema, sharedFindingSchema, type PublicFinding, type SharedFinding } from '../shared/public-report';

const labels = { verified_open: 'Verified open', not_listed: 'Not currently listed', inconclusive: 'Inconclusive' };
function time(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
export function FindingPreview({ finding, published = false }: { finding: PublicFinding; published?: boolean }) {
  const Title = published ? 'h1' : 'h5';
  const Subheading = published ? 'h2' : 'h6';
  return <article className="shared-finding" aria-label={published ? 'Reviewed shared source finding' : 'Public source finding preview'}>
    <p className="eyebrow">FIRST-PARTY SOURCE / SNAPSHOT</p>
    <span className={`verdict-badge ${finding.verdict}`}>{labels[finding.verdict]}</span>
    <Title>{finding.title}</Title>
    <p>{finding.board} <span className="shared-muted">· {finding.ats} board identifier</span></p>
    <p>{finding.statement}</p>
    <p className="shared-muted">Checked {time(finding.checkedAt)} · Posting ID {finding.jobId}</p>
    <a href={finding.officialUrl} rel="noreferrer" target="_blank" className="secondary-button">Open the official posting ↗</a>
    <Subheading>What this tells you</Subheading>
    <ul>{finding.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
    <details><summary>Checked sources ({finding.sources.length})</summary>
      {finding.sources.map((source) => <div className="shared-source" key={`${source.url}:${source.sha256}`}>
        <a href={source.url} rel="noreferrer" target="_blank">Public ATS response ↗</a>
        <p>{time(source.capturedAt)}</p><code>{source.sha256}</code>
      </div>)}
    </details>
  </article>;
}
export function SharedFindingPage({ id }: { id: string }) {
  const [finding, setFinding] = useState<SharedFinding | null>(null);
  const [state, setState] = useState<'loading' | 'missing' | 'error' | 'ready'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let cancelled = false;
    setState('loading'); setFinding(null);
    if (!/^[a-f0-9]{64}$/.test(id)) { setState('missing'); return () => controller.abort(); }
    void (async () => {
      try {
        const response = await fetch(`/api/shared-reports/${id}`, { credentials: 'omit', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (cancelled) return;
        if (response.status === 404) { setState('missing'); return; }
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Unavailable');
        const content = await response.text();
        if (content.length > 32000) throw new Error('Invalid finding');
        const result = sharedFindingSchema.parse(JSON.parse(content));
        publicFindingSchema.parse(result.finding);
        if (result.id !== id) throw new Error('Invalid finding');
        if (!cancelled) { setFinding(result); setState('ready'); }
      } catch { if (!cancelled) setState('error'); }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [id, attempt]);
  return <div className="shared-page">
    <a className="skip-link" href="#shared-main">Skip to shared finding</a>
    <a className="shared-brand" href="/">vacancy autopsy ↗</a>
    <main id="shared-main" aria-busy={state === 'loading'} tabIndex={-1}>
      {state === 'loading' && <p role="status">Opening the shared source finding…</p>}
      {state === 'missing' && <><h1>This finding is unavailable.</h1><p>The link may have been withdrawn or sharing may be disabled.</p><a href="/">Check an opening yourself ↗</a></>}
      {state === 'error' && <><h1>The finding couldn’t load.</h1><p role="alert">Please try again. No availability conclusion can be drawn from this error.</p><button className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></>}
      {finding && <><p className="shared-muted">Reviewed source finding · Shared {time(finding.publishedAt)}</p><FindingPreview finding={finding.finding} published /></>}
    </main>
    <footer>More clarity. Fewer dead ends.</footer>
  </div>;
}
