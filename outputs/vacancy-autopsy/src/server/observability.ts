import * as Sentry from '@sentry/node';

const operations = new Set(['investigation.run', 'identity.resolve', 'source.verify', 'evidence.seal', 'discovery.search', 'browser.capture', 'review.approve']);
type Operation = 'investigation.run' | 'identity.resolve' | 'source.verify' | 'evidence.seal' | 'discovery.search' | 'browser.capture' | 'review.approve';
const allowedAttributes = new Set(['sentry.op', 'sentry.origin', 'sentry.sample_rate', 'va.step', 'va.outcome', 'va.ats', 'va.evidence_count', 'va.success']);

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
      name: operations.has(span.name) ? span.name : 'vacancy-autopsy.operation',
      attributes: Object.fromEntries(Object.entries(span.attributes).filter(([key, value]) => allowedAttributes.has(key) &&
        (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
          typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value)))),
      links: undefined,
    }),
  });
  if (!Sentry.getClient()?.getDsn()) throw new Error('The Sentry client did not accept the project DSN.');
  return true;
}

export async function traceOperation<T>(name: Operation, operation: () => Promise<T>, attributes: Record<string, string | number | boolean> = {}, classify?: (result: T) => string): Promise<T> {
  return Sentry.startSpan({ name, op: 'workflow.step', attributes }, async (span) => {
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
      Sentry.captureMessage('Vacancy Autopsy operation failed', 'error');
      throw error;
    }
  });
}

export function traceSourceOutcome(verdict: string, evidenceCount: number) {
  const span = Sentry.getActiveSpan();
  span?.setAttribute('va.outcome', verdict);
  span?.setAttribute('va.evidence_count', evidenceCount);
}

export const flushObservability = () => Sentry.flush(2000);
