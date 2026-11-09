import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBranchDiff,
  summarizeTriage,
} from '../../src/control-plane/tooling/dream-cycle-pr-triage.js';

test('classifyBranchDiff: empty diff is docs-only (nothing to review)', () => {
  const result = classifyBranchDiff([]);
  assert.equal(result.tier, 'docs-only');
});

test('classifyBranchDiff: pure docs/ledger diff is docs-only', () => {
  const result = classifyBranchDiff([
    'docs/dream-cycle/2026-11-08-performance-report.md',
    'docs/dream-cycle/LEDGER.md',
  ]);
  assert.equal(result.tier, 'docs-only');
});

test('classifyBranchDiff: a single production file plus a docs file is NOT docs-only', () => {
  const result = classifyBranchDiff(['src/control-plane/store/agentdb-adapter.ts', 'docs/dream-cycle/LEDGER.md']);
  assert.notEqual(result.tier, 'docs-only');
});

test('classifyBranchDiff: small production change with test coverage is mechanical', () => {
  const result = classifyBranchDiff([
    'src/control-plane/store/agentdb-adapter.ts',
    'tests/control-plane/agentdb-adapter.test.ts',
    'docs/dream-cycle/LEDGER.md',
  ]);
  assert.equal(result.tier, 'mechanical');
});

test('classifyBranchDiff: production change with zero test files needs review regardless of size', () => {
  const result = classifyBranchDiff(['src/control-plane/store/agentdb-adapter.ts']);
  assert.equal(result.tier, 'needs-review');
  assert.match(result.reason, /no accompanying test file/);
});

test('classifyBranchDiff: a large production diff (above the mechanical threshold) needs review even with tests', () => {
  const result = classifyBranchDiff([
    'src/control-plane/store/agentdb-adapter.ts',
    'src/control-plane/authorization/credential-issuer.ts',
    'src/control-plane/governance/autogenous-client.ts',
    'src/control-plane/heartbeat/heartbeat-schedule.ts',
    'tests/control-plane/agentdb-adapter.test.ts',
  ]);
  assert.equal(result.tier, 'needs-review');
});

test('classifyBranchDiff: services/ counts as production, same as src/', () => {
  const result = classifyBranchDiff(['services/ruclip-attester/src/server.ts']);
  assert.equal(result.tier, 'needs-review');
});

test('summarizeTriage: tallies each tier and the total', () => {
  const summary = summarizeTriage(['docs-only', 'docs-only', 'mechanical', 'needs-review', 'needs-review', 'needs-review']);
  assert.deepEqual(summary, { docsOnly: 2, mechanical: 1, needsReview: 3, total: 6 });
});

test('summarizeTriage: empty input summarizes to all zeros', () => {
  const summary = summarizeTriage([]);
  assert.deepEqual(summary, { docsOnly: 0, mechanical: 0, needsReview: 0, total: 0 });
});
