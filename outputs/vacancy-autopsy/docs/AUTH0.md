# Auth0 reviewer approval

The backend can validate real Auth0 API access tokens and record a reviewer's approval of one exact report digest. The record is **private release readiness**, not public publication. It does not change `Investigation.publication`, create a public route, contact an employer, or claim that a stale listing proves intent.

## Configure and register

Requires direct `jose` v6 dependency. Auth0 verification uses public JWKS; it needs no client secret or Management API token. The application integration supplies these server-side settings:

```text
AUTH0_ISSUER_BASE_URL=https://YOUR-TENANT.auth0.com/
AUTH0_AUDIENCE=YOUR-CUSTOM-API-IDENTIFIER
AUTH0_CLIENT_ID=YOUR-SPA-CLIENT-ID
# Local files use DATA_DIR (default ./data); hosted mode also requires MONGODB_URI.
# PUBLIC_ORIGIN=https://your-service.onrender.com
```

In Auth0, create/configure a custom API using RS256, enable RBAC and **Add Permissions in the Access Token**, define `review:reports`, and assign that permission only to human reviewers. The frontend must request an access token for this API audience. An ID token is not an API access token. Account/application/permission provisioning and a genuine tenant login remain separate live-provider gates; no setup was performed by these backend changes.

The application entry point configures the verifier and registers approval routes automatically. Set these values in the project environment; no custom route registration or client secret is needed. With `MONGODB_URI`, approvals use the same database as workspace artifacts; otherwise local approvals live in `DATA_DIR/approvals`.

The default local desk retains its localhost bind, Host/Origin guard and rate limit. Optional hosted mode is a **single private workspace**: every authorized human with `review:reports` can access that workspace's shared reports. It is not a multi-tenant isolation model and does not authorize deployment. The server enforces a default-deny JWT boundary before every protected route. Only GET/HEAD requests for the root shell, known assets/fonts, health and reviewer configuration are public. Investigation history, evidence downloads, source tools, rechecks and approvals require a verified permitted human. Authenticated request budgets use the issuer-bound subject hash; public shell/health traffic does not consume that budget. Failed authorization has its own bounded IP bucket. No unrestricted proxy-header trust is enabled.

## Reviewer interface

`src/web/ReviewerPanel.tsx` exports `ReviewerPanel({ report })` (also the default export). Shared `workspace-auth.ts` reads `GET /api/reviewer-config`, which always includes `requiresAuthentication: boolean` alongside `configured` and, when configured, `issuer`, `clientId` and `audience`. These are public application settings, not secrets. A missing or malformed authentication-mode field fails closed. Missing local reviewer configuration produces an explicit disabled sign-in state and never calls Auth0.

The application wraps its desk in `WorkspaceGate({ children })` and mounts the reviewer panel for the selected report. The gate processes OAuth callbacks before reports mount, shares a single SDK client with the reviewer panel, and in hosted mode validates access through protected `GET /api/workspace` before showing the desk. The expected response is `{ authorized: true, visibility: "private_workspace" }`; a public health response is not authorization evidence. A 401/403 from protected fetches closes the hosted gate, with explicit sign-in or role-permission feedback. Local mode passes through after configuration is read.

The desk reads the exported `getReviewerReturnReportId()` during initial app loading and restores that report through its investigation endpoint. The helper reads only a validated report UUID from session storage. Callback processing leaves it available until the restored reviewer panel mounts, preventing a callback/restoration race. The panel then clears it; sign-out also clears it. Report bodies, access tokens and user profiles are never written to application storage.

Replace direct frontend API fetches with `authorizedFetch(path, options)`. It accepts only same-origin `/api/` paths, forces same-origin credentials and redirect refusal, and adds an in-memory bearer when hosted authentication is required. `reviewerFetch` adds the reviewer token even in local mode. Tokens are never put in URLs. Direct download anchors cannot send bearer headers: their click handler calls `authenticatedDownload(event, path).catch(showError)`. Local links retain their native behavior; hosted JSON is fetched with authorization and downloaded verbatim through a short-lived blob URL. The helper refuses external targets and non-JSON responses. This includes investigation, search-provenance and browser-evidence downloads.

Configure an Auth0 **Single Page Application** with the current local app origin in Allowed Web Origins, and its root URL (for example `http://127.0.0.1:8787/`) in Allowed Callback URLs. The frontend client ID is `AUTH0_CLIENT_ID`; it must belong to that application. Set its allowed logout URL if using a full Auth0 logout elsewhere. This panel clears only the local review session without federated logout.

The shared SDK client implements PKCE and uses `createAuth0Client`, `handleRedirectCallback` and `getTokenSilently`, requesting only `openid review:reports`. Tokens stay in its memory cache, with refresh tokens disabled. The SDK may retain its own short-lived OAuth transaction material for PKCE; no access or refresh tokens are put in local/session storage. The callback always returns to this origin's root, ignores arbitrary `appState` navigation, and removes authorization parameters from browser history after processing. Permission errors never become successful approvals. The interface compares the complete returned review report with the currently visible report before enabling the acknowledgement and submit action.

When reviewer access is configured, the server's Content Security Policy must permit **only the validated issuer origin** in `connect-src` (token requests) and `frame-src` (silent sign-in). Keep other external origins blocked. The bundled SDK needs no external script/CDN allowance. Browser privacy settings can prevent silent sign-in; the UI then asks for interactive sign-in again instead of persisting tokens.

The unconfigured reviewer state was inspected in the actual in-app browser, including responsive and keyboard behavior. The configured redirect, permission denial, private approval and authenticated download journey still need actual Auth0 settings and a reviewer account; synthetic contract tests are not a tenant-login receipt.

## Review protocol

1. An authenticated reviewer calls `GET /api/investigations/:id/review` with an `Authorization: Bearer …` header. It returns the full private report, `reportDigest`, `digestAlgorithm`, and that reviewer's approval for the current digest, if one exists.
2. The interface presents the actual evidence and limitations, then obtains an explicit confirmation. It posts to `POST /api/investigations/:id/approvals` with exactly `{ "reportDigest": "<digest from review>", "confirmation": "I reviewed the evidence and limitations" }`.
3. The server re-reads the immutable report and recomputes its digest. A mismatch returns 409 and records nothing. Illustrative reports or reports with no captured evidence cannot be approved.
4. A matching approval is stored atomically and returned with `publication: "private"`. Retrying the same report/reviewer pair returns the original record and approval timestamp. A changed report does not inherit the old approval.

The digest covers the validated full report, including ID, evidence body, verdict, limitations, source timestamps and input, using recursively sorted object keys, preserved array order, and a versioned SHA-256 domain prefix. Clients use the server-provided digest rather than duplicating canonicalization. Future schema/policy changes need a new digest/policy version.

JWT verification pins RS256 and the configured issuer/audience; requires expiry, issue time and subject; validates not-before and caps token age at 24 hours with five seconds of clock tolerance. Only the configured issuer's JWKS is used; token-supplied key URLs cannot choose the verifier. JWKS retrieval has a five-second timeout, ten-minute cache, and thirty-second refresh cooldown. Permission must appear in the Auth0 RBAC `permissions` array; a bare `scope` claim does not substitute. Client-credentials grants and `@clients` machine subjects are denied. These checks enforce the assigned identity/permission; they cannot prove a person read the evidence or prevent a compromised authorized account from confirming it.

Approval records contain the report ID/digest, approval time, policy/permission and an issuer-bound subject hash. Tokens, raw subject IDs, emails, profile data and duplicate evidence bodies are not persisted. The local store uses private 0600 files, atomic exclusive writes and a 1,000-record cap. It is single-process development storage. The MongoDB approval adapter validates immutable records, unique IDs and acknowledged writes; synthetic driver tests passed, but no live Atlas approval read/write has been exercised. A future public publisher must revalidate the exact digest, authorization, evidence freshness and release policy at publication time. Approval revocation, multi-tenant ownership and public release are not implemented here.

## Evidence boundary

Run `npx tsx --test --test-concurrency=2 tests/auth-approval.test.ts tests/workspace-auth.test.ts tests/hosted-access.test.ts tests/mongo-workspace.test.ts` and `npm run typecheck`.

Tests use generated RS256 keys, a real local JWKS resolver and the actual Fastify entry point with synthetic reports. They check valid signatures, wrong issuer/audience, missing/expired/future claims, forged/unknown keys, algorithm substitution, missing permission, machine identities, report mutations, private immutable storage, idempotent retries and credential-safe errors. Hosted-access tests additionally exercise the actual default-deny route gate, separate public/authenticated budgets and independent human reviewer budgets. This proves local enforcement, not an Auth0 tenant login or sponsor qualification. No cloud account, token, key, payment, deployment or public report was created.

The workspace transport contract test uses a synthetic browser/config fixture and restores its global fetch/window after execution. It verifies local pass-through, same-origin API confinement before SDK initialization, redirect refusal, native local downloads, case-ID restoration, malformed configuration refusal and hosted misconfiguration refusal. It makes no provider call and does not prove a configured Auth0 browser login or hosted bearer-download receipt.

Primary references checked October 30, 2026: [Auth0 access-token validation](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens), [Auth0 API RBAC](https://auth0.com/docs/manage-users/access-control/configure-core-rbac/rbac-users/view-user-permissions), [jose JWT verification and JWKS](https://github.com/panva/jose).
