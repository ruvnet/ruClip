/**
 * Coverage for src/control-plane/dream-cycle/darwin-pin-check.ts — the pure
 * logic behind scripts/check-darwin-pin.mjs (Dream Cycle 2026-10-19,
 * developer-experience). See that module's header for the full context.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPin, summarizeOtherCopies, formatReport } from '../../../src/control-plane/dream-cycle/darwin-pin-check.js';

test('checkPin: identical pinned and actual versions is a match', () => {
  const result = checkPin('0.9.3', '0.9.3', '@metaharness/darwin');
  assert.equal(result.status, 'match');
  assert.equal(result.package, '@metaharness/darwin');
  assert.equal(result.pinnedVersion, '0.9.3');
  assert.equal(result.actualVersion, '0.9.3');
});

test('checkPin: differing pinned and actual versions is a mismatch', () => {
  const result = checkPin('0.9.3', '0.9.4', '@metaharness/darwin');
  assert.equal(result.status, 'mismatch');
});

test('checkPin: carries the package name through unchanged', () => {
  const result = checkPin('1.0.0', '1.0.0', '@scope/other-pkg');
  assert.equal(result.package, '@scope/other-pkg');
});

test('summarizeOtherCopies: drops copies that match the active version', () => {
  const lines = summarizeOtherCopies('0.9.3', [
    { path: 'node_modules/@metaharness/darwin', version: '0.9.3' },
  ]);
  assert.deepEqual(lines, []);
});

test('summarizeOtherCopies: reports copies that diverge from the active version', () => {
  const lines = summarizeOtherCopies('0.9.3', [
    { path: 'node_modules/agentdb/node_modules/@metaharness/darwin', version: '0.8.0' },
    { path: 'node_modules/agentdb/node_modules/ruvector/node_modules/metaharness/node_modules/@metaharness/darwin', version: '0.2.8' },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /0\.8\.0/);
  assert.match(lines[0]!, /diverges from active 0\.9\.3/);
  assert.match(lines[1]!, /0\.2\.8/);
});

test('summarizeOtherCopies: mixed list only reports the diverging entries', () => {
  const lines = summarizeOtherCopies('0.9.3', [
    { path: 'a', version: '0.9.3' },
    { path: 'b', version: '0.8.0' },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^  - b: 0\.8\.0/);
});

test('formatReport: match with no other copies is a single OK line', () => {
  const result = checkPin('0.9.3', '0.9.3', '@metaharness/darwin');
  const report = formatReport(result, []);
  assert.match(report, /^OK: @metaharness\/darwin resolves to the pinned version 0\.9\.3/);
  assert.equal(report.includes('ADVISORY'), false);
});

test('formatReport: match with diverging copies appends a non-blocking advisory section', () => {
  const result = checkPin('0.9.3', '0.9.3', '@metaharness/darwin');
  const otherLines = summarizeOtherCopies('0.9.3', [
    { path: 'node_modules/agentdb/node_modules/@metaharness/darwin', version: '0.8.0' },
  ]);
  const report = formatReport(result, otherLines);
  assert.match(report, /^OK:/);
  assert.match(report, /ADVISORY \(non-blocking\): 1 other resolved copy/);
  assert.match(report, /0\.8\.0/);
});

test('formatReport: mismatch names both versions and instructs how to re-pin', () => {
  const result = checkPin('0.9.3', '0.9.4', '@metaharness/darwin');
  const report = formatReport(result, []);
  assert.match(report, /^MISMATCH: @metaharness\/darwin now resolves to 0\.9\.4/);
  assert.match(report, /pinned-versions\.json records 0\.9\.3/);
  assert.match(report, /update \.harness\/pinned-versions\.json/);
});

test('formatReport: pluralizes the advisory line correctly for exactly one diverging copy', () => {
  const result = checkPin('0.9.3', '0.9.3', '@metaharness/darwin');
  const otherLines = summarizeOtherCopies('0.9.3', [{ path: 'x', version: '0.8.0' }]);
  const report = formatReport(result, otherLines);
  assert.match(report, /1 other resolved copy of @metaharness\/darwin/);
});

test('formatReport: pluralizes the advisory line correctly for more than one diverging copy', () => {
  const result = checkPin('0.9.3', '0.9.3', '@metaharness/darwin');
  const otherLines = summarizeOtherCopies('0.9.3', [
    { path: 'x', version: '0.8.0' },
    { path: 'y', version: '0.2.8' },
  ]);
  const report = formatReport(result, otherLines);
  assert.match(report, /2 other resolved copies of @metaharness\/darwin/);
});
