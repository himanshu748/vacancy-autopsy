import 'dotenv/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createApp } from './app.js';
import { LocalStore, MongoStore, type InvestigationStore } from './store.js';
import { createTemporalExecutor } from '../temporal/client.js';
import { initializeObservability, flushObservability } from './observability.js';
import { LocalArtifactStore } from './research.js';
import { createAuth0Verifier } from './auth.js';
import { LocalApprovalStore } from './approvals.js';
import { connectMongoWorkspace, type MongoWorkspace } from './mongo-workspace.js';
import { onceCleanup, settleCleanup } from './shutdown.js';
import { resolvePublicOrigin } from './hosting.js';
import { LocalReleaseStore, MongoReleaseStore, type ReleaseStore } from './releases.js';
import { LocalTriageHistory, resolveTriageHistoryPath } from './triage.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? 8787);
let publicOrigin: string | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let durableExecutor: Awaited<ReturnType<typeof createTemporalExecutor>> | undefined;
let workspace: MongoWorkspace | undefined;
let store: InvestigationStore | undefined;
let releases: ReleaseStore | undefined;
let closeApprovals: () => Promise<void> = async () => {};
try {
  publicOrigin = resolvePublicOrigin(process.env);
  const host = process.env.HOST ?? (publicOrigin ? '0.0.0.0' : '127.0.0.1');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !publicOrigin) throw new Error('Network binding requires authenticated hosted mode.');
  if (publicOrigin && (!process.env.MONGODB_URI || !process.env.AUTH0_ISSUER_BASE_URL || !process.env.AUTH0_AUDIENCE || !process.env.AUTH0_CLIENT_ID)) {
    throw new Error('Hosted mode requires persistent MongoDB and complete Auth0 configuration.');
  }
  const sentryEnabled = initializeObservability({ dsn: process.env.SENTRY_DSN, environment: process.env.SENTRY_ENVIRONMENT });
  if (process.env.PUBLIC_SHARING_ENABLED && !['true', 'false'].includes(process.env.PUBLIC_SHARING_ENABLED)) throw new Error('PUBLIC_SHARING_ENABLED must be true or false.');
  const sharingEnabled = process.env.PUBLIC_SHARING_ENABLED === 'true';
  const dataDirectory = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(root, 'data');
  const triageHistoryPath = resolveTriageHistoryPath({ dataDirectory,
    explicitDataDirectory: Boolean(process.env.DATA_DIR), hosted: Boolean(publicOrigin),
    priorityContextPath: process.env.TABPFN_PRIORITY_CONTEXT });
  const reviewValues = [process.env.AUTH0_ISSUER_BASE_URL, process.env.AUTH0_AUDIENCE];
  if (reviewValues.some(Boolean) && !reviewValues.every(Boolean)) throw new Error('Complete Auth0 configuration is required.');
  const authenticator = process.env.AUTH0_ISSUER_BASE_URL && process.env.AUTH0_AUDIENCE
    ? createAuth0Verifier({ issuer: process.env.AUTH0_ISSUER_BASE_URL, audience: process.env.AUTH0_AUDIENCE }) : undefined;
  if (process.env.MONGODB_URI) workspace = await connectMongoWorkspace(process.env.MONGODB_URI, process.env.MONGODB_DATABASE ?? 'vacancy_autopsy');
  const reviewer = process.env.AUTH0_ISSUER_BASE_URL && process.env.AUTH0_AUDIENCE ? {
    issuer: process.env.AUTH0_ISSUER_BASE_URL, audience: process.env.AUTH0_AUDIENCE, clientId: process.env.AUTH0_CLIENT_ID,
    authenticator: authenticator!,
    approvals: workspace?.approvals ?? new LocalApprovalStore(resolve(dataDirectory, 'approvals')),
  } : undefined;
  if (reviewer) {
    closeApprovals = onceCleanup(reviewer.approvals.close.bind(reviewer.approvals));
    reviewer.approvals.close = closeApprovals;
  }
  if (sharingEnabled) {
    if (!reviewer?.clientId) throw new Error('Sharing requires complete human reviewer authentication.');
    releases = process.env.MONGODB_URI
      ? await MongoReleaseStore.connect(process.env.MONGODB_URI, process.env.MONGODB_DATABASE ?? 'vacancy_autopsy')
      : new LocalReleaseStore(resolve(dataDirectory, 'shared-findings'));
    releases.close = onceCleanup(releases.close.bind(releases));
  }
  store = process.env.MONGODB_URI
    ? await MongoStore.connect(process.env.MONGODB_URI, process.env.MONGODB_DATABASE ?? 'vacancy_autopsy')
    : new LocalStore(dataDirectory);
  store.close = onceCleanup(store.close.bind(store));
  durableExecutor = process.env.TEMPORAL_ADDRESS ? await createTemporalExecutor({ store,
    address: process.env.TEMPORAL_ADDRESS, namespace: process.env.TEMPORAL_NAMESPACE,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE }) : undefined;
  if (durableExecutor) durableExecutor.close = onceCleanup(durableExecutor.close.bind(durableExecutor));
  app = await createApp({ store, staticDirectory: resolve(root, 'dist'), logger: true,
    executeInvestigation: durableExecutor?.execute, sentryEnabled, reviewer, publicOrigin,
    sharing: releases ? { releases } : undefined,
    priority: { contextPath: process.env.TABPFN_PRIORITY_CONTEXT, pythonPath: process.env.TABPFN_PYTHON },
    triage: triageHistoryPath ? { history: new LocalTriageHistory(triageHistoryPath) } : undefined,
    extraction: { artifactPath: process.env.TINKER_EXTRACTOR_ARTIFACT,
      pythonPath: process.env.TINKER_PYTHON, tokenizerCachePath: process.env.TINKER_TOKENIZER_CACHE },
    research: { artifacts: workspace?.artifacts ?? new LocalArtifactStore(resolve(dataDirectory, 'sources')),
      discovery: { apiKey: process.env.SERPAPI_API_KEY },
      capture: { apiKey: process.env.BROWSERBASE_API_KEY, projectId: process.env.BROWSERBASE_PROJECT_ID } } });
  app.addHook('onClose', async () => { await settleCleanup([async () => durableExecutor?.close(), async () => workspace?.close()]); });
  const shutdown = async () => {
    const stopped = await settleCleanup([async () => app?.close()]);
    const closed = await settleCleanup([async () => durableExecutor?.close(), closeApprovals, async () => releases?.close(), async () => workspace?.close(), async () => store?.close(), flushObservability]);
    process.exit(stopped && closed ? 0 : 1);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ host, port });
}
catch {
  // Avoid printing driver errors or a credential-bearing URI.
  console.error('Vacancy Autopsy could not start. Check the port and storage configuration.');
  await settleCleanup([async () => app?.close()]);
  await settleCleanup([async () => durableExecutor?.close(), closeApprovals, async () => releases?.close(), async () => workspace?.close(), async () => store?.close()]);
  process.exitCode = 1;
}
