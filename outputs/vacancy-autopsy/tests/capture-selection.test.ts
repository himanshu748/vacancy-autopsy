import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePostingIdentity, uniquePostingIdentity } from '../src/shared/posting-identity.js';
import { replacementCaptureForReport } from '../src/shared/capture-selection.js';
import { parseIdentity } from '../src/server/identity.js';

const id = '12345678-1234-4321-8123-123456789012';
const originalCapture = '77777777-7777-4777-8777-777777777777';
const refreshedCapture = '88888888-8888-4888-8888-888888888888';

test('Capture UI and server select one canonical identity across legacy and application-link aliases without mutating evidence links', () => {
  for (const links of [
    ['https://boards.greenhouse.io/example/jobs/123', 'https://job-boards.greenhouse.io/example/jobs/123'],
    [`https://jobs.lever.co/example/${id}`, `https://jobs.lever.co/example/${id}/apply`],
    [`https://jobs.ashbyhq.com/example/${id}`, `https://jobs.ashbyhq.com/example/${id}/application`],
  ]) {
    const before = [...links];
    const selected = uniquePostingIdentity(links);
    assert.ok(selected);
    assert.deepEqual(selected, parseIdentity(links[0]));
    assert.deepEqual(parsePostingIdentity(links[1]), selected);
    assert.deepEqual(links, before);
  }
});

test('No selection is offered for malformed metadata or different jobs, boards, ATSs or Lever regions', () => {
  const lever = `https://jobs.lever.co/example/${id}`;
  for (const links of [undefined, null, {}, [], [null], ['not-a-url'], [lever, lever.replace('example', 'other')],
    [lever, lever.replace('jobs.lever.co', 'jobs.eu.lever.co')], [lever, lever.replace(id, '22345678-1234-4321-8123-123456789012')],
    [lever, `https://jobs.ashbyhq.com/example/${id}`], [lever, 'https://outside.example.com/jobs/123'],
    ['http://jobs.lever.co/example/' + id], ['https://user:secret@jobs.lever.co/example/' + id], Array(81).fill(lever)]) {
    assert.equal(uniquePostingIdentity(links), null);
  }
});

test('A refreshed snapshot is offered only for the saved report’s exact advertisement and posting identity', () => {
  const original = { url: 'https://www.oppidx.com/opportunities/synthetic', officialUrl: 'https://boards.greenhouse.io/example/jobs/123', captureArtifactId: originalCapture };
  const selection = { ...original, officialUrl: 'https://job-boards.greenhouse.io/example/jobs/123', captureArtifactId: refreshedCapture };
  assert.equal(replacementCaptureForReport(original, selection), refreshedCapture);
  assert.equal(replacementCaptureForReport(original, { ...selection, url: original.url + '?tracking=discarded#fragment' }), refreshedCapture);
  assert.equal(replacementCaptureForReport(original, { ...selection, captureArtifactId: originalCapture }), null);
  assert.equal(replacementCaptureForReport(original, { ...selection, captureArtifactId: undefined }), null);
  assert.equal(replacementCaptureForReport(original, { ...selection, url: original.url + '-another-advertisement' }), null);
  assert.equal(replacementCaptureForReport(original, { ...selection, officialUrl: selection.officialUrl.replace('123', '124') }), null);
  assert.equal(replacementCaptureForReport(original, { ...selection, officialUrl: selection.officialUrl.replace('example', 'other') }), null);
  assert.equal(replacementCaptureForReport({ url: original.url }, selection), null);
  assert.equal(replacementCaptureForReport({ url: 'not-a-url', officialUrl: original.officialUrl }, selection), null);
});
