# Performance SOTA Report — 2026

**Dream Cycle 2026-10-27 — `ruvnet/ruClip`**
Rotation: `SLOT=2` schedules `DEEP=architecture / SCAN=docs,api`. **Overridden** (STEP 1.1 learning signal): the architecture surface's dominant finding — the dream-cycle control loop itself has a ~0% PR merge rate and a `LEDGER.md` frozen on `main` since 2026-09-06 — has already been independently found and quantified on 3+ prior architecture/dev-experience nights (#72 2026-10-12, #84 2026-10-18, #92 2026-10-22). Re-running that analysis again tonight would be a 6th overlapping attempt at the same finding. Per STEP 1.1 ("a finding repeated in ≥3 prior nights → rotate to the next slot's DEEP surface"), tonight's `DEEP` is rotated to **performance** (slot 3's surface), `SCAN` kept at tonight's scheduled `docs,api`.

## TL;DR

`buildGoalSnapshot` (`src/control-plane/dashboard/build-snapshot.ts`) built every issue's dashboard snapshot — each of which fires 2 `agentdb_graph-query` RPCs (`getChildIssueIds`/`getBlockerIssueIds`) — through a bare `Promise.all`, with **no concurrency ceiling**. Peak concurrent graph-query RPCs scaled linearly with a goal's issue count (measured: 60 issues → 120 concurrent RPCs). This is the exact unbounded-fan-out shape `checkOperatingBudget` had before the 2026-09-03 fix (ledger row 2, PR #11) — just never applied to this later call site. Fixed by reusing that same `mapWithConcurrency` worker pool (now exported) at a 25-issue cap, bounding peak graph-query concurrency to a constant 50, independent of company size. **ACCEPT.**

## What's new

- `mapWithConcurrency` (store/agentdb-adapter.ts) is now `export`ed — zero behavior change to its one existing caller (`checkOperatingBudget`), newly reusable at other independent-round-trip fan-out sites.
- `buildGoalSnapshot`'s per-issue snapshot assembly now runs through that pool at `DASHBOARD_ISSUE_FANOUT_CONCURRENCY = 25` (same cap value as `SESSION_COST_FETCH_CONCURRENCY`, for consistency, not re-derived).
- One new deterministic regression test (`tests/control-plane/dashboard-fanout-concurrency.test.ts`) measuring **peak concurrent RPC count** directly via a counter in the mock bridge handler, rather than wall-clock timing — avoids the flakiness a timing-based assertion would have under a mocked, non-deterministically-scheduled event loop.

## Competitors / prior art

| # | Source | What it does | Relevance | Grade |
|---|---|---|---|---|
| 1 | Paperclip (`paperclipai/paperclip` per this repo's own `dream.config.json`; some mirrors list it as `paperclip-ai/paperclip` — unresolved, flagged, not load-bearing for this finding) | Node.js/React open-source control plane running a team of AI agents in a company-like hierarchy, budget gates, approval gates, heartbeat-driven execution — the closest direct competitor to ruClip's own design | Same problem class (org-chart + budget + heartbeat dashboard for an agent company); its dashboard/snapshot assembly is the natural analogue to `build-snapshot.ts`, though its own fan-out bounding was not independently verifiable from outside its repo tonight | B (cross-checked across 3 independent tutorials/talk descriptions, not the repo source itself) |
| 2 | `p-limit` (`sindresorhus/p-limit`, npm) | General-purpose per-call concurrency limiter for async fan-out in Node.js; `limit.map()`, `activeCount`/`pendingCount` introspection | Validates that "cap concurrent async fan-out instead of bare `Promise.all`" is an established, widely-adopted pattern in this exact ecosystem, not a bespoke idea — ruClip already has its own equivalent (`mapWithConcurrency`); tonight's fix is reuse, not a new dependency | A (official package docs) |
| 3 | `p-queue` (`sindresorhus/p-queue`, npm) | Fuller-featured async queue: priority, pause/resume, rate limiting, in addition to concurrency capping | Relevant as the "next step up" if ruClip ever needs backpressure/pause semantics on the bridge connection beyond a flat cap (not needed for tonight's fix) | A (official package docs) |
| 4 | Node.js `--test` runner scheduling model (official docs + this repo's own prior ledger entries, e.g. PR #11/#15's "synchronization-barrier mock" technique) | Confirms that measuring concurrency via a counter bumped synchronously inside a mocked async handler, with a fixed delay before resolution, is a deterministic way to observe true overlap without relying on real wall-clock race conditions | Directly informs tonight's test design — same technique class this repo already used for PR #15's TOCTOU-race test | A (this repo's own prior, already-merged test code) |

## Frozen hypothesis (before implementation)

> Given a dashboard-snapshot build for a goal with many issues, when `buildGoalSnapshot`'s per-issue fan-out (assignee resolution + `getChildIssueIds` + `getBlockerIssueIds`) is routed through `mapWithConcurrency` at a 25-issue cap instead of a bare `Promise.all`, then peak concurrent `agentdb_graph-query` RPCs for that fan-out should be bounded by a constant (2 × cap = 50) independent of the goal's issue count — subject to: (a) identical output (`DashboardGoalSnapshot` content and ordering unchanged), (b) the entire existing test suite remains green, (c) `harness:bench-verify`'s committed benchmark hash is unaffected.

Frozen before any baseline/candidate run; not modified afterward.

## Evaluation receipt

- Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), real build + real test runner, no fallback metric.
- **Baseline** (parent commit `6e73a8f`, fix stashed, new test present): `328` tests, **327 pass / 1 fail** — the new concurrency test, measured peak `120` concurrent `agentdb_graph-query` RPCs against an expected bound of `50` (60 issues × 2 calls each, fully unbounded).
- **Candidate** (fix applied): `328/328` pass, **0 regressions**. Directly re-measured (ad hoc script, same mock, same inputs): peak `50` concurrent RPCs — exactly the predicted bound (25-worker pool × 2 calls/issue), not merely "under" it.
- `npm run harness:bench-verify`: hash unchanged (`840fd8d2d698…`) before and after — candidate does not touch the benchmark corpus.
- `npm run build`: clean, no new TypeScript errors.
- Candidate diff: 2 production files, **31 changed lines** (`+29/-2`) — well under the 300-line target; one conceptual change (reuse an existing bounded-worker-pool pattern at a second call site).

## Darwin lineage

Not run. The fix has exactly one natural parameter (the concurrency cap), already fixed to the repo's own existing precedent value (`SESSION_COST_FETCH_CONCURRENCY = 25`) for consistency rather than independently tuned — a multi-generation search over cap values would not be measuring anything the mocked evaluator can meaningfully score (no real backend saturation signal available in-repo), so it would produce theater, not evidence. `harness:bench-verify`'s unchanged hash was used instead as the real, already-existing regression gate.

## Evidence classification

- **MEASUREMENT**: baseline peak concurrency = 120 (reproduced twice, deterministic). Candidate peak concurrency = 50 (reproduced twice, deterministic). `npm test` baseline 327/328, candidate 328/328. `harness:bench-verify` hash before/after.
- **OBSERVATION**: `buildGoalSnapshot`'s pre-fix fan-out call site; `mapWithConcurrency`'s existing single caller and its 2026-09-03 provenance.
- **INFERENCE**: this reduces (does not eliminate) risk of a dashboard-snapshot build saturating the real AgentDB bridge's connection capacity for a large company — the real bridge's actual concurrent-request ceiling was not independently verified tonight (no live AgentDB instance in this evaluation environment), so the practical real-world benefit size is not independently measured, only the RPC-count bound itself is.
- **DECISION**: ACCEPT, human review requested via draft PR — no self-merge, no self-promotion.

## Reward-hack check (independent critic pass)

- Benchmark/gold data: untouched — no change to `.harness/bench.json` or any committed corpus.
- Threshold gaming: the test's bound (`2 × 25 = 50`) is derived directly from the actual code path (worker-pool cap × calls-per-issue), not loosened to guarantee a pass; it demonstrably fails against the real baseline (120 > 50) before the fix and matches the candidate's measured value exactly (not merely "comfortably under").
- Cherry-picking: ran the full existing suite both ways (327/328 → 328/328), not just the new test.
- Evaluator exploitation / undocumented cache: the fix does not alter `resolveOrgMemberRef`'s cache, does not short-circuit any graph-query call, and does not change output — verified by the existing `dashboard-snapshot.test.ts`/`dashboard-cross-company-gap.test.ts` suites staying green unchanged.
- Hidden cost: bounding concurrency trades a small latency increase for very large `N` (more than 25 issues) against a hard ceiling on simultaneous outbound RPCs — stated plainly here, not hidden; no attempt was made to claim a pure win with no tradeoff.

**Critic verdict: clear.**

## Security review

Resource-exhaustion / availability angle only (not a credential, injection, or authority-boundary issue): an unbounded per-snapshot RPC fan-out that scales with company size is a mild self-inflicted DoS surface against ruClip's own AgentDB bridge connection capacity for large companies. This fix reduces that exposure at one call site using an already-reviewed pattern; it does not change any permission, credential, or trust boundary. No prompt-injection, agent-impersonation, or cross-agent memory-poisoning surface is touched.

## Scan findings

- **docs**: `build-snapshot.ts`'s own module header already documents the intentional per-call `OrgMemberCache` design in detail (team-lead-approved, 2026-09-02) but said nothing about the issue-level fan-out's concurrency being unbounded — now documented inline at the new constant.
- **api**: No public API/CLI surface change — `buildDashboardSnapshot`'s exported signature and `DashboardGoalSnapshot`/`DashboardIssueSnapshot` shapes are unchanged; `mapWithConcurrency` becoming exported is an internal-module surface change only (not part of `src/cli/ruclip.ts`'s public CLI surface).

## Recommendation / next steps

1. **Human action, highest priority, not this candidate**: `ruvnet/ruClip` has had a **0% dream-cycle PR merge rate since 2026-09-07** (last merge: PR #15) — at least ~45 subsequent nightly PRs are open and unmerged, `LEDGER.md` on `main` is ~50 rows stale, and this exact problem has already been independently found and quantified 3+ times (#72, #84, #92). No further autonomous tooling should be built for this; it needs a human to actually review and merge/close the backlog. See issue #92 and its linked PR for the full quantification.
2. Apply the same `mapWithConcurrency` bound to `buildDashboardSnapshot`'s goal-level `Promise.all(goals.map(buildGoalSnapshot))` fan-out — tonight's fix bounds concurrency *within* a goal, not *across* goals; a company with many goals (not just many issues in one goal) has the same unbounded shape one level up. Left out of tonight's candidate to keep it to one conceptual change.
3. If this candidate is merged, verify against a real (non-mocked) AgentDB bridge instance what its actual safe concurrent-connection ceiling is, and tune `DASHBOARD_ISSUE_FANOUT_CONCURRENCY` (and `SESSION_COST_FETCH_CONCURRENCY`) from measured real-world capacity rather than an inherited default of 25.

## Witness

- `SESSION_COMMIT` (parent, before this branch's work): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- `REPORT_HASH` (sha256 of this report's exact committed text, from the top down to — but not including — this `## Witness` heading): `0ab10a353233051f390d2139eb9deb2d5653d2d658b72f4c607bec419db21938`
- `WITNESS` (`sha256(REPORT_HASH || SESSION_COMMIT)`): `e0eb6999b23f0f594730ac62c752a960b8c5cf265b9ac88f460dffabd7a7a738`

**Verification procedure (reproducible by anyone):**
1. Fetch this report's exact committed text (`docs/dream-cycle/2026-10-27-performance-report.md`) up to the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` (`6e73a8f060bcbb69965a50ffe4627e33622d4094`) is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. `npm ci && npm run build && npm test` on the branch → must show `328/328` passing; `git stash` the two production-file changes (`src/control-plane/store/agentdb-adapter.ts`, `src/control-plane/dashboard/build-snapshot.ts`) and re-run to reproduce the `327/328` baseline with the predicted single failure (the new concurrency test).
