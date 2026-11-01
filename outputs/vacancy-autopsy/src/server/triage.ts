import { constants } from 'node:fs';
import { mkdir, open, readFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Investigation, InvestigationInput } from '../shared/types.js';
import { triageResultSchema as resultSchema, type TriageResult, type TriageLeadResult } from '../shared/triage.js';
import { investigationSchema, publicUrlSchema } from './schemas.js';
import { buildPriorityRows, createPriorityRunner, priorityEntrySchema, validatePriorityResult,
  type PriorityOptions } from './priority.js';
import { runInvestigation } from './workflow.js';
import type { InvestigationStore } from './store.js';
import type { Fetcher } from './ats.js';
import type { ArtifactStore } from './research.js';
import { traceOperation } from './observability.js';

const triageEntrySchema = priorityEntrySchema.extend({ advertisementText: z.string().trim().max(16000).optional() }).strict();
export const triageInputSchema = z.object({
  entries: z.array(triageEntrySchema).min(2).max(20).refine(rows => new Set(rows.map(row => row.id)).size === rows.length),
  budget: z.number().int().min(1).max(20).default(3),
}).strict();
export type TriageInput = z.infer<typeof triageInputSchema>;
const featuresSchema = z.object({
  listing_age_days: z.number().nonnegative().nullable(), repost_count: z.number().int().nonnegative().nullable(),
  employer_name_similarity: z.null(), title_consistency: z.null(), ats_link_present: z.literal(1).nullable(),
  source_type: z.enum(['official', 'job_board']),
}).strict();
const triagedSchema = z.object({
  runId: z.string().uuid(), frozenAt: z.string().datetime(), checkBudget: z.number().int(),
  ranked: z.array(z.object({ entry: triageEntrySchema, features: featuresSchema,
    rank: z.number().int(), priority: z.number().min(0).max(1) }).strict()),
}).strict();

/** Deliberately excluded from the strict independent-review benchmark schema. */
export const agentHistorySchema = z.object({
  kind: z.literal('vacancy_autopsy_agent_history_v2'), collection: z.literal('agent_collected'),
  provenance: z.literal('agent_collected'), training_eligible: z.literal(false), review_required: z.literal(true),
  id: z.string(), run_id: z.string().uuid(), lead_id: z.string(), report_id: z.string().uuid(),
  advertisement_url: publicUrlSchema, advertisement_text: z.string().max(16000).nullable(),
  advertisement_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  advertisement_captured_at: z.null(), features_captured_at: z.string().datetime(), features: featuresSchema,
  employer_group: z.null(), template_group: z.null(), dedup_key: z.string(),
  verification: z.object({ source_url: publicUrlSchema.nullable(), checked_at: z.string().datetime(),
    evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), complete: z.boolean(), identity_confirmed: z.boolean(),
    outcome: z.enum(['verified_open', 'not_listed']).nullable(), reviewed_by: z.literal('vacancy-autopsy-agent'),
    label_method: z.literal('agent_first_party_check'),
  }).strict(),
  gold: z.object({ employer: z.null(), title: z.null(), job_id: z.string().nullable(),
    ats: z.enum(['greenhouse', 'lever', 'ashby']).nullable() }).strict(),
}).strict();
export type AgentHistoryRow = z.infer<typeof agentHistorySchema>;
// Earlier local runs remain readable for counts; they are neither rewritten nor
// admitted by the new append schema or the independent-review benchmark loader.
const storedHistorySchema = z.union([agentHistorySchema, agentHistorySchema.extend({
  kind: z.literal('vacancy_autopsy_agent_history_v1'), provenance: z.literal('real_public'),
}).strict()]);

export interface TriageHistory {
  count(): Promise<number>;
  append(row: AgentHistoryRow): Promise<void>;
}

/** Keep hosted history beside the already-provisioned persistent model context. */
export function resolveTriageHistoryPath(options: {
  dataDirectory: string; explicitDataDirectory: boolean; hosted: boolean; priorityContextPath?: string;
}): string | undefined {
  if (options.explicitDataDirectory || !options.hosted) return resolve(options.dataDirectory, 'triage', 'history.jsonl');
  if (!options.priorityContextPath || !isAbsolute(options.priorityContextPath)) return undefined;
  return resolve(dirname(options.priorityContextPath), '..', 'triage', 'history.jsonl');
}

/** One process owns the persistent file. No model fitting or automatic retraining. */
const MAX_HISTORY_BYTES = 10_000_000;
export class LocalTriageHistory implements TriageHistory {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async rows(): Promise<z.infer<typeof storedHistorySchema>[]> {
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.size > MAX_HISTORY_BYTES || (metadata.mode & 0o077)) throw new Error('Private history is unavailable.');
      const body = await readFile(this.path, 'utf8');
      return body.split('\n').filter(Boolean).map(line => storedHistorySchema.parse(JSON.parse(line)));
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Private history is unavailable.');
    }
  }
  async count(): Promise<number> { await this.queue; return (await this.rows()).length; }
  async append(raw: AgentHistoryRow): Promise<void> {
    const row = agentHistorySchema.parse(raw);
    const operation = this.queue.then(async () => {
      const rows = await this.rows();
      const duplicate = rows.find(saved => saved.id === row.id);
      if (duplicate) {
        if (JSON.stringify(duplicate) !== JSON.stringify(row)) throw new Error('History identity conflict.');
        return;
      }
      if (rows.length >= 10000) throw new Error('Private history is full.');
      const line = `${JSON.stringify(row)}\n`;
      const existingBytes = await lstat(this.path).then(metadata => metadata.size, (failure: NodeJS.ErrnoException) => {
        if (failure.code === 'ENOENT') return 0;
        throw new Error('Private history is unavailable.');
      });
      if (existingBytes + Buffer.byteLength(line, 'utf8') > MAX_HISTORY_BYTES) throw new Error('Private history is full.');
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const file = await open(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(line);
        await file.sync();
      } finally { await file.close(); }
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }
}

export interface TriageOptions {
  priority: PriorityOptions;
  history: TriageHistory;
  store: InvestigationStore;
  fetcher?: Fetcher;
  artifacts?: ArtifactStore;
  signal?: AbortSignal;
  executeInvestigation?: (input: InvestigationInput, options?: { signal?: AbortSignal }) => Promise<Investigation>;
  onInvestigation?: () => void;
}

const cleanUrl = (value: string): string => { const url = new URL(value); url.search = ''; url.hash = ''; return url.href; };
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function historyRow(runId: string, lead: z.infer<typeof triagedSchema>['ranked'][number], frozenAt: string, report: Investigation): AgentHistoryRow {
  const official = report.evidence.find(item => item.kind === 'official_feed');
  const qualified = report.mode === 'live' && report.verdict !== 'inconclusive' && Boolean(official);
  const text = lead.entry.advertisementText?.trim() || null;
  return agentHistorySchema.parse({
    kind: 'vacancy_autopsy_agent_history_v2', collection: 'agent_collected', provenance: 'agent_collected',
    training_eligible: false, review_required: true, id: `${runId}:${lead.entry.id}`, run_id: runId,
    lead_id: lead.entry.id, report_id: report.id, advertisement_url: cleanUrl(lead.entry.url),
    advertisement_text: text, advertisement_sha256: text === null ? null : hash(text),
    advertisement_captured_at: null, features_captured_at: frozenAt, features: lead.features,
    // A board slug and a URL host are not verified employer/template grouping labels.
    employer_group: null, template_group: null,
    dedup_key: report.ats && report.jobId && report.officialUrl ? `${report.ats}:${report.officialUrl}:${report.jobId}` : `url:${hash(cleanUrl(lead.entry.url))}`,
    verification: { source_url: official?.url ?? null, checked_at: report.checkedAt,
      evidence_sha256: official?.sha256 ?? null, complete: qualified, identity_confirmed: qualified,
      outcome: qualified ? report.verdict : null, reviewed_by: 'vacancy-autopsy-agent', label_method: 'agent_first_party_check' },
    gold: { employer: null, title: null, job_id: qualified ? report.jobId ?? null : null, ats: qualified ? report.ats ?? null : null },
  });
}

export async function runTriage(raw: TriageInput, options: TriageOptions): Promise<TriageResult> {
  const input = triageInputSchema.parse(raw);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(120_000)]);
  const runId = randomUUID();
  const rank = options.priority.runner ?? createPriorityRunner(options.priority);
  const triage = createStep({ id: 'triage', inputSchema: triageInputSchema, outputSchema: triagedSchema,
    execute: async ({ inputData }) => traceOperation('model.rank', async () => {
      signal.throwIfAborted();
      const frozenAt = new Date().toISOString();
      const frozen = buildPriorityRows(inputData.entries).map(row => Object.freeze({ id: row.id, features: Object.freeze({ ...row.features }) }));
      const returned = await rank({ rows: frozen }, { contextPath: resolve(options.priority.contextPath!),
        pythonPath: options.priority.pythonPath!, signal });
      signal.throwIfAborted();
      const ranked = validatePriorityResult(returned, frozen);
      try { options.priority.onVerified?.(); } catch { /* Observation cannot change a valid ranking. */ }
      return { runId, frozenAt, checkBudget: Math.min(inputData.budget, inputData.entries.length),
        ranked: ranked.map(row => ({ entry: inputData.entries.find(entry => entry.id === row.id)!,
          features: frozen.find(entry => entry.id === row.id)!.features, rank: row.rank, priority: row.priority })) };
    }, { 'va.provider': 'tabpfn' }) });
  const verify = createStep({ id: 'verify-within-budget', inputSchema: triagedSchema, outputSchema: resultSchema,
    execute: async ({ inputData }) => {
      let checksUsed = 0;
      const ranked: TriageLeadResult[] = [];
      for (const [index, lead] of inputData.ranked.entries()) {
        const summary = { id: lead.entry.id, url: cleanUrl(lead.entry.url), ...(lead.entry.role ? { role: lead.entry.role } : {}),
          rank: lead.rank, priority: lead.priority };
        if (index >= inputData.checkBudget || signal.aborted) {
          ranked.push({ ...summary, checked: false, reason: signal.aborted
            ? `Skipped at ranked position ${index + 1}: the run stopped before this check.`
            : `Skipped at ranked position ${index + 1}: outside the ${inputData.checkBudget}-check budget.` });
          continue;
        }
        checksUsed++;
        const request: InvestigationInput = { url: lead.entry.url,
          ...(lead.entry.originalEmployerLink ? { officialUrl: lead.entry.originalEmployerLink } : {}),
          ...(lead.entry.advertisementText ? { advertisementText: lead.entry.advertisementText } : {}) };
        let report: Investigation;
        try {
          report = investigationSchema.parse(options.executeInvestigation
            ? await options.executeInvestigation(request, { signal })
            : await runInvestigation(request, { fetcher: options.fetcher, artifacts: options.artifacts, signal }));
          if (!options.executeInvestigation) await options.store.put(report);
        } catch {
          ranked.push({ ...summary, checked: true,
            reason: `Checked at ranked position ${index + 1} within the ${inputData.checkBudget}-check budget; no saved finding was returned.`,
            error: 'The check could not complete. No availability verdict was inferred.' });
          continue;
        }
        // An outcome enters history only after the verifier returned and the report was saved.
        await options.history.append(historyRow(inputData.runId, lead, inputData.frozenAt, report));
        try { options.onInvestigation?.(); } catch { /* Best-effort runtime observation. */ }
        ranked.push({ ...summary, checked: true,
          reason: `Checked at ranked position ${index + 1} within the ${inputData.checkBudget}-check budget.`,
          reportId: report.id, verdict: report.verdict });
      }
      return { runId: inputData.runId, createdAt: inputData.frozenAt, total: inputData.ranked.length,
        checkBudget: inputData.checkBudget, checksUsed, checksSaved: inputData.ranked.length - checksUsed,
        historyRows: await options.history.count(), relativeOnly: true as const, ranked };
    } });
  const workflow = createWorkflow({ id: 'vacancy-autopsy-prediction-agent', inputSchema: triageInputSchema, outputSchema: resultSchema })
    .then(triage).then(verify).commit();
  const run = await workflow.createRun();
  const result = await run.start({ inputData: input });
  if (result.status !== 'success') throw new Error('The prediction agent did not complete; saved checks remain in the private archive.');
  return resultSchema.parse(result.result);
}

export async function registerTriageRoutes(app: FastifyInstance, options: Omit<TriageOptions, 'signal'>): Promise<void> {
  let active = false;
  app.get('/api/triage/history', async () => ({ historyRows: await options.history.count(), automaticRetraining: false }));
  app.post('/api/triage', { bodyLimit: 400_000 }, async (request, reply) => {
    const input = triageInputSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Supply 2–20 public leads and a whole-number check budget from 1 to 20.' });
    if (!options.priority.contextPath || !options.priority.pythonPath || !(options.priority.token ?? process.env.TABPFN_TOKEN))
      return reply.code(503).send({ error: 'The TabPFN triage model is not connected.' });
    if (active) return reply.code(429).send({ error: 'A triage run is already active. Wait for its result before starting another.' });
    active = true;
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', abort);
    try { return await runTriage(input.data, { ...options, signal: controller.signal }); }
    catch { return reply.code(502).send({ error: 'Triage did not complete. Saved checks remain in the private archive. No automatic retry or retraining was started.' }); }
    finally { active = false; reply.raw.off('close', abort); }
  });
}
