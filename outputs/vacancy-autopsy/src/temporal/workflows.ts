import { proxyActivities, defineQuery, setHandler } from '@temporalio/workflow';
import type { DurableActivities, DurableRequest, ReportReference } from './contracts.js';

export const investigationStatus = defineQuery<string>('investigationStatus');

/** Deterministic orchestration only. No networking, credentials, or filesystem. */
export async function durableInvestigation(request: DurableRequest): Promise<ReportReference> {
  let status = 'checking-and-recording';
  setHandler(investigationStatus, () => status);
  const { investigateAndSave } = proxyActivities<DurableActivities>({
    startToCloseTimeout: '45 seconds',
    scheduleToCloseTimeout: '3 minutes',
    heartbeatTimeout: '8 seconds',
    retry: {
      initialInterval: '1 second', maximumInterval: '5 seconds',
      backoffCoefficient: 2, maximumAttempts: 3,
      nonRetryableErrorTypes: ['ValidationError', 'StorageFullError', 'OperationConflict'],
    },
  });
  const result = await investigateAndSave(request);
  status = 'recorded';
  return result;
}
