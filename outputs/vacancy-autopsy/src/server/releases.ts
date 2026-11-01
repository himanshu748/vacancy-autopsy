import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MongoClient, MongoServerError, type Collection } from 'mongodb';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PUBLIC_RELEASE_CONFIRMATION, PUBLIC_WITHDRAW_CONFIRMATION, PUBLIC_FINDING_STATEMENTS, PUBLIC_FINDING_LIMITATIONS, publicFindingSchema, publicReleaseIdSchema,
  type PublicFinding, type SharedFinding } from '../shared/public-report.js';
import type { Investigation } from '../shared/types.js';
import { digestReport, approvalId, validatedApproval, type ApprovalStore } from './approvals.js';
import { ReviewAuthorizationError, type AccessTokenVerifier, type ReviewPrincipal } from './auth.js';
import { parseIdentity, sameIdentity } from './identity.js';
import { verifyFeed, hashBody } from './ats.js';
import { investigationSchema, reportIdSchema } from './schemas.js';
import type { InvestigationStore } from './store.js';

const digest = publicReleaseIdSchema;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_RECORD_BYTES = 32000;
const recordSchema = z.object({ id: digest, reportId: reportIdSchema, reportDigest: digest, previewDigest: digest,
  approvalId: digest, reviewerHash: digest, publishedAt: z.string().datetime(), finding: publicFindingSchema }).strict();
const withdrawalSchema = z.object({ id: digest, withdrawnAt: z.string().datetime(), reviewerHash: digest }).strict();
export type ReleaseRecord = z.infer<typeof recordSchema>;
export type WithdrawalRecord = z.infer<typeof withdrawalSchema>;
export interface ReleaseState { record: ReleaseRecord; withdrawal: WithdrawalRecord | null }
export interface ReleaseStore {
  get(id: string): Promise<ReleaseState | null>;
  putIfAbsent(record: ReleaseRecord): Promise<ReleaseState>;
  withdraw(record: WithdrawalRecord): Promise<ReleaseState | null>;
  close(): Promise<void>;
}
export class ReleasePolicyError extends Error {}
export function digestPublicFinding(value: PublicFinding): string {
  return createHash('sha256').update(`vacancy-autopsy-public-v1\n${JSON.stringify(publicFindingSchema.parse(value))}`).digest('hex');
}
export function releaseId(reportDigest: string, previewDigest: string): string {
  return createHash('sha256').update(`vacancy-autopsy-release-v1\0${reportDigest}\0${previewDigest}`).digest('hex');
}
export function validatedRelease(value: unknown): ReleaseRecord {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RECORD_BYTES) throw new Error('Shared finding exceeds storage limit.');
  const record = recordSchema.parse(value);
  if (digestPublicFinding(record.finding) !== record.previewDigest || releaseId(record.reportDigest, record.previewDigest) !== record.id ||
      record.approvalId !== approvalId(record.reportDigest, record.reviewerHash)) throw new Error('Invalid release identity.');
  const identity = parseIdentity(record.finding.officialUrl);
  if (!identity || identity.officialUrl !== record.finding.officialUrl || identity.board !== record.finding.board ||
      identity.ats !== record.finding.ats || identity.jobId !== record.finding.jobId) throw new Error('Invalid public source identity.');
  const allowedSources = new Set(identity.ats === 'greenhouse'
    ? [`https://boards-api.greenhouse.io/v1/boards/${identity.board}/jobs`]
    : identity.ats === 'ashby' ? [`https://api.ashbyhq.com/posting-api/job-board/${identity.board}`]
      : [`https://${identity.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${identity.board}/${identity.jobId}?mode=json`,
        ...Array.from({ length: 10 }, (_, page) => `https://${identity.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${identity.board}?mode=json&limit=100&skip=${page * 100}`)]);
  if (record.finding.sources.some((source) => !allowedSources.has(source.url)) ||
      record.finding.statement !== PUBLIC_FINDING_STATEMENTS[record.finding.verdict] ||
      JSON.stringify(record.finding.limitations) !== JSON.stringify(PUBLIC_FINDING_LIMITATIONS)) throw new Error('Invalid public finding policy.');
  return record;
}
function fresh(at: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(at);
  return Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age <= DAY_MS;
}

/** Re-run the deterministic verifier against saved bytes only; this never fetches the network. */
export async function buildPublicFinding(reportValue: Investigation, now: Date): Promise<PublicFinding> {
  const report = investigationSchema.strict().parse(reportValue);
  const identity = report.officialUrl ? parseIdentity(report.officialUrl) : null;
  const supplied = parseIdentity(report.input.officialUrl ?? report.input.url);
  if (report.mode !== 'live' || !identity || !sameIdentity(identity, supplied) || identity.ats !== report.ats ||
      identity.jobId !== report.jobId || !fresh(report.checkedAt, now)) throw new ReleasePolicyError('Recheck the exact official opening before sharing.');
  const sources = report.evidence.filter((item) => item.kind === 'official_feed');
  // Lever may retain one exact-posting 404 followed by up to ten board pages.
  if (!sources.length || sources.length > 11 || sources.some((source) => typeof source.body !== 'string' ||
      hashBody(source.body) !== source.sha256 || !fresh(source.capturedAt, now) ||
      Math.abs(Date.parse(source.capturedAt) - Date.parse(report.checkedAt)) > CLOCK_SKEW_MS) ||
      sources.reduce((sum, source) => sum + Buffer.byteLength(source.body!), 0) > 2_000_000) {
    throw new ReleasePolicyError('The source evidence is stale, missing or fails its integrity check. Recheck before sharing.');
  }
  let index = 0;
  let replayMismatch = false;
  const result = await verifyFeed(identity, { fetcher: (async (url) => {
    const source = sources[index++];
    if (!source || source.url !== String(url) || source.httpStatus === undefined || source.httpStatus < 200 || source.httpStatus > 599) {
      replayMismatch = true;
      throw new Error('Saved source does not match the deterministic verification request.');
    }
    return new Response(source.body!, { status: source.httpStatus, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
  const observation = report.sourceObservation ?? report;
  if (replayMismatch || index !== sources.length || result.verdict !== observation.verdict ||
      !fresh(observation.checkedAt, now) || Math.abs(Date.parse(observation.checkedAt) - Date.parse(report.checkedAt)) > CLOCK_SKEW_MS) {
    throw new ReleasePolicyError('The finding cannot be reproduced from its captured official source. Recheck before sharing.');
  }
  return publicFindingSchema.parse({ policyVersion: 1, scope: 'official_source_only',
    title: result.title?.slice(0, 1000) || `Opening ${identity.jobId}`, board: identity.board, ats: identity.ats,
    jobId: identity.jobId, officialUrl: identity.officialUrl, verdict: result.verdict, checkedAt: observation.checkedAt,
    statement: PUBLIC_FINDING_STATEMENTS[result.verdict], limitations: PUBLIC_FINDING_LIMITATIONS,
    sources: sources.map(({ url, capturedAt, sha256 }) => ({ url, capturedAt, sha256 })) });
}

/** Append-only records and withdrawal markers: retries can never reactivate a withdrawn link. */
export class LocalReleaseStore implements ReleaseStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private async read(name: string): Promise<unknown | null> {
    try {
      const bytes = await readFile(join(this.directory, name));
      if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error('Invalid release storage size.');
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async get(id: string): Promise<ReleaseState | null> {
    if (!digest.safeParse(id).success) return null;
    const raw = await this.read(`${id}.json`);
    if (!raw) return null;
    const record = validatedRelease(raw);
    if (record.id !== id) throw new Error('Release identity mismatch.');
    const marker = await this.read(`${id}.withdrawn.json`);
    const withdrawal = marker ? withdrawalSchema.parse(marker) : null;
    if (withdrawal && withdrawal.id !== id) throw new Error('Withdrawal identity mismatch.');
    return { record, withdrawal };
  }
  private async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.directory);
    if (files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length >= 1000 && !name.endsWith('.withdrawn.json')) throw new Error('Local shared finding limit reached.');
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, join(this.directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  putIfAbsent(value: ReleaseRecord): Promise<ReleaseState> {
    const checked = validatedRelease(value);
    return this.serial(async () => {
      let state = await this.get(checked.id);
      if (!state) { await this.write(`${checked.id}.json`, checked); state = await this.get(checked.id); }
      if (!state || state.record.reportDigest !== checked.reportDigest || state.record.previewDigest !== checked.previewDigest) throw new Error('Release could not be confirmed.');
      return state;
    });
  }
  withdraw(value: WithdrawalRecord): Promise<ReleaseState | null> {
    const checked = withdrawalSchema.parse(value);
    return this.serial(async () => {
      const existing = await this.get(checked.id);
      if (!existing) return null;
      if (!existing.withdrawal) await this.write(`${checked.id}.withdrawn.json`, checked);
      const saved = await this.get(checked.id);
      if (!saved?.withdrawal) throw new Error('Withdrawal could not be confirmed.');
      return saved;
    });
  }
  async close(): Promise<void> { await this.queue; }
}

export class MongoReleaseStore implements ReleaseStore {
  constructor(private readonly records: Collection<ReleaseRecord>, private readonly withdrawals: Collection<WithdrawalRecord>,
    private readonly closeClient: () => Promise<void> = async () => {}) {}
  static async connect(uri: string, database: string): Promise<MongoReleaseStore> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, socketTimeoutMS: 10000,
      maxPoolSize: 3, ignoreUndefined: true, appName: 'vacancy-autopsy-sharing' });
    try {
      await client.connect();
      const records = client.db(database).collection<ReleaseRecord>('shared_findings');
      const withdrawals = client.db(database).collection<WithdrawalRecord>('withdrawn_findings');
      await records.createIndex({ id: 1 }, { unique: true });
      await withdrawals.createIndex({ id: 1 }, { unique: true });
      return new MongoReleaseStore(records, withdrawals, () => client.close());
    } catch (error) { await client.close().catch(() => undefined); throw error; }
  }
  async get(id: string): Promise<ReleaseState | null> {
    if (!digest.safeParse(id).success) return null;
    const value = await this.records.findOne({ id }, { projection: { _id: 0 } });
    if (!value) return null;
    const record = validatedRelease(value);
    if (record.id !== id) throw new Error('Release identity mismatch.');
    const marker = await this.withdrawals.findOne({ id }, { projection: { _id: 0 } });
    const withdrawal = marker ? withdrawalSchema.parse(marker) : null;
    if (withdrawal && withdrawal.id !== id) throw new Error('Withdrawal identity mismatch.');
    return { record, withdrawal };
  }
  async putIfAbsent(value: ReleaseRecord): Promise<ReleaseState> {
    const checked = validatedRelease(value);
    try { const result = await this.records.insertOne({ ...checked }); if (!result.acknowledged) throw new Error('Release write not acknowledged.'); }
    catch (error) { if (!(error instanceof MongoServerError && error.code === 11000)) throw error; }
    const saved = await this.get(checked.id);
    if (!saved || saved.record.reportDigest !== checked.reportDigest || saved.record.previewDigest !== checked.previewDigest) throw new Error('Release could not be confirmed.');
    return saved;
  }
  async withdraw(value: WithdrawalRecord): Promise<ReleaseState | null> {
    const checked = withdrawalSchema.parse(value);
    if (!await this.get(checked.id)) return null;
    try { const result = await this.withdrawals.insertOne({ ...checked }); if (!result.acknowledged) throw new Error('Withdrawal write not acknowledged.'); }
    catch (error) { if (!(error instanceof MongoServerError && error.code === 11000)) throw error; }
    const saved = await this.get(checked.id);
    if (!saved?.withdrawal) throw new Error('Withdrawal could not be confirmed.');
    return saved;
  }
  close(): Promise<void> { return this.closeClient(); }
}

export interface SharingOptions { releases: ReleaseStore; now?: () => Date }
export interface ReleaseRouteOptions extends SharingOptions {
  reports: Pick<InvestigationStore, 'get'>; approvals: ApprovalStore; authenticator: AccessTokenVerifier;
}
export async function registerReleaseRoutes(app: FastifyInstance, options: ReleaseRouteOptions): Promise<void> {
  async function authorize(request: FastifyRequest, reply: FastifyReply): Promise<ReviewPrincipal | null> {
    try { return await options.authenticator.verify(request.headers.authorization); }
    catch (error) {
      const status = error instanceof ReviewAuthorizationError ? error.statusCode : 503;
      if (status === 401) reply.header('www-authenticate', 'Bearer');
      void reply.code(status).send({ error: status === 503 ? 'Reviewer authentication is temporarily unavailable.' : 'A permitted human reviewer must confirm sharing.' });
      return null;
    }
  }
  const receipt = (state: ReleaseState) => ({ id: state.record.id, publishedAt: state.record.publishedAt,
    ...(state.withdrawal ? { withdrawnAt: state.withdrawal.withdrawnAt } : {}) });
  app.get<{ Params: { id: string } }>('/api/investigations/:id/share-preview', async (request, reply) => {
    const principal = await authorize(request, reply); if (!principal) return;
    if (!reportIdSchema.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Investigation not found.' });
    const report = await options.reports.get(request.params.id); if (!report) return reply.code(404).send({ error: 'Investigation not found.' });
    try {
      const now = options.now?.() ?? new Date();
      let finding: PublicFinding;
      let publishable = true;
      try { finding = await buildPublicFinding(report, now); }
      catch (error) {
        if (!(error instanceof ReleasePolicyError) || fresh(report.checkedAt, now)) throw error;
        // Historical links must remain withdrawable after the publication window.
        // Integrity, exact source replay and private authentication still apply;
        // this cannot create a new release or bypass final POST freshness checks.
        finding = await buildPublicFinding(report, new Date(report.checkedAt));
        publishable = false;
      }
      const reportDigest = digestReport(report), previewDigest = digestPublicFinding(finding);
      const state = await options.releases.get(releaseId(reportDigest, previewDigest));
      if (!publishable && !state) return reply.code(409).send({ error: 'Recheck the exact official opening before sharing.' });
      return { reportDigest, previewDigest, finding, publishable, release: state ? receipt(state) : null };
    } catch (error) { if (error instanceof ReleasePolicyError) return reply.code(409).send({ error: error.message }); throw error; }
  });
  app.post<{ Params: { id: string } }>('/api/investigations/:id/share', async (request, reply) => {
    const principal = await authorize(request, reply); if (!principal) return;
    const body = z.object({ reportDigest: digest, previewDigest: digest, confirmation: z.literal(PUBLIC_RELEASE_CONFIRMATION) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Review the exact public preview and confirm sharing.' });
    if (!reportIdSchema.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Investigation not found.' });
    const report = await options.reports.get(request.params.id); if (!report) return reply.code(404).send({ error: 'Investigation not found.' });
    try {
      const now = options.now?.() ?? new Date();
      const reportDigest = digestReport(report), finding = await buildPublicFinding(report, now), previewDigest = digestPublicFinding(finding);
      if (body.data.reportDigest !== reportDigest || body.data.previewDigest !== previewDigest) return reply.code(409).send({ error: 'The report or public preview changed. Reload and review both again.' });
      const id = approvalId(reportDigest, principal.subjectHash);
      const rawApproval = await options.approvals.get(id);
      const approval = rawApproval ? validatedApproval(rawApproval) : null;
      if (!approval || approval.id !== id || approval.reportId !== report.id || approval.reportDigest !== reportDigest ||
          approval.reviewerHash !== principal.subjectHash || !fresh(approval.approvedAt, now)) return reply.code(409).send({ error: 'Record a current review of this exact report before sharing.' });
      const current = await options.reports.get(report.id);
      if (!current || digestReport(current) !== reportDigest) return reply.code(409).send({ error: 'The source report changed while preparing the share. Review again.' });
      const saved = await options.releases.putIfAbsent({ id: releaseId(reportDigest, previewDigest), reportId: report.id,
        reportDigest, previewDigest, approvalId: id, reviewerHash: principal.subjectHash, publishedAt: now.toISOString(), finding });
      if (saved.withdrawal) return reply.code(409).send({ error: 'This shared finding was withdrawn. Recheck the opening to create a new share.' });
      return { release: receipt(saved) };
    } catch (error) {
      if (error instanceof ReleasePolicyError) return reply.code(409).send({ error: error.message });
      return reply.code(503).send({ error: 'Sharing could not be confirmed. Reload the preview to check its status before retrying.' });
    }
  });
  app.post<{ Params: { id: string } }>('/api/shared-reports/:id/withdraw', async (request, reply) => {
    const principal = await authorize(request, reply); if (!principal) return;
    const body = z.object({ confirmation: z.literal(PUBLIC_WITHDRAW_CONFIRMATION) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Confirm withdrawal of this shared finding.' });
    if (!digest.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Shared finding not found.' });
    try {
      const saved = await options.releases.withdraw({ id: request.params.id, reviewerHash: principal.subjectHash,
        withdrawnAt: (options.now?.() ?? new Date()).toISOString() });
      if (!saved) return reply.code(404).send({ error: 'Shared finding not found.' });
      return { release: receipt(saved) };
    } catch { return reply.code(503).send({ error: 'Withdrawal could not be confirmed. Keep the link private and retry.' }); }
  });
  app.get<{ Params: { id: string } }>('/api/shared-reports/:id', async (request, reply): Promise<SharedFinding | void> => {
    if (!digest.safeParse(request.params.id).success) return void reply.code(404).send({ error: 'Shared finding unavailable.' });
    const saved = await options.releases.get(request.params.id);
    if (!saved || saved.withdrawal) return void reply.code(404).send({ error: 'Shared finding unavailable or withdrawn.' });
    return { id: saved.record.id, publishedAt: saved.record.publishedAt, finding: saved.record.finding };
  });
  app.addHook('onClose', async () => options.releases.close());
}
