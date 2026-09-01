# ruClip — Architecture & Implementation Plan (draft for review)

Status: DRAFT — staged in `ruvnet/ruflo` branch `explore/ruclip-mission` pending
review. The `ruvnet/ruClip` repo is intentionally **not created yet** — that is
the one explicit checkpoint the user asked for before autonomous build
continues.

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
| `agentbbs` (npm `0.2.1`, `github.com/ruvnet/AgentBBS`) | **Already wired** via `plugins/ruflo-bbs-federation` (ADR-164), **already deployed**: 6 live Cloud Run services in `cognitum-20260110` (`agentbbs-web`, `agentbbs-self-*`, `agentbbs-test-*`, `agentbbs-think-pro-*`, `agentbbs-prof-qe-*`, `agentbbs-aass1122-*`) | Human+agent shared comms layer — the Slack-equivalent from the mission brief |
| [`ruvnet/LatentMesh`](https://github.com/ruvnet/LatentMesh) (Rust, 47 ADRs, "research prototype" status, has a `latentmesh-agentbbs-bridge` crate already) | Offline/edge agent mesh over LoRa/radio/audio — NOT a company-orchestration primitive | **Optional, Phase 2+**: only relevant if a "hire" needs to operate somewhere without cloud connectivity (field ops, IoT — see `ruflo-iot-cognitum` plugin). Not on the critical path for v1. |
| [`ruvnet/dream-machine`](https://github.com/ruvnet/dream-machine) (npm `dream-machine`, already running nightly against `ruvnet/ruflo` and `ruvnet/metaharness`) | Config-driven nightly evidence-gated evolution engine: `ledger → research → hypothesis → candidate → baseline → evaluation → adversarial critique → bounded Darwin → flywheel evidence → witness → issue → draft PR → ledger row`. **Never merges — draft PRs only.** | This *is* "nightly dream machine tasks for ruvnet." Integration = generate a `dream.config.json` for `ruvnet/ruClip` and register it the same way ruflo/metaharness already are. No new nightly system needed. |
| `@claude-flow/codex` dual-mode | Claude+Codex peer execution | Cross-model verification for ruClip's own build and for high-stakes agent "employee" decisions |

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
4. **Cross-provider agent adapter beyond Claude+Codex** (paperclip supports
   OpenClaw, arbitrary webhooks). Out of scope for v1 — ruvnet-only per the
   mission brief anyway.

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
   │ Agent    │        │ agentbbs   │        │ Semantic    │
   │ "employees" │◄──►│ (human+agent│◄──►    │ memory      │
   │ (ruflo Agent│     │ comms, live│        │ (ruvector +  │
   │  Teams,      │    │ Cloud Run) │        │  AgentDB)    │
   │  Claude+Codex│    └────────────┘        └─────────────┘
   │  peers)      │
   └──────────────┘
        │
   ┌────▼─────────────────────────────────────┐
   │ Custom "ruclip-metaharness" (governs both  │
   │ the build of ruClip AND its runtime ops)   │
   │ — score/genome/bench/redblue/flywheel      │
   └─────────────────────────────────────────┘
        │
   ┌────▼─────────────────────────────────────┐
   │ dream-machine nightly cycle (existing,    │
   │ generalized engine — config only, no new  │
   │ nightly system)                           │
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
  (every state transition witnessed), agentbbs message delivery, dashboard
  Artifact capability wiring.
- **Runtime genome** (`metaharness redblue` + `flywheel`): once ruClip is
  live, adversarially tests the *running company* — can an agent "employee"
  bypass a budget cap, forge an approval, or post to agentbbs without
  authorization? Findings feed `flywheel receipts` (immutable) and require an
  explicit `flywheel promote` — never auto-applied, mirroring dream-machine's
  "evaluation is not promotion" invariant.

Both are new `bench.json` suites under `ruvnet/ruClip/.harness/`, authored
with `metaharness bench verify`, not a new evaluation engine.

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
should include: the two new bench suites above, `redblue` adversarial runs
against the runtime, and `LEDGER.md` rows under `docs/dream-cycle/`. No new
nightly scheduler, no new GCP cron — reuse verbatim.

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
   budget-gated heartbeats, approval gates, signed audit trail, agentbbs wiring.
   - **Delivered this iteration** (commits `2952348`..`13ac549`): the
     Company/Goals/Issues schema (types + `assertValid*` validation) and the
     AgentDB adapter (hierarchical store/recall, tier placement, causal edges
     for `reports_to`/`parent_of`/`blocks`/`assigned_to`/`belongs_to`),
     covered by 70 tests (69 pass, 1 todo), `tsc --strict` clean, and a
     security pass that closed a key-collision/entity-confusion vuln (id
     charset restricted to `[A-Za-z0-9_-]{1,256}` in both the schema
     validators and the adapter's key builders — see commit `13ac549`).
   - **Still remaining for Phase 1**: budget-gated heartbeats,
     approval-gate *enforcement* (schema has `approvalState`/`budgetImpact`
     fields, but no `transitionApprovalState`-equivalent function exists
     anywhere in `src/control-plane` — a raw write can currently set
     `approvalState: 'approved'` directly, with no tamper-evidence such as
     approver id/timestamp/signature, and no enforcement of the
     draft→pending→approved/rejected state machine per
     `docs/design/DOMAIN-MODEL.md` §3), signed audit-trail wiring (no
     witness/ADR-103 hook point yet on Issue state transitions — recommend
     the eventual gate-enforcement layer write a witness entry in the same
     transaction as any `approvalState` transition, and have
     `assertValidIssue`/`persistIssue` reject a `done`-with-positive-
     `budgetImpact` write that doesn't cite one), and agentbbs wiring (not
     started).
3. **Phase 2 — Dashboard**: Claude Artifact-based company board (capabilities:
   live state, multi-viewer, saved documents).
4. **Phase 3 — ruclip-metaharness**: build-time + runtime bench suites,
   redblue adversarial harness, flywheel promotion gate.
5. **Phase 4 — Dream-machine nightly integration**: config + `/schedule`
   routine, first ledger rows.
6. **Phase 5 (optional)** — LatentMesh edge-resilience integration for
   agents operating without cloud connectivity, if a concrete use case
   emerges (e.g. via `ruflo-iot-cognitum`).
7. **Throughout** — test/validate/secure/benchmark/optimize each phase via
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
