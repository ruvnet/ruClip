# ruclip-metaharness

Custom `metaharness` bench suites governing ruClip itself (per ADR-0001 §5):

- **Build-time genome** — scores the codebase: org-chart schema correctness,
  approval-gate enforcement, budget hard-stop correctness, audit-trail
  completeness, agentbbs delivery, dashboard capability wiring.
- **Runtime genome** — `@metaharness/redblue` adversarial testing of the
  live company (can an agent bypass a budget cap, forge an approval, post
  unauthorized to agentbbs?), gated through `@metaharness/flywheel`
  (evaluation is not promotion — no auto-merge, no auto-promote).

No `bench.json` yet — authored in Phase 3 via `metaharness bench verify`.
