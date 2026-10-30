import 'dotenv/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createApp } from './app.js';
import { LocalStore, MongoStore } from './store.js';
import { createTemporalExecutor } from '../temporal/client.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let durableExecutor: Awaited<ReturnType<typeof createTemporalExecutor>> | undefined;
try {
  const store = process.env.MONGODB_URI
    ? await MongoStore.connect(process.env.MONGODB_URI, process.env.MONGODB_DATABASE ?? 'vacancy_autopsy')
    : new LocalStore(process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(root, 'data'));
  durableExecutor = process.env.TEMPORAL_ADDRESS ? await createTemporalExecutor({ store,
    address: process.env.TEMPORAL_ADDRESS, namespace: process.env.TEMPORAL_NAMESPACE,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE }) : undefined;
  app = await createApp({ store, staticDirectory: resolve(root, 'dist'), logger: true,
    executeInvestigation: durableExecutor?.execute });
  app.addHook('onClose', async () => durableExecutor?.close());
  const shutdown = async () => { await app?.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ host, port });
}
catch {
  // Avoid printing driver errors or a credential-bearing URI.
  console.error('Vacancy Autopsy could not start. Check the port and storage configuration.');
  await app?.close();
  if (!app) await durableExecutor?.close();
  process.exitCode = 1;
}
