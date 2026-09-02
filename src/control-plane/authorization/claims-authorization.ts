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
 *
 * **Cross-tenant claim collision fix (2026-09-02, `ruvnet/ruClip#5` Finding
 * 1, team-lead approved, full pipeline)**: the real ruflo bridge does not
 * scope `claims_*` records by `companyId` at all — `claims_list({claimant})`
 * returns every claim for that claimant string across every company sharing
 * the bridge, and `Issue.id`/`OrgMember.id` are only charset-validated
 * (`assertSafeId`), never enforced globally unique. Two companies with the
 * same literal issue id (predictable seed data like `issue-1` makes this
 * realistic, not contrived — exactly what the external team's own
 * reproduction hit) could therefore collide: a genuine claim filed by an
 * OrgMember in company A satisfies `verifyActorHoldsClaim` for an unrelated
 * actor+issue in company B, provided that actor's claimant string
 * (`kind:id:role`) happens to match. Bounded severity, not an open bypass —
 * `checkAuthorizationGuard`/`applyApprovalTransition`
 * (`store/agentdb-adapter.ts`) already require an already-credentialed
 * actor whose own `companyId` is verified before any of these functions
 * run — but a real, worth-fixing gap for an attacker who already holds a
 * genuine credential in the target company.
 *
 * Fix: every `issueId` string actually sent to `claims_claim`/
 * `claims_handoff`/`claims_accept-handoff`, and compared against what
 * `claims_list`/`claims_board` return, is company-prefixed
 * (`` `${companyId}:${issueId}` `` via `claimIssueId` below) — scoped
 * entirely within this file, no ruflo bridge change needed. `companyId` is
 * NOT a new parameter on these functions' public signatures — every one
 * already receives the acting `OrgMember`(s), and every real call site in
 * `agentdb-adapter.ts` already independently verifies `actor.companyId`
 * matches the `companyId` in scope before calling in (confirmed by reading
 * every call site, not assumed) — so `actor.companyId` (or `from.companyId`
 * for `handoffClaim`, which also now asserts `from`/`to` share a company —
 * see that function) is the correct, already-trusted source, not a second
 * independently-supplied value that could drift from it.
 * `claimIssueId` runs both halves through `assertSafeId` — cheap, matches
 * this codebase's existing discipline for every other composite AgentDB
 * key, and confirmed empirically (read the real bridge's
 * `validateIdentifier` in `v3/@claude-flow/cli-core/src/mcp-tools/
 * validate-input.ts` in the ruflo monorepo — not assumed) that the real
 * bridge's own server-side `issueId` validation explicitly allows `:` in
 * its identifier charset, so the composite key is not rejected upstream.
 *
 * **Other-consumer check (explicitly asked for, not assumed safe)**:
 * searched the ruflo monorepo (the only other real consumer source this
 * repo has read access to) for anything besides `claims-tools.ts` itself
 * reading `claims_list`'s `issueId` field — found none (`guidance-tools.ts`
 * lists a same-named `claims_list` under an unrelated permission-grant
 * "Security & Compliance" capability group, a static registry string, not
 * code reading a work-claim record). `agentbbs` and `autogenous-service`
 * are separate repos this session has no local checkout of and could not
 * search directly — **this is not confirmed safe for those**, only "no
 * other consumer found in what I could check." If either reads claims by
 * bare `issueId` against the same bridge, this IS a breaking convention
 * change for them, not just an internal ruClip detail — flagging this
 * plainly rather than asserting safety I couldn't verify.
 */
import type { OrgMember } from '../schema/org-member.js';
import { callTool, AgentDbBridgeError, assertSafeId, type AgentDbAdapterConfig } from '../store/bridge-client.js';

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

/** Company-scopes the issueId string sent to/compared against the real claims_* bridge calls — see file header "Cross-tenant claim collision fix". */
function claimIssueId(companyId: string, issueId: string): string {
  assertSafeId(companyId, 'companyId');
  assertSafeId(issueId, 'issueId');
  return `${companyId}:${issueId}`;
}

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
  const scopedIssueId = claimIssueId(actor.companyId, issueId);
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
      (c) => c.issueId === scopedIssueId && formatRawClaimant(c.claimant) === claimant && LIVE_CLAIM_STATUSES.has(c.status),
    );
    if (!hasClaim) {
      throw new ClaimAuthorizationError(
        `Actor '${actor.id}' does not hold the claim on issue '${issueId}' in company '${actor.companyId}'`,
      );
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
    (entry) => entry.issueId === scopedIssueId && (entry.claimant === claimant || entry.from === claimant),
  );
  if (!hasClaim) {
    throw new ClaimAuthorizationError(
      `Actor '${actor.id}' does not hold the claim on issue '${issueId}' in company '${actor.companyId}' (verified via claims_board fallback)`,
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
    { issueId: claimIssueId(actor.companyId, issueId), claimant: orgMemberClaimant(actor), context },
    config,
  );
  if (result.success === false) {
    throw new ClaimAuthorizationError(
      `claims_claim failed for actor '${actor.id}' on issue '${issueId}': ${result.error ?? 'unknown error'}`,
    );
  }
}

/**
 * Thin wrapper over claims_handoff — requests (does not immediately
 * transfer) a handoff. Asserts `from`/`to` share a company before building
 * the composite issueId — without this, a caller-mismatched `to` (e.g.
 * `deps.approver`/`deps.handoffTo` in `applyApprovalTransition`, which are
 * NOT independently companyId-checked at that call site — a real,
 * pre-existing gap, unrelated to this fix, not fixed here since it's out
 * of Finding 1's scope) would silently scope the composite key to `from`'s
 * company while `to`'s own claimant string is for a different company's
 * OrgMember — confusing, not obviously exploitable given the OTHER guards
 * already in front of this call, but a correctness footgun this fix
 * shouldn't introduce.
 */
export async function handoffClaim(
  issueId: string,
  from: OrgMember,
  to: OrgMember,
  opts?: { reason?: string; progress?: number },
  config?: AgentDbAdapterConfig,
): Promise<void> {
  if (from.companyId !== to.companyId) {
    throw new ClaimAuthorizationError(
      `handoffClaim: 'from' (${from.id}, company '${from.companyId}') and 'to' (${to.id}, company ` +
        `'${to.companyId}') belong to different companies — a claim cannot be handed off across companies`,
    );
  }
  const result = await callTool<ClaimsMutationResult>(
    'claims_handoff',
    {
      issueId: claimIssueId(from.companyId, issueId),
      from: orgMemberClaimant(from),
      to: orgMemberClaimant(to),
      reason: opts?.reason,
      progress: opts?.progress,
    },
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
    { issueId: claimIssueId(actor.companyId, issueId), claimant: orgMemberClaimant(actor) },
    config,
  );
  if (result.success === false) {
    throw new ClaimAuthorizationError(
      `claims_accept-handoff failed for actor '${actor.id}' on issue '${issueId}': ${result.error ?? 'unknown error'}`,
    );
  }
}
