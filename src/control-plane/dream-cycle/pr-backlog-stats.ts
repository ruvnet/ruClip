/**
 * Pure, dependency-free summary of the Dream Machine's own `dream/*` PR
 * backlog on `ruvnet/ruClip`. Deliberately takes already-fetched GitHub
 * state as plain data (never calls the network itself) so it stays
 * unit-testable without credentials and reusable from a one-off report
 * script, a future CI gate, or a future nightly session — see
 * `scripts/dream-cycle-ledger-report.mjs` for the real-data entry point.
 */

export interface DreamCyclePr {
  readonly number: number;
  /** Full head branch ref, e.g. "dream/2026-10-21-security". */
  readonly headRef: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly createdAt: string;
}

export interface SurfaceTally {
  readonly total: number;
  readonly merged: number;
}

export interface DreamCycleBacklogSummary {
  readonly total: number;
  readonly merged: number;
  readonly closedUnmerged: number;
  readonly openUnmerged: number;
  readonly mergeRatePct: number;
  readonly bySurface: Readonly<Record<string, SurfaceTally>>;
  /** ISO createdAt of the most recently *merged* PR, or null if none merged. */
  readonly lastMergedCreatedAt: string | null;
  /** Count of dream-cycle PRs created strictly after the last merge. */
  readonly unmergedStreak: number;
}

const DREAM_HEAD_REF_PATTERN = /^dream\/\d{4}-\d{2}-\d{2}-([a-z-]+)$/;

/**
 * Extracts the rotation surface (e.g. "architecture", "developer-experience")
 * from a `dream/<date>-<surface>` branch ref. Returns null for any ref that
 * doesn't match the convention fixed by PROMPT.md's STEP 20 branch-naming
 * rule, rather than guessing.
 */
export function parseSurfaceFromHeadRef(headRef: string): string | null {
  const match = DREAM_HEAD_REF_PATTERN.exec(headRef);
  return match ? match[1] ?? null : null;
}

/**
 * Summarizes a list of dream-cycle PRs. Throws on a PR whose headRef isn't a
 * `dream/*` branch — callers must pre-filter to the PRs they actually mean
 * to analyze, so a filtering mistake fails loudly instead of silently
 * skewing the merge rate.
 */
export function summarizeDreamCyclePrs(prs: readonly DreamCyclePr[]): DreamCycleBacklogSummary {
  const bySurface: Record<string, { total: number; merged: number }> = {};
  let merged = 0;
  let closedUnmerged = 0;
  let openUnmerged = 0;
  let lastMergedCreatedAt: string | null = null;

  const sorted = [...prs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const pr of sorted) {
    const surface = parseSurfaceFromHeadRef(pr.headRef);
    if (surface === null) {
      throw new Error(
        `summarizeDreamCyclePrs: PR #${pr.number} headRef "${pr.headRef}" is not a dream/<date>-<surface> branch`,
      );
    }
    const tally = (bySurface[surface] ??= { total: 0, merged: 0 });
    tally.total += 1;

    if (pr.merged) {
      merged += 1;
      tally.merged += 1;
      if (lastMergedCreatedAt === null || pr.createdAt > lastMergedCreatedAt) {
        lastMergedCreatedAt = pr.createdAt;
      }
    } else if (pr.state === 'closed') {
      closedUnmerged += 1;
    } else {
      openUnmerged += 1;
    }
  }

  const unmergedStreak =
    lastMergedCreatedAt === null
      ? sorted.length
      : sorted.filter((pr) => pr.createdAt > (lastMergedCreatedAt as string)).length;

  return {
    total: sorted.length,
    merged,
    closedUnmerged,
    openUnmerged,
    mergeRatePct: sorted.length === 0 ? 0 : Math.round((merged / sorted.length) * 1000) / 10,
    bySurface,
    lastMergedCreatedAt,
    unmergedStreak,
  };
}
