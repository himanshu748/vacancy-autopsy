import { useEffect, useState, type ReactNode } from 'react';
import { authorizedFetch, getWorkspaceAccessToken, getWorkspaceClient, getWorkspaceConfig, hasWorkspaceCallback,
  needsWorkspaceSignIn, signInToWorkspace, signOutOfWorkspace, WORKSPACE_ACCESS_EVENT,
  WorkspaceAuthError, type WorkspaceConfig } from './workspace-auth';

type Phase = 'loading' | 'ready' | 'signed_out' | 'forbidden' | 'error' | 'redirecting';
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const accessChanged = (event: Event) => {
      const status = (event as CustomEvent<{ status: number }>).detail?.status;
      if (status === 403) { setPhase('forbidden'); setError('This account does not have access to this workspace. Ask the project owner for reviewer permission.'); }
      else { setPhase('signed_out'); setError('Please sign in to continue.'); }
    };
    window.addEventListener(WORKSPACE_ACCESS_EVENT, accessChanged);
    setPhase('loading'); setError('');
    void (async () => {
      try {
        const next = await getWorkspaceConfig(attempt > 0);
        if (cancelled) return;
        setConfig(next);
        if (next.configured && hasWorkspaceCallback()) await getWorkspaceClient(next);
        if (cancelled) return;
        if (!next.requiresAuthentication) { setPhase('ready'); return; }
        if (!next.configured) throw new WorkspaceAuthError(503);
        const client = await getWorkspaceClient(next);
        if (cancelled) return;
        if (!await client.isAuthenticated()) { if (!cancelled) setPhase('signed_out'); return; }
        if (attempt > 0) await getWorkspaceAccessToken(true);
        const response = await authorizedFetch('/api/workspace', { signal: controller.signal });
        if (cancelled) return;
        if (!response.ok) throw new WorkspaceAuthError(response.status);
        const workspace: unknown = await response.json();
        if (!workspace || typeof workspace !== 'object' || !('authorized' in workspace) || workspace.authorized !== true ||
            !('visibility' in workspace) || workspace.visibility !== 'private_workspace') throw new WorkspaceAuthError(503);
        setPhase('ready');
      } catch (failure) {
        if (cancelled) return;
        if (needsWorkspaceSignIn(failure)) { setPhase('signed_out'); setError('Please sign in to continue.'); }
        else if (failure instanceof WorkspaceAuthError && failure.status === 403) {
          setPhase('forbidden'); setError('This account does not have access to this workspace. Ask the project owner for reviewer permission.');
        } else { setPhase('error'); setError('The workspace could not be opened. Your reports remain private. Please try again.'); }
      }
    })();
    return () => { cancelled = true; controller.abort(); window.removeEventListener(WORKSPACE_ACCESS_EVENT, accessChanged); };
  }, [attempt]);
  async function signIn() {
    setPhase('redirecting'); setError('');
    try { await signInToWorkspace(); }
    catch { setPhase('error'); setError('Sign-in could not be opened. Please try again.'); }
  }
  async function signOut() {
    try { await signOutOfWorkspace(); setPhase('signed_out'); setError(''); }
    catch { setPhase('error'); setError('Sign-out could not finish. Close this tab to clear workspace access.'); }
  }
  if (phase === 'ready') return <>
    {config?.requiresAuthentication && <aside aria-label="Workspace session" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 16, padding: '6px 24px', fontSize: 12 }}>
      <span>Private workspace</span>
      <button type="button" className="text-button" onClick={() => void signOut()}>Sign out</button>
    </aside>}
    {children}
  </>;
  const busy = phase === 'loading' || phase === 'redirecting';
  return <main className="empty-state" aria-labelledby="workspace-access-title" aria-busy={busy} style={{ maxWidth: 560, margin: '12vh auto', padding: '32px 24px', textAlign: 'left' }}>
    <p style={{ fontSize: 12, color: '#526b42' }}>VACANCY AUTOPSY</p>
    <h1 id="workspace-access-title" style={{ fontSize: 32, lineHeight: 1.2, margin: '16px 0' }}>{config?.requiresAuthentication ? 'A private investigation desk.' : 'Your investigation desk.'}</h1>
    <p>{config?.requiresAuthentication ? 'Sign in to access this workspace’s shared reports and evidence. Access is limited to its approved reviewers.' : 'We’re checking access before opening your cases.'}</p>
    {phase === 'loading' && <p role="status">Checking workspace access…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {config?.configured && phase !== 'forbidden' && <button type="button" className="secondary-button" disabled={busy} onClick={() => void signIn()}>
      {phase === 'redirecting' ? 'Opening sign-in…' : 'Sign in to workspace'}
    </button>}
    {phase === 'forbidden' && <button type="button" className="secondary-button" onClick={() => void signOut()}>Sign out</button>}
    {(phase === 'error' || phase === 'forbidden') && <button type="button" className="text-button" onClick={() => setAttempt((value) => value + 1)}>Retry workspace access</button>}
    {phase === 'error' && config?.requiresAuthentication === false && <button type="button" className="text-button" onClick={() => setPhase('ready')}>Open the local desk</button>}
  </main>;
}

export default WorkspaceGate;
