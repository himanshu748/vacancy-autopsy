import 'dotenv/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { cancellationSignal, heartbeat } from '@temporalio/activity';
import { LocalStore, MongoStore } from '../server/store.js';
import { createActivities } from './activities.js';
import { DEFAULT_TASK_QUEUE, type DurableRequest } from './contracts.js';
import { initializeObservability, flushObservability } from '../server/observability.js';
import { settleCleanup } from '../server/shutdown.js';
import { LocalArtifactStore } from '../server/research.js';
import { connectMongoWorkspace, type MongoWorkspace } from '../server/mongo-workspace.js';

async function main() {
  initializeObservability({ dsn: process.env.SENTRY_DSN, environment: process.env.SENTRY_ENVIRONMENT });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  if (!/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(address)) throw new Error('Only local Temporal is supported.');
  const store = process.env.MONGODB_URI
    ? await MongoStore.connect(process.env.MONGODB_URI, process.env.MONGODB_DATABASE ?? 'vacancy_autopsy')
    : new LocalStore(process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(root, 'data'));
  let connection: NativeConnection | undefined;
  let workspace: MongoWorkspace | undefined;
  try {
    if (process.env.MONGODB_URI) workspace = await connectMongoWorkspace(process.env.MONGODB_URI, process.env.MONGODB_DATABASE ?? 'vacancy_autopsy');
    const artifacts = workspace?.artifacts ?? new LocalArtifactStore(resolve(process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(root, 'data'), 'sources'));
    connection = await NativeConnection.connect({ address });
    const activities = createActivities({ store, artifacts, signal: cancellationSignal });
    const worker = await Worker.create({
      connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
      activities: {
        async investigateAndSave(request: DurableRequest) {
          const timer = setInterval(() => heartbeat('investigating'), 2000);
          try { return await activities.investigateAndSave(request); }
          finally { clearInterval(timer); }
        },
      },
      maxConcurrentActivityTaskExecutions: 2, maxCachedWorkflows: 10,
      shutdownGraceTime: '10 seconds',
    });
    process.once('SIGINT', () => worker.shutdown());
    process.once('SIGTERM', () => worker.shutdown());
    await worker.run();
  } finally {
    const closed = await settleCleanup([() => store.close(), async () => workspace?.close(), async () => connection?.close(), flushObservability]);
    if (!closed) throw new Error('Worker resources could not all close cleanly.');
  }
}

main().catch(() => {
  console.error('The local investigation worker could not run. Check Temporal and storage configuration.');
  process.exitCode = 1;
});
