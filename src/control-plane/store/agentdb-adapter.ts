/**
 * AgentDB persistence adapter for Company/OrgMember/Goal/Issue/Comment
 * (DOMAIN-MODEL.md §2). Implements the hierarchical-store tier placement,
 * causal-edge relations, and pattern-store namespaces the domain model
 * specifies.
 *
 * CLI-surface finding (this is the documented deviation the coder-stage
 * brief asked for): `npx ruflo agentdb ...` does **not exist** as a CLI
 * subcommand. Checked v3/@claude-flow/cli/src/commands/*.ts directly — the
 * only CLI surface is `ruflo memory <store|retrieve|search|list|delete|...>`
 * (v3/@claude-flow/cli/src/commands/memory.ts), which is a much thinner
 * key/namespace/value API than what this schema needs (no tiers, no causal
 * edges, no graph queries, no pattern-store namespaces). The richer
 * `agentdb_*` primitives this file depends on
 * (hierarchical-store/recall/delete, causal-edge, graph-query,
 * pattern-store/search) exist ONLY as MCP tools
 * (v3/@claude-flow/cli/src/mcp-tools/agentdb-tools.ts) — they are not
 * exposed as `ruflo <verb>` CLI commands anywhere in that package.
 *
 * Since this repo is a plain Node module (not a Claude Code session), it
 * cannot call `mcp__*__agentdb_*` tools directly either. The path that
 * actually exists end-to-end is the HTTP JSON-RPC bridge started by
 * `ruflo mcp start -t http -p <port>` (verified against
 * v3/@claude-flow/cli/src/mcp-server.ts `handleMCPMessage`): POST
 * `{jsonrpc:"2.0", method:"tools/call", params:{name, arguments}}` to
 * `http://<host>:<port>/rpc` and unwrap `result.content[0].text` (JSON).
 * This module talks to that bridge. A deployment must run
 * `ruflo mcp start -t http` as a sidecar before this adapter's functions
 * will succeed; `RUCLIP_AGENTDB_BRIDGE_URL` overrides the default
 * `http://localhost:3000`.
 *
 * Two further deviations from DOMAIN-MODEL.md §2, discovered by reading the
 * real tool schemas rather than guessing:
 *
 * 1. §2.3 says cycle prevention runs `agentdb_graph-pathfinder` from the
 *    proposed target back to the proposed source. The real
 *    `agentdb_graph-pathfinder` tool takes `{seedNodeId, query}` and returns
 *    algorithm-ranked paths (personalized-pagerank / mincut / spectral /
 *    etc.) scored against a natural-language query — it has no
 *    `targetNodeId` and is not a deterministic "does a path exist" check.
 *    `agentdb_graph-query` with `mode:'k-hop'` + a `relation` filter IS a
 *    deterministic bounded neighbor expansion, so cycle prevention here
 *    walks k-hop from the proposed target and checks whether the proposed
 *    source appears in the reachable set. See `wouldCreateCycle` below.
 * 2. `agentdb_pattern-store`/`agentdb_pattern-search` have no `namespace`
 *    parameter (only `pattern`, `type`, `confidence` / `query`, `topK`,
 *    `minConfidence`). The three namespaces DOMAIN-MODEL.md §2.4 describes
 *    (`ruclip/org-chart`, `ruclip/issue-templates`,
 *    `ruclip/approval-heuristics`) are encoded into the `type` field
 *    instead, since that's the only discriminator the real tool exposes.
 *
 * Node IDs used in causal-edge/graph-query calls are prefixed `entity:` to
 * land in agentdb-tools.ts's ADR-130 `VALID_DOMAINS` set and avoid its
 * legacy-ID auto-prefix warning.
 */
import type { Company } from '../schema/company.js';
import type { OrgMember } from '../schema/org-member.js';
import type { Goal } from '../schema/goal.js';
import type { Issue } from '../schema/issue.js';
import type { Comment } from '../schema/comment.js';
import type { ApprovalAction, ApprovalTransition } from '../schema/approval-transition.js';
import type { WitnessHook } from '../schema/witness.js';
import type { HeartbeatSchedule, HeartbeatStatus, HeartbeatTarget } from '../schema/heartbeat-schedule.js';
import type { NotificationChannel } from '../schema/notification.js';
import type { CausalRelation, MemoryTier } from '../schema/enums.js';
import {
  assertValidCompany,
  assertValidOrgMember,
  assertValidGoal,
  assertValidIssue,
  assertValidComment,
  assertValidApprovalTransition,
  assertValidHeartbeatSchedule,
} from '../schema/validation.js';
import { transitionApprovalState, isLegalApprovalTransition } from '../approval/transition-approval-state.js';
import {
  verifyActorHoldsClaim,
  handoffClaim,
  acceptClaimHandoff,
  ClaimAuthorizationError,
} from '../authorization/claims-authorization.js';
import { resolveVerifiedActor, type ActorAuthorization } from '../authorization/actor-credential.js';
import { recomputeInteractionSignals } from '../employee-augmentation/interaction-profile.js';
import type {
  Mutation,
  Genome,
  AdmitResponse,
  CanaryController,
  Decision,
  FitnessVector,
} from '../governance/autogenous-client.js';
import { AgentDbBridgeError, callTool, assertSafeId, type AgentDbAdapterConfig } from './bridge-client.js';

// Re-exported so every existing `from '../store/agentdb-adapter.js'` import
// of these three names keeps working unchanged — see bridge-client.ts's
// header for why they now live in their own dependency-free module (the
// real circular-import failure this avoids, discovered at runtime, not by
// tsc).
export { AgentDbBridgeError, callTool, type AgentDbAdapterConfig };

/**
 * Raised by persistIssue's Guard A/B (APPROVAL-GATE.md §3) when a write
 * would change approvalState without a matching, legal ApprovalTransition,
 * or would change budgetImpact after the issue has left 'draft'. Subclasses
 * AgentDbBridgeError so callers that already catch that still see it.
 */
export class ApprovalGateViolationError extends AgentDbBridgeError {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalGateViolationError';
  }
}

// --- Keying (DOMAIN-MODEL.md §2.2) ---------------------------------------
// assertSafeId now lives in bridge-client.ts (imported above) so every
// module building an AgentDB key/node-id shares the same guard — see that
// file's header comment for the collision class this closes.

export function companyKey(companyId: string): string {
  assertSafeId(companyId, 'companyId');
  return `ruclip:company:${companyId}`;
}
export function orgMemberKey(companyId: string, orgMemberId: string): string {
  assertSafeId(companyId, 'companyId');
  assertSafeId(orgMemberId, 'orgMemberId');
  return assertKeyFits(`ruclip:company:${companyId}:org-member:${orgMemberId}`);
}
export function goalKey(companyId: string, goalId: string): string {
  assertSafeId(companyId, 'companyId');
  assertSafeId(goalId, 'goalId');
  return assertKeyFits(`ruclip:company:${companyId}:goal:${goalId}`);
}
export function issueKey(companyId: string, goalId: string, issueId: string): string {
  assertSafeId(companyId, 'companyId');
  assertSafeId(goalId, 'goalId');
  assertSafeId(issueId, 'issueId');
  return assertKeyFits(`ruclip:company:${companyId}:goal:${goalId}:issue:${issueId}`);
}
/**
 * The bridge's hierarchical store rejects keys longer than this (observed live:
 * `{"success": false, "error": "key exceeds 128 characters"}` inside a non-error
 * result). Nesting comment/approval-transition/heartbeat keys under
 * company→goal→issue crossed it with ordinary ids, so those three are keyed at
 * company level; the record itself carries goalId/issueId/target for scoping.
 */
export const MAX_AGENTDB_KEY_LENGTH = 128;
function assertKeyFits(key: string): string {
  if (key.length > MAX_AGENTDB_KEY_LENGTH) {
    throw new AgentDbBridgeError(
      `AgentDB key exceeds ${MAX_AGENTDB_KEY_LENGTH} characters (${key.length}): '${key}' — shorten the ids`,
    );
  }
  return key;
}
export function commentKey(companyId: string, _goalId: string, _issueId: string, commentId: string): string {
  assertSafeId(commentId, 'commentId');
  return assertKeyFits(`${companyKey(companyId)}:comment:${commentId}`);
}
export function approvalTransitionKey(
  companyId: string,
  _goalId: string,
  _issueId: string,
  transitionId: string,
): string {
  assertSafeId(transitionId, 'transitionId');
  return assertKeyFits(`${companyKey(companyId)}:approval-transition:${transitionId}`);
}
/** HEARTBEATS-AND-COMMS.md §1 keying — company-scoped; the schedule's `target` carries goal/issue. */
export function heartbeatKey(companyId: string, target: HeartbeatTarget, heartbeatId: string): string {
  assertSafeId(heartbeatId, 'heartbeatId');
  if (target.kind === 'issue') {
    assertSafeId(target.issueId, 'issueId');
  }
  assertSafeId(target.goalId, 'goalId');
  return assertKeyFits(`${companyKey(companyId)}:heartbeat:${heartbeatId}`);
}

/** AUTOGENOUS-RUNTIME-GOVERNANCE.md §6 keying — mirrors heartbeatKey's company-scoped nesting. */
export function autogenousMutationKey(companyId: string, mutationId: string): string {
  assertSafeId(mutationId, 'mutationId');
  return `${companyKey(companyId)}:autogenous-mutation:${mutationId}`;
}

/** ADR-130 domain-prefixed node id for causal-edge / graph-query calls. */
function entityNodeId(kind: 'company' | 'org-member' | 'goal' | 'issue' | 'heartbeat', id: string): string {
  assertSafeId(id, 'id');
  return `entity:${kind}:${id}`;
}

/** DOMAIN-MODEL.md §2.1 — an issue's tier is derived from its status. */
export function tierForIssueStatus(status: Issue['status']): MemoryTier {
  return status === 'done' || status === 'cancelled' ? 'episodic' : 'working';
}

// --- Generic hierarchical-store wrappers ----------------------------------

async function storeAtTier(
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

/**
 * The bridge reports some failures (key too long, backend refusal) as
 * `{ success: false, error }` inside an ordinary result, not as a JSON-RPC
 * error — so a write can "succeed" while nothing is stored. Treat that as
 * a failure here, once, for every store/delete.
 */
function assertToolSucceeded(tool: string, key: string, result: { success?: boolean; error?: string } | null | undefined): void {
  if (result && result.success === false) {
    throw new AgentDbBridgeError(`AgentDB tool '${tool}' refused key '${key}': ${result.error ?? 'unknown error'}`);
  }
}

async function deleteFromTier(key: string, tier: MemoryTier, config?: AgentDbAdapterConfig): Promise<void> {
  const result = await callTool<{ success?: boolean; error?: string }>('agentdb_hierarchical-delete', { key, tier }, config);
  assertToolSucceeded('agentdb_hierarchical-delete', key, result);
}

/**
 * Recall by exact key. agentdb_hierarchical-recall is a semantic/BM25 search
 * over `query`, not an exact-key get — we search with the key as the query
 * and defensively keep only a result whose own key matches exactly.
 */
const RECALL_BY_KEY_PAGE_SIZES = [200, 1000] as const;

async function recallByKey<T>(
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

// --- Causal edges (DOMAIN-MODEL.md §2.3) ----------------------------------

const CYCLE_CHECKED_RELATIONS: readonly CausalRelation[] = ['parent_of', 'reports_to'];

/**
 * Deterministic k-hop reachability check (see file header for why this
 * replaces the domain model's graph-pathfinder suggestion). Returns true if
 * `candidateSourceId` is reachable from `candidateTargetId` by following
 * `relation` edges — i.e. adding `candidateSourceId -> candidateTargetId`
 * would close a cycle.
 */
async function wouldCreateCycle(
  candidateSourceId: string,
  candidateTargetId: string,
  relation: CausalRelation,
  config?: AgentDbAdapterConfig,
): Promise<boolean> {
  const result = await callTool<{ nodes?: Array<{ id: string }> }>(
    'agentdb_graph-query',
    { nodeId: candidateTargetId, mode: 'k-hop', relation, depth: 5 },
    config,
  );
  return (result.nodes ?? []).some((n) => n.id === candidateSourceId);
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

/** k-hop neighbors of `nodeId` following `relation`, one hop, as raw entity ids. */
async function graphNeighbors(
  nodeId: string,
  relation: CausalRelation,
  config?: AgentDbAdapterConfig,
): Promise<string[]> {
  const result = await callTool<{ nodes?: Array<{ id: string }> }>(
    'agentdb_graph-query',
    { nodeId, mode: 'k-hop', relation, depth: 1 },
    config,
  );
  return (result.nodes ?? []).map((n) => n.id);
}

// --- Company ---------------------------------------------------------------

export async function persistCompany(company: Company, config?: AgentDbAdapterConfig): Promise<void> {
  assertValidCompany(company);
  await storeAtTier(companyKey(company.id), company, 'semantic', config);
}

export async function recallCompany(companyId: string, config?: AgentDbAdapterConfig): Promise<Company | null> {
  return recallByKey<Company>(companyKey(companyId), 'semantic', config);
}

// --- OrgMember ---------------------------------------------------------------

export async function persistOrgMember(member: OrgMember, config?: AgentDbAdapterConfig): Promise<void> {
  assertValidOrgMember(member);
  await storeAtTier(orgMemberKey(member.companyId, member.id), member, 'semantic', config);
  if (member.managerId) {
    await recordCausalEdge(
      entityNodeId('org-member', member.id),
      entityNodeId('org-member', member.managerId),
      'reports_to',
      config,
    );
  }
}

export async function recallOrgMember(
  companyId: string,
  orgMemberId: string,
  config?: AgentDbAdapterConfig,
): Promise<OrgMember | null> {
  return recallByKey<OrgMember>(orgMemberKey(companyId, orgMemberId), 'semantic', config);
}

// --- Goal ---------------------------------------------------------------

export async function persistGoal(goal: Goal, config?: AgentDbAdapterConfig): Promise<void> {
  assertValidGoal(goal);
  await storeAtTier(goalKey(goal.companyId, goal.id), goal, 'semantic', config);
  await recordCausalEdge(entityNodeId('goal', goal.id), entityNodeId('company', goal.companyId), 'belongs_to', config);
}

export async function recallGoal(
  companyId: string,
  goalId: string,
  config?: AgentDbAdapterConfig,
): Promise<Goal | null> {
  return recallByKey<Goal>(goalKey(companyId, goalId), 'semantic', config);
}

/**
 * Broad, client-side-filtered scan of every persisted Goal for a company —
 * RUCLIP-DASHBOARD.md §1's real gap (no existing primitive lists Goals
 * scoped to a company; only exact-id `recallGoal` existed). Follows
 * `listApprovalTransitionsForCompany`'s exact established pattern: a
 * `agentdb_hierarchical-recall` text query over the tier Goals actually
 * live in (`semantic`, per `persistGoal`), `topK: 200`, skip malformed
 * entries rather than fail the whole scan. Same "list broadly, filter
 * client-side" trade-off, same not-exhaustive-at-large-scale caveat — see
 * that function's own header comment.
 */
export async function listGoalsForCompany(companyId: string, config?: AgentDbAdapterConfig): Promise<Goal[]> {
  assertSafeId(companyId, 'companyId');
  const result = await callTool<{ results?: Array<{ value?: string }> }>(
    'agentdb_hierarchical-recall',
    { query: `ruclip:company:${companyId} goal`, tier: 'semantic', topK: 200 },
    config,
  );
  const goals: Goal[] = [];
  for (const r of result.results ?? []) {
    if (typeof r.value !== 'string') continue;
    try {
      const parsed = JSON.parse(r.value) as Partial<Goal>;
      if (parsed && typeof parsed.id === 'string' && parsed.companyId === companyId) {
        goals.push(parsed as Goal);
      }
    } catch {
      // skip malformed entries rather than fail the whole scan
    }
  }
  return goals;
}

// --- Issue ---------------------------------------------------------------

/**
 * Guard A (APPROVAL-GATE.md §3): approvalState may not change without a
 * matching, re-validated ApprovalTransition. Throws ApprovalGateViolationError
 * on any mismatch; makes no writes (called before persistIssue's first write).
 */
function checkApprovalStateGuard(
  issue: Issue,
  stored: Issue | null,
  approvalTransition: ApprovalTransition | undefined,
): void {
  if (stored === null) {
    if (approvalTransition !== undefined) {
      throw new ApprovalGateViolationError(
        `New issue '${issue.id}' must not be created with an approvalTransition supplied — there is no prior ` +
          `state for a transition to move from`,
      );
    }
    if (issue.approvalTransitionRef !== null) {
      throw new ApprovalGateViolationError(
        `New issue '${issue.id}' must not carry an approvalTransitionRef (got '${issue.approvalTransitionRef}')`,
      );
    }
    const isDraftDefault = issue.approvalState === 'draft';
    const isZeroBudgetFastPath = issue.approvalState === 'approved' && issue.budgetImpact === 0;
    if (!isDraftDefault && !isZeroBudgetFastPath) {
      throw new ApprovalGateViolationError(
        `New issue '${issue.id}' must start with approvalState 'draft', or 'approved' with budgetImpact === 0 ` +
          `(got approvalState '${issue.approvalState}' with budgetImpact ${issue.budgetImpact})`,
      );
    }
    return;
  }

  if (issue.approvalState === stored.approvalState) {
    if (approvalTransition !== undefined) {
      throw new ApprovalGateViolationError(
        `Issue '${issue.id}' approvalState is unchanged ('${issue.approvalState}') but an approvalTransition was supplied`,
      );
    }
    if (issue.approvalTransitionRef !== stored.approvalTransitionRef) {
      throw new ApprovalGateViolationError(
        `Issue '${issue.id}' approvalState is unchanged but approvalTransitionRef changed from ` +
          `'${stored.approvalTransitionRef}' to '${issue.approvalTransitionRef}'`,
      );
    }
    return;
  }

  if (!approvalTransition) {
    throw new ApprovalGateViolationError(
      `Issue '${issue.id}' approvalState changed from '${stored.approvalState}' to '${issue.approvalState}' ` +
        `but no approvalTransition was supplied`,
    );
  }
  if (approvalTransition.issueId !== issue.id) {
    throw new ApprovalGateViolationError(
      `approvalTransition.issueId '${approvalTransition.issueId}' does not match issue '${issue.id}'`,
    );
  }
  if (approvalTransition.fromState !== stored.approvalState) {
    throw new ApprovalGateViolationError(
      `approvalTransition.fromState '${approvalTransition.fromState}' does not match stored approvalState '${stored.approvalState}'`,
    );
  }
  if (approvalTransition.toState !== issue.approvalState) {
    throw new ApprovalGateViolationError(
      `approvalTransition.toState '${approvalTransition.toState}' does not match issue.approvalState '${issue.approvalState}'`,
    );
  }
  if (approvalTransition.id !== issue.approvalTransitionRef) {
    throw new ApprovalGateViolationError(
      `Issue '${issue.id}' approvalTransitionRef '${issue.approvalTransitionRef}' does not point at the supplied ` +
        `approvalTransition '${approvalTransition.id}'`,
    );
  }
  if (!isLegalApprovalTransition(approvalTransition.action, approvalTransition.fromState, approvalTransition.toState)) {
    throw new ApprovalGateViolationError(
      `approvalTransition (${approvalTransition.action}: ${approvalTransition.fromState} -> ${approvalTransition.toState}) ` +
        `is not a legal transition — forged or corrupted ApprovalTransition object`,
    );
  }
}

/**
 * Guard B (APPROVAL-GATE.md §3): budgetImpact is frozen once the stored
 * issue's approvalState has left 'draft'.
 */
function checkBudgetImpactFrozenGuard(issue: Issue, stored: Issue | null): void {
  if (stored !== null && stored.approvalState !== 'draft' && issue.budgetImpact !== stored.budgetImpact) {
    throw new ApprovalGateViolationError(
      `Issue '${issue.id}' budgetImpact is frozen once approvalState leaves 'draft' — stored approvalState is ` +
        `'${stored.approvalState}' with budgetImpact ${stored.budgetImpact}, write attempted ${issue.budgetImpact}`,
    );
  }
}

/**
 * Guard C (AUTHORIZATION.md §6, hardened further by
 * ACTOR-IDENTITY-VERIFICATION.md §5 item 2): closes the actor-forgery
 * vector Guard A leaves open — Guard A validates an ApprovalTransition's
 * shape but not whether the actorId inside it is genuine. No-op when
 * approvalTransition is undefined (no approval-state change this write,
 * nothing to authorize). Otherwise requires `authorization`, checks the
 * resolved actor matches the transition, re-verifies status: 'active'
 * against the PERSISTED OrgMember record (never a caller-supplied object —
 * recalled via recallOrgMember; a missing record is treated as
 * unauthorized, not as "trust the caller"), re-verifies the self-approval
 * invariant against the PERSISTED submit transition (never a
 * caller-supplied object — recalled via recallApprovalTransition), then
 * calls verifyActorHoldsClaim as the unforgeable external check.
 *
 * `authorization` accepts EITHER shape:
 * - `{ credential, admittedIssuerKeys }` — a raw ActorCredential, verified
 *   fresh right here via `resolveVerifiedActor` (consumes the credential's
 *   nonce). This is what a caller invoking persistIssue directly/standalone
 *   presents.
 * - `{ actor }` — an ALREADY-VERIFIED OrgMember, freshly recalled by
 *   another caller that already paid the `resolveVerifiedActor` cost. This
 *   is what `applyApprovalTransition` (persistIssue's only real production
 *   caller) passes — see that function's own header comment for why: its
 *   own `resolveVerifiedActor` call already consumed the credential's
 *   nonce (single-use, §3), so Guard C re-verifying the SAME raw credential
 *   a second time would hit the replay guard and fail every legitimate
 *   approve/reject/submit. `docs/PLAN.md` §8 records this as the one
 *   necessary deviation from a literal reading of the design's §5 items
 *   1-2, which (read literally) would double-consume a single-use nonce.
 *
 * Security-hardening correction to AUTHORIZATION.md §6's original text
 * ("`authorization.actor.status === 'active'` — re-verified here
 * independently of `transitionApprovalState`'s own check"): checking the
 * field on the caller-supplied object is not actually re-verification of
 * anything — a caller can set that field to whatever they want, the same
 * way the pre-hardening Guard A create-path trusted a caller-supplied
 * approvalTransition. Confirmed exploitable in practice (an operator marks
 * an OrgMember 'inactive' in ruClip's own store expecting that to freeze
 * their approval authority; a caller who still knows their live claimant
 * string could keep approving by lying about `status` in the object handed
 * to Guard C). Ground truth now comes from a recall, matching how the
 * self-approval check below already treats its own input.
 */
async function checkAuthorizationGuard(
  companyId: string,
  issue: Issue,
  stored: Issue | null,
  approvalTransition: ApprovalTransition | undefined,
  authorization: { actor: OrgMember } | ActorAuthorization | undefined,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  if (approvalTransition === undefined) return;

  if (!authorization) {
    throw new ApprovalGateViolationError(
      `Issue '${issue.id}' approvalState change requires authorization to be supplied`,
    );
  }
  const actor = 'credential' in authorization ? await resolveVerifiedActor(authorization, config) : authorization.actor;
  // Security-hardening correction (security review round 7): mirrors
  // applyApprovalTransition's own `actor.companyId !== companyId` check
  // (added in this same slice). Without this, a credential verified for a
  // DIFFERENT company than `companyId` wasn't explicitly rejected here —
  // the subsequent recallOrgMember(companyId, actor.id, ...) below happens
  // to fail closed in that case (it looks the id up in the wrong company's
  // table and finds nothing), so this wasn't independently exploitable, but
  // leaving it implicit/incidental instead of an explicit check is the same
  // class of latent risk a future refactor of that recall could reopen —
  // made deliberate here, matching the sibling code path exactly.
  if ('credential' in authorization && actor.companyId !== companyId) {
    throw new ApprovalGateViolationError(
      `checkAuthorizationGuard: verified actor '${actor.id}' belongs to company '${actor.companyId}', not '${companyId}'`,
    );
  }
  if (actor.id !== approvalTransition.actorId) {
    throw new ApprovalGateViolationError(
      `authorization.actor.id '${actor.id}' does not match approvalTransition.actorId '${approvalTransition.actorId}'`,
    );
  }
  const persistedActor = await recallOrgMember(companyId, actor.id, config);
  if (!persistedActor) {
    throw new ApprovalGateViolationError(
      `Actor '${actor.id}' has no persisted OrgMember record in company '${companyId}' — an unknown actor cannot ` +
        `be authorized for an approval decision`,
    );
  }
  if (persistedActor.status !== 'active') {
    throw new ApprovalGateViolationError(
      `Actor '${actor.id}' cannot be authorized for an approval decision while status is '${persistedActor.status}' ` +
        `(re-verified against the persisted OrgMember record, not the caller-supplied authorization.actor object)`,
    );
  }

  if (
    (approvalTransition.action === 'approve' || approvalTransition.action === 'reject') &&
    stored?.approvalTransitionRef
  ) {
    const submitTransition = await recallApprovalTransition(
      companyId,
      issue.goalId,
      issue.id,
      stored.approvalTransitionRef,
      config,
    );
    if (submitTransition && submitTransition.actorId === actor.id) {
      throw new ClaimAuthorizationError(
        `Actor '${actor.id}' submitted issue '${issue.id}' for approval and cannot also ${approvalTransition.action} ` +
          `it (self-approval, verified against the persisted submit record — not a caller-supplied object)`,
      );
    }
  }

  await verifyActorHoldsClaim(issue.id, actor, config);
}

/**
 * Persist an issue at the tier its status implies. When `previousStatus` is
 * given and its tier differs from the new status's tier, the stale copy is
 * removed from the old tier in the same call — DOMAIN-MODEL.md §2.1's "an
 * issue's tier changes exactly once, in the write that closes it."
 *
 * Before any write, recalls the currently-stored issue and runs Guard A
 * (approvalState may not change without a matching, re-validated
 * ApprovalTransition), Guard B (budgetImpact is frozen once the issue
 * leaves 'draft') — APPROVAL-GATE.md §3 — and Guard C (the actor named in
 * the transition is genuine and currently holds the issue's claim per
 * ruflo's claims system) — AUTHORIZATION.md §6. All three throw and make
 * no writes on failure.
 */
export async function persistIssue(
  companyId: string,
  issue: Issue,
  previousStatus?: Issue['status'],
  approvalTransition?: ApprovalTransition,
  authorization?: { actor: OrgMember } | ActorAuthorization,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  assertValidIssue(issue);
  const stored = await recallIssue(companyId, issue.goalId, issue.id, config);
  checkApprovalStateGuard(issue, stored, approvalTransition);
  checkBudgetImpactFrozenGuard(issue, stored);
  await checkAuthorizationGuard(companyId, issue, stored, approvalTransition, authorization, config);

  const key = issueKey(companyId, issue.goalId, issue.id);
  const tier = tierForIssueStatus(issue.status);
  await storeAtTier(key, issue, tier, config);
  if (previousStatus) {
    const previousTier = tierForIssueStatus(previousStatus);
    if (previousTier !== tier) {
      await deleteFromTier(key, previousTier, config);
    }
  }
  await recordCausalEdge(entityNodeId('issue', issue.id), entityNodeId('goal', issue.goalId), 'belongs_to', config);
  if (issue.parentId) {
    await recordCausalEdge(
      entityNodeId('issue', issue.parentId),
      entityNodeId('issue', issue.id),
      'parent_of',
      config,
    );
  }
  if (issue.assigneeId) {
    await recordCausalEdge(
      entityNodeId('issue', issue.id),
      entityNodeId('org-member', issue.assigneeId),
      'assigned_to',
      config,
    );
  }
}

/** Looks in the working tier first (the common case), falling back to episodic for closed issues. */
export async function recallIssue(
  companyId: string,
  goalId: string,
  issueId: string,
  config?: AgentDbAdapterConfig,
): Promise<Issue | null> {
  const key = issueKey(companyId, goalId, issueId);
  return (
    (await recallByKey<Issue>(key, 'working', config)) ?? (await recallByKey<Issue>(key, 'episodic', config))
  );
}

/**
 * Broad, client-side-filtered scan of every persisted Issue for one Goal —
 * RUCLIP-DASHBOARD.md §1's real gap (no existing primitive lists Issues
 * scoped to a goal; only exact-id `recallIssue` existed). Follows
 * `listApprovalTransitionsForCompany`'s exact established pattern: scans
 * both tiers an Issue can live in (`tierForIssueStatus` — `working` while
 * open/in_progress/blocked, `episodic` once done/cancelled), `topK: 200`
 * per tier, skip malformed entries rather than fail the whole scan.
 */
export async function listIssuesForGoal(
  companyId: string,
  goalId: string,
  config?: AgentDbAdapterConfig,
): Promise<Issue[]> {
  assertSafeId(companyId, 'companyId');
  assertSafeId(goalId, 'goalId');
  const issues: Issue[] = [];
  for (const tier of ['working', 'episodic'] as const) {
    const result = await callTool<{ results?: Array<{ value?: string }> }>(
      'agentdb_hierarchical-recall',
      { query: `ruclip:company:${companyId}:goal:${goalId} issue`, tier, topK: 200 },
      config,
    );
    for (const r of result.results ?? []) {
      if (typeof r.value !== 'string') continue;
      try {
        const parsed = JSON.parse(r.value) as Partial<Issue>;
        if (parsed && typeof parsed.id === 'string' && parsed.goalId === goalId) {
          issues.push(parsed as Issue);
        }
      } catch {
        // skip malformed entries rather than fail the whole scan
      }
    }
  }
  return issues;
}

/** Parallel to recallIssue, keyed via approvalTransitionKey — used by Guard C to re-verify self-approval against persisted state. */
export async function recallApprovalTransition(
  companyId: string,
  goalId: string,
  issueId: string,
  transitionId: string,
  config?: AgentDbAdapterConfig,
): Promise<ApprovalTransition | null> {
  const key = approvalTransitionKey(companyId, goalId, issueId, transitionId);
  return (
    (await recallByKey<ApprovalTransition>(key, 'working', config)) ??
    (await recallByKey<ApprovalTransition>(key, 'episodic', config))
  );
}

/**
 * Broad, client-side-filtered scan of every persisted ApprovalTransition
 * record for a company — needed by
 * employee-augmentation/interaction-profile.ts's `recomputeInteractionSignals`
 * (EMPLOYEE-INTERACTION-PROFILE.md §4 step 2: "query ApprovalTransition
 * records where actorId === orgMemberId") to pair each actor's approve/
 * reject transition with the immediately-prior submit transition for the
 * SAME issueId, which may belong to a different actor — so a query scoped
 * to one actor alone isn't sufficient; the pairing needs the whole
 * per-issue transition history. Not named in the design doc's own file
 * list — added because no existing primitive supports "list all
 * transitions," matching the exact "list broadly,
 * filter client-side" pattern `listDueHeartbeats` already establishes for
 * the same reason (`agentdb_hierarchical-recall` is semantic search, not a
 * structured filter). Not exhaustive at large scale (topK caps results per
 * tier) — acceptable at this project's current scale, matching
 * `listDueHeartbeats`'s own documented limitation and
 * EMPLOYEE-INTERACTION-PROFILE.md §6 open item 3's explicit acceptance of
 * this trade-off.
 */
export async function listApprovalTransitionsForCompany(
  companyId: string,
  config?: AgentDbAdapterConfig,
): Promise<ApprovalTransition[]> {
  assertSafeId(companyId, 'companyId');
  const transitions: ApprovalTransition[] = [];
  for (const tier of ['working', 'episodic'] as const) {
    const result = await callTool<{ results?: Array<{ key?: string; value?: string }> }>(
      'agentdb_hierarchical-recall',
      { query: companyKey(companyId), tier, topK: 500 },
      config,
    );
    for (const r of result.results ?? []) {
      // A similarity query with extra words returned nothing on a real bridge;
      // the bare company prefix returns the company's records, filtered by key.
      if (typeof r.value !== 'string') continue;
      if (typeof r.key === 'string' && !r.key.includes(':approval-transition:')) continue;
      try {
        const parsed = JSON.parse(r.value) as Partial<ApprovalTransition>;
        if (parsed && typeof parsed.issueId === 'string' && typeof parsed.actorId === 'string' && typeof parsed.action === 'string') {
          transitions.push(parsed as ApprovalTransition);
        }
      } catch {
        // skip malformed entries rather than fail the whole scan
      }
    }
  }
  return transitions;
}

/**
 * Orchestrates one approval-state-machine step end to end (APPROVAL-GATE.md
 * §4, AUTHORIZATION.md §8): claims_* authorization choreography, THEN
 * computes the transition (pure, throws before any I/O if illegal),
 * optionally witnesses it, persists the ApprovalTransition record, records
 * the approved_by/rejected_by causal edge, then persists the updated Issue
 * through the hardened persistIssue (which re-validates via Guards A/B/C).
 * `deps.witness` is optional — when omitted, `transition.witnessRef` stays
 * null (a tracked gap, see schema/witness.ts and APPROVAL-GATE.md §5).
 *
 * ACTOR-IDENTITY-VERIFICATION.md §5 item 1: `actor: OrgMember` is now
 * `authorization: ActorAuthorization` — every action, including 'submit',
 * requires a pre-existing, cryptographically verified `ActorCredential`
 * rather than a caller-self-asserted `OrgMember` object. `resolveVerifiedActor`
 * is called exactly ONCE, here, at the very top, before any side effect —
 * both because a credential's nonce is single-use (§3 — verifying twice
 * would fail the second time) and because it must gate every consequential
 * action (claims_* mutations included), not just the final persist step.
 * The resolved `actor` is threaded through the rest of this function
 * exactly as the caller-supplied `actor` object was before, INCLUDING into
 * `persistIssue`'s Guard C as `{ actor }` (an already-verified OrgMember),
 * not as a second `{ credential, admittedIssuerKeys }` — passing the raw
 * credential again would re-verify (and re-consume) the same nonce and
 * fail every legitimate call. `docs/PLAN.md` §8 records this as a
 * necessary deviation from a literal reading of the design's §5 items 1-2,
 * found while implementing, not decided silently.
 */
export async function applyApprovalTransition(
  companyId: string,
  issue: Issue,
  action: ApprovalAction,
  authorization: ActorAuthorization,
  previousTransition: ApprovalTransition | null,
  deps: {
    witness?: WitnessHook;
    notifications?: NotificationChannel;
    reason?: string;
    approver?: OrgMember;
    handoffTo?: OrgMember;
    interactionLearning?: boolean;
  },
  config?: AgentDbAdapterConfig,
): Promise<{ issue: Issue; transition: ApprovalTransition }> {
  const actor = await resolveVerifiedActor(authorization, config);
  if (actor.companyId !== companyId) {
    throw new ClaimAuthorizationError(
      `applyApprovalTransition: verified actor '${actor.id}' belongs to company '${actor.companyId}', not '${companyId}'`,
    );
  }

  // AUTHORIZATION.md §8 steps 1-2 — authorization choreography runs BEFORE
  // any state-machine computation, so a failure here short-circuits before
  // transitionApprovalState is ever called.
  if (action === 'approve' || action === 'reject' || action === 'revise') {
    await acceptClaimHandoff(issue.id, actor, config);
  }
  if (action === 'submit') {
    if (!deps.approver) {
      throw new ClaimAuthorizationError(`applyApprovalTransition: action 'submit' requires deps.approver`);
    }
    await handoffClaim(issue.id, actor, deps.approver, { reason: deps.reason, progress: 100 }, config);
  }

  const { nextIssue, transition } = transitionApprovalState(issue, action, actor, previousTransition, {
    reason: deps.reason,
  });

  if (deps.witness) {
    const ref = await deps.witness.record({
      subject: `issue:${issue.id}:approval-transition:${transition.id}`,
      eventType: 'ruclip.issue.approval_transition',
      payload: {
        issueId: transition.issueId,
        action: transition.action,
        fromState: transition.fromState,
        toState: transition.toState,
        actorId: transition.actorId,
        reason: transition.reason,
        createdAt: transition.createdAt,
      },
      occurredAt: transition.createdAt,
    });
    transition.witnessRef = ref.id;
  }

  assertValidApprovalTransition(transition);
  await storeAtTier(
    approvalTransitionKey(companyId, issue.goalId, issue.id, transition.id),
    transition,
    tierForIssueStatus(nextIssue.status),
    config,
  );

  if (action === 'approve' || action === 'reject') {
    const relation: CausalRelation = action === 'approve' ? 'approved_by' : 'rejected_by';
    await recordCausalEdge(entityNodeId('issue', issue.id), entityNodeId('org-member', actor.id), relation, config);
  }

  await persistIssue(companyId, nextIssue, issue.status, transition, { actor }, config);

  // EMPLOYEE-INTERACTION-PROFILE.md §4 — best-effort, same non-blocking
  // contract deps.notifications already has: a failure here must never
  // fail the approval decision itself. Default false/omitted — existing
  // callers are unaffected.
  if (deps.interactionLearning && (action === 'approve' || action === 'reject')) {
    await recomputeInteractionSignals(companyId, actor.id, config).catch(() => {});
  }

  // HEARTBEATS-AND-COMMS.md §5 — best-effort; a lost/degraded notification
  // must never fail an approval decision that already succeeded on its own
  // terms, so publish failures are swallowed, not propagated.
  if (deps.notifications) {
    await deps.notifications
      .publish({
        kind: 'issue-approval-transition',
        companyId,
        subjectRef: `issue:${issue.id}`,
        payload: {
          issueId: issue.id,
          action,
          fromState: transition.fromState,
          toState: transition.toState,
          actorId: actor.id,
        },
        occurredAt: transition.createdAt,
      })
      .catch(() => {});
  }

  // AUTHORIZATION.md §8 step 6 — hand the claim back to the original
  // submitter after a legal reject, so they can accept and later revise.
  if (action === 'reject') {
    if (!deps.handoffTo) {
      throw new ClaimAuthorizationError(`applyApprovalTransition: action 'reject' requires deps.handoffTo`);
    }
    await handoffClaim(issue.id, actor, deps.handoffTo, { reason: 'returned for revision' }, config);
  }

  return { issue: nextIssue, transition };
}

/** DOMAIN-MODEL.md §1.4 `blocks` edge — no cycle check (blocking isn't a tree relation). */
export async function addBlocksEdge(
  blockerIssueId: string,
  blockedIssueId: string,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  await recordCausalEdge(entityNodeId('issue', blockerIssueId), entityNodeId('issue', blockedIssueId), 'blocks', config);
}

/** Issue ids of open blockers pointing at `issueId` — feeds the §1.4 progress-gate invariant (enforced downstream). */
export async function getBlockerIssueIds(issueId: string, config?: AgentDbAdapterConfig): Promise<string[]> {
  const neighbors = await graphNeighbors(entityNodeId('issue', issueId), 'blocks', config);
  return neighbors
    .filter((id) => id.startsWith('entity:issue:'))
    .map((id) => id.slice('entity:issue:'.length));
}

/** Child issue ids — derived via `parent_of`, never stored on the Issue document (DOMAIN-MODEL.md §1.4). */
export async function getChildIssueIds(issueId: string, config?: AgentDbAdapterConfig): Promise<string[]> {
  const neighbors = await graphNeighbors(entityNodeId('issue', issueId), 'parent_of', config);
  return neighbors
    .filter((id) => id.startsWith('entity:issue:'))
    .map((id) => id.slice('entity:issue:'.length));
}

// --- Comment ---------------------------------------------------------------

/** Comments are stored at their parent issue's current tier (DOMAIN-MODEL.md §2.1). */
export async function persistComment(
  companyId: string,
  goalId: string,
  comment: Comment,
  issueTier: MemoryTier,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  assertValidComment(comment);
  await storeAtTier(commentKey(companyId, goalId, comment.issueId, comment.id), comment, issueTier, config);
}

// --- HeartbeatSchedule (HEARTBEATS-AND-COMMS.md §1, §6) --------------------

/** HEARTBEATS-AND-COMMS.md §1 §2.1-style tier rule: working while active/paused, episodic once cancelled. */
function tierForHeartbeatStatus(status: HeartbeatStatus): MemoryTier {
  return status === 'cancelled' ? 'episodic' : 'working';
}

/**
 * Persists a HeartbeatSchedule. `actor` is required for the three
 * actor-driven lifecycle operations HEARTBEATS-AND-COMMS.md §6 names
 * (create/pause/resume) — when supplied, reuses verifyActorHoldsClaim
 * exactly like persistIssue's Guard C, checked against the target Issue's
 * claim (there is no claims concept for a bare Goal in ruflo's claims
 * system, so a `target.kind === 'goal'` schedule has nothing to check
 * against and the claim check is skipped for that case). `actor` is
 * omitted by fireHeartbeat's own bookkeeping write (§3 step 5) — firing is
 * system-initiated cadence upkeep, not an actor-requested lifecycle change,
 * so it is not one of the three operations §6 requires authorization for.
 *
 * Security-hardening correction (security review round 4): the original
 * version of this function made `actor` unconditionally optional, with
 * nothing distinguishing a genesis create (one of the three operations §6
 * requires authorization for) from fireHeartbeat's legitimate no-actor
 * re-persist of an ALREADY-EXISTING schedule. A caller could create a
 * brand-new schedule with no actor and no live claim check at all —
 * confirmed exploitable by an independent test
 * (tests/control-plane/heartbeats-authorization-gaps.test.ts). Fixed the
 * same way the pre-de48670 Guard A create-path bug was: recall the
 * currently-stored schedule first; a `null` result means this write is a
 * genesis create, which now hard-requires `actor` (mirroring Guard A's
 * `stored === null` create-path convention in persistIssue). fireHeartbeat
 * never creates — it only ever re-persists a schedule it just recalled to
 * fire — so this does not affect its no-actor bookkeeping writes.
 *
 * Also recalls the target (Issue or Goal) and rejects a
 * `target.issueId`'s `goalId` mismatch against the real stored Issue,
 * mirroring how persistIssue already recalls state before writing (§1's
 * invariant).
 *
 * ACTOR-IDENTITY-VERIFICATION.md §5 item 4: `actor?: OrgMember` is now
 * `authorization?: ActorAuthorization` — `verifyActorHoldsClaim` stays as
 * the claim-ownership check (a different, still-valid question); resolving
 * `authorization` via `resolveVerifiedActor` happens first, so the full
 * chain is "verify the caller really is this OrgMember, then verify that
 * OrgMember holds the claim" instead of just the second half. This is the
 * only verification point in this function (unlike applyApprovalTransition,
 * nothing downstream re-verifies the same credential), so no
 * nonce-double-consumption concern applies here.
 */
export async function persistHeartbeatSchedule(
  schedule: HeartbeatSchedule,
  authorization?: ActorAuthorization,
  previousStatus?: HeartbeatStatus,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  assertValidHeartbeatSchedule(schedule);

  const stored = await recallHeartbeatSchedule(schedule.companyId, schedule.target, schedule.id, config);
  if (stored === null && !authorization) {
    throw new ApprovalGateViolationError(
      `Creating HeartbeatSchedule '${schedule.id}' requires an acting OrgMember (HEARTBEATS-AND-COMMS.md §6) — ` +
        `authorization was not supplied`,
    );
  }
  // Security-hardening correction (security review round 7): the create-only
  // check above left every UPDATE (pause or resume of an existing schedule)
  // fully unauthenticated — `authorization` was optional with nothing
  // requiring it. fireHeartbeat's own legitimate no-authorization writes
  // only ever fire (status unchanged) or auto-pause on a budget block
  // (active -> paused); it never resumes a schedule (HEARTBEATS-AND-COMMS.md
  // §3 step 2 — "a human must explicitly resume"). A resume (paused ->
  // active) is therefore unambiguously one of the three actor-driven
  // operations HEARTBEATS-AND-COMMS.md §6 / ACTOR-IDENTITY-VERIFICATION.md
  // §5 item 4 require authorization for, and is now enforced — confirmed
  // exploitable (zero authorization needed to resume) by an independent
  // test. An actor-initiated PAUSE (active -> paused) remains genuinely
  // ambiguous with fireHeartbeat's own system pause at the parameter level —
  // both are the identical transition with no discriminant between "budget
  // gate paused this" and "an actor asked to pause this" — closing that
  // specific case needs a design decision (e.g. an explicit pause-source
  // parameter), not a mechanical fix, so it stays open, same disposition as
  // before this round.
  if (stored !== null && stored.status === 'paused' && schedule.status === 'active' && !authorization) {
    throw new ApprovalGateViolationError(
      `Resuming HeartbeatSchedule '${schedule.id}' requires an acting OrgMember (HEARTBEATS-AND-COMMS.md §6) — ` +
        `authorization was not supplied`,
    );
  }
  const actor = authorization ? await resolveVerifiedActor(authorization, config) : undefined;
  if (actor && actor.companyId !== schedule.companyId) {
    throw new ApprovalGateViolationError(
      `persistHeartbeatSchedule: verified actor '${actor.id}' belongs to company '${actor.companyId}', not ` +
        `'${schedule.companyId}'`,
    );
  }

  let targetNodeId: string;
  if (schedule.target.kind === 'issue') {
    const issue = await recallIssue(schedule.companyId, schedule.target.goalId, schedule.target.issueId, config);
    if (!issue) {
      throw new ApprovalGateViolationError(
        `HeartbeatSchedule '${schedule.id}' targets issue '${schedule.target.issueId}' which does not exist`,
      );
    }
    if (issue.goalId !== schedule.target.goalId) {
      throw new ApprovalGateViolationError(
        `HeartbeatSchedule '${schedule.id}' target.goalId '${schedule.target.goalId}' does not match the target ` +
          `issue's actual goalId '${issue.goalId}'`,
      );
    }
    if (actor) {
      await verifyActorHoldsClaim(schedule.target.issueId, actor, config);
    }
    targetNodeId = entityNodeId('issue', schedule.target.issueId);
  } else {
    const goal = await recallGoal(schedule.companyId, schedule.target.goalId, config);
    if (!goal) {
      throw new ApprovalGateViolationError(
        `HeartbeatSchedule '${schedule.id}' targets goal '${schedule.target.goalId}' which does not exist`,
      );
    }
    targetNodeId = entityNodeId('goal', schedule.target.goalId);
  }

  const key = heartbeatKey(schedule.companyId, schedule.target, schedule.id);
  const tier = tierForHeartbeatStatus(schedule.status);
  await storeAtTier(key, schedule, tier, config);
  if (previousStatus) {
    const previousTier = tierForHeartbeatStatus(previousStatus);
    if (previousTier !== tier) {
      await deleteFromTier(key, previousTier, config);
    }
  }
  await recordCausalEdge(entityNodeId('heartbeat', schedule.id), targetNodeId, 'belongs_to', config);
}

export async function recallHeartbeatSchedule(
  companyId: string,
  target: HeartbeatTarget,
  heartbeatId: string,
  config?: AgentDbAdapterConfig,
): Promise<HeartbeatSchedule | null> {
  const key = heartbeatKey(companyId, target, heartbeatId);
  return (
    (await recallByKey<HeartbeatSchedule>(key, 'working', config)) ??
    (await recallByKey<HeartbeatSchedule>(key, 'episodic', config))
  );
}

/**
 * "All active schedules with nextFireAt <= now" is a range/scan query —
 * neither an exact-key recall nor a k-hop graph walk covers that shape
 * (HEARTBEATS-AND-COMMS.md §7's flagged open question).
 * `agentdb_hierarchical-recall` is semantic/BM25 search over `query`, not a
 * structured filter, so this overfetches via a broad query against the
 * `working` tier (schedules are always `working` while `active`, per
 * `tierForHeartbeatStatus`) and filters `status`/`nextFireAt` client-side —
 * same "list broadly, filter client-side" pattern `recallByKey` already
 * uses for exact-key matching, and the same shape `budget.mjs`'s own
 * `loadSessions` uses. Not exhaustive at large scale (topK caps how much a
 * single semantic search returns) — acceptable at this project's current
 * scale per the design doc, not a guarantee for a large heartbeat count.
 */
export async function listDueHeartbeats(companyId: string, config?: AgentDbAdapterConfig): Promise<HeartbeatSchedule[]> {
  assertSafeId(companyId, 'companyId');
  const nowIso = new Date().toISOString();
  const result = await callTool<{ results?: Array<{ value?: string }> }>(
    'agentdb_hierarchical-recall',
    { query: `ruclip:company:${companyId} heartbeat`, tier: 'working', topK: 100 },
    config,
  );
  const schedules: HeartbeatSchedule[] = [];
  for (const r of result.results ?? []) {
    if (typeof r.value !== 'string') continue;
    try {
      const parsed = JSON.parse(r.value) as HeartbeatSchedule;
      if (parsed && parsed.companyId === companyId) {
        schedules.push(parsed);
      }
    } catch {
      // skip malformed entries rather than fail the whole scan
    }
  }
  return schedules.filter((s) => s.status === 'active' && s.nextFireAt <= nowIso);
}

/**
 * RUCLIP-DASHBOARD.md §5 deviation, found while implementing, not silently
 * skipped: the design's §1 claims `listDueHeartbeats` "supplies heartbeat
 * status directly — no gap there," but that function's own client-side
 * filter (`status === 'active' && nextFireAt <= now`) actively EXCLUDES a
 * `status: 'paused'` schedule — exactly the state `fireHeartbeat`'s
 * `pauseAndPersist` sets on `application_budget_blocked`/
 * `operating_budget_blocked` (`heartbeat/fire-heartbeat.ts`). §2's own
 * requirement ("blocked outcomes shown plainly, not hidden") is directly
 * contradicted by reusing `listDueHeartbeats` as literally instructed — the
 * single most dashboard-relevant heartbeat state (a currently-blocked one)
 * would silently never appear. This broader listing exists for that reason:
 * every heartbeat for a company regardless of status or due-ness, scanning
 * both tiers a schedule can live in (`tierForHeartbeatStatus` — `working`
 * while active/paused, `episodic` once cancelled). `listDueHeartbeats`
 * itself is untouched (still used by whatever actually fires heartbeats) —
 * this is a new, separate function, not a refactor of it.
 */
export async function listHeartbeatsForCompany(
  companyId: string,
  config?: AgentDbAdapterConfig,
): Promise<HeartbeatSchedule[]> {
  assertSafeId(companyId, 'companyId');
  const schedules: HeartbeatSchedule[] = [];
  for (const tier of ['working', 'episodic'] as const) {
    const result = await callTool<{ results?: Array<{ value?: string }> }>(
      'agentdb_hierarchical-recall',
      { query: `ruclip:company:${companyId} heartbeat`, tier, topK: 100 },
      config,
    );
    for (const r of result.results ?? []) {
      if (typeof r.value !== 'string') continue;
      try {
        const parsed = JSON.parse(r.value) as Partial<HeartbeatSchedule>;
        if (parsed && typeof parsed.id === 'string' && parsed.companyId === companyId) {
          schedules.push(parsed as HeartbeatSchedule);
        }
      } catch {
        // skip malformed entries rather than fail the whole scan
      }
    }
  }
  return schedules;
}

// --- Operating-spend circuit breaker (HEARTBEATS-AND-COMMS.md §4, Finding C) -
// Extracted to ./operating-budget.ts (2026-09-02, architecture rotation) —
// see that module's header for why. Re-exported so every existing
// `from '../store/agentdb-adapter.js'` import of these names keeps working
// unchanged, the same technique bridge-client.ts's own extraction already
// established for this file.
export {
  type OperatingBudgetLevel,
  type OperatingBudgetThresholds,
  type OperatingBudgetConfig,
  DEFAULT_OPERATING_BUDGET_THRESHOLDS,
  setOperatingBudget,
  operatingBudgetLevel,
  checkOperatingBudget,
} from './operating-budget.js';

// --- Pattern-store (DOMAIN-MODEL.md §2.4) -----------------------------------

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

// --- Autogenous runtime governance audit trail (AUTOGENOUS-RUNTIME-GOVERNANCE.md §6) ---

/**
 * ruClip's own audit record for one proposed Autogenous mutation —
 * persisted the same way ApprovalTransition/HeartbeatSchedule already are.
 * `controller` is null until `/v1/canary/new` succeeds. `observations` is
 * append-only; each entry's `decision` is the real, externally-tagged
 * `Decision` the service returned for that observation, not a paraphrase.
 * `controller.audit` (copied verbatim on every update) is the service's own
 * signed promotion/rollback log — this record does not invent a second
 * witness mechanism, it durably stores the authoritative one (§6).
 */
export interface AutogenousMutationRecord {
  id: string; // == mutation.id
  companyId: string;
  mutation: Mutation;
  parentGenome: Genome;
  admitResponse: AdmitResponse;
  controller: CanaryController | null;
  observations: Array<{ at: string; fitness: FitnessVector; decision: Decision }>;
  createdAt: string;
  updatedAt: string;
}

/** Single tier ('working') for the whole record lifecycle — this is a low-volume governance/audit entity, not a high-churn one like Issue, so no tier-migration rule is needed (none is specified by the design). */
export async function persistAutogenousMutationRecord(
  record: AutogenousMutationRecord,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  await storeAtTier(autogenousMutationKey(record.companyId, record.id), record, 'working', config);
}

export async function recallAutogenousMutationRecord(
  companyId: string,
  mutationId: string,
  config?: AgentDbAdapterConfig,
): Promise<AutogenousMutationRecord | null> {
  return recallByKey<AutogenousMutationRecord>(autogenousMutationKey(companyId, mutationId), 'working', config);
}
