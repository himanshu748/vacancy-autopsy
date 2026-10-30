import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import type { Investigation, InvestigationInput } from '../shared/types.js';
import type { InvestigationStore } from '../server/store.js';
import { investigationInputSchema } from '../server/schemas.js';
import { sanitizeInput } from '../server/identity.js';
import { DEFAULT_TASK_QUEUE, type DurableRequest, type ReportReference } from './contracts.js';

interface ExecutorOptions {
  store: InvestigationStore;
  address: string;
  namespace?: string;
  taskQueue?: string;
}

export async function createTemporalExecutor(options: ExecutorOptions) {
  // This baseline explicitly supports a local dev service. Cloud credentials,
  // payload encryption, authenticated APIs, and tenant ownership are not set up.
  if (!/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(options.address)) {
    throw new Error('Only a local Temporal dev service is supported by this baseline.');
  }
  const connection = await Connection.connect({ address: options.address, connectTimeout: '5 seconds' });
  const client = new Client({ connection, namespace: options.namespace ?? 'default' });
  return {
    async execute(input: InvestigationInput, runOptions: { previousInvestigationId?: string; signal?: AbortSignal } = {}): Promise<Investigation> {
      const request: DurableRequest = {
        operationId: randomUUID(), input: sanitizeInput(investigationInputSchema.parse(input)),
        ...(runOptions.previousInvestigationId ? { previousInvestigationId: runOptions.previousInvestigationId } : {}),
      };
      const handle = await client.workflow.start('durableInvestigation', {
        workflowId: `vacancy-${request.operationId}`, taskQueue: options.taskQueue ?? DEFAULT_TASK_QUEUE,
        workflowExecutionTimeout: '4 minutes', args: [request],
      });
      // A disconnected HTTP client does not cancel a durable investigation. Its
      // immutable report becomes visible in the local archive when recorded.
      const result = await handle.result() as ReportReference;
      const report = await options.store.get(result.reportId);
      if (!report) throw new Error('The durable workflow completed without a saved evidence report.');
      return report;
    },
    close: () => connection.close(),
  };
}
