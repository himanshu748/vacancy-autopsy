import { randomUUID } from 'node:crypto';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Evidence, Investigation, InvestigationInput } from '../shared/types.js';
import { verifyFeed, hashBody, type Fetcher } from './ats.js';
import { identify, sanitizeInput } from './identity.js';
import { evidenceSchema, identitySchema, investigationInputSchema, investigationSchema, timelineSchema } from './schemas.js';
import { traceOperation, traceSourceOutcome } from './observability.js';
import type { ArtifactStore } from './research.js';
import { loadCapturedLinkage } from './capture-linkage.js';

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

export interface InvestigationOptions { fetcher?: Fetcher; signal?: AbortSignal; previousInvestigationId?: string; artifacts?: ArtifactStore }

/** A deterministic Mastra workflow. No model call or durable execution is implied. */
export async function runInvestigation(rawInput: InvestigationInput, options: InvestigationOptions = {}): Promise<Investigation> {
  return traceOperation('investigation.run', async () => runInvestigationSteps(rawInput, options));
}

async function runInvestigationSteps(rawInput: InvestigationInput, options: InvestigationOptions): Promise<Investigation> {
  const input = sanitizeInput(investigationInputSchema.parse(rawInput));
  // Resolve the reference inside this process (or the Temporal Activity), before
  // fetching a source. Full DOM/PNG bytes never enter durable workflow input.
  const capture = await loadCapturedLinkage(input, options.artifacts);
  const extractIdentity = createStep({
    id: 'resolve-posting-identity', inputSchema: requestSchema, outputSchema: identifiedSchema,
    execute: async ({ inputData }) => traceOperation('identity.resolve', async () => {
      const createdAt = new Date().toISOString();
      const identityResult = capture
        ? { identity: capture.identity, linkageVerified: true }
        : identify(inputData.input);
      const evidence: Evidence[] = inputData.input.advertisementText ? [{
        id: randomUUID(), kind: 'advertisement' as const, url: inputData.input.url,
        capturedAt: createdAt, sha256: hashBody(inputData.input.advertisementText),
        body: inputData.input.advertisementText,
        summary: 'User-supplied advertisement text recorded at this time. The original advertisement page was not fetched or independently captured.',
      }] : [];
      if (capture) evidence.push(capture.evidence);
      return { ...inputData, id: randomUUID(), createdAt, ...identityResult, evidence,
        timeline: [{ name: identityResult.identity ? 'Job identity resolved' : 'Job identity unresolved', status: identityResult.identity ? 'complete' as const : 'warning' as const,
          detail: identityResult.identity ? `Exact ${identityResult.identity.ats} posting ID read from the supplied URL.` : identityResult.warning!,
          at: createdAt }, ...(capture ? [{ name: 'Advertisement posting link captured', status: 'complete' as const,
            detail: 'The saved static browser snapshot contains one unique supported ATS posting identity matching this check. A link does not establish employer intent or prior removal.',
            at: capture.evidence.capturedAt }] : [])] };
    }),
  });
  const checkOfficialSource = createStep({
    id: 'check-public-job-feed', inputSchema: identifiedSchema, outputSchema: checkedSchema,
    execute: async ({ inputData }) => traceOperation('source.verify', async () => {
      const feed = inputData.identity ? await verifyFeed(inputData.identity, options) : {
        verdict: 'inconclusive' as const, explanation: inputData.warning ?? 'No verifiable posting identity was supplied.',
        limitations: ['No official job feed was fetched because the posting identity could not be resolved.'],
        evidence: [], checkedAt: new Date().toISOString(),
      };
      traceSourceOutcome(feed.verdict, feed.evidence.length);
      return { ...inputData, feed, timeline: [...inputData.timeline, {
        name: inputData.identity ? 'Official source checked' : 'Official check skipped', status: !inputData.identity ? 'skipped' as const : feed.verdict === 'inconclusive' ? 'warning' as const : 'complete' as const,
        detail: feed.explanation, at: feed.checkedAt,
      }] };
    }),
  });
  const sealEvidence = createStep({
    id: 'seal-qualified-evidence-report', inputSchema: checkedSchema, outputSchema: investigationSchema,
    execute: async ({ inputData }) => traceOperation('evidence.seal', async () => {
      const evidence = [...inputData.evidence, ...inputData.feed.evidence];
      const limitations = [...inputData.feed.limitations];
      if (capture) limitations.push(...capture.limitations);
      if (inputData.warning) limitations.unshift(inputData.warning);
      if (inputData.input.advertisementText) limitations.push('Pasted advertisement text is user-supplied, not an independent browser capture.');
      limitations.push('URL query strings and fragments were removed before storage to reduce accidental token retention.');
      const verdict = inputData.linkageVerified ? inputData.feed.verdict : 'inconclusive';
      return {
        id: inputData.id, input: inputData.input, createdAt: inputData.createdAt,
        checkedAt: inputData.feed.checkedAt, verdict,
        ...(inputData.feed.evidence.some(item => item.kind === 'official_feed') ? { sourceObservation: { verdict: inputData.feed.verdict, explanation: inputData.feed.explanation, checkedAt: inputData.feed.checkedAt } } : {}),
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
    }),
  });
  const workflow = createWorkflow({ id: 'vacancy-autopsy-investigation', inputSchema: requestSchema,
    outputSchema: investigationSchema })
    .then(extractIdentity).then(checkOfficialSource).then(sealEvidence).commit();
  const run = await workflow.createRun();
  const result = await run.start({ inputData: { input, previousInvestigationId: options.previousInvestigationId } });
  if (result.status !== 'success') throw new Error('The investigation workflow did not complete successfully.');
  return investigationSchema.parse(result.result);
}
