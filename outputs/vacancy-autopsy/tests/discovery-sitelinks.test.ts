import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { discoverJobs } from '../src/server/discovery.js';

// Provider-contract fixtures only: no live search, page capture, or availability proof.
const key = 'synthetic_sitelink_credential';
const ashby = 'https://jobs.ashbyhq.com/semgrep/8e64dc7f-e925-4361-86d5-b01ee518c987';
const lever = 'https://jobs.lever.co/palantir/17e6d46a-cb26-4d83-9388-befbc9d4da90';
const greenhouse = 'https://job-boards.greenhouse.io/figma/jobs/6144755004';
const query = 'public employer role';
function response(organic_results: unknown, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ search_metadata: { status: 'Success', id: 'synthetic_sitelinks' },
    organic_results, ...extra }), { headers: { 'content-type': 'application/json' } });
}

test('Discovery retains documented inline, expanded and list ATS sitelinks below an unusable parent', async () => {
  let calls = 0;
  const result = await discoverJobs({ query }, { apiKey: key, fetcher: (async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return response([{ link: 'not-a-url', title: 'Employer careers', position: 4, sitelinks: {
      inline: [{ title: 'Internship', link: `${ashby}?source=google#apply` }],
      expanded: [{ title: 'Administrative role', link: lever, snippet: 'Expanded result snippet' }],
      list: [{ title: 'Design role', link: greenhouse, snippet: 'List result snippet' }],
    } }]);
  }) as typeof fetch });
  assert.equal(calls, 1);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), [ashby, lever, greenhouse]);
  assert.ok(result.candidates.every((candidate) => candidate.source === 'official_posting_candidate' && candidate.position === 4));
  assert.equal(result.candidates[0].snippet, '');
  assert.equal(result.candidates[1].snippet, 'Expanded result snippet');
  assert.equal(result.candidates[2].snippet, 'List result snippet');
  assert.equal(result.provenance?.requestCount, 1);
  assert.equal(createHash('sha256').update(result.provenance!.projectionBody).digest('hex'), result.provenance?.projectionSha256);
  assert.deepEqual(JSON.parse(result.provenance!.projectionBody), { query, candidates: result.candidates });
});

test('Malformed organic/sitelink siblings cannot discard valid leads or introduce arbitrary metadata links', async () => {
  const ignored = 'https://example.com/provider-metadata';
  const result = await discoverJobs({ query }, { apiKey: key, fetcher: (async () => response([
    null, 'malformed organic row',
    { title: 42, link: null, position: 'wrong type', sitelinks: {
      inline: [null, false, { link: 'https://', title: 'Broken URL' }, { title: 3, link: lever },
        { link: ashby, title: 'Valid nested posting', snippet: { wrong: true } }],
      expanded: { link: ignored, title: 'Not an array' },
      list: [{ link: lever, title: 'Valid list posting' }],
    }, redirect_link: ignored, rich_snippet: { bottom: { link: ignored } } },
    { title: 'Valid parent despite malformed sitelinks', link: 'https://example.com/careers', sitelinks: 'wrong type' },
  ])) as typeof fetch });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), [ashby, lever, 'https://example.com/careers']);
  assert.equal(result.candidates[0].position, 3);
  assert.equal(result.candidates[0].snippet, '');
  assert.ok(!JSON.stringify(result).includes(ignored));
});

test('Discovery normalizes and deduplicates nested URLs, redacts text and refuses credential-bearing/unsafe links', async () => {
  const result = await discoverJobs({ query }, { apiKey: key, fetcher: (async () => response([
    { title: 'First occurrence', link: `${ashby}?tracking=one`, sitelinks: {
      inline: [
        { title: 'Duplicate nested occurrence', link: `${ashby}?tracking=two#apply` },
        { title: `Title ${key}`, link: `${lever}?api_key=${key}#${key}`, snippet: `Snippet ${key}` },
        { title: 'Unsafe scheme', link: 'http://example.com/job' },
        { title: 'Private address', link: 'https://127.0.0.1/job' },
        { title: 'Credentials', link: 'https://user:password@example.com/job' },
        { title: 'Private provider path', link: `https://serpapi.com/search/${key}` },
      ],
    } },
    { title: 'Later duplicate parent', link: lever },
  ], { search_metadata: { status: 'Success', id: `prefix_${key}` } })) as typeof fetch });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), [ashby, lever]);
  assert.equal(result.candidates[0].title, 'First occurrence');
  assert.equal(result.candidates[1].title, 'Title [REDACTED]');
  assert.equal(result.candidates[1].snippet, 'Snippet [REDACTED]');
  assert.equal(result.provenance?.searchId, undefined);
  assert.ok(!JSON.stringify(result).includes(key));
});

test('Exact ATS candidates retain stable provider order ahead of board roots when the ten-lead budget fills', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    link: `https://example.com/board/${index}`, title: `Board ${index}`, position: index + 1,
  }));
  const result = await discoverJobs({ query }, { apiKey: key, fetcher: (async () => response([
    ...rows,
    { link: 'https://jobs.lever.co/palantir', title: 'Employer board', position: 13,
      sitelinks: { expanded: [{ title: 'Lever exact posting', link: lever }, { title: 'Ashby exact posting', link: ashby }] } },
    { link: greenhouse, title: 'Greenhouse exact posting', position: 14 },
  ])) as typeof fetch });
  assert.equal(result.status, 'success');
  assert.equal(result.candidates.length, 10);
  assert.deepEqual(result.candidates.slice(0, 3).map((candidate) => candidate.url), [lever, ashby, greenhouse]);
  assert.deepEqual(result.candidates.slice(0, 3).map((candidate) => candidate.position), [13, 13, 14]);
  assert.deepEqual(result.candidates.slice(3).map((candidate) => candidate.url), rows.slice(0, 7).map((row) => row.link));
});

test('Only the first hundred organic rows and hundred sitelink rows globally are inspected', async () => {
  const result = await discoverJobs({ query }, { apiKey: key, fetcher: (async () => response([
    { link: 'https://example.com/first', title: 'First board', sitelinks: {
      inline: Array(50).fill(null), expanded: Array(50).fill({ title: 'Malformed nested URL', link: 'not-a-url' }),
      list: [{ title: 'Beyond global sitelink budget', link: ashby }],
    } },
    { link: lever, title: 'Top-level candidates remain independent of nested budget', sitelinks: {
      inline: [{ title: 'Still beyond global sitelink budget', link: greenhouse }],
    } },
    ...Array(98).fill(null),
    { link: greenhouse, title: 'Beyond organic row budget' },
  ])) as typeof fetch });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), [lever, 'https://example.com/first']);
  assert.match(result.limitations.join(' '), /first 100 organic rows and first 100 documented organic sitelinks/);
});
