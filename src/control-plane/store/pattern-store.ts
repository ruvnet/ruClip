/**
 * Advisory pattern-store namespaces (DOMAIN-MODEL.md §2.4), extracted from
 * `agentdb-adapter.ts` as its own single-responsibility module — the same
 * convention already applied to `bridge-client.ts` (circular-import
 * avoidance) and proposed for `operating-budget.ts` (bounded-context
 * extraction) in that file's header/history. This bounded context has no
 * dependency on anything else in `agentdb-adapter.ts` (only on the shared
 * `callTool` bridge primitive), so it extracts cleanly with zero behavioral
 * change.
 *
 * Deviation from DOMAIN-MODEL.md §2.4 (inherited from `agentdb-adapter.ts`'s
 * own header, deviation 2): `agentdb_pattern-store`/`agentdb_pattern-search`
 * have no `namespace` parameter (only `pattern`, `type`, `confidence` /
 * `query`, `topK`, `minConfidence`). The three namespaces this module
 * exposes (`ruclip/org-chart`, `ruclip/issue-templates`,
 * `ruclip/approval-heuristics`) are encoded into the `type` field instead,
 * since that's the only discriminator the real tool exposes.
 */
import { callTool, type AgentDbAdapterConfig } from './bridge-client.js';

/** The three advisory namespaces from DOMAIN-MODEL.md §2.4, encoded into `type` (see file header, deviation 2). */
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
