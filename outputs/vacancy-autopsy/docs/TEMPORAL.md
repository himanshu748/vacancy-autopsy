# Durable local investigations with Temporal

Temporal is an optional execution path around the actual Mastra investigation. It is verified locally; no Temporal Cloud account or production durability is claimed.

## Run

Use matching `@temporalio/*` SDK packages; the installed set is **1.25.0**. A local dev server is required. During this build, the official Temporal CLI **1.9.1**, containing Server **1.32.0**, was downloaded under the workspace's `work/temporal` directory. The CLI is a local tool, not a committed project dependency.

```sh
# Run a local Temporal service. The database path preserves execution history.
temporal server start-dev --ip 127.0.0.1 --ui-ip 127.0.0.1 \
  --ui-disable-news-fetch --db-filename /path/to/local-temporal.sqlite

# From this project, start the worker. Use the same DATA_DIR as the API.
TEMPORAL_ADDRESS=127.0.0.1:7233 npx tsx src/temporal/worker.ts

# In another terminal, enable the API's optional durable executor.
TEMPORAL_ADDRESS=127.0.0.1:7233 npm run dev:api
```

The local Web UI is normally at `http://127.0.0.1:8233`. Binding, credentials, payload encryption, and deployment for Temporal Cloud are outside this baseline. The client and worker deliberately reject non-loopback Temporal addresses.

## What survives a worker crash

The client creates one UUID per investigation intent. That UUID binds the Temporal workflow to one immutable report. The Workflow runs deterministic orchestration; its Activity owns public-source requests, Mastra execution, and persistence. The Activity first looks up the report ID. If a previous attempt already saved it, the retry returns that report without fetching the source again. The persisted input must match the retried operation, or it fails as a conflict.

Only `{reportId, verdict, checkedAt, reused}` leaves the Activity. Full ATS response bodies remain in the evidence store and never become workflow results or Activity results in Temporal history. Workflow input still contains the supplied URL and optional advertisement text, which the local Temporal database retains. Do not use this dev setup for sensitive data or public hosting.

Activity retries are bounded to three attempts, 45 seconds per attempt, three minutes total, and an eight-second heartbeat timeout. The worker heartbeats every two seconds and passes Activity cancellation to the source request. Validation, operation-conflict, and storage-capacity failures are permanent. Database driver errors are reduced to a controlled message before Temporal can record them.

Source HTTP failures are retained as qualified inconclusive reports by the core verifier. Temporal does not silently replace one failed source observation with a later successful observation. A user recheck creates a new report.

This is idempotent persistence, not an exactly-once claim for every external read: if a worker dies before saving, the source request may run again. Concurrent timed-out attempts can also overlap before either saves; immutable storage selects one report. The local store's 200-report quota is a single-process convenience; multiple workers require a transactional shared store and stronger global quota controls.

Disconnecting the HTTP client does not cancel the durable workflow. The completed report appears in the archive. This version has no public operation-status endpoint or cross-process HTTP wait resumption; restarting the API loses the HTTP wait while the Temporal execution continues.

## Verification

Three Activity tests passed: retry after save reuses evidence, reusing an operation ID for different input is rejected, and raw database credential errors are excluded. These tests use clearly synthetic public-feed fixtures.

The opt-in integration test starts a **real worker subprocess against the real local Temporal server**, pauses it immediately after evidence persistence, kills it with **SIGKILL**, starts a new worker, and awaits the original workflow. It then checks the saved report and replays the actual workflow history.

```sh
TEMPORAL_RECOVERY_TEST=1 TEMPORAL_ADDRESS=127.0.0.1:7233 \
  npx tsx --test tests/temporal-recovery.integration.test.ts
```

Ordinary `npm test` skips this server-dependent test. Run evidence goes to `data/temporal-recovery/` unless `TEMPORAL_RECOVERY_OUTPUT_DIR` is set. The fixture worker lives at `src/temporal/testing/recovery-worker.cjs`; the app never enables its pause hook from request input or environment.

The final run at **October 30, 2026, 12:10:35 PM IST** (`2026-10-30T06:40:35.085Z`) passed:

| Observation | Result |
| --- | --- |
| Worker killed after report save and before Activity completion | SIGKILL confirmed |
| Original workflow resumed on replacement worker | Passed |
| Source fixture fetches | 1 |
| Immutable saved reports | 1 |
| Report ID | `7c33b71d-f565-406e-b003-9b4119951955` |
| Saved report contents after recovery | Identical |
| Feed response body in Temporal history | Absent |
| Actual saved history replay | Passed |

Fixture response SHA-256: `7be58a2c7cc1ca17e2a9b3f5448b437f3f751b86a0279e2339f9cd8f35d533d8`.

This proves **local worker-crash recovery with a synthetic source fixture**. It does not prove a live stale-job finding, Temporal Cloud deployment, model accuracy, server-crash recovery, or durable storage under disk/hardware failure.

## Sources

- [Temporal TypeScript development guide](https://docs.temporal.io/develop/typescript)
- [Workflow API and proxyActivities](https://typescript.temporal.io/api/namespaces/workflow)
- [Worker API](https://typescript.temporal.io/api/namespaces/worker)
- [Official first TypeScript application](https://learn.temporal.io/getting_started/typescript/hello_world_in_typescript/)
