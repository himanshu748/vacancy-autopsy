import { randomUUID } from 'node:crypto';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Investigation, InvestigationInput } from '../shared/types.js';
import { verifyFeed, hashBody, type Fetcher } from './ats.js';
import { identify, sanitizeInput } from './identity.js';
import { evidenceSchema, identitySchema, investigationInputSchema, investigationSchema, timelineSchema } from './schemas.js';

const requestSchema = z.object({ input: investigationInputSchema, previousInvestigationId: z.string().uuid().optional() });
const identifiedSchema = requestSchema.extend({
  id: z.string().uuid(), createdAt: z.string().datetime(), identity: identitySchema.nullable(),
  linkageVerified: z.boolean(), warning: z.string().optional(),
  evidence: z.array(evidenceSchema), timeline: z.array(timelineSchema),
});
const checkedSchema = identifiedSchema.extend({
  feed: z.object({ verdict: z.enum(['verified_open', 'not_listed', 'inconclusive']),
    title: z.string().optional(), explanation: z.string(), limitations: z.array(z.string()),
    evidence: z.array(evidenceSchema), checkedAt: z.string().datetime() }),
});

export interface InvestigationOptions { fetcher?: Fetcher; signal?: AbortSignal; previousInvestigationId?: string }

/** A deterministic Mastra workflow. No model call or durable execution is implied. */
export async function runInvestigation(rawInput: InvestigationInput, options: InvestigationOptions = {}): Promise<Investigation> {
  const input = sanitizeInput(investigationInputSchema.parse(rawInput));
  const extractIdentity = createStep({
    id: 'resolve-posting-identity', inputSchema: requestSchema, outputSchema: identifiedSchema,
    execute: async ({ inputData }) => {
      const createdAt = new Date().toISOString();
      const identityResult = identify(inputData.input);
      const evidence = inputData.input.advertisementText ? [{
        id: randomUUID(), kind: 'advertisement' as const, url: inputData.input.url,
        capturedAt: createdAt, sha256: hashBody(inputData.input.advertisementText),
        body: inputData.input.advertisementText,
        summary: 'User-supplied advertisement text recorded at this time. The original advertisement page was not fetched or independently captured.',
      }] : [];
      return { ...inputData, id: randomUUID(), createdAt, ...identityResult, evidence,
        timeline: [{ name: identityResult.identity ? 'Job identity resolved' : 'Job identity unresolved', status: identityResult.identity ? 'complete' as const : 'warning' as const,
          detail: identityResult.identity ? `Exact ${identityResult.identity.ats} posting ID read from the supplied URL.` : identityResult.warning!,
          at: createdAt }] };
    },
  });
  const checkOfficialSource = createStep({
    id: 'check-public-job-feed', inputSchema: identifiedSchema, outputSchema: checkedSchema,
    execute: async ({ inputData }) => {
      const feed = inputData.identity ? await verifyFeed(inputData.identity, options) : {
        verdict: 'inconclusive' as const, explanation: inputData.warning ?? 'No verifiable posting identity was supplied.',
        limitations: ['No official job feed was fetched because the posting identity could not be resolved.'],
        evidence: [], checkedAt: new Date().toISOString(),
      };
      return { ...inputData, feed, timeline: [...inputData.timeline, {
        name: inputData.identity ? 'Official source checked' : 'Official check skipped', status: !inputData.identity ? 'skipped' as const : feed.verdict === 'inconclusive' ? 'warning' as const : 'complete' as const,
        detail: feed.explanation, at: feed.checkedAt,
      }] };
    },
  });
  const sealEvidence = createStep({
    id: 'seal-qualified-evidence-report', inputSchema: checkedSchema, outputSchema: investigationSchema,
    execute: async ({ inputData }) => {
      const evidence = [...inputData.evidence, ...inputData.feed.evidence];
      const limitations = [...inputData.feed.limitations];
      if (inputData.warning) limitations.unshift(inputData.warning);
      if (inputData.input.advertisementText) limitations.push('Pasted advertisement text is user-supplied, not an independent browser capture.');
      limitations.push('URL query strings and fragments were removed before storage to reduce accidental token retention.');
      const verdict = inputData.linkageVerified ? inputData.feed.verdict : 'inconclusive';
      return {
        id: inputData.id, input: inputData.input, createdAt: inputData.createdAt,
        checkedAt: inputData.feed.checkedAt, verdict,
        title: inputData.feed.title ?? (inputData.identity ? `Posting ${inputData.identity.jobId}` : 'Unresolved job advertisement'),
        employer: inputData.identity ? `${inputData.identity.board} (board identifier)` : 'Employer not verified',
        ...(inputData.identity ? { jobId: inputData.identity.jobId, ats: inputData.identity.ats, officialUrl: inputData.identity.officialUrl } : {}),
        explanation: !inputData.linkageVerified && inputData.identity ?
          `${inputData.warning} Official-source observation: ${inputData.feed.explanation}` : inputData.feed.explanation,
        limitations, evidence,
        timeline: [...inputData.timeline, {
          name: 'Evidence recorded', status: evidence.length ? 'complete' as const : 'warning' as const,
          detail: evidence.length ? `${evidence.length} source record${evidence.length === 1 ? '' : 's'} retained with capture timestamps and SHA-256 body hashes.` : 'No source response was captured. No finding can be supported by a snapshot.',
          at: new Date().toISOString(),
        }, {
          name: 'Qualified verdict prepared', status: verdict === 'inconclusive' ? 'warning' as const : 'complete' as const,
          detail: 'The source observation is ready to inspect. This report is saved privately.',
          at: new Date().toISOString(),
        }],
        mode: 'live' as const, publication: 'private' as const,
        ...(inputData.previousInvestigationId ? { previousInvestigationId: inputData.previousInvestigationId } : {}),
      };
    },
  });
  const workflow = createWorkflow({ id: 'vacancy-autopsy-investigation', inputSchema: requestSchema,
    outputSchema: investigationSchema })
    .then(extractIdentity).then(checkOfficialSource).then(sealEvidence).commit();
  const run = await workflow.createRun();
  const result = await run.start({ inputData: { input, previousInvestigationId: options.previousInvestigationId } });
  if (result.status !== 'success') throw new Error('The investigation workflow did not complete successfully.');
  return investigationSchema.parse(result.result);
}
