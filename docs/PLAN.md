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

## 5. Custom metaharness for ruClip (build + ops)

Two distinct evaluation surfaces, both riding the existing `metaharness`
primitives already in this repo (`plugins/ruflo-metaharness`) rather than a
parallel implementation — matching the ADR-150 "removable, optional peer"
constraint:

- **Build-time genome** (`metaharness genome`/`score`): scores the ruClip
  *codebase itself* against a bench suite covering — org-chart schema
  correctness, approval-gate enforcement (no action executes without a
  satisfied gate), budget-hard-stop correctness, audit-trail completeness
  (every state transition witnessed), agentbbs/AgentRadio message delivery,
  dashboard Artifact capability wiring.
- **Runtime genome — superseded by Autogenous (2026-09-01 amendment)**:
  rather than a from-scratch `redblue`/`flywheel` adversarial harness for the
  *live* company, ruClip adopts `ruvnet/autogenous`'s antibody-package model
  directly — a runtime failure (a forged approval attempt, a budget-cap
  bypass, an unauthorized agentbbs/AgentRadio post) becomes a typed, signed
  antibody candidate, admitted only if it beats the parent behavior on a
  labeled corpus, staged through canary 1→10→50→100%, and automatically
  rolled back on regression. This is a stricter, already-implemented version
  of the originally-sketched `redblue`+`flywheel` design — see §8 Phase 4,
  its own roadmap phase rather than folded into `ruclip-metaharness`.
  `metaharness`/`flywheel` remains the mechanism for *build-time* (nightly,
  via dream-machine) evolution; Autogenous governs *runtime* evolution. Both
  share the same "evaluation is not promotion without a signed gate"
  discipline.

The build-time genome above is a new `bench.json` suite under
`ruvnet/ruClip/.harness/`, authored with `metaharness bench verify`, not a
new evaluation engine.

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
   - **Still remaining**: `claims_claim` is not wired into issue
     creation/assignment (`AUTHORIZATION.md` §5 — the natural extension
     point is the existing `assigned_to` causal-edge write in
     `persistIssue`, not built this slice); the real `claims_list`/
     `claims_board` response shape is verified only by reading
     `v3/@claude-flow/cli/src/mcp-tools/claims-tools.ts` in the ruflo
     monorepo directly, not against a live running bridge — the
     `claims_board` fallback path this repo's own tests exercise has never
     actually run against a real `ruflo mcp start -t http` process; the
     real `WitnessHook` implementation (ADR-103) is still unbuilt (Phase 1c
     gap, unchanged); budget-gated heartbeats and `agentbbs` wiring remain
     not started.
3. **Phase 2 — Dashboard**: Claude Artifact-based company board (capabilities:
   live state, multi-viewer, saved documents).
4. **Phase 3 — ruclip-metaharness**: build-time bench suite, `score`/`genome`
   gates against the ruClip codebase. **Amended 2026-09-01**: no longer
   includes a runtime bench suite, `redblue`, or `flywheel` — that scope moved
   to Phase 4 below, so this phase governs the codebase only, matching §5's
   updated split.
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
7. **Phase 6 (optional)** — LatentMesh edge-resilience integration for
   agents operating without cloud connectivity, if a concrete use case
   emerges (e.g. via `ruflo-iot-cognitum`).
8. **Throughout** — test/validate/secure/benchmark/optimize each phase via
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
