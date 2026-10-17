/**
 * Causal-edge relations (DOMAIN-MODEL.md §2.3) — `recordCausalEdge`'s cycle
 * prevention for `parent_of`/`reports_to`, plus the one-hop neighbor lookup
 * `getBlockerIssueIds`/`getChildIssueIds` build on. Extracted from
 * `agentdb-adapter.ts` (dream-cycle architecture night, same already-
 * established convention as that file's prior operating-budget/pattern-store/
 * hierarchical-store-wrapper extractions): one more self-contained bounded
 * context out of that file's 8+, this one with no dependency on its private
 * `storeAtTier`/`recallByKey` hierarchical-store wrappers — only the
 * dependency-free `callTool`/`AgentDbBridgeError` bridge-client primitives —
 * so it moves cleanly with zero circular-import risk.
 */
import type { CausalRelation } from '../schema/enums.js';
import { AgentDbBridgeError, callTool, type AgentDbAdapterConfig } from './bridge-client.js';

const CYCLE_CHECKED_RELATIONS: readonly CausalRelation[] = ['parent_of', 'reports_to'];

/**
 * Deterministic k-hop reachability check (see agentdb-adapter.ts's file
 * header for why this replaces the domain model's graph-pathfinder
 * suggestion). Returns true if `candidateSourceId` is reachable from
 * `candidateTargetId` by following `relation` edges — i.e. adding
 * `candidateSourceId -> candidateTargetId` would close a cycle.
 *
 * Real k-hop response shape is `{ results: [{ nodeId, depth? }, ...], ... }`,
 * confirmed against the real, currently-pinned `@claude-flow/cli@3.38.20`
 * tool source (`agentdbGraphQuery.handler`'s k-hop branch), not
 * `{ nodes: [{ id }, ...] }` — see the 2026-09-05 correctness fix this
 * module carries forward unchanged.
 */
async function wouldCreateCycle(
  candidateSourceId: string,
  candidateTargetId: string,
  relation: CausalRelation,
  config?: AgentDbAdapterConfig,
): Promise<boolean> {
  const result = await callTool<{ results?: Array<{ nodeId: string }> }>(
    'agentdb_graph-query',
    { nodeId: candidateTargetId, mode: 'k-hop', relation, depth: 5 },
    config,
  );
  return (result.results ?? []).some((n) => n.nodeId === candidateSourceId);
}

/**
 * Record a causal edge, enforcing DOMAIN-MODEL.md §1.2/§1.4 cycle
 * prevention for `parent_of` and `reports_to`.
 */
export async function recordCausalEdge(
  sourceId: string,
  targetId: string,
  relation: CausalRelation,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  if (CYCLE_CHECKED_RELATIONS.includes(relation)) {
    if (sourceId === targetId) {
      throw new AgentDbBridgeError(`Refusing self-referential ${relation} edge on ${sourceId}`);
    }
    if (await wouldCreateCycle(sourceId, targetId, relation, config)) {
      throw new AgentDbBridgeError(
        `Refusing ${relation} edge ${sourceId} -> ${targetId}: would close a cycle`,
      );
    }
  }
  await callTool('agentdb_causal-edge', { sourceId, targetId, relation, weight: 1.0 }, config);
}

/**
 * k-hop neighbors of `nodeId` following `relation`, one hop, as raw entity
 * ids. Real response shape (`results`/`nodeId`, not `nodes`/`id`) — see
 * `wouldCreateCycle`'s own header comment above for the ground-truth fix
 * this shares.
 */
export async function graphNeighbors(
  nodeId: string,
  relation: CausalRelation,
  config?: AgentDbAdapterConfig,
): Promise<string[]> {
  const result = await callTool<{ results?: Array<{ nodeId: string }> }>(
    'agentdb_graph-query',
    { nodeId, mode: 'k-hop', relation, depth: 1 },
    config,
  );
  return (result.results ?? []).map((n) => n.nodeId);
}
