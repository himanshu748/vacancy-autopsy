import { z } from 'zod';

export const alternativeReasonSchema = z.enum(['role_similarity', 'seniority_similarity', 'location_similarity']);
export const alternativesResultSchema = z.object({
  provider: z.literal('ultramarine'), model: z.literal('ultramarine-1-flash'),
  checkedAt: z.string().datetime(), generatedAt: z.string().datetime(), modelCalled: z.boolean(),
  candidatesConsidered: z.number().int().min(0).max(20), candidatesAvailable: z.number().int().nonnegative(),
  alternatives: z.array(z.object({ jobId: z.string().min(1).max(100), title: z.string().min(1).max(500),
    url: z.string().url().startsWith('https://'), location: z.string().max(300).nullable(), reason: alternativeReasonSchema,
  }).strict()).max(3),
  qualification: z.string(), sourceReferences: z.array(z.object({ url: z.string().url().startsWith('https://'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(11),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
  }).strict().refine(value => value.totalTokens === value.inputTokens + value.outputTokens &&
    (value.cachedInputTokens === null || value.cachedInputTokens <= value.inputTokens) &&
    (value.reasoningTokens === null || value.reasoningTokens <= value.outputTokens)).nullable(),
  latencyMs: z.number().nonnegative(), estimatedCostUsd: z.number().nonnegative().nullable(), priceVersion: z.string(),
}).strict().refine(value => value.candidatesConsidered <= value.candidatesAvailable &&
  new Set(value.alternatives.map(item => item.jobId)).size === value.alternatives.length);
export type AlternativesResult = z.infer<typeof alternativesResultSchema>;
