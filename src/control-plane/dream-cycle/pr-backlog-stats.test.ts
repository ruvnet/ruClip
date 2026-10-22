import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSurfaceFromHeadRef, summarizeDreamCyclePrs, type DreamCyclePr } from './pr-backlog-stats.js';

test('parseSurfaceFromHeadRef extracts the surface from a dream/<date>-<surface> ref', () => {
  assert.equal(parseSurfaceFromHeadRef('dream/2026-10-21-security'), 'security');
  assert.equal(parseSurfaceFromHeadRef('dream/2026-09-29-developer-experience'), 'developer-experience');
});

test('parseSurfaceFromHeadRef returns null for a non-dream-cycle branch', () => {
  assert.equal(parseSurfaceFromHeadRef('feat/ruv-manifest-nexus-20261010'), null);
  assert.equal(parseSurfaceFromHeadRef('main'), null);
});

test('summarizeDreamCyclePrs computes merge rate, surface tallies, and the unmerged streak', () => {
  const prs: DreamCyclePr[] = [
    { number: 9, headRef: 'dream/2026-09-02-architecture', state: 'closed', merged: false, createdAt: '2026-09-02T08:27:28Z' },
    { number: 11, headRef: 'dream/2026-09-03-performance', state: 'closed', merged: true, createdAt: '2026-09-03T08:29:26Z' },
    { number: 15, headRef: 'dream/2026-09-06-security', state: 'closed', merged: true, createdAt: '2026-09-06T08:31:42Z' },
    { number: 17, headRef: 'dream/2026-09-07-architecture', state: 'open', merged: false, createdAt: '2026-09-07T08:25:34Z' },
    { number: 61, headRef: 'dream/2026-10-07-architecture', state: 'open', merged: false, createdAt: '2026-10-07T08:29:25Z' },
  ];

  const summary = summarizeDreamCyclePrs(prs);

  assert.equal(summary.total, 5);
  assert.equal(summary.merged, 2);
  assert.equal(summary.closedUnmerged, 1);
  assert.equal(summary.openUnmerged, 2);
  assert.equal(summary.mergeRatePct, 40);
  assert.deepEqual(summary.bySurface, {
    architecture: { total: 3, merged: 0 },
    performance: { total: 1, merged: 1 },
    security: { total: 1, merged: 1 },
  });
  assert.equal(summary.lastMergedCreatedAt, '2026-09-06T08:31:42Z');
  // Only #17 and #61 were created after the last merge (#15).
  assert.equal(summary.unmergedStreak, 2);
});

test('summarizeDreamCyclePrs on an all-unmerged backlog reports a 0% merge rate and a full-length streak', () => {
  const prs: DreamCyclePr[] = [
    { number: 78, headRef: 'dream/2026-10-15-correctness', state: 'open', merged: false, createdAt: '2026-10-15T08:33:15Z' },
    { number: 90, headRef: 'dream/2026-10-21-security', state: 'open', merged: false, createdAt: '2026-10-21T08:32:51Z' },
  ];

  const summary = summarizeDreamCyclePrs(prs);

  assert.equal(summary.mergeRatePct, 0);
  assert.equal(summary.lastMergedCreatedAt, null);
  assert.equal(summary.unmergedStreak, 2);
});

test('summarizeDreamCyclePrs rejects a PR whose headRef is not a dream/<date>-<surface> branch', () => {
  const prs: DreamCyclePr[] = [
    { number: 66, headRef: 'feat/ruv-manifest-nexus-20261010', state: 'open', merged: false, createdAt: '2026-10-10T03:06:48Z' },
  ];

  assert.throws(() => summarizeDreamCyclePrs(prs), /not a dream\/<date>-<surface> branch/);
});
