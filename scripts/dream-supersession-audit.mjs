#!/usr/bin/env node
/**
 * Live audit: scans every `origin/dream/*` branch's own commits (ahead of
 * `main`) for a self-admitted supersession claim ("supersedes ... #N",
 * "redoes ... #N") and reports which already-superseded draft PRs are
 * safe to close as pure backlog hygiene — closing, never merging.
 *
 * Git-only, no GitHub API token required: every git invocation below uses
 * `execFileSync` with a static argv (no shell, no string interpolation of
 * branch names into a command line), matching the security posture of the
 * two prior dream-cycle tools this one is modeled on
 * (reconcile-ledger.mjs, dream-branch-audit.mjs — both still unmerged).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseSupersessionClaims, summarizeSupersessionClaims } from '../dist/src/control-plane/dream-cycle/supersession-audit.js';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function listDreamBranches() {
  const raw = git(['branch', '-r', '--list', 'origin/dream/*']);
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^origin\//, ''));
}

function collectCommits(branch) {
  const format = '--commit--%n%H%n%s%n%n%b%n--end-commit--';
  let raw;
  try {
    raw = git(['log', `main..origin/${branch}`, `--format=${format}`]);
  } catch {
    return [];
  }
  const commits = [];
  for (const chunk of raw.split('--commit--').map((c) => c.trim()).filter(Boolean)) {
    const body = chunk.replace(/--end-commit--\s*$/, '').trim();
    const newlineIndex = body.indexOf('\n');
    if (newlineIndex === -1) continue;
    const sha = body.slice(0, newlineIndex).trim();
    const message = body.slice(newlineIndex + 1).trim();
    commits.push({ branch, sha, message });
  }
  return commits;
}

function main() {
  let branches;
  try {
    branches = listDreamBranches();
  } catch (err) {
    console.error(`git branch -r failed: ${err.message}`);
    process.exitCode = 0; // advisory tool: never block anything on git failing
    return;
  }

  const allCommits = branches.flatMap(collectCommits);
  const claims = parseSupersessionClaims(allCommits);
  const summary = summarizeSupersessionClaims(claims);

  const lines = [];
  lines.push('# Dream Cycle supersession audit');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Branches scanned: ${branches.length}`);
  lines.push(`Commits scanned: ${allCommits.length}`);
  lines.push(`Self-admitted supersession claims found: ${summary.totalClaims}`);
  lines.push(`Distinct superseded PR/issue numbers named: ${summary.distinctSupersededPrNumbers.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('| Claimant branch | Claimant SHA | Superseded # | Evidence |');
  lines.push('|---|---|---|---|');
  for (const claim of claims) {
    lines.push(
      `| ${claim.claimantBranch} | ${claim.claimantSha.slice(0, 12)} | #${claim.supersededPrNumber} | ${claim.evidence.replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');
  const report = lines.join('\n') + '\n';

  writeFileSync('docs/dream-cycle/SUPERSESSION-AUDIT.md', report);
  console.log(report);
}

main();
