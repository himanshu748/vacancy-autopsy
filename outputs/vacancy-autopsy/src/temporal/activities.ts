import { ApplicationFailure } from '@temporalio/activity';
import type { Investigation } from '../shared/types.js';
import type { Fetcher } from '../server/ats.js';
import { sanitizeInput } from '../server/identity.js';
import { investigationInputSchema, reportIdSchema } from '../server/schemas.js';
import { runInvestigation } from '../server/workflow.js';
import { StorageFullError, type InvestigationStore } from '../server/store.js';
import type { ArtifactStore } from '../server/research.js';
import { CaptureLinkageError } from '../server/capture-linkage.js';
import type { DurableActivities, DurableRequest, ReportReference } from './contracts.js';

export interface ActivityDependencies {
  store: InvestigationStore;
  fetcher?: Fetcher;
  artifacts?: ArtifactStore;
  signal?: () => AbortSignal;
  /** Dependency-injected recovery probe, never enabled by API input or env. */
  afterPersist?: (report: Investigation) => Promise<void>;
  onReuse?: (report: Investigation) => Promise<void>;
}

function reference(report: Investigation, reused: boolean): ReportReference {
  return { reportId: report.id, verdict: report.verdict, checkedAt: report.checkedAt, reused };
}

function assertSameOperation(existing: Investigation, request: DurableRequest): void {
  const sanitized = sanitizeInput(request.input);
  if (JSON.stringify(existing.input) !== JSON.stringify(sanitized) || existing.previousInvestigationId !== request.previousInvestigationId) {
    throw ApplicationFailure.nonRetryable('The operation ID is already bound to a different investigation.', 'OperationConflict');
  }
}

export function createActivities(dependencies: ActivityDependencies): DurableActivities {
  return {
    async investigateAndSave(request) {
      try {
        const parsed = investigationInputSchema.safeParse(request.input);
        if (!reportIdSchema.safeParse(request.operationId).success || !parsed.success ||
          (request.previousInvestigationId && !reportIdSchema.safeParse(request.previousInvestigationId).success)) {
          throw ApplicationFailure.nonRetryable('The investigation input or operation ID is invalid.', 'ValidationError');
        }
        request = { ...request, input: parsed.data };
        const existing = await dependencies.store.get(request.operationId);
        if (existing) {
          assertSameOperation(existing, request);
          await dependencies.onReuse?.(existing);
          return reference(existing, true);
        }
        const report = await runInvestigation(request.input, {
          fetcher: dependencies.fetcher,
          signal: dependencies.signal?.(),
          previousInvestigationId: request.previousInvestigationId,
          artifacts: dependencies.artifacts,
        });
        report.id = request.operationId;
        try {
          await dependencies.store.put(report);
        } catch (error) {
          // A timed-out worker can overlap its retry. A single immutable report ID
          // arbitrates publication; the loser uses the already persisted winner.
          const winner = await dependencies.store.get(request.operationId);
          if (winner) {
            assertSameOperation(winner, request);
            await dependencies.onReuse?.(winner);
            return reference(winner, true);
          }
          if (error instanceof StorageFullError) {
            throw ApplicationFailure.nonRetryable(error.message, 'StorageFullError');
          }
          throw error;
        }
        await dependencies.afterPersist?.(report);
        return reference(report, false);
      } catch (error) {
        if (error instanceof ApplicationFailure) throw error;
        if (error instanceof CaptureLinkageError) throw ApplicationFailure.nonRetryable(error.message, 'CaptureLinkageError');
        // Temporal persists Activity errors in history and logs them. Database
        // drivers can include a secret-bearing URI, so discard original causes.
        throw new Error('The investigation activity could not read or save its evidence; retry is bounded.');
      }
    },
  };
}
