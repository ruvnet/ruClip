/**
 * ruClip's semantic pattern-store (DOMAIN-MODEL.md §2.4) — advisory
 * org-chart/issue-template/approval-heuristic patterns surfaced via the
 * real `agentdb_pattern-store`/`agentdb_pattern-search` MCP tools.
 *
 * Extracted out of `agentdb-adapter.ts` (2026-09-07, architecture
 * rotation), continuing the same extract-and-re-export technique
 * `bridge-client.ts` and `store/operating-budget.ts` already used to pull
 * self-contained bounded contexts out of that file — not a new
 * convention (see `docs/dream-cycle/2026-09-02-architecture-report.md`,
 * whose own "Next steps" named this exact section as the next candidate).
 * `agentdb-adapter.ts` re-exports every name below unchanged, so no
 * import path anywhere in the repo needed to change.
 */
import { callTool, type AgentDbAdapterConfig } from './bridge-client.js';

/** The three advisory namespaces from DOMAIN-MODEL.md §2.4, encoded into `type` (see agentdb-adapter.ts's file header, deviation 2). */
export type RuclipPatternNamespace =
  | 'ruclip/org-chart'
  | 'ruclip/issue-templates'
  | 'ruclip/approval-heuristics';

export async function storePattern(
  namespace: RuclipPatternNamespace,
  pattern: string,
  confidence = 0.8,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  await callTool('agentdb_pattern-store', { pattern, type: namespace, confidence }, config);
}

export interface PatternSearchResult {
  pattern: string;
  type: string;
  confidence: number;
}

export async function searchPatterns(
  namespace: RuclipPatternNamespace,
  query: string,
  topK = 5,
  config?: AgentDbAdapterConfig,
): Promise<PatternSearchResult[]> {
  const result = await callTool<{ results?: PatternSearchResult[] }>(
    'agentdb_pattern-search',
    { query: `${namespace} ${query}`, topK },
    config,
  );
  return (result.results ?? []).filter((r) => r.type === namespace);
}
