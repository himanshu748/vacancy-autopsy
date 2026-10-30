import { mkdir, open, readFile, readdir, link, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MongoClient, type Collection } from 'mongodb';
import type { Investigation } from '../shared/types.js';
import { investigationSchema, reportIdSchema } from './schemas.js';

export interface InvestigationStore {
  readonly kind: 'local' | 'mongodb';
  put(report: Investigation): Promise<void>;
  get(id: string): Promise<Investigation | null>;
  list(): Promise<Investigation[]>;
  close(): Promise<void>;
}

const MAX_REPORTS = 200;
const MAX_REPORT_BYTES = 3_000_000;
export class StorageFullError extends Error {}

function brief(report: Investigation): Investigation {
  return { ...report, evidence: report.evidence.map(({ body: _body, ...evidence }) => evidence),
    input: { ...report.input, advertisementText: undefined } };
}

/** Immutable, atomic, single-process local evidence files; not a cloud database. */
export class LocalStore implements InvestigationStore {
  readonly kind = 'local';
  private writeQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}

  private async files(): Promise<string[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return (await readdir(this.directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
  }

  async put(report: Investigation): Promise<void> {
    const record = investigationSchema.parse(report);
    const serialized = JSON.stringify(record, null, 2);
    if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) throw new StorageFullError('The evidence report exceeds the local storage budget.');
    const operation = this.writeQueue.then(async () => {
      const files = await this.files();
      if (files.length >= MAX_REPORTS) throw new StorageFullError('Local evidence storage has reached 200 reports. Archive reports before adding more.');
      const temporary = join(this.directory, `.${randomUUID()}.tmp`);
      const target = join(this.directory, `${record.id}.json`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(serialized);
          await file.sync();
        } finally { await file.close(); }
        await link(temporary, target);
      } finally {
        try { await unlink(temporary); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async get(id: string): Promise<Investigation | null> {
    if (!reportIdSchema.safeParse(id).success) return null;
    try { return investigationSchema.parse(JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  async list(): Promise<Investigation[]> {
    // Avoid reading every evidence body just to show recent history.
    const files = await Promise.all((await this.files()).map(async (name) => ({ name,
      modified: (await stat(join(this.directory, name))).mtimeMs })));
    const recent = files.sort((a, b) => b.modified - a.modified).slice(0, 30);
    const records = await Promise.all(recent.map(({ name }) => this.get(name.slice(0, -5))));
    return records.filter((record): record is Investigation => !!record)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(brief);
  }

  async close(): Promise<void> { await this.writeQueue; }
}

export class MongoStore implements InvestigationStore {
  readonly kind = 'mongodb';
  private constructor(private readonly client: MongoClient, private readonly collection: Collection<Investigation>) {}

  static async connect(uri: string, database: string): Promise<MongoStore> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000,
      socketTimeoutMS: 10000, maxPoolSize: 5, appName: 'vacancy-autopsy' });
    try {
      await client.connect();
      const collection = client.db(database).collection<Investigation>('investigations');
      await collection.createIndex({ id: 1 }, { unique: true });
      await collection.createIndex({ createdAt: -1 });
      return new MongoStore(client, collection);
    } catch (error) { await client.close(); throw error; }
  }

  async put(report: Investigation): Promise<void> {
    const record = investigationSchema.parse(report);
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_REPORT_BYTES) throw new StorageFullError('The evidence report exceeds the storage budget.');
    await this.collection.insertOne(record);
  }

  async get(id: string): Promise<Investigation | null> {
    if (!reportIdSchema.safeParse(id).success) return null;
    const record = await this.collection.findOne({ id }, { projection: { _id: 0 } });
    return record ? investigationSchema.parse(record) : null;
  }

  async list(): Promise<Investigation[]> {
    const records = await this.collection.find({}, { projection: { _id: 0, 'evidence.body': 0, 'input.advertisementText': 0 } }).sort({ createdAt: -1 }).limit(30).toArray();
    return records.map((record) => brief(investigationSchema.parse(record)));
  }

  async close(): Promise<void> { await this.client.close(); }
}
