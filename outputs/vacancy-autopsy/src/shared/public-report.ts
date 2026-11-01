import { z } from 'zod';

export const PUBLIC_RELEASE_CONFIRMATION = 'Publish this exact reviewed source finding';
export const PUBLIC_WITHDRAW_CONFIRMATION = 'Withdraw this shared finding';
export const PUBLIC_FINDING_STATEMENTS = {
  verified_open: 'The exact posting was present in the checked public ATS source at the recorded time.',
  not_listed: 'The exact posting ID was absent from a complete checked public ATS board response at the recorded time.',
  inconclusive: 'The checked public ATS source did not support a conclusive availability finding at the recorded time.',
};
export const PUBLIC_FINDING_LIMITATIONS = [
  'This is a timestamped source observation. The posting may have changed since this check; no application was submitted.',
  'A missing posting does not establish employer intent, fraud or prior removal. A present posting does not guarantee a hire.',
  'The board identifier comes from the supplied ATS URL; company-domain ownership and linkage to any third-party advertisement are not independently established.',
];
export const publicReleaseIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const publicSourceUrl = z.string().max(2048).url().refine((value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash; }
  catch { return false; }
}, 'A credential-free public HTTPS source URL is required.');
export const publicFindingSchema = z.object({
  policyVersion: z.literal(1),
  scope: z.literal('official_source_only'),
  title: z.string().min(1).max(1000),
  board: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  ats: z.enum(['greenhouse', 'lever', 'ashby']),
  jobId: z.string().min(1).max(100),
  officialUrl: publicSourceUrl,
  verdict: z.enum(['verified_open', 'not_listed', 'inconclusive']),
  checkedAt: z.string().datetime(),
  statement: z.string().min(1).max(500),
  limitations: z.array(z.string().max(500)).min(1).max(5),
  sources: z.array(z.object({ url: publicSourceUrl, capturedAt: z.string().datetime(), sha256: publicReleaseIdSchema }).strict()).min(1).max(11),
}).strict();
export type PublicFinding = z.infer<typeof publicFindingSchema>;
export const sharedFindingSchema = z.object({
  id: publicReleaseIdSchema, publishedAt: z.string().datetime(), finding: publicFindingSchema,
}).strict();
export type SharedFinding = z.infer<typeof sharedFindingSchema>;
export interface SharePreview {
  reportDigest: string;
  previewDigest: string;
  finding: PublicFinding;
  publishable: boolean;
  release: { id: string; publishedAt: string; withdrawnAt?: string } | null;
}
