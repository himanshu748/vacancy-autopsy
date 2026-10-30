import Fastify, { LogController } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Health, SponsorStatus, Investigation, InvestigationInput } from '../shared/types.js';
import { investigationInputSchema, reportIdSchema } from './schemas.js';
import { runInvestigation } from './workflow.js';
import { StorageFullError, type InvestigationStore } from './store.js';
import type { Fetcher } from './ats.js';

export interface AppOptions {
  store: InvestigationStore;
  fetcher?: Fetcher;
  staticDirectory?: string;
  logger?: boolean;
  rateLimit?: number;
  /** Optional durable executor owns persistence; the local path saves below. */
  executeInvestigation?: (input: InvestigationInput, options?: { previousInvestigationId?: string; signal?: AbortSignal }) => Promise<Investigation>;
}

/** Local single-user API. Public, multi-tenant hosting requires authentication. */
export async function createApp(options: AppOptions) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 96_000,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    genReqId: () => randomUUID(),
    // Body, source text, and database credentials must never appear in logs.
    logController: new LogController({ disableRequestLogging: true }),
  });
  // Loopback binding alone does not stop DNS rebinding. This baseline is a
  // single-user local app; authenticated public hosting is a separate gate.
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  app.addHook('onRequest', async (request, reply) => {
    let host: URL;
    try { host = new URL(`http://${request.headers.host ?? ''}`); }
    catch { return reply.code(403).send({ error: 'This investigation desk accepts local requests only.' }); }
    if (!loopbackHosts.has(host.hostname) || host.username || host.password) {
      return reply.code(403).send({ error: 'This investigation desk accepts local requests only.' });
    }
    const origin = request.headers.origin;
    if (origin) {
      const address = app.server.address();
      const apiPort = address && typeof address === 'object' ? String(address.port) : '8787';
      let parsed: URL;
      try { parsed = new URL(origin); }
      catch { return reply.code(403).send({ error: 'This request did not originate at the local investigation desk.' }); }
      if (parsed.origin !== origin || parsed.protocol !== 'http:' || !loopbackHosts.has(parsed.hostname) || !new Set(['5173', apiPort]).has(parsed.port)) {
        return reply.code(403).send({ error: 'This request did not originate at the local investigation desk.' });
      }
    }
  });
  await app.register(rateLimit, { max: options.rateLimit ?? 30, timeWindow: '1 minute' });
  let successfulWorkflowRuns = 0;
  let activeChecks = 0;

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (_request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (error instanceof StorageFullError) {
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
      pending('Tinker', 'Fine-tuning and extraction benchmarks have not run.'),
      pending('TabPFN', 'The prediction model is not in this investigation path.'),
      pending('Render', 'No hosted deployment has been verified.'),
      pending('SerpApi', 'Discovery search is not implemented in this local baseline.'),
      pending('Browserbase', 'No remote browser capture is performed.'),
      { name: 'Temporal', status: options.executeInvestigation ? (successfulWorkflowRuns > 0 ? 'local_verified' : 'configured_unverified') : 'not_configured',
        detail: options.executeInvestigation ? 'A local durable executor is selected. Historical crash-recovery evidence is recorded separately in docs/TEMPORAL.md.' : 'Direct local execution is selected; Temporal is optional. See docs/TEMPORAL.md for the tested local recovery path.' },
      pending('Sentry', 'No provider trace has been captured.'),
      pending('Auth0', 'Reports remain private; authenticated publication is not implemented.'),
    ] };
  });
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
      const report = options.executeInvestigation
        ? await options.executeInvestigation(parsed.data, { signal: controller.signal })
        : await runInvestigation(parsed.data, { fetcher: options.fetcher, signal: controller.signal });
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
    const previous = await options.store.get(request.params.id);
    if (!previous) return reply.code(404).send({ error: 'Investigation not found.' });
    if (activeChecks >= 2) return reply.code(429).send({ error: 'Two investigations are already running. Please try again shortly.' });
    activeChecks++;
    try {
      const report = options.executeInvestigation
        ? await options.executeInvestigation(previous.input, { previousInvestigationId: previous.id })
        : await runInvestigation(previous.input, { fetcher: options.fetcher, previousInvestigationId: previous.id });
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
