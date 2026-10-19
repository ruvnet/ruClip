/**
 * Pure logic for the `@metaharness/darwin` version-pin drift guard.
 *
 * Context (Dream Cycle 2026-10-19, developer-experience; full writeup in
 * docs/dream-cycle/2026-10-19-developer-experience-report.md):
 *
 * `npm run harness:bench-verify` (`.github/workflows/ci.yml`'s hard gate,
 * comment: "catches .harness/bench.json tampering per ADR-076's anti-gaming
 * intent") invokes whatever `@metaharness/darwin` copy npm's resolver hoists
 * to `node_modules/.bin/metaharness-darwin`. This repo declares
 * `metaharness`/`ruvector`/`ruflo`/`agentbbs`/`radio-moe` as entirely
 * unconstrained (`"*"`) peerDependencies in `package.json`. A real
 * `npm install` against this exact repo (2026-10-19) resolved THREE
 * simultaneously-live copies of `@metaharness/darwin` in `node_modules`
 * (0.9.3 top-level/hoisted, 0.8.0 and 0.2.8 nested via `ruflo`'s own
 * transitive chain). Running each copy's own `bench verify` CLI directly
 * against this repo's committed `.harness/bench.json` confirmed all three
 * currently agree on the taskHash — no live inconsistency today — but
 * nothing pins which copy npm hoists to `.bin` on a future install,
 * anywhere in the tree, not even inside ruClip's own `package.json`. This
 * module (and its CLI wrapper, `scripts/check-darwin-pin.mjs`) makes that
 * drift loud (a recorded pin + an explicit mismatch report) instead of
 * silent.
 *
 * Deliberately pure: no filesystem or process I/O here, so this is testable
 * without touching a real `node_modules` tree. The CLI wrapper does the I/O
 * and calls into this module.
 */

export interface PinCheckResult {
  readonly package: string;
  readonly pinnedVersion: string;
  readonly actualVersion: string;
  readonly status: 'match' | 'mismatch';
}

/** Compares the recorded pin against the version actually resolved today. */
export function checkPin(pinnedVersion: string, actualVersion: string, pkg: string): PinCheckResult {
  return {
    package: pkg,
    pinnedVersion,
    actualVersion,
    status: pinnedVersion === actualVersion ? 'match' : 'mismatch',
  };
}

export interface ResolvedCopy {
  /** Path relative to the repo root, for a stable, reviewable report. */
  readonly path: string;
  readonly version: string;
}

/**
 * Advisory-only: describes other resolved copies of the package elsewhere
 * in the tree that diverge from the active (hoisted) version. Never causes
 * a failing status by itself — only the primary `checkPin` result does —
 * because npm always hoists a single deterministic copy to `.bin`; these
 * other copies aren't invoked by the CI gate today, only disclosed as a
 * standing risk.
 */
export function summarizeOtherCopies(activeVersion: string, otherCopies: readonly ResolvedCopy[]): string[] {
  return otherCopies
    .filter((copy) => copy.version !== activeVersion)
    .map((copy) => `  - ${copy.path}: ${copy.version} (diverges from active ${activeVersion})`);
}

/** Formats the full human-readable report printed by the CLI wrapper. */
export function formatReport(result: PinCheckResult, otherCopyLines: readonly string[]): string {
  const lines: string[] = [];

  if (result.status === 'match') {
    lines.push(
      `OK: ${result.package} resolves to the pinned version ${result.actualVersion} ` +
        `(the exact copy \`npm run harness:bench-verify\` invokes via node_modules/.bin).`,
    );
  } else {
    lines.push(
      `MISMATCH: ${result.package} now resolves to ${result.actualVersion}, but ` +
        `.harness/pinned-versions.json records ${result.pinnedVersion} as the last version whose ` +
        `ADR-076 anti-gaming taskHash algorithm was verified against this repo's .harness/bench.json. ` +
        `Re-verify "npm run harness:bench-verify" still enforces the expected hash semantics against ` +
        `the new version (run each candidate's own \`bench verify\` CLI directly, the way this repo's ` +
        `2026-10-19 Dream Cycle report did), then update .harness/pinned-versions.json's "pinnedVersion" ` +
        `field to match.`,
    );
  }

  if (otherCopyLines.length > 0) {
    lines.push('');
    lines.push(
      `ADVISORY (non-blocking): ${otherCopyLines.length} other resolved cop${
        otherCopyLines.length === 1 ? 'y' : 'ies'
      } of ${result.package} exist elsewhere in node_modules at a different version. Not invoked by ` +
        `the CI hard gate today — npm hoists only one copy to node_modules/.bin — but a future ` +
        `dependency bump anywhere in the tree could silently change which copy hoists next:`,
    );
    lines.push(...otherCopyLines);
  }

  return lines.join('\n');
}
