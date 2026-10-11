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
 *
 * Dream Cycle 2026-10-11 (security): the rolling window above was a single
 * mutable JSON-array value under one shared key, updated by
 * `memory_retrieve` the array, append, `memory_store({upsert: true})` the
 * whole array back — a check-then-act race (CWE-362, the same class as
 * ACTOR-IDENTITY-VERIFICATION.md's nonce-guard TOCTOU, 2026-09-06). Every
 * real call site is a heartbeat firing (`fire-heartbeat.ts`'s Gate 2), and
 * heartbeat delivery is at-least-once in this design (HEARTBEATS-AND-COMMS.md
 * never promises a schedule fires at most once) — two overlapping fires for
 * the same company race this read-modify-write exactly like two concurrent
 * `verifyActorCredential` calls raced the nonce guard. Confirmed by an
 * independent test: two concurrent `recordLevelObservation` calls that both
 * read the same prior history before either writes back produce a history
 * missing one of the two observations (last writer wins) — silently
 * corrupting the input `isNewWarningStreak` gates the one autonomous
 * budget-tightening trigger this file exists to fire on.
 *
 * Unlike the nonce guard, this can't be fixed by making the SAME key's
 * write atomic: `memory_store`'s only atomicity primitive is strict-insert
 * on a key that doesn't exist yet (`upsert: false`, backed by the real
 * `UNIQUE(namespace, key)` constraint) — there is no compare-and-swap on an
 * existing key's VALUE, so a shared mutable blob can never be updated
 * race-free with the tools this backend exposes, no matter how the
 * read-modify-write is sequenced. The fix is therefore the same shape as
 * `store/agentdb-adapter.ts`'s own cost-tracking namespace (Dream Cycle
 * 2026-09-03): one immutable key per observation (`upsert: false`, so a
 * same-key collision fails loudly instead of silently overwriting — in
 * practice never happens, each key includes a fresh `randomUUID()`), the
 * window reconstructed by `memory_list`-ing the namespace and keeping the
 * most recent `WINDOW_SIZE` entries by the real backend's own `storedAt`
 * timestamp. Two concurrent recorders now write to two different keys —
 * nothing to race.
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
// Generous relative to any plausible heartbeat cadence — large enough that the
// window is never starved by expiry, small enough to self-bound storage
// growth rather than retaining observations forever (same self-expiring
// discipline as actor-credential.ts's nonce guard).
const OBSERVATION_TTL_SECONDS = 24 * 60 * 60;
// memory_list's own documented cap (store/agentdb-adapter.ts's cost-tracking
// namespace hits the identical limit for the identical reason).
const LEVEL_HISTORY_LIST_LIMIT = 1000;

/** WARNING-or-worse per §4's own wording — OK/INFO are not part of the pattern. */
const WARNING_OR_WORSE: ReadonlySet<OperatingBudgetLevel> = new Set(['WARNING', 'CRITICAL', 'HARD_STOP']);

function levelHistoryKeyPrefix(companyId: string): string {
  return `ruclip:company:${companyId}:autogenous-budget-level-history:`;
}

interface LevelObservation {
  level: OperatingBudgetLevel;
}

/**
 * Reads the current rolling window: lists every observation key for
 * `companyId`, keeps the most recent `WINDOW_SIZE` by the real backend's own
 * `storedAt` metadata (never a client clock), and retrieves each one. Each
 * key is independent — nothing here needs one observation's fetch to
 * complete before the next starts (same reasoning as `checkOperatingBudget`'s
 * own session-cost fan-out), and `WINDOW_SIZE` bounds the fan-out to at most
 * 10, so a plain `Promise.all` needs no concurrency cap the way that
 * (up to 1000-wide) fan-out does.
 *
 * Known scaling caveat, inherited from `checkOperatingBudget`'s identical
 * list-then-filter-by-prefix shape over the same `memory_list` 1000-entry
 * cap: `LEVEL_HISTORY_NAMESPACE` is shared across every company, not
 * company-scoped, so if the TOTAL observation count across all companies
 * within `OBSERVATION_TTL_SECONDS` ever approached 1000, one company's own
 * recent keys could be pushed out of the capped page before this filters by
 * its prefix. Not a regression this change introduces (the same shape and
 * cap already exists, accepted, in `store/agentdb-adapter.ts`) and not
 * reachable at this project's current single-company v1 scale — flagged
 * here, not fixed, as a next-step candidate (e.g. a company-scoped
 * namespace, or a shorter TTL) if/when that scale changes.
 */
async function readLevelHistory(companyId: string, config?: AgentDbAdapterConfig): Promise<OperatingBudgetLevel[]> {
  const prefix = levelHistoryKeyPrefix(companyId);
  const listResult = await callTool<{ entries?: Array<{ key: string; storedAt?: string }> }>(
    'memory_list',
    { namespace: LEVEL_HISTORY_NAMESPACE, limit: LEVEL_HISTORY_LIST_LIMIT },
    config,
  );
  const recentKeys = (listResult.entries ?? [])
    .filter((e) => e.key.startsWith(prefix))
    .sort((a, b) => Date.parse(a.storedAt ?? '') - Date.parse(b.storedAt ?? ''))
    .slice(-WINDOW_SIZE)
    .map((e) => e.key);

  const observations = await Promise.all(
    recentKeys.map((key) =>
      callTool<{ found?: boolean; value?: unknown }>('memory_retrieve', { key, namespace: LEVEL_HISTORY_NAMESPACE }, config),
    ),
  );
  return observations
    .filter((o): o is { found: true; value: LevelObservation } => Boolean(o.found) && typeof o.value === 'object' && o.value !== null)
    .map((o) => o.value.level);
}

/**
 * Records one observation under its own fresh key (`upsert: false` — see
 * file header for why a shared mutable key can never be made race-free with
 * this backend's atomicity primitive) and returns the refreshed window.
 * Two concurrent calls for the same company write two different keys, so
 * neither can observe or overwrite the other's write — there is no
 * read-modify-write step left to race.
 *
 * Exported (not module-private) so the concurrency regression test can
 * exercise exactly this step directly, the same testability discipline
 * `attest-handler.ts` documents for its own separation from HTTP wiring —
 * isolating the race from `checkAndProposeBudgetMutation`'s own
 * checkOperatingBudget/admit/canary side effects, none of which are part of
 * what this function's own atomicity claim is about.
 */
export async function recordLevelObservation(
  companyId: string,
  level: OperatingBudgetLevel,
  config?: AgentDbAdapterConfig,
): Promise<OperatingBudgetLevel[]> {
  const key = `${levelHistoryKeyPrefix(companyId)}${randomUUID()}`;
  const value: LevelObservation = { level };
  await callTool(
    'memory_store',
    { key, value: JSON.stringify(value), namespace: LEVEL_HISTORY_NAMESPACE, ttl: OBSERVATION_TTL_SECONDS, upsert: false },
    config,
  );
  return readLevelHistory(companyId, config);
}

/**
 * Security-hardening correction (security review round 9): the original
 * version of this check was level-triggered — "are the last
 * CONSECUTIVE_THRESHOLD readings all WARNING-or-worse right now" — which is
 * true on every single reading for the entire duration of an ongoing
 * incident, not just the reading where the pattern first became true.
 * Since this v1 flow never actually applies the tightened threshold to
 * Company.budget (only a real /v1/promote success would, Phase 4b, out of
 * scope), the caller passes the identical currentHardStopThreshold on every
 * check for as long as the underlying problem persists — so a sustained
 * streak re-triggered a brand-new /v1/agl/admit + /v1/canary/new submission
 * on EVERY reading after the 3rd, proposing the literal identical parent
 * genome hash and threshold change already proposed, for what the
 * governance service sees as duplicate proposals for the same incident.
 * Confirmed exploitable by an independent test (4 consecutive WARNING
 * readings produced 2 distinct triggers/mutation ids/admit+canary pairs).
 *
 * Fixed to be edge-triggered instead: the pattern must be true NOW and
 * have been false immediately before the current CONSECUTIVE_THRESHOLD
 * window began — i.e. this is the reading where the streak first crossed
 * the threshold, not a continuation of an already-triggered one. A streak
 * that never breaks (stays WARNING-or-worse indefinitely) now fires exactly
 * once; a new incident (streak breaks back to OK/INFO, then WARNING+ again)
 * correctly fires again as its own, genuinely new proposal.
 */
function isNewWarningStreak(history: OperatingBudgetLevel[]): boolean {
  if (history.length < CONSECUTIVE_THRESHOLD) return false;
  const window = history.slice(-CONSECUTIVE_THRESHOLD);
  if (!window.every((level) => WARNING_OR_WORSE.has(level))) return false;
  const priorIndex = history.length - CONSECUTIVE_THRESHOLD - 1;
  // No reading exists before the window (history is exactly THRESHOLD long,
  // e.g. right after the rolling window itself first fills) — this is the
  // earliest possible trigger for a genuinely first-seen incident.
  if (priorIndex < 0) return true;
  return !WARNING_OR_WORSE.has(history[priorIndex]!);
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
  if (!isNewWarningStreak(history)) {
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
