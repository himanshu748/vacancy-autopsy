import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Investigation } from '../shared/types.js';
import { investigationSchema, reportIdSchema } from './schemas.js';
import type { InvestigationStore } from './store.js';
import { REVIEW_PERMISSION, ReviewAuthorizationError, type AccessTokenVerifier, type ReviewPrincipal } from './auth.js';
import { traceOperation } from './observability.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const REVIEW_CONFIRMATION = 'I reviewed the evidence and limitations';
export const REPORT_DIGEST_ALGORITHM = 'sha256:canonical-json-v1';
const approvalSchema = z.object({
  id: digestSchema, reportId: reportIdSchema, reportDigest: digestSchema,
  approvedAt: z.string().datetime(), reviewerHash: digestSchema,
  permission: z.literal(REVIEW_PERMISSION), policyVersion: z.literal(1),
  purpose: z.literal('release_readiness'), publication: z.literal('private'),
}).strict();
export type ApprovalRecord = z.infer<typeof approvalSchema>;
export interface ApprovalStore {
  get(id: string): Promise<ApprovalRecord | null>;
  /** Return the existing matching record on retry; never overwrite it. */
  putIfAbsent(record: ApprovalRecord): Promise<ApprovalRecord>;
  close(): Promise<void>;
}
export class ApprovalStorageFullError extends Error {}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function digestReport(report: Investigation): string {
  const validated = investigationSchema.strict().parse(report);
  return createHash('sha256').update(`vacancy-autopsy-report-v1\n${canonicalJson(validated)}`).digest('hex');
}
function approvalId(reportDigest: string, reviewerHash: string): string {
  return createHash('sha256').update(`vacancy-autopsy-approval-v1\0${reportDigest}\0${reviewerHash}`).digest('hex');
}
export function validatedApproval(record: unknown): ApprovalRecord {
  const checked = approvalSchema.parse(record);
  if (checked.id !== approvalId(checked.reportDigest, checked.reviewerHash)) throw new Error('Approval identity does not match its report and reviewer.');
  return checked;
}

/** Private immutable files; serialized within one process. Not an Atlas proof. */
export class LocalApprovalStore implements ApprovalStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async get(id: string): Promise<ApprovalRecord | null> {
    if (!digestSchema.safeParse(id).success) return null;
    try {
      const contents = await readFile(join(this.directory, `${id}.json`));
      if (contents.byteLength > 4096) throw new Error('Approval record exceeds the storage limit.');
      return validatedApproval(JSON.parse(contents.toString('utf8')));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async putIfAbsent(record: ApprovalRecord): Promise<ApprovalRecord> {
    const checked = validatedApproval(record);
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const existing = await this.get(checked.id);
      if (existing) {
        if (existing.reportId !== checked.reportId || existing.reportDigest !== checked.reportDigest || existing.reviewerHash !== checked.reviewerHash) throw new Error('Approval conflict.');
        return existing;
      }
      const files = (await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
      if (files.length >= 1000) throw new ApprovalStorageFullError('Local approval storage has reached 1,000 records.');
      const temporary = join(this.directory, `.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(checked, null, 2)); await file.sync(); }
        finally { await file.close(); }
        try { await link(temporary, join(this.directory, `${checked.id}.json`)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const winner = await this.get(checked.id);
          if (!winner || winner.reportId !== checked.reportId) throw new Error('Approval conflict.');
          return winner;
        }
      } finally {
        try { await unlink(temporary); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return checked;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  async close(): Promise<void> { await this.queue; }
}

export interface ApprovalRouteOptions {
  reports: Pick<InvestigationStore, 'get'>;
  approvals: ApprovalStore;
  authenticator: AccessTokenVerifier;
  now?: () => Date;
}
/** Register inside the existing localhost-only app. This never publishes a report. */
export async function registerApprovalRoutes(app: FastifyInstance, options: ApprovalRouteOptions): Promise<void> {
  async function authorize(request: FastifyRequest, reply: FastifyReply): Promise<ReviewPrincipal | null> {
    try { return await options.authenticator.verify(request.headers.authorization); }
    catch (error) {
      if (error instanceof ReviewAuthorizationError) {
        if (error.statusCode === 401) reply.header('www-authenticate', 'Bearer');
        void reply.code(error.statusCode).send({ error: error.message });
      } else void reply.code(503).send({ error: 'Reviewer authentication is temporarily unavailable.' });
      return null;
    }
  }
  app.get<{ Params: { id: string } }>('/api/investigations/:id/review', async (request, reply) => {
    const principal = await authorize(request, reply);
    if (!principal) return;
    if (!reportIdSchema.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Investigation not found.' });
    const report = await options.reports.get(request.params.id);
    if (!report) return reply.code(404).send({ error: 'Investigation not found.' });
    const reportDigest = digestReport(report);
    const approval = await options.approvals.get(approvalId(reportDigest, principal.subjectHash));
    if (approval && (approval.reportId !== report.id || approval.reportDigest !== reportDigest || approval.reviewerHash !== principal.subjectHash)) {
      return reply.code(503).send({ error: 'The saved approval could not be validated. The report remains private.' });
    }
    return { report, reportDigest, digestAlgorithm: REPORT_DIGEST_ALGORITHM, approval,
      purpose: 'release_readiness', publication: 'private' };
  });
  app.post<{ Params: { id: string } }>('/api/investigations/:id/approvals', async (request, reply) => {
    const principal = await authorize(request, reply);
    if (!principal) return;
    const body = z.object({ reportDigest: digestSchema, confirmation: z.literal(REVIEW_CONFIRMATION) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Review the evidence and limitations, then confirm the exact report digest.' });
    if (!reportIdSchema.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Investigation not found.' });
    const report = await options.reports.get(request.params.id);
    if (!report) return reply.code(404).send({ error: 'Investigation not found.' });
    if (report.mode !== 'live' || report.evidence.length === 0) {
      return reply.code(409).send({ error: 'Capture real source evidence before requesting release-readiness approval.' });
    }
    const reportDigest = digestReport(report);
    if (body.data.reportDigest !== reportDigest) return reply.code(409).send({ error: 'The report differs from the reviewed copy. Reload and review the evidence again.' });
    const record: ApprovalRecord = { id: approvalId(reportDigest, principal.subjectHash), reportId: report.id,
      reportDigest, approvedAt: (options.now?.() ?? new Date()).toISOString(), reviewerHash: principal.subjectHash,
      permission: REVIEW_PERMISSION, policyVersion: 1, purpose: 'release_readiness', publication: 'private' };
    try {
      const saved = await traceOperation('review.approve', () => options.approvals.putIfAbsent(record));
      return reply.code(200).send({ approval: saved, publication: 'private' });
    } catch (error) {
      if (error instanceof ApprovalStorageFullError) return reply.code(507).send({ error: error.message });
      return reply.code(503).send({ error: 'The approval could not be saved. The report remains private.' });
    }
  });
  app.addHook('onClose', async () => options.approvals.close());
}
