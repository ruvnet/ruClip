# Approval-gate enforcement + witness hook

Status: design (Phase 1c). Closes the gap `docs/PLAN.md` §8 Phase 1 records
after commit `13ac549`: `Issue.approvalState` and `Issue.budgetImpact` are
today bare client-settable fields on the `Issue` document — `persistIssue`
in `src/control-plane/store/agentdb-adapter.ts` writes whatever `approvalState`
the caller hands it, with no enforcement of the draft→pending→approved|
rejected→draft state machine already specified in
`docs/design/DOMAIN-MODEL.md` §3, no record of who made the decision or
when, and no tamper-evidence. `budgetImpact` has the identical problem —
nothing stops a write from silently changing an issue's committed cost after
it has been approved. Both are addressed here, since they're the same class
of defect: a value that must only change through a governed transition is
instead just another field on a document anyone can overwrite.

This document assumes and extends the real implementation in
`src/control-plane/schema/*.ts` and `src/control-plane/store/agentdb-adapter.ts`
(commits `2952348`..`d6a3ff8`), not the original DOMAIN-MODEL.md sketch —
in particular the AgentDB access pattern (HTTP JSON-RPC bridge via
`callTool`), the `entity:{kind}:{id}` node-id prefix for causal edges, the
`CYCLE_CHECKED_RELATIONS` k-hop cycle check, and the fact that `persistIssue`
is already the single function that writes an `Issue` to AgentDB — which is
exactly the chokepoint this design uses for enforcement, rather than
inventing a second write path.

## 1. New entity: ApprovalTransition

An immutable record of one state-machine step, analogous in shape and
lifecycle to `Comment` (§1.5 of DOMAIN-MODEL.md — append-only, never edited).
One `ApprovalTransition` is created per legal move through the diagram in
DOMAIN-MODEL.md §3.

Fields: `id`, `issueId`, `action` (`submit | approve | reject | revise`),
`fromState` (`ApprovalState`), `toState` (`ApprovalState`), `actorId`
(`OrgMember.id` — who made this decision), `reason` (`string | null` —
**required** non-null when `action === 'reject'`, optional otherwise),
`createdAt`, `witnessRef` (`string | null` — see §4; null until a witness
client exists, or until the hook call for this particular transition
resolves).

Action → transition mapping (same diagram as DOMAIN-MODEL.md §3, now with
the action names that produce each edge):

| Action | fromState | toState |
|---|---|---|
| `submit` | `draft` | `pending` |
| `approve` | `pending` | `approved` |
| `reject` | `pending` | `rejected` |
| `revise` | `rejected` | `draft` |

No other `(action, fromState)` pair is legal. `approved` has no outgoing
transition in v1 (DOMAIN-MODEL.md §3's "not a valid transition in v1" note
stands).

## 2. `transitionApprovalState` — the pure state-machine function

```
transitionApprovalState(
  issue: Issue,
  action: ApprovalAction,
  actor: OrgMember,
  previousTransition: ApprovalTransition | null,
  opts?: { reason?: string; now?: () => string },
): { nextIssue: Issue; transition: ApprovalTransition }
```

Pure — no I/O, no AgentDB calls, no witness call. Given the current `issue`
and the transition record that most recently produced `issue.approvalState`
(`previousTransition`, `null` only when `issue.approvalState === 'draft'`
and the issue has never been submitted), it validates and computes the next
state. Throws (a new `IllegalApprovalTransitionError`, not
`SchemaValidationError` — this is a business-rule violation, not a shape
violation) when any of the following hold:

- `(action, issue.approvalState)` is not one of the four rows in §1's table.
- `action === 'reject'` and `opts.reason` is missing or empty — rejections
  must carry a reason (this is the one deliberately-required field beyond
  the state machine itself, since an unexplained rejection is useless to
  the person revising the issue and is exactly the kind of gap the
  build-time genome's "audit-trail completeness" check, PLAN.md §5, is
  meant to catch).
- `actor.status !== 'active'` — an inactive `OrgMember` cannot record a
  decision.
- **Self-approval invariant**: when `action ∈ {approve, reject}`,
  `actor.id === previousTransition!.actorId` (the actor who submitted this
  issue for approval is also the one deciding it) — rejected as a
  segregation-of-duties violation. `previousTransition` for an
  `approve`/`reject` call is always the `submit` transition (the only way
  to reach `pending`), so this is always well-defined when the action is
  legal.

On success, returns:
- `transition`: a new `ApprovalTransition` with `fromState:
  issue.approvalState`, `toState` per §1's table, `actorId: actor.id`,
  `reason: opts?.reason ?? null`, `createdAt: (opts?.now ?? defaultNow)()`,
  `witnessRef: null` (filled in by the orchestration layer, §4).
- `nextIssue`: a shallow copy of `issue` with `approvalState: toState`,
  `approvalTransitionRef: transition.id`, `updatedAt` bumped to the same
  timestamp. `budgetImpact`, `status`, and every other field are untouched
  — this function only ever moves `approvalState`.

## 3. Enforcement: hardening `persistIssue`

`persistIssue` in `store/agentdb-adapter.ts` is already the sole function
that writes an `Issue` document to AgentDB (`storeAtTier` +
`recordCausalEdge` calls for `belongs_to`/`parent_of`/`assigned_to`). That
makes it the correct enforcement chokepoint — no second write path needs
policing, and this matches the file's existing division of labor (per its
own header comment: structural checks live in `schema/validation.ts`,
checks that need previously-stored state live in the adapter next to the
causal-edge writes they guard).

New signature:

```
persistIssue(
  companyId: string,
  issue: Issue,
  previousStatus?: Issue['status'],
  approvalTransition?: ApprovalTransition,
  config?: AgentDbAdapterConfig,
): Promise<void>
```

Before any AgentDB write, `persistIssue` recalls the currently-stored issue
(`recallIssue`, working tier then episodic — the function it already has)
and runs two independent guards. Both throw a new
`ApprovalGateViolationError` (subclass of the existing `AgentDbBridgeError`,
so callers who already catch `AgentDbBridgeError` still see it) and make no
writes on failure — `persistIssue` must check-then-write, not write-then-
validate, since AgentDB has no transaction/rollback primitive available
here.

**Guard A — approvalState may not change without a matching transition.**

- Let `stored = await recallIssue(...)` and `priorApprovalState =
  stored?.approvalState ?? null`.
- **No prior record** (`stored === null`, this is a create): `issue`'s
  initial `approvalState` must be `'draft'` (issues with `budgetImpact > 0`
  always start here — DOMAIN-MODEL.md §1.4) OR `'approved'` with
  `budgetImpact === 0` (DOMAIN-MODEL.md §3's implicit fast-path for
  no-cost issues). Either way `issue.approvalTransitionRef` must be `null`
  — there is no transition record for a brand-new issue. Any other
  initial `approvalState` is rejected.
- **Prior record exists, `issue.approvalState === priorApprovalState`**:
  no approval-state change this write (e.g. only `title`/`description`/
  `assigneeId` changed). `approvalTransition` must be omitted, and
  `issue.approvalTransitionRef` must equal `stored.approvalTransitionRef`
  exactly — a write cannot silently swap in a different transition
  reference while leaving the visible state unchanged.
- **Prior record exists, `issue.approvalState !== priorApprovalState`**: a
  real transition is being persisted. `approvalTransition` must be
  supplied and must satisfy every one of: `approvalTransition.issueId ===
  issue.id`; `approvalTransition.fromState === priorApprovalState`;
  `approvalTransition.toState === issue.approvalState`;
  `approvalTransition.id === issue.approvalTransitionRef` (the issue
  document must point at the exact transition supplied, not just any
  transition with matching from/to states); and `(approvalTransition.action,
  approvalTransition.fromState) → approvalTransition.toState` must itself
  be one of the four legal rows in §1 (recomputed here, not merely
  trusted — defense in depth against a forged `ApprovalTransition` object
  reaching this call without having gone through §2's function). Any
  mismatch is rejected.

**Guard B — budgetImpact is frozen once an issue leaves `draft`.**

- If `stored !== null` and `stored.approvalState !== 'draft'` (i.e. the
  stored issue is `pending`, `approved`, or `rejected`), then
  `issue.budgetImpact` must equal `stored.budgetImpact` exactly. Changing
  the cost of an issue that has already been submitted requires reverting
  to `draft` first via a `revise` transition (§1) and resubmitting — cost
  cannot be quietly bumped after approval, which is the specific
  bait-and-switch the budget-gated heartbeat (PLAN.md §4, out of scope
  this slice, but a real future consumer of this field) depends on not
  happening.
- If `stored === null` or `stored.approvalState === 'draft'`,
  `budgetImpact` may be freely set — this is the only window in which an
  issue's cost estimate is editable.

Both guards run against the same `recallIssue` result, so `persistIssue`
does one extra read (it already does zero today) before its existing
writes. This is an acceptable cost for a per-issue write in the `working`
tier and matches the adapter's existing pattern of reading before writing
for cycle prevention (`wouldCreateCycle`).

## 4. Orchestration: `applyApprovalTransition`

A new adapter function that composes §2 and §3 plus the witness call (§5)
so callers never have to remember the right call order:

```
applyApprovalTransition(
  companyId: string,
  issue: Issue,
  action: ApprovalAction,
  actor: OrgMember,
  previousTransition: ApprovalTransition | null,
  deps: { witness?: WitnessHook; reason?: string },
  config?: AgentDbAdapterConfig,
): Promise<{ issue: Issue; transition: ApprovalTransition }>
```

Steps:
1. `{ nextIssue, transition } = transitionApprovalState(issue, action,
   actor, previousTransition, { reason: deps.reason })` — throws before
   any I/O if the transition itself is illegal (§2).
2. If `deps.witness` is provided, call it (§5) with the transition's
   payload and set `transition.witnessRef` to the returned ref's `id`
   before the transition record is persisted, so the persisted record
   carries its own witness pointer rather than needing a follow-up write.
3. Persist the `ApprovalTransition` record itself — same key/tier pattern
   as `Comment` (§2.2 of DOMAIN-MODEL.md): `ruclip:company:{companyId}:
   goal:{goalId}:issue:{issueId}:approval-transition:{transitionId}`,
   stored at the issue's *current* tier (before this call's status change,
   if any — approval transitions don't change `status`, so this is always
   the issue's existing tier), immutable, never updated after write.
4. If `action ∈ {approve, reject}`, record the causal edge
   `entity:issue:{issue.id} --[approved_by|rejected_by]--> entity:org-
   member:{actor.id}` via the adapter's existing `recordCausalEdge` —
   `approved_by`/`rejected_by` are already in the `CausalRelation` union
   (`schema/enums.ts`); no new relation type is needed. Neither relation is
   in `CYCLE_CHECKED_RELATIONS`, so no cycle check runs (correct — these
   aren't tree-shaped relations).
5. Call `persistIssue(companyId, nextIssue, issue.status, transition,
   config)` — `status` is unchanged by an approval transition alone, so
   `previousStatus === issue.status` and `persistIssue`'s tier-migration
   logic is a no-op here; `transition` is the just-computed,
   just-witnessed, just-persisted record that satisfies Guard A.
6. Return `{ issue: nextIssue, transition }`.

Note what this function deliberately does **not** do: it does not decide
*whether* `actor` is authorized to approve an issue of this
`budgetImpact` bracket — that policy decision belongs to `claims_handoff`/
`claims_accept-handoff` per ADR-0001 §3 point 3, which this slice does not
wire up (out of scope, same as budget-gated heartbeats and agentbbs — see
the task that requested this design). `applyApprovalTransition` trusts that
`actor` has already cleared that authorization check by the time it's
called; what it guarantees is that the *recorded* transition is
state-machine-legal, non-self-approved, reasoned when rejecting, and
tamper-evident once persisted. Wiring the actual `claims_*` authorization
call in front of this function is a follow-on slice.

## 5. Witness hook (ADR-103 pattern)

Per the task: design the seam, not the witness client. The interface is
deliberately small and consumer-shaped rather than modeling ADR-103's own
manifest format, since this control plane is a witness *consumer*, not a
reimplementation:

```
interface WitnessEntryInput {
  subject: string;        // e.g. "issue:{issueId}:approval-transition:{transitionId}"
  eventType: WitnessEventType;
  payload: Record<string, unknown>;  // canonical JSON the signature covers
  occurredAt: string;     // ISO 8601 — the event's own timestamp, not signing time
}

type WitnessEventType =
  | 'ruclip.issue.approval_transition'
  | 'ruclip.issue.status_transition'; // reserved — see below, not called this slice

interface WitnessEntryRef {
  id: string;  // opaque id/hash the witness manifest assigns; stored back as ApprovalTransition.witnessRef
}

interface WitnessHook {
  record(entry: WitnessEntryInput): Promise<WitnessEntryRef>;
}
```

`applyApprovalTransition` (§4 step 2) is the only call site this slice
wires up, with `payload` set to `{ issueId, action, fromState, toState,
actorId, reason, createdAt }` (the transition record minus its own
`witnessRef`, to avoid a self-referential payload) and `eventType:
'ruclip.issue.approval_transition'`.

`deps.witness` is optional and injected the same way
`AgentDbAdapterConfig.fetchImpl` is already injected — `applyApprovalTransition`
must work with `deps.witness` omitted (no witness client exists yet in this
repo; the actual Ed25519-signed-manifest implementation per ADR-103 is
future work, likely wrapping the same GCP Secret Manager signing-key
pattern this repo's root `CLAUDE.md` documents for the npm publish flow).
When omitted, `transition.witnessRef` stays `null` and the transition is
still persisted — **this is a known, tracked gap, not silently swallowed**:
record it in `docs/PLAN.md` §8 the same way the pre-existing gap was
recorded, so the eventual build-time genome's "audit-trail completeness"
bench check (PLAN.md §5) has a concrete thing to assert once a real
`WitnessHook` implementation lands (`witnessRef !== null` on every
`ApprovalTransition`).

**Scope note on "every Issue state transition."** The task's phrasing is
broader than approval — it also covers `status` transitions
(`open`→`in_progress`→`blocked`→`done`→`cancelled`), which are largely
driven by the budget-gated heartbeat (PLAN.md §4), explicitly out of scope
this slice. The `WitnessEventType` union above reserves
`'ruclip.issue.status_transition'` so the same `WitnessHook` interface
covers that case without a second interface being designed later, but no
call site uses it yet — `persistIssue`'s `previousStatus`-vs-`status`
transition is the natural future call site (mirroring how §4 wires the
approval-transition case), left for the slice that implements
budget-gated heartbeats.

## 6. What this changes in `docs/design/DOMAIN-MODEL.md` / `schema/types.md`

- `Issue` (DOMAIN-MODEL.md §1.4, `schema/types.md` `issue.ts`) gains
  `approvalTransitionRef: string | null` — see the updated `types.md`
  section for the exact field placement and comment.
- Two new schema files are needed, both added to `schema/types.md`:
  `approval-transition.ts` (`ApprovalAction`, `ApprovalTransition`) and
  `witness.ts` (`WitnessEntryInput`, `WitnessEventType`, `WitnessEntryRef`,
  `WitnessHook`).
- DOMAIN-MODEL.md §2.3's causal-edge table is unchanged — `approved_by`/
  `rejected_by` were already specified there and in `schema/enums.ts`'s
  `CausalRelation` union; this design is the first slice to actually write
  them.

## 7. What Phase 1c (coder) implements

- `src/control-plane/schema/approval-transition.ts` — `ApprovalAction`,
  `ApprovalTransition` per §1, plus an `assertValidApprovalTransition` in
  `schema/validation.ts` following the existing `assertValid*` pattern
  (structural checks only — safe-id fields, enum membership, `reason`
  required-when-reject — no access to prior state, consistent with that
  file's documented boundary).
- `src/control-plane/schema/witness.ts` — the `WitnessEntryInput` /
  `WitnessEventType` / `WitnessEntryRef` / `WitnessHook` interfaces from
  §5, no implementation.
- `src/control-plane/approval/transition-approval-state.ts` — the pure
  `transitionApprovalState` function from §2, including the legal-transition
  table and `IllegalApprovalTransitionError`.
- `src/control-plane/store/agentdb-adapter.ts` — hardened `persistIssue`
  per §3 (both guards, `ApprovalGateViolationError`), new
  `applyApprovalTransition` per §4 (including the approval-transition key
  builder, alongside the existing `issueKey`/`commentKey` builders), and
  wiring the optional `witness` dependency through.
- `src/control-plane/schema/issue.ts` — add `approvalTransitionRef` to the
  `Issue` interface (see updated `types.md`).
- Tests: illegal-transition rejection for all `(action, fromState)` pairs
  outside §1's table, self-approval rejection, reject-without-reason
  rejection, inactive-actor rejection, Guard A's three cases (create /
  no-change / real-transition) including the forged-transition-object
  case, Guard B's freeze behavior across all three non-`draft` states, and
  `applyApprovalTransition` end-to-end with and without a `witness` dep
  injected.

Please implement verbatim — if a signature genuinely doesn't work during
implementation, that's a signal to come back to this document, not to
silently diverge (same convention as the DOMAIN-MODEL.md handoff).
