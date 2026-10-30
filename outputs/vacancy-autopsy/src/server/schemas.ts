import { z } from 'zod';

export const publicUrlSchema = z.string().trim().max(2048).url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    !url.hostname.includes(':') && !/^\d+(\.\d+){3}$/.test(url.hostname) &&
    url.hostname.includes('.') && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname);
}, 'Use a public HTTPS URL without credentials or a custom port.');

export const investigationInputSchema = z.object({
  url: publicUrlSchema,
  officialUrl: publicUrlSchema.optional(),
  advertisementText: z.string().trim().max(16000).optional(),
}).strict();

export const identitySchema = z.object({
  ats: z.enum(['greenhouse', 'lever', 'ashby']),
  board: z.string().min(1).max(100),
  jobId: z.string().min(1).max(100),
  officialUrl: publicUrlSchema,
  region: z.enum(['global', 'eu']),
});
export type Identity = z.infer<typeof identitySchema>;

export const evidenceSchema = z.object({
  id: z.string(), kind: z.enum(['official_feed', 'advertisement', 'browser_capture']),
  url: publicUrlSchema, capturedAt: z.string().datetime(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string(), httpStatus: z.number().int().optional(), body: z.string().optional(),
});
export const timelineSchema = z.object({
  name: z.string(), status: z.enum(['complete', 'warning', 'failed', 'skipped']),
  detail: z.string(), at: z.string().datetime(),
});
export const investigationSchema = z.object({
  id: z.string().uuid(), input: investigationInputSchema,
  createdAt: z.string().datetime(), checkedAt: z.string().datetime(),
  verdict: z.enum(['verified_open', 'not_listed', 'inconclusive']),
  title: z.string(), employer: z.string(), jobId: z.string().optional(),
  ats: z.enum(['greenhouse', 'lever', 'ashby']).optional(), officialUrl: publicUrlSchema.optional(),
  explanation: z.string(), limitations: z.array(z.string()), evidence: z.array(evidenceSchema),
  timeline: z.array(timelineSchema), mode: z.enum(['live', 'illustrative']),
  publication: z.literal('private'), previousInvestigationId: z.string().uuid().optional(),
});

export const reportIdSchema = z.string().uuid();
