import * as Sentry from '@sentry/node';

const operations = new Set(['investigation.run', 'identity.resolve', 'source.verify', 'evidence.seal', 'discovery.search', 'browser.capture', 'review.approve', 'model.extract', 'model.rank']);
type Operation = 'investigation.run' | 'identity.resolve' | 'source.verify' | 'evidence.seal' | 'discovery.search' | 'browser.capture' | 'review.approve' | 'model.extract' | 'model.rank';
// Manual tool conventions avoid publishing private checkpoint identities or
// misrepresenting tabular prediction as a generative chat request.
const aiTools = new Map<Operation, { name: string; provider: string }>([
  ['model.extract', { name: 'read_listing_details', provider: 'tinker' }],
  ['model.rank', { name: 'prioritize_shortlist', provider: 'prior_labs' }],
]);
const allowedSpanNames = new Set([...operations, ...[...aiTools.values()].map((tool) => `execute_tool ${tool.name}`)]);
export type FailureClass = 'provider_error' | 'invalid_response' | 'cancelled' | 'pending' | 'quota_exhausted' | 'not_configured' | 'uncertain_submission' | 'storage_full';
const failureClasses = new Set<FailureClass>(['provider_error', 'invalid_response', 'cancelled', 'pending', 'quota_exhausted', 'not_configured', 'uncertain_submission', 'storage_full']);
const allowedAttributes = new Set(['sentry.op', 'sentry.origin', 'sentry.sample_rate', 'va.step', 'va.outcome', 'va.ats', 'va.evidence_count', 'va.success', 'va.provider', 'va.failure_class', 'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.tool.name', 'error.type']);

/** Explicit spans only: never instrument request bodies, source text or tokens. */
export function initializeObservability(options: Pick<Sentry.NodeOptions, 'dsn' | 'transport'> & { environment?: string } = {}) {
  if (!options.dsn) return false;
  const dsn = new URL(options.dsn);
  if (dsn.protocol !== 'https:' || !dsn.hostname || !/^[a-z0-9]{1,128}$/i.test(dsn.username) || dsn.password ||
      dsn.search || dsn.hash || !/^\/\d+$/.test(dsn.pathname)) {
    throw new Error('SENTRY_DSN must be a valid HTTPS project DSN.');
  }
  Sentry.init({
    dsn: options.dsn, transport: options.transport,
    environment: options.environment ?? 'local',
    defaultIntegrations: false, tracesSampleRate: 1, maxBreadcrumbs: 0,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      genAI: { inputs: false, outputs: false }, mcp: { inputs: false, outputs: false },
      databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 },
    beforeSend: (event) => ({ type: event.type, event_id: event.event_id, timestamp: event.timestamp, level: 'error',
      message: 'Vacancy Autopsy operation failed', contexts: event.contexts?.trace ? { trace: event.contexts.trace } : undefined,
      tags: { component: 'investigation' } }),
    beforeSendSpan: (span) => ({ ...span,
      name: allowedSpanNames.has(span.name) ? span.name : 'vacancy-autopsy.operation',
      attributes: Object.fromEntries(Object.entries(span.attributes).filter(([key, value]) => allowedAttributes.has(key) &&
        (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
          typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value)))),
      links: undefined,
    }),
  });
  if (!Sentry.getClient()?.getDsn()) throw new Error('The Sentry client did not accept the project DSN.');
  return true;
}

export async function traceOperation<T>(name: Operation, operation: () => Promise<T>, attributes: Record<string, string | number | boolean> = {}, classify?: (result: T) => string, classifyFailure?: (error: unknown) => FailureClass): Promise<T> {
  const tool = aiTools.get(name);
  const startOperationSpan = () => Sentry.startSpan({
    name: tool ? `execute_tool ${tool.name}` : name,
    op: tool ? 'gen_ai.execute_tool' : 'workflow.step',
    attributes: tool ? { ...attributes, 'va.step': name, 'gen_ai.operation.name': 'execute_tool',
      'gen_ai.provider.name': tool.provider, 'gen_ai.tool.name': tool.name } : attributes,
  }, async (span) => {
    try {
      const result = await operation();
      const outcome = classify?.(result);
      const success = outcome === undefined || outcome === 'success' || outcome === 'captured';
      span.setAttribute('va.success', success);
      if (outcome && ['success', 'captured', 'failed', 'blocked', 'cancelled', 'not_configured'].includes(outcome)) span.setAttribute('va.outcome', outcome);
      if (!success) {
        span.setStatus({ code: 2, message: 'provider_operation_unavailable' });
        Sentry.captureMessage('Vacancy Autopsy operation failed', 'error');
      }
      return result;
    } catch (error) {
      span.setStatus({ code: 2, message: 'operation_failed' });
      span.setAttribute('va.success', false);
      span.setAttribute('va.outcome', 'failed');
      const failureClass = classifyFailure?.(error);
      if (failureClass && failureClasses.has(failureClass)) {
        span.setAttribute('va.failure_class', failureClass);
        if (tool) span.setAttribute('error.type', failureClass);
      }
      Sentry.captureMessage('Vacancy Autopsy operation failed', 'error');
      throw error;
    }
  });
  // Automatic HTTP integrations are disabled deliberately. Without an active
  // parent, reset the SDK's process-wide propagation context for this action
  // (including a Temporal activity attempt), while keeping real children joined.
  return Sentry.getActiveSpan()
    ? startOperationSpan()
    : Sentry.withIsolationScope(() => Sentry.startNewTrace(startOperationSpan));
}

export function traceSourceOutcome(verdict: string, evidenceCount: number) {
  const span = Sentry.getActiveSpan();
  span?.setAttribute('va.outcome', verdict);
  span?.setAttribute('va.evidence_count', evidenceCount);
}

export const flushObservability = () => Sentry.flush(2000);
