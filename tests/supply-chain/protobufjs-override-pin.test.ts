/**
 * Regression guard for the 2026-09-16 dream-cycle security fix
 * (docs/dream-cycle/2026-09-16-security-report.md): `npm audit` found a
 * CRITICAL arbitrary-code-execution vulnerability, `protobufjs <7.5.5`
 * (CVE-2026-41242 / GHSA-xq3m-2v4x-88gg), reachable only through `ruflo`'s
 * optional, unused `agentic-flow` -> `@xenova/transformers` ->
 * `onnxruntime-web` -> `onnx-proto` ONNX toolchain — no file under `src/`,
 * `tests/`, or `services/` imports any of those packages. Closed with a
 * single `package.json` `overrides` pin
 * (`"protobufjs": "^7.6.6"`), not a source change, so nothing in the
 * ordinary test suite would otherwise notice a future regression (e.g. the
 * `overrides` entry being dropped during a routine dependency bump).
 *
 * This walks every installed `protobufjs/package.json` under
 * `node_modules` (a plain filesystem walk, dependency-free, no `npm ls`
 * subprocess) and fails loudly if any resolved copy is ever below the
 * patched version again — the same "fail loudly on drift, never silently
 * invalidate prior evidence" discipline as
 * `actor-credential-nonce-durable-backend.test.ts`'s `@claude-flow/cli`
 * pin check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Patched per GHSA-xq3m-2v4x-88gg / CVE-2026-41242: fixed in 7.5.5 (and 8.0.1 on the 8.x line). */
const MIN_SAFE_VERSION: readonly [number, number, number] = [7, 5, 5];

function parseVersion(raw: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) throw new Error(`Could not parse a semver-ish version out of '${raw}'`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(version: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== min[i]!) return version[i]! > min[i]!;
  }
  return true;
}

/** Every `node_modules/**\/protobufjs/package.json`, at any nesting depth, including under scoped (`@scope/pkg`) packages. */
function findInstalledProtobufjsPackageJsons(nodeModulesDir: string): string[] {
  const found: string[] = [];

  function visitPackageDir(pkgDir: string, pkgName: string): void {
    if (pkgName === 'protobufjs') {
      const pkgJsonPath = join(pkgDir, 'package.json');
      try {
        readFileSync(pkgJsonPath, 'utf8');
        found.push(pkgJsonPath);
      } catch {
        // Directory named 'protobufjs' with no package.json isn't a real install — skip.
      }
    }
    walk(join(pkgDir, 'node_modules'));
  }

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === '.bin' || entry === '.package-lock.json') continue;
      const entryPath = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(entryPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      if (entry.startsWith('@')) {
        let scopedEntries: string[];
        try {
          scopedEntries = readdirSync(entryPath);
        } catch {
          continue;
        }
        for (const scopedPkg of scopedEntries) {
          visitPackageDir(join(entryPath, scopedPkg), scopedPkg);
        }
        continue;
      }

      visitPackageDir(entryPath, entry);
    }
  }

  walk(nodeModulesDir);
  return found;
}

test(
  'every installed protobufjs copy (at any nesting depth) is at or above the patched 7.5.5 line — ' +
    'GHSA-xq3m-2v4x-88gg / CVE-2026-41242 stays closed regardless of future dependency churn',
  () => {
    const nodeModulesDir = join(process.cwd(), 'node_modules');
    const packageJsonPaths = findInstalledProtobufjsPackageJsons(nodeModulesDir);

    // If this ever finds zero installs, the walk itself is broken (protobufjs is definitely
    // installed transitively via @google-cloud/secret-manager) — fail loudly rather than
    // vacuously "pass" with nothing checked.
    assert.ok(
      packageJsonPaths.length > 0,
      'Expected to find at least one installed protobufjs/package.json under node_modules — the walk may be broken',
    );

    for (const pkgJsonPath of packageJsonPaths) {
      const { version } = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version: string };
      assert.ok(
        isAtLeast(parseVersion(version), MIN_SAFE_VERSION),
        `${pkgJsonPath} resolves protobufjs@${version}, below the patched 7.5.5 line ` +
          `(GHSA-xq3m-2v4x-88gg / CVE-2026-41242) — check package.json's "overrides" entry`,
      );
    }
  },
);
