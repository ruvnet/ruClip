/**
 * Authorization layer in front of the approval-gate (AUTHORIZATION.md),
 * wiring ruflo's real `claims_*` work-ownership MCP tools rather than
 * inventing a new authorization system. Reuses the same HTTP JSON-RPC
 * bridge `store/agentdb-adapter.ts` already built (`callTool`, factored
 * out into `store/bridge-client.ts` — see that file's header for why a
 * plain re-export from agentdb-adapter.ts wasn't enough) — no second
 * bridge client.
 *
 * Ground-truth correction to AUTHORIZATION.md §1's assumed response shape
 * (verified by reading v3/@claude-flow/cli/src/mcp-tools/claims-tools.ts in
 * the ruflo monorepo directly — this repo never imports it, only calls the
 * MCP bridge, same discipline as the rest of this adapter):
 *
 * 1. Every `claims_*` tool signals failure as a *successful* JSON-RPC
 *    response body `{ success: false, error: "..." }`, not a thrown
 *    JSON-RPC error and not an HTTP error — `callTool` will happily return
 *    that object rather than throwing. Every wrapper below therefore checks
 *    `result.success === false` itself and throws `ClaimAuthorizationError`
 *    — the transport layer does not do this for you.
 * 2. `claims_list`'s real response shape is `{ success, claims: ClaimRecord[],
 *    count, stealableCount }` (not `{ records: [...] }`), and each
 *    record's `claimant` field is a structured object
 *    (`{type:'human', userId, name}` or `{type:'agent', agentId,
 *    agentType}`), not a pre-formatted string — `ClaimRecord` below models
 *    the real shape. `issueId` IS present on every record as
 *    AUTHORIZATION.md §1 assumed, so the `claims_board` fallback it
 *    describes is kept here for defense in depth but is not expected to
 *    trigger against the real bridge.
 * 3. `claims_board`'s shape is unrelated to `claims_list`'s — a
 *    `{ board: { active: [...], paused: [...], ... } }` bucketed-by-status
 *    object, not a flat list, and each bucket's entries already carry a
 *    pre-formatted `claimant` string (via ruflo's own `formatClaimant`).
 *    The fallback below only reads `board.active`, matching the
 *    `status: 'active'` filter `verifyActorHoldsClaim` applies to the
 *    primary `claims_list` path.
 */
import type { OrgMember } from '../schema/org-member.js';
import { callTool, AgentDbBridgeError, type AgentDbAdapterConfig } from '../store/bridge-client.js';

export class ClaimAuthorizationError extends AgentDbBridgeError {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimAuthorizationError';
  }
}

/** `claims_*`'s claimant string format, from the real tool docstrings: "{kind}:{id}:{label}". */
export function orgMemberClaimant(member: OrgMember): string {
  return `${member.kind}:${member.id}:${member.role}`;
}

/** The raw `claimant` shape a claims_list record carries (see file header, correction 2). */
interface RawClaimant {
  type: 'human' | 'agent';
  userId?: string;
  name?: string;
  agentId?: string;
  agentType?: string;
}

function formatRawClaimant(claimant: RawClaimant): string {
  return claimant.type === 'human'
    ? `human:${claimant.userId}:${claimant.name}`
    : `agent:${claimant.agentId}:${claimant.agentType}`;
}

/** A claims_list record — the real shape, see file header correction 2. */
export interface ClaimRecord {
  issueId: string;
  claimant: RawClaimant;
  status: string;
}

interface ClaimsListResult {
  success?: boolean;
  error?: string;
  claims?: ClaimRecord[];
}

interface ClaimsBoardResult {
  success?: boolean;
  error?: string;
  board?: Record<string, Array<{ issueId: string; claimant?: string; from?: string }>>;
}

/** claims_list record statuses treated as "actor currently holds the claim" — see verifyActorHoldsClaim's header comment. */
const LIVE_CLAIM_STATUSES = new Set(['active', 'handoff-pending']);

/**
 * Read-only, defense-in-depth check: does `actor` currently, externally hold
 * the claim on `issueId` per ruflo's claims system? Throws
 * ClaimAuthorizationError if not — this is what makes a bypass of
 * applyApprovalTransition fail even with a structurally-perfect forged
 * ApprovalTransition, since a live claim can't be faked from inside this
 * repo's own AgentDB documents (AUTHORIZATION.md §3).
 *
 * Real-behavior correction to AUTHORIZATION.md §3/§6, found by building an
 * accurate stateful simulation of claims-tools.ts (see
 * v3/@claude-flow/cli/src/mcp-tools/claims-tools.ts's `claims_handoff`
 * handler) and running the submit->approve round trip against it: the
 * design assumed `claims_list({claimant, status: 'active'})` would still
 * find the submitter right up to `persistIssue`'s Guard C check.
 * `claims_handoff` sets `claim.status = 'handoff-pending'` (not
 * `'active'`) the instant it's called — `applyApprovalTransition`'s step 2
 * calls `claims_handoff` for `submit` BEFORE `persistIssue`/Guard C runs
 * (§8), so by the time Guard C's live check fires, an `status: 'active'`-
 * only filter always misses the submitter and every `submit` fails. The
 * design's own §4 reasoning — "claims_handoff only *requests* a transfer
 * ... so the original claimant keeps the claim until the recipient
 * accepts" — is correct about `claimant` (the field doesn't change), just
 * not about `status` staying `'active'`. This function therefore accepts
 * both `'active'` and `'handoff-pending'` records naming `actor` as the
 * claimant — the actor genuinely still IS the claim's `claimant` field in
 * both states; only `accept-handoff` (approve/reject/revise's own step 1)
 * moves it. No `status` filter is sent to `claims_list` itself (that
 * filter doesn't support an "or" of two values) — filtering is done
 * client-side against `LIVE_CLAIM_STATUSES`.
 */
export async function verifyActorHoldsClaim(
  issueId: string,
  actor: OrgMember,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  const claimant = orgMemberClaimant(actor);
  const listResult = await callTool<ClaimsListResult>('claims_list', { claimant }, config);
  if (listResult.success === false) {
    throw new ClaimAuthorizationError(
      `claims_list failed while verifying actor '${actor.id}' holds a claim on issue '${issueId}': ${listResult.error ?? 'unknown error'}`,
    );
  }

  const claims = listResult.claims;
  const shapeLooksReal = Array.isArray(claims) && claims.every((c) => typeof c.issueId === 'string');

  if (shapeLooksReal) {
    const hasClaim = claims!.some(
      (c) => c.issueId === issueId && formatRawClaimant(c.claimant) === claimant && LIVE_CLAIM_STATUSES.has(c.status),
    );
    if (!hasClaim) {
      throw new ClaimAuthorizationError(`Actor '${actor.id}' does not hold the claim on issue '${issueId}'`);
    }
    return;
  }

  // Fallback per AUTHORIZATION.md §1 — not expected to trigger against the
  // real bridge (claims_list's records always carry issueId), kept in case
  // a different claims backend at runtime departs from the shape verified
  // in the file header. claims_board buckets by status, so both relevant
  // buckets are checked.
  const boardResult = await callTool<ClaimsBoardResult>('claims_board', {}, config);
  if (boardResult.success === false) {
    throw new ClaimAuthorizationError(
      `claims_list returned an unexpected shape and the claims_board fallback also failed for actor '${actor.id}' ` +
        `on issue '${issueId}': ${boardResult.error ?? 'unknown error'}`,
    );
  }
  const liveEntries = [...(boardResult.board?.active ?? []), ...(boardResult.board?.['handoff-pending'] ?? [])];
  const hasClaim = liveEntries.some(
    (entry) => entry.issueId === issueId && (entry.claimant === claimant || entry.from === claimant),
  );
  if (!hasClaim) {
    throw new ClaimAuthorizationError(
      `Actor '${actor.id}' does not hold the claim on issue '${issueId}' (verified via claims_board fallback)`,
    );
  }
}

interface ClaimsMutationResult {
  success?: boolean;
  error?: string;
}

/** Thin wrapper over claims_claim — establishes the first claim on an issue. */
export async function claimIssueForActor(
  issueId: string,
  actor: OrgMember,
  context?: string,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  const result = await callTool<ClaimsMutationResult>(
    'claims_claim',
    { issueId, claimant: orgMemberClaimant(actor), context },
    config,
  );
  if (result.success === false) {
    throw new ClaimAuthorizationError(
      `claims_claim failed for actor '${actor.id}' on issue '${issueId}': ${result.error ?? 'unknown error'}`,
    );
  }
}

/** Thin wrapper over claims_handoff — requests (does not immediately transfer) a handoff. */
export async function handoffClaim(
  issueId: string,
  from: OrgMember,
  to: OrgMember,
  opts?: { reason?: string; progress?: number },
  config?: AgentDbAdapterConfig,
): Promise<void> {
  const result = await callTool<ClaimsMutationResult>(
    'claims_handoff',
    { issueId, from: orgMemberClaimant(from), to: orgMemberClaimant(to), reason: opts?.reason, progress: opts?.progress },
    config,
  );
  if (result.success === false) {
    throw new ClaimAuthorizationError(
      `claims_handoff failed for issue '${issueId}' (${from.id} -> ${to.id}): ${result.error ?? 'unknown error'}`,
    );
  }
}

/** Thin wrapper over claims_accept-handoff — fails when nothing is pending for `actor`; that failure IS the authorization signal. */
export async function acceptClaimHandoff(
  issueId: string,
  actor: OrgMember,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  const result = await callTool<ClaimsMutationResult>(
    'claims_accept-handoff',
    { issueId, claimant: orgMemberClaimant(actor) },
    config,
  );
  if (result.success === false) {
    throw new ClaimAuthorizationError(
      `claims_accept-handoff failed for actor '${actor.id}' on issue '${issueId}': ${result.error ?? 'unknown error'}`,
    );
  }
}
