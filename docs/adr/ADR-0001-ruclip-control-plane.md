# ADR-0001: ruClip — ruvnet-only agent-run company control plane

- **Status**: proposed
- **Date**: 2026-09-01
- **Deciders**:
- **Tags**: ruclip, metaharness, dream-machine, agentbbs, ruvector, latentmesh, agent-teams

## Context

The mission brief asked for a ruvnet version of
[paperclipai/paperclip](https://github.com/paperclipai/paperclip) — named
"ruClip" — intended to become its own repo (`ruvnet/ruClip`), using **only**
ruvnet-owned tools/packages, to manage an AI-driven company end-to-end.

Research this session (deep-researcher agent + direct `gh`/`npm` verification)
established:

- Paperclip is MIT-licensed Node/React/TypeScript, and is **not an agent
  framework** — it is a control plane above whatever agents you plug in
  (Claude Code, Codex, webhooks): org-chart, budget-gated heartbeats,
  task/approval workflow, signed audit trail. It does not itself ship
  sales/eng/support/finance automation.
- Of the tools named in the brief, `ruflo`, `metaharness` (npm `0.4.8`),
  `ruvector` (npm `0.3.0`), and `agentbbs` (npm `0.2.1`,
  `github.com/ruvnet/AgentBBS`) are real and already integrated into this
  repo. `agentbbs` is further along than expected: already wired via
  `plugins/ruflo-bbs-federation` (ADR-164) and already deployed as 6 live
  Cloud Run services in GCP project `cognitum-20260110`.
- `ruview` (the brief's guess) resolves to `@ruvnet/ruview`, a WiFi-sensing
  hardware harness — not a company-orchestration building block, and not
  used by this ADR.
- `latentmesh` and "nightly dream machine tasks" were initially unresolved by
  web/npm search (too recent to be indexed) but confirmed directly via `gh
  repo view` to be real, public repos: `ruvnet/LatentMesh` (offline/edge
  agent mesh over LoRa/radio/audio, Rust, 47 ADRs, "research prototype"
  status) and `ruvnet/dream-machine` (a config-driven nightly
  evidence-gated repo-evolution engine, **already running nightly against
  `ruvnet/ruflo` and `ruvnet/metaharness`**, never merges — draft PRs only).
- No dedicated web dashboard/UI product exists anywhere in the ruvnet stack
  today — the stack is CLI/MCP/plugin-first. This is the largest genuine gap
  relative to paperclip's core UX.
- No GPU quota exists in either `ruv-dev` or `cognitum-20260110` (the only
  two GCP projects checked with relevant infra); "cognitum-one" is not a
  separate org, just a misreading of `cognitum-20260110`'s display name
  "Cognitum" — the actual org is `ruv.net` (id `885436984033`).

Full findings, capability-mapping table, phased roadmap, and open risks are
recorded in `docs/PLAN.md` (the research and initial scaffold were staged in
`ruvnet/ruflo` branch `explore/ruclip-mission` before this repo was created
via `ruflo eject`; this ADR and `docs/PLAN.md` are this repo's own copies,
kept in sync with amendments made upstream — see the 2026-09-01 amendment
below).

## Decision

Build ruClip entirely on existing ruvnet-owned components rather than
adopting paperclip's own Node/React/Postgres stack:

1. **Orchestration substrate**: ruflo Agent Teams (`SendMessage`), `claims_*`
   work-ownership primitives, and the `witness` signed audit manifest
   pattern (ADR-103) as the company's immutable activity log.
2. **Governance/quality**: `metaharness` (already integrated, ADR-150) via a
   new custom `ruclip-metaharness` bench suite — **build-time genome only,
   permanently** (org-chart schema correctness, approval-gate enforcement,
   budget hard-stops, audit completeness): `metaharness score`/`genome`
   scoring the codebase and a `.harness/bench.json` task corpus verified
   against `metaharness bench verify`. **`@metaharness/redblue` adversarial
   testing of the live company is explicitly not part of this bench
   suite's design, now or later** — superseded by Autogenous (Phase 4) per
   amendment 7a below, which already states Autogenous's antibody/canary/
   rollback model replaces the from-scratch `redblue`+`flywheel` runtime-
   genome sketch this point originally carried. When Phase 2 ships a live
   agent-employee target, it gets wired into Autogenous's flow, not into a
   resurrected `redblue` integration here — this is a permanent scope
   split, not a deferral pending both prerequisites existing.
3. **Memory**: `ruvector` + AgentDB (`v3/@claude-flow/memory`) for semantic
   memory, and as the substrate for the one genuinely new data model this
   project needs — a thin Company → Goals → Issues (parent/child, blockers,
   single-assignee) schema layer, not a new database.
4. **Human+agent comms**: `agentbbs`, reused as-is via the existing
   `plugins/ruflo-bbs-federation` wiring and existing Cloud Run deployment —
   no new comms infrastructure.
5. **Dashboard**: a Claude Artifact with runtime capabilities (multi-viewer
   state, saved documents) as v1, deferring a dedicated hosted web app
   unless Artifact capabilities prove insufficient.
5a. **Amendment (2026-09-02, pre-acceptance)** — investigated the real
   Claude Artifact runtime-capability contract (`artifact-capabilities`
   skill, the platform's actual `claude.d.ts`/`db.d.ts`/`artifact.d.ts`
   type definitions) rather than assuming point 5's phrasing held. Two
   corrections:
   - **"Live state" is corrected to periodically-republished snapshot
     state** for the read-only company-board portion (Phase 2a,
     `docs/design/RUCLIP-DASHBOARD.md`) — the `db` capability that would
     give genuinely live multi-viewer sync is written to from inside a
     page's own client-side JS, and ruClip has no publicly-reachable
     endpoint for a page to fetch live state from. The `artifact`
     capability's republish-on-change model (an agent with backend access
     periodically republishes the board with current state embedded,
     labeled with its publish time) is what's real and buildable today.
   - **Point 5's own already-anticipated fallback is confirmed triggered,
     not hypothetical**: no capability among the seven available to this
     account (`artifact`, `db`, `downloads`, `mcp`, `room`, `sample`,
     `self`) lets a page hand ruClip's backend a portable, verifiable proof
     of human identity — Artifact capabilities have proven insufficient for
     the write/approval/consent side specifically, per point 5's own
     stated condition. That side (Phase 2b) needs "a dedicated hosted web
     app" as point 5 already named — concretely, the Cloud Run path,
     scoped in its own future design pass rather than folded into Phase 2a.
     See `docs/PLAN.md` §8 Phase 2's split for the phased handling.
6. **Nightly evolution**: integrate with `ruvnet/dream-machine` by
   generating a `dream.config.json` for `ruvnet/ruClip` and registering a
   `/schedule` cloud routine — the same mechanism already running nightly
   for `ruflo` and `metaharness`. No new nightly scheduler is built.
7. **Edge resilience**: `ruvnet/LatentMesh` is explicitly **out of the v1
   critical path** — deferred to an optional later phase for agents needing
   offline/field operation (via `ruflo-iot-cognitum`), since it solves a
   connectivity-transport problem orthogonal to company orchestration, and
   is itself still a "research prototype."
7a. **Amendment (2026-09-01, pre-acceptance)** — `ruvnet/autogenous`
   ("Governed Evolutionary Software," research-prototype status) is folded
   in for two capabilities, replacing what was previously scoped as
   from-scratch work:
   - **Cross-provider agent adapter**: `packages/radio-moe` (AgentRadio) is
     a real, ed25519-signed, live-verified streaming mixture-of-agents mesh
     already running Claude/Codex/OpenRouter/Gemini backends. This
     supersedes point 4's prior "out of scope for v1" stance on adapters
     beyond Claude+Codex — ruClip's agent "employees" route through
     AgentRadio rather than a bespoke adapter layer.
   - **Runtime governance layer**: Autogenous's antibody-package model
     (typed mutation → verifier admission → replay-measured fitness →
     staged canary 1→10→50→100% → signed promotion or automatic rollback,
     authority-never-expands as a type-level invariant) replaces the
     from-scratch "runtime genome" sketched in §5 of `docs/PLAN.md` as the
     mechanism for governing the *live* company's agent-taken actions,
     complementing rather than duplicating `metaharness`/`dream-machine`'s
     nightly *repo*-evolution loop — Autogenous governs runtime behavior,
     dream-machine governs the codebase. `docs/PLAN.md` records the
     concrete re-scoped roadmap phase.
7b. **Amendment (2026-09-01, pre-acceptance)** — ruClip's scope expands
   from "orchestrate AI agent employees" to "optimize every employee,
   human and AI, working alongside the system" — the user's framing: "a
   kind 10,000x multiplier." Concretely: analyze existing human employees'
   work habits, calendars, emails, AI-meeting-recorder transcripts, and
   other available signals; support direct messages, reminders, and
   proactive nudges aimed at improving individual performance; learn
   per-person over time how to best interact with each individual (tone,
   timing, channel, intrusiveness) rather than applying one generic
   policy; keep guidance subtle and proactive, not a surveillance
   dashboard.

   Architecturally, this treats human `OrgMember`s (already a first-class
   entity in the Company/Goals/Issues schema per point 3) as subjects of
   the *same* adaptive-learning loop originally scoped only for AI agent
   employees, using components already in this ADR rather than new ones:
   - **Per-person adaptation**: SONA + AgentDB pattern-store, scoped per
     human `OrgMember` (not a global policy) — both already core to
     `ruflo`.
   - **Proactive delivery**: the `agentbbs` notification channel already
     built for approval-gate/heartbeat events (with the `radio-moe`
     Ed25519-signing layer added in the same phase as this amendment) is
     reused as the DM/reminder/nudge channel — no separate comms system.
   - **Signal ingestion is explicitly *not* part of the "ruvnet-only"
     orchestration-substrate constraint** — calendar, email, and
     meeting-transcript sources are inherently third-party SaaS surfaces
     (Google Calendar/Gmail-style APIs, generic meeting-recorder
     transcripts) that any real company's employees already use; ruClip
     integrates with them as external data sources the same way it would
     integrate with any company's existing tools, the same distinction
     already drawn for Cloud Run/GCP infrastructure in point 9. What stays
     ruvnet-only is the orchestration/learning/governance layer acting on
     that data.
   - **Privacy is a hard constraint, not an implementation detail**:
     calendar/email/meeting-recording access is sensitive PII. Any signal
     ingested must pass through this repo's existing AIDefence
     PII-scanning discipline, carry ADR-323-style provenance tagging, and
     require explicit per-employee opt-in — this is not built as an
     always-on surveillance layer by default. This constraint is
     load-bearing for acceptance, not a nice-to-have.

   This is its own roadmap phase (Human Employee Augmentation), sequenced
   after the Autogenous runtime-governance phase and dream-machine nightly
   integration — see `docs/PLAN.md` §8 for the concrete phase placement.
8. **Secrets**: wrap the existing GCP Secret Manager pattern already used
   for the npm publish signing key, rather than building a new secrets
   store.
9. **GCP**: no GPU provisioning is assumed or requested by this ADR; cleared
   only for minimal non-GPU dev-tier Cloud Run/VM reuse. A GPU quota
   request is a separate, explicitly-budgeted future decision.
10. **Repo creation is gated**: `ruvnet/ruClip` is created via `npx ruflo
    eject --name ruClip` from a scaffold built in this branch, only after
    plan review — not as a first action.

## Consequences

### Positive
- Zero new infrastructure for comms (agentbbs), nightly evolution
  (dream-machine), or governance (metaharness) — all three are reused
  verbatim rather than reimplemented, matching the ADR-150 "removable,
  optional peer" architectural discipline already established in this repo.
- `ruflo eject` gives a purpose-built path to spin ruClip into its own repo
  without hand-rolling git/publish plumbing.
- GPU and dashboard-hosting decisions are explicitly deferred rather than
  silently assumed, avoiding uncontrolled cloud spend.

### Negative
- The Company/Goals/Issues schema and the Claude Artifact dashboard are net
  new surface area with no existing ruvnet precedent to lean on — highest
  implementation risk in the plan.
- Dependence on `ruvnet/dream-machine` and `ruvnet/LatentMesh`, both very
  recently pushed (2026-08-30 and 2026-09-01) and low-star, carries more
  churn risk than the more mature `ruflo`/`metaharness`/`ruvector` core.
- `agentbbs` Cloud Run services already exist and may be owned/operated by
  another workstream — needs coordination before ruClip depends on them.

### Neutral
- `ruvector@0.2.25` pinned in this repo's CLAUDE.md vs. registry `0.3.0` is
  a pre-existing version-drift issue, unrelated to this decision, tracked
  separately.
- Amendment 7b's human-employee-augmentation scope has no code impact on
  what has already shipped (Company/Goals/Issues schema, approval-gate
  state machine, claims authorization, budget-gated heartbeats, agentbbs
  comms) — it reuses those primitives rather than requiring rework, and is
  additive future scope, not a course correction.

## Links

- ADR-103 — signed witness manifest pattern (audit trail reused here)
- ADR-150 — MetaHarness integration surfaces (governance substrate reused here)
- ADR-164 — agentbbs federation Phase 1 (comms layer reused here)
- `ruvnet/autogenous` ADR-390 through ADR-395–402 (radio-moe) — cross-provider
  adapter and runtime governance, folded in per amendment 7a above
- `docs/PLAN.md` — working implementation plan, mapping table, and
  phased roadmap (may evolve without a new ADR unless the component choices
  above change)
