/**
 * Dream Cycle 2026-11-12 (architecture): PR #119 (2026-11-04) measured every
 * open `dream/*` branch against bare `main` independently and found 51/53
 * pairwise-clean. That check cannot see conflicts caused by *other* branches
 * in the same backlog — relevant here because #119 itself found 24/53
 * branches already touching one file (`agentdb-adapter.ts`). This module
 * classifies the backlog as a chronological sequence instead: starting from
 * `main`, each branch is merge-tried against the running integration tip
 * left behind by every earlier branch that applied cleanly. That is the
 * metric a human actually needs before merging several PRs in one sitting —
 * "how many of these can go in together, in order" — not the weaker
 * per-branch-vs-main guarantee #119 already established.
 *
 * Pure here: no git I/O. The CLI wrapper (dream-cycle-sequential-mergeability.mjs)
 * supplies `tryMerge` (a `git merge-tree --write-tree` call) and the real
 * branch ref list; this module only orders branches and folds the per-step
 * outcomes into a summary.
 */

const DREAM_BRANCH_PATTERN = /^dream\/(\d{4}-\d{2}-\d{2})-(.+)$/;

export interface ParsedDreamBranch {
  readonly name: string;
  readonly date: string;
  readonly surface: string;
}

export interface MergeStepOutcome {
  readonly branch: ParsedDreamBranch;
  readonly status: 'merged' | 'conflict';
  /** Resulting integration-tip commit-ish, present only when status is 'merged'. */
  readonly tipSha?: string;
}

export interface SequentialMergeabilitySummary {
  readonly totalBranches: number;
  readonly mergedCount: number;
  readonly conflictCount: number;
  /** Longest unbroken merged-in-order prefix starting at the oldest branch. */
  readonly longestCleanPrefix: number;
  readonly firstConflictBranch: string | null;
  readonly conflictBranches: readonly string[];
}

/**
 * Parses `dream/<YYYY-MM-DD>-<surface>` branch names and returns only the
 * ones that match, sorted oldest-first by date (ties broken by name).
 * Non-dream-cycle branches (e.g. `chore/*`, `feat/*`) are silently excluded —
 * this tool is scoped to the dream-cycle backlog only.
 */
export function orderDreamBranchesByDate(branchNames: readonly string[]): ParsedDreamBranch[] {
  const parsed: ParsedDreamBranch[] = [];
  for (const name of branchNames) {
    const match = DREAM_BRANCH_PATTERN.exec(name);
    if (!match) continue;
    const date = match[1];
    const surface = match[2];
    if (date === undefined || surface === undefined) continue;
    parsed.push({ name, date, surface });
  }
  return parsed.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date.localeCompare(b.date)));
}

/**
 * Folds an ordered sequence of per-branch merge attempts into a summary.
 * `attemptMerge(integrationTip, branch)` is caller-supplied so this stays
 * pure and unit-testable: it returns the new tip tree SHA on a clean merge,
 * or `null` on conflict. A conflicting branch is skipped (does not advance
 * the integration tip) but later branches are still attempted against the
 * tip left by the last branch that *did* merge cleanly — one bad branch
 * should not hide the mergeability of everything after it.
 */
export function simulateSequentialMerge(
  branches: readonly ParsedDreamBranch[],
  attemptMerge: (integrationTip: string, branch: ParsedDreamBranch) => string | null,
  baseTip: string,
): { outcomes: MergeStepOutcome[]; summary: SequentialMergeabilitySummary } {
  const outcomes: MergeStepOutcome[] = [];
  let tip = baseTip;
  let longestCleanPrefix = 0;
  let stillInPrefix = true;

  for (const branch of branches) {
    const result = attemptMerge(tip, branch);
    if (result === null) {
      outcomes.push({ branch, status: 'conflict' });
      stillInPrefix = false;
      continue;
    }
    tip = result;
    outcomes.push({ branch, status: 'merged', tipSha: result });
    if (stillInPrefix) longestCleanPrefix += 1;
  }

  const conflictBranches = outcomes.filter((o) => o.status === 'conflict').map((o) => o.branch.name);
  const summary: SequentialMergeabilitySummary = {
    totalBranches: branches.length,
    mergedCount: outcomes.filter((o) => o.status === 'merged').length,
    conflictCount: conflictBranches.length,
    longestCleanPrefix,
    firstConflictBranch: conflictBranches[0] ?? null,
    conflictBranches,
  };
  return { outcomes, summary };
}
