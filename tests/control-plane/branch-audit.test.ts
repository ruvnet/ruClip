/**
 * Coverage for `auditBranches`/`formatAuditReport`
 * (`src/control-plane/dream-cycle/branch-audit.ts`), tonight's
 * (2026-09-29) developer-experience candidate: surfacing the Dream Cycle's
 * growing `dream/*` branch backlog (9 branches measured 2026-09-19, 18
 * measured tonight) in CI instead of only via manual GitHub
 * cross-referencing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditBranches, formatAuditReport } from '../../src/control-plane/dream-cycle/branch-audit.js';

const NOW = new Date('2026-09-29T08:17:00.000Z');

test('auditBranches reports zero stale branches for an empty input', () => {
  const result = auditBranches([], NOW, 3);
  assert.deepEqual(result, { totalBranches: 0, staleBranches: [], thresholdDays: 3 });
});

test('auditBranches excludes a branch younger than the threshold', () => {
  const result = auditBranches(
    [{ name: 'dream/2026-09-27-performance', lastCommitIso: '2026-09-27T08:27:02.000Z' }],
    NOW,
    3,
  );
  assert.equal(result.totalBranches, 1);
  assert.deepEqual(result.staleBranches, []);
});

test('auditBranches includes a branch exactly at the threshold (>=, not >)', () => {
  const result = auditBranches(
    [{ name: 'dream/2026-09-26-x', lastCommitIso: '2026-09-26T08:17:00.000Z' }],
    NOW,
    3,
  );
  assert.equal(result.staleBranches.length, 1);
  assert.equal(result.staleBranches[0]?.ageDays, 3);
});

test('auditBranches computes whole-day age for a branch well past the threshold', () => {
  const result = auditBranches(
    [{ name: 'dream/2026-09-02-architecture', lastCommitIso: '2026-09-02T08:27:28.000Z' }],
    NOW,
    3,
  );
  assert.equal(result.staleBranches.length, 1);
  assert.equal(result.staleBranches[0]?.ageDays, 26);
});

test('auditBranches sorts stale branches oldest-first regardless of input order', () => {
  const result = auditBranches(
    [
      { name: 'dream/2026-09-20-correctness', lastCommitIso: '2026-09-20T08:36:39.000Z' },
      { name: 'dream/2026-09-02-architecture', lastCommitIso: '2026-09-02T08:27:28.000Z' },
      { name: 'dream/2026-09-16-security', lastCommitIso: '2026-09-16T08:34:14.000Z' },
    ],
    NOW,
    3,
  );
  assert.deepEqual(
    result.staleBranches.map((b) => b.name),
    ['dream/2026-09-02-architecture', 'dream/2026-09-16-security', 'dream/2026-09-20-correctness'],
  );
});

test('auditBranches never mutates its input array', () => {
  const branches = [{ name: 'dream/2026-09-02-architecture', lastCommitIso: '2026-09-02T08:27:28.000Z' }];
  const snapshot = JSON.stringify(branches);
  auditBranches(branches, NOW, 3);
  assert.equal(JSON.stringify(branches), snapshot);
});

test('auditBranches reproduces tonight\'s real 2026-09-29 measurement (18 branches, 16 stale)', () => {
  // Real `git for-each-ref` output against origin, captured tonight — see
  // docs/dream-cycle/BRANCH-AUDIT.md for the live run this fixture mirrors.
  // The 2 youngest branches (2026-09-27, 2026-09-28) are correctly excluded:
  // pushed within the last 2 days, they are not yet stale under the 3-day
  // threshold, even though the backlog they'll soon join is already large.
  const branches = [
    { name: 'dream/2026-09-02-architecture', lastCommitIso: '2026-09-02T08:27:28.000Z' },
    { name: 'dream/2026-09-05-correctness', lastCommitIso: '2026-09-05T08:43:57.000Z' },
    { name: 'dream/2026-09-06-security', lastCommitIso: '2026-09-06T08:31:42.000Z' },
    { name: 'dream/2026-09-07-architecture', lastCommitIso: '2026-09-07T08:25:34.000Z' },
    { name: 'dream/2026-09-08-performance', lastCommitIso: '2026-09-08T08:31:08.000Z' },
    { name: 'dream/2026-09-09-developer-experience', lastCommitIso: '2026-09-09T08:36:23.000Z' },
    { name: 'dream/2026-09-10-correctness', lastCommitIso: '2026-09-10T08:33:28.000Z' },
    { name: 'dream/2026-09-11-security', lastCommitIso: '2026-09-11T08:39:46.000Z' },
    { name: 'dream/2026-09-15-correctness', lastCommitIso: '2026-09-15T08:30:19.000Z' },
    { name: 'dream/2026-09-16-security', lastCommitIso: '2026-09-16T08:34:14.000Z' },
    { name: 'dream/2026-09-17-architecture', lastCommitIso: '2026-09-17T21:41:43.000Z' },
    { name: 'dream/2026-09-18-performance', lastCommitIso: '2026-09-18T08:31:08.000Z' },
    { name: 'dream/2026-09-19-developer-experience', lastCommitIso: '2026-09-19T08:32:16.000Z' },
    { name: 'dream/2026-09-20-correctness', lastCommitIso: '2026-09-20T08:36:39.000Z' },
    { name: 'dream/2026-09-21-security', lastCommitIso: '2026-09-21T08:48:14.000Z' },
    { name: 'dream/2026-09-22-performance', lastCommitIso: '2026-09-22T08:36:05.000Z' },
    { name: 'dream/2026-09-27-performance', lastCommitIso: '2026-09-27T08:27:02.000Z' },
    { name: 'dream/2026-09-28-performance', lastCommitIso: '2026-09-28T08:31:37.000Z' },
  ];
  const result = auditBranches(branches, NOW, 3);
  assert.equal(result.totalBranches, 18);
  assert.equal(result.staleBranches.length, 16, '16 of 18 branches are >3 days old as of tonight');
  assert.equal(result.staleBranches[0]?.name, 'dream/2026-09-02-architecture');
  assert.equal(result.staleBranches[0]?.ageDays, 26);
  assert.deepEqual(
    branches
      .map((b) => b.name)
      .filter((name) => !result.staleBranches.some((s) => s.name === name)),
    ['dream/2026-09-27-performance', 'dream/2026-09-28-performance'],
  );
});

test('formatAuditReport renders a no-branches message distinctly from a zero-stale message', () => {
  assert.equal(formatAuditReport(auditBranches([], NOW, 3)), 'No dream/* branches found on origin.');
  const allFresh = formatAuditReport(
    auditBranches([{ name: 'dream/2026-09-29-x', lastCommitIso: '2026-09-29T08:00:00.000Z' }], NOW, 3),
  );
  assert.match(allFresh, /Scanned 1 dream\/\* branch\(es\); 0 stale/);
});

test('formatAuditReport lists each stale branch with its age and last-commit timestamp', () => {
  const report = formatAuditReport(
    auditBranches(
      [{ name: 'dream/2026-09-02-architecture', lastCommitIso: '2026-09-02T08:27:28.000Z' }],
      NOW,
      3,
    ),
  );
  assert.match(report, /Scanned 1 dream\/\* branch\(es\); 1 stale \(>= 3d old\)\./);
  assert.match(report, /dream\/2026-09-02-architecture: 26d old \(last commit 2026-09-02T08:27:28\.000Z\)/);
});
