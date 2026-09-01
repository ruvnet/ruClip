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
import type { CausalRelation, MemoryTier } from '../schema/enums.js';
import {
  assertValidCompany,
  assertValidOrgMember,
  assertValidGoal,
  assertValidIssue,
  assertValidComment,
  assertValidApprovalTransition,
} from '../schema/validation.js';
import { transitionApprovalState, isLegalApprovalTransition } from '../approval/transition-approval-state.js';
import {
  verifyActorHoldsClaim,
  handoffClaim,
  acceptClaimHandoff,
  ClaimAuthorizationError,
} from '../authorization/claims-authorization.js';
import { AgentDbBridgeError, callTool, type AgentDbAdapterConfig } from './bridge-client.js';

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

/**
 * Keys/node-ids below are built by string-concatenating caller-supplied ids
 * into `:`-delimited templates, and recallByKey does exact-string matching
 * on the result. An id containing a template's own delimiter (":goal:",
 * ":issue:", "entity:issue:", etc.) can make two semantically different id
 * tuples serialize to the identical key/node-id string, letting a crafted id
 * collide with — and overwrite or be confused with — a different entity's
 * record or graph node. assertValid* in schema/validation.ts blocks unsafe
 * ids on entity write paths; this guard covers the id-only functions below
 * (recall, causal-edge, graph-neighbor lookups) that never go through an
 * assertValid* call.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new AgentDbBridgeError(`Refusing to build an AgentDB key/node-id from unsafe ${label} '${value}'`);
  }
}

export function companyKey(companyId: string): string {
  assertSafeId(companyId, 'companyId');
  return `ruclip:company:${companyId}`;
}
export function orgMemberKey(companyId: string, orgMemberId: string): string {
  assertSafeId(companyId, 'companyId');
  assertSafeId(orgMemberId, 'orgMemberId');
  return `ruclip:company:${companyId}:org-member:${orgMemberId}`;
}
export function goalKey(companyId: string, goalId: string): string {
  assertSafeId(companyId, 'companyId');
  assertSafeId(goalId, 'goalId');
  return `ruclip:company:${companyId}:goal:${goalId}`;
}
export function issueKey(companyId: string, goalId: string, issueId: string): string {
  assertSafeId(companyId, 'companyId');
  assertSafeId(goalId, 'goalId');
  assertSafeId(issueId, 'issueId');
  return `ruclip:company:${companyId}:goal:${goalId}:issue:${issueId}`;
}
export function commentKey(companyId: string, goalId: string, issueId: string, commentId: string): string {
  assertSafeId(commentId, 'commentId');
  return `${issueKey(companyId, goalId, issueId)}:comment:${commentId}`;
}
export function approvalTransitionKey(
  companyId: string,
  goalId: string,
  issueId: string,
  transitionId: string,
): string {
  assertSafeId(transitionId, 'transitionId');
  return `${issueKey(companyId, goalId, issueId)}:approval-transition:${transitionId}`;
}

/** ADR-130 domain-prefixed node id for causal-edge / graph-query calls. */
function entityNodeId(kind: 'company' | 'org-member' | 'goal' | 'issue', id: string): string {
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
  await callTool('agentdb_hierarchical-store', { key, value: JSON.stringify(value), tier }, config);
}

async function deleteFromTier(key: string, tier: MemoryTier, config?: AgentDbAdapterConfig): Promise<void> {
  await callTool('agentdb_hierarchical-delete', { key, tier }, config);
}

/**
 * Recall by exact key. agentdb_hierarchical-recall is a semantic/BM25 search
 * over `query`, not an exact-key get — we search with the key as the query
 * and defensively keep only a result whose own key matches exactly.
 */
async function recallByKey<T>(
  key: string,
  tier: MemoryTier | undefined,
  config?: AgentDbAdapterConfig,
): Promise<T | null> {
  const result = await callTool<{ results?: Array<{ key?: string; id?: string; value?: string }> }>(
    'agentdb_hierarchical-recall',
    { query: key, tier, topK: 10 },
    config,
  );
  const match = (result.results ?? []).find((r) => r.key === key || r.id === key);
  if (!match || typeof match.value !== 'string') return null;
  try {
    return JSON.parse(match.value) as T;
  } catch {
    return null;
  }
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
 * Guard C (AUTHORIZATION.md §6): closes the actor-forgery vector Guard A
 * leaves open — Guard A validates an ApprovalTransition's shape but not
 * whether the actorId inside it is genuine. No-op when approvalTransition
 * is undefined (no approval-state change this write, nothing to
 * authorize). Otherwise requires `authorization`, checks the supplied actor
 * matches the transition and is active, re-verifies the self-approval
 * invariant against the PERSISTED submit transition (never a
 * caller-supplied object — recalled via recallApprovalTransition), then
 * calls verifyActorHoldsClaim as the unforgeable external check.
 */
async function checkAuthorizationGuard(
  companyId: string,
  issue: Issue,
  stored: Issue | null,
  approvalTransition: ApprovalTransition | undefined,
  authorization: { actor: OrgMember } | undefined,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  if (approvalTransition === undefined) return;

  if (!authorization) {
    throw new ApprovalGateViolationError(
      `Issue '${issue.id}' approvalState change requires authorization.actor to be supplied`,
    );
  }
  const { actor } = authorization;
  if (actor.id !== approvalTransition.actorId) {
    throw new ApprovalGateViolationError(
      `authorization.actor.id '${actor.id}' does not match approvalTransition.actorId '${approvalTransition.actorId}'`,
    );
  }
  if (actor.status !== 'active') {
    throw new ApprovalGateViolationError(
      `Actor '${actor.id}' cannot be authorized for an approval decision while status is '${actor.status}'`,
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
  authorization?: { actor: OrgMember },
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
 * Orchestrates one approval-state-machine step end to end (APPROVAL-GATE.md
 * §4, AUTHORIZATION.md §8): claims_* authorization choreography, THEN
 * computes the transition (pure, throws before any I/O if illegal),
 * optionally witnesses it, persists the ApprovalTransition record, records
 * the approved_by/rejected_by causal edge, then persists the updated Issue
 * through the hardened persistIssue (which re-validates via Guards A/B/C).
 * `deps.witness` is optional — when omitted, `transition.witnessRef` stays
 * null (a tracked gap, see schema/witness.ts and APPROVAL-GATE.md §5).
 */
export async function applyApprovalTransition(
  companyId: string,
  issue: Issue,
  action: ApprovalAction,
  actor: OrgMember,
  previousTransition: ApprovalTransition | null,
  deps: { witness?: WitnessHook; reason?: string; approver?: OrgMember; handoffTo?: OrgMember },
  config?: AgentDbAdapterConfig,
): Promise<{ issue: Issue; transition: ApprovalTransition }> {
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
