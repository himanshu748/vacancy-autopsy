import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client, Connection } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import type { ReportReference } from '../src/temporal/contracts.js';
import { LocalStore } from '../src/server/store.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const probe = join(root, 'src/temporal/testing/recovery-worker.cjs');

async function until<T>(read: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The recovery probe exceeded its bounded wait.');
}
async function exists(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill(signal);
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  await ended;
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('No recovered workflow result within its bounded wait')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

test('Real worker SIGKILL after evidence persistence recovers the same report without refetch', { skip: process.env.TEMPORAL_RECOVERY_TEST !== '1', timeout: 100000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vacancy-temporal-crash-'));
  const operationId = randomUUID();
  const taskQueue = `vacancy-recovery-${operationId}`;
  const workflowId = `vacancy-${operationId}`;
  const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const connection = await Connection.connect({ address, connectTimeout: '5 seconds' });
  const client = new Client({ connection, namespace: 'default' });
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  const logs: string[] = [];
  function start(pause: boolean) {
    const child = spawn(process.execPath, ['--import', 'tsx', probe], { cwd: root,
      env: { ...process.env, TEMPORAL_ADDRESS: address, VACANCY_PROBE_PACKAGE: join(root, 'package.json'), VACANCY_PROBE_DIR: directory, VACANCY_PROBE_QUEUE: taskQueue, VACANCY_PROBE_PAUSE: pause ? 'yes' : 'no' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', part => logs.push(part.toString()));
    child.stderr?.on('data', part => logs.push(part.toString()));
    return child;
  }
  try {
    first = start(true);
    await until(() => exists(join(directory, `ready-${first!.pid}`)), 25000);
    const handle = await client.workflow.start('durableInvestigation', { workflowId, taskQueue, workflowExecutionTimeout: '90 seconds', args: [{ operationId, input: { url: 'https://job-boards.greenhouse.io/example/jobs/123' } }] });
    const persisted = JSON.parse(await until(() => exists(join(directory, 'persisted.json')), 25000));
    const savedBytes = await readFile(join(directory, 'reports', `${operationId}.json`), 'utf8');
    await stop(first, 'SIGKILL');
    assert.equal(first.signalCode, 'SIGKILL');
    second = start(false);
    await until(() => exists(join(directory, `ready-${second!.pid}`)), 25000);
    const result = await bounded(handle.result() as Promise<ReportReference>, 35000);
    assert.equal(result.reportId, operationId);
    assert.equal(result.reused, true);
    assert.equal((await readFile(join(directory, 'fetches.txt'), 'utf8')).trim().split('\n').length, 1);
    assert.equal((await readdir(join(directory, 'reports'))).filter(file => file.endsWith('.json')).length, 1);
    assert.equal(await readFile(join(directory, 'reports', `${operationId}.json`), 'utf8'), savedBytes);
    const report = await new LocalStore(join(directory, 'reports')).get(operationId);
    assert.equal(report?.evidence[0].sha256, persisted.sha256);
    const history = await handle.fetchHistory();
    const historyText = JSON.stringify(history);
    assert.ok(!historyText.includes('Synthetic Recovery Fixture'), 'Full feed body should not enter Temporal history');
    assert.ok(!historyText.includes('absolute_url'), 'Evidence response fields should stay outside history');
    await Worker.runReplayHistory({ workflowsPath: fileURLToPath(new URL('../src/temporal/workflows.ts', import.meta.url)) }, history, workflowId);
    const receipt = { checkedAt: new Date().toISOString(), mode: 'synthetic-source-real-local-temporal', serverAddress: address,
      workflowId, operationId, verdict: result.verdict, workerKilledWith: 'SIGKILL', reusedSavedReport: result.reused,
      sourceFetches: 1, savedReports: 1, savedReportUnchanged: true, feedBodyExcludedFromHistory: true,
      replayVerified: true, sourceSha256: persisted.sha256,
      note: 'This proves recovery of local Temporal execution with a synthetic public-feed fixture. It is not a live job finding, cloud-hosting result, or model benchmark.' };
    const evidenceDirectory = process.env.TEMPORAL_RECOVERY_OUTPUT_DIR ?? join(root, 'data/temporal-recovery');
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, 'recovery-receipt.json'), JSON.stringify(receipt, null, 2));
    await writeFile(join(evidenceDirectory, 'recovery-history.json'), historyText);
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(logs.join('').slice(-12000));
    throw error;
  } finally {
    await stop(first, 'SIGKILL');
    await stop(second, 'SIGTERM');
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});
