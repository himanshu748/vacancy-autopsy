import type { InvestigationInput, Verdict } from '../shared/types.js';

export interface DurableRequest {
  operationId: string;
  input: InvestigationInput;
  previousInvestigationId?: string;
}

/** Only this small reference crosses an Activity result/history boundary. */
export interface ReportReference {
  reportId: string;
  verdict: Verdict;
  checkedAt: string;
  reused: boolean;
}

export interface DurableActivities {
  investigateAndSave(request: DurableRequest): Promise<ReportReference>;
}

export const DEFAULT_TASK_QUEUE = 'vacancy-autopsy-investigations';
