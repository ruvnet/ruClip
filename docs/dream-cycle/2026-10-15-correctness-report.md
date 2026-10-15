# Correctness SOTA Report — 2026-10-15

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 0 (`DAYINT % 5 = 0`): DEEP=correctness, SCAN=performance,tests.
No bonus roadmap-review (`DAYINT % 25 = 15 ≠ 0`).

## TL;DR

`wouldCreateCycle` (`src/control-plane/store/agentdb-adapter.ts`) calls the
real `agentdb_graph-query` MCP tool with `{ depth: 5 }` and no
`complexityBudget`. The real, currently-pinned tool
(`@claude-flow/cli@3.38.20`) always clamps the effective traversal depth to
`complexityBudget.maxDepth ?? 5` **regardless of the `depth` field's own
value** — so cycle prevention for `parent_of`/`reports_to` edges silently
never detects a cycle whose closing path is more than 5 hops away. This is
exactly the residual gap the 2026-09-05 correctness night's rejected
hypothesis H1 predicted and flagged as "next step 1" — tonight closes it by
passing `complexityBudget: { maxDepth: N }` explicitly, and **empirically
measures** the fix against the real, installed native graph backend (not a
mock) before touching any test.

## What's new

- Confirmed, against the real installed tool source
  (`node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js:1055`),
  that `depth` alone is dead: `Math.min(validatePositiveInt(params.depth, 2,
  budget.maxDepth), budget.maxDepth)` where `budget.maxDepth =
  budgetRaw.maxDepth ?? 5`. Passing `depth: 20` with no `complexityBudget`
  is silently clamped straight back to 5.
- Ran this against the **real, installed `@ruvector/graph-node` native
  backend** (not a mock — confirmed `isGraphBackendAvailable() === true` in
  this sandbox) on a genuine 8-node chain: `depth: 7` alone still returns
  only 6 reachable nodes (clamped); `depth: 7, complexityBudget: { maxDepth:
  7 }` returns all 8. This is a MEASUREMENT, not an inference.
- Also confirmed (source read, not yet re-measured live) that the tool's
  SQL-CTE fallback path (used only when the native backend is unavailable)
  independently hard-caps k-hop depth to 3
  (`buildKHopCTE(nodeId, Math.min(depth, 3), ...)`,
  `agentdb-tools.js:1080`) — **regardless of `complexityBudget`**. So the
  fix below only closes the gap when the native backend is active; it is
  a documented, not silent, residual.
- Verified the 2026-09-05 report's "next step 2" (a cycle test allegedly
  passing for the wrong reason) is already resolved by the since-merged
  PR #13 response-shape fix — re-ran it today and it now throws
  `AgentDbBridgeError` for the genuine cycle-detected reason, confirmed by
  direct instanceof check. No action needed; recorded so it isn't
  re-investigated on a future night.

## Competitors / reference points

| # | System | Relevant mechanism | Grade |
|---|---|---|---|
| 1 | `paperclipai/paperclip` (named competitor) | Org-chart + budget-gated task hierarchy; no public documentation of a causal-edge graph store or k-hop cycle-prevention mechanism was found to compare against | C (no primary source found) |
| 2 | TigerGraph (graph-traversal glossary) | Recommends a hard depth cap combined with loop/visited-set tracking for k-hop traversal — same shape as this repo's own `depth`+`complexityBudget` design | B (vendor doc, cross-checked against academic sources below) |
| 3 | Neo4j Cypher variable-length paths (`[:REL*1..5]`) | Industry-standard pattern: callers must pass an explicit, bounded depth range; there is no "unbounded but silently capped" mode | A (official, widely known) |
| 4 | This repo's own `agentdb_graph-pathfinder` tool (same dependency, same file) | Clamps `depth` to 5 exactly like `agentdb_graph-query`, but — unlike `graph-query` — **returns an explicit `depthWarning` field** when the caller's requested depth was clamped. `graph-query`'s k-hop path has no equivalent warning; callers (like this repo, until tonight) have no signal they were silently clamped. Flagged as an upstream-dependency inconsistency, not fixed here (out of scope: it's in `node_modules`, not this repo) | A (direct source read, `agentdb-tools.js:1319`) |

## Frozen Hypothesis

> Given `wouldCreateCycle`'s cycle-prevention k-hop query for `parent_of`/
> `reports_to` edges, when the call to `agentdb_graph-query` is changed from
> `{ depth: 5 }` (no `complexityBudget`) to `{ depth: CYCLE_CHECK_MAX_DEPTH,
> complexityBudget: { maxDepth: CYCLE_CHECK_MAX_DEPTH } }` with
> `CYCLE_CHECK_MAX_DEPTH = 20`, then cycle detection should correctly reject
> a cycle-closing edge whose path is between 6 and 20 hops away — which it
> currently does not — when the real tool's native graph-node backend
> answers the query, subject to: zero behavior change for the already-
> detected ≤5-hop case, zero behavior change to `graphNeighbors` (unaffected,
> still 1-hop), the full existing test suite passing with 0 regressions, and
> explicit documentation (not silent handling) of the residual gap on the
> tool's SQL-CTE fallback path, which independently caps depth at 3
> regardless of `complexityBudget`.

Frozen before implementation; not modified after evaluation began.

## Candidate

`wouldCreateCycle` (`src/control-plane/store/agentdb-adapter.ts`) now calls
`agentdb_graph-query` with `{ depth: CYCLE_CHECK_MAX_DEPTH, complexityBudget:
{ maxDepth: CYCLE_CHECK_MAX_DEPTH } }` where `CYCLE_CHECK_MAX_DEPTH = 20`
(a new named module constant, documented inline). `graphNeighbors` (1-hop,
feeding `getChildIssueIds`/`getBlockerIssueIds`) is untouched — out of
scope, unaffected by the default clamp. One new discriminating regression
test added to `src/control-plane/store/agentdb-adapter.test.ts`; 0 existing
tests modified. Diff: 2 files, +62/-2 (code + test only; this report and the
ledger are separate files).

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), this repo's real, only entrypoint. No LLM calls (`LLM_EVAL=not_needed` — this candidate is deterministic and needed no model calls; `OPENROUTER_API_KEY` is present in this sandbox but unused tonight).

| | Tests | Pass | Fail | tsc | `harness:bench-verify` |
|---|---|---|---|---|---|
| Baseline (candidate code stashed, new test present, HEAD `6e73a8f`) | 328 | 327 | **1** | clean | n/a (not re-run; no src change) |
| Candidate (this branch) | 328 | 328 | 0 | clean | `Suite repo-native@0.1.0: 6 tasks, hash OK` (unchanged) |

The one baseline failure is the new test itself, failing for the exact
predicted reason (`complexityBudget.maxDepth` never requested) — proof the
test discriminates, not just passes by construction.

## Live (non-mocked) real-tool measurement

Before writing the fix, ran the real, installed
`agentdbGraphQuery.handler` directly (not the mock, not an inference) against
the real, installed `@ruvector/graph-node` native backend
(`isGraphBackendAvailable() === true` in this sandbox), on a genuine 8-node
`parent_of` chain `n0→n1→…→n7`:

| Call | Real tool's reported `depth` | `count` (reachable nodes found) |
|---|---|---|
| `{ depth: 5 }` (today's shipped baseline) | 5 | 6 |
| `{ depth: 7 }` (2026-09-05's rejected H1 shape — depth alone) | **5** (clamped back down) | 6 (unchanged — proves H1 is a no-op) |
| `{ depth: 7, complexityBudget: { maxDepth: 7 } }` (tonight's fix shape) | 7 | 8 (all reachable) |
| `{ depth: 20, complexityBudget: { maxDepth: 20 } }` | 20 | 8 (chain exhausted, as expected) |

This is the strongest evidence class available without a live `ruflo mcp
start -t http` server: the exact in-process handler function the HTTP
bridge would otherwise dispatch to, invoked directly, against the real
native graph backend — not a mock, not an inference from reading source
alone (though the source read matches exactly).

## Darwin Lineage

Ran — real one-parameter search space (`CYCLE_CHECK_MAX_DEPTH`). Frozen
fitness (declared before running): minimize `elapsedMs` for a synthetic
N=150-node real-native-backend chain query while still reaching the far end
of the chain. 1 generation × 4 candidates (10/20/50/100), against the real
native backend (not a throwaway synthetic harness — the real
`agentdbGraphQuery.handler`):

| maxDepth | count | elapsedMs | reaches node 149? |
|---|---|---|---|
| 10 | 11 | 2 | no |
| 20 | 21 | 0 | no |
| 50 | 51 | 1 | no |
| 100 | 101 | 1 | no |

All four candidates cost ≈0–2ms on the real native backend — latency is not
the binding constraint at any of these depths (the repo's
`maxNodesVisited` budget, default 10,000, remains the real cost ceiling
regardless of `maxDepth`). Because latency doesn't discriminate between
candidates, and — exactly as the 2026-09-03 performance night reasoned for
its own synthetic-fitness winner — there is no production evidence on how
deep real `parent_of`/`reports_to` hierarchies actually get, **no candidate
beyond 20 is promoted tonight**. 20 was fixed as the shipped value before
this sweep ran (not cherry-picked after seeing the numbers) and stays the
shipped value; 10/50/100 are kept as rejected lineage, not discarded.

## Evidence

- OBSERVATION: real tool's depth clamp, `agentdb-tools.js:1055` (`Math.min(validatePositiveInt(params.depth, 2, budget.maxDepth), budget.maxDepth)`, `budget.maxDepth = budgetRaw.maxDepth ?? 5`).
- OBSERVATION: real tool's SQL-CTE fallback additionally hard-caps at depth 3 regardless of `complexityBudget` (`agentdb-tools.js:1080`, `buildKHopCTE(nodeId, Math.min(depth, 3), ...)`) — not re-measured live tonight (native backend was available in this sandbox throughout), carried as a documented residual.
- MEASUREMENT: live native-backend 8-node chain, table above — `depth` alone is dead past 5; `complexityBudget.maxDepth` is not.
- MEASUREMENT: baseline 327/328 (1 predicted failure) → candidate 328/328; `harness:bench-verify` hash unchanged.
- MEASUREMENT: Darwin sweep (N=150 real chain, 4 candidates), table above.
- INFERENCE: the fix generalizes to any `parent_of`/`reports_to` hierarchy up to 20 hops deep on the native backend; hierarchies deeper than 20 hops, or any deployment where the native backend is unavailable (SQL-CTE fallback, capped at 3), retain a bounded, now-documented false-negative window.
- DECISION: ACCEPT, recommended for human review. No REJECTION of the shipped candidate itself; Darwin's 10/50/100 variants are rejected-but-retained lineage (insufficient production-depth evidence to deviate from the pre-registered 20).

## Reward-Hack Check

Independent adversarial pass (this session, separate role from
implementation): no benchmark/gold data touched (`harness:bench-verify`
hash byte-identical before/after); no test weakened (1 added, 0 edited, 0
removed/skipped); the new test's mock encodes the real tool's measured
clamp behavior (verified against the live native backend above), not an
invented shortcut; no cherry-picked metric (full 328-test suite, run twice,
unfiltered); no hidden cost (`maxNodesVisited` budget unchanged at its
default; Darwin sweep shows negligible latency difference across all
candidate depths); no new dependency; no undocumented cache. `depth`
remains sent alongside `complexityBudget.maxDepth` for backward
compatibility with any backend that only understands the older field. No
unresolved signal.

## Security Review

No new capability, credential, or MCP tool surface — same `agentdb_graph-query`
tool, one additional already-documented optional parameter
(`complexityBudget`, present in the tool's own `inputSchema`). Cycle
prevention is a data-integrity guard, not an authorization boundary
(confirmed 2026-09-05: `claims-authorization.ts`/`transitionApprovalState`
key off actor identity and persisted approval state, not graph
reachability) — unchanged tonight. Marginally larger worst-case traversal
work per `parent_of`/`reports_to` write (depth 20 vs 5), but bounded by the
same `maxNodesVisited` ceiling (default 10,000) that already bounded the
unfixed code — no new DoS surface. Residual risk, stated plainly: a
cyclic edge whose closing path is more than 20 hops away (native backend)
or more than 3 hops away (SQL-CTE fallback, any deployment without the
native backend) still passes silently, same class of gap as before, now
narrower and documented instead of unbounded and silent.

## Regression Analysis

0 regressions: 328/328 (up from 327 baseline + 1 new test), `npm run build`
clean, `harness:bench-verify` hash unchanged. `graphNeighbors` (1-hop) is
untouched — `getChildIssueIds`/`getBlockerIssueIds` behavior is identical.
Only 2 files touched (1 modified source, 1 modified test file) plus this
report and the ledger.

## Next steps

1. The SQL-CTE fallback's independent hard cap at depth 3 is unresolved —
   if the native `@ruvector/graph-node` backend is ever unavailable in
   production (platform without the prebuilt binary, backend load failure),
   cycle detection silently reverts to a 3-hop horizon even with
   `complexityBudget.maxDepth: 20` requested. A future night should either
   get this surfaced upstream or add a local assertion that
   `result.backend === 'graph-node'` and treat `'sql-cte'` as a degraded,
   explicitly-logged mode rather than a silent one.
2. `listIssuesForGoal` and its sibling functions (same file, ~4 call sites)
   scan the `working` and `episodic` tiers sequentially even though the two
   reads are independent — the same class of win as the 2026-09-03
   performance night's `checkOperatingBudget` fix, smaller magnitude (2
   round trips, not N). Candidate for a future performance night.
3. Sweep the rest of `agentdb-adapter.ts`'s `callTool<...>()` response-shape
   assumptions against the real installed tool source the same way the
   2026-09-05 and tonight's nights did for `agentdb_graph-query` — this is
   the second time reading the real source (rather than trusting the
   existing mock) surfaced a materially different contract than assumed.

## Issue

[#77](https://github.com/ruvnet/ruClip/issues/77)

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
this `## Witness` heading.

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (pre-Witness-section content, per the scope above): `50db43400caa9e397e1e4ecc6a4ce87caf645a8b1ebd75c3e5f7e06ce499efff`
- Witness stamp (`sha256(report_sha256 + session_commit)`): `153f7fb83cf90c0250e902170ab6a02db884f3ae3fd3b913cefdecbcf5876f51`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm this is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-10-15-correctness-report.md | sha256sum` — confirm it matches the Report sha256 above.
3. `printf '%s%s' 50db43400caa9e397e1e4ecc6a4ce87caf645a8b1ebd75c3e5f7e06ce499efff 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` — confirm it matches the Witness stamp above.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- . && npm ci && npm test` — confirm 327/327 pass (this report's test is not yet present on that commit).
5. `git checkout dream/2026-10-15-correctness -- . && npm ci && npm test` — confirm 328/328 pass, and `git diff 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src/control-plane/store/agentdb-adapter.ts` shows exactly the `CYCLE_CHECK_MAX_DEPTH`/`complexityBudget` addition to `wouldCreateCycle`.
6. Independently confirm the real tool's depth clamp: `node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js` line ~1055 (`agentdbGraphQuery.handler`, k-hop branch).
