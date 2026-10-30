# Hosted deployment preparation

The built app supports an authenticated, persistent **single private workspace**. Private source delivery to `https://github.com/himanshu748/vacancy-autopsy` is explicitly authorized, and that remote is configured. Git refs and the local delivery receipt establish the actual pushed revision. No Render deployment or public report publication has occurred; no resource-provisioning Blueprint has been activated. A hosted-provider acceptance receipt remains open.

## Prerequisites

Before provisioning, obtain explicit deployment authorization and an authorized source remote or prebuilt-image destination. Confirm the selected Render resource, quota and cost boundaries before creating it. Do not add a card, upgrade, enable auto-reload or purchase credits as an implied setup step.

Configure project-specific Auth0 and MongoDB access. The Atlas connector currently reports AI-client access disabled by every available organization. An organization owner must enable access; reauthentication or a different access path must not be used to circumvent that policy. No credentials or checkpoints from another project may be reused.

Auth0 needs an RS256 custom API with RBAC, permissions included in access tokens, and `review:reports` assigned only to intended human reviewers. Configure a Single Page Application with the exact hosted root callback and web origin. See [AUTH0.md](AUTH0.md). All reviewers with that permission share this workspace's reports and source artifacts. There is no per-user or tenant ownership isolation.

## Runtime settings

The frontend and API are served by one Node process. The application directory is `outputs/vacancy-autopsy` when deploying from this repository layout. Build with `npm ci && npm run build`; start with `npm start`. Keep build-time development dependencies available because TypeScript/Vite build the app and `tsx` starts the current source entry point. Use `/api/health` for a read-only health check.

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

## Optional Temporal worker

Without `TEMPORAL_ADDRESS`, the API executes the same verifier directly. An optional worker runs `npm run temporal:worker` and must share the API's MongoDB database, Temporal address, namespace and task queue. The application must reach an authorized Temporal service; the local development server is not a hosted service. The current environment contract does not configure a Temporal Cloud TLS/API-key connection, so do not claim Cloud readiness from the local recovery test. See [TEMPORAL.md](TEMPORAL.md).

## Acceptance before a hosted claim

Verify the deployed entry point through a real browser: anonymous history, reports, downloads, source tools and rechecks must be denied; a permitted human must sign in, create and download a real-source report, recheck it, and record a digest-bound private approval. A user without `review:reports` must remain denied. Confirm that restart preserves reports, artifacts and approvals, and record the actual deployment/source revision and provider receipts.

The public shell, known static assets, health and reviewer configuration are intentionally readable. A successful health check alone does not establish reviewer authorization, live integration success or a functioning hosted journey. Current tests exercise generated JWT/JWKS and synthetic provider/storage contracts; live Auth0, Atlas, reverse-proxy behavior and Render persistence remain unverified.

Deploy a reviewed source revision and preserve the previous revision for rollback. A source rollback does not undo database records. No schema migration or production rollback has been exercised. Approval is always private; there is no public publisher to activate through deployment.
