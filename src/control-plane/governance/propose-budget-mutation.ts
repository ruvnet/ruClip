/**
 * The concrete v1 Autogenous trigger (AUTOGENOUS-RUNTIME-GOVERNANCE.md §4):
 * a repeated WARNING-or-worse pattern from `checkOperatingBudget` (3+
 * consecutive checks within a bounded window) proposes a single,
 * `auto_reversible`-authority, `routing_budget`-scoped config-level
 * `Mutation` (tightening `Company.budget.hardStopThreshold`) — never
 * `application_code`/`security_policy`/`schema_migration`/`constitutional`
 * scope, matching `MutationScope::auto_promotable()`'s own real boundary.
 *
 * Several concrete mechanics below are NOT specified verbatim by the
 * design doc (it names the trigger and the wire contract, not every
 * implementation detail) — documented inline where invented, and called
 * out in the delivery notes for architect/team-lead review, per this
 * project's standing practice:
 * - The "3+ consecutive within a bounded window" pattern needs its own
 *   small persisted rolling window (§4 doesn't name an existing primitive
 *   for this — `checkOperatingBudget` itself is stateless per call). Kept
 *   self-contained in this file's own memory_store namespace, matching
 *   `employee-augmentation/interaction-profile.ts`'s precedent of a
 *   feature-specific namespace living with the feature, not bolted onto
 *   `agentdb-adapter.ts`.
 * - `Genome.constitution` has no real value yet (Phase 4b hasn't authored
 *   one) — set to a documented placeholder. Reasoned to be safe for v1's
 *   admit-only scope: none of `/v1/agl/admit`'s seven real
 *   `AdmissionError` codes (§2.4) concern the *format* of this field, only
 *   `/v1/promote`/`/v1/judges/evaluate` (out of scope, §1) actually need a
 *   real Constitution.
 * - `FitnessVector`'s fields not directly measurable from a budget-config
 *   change (`task_quality`, `p99_overhead_ms`, `false_positive_rate`) get
 *   honest, conservative defaults, documented per-field below — never a
 *   value chosen to make the gate pass.
 */
import { randomUUID, createHash } from 'node:crypto';
import {
  checkOperatingBudget,
  persistAutogenousMutationRecord,
  recallAutogenousMutationRecord,
  type OperatingBudgetLevel,
  type AutogenousMutationRecord,
} from '../store/agentdb-adapter.js';
import { callTool, assertSafeId, type AgentDbAdapterConfig } from '../store/bridge-client.js';
import {
  admitMutation,
  createCanary,
  observeCanary,
  type AutogenousClientConfig,
  type Genome,
  type Mutation,
  type FitnessVector,
  type Decision,
} from './autogenous-client.js';

// --- Level-history rolling window (see file header) -------------------------

const LEVEL_HISTORY_NAMESPACE = 'ruclip-autogenous-budget-triggers';
const CONSECUTIVE_THRESHOLD = 3;
const WINDOW_SIZE = 10; // bounded window — only the most recent readings matter for the pattern check

/** WARNING-or-worse per §4's own wording — OK/INFO are not part of the pattern. */
const WARNING_OR_WORSE: ReadonlySet<OperatingBudgetLevel> = new Set(['WARNING', 'CRITICAL', 'HARD_STOP']);

function levelHistoryKey(companyId: string): string {
  return `ruclip:company:${companyId}:autogenous-budget-level-history`;
}

async function recordLevelObservation(
  companyId: string,
  level: OperatingBudgetLevel,
  config?: AgentDbAdapterConfig,
): Promise<OperatingBudgetLevel[]> {
  const key = levelHistoryKey(companyId);
  const existing = await callTool<{ found?: boolean; value?: unknown }>(
    'memory_retrieve',
    { key, namespace: LEVEL_HISTORY_NAMESPACE },
    config,
  );
  const history: OperatingBudgetLevel[] =
    existing.found && Array.isArray(existing.value) ? (existing.value as OperatingBudgetLevel[]) : [];
  const updated = [...history, level].slice(-WINDOW_SIZE);
  await callTool(
    'memory_store',
    { key, value: JSON.stringify(updated), namespace: LEVEL_HISTORY_NAMESPACE, upsert: true },
    config,
  );
  return updated;
}

function hasConsecutiveWarningOrWorse(history: OperatingBudgetLevel[]): boolean {
  if (history.length < CONSECUTIVE_THRESHOLD) return false;
  return history.slice(-CONSECUTIVE_THRESHOLD).every((level) => WARNING_OR_WORSE.has(level));
}

// --- Genome / Mutation construction ------------------------------------------

const BUDGET_INVARIANT_NAME = 'budget-hard-stop-monotonic';
const THRESHOLD_TIGHTEN_STEP = 0.05;
const THRESHOLD_FLOOR = 0.5;

function tightenedThreshold(current: number): number {
  return Math.max(THRESHOLD_FLOOR, Math.round((current - THRESHOLD_TIGHTEN_STEP) * 100) / 100);
}

function budgetGenomeHash(companyId: string, hardStopThreshold: number): string {
  return createHash('sha256').update(`${companyId}:hardStopThreshold:${hardStopThreshold}`).digest('hex');
}

function buildParentGenome(companyId: string, currentThreshold: number): Genome {
  return {
    hash: budgetGenomeHash(companyId, currentThreshold),
    identity: `ruclip:company:${companyId}:budget-config`,
    // Placeholder — ruClip has no Constitution yet (Phase 4b). See file header for why this is safe for v1's admit-only scope.
    constitution: 'unconstituted',
    capability_ceiling: 'auto_reversible', // ruClip never grants itself more than this
    hard_invariants: [{ name: BUDGET_INVARIANT_NAME, holds: true }],
    lineage: [],
  };
}

function buildMutation(parent: Genome, newThreshold: number): Mutation {
  return {
    id: randomUUID(),
    parent_genome_hash: parent.hash,
    scope: 'routing_budget',
    requested_authority: 'auto_reversible',
    applicability: { workloads: [], environments: [], jurisdictions: [] }, // unscoped — ruClip has no workload/environment/jurisdiction segmentation concept yet
    preserved_invariants: parent.hard_invariants,
    rollback_target: parent.hash, // REQUIRED (§2.2/§2.4) — the prior threshold's genome hash
    expires_at: null,
    signature: null,
  };
}

export interface ProposeBudgetMutationResult {
  triggered: boolean;
  record?: AutogenousMutationRecord;
}

/**
 * Call this alongside every real `checkOperatingBudget` reading (the
 * natural call site is `fireHeartbeat`'s own Gate 2, HEARTBEATS-AND-COMMS.md
 * §4 — not wired here, since that's a separate integration decision outside
 * this file's own scope per the design's file list). Records the reading
 * into the rolling window; if the pattern trips, proposes and submits a
 * Mutation. Returns `{triggered: false}` when the pattern hasn't tripped —
 * not an error, the common case.
 */
export async function checkAndProposeBudgetMutation(
  companyId: string,
  currentHardStopThreshold: number,
  storeConfig?: AgentDbAdapterConfig,
  autogenousConfig?: AutogenousClientConfig,
): Promise<ProposeBudgetMutationResult> {
  assertSafeId(companyId, 'companyId');
  const { level } = await checkOperatingBudget(companyId, storeConfig);
  const history = await recordLevelObservation(companyId, level, storeConfig);
  if (!hasConsecutiveWarningOrWorse(history)) {
    return { triggered: false };
  }

  const parent = buildParentGenome(companyId, currentHardStopThreshold);
  const mutation = buildMutation(parent, tightenedThreshold(currentHardStopThreshold));
  const now = Math.floor(Date.now() / 1000);

  // §3's fail-closed contract: AutogenousClientError on unreachability
  // propagates as a thrown error here — the caller sees "not admitted"
  // exactly the same way an explicit {admitted: false} response would
  // read, just via a throw instead of a return value. Deliberately not
  // caught/swallowed.
  const admitResponse = await admitMutation({ mutation, parent, now }, autogenousConfig);

  const nowIso = new Date().toISOString();
  let record: AutogenousMutationRecord = {
    id: mutation.id,
    companyId,
    mutation,
    parentGenome: parent,
    admitResponse,
    controller: null,
    observations: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (admitResponse.admitted) {
    // §4: admitted -> /v1/canary/new. Not yet applied to Company.budget --
    // that only happens on a real /v1/promote success (Phase 4b, out of
    // scope here).
    const { controller } = await createCanary(
      { candidate_id: mutation.id, rollback_target: mutation.rollback_target! },
      autogenousConfig,
    );
    record = { ...record, controller, updatedAt: new Date().toISOString() };
  }
  // Not admitted -> persisted as-is (controller stays null) so the
  // rejection itself is part of the durable, queryable audit trail (§6) --
  // "log and stop" (§4) is satisfied by this persist; "no further action"
  // means no canary/promotion follow-up, not "don't record the attempt."

  await persistAutogenousMutationRecord(record, storeConfig);
  return { triggered: true, record };
}

// --- Feeding subsequent readings into an in-flight canary --------------------

/**
 * `safety`/`governance` are derived honestly from whether the tightened
 * threshold is actually preventing further alert-ladder breaches (§4) —
 * not defaulted to a value that always passes. Fields this file has no way
 * to measure from a budget-config change alone get conservative, clearly
 * documented defaults rather than an optimistic guess:
 * - `task_quality`/`reliability`: 1 (unmeasured; a threshold tweak doesn't
 *   itself degrade task output or reliability).
 * - `p99_overhead_ms`: 0 (a config value change has no runtime latency cost).
 * - `false_positive_rate`: 0 (nothing here classifies anything).
 * - `regression_count`: 1 if the level is STILL WARNING-or-worse despite
 *   the tightened threshold (the change isn't working), else 0.
 * - `rollback_verified`: false, always, in this v1 flow — never actually
 *   exercised, so never honestly claimed true.
 */
function fitnessFromBudgetLevel(level: OperatingBudgetLevel): FitnessVector {
  const stillBreaching = WARNING_OR_WORSE.has(level);
  return {
    task_quality: 1,
    safety: stillBreaching ? 0.5 : 1,
    governance: stillBreaching ? 0.5 : 1,
    reliability: 1,
    p99_overhead_ms: 0,
    false_positive_rate: 0,
    regression_count: stillBreaching ? 1 : 0,
    rollback_verified: false,
  };
}

export interface ObserveBudgetMutationResult {
  decision: Decision;
  stagePct: number | null;
  record: AutogenousMutationRecord;
}

/**
 * Feeds one fresh `checkOperatingBudget` reading into an already-admitted,
 * already-canarying mutation's `/v1/canary/observe` call. Throws if no
 * record exists or the record was never admitted (controller null) — there
 * is nothing to observe.
 */
export async function observeBudgetMutation(
  companyId: string,
  mutationId: string,
  storeConfig?: AgentDbAdapterConfig,
  autogenousConfig?: AutogenousClientConfig,
): Promise<ObserveBudgetMutationResult> {
  const existing = await recallAutogenousMutationRecord(companyId, mutationId, storeConfig);
  if (!existing || !existing.controller) {
    throw new Error(
      `No admitted, canarying AutogenousMutationRecord '${mutationId}' for company '${companyId}' to observe`,
    );
  }

  const { level } = await checkOperatingBudget(companyId, storeConfig);
  const fitness = fitnessFromBudgetLevel(level);

  // §3's fail-closed contract applies here too — an unreachable service
  // throws, this function does not swallow it into a fabricated decision.
  const { controller, decision, stage_pct } = await observeCanary({ controller: existing.controller, fitness }, autogenousConfig);

  const nowIso = new Date().toISOString();
  const record: AutogenousMutationRecord = {
    ...existing,
    controller,
    observations: [...existing.observations, { at: nowIso, fitness, decision }],
    updatedAt: nowIso,
  };
  await persistAutogenousMutationRecord(record, storeConfig);

  return { decision, stagePct: stage_pct, record };
}
