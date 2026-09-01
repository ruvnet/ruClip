<div align="center">

# ruClip

### A ruvnet-only control plane for running a company where the employees are agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![status](https://img.shields.io/badge/status-early_scaffold-orange)](docs/adr/ADR-0001-ruclip-control-plane.md)

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
| Build- and runtime-governance of ruClip itself | [`metaharness`](https://github.com/ruvnet/metaharness) — custom `ruclip-metaharness` bench suites, `@metaharness/redblue`, `@metaharness/flywheel` |
| Semantic memory + Company/Goals/Issues schema | [`ruvector`](https://github.com/ruvnet/ruvector) + AgentDB |
| Human+agent comms (the Slack-equivalent) | [`agentbbs`](https://github.com/ruvnet/AgentBBS) |
| Nightly evidence-gated evolution | [`dream-machine`](https://github.com/ruvnet/dream-machine) — config only, no new scheduler |

Edge/offline agent transport ([`LatentMesh`](https://github.com/ruvnet/LatentMesh))
is intentionally **not** on the v1 critical path — it solves connectivity, a
different problem than company orchestration. See
[ADR-0001](docs/adr/ADR-0001-ruclip-control-plane.md) for the full reasoning
and [`docs/PLAN.md`](docs/PLAN.md) for the phased implementation roadmap.

## Status

Early scaffold — architecture and ADR only, staged from
[`ruvnet/ruflo`](https://github.com/ruvnet/ruflo) branch `explore/ruclip-mission`.
No control-plane code yet. Follow the roadmap in `docs/PLAN.md`.

## License

MIT — see [LICENSE](LICENSE).
