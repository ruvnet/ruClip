#!/usr/bin/env node
/**
 * CLI wrapper around `auditBranches` (`dist/src/control-plane/dream-cycle/branch-audit.js`):
 * fetches `origin`'s `dream/*` refs, classifies them by age, and prints a
 * report. Advisory only — always exits 0, never blocks CI, never mutates
 * any branch/PR/ledger state. See `src/control-plane/dream-cycle/branch-audit.ts`
 * for the finding this responds to (2026-09-29, developer-experience).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { auditBranches, formatAuditReport } from '../dist/src/control-plane/dream-cycle/branch-audit.js';

const THRESHOLD_DAYS = 3;
const REF_GLOB = 'refs/remotes/origin/dream/*';

function tryFetchDreamRefs() {
  try {
    execFileSync('git', ['fetch', 'origin', '+refs/heads/dream/*:refs/remotes/origin/dream/*'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch (err) {
    console.warn(`dream-branch-audit: git fetch failed, using local refs only (${err.message})`);
  }
}

function listBranches() {
  let output;
  try {
    output = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname:short)|%(committerdate:iso8601)', REF_GLOB],
      { encoding: 'utf8' },
    );
  } catch (err) {
    console.warn(`dream-branch-audit: git for-each-ref failed (${err.message})`);
    return [];
  }
  const branches = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [ref, iso] = line.split('|');
    if (!ref || !iso) continue;
    const name = ref.replace(/^origin\//, '');
    const parsed = new Date(iso.trim());
    if (Number.isNaN(parsed.getTime())) {
      console.warn(`dream-branch-audit: skipping ${name}, unparseable committerdate "${iso.trim()}"`);
      continue;
    }
    branches.push({ name, lastCommitIso: parsed.toISOString() });
  }
  return branches;
}

function main() {
  tryFetchDreamRefs();
  const branches = listBranches();
  const result = auditBranches(branches, new Date(), THRESHOLD_DAYS);
  const report = formatAuditReport(result);
  console.log(report);

  const outPath = 'docs/dream-cycle/BRANCH-AUDIT.md';
  const snapshot = [
    '# Dream Cycle branch backlog audit',
    '',
    `Regenerable point-in-time snapshot from \`npm run dream:branch-audit\`, generated ${new Date().toISOString()}.`,
    'Not a source of truth — re-run for current state. Advisory only.',
    '',
    '```text',
    report,
    '```',
    '',
  ].join('\n');
  try {
    writeFileSync(outPath, snapshot);
  } catch (err) {
    console.warn(`dream-branch-audit: could not write ${outPath} (${err.message})`);
  }

  process.exitCode = 0;
}

main();
