import Fastify, { LogController, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Health, SponsorStatus, Investigation, InvestigationInput } from '../shared/types.js';
import { investigationInputSchema, publicUrlSchema, reportIdSchema } from './schemas.js';
import { runInvestigation } from './workflow.js';
import { StorageFullError, type InvestigationStore } from './store.js';
import type { Fetcher } from './ats.js';
import { registerResearchRoutes, type ResearchOptions } from './research.js';
import { registerApprovalRoutes, type ApprovalRouteOptions } from './approvals.js';
import { ReviewAuthorizationError } from './auth.js';
import { registerExtractionRoutes, type ExtractionOptions } from './extraction.js';
import { registerPriorityRoutes, type PriorityOptions } from './priority.js';
import { registerReleaseRoutes, type SharingOptions } from './releases.js';
import { CaptureLinkageError, loadCapturedLinkage } from './capture-linkage.js';

export interface AppOptions {
  store: InvestigationStore;
  fetcher?: Fetcher;
  staticDirectory?: string;
  logger?: boolean;
  rateLimit?: number;
  research?: ResearchOptions;
  extraction?: ExtractionOptions;
  priority?: PriorityOptions;
  reviewer?: Omit<ApprovalRouteOptions, 'reports'> & { issuer: string; audience: string; clientId?: string };
  sentryEnabled?: boolean;
  /** Explicit opt-in only; immutable private reports are never served publicly. */
  sharing?: SharingOptions;
  /** Optional Auth0-protected single workspace; never enables anonymous APIs. */
  publicOrigin?: string;
  /** Optional durable executor owns persistence; the local path saves below. */
  executeInvestigation?: (input: InvestigationInput, options?: { previousInvestigationId?: string; signal?: AbortSignal }) => Promise<Investigation>;
}

/** Local desk by default; optional hosted access is one permissioned workspace. */
export async function createApp(options: AppOptions) {
  if (options.sharing && !options.reviewer?.clientId) throw new Error('Public sharing requires complete human reviewer authentication.');
  let publicOrigin: string | undefined;
  if (options.publicOrigin) {
    const parsed = new URL(publicUrlSchema.parse(options.publicOrigin));
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || !options.reviewer?.clientId) {
      throw new Error('Hosted mode requires an HTTPS origin and complete reviewer authentication.');
    }
    publicOrigin = parsed.origin;
  }
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 96_000,
    requestTimeout: 30_000,
    connectionTimeout: 90_000,
    genReqId: () => randomUUID(),
    // Body, source text, and database credentials must never appear in logs.
    logController: new LogController({ disableRequestLogging: true }),
  });
  // Host checks prevent rebinding; hosted APIs additionally require signed JWTs.
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  app.addHook('onRequest', async (request, reply) => {
    let host: URL;
    try { host = new URL(`http://${request.headers.host ?? ''}`); }
    catch { return reply.code(403).send({ error: 'This investigation desk accepts local requests only.' }); }
    if ((!loopbackHosts.has(host.hostname) && (!publicOrigin || host.host !== new URL(publicOrigin).host)) || host.username || host.password) {
      return reply.code(403).send({ error: 'This investigation desk accepts local requests only.' });
    }
    const origin = request.headers.origin;
    if (origin) {
      const address = app.server.address();
      const apiPort = address && typeof address === 'object' ? String(address.port) : '8787';
      let parsed: URL;
      try { parsed = new URL(origin); }
      catch { return reply.code(403).send({ error: 'This request did not originate at the local investigation desk.' }); }
      const allowed = publicOrigin ? parsed.origin === publicOrigin : parsed.protocol === 'http:' && loopbackHosts.has(parsed.hostname) && new Set(['5173', apiPort]).has(parsed.port);
      if (parsed.origin !== origin || !allowed) {
        return reply.code(403).send({ error: 'This request did not originate at the local investigation desk.' });
      }
    }
  });
  await app.register(rateLimit, { global: !publicOrigin, max: options.rateLimit ?? 30, timeWindow: '1 minute' });
  const principals = new WeakMap<FastifyRequest, string>();
  const workspaceLimit = app.createRateLimit({ max: options.rateLimit ?? 30, timeWindow: '1 minute',
    keyGenerator: (request) => `workspace:${principals.get(request) ?? 'no_verified_principal'}` });
  const rejectedAuthLimit = app.createRateLimit({ max: 60, timeWindow: '1 minute',
    keyGenerator: (request) => `failed-auth:${request.ip}` });
  const sharedReadLimit = app.createRateLimit({ max: 60, timeWindow: '1 minute',
    keyGenerator: (request) => `shared-read:${request.ip}` });
  if (publicOrigin) app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    const sharedRead = ['GET', 'HEAD'].includes(request.method) && /^\/api\/shared-reports\/[a-f0-9]{64}$/.test(path);
    const publicRead = ['GET', 'HEAD'].includes(request.method) &&
      (['/', '/api/health', '/api/reviewer-config', '/favicon.ico'].includes(path) ||
        sharedRead ||
        /^\/assets\/[A-Za-z0-9_.-]+$/.test(path) || /^\/fonts\/[A-Za-z0-9_.-]+\.(ttf|woff2?)$/.test(path));
    if (sharedRead) {
      const limit = await sharedReadLimit(request);
      if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: 'Too many shared-finding requests. Please wait.' });
    }
    if (publicRead) return;
    try {
      const principal = await options.reviewer!.authenticator.verify(request.headers.authorization);
      principals.set(request, principal.subjectHash);
    }
    catch (error) {
      const limit = await rejectedAuthLimit(request);
      if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: 'Too many unsuccessful sign-in requests. Please wait.' });
      const status = error instanceof ReviewAuthorizationError ? error.statusCode : 503;
      if (status === 401) reply.header('www-authenticate', 'Bearer');
      return reply.code(status).send({ error: status === 403 ? 'This account does not have workspace access.' : status === 401 ? 'Sign in to access this private workspace.' : 'Workspace authentication is temporarily unavailable.' });
    }
    const limit = await workspaceLimit(request);
    if (!limit.isAllowed && limit.isExceeded) {
      reply.header('retry-after', String(limit.ttlInSeconds));
      return reply.code(429).send({ error: 'This reviewer has reached the workspace request limit. Please wait.' });
    }
  });
  let successfulWorkflowRuns = 0;
  let activeChecks = 0;
  const reviewerOrigin = options.reviewer ? new URL(options.reviewer.issuer).origin : '';

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${reviewerOrigin}; frame-src 'self' ${reviewerOrigin}; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
    if (_request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (error instanceof CaptureLinkageError) {
      void reply.code(error.statusCode).send({ error: error.message });
    } else if (error instanceof StorageFullError) {
      void reply.code(507).send({ error: error.message });
    } else if (statusCode === 413) {
      void reply.code(413).send({ error: 'The request is too large. Keep advertisement text under 16,000 characters.' });
    } else if (statusCode >= 400 && statusCode < 500) {
      void reply.code(statusCode).send({ error: statusCode === 429 ? 'Too many requests. Please wait before investigating again.' : 'The request could not be read. Send a valid JSON investigation request.' });
    } else {
      // Deliberately do not log error objects: drivers may include secret-bearing URIs.
      app.log.error({ requestId: _request.id }, 'Investigation request failed');
      void reply.code(503).send({ error: 'The investigation could not be saved. Please try again; no report was published.' });
    }
  });

  app.get('/api/health', async (): Promise<Health> => {
    const pending = (name: string, detail: string): SponsorStatus => ({ name, status: 'not_implemented', detail });
    return { status: 'ok', storage: options.store.kind, sponsors: [
      { name: 'Mastra', status: successfulWorkflowRuns > 0 ? 'local_verified' : 'configured_unverified',
        detail: successfulWorkflowRuns > 0 ? 'The deterministic investigation workflow completed locally. No model or agent inference is implied.' : 'Workflow is installed; no completed run observed in this process yet.' },
      { name: 'MongoDB Atlas', status: options.store.kind === 'mongodb' ? 'configured_unverified' : 'not_configured',
        detail: options.store.kind === 'mongodb' ? 'MongoDB connection active. Atlas hosting and a saved read/write receipt must be independently verified.' : 'Reports use local files. Atlas is not configured.' },
      { name: 'Tinker', status: options.extraction?.artifactPath && options.extraction?.pythonPath ? 'configured_unverified' : 'not_configured', detail: 'A private fine-tuned identity extractor can be configured. Successful inference and model benchmark results are recorded separately.' },
      { name: 'TabPFN', status: options.priority?.contextPath && options.priority?.pythonPath ? 'configured_unverified' : 'not_configured', detail: 'A pre-verification shortlist ranker can be configured. Ranking is separate from opening availability; benchmark limits are documented.' },
      pending('Render', 'No hosted deployment has been verified.'),
      { name: 'SerpApi', status: options.research?.discovery?.apiKey ? 'configured_unverified' : 'not_configured', detail: 'Bounded source discovery is implemented. Live provider evidence is tracked separately.' },
      { name: 'Browserbase', status: options.research?.capture?.apiKey ? 'configured_unverified' : 'not_configured', detail: 'Private browser-artifact capture is implemented. A successful live capture is still required.' },
      { name: 'Temporal', status: options.executeInvestigation ? (successfulWorkflowRuns > 0 ? 'local_verified' : 'configured_unverified') : 'not_configured',
        detail: options.executeInvestigation ? 'A local durable executor is selected. Historical crash-recovery evidence is recorded separately in docs/TEMPORAL.md.' : 'Direct local execution is selected; Temporal is optional. See docs/TEMPORAL.md for the tested local recovery path.' },
      { name: 'Sentry', status: options.sentryEnabled ? 'configured_unverified' : 'not_configured', detail: 'Workflow and tool spans are implemented with content collection disabled. A provider trace receipt is required.' },
      { name: 'Auth0', status: options.reviewer ? 'configured_unverified' : 'not_configured', detail: 'Digest-bound private reviewer approval is implemented. Live Auth0 verification remains a separate gate.' },
    ] };
  });
  await registerResearchRoutes(app, options.research);
  await registerExtractionRoutes(app, options.extraction);
  await registerPriorityRoutes(app, options.priority);
  app.get('/api/reviewer-config', async () => options.reviewer?.clientId
    ? { configured: true, requiresAuthentication: Boolean(publicOrigin), sharingEnabled: Boolean(options.sharing), issuer: options.reviewer.issuer, audience: options.reviewer.audience, clientId: options.reviewer.clientId }
    : { configured: false, requiresAuthentication: false, sharingEnabled: false });
  app.get('/api/workspace', async () => ({ authorized: true, visibility: 'private_workspace' }));
  if (options.reviewer) await registerApprovalRoutes(app, { ...options.reviewer, reports: options.store });
  if (options.sharing && options.reviewer) await registerReleaseRoutes(app, { ...options.sharing,
    reports: options.store, approvals: options.reviewer.approvals, authenticator: options.reviewer.authenticator });
  app.get('/api/investigations', async () => options.store.list());

  app.post('/api/investigations', async (request, reply) => {
    const parsed = investigationInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a public HTTPS job URL. An optional official URL must use HTTPS, and advertisement text must be under 16,000 characters.' });
    if (activeChecks >= 2) return reply.code(429).send({ error: 'Two investigations are already running. Please try again shortly.' });
    activeChecks++;
    const controller = new AbortController();
    const onClose = () => { if (request.raw.aborted) controller.abort(); };
    request.raw.on('close', onClose);
    try {
      if (options.executeInvestigation) await loadCapturedLinkage(parsed.data, options.research?.artifacts);
      const report = options.executeInvestigation
        ? await options.executeInvestigation(parsed.data, { signal: controller.signal })
        : await runInvestigation(parsed.data, { fetcher: options.fetcher, signal: controller.signal, artifacts: options.research?.artifacts });
      if (!options.executeInvestigation) await options.store.put(report);
      successfulWorkflowRuns++;
      return reply.code(201).send(report);
    } finally { activeChecks--; request.raw.off('close', onClose); }
  });

  app.get<{ Params: { id: string } }>('/api/investigations/:id', async (request, reply) => {
    if (!reportIdSchema.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Investigation not found.' });
    const report = await options.store.get(request.params.id);
    return report ?? reply.code(404).send({ error: 'Investigation not found.' });
  });
  app.post<{ Params: { id: string } }>('/api/investigations/:id/recheck', async (request, reply) => {
    if (!reportIdSchema.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Investigation not found.' });
    const replacement = z.object({ captureArtifactId: reportIdSchema.optional() }).strict().safeParse(request.body === undefined ? {} : request.body);
    if (!replacement.success) return reply.code(400).send({ error: 'A recheck accepts only an optional saved capture reference; the original advertisement and posting identity cannot be changed.' });
    const previous = await options.store.get(request.params.id);
    if (!previous) return reply.code(404).send({ error: 'Investigation not found.' });
    const input = { ...previous.input, ...(replacement.data.captureArtifactId ? { captureArtifactId: replacement.data.captureArtifactId } : {}) };
    if (activeChecks >= 2) return reply.code(429).send({ error: 'Two investigations are already running. Please try again shortly.' });
    activeChecks++;
    try {
      if (options.executeInvestigation) await loadCapturedLinkage(input, options.research?.artifacts);
      const report = options.executeInvestigation
        ? await options.executeInvestigation(input, { previousInvestigationId: previous.id })
        : await runInvestigation(input, { fetcher: options.fetcher, previousInvestigationId: previous.id, artifacts: options.research?.artifacts });
      if (!options.executeInvestigation) await options.store.put(report);
      successfulWorkflowRuns++;
      return reply.code(201).send(report);
    } finally { activeChecks--; }
  });
  app.get<{ Params: { id: string } }>('/api/investigations/:id/report', async (request, reply) => {
    if (!reportIdSchema.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Investigation not found.' });
    const report = await options.store.get(request.params.id);
    if (!report) return reply.code(404).send({ error: 'Investigation not found.' });
    reply.header('content-disposition', `attachment; filename="vacancy-autopsy-${report.id}.json"`);
    reply.type('application/json; charset=utf-8');
    return JSON.stringify(report, null, 2);
  });

  if (options.staticDirectory && existsSync(options.staticDirectory)) {
    await app.register(fastifyStatic, { root: options.staticDirectory });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Route not found.' });
    });
  }
  app.addHook('onClose', async () => options.store.close());
  return app;
}
