/**
 * Synthetic-diff unit coverage for overlap-duplicate-audit.ts. The real
 * live run against this repo's actual 35 `dream/*` branches is reported in
 * docs/dream-cycle/2026-10-18-developer-experience-report.md and committed
 * to docs/dream-cycle/OVERLAP-AUDIT.md, not re-asserted here — these tests
 * only prove the pure detection logic itself is correct on inputs whose
 * right answer is known by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUnifiedDiffHunks,
  findOverlappingPairs,
  isRoutinePaperworkFile,
  formatOverlapReport,
} from '../../src/control-plane/dream-cycle/overlap-duplicate-audit.js';

function diffFor(file: string, startLine: number, count: number): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index 0000000..1111111 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${startLine},${count} +${startLine},${count} @@`,
    '-old line',
    '+new line',
  ].join('\n');
}

test('parseUnifiedDiffHunks extracts the post-image file and line range from a real-shaped unified diff', () => {
  const diff = diffFor('.github/workflows/ci.yml', 17, 1);
  const hunks = parseUnifiedDiffHunks(diff);
  assert.deepEqual(hunks, [{ file: '.github/workflows/ci.yml', startLine: 17, endLine: 17 }]);
});

test('parseUnifiedDiffHunks handles a hunk with no explicit count (implicit count of 1)', () => {
  const diff = [
    'diff --git a/foo.ts b/foo.ts',
    '--- a/foo.ts',
    '+++ b/foo.ts',
    '@@ -5 +5 @@',
    '-x',
    '+y',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiffHunks(diff), [{ file: 'foo.ts', startLine: 5, endLine: 5 }]);
});

test('findOverlappingPairs flags two branches that touch the exact same single line of the same file — the real PR #65/#76 shape', () => {
  const branches = new Map([
    ['dream/2026-10-09-developer-experience', diffFor('.github/workflows/ci.yml', 17, 1)],
    ['dream/2026-10-14-developer-experience', diffFor('.github/workflows/ci.yml', 17, 1)],
  ]);
  const matches = findOverlappingPairs(branches);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.file, '.github/workflows/ci.yml');
  assert.deepEqual(new Set([matches[0]?.branchA, matches[0]?.branchB]), new Set(['dream/2026-10-09-developer-experience', 'dream/2026-10-14-developer-experience']));
});

test('findOverlappingPairs does NOT flag two branches that touch the same file but disjoint line ranges — the real 4-way agentdb-adapter.ts architecture-extraction shape', () => {
  const branches = new Map([
    ['dream/2026-09-02-architecture', diffFor('src/control-plane/store/agentdb-adapter.ts', 1200, 20)],
    ['dream/2026-10-07-architecture', diffFor('src/control-plane/store/agentdb-adapter.ts', 1300, 20)],
  ]);
  assert.deepEqual(findOverlappingPairs(branches), []);
});

test('findOverlappingPairs does not flag two branches touching different files', () => {
  const branches = new Map([
    ['a', diffFor('src/one.ts', 10, 5)],
    ['b', diffFor('src/two.ts', 10, 5)],
  ]);
  assert.deepEqual(findOverlappingPairs(branches), []);
});

test('findOverlappingPairs treats a touching-but-not-overlapping adjacent range as non-overlapping', () => {
  const branches = new Map([
    ['a', diffFor('f.ts', 1, 5)], // lines 1-5
    ['b', diffFor('f.ts', 6, 5)], // lines 6-10
  ]);
  assert.deepEqual(findOverlappingPairs(branches), []);
});

test('findOverlappingPairs is symmetric regardless of input branch order and never compares a branch to itself', () => {
  const forward = new Map([
    ['a', diffFor('f.ts', 10, 5)],
    ['b', diffFor('f.ts', 12, 5)],
  ]);
  const backward = new Map([
    ['b', diffFor('f.ts', 12, 5)],
    ['a', diffFor('f.ts', 10, 5)],
  ]);
  assert.equal(findOverlappingPairs(forward).length, 1);
  assert.equal(findOverlappingPairs(backward).length, 1);
  assert.equal(findOverlappingPairs(new Map([['a', diffFor('f.ts', 10, 5)]])).length, 0);
});

test('isRoutinePaperworkFile excludes LEDGER.md, dated reports, generated audit docs, and package-lock.json', () => {
  assert.equal(isRoutinePaperworkFile('docs/dream-cycle/LEDGER.md'), true);
  assert.equal(isRoutinePaperworkFile('docs/dream-cycle/2026-10-09-developer-experience-report.md'), true);
  assert.equal(isRoutinePaperworkFile('docs/dream-cycle/BRANCH-AUDIT.md'), true);
  assert.equal(isRoutinePaperworkFile('docs/dream-cycle/SUPERSESSION-AUDIT.md'), true);
  assert.equal(isRoutinePaperworkFile('package-lock.json'), true);
  assert.equal(isRoutinePaperworkFile('.github/workflows/ci.yml'), false);
  assert.equal(isRoutinePaperworkFile('src/control-plane/store/agentdb-adapter.ts'), false);
  assert.equal(isRoutinePaperworkFile('docs/adr/ADR-0002-dream-cycle-candidate-promotion-backlog.md'), false);
});

test('findOverlappingPairs ignores routine-paperwork-only overlaps (every branch appends LEDGER.md at the same stale insertion point)', () => {
  const branches = new Map([
    ['a', diffFor('docs/dream-cycle/LEDGER.md', 40, 1)],
    ['b', diffFor('docs/dream-cycle/LEDGER.md', 40, 1)],
  ]);
  assert.deepEqual(findOverlappingPairs(branches), []);
});

test('formatOverlapReport renders a human-readable, non-empty summary for a found match and an explicit all-clear for none', () => {
  const match = findOverlappingPairs(
    new Map([
      ['a', diffFor('.github/workflows/ci.yml', 17, 1)],
      ['b', diffFor('.github/workflows/ci.yml', 17, 1)],
    ]),
  );
  assert.match(formatOverlapReport(match), /ci\.yml.*\[17-17\].*overlaps/s);
  assert.match(formatOverlapReport([]), /No file\/line-range overlaps/);
});
