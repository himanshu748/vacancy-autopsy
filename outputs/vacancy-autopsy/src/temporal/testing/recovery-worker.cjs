// Synthetic source fixture, real Temporal worker process. Only the recovery
// integration test launches this file; it is not part of the app entry point.
const { createRequire } = require('node:module');
const { appendFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const projectRequire = createRequire(process.env.VACANCY_PROBE_PACKAGE);
const { NativeConnection, Worker } = projectRequire('@temporalio/worker');
const { heartbeat } = projectRequire('@temporalio/activity');
const { LocalStore } = projectRequire('./src/server/store.ts');
const { createActivities } = projectRequire('./src/temporal/activities.ts');

async function main() {
  const directory = process.env.VACANCY_PROBE_DIR;
  const store = new LocalStore(join(directory, 'reports'));
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS });
  const activities = createActivities({
    store,
    fetcher: async () => {
      await appendFile(join(directory, 'fetches.txt'), 'synthetic-source-fetch\n');
      return new Response(JSON.stringify({ jobs: [{ id: 123, title: 'Synthetic Recovery Fixture', absolute_url: 'https://job-boards.greenhouse.io/example/jobs/123' }], meta: { total: 1 } }), { headers: { 'content-type': 'application/json' } });
    },
    afterPersist: process.env.VACANCY_PROBE_PAUSE === 'yes' ? async report => {
      await writeFile(join(directory, 'persisted.json'), JSON.stringify({ reportId: report.id, sha256: report.evidence[0].sha256 }));
      await new Promise(() => {});
    } : undefined,
    onReuse: async report => {
      await appendFile(join(directory, 'reused.txt'), report.id + '\n');
    },
  });
  const worker = await Worker.create({
    connection, namespace: 'default', taskQueue: process.env.VACANCY_PROBE_QUEUE,
    workflowsPath: projectRequire.resolve('./src/temporal/workflows.ts'),
    maxCachedWorkflows: 0,
    activities: {
      async investigateAndSave(request) {
        const timer = setInterval(() => heartbeat('recovery-probe'), 1000);
        try { return await activities.investigateAndSave(request); }
        finally { clearInterval(timer); }
      },
    },
  });
  process.once('SIGTERM', () => worker.shutdown());
  process.once('SIGINT', () => worker.shutdown());
  await writeFile(join(directory, 'ready-' + process.pid), 'ready');
  try { await worker.run(); }
  finally { await store.close(); await connection.close(); }
}
main().catch(() => { console.error('Recovery fixture worker failed.'); process.exitCode = 1; });
