/**
 * Consolidated version-floor regression guard for the npm-audit findings this
 * repo's own dream-cycle nights have already investigated, ACCEPTed, and
 * produced clean, lockfile-only fixes for — but whose fix PRs have sat
 * unmerged for weeks, so the vulnerable versions are still what `npm ci`
 * resolves on `main` today:
 *
 *  - `proxy-addr <2.0.8`   GHSA-jqcg-44mw-7w3h (CVSS 9.1, CRITICAL, CWE-290/348/697:
 *    IPv4-mapped-IPv6 trust-subnet IP spoofing). Fix proposed in PR #100
 *    (2026-10-26): lockfile-only `npm update proxy-addr`, no `package.json`
 *    change (`express`'s own declared `^2.0.7` range already permits
 *    `2.0.8`). Still unmerged as of this test being added.
 *
 *  - `@grpc/grpc-js <1.14.5` GHSA-m9gg-hp2v-232j (CVSS 7.4, HIGH, CWE-295:
 *    `getAuthContext` can return unauthorized peer certificates as though
 *    they were authorized). Fix proposed in PR #51 (2026-10-01): same
 *    lockfile-only pattern (`google-gax`'s declared `^1.12.6` and
 *    `@opentelemetry/exporter-*-otlp-grpc`'s declared `^1.14.3` both already
 *    permit `1.14.5`+). Unlike `proxy-addr`, this one is NOT confined to an
 *    unreachable sidecar tree: `services/ruclip-attester/src/signing-key.ts`
 *    imports `@google-cloud/secret-manager`, whose own dependency tree pulls
 *    in `@grpc/grpc-js` to make the real gRPC calls that fetch the signing
 *    key — the vulnerable transport-auth code genuinely executes on that
 *    path. Still unmerged as of this test being added.
 *
 * This test is intentionally dependency-free (no `semver` package: parses
 * `major.minor.patch` directly) and reads the real installed
 * `node_modules/<pkg>/package.json`, not `package-lock.json`'s stated
 * intent, so it fails loudly against whatever a real `npm ci` actually
 * resolved — not what some lockfile says it should have resolved.
 *
 * This file does not fix anything itself (no `package.json` or
 * `package-lock.json` change lives in this commit) — see this PR's
 * description for the actual lockfile bump, applied in the same diff.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Version = [number, number, number];

function parseVersion(version: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  assert.ok(match, `unparseable version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(actual: Version, min: Version): boolean {
  const [aMajor, aMinor, aPatch] = actual;
  const [mMajor, mMinor, mPatch] = min;
  if (aMajor !== mMajor) return aMajor > mMajor;
  if (aMinor !== mMinor) return aMinor > mMinor;
  return aPatch >= mPatch;
}

/**
 * Finds every real installed copy of `pkgName` (plain, e.g. `proxy-addr`, or
 * scoped, e.g. `@grpc/grpc-js`), at any nesting depth, by walking
 * `node_modules` directories. A `@scope` directory's entries are the scoped
 * packages themselves (not a nested `node_modules`), so it recurses straight
 * into itself rather than into a non-existent `@scope/node_modules` path —
 * and the scope segment is carried alongside the entry name when matching,
 * since a bare directory-name comparison inside a `@scope` dir would never
 * see the `@scope/` prefix.
 */
function findInstalledCopies(dir: string, pkgName: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry === '.bin') continue;
    const fullPath = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (entry.startsWith('@')) {
      findInstalledCopies(fullPath, pkgName, found);
      if (pkgName.startsWith(`${entry}/`)) {
        const scopedName = pkgName.slice(entry.length + 1);
        const scopedPath = join(fullPath, scopedName);
        try {
          if (statSync(scopedPath).isDirectory()) {
            found.push(join(scopedPath, 'package.json'));
            findInstalledCopies(join(scopedPath, 'node_modules'), pkgName, found);
          }
        } catch {
          // not present under this scope directory — fine, keep walking.
        }
      }
      continue;
    }
    if (entry === pkgName) {
      found.push(join(fullPath, 'package.json'));
    }
    findInstalledCopies(join(fullPath, 'node_modules'), pkgName, found);
  }
  return found;
}

function assertEveryCopyAtLeast(pkgName: string, min: Version, advisoryUrl: string): void {
  const copies = findInstalledCopies(join(process.cwd(), 'node_modules'), pkgName);
  assert.ok(copies.length > 0, `expected at least one installed ${pkgName} copy — test setup is stale`);
  for (const pkgPath of copies) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const version = parseVersion(pkg.version);
    assert.ok(
      isAtLeast(version, min),
      `${pkgPath} is ${pkgName}@${pkg.version}, below the ${min.join('.')} floor fixed for ${advisoryUrl}`,
    );
  }
}

test('every installed proxy-addr copy is >=2.0.8 (GHSA-jqcg-44mw-7w3h, CVSS 9.1 CRITICAL — fix: PR #100)', () => {
  assertEveryCopyAtLeast('proxy-addr', [2, 0, 8], 'https://github.com/advisories/GHSA-jqcg-44mw-7w3h');
});

test('every installed @grpc/grpc-js copy is >=1.14.5 (GHSA-m9gg-hp2v-232j, CVSS 7.4 HIGH, reachable via services/ruclip-attester/src/signing-key.ts — fix: PR #51)', () => {
  assertEveryCopyAtLeast('@grpc/grpc-js', [1, 14, 5], 'https://github.com/advisories/GHSA-m9gg-hp2v-232j');
});
