/**
 * Dream Cycle developer-experience tooling (2026-10-18 night, rotated from
 * performance — PRs #19/#53/#74 confirmed the tier-scan-concurrency finding
 * 3x unmerged, firing the ledger's own "repeated >=3 nights -> rotate
 * surface" learning signal).
 *
 * `supersession-audit.ts` (PR #72, still unmerged on `main`) only catches a
 * duplicate PR pair when the later PR's own commit text names the earlier
 * PR number. That misses independent, unaware rediscoveries. Confirmed
 * real case: PR #65 (2026-10-09) and PR #76 (2026-10-14) both replace the
 * exact same `.github/workflows/ci.yml` line
 * (`npm install --no-audit --no-fund || true`) with a fix for the same
 * failure-masking bug, five nights apart, with zero cross-reference in
 * either PR's text — so PR #72's textual detector would never find this
 * pair, and tonight's real live run (see the committed OVERLAP-AUDIT.md)
 * confirms it doesn't.
 *
 * This is a strictly weaker, noisier signal than textual self-admission
 * (two branches touching the same lines does not prove one supersedes the
 * other), so — unlike PR #72's supersession-audit — nothing found here is
 * ever auto-closed. It is surfaced only as a human-triage recommendation.
 */

export interface FileHunk {
  file: string;
  /** Post-image (new-file) line range, inclusive on both ends. */
  startLine: number;
  endLine: number;
}

export interface OverlapMatch {
  file: string;
  branchA: string;
  branchB: string;
  rangeA: [number, number];
  rangeB: [number, number];
}

/**
 * Files every dream-cycle night touches as a matter of routine bookkeeping
 * (an appended ledger row, a dated report/gist, a generated audit
 * snapshot) rather than as part of its actual candidate fix. Including
 * them would flood every branch pair with a "duplicate" on the ledger's
 * append point alone, which carries no signal about whether the real
 * candidates duplicate each other.
 */
const ROUTINE_PAPERWORK_PATTERNS: RegExp[] = [
  /^docs\/dream-cycle\/LEDGER\.md$/,
  /^docs\/dream-cycle\/\d{4}-\d{2}-\d{2}-.*\.md$/,
  /^docs\/dream-cycle\/BRANCH-AUDIT\.md$/,
  /^docs\/dream-cycle\/SUPERSESSION-AUDIT\.md$/,
  /^docs\/dream-cycle\/OVERLAP-AUDIT\.md$/,
  /^package-lock\.json$/,
];

export function isRoutinePaperworkFile(path: string): boolean {
  return ROUTINE_PAPERWORK_PATTERNS.some((re) => re.test(path));
}

/**
 * Parses a unified `git diff` into per-file post-image line ranges, one
 * range per hunk. Only the `@@ -a,b +c,d @@` header is needed — the hunk
 * body itself is irrelevant to an overlap check, so it is intentionally
 * not parsed line-by-line.
 */
export function parseUnifiedDiffHunks(diffText: string): FileHunk[] {
  const hunks: FileHunk[] = [];
  let currentFile: string | null = null;
  for (const line of diffText.split('\n')) {
    const fileHeader = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileHeader) {
      currentFile = fileHeader[1] ?? null;
      continue;
    }
    if (line.startsWith('diff --git')) {
      // A new file section is starting; the real path comes from the next
      // `+++ b/...` line (or `/dev/null` for a pure deletion, which has no
      // post-image lines to flag — left as null until the header arrives).
      currentFile = null;
      continue;
    }
    const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkHeader && currentFile) {
      const start = Number(hunkHeader[1]);
      const count = hunkHeader[2] !== undefined ? Number(hunkHeader[2]) : 1;
      if (count > 0) {
        hunks.push({ file: currentFile, startLine: start, endLine: start + count - 1 });
      }
    }
  }
  return hunks;
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/** Groups hunks by file, dropping routine-paperwork files up front. */
function groupByFile(hunks: FileHunk[]): Map<string, Array<[number, number]>> {
  const byFile = new Map<string, Array<[number, number]>>();
  for (const h of hunks) {
    if (isRoutinePaperworkFile(h.file)) continue;
    const ranges = byFile.get(h.file) ?? [];
    ranges.push([h.startLine, h.endLine]);
    byFile.set(h.file, ranges);
  }
  return byFile;
}

/**
 * For every pair of branches in `branchDiffs`, flags every (file,
 * overlapping-range) match. Symmetric and self-pair-free: branch order in
 * the input doesn't affect the output, and a branch is never compared to
 * itself.
 */
export function findOverlappingPairs(branchDiffs: ReadonlyMap<string, string>): OverlapMatch[] {
  const byBranchFile = new Map<string, Map<string, Array<[number, number]>>>();
  for (const [branch, diffText] of branchDiffs) {
    byBranchFile.set(branch, groupByFile(parseUnifiedDiffHunks(diffText)));
  }

  const branches = [...byBranchFile.keys()];
  const matches: OverlapMatch[] = [];
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const branchA = branches[i]!;
      const branchB = branches[j]!;
      const filesA = byBranchFile.get(branchA)!;
      const filesB = byBranchFile.get(branchB)!;
      for (const [file, rangesA] of filesA) {
        const rangesB = filesB.get(file);
        if (!rangesB) continue;
        for (const rangeA of rangesA) {
          for (const rangeB of rangesB) {
            if (rangesOverlap(rangeA, rangeB)) {
              matches.push({ file, branchA, branchB, rangeA, rangeB });
            }
          }
        }
      }
    }
  }
  return matches;
}

export function formatOverlapReport(matches: readonly OverlapMatch[]): string {
  if (matches.length === 0) {
    return 'No file/line-range overlaps found among the scanned branches.\n';
  }
  const lines = [
    `${matches.length} overlap${matches.length === 1 ? '' : 's'} found (human-triage recommendation, nothing auto-closed):`,
    '',
  ];
  for (const m of matches) {
    lines.push(
      `- ${m.file}: ${m.branchA} [${m.rangeA[0]}-${m.rangeA[1]}] overlaps ${m.branchB} [${m.rangeB[0]}-${m.rangeB[1]}]`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
