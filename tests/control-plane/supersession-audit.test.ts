import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSupersessionClaims,
  summarizeSupersessionClaims,
  type BranchCommit,
} from '../../src/control-plane/dream-cycle/supersession-audit.js';

// Verbatim (modulo surrounding paragraph text) from the real, live
// ruvnet/ruClip remote: dream/2026-10-02-performance's commit
// 97dbcf340afee117b45c3f9709dc104495a96bc5 (PR #53), which explicitly
// reimplements stalled PR #19 (2026-09-08).
const REAL_SUPERSEDES_COMMIT: BranchCommit = {
  branch: 'dream/2026-10-02-performance',
  sha: '97dbcf340afee117b45c3f9709dc104495a96bc5',
  message:
    'perf(dream-cycle 2026-10-02): parallelize 3 sequential tier-scan listers (rotated from architecture)\n\n' +
    'Supersedes stalled, unmerged PR #19 (2026-09-08) with a fresh reimplementation\n' +
    'of the same already-ACCEPT finding against today\'s main HEAD. listIssuesForGoal,\n' +
    'listApprovalTransitionsForCompany, and listHeartbeatsForCompany each scanned the\n' +
    'working then episodic hierarchical-store tier sequentially.\n\nCloses #52.',
};

// Verbatim from dream/2026-10-07-architecture's commit
// b4fdc20328e1b2a9108c21917b38a2c0cf2eccc3 (PR #61), reimplementing stale
// draft PR #9 (2026-09-02).
const REAL_REDO_COMMIT: BranchCommit = {
  branch: 'dream/2026-10-07-architecture',
  sha: 'b4fdc20328e1b2a9108c21917b38a2c0cf2eccc3',
  message:
    'architecture(dream-cycle 2026-10-07): extract operating-budget circuit breaker from agentdb-adapter, fresh against current main\n\n' +
    'Redoes the identical candidate stale draft PR #9 (2026-09-02) already\n' +
    'proved, because #9\'s branch now conflicts with main.',
};

test('parseSupersessionClaims recovers the real "Supersedes ... PR #N" admission', () => {
  const claims = parseSupersessionClaims([REAL_SUPERSEDES_COMMIT]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.supersededPrNumber, 19);
  assert.equal(claims[0]?.claimantBranch, 'dream/2026-10-02-performance');
});

test('parseSupersessionClaims recovers the real "Redoes ... stale draft PR #N" admission', () => {
  const claims = parseSupersessionClaims([REAL_REDO_COMMIT]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.supersededPrNumber, 9);
});

test('parseSupersessionClaims does not flag an ordinary commit mentioning an unrelated issue number', () => {
  const commit: BranchCommit = {
    branch: 'dream/2026-10-08-performance',
    sha: 'e68983f6350d8625536fb2752061d90ae237c24d',
    message:
      'docs/perf(dream-cycle 2026-10-08): persistIssue\'s edge writes resist naive parallelization\n\n' +
      'Rejected the hypothesis with this clean measurement. See issue #62.',
  };
  assert.deepEqual(parseSupersessionClaims([commit]), []);
});

test('parseSupersessionClaims does not flag "redo" or "supersede" used without a PR reference', () => {
  const commit: BranchCommit = {
    branch: 'dream/example',
    sha: 'deadbeef',
    message: 'This supersedes nothing in particular and we will redo it later, no ticket yet.',
  };
  assert.deepEqual(parseSupersessionClaims([commit]), []);
});

test('parseSupersessionClaims counts one claim per commit even if both patterns would match', () => {
  const commit: BranchCommit = {
    branch: 'dream/example',
    sha: 'deadbeef',
    message: 'This redo supersedes stale draft PR #42 entirely.',
  };
  const claims = parseSupersessionClaims([commit]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.supersededPrNumber, 42);
});

test('parseSupersessionClaims scans multiple commits/branches independently', () => {
  const claims = parseSupersessionClaims([REAL_SUPERSEDES_COMMIT, REAL_REDO_COMMIT]);
  assert.equal(claims.length, 2);
  assert.deepEqual(
    claims.map((c) => c.supersededPrNumber).sort((a, b) => a - b),
    [9, 19],
  );
});

test('summarizeSupersessionClaims deduplicates the superseded PR numbers and sorts them', () => {
  const summary = summarizeSupersessionClaims([
    { claimantBranch: 'b1', claimantSha: 's1', supersededPrNumber: 19, evidence: 'e1' },
    { claimantBranch: 'b2', claimantSha: 's2', supersededPrNumber: 9, evidence: 'e2' },
    { claimantBranch: 'b3', claimantSha: 's3', supersededPrNumber: 19, evidence: 'e3' },
  ]);
  assert.equal(summary.totalClaims, 3);
  assert.deepEqual(summary.distinctSupersededPrNumbers, [9, 19]);
});

test('summarizeSupersessionClaims returns an empty summary for no claims', () => {
  const summary = summarizeSupersessionClaims([]);
  assert.equal(summary.totalClaims, 0);
  assert.deepEqual(summary.distinctSupersededPrNumbers, []);
});
