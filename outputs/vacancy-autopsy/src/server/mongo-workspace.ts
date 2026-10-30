import { MongoClient, MongoServerError, type Collection } from 'mongodb';
import { validatedApproval, type ApprovalRecord, type ApprovalStore } from './approvals.js';
import type { ArtifactStore, ResearchArtifact } from './research.js';
import { validatedResearchArtifact } from './research-artifact.js';
import { reportIdSchema } from './schemas.js';

class MongoArtifactStore implements ArtifactStore {
  constructor(private readonly collection: Collection<ResearchArtifact>) {}
  async put(artifact: ResearchArtifact): Promise<void> {
    const checked = validatedResearchArtifact(artifact);
    try {
      const result = await this.collection.insertOne(checked);
      if (!result.acknowledged) throw new Error('Source artifact write was not acknowledged.');
    }
    catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) throw new Error('Source artifacts cannot be overwritten.');
      throw error;
    }
  }
  async get(id: string): Promise<ResearchArtifact | null> {
    if (!reportIdSchema.safeParse(id).success) return null;
    const record = await this.collection.findOne({ id }, { projection: { _id: 0 } });
    if (!record) return null;
    const checked = validatedResearchArtifact(record);
    if (checked.id !== id) throw new Error('Source artifact identity mismatch.');
    return checked;
  }
}

function checkedApproval(record: unknown): ApprovalRecord {
  const encoded = JSON.stringify(record);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 4096) throw new Error('Approval record exceeds the storage limit.');
  return validatedApproval(record);
}
class MongoApprovalStore implements ApprovalStore {
  constructor(private readonly collection: Collection<ApprovalRecord>) {}
  async get(id: string): Promise<ApprovalRecord | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const record = await this.collection.findOne({ id }, { projection: { _id: 0 } });
    if (!record) return null;
    const checked = checkedApproval(record);
    if (checked.id !== id) throw new Error('Approval identity mismatch.');
    return checked;
  }
  async putIfAbsent(record: ApprovalRecord): Promise<ApprovalRecord> {
    const checked = checkedApproval(record);
    try {
      // The driver may add _id to its argument; retain a clean approval record.
      const result = await this.collection.insertOne({ ...checked });
      if (!result.acknowledged) throw new Error('Approval write was not acknowledged.');
      return checked;
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
      const existing = await this.get(checked.id);
      if (!existing || existing.reportId !== checked.reportId || existing.reportDigest !== checked.reportDigest ||
          existing.reviewerHash !== checked.reviewerHash) throw new Error('Approval conflict.');
      return existing;
    }
  }
  /** The workspace owns the shared connection, including any in-flight users. */
  async close(): Promise<void> {}
}

export interface MongoWorkspace {
  artifacts: ArtifactStore;
  approvals: ApprovalStore;
  close(): Promise<void>;
}

/** Connect once for private source artifacts and approvals; never publish records. */
export async function connectMongoWorkspace(uri: string, database: string): Promise<MongoWorkspace> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000,
    socketTimeoutMS: 10000, maxPoolSize: 5, ignoreUndefined: true, appName: 'vacancy-autopsy-workspace' });
  try {
    await client.connect();
    const db = client.db(database);
    const artifacts = db.collection<ResearchArtifact>('source_artifacts');
    const approvals = db.collection<ApprovalRecord>('review_approvals');
    await artifacts.createIndex({ id: 1 }, { unique: true });
    await artifacts.createIndex({ createdAt: -1 });
    await approvals.createIndex({ id: 1 }, { unique: true });
    await approvals.createIndex({ approvedAt: -1 });
    let closing: Promise<void> | undefined;
    return { artifacts: new MongoArtifactStore(artifacts), approvals: new MongoApprovalStore(approvals),
      close: () => closing ??= client.close() };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
