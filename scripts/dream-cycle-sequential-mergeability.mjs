#!/usr/bin/env node
/**
 * Dream Cycle 2026-11-12 (architecture): CLI wrapper over local git plumbing
 * for src/control-plane/tooling/dream-cycle-sequential-mergeability.ts.
 *
 * Usage:
 *   node scripts/dream-cycle-sequential-mergeability.mjs [--base <ref>] [--remote <name>]
 *
 * Lists every `<remote>/dream/<date>-<surface>` branch, orders them
 * oldest-first, and simulates merging them one at a time onto a running
 * integration tip using `git merge-tree --write-tree` (no checkout and no
 * working-tree/index mutation, no push, no existing ref touched). Because
 * `merge-tree --write-tree` needs a commit-ish on each side (it computes a
 * merge-base), the tree it writes after a clean step is wrapped in a
 * synthetic merge commit via `git commit-tree` so the *next* step has a
 * commit-ish integration tip to diff against. That synthetic commit is a
 * loose object local to this checkout only — never pushed, never attached
 * to any branch or tag, safe to garbage-collect. Exit code 0 means every
 * branch merged cleanly in sequence; exit code 1 means at least one
 * conflicted.
 */
import { execFileSync } from 'node:child_process';
import { orderDreamBranchesByDate, simulateSequentialMerge } from '../dist/src/control-plane/tooling/dream-cycle-sequential-mergeability.js';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  let base = 'main';
  let remote = 'origin';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--remote') remote = argv[++i];
  }
  return { base, remote };
}

function listRemoteBranches(remote) {
  const prefix = `refs/remotes/${remote}/`;
  const out = git(['for-each-ref', '--format=%(refname)', prefix]);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.slice(prefix.length));
}

function attemptMerge(integrationTip, branch, remote) {
  const branchRef = `${remote}/${branch.name}`;
  let treeSha;
  try {
    treeSha = execFileSync(
      'git',
      ['merge-tree', '--write-tree', integrationTip, branchRef],
      { encoding: 'utf8' },
    ).trim().split('\n')[0];
  } catch {
    return null;
  }
  // Wrap the resulting tree in a synthetic merge commit (local object only,
  // no ref created) so the next merge-tree call has a commit-ish to diff.
  const branchSha = git(['rev-parse', branchRef]);
  return execFileSync(
    'git',
    [
      'commit-tree',
      treeSha,
      '-p',
      integrationTip,
      '-p',
      branchSha,
      '-m',
      `dream-cycle-sequential-mergeability: synthetic merge of ${branch.name}`,
    ],
    { encoding: 'utf8' },
  ).trim();
}

function main() {
  const { base, remote } = parseArgs(process.argv.slice(2));
  const baseTip = git(['rev-parse', base]);
  const allBranches = listRemoteBranches(remote);
  const dreamBranches = orderDreamBranchesByDate(allBranches);

  const { outcomes, summary } = simulateSequentialMerge(
    dreamBranches,
    (tip, branch) => attemptMerge(tip, branch, remote),
    baseTip,
  );

  for (const outcome of outcomes) {
    const marker = outcome.status === 'merged' ? 'MERGED  ' : 'CONFLICT';
    console.log(`${marker}  ${outcome.branch.name}`);
  }
  console.log('');
  console.log(`base: ${base}@${baseTip}`);
  console.log(`total dream/* branches: ${summary.totalBranches}`);
  console.log(`merged in sequence: ${summary.mergedCount}`);
  console.log(`conflicted in sequence: ${summary.conflictCount}`);
  console.log(`longest clean prefix (oldest-first, unbroken): ${summary.longestCleanPrefix}`);
  console.log(`first conflict: ${summary.firstConflictBranch ?? 'none'}`);
  if (summary.conflictBranches.length > 0) {
    console.log(`all conflicting branches: ${summary.conflictBranches.join(', ')}`);
  }

  process.exitCode = summary.conflictCount > 0 ? 1 : 0;
}

main();
