/**
 * Pure file-contention analysis for the nightly Dream Machine cycle.
 *
 * Measured on 2026-11-04: of 53 open `dream/*` branches, 24 independently
 * touch `src/control-plane/store/agentdb-adapter.ts` — each night picks a
 * candidate against `main` alone, blind to every other still-open branch
 * editing the same file. Per-branch merge checks against `main` stay clean
 * (git has nothing to compare against), so that staleness is invisible
 * until a human tries to reconcile all of them by hand. This module gives a
 * nightly run (or a human reviewer) a way to see that overlap up front,
 * without calling GitHub or an LLM.
 */

export interface ContentionEntry {
  file: string;
  branches: string[];
}

export interface ContentionOptions {
  /** Files matching any of these patterns are excluded (e.g. the ledger, which every branch touches by design). */
  ignore?: RegExp[];
}

export function computeFileContention(
  branchFiles: Readonly<Record<string, readonly string[]>>,
  opts: ContentionOptions = {},
): ContentionEntry[] {
  const ignore = opts.ignore ?? [];
  const fileToBranches = new Map<string, Set<string>>();

  for (const [branch, files] of Object.entries(branchFiles)) {
    for (const file of files) {
      if (ignore.some((pattern) => pattern.test(file))) continue;
      let branches = fileToBranches.get(file);
      if (!branches) {
        branches = new Set();
        fileToBranches.set(file, branches);
      }
      branches.add(branch);
    }
  }

  const entries: ContentionEntry[] = [];
  for (const [file, branches] of fileToBranches) {
    if (branches.size > 1) {
      entries.push({ file, branches: [...branches].sort() });
    }
  }

  entries.sort((a, b) => b.branches.length - a.branches.length || a.file.localeCompare(b.file));
  return entries;
}

/** Contention entries that involve `branch` and have reached `threshold` or more concurrent editors. */
export function contentionWarningsForBranch(
  entries: readonly ContentionEntry[],
  branch: string,
  threshold: number,
): ContentionEntry[] {
  return entries.filter((entry) => entry.branches.includes(branch) && entry.branches.length >= threshold);
}
