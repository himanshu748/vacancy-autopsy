# Discovery and restricted browser capture

These optional adapters support finding and retaining public source leads. They do not predict employer intent or submit applications. Provider-contract tests use synthetic responses; no live SerpApi request or Browserbase session was run during implementation.

## Server integration

The server passes configuration privately and invokes a provider only after the user requests that operation through the source-tools interface. No API key belongs in browser JavaScript or request bodies from the frontend. Configuring a key is not a billing authorization or a successful integration receipt.

```ts
import { discoverJobs, discoveryInputSchema } from './discovery.js';
import { captureAdvertisement, captureInputSchema } from './browser-capture.js';

const query = discoveryInputSchema.parse(request.body); // { query: string }
const leads = await discoverJobs(query, { apiKey: process.env.SERPAPI_API_KEY, signal });

const target = captureInputSchema.parse(request.body); // { url: public HTTPS URL }
const capture = await captureAdvertisement(target, {
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  signal,
});
```

The integrated routes use the server's Host/Origin controls, operation rate limit and request cancellation. `POST /api/discovery` and `POST /api/captures` persist immutable private artifacts; `GET /api/research/:id/report` downloads them. The local desk is loopback-only, while hosted mode requires the workspace bearer for all three endpoints. One source-tool operation may run at a time in this process. Invalid input raises a Zod validation error. Missing configuration returns `not_configured` with no provider call. Provider failures return a safe `failed`/`cancelled` result without raw exception strings or connection URLs. The routes persist independent discovery/capture artifacts; the helpers themselves do not mutate investigation records.

Discovery returns candidate URL, title, snippet, position and candidate type. `provenance` holds the provider search ID when available, one-request count, the exact normalized result projection and its SHA-256. It deliberately does not store raw provider metadata or a request URL carrying `api_key`. A projection hash authenticates the retained projection, not the underlying page or a complete raw search response. An ATS URL is labeled `official_posting_candidate`; it has not yet been checked.

Capture returns a timestamped `browser_capture` evidence record containing the exact retained JSON DOM observation and its hash. A separate optional PNG artifact has base64 bytes, byte count and a byte hash. Persist image bytes with private access and display the stated capture restrictions alongside them. `officialLinks` contains exact supported ATS URLs observed in the first 80 anchors. A page linking to an opening is useful evidence, but does not independently establish employer ownership, title equivalence or current availability. Do not automatically promote the overall third-party report verdict.

## Bounds and access behavior

SerpApi uses one synchronous first-page Google search, a ten-second request deadline, no retry or pagination, a 1 MB response cap and at most ten retained unique candidates. Cached results are allowed and explicitly qualified. Snippets can be old; the verifier must still fetch the first-party source. Result URL queries and fragments are removed before storage.

Browserbase creates at most one concurrent session in this process. A session requests a 60-second provider timeout, `keepAlive: false`, no proxy, no CAPTCHA solving, no stealth, and normal certificate validation. There is no context, cookie or login reuse. The local operation has a 35-second budget plus an independent eight-second cleanup request. Creation is never retried: a timed-out creation might have created an unknown session, which should expire at its requested provider timeout. A duration bound is not a guaranteed dollar cost or a grant of free usage.

Capture destinations are fixed exact hosts: OppIDX, Employbl and the supported Greenhouse, Lever and Ashby posting hosts. Arbitrary employer domains are unsupported. DNS answers must all be public global addresses. The provider's `allowedDomains` setting restricts main-frame navigation **only**, including subdomains; it is not a resource egress firewall. Therefore capture also disables page JavaScript before navigation, bypasses service workers and intercepts every CDP Fetch request. The handler permits only GET/HTTPS requests to a fixed exact host set after public-DNS validation; it blocks redirects, frames and resources outside that set, credentials, custom ports, and private/reserved addresses. Eighty requests are the maximum allowed. Failures in interception terminate capture. WebSocket connection URLs are accepted only on Browserbase-owned WSS hosts and are never included in artifacts.

Local DNS checks cannot pin how a remote provider resolves a hostname. The fixed trusted-host restriction is intentional; do not replace it with an arbitrary user-controlled hostname allowlist. Page JavaScript remains disabled to prevent page WebSocket/worker/pop-up traffic outside Fetch interception. No dynamic application-state claim is supported. Access-denied/CAPTCHA pages are retained as `blocked`; no bypass is attempted.

The snapshot is limited to 16,000 text characters, 80 anchors and a 1280×900 viewport screenshot below 1 MB. Other resource requests may be blocked, so appearance/content can be incomplete. Hashes refer to that declared subset. This is useful static-browser evidence, not a complete page archive or proof a form accepts submissions.

Known sessions receive an explicit release request in `finally`, even after cancellation or unsafe transport data. Cleanup has its own uncancelled deadline. The response must identify the same session with a terminal state before `cleanup: released` is returned. A successful HTTP response reporting a still-running session remains `cleanup: release_failed`, meaning release could not be confirmed. The provider's hard timeout remains the final bound.

## Verification and remaining gates

Run `npx tsx --test --test-concurrency=2 tests/discovery-capture.test.ts tests/research-routes.test.ts tests/mongo-workspace.test.ts`. Tests exercise bounded discovery, retained hashes, missing configuration, malformed/oversized/invalid-UTF-8 provider responses, private/reserved DNS, foreign CDP endpoints, final redirects, request interception, main-frame status handling, blocked access, cancellation and cleanup. All responses and the CDP connection in these tests are synthetic fixtures. Native WebSocket/CDP transport against Browserbase and provider-side policy enforcement require a real authorized run.

The source-tools interface was exercised in the in-app browser without credentials: search and capture returned explicit unavailable states, with no fabricated results or provider calls. A separate real OppIDX advertisement was inspected through the user's browser, not Browserbase; it does not satisfy the Browserbase gate.

Before a sponsor claim, retain a successful live discovery projection and a real capture screenshot/DOM artifact with source URLs and timestamps, plus provider session/release receipts. Check actual account quota and allowed features before enabling calls. The adapters do not establish free-plan availability, actual credits, sponsor eligibility, historical stale-ad labels or a successful public deployment.

Primary contracts checked October 30, 2026: [SerpApi Search API](https://serpapi.com/search-api), [Browserbase session creation](https://docs.browserbase.com/reference/api/create-a-session), [Browserbase release](https://docs.browserbase.com/reference/api/update-a-session), [current Browserbase SDK settings and allowed-domain limitations](https://github.com/browserbase/sdk-node/blob/main/src/resources/sessions/sessions.ts), [Chrome DevTools Fetch interception](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/).
