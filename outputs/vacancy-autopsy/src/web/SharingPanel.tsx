import { useEffect, useState } from 'react';
import { z } from 'zod';
import { PUBLIC_RELEASE_CONFIRMATION, PUBLIC_WITHDRAW_CONFIRMATION, publicFindingSchema, publicReleaseIdSchema } from '../shared/public-report';
import { reviewerFetch } from './workspace-auth';
import { FindingPreview } from './SharedFinding';

const receiptSchema = z.object({ id: publicReleaseIdSchema, publishedAt: z.string().datetime(), withdrawnAt: z.string().datetime().optional() }).strict();
const previewSchema = z.object({ reportDigest: publicReleaseIdSchema, previewDigest: publicReleaseIdSchema,
  finding: publicFindingSchema, publishable: z.boolean(), release: receiptSchema.nullable() }).strict();
type Preview = z.infer<typeof previewSchema>;
async function request(path: string, init: RequestInit = {}) {
  const response = await reviewerFetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  const result: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Sign in again with reviewer permission to continue.');
    if (response.status === 409 && result && typeof result === 'object' && 'error' in result && typeof result.error === 'string') throw new Error(result.error);
    throw new Error('The sharing operation could not be confirmed. Reload the preview to check its status before retrying.');
  }
  return result;
}
export function SharingPanel({ reportId, reportDigest }: { reportId: string; reportDigest: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setPreview(null); setConfirmed(false); setError(''); }, [reportId, reportDigest]);
  async function load() {
    if (busy) return;
    setBusy(true); setError(''); setConfirmed(false); setPreview(null);
    try {
      const data = previewSchema.parse(await request(`/api/investigations/${reportId}/share-preview`));
      if (data.reportDigest !== reportDigest) throw new Error('The private report changed. Reload the case and review it again.');
      setPreview(data);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The preview is unavailable.'); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!preview || !preview.publishable || !confirmed || busy || error || preview.release) return;
    setBusy(true); setError(''); setConfirmed(false);
    try {
      const result = z.object({ release: receiptSchema }).strict().parse(await request(`/api/investigations/${reportId}/share`, {
        method: 'POST', body: JSON.stringify({ reportDigest: preview.reportDigest, previewDigest: preview.previewDigest, confirmation: PUBLIC_RELEASE_CONFIRMATION }),
      }));
      setPreview({ ...preview, release: result.release });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Sharing could not be confirmed.'); }
    finally { setBusy(false); }
  }
  async function withdraw() {
    if (!preview?.release || preview.release.withdrawnAt || !confirmed || busy) return;
    setBusy(true); setError(''); setConfirmed(false);
    try {
      const result = z.object({ release: receiptSchema }).strict().parse(await request(`/api/shared-reports/${preview.release.id}/withdraw`, {
        method: 'POST', body: JSON.stringify({ confirmation: PUBLIC_WITHDRAW_CONFIRMATION }),
      }));
      setPreview({ ...preview, release: result.release });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Withdrawal could not be confirmed.'); }
    finally { setBusy(false); }
  }
  return <div className="sharing-panel" aria-busy={busy}>
    <h4>Share a clearer source finding.</h4>
    <p>Only the preview below becomes readable to anyone with the link. Your private input, captured bodies and reviewer identity stay private.</p>
    {!preview && <button className="secondary-button" disabled={busy} onClick={() => void load()}>{busy ? 'Preparing the preview…' : 'Preview a share link'}</button>}
    {error && <><p role="alert" className="error">{error}</p><button className="text-button" disabled={busy} onClick={() => void load()}>Reload public preview</button></>}
    {preview && <>
      <FindingPreview finding={preview.finding} />
      {preview.release?.withdrawnAt ? <p role="status">This link was withdrawn. Recheck the opening to create a new shared finding.</p> : preview.release ? <>
        <p role="status">The reviewed finding is shared. Its source check remains a point-in-time snapshot.</p>
        <a href={`/?shared=${preview.release.id}`} target="_blank" rel="noreferrer" className="secondary-button">Open shared finding ↗</a>
        <label className="sharing-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /><span>Withdraw this link so it stops serving the shared finding.</span></label>
        <button className="secondary-button" disabled={busy || !confirmed} onClick={() => void withdraw()}>{busy ? 'Withdrawing…' : 'Withdraw share link'}</button>
      </> : <>
        <label className="sharing-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /><span>I reviewed this exact public preview and approve making it readable to anyone with the link.</span></label>
        <button className="secondary-button" disabled={busy || !confirmed || !preview.publishable || Boolean(error)} onClick={() => void publish()}>{busy ? 'Creating the share link…' : 'Confirm and create share link'}</button>
      </>}
    </>}
  </div>;
}
