import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Investigation } from '../shared/types';
import { SharingPanel } from './SharingPanel';
import { getWorkspaceClient, getWorkspaceConfig, needsWorkspaceSignIn as needsSignIn, noteWorkspaceReport,
  restoredWorkspaceReport, reviewerFetch, signInToWorkspace, signOutOfWorkspace,
  WorkspaceAuthError as ReviewerRequestError, type WorkspaceConfig } from './workspace-auth';
export { getReviewerReturnReportId } from './workspace-auth';

const DIGEST = /^[a-f0-9]{64}$/;
const CONFIRMATION = 'I reviewed the evidence and limitations';
type Approval = { id: string; reportId: string; reportDigest: string; approvedAt: string; publication: 'private' };
type Review = { reportDigest: string; approval: Approval | null };
type Phase = 'loading' | 'unconfigured' | 'signed_out' | 'loading_review' | 'ready' | 'saving' | 'saved' | 'redirecting' | 'error';
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (object(value)) return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function readApproval(value: unknown, reportId: string, reportDigest: string): Approval {
  if (!object(value) || typeof value.id !== 'string' || !DIGEST.test(value.id) || value.reportId !== reportId ||
      value.reportDigest !== reportDigest || value.publication !== 'private' || typeof value.approvedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.approvedAt))) throw new Error('Invalid approval receipt.');
  return { id: value.id, reportId, reportDigest, approvedAt: value.approvedAt, publication: 'private' };
}
function messageFor(error: unknown): string {
  if (error instanceof ReviewerRequestError) {
    if (error.status === 401) return 'Your reviewer sign-in has expired. Please sign in again.';
    if (error.status === 403) return 'This account does not have reviewer permission. Ask the project owner for access.';
    if (error.status === 409) return 'The report changed. Reload the case and review the evidence again.';
    if (error.status === 404) return 'This case could not be found. Return to the case archive.';
    if (error.status === 429) return 'Too many review requests. Please wait a moment and try again.';
  }
  if (object(error) && typeof error.error === 'string' && ['login_required', 'consent_required', 'interaction_required'].includes(error.error)) {
    return 'Please sign in again to continue your review.';
  }
  return 'Reviewer sign-in or approval is unavailable. Your report remains private; please try again.';
}
async function request(path: string, options: RequestInit = {}, refreshToken = false): Promise<unknown> {
  const response = await reviewerFetch(path, { ...options, headers: { 'Content-Type': 'application/json' } }, refreshToken);
  if (!response.ok) throw new ReviewerRequestError(response.status);
  return response.json();
}

export function ReviewerPanel({ report }: { report: Investigation }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const reportFingerprint = useMemo(() => stableJson(report), [report]);
  const busy = ['loading', 'loading_review', 'saving', 'redirecting'].includes(phase);
  const eligible = report.mode === 'live' && report.evidence.length > 0;

  const loadReview = useCallback(async (signal?: AbortSignal, refreshToken = false): Promise<Review> => {
    const data = await request(`/api/investigations/${encodeURIComponent(report.id)}/review`, { signal }, refreshToken);
    if (!object(data) || typeof data.reportDigest !== 'string' || !DIGEST.test(data.reportDigest) ||
        data.digestAlgorithm !== 'sha256:canonical-json-v1' || data.publication !== 'private' ||
        !object(data.report) || data.report.id !== report.id) throw new Error('Invalid review snapshot.');
    if (stableJson(data.report) !== reportFingerprint) throw new ReviewerRequestError(409);
    return { reportDigest: data.reportDigest,
      approval: data.approval === null ? null : readApproval(data.approval, report.id, data.reportDigest) };
  }, [report.id, reportFingerprint]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    noteWorkspaceReport(report.id);
    setPhase('loading'); setError(''); setReview(null); setConfirmed(false); setSignedIn(false);
    void (async () => {
      try {
        const next = await getWorkspaceConfig();
        if (cancelled) return;
        setConfig(next);
        if (!next.configured) { setPhase('unconfigured'); return; }
        const client = await getWorkspaceClient(next);
        if (cancelled) return;
        restoredWorkspaceReport(report.id);
        const authenticated = await client.isAuthenticated();
        if (cancelled) return;
        setSignedIn(authenticated);
        if (!authenticated) { setPhase('signed_out'); return; }
        setPhase('loading_review');
        const snapshot = await loadReview(controller.signal, attempt > 0);
        if (!cancelled) { setReview(snapshot); setPhase(snapshot.approval ? 'saved' : 'ready'); }
      } catch (failure) {
        if (cancelled) return;
        if (needsSignIn(failure)) setSignedIn(false);
        setError(messageFor(failure)); setPhase('error');
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [loadReview, attempt]);

  async function signIn() {
    if (!config?.configured || busy) return;
    setError(''); setPhase('redirecting'); setConfirmed(false);
    try {
      await signInToWorkspace(report.id);
    } catch (failure) { setError(messageFor(failure)); setPhase('error'); }
  }
  async function approve() {
    if (!config?.configured || !signedIn || !review || !confirmed || busy || !eligible) return;
    setPhase('saving'); setError('');
    try {
      const data = await request(`/api/investigations/${encodeURIComponent(report.id)}/approvals`, {
        method: 'POST', body: JSON.stringify({ reportDigest: review.reportDigest, confirmation: CONFIRMATION }),
      });
      if (!object(data) || data.publication !== 'private') throw new Error('Invalid approval response.');
      const approval = readApproval(data.approval, report.id, review.reportDigest);
      setReview({ ...review, approval }); setPhase('saved'); setConfirmed(false);
    } catch (failure) {
      setConfirmed(false);
      if (needsSignIn(failure)) setSignedIn(false);
      setError(messageFor(failure)); setPhase('error');
    }
  }
  async function signOut() {
    if (busy) return;
    try {
      await signOutOfWorkspace();
      setSignedIn(false); setReview(null); setConfirmed(false); setError(''); setPhase('signed_out');
    } catch { setError('Sign-out could not finish. Close this tab to clear reviewer access.'); setPhase('error'); }
  }

  return <section className="source-details reviewer-panel" aria-labelledby={`reviewer-title-${report.id}`} aria-busy={busy} style={{ paddingTop: 14 }}>
    <h3 id={`reviewer-title-${report.id}`} style={{ fontSize: 14, color: '#28432b', marginBottom: 8 }}>A second pair of eyes.</h3>
    <p>Record a reviewer’s approval of this evidence. Your report stays private.</p>
    {phase === 'loading' && <p role="status">Checking reviewer access…</p>}
    {phase === 'unconfigured' && <>
      <p>Reviewer sign-in isn’t connected yet. Approval becomes available after the project owner completes setup.</p>
      <button type="button" className="secondary-button" disabled>Reviewer sign-in unavailable</button>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    {config?.configured && !signedIn && phase !== 'loading' && <button type="button" className="secondary-button" disabled={busy} onClick={() => void signIn()}>
      {phase === 'redirecting' ? 'Opening reviewer sign-in…' : 'Sign in as reviewer'}
    </button>}
    {phase === 'loading_review' && <p role="status">Loading the evidence for review…</p>}
    {review?.approval && <div role="status">
      <p><strong>Review recorded.</strong> This report remains private.</p>
      <p>Approved {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(review.approval.approvedAt))}</p>
      <div className="hash-label">Approval receipt<code>{review.approval.id}</code></div>
    </div>}
    {signedIn && review && !review.approval && <>
      <div className="hash-label">Report fingerprint<code>{review.reportDigest}</code></div>
      {!eligible ? <p>Capture source evidence before requesting approval.</p> : <>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.7, margin: '12px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} style={{ width: 16, height: 16, flexShrink: 0, marginTop: 1 }} />
          <span>I reviewed this report’s evidence and limitations.</span>
        </label>
        <button type="button" className="secondary-button" disabled={busy || !confirmed || phase === 'error'} onClick={() => void approve()}>
          {phase === 'saving' ? 'Recording review…' : 'Record approval'}
        </button>
      </>}
    </>}
    {signedIn && review?.approval && config?.sharingEnabled && <SharingPanel key={report.id + review.reportDigest} reportId={report.id} reportDigest={review.reportDigest} />}
    {phase === 'error' && <button type="button" className="text-button" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>Retry reviewer access</button>}
    {signedIn && <button type="button" className="text-button" disabled={busy} onClick={() => void signOut()}>Sign out of review</button>}
  </section>;
}

export default ReviewerPanel;
