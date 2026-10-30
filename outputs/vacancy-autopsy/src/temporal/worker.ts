import 'dotenv/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { cancellationSignal, heartbeat } from '@temporalio/activity';
import { LocalStore, MongoStore } from '../server/store.js';
import { createActivities } from './activities.js';
import { DEFAULT_TASK_QUEUE, type DurableRequest } from './contracts.js';

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  if (!/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(address)) throw new Error('Only local Temporal is supported.');
  const store = process.env.MONGODB_URI
    ? await MongoStore.connect(process.env.MONGODB_URI, process.env.MONGODB_DATABASE ?? 'vacancy_autopsy')
    : new LocalStore(process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(root, 'data'));
  let connection: NativeConnection | undefined;
  try {
    connection = await NativeConnection.connect({ address });
    const activities = createActivities({ store, signal: cancellationSignal });
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
    await store.close();
    await connection?.close();
  }
}

main().catch(() => {
  console.error('The local investigation worker could not run. Check Temporal and storage configuration.');
  process.exitCode = 1;
});
