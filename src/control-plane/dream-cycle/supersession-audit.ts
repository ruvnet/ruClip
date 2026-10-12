/**
 * Pure parsing/aggregation for the Dream Cycle's candidate-promotion
 * backlog. ruClip's nightly dream-cycle opens a fresh draft PR against
 * `main` every run and never merges one (standing invariant); nothing in
 * the routine ever shrinks that backlog back down. Twice already
 * (2026-10-02's PR #53, 2026-10-07's PR #61) a session has independently
 * reimplemented an older, now-stale draft PR (#19, #9) from scratch and
 * said so in its own commit message — a self-admitted duplicate the
 * backlog is carrying for no reason. This module finds those admissions
 * mechanically instead of relying on a future session rediscovering them
 * by hand.
 */

export interface BranchCommit {
  readonly branch: string;
  readonly sha: string;
  readonly message: string;
}

export interface SupersessionClaim {
  readonly claimantBranch: string;
  readonly claimantSha: string;
  readonly supersededPrNumber: number;
  readonly evidence: string;
}

export interface SupersessionSummary {
  readonly totalClaims: number;
  readonly distinctSupersededPrNumbers: readonly number[];
}

// Deliberately narrow: only commit messages that explicitly name the PR
// they replace, in the author's own words ("supersedes ... #19", "redoes
// ... #9"). This is a text-admission detector, not a code-similarity
// heuristic — it never guesses that two PRs are related from touching the
// same files, since two independent-but-overlapping candidates are a real,
// non-superseded case this routine has also produced.
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bsupersed\w*\b[^\n#]{0,120}#(\d+)/i,
  /\bredo\w*\b[^\n#]{0,120}#(\d+)/i,
];

/**
 * Scans each commit's message once; the first pattern that matches wins
 * (a commit naming the same PR number via both phrasings would otherwise
 * be double-counted as two claims instead of one).
 */
export function parseSupersessionClaims(commits: readonly BranchCommit[]): SupersessionClaim[] {
  const claims: SupersessionClaim[] = [];
  for (const commit of commits) {
    for (const pattern of CLAIM_PATTERNS) {
      const match = pattern.exec(commit.message);
      if (match) {
        claims.push({
          claimantBranch: commit.branch,
          claimantSha: commit.sha,
          supersededPrNumber: Number(match[1]),
          evidence: match[0].trim(),
        });
        break;
      }
    }
  }
  return claims;
}

export function summarizeSupersessionClaims(claims: readonly SupersessionClaim[]): SupersessionSummary {
  const distinct = Array.from(new Set(claims.map((claim) => claim.supersededPrNumber))).sort(
    (a, b) => a - b,
  );
  return { totalClaims: claims.length, distinctSupersededPrNumbers: distinct };
}
