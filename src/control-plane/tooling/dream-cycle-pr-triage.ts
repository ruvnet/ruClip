/**
 * Pure classifier for triaging an open `dream/*` Dream Cycle branch by how
 * much human-review risk its diff against `main` actually carries.
 *
 * Context (2026-11-09 dev-experience/ci,tooling finding): as of tonight the
 * `dream/*` backlog has 0 merged PRs since 2026-09-06 across 50+ nightly
 * runs (already measured, separately, by this repo's own 2026-10-21,
 * 2026-11-03 and 2026-11-08 dream-cycle nights). A `main`-only mergeability
 * check (clean/dirty) tells a reviewer nothing about *how much* of a given
 * branch needs real attention versus being pure, zero-risk research record.
 * This module answers that question from a changed-file list alone: no
 * network, no model call, no mutation of any branch or ledger history.
 */

export type PrRiskTier = 'docs-only' | 'mechanical' | 'needs-review';

export interface PrTriageResult {
  tier: PrRiskTier;
  reason: string;
}

const DOCS_ONLY_PREFIXES = ['docs/'];
const PRODUCTION_PREFIXES = ['src/', 'services/'];

/**
 * Classifies a single branch's changed-file list (paths relative to the
 * repo root, as `git diff --name-only` reports them) into a risk tier:
 *
 * - `docs-only`: every changed file is under `docs/` (ledger rows, dream
 *   SOTA reports, ADRs). Carries zero production or test risk — safe to
 *   fast-track without a code review pass.
 * - `mechanical`: changes production and/or test files, but every changed
 *   test file has a `docs/`-sibling-free, additive-looking name match (i.e.
 *   the branch also touched `tests/` or a colocated `*.test.ts`) alongside
 *   at most a small number of production files. Still needs a real review,
 *   but is the cheapest non-docs-only category to review first.
 * - `needs-review`: everything else, including any branch that touches
 *   production code with no accompanying test file at all, or touches a
 *   large number of files.
 */
export function classifyBranchDiff(changedFiles: readonly string[]): PrTriageResult {
  if (changedFiles.length === 0) {
    return { tier: 'docs-only', reason: 'no changed files' };
  }

  const touchesDocsOnly = changedFiles.every((f) => DOCS_ONLY_PREFIXES.some((p) => f.startsWith(p)));
  if (touchesDocsOnly) {
    return { tier: 'docs-only', reason: 'every changed file is under docs/' };
  }

  const productionFiles = changedFiles.filter((f) => PRODUCTION_PREFIXES.some((p) => f.startsWith(p)));
  const testFiles = changedFiles.filter((f) => f.startsWith('tests/') || f.endsWith('.test.ts') || f.endsWith('.test.js'));

  if (productionFiles.length > 0 && testFiles.length === 0) {
    return {
      tier: 'needs-review',
      reason: `${productionFiles.length} production file(s) changed with no accompanying test file`,
    };
  }

  const MECHANICAL_MAX_PRODUCTION_FILES = 3;
  if (productionFiles.length > 0 && productionFiles.length <= MECHANICAL_MAX_PRODUCTION_FILES && testFiles.length > 0) {
    return {
      tier: 'mechanical',
      reason: `${productionFiles.length} production file(s) with accompanying test coverage`,
    };
  }

  return {
    tier: 'needs-review',
    reason: `${productionFiles.length} production file(s) changed — above the mechanical-change threshold or untestable by this heuristic`,
  };
}

export interface TriageSummary {
  docsOnly: number;
  mechanical: number;
  needsReview: number;
  total: number;
}

export function summarizeTriage(results: readonly PrRiskTier[]): TriageSummary {
  const summary: TriageSummary = { docsOnly: 0, mechanical: 0, needsReview: 0, total: results.length };
  for (const tier of results) {
    if (tier === 'docs-only') summary.docsOnly += 1;
    else if (tier === 'mechanical') summary.mechanical += 1;
    else summary.needsReview += 1;
  }
  return summary;
}
