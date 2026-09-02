<div align="center">

# ruClip

### A ruvnet-only control plane for running a company where the employees are agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![status](https://img.shields.io/badge/status-active_development-green)](docs/adr/ADR-0001-ruclip-control-plane.md)

</div>

---

## What this is

ruClip is a ruvnet reinterpretation of the ideas behind
[paperclipai/paperclip](https://github.com/paperclipai/paperclip): a control
plane that sits *above* whatever agents you already have — org chart, goals,
budget-gated heartbeats, task/approval workflow, and a signed audit trail —
rather than an agent framework in its own right. paperclip does not itself
automate sales/eng/support/finance; neither does ruClip. What it provides is
the governance substrate for running agents as if they were employees of a
company with a goal, a budget, and accountability.

ruClip is built entirely on tools ruvnet already owns and operates. Nothing
here reimplements what already exists elsewhere in the ecosystem:

| Capability | Backed by |
|---|---|
| Agent orchestration, work-ownership, signed audit trail | [`ruflo`](https://github.com/ruvnet/ruflo) — Agent Teams, `claims_*`, `witness` |
| Build-time governance of ruClip's own codebase | [`metaharness`](https://github.com/ruvnet/metaharness) — `metaharness score`/`genome`, a custom `ruclip-metaharness` `.harness/bench.json` suite. `@metaharness/redblue`/`@metaharness/flywheel` are explicitly not part of this — that role belongs to Autogenous (below), permanently |
| Runtime governance of the live company | [`ruvnet/autogenous`](https://github.com/ruvnet/autogenous) — antibody/canary/rollback model, `packages/radio-moe` as the cross-provider agent adapter |
| Semantic memory + Company/Goals/Issues schema | [`ruvector`](https://github.com/ruvnet/ruvector) + AgentDB |
| Human+agent comms (the Slack-equivalent) | [`agentbbs`](https://github.com/ruvnet/AgentBBS) |
| Nightly evidence-gated evolution | [`dream-machine`](https://github.com/ruvnet/dream-machine) — config only, no new scheduler |

Edge/offline agent transport ([`LatentMesh`](https://github.com/ruvnet/LatentMesh))
is intentionally **not** on the v1 critical path — it solves connectivity, a
different problem than company orchestration. See
[ADR-0001](docs/adr/ADR-0001-ruclip-control-plane.md) for the full reasoning
and [`docs/PLAN.md`](docs/PLAN.md) for the phased implementation roadmap.

## Status

Active development. Shipped: Phase 1 (control-plane core — Company/Goals/
Issues schema, approval-gate state machine, `claims_*`-backed
authorization, `ActorCredential` identity verification, budget-gated
heartbeats, agentbbs comms with `radio-moe` signing, per-`OrgMember`
interaction profiles), Phase 3 (build-time governance genome), Phase 2a
(read-only company-board dashboard, as a Claude Artifact), and Phase 2b's
first slice — a real `HumanIdentityAttestation` → `ActorCredential`
minting primitive, so a human OrgMember holding a valid attestation can
already call `applyApprovalTransition` end to end. Still open: no
attestation *producer* exists yet (no login/dashboard flow), which is now
Phase 2b's narrowed remaining scope, and dashboard write actions
(approve/reject UI) aren't built. See `docs/PLAN.md` §8 for the full phased
roadmap and current delivery status, and `docs/design/` for every slice's
design doc.

## License

MIT — see [LICENSE](LICENSE).
