# Approval authorization via ruflo `claims_*` (closes the actor-forgery vector)

Status: design (Phase 1d). Closes the gap `docs/PLAN.md` §8 records after
commit `57ab6ab`: `persistIssue`'s Guard A (`checkApprovalStateGuard`)
re-validates an `ApprovalTransition`'s *shape* — id/state cross-references,
`(action, fromState) -> toState` legality — but has no way to confirm the
`actorId` inside that object is genuine. A caller that bypasses
`applyApprovalTransition` and calls `persistIssue` directly with a
hand-built, structurally-legal `ApprovalTransition` (any `actorId`,
including one that never submitted the issue or isn't `active`) passes
Guard A today. The actor-validity checks that *do* exist
(`actor.status === 'active'`, the self-approval invariant) live only inside
the pure `transitionApprovalState` function, and nothing forces every write
path through that function before reaching `persistIssue`.

This document does not touch `transitionApprovalState` (§2 of
`APPROVAL-GATE.md`) — its state-machine logic is correct and out of scope
per this slice's instructions. What's missing is authorization: proof that
the actor named in a transition actually, currently, externally holds the
authority to make it — not just that the transition object is internally
consistent. `docs/PLAN.md` already names the fix: wire this repo's existing
peerDependency on `ruflo`'s `claims_*` work-ownership primitives
(`claims_claim`/`claims_handoff`/`claims_accept-handoff`) in front of both
`applyApprovalTransition` and `persistIssue`, rather than inventing a new
authorization system.

## 1. Real tool surface (checked against the live MCP schemas, not assumed)

`claims_grant`/`claims_check`, referenced in every `claims_*` tool's
generic boilerplate description ("Pair claims_grant + claims_check before
letting an agent run privileged ops"), **do not exist** as callable tools —
that sentence is boilerplate shared across the whole tool family, not
documentation of two additional tools. The real, callable primitives are:

| Tool | Input | Purpose |
|---|---|---|
| `claims_claim` | `{issueId, claimant, context?}` | Claim an issue for work. `claimant` format is `"{kind}:{id}:{label}"`, e.g. `"human:user-1:Alice"` or `"agent:coder-1:coder"` (from the tool's own docstring examples). |
| `claims_handoff` | `{issueId, from, to, reason?, progress?}` | **Request** a handoff to another claimant — per its own description this is a request, not an immediate transfer. |
| `claims_accept-handoff` | `{issueId, claimant}` | Accept a *pending* handoff. Fails when there is no pending handoff addressed to `claimant` for `issueId` — this failure is itself the authorization signal this design relies on. |
| `claims_release` | `{issueId, claimant, reason?}` | Release a claim. Used optionally for cleanup after `approve` (not required by this design). |
| `claims_status` | `{issueId, status, progress?, note?}` | Update claim status (`active\|paused\|blocked\|review-requested\|completed`). Not used by this design. |
| `claims_list` | `{claimant?, agentType?, status?}` | List/filter claims. **No `issueId` filter parameter** — this design filters the returned records client-side by `issueId` (see §3, and the documented assumption about the response shape). |
| `claims_board` | `{}` | Full claims board, no filters. Fallback data source if `claims_list`'s records turn out not to carry `issueId` (see §3). |

These ride the exact same HTTP JSON-RPC bridge the coder already built for
`agentdb_*` tools (`store/agentdb-adapter.ts`'s `callTool`, POSTing to
`ruflo mcp start -t http`'s `/rpc`) — same MCP server, same transport, no
second bridge client needed. `callTool` is currently a private,
non-exported function in `agentdb-adapter.ts`; this slice needs it
`export`ed so the new authorization module can reuse it (a one-line
change, not a refactor — no need to extract a separate bridge-client
module for this).

**Unknown, flagged for the coder to verify against the real bridge**: the
*response* shape of `claims_list`/`claims_board` isn't visible from the
input schema (only arguments are typed). This design assumes each returned
record has at minimum `{issueId: string, claimant: string, status: string}`
— a reasonable expectation given a claim's natural primary key is the
issue it's for, but unverified. If `claims_list`'s records don't carry
`issueId`, fall back to `claims_board()` (explicitly "all claims") and
filter client-side by both `issueId` and `claimant` instead.

## 2. Claimant identity: mapping `OrgMember` to a `claims_*` claimant string

```
orgMemberClaimant(member: OrgMember): string
  => `${member.kind}:${member.id}:${member.role}`
```

Pure, derivable from any `OrgMember` record — `kind` is already exactly
`'agent' | 'human'` (matches the claimant format's first segment verbatim),
`id` is already validated against the safe-id charset, `role` is a
human-readable label. No new field on `OrgMember` is needed.

## 3. Read-only verification: `verifyActorHoldsClaim`

```
verifyActorHoldsClaim(issueId: string, actor: OrgMember, config?): Promise<void>
```

Calls `claims_list({ claimant: orgMemberClaimant(actor), status: 'active' })`
via the shared `callTool`, filters the returned records for one with
`issueId === issueId`, and throws a new `ClaimAuthorizationError` (see §6)
if none is found. This is the **read-only, defense-in-depth** check —
it does not mutate claims state, and it is what makes a bypass of
`applyApprovalTransition` fail even when the caller supplies a
structurally-perfect forged `ApprovalTransition` plus a matching `actor`
object: it cannot fake a live "this actor currently holds an accepted
claim on this issue" fact in `ruflo`'s claims system, because that fact
lives entirely outside this repo's own AgentDB documents.

## 4. Claim lifecycle across the approval state machine

Every `ApprovalAction` (`submit | approve | reject | revise`,
`APPROVAL-GATE.md` §1) pairs with a `claims_*` side effect. The pattern:
whoever is the *recipient* of the most recent handoff must explicitly
**accept** it before acting (that accept call is itself the authorization
gate — it fails if nothing is pending for them); whoever's action *hands
authority to someone else* must explicitly **request** that handoff.

| Action | Pre-step (accept, if actor is receiving authority) | Post-step (initiate handoff, if actor is passing authority on) |
|---|---|---|
| `submit` | none — the actor already holds the original claim from an earlier `claims_claim` (issue creation/assignment time, outside this state machine — see §5) | `claims_handoff(issueId, from: actor, to: approver)` — **`approver: OrgMember` becomes a required input** whenever `action === 'submit'` |
| `approve` | `claims_accept-handoff(issueId, actor)` — fails if no pending handoff addressed to `actor` exists, which is exactly the authorization check | none — `approved` is terminal (`APPROVAL-GATE.md` §1) |
| `reject` | `claims_accept-handoff(issueId, actor)` | `claims_handoff(issueId, from: actor, to: submitter)` — hands the claim back so the original submitter can revise. **`submitter: OrgMember` becomes a required input** whenever `action === 'reject'` (resolved from `previousTransition.actorId`, but the full `OrgMember` record — not just the id — is needed to build the claimant string, so the caller must supply it) |
| `revise` | `claims_accept-handoff(issueId, actor)` — accepting the handback from `reject` | none — the issue is back at `draft`; the next `submit` initiates a fresh handoff |

Right before `persistIssue` is called in every case, `actor` should be the
issue's *current* claimant per `ruflo`'s claims system — either because
they always were (`submit`: `claims_handoff` only *requests* a transfer,
per its own description, so the original claimant keeps the claim until
the recipient accepts) or because they just accepted it
(`approve`/`reject`/`revise`). This is what makes a single, uniform Guard C
rule possible (§6) instead of one rule per action.

**Self-approval is not what the claims system checks.** `claims_*` is
agnostic to *who* is allowed to be on either end of a handoff — it only
tracks issue ownership transfer. The self-approval invariant (the actor
deciding an issue must differ from whoever submitted it) stays a
domain-level rule enforced by `transitionApprovalState` (unchanged, §2 of
`APPROVAL-GATE.md`) and, newly, re-verified independently inside
`persistIssue` against the **persisted** submit record rather than any
caller-supplied object (§6) — the two protections are complementary, not
the same mechanism, and both matter: the claims check proves the actor is
who they claim to be *right now*, the self-approval re-check proves that
identity isn't the same one who submitted.

## 5. Claiming an issue in the first place (context, not new scope)

`claims_claim(issueId, actor, context?)` is how an `OrgMember` establishes
the very first claim on an `Issue` — naturally at issue creation or
assignment time (when `Issue.assigneeId` is first set or changed), well
before any `submit` call. `store/agentdb-adapter.ts`'s existing
`persistIssue` already writes an `assigned_to` causal edge whenever
`issue.assigneeId` is set — the natural extension point for a future slice
would be calling `claims_claim` alongside that edge write. **This slice
does not wire that in** — `verifyActorHoldsClaim` and the handoff
choreography in §4 assume a claim already exists by the time `submit` is
called (its absence is itself a legitimate failure — "you can't submit an
issue you never claimed" is a reasonable consequence, not a gap this
design needs to paper over) — actually establishing that first claim
automatically is out of scope, left for the assignment-workflow slice.

## 6. Enforcement: `persistIssue`'s new Guard C

`persistIssue`'s signature grows one parameter:

```
persistIssue(
  companyId: string,
  issue: Issue,
  previousStatus?: Issue['status'],
  approvalTransition?: ApprovalTransition,
  authorization?: { actor: OrgMember },   // NEW
  config?: AgentDbAdapterConfig,
): Promise<void>
```

`checkApprovalStateGuard` (Guard A) and `checkBudgetImpactFrozenGuard`
(Guard B) are unchanged. A new `checkAuthorizationGuard` (Guard C) runs
between them and the writes:

- If `approvalTransition` is `undefined` (no approval-state change this
  write), Guard C is a no-op — nothing to authorize.
- Otherwise, `authorization` **must** be supplied, or throw
  `ApprovalGateViolationError` (reusing the existing class — this half of
  the check is still "the request is malformed," matching Guard A's
  style).
- `authorization.actor.id === approvalTransition.actorId` — the supplied
  actor must match who the transition claims made the decision. Mismatch
  throws `ApprovalGateViolationError`.
- `authorization.actor.status === 'active'` — re-verified here
  independently of `transitionApprovalState`'s own check, since a forged
  `ApprovalTransition` never passed through that function. Throws
  `ApprovalGateViolationError`.
- **Self-approval re-check, against persisted state, not a parameter**:
  when `approvalTransition.action ∈ {approve, reject}` and
  `stored.approvalTransitionRef` is non-null, recall the actual persisted
  submit-transition record (`recallApprovalTransition`, a new small
  function parallel to `recallIssue`, keyed via the existing
  `approvalTransitionKey`) and compare its `actorId` to
  `authorization.actor.id`. Equal means self-approval — throw a new
  `ClaimAuthorizationError` (§7). This is the piece that closes the
  specific hole `57ab6ab` flagged: it does not trust any object the caller
  handed in, only what `persistIssue` itself already wrote earlier.
- **Live claims-system check**: `await verifyActorHoldsClaim(issue.id,
  authorization.actor, config)` (§3) — unforgeable, since it requires a
  real round-trip confirming `ruflo`'s claims system independently agrees
  this actor currently holds the claim. Throws `ClaimAuthorizationError`
  on failure.

All of Guard C runs — and can throw — before any AgentDB write, same
check-then-write discipline Guards A and B already follow.

## 7. New error class

```
export class ClaimAuthorizationError extends AgentDbBridgeError {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimAuthorizationError';
  }
}
```

Distinct from `ApprovalGateViolationError` on purpose: the latter means
"this request is internally inconsistent" (Guards A/B, and the
malformed/mismatched-actor half of Guard C); the former means "this
request is well-formed but the actor isn't authorized" (the self-approval
and live-claims-check half of Guard C, plus `applyApprovalTransition`'s
own pre-checks in §8). Both subclass `AgentDbBridgeError`, so existing
callers that catch that base class are unaffected.

## 8. `applyApprovalTransition`'s new choreography

Signature grows:

```
applyApprovalTransition(
  companyId: string,
  issue: Issue,
  action: ApprovalAction,
  actor: OrgMember,
  previousTransition: ApprovalTransition | null,
  deps: {
    witness?: WitnessHook;
    reason?: string;
    approver?: OrgMember;   // NEW — required when action === 'submit'
    handoffTo?: OrgMember;  // NEW — required when action === 'reject' (the original submitter)
  },
  config?: AgentDbAdapterConfig,
): Promise<{ issue: Issue; transition: ApprovalTransition }>
```

New steps, in order, all **before** `transitionApprovalState` is called
(fail fast on authorization before doing any state-machine computation):

1. For `action ∈ {approve, reject, revise}`: `await
   claims_accept-handoff({ issueId: issue.id, claimant:
   orgMemberClaimant(actor) })` via `callTool`. A failure here (no pending
   handoff addressed to `actor`) is wrapped as `ClaimAuthorizationError`
   and propagates immediately — this is `applyApprovalTransition`'s own
   primary authorization gate, using `ruflo`'s own accept-handoff
   semantics rather than a custom check.
2. For `action === 'submit'`: require `deps.approver` (throw
   `ClaimAuthorizationError` if missing — a submit with nowhere to hand
   authority to is not a valid call). Call `claims_handoff({ issueId:
   issue.id, from: orgMemberClaimant(actor), to:
   orgMemberClaimant(deps.approver), reason: deps.reason, progress: 100
   })`.
3. `transitionApprovalState(...)` — **unchanged**, §2 of
   `APPROVAL-GATE.md`.
4. Witness call, persist the `ApprovalTransition` record, record the
   `approved_by`/`rejected_by` causal edge — **unchanged**, §4 of
   `APPROVAL-GATE.md`.
5. `persistIssue(companyId, nextIssue, issue.status, transition, { actor
   }, config)` — now passes the new `authorization` bag, which exercises
   Guard C.
6. For `action === 'reject'`: require `deps.handoffTo` (the original
   submitter's full `OrgMember` record — `previousTransition.actorId`
   alone isn't enough to build a claimant string, since `kind`/`role` are
   also needed). Call `claims_handoff({ issueId: issue.id, from:
   orgMemberClaimant(actor), to: orgMemberClaimant(deps.handoffTo),
   reason: 'returned for revision' })` so the submitter can accept and
   later call `revise`.

Step 1's `claims_accept-handoff` for `approve`/`reject`/`revise` and step 5's
Guard C are deliberately redundant with each other — step 1 is the
mutating, once-per-transition authorization action; Guard C's
`verifyActorHoldsClaim` is the read-only re-verification that also runs
when a caller bypasses this function entirely and calls `persistIssue`
directly, which is the actual gap this document closes.

## 9. What this does not change

- `transitionApprovalState`'s state machine, legal-transition table, and
  its own `actor.status`/self-approval checks — untouched, per this
  slice's scope.
- `schema/types.md` — no new domain entity. `ClaimRecord` (the assumed
  shape of a `claims_list`/`claims_board` record, §1) and
  `ClaimAuthorizationError` are integration-boundary types, not domain
  entities, and belong in the new authorization module (§10), the same
  way `PatternSearchResult` lives in `store/agentdb-adapter.ts` rather
  than `schema/`.
- Budget-gated heartbeats, `agentbbs` wiring, and the real `WitnessHook`
  implementation remain out of scope, unchanged from `APPROVAL-GATE.md`'s
  own scope notes.
- `claims_status`/`claims_release`/`claims_load`/`claims_board`'s writer
  path/`claims_mark-stealable`/`claims_rebalance`/`claims_steal` are not
  used by this design — those solve work-distribution/load-balancing
  problems orthogonal to single-assignee approval authority.

## 10. What Phase 1d (coder) implements

- `store/agentdb-adapter.ts`: export the existing private `callTool`
  function (one-line change) so the new module can reuse it without
  duplicating the HTTP JSON-RPC logic.
- `src/control-plane/authorization/claims-authorization.ts` (new file):
  `orgMemberClaimant`, `ClaimRecord` (documented-assumption interface),
  `verifyActorHoldsClaim` (§3), `ClaimAuthorizationError` (§7), and thin
  wrappers over `claims_claim`/`claims_handoff`/`claims_accept-handoff`
  (`claimIssueForActor`, `handoffClaim`, `acceptClaimHandoff` — simple
  one-call-each functions, not orchestration).
- `store/agentdb-adapter.ts`: add `checkAuthorizationGuard` (Guard C, §6),
  a new `recallApprovalTransition` (parallel to `recallIssue`, keyed via
  the existing `approvalTransitionKey`), thread the new `authorization`
  parameter through `persistIssue`, and update `applyApprovalTransition`
  per §8 (new `deps.approver`/`deps.handoffTo`, the accept-handoff/handoff
  calls, unchanged `transitionApprovalState` call).
- Tests: `verifyActorHoldsClaim` success/failure (including the
  `claims_list` response-shape assumption — mock both the expected shape
  and confirm the code fails loudly rather than silently if the mock
  returns something unexpected), Guard C's four checks independently
  (missing `authorization`, actor/transition id mismatch, inactive actor,
  self-approval-against-persisted-record — including the specific case
  `57ab6ab` called out: a forged `ApprovalTransition` with a real
  submitter's id reused as the "approver," bypassing
  `applyApprovalTransition` entirely and calling `persistIssue` directly),
  `applyApprovalTransition`'s full choreography per action (submit
  requires `deps.approver`, reject requires `deps.handoffTo`, a failed
  `claims_accept-handoff` short-circuits before `transitionApprovalState`
  runs, `claims_handoff` is called with the right `from`/`to` for submit
  and reject), and an end-to-end submit→approve and submit→reject→revise
  round trip against a mocked bridge.
- Update `docs/PLAN.md` §8 with delivery status and remaining gaps, same
  pattern as the last two slices (in particular: `claims_claim` is still
  not wired into issue assignment — §5 — and the exact `claims_list`
  response shape is unverified against a real running bridge, only
  against the documented assumption).

Please implement verbatim — if a signature genuinely doesn't work during
implementation (in particular, if the real `claims_list`/`claims_board`
response shape differs from §1's assumption), that's a signal to come back
to this document, not to silently diverge.
