# Hosted deployment preparation

The reviewable full-model candidate is [deploy/render-full.yaml.example](../deploy/render-full.yaml.example), with a Dockerfile that builds the React frontend and installs both Python API clients. It has **not been applied**, and it is deliberately not named `render.yaml` at the repository root. The current source changes are local; the previously delivered private remote does not establish that this candidate has been pushed.

The candidate uses one `1c-2g` web service and a 1 GB disk in Singapore. Current list rates are **$25/month compute + $0.25/month disk**, before any bandwidth/build overages or separate model usage. These are recurring resources, even while paid from credits. Prices and available credit must be checked again before applying. [Render pricing](https://render.com/pricing)

On October 30, 2026, read-only CLI validation against the selected existing workspace returned **`valid: false`, `need_payment_info`**. The account's $50 credit does not remove that gate. The same workspace has 25/25 service slots occupied. No card was added, service removed, plan upgraded or deployment started. These are provider blockers, not an instruction to supply payment information automatically.

The built app supports an authenticated, persistent **single private workspace**. Private source delivery to `https://github.com/himanshu748/vacancy-autopsy` is explicitly authorized, and that remote is configured. Git refs and the local delivery receipt establish the actual pushed revision. No Render deployment or public report publication has occurred; no resource-provisioning Blueprint has been activated. A hosted-provider acceptance receipt remains open.

## Prerequisites

Before provisioning, obtain explicit deployment authorization and an authorized source remote or prebuilt-image destination. Confirm the selected Render resource, quota and cost boundaries before creating it. Do not add a card, upgrade, enable auto-reload or purchase credits as an implied setup step.

Configure project-specific Auth0 and MongoDB access. Under explicit authorization, owner-side AI-client read/write access was enabled for the selected Atlas organization, and a dedicated free cluster now stores this project's local application records. Its application user has `readWrite` only on `vacancy_autopsy`, is restricted to that cluster, and the network list permits only this machine's current address. Other organizations and third-party application settings were not changed. No credentials or checkpoints from another project may be reused.

Auth0 needs an RS256 custom API with RBAC, permissions included in access tokens, and `review:reports` assigned only to intended human reviewers. Configure a Single Page Application with the exact hosted root callback and web origin. See [AUTH0.md](AUTH0.md). All reviewers with that permission share this workspace's reports and source artifacts. There is no per-user or tenant ownership isolation.

## Runtime settings

The frontend and API are served by one Node process. The application directory is `outputs/vacancy-autopsy` when deploying from this repository layout. For core-only native Node hosting, build with `npm ci && npm run build`; start with `npm start`. Keep build-time development dependencies available because TypeScript/Vite build the app and `tsx` starts the current source entry point. Full model serving uses the supplied Dockerfile so both Python clients and the offline tokenizer are present. Use `/api/health` for a read-only health check.

Required hosted environment names:

```text
PUBLIC_ORIGIN=https://YOUR-SERVICE.onrender.com
HOST=0.0.0.0
MONGODB_URI=...
MONGODB_DATABASE=vacancy_autopsy
AUTH0_ISSUER_BASE_URL=https://YOUR-TENANT.auth0.com/
AUTH0_AUDIENCE=YOUR-API-IDENTIFIER
AUTH0_CLIENT_ID=YOUR-SPA-CLIENT-ID
```

Let the host supply `PORT`. `PUBLIC_ORIGIN` must be a public HTTPS origin without a path, query or fragment. Missing required settings or a failed MongoDB connection stops startup; the app does not fall back to ephemeral hosted files. A non-loopback bind without hosted mode is refused.

Optional server-only credentials enable individual integrations:

```text
SERPAPI_API_KEY
BROWSERBASE_API_KEY
BROWSERBASE_PROJECT_ID
SENTRY_DSN
SENTRY_ENVIRONMENT
```

Keep secrets in the provider's private environment settings, never in source, a Blueprint literal or browser configuration. Auth0 issuer, audience and SPA client ID are public application metadata; access tokens remain in memory and never enter download URLs.

MongoDB stores immutable reports, source artifacts and private approvals with unique-ID indexes. Preserve that database across application restarts. Source artifacts and reports contain public-page text and may contain user-pasted content; restrict database access and back it up deliberately. The app has no automatic retention purge, deletion UI or restore-tested backup service.

The local API and Temporal worker have migrated 15 reports and two source artifacts into Atlas with all 17 hashes preserved. A real browser recheck created a sixteenth report only in Atlas, and restarting both processes restored and downloaded it byte-for-byte unchanged. Required indexes, duplicate protection, idempotent replay and out-of-scope denial were verified. This proves the local app's cloud database connection, not hosted access: the current single-address network rule does not permit Render. Obtain authorization for the exact hosted network access and private credential destination before provisioning; do not broaden it to all addresses as a convenience.

## Private model provisioning

The Docker build uses `tinker==0.36.0`, `tabpfn-client==0.7.0` and `transformers==5.22.1`. It downloads only public Qwen tokenizer/configuration files at revision `b968826d9c46dd6066d109eabc6255188de91218`, with remote model code disabled. No model weights, API keys, checkpoints, source captures or session data enter the build context. Tinker sampling remains remote; TabPFN uses its fitted API model, not locally downloaded weights. [Reviewed Qwen revision](https://huggingface.co/Qwen/Qwen3-8B/tree/b968826d9c46dd6066d109eabc6255188de91218), [Render Docker guidance](https://render.com/docs/docker)

After deployment authorization, provision these project-specific values privately, never in Git or Docker build arguments:

| Runtime input | Destination |
| --- | --- |
| `TINKER_API_KEY`, matching `TINKER_PROJECT_ID`, `TABPFN_TOKEN` | Render private environment variables |
| Completed Tinker training artifact JSON | Render secret file `tinker-training.json` |
| Frozen TabPFN context JSON | Render secret file `priority-context.json` |
| Matching fitted TabPFN state JSON | Render secret file `priority-model-state.json` |

These three JSON files fit Render's combined 1 MB secret-file limit. The Tinker checkpoint itself remains private at the provider; do not upload its weights or publish its URI. The current unchanged checkpoint's 90-day retention ends January 28, 2027, at 10:20 PM IST; its full storage estimate is $0.05540784, and provider-side retention and validity must be refreshed before hosting. The tokenizer is public and built separately. Secret files are runtime-mounted under `/etc/secrets`; the Docker allowlist excludes them from image copies. [Render secret files](https://render.com/docs/configure-environment-variables#secret-files)

Startup drops privileges to the `node` user and validates the checkpoint/project and TabPFN metadata. It copies the TabPFN context/state into `/var/lib/vacancy-autopsy/priority` on the persistent disk, with owner-only permissions. This directory also retains accepted prediction IDs and uncertain-submission markers. A restart preserves them; a different model/context is refused until pending operations are reviewed. The full candidate refuses an ordinary unmounted filesystem. Do not move this path to ephemeral storage: that could lose accepted-request state and cause duplicate model submissions after a restart.

The persistent disk is why the complete candidate uses paid compute. Free web services cannot attach disks. One instance is deliberate: the current ranker serializes filesystem state locally; horizontal replicas are unsupported. Disk-backed deploys can interrupt availability during a restart. MongoDB still holds application reports and sources; the disk does not substitute for Atlas. [Render disks](https://render.com/docs/disks)

## Local checks and next deployment step

Shell/Python syntax and four synthetic startup regressions passed, including preservation of pending-operation bytes, rejection of context replacement and refusal of an ephemeral filesystem. The combined Python dependency dry run resolved successfully on the existing macOS Python environment. Offline tokenizer import peaked near 236 MB RSS; TabPFN client import near 197 MB RSS, measured separately, without provider calls. These are import-only macOS measurements, not a Linux capacity or load test.

The local Docker CLI is installed, but its Colima daemon was unavailable. The image build, Linux wheels, final memory use and complete container startup remain **unverified**. Once the local daemon is running, build from the application directory with `docker build -t vacancy-autopsy:review .`, then exercise the container with test credentials and a mounted test disk before requesting a production apply. Do not supply secrets as build arguments.

Resolve Render's capacity/payment-information gate and Auth0's application/tenant capacity, authorize the precise hosted Atlas network access and credential provisioning, and obtain explicit authorization for the exact service before proceeding. Review the source diff and secret exclusions; commit/push only when separately authorized. After that, the reviewed candidate can be promoted to repository-root `render.yaml`, validated again with `render blueprints validate render.yaml -w <workspace-id> -o json`, and applied through the Dashboard. No live Blueprint link is advertised until that file is present on the authorized remote.

## Optional Temporal worker

Without `TEMPORAL_ADDRESS`, the hosted API executes the same Mastra verifier directly. The candidate intentionally leaves this variable absent. The current client and worker reject non-loopback Temporal addresses, and no Temporal Cloud TLS/API-key connection is implemented. Creating a separate Render worker with the current code would fail rather than provide hosted durability; no such resource is included. The local worker and recovery test remain usable locally. A hosted Temporal connection requires a focused implementation and live recovery verification before adding a worker. See [TEMPORAL.md](TEMPORAL.md).

## Acceptance before a hosted claim

Verify the deployed entry point through a real browser: anonymous history, reports, downloads, source tools and rechecks must be denied; a permitted human must sign in, create and download a real-source report, recheck it, and record a digest-bound private approval. A user without `review:reports` must remain denied. Confirm that restart preserves reports, artifacts and approvals, and record the actual deployment/source revision and provider receipts.

Reviewed sharing is optional and remains disabled in actual configuration. Enabling `PUBLIC_SHARING_ENABLED=true` requires complete Auth0 setup and explicit authorization; deployment alone does not turn it on. If authorized, exercise preview, exact human confirmation, anonymous source-only viewing and withdrawal with a specifically authorized report. Verify that private inputs, bodies, approval identities and digests are absent from the public response, source/preview mutations are rejected, and database restart preserves both active releases and withdrawal tombstones. Only the exact GET/HEAD shared-report path is anonymously readable; there is no listing. The Mongo release store creates `shared_findings` and `withdrawn_findings` only when enabled. See [AUTH0.md](AUTH0.md).

The public shell, known static assets, health and reviewer configuration are intentionally readable. A successful health check alone does not establish reviewer authorization, live integration success or a functioning hosted journey. Current tests exercise generated JWT/JWKS and synthetic provider/storage contracts; the local app has also exercised real Atlas reads, writes and restart persistence. Local Auth0 login, permission denial and private approval are now verified against the dedicated tenant. Hosted Auth0 callbacks/bearer downloads, hosted Atlas access, reverse-proxy behavior and Render persistence remain unverified.

Deploy a reviewed source revision and preserve the previous revision for rollback. A source rollback does not undo database records. No schema migration or production rollback has been exercised. Private investigations and review approvals stay private even if a separately confirmed sanitized finding is shared. Disabling sharing stops its public route from serving any stored releases; it does not delete records or recall recipient copies.
