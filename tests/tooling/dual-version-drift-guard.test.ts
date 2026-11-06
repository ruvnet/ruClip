/**
 * Coverage for `dual-version-drift-guard.ts` — Dream Cycle 2026-11-06.
 *
 * `findInstalledCopies`/`compareCopies` are pure and exercised here only
 * against temp fixture directories (no real `node_modules` read, no
 * network) — same discipline as `audit-reachability.test.ts`'s fixture-tree
 * unit tests. A separate, non-asserting diagnostic check against the real
 * installed tree is included at the bottom; it reports but never fails the
 * suite on drift, since that live receipt belongs in the dream-cycle report
 * and the `security:dual-version-drift-guard` script, not in a flaky CI gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findInstalledCopies, compareCopies, DEFAULT_WATCHED_FILE } from '../../src/tooling/dual-version-drift-guard.js';

function makeFixturePackage(root: string, pkgPath: string, version: string, watchedFileContent: string): string {
  const packageDir = join(root, ...pkgPath.split('/'));
  mkdirSync(join(packageDir, 'build', 'src', 'auth'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'google-auth-library', version }));
  writeFileSync(join(packageDir, 'build', 'src', 'auth', 'oauth2client.js'), watchedFileContent);
  return packageDir;
}

test('compareCopies: identical watched-file content across copies is consistent', () => {
  const root = mkdtempSync(join(tmpdir(), 'drift-guard-'));
  try {
    const a = makeFixturePackage(root, 'node_modules/google-auth-library', '10.9.1', 'module.exports = 1;');
    const b = makeFixturePackage(root, 'node_modules/google-gax/node_modules/google-auth-library', '11.0.2', 'module.exports = 1;');
    const result = compareCopies([a, b], DEFAULT_WATCHED_FILE);
    assert.equal(result.consistent, true);
    assert.equal(result.copies.length, 2);
    assert.equal(result.copies[0]!.hash, result.copies[1]!.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareCopies: diverging watched-file content is reported as inconsistent (the drift case)', () => {
  const root = mkdtempSync(join(tmpdir(), 'drift-guard-'));
  try {
    const a = makeFixturePackage(root, 'node_modules/google-auth-library', '10.9.1', 'module.exports = 1;');
    const b = makeFixturePackage(root, 'node_modules/google-gax/node_modules/google-auth-library', '11.0.2', 'module.exports = 2;');
    const result = compareCopies([a, b], DEFAULT_WATCHED_FILE);
    assert.equal(result.consistent, false);
    assert.notEqual(result.copies[0]!.hash, result.copies[1]!.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareCopies: a single installed copy is trivially consistent (nothing to compare)', () => {
  const root = mkdtempSync(join(tmpdir(), 'drift-guard-'));
  try {
    const a = makeFixturePackage(root, 'node_modules/google-auth-library', '10.9.1', 'module.exports = 1;');
    const result = compareCopies([a], DEFAULT_WATCHED_FILE);
    assert.equal(result.consistent, true);
    assert.equal(result.copies.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareCopies: a copy missing the watched file is reported as inconsistent, not silently skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'drift-guard-'));
  try {
    const a = makeFixturePackage(root, 'node_modules/google-auth-library', '10.9.1', 'module.exports = 1;');
    const bDir = join(root, 'node_modules', 'google-gax', 'node_modules', 'google-auth-library');
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(bDir, 'package.json'), JSON.stringify({ name: 'google-auth-library', version: '99.0.0' }));
    // Deliberately no build/src/auth/oauth2client.js at this copy.
    const result = compareCopies([a, bDir], DEFAULT_WATCHED_FILE);
    assert.equal(result.consistent, false);
    assert.equal(result.copies[1]!.missing, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findInstalledCopies: finds every nested copy, recursing through @scope directories correctly', () => {
  const root = mkdtempSync(join(tmpdir(), 'drift-guard-'));
  try {
    const a = makeFixturePackage(root, 'node_modules/google-auth-library', '10.9.1', 'x');
    const b = makeFixturePackage(root, 'node_modules/@scope/pkg/node_modules/google-auth-library', '11.0.2', 'x');
    const found = findInstalledCopies(join(root, 'node_modules'), 'google-auth-library').sort();
    assert.deepEqual(found.sort(), [a, b].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findInstalledCopies: returns an empty array when the package is not installed at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'drift-guard-'));
  try {
    mkdirSync(join(root, 'node_modules', 'unrelated-package'), { recursive: true });
    const found = findInstalledCopies(join(root, 'node_modules'), 'google-auth-library');
    assert.deepEqual(found, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic (non-asserting): real installed google-auth-library copies, if any, reported for visibility', () => {
  const copies = findInstalledCopies(join(process.cwd(), 'node_modules'), 'google-auth-library');
  const result = compareCopies(copies, DEFAULT_WATCHED_FILE);
  console.log(
    `[diagnostic] google-auth-library installed copies: ${result.copies.length}, consistent: ${result.consistent}`,
  );
});
