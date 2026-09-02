/**
 * ruClip's own operating-spend circuit breaker (HEARTBEATS-AND-COMMS.md §4,
 * Finding C) — Gate 2 of `heartbeat/fire-heartbeat.ts`'s two AND'ed budget
 * gates, and the source of `propose-budget-mutation.ts`'s repeated-WARNING
 * fitness signal and `dashboard/build-snapshot.ts`'s Company budget display.
 *
 * Extracted out of `agentdb-adapter.ts` (2026-09-02, architecture rotation):
 * that module had grown into a single persistence/orchestration surface for
 * 8 unrelated bounded contexts (company/goal/issue persistence, approval
 * guards, causal edges, heartbeat scheduling, this budget circuit breaker,
 * the pattern store, and the Autogenous mutation audit trail) — a textbook
 * God-module (Brown et al., *AntiPatterns*, 1998; Fowler's "Large
 * Class"/"Divergent Change"). This mirrors the exact extract-and-re-export
 * technique `bridge-client.ts` already used to pull `AgentDbBridgeError`/
 * `callTool`/`AgentDbAdapterConfig` out of this same file — not a new
 * convention. `agentdb-adapter.ts` re-exports every name below unchanged,
 * so no import path anywhere in the repo needed to change.
 */
import { callTool, assertSafeId, type AgentDbAdapterConfig } from './bridge-client.js';

/** ruClip's OWN namespace via memory_store/memory_retrieve/memory_list — deliberately not the shared `cost-tracking` namespace ruflo-cost-tracker itself uses. */
const RUCLIP_COST_NAMESPACE = 'ruclip-cost-tracking';

export type OperatingBudgetLevel = 'OK' | 'INFO' | 'WARNING' | 'CRITICAL' | 'HARD_STOP';

export interface OperatingBudgetThresholds {
  info: number;
  warning: number;
  critical: number;
  hardStop: number;
}

export interface OperatingBudgetConfig {
  budgetUsd: number;
  thresholds: OperatingBudgetThresholds;
}

/**
 * Exported (not module-private) so RUCLIP-DASHBOARD.md §2's Company budget
 * display can reuse the exact same alert-ladder thresholds this circuit
 * breaker uses, rather than duplicating the 50/75/90/100% figures — see
 * dashboard/build-snapshot.ts.
 */
export const DEFAULT_OPERATING_BUDGET_THRESHOLDS: OperatingBudgetThresholds = {
  info: 0.5,
  warning: 0.75,
  critical: 0.9,
  hardStop: 1.0,
};

function operatingBudgetConfigKey(companyId: string): string {
  return `${companyId}:budget-config`;
}
function operatingSessionKeyPrefix(companyId: string): string {
  return `${companyId}:session-`;
}

/**
 * Real memory_store confirmed live schema: `upsert` defaults to `true`
 * (matches CLI `memory store`'s own default) — so unlike `budget.mjs`'s
 * `budget-config-<timestamp>` + pick-latest workaround (which exists for a
 * UNIQUE-constraint quirk specific to that CLI code path), this can write
 * the same key repeatedly with no stamping/index-of-latest dance. If this
 * assumption ever proves wrong against a live bridge, that is the signal to
 * adopt the stamping workaround here too — not to silently assume it.
 */
export async function setOperatingBudget(
  companyId: string,
  budgetUsd: number,
  thresholds: OperatingBudgetThresholds = DEFAULT_OPERATING_BUDGET_THRESHOLDS,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  assertSafeId(companyId, 'companyId');
  const value: OperatingBudgetConfig = { budgetUsd, thresholds };
  await callTool(
    'memory_store',
    { key: operatingBudgetConfigKey(companyId), value: JSON.stringify(value), namespace: RUCLIP_COST_NAMESPACE, upsert: true },
    config,
  );
}

/** Exported alongside DEFAULT_OPERATING_BUDGET_THRESHOLDS — see that constant's own comment. */
export function operatingBudgetLevel(utilizationPct: number, thresholds: OperatingBudgetThresholds): OperatingBudgetLevel {
  if (utilizationPct >= thresholds.hardStop) return 'HARD_STOP';
  if (utilizationPct >= thresholds.critical) return 'CRITICAL';
  if (utilizationPct >= thresholds.warning) return 'WARNING';
  if (utilizationPct >= thresholds.info) return 'INFO';
  return 'OK';
}

/**
 * Gate 2 (HEARTBEATS-AND-COMMS.md §2/§4) — ruClip's own whole-company
 * operating-spend circuit breaker, mirroring `ruflo-cost-tracker`'s
 * alert-ladder shape but reading/writing ruClip's own namespace.
 *
 * Real-behavior finding, not in the design doc's own §4 text: `memory_list`
 * confirmed live schema returns entry METADATA ONLY
 * (`{key, namespace, storedAt, updatedAt, accessCount, hasEmbedding,
 * size}`) — no `value`/`content` field at all. Summing `total_cost_usd`
 * therefore cannot be a single `memory_list` call the way the design's own
 * prose reads ("Sums total_cost_usd across ... records via memory_list") —
 * it requires `memory_list` to enumerate `session-*` keys, then one
 * `memory_retrieve` per key to actually read each record's value. This
 * mirrors the exact same metadata-only limitation
 * `v3/@claude-flow/cli/src/mcp-tools/agentdb-tools.ts`'s own pattern-search
 * fallback works around (its `#2226` comment) — same tool family, same
 * constraint, independently re-discovered here.
 */
export async function checkOperatingBudget(
  companyId: string,
  config?: AgentDbAdapterConfig,
): Promise<{ level: OperatingBudgetLevel; utilizationPct: number }> {
  assertSafeId(companyId, 'companyId');
  const configResult = await callTool<{ found?: boolean; value?: unknown }>(
    'memory_retrieve',
    { key: operatingBudgetConfigKey(companyId), namespace: RUCLIP_COST_NAMESPACE },
    config,
  );
  if (!configResult.found || typeof configResult.value !== 'object' || configResult.value === null) {
    // No budget configured — no known problem, not a hard failure, matching budget.mjs check's own non-alerting path.
    return { level: 'OK', utilizationPct: 0 };
  }
  const budgetConfig = configResult.value as OperatingBudgetConfig;

  const listResult = await callTool<{ entries?: Array<{ key: string }> }>(
    'memory_list',
    { namespace: RUCLIP_COST_NAMESPACE, limit: 1000 },
    config,
  );
  const sessionKeys = (listResult.entries ?? [])
    .map((e) => e.key)
    .filter((key) => key.startsWith(operatingSessionKeyPrefix(companyId)));

  let totalCostUsd = 0;
  for (const key of sessionKeys) {
    const sessionResult = await callTool<{ found?: boolean; value?: unknown }>(
      'memory_retrieve',
      { key, namespace: RUCLIP_COST_NAMESPACE },
      config,
    );
    const value = sessionResult.value as { total_cost_usd?: unknown } | undefined;
    if (sessionResult.found && value && typeof value.total_cost_usd === 'number') {
      totalCostUsd += value.total_cost_usd;
    }
  }

  const utilizationPct = budgetConfig.budgetUsd > 0 ? totalCostUsd / budgetConfig.budgetUsd : 0;
  return { level: operatingBudgetLevel(utilizationPct, budgetConfig.thresholds), utilizationPct };
}
