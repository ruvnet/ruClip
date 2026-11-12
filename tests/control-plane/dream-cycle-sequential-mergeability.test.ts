/**
 * Synthetic fixtures only — deterministic, independent of the live branch
 * graph (which grows nightly) so these tests won't flake as branches
 * merge/close. The live simulation is exercised separately, by hand, via
 * `npm run dream:seq-merge` against the real `origin/dream/*` backlog (see
 * docs/dream-cycle/2026-11-12-architecture-report.md for that run's output).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderDreamBranchesByDate,
  simulateSequentialMerge,
} from '../../src/control-plane/tooling/dream-cycle-sequential-mergeability.js';

test('orderDreamBranchesByDate: sorts by embedded date, oldest first', () => {
  const ordered = orderDreamBranchesByDate([
    'dream/2026-10-02-performance',
    'dream/2026-09-02-architecture',
    'dream/2026-09-30-correctness',
  ]);
  assert.deepEqual(ordered.map((b) => b.name), [
    'dream/2026-09-02-architecture',
    'dream/2026-09-30-correctness',
    'dream/2026-10-02-performance',
  ]);
});

test('orderDreamBranchesByDate: extracts date and surface', () => {
  const [parsed] = orderDreamBranchesByDate(['dream/2026-11-07-architecture']);
  assert.ok(parsed);
  assert.equal(parsed.date, '2026-11-07');
  assert.equal(parsed.surface, 'architecture');
});

test('orderDreamBranchesByDate: silently excludes non-dream-cycle branches', () => {
  const ordered = orderDreamBranchesByDate([
    'chore/ignore-tool-state-dirs',
    'dream/2026-09-02-architecture',
    'feat/ruv-manifest-nexus-20261010',
  ]);
  assert.deepEqual(ordered.map((b) => b.name), ['dream/2026-09-02-architecture']);
});

test('orderDreamBranchesByDate: breaks same-date ties by name', () => {
  const ordered = orderDreamBranchesByDate([
    'dream/2026-09-02-performance',
    'dream/2026-09-02-architecture',
  ]);
  assert.deepEqual(ordered.map((b) => b.name), [
    'dream/2026-09-02-architecture',
    'dream/2026-09-02-performance',
  ]);
});

test('simulateSequentialMerge: all-clean sequence advances the tip every step', () => {
  const branches = orderDreamBranchesByDate([
    'dream/2026-09-02-architecture',
    'dream/2026-09-03-performance',
  ]);
  const seen: string[] = [];
  const { outcomes, summary } = simulateSequentialMerge(
    branches,
    (tip, branch) => {
      seen.push(`${tip}->${branch.name}`);
      return `tree-after-${branch.name}`;
    },
    'base-tip',
  );
  assert.deepEqual(seen, [
    'base-tip->dream/2026-09-02-architecture',
    'tree-after-dream/2026-09-02-architecture->dream/2026-09-03-performance',
  ]);
  assert.equal(outcomes.every((o) => o.status === 'merged'), true);
  assert.equal(summary.mergedCount, 2);
  assert.equal(summary.conflictCount, 0);
  assert.equal(summary.longestCleanPrefix, 2);
  assert.equal(summary.firstConflictBranch, null);
});

test('simulateSequentialMerge: a mid-sequence conflict does not block later clean branches', () => {
  const branches = orderDreamBranchesByDate([
    'dream/2026-09-02-architecture',
    'dream/2026-09-03-performance',
    'dream/2026-09-05-correctness',
  ]);
  const { outcomes, summary } = simulateSequentialMerge(
    branches,
    (tip, branch) => (branch.name.includes('09-03') ? null : `tree-after-${branch.name}`),
    'base-tip',
  );
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ['merged', 'conflict', 'merged'],
  );
  assert.equal(summary.mergedCount, 2);
  assert.equal(summary.conflictCount, 1);
  assert.equal(summary.firstConflictBranch, 'dream/2026-09-03-performance');
  // The later clean branch is attempted against the tip left by the LAST
  // branch that merged, not against the conflicting branch's own tree.
  assert.equal(outcomes[2]?.tipSha, 'tree-after-dream/2026-09-05-correctness');
});

test('simulateSequentialMerge: longestCleanPrefix stops counting at the first conflict', () => {
  const branches = orderDreamBranchesByDate([
    'dream/2026-09-02-architecture',
    'dream/2026-09-03-performance',
    'dream/2026-09-05-correctness',
    'dream/2026-09-06-security',
  ]);
  const { summary } = simulateSequentialMerge(
    branches,
    (tip, branch) => (branch.name.includes('09-05') ? null : `tree-after-${branch.name}`),
    'base-tip',
  );
  // Branches 1-2 merge cleanly (prefix length 2), branch 3 conflicts, branch
  // 4 then merges again (against the tip left by branch 2) but does not
  // extend the *unbroken* prefix.
  assert.equal(summary.longestCleanPrefix, 2);
  assert.equal(summary.mergedCount, 3);
  assert.equal(summary.conflictCount, 1);
});

test('simulateSequentialMerge: empty branch list is a clean no-op', () => {
  const { outcomes, summary } = simulateSequentialMerge([], () => 'unused', 'base-tip');
  assert.deepEqual(outcomes, []);
  assert.equal(summary.totalBranches, 0);
  assert.equal(summary.longestCleanPrefix, 0);
  assert.equal(summary.firstConflictBranch, null);
});
