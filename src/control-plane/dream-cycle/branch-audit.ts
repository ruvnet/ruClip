/**
 * Audits `dream/*` branches (the Dream Cycle's per-night candidate
 * branches, per `docs/dream-cycle/PROMPT.md` STEP 20) for staleness.
 *
 * Finding (2026-09-29, developer-experience): 2026-09-19's own Dream Cycle
 * session (PR #35, itself still unmerged) diagnosed that the routine's
 * "never self-merge" invariant plus its own append-only ledger design
 * means `dream/*` branches accumulate unmerged, and measured 9 of them
 * (2026-09-07..2026-09-18). That session shipped a ledger-reconciliation
 * tool but explicitly *deferred* a distinct, smaller finding as its own
 * "Next Step #2": the backlog itself is only discoverable by manually
 * cross-referencing GitHub issues/PRs, with no visibility in CI. Measured
 * again tonight (2026-09-29): 18 `dream/*` branches on `origin`, spanning
 * 2026-09-02..2026-09-28 — the backlog has roughly doubled in 10 days.
 *
 * This module is a pure, read-only classifier: given each branch's name
 * and last-commit timestamp, it reports which are older than a staleness
 * threshold. It does not read or write `LEDGER.md`, does not touch PR or
 * merge state, and performs no git/network I/O itself (that lives in
 * `scripts/dream-branch-audit.mjs`, the only piece that shells out).
 */

export interface BranchInfo {
  /** Branch name, e.g. `dream/2026-09-07-architecture` (prefix not enforced by this module). */
  name: string;
  /** The branch's last commit date, as an ISO-8601 string (from `git for-each-ref`'s `%(committerdate:iso8601)`). */
  lastCommitIso: string;
}

export interface StaleBranch extends BranchInfo {
  /** Whole days between `lastCommitIso` and the audit's reference time. */
  ageDays: number;
}

export interface BranchAuditResult {
  totalBranches: number;
  /** Branches at or beyond `thresholdDays`, oldest first. */
  staleBranches: StaleBranch[];
  thresholdDays: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Classifies `branches` by age relative to `now`. A branch is stale once
 * its age in whole days is `>= thresholdDays`. Pure function: no I/O, no
 * mutation of its inputs, deterministic for a given `now`.
 */
export function auditBranches(
  branches: readonly BranchInfo[],
  now: Date,
  thresholdDays = 3,
): BranchAuditResult {
  const nowMs = now.getTime();
  const staleBranches: StaleBranch[] = [];

  for (const branch of branches) {
    const commitMs = new Date(branch.lastCommitIso).getTime();
    const ageDays = Math.floor((nowMs - commitMs) / MS_PER_DAY);
    if (ageDays >= thresholdDays) {
      staleBranches.push({ ...branch, ageDays });
    }
  }

  staleBranches.sort((a, b) => b.ageDays - a.ageDays);

  return {
    totalBranches: branches.length,
    staleBranches,
    thresholdDays,
  };
}

/** Renders a human-readable report; used by both the CLI wrapper and tests that check output shape. */
export function formatAuditReport(result: BranchAuditResult): string {
  const { totalBranches, staleBranches, thresholdDays } = result;
  if (totalBranches === 0) {
    return 'No dream/* branches found on origin.';
  }
  const lines = [
    `Scanned ${totalBranches} dream/* branch(es); ${staleBranches.length} stale (>= ${thresholdDays}d old).`,
  ];
  for (const branch of staleBranches) {
    lines.push(`  - ${branch.name}: ${branch.ageDays}d old (last commit ${branch.lastCommitIso})`);
  }
  return lines.join('\n');
}
