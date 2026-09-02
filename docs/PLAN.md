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

- Org is `ruv.net` (id `885436984033`); **as a GCP org, "cognitum-one" is
  not a separate one** — it was a misreading of the `cognitum-20260110`
  project's display name "Cognitum." Corrected here so future GCP-project
  references use the right ID. **Disambiguation added 2026-09-02**: this
  is a claim about GCP org identity specifically, not about GitHub —
  `cognitum-one` the **GitHub org** (90+ repos, e.g. `cognitum-one/slack`,
  referenced in this doc's own Phase 2b notes below) is real and separate
  from both `ruv.net` and `cognitum-20260110`. The two systems' naming
  overlapping is coincidental, not evidence either claim is wrong.
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
   live state, multi-viewer, saved documents). **Split into 2a/2b,
   2026-09-02** (`docs/design/ACTOR-IDENTITY-VERIFICATION.md` §4 plus a
   direct investigation of the real Claude Artifact `artifact-capabilities`
   skill/type contracts this session): Claude Artifacts, as currently
   available to this account, have no capability that lets a page hand an
   external system a portable, verifiable proof of viewer identity — the
   one identity-adjacent capability (`user`, giving `Claude.user.id`) is
   real and documented (cross-referenced in `db.d.ts`/`room.d.ts`) but not
   in this account's available capability set, and even if it were, its
   guarantee is scoped to the artifact's own `db` privacy semantics, not
   exportable as a credential `ActorCredential` verification could check.
   Confirmed by reading the platform's real type definitions directly, not
   assumed; no capability grant is available to pursue further.
   - **Phase 2a (this iteration) — read-only company board**: Company/
     Goals/Issues visibility, heartbeat status, no write actions, no human
     identity needed. See `docs/design/RUCLIP-DASHBOARD.md`.
     - **Delivered 2026-09-02**: `store/agentdb-adapter.ts` gained
       `listGoalsForCompany`/`listIssuesForGoal` (RUCLIP-DASHBOARD.md §1's
       real gap — no primitive listed Goals/Issues scoped to a
       company/goal before this slice), following
       `listApprovalTransitionsForCompany`'s exact established pattern
       (broad `agentdb_hierarchical-recall` query, tier scan, malformed-entry
       skip). `dashboard/build-snapshot.ts`'s `buildDashboardSnapshot`
       composes `recallCompany` + those two + `getChildIssueIds`/
       `getBlockerIssueIds`/`recallOrgMember` resolution into one
       `DashboardSnapshot` plain-data object, embedded as static data in a
       published Claude Artifact (no `capabilities` declared, per §0).
       `operatingBudgetLevel`/`DEFAULT_OPERATING_BUDGET_THRESHOLDS` were
       exported from the adapter (previously module-private) so the
       Company budget display genuinely reuses `checkOperatingBudget`'s own
       50/75/90/100% alert ladder rather than duplicating the figures. 5
       new tests (214 total, up from 209), `tsc --strict` clean.
     - **One deviation from a literal reading of §1, found while
       implementing, not silently applied**: §1 states `listDueHeartbeats`
       "supplies heartbeat status directly — no gap there," but that
       function's own filter (`status === 'active' && nextFireAt <= now`)
       actively EXCLUDES a `status: 'paused'` schedule — exactly the state
       `fireHeartbeat`'s `pauseAndPersist` sets on a budget-blocked
       heartbeat. §2's own requirement ("blocked outcomes shown plainly,
       not hidden") is directly contradicted by reusing `listDueHeartbeats`
       as literally instructed — the single most dashboard-relevant
       heartbeat state would silently never appear. Added a new, separate
       `listHeartbeatsForCompany` (every schedule for a company regardless
       of status/due-ness, scanning both tiers a schedule can live in) and
       used that instead; `listDueHeartbeats` itself is untouched. Covered
       by a dedicated regression test proving the blocked/paused schedule
       is present where `listDueHeartbeats` would have dropped it.
     - **The Artifact page**: published at
       `https://claude.ai/code/artifact/f3356590-2d69-4452-af3a-df0bf1f20e56`
       ("Meridian Labs Board") with representative sample data matching
       `DashboardSnapshot`'s exact shape verbatim — swapping in a real
       `buildDashboardSnapshot()` result at publish time is the only change
       needed for a live company. Loaded `artifact-design` (utilitarian/
       dashboard treatment — summary before detail, state encoded in pill
       form not color alone) and `dataviz` (validated status palette: the
       skill's own reference `good`/`warning`/`serious`/`critical` hexes,
       fixed across both themes per that palette's own "never themed" rule;
       legibility comes from a colored dot + neutral-ink label, never
       colored text, since the reference palette's warning/serious steps
       are sub-3:1 by design and rely on the icon+label pairing as
       mitigation) before writing it, per that tooling's own rules. No
       runtime `capabilities` declared, matching §0's own conclusion. A
       blocked heartbeat and a blocked issue are both included in the
       sample data specifically to prove §2's "shown plainly" requirement
       renders correctly, not just parses correctly.
   - **Phase 2b — designed 2026-09-01**
     (`docs/design/HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md`): the human
     `HumanIdentityAttestation` *producer* — the piece
     `HUMAN-CREDENTIAL-ISSUANCE.md` §5 named as still open. Investigated
     first, per team-lead's instruction: Cognitum Slack identity
     (`cognitum-one/slack` ADR-0002/0015) is real and mature but has no
     export mechanism anywhere across its 20 ADRs, and is a different
     team's private repo — ruled out as ruClip's v1 producer, not assumed.
     Direction instead: a new, minimal `ruclip-attester` Cloud Run service
     (the Cloud Run fallback `ADR-0001` point 5 anticipated) plus a
     CLI-based `ruclip login` reusing a human's own already-authenticated
     `gcloud` identity — no new OAuth/browser consent flow. Team-lead
     approved the direction with one explicit requirement: design the
     Google-identity → `OrgMember.identityRef` mapping's write boundary
     precisely, since whoever can edit it can grant impersonation of a
     specific human employee. Resolved: **v1 has no runtime write path for
     that mapping at all** — it is a deploy-time GCP Secret Manager
     artifact, editable only by whoever already holds this repo's existing
     secret-edit/deploy authority (same per-secret IAM-scoping discipline
     as the npm-publish signing key and `credential-issuer.ts`'s own
     issuer key); a real self-service admin flow is explicitly deferred,
     since it would need an owner/admin concept the schema doesn't have
     yet (`OrgMember.role` is a free string; the only structural signal is
     `managerId: null` for the single root member — checked directly, not
     assumed). Dashboard write actions (approve/reject, consent-setting)
     remain out of THIS phase's scope — 2b is the CLI login/attestation
     producer only; whether/how the Artifact dashboard itself gets write
     actions is still open, unaffected by this design.
     - **Delivered 2026-09-02 (coder stage, awaiting architect
       verification)**: `services/ruclip-attester/` (new, standalone
       deployable — `src/server.ts` plain `node:http`, no framework;
       `src/attest-handler.ts` the pure, dependency-injected handler;
       `src/google-token.ts` wraps `google-auth-library@10.9.1`'s real
       `OAuth2Client.verifyIdToken`; `src/identity-map.ts`/`src/signing-key.ts`
       — both follow `credential-issuer.ts`'s exact GCP Secret Manager
       discipline, `execFile` argument array, never logged, env-var-named
       secrets, no hardcoded secret name/project) and
       `src/cli/ruclip.ts` (this repo's first CLI entry point,
       `package.json` `bin.ruclip`, one subcommand — `login`). Neither
       `human-identity-attestation.ts` nor `credential-issuer.ts` was
       touched — both consumed exactly as shipped. `google-auth-library`
       added as a real, direct dependency (was already present only as an
       undeclared transitive one). 30 new tests (18 attester + 6 CLI + 6
       already-existing-suite-adjacent), 291 total, `tsc --strict` clean on
       both Node 20.20.2 and Node 22.22.1.
     - **§4 step 2's flagged-as-unconfirmed app-level verification —
       CONFIRMED, live, not just unit-tested**: ran the real, compiled
       server against a genuine Google ID token from this session's own
       `gcloud` identity (`gcloud auth print-identity-token`, bare) —
       `RealGoogleIdTokenVerifier` correctly performed a live Google JWKS
       signature check, extracted `email`/`email_verified` accurately, and
       `handleAttestRequest` produced the correct `google:<email>`
       attestation end to end. This narrows what's genuinely still
       unconfirmed to ONE specific platform behavior this session could not
       test without deploying a new Cloud Run service (a real,
       partially-irreversible infra action requiring explicit
       authorization, not taken unilaterally, mirroring the standing
       discipline around risky actions this project has held throughout):
       **whether Cloud Run's own front-end proxy forwards the
       `Authorization` header through to the container** when
       `--no-allow-unauthenticated` — standard, documented Cloud Run
       behavior, but not independently reproduced here. This is the one
       piece that needs verifying against a real Cloud Run deployment of
       `ruclip-attester` itself, the same "confirm once deployed" pattern
       `autogenous-client.ts`'s own `--audiences` correction and §7's live
       verification already established for Autogenous.
     - The malformed/expired/wrong-issuer token cases the design asked to
       be tested are covered via an injected `GoogleIdTokenVerifier`
       interface simulating each outcome precisely — the real
       `google-auth-library`-backed verifier fetches Google's live JWKS
       *before* parsing the token at all (confirmed by reading its actual
       source, not the `.d.ts`), so exercising THOSE specific real
       rejection paths offline/in CI isn't possible without a live,
       genuinely-Google-signed-but-expired/wrong-issuer token, which this
       session has no way to fabricate. Documented in `google-token.ts`'s
       own header, same "confirmed vs. still assumed" honesty as every
       other live-service integration point in this project.
     - Reused the existing `humanAttestationFor`/`testAdmittedAttesterKeys`
       fixtures from `tests/support/actor-credential-fixture.ts` (already
       shipped for `human-identity-attestation.test.ts`) rather than
       building parallel ones.
   - **Review pipeline complete (2026-09-01)**: architect independently
     re-ran `tsc --strict` and the real suite (not just trusting the
     coder's numbers) — 291/291, clean. `ruclip-tester` did a full
     independent pass and confirmed the identity-mapping write-boundary is
     structurally absent (no write function anywhere, no route that could
     reach one), not merely conventionally enforced — the load-bearing
     claim for this whole phase. `ruclip-security` reviewed the two items
     flagged for explicit judgment: (1) `google-token.ts`'s deliberate
     audience-claim omission — confirmed safe, since a bare
     `gcloud auth print-identity-token`'s `aud` is a constant identical
     regardless of which service is called, so checking it provides no
     discriminating security value; Cloud Run's own per-service IAM invoker
     check is the real boundary. (2) `ruclip login` printing the raw
     `ActorCredential` to stdout — accepted as the right default (matches
     `gcloud`'s own `print-identity-token`/`print-access-token` convention,
     bounded by the credential's 15-min TTL + single-use nonce), with one
     small hardening landed: a stderr warning immediately before the
     credential JSON (commit `b48e079`), addressing the practical risk the
     TTL/nonce don't bound — terminal scrollback/screen-share/shell-history
     exposure for an interactive human, not scripted capture. Re-verified
     291/291 and `tsc --strict` clean after that fix. No blocking findings
     at any stage. Design-doc correction from the implementation stage
     (§4 step 2's audience-check assumption) recorded in commit `bf38d56`.
     Handed to `ruclip-reviewer` for final sign-off.
   - **Live deployment (2026-09-01, team-lead)**: `ruclip-attester` deployed
     to Cloud Run (`ruv-dev`),
     `https://ruclip-attester-875130704813.us-central1.run.app`,
     `--no-allow-unauthenticated`. Two real bugs found via actual live
     testing (an isolated, deployed-then-deleted echo service — not
     inferred): **(1)** Cloud Run's front-end DOES forward the
     `Authorization` header to the container (§7's flagged-unconfirmed
     item — now confirmed, closing it), but lowercases the auth scheme to
     `bearer`, and `attest-handler.ts`'s prefix check
     (`startsWith('Bearer ')`) is case-sensitive — every real
     IAM-authorized call currently 401s. **(2)** Cloud Run also replaces
     the forwarded JWT's signature segment with the literal string
     `SIGNATURE_REMOVED_BY_GOOGLE` — `RealGoogleIdTokenVerifier`'s
     cryptographic `verifyIdToken` call can never succeed against a real
     deployed request, only against the direct-to-process test the coder
     ran locally before deployment (a genuine, real Google-signed token,
     un-proxied). **Decided (team-lead)**: this is Cloud Run's own
     standard, documented pattern for services behind
     `--no-allow-unauthenticated` — the platform's IAM invoker check is
     the real authentication boundary (a request cannot reach the
     container without already passing it), so the forwarded, redacted
     token is handed to the app purely to read claims from, not to
     re-verify. Fix: decode-without-cryptographic-verification the
     claims, plus structural sanity checks (3 dot-separated segments,
     `iss` exactly `accounts.google.com`/`https://accounts.google.com`) in
     place of signature verification, documented in code as a deliberate
     choice (Cloud Run's IAM layer already did the real check), not a gap.
     Routed through the full pipeline again given this touches the auth
     verification path directly.
     - Also queued: `Dockerfile`'s own documented deploy command
       (`gcloud run deploy --source .` from repo root) silently falls back
       to Buildpacks and fails, since the Dockerfile lives in
       `services/ruclip-attester/` not the source root — **verified via
       `gcloud builds submit --help` directly** (not assumed) that
       `gcloud builds submit --tag` has no `-f`/`--dockerfile` override
       flag; team-lead's own phrasing named that flag but it doesn't exist
       on the real CLI. The two real working fixes: a `cloudbuild.yaml`
       with an explicit `docker build -f services/ruclip-attester/Dockerfile .`
       step (`--config=cloudbuild.yaml`, no `--tag`), or a local
       `docker build -f services/ruclip-attester/Dockerfile -t <image> .`
       → `docker push` → `gcloud run deploy --image`. Left the choice
       between the two to the coder/reviewer.
     - **Tracked, no code change**: ruClip's backend still has no dedicated
       service account with `roles/run.invoker` scoped to
       `ruclip-attester` — same open item already tracked for
       `autogenous-service` above.
     - **Fixed and CONFIRMED LIVE (2026-09-02, coder stage, this round)**:
       both bugs above. Rebuilt (`docker buildx build --platform linux/amd64`
       — the earlier local build silently produced an arm64 manifest that
       Cloud Run rejects, a real finding of its own, fixed by pinning the
       platform explicitly), pushed to
       `us-central1-docker.pkg.dev/ruv-dev/cloud-run-source-deploy/ruclip-attester`,
       and redeployed the real `ruclip-attester` Cloud Run service twice
       (once per fix round) — this is the verified working deploy path
       recorded in the Dockerfile's own header now, not just a claim.
       Confirmed via a real `curl` with this session's own
       `gcloud auth print-identity-token` against the live URL: the
       response moved from `{"error":"missing bearer token"}` (bug 1,
       pre-fix) all the way to a `handleAttestRequest`-internal rejection
       (post-fix) — i.e. the request now clears the Bearer-scheme check
       AND the token decode/issuer/expiry checks and reaches the identity
       lookup step, closing both bugs for real, not just in unit tests.
     - **A third real bug found only by actually deploying and testing live
       (not asked for, found anyway, per this project's standing "verify,
       don't assume" discipline)**: `identity-map.ts`/`signing-key.ts` both
       originally shelled out to the `gcloud` CLI (mirroring
       `credential-issuer.ts`'s own discipline) — confirmed via the real
       service's own Cloud Run logs that this throws `spawn gcloud ENOENT`,
       because the `node:20-slim` container has no `gcloud` CLI installed
       at all. `credential-issuer.ts`'s shell-out pattern is correct for
       ITS callers (this repo's own dev/CI/publish environment, which does
       have `gcloud` on `PATH`) but cannot work inside a server-side Cloud
       Run container. Fixed by switching both files to the official
       `@google-cloud/secret-manager@7.0.0` client library (Application
       Default Credentials — the service's own runtime service account,
       automatically; no CLI needed) — `credential-issuer.ts` itself
       untouched, per standing instruction. Redeployed and reconfirmed
       live: the `ENOENT` error is completely gone, replaced by a clean,
       expected `PERMISSION_DENIED` on `secretmanager.versions.access` —
       proof the SDK call now correctly reaches Secret Manager. New tests:
       `google-token.test.ts` (7 tests) — a genuine bonus from the
       signature-verification removal: the real `RealGoogleIdTokenVerifier`
       decode logic is now pure/offline-testable for the first time
       (previously only reachable via a live Google JWKS network call);
       plus a case-insensitive-Bearer test and a stale-comment fix in
       `attest-handler.test.ts`. 9 new tests (300 total, up from 291),
       `tsc --strict` clean on both Node 20.20.2 and 22.22.1.
     - **What's still blocking full live verification — an IAM grant this
       session did NOT make unilaterally**: the service's current runtime
       identity (`875130704813-compute@developer.gserviceaccount.com`, the
       default compute SA — confirmed via `gcloud run services describe`)
       has no `roles/secretmanager.secretAccessor` on either
       `ruclip-attester-identity-map` or `ruclip-attester-signing-key`
       (confirmed empty via `gcloud secrets get-iam-policy` on both, and no
       project-level grant either). Granting IAM access on a live GCP
       project is a real, if narrow, access-control change — treated the
       same as the standing discipline around deploying new infrastructure
       unilaterally, so this was NOT granted without asking. This is the
       natural moment to fold in the dedicated-service-account item already
       tracked two bullets up (`roles/run.invoker` scoping) — one service
       account, both grants, rather than patching the default compute SA's
       permissions piecemeal. Flagged to architect/team-lead; once granted,
       the remaining end-to-end check (mapping hit → real 200 with a signed
       attestation) can complete in a follow-up round.
     - **Architect independently verified (2026-09-02)**: re-ran `tsc
       --strict` and the full suite myself rather than trusting the
       reported numbers — 300/300, clean. Read every changed file
       (`attest-handler.ts`, `google-token.ts`, `identity-map.ts`,
       `signing-key.ts`, the `Dockerfile`, `package.json`) and confirmed
       `credential-issuer.ts`/`human-identity-attestation.ts` are
       genuinely untouched (empty diff). Design doc corrected to match
       (`docs/design/HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md`, commit
       `ad4b450`) — both the signature-redaction finding and the
       gcloud-CLI-unavailable-in-container finding were gaps in the
       original design's own assumptions, not coder oversights; recorded
       as such rather than left implicit. Routed to `ruclip-tester` again
       given this touches the auth verification path directly.
     - **`ruclip-tester` round-2 finding — single point of failure,
       demonstrated not just described (commit `170309f`)**: answered the
       architect's own review question ("is there any path where the
       container receives a request that didn't pass Cloud Run's IAM
       check") concretely — `RealGoogleIdTokenVerifier` checks only that a
       third JWT segment EXISTS, never its content; a completely
       fabricated token (never touched by Google, arbitrary third
       segment) is accepted and mints a real, validly-signed
       `HumanIdentityAttestation` for an attacker-chosen identity, proven
       end to end through the real `handleAttestRequest` pipeline. This is
       the honest, already-understood consequence of the decode-without-
       verify design (§4 step 2's Correction #2), not a new code bug — but
       it means the service's ENTIRE security model rests on one
       infrastructure setting (`--no-allow-unauthenticated`) with zero
       independent application-level backstop. Also confirmed the `exp`
       defense-in-depth check is trivially bypassed by simply omitting
       `exp` — exactly matching its own "not the real check" framing, no
       overreach. 303 tests total (up from 300). Architect independently
       re-ran `tsc --strict` and the full suite — confirmed clean. Handed
       to `ruclip-security` for the explicit call on whether this warrants
       an app-level or deploy-time mitigation, per the same escalation
       discipline this project has used for every other genuinely
       load-bearing security tradeoff.
     - **`ruclip-security` escalated, not signed off (2026-09-02)**: unlike
       the round-1 items (audience-check omission, stdout credential print
       — both traced through and accepted as benign), this one is judged a
       real, complete, working identity-impersonation exploit requiring no
       misconfiguration to trigger — ANY member of the `roles/run.invoker`
       Google Group, even one with zero identity-mapping entry of their
       own, can forge a JWT-shaped payload claiming any OTHER mapped
       employee's email and receive a fully valid
       `HumanIdentityAttestation` → `ActorCredential` for that identity.
       Escalated directly to team-lead with the full exploit trace and a
       recommended fix path (an Identity-Aware Proxy in front of Cloud
       Run, for a genuinely verifiable forwarded-identity channel that
       bare Cloud Run + IAM-invoker doesn't provide), plus an immediate,
       zero-code interim mitigation available via IAM config alone (make
       the invoker group's membership match the identity-mapping's
       keyspace exactly) while the real fix is designed. Independently
       verified `ruclip-tester`'s `forged-token-trust-boundary.test.ts`
       reaches the same conclusion by reading the code path directly —
       needs no changes. Not yet resolved — awaiting team-lead's decision.
     - **`ruclip-security` follow-up (2026-09-02)**: confirmed the IAP
       recommendation against Google's own documentation (not memory) —
       header/issuer/audience/JWKS endpoint all checked, including that
       `verifySignedJwtWithCertsAsync` (the same `google-auth-library`
       method already found in this project's history) is Google's own
       documented Node.js verification path for an IAP-signed
       `x-goog-iap-jwt-assertion` header. Recommending team-lead pursue
       IAP as the real fix — now with team-lead for the infra decision.
       Explicit call on the architect's own two proposed interim
       mitigations: **don't build #1** (the segment-content marker check)
       — agreed it's theater relative to the real threat model, since the
       marker string is now public (this project's own git history/
       PLAN.md), and could give false confidence that something was
       hardened when the actual vulnerability is untouched; **do build
       #2** (a deploy-time CI assertion against `--allow-unauthenticated`)
       — cheap, orthogonal, catches a real regression class, worth doing
       regardless of the IAP timeline. Net: no #1, build #2, real fix is
       IAP pending team-lead's infra decision.
     - **#2 delivered (2026-09-02, coder)**:
       `services/ruclip-attester/scripts/assert-not-publicly-invokable.ts`
       — `assertNoPublicInvoker` (pure, fixture-tested) throws if
       `ruclip-attester`'s real Cloud Run IAM policy ever grants
       `roles/run.invoker` to `allUsers`/`allAuthenticatedUsers`; a thin
       CLI wrapper (`npm run attester:assert-not-public`) shells out to
       `gcloud` (a CI/dev-environment context, not the attester's own
       server container — same distinction `identity-map.ts`'s header now
       documents) and is run manually/at deploy time, not wired into the
       existing credential-less `.github/workflows/ci.yml` (that workflow
       has no GCP auth configured; forcing this in would break CI for
       everyone, not narrow scope). **A real gap found and fixed while
       verifying live, not assumed**: `gcloud run services get-iam-policy`
       does NOT error for a nonexistent/typo'd service — it returns a
       valid, empty policy, which the guardrail would otherwise silently
       treat as "safe." Fixed by running `gcloud run services describe`
       first as an explicit existence check (confirmed that command DOES
       fail loudly for a real nonexistent service, verified by redirecting
       output to a file rather than piping — a pipe masks the real exit
       code behind its last stage, an easy way to be fooled). Verified all
       three states against the real deployed service: passes for
       `ruclip-attester` itself, fails loudly for a nonexistent service
       name, fails loudly with no `RUCLIP_ATTESTER_GCP_PROJECT` set. 7 new
       tests (310 total, up from 300), `tsc --strict` clean on Node
       20.20.2 and 22.22.1. Independent, narrow scope per instruction — no
       app code touched, full pipeline not required.
     - **Team-lead authorized IAP, sequenced in two steps (2026-09-02)**:
       (1) code first, through the full pipeline — verify
       `x-goog-iap-jwt-assertion` (issuer `https://cloud.google.com/iap`,
       audience `/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE_NAME}`,
       ES256 against IAP's published keys, `verifySignedJwtWithCertsAsync`)
       — **replacing**, not sitting alongside, the current decode-without-
       verify approach, since IAP gives a genuinely verifiable signature
       and the whole point is to stop trusting an unverifiable channel;
       explicit instruction to have the coder independently verify against
       the actual installed library source (not trust the docs' code
       sample blindly), same discipline that found the original redaction
       bug. (2) Deploy second, once code is ready and reviewed — enabling
       IAP on the live service (granting IAP's service agent
       `roles/run.invoker`, granting real users
       `roles/iap.httpsResourceAccessor`) is real infra change, routed the
       same way as the original deployment and the SA work — a dedicated
       task, empirically verified against the live service, reported back
       for the audit trail. Explicit ordering constraint: do not enable
       IAP on the live service before the code side can actually verify
       its header — a half-migrated state would break the service. **Hard
       gate, unchanged**: the identity-mapping secret stays empty until
       this is verified working end-to-end on the live service, not just
       in code review. Routed to `ruclip-coder`.
     - **Step 1 (code) delivered (2026-09-02, coder)**: `google-token.ts`
       rewritten to real ES256 cryptographic verification, replacing
       decode-without-verify entirely — confirmed against the actual
       installed `google-auth-library@10.9.1` source (`node_modules/
       google-auth-library/build/src/auth/oauth2client.js`), not a docs
       sample: `OAuth2Client#getIapPublicKeysAsync()` fetches
       `https://www.gstatic.com/iap/verify/public_key`; `#verifySignedJwt-
       WithCertsAsync(jwt, certs, audience, issuers)` does the real ES256
       verify (via the library's own `ecdsa-sig-formatter` JOSE→DER
       conversion) plus `iat`/`exp`/`iss`/`aud` checks and returns a
       `LoginTicket`; `getIapPublicKeysAsync()`'s `{kid: PEM}` output plugs
       directly into `verifySignedJwtWithCertsAsync`'s `certs` param. Also
       independently confirmed against Google's own docs
       (cloud.google.com/iap/docs/signed-headers-howto, fetched
       2026-09-02): issuer `https://cloud.google.com/iap` and the Cloud Run
       audience format both match the architect's message exactly; the
       library's `oauth2IapPublicKeyUrl` constant matches Google's
       documented endpoint verbatim; **IAP's JWT has no `email_verified`
       claim at all** (unlike a classic Google Sign-In ID token) — since a
       verified IAP `email` claim only exists because Cloud IAM already
       authenticated the caller, `verify()` now maps a successfully-
       verified token to `emailVerified: true` unconditionally rather than
       reading a nonexistent field, documented explicitly in the file
       header as a deliberate mapping, not an observed value. Audience is
       config/env-driven (`RUCLIP_ATTESTER_IAP_AUDIENCE`), fails closed
       with no live-value guess — confirming the real project number stays
       step 2's job.
       Also changed, following directly from the architect's header-name
       correction (`x-goog-iap-jwt-assertion`, not `Authorization`) and
       independently confirmed via the same Google doc fetch above (IAP's
       header carries the raw JWT with **no** `Bearer` scheme prefix,
       unlike the old `Authorization` header — and Google's own docs
       explicitly warn the convenience headers `x-goog-authenticated-user-
       email`/`-id` are forgeable by anyone who bypasses IAP, so this
       service correctly never reads them): `attest-handler.ts` no longer
       parses a `Bearer` scheme at all (took the raw header value
       directly); `server.ts` now reads `x-goog-iap-jwt-assertion` instead
       of `authorization`, with an explicit reject-not-silently-pick-one
       guard for the (IAP-never-sends-it) duplicated-header array case.
       `forged-token-trust-boundary.test.ts` — which previously
       demonstrated the forged-token exploit succeeding — now demonstrates
       it CLOSED (same forged-token shapes, flipped to `assert.rejects`,
       through both the verifier directly and the full
       `handleAttestRequest` pipeline). `google-token.test.ts` rewritten to
       exercise the real cryptography end to end: a real generated P-256
       keypair, real ES256 signing via the same `ecdsa-sig-formatter`
       conversion the library itself uses (added as a devDependency for
       this purpose), injected via the documented `config.publicKeys`
       test/dev escape hatch (bypasses only the live network fetch, never
       the crypto). Two tests specifically close the finding: a
       validly-signed token with its payload tampered with post-signing
       (email swapped, signature untouched) is now rejected, and a token
       signed with an attacker-controlled key claiming the real key's `kid`
       is rejected — both would have been silently accepted by the
       previous round's decode-only verifier. `google-auth-library` added
       back to `package.json` dependencies (`^10.9.1`, matching what was
       actually verified against). `tsc --strict` clean, full suite
       310 → 311 tests (net +1 after replacing the old decode-only tests
       in `google-token.test.ts`/`forged-token-trust-boundary.test.ts`/
       `attest-handler.test.ts` with real-crypto equivalents), 311/311
       passing on both Node 20.20.2 and 22.22.1.
       **What's confirmed-by-source vs. still pending step 2 (explicitly
       not done here)**: the cryptographic mechanism, endpoint URLs, claim
       names, and header contract above are all confirmed against real
       installed source and Google's own current documentation — not
       assumed. NOT yet confirmed, because IAP isn't live on the real
       service yet: the real `RUCLIP_ATTESTER_IAP_AUDIENCE` value for the
       actual deployed service (the real project number), and that IAP's
       real, live-issued JWTs match this shape byte-for-byte against this
       exact code path end to end. No "confirmed live" claim is made for
       this round — that is explicitly step 2's job. Hard gate unchanged:
       identity-mapping secret stays empty until step 2 verifies this
       working end-to-end on the live service. Handed off to
       `ruclip-tester` next per the full-pipeline routing (security-
       sensitive change).
   - The prerequisite bullets below (added 2026-09-01/02) describe exactly
     why 2b is needed — they remain accurate.

   `ActorCredential` verification (the
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
   - **Human credential issuance — first slice delivered
     (`docs/design/HUMAN-CREDENTIAL-ISSUANCE.md`,
     `src/control-plane/authorization/human-identity-attestation.ts`)**:
     the human-issuance gap this Phase 2 entry names above as a hard
     prerequisite now has a real primitive, not just a named gap.
     `HumanIdentityAttestation` (a short-lived, signed statement from an
     external attester that a human's identity has already been verified —
     shaped to carry a Cognitum Slack `user_id` via `identityRef`, per
     `cognitum-one/slack` ADR-0002/ADR-0015, though this module imports
     nothing from that repo) + `mintHumanActorCredential` (verifies the
     attestation, cross-checks it against the persisted OrgMember's own
     `identityRef`, then mints via the SAME durable-issuer-key
     `mintActorCredential` agent issuance already uses) is the human
     analogue of this Phase 2 entry's own agent-issuance anchor
     (`claims_accept-handoff` succeeding). `resolveVerifiedActor`
     (`actor-credential.ts`) now authorizes a `kind: 'human'` actor
     specifically when its credential carries the AgentDB-backed provenance
     marker `mintHumanActorCredential` writes — every other `kind: 'human'`
     credential (including one minted directly via the existing, unchanged
     `mintActorCredential`) stays blocked exactly as this Phase 2 entry's
     original decision locked down, confirmed by a regression test, not
     assumed. Full pipeline confirmed end to end: a human OrgMember can now
     actually call `applyApprovalTransition` to approve an issue, real
     `radio-moe` signing/verification throughout. **Still open**: no
     producer of a `HumanIdentityAttestation` exists yet — no login/
     dashboard flow calls this new mint function, so this narrows Phase 2's
     remaining prerequisite to "produce one signed statement" rather than
     "solve human authentication from scratch"; `setInteractionProfileConsent`'s
     residual `actor.id` forgery risk (§4's narrowed exception, above) is
     unchanged, deliberately out of this slice's scope. 222 tests total (up
     from 209), `tsc --strict` clean, verified against the real installed
     `radio-moe@0.3.1` end to end.
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
   - **Design delivered 2026-09-02** (`docs/design/AUTOGENOUS-RUNTIME-GOVERNANCE.md`):
     grounded directly in the real `ruvnet/autogenous` repo (`gh api`, real
     Rust source, not README prose) — confirmed no npm/WASM binding exists,
     but the repo ships a real, complete HTTP service
     (`crates/service`/`autogenous-service`) implementing the actual
     admission/canary/promotion API, purpose-built for exactly this Cloud
     Run deployment pattern. Team-lead authorized the real deployment to
     `ruv-dev` in parallel (separate from this design work). Every request/
     response type in the design doc is read from the real handler source
     and struct definitions, not assumed — including one real, non-obvious
     nuance: `/v1/agl/admit`'s `error`/`reason` fields are Rust `Debug`-
     formatted strings, not the `AdmissionError` type's own JSON
     serialization, so `error` uses PascalCase variant names while every
     other field on this API is snake_case. **v1 scope is deliberately
     narrow**: only `/v1/agl/admit`, `/v1/agl/fitness`, `/v1/canary/new`,
     `/v1/canary/observe` are wired — `/v1/promote`/`/v1/judges/evaluate`
     need a `Constitution` document (a governance decision, not a code
     task) and are scoped to Phase 4b. ruClip proposes only narrow,
     `auto_reversible`-authority, `routing_budget`-scoped configuration
     mutations (e.g. tightening a budget threshold after a repeated alert
     pattern) — never code, security-policy, or schema mutations. A
     mutation is never applied to `Company.budget` until a real
     `/v1/promote` success returns a signature (Phase 4b) — reaching
     `ReadyForPromotion` at 100% canary is where this slice's scope stops,
     matching "evaluation is not promotion" throughout this project.
     `CanaryController.audit` (the service's own signed audit log) is
     persisted verbatim into a new `AutogenousMutationRecord`, rather than
     ruClip inventing a parallel witness mechanism.
   - **Delivered 2026-09-02 (coder stage)** —
     `src/control-plane/governance/{autogenous-client,propose-budget-mutation}.ts`,
     `store/agentdb-adapter.ts`'s `persistAutogenousMutationRecord`/
     `recallAutogenousMutationRecord`. 23 new tests (251 total, up from
     228), `tsc --strict` clean, verified on both Node 20.20.2 and Node
     22.22.1.
     - **Confirmed against real behavior**: every one of the seven real
       `AdmitResponse.error` codes (§2.4) round-trips correctly, including
       the PascalCase-Debug-string-vs-snake_case nuance. `assertValidCanaryState`/
       `assertValidDecision` accept exactly §2.6's three/four hand-built
       fixture shapes and — the defensive boundary team-lead specifically
       asked for — throw `AutogenousClientError` on anything else, rather
       than silently passing an unexpected shape through;
       `createCanary`/`observeCanary` call these validators before
       returning. `AutogenousClientError` on unreachability propagates
       (never swallowed) through every call site, including
       `checkAndProposeBudgetMutation`'s own admit/canary-create calls.
     - **Live verification DONE (2026-09-02)** — the real deployment
       (`https://autogenous-service-875130704813.us-central1.run.app`,
       `ruv-dev`) exists now; ran §7's first-real-integration-test through
       the actual shipped TypeScript client (not just `curl` equivalence —
       a throwaway script imported the real compiled `getHealth`/
       `admitMutation`/`createCanary`/`observeCanary`, no
       `AutogenousClientError` thrown, every response accepted by
       `assertValidCanaryState`/`assertValidDecision` with no fixture
       guessing). **Everything §2/§2.6 documented is confirmed exactly
       right**: `GET /health` returns the five real planes
       (`constitutional`/`morphogenetic`/`simulation`/`execution`/`evidence`);
       `/v1/agl/admit`'s `error`/`reason` Debug-string format matches
       verbatim, including the PascalCase `Governed`/`AutoReversible`
       nuance for a real `AuthorityExpansion` rejection; `/v1/canary/new`'s
       real default `gates` match `DEFAULT_HARD_GATES` exactly
       (`min_safety: 0.99`, etc.); `CanaryState`/`Decision`'s externally-
       tagged shape is exactly §2.6's inference — `{"Serving": {...}}`,
       `{"RolledBack": {...}}`, `{"Advance": {...}}`, `{"RollBack": {...}}`
       all observed for real. One refinement to §2.4 worth naming: a
       *unit-variant* `AdmissionError` (e.g. `NoRollback`) Debug-formats
       with **no** `{...}` suffix — `reason` equals `error` verbatim in
       that case, not every rejection has a bracketed reason string. No
       code change needed (this repo's own types already treat both as
       plain `string | null`), but worth knowing when reading logs.
     - **One real, consequential finding from live testing — flagged to
       architect, not silently patched, per their explicit instruction**:
       `rollback_verified: false` is a **hard, binary gate** server-side,
       confirmed by a controlled A/B test against the live service —
       identical fitness values (`safety`/`governance`/`reliability`: 1.0,
       zero regressions/false-positives) produce an immediate
       `{RolledBack: ...}`/`{RollBack: ...}` when `rollback_verified` is
       `false`, and `{Advance: {to_pct: 10}}` when it's `true`, with
       nothing else different. `propose-budget-mutation.ts`'s
       `fitnessFromBudgetLevel()` currently hardcodes `rollback_verified:
       false` unconditionally ("never actually exercised, so never
       honestly claimed true") — a deliberately honest choice at design
       time that, per this live result, makes the v1 canary flow
       **functionally unable to ever advance past 1%** as currently
       written. This is a real design question (how does ruClip earn the
       right to honestly claim `rollback_verified: true` — a genuine
       rollback-verification step, or a different v1 scope entirely?), not
       a code bug to patch silently — reported to architect for a decision
       before touching `fitnessFromBudgetLevel()`.
     - **Resolved 2026-09-02 (team-lead), not just flagged**: v1's canary
       loop plateauing at 1% is **correct, intended v1 behavior**, not a
       bug — applying a real mutation to live `Company.budget` before
       Phase 4b's `Constitution`/authorization framework exists to govern
       who may do that would mean exercising authority ahead of its own
       governance, backwards from every other pattern this project holds
       (approval-gate, `claims_*` authorization, `ActorCredential`'s
       fail-closed defaults, dream-machine's own evaluation-is-not-
       promotion discipline). `fitnessFromBudgetLevel()`'s honest
       `rollback_verified: false` stays exactly as the coder wrote it — no
       code change from this decision. The plateau is functionally an
       `INCONCLUSIVE`-shaped outcome (dream-machine's own three-verdict
       discipline): real evidence gathered, no promotion possible yet, by
       design. `AutogenousMutationRecord.observations` (already shipped)
       already carries every reading needed to recognize this pattern — a
       future reporting surface over that history is a natural follow-on,
       not built today. Real mutation-application + rollback-verification
       (this finding's original open question) is now explicitly bundled
       into Phase 4b alongside the `Constitution`/authorization decision —
       one coherent scope, not two separate deferred half-decisions, since
       "apply and verify a real mutation" is meaningless without first
       deciding who's authorized to govern it.
     - **One live-testing correction to the design doc's own suggested
       verification command**: `gcloud auth print-identity-token
       --audiences=<baseUrl>` (§0's suggested command) **errors** for a
       plain authenticated user account — `"Invalid account type for
       --audiences. Requires valid service account."` — that flag needs
       either a real service-account key or
       `--impersonate-service-account`. The command that actually worked:
       a bare `gcloud auth print-identity-token` (no `--audiences`), since
       Cloud Run's IAM invoker check authorizes by caller identity, not by
       matching the token's audience claim, for an already-`roles/run.invoker`-
       granted caller. `tokenProvider` (`AutogenousClientConfig`, added
       this iteration per architect's `b325965`) is injectable and doesn't
       assume either command — this is purely a note for whoever next runs
       a manual verification.
     - 256 tests total (up from 251), `tsc --strict` clean.
     - **Mechanics invented beyond the design doc's own wire contract**
       (documented in `propose-budget-mutation.ts`'s own file header, not
       silently decided): the "3+ consecutive WARNING-or-worse within a
       bounded window" pattern needs its own small persisted rolling
       window — §4 names the trigger, not this mechanism — implemented as
       a feature-scoped `memory_store` namespace
       (`ruclip-autogenous-budget-triggers`), matching
       `employee-augmentation/interaction-profile.ts`'s precedent of
       keeping a feature's own storage private to its own file rather than
       adding a generic primitive to the adapter. `Genome.constitution` has
       no real value yet (Phase 4b hasn't authored one) — set to a
       documented placeholder (`'unconstituted'`), reasoned safe because
       none of the seven real `AdmissionError` codes concern this field's
       format; only `/v1/promote`/`/v1/judges/evaluate` (out of scope)
       actually need a real `Constitution`. `FitnessVector` fields with no
       way to be measured from a budget-config change alone
       (`task_quality`, `p99_overhead_ms`, `false_positive_rate`) get
       conservative, explicitly-documented defaults — never a value chosen
       to make a gate pass; `rollback_verified` is always `false` in this
       v1 flow since a rollback is never actually exercised here.
     - **Not wired**: `fireHeartbeat`'s own Gate 2 does not yet call
       `checkAndProposeBudgetMutation` — that integration point is a
       separate decision outside this slice's own file list (§7 names only
       the governance module + adapter functions), left for architect/
       team-lead to schedule. **Confirmed deliberate, not a scope gap
       (architect, 2026-09-02)**: `fireHeartbeat` is already-shipped,
       heavily-tested, production-critical code; wiring a live network call
       to an undeployed external service whose response-shape assumptions
       (§2.6) aren't yet verified directly into that hot path, before
       verification completes, would couple every heartbeat firing's
       success to Autogenous's availability/correctness ahead of what's
       actually confirmed — exactly the "ahead of what's verified" risk
       this project has consistently avoided elsewhere. Wiring this call
       site is deferred until after the §7 live-verification step passes,
       not forgotten.
   - **Live deployment confirmed (commit `b325965`, design-doc only, no
     PLAN.md update at the time — recorded here now)**: team-lead deployed
     `autogenous-service` to Cloud Run (`ruv-dev`),
     `https://autogenous-service-875130704813.us-central1.run.app`,
     `--no-allow-unauthenticated` (403 anonymous confirmed), `/v1/judges/keys`
     confirmed returning real production keys distinct from the DEV-seed
     fallback. `AutogenousClientConfig` gained `tokenProvider` — every call
     needs a bearer OIDC identity token, injectable rather than hardcoded to
     shelling out to `gcloud`. **Outstanding, not blocking**: ruClip's own
     backend has no GCP service account yet with `roles/run.invoker` on this
     service (same OIDC pattern already tracked for the AgentDB bridge,
     `ruvnet/ruClip` issue #1) — a concrete next step, correctly flagged
     rather than decided unilaterally.
   - **Post-delivery security fix (commit `5d5745a`)**: `checkAndProposeBudgetMutation`'s
     trigger was level-triggered, not edge-triggered — a sustained
     WARNING-or-worse streak resubmitted a brand-new `/v1/agl/admit` +
     `/v1/canary/new` pair on every reading after the 3rd consecutive one,
     not just once per incident (since this v1 flow never actually updates
     `Company.budget.hardStopThreshold`, the caller passes the identical
     threshold on every check for as long as the incident persists — nothing
     marked a streak as "already proposed for"). Given the service is now
     live, an unbounded incident would have produced an unbounded stream of
     duplicate mutation/canary submissions to a real external governance
     service — directly undermining the "bounded, auditable mutations"
     premise this whole integration exists for. Confirmed exploitable by an
     independent test (4 consecutive WARNING readings produced 2 distinct
     admit+canary pairs). Fixed by making the pattern edge-triggered: fires
     once when the streak first crosses the threshold, stays silent for the
     rest of that incident, and correctly fires again if the streak breaks
     and a genuinely new incident begins later. 253 tests total (up from
     251), `tsc --strict` clean.
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
9a. **Bridge-client hardening (delivered this iteration, PR to `ruvnet/ruClip`
   requested via ruClip#1)** — two corrections to `store/bridge-client.ts`
   against the real, published bridge (`ruflo@3.38.20`, `ruflo mcp start -t
   http`), found by running it, not assumed from the MCP spec: (1) a bare
   `tools/call` came back `{"error":{"code":-32002,"message":"Server not
   initialized"}}` — the bridge requires a JSON-RPC `initialize` request
   (answering with `protocolVersion:"2025-11-25"`,
   `serverInfo.name:"Claude-Flow MCP Server V3"`) followed by a
   `notifications/initialized` notification first, and MAY return an
   `Mcp-Session-Id` response header that must be echoed back on every later
   request. `callTool` now performs this handshake lazily, once per
   (fetch implementation, baseUrl) pair, caches the in-flight promise so
   concurrent first calls don't double-initialize, and re-runs it exactly
   once on a `-32002` so a bridge that restarted (and forgot the session)
   self-heals instead of failing forever. (2) A Cloud Run bridge deployed
   IAM-protected (no `--allow-unauthenticated`) needs a Google OIDC
   `Authorization: Bearer` header on every request. New `store/bridge-
   auth.ts` implements this — the same metadata-server pattern already
   verified working in `cognitum-one/slack`'s `src/harness.rs::id_token()`
   (`GET http://metadata.google.internal/.../identity?audience=<bridge
   origin>` with `Metadata-Flavor: Google`) — deliberately **opt-in**
   (`AgentDbAdapterConfig.auth: 'gcp-oidc'` / `RUCLIP_BRIDGE_AUTH=gcp-
   oidc`, default `'none'`), fail-closed (a token-fetch failure throws
   `AgentDbBridgeError` rather than falling through unauthenticated), with
   the identity token cached and proactively refreshed off its own decoded
   (not verified — the bridge verifies) `exp` claim. Both files stay
   dependency-free leaves (`node:` builtins only), split across two files
   to keep each under the repo's ~500-line convention and to avoid
   recreating the exact two-way class-heritage import cycle
   `bridge-client.ts`'s own header describes having broken once already:
   `bridge-auth.ts` throws plain `Error`s rather than importing
   `AgentDbBridgeError`, so the dependency between the two files stays
   one-directional. `tests/support/mock-bridge.ts` (and the one pre-
   existing local copy of it in `src/control-plane/store/agentdb-
   adapter.test.ts`, found stale by running the suite, not by reading)
   were both updated to answer `initialize`/`notifications/initialized`
   generically, so every one of the existing 222 tests kept passing
   unchanged; 11 new tests cover the handshake ordering/caching/session-id/
   retry-once behavior and the OIDC opt-in/cache/fail-closed/off-by-default
   behavior — 233 tests total, `tsc --strict` clean.
10. **Throughout** — test/validate/secure/benchmark/optimize each phase via
   the standard swarm protocol in this repo's `CLAUDE.md`, using
   `ruflo-testgen`, `ruflo-security-audit`, `metaharness security_bench`, and
   `ruflo-cost-tracker` for spend gates.

## 9. Open items carried forward (not blocking, tracked)

- **Fixed 2026-09-02 (`scripts/run-tests.mjs`)**: `.github/workflows/ci.yml`
  pins `node-version: 20`, but `package.json`'s `test` script passed a
  quoted glob (`"dist/**/*.test.js"`) directly to `node --test` — glob
  expansion by the test runner itself is a Node 22+ behavior; on Node 20 it
  is treated as a literal filename and fails with `Could not find`. This had
  been failing on every CI run on `main`, unnoticed locally because every
  local dev environment here runs Node 22+. Reproduced and confirmed fixed
  on both Node 20.20.2 (via `nvm use 20`) and Node 22.22.1 before committing,
  not assumed. Fix: `scripts/run-tests.mjs`, a dependency-free script that
  walks `dist/` recursively for `*.test.js` (both `dist/src/**` — coder-stage
  colocated tests — and `dist/tests/**` — independent test-stage coverage;
  narrowing the walk to just `dist/tests/` would have silently dropped 2 of
  17 test files) and spawns `node --test` with an explicit file list, so it
  depends on neither Node's own glob support nor which shell `npm` invokes
  scripts with (an unquoted glob would depend on bash's globstar, which dash
  doesn't support). Verified a genuinely failing test still exits non-zero
  through the new script before committing.
- **Reconciled 2026-09-02 (post-merge, team-lead)**: an external PR (#3,
  from the same Cognitum-integration team as PR #2) independently found the
  same underlying Node-version CI failure and fixed it differently — bumped
  `.github/workflows/ci.yml`'s runner to `node-version: 22`, deliberately
  leaving `package.json`'s `engines.node ">=20"` claim untouched. Reasoned,
  but it means CI stops verifying that `>=20` claim at all. Merging
  `origin/main` brought that change in alongside `scripts/run-tests.mjs`
  above; since our fix makes Node 20 CI pass correctly on its own merits
  (confirmed on both 20.20.2 and 22.22.1, not assumed), `node-version: 20`
  was restored in the merge rather than keeping their `22` — this is not an
  arbitrary override of a good-faith external contribution, it's that our
  fix (built after theirs, with the benefit of already having root-caused
  the failure more thoroughly) makes their tradeoff unnecessary and
  restores real `>=20` verification. Recorded here per team-lead's explicit
  instruction, so the reasoning behind reverting part of an external PR
  during the merge is visible, not silent.
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
