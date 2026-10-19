#!/usr/bin/env node
/**
 * Drift guard for the exact version of @metaharness/darwin that
 * `npm run harness:bench-verify` (ADR-076's anti-gaming taskHash hard gate,
 * see .github/workflows/ci.yml) actually invokes.
 *
 * Full context: src/control-plane/dream-cycle/darwin-pin-check.ts's header,
 * and docs/dream-cycle/2026-10-19-developer-experience-report.md.
 *
 * Exit code: 0 on a pin match (or if @metaharness/darwin isn't installed at
 * all yet — nothing to check), 1 on a recorded mismatch or a missing pin
 * file. The "other resolved copies" section is always advisory-only and
 * never affects the exit code.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  checkPin,
  summarizeOtherCopies,
  formatReport,
} from '../dist/src/control-plane/dream-cycle/darwin-pin-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const PACKAGE = '@metaharness/darwin';
const PRIMARY_PKG_JSON = join(repoRoot, 'node_modules/@metaharness/darwin/package.json');
const PIN_FILE = join(repoRoot, '.harness/pinned-versions.json');

// Other live resolution paths for @metaharness/darwin, recorded from the
// real `npm ls @metaharness/darwin` output captured during the 2026-10-19
// Dream Cycle session (see the report above). Kept as a fixed, disclosed
// list rather than a recursive node_modules walk, so this stays a cheap,
// deterministic, near-zero-cost check with no surprise runtime cost or
// false positives from unrelated same-named directories.
const KNOWN_OTHER_PATHS = [
  'node_modules/agentdb/node_modules/@metaharness/darwin/package.json',
  'node_modules/agentdb/node_modules/ruvector/node_modules/metaharness/node_modules/@metaharness/darwin/package.json',
  'node_modules/@claude-flow/cli/node_modules/ruvector/node_modules/@metaharness/darwin/package.json',
  'node_modules/@claude-flow/cli/node_modules/ruvector/node_modules/metaharness/node_modules/@metaharness/darwin/package.json',
];

function readVersion(pkgJsonPath) {
  const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  return parsed.version;
}

function main() {
  if (!existsSync(PRIMARY_PKG_JSON)) {
    console.log(
      `SKIP: ${PACKAGE} is not installed at node_modules/@metaharness/darwin — nothing to check ` +
        `(this usually means \`npm install\` hasn't run yet).`,
    );
    process.exit(0);
  }

  if (!existsSync(PIN_FILE)) {
    console.error(`FAIL: pin file missing at ${PIN_FILE}.`);
    process.exit(1);
  }

  const actualVersion = readVersion(PRIMARY_PKG_JSON);
  const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'));

  const result = checkPin(pin.pinnedVersion, actualVersion, PACKAGE);

  const otherCopies = KNOWN_OTHER_PATHS.map((relPath) => join(repoRoot, relPath))
    .filter((absPath) => existsSync(absPath))
    .map((absPath) => ({
      path: absPath.slice(repoRoot.length + 1),
      version: readVersion(absPath),
    }));
  const otherLines = summarizeOtherCopies(actualVersion, otherCopies);

  console.log(formatReport(result, otherLines));

  process.exit(result.status === 'match' ? 0 : 1);
}

main();
