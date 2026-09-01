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
recorded in `docs/ruclip/PLAN.md` (staged in branch `explore/ruclip-mission`
pending review — `ruvnet/ruClip` is intentionally not created yet).

## Decision

Build ruClip entirely on existing ruvnet-owned components rather than
adopting paperclip's own Node/React/Postgres stack:

1. **Orchestration substrate**: ruflo Agent Teams (`SendMessage`), `claims_*`
   work-ownership primitives, and the `witness` signed audit manifest
   pattern (ADR-103) as the company's immutable activity log.
2. **Governance/quality**: `metaharness` (already integrated, ADR-150) via a
   new custom `ruclip-metaharness` bench suite — a build-time genome
   (org-chart schema correctness, approval-gate enforcement, budget
   hard-stops, audit completeness) and a runtime genome
   (`@metaharness/redblue` adversarial testing of the live company, gated
   through `@metaharness/flywheel` — evaluation is never auto-promoted).
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
6. **Nightly evolution**: integrate with `ruvnet/dream-machine` by
   generating a `dream.config.json` for `ruvnet/ruClip` and registering a
   `/schedule` cloud routine — the same mechanism already running nightly
   for `ruflo` and `metaharness`. No new nightly scheduler is built.
7. **Edge resilience**: `ruvnet/LatentMesh` is explicitly **out of the v1
   critical path** — deferred to an optional later phase for agents needing
   offline/field operation (via `ruflo-iot-cognitum`), since it solves a
   connectivity-transport problem orthogonal to company orchestration, and
   is itself still a "research prototype."
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

## Links

- ADR-103 — signed witness manifest pattern (audit trail reused here)
- ADR-150 — MetaHarness integration surfaces (governance substrate reused here)
- ADR-164 — agentbbs federation Phase 1 (comms layer reused here)
- `docs/PLAN.md` — working implementation plan, mapping table, and
  phased roadmap (may evolve without a new ADR unless the component choices
  above change)
