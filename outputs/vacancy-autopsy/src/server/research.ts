import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { discoverJobs, discoveryInputSchema, type DiscoveryOptions, type DiscoveryResult } from './discovery.js';
import { captureAdvertisement, captureInputSchema, type BrowserCaptureOptions, type BrowserCaptureResult } from './browser-capture.js';
import { reportIdSchema } from './schemas.js';
import { traceOperation } from './observability.js';
import { validatedResearchArtifact } from './research-artifact.js';

export interface ResearchArtifact { id: string; kind: 'discovery' | 'browser_capture'; createdAt: string; result: DiscoveryResult | BrowserCaptureResult }
export interface ArtifactStore { put(artifact: ResearchArtifact): Promise<void>; get(id: string): Promise<ResearchArtifact | null> }
/** Private source artifacts are separate from qualified investigation verdicts. */
export class LocalArtifactStore implements ArtifactStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async get(id: string): Promise<ResearchArtifact | null> {
    if (!reportIdSchema.safeParse(id).success) return null;
    try {
      const buffer = await readFile(join(this.directory, `${id}.json`));
      if (buffer.byteLength > 4_000_000) throw new Error('Artifact exceeds its storage budget.');
      const artifact = validatedResearchArtifact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)));
      if (artifact.id !== id) throw new Error('Invalid source artifact.');
      return artifact;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async put(artifact: ResearchArtifact): Promise<void> {
    const checked = validatedResearchArtifact(artifact);
    const bytes = Buffer.from(JSON.stringify(checked));
    if (bytes.byteLength > 4_000_000) throw new Error('Artifact exceeds its storage budget.');
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await readdir(this.directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).length >= 100) throw new Error('Source artifact storage is full.');
      if (await this.get(artifact.id)) throw new Error('Source artifacts cannot be overwritten.');
      const temporary = join(this.directory, `.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await link(temporary, join(this.directory, `${artifact.id}.json`));
      } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
export interface ResearchOptions { artifacts?: ArtifactStore; discovery?: DiscoveryOptions; capture?: BrowserCaptureOptions }
export async function registerResearchRoutes(app: FastifyInstance, options: ResearchOptions = {}) {
  let active = 0;
  app.post('/api/discovery', async (request, reply) => {
    const input = discoveryInputSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Enter a role and employer using 3–240 characters.' });
    if (!options.discovery?.apiKey || !options.artifacts) return reply.code(503).send({ error: 'Source search is not enabled at this desk yet.' });
    if (active) return reply.code(429).send({ error: 'Another source search or capture is running. Please wait.' });
    active++;
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', abort);
    try {
      const result = await traceOperation('discovery.search', () => discoverJobs(input.data, { ...options.discovery, signal: controller.signal }), {}, (result) => result.status);
      if (result.status !== 'success') return reply.code(503).send({ error: 'The search could not finish. No source finding was inferred.', status: result.status });
      const artifact: ResearchArtifact = { id: randomUUID(), kind: 'discovery', createdAt: new Date().toISOString(), result };
      await options.artifacts.put(artifact);
      return reply.code(201).send(artifact);
    } finally { active--; reply.raw.off('close', abort); }
  });
  app.post('/api/captures', async (request, reply) => {
    const input = captureInputSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Capture supports public OppIDX, Employbl, Greenhouse, Lever and Ashby posting URLs.' });
    if (!options.capture?.apiKey || !options.artifacts) return reply.code(503).send({ error: 'Independent browser capture is not enabled at this desk yet.' });
    if (active) return reply.code(429).send({ error: 'Another source search or capture is running. Please wait.' });
    active++;
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', abort);
    try {
      const result = await traceOperation('browser.capture', () => captureAdvertisement(input.data, { ...options.capture, signal: controller.signal }), {}, (result) => result.status);
      if (result.status !== 'captured') return reply.code(503).send({ error: 'The page could not be captured safely. No source finding was inferred.', status: result.status });
      const artifact: ResearchArtifact = { id: randomUUID(), kind: 'browser_capture', createdAt: new Date().toISOString(), result };
      await options.artifacts.put(artifact);
      return reply.code(201).send(artifact);
    } finally { active--; reply.raw.off('close', abort); }
  });
  app.get<{ Params: { id: string } }>('/api/research/:id/report', async (request, reply) => {
    if (!options.artifacts || !z.string().uuid().safeParse(request.params.id).success) return reply.code(404).send({ error: 'Source artifact not found.' });
    const artifact = await options.artifacts.get(request.params.id);
    if (!artifact) return reply.code(404).send({ error: 'Source artifact not found.' });
    reply.header('content-disposition', `attachment; filename="source-artifact-${artifact.id}.json"`);
    reply.type('application/json; charset=utf-8');
    return JSON.stringify(artifact, null, 2);
  });
}
