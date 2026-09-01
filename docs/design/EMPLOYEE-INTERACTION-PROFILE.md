# EmployeeInteractionProfile — per-human-OrgMember adaptive learning (first slice)

Status: design (Phase 6a — first slice of Human Employee Augmentation,
`docs/PLAN.md` §8 Phase 6). Approved scope, per team-lead sign-off: the
narrowest possible starting point — a per-person adaptive-learning
substrate fed **entirely by data ruClip already legitimately holds**
(approval-decision timing, heartbeat outcomes), with **zero new external
signal ingestion** (no calendar/email/meeting-transcript connector this
slice) and therefore no new PII-ingestion surface. This is deliberately
*not* the full amendment 7b scope — it's the piece that can be built
before the opt-in/AIDefence/external-connector machinery exists, and it
builds the substrate those future signals will plug into.

Two constraints were explicitly named as load-bearing before any code is
written, not to be bolted on after: **opt-in is required even for this
slice's low-risk internal-only signal** (not just for future external
ones), and **access control is designed in now even though no read
surface exists yet** — this profile is personalization data (how the
system talks to one person), never performance-surveillance data (how a
manager could watch that person), and nothing in this design creates a
path from one to the other.

## 0. Grounding corrections (read before implementing)

**A. "SONA" in the amendment is not `ruvllm_sona_*`.** The amendment's
"Per-person adaptation: SONA + AgentDB pattern-store" reads naturally as
"the `ruvllm_sona_create`/`ruvllm_sona_adapt` MCP tools." Checking their
real schemas: `ruvllm_sona_create` is described as "a SONA instant
adaptation loop (<1ms adaptation cycles)... local inference — air-gapped
environments, MicroLoRA-fine-tuned per-task adapters, sub-cent per-call
cost. For general Claude work native Task is the right call." This is a
**local-model weight-adaptation mechanism** — a different concern (running
your own small model with fast per-task fine-tuning) than "durably
remember that Alice tends to decide things at 4pm and Bob decides fast in
the morning." Its cross-session/cross-restart persistence is unconfirmed
from the tool schema alone (the same category of unverified-durability
trap `CronCreate` turned out to be in `HEARTBEATS-AND-COMMS.md` §0 Finding
B) — nothing in the schema says a `sonaId` instance survives a session
restart. **This design does not use `ruvllm_sona_*` for storage.** The
durable per-person record is a `memory_store`/`memory_retrieve` record
instead (§5) — a tool this repo has already used successfully
(`checkOperatingBudget`, `HEARTBEATS-AND-COMMS.md` §4) with confirmed
`upsert: true` semantics and, crucially, a real `provenance_type`
parameter that **is** ADR-323's provenance-tagging mechanism verbatim
(its own description: `"ADR-323: who/what produced this value..."`).
`agentdb_pattern-store`/`agentdb_pattern-search` (BM25+semantic hybrid,
already used for `RuclipPatternNamespace` in `store/agentdb-adapter.ts`)
remains available as an *optional* secondary store for individual raw
signal events if a future slice wants semantic query/explainability over
them — not required for this slice's aggregate profile. `ruvllm_sona_*`
is left as a genuine future option — for fast, local personalization of
*generated message text* once there is generated text to personalize —
explicitly not adopted here for lack of a persistence guarantee and lack
of anything to personalize yet.

**B. AIDefence (`aidefence_scan`/`aidefence_has_pii`) is real, correctly
named, and has nothing to scan this slice.** Both tools are live,
confirmed schemas. But this slice's only signals are `ApprovalTransition`
timestamps and `HeartbeatSchedule` outcomes — structured, already-in-schema
operational data with no free-text component. To keep it that way
deliberately (not by accident): **the signal set for this slice is
restricted to structured/numeric/enum fields only** — explicitly
excluding `ApprovalTransition.reason` (free text, could name another
person, could contain anything) and any `Comment.body`. No AIDefence call
is needed *because* nothing free-text or externally-sourced is ingested,
not because the requirement doesn't apply — the moment a future slice
ingests free text or an external signal, `aidefence_scan`/
`aidefence_has_pii` gate it before it reaches storage, same as every other
untrusted-input boundary already documented for this repo.

## 1. `EmployeeInteractionProfile` entity

One record per **human** `OrgMember` (`kind: 'human'` only — an agent
OrgMember doesn't need personalized tone/timing coaching in the sense this
amendment means; extending to agents is explicitly out of scope, not
silently assumed).

```typescript
export type InteractionSignalType = 'internal-timing'; // extensible — the only value this slice

export interface EmployeeInteractionProfile {
  id: string; // == orgMemberId, one profile per human OrgMember
  companyId: string;
  orgMemberId: string;
  /**
   * Signal types this OrgMember has explicitly consented to. Empty by
   * default — even 'internal-timing' (this slice's only, low-risk,
   * already-in-schema signal) requires explicit opt-in, not just future
   * external signals. No profile is computed for any signal type not in
   * this set (§3).
   */
  consentedSignalTypes: InteractionSignalType[];
  /** Median seconds from an Issue reaching 'pending' to this OrgMember's approve/reject decision. Null until >=1 sample. */
  medianDecisionLatencySeconds: number | null;
  /** Count of hour-of-day (0-23, local to... see §4 note) buckets this OrgMember has made decisions in — a lightweight histogram, not raw timestamps. */
  decisionHourHistogram: number[]; // length 24
  /** How many ApprovalTransition observations fed the current aggregate. */
  sampleCount: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
```

Deliberately **not** included yet: `preferredChannel`, `tone`,
`intrusiveness` — the amendment names these as the eventual goal, but
there is no real signal behind them this slice (one channel exists,
`agentbbs`; no generated-message-content mechanism exists to have a
"tone"). Adding fields with no real signal driving them would be exactly
the kind of fabrication this repo's design docs have consistently avoided
(see `HEARTBEATS-AND-COMMS.md`'s refusal to invent an AgentRadio API).
They're reserved conceptually (the `InteractionSignalType` union is built
to grow) but not implemented until there's a genuine second channel/signal
to learn from.

Invariants:
- `orgMemberId` must resolve to an `OrgMember` with `kind === 'human'` —
  reject creation/consent otherwise.
- `consentedSignalTypes` empty ⇒ no fields below `sampleCount` are ever
  written past their zero-value defaults — a profile can exist (created at
  first consent-check) with nothing learned yet, but never accumulates
  data for a signal type not present in this array.
- `decisionHourHistogram.length === 24` always.

## 2. Access control — the boundary that has no query surface to violate yet

Per team-lead's explicit refinement: this is personalization data (adapts
*how the system talks to this person*), never performance-surveillance
data (how *someone else* could watch this person). Two read paths are
designed, and **no others exist**:

1. **Self-read**: `recallOwnInteractionProfile(actor: OrgMember, config?)`
   — `actor.id` is both the requester and the subject; there is no
   `orgMemberId` parameter separate from `actor.id`, by construction, so
   there is no way to call this function asking about someone else. A
   human OrgMember checking "what does the system know about me" (a
   reasonable, privacy-respecting future UI affordance) goes through this.
2. **Internal composition-only read**: `recallInteractionProfileForComposition(companyId, orgMemberId, config?)`
   — used exclusively, in a future slice, by whatever code composes a
   notification's timing/channel for that specific `orgMemberId` right
   before sending it *to that same person*. It takes no `actor`/requester
   parameter at all, because it is not reachable from any
   actor-driven/API-shaped call path — only from the notification
   pipeline's own internals, for the sole purpose of deciding how to talk
   to the profile's own subject.

**No function in this design takes `(requestingActor, targetOrgMemberId)`
as two independent parameters.** That shape — "let X read Y's profile" —
is exactly the manager-visibility feature the team lead flagged as
requiring its own separate, explicitly-consented design; not building that
function at all (rather than building it and gating it with a
not-yet-enforced permission check) is the actual guarantee here. A future
manager-facing feature must add a **new**, separately-designed,
separately-consented read path — it cannot "unlock" by relaxing a
parameter on these two, because these two never had the parameter that
would need relaxing.

## 3. Consent — self-service, fail-closed, per signal type

```
setInteractionProfileConsent(
  companyId: string,
  orgMemberId: string,
  signalTypes: InteractionSignalType[],
  actor: OrgMember,
  config?: AgentDbAdapterConfig,
): Promise<EmployeeInteractionProfile>
```

- **`actor.id !== orgMemberId` is rejected outright** — consent is
  self-service only, no proxy/admin/manager override exists in this
  design. (Contrast with claims-based work delegation, which is
  deliberately *not* reused here: consenting to personal-data collection
  about yourself is not a work-ownership concern `claims_handoff` should
  ever be able to grant on someone's behalf.)
- Rejects if the target `OrgMember.kind !== 'human'`.
- `signalTypes` replaces (not merges with) `consentedSignalTypes` — an
  explicit "these and only these" set each call, so withdrawing consent
  (calling with an empty array, or a smaller set) is the same code path as
  granting it, not a separate "revoke" special case that could be
  overlooked.
- **Withdrawing consent for a signal type does not retroactively delete
  already-aggregated values for it** in this slice — the aggregate fields
  (`medianDecisionLatencySeconds`, `decisionHourHistogram`,
  `sampleCount`) simply stop being updated. A full right-to-erasure delete
  path is a reasonable future addition, explicitly not built here — noted
  as an open item (§6), not silently assumed to exist.

## 4. Signal computation — from data already in AgentDB, no new ingestion

`recomputeInteractionSignals(companyId, orgMemberId, config?)`:

1. Recall the profile (`recallOwnInteractionProfile`-shaped internal
   recall — no actor check needed here, this is system-internal
   recomputation, not a user-facing read). If `consentedSignalTypes`
   doesn't include `'internal-timing'`, return immediately — no
   computation happens for an unconsented signal type, matching §1's
   invariant.
2. Query `ApprovalTransition` records where `actorId === orgMemberId` and
   `action ∈ {approve, reject}` (these are exactly the moments this person
   made a timed decision — `submit`/`revise` are the *other* party's
   actions, not a latency sample for this actor).
3. For each, the paired `submit` transition (the one whose `toState`
   matches this transition's `fromState`, i.e. `'pending'`, for the same
   `issueId`, immediately prior) gives `pendingSince`; this transition's
   own `createdAt` gives `decidedAt`. `decidedAt - pendingSince` is one
   latency sample.
4. Recompute `medianDecisionLatencySeconds` over all available samples
   (not incrementally averaged — recomputed fresh each call, since
   `ApprovalTransition` records are cheap to recall and a median can't be
   incrementally updated correctly without keeping the full sample set
   anyway).
5. Increment `decisionHourHistogram[hourOf(decidedAt)]` for each sample —
   this one *can* accumulate incrementally, but for consistency this
   slice recomputes it fresh alongside the median (same recall pass, no
   reason to diverge).
6. **Timezone note, stated not silently assumed**: `hourOf(decidedAt)`
   uses the timestamp's own UTC hour — this repo has no per-`OrgMember`
   timezone field yet, so "hour of day" is not yet truly local to the
   person. This makes the histogram less immediately useful than it will
   be once a timezone field exists, but it's honest about what it
   currently measures rather than silently assuming UTC is "local enough."
   Flagged as a concrete follow-on (§6), not fixed here.
7. Persist via `persistInteractionProfile` (§5).

**Trigger**: `applyApprovalTransition` (already shipped,
`store/agentdb-adapter.ts`) gains one more optional dependency, following
the exact injection pattern `deps.witness`/`deps.notifications` already
use:

```
deps: { witness?; notifications?; reason?; approver?; handoffTo?; interactionLearning?: boolean }
```

When `deps.interactionLearning` is `true` and `action ∈ {approve, reject}`,
call `recomputeInteractionSignals(companyId, actor.id, config)` **after**
the transition is persisted (best-effort, same non-blocking contract
`deps.notifications` already has — a failure here must never fail the
approval decision itself). Default `false`/omitted — existing callers are
unaffected, matching every prior additive `deps.*` extension.

## 5. Storage

```
export function interactionProfileKey(companyId: string, orgMemberId: string): string {
  assertSafeId(companyId, 'companyId');
  assertSafeId(orgMemberId, 'orgMemberId');
  return `ruclip:company:${companyId}:org-member:${orgMemberId}:interaction-profile`;
}
```

Uses `memory_store`/`memory_retrieve` (not `agentdb_hierarchical-store`,
per §0 Finding A's storage-mechanism decision) with
`provenance_type: 'system_observation'` (ADR-323 — this data is derived
by ruClip's own observation of in-system behavior, not a `user_claim`,
`agent_output`, or `tool_result`) and `upsert: true` (confirmed real
default, so no `budget.mjs`-style timestamp-stamping workaround is
needed, consistent with `checkOperatingBudget`'s confirmed finding in
`HEARTBEATS-AND-COMMS.md` §4). Namespace: a new `ruclip-employee-profiles`
namespace — **deliberately separate** from both `ruclip-cost-tracking`
(operational infra spend) and the `ruclip:company:...` AgentDB
hierarchical-store keys (domain entities), since this is a distinct,
more-sensitive category of data with its own access-control story (§2)
that shouldn't share a namespace with anything else, making a future
"delete everything in this namespace for GDPR-style erasure" operation
possible without touching unrelated data.

## 6. What Phase 6a (coder) implements

- `src/control-plane/schema/employee-interaction-profile.ts` —
  `InteractionSignalType`, `EmployeeInteractionProfile` per §1, plus
  `assertValidEmployeeInteractionProfile` in `schema/validation.ts`
  (structural only, same boundary every other `assertValid*` keeps: no
  access-control logic here, that lives in the functions in §2/§3, same
  division of labor `checkApprovalStateGuard` vs. `transitionApprovalState`
  already established).
- `src/control-plane/employee-augmentation/interaction-profile.ts` —
  `recallOwnInteractionProfile`, `setInteractionProfileConsent`,
  `recomputeInteractionSignals`, `recallInteractionProfileForComposition`
  per §2-4. Keep the self-only/internal-only access boundary as actual
  function signatures (no `orgMemberId` parameter alongside an unrelated
  `actor` parameter anywhere in this file) — the access control in §2 is
  enforced by what parameters exist, not by a runtime check on values,
  wherever that's achievable; where a runtime check is unavoidable
  (`setInteractionProfileConsent`'s `actor.id !== orgMemberId` reject),
  make it the first thing the function does, before any recall/write.
- `src/control-plane/store/agentdb-adapter.ts` —
  `interactionProfileKey` per §5, `persistInteractionProfile`/
  `recallInteractionProfile` (the low-level store/recall pair
  `recallOwnInteractionProfile` etc. build on), and the
  `deps.interactionLearning` addition to `applyApprovalTransition` per §4.
- Tests: consent is self-only (reject any `actor.id !== orgMemberId`,
  including a `kind: 'agent'` actor trying to consent on a human's
  behalf), consent is rejected for a `kind: 'agent'` target, no signal is
  computed/stored for an unconsented type (verify a full
  `recomputeInteractionSignals` call against a profile with empty
  `consentedSignalTypes` writes nothing), the latency computation itself
  (paired submit→decide transitions, median correctness, histogram
  bucketing), `deps.interactionLearning` omitted/false leaves existing
  `applyApprovalTransition` behavior unchanged (regression-style test
  against the existing approval-gate test suite), a failure inside
  `recomputeInteractionSignals` doesn't fail the approval transition
  itself (matches the `deps.notifications` non-blocking contract), and —
  importantly — a **static/structural test that
  `recallInteractionProfileForComposition` and
  `recallOwnInteractionProfile`'s exported signatures never gain a second
  identity parameter**, so a future refactor can't accidentally reintroduce
  the "read someone else's profile" shape this design deliberately omits.
- Full pipeline resumes on this slice per team-lead's instruction
  (coder → tester → security → reviewer) — no shortcuts, given the
  sensitivity of the domain even though this particular slice has no
  external PII surface.
- **Open items, named not hidden**: (1) `decisionHourHistogram`'s "hour of
  day" is UTC, not per-`OrgMember` local time — no timezone field exists
  on `OrgMember` yet (§4 step 6); (2) withdrawing consent doesn't delete
  already-aggregated values, only stops future updates — a full erasure
  path is future work (§3); (3) `recomputeInteractionSignals`'s per-call
  full-history recall/recompute (rather than incremental) is a reasonable
  v1 choice given expected `ApprovalTransition` volumes, but isn't
  designed to scale indefinitely — revisit if/when an `OrgMember`
  accumulates thousands of transitions; (4) `ruvllm_sona_*` remains a
  real, unused-for-now option for future message-tone personalization,
  not storage — noted so it isn't rediscovered and misapplied to storage
  again later.

Please implement verbatim — if the access-control function-signature
approach in §2/§6 genuinely can't be maintained during implementation
(e.g. a real constraint forces an `(actor, targetId)` shape somewhere),
that is a signal to come back to this document and to me before shipping
it, not to add the parameter and rely on a runtime check alone — the
whole point of this design is that the unsafe shape doesn't exist to be
misused, not just that it's checked.
