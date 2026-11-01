import { z } from 'zod';

export const triageLeadResultSchema = z.object({
  id: z.string(), url: z.string().url().startsWith('https://'), role: z.string().optional(), rank: z.number().int().min(1).max(20),
  priority: z.number().min(0).max(1), checked: z.boolean(), reason: z.string().min(1),
  reportId: z.string().uuid().optional(), verdict: z.enum(['verified_open', 'not_listed', 'inconclusive']).optional(),
  error: z.string().optional(),
}).strict().refine(row => row.checked || (!row.reportId && !row.verdict && !row.error))
  .refine(row => Boolean(row.reportId) === Boolean(row.verdict));
export type TriageLeadResult = z.infer<typeof triageLeadResultSchema>;

export const triageResultSchema = z.object({
  runId: z.string().uuid(), createdAt: z.string().datetime(), total: z.number().int().min(2).max(20),
  checkBudget: z.number().int().min(1).max(20), checksUsed: z.number().int().min(0).max(20),
  checksSaved: z.number().int().min(0).max(20), historyRows: z.number().int().nonnegative(),
  relativeOnly: z.literal(true), ranked: z.array(triageLeadResultSchema).min(2).max(20),
}).strict().refine(result => result.ranked.length === result.total && result.checkBudget <= result.total &&
  result.checksUsed <= result.checkBudget && result.checksUsed === result.ranked.filter(row => row.checked).length &&
  result.checksSaved === result.total - result.checksUsed && new Set(result.ranked.map(row => row.id)).size === result.total &&
  result.ranked.every((row, index, rows) =>
    row.rank === (index > 0 && row.priority === rows[index - 1].priority ? rows[index - 1].rank : index + 1) &&
    (index === 0 || row.priority <= rows[index - 1].priority)));
export type TriageResult = z.infer<typeof triageResultSchema>;
