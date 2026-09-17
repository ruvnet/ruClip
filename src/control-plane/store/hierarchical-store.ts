/**
 * Generic hierarchical-store wrappers (store/delete/recall-by-exact-key)
 * shared by every persistence function in `agentdb-adapter.ts`.
 *
 * Extracted out of that file (2026-09-17, architecture rotation) as a
 * dependency-free leaf atop `bridge-client.ts`'s `callTool` — the same
 * extract-and-re-export technique already used to pull
 * `AgentDbBridgeError`/`callTool`/`AgentDbAdapterConfig` into
 * `bridge-client.ts` and the `operating-budget`/`pattern-store` bounded
 * contexts into their own files. `agentdb-adapter.ts` re-exports every name
 * below unchanged, so no existing `from '../store/agentdb-adapter.js'`
 * import needed to change.
 *
 * Unlike those single-bounded-context extractions, this slice is used by
 * *every* persistence function in `agentdb-adapter.ts` (12 call sites
 * spanning company/goal/issue/comment/approval-transition/heartbeat) rather
 * than by one. Moving it onto the same dependency-free layer as
 * `bridge-client.ts` — instead of leaving it private inside
 * `agentdb-adapter.ts` — unblocks any *future* extraction of a bounded
 * context that itself needs store/delete/recall (heartbeat-schedule,
 * approval-transition, comment, etc.) without re-creating the two-way
 * import cycle `bridge-client.ts`'s own header already documents breaking
 * once for `assertSafeId`/`callTool` (a `class ... extends` heritage clause
 * evaluated at module-load time faults on an uninitialized circular import;
 * a plain function body does not, but two modules each needing the other's
 * generic store helpers hits the same class of problem the moment either
 * one has a class that must exist before the cycle resolves).
 */
import { callTool, AgentDbBridgeError, type AgentDbAdapterConfig } from './bridge-client.js';
import type { MemoryTier } from '../schema/enums.js';

/**
 * The bridge reports some failures (key too long, backend refusal) as
 * `{ success: false, error }` inside an ordinary result, not as a JSON-RPC
 * error — so a write can "succeed" while nothing is stored. Treat that as
 * a failure here, once, for every store/delete.
 */
function assertToolSucceeded(
  tool: string,
  key: string,
  result: { success?: boolean; error?: string } | null | undefined,
): void {
  if (result && result.success === false) {
    throw new AgentDbBridgeError(`AgentDB tool '${tool}' refused key '${key}': ${result.error ?? 'unknown error'}`);
  }
}

export async function storeAtTier(
  key: string,
  value: unknown,
  tier: MemoryTier,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  const result = await callTool<{ success?: boolean; error?: string }>(
    'agentdb_hierarchical-store',
    { key, value: JSON.stringify(value), tier },
    config,
  );
  assertToolSucceeded('agentdb_hierarchical-store', key, result);
}

export async function deleteFromTier(key: string, tier: MemoryTier, config?: AgentDbAdapterConfig): Promise<void> {
  const result = await callTool<{ success?: boolean; error?: string }>('agentdb_hierarchical-delete', { key, tier }, config);
  assertToolSucceeded('agentdb_hierarchical-delete', key, result);
}

/**
 * Recall by exact key. agentdb_hierarchical-recall is a semantic/BM25 search
 * over `query`, not an exact-key get — we search with the key as the query
 * and defensively keep only a result whose own key matches exactly.
 */
const RECALL_BY_KEY_PAGE_SIZES = [200, 1000] as const;

export async function recallByKey<T>(
  key: string,
  tier: MemoryTier | undefined,
  config?: AgentDbAdapterConfig,
): Promise<T | null> {
  // agentdb_hierarchical-recall is a similarity/lexical search, not an exact-key read: the
  // exact key is only somewhere in the result page. On a real bridge a company with more
  // than ten sibling records (members, issues, heartbeats all share the company prefix)
  // pushed the exact key out of a topK:10 page, so recallCompany() returned null and every
  // caller that starts with "recall the company" silently did nothing (ruvnet/ruClip#5).
  // Page wide first, then widen once more before giving up.
  for (const topK of RECALL_BY_KEY_PAGE_SIZES) {
    const result = await callTool<{ results?: Array<{ key?: string; id?: string; value?: string }> }>(
      'agentdb_hierarchical-recall',
      { query: key, tier, topK },
      config,
    );
    const results = result.results ?? [];
    const match = results.find((r) => r.key === key || r.id === key);
    if (match) {
      if (typeof match.value !== 'string') return null;
      try {
        return JSON.parse(match.value) as T;
      } catch {
        return null;
      }
    }
    // A short page means the store has no more candidates; a full page means widen.
    if (results.length < topK) return null;
  }
  return null;
}
