/**
 * Regression guard for GHSA-jqcg-44mw-7w3h (CVSS 9.1, CWE-290/348/697):
 * `proxy-addr` `>=1.1.0 <2.0.8` trusts an IPv4-mapped IPv6 address inside a
 * configured trust subnet even when the real peer address is a plain IPv4
 * address outside it, letting a spoofed `X-Forwarded-For` value be accepted
 * as if it came from a trusted proxy. Fixed upstream in `2.0.8`.
 *
 * ruClip's own code never imports `proxy-addr` or configures an
 * Express `trust proxy` setting (confirmed by repo-wide grep across
 * `src/`/`services/` — no `trust proxy`, `proxy-addr`, or `req.ip` usage
 * exists outside this test and `node_modules`); the one installed copy is
 * nested under `ruflo`'s optional `@claude-flow/cli` → `express` sidecar
 * tree, unreachable from any code path this repo's own build emits. Same
 * class of residual, not-this-repo's-call risk as the `protobufjs` finding
 * in issue #28/PR #29 — fixed here anyway as supply-chain hygiene, the same
 * `npm update` (lockfile-only, no `package.json`/`overrides` change) used
 * for the `@grpc/grpc-js` finding in issue #50/PR #51, since `express`'s own
 * declared range (`^2.0.7`) already permits `2.0.8` with no version
 * override needed.
 *
 * This test is dependency-free (no `semver` package) and walks the real
 * installed tree rather than trusting `package-lock.json`'s stated
 * intent, so a future reinstall that silently re-resolves to a vulnerable
 * copy fails loudly instead of only showing up in a periodic `npm audit`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MIN_SAFE_VERSION: [number, number, number] = [2, 0, 8];

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  assert.ok(match, `unparseable proxy-addr version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(actual: [number, number, number], min: [number, number, number]): boolean {
  const [aMajor, aMinor, aPatch] = actual;
  const [mMajor, mMinor, mPatch] = min;
  if (aMajor !== mMajor) return aMajor > mMajor;
  if (aMinor !== mMinor) return aMinor > mMinor;
  return aPatch >= mPatch;
}

/**
 * Finds every real installed copy of `proxy-addr`, at any nesting depth, by
 * walking `node_modules` directories. `dir` is "a directory whose entries
 * are package directories" — true of `node_modules` itself, of any
 * package's own nested `node_modules`, AND of a `@scope` directory (whose
 * entries are the scoped packages, not a nested `node_modules`) — so a
 * `@scope` entry recurses straight into itself rather than into a
 * `@scope/node_modules` path that would never exist.
 */
function findInstalledCopies(dir: string, found: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry === '.bin') continue;
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (entry.startsWith('@')) {
      findInstalledCopies(fullPath, found);
      continue;
    }
    if (entry === 'proxy-addr') {
      found.push(join(fullPath, 'package.json'));
    }
    // Recurse into this package's own nested node_modules (if any) so a
    // deeply hoisted or duplicated copy can't hide from this check.
    findInstalledCopies(join(fullPath, 'node_modules'), found);
  }
  return found;
}

test('every installed proxy-addr copy is >=2.0.8 (GHSA-jqcg-44mw-7w3h fixed)', () => {
  const copies = findInstalledCopies(join(process.cwd(), 'node_modules'));
  assert.ok(copies.length > 0, 'expected at least one installed proxy-addr copy to check — test setup is stale');

  for (const pkgPath of copies) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const version = parseVersion(pkg.version);
    assert.ok(
      isAtLeast(version, MIN_SAFE_VERSION),
      `${pkgPath} is proxy-addr@${pkg.version}, vulnerable to GHSA-jqcg-44mw-7w3h ` +
        `(IPv4-mapped IPv6 trust-subnet spoofing) — expected >=2.0.8`,
    );
  }
});
