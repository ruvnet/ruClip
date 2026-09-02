# ruClip — Architecture & Implementation Plan

Status: LIVE — this repo (`ruvnet/ruClip`) was created via `ruflo eject` from
the scaffold originally staged in `ruvnet/ruflo` branch `explore/ruclip-mission`,
and Phase 1 (§8) is under active development (see delivery notes below). This
file and `docs/adr/ADR-0001-ruclip-control-plane.md` are this repo's own
copies, kept in sync with amendments approved upstream (most recently the
2026-09-01 `ruvnet/autogenous` amendment throughout this document).

## 1. What this is

A ruvnet-only reinterpretation of [paperclipai/paperclip](https://github.com/paperclipai/paperclip):
a control plane for running a company where the "employees" are agents.
Paperclip is **not** an agent framework and does not ship built-in
sales/eng/support/finance automation — it is org-chart + budget-gated
heartbeats + task/approval workflow + audit trail, sitting above whatever
agents you plug in. ruClip replicates that shape using only tools ruvnet
already owns, rather than adopting paperclip's Node/React/Postgres stack.

## 2. Confirmed building blocks (verified this session, not assumed)

| Component | Reality | Role in ruClip |
|---|---|---|
| `ruflo` (this repo) | 39k★, 60+ plugins, Agent Teams (`SendMessage`), `claims_*` work-ownership, `witness` signed audit manifest | Core orchestration substrate |
| `metaharness` (npm `0.4.8`) + `@metaharness/router`, `@metaharness/redblue` | Already integrated, ADR-150 | Governs quality/readiness of both ruClip-the-product and every agent "hire" |
| `ruvector` (npm `0.3.0` — CLAUDE.md's `0.2.25` pin is stale, separate fix needed) | HNSW, RaBitQ, RVF containers | Semantic memory backing every agent + the company's shared knowledge base |
| `agentbbs` (npm `0.2.1`, `github.com/ruvnet/AgentBBS`) | **Already wired** via `plugins/ruflo-bbs-federation` (ADR-164), **already deployed**: 6 live Cloud Run services in `cognitum-20260110` (`agentbbs-web`, `agentbbs-self-*`, `agentbbs-test-*`, `agentbbs-think-pro-*`, `agentbbs-prof-qe-*`, `agentbbs-aass1122-*`) | Human+agent shared comms layer — the Slack-equivalent from the mission brief. **Amended 2026-09-01**: no longer assumed the sole comms channel — evaluated alongside/via AgentRadio (below), whose mesh may itself carry agent-to-agent traffic, with agentbbs remaining the human-visible board. Phase 1 wiring decides the concrete split (see §8). |
| [`ruvnet/LatentMesh`](https://github.com/ruvnet/LatentMesh) (Rust, 47 ADRs, "research prototype" status, has a `latentmesh-agentbbs-bridge` crate already) | Offline/edge agent mesh over LoRa/radio/audio — NOT a company-orchestration primitive | **Optional, Phase 2+**: only relevant if a "hire" needs to operate somewhere without cloud connectivity (field ops, IoT — see `ruflo-iot-cognitum` plugin). Not on the critical path for v1. |
| [`ruvnet/dream-machine`](https://github.com/ruvnet/dream-machine) (npm `dream-machine`, already running nightly against `ruvnet/ruflo` and `ruvnet/metaharness`) | Config-driven nightly evidence-gated evolution engine: `ledger → research → hypothesis → candidate → baseline → evaluation → adversarial critique → bounded Darwin → flywheel evidence → witness → issue → draft PR → ledger row`. **Never merges — draft PRs only.** | This *is* "nightly dream machine tasks for ruvnet." Integration = generate a `dream.config.json` for `ruvnet/ruClip` and register it the same way ruflo/metaharness already are. No new nightly system needed. Governs the *codebase* only — see the `ruvnet/autogenous` row below for the runtime counterpart. |
| `@claude-flow/codex` dual-mode | Claude+Codex peer execution | Cross-model verification for ruClip's own build and for high-stakes agent "employee" decisions |
| [`ruvnet/autogenous`](https://github.com/ruvnet/autogenous) (Rust, research-prototype, ADR-390–402) — **added 2026-09-01** | Governed evolutionary control plane: typed mutations (AGL) → verifier admission → replay-measured fitness → staged canary 1→10→50→100% → cryptographically-signed promotion or automatic rollback, authority-never-expands as a type invariant. `packages/radio-moe` (AgentRadio): a real, ed25519-signed, live-verified streaming mixture-of-agents mesh already running Claude/Codex/OpenRouter/Gemini backends. | **Two roles, replacing prior placeholders**: (1) AgentRadio *is* ruClip's cross-provider agent adapter — supersedes the earlier "out of scope for v1" stance on non-Claude/Codex adapters (§3 item 4, now resolved). (2) The antibody/canary/rollback machinery *is* ruClip's runtime governance layer — replaces the from-scratch "runtime genome" previously sketched in §5, now its own roadmap phase (§8 Phase 4) rather than folded into `ruclip-metaharness`. Governs live agent-taken actions; complements (does not duplicate) dream-machine's nightly repo-evolution loop. |

## 3. Gaps (confirmed absent, need building)

1. **Persistent web dashboard/UI.** Paperclip's core UX is a React board. Nothing
   in the ruvnet stack is a persistent multi-viewer web app in that shape today.
   Closest existing surface is Claude **Artifacts** (with the `assets`/state
   capabilities) — proposed as the v1 dashboard rather than standing up a new
   hosted React app, since it gets multi-viewer state, comments, and zero
   infra cost for free. A dedicated Cloud Run app is the fallback if Artifacts
   capabilities prove insufficient (e.g. need for SSO/data residency).
2. **Secrets management.** No dedicated ruflo plugin. Wrap GCP Secret Manager
   (already the pattern used for the npm publish signing key per this repo's
   CLAUDE.md) rather than building a new secrets store.
3. **Org-chart/company data model.** `ruflo-goals` (goal-plan/horizon-track) and
   Agent Teams give hierarchy and delegation primitives, but not a first-class
   "Company → Goals → Issues (parent/child, blockers, single-assignee)" schema.
   This is the one genuinely new domain model ruClip needs to build — proposed
   as a thin schema layer over AgentDB (v3/@claude-flow/memory), not a new
   database.
4. **Cross-provider agent adapter beyond Claude+Codex — superseded (2026-09-01
   amendment).** Previously scoped as out-of-v1 (paperclip supports OpenClaw,
   arbitrary webhooks; ruvnet-only per the mission brief anyway). No longer a
   gap: `ruvnet/autogenous`'s `packages/radio-moe` (AgentRadio) is a real,
   already-running cross-provider mesh (Claude/Codex/OpenRouter/Gemini) —
   ruClip's agent "employees" route through it instead of a bespoke adapter.
   See §2's `ruvnet/autogenous` row and §8 Phase 1.

## 4. Architecture (v1)

```
                     ┌─────────────────────────────┐
                     │   ruClip Dashboard (Claude    │
                     │   Artifact, capability-backed) │
                     └───────────────┬─────────────┘
                                     │ reads/writes company state
┌────────────────────────────────────┴───────────────────────────────┐
│                        ruClip Control Plane                         │
│  Company schema (AgentDB) ── Goals ── Issues (blockers, assignee)   │
│  Budget-gated heartbeats (ruflo-loop-workers + ruflo-cost-tracker)  │
│  Approval gates (claims_handoff / claims_accept-handoff)            │
│  Signed audit trail (witness, ADR-103 pattern)                     │
└───────┬───────────────────┬────────────────────┬────────────────────┘
        │                   │                    │
   ┌────▼────┐        ┌─────▼─────┐        ┌─────▼──────┐
   │ Agent       │     │ agentbbs +  │       │ Semantic    │
   │ "employees" │◄──►│ AgentRadio  │◄──►    │ memory      │
   │ (ruflo Agent│     │ (human+agent│        │ (ruvector +  │
   │  Teams,      │    │ comms, live │        │  AgentDB)    │
   │  routed via  │    │ Cloud Run,  │        └─────────────┘
   │  AgentRadio  │    │ + AgentRadio│
   │  mesh)       │    │ cross-      │
   │             │     │ provider    │
   │             │     │ mesh)       │
   └──────────────┘    └────────────┘
        │
   ┌────▼─────────────────────────────────────┐
   │ Custom "ruclip-metaharness" — build-time   │
   │ genome only, governs the ruClip codebase   │
   │ — score/genome/bench                       │
   └─────────────────────────────────────────┘
        │
   ┌────▼─────────────────────────────────────┐
   │ Autogenous runtime governance (governs the │
   │ LIVE company): antibody → verifier admit → │
   │ canary 1→10→50→100% → signed promotion or  │
   │ automatic rollback                         │
   └─────────────────────────────────────────┘
        │
   ┌────▼─────────────────────────────────────┐
   │ dream-machine nightly cycle (existing,    │
   │ generalized engine — config only, no new  │
   │ nightly system; governs the CODEBASE only)│
   └─────────────────────────────────────────┘
```

## 5. Custom metaharness for ruClip (build-time only, permanently)

**One evaluation surface, not two** — `ruclip-metaharness`'s scope is
build-time genome only, riding the existing `metaharness` primitives
already in this repo (`plugins/ruflo-metaharness`) rather than a parallel
implementation, matching the ADR-150 "removable, optional peer" constraint:

- **Build-time genome** (`metaharness score`/`genome`, pure-read, no
  bench.json needed for these two — real measured output as of the Phase 3
  delivery: `harnessFit: 72`, `taskCoverage: 79`, `toolSafety: 100`, genome
  `verdict: "ready"`) plus a hand-authored `.harness/bench.json` task
  corpus (verified against the real `metaharness bench verify` tool)
  covering: approval-gate self-approval invariant, budget hard-stop
  correctness (Guard B), actor-identity forgery closure, budget-gated
  heartbeats + agentbbs delivery, and `EmployeeInteractionProfile`
  access-control boundary — each task wired to the real, already-passing
  test file(s) that verify that property, wrapping the existing suite
  rather than reinventing checks. `metaharness_mcp_scan` also runs cleanly
  (currently: no MCP surface exposed, nothing to scan yet — becomes
  meaningful the moment ruClip or its dashboard hosts one).

**`@metaharness/redblue`/`@metaharness/flywheel` adversarial/runtime
testing is explicitly, permanently NOT part of `ruclip-metaharness`'s
design** — decided 2026-09-02, not deferred pending both prerequisites
existing. Confirmed by actually running `redblue init`/`redblue attack`:
`redblue` needs a live, HTTP-reachable conversational agent/LLM endpoint to
attack (its real attacks are natural-language prompts, not TypeScript
function calls), which ruClip doesn't have. Rather than treat this as "wire
it in once Phase 2 ships a target," the permanent decision is: that role
belongs to Autogenous (Phase 4) — `ruvnet/autogenous`'s antibody-package
model already replaces the from-scratch `redblue`+`flywheel` runtime-genome
sketch per ADR-0001 amendment 7a, and when Phase 2 ships a live
agent-employee endpoint, it gets wired into **Autogenous's** flow, not into
a resurrected `redblue` integration here. `ruclip-metaharness` governs the
*codebase*; Autogenous governs the *live company*; dream-machine (§6) runs
the nightly cycle over the codebase. No component's scope grows to cover
what another already owns.

The build-time genome's bench corpus lives at `ruvnet/ruClip/.harness/bench.json`,
authored with `metaharness bench verify`, not a new evaluation engine.

## 6. Nightly dream-machine integration (concrete, not new infra)

Once `ruvnet/ruClip` exists:

```bash
npx dream-machine init --repo ruvnet/ruClip --out dream.config.json
npx dream-machine compile dream.config.json --out PROMPT.md
npx dream-machine schedule dream.config.json --env <cloud-env-id> --out routine.json
```

Then a `/schedule` cloud routine (same mechanism already running nightly for
`ruvnet/ruflo` and `ruvnet/metaharness`, cron `0 9 * * *`) is created pointing
at the bootstrap prompt. `dream.config.json`'s rotation surface for ruClip
should include: the build-time bench suite from §5 above, and `LEDGER.md`
rows under `docs/dream-cycle/`. **Amended 2026-09-01**: no `redblue`
adversarial-runtime rotation here — that surface belongs to Autogenous (§8
Phase 4) now, not dream-machine; this loop stays codebase-only, mirroring
`ruflo`/`metaharness`'s own nightly cycles. No new nightly scheduler, no new
GCP cron — reuse verbatim.

## 7. GCP footprint (confirmed this session, read-only)

- Org is `ruv.net` (id `885436984033`); **"cognitum-one" is not a separate
  org** — it was a misreading of the `cognitum-20260110` project's display
  name "Cognitum." Corrected here so future references use the right ID.
- `ruv-dev`: 2 running VMs (`ruvbrain-vm` e2-standard-4, `edge-net-turn`
  e2-small), 18 Cloud Run services, **no GPU quota**.
- `cognitum-20260110`: 18 VMs (several terminated), mostly GitHub Actions
  runners, plus the 6 live `agentbbs-*` Cloud Run services, **no GPU quota**.
- **Zero GPU capacity anywhere in the account.** Cleared for "minimal
  dev-tier, no GPUs" provisioning — proposal: one small Cloud Run service for
  the ruClip control-plane API (if the Artifact-only dashboard proves
  insufficient) + reuse of existing `gha-runner-*` VMs for CI. No new VM
  needed for v1. GPU quota request is a separate, explicitly-budgeted future
  ask if ruClip ever needs local fine-tuning rather than hosted LLM calls.

## 7a. Human Employee Augmentation (2026-09-01 amendment)

ruClip's scope expands from "orchestrate AI agent employees" to "optimize
every employee, human and AI, working alongside the system" — per the
user: "a kind 10,000x multiplier." See ADR-0001 amendment 7b for the full
rationale. Summary of the design, reusing already-shipped primitives:

| Need | Backed by |
|---|---|
| Per-person adaptive learning (not a generic policy) | SONA + AgentDB pattern-store, scoped per human `OrgMember` |
| Proactive DMs/reminders/nudges | `agentbbs` notification channel (already built, with `radio-moe` Ed25519 signing) — reused, no new comms system |
| Calendar/email/meeting-transcript signal ingestion | External SaaS integrations (Google Calendar/Gmail-style APIs, generic meeting-recorder transcripts) — explicitly outside the "ruvnet-only" orchestration-substrate constraint, same as any real company's existing tools |
| Privacy | Hard constraint: AIDefence PII scanning on every ingested signal, ADR-323 provenance tagging, explicit per-employee opt-in — never an always-on surveillance default |

New roadmap phase (§8 Phase 6 below), sequenced after Autogenous runtime
governance (Phase 4) and dream-machine nightly integration (Phase 5).

## 8. Phased roadmap

1. **Phase 0 (this doc + ADR)** — plan review, then create `ruvnet/ruClip`
   (via `npx ruflo eject --name ruClip` from a scaffolded skeleton in this
   branch, which is the existing purpose-built ruflo command for lifting a
   project into a standalone harness — not a fresh `gh repo create` from
   nothing).
2. **Phase 1 — Control plane core**: Company/Goals/Issues schema on AgentDB,
   budget-gated heartbeats, approval gates, signed audit trail,
   agentbbs/AgentRadio comms wiring. **Amended 2026-09-01**: agentbbs and
   AgentRadio (packages/radio-moe, §2) are evaluated together here — AgentRadio
   is also where agent "employees'" cross-provider routing (Claude/Codex/
   OpenRouter/Gemini) is wired, not a separate phase, since it's foundational
   to how employees communicate and act from day one.
   - **Delivered this iteration** (commits `2952348`..`13ac549`): the
     Company/Goals/Issues schema (types + `assertValid*` validation) and the
     AgentDB adapter (hierarchical store/recall, tier placement, causal edges
     for `reports_to`/`parent_of`/`blocks`/`assigned_to`/`belongs_to`),
     covered by 70 tests (69 pass, 1 todo), `tsc --strict` clean, and a
     security pass that closed a key-collision/entity-confusion vuln (id
     charset restricted to `[A-Za-z0-9_-]{1,256}` in both the schema
     validators and the adapter's key builders — see commit `13ac549`).
   - **Still remaining for Phase 1**: budget-gated heartbeats and agentbbs
     wiring (not started).
   - **Delivered this iteration** (Phase 1c, commits `2952348`..HEAD —
     closes the approval-gate-enforcement gap the previous iteration
     recorded): `ApprovalTransition` (`schema/approval-transition.ts`) and
     the `WitnessHook`/`WitnessEntryInput`/`WitnessEntryRef` seam
     (`schema/witness.ts`, interfaces only — no witness client yet, see
     below), plus the pure `transitionApprovalState` state machine
     (`src/control-plane/approval/transition-approval-state.ts`) enforcing
     the draft→pending→approved/rejected→draft diagram from
     `docs/design/DOMAIN-MODEL.md` §3 / `docs/design/APPROVAL-GATE.md` §1-2,
     including reject-requires-reason, inactive-actor rejection, and the
     self-approval (segregation-of-duties) invariant. `Issue` gained
     `approvalTransitionRef` (`schema/issue.ts`), and
     `store/agentdb-adapter.ts`'s `persistIssue` is now hardened with two
     guards that make it the actual enforcement chokepoint (one extra
     `recallIssue` read before any write, per `APPROVAL-GATE.md` §3):
     **Guard A** rejects any write that changes `approvalState` without a
     supplied `ApprovalTransition` whose `issueId`/`fromState`/`toState`/`id`
     cross-reference the stored issue exactly *and* whose
     `(action, fromState) -> toState` is independently re-verified as legal
     (defense in depth against a forged `ApprovalTransition` object that
     never went through `transitionApprovalState`); **Guard B** freezes
     `budgetImpact` once the stored issue's `approvalState` leaves `'draft'`.
     Both throw a new `ApprovalGateViolationError`. A new
     `applyApprovalTransition` orchestrates the whole step (compute
     transition → optional witness call → persist the immutable
     `ApprovalTransition` record → record the `approved_by`/`rejected_by`
     causal edge → hardened `persistIssue`), wiring the optional
     `WitnessHook` dependency the same way `AgentDbAdapterConfig.fetchImpl`
     is already injected. 106 tests total (up from 70), `tsc --strict`
     clean.
   - **Still a tracked, non-silent gap**: no real `WitnessHook`
     implementation exists yet (ADR-103's actual signed manifest) —
     `applyApprovalTransition` runs correctly with `deps.witness` omitted,
     `ApprovalTransition.witnessRef` just stays `null`. The eventual
     build-time genome's "audit-trail completeness" check (§5) should assert
     `witnessRef !== null` on every `ApprovalTransition` once a real
     `WitnessHook` lands. Also still open: wiring the actual
     `claims_handoff`/`claims_accept-handoff` *authorization* check in front
     of `applyApprovalTransition` — it currently trusts that the caller has
     already established the actor is allowed to decide on an issue of this
     `budgetImpact` bracket; enforcing that is a follow-on slice.
   - **Related, more specific open item flagged in security review**:
     `checkApprovalStateGuard` ("Guard A" in
     `store/agentdb-adapter.ts`/`APPROVAL-GATE.md` §3) only re-validates the
     *shape* of a supplied `ApprovalTransition` — id/state cross-references
     and `(action, fromState) -> toState` legality — because `persistIssue`
     takes an `ApprovalTransition` object directly, not an `actor` +
     `action` pair. The actor-validity checks (`actor.status === 'active'`,
     the self-approval/segregation-of-duties invariant) live only inside the
     pure `transitionApprovalState` function (§2), and nothing forces every
     write path through that function before reaching `persistIssue`. A
     caller that bypasses `applyApprovalTransition` and calls `persistIssue`
     directly with a hand-built but structurally-legal `ApprovalTransition`
     (any `actorId`, including one that never submitted or isn't active)
     currently passes Guard A — no test exercises this today. This is the
     same underlying gap as the `claims_handoff` wiring above (an
     authorization layer in front of every write path, not just the
     `applyApprovalTransition` entry point), not a new one — recorded
     separately here because it's a concrete forgery vector, not just a
     missing policy check.
   - **Delivered this iteration** (Phase 1d, `docs/design/AUTHORIZATION.md`
     — closes both gaps 1c recorded: the `claims_handoff`/
     `claims_accept-handoff` wiring, and the actor-forgery vector in Guard
     A): a new `src/control-plane/authorization/claims-authorization.ts`
     wraps ruflo's real `claims_claim`/`claims_handoff`/
     `claims_accept-handoff`/`claims_list`/`claims_board` MCP tools —
     `claims_grant`/`claims_check`, referenced only in every `claims_*`
     tool's shared boilerplate description, do not exist as real tools and
     are not used. `persistIssue` gained a third guard, **Guard C**
     (`checkAuthorizationGuard`): no-op when no `approvalTransition` is
     supplied; otherwise requires an `authorization: {actor}` parameter,
     checks `actor.id`/`actor.status` against the transition, re-verifies
     the self-approval invariant against the **persisted** submit-transition
     record (`recallApprovalTransition`, never a caller-supplied object —
     the specific fix for the forgery vector), and calls the new
     `verifyActorHoldsClaim` as an unforgeable live check against ruflo's
     claims system. `applyApprovalTransition` now runs the full claims
     choreography (`claims_accept-handoff` for approve/reject/revise before
     any state-machine computation; `claims_handoff` after a legal submit
     or reject) per a new `deps.approver`/`deps.handoffTo`. 142 tests total
     (up from 106), `tsc --strict` clean.
   - **Two real deviations from the design doc, found only by running the
     code, not by type-checking it** — both documented in the affected
     files' own comments: (1) `AUTHORIZATION.md`'s "export `callTool`, a
     one-line change, no need for a separate bridge-client module" turned
     out to be insufficient — `claims-authorization.ts` needs `callTool`/
     `AgentDbBridgeError` from `agentdb-adapter.ts`, which needs
     `verifyActorHoldsClaim` etc. back from `claims-authorization.ts`, a
     genuine two-way cycle. `tsc` accepted it, but the compiled output threw
     `ReferenceError: Cannot access 'AgentDbBridgeError' before
     initialization` — a `class X extends Y` heritage clause evaluates
     immediately at module-load time, unlike a function body, so the cycle
     broke at runtime. Fixed by extracting `AgentDbBridgeError`/
     `AgentDbAdapterConfig`/`callTool` into a new dependency-free
     `store/bridge-client.ts` that both files import from (re-exported from
     `agentdb-adapter.ts`, so no external import path changed). (2)
     `verifyActorHoldsClaim`'s `claims_list({claimant, status: 'active'})`
     call (as specified) never finds the submitter during a `submit`
     action's own `persistIssue`/Guard C check: `applyApprovalTransition`
     calls `claims_handoff` (which the real `claims-tools.ts` flips the
     claim's `status` to `'handoff-pending'`, not `'active'`) *before*
     `persistIssue` runs, so a strict `status: 'active'` filter always
     misses — every `submit` failed against a faithful stateful simulation
     of the real tool. Confirmed by reading `claims-tools.ts`'s
     `claims_handoff` handler directly, not by guessing. Fixed by dropping
     the `status` filter from the `claims_list` call and instead accepting
     client-side any record naming the actor as claimant with status
     `'active'` OR `'handoff-pending'` (both mean "this actor is still the
     recorded claimant" per the design's own §4 reasoning — only
     `accept-handoff` moves the claimant, not `status` alone).
   - **Post-delivery security fix (round 3, commit `2c08d8a`)**: Guard C's
     `actor.status === 'active'` check, as first implemented, tested the
     field on the caller-supplied `authorization.actor` object — not actual
     re-verification, since a caller can set that field to anything (the
     same trust bug the pre-`de48670` Guard A create-path had). Confirmed
     exploitable by an independent test
     (`tests/control-plane/authorization-trust-boundary.test.ts`): an
     OrgMember an operator marks `'inactive'` in ruClip's own store could
     keep deciding approvals indefinitely as long as ruflo's claims system
     (which has no concept of `OrgMember.status`) still showed them holding
     the claim. Fixed to recall the actual persisted `OrgMember` via
     `recallOrgMember` and check *its* status, treating a missing record as
     unauthorized rather than trusting the caller — matching how the
     self-approval re-check already treated its own input. 144 tests total
     (up from 142), `tsc --strict` clean.
   - **Still remaining (superseded below)**: `claims_claim` is not wired
     into issue creation/assignment (`AUTHORIZATION.md` §5 — the natural
     extension point is the existing `assigned_to` causal-edge write in
     `persistIssue`, not built this slice); the real `claims_list`/
     `claims_board` response shape is verified only by reading
     `v3/@claude-flow/cli/src/mcp-tools/claims-tools.ts` in the ruflo
     monorepo directly, not against a live running bridge — the
     `claims_board` fallback path this repo's own tests exercise has never
     actually run against a real `ruflo mcp start -t http` process; the
     real `WitnessHook` implementation (ADR-103) is still unbuilt (Phase 1c
     gap, unchanged).
   - **Delivered this iteration** (Phase 1e,
     `docs/design/HEARTBEATS-AND-COMMS.md` — closes both of Phase 1's
     remaining items, budget-gated heartbeats and comms wiring): a new
     `HeartbeatSchedule` entity (`schema/heartbeat-schedule.ts` — a
     discriminated `goal | issue` target, `assertValidHeartbeatSchedule`)
     and `NotificationChannel`/`NotificationEvent`/`NotificationKind` seam
     (`schema/notification.ts`). `fireHeartbeat`
     (`src/control-plane/heartbeat/fire-heartbeat.ts`) runs two AND'ed
     gates before ever waking anyone — **Gate 1**, ruClip's own already-
     shipped `Company.budget`/`Issue.budgetImpact`/`Goal.budgetAllocation`
     accounting, and **Gate 2**, a new `checkOperatingBudget`/
     `setOperatingBudget` pair in `store/agentdb-adapter.ts` mirroring
     `ruflo-cost-tracker`'s alert-ladder shape but reading/writing ruClip's
     **own** `ruclip-cost-tracking` namespace via the real `memory_store`/
     `memory_retrieve`/`memory_list` MCP tools — either gate failing pauses
     the schedule (fail closed) and publishes a `heartbeat-budget-blocked`
     notification rather than silently skipping to retry next cycle. New
     `heartbeatKey`/`persistHeartbeatSchedule`/`recallHeartbeatSchedule`/
     `listDueHeartbeats` complete the adapter surface; creating/pausing/
     resuming a schedule reuses `verifyActorHoldsClaim` directly (no new
     authorization machinery). `AgentBbsNotificationChannel`
     (`src/control-plane/comms/agentbbs-notification-channel.ts`) is a real
     implementation over the live `federation_bbs_register`/`_publish`/
     `_human_join` MCP tools; `AgentRadioNotificationChannel` is an
     interface-only stub (`{delivered:false, degraded:true}` unconditionally
     — see deviations below). `applyApprovalTransition` gained
     `deps.notifications`, publishing `issue-approval-transition`
     best-effort after a transition persists. 174 tests total (up from
     144), `tsc --strict` clean.
   - **Four grounding corrections from a literal reading of the original
     brief, documented in `HEARTBEATS-AND-COMMS.md` §0 before
     implementation** (same discipline that caught the Phase 1d
     `claims_handoff` status bug): (A) `hooks_worker-dispatch`'s 12
     triggers are a closed, repo-maintenance vocabulary — none fits "check
     on an Issue," so heartbeats are not a worker-dispatch call. (B)
     Neither `CronCreate` (real live schema: session-only, non-durable,
     7-day auto-expire, contradicting `ruflo-loop-workers`' own skill doc)
     nor `ScheduleWakeup` (not a real tool in this environment) is an
     actually-durable scheduler — `HeartbeatSchedule.nextFireAt` in AgentDB
     is the durable source of truth; an active session/cron job is only
     ever the proximate trigger. (C) `ruflo-cost-tracker`'s "budget" is a
     whole-*project* circuit breaker over real Claude session spend via CLI
     script shell-outs (no MCP form), with no `companyId`/`issueId`
     parameter at all — genuinely different from ruClip's own
     `Company.budget`/`Issue.budgetImpact`; both stay as two separate,
     AND'ed gates, not merged. (D) `agentbbs` has real, live
     `federation_bbs_*` MCP tools; a repo-wide search for
     `radio-moe`/`AgentRadio` finds no source and no matching MCP tools
     anywhere in this environment, and `ruvnet/autogenous` is not checked
     out on this machine — `AgentRadioNotificationChannel` is therefore an
     honest stub and `agentbbs`, not AgentRadio, is the channel actually
     wired this slice, a deviation from the brief's "AgentRadio primary"
     framing made explicit rather than faked.
   - **One further real deviation found only by reading the tool source,
     not assumed from the design doc's own prose**: `memory_list`'s
     confirmed live schema returns entry **metadata only**
     (`{key, namespace, storedAt, updatedAt, accessCount, hasEmbedding,
     size}`) — no `value`/`content` field at all. `checkOperatingBudget`
     therefore cannot sum `total_cost_usd` from a single `memory_list` call
     the way the design doc's prose reads — it lists `session-*` keys, then
     issues one `memory_retrieve` per key to actually read each record.
     This mirrors the exact same metadata-only limitation
     `agentdb-tools.ts`'s own pattern-search fallback already works around
     elsewhere in the ruflo monorepo (independently re-discovered here, not
     copied). By contrast, `memory_store`'s `upsert: true` default *was*
     confirmed correct as the design assumed — no timestamp-stamping
     workaround needed for `setOperatingBudget`.
   - **Still remaining**: the scheduler loop itself (whatever periodically
     calls `listDueHeartbeats` + `fireHeartbeat`) is intentionally not
     built this slice (`HEARTBEATS-AND-COMMS.md` §7 — a `/loop`-style
     in-session pattern is the natural fit, cross-referenced but deferred,
     same as `WitnessHook`'s real implementation was in Phase 1c);
     `claims_claim` still not wired into issue creation/assignment;
     `AgentRadioNotificationChannel` remains a stub pending a real
     `ruvnet/autogenous`/`radio-moe` checkout to implement against; the
     real `WitnessHook` implementation (ADR-103) is still unbuilt. This
     closes out the last two items PLAN.md §8 Phase 1 originally listed —
     Phase 1 (Control plane core) is now feature-complete against its
     original scope, modulo the still-open items named throughout this
     section.
   - **AgentRadio correction, final revision (round 5)**: the "honest stub"
     bullet just above turned out to be wrong on one narrow point —
     `radio-moe@0.3.1`/`@metaharness/radio@0.1.0` ARE real, published npm
     packages (confirmed via `npm view` and by installing and reading the
     actual `dist/*.d.ts`, not the README alone). The architect's follow-up
     review (`HEARTBEATS-AND-COMMS.md` §0 Finding D, second revision) then
     established the more precise point: neither package's real API is a
     notification/pub-sub bus, so no standalone
     `AgentRadioNotificationChannel implements NotificationChannel` was
     built. Final shape: `src/control-plane/comms/
     agentradio-notification-channel.ts` is deleted; `radio-moe`'s real
     `PeerIdentity`/`signFrame`/`verifyFrame` are used *inside*
     `AgentBbsNotificationChannel` as an optional signing layer — every
     published notification carries a genuine ed25519 signature
     (`radioMoeSignature`) when `radio-moe` is installed (an optional peer
     dependency, and also a `devDependency` so this repo's own tests
     exercise the real signed/verified path deterministically), degrading
     silently to the pre-signing behavior when it isn't. This is the first
     integration anywhere in ruClip that imports a peer package directly
     rather than only calling `bridge-client.ts`'s `callTool` — there is no
     MCP tool wrapping radio-moe's signing primitives (checked: no
     `radio-moe`/`AgentRadio` reference anywhere in
     `v3/@claude-flow/cli/src/mcp-tools/`), so there was no bridge path
     available. 177 tests total (up from 174), `tsc --strict` clean.
     `radio-moe`'s real notification-*delivery*-shaped gap — no
     notification-shaped `Wire` variant exists in its real, closed signed
     transport protocol (`AdvertWire | DispatchWire | LogitFrame |
     TextFrame`) — is documented in `HEARTBEATS-AND-COMMS.md` §5 for anyone
     revisiting this later; radio-moe's real separate role (cross-provider
     agent-work dispatch) is unchanged and still tracked as Phase 1f below.
   - **Two post-delivery security passes on this slice (commits `467c4d9`,
     `732c2e1`)**, same recurring bug class this repo keeps catching
     ("trust caller-supplied data instead of recalling/enforcing ground
     truth"): (1) `registerCompanyCommsRoom` built its AgentDB key by raw
     string interpolation with no `assertSafeId` check, reintroducing the
     exact key-collision vulnerability class `13ac549` closed repo-wide — a
     crafted `companyId` could collide byte-for-byte with `orgMemberKey`
     and silently overwrite a real `OrgMember` record. Fixed by moving
     `assertSafeId`/`SAFE_ID_PATTERN` into `store/bridge-client.ts` (the
     shared dependency-free leaf every key-building module now imports
     from) and calling it first in `registerCompanyCommsRoom`. (2)
     `persistHeartbeatSchedule`'s `actor` parameter was optional with
     nothing distinguishing a legitimate system re-persist (`fireHeartbeat`'s
     own bookkeeping, which correctly omits `actor`) from a hostile caller
     creating a brand-new schedule and omitting `actor` to dodge the
     "requires a live claim" invariant `HEARTBEATS-AND-COMMS.md` §6 states
     — fixed the same way as the earlier Guard A create-path bug: recall
     the stored schedule first, and a `null` result (genesis create) now
     hard-requires `actor`. (3) A third, narrower pass (`732c2e1`) found the
     ed25519-signed frame `notificationFrame()` built for signing omitted
     `event.occurredAt`, so `verifySignedNotification` returned `true` even
     when a notification's timestamp had been altered post-signing —
     fixed by folding `occurredAt` into the signed `value` object (single
     point of truth between signing and verification). 181 tests total (up
     from 177), `tsc --strict` clean, verified against the real installed
     `radio-moe@0.3.1` package (not a mock).
3. **Phase 2 — Dashboard**: Claude Artifact-based company board (capabilities:
   live state, multi-viewer, saved documents). **Hard prerequisite added
   2026-09-01, narrowed 2026-09-01** (`docs/design/ACTOR-IDENTITY-VERIFICATION.md`
   §4): real human authentication/login must be solved as this phase's
   first concern, not designed later. `ActorCredential` verification (the
   cross-cutting fix for the actor-forgery gap security found — closes it
   for agent `OrgMember`s via a fresh, per-call, cryptographically-signed
   credential) has no working issuance path for `kind: 'human'` actors —
   no dashboard/login flow exists anywhere in ruClip yet to issue one
   through. **Narrowed scope, not all human-reachable functions**: this
   blocks only the three sites that exercise authority on behalf of the
   company or grant access/effect visible to another party (approval
   decisions, comms-room registration, heartbeat creation) — a strictly
   self-referential action with no other party affected
   (`setInteractionProfileConsent`, where actor and subject must already
   be identical) is explicitly exempt and keeps working on its
   pre-existing self-check, with the residual forgery risk there tracked
   as an accepted, pre-existing gap rather than newly blocked or silently
   ignored. Phase 2's own design doc must solve human credential issuance
   first, closing that residual gap as part of the same work, not as a
   separate follow-up.
   - **Second hard prerequisite added 2026-09-02**
     (`docs/design/RUCLIP-METAHARNESS.md` §0 Finding B, §3): a live,
     HTTP-reachable agent-employee endpoint — confirmed necessary by
     actually running `redblue init`/`redblue attack` (real attacks are
     natural-language prompts for a conversational target, not TypeScript
     function calls; `redblue.yaml`'s real `target.kind: http` needs a
     `url`/`responsePath`). **Decided 2026-09-02, permanently**: when this
     endpoint ships, it wires into **Autogenous's** (Phase 4) flow, not
     into `@metaharness/redblue` — `ruclip-metaharness` (Phase 3) stays
     build-time-only forever, per `ADR-0001` amendment 7a and §5's updated
     text. Until then, ruClip's existing regression test suite
     (`RUCLIP-METAHARNESS.md` §3) is the ongoing verification that the
     vulnerabilities this repo's security reviews found and fixed stay
     fixed.
   - **Delivered this iteration** (`ACTOR-IDENTITY-VERIFICATION.md`,
     `src/control-plane/authorization/{actor-credential,credential-issuer}.ts`):
     `ActorCredential` (signed via `radio-moe`'s real `AgentFrame`
     `signFrame`/`verifyFrame`, §1-2), the single-use nonce replay guard
     (`memory_store`'s real `ttl` parameter, §3), and `mintActorCredential`/
     `resolveAdmittedIssuerKeys` (§4 — durable issuer keypair signing).
     Retrofitted **3 of the design's 5 named call sites**:
     `applyApprovalTransition`, `persistIssue`'s Guard C, and
     `persistHeartbeatSchedule` now take `ActorAuthorization` (a verified
     credential) instead of a caller-self-asserted `OrgMember` — the exact
     bypass security found (approve/reject with a forged, *different*
     `actorId` than the real submitter) is closed and regression-tested
     (`tests/control-plane/actor-identity-verification.test.ts`). 207 tests
     total (up from 195), `tsc --strict` clean, verified against the real
     installed `radio-moe@0.3.1` (not a mock) end to end, including real
     Ed25519 signing/verification. `radio-moe`'s `peerDependenciesMeta` is
     now `optional: false` (required for this mechanism specifically;
     `comms/agentbbs-notification-channel.ts`'s own, separate, best-effort
     signing usage is untouched).
   - **2 of the 5 named call sites deliberately NOT retrofitted — found
     while implementing, flagged rather than silently forced or silently
     skipped**: `mintHumanCommsAccess`
     (`comms/agentbbs-notification-channel.ts`) and
     `setInteractionProfileConsent`
     (`employee-augmentation/interaction-profile.ts`) are each the ONE
     currently-working, human-reachable path for their respective feature
     (comms onboarding; consent self-service) — both are already gated on
     `kind === 'human'` by their own logic, and `resolveVerifiedActor`
     unconditionally rejects every `kind: 'human'` OrgMember (§4's locked
     block decision). Retrofitting either would make it **permanently
     uncallable**, not more secure — a real functional regression, directly
     contradicting the block decision's own justification ("costs nothing
     functionally today... no dashboard/login flow ... yet anyway"), which
     is true for the other three sites but not these two. Left as they were
     (comms registration/human-join never took an actor param to forge in
     the first place — also a design-doc/reality mismatch, found and
     documented in the comms file's own header); both files carry a
     detailed code comment explaining why.
   - **Resolved (2026-09-01, team-lead, `ACTOR-IDENTITY-VERIFICATION.md` §4,
     commit `35a2a15`)**: the recommendation above was decided as the
     per-call-site scoping option — "block" applies only to the three sites
     that exercise authority on behalf of the company or grant
     access/effect visible to another party (approval decisions, comms-room
     registration, heartbeat creation); `setInteractionProfileConsent`
     (strictly self-referential, no other party affected) keeps its
     pre-existing `actor.id === orgMemberId` check, with the residual
     forgery risk there tracked as an accepted, pre-existing gap until
     Phase 2's real human-issuance work closes it. `mintHumanCommsAccess`
     needed no decision either way — it never had an actor param to
     retrofit or block. See the Phase 2 entry above, updated in lockstep
     (commit `717a649`).
   - **One necessary deviation from a literal reading of §5 items 1-2**: the
     design's own text ("hands \[the newly-minted credential\] back to the
     calling session for the *rest of that same flow* — e.g., threaded into
     `persistIssue`'s Guard C instead of a bare `actor`") and §3's single-use
     nonce are mutually exclusive if `applyApprovalTransition` and
     `persistIssue`'s Guard C each independently call
     `verifyActorCredential` on the *same* credential — the second call
     would hit its own nonce-replay guard and fail every legitimate
     approve/reject/submit. Resolved by verifying the credential exactly
     ONCE, at `applyApprovalTransition`'s own top (before any side effect,
     so replay protection actually gates the consequential `claims_*`
     mutations, not just the final persist step), and threading the
     resulting, already-verified `OrgMember` into `persistIssue`'s Guard C
     — which now accepts EITHER `{ actor: OrgMember }` (pre-verified,
     internal callers) OR `{ credential, admittedIssuerKeys }`
     (independently verified, standalone/direct callers) as a union type.
     Documented in both functions' own header comments.
   - **One radio-moe API surprise, resolved not blocked**: `PeerIdentity`
     (`credential-issuer.ts`'s original literal premise for a "durable,
     GCP-Secret-Manager-backed identity") has a `private constructor()` —
     its only public construction path is `PeerIdentity.generate()`, which
     always mints a fresh in-process keypair; there is no way to reconstruct
     one from an externally-stored private key. Confirmed by reading
     `radio-moe`'s compiled `dist/transport.js`/`dist/agent-frame.js`
     directly (not just the `.d.ts`), which also showed
     `PeerIdentity.sign()`/`signFrame`/`verifyFrame` are thin wrappers over
     plain `node:crypto` Ed25519 using the same DER SPKI encoding
     `generateKeyPairSync('ed25519', ...)` already produces. `credential-issuer.ts`
     therefore signs directly with `node:crypto` against a durably-stored
     keypair, reproducing `signFrame`'s exact byte contract via `radio-moe`'s
     own exported `canonicalBytes` — verification is completely untouched,
     real `radio-moe` `verifyFrame` end to end; only issuance needed a
     different mechanism than `PeerIdentity.generate()` offers. No real GCP
     secret is provisioned by this slice — `RUCLIP_ISSUER_SIGNING_SECRET`/
     `RUCLIP_ISSUER_SIGNING_PROJECT` name where one would be read from
     (`gcloud secrets versions access`, argument array not a shell string),
     and tests inject a throwaway, test-only keypair directly
     (`tests/support/actor-credential-fixture.ts`) — provisioning the real
     secret is a deployment-time step, tracked, not done here.
   - **One interpretation choice on agent issuance (§4), flagged for
     confirmation**: §4's own text describes minting a credential
     "immediately after `acceptClaimHandoff` succeeds inside
     `applyApprovalTransition`'s existing choreography." Implemented
     instead as a standalone `mintActorCredential` primitive, callable by
     whatever code establishes an agent OrgMember's first credential in a
     session — NOT nested inside `applyApprovalTransition` itself — because
     `applyApprovalTransition`'s own entry parameter is now
     `credential: ActorCredential` per §5 item 1 (every action, including
     `submit`, requires a PRE-EXISTING verified credential); nesting the
     mint inside would require the function to also accept a bare,
     self-asserted `actor` for its very first call, which would reopen
     exactly the gap this design closes. `claims_accept-handoff` succeeding
     is itself still just a self-asserted-claimant-string check (per §0's
     own finding) — it is not, by itself, proof of caller identity, so it
     was not treated as a sufficient anchor for an *automatic* internal
     mint. Genuinely ambiguous in the source document; implemented the
     interpretation that doesn't reopen the gap, flagged rather than guessed
     silently.
   - **Post-delivery security fix (commit `ebb1983`)**: two real issues found
     on top of the coder's own 12 passing tests. (1) The coder's own
     most-important regression test — "the exact scenario security found"
     (a forged credential naming a different `orgMemberId` than the real
     submitter) — was silently testing nothing, because a shared test
     helper was missing its `...overrides` spread, so every fixture came
     back with hardcoded default field values regardless of what the test
     asked for; fixed the helper, then re-verified the real production fix
     actually works once the test genuinely exercises it (it does). (2)
     `persistHeartbeatSchedule`'s authorization gate (§5 item 4) only
     covered the CREATE path, leaving RESUME (paused → active) completely
     unauthenticated — `fireHeartbeat` itself never resumes a schedule, so
     any caller reaching resume is unambiguously acting on a human/operator
     decision, not internal bookkeeping, and needed the same credential
     check as create. Fixed by requiring authorization specifically on the
     paused→active transition. Also made `checkAuthorizationGuard`'s
     cross-company check explicit (previously incidental) rather than
     relying on it falling out of other checks, mirroring
     `applyApprovalTransition`'s equivalent explicit check. 209 tests total
     (up from 207), `tsc --strict` clean.
4. **Phase 3 — ruclip-metaharness**: build-time bench suite, `score`/`genome`
   gates against the ruClip codebase. **Amended 2026-09-01**: no longer
   includes a runtime bench suite, `redblue`, or `flywheel` — that scope moved
   to Phase 4 below, so this phase governs the codebase only, matching §5's
   updated split.
   - **Delivered 2026-09-02** (`docs/design/RUCLIP-METAHARNESS.md`,
     `.harness/bench.json`): build-time genome wired to the real, already-
     built `metaharness_score`/`metaharness_genome`/`metaharness_mcp_scan`
     tools (pure-read, no bench.json needed — real measured output this
     iteration: `harnessFit: 72`, `taskCoverage: 79`, `toolSafety: 100`,
     genome `verdict: "ready"`). `.harness/bench.json` authored and
     **verified against the real `metaharness_bench --op verify` tool**
     (`"6 tasks, hash OK"`) — 6 tasks, `task-0001` the tool's own
     auto-generated smoke task plus 5 hand-authored governance tasks
     (approval-gate self-approval, budget hard-stop, actor-identity
     forgery, budget-gated heartbeats, `EmployeeInteractionProfile` access
     control) each wired to the real, already-passing test files that
     verify that property — wraps the existing 209+ tests rather than
     reinventing checks, per instruction.
   - **`@metaharness/redblue`/`@metaharness/flywheel` — investigated for
     real, not wired**: see the new Phase 2 prerequisite above and
     `RUCLIP-METAHARNESS.md` §3-4. Real, confirmed by actually running
     `redblue init`/`redblue attack`: `redblue` attacks a live,
     HTTP-reachable conversational agent endpoint, which doesn't exist in
     ruClip yet — no `redblue.yaml` committed, no false "security-tested"
     claim made against a target that isn't real. `flywheel`'s promotion
     gate (`confirm: true` + an approved Ed25519 key, never inferred) is
     documented but has nothing to gate yet either.
   - **Resolved 2026-09-02 (was flagged, now decided)**: this iteration's
     `@metaharness/redblue`/`flywheel` investigation was scoped by the
     original Phase 3 request, but team-lead confirmed the 2026-09-01
     Autogenous amendment (`ADR-0001` §7a) already settles this —
     Autogenous's antibody/canary/rollback model *replaces*
     `redblue`+`flywheel` as the runtime-governance layer, permanently, not
     just until both prerequisites happen to exist. `ruclip-metaharness`'s
     scope is build-time-only forever; `redblue`/`flywheel` are not part of
     its design now or later. `ADR-0001` §2 and `PLAN.md` §5 updated to
     state this explicitly so it doesn't get quietly re-proposed by a
     future slice.
   - **CI wiring delivered 2026-09-02** (`RUCLIP-METAHARNESS.md` §5 —
     coder stage): `package.json` gained five scripts —
     `harness:score`/`harness:genome`/`harness:mcp-scan` (advisory),
     `harness:advisory` (all three in sequence), and `harness:bench-verify`
     (the hard gate). `.github/workflows/ci.yml` runs `harness:advisory`
     with `continue-on-error: true` after `npm test` (never fails the
     build — no baseline history to threshold against yet, per §1's own
     instruction not to invent one) and `harness:bench-verify` with no
     such override (fails the build on `.harness/bench.json` tampering —
     verified live: corrupting one field flips `metaharness-darwin bench
     verify`'s exit code from 0 to 1 with a clear "taskHash mismatch"
     error). All four underlying invocations re-verified directly against
     the real installed binaries before wiring, not assumed from the
     design doc's own numbers alone.
   - **One real CLI surprise found while wiring, not in the design doc**:
     the `metaharness` npm package ships **two separate binaries** —
     `metaharness` (`dist/bin.js`, the project *scaffolder*) and `harness`
     (`dist/harness-bin.js`, an *already-scaffolded* project's own local
     CLI). `score`/`genome` work identically on either binary (confirmed —
     same output), but **`mcp-scan` exists ONLY on `harness`, not
     `metaharness`** — running `metaharness mcp-scan .` (the naturally-guessed
     form) does NOT scan anything; `mcp-scan` isn't a recognized subcommand
     on that binary, so it silently falls through to the scaffolder's
     top-level `<name> [--target <path>]` behavior and **creates an
     unwanted new project directory literally named `mcp-scan/`** in the
     repo root (caught immediately by `git status` before committing,
     deleted, not left behind). The correct, verified invocation is
     `harness mcp-scan --json`, which operates on the current directory by
     default and reproduces the design doc's exact expected output
     (`mcpEnabled: false`, the `"No MCP surface"` info finding). Separately,
     `harness score`/`harness genome` (same binary, different subcommand
     namespace than the scaffolder's own `score`/`genome`) emit a
     completely different, unrelated schema (`harness-quickcheck-v1`) AND
     `harness score` exits with code 2 even on a normal, successful-looking
     run — so `harness:score` in this repo's scripts deliberately uses the
     `metaharness` (scaffolder) binary, not `harness`, while `harness:mcp-scan`
     deliberately uses the opposite. Recorded here so a future edit doesn't
     "simplify" these three scripts onto one binary and reintroduce either
     bug.
   - **Confirmed systemic, not two one-off bugs (`ruclip-tester`,
     independently re-verified 2026-09-02)**: bare `metaharness bench` (no
     `--op`) has the identical pathology — silently scaffolds an unwanted
     `bench/` directory instead of doing anything bench-related, exit 0, no
     error (reproduced and cleaned up by both the coder and the tester,
     separately). What's actually wired here (`metaharness-darwin bench
     verify ...`, a third, distinct binary) correctly avoids this. **Rule of
     thumb for any future script addition**: never pass an unfamiliar verb
     to the bare `metaharness` binary without checking `--help`/`harness
     --help` first — an unrecognized subcommand doesn't error, it silently
     scaffolds a new project named after that verb.
5. **Phase 4 (NEW, 2026-09-01) — Autogenous runtime-governance integration**:
   wire `ruvnet/autogenous`'s antibody-package model as ruClip's live-company
   governance layer — typed mutation (a runtime failure: forged approval,
   budget-cap bypass, unauthorized agentbbs/AgentRadio post) → verifier
   admission → replay-measured fitness against a labeled corpus → staged
   canary 1→10→50→100% → cryptographically-signed promotion or automatic
   rollback. Its own phase, not folded into Phase 3, because it governs
   runtime behavior of the *live* company rather than the codebase — see §5's
   "superseded" note and ADR-0001 amendment 7a for why it's kept distinct
   from `ruclip-metaharness`'s build-time genome and from dream-machine's
   nightly repo-evolution loop (Phase 5 below), which it complements rather
   than duplicates.
6. **Phase 5 — Dream-machine nightly integration**: config + `/schedule`
   routine, first ledger rows. **Amended 2026-09-01**: rotation surface is
   codebase-only (§6) — no runtime `redblue` rotation here, that's Phase 4's
   job now.
   - **Delivered this iteration** (`docs/design/DREAM-MACHINE-INTEGRATION.md`,
     commit `a30ceab` — docs+config only, no application code, so this
     slice skipped straight from architect to reviewer): grounded in the
     real, installed `dream-machine@0.1.1` package (tarball pulled and
     `init`/`compile`/`schedule` actually run against this repo, not
     assumed) — `dream.config.json` (root, matching `package.json`/
     `tsconfig.json`'s existing convention), `docs/dream-cycle/PROMPT.md`
     (compiled prompt mirror), and `docs/dream-cycle/routine.json` (the
     `/schedule` payload). Two real defects in the generic scaffold were
     found and corrected before committing, not silently accepted:
     `adrConvention`'s string form hardcodes `docs/adrs/` (plural) — this
     repo's real directory is `docs/adr/` (singular) — fixed via the
     undocumented object form `{dir, pad}` found by reading `adrDir()` in
     the bundled source directly; `competitors` defaulted to a generic
     agent-framework list (LangGraph/AutoGen/CrewAI/…) irrelevant to
     ruClip's actual domain, replaced with the one real comparison point
     this project's own docs already name (`paperclipai/paperclip`).
     `evaluatorEntrypoints.bench` is `npm test` today — Phase 3's
     `ruclip-metaharness` bench suites and `security_bench`/`mcp_scan` are
     explicitly deferred as future evaluator entries, not fabricated as
     already wired. `autoMerge: false` and the routine's own compiled
     prompt both carry the "evaluation is never promotion, never merges"
     invariant this repo has held throughout (ADR-0001 §2, `AUTHORIZATION.md`
     §4's promotion-gate language, `HEARTBEATS-AND-COMMS.md`'s fail-closed
     discipline — same family of guarantee, applied here to nightly
     research output instead of a runtime action).
   - **Deliberately not invoked**: `routine.json`'s `environment_id` is left
     as an explicit placeholder (`REPLACE_WITH_CLOUD_ENV_ID`) — registering
     a live `/schedule` cloud cron routine is a different class of action
     than committing a repo file (it starts a recurring, unattended,
     budget-spending process against a real cloud environment) and is held
     for team-lead's explicit go, not bundled into this docs+config commit.
7. **Phase 6 (NEW, 2026-09-01) — Human Employee Augmentation**
   (see §7a above for the full design): per-person adaptive coaching for
   human `OrgMember`s via calendar/email/meeting-transcript signal
   ingestion, proactive nudges through the already-built `agentbbs`
   channel, gated on explicit per-employee opt-in and AIDefence PII
   scanning on every ingested signal (fail closed if consent or scanning
   status is unclear — never an ambient default). Sequenced here,
   deliberately after Phase 4 (Autogenous runtime governance) and Phase 5
   (dream-machine nightly integration) per the amendment. Reuses SONA +
   AgentDB pattern-store (scoped per `OrgMember`, not a global policy) and
   the `agentbbs`/`radio-moe`-signed notification channel — no new comms
   or learning infrastructure. Calendar/email/meeting-transcript connectors
   are external SaaS integrations, outside the ruvnet-only orchestration
   constraint (same distinction already drawn for GCP infra in §7).
   - **Delivered this iteration (Phase 6a, `docs/design/EMPLOYEE-INTERACTION-PROFILE.md`
     — the narrowest possible first slice, team-lead approved)**: a
     per-human-`OrgMember` `EmployeeInteractionProfile`
     (`schema/employee-interaction-profile.ts`) fed entirely by data ruClip
     already legitimately holds — `ApprovalTransition` timing — with
     **zero new external signal ingestion** and therefore no new
     PII-ingestion surface this slice (calendar/email/meeting-transcript
     connectors, AIDefence gating for them, and `preferredChannel`/`tone`/
     `intrusiveness` fields remain unbuilt, correctly deferred to a slice
     that has a real free-text/external signal to gate). Two privacy
     constraints were load-bearing from the start, not bolted on: **opt-in**
     (`setInteractionProfileConsent` — self-service only, hard-rejects any
     `actor.id !== orgMemberId`, no proxy/admin override exists as a code
     path; rejects a `kind !== 'human'` target; replaces rather than merges
     `consentedSignalTypes`, so withdrawing consent is the same code path
     as granting it) and **access control by function shape, not runtime
     check** — `recallOwnInteractionProfile(actor)` has no `orgMemberId`
     parameter separate from `actor.id`, and
     `recallInteractionProfileForComposition(companyId, orgMemberId)` has
     no `actor`/requester parameter at all; no function anywhere takes
     `(requestingActor, targetOrgMemberId)` as two independent parameters,
     locked down by a dedicated arity-based structural test so a future
     refactor can't quietly reintroduce that shape.
     `recomputeInteractionSignals` pairs each actor's approve/reject
     `ApprovalTransition` with the immediately-prior submit transition for
     the same `issueId` to derive a latency sample, recomputing
     `medianDecisionLatencySeconds` and a 24-bucket `decisionHourHistogram`
     fresh each call (not incrementally). `applyApprovalTransition` gained
     `deps.interactionLearning?: boolean` (default `false`/omitted, same
     non-blocking best-effort contract `deps.notifications` already has —
     a failure here never fails the approval decision). Storage:
     `memory_store`/`memory_retrieve` (not `agentdb_hierarchical-store` —
     see the grounding correction below) in a new, deliberately separate
     `ruclip-employee-profiles` namespace, `provenance_type:
     'system_observation'` (ADR-323). 195 tests total (up from 177),
     `tsc --strict` clean.
   - **One grounding correction made before any code was written** (same
     discipline as every prior slice): the amendment's "SONA + AgentDB
     pattern-store" reads naturally as the `ruvllm_sona_*` MCP tools, but
     those are local-model weight-adaptation with unconfirmed cross-session
     persistence from the schema alone — the same unverified-durability
     trap `CronCreate` turned out to be in `HEARTBEATS-AND-COMMS.md` §0
     Finding B. The durable per-person record uses `memory_store`/
     `memory_retrieve` instead (already proven reliable —
     `checkOperatingBudget`'s confirmed `upsert: true`), and its real
     `provenance_type` parameter genuinely **is** ADR-323's mechanism, not
     a guess. `ruvllm_sona_*` remains a real, correctly-scoped *future*
     option for personalizing generated message *text* once a slice has
     text to personalize — explicitly not used for storage.
   - **One new function beyond the design doc's own file list**:
     `listApprovalTransitionsForCompany` in `store/agentdb-adapter.ts` — a
     broad, client-side-filtered scan (same "list broadly, filter
     client-side" pattern `listDueHeartbeats` already established), needed
     because the median-latency pairing requires each actor's decision
     transition to be matched against the submit transition for the SAME
     issue, which may belong to a *different* actor — so a query scoped to
     one actor's own transitions alone isn't sufficient. Not exhaustive at
     very large transition counts (`topK` caps results per tier), matching
     `HEARTBEATS-AND-COMMS.md`'s own equivalent, already-accepted trade-off.
   - **Still remaining, named not hidden (§6 of the design doc)**: (1)
     `decisionHourHistogram`'s "hour of day" is UTC, not per-`OrgMember`
     local time — no timezone field exists on `OrgMember` yet; (2)
     withdrawing consent does not retroactively delete already-aggregated
     values, only stops future updates — a full right-to-erasure delete
     path is future work; (3) `recomputeInteractionSignals`'s per-call
     full-history recall/recompute is a reasonable v1 choice at expected
     volumes but isn't designed to scale indefinitely; (4) no read surface
     exists yet for a human to actually see their own profile (`docs/PLAN.md`
     Phase 2's dashboard is the natural future consumer of
     `recallOwnInteractionProfile`) — this slice built the substrate and
     the access-control boundary, not a UI. The full pipeline
     (coder → tester → security → reviewer) resumes on this slice per
     team-lead's explicit instruction, no shortcuts given the domain's
     sensitivity even though this particular slice has no external PII
     surface.
   - **Post-delivery security fix (commit `d8111e4`)**: the design's central
     "no other read path exists" guarantee (§2) was false as first shipped —
     `recallInteractionProfile`, the low-level primitive
     `recallOwnInteractionProfile`/`recallInteractionProfileForComposition`
     build on, was an exported, unrestricted function any code in the
     codebase could import and call with an arbitrary `orgMemberId`,
     bypassing both of the designed access paths entirely. Fixed by moving
     it and its two sibling low-level primitives out of
     `store/agentdb-adapter.ts` into `employee-augmentation/
     interaction-profile.ts` (their only legitimate caller's module) as
     private, unexported functions — the unsafe shape no longer exists to
     be imported, matching this design's own stated philosophy (§2: "not
     just that it's checked" but that the unsafe shape doesn't exist).
     Separately, a real actor-forgery gap in `setInteractionProfileConsent`
     was flagged during this pass as systemic — not scoped to this one
     function — and routed to team-lead, who escalated it to
     `ACTOR-IDENTITY-VERIFICATION.md` below rather than patching it locally.
8. **Phase 7 (optional)** — LatentMesh edge-resilience integration for
   agents operating without cloud connectivity, if a concrete use case
   emerges (e.g. via `ruflo-iot-cognitum`).
9. **Phase 1f (NEW, 2026-09-01, not started) — `radio-moe` cross-provider
   agent-dispatch**: route an agent-employee's actual dispatched work (the
   `fireHeartbeat` agent-assignee wake step, `HEARTBEATS-AND-COMMS.md` §3
   step 4) through `radio-moe@0.3.1`'s `Gate`/`Peer`/`Mesh` and its real
   backend adapters (`openRouterExpert`, `geminiExpert`,
   `CommandStreamingExpert` for `claude`/`codex`) — the correct, verified
   match for ADR-0001 amendment 7a's "cross-provider agent adapter" claim
   (confirmed by reading the published package's real `dist/index.d.ts` +
   README, not assumed). Numbered against Phase 1 rather than the Phase
   2-6 sequence because it's a follow-on to Phase 1's control-plane core,
   not an independent initiative. Explicitly **not** the same package as
   `NotificationChannel`'s `agentbbs` backend (`HEARTBEATS-AND-COMMS.md`
   §5) — `radio-moe` is request-routing/governance across LLM backends,
   not event/notification delivery; conflating the two would be the
   mistake this note exists to prevent. Not started — no code exists for
   this yet. (Stale as of the "round 5" delivery note above: the
   `agentradio-notification-channel.ts` stub this bullet originally
   contrasted against has since been deleted outright, not just corrected
   — `radio-moe`'s only role in the shipped code is the signing layer
   inside `AgentBbsNotificationChannel`. This Phase 1f item is unaffected;
   it was already describing a distinct, not-yet-built integration point.)
10. **Throughout** — test/validate/secure/benchmark/optimize each phase via
   the standard swarm protocol in this repo's `CLAUDE.md`, using
   `ruflo-testgen`, `ruflo-security-audit`, `metaharness security_bench`, and
   `ruflo-cost-tracker` for spend gates.

## 9. Open items carried forward (not blocking, tracked)

- `ruvector@0.2.25` pin vs. registry `0.3.0` drift — pre-existing, unrelated
  to ruClip, worth a separate fix.
- "Animated scrollyteller parallax narrative" from the mission brief maps to
  a marketing/docs landing page (Phase 2, alongside the dashboard) — both
  LatentMesh and dream-machine's own READMEs already demonstrate this exact
  pattern (`docs/media/*.jpg` + an animated GitHub Pages site) and can be
  used as the direct template rather than building the technique from
  scratch.
- Whoever owns the 6 existing `agentbbs-*` Cloud Run deployments in
  `cognitum-20260110` should be looped in before ruClip starts depending on
  them in case of naming/quota collisions.
