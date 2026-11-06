#!/usr/bin/env node
/**
 * Dream Cycle 2026-11-06 (security deep dive + dependencies,secrets scan).
 *
 * `services/ruclip-attester/src/google-token.ts` (the sole cryptographic
 * trust boundary for `/v1/attest` — see that file's own header) imports
 * `OAuth2Client` from `google-auth-library` and calls exactly two of its
 * methods: `getIapPublicKeysAsync()` and `verifySignedJwtWithCertsAsync()`.
 * That file's header explicitly grounds its correctness claims in having
 * "read the actual installed v10.9.1 source" — not assumed from docs.
 *
 * Tonight's `npm ls google-auth-library --all` shows this repo's real
 * production dependency closure resolves **two** copies of that same
 * package at two different declared versions: a top-level copy (the one
 * Node's module resolution actually hands to `google-token.ts`, since
 * `services/ruclip-attester` has no closer nested copy of its own) and a
 * second copy nested under `@google-cloud/secret-manager` -> `google-gax`.
 * `npm audit` never flags this — it is not a CVE, it is ordinary
 * `peerDependencies`/version-range divergence — so no prior dream-cycle
 * night's audit-reachability work (#113) or manual CVE triage (#29, #51,
 * #100) would ever have surfaced it.
 *
 * Verified tonight by reading the real installed files (same discipline as
 * `google-token.ts` itself): `diff -rq` over both copies' `build/`
 * directories is empty — today the two versions are byte-identical on the
 * IAP-verification surface this repo actually exercises. But nothing
 * currently re-checks that after a future `npm ci`/`npm update` — a
 * `google-gax` bump could pull a newer `google-auth-library` into the
 * nested copy while the top-level direct dependency stays pinned, silently
 * invalidating `google-token.ts`'s "confirmed by reading the installed
 * source" claim with no CVE, no audit flag, and no other guard to catch it.
 *
 * This is a read-only, dependency-free (`node:` builtins only) drift guard:
 * it finds every installed copy of a named package under `node_modules`
 * (handling `@scope` directories, same walk shape as the existing
 * `proxy-addr` supply-chain regression test), hashes one real,
 * security-relevant file from each copy, and fails loudly the moment two
 * copies diverge — the only correct response is "go re-verify
 * `google-token.ts`'s source-reading claim against the new version", never
 * a silent pass.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The one file `google-token.ts`'s IAP trust boundary actually depends on. */
export const DEFAULT_WATCHED_FILE = 'build/src/auth/oauth2client.js';

/**
 * Finds every installed copy of `packageName` under `dir`, at any nesting
 * depth, returning each copy's package directory (not `package.json`
 * itself). `dir` is "a directory whose entries are package directories" —
 * true of `node_modules` itself, of any package's own nested
 * `node_modules`, AND of a `@scope` directory (whose entries are the scoped
 * packages, not a nested `node_modules`) — so a `@scope` entry recurses
 * straight into itself rather than into a `@scope/node_modules` path that
 * would never exist.
 */
export function findInstalledCopies(dir: string, packageName: string, found: string[] = []): string[] {
  let entries: string[];
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
      findInstalledCopies(fullPath, packageName, found);
      continue;
    }
    if (entry === packageName) {
      found.push(fullPath);
    }
    findInstalledCopies(join(fullPath, 'node_modules'), packageName, found);
  }
  return found;
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface CopyHash {
  packageDir: string;
  version: string | undefined;
  hash: string | undefined;
  /** Set when the watched file does not exist at this copy (e.g. a major rewrite moved/renamed it). */
  missing: boolean;
}

export interface DriftResult {
  watchedFile: string;
  copies: CopyHash[];
  /** True iff 0 or 1 copies were found (nothing to compare), or every found copy hashes identically. */
  consistent: boolean;
}

/** Pure: given already-resolved package directories, compares `watchedFile` across all of them. */
export function compareCopies(packageDirs: string[], watchedFile: string): DriftResult {
  const copies: CopyHash[] = packageDirs.map((packageDir) => {
    let version: string | undefined;
    try {
      version = (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: string }).version;
    } catch {
      version = undefined;
    }
    const filePath = join(packageDir, watchedFile);
    try {
      return { packageDir, version, hash: hashFile(filePath), missing: false };
    } catch {
      return { packageDir, version, hash: undefined, missing: true };
    }
  });

  const hashes = new Set(copies.map((c) => c.hash).filter((h): h is string => h !== undefined));
  const anyMissing = copies.some((c) => c.missing);
  const consistent = !anyMissing && hashes.size <= 1;
  return { watchedFile, copies, consistent };
}

function formatReport(result: DriftResult, cwd: string): string {
  const lines: string[] = [];
  lines.push(`Watched file: ${result.watchedFile}`);
  lines.push(`Installed copies found: ${result.copies.length}`);
  for (const copy of result.copies) {
    const rel = relative(cwd, copy.packageDir);
    if (copy.missing) {
      lines.push(`  [MISSING] ${rel}@${copy.version ?? 'unknown'} — watched file not found at this copy`);
    } else {
      lines.push(`  ${rel}@${copy.version ?? 'unknown'}  sha256:${copy.hash}`);
    }
  }
  lines.push(
    result.consistent
      ? 'OK: every installed copy of this dependency agrees on the watched security-relevant file.'
      : 'DRIFT DETECTED: installed copies of this dependency disagree on the watched security-relevant file — ' +
          're-verify google-token.ts\'s "confirmed by reading the installed source" claim against the new version(s) before trusting it.',
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const packageName = 'google-auth-library';
  const copies = findInstalledCopies(join(cwd, 'node_modules'), packageName);
  const result = compareCopies(copies, DEFAULT_WATCHED_FILE);
  console.log(formatReport(result, cwd));
  if (!result.consistent) {
    process.exitCode = 1;
  }
}

// Only run when invoked directly (not when imported for tests).
if (process.argv[1] && process.argv[1].endsWith('dual-version-drift-guard.js')) {
  void main();
}
