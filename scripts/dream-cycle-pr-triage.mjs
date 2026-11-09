#!/usr/bin/env node
/**
 * Live triage report for the open `dream/*` Dream Cycle backlog: classifies
 * every remote `dream/*` branch's diff against `main` with
 * `classifyBranchDiff` (dist/src/control-plane/tooling/dream-cycle-pr-triage.js)
 * and prints a per-branch tier plus a totals table.
 *
 * Read-only: only `git fetch --prune` + `git diff --name-only` plumbing, no
 * branch/ledger mutation, no network calls beyond the local remote the repo
 * is already configured with.
 *
 * Usage: node scripts/dream-cycle-pr-triage.mjs [--base origin/main]
 */
import { execFileSync } from 'node:child_process';
import { classifyBranchDiff, summarizeTriage } from '../dist/src/control-plane/tooling/dream-cycle-pr-triage.js';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const baseArgIndex = process.argv.indexOf('--base');
const base = baseArgIndex !== -1 ? process.argv[baseArgIndex + 1] : 'origin/main';

try {
  git(['fetch', '--prune', 'origin']);
} catch {
  // Offline/sandboxed environments: fall back to whatever refs are already
  // present locally rather than failing the whole report.
}

const remoteBranches = git(['branch', '-r', '--format=%(refname:short)'])
  .split('\n')
  .map((b) => b.trim())
  .filter((b) => b.startsWith('origin/dream/'));

const rows = [];
for (const branch of remoteBranches) {
  let changedFiles;
  try {
    changedFiles = git(['diff', '--name-only', `${base}...${branch}`])
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    rows.push({ branch, tier: 'needs-review', reason: 'diff against base failed (likely diverged/conflicted)' });
    continue;
  }
  const { tier, reason } = classifyBranchDiff(changedFiles);
  rows.push({ branch, tier, reason, fileCount: changedFiles.length });
}

for (const row of rows.sort((a, b) => a.branch.localeCompare(b.branch))) {
  console.log(`${row.tier.padEnd(13)} ${row.branch}  (${row.fileCount ?? 0} files)  ${row.reason}`);
}

const summary = summarizeTriage(rows.map((r) => r.tier));
console.log('---');
console.log(
  `docs-only=${summary.docsOnly} mechanical=${summary.mechanical} needs-review=${summary.needsReview} total=${summary.total}`,
);
