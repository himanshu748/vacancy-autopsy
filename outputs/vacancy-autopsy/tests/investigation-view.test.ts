import test from "node:test";
import assert from "node:assert/strict";
import type { Investigation } from "../src/shared/types";
import {
  buildInvestigationView,
  publicSourceLink,
  capturedSourceLink,
} from "../src/web/investigation-view";

function report(overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    input: { url: "https://boards.greenhouse.io/example/jobs/123" },
    createdAt: "2026-10-30T10:00:00Z",
    checkedAt: "2026-10-30T10:00:01Z",
    verdict: "verified_open",
    title: "Example engineer",
    employer: "Example",
    jobId: "123",
    ats: "greenhouse",
    officialUrl: "https://boards.greenhouse.io/example/jobs/123",
    explanation: "Synthetic source fixture.",
    limitations: ["Fixture only."],
    timeline: [],
    mode: "live",
    publication: "private",
    evidence: [
      {
        id: "source-1",
        kind: "official_feed",
        url: "https://boards-api.greenhouse.io/v1/boards/example/jobs",
        capturedAt: "2026-10-30T10:00:01Z",
        sha256: "a".repeat(64),
        summary: "Synthetic official response.",
        httpStatus: 200,
      },
    ],
    ...overrides,
  };
}

test("Open and absent briefs describe exact posting status without inventing hiring intent or previous removal", () => {
  const open = buildInvestigationView(report());
  assert.match(open.meaning, /exact posting was found/);
  assert.match(open.meaning, /does not guarantee/);
  assert.equal(open.sources[0].state, "Exact posting found");
  assert.deepEqual(open.facts, [
    { label: "Posting ID", value: "123" },
    { label: "Evidence retained", value: "1 record" },
  ]);
  const absent = buildInvestigationView(report({ verdict: "not_listed" }));
  assert.match(absent.meaning, /whether it existed before/);
  assert.match(absent.nextStep, /reposted opening/);
  assert.equal(absent.sources[0].state, "Exact ID not found");
});

test("No official snapshot and illustrative records cannot become positive source facts", () => {
  const empty = buildInvestigationView(
    report({ evidence: [], verdict: "inconclusive", jobId: undefined }),
  );
  assert.match(empty.meaning, /No official source snapshot/);
  assert.equal(empty.sources[0].state, "No snapshot retained");
  assert.equal(empty.facts[0].value, "Unresolved");
  const inconsistent = buildInvestigationView(
    report({ evidence: [], verdict: "verified_open" }),
  );
  assert.doesNotMatch(inconsistent.meaning, /posting was found/);
  const illustrative = buildInvestigationView(report({ mode: "illustrative" }));
  assert.equal(illustrative.sources[0].state, "Illustrative only");
  assert.match(illustrative.meaning, /not a checked opening/);
});

test("A matched official timeline does not promote an unrelated advertisement from inconclusive", () => {
  const mixed = report({
    verdict: "inconclusive",
    input: {
      url: "https://public-board.org/old-listing",
      officialUrl: "https://boards.greenhouse.io/example/jobs/123",
      advertisementText: "Supplied advertisement",
    },
    timeline: [
      {
        name: "Official source checked",
        status: "complete",
        detail: "The exact posting is present.",
        at: "2026-10-30T10:00:01Z",
      },
    ],
  });
  const view = buildInvestigationView(mixed);
  assert.equal(view.sources.length, 2);
  assert.equal(view.sources[0].label, "Advertisement supplied");
  assert.equal(view.sources[0].state, "Pasted text retained");
  assert.equal(view.sources[1].state, "Current status unresolved");
  assert.match(view.meaning, /cannot establish/);
  assert.match(view.provenanceNote!, /has not been independently verified/);
  assert.match(view.nextStep, /Confirm that the advertisement links/);
});

test("Public source links strip credential and tracking fields and refuse non-public address forms", () => {
  assert.equal(
    publicSourceLink(
      "https://name:credential@boards.greenhouse.io/example/jobs/123?token=discard#secret",
    ),
    "https://boards.greenhouse.io/example/jobs/123",
  );
  for (const value of [
    "javascript:alert(1)",
    "http://public-board.org/jobs",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://10.0.0.5/",
    "https://[::1]/",
    "https://192.168.1.2/",
    "https://example.internal/",
    "https://example.local/",
    "https://public-board.org:8080/",
    "not a URL",
  ]) {
    assert.equal(publicSourceLink(value), undefined, value);
  }
  const view = buildInvestigationView(
    report({
      input: { url: "javascript:alert(1)", advertisementText: "Supplied text" },
      evidence: [],
      officialUrl: "https://127.0.0.1/private",
    }),
  );
  assert.ok(view.sources.every((source) => source.url === undefined));
});

test("Recheck identity alone does not claim a previous verdict, a change, or independently verified hashes", () => {
  const view = buildInvestigationView(
    report({ previousInvestigationId: "22222222-2222-4222-8222-222222222222" }),
  );
  const text = JSON.stringify(view);
  assert.doesNotMatch(
    text,
    /changed|previous verdict|hash.*verified|confidence/i,
  );
  assert.equal(view.facts[1].value, "1 record");
});

test("Captured Lever links preserve page identity and direct JSON endpoints without allowing credential queries", () => {
  for (const host of ["api.lever.co", "api.eu.lever.co"]) {
    const endpoint = `https://${host}/v0/postings/palantir?mode=json&limit=100&skip=100`;
    assert.equal(capturedSourceLink(endpoint), endpoint);
    const direct = `https://${host}/v0/postings/palantir/123?mode=json`;
    assert.equal(capturedSourceLink(direct), direct);
  }
  const endpoint =
    "https://api.lever.co/v0/postings/palantir?mode=json&limit=100&skip=100";
  const model = buildInvestigationView(
    report({ evidence: [{ ...report().evidence[0], url: endpoint }] }),
  );
  assert.equal(model.sources[0].url, endpoint);
  for (const value of [
    endpoint + "&token=private",
    endpoint + "&skip=200",
    endpoint.replace("skip=100", "skip=-1"),
    "https://other.org/?mode=json&limit=100&skip=100",
  ])
    assert.equal(capturedSourceLink(value), undefined);
});


test('Structured employer-source observations explain useful facts without promoting ad linkage', () => {
  const result = buildInvestigationView(report({verdict:'inconclusive', sourceObservation:{verdict:'not_listed',explanation:'Exact ID absent.',checkedAt:'2026-10-30T10:00:01Z'},input:{url:'https://public-board.org/listing',officialUrl:'https://boards.greenhouse.io/example/jobs/123'}}));
  assert.match(result.meaning,/does not currently list/);
  assert.match(result.meaning,/still needs confirmation/);
  assert.equal(result.sources[1].state,'ID absent · ad link unconfirmed');
});

test('Server-attached browser evidence explains exact linkage without inventing ownership or intent', () => {
  const input = { url: 'https://www.oppidx.com/opportunities/fixture',
    officialUrl: 'https://boards.greenhouse.io/example/jobs/123',
    captureArtifactId: '33333333-3333-4333-8333-333333333333' };
  const captured = { id: 'browser-1', kind: 'browser_capture' as const, url: input.url,
    capturedAt: '2026-10-30T10:00:00Z', sha256: 'b'.repeat(64), summary: 'Synthetic browser fixture.' };
  const observed = report({ input, verdict: 'not_listed', evidence: [captured, ...report().evidence] });
  const view = buildInvestigationView(observed);
  assert.equal(view.sources[0].label, 'Advertisement captured');
  assert.equal(view.sources[0].state, 'Exact posting link retained');
  assert.match(view.provenanceNote!, /links this advertisement to the exact checked ATS posting/);
  assert.match(view.provenanceNote!, /does not establish employer ownership, hiring intent or prior removal/);
  assert.doesNotMatch(view.provenanceNote!, /has not been independently verified/);
  assert.match(view.meaning, /absent from the checked board/);
  const unavailable = buildInvestigationView({ ...observed, verdict: 'inconclusive', evidence: [captured] });
  assert.match(unavailable.meaning, /No official source snapshot/);
  assert.match(unavailable.nextStep, /posting link is retained/);
  assert.match(unavailable.sources[0].state, /Exact posting link/);
  const unbound = buildInvestigationView({ ...observed, input: { ...input, captureArtifactId: undefined } });
  assert.equal(unbound.sources[0].label, 'Advertisement supplied');
  assert.match(unbound.provenanceNote!, /has not been independently verified/);
  const mismatched = buildInvestigationView({ ...observed, evidence: [{ ...captured, url: 'https://www.oppidx.com/opportunities/other' }, ...report().evidence] });
  assert.equal(mismatched.sources[0].label, 'Advertisement supplied');
});
