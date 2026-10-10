# Correctness SOTA Report — 2026-10-10

## TL;DR

`wouldCreateCycle` (`src/control-plane/store/agentdb-adapter.ts`) calls the
real, installed `agentdb_graph-query` MCP tool with `depth: 5` and no
`complexityBudget`. The real tool's own source
(`node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js:1048-
1055`) server-clamps the *effective* k-hop depth to
`complexityBudget?.maxDepth ?? 5` regardless of the caller's `depth` value —
confirmed directly from that installed source, not guessed. This is exactly
the gap the 2026-09-05 dream-cycle night (issue #12) read from the same
source and flagged as still-open follow-up work, distinguishing it from that
night's own rejected hypothesis H1 (which raised bare `depth` alone and was
correctly rejected for being a no-op against the real server). Tonight ships
the actual fix: `wouldCreateCycle` now also sends
`complexityBudget: { maxDepth: 20 }`, which the real server does honor,
closing the false-negative for cycles between 6 and 20 hops away. A
discriminating regression test (8-hop synthetic cycle) proves the baseline
misses it and the candidate catches it.

## What's new

- Read the exact real-tool clamp formula end-to-end (handler → `budget`
  object → `Math.min(depth, budget.maxDepth)`), not assumed from the prior
  night's prose summary of it.
- Swept every other `agentdb_hierarchical-recall`/`-store`/`-delete`
  callTool<> response-shape assumption in `agentdb-adapter.ts` against the
  real, installed `@claude-flow/memory` controller-registry source — see
  "Rejected direction" below for why that sweep did **not** ship a second
  finding tonight (a real, documented, and good-news result).
- Found and fixed a "passes for the wrong reason" bug in my own first draft
  of tonight's regression test before shipping it (see Reward-Hack Check) —
  the exact same failure mode issue #12 already flagged in a *different*,
  still-unfixed, pre-existing test (see Scan Findings — tests).

## Competitors

| Competitor / reference | Relevance | Grade |
|---|---|---|
| `paperclipai/paperclip` | Named competitor; org-chart/graph storage is a single in-repo Postgres schema with no third-party MCP bridge indirection — this specific class of "caller assumes X, server enforces Y and silently clamps" bug doesn't arise the same way for it | B |
| CWE-20 (Improper Input Validation) / CWE-664 (Improper Control of a Resource Through its Lifetime) | The defect class: a caller-supplied parameter (`depth`) that looks authoritative but is silently overridden by a separate, undocumented-to-the-caller server policy (`complexityBudget.maxDepth`'s default) | A |
| gRPC/Protobuf server-side request validation conventions | Standard practice is for a server that clamps a client parameter to echo back the *effective* value used (e.g. in response metadata), precisely so this silent-clamp class of bug is observable from the client side without reading server source — `agentdb_graph-query`'s response does include `depth` in its k-hop reply (`agentdb-tools.js:1066`, `1087`), which a defensive caller *could* assert against post-call as a generic guard; not done tonight (single conceptual change), flagged as a next step | A |
| This repo's own prior self-corrections (2026-09-05, issue #12) | Direct precedent and the actual source of tonight's hypothesis — this night is the explicitly-recommended follow-up to that one, not independently discovered from scratch | A |

## Hypothesis (frozen before implementation)

> Given ruClip's `wouldCreateCycle` (`src/control-plane/store/agentdb-
> adapter.ts`), which calls the real, installed `agentdb_graph-query` MCP
> tool with `{ mode: 'k-hop', depth: 5 }` and no `complexityBudget`, and
> given that tool's own installed source server-clamps the *effective*
> depth to `complexityBudget?.maxDepth ?? 5` independent of the caller's
> `depth` — when `wouldCreateCycle` is changed to also send
> `complexityBudget: { maxDepth: 20 }`, then it should correctly detect a
> `parent_of`/`reports_to` cycle between 6 and 20 hops away, which it
> currently, silently, does NOT — subject to: zero behavior change for
> cycles within 5 hops, zero change to `graphNeighbors`' unrelated
> `depth: 1` one-hop queries, the full existing test suite passing
> unchanged, and no new tool authority/dependency.

Not modified after evaluation began.

## Candidate

One function changed: `wouldCreateCycle` (`src/control-plane/store/
agentdb-adapter.ts`). Its `agentdb_graph-query` call now sends
`depth: CYCLE_CHECK_MAX_DEPTH` (20) **and** `complexityBudget: { maxDepth:
CYCLE_CHECK_MAX_DEPTH }` instead of a bare `depth: 5`. `graphNeighbors`
(the depth-1 helper behind `getChildIssueIds`/`getBlockerIssueIds`) is
untouched — 1 hop is already far under the server's default 5-hop clamp, so
nothing there needed a budget override. Diff: 2 files (1 production, 1
test), 133 lines total (38 production incl. comments, 95 test), one
conceptual change.

`CYCLE_CHECK_MAX_DEPTH = 20` is the same first widening step 2026-09-05's
rejected H1 used — not Darwin-tuned (see Darwin Results) and not claimed to
be optimal, just a concrete, reviewable, order-of-magnitude-reasonable
value for an org-chart/issue-hierarchy depth. Calibrating it against a real
bridge's actual node counts/graph shapes is flagged as a next step, same as
2026-09-03's concurrency cap was.

### Known residual limitation (real-tool-side, not fixable from this repo)

The real tool's **SQL-CTE fallback** k-hop path (used when the graph-node-
native backend is unavailable) separately hard-caps depth at
`Math.min(depth, 3)` (`agentdb-tools.js:1080`), **regardless of
`complexityBudget.maxDepth`**. Only the graph-node-native backend honors a
raised `complexityBudget.maxDepth` beyond the server's own default of 5.
This means tonight's fix closes the gap only when the real deployment's
graph-node-native backend is actually in use; on the SQL-CTE fallback, a
cycle beyond 3 hops can still slip through, same as before. This is a
limitation in the vendored `@claude-flow/cli` dependency, not something
ruClip's own code can fix — documented here, not silently glossed over.

## Rejected direction (read first, implemented nothing, no wasted line of
inquiry)

Issue #12's Recommendation #4 asked for a sweep of every other
`agentdb-adapter.ts` `callTool<>()` response-shape assumption against the
real tool source, the same way 2026-09-05 fixed `agentdb_graph-query`'s
shape. Did that sweep first, before picking tonight's candidate:

Every `agentdb_hierarchical-recall`/`-store`/`-delete` call site assumes
results shaped `{ key?, id?, value? }` (string `.value`, not `.content`).
Reading `node_modules/@claude-flow/cli/dist/src/memory/memory-bridge.js`'s
`bridgeHierarchicalRecall`/`bridgeHierarchicalStore` shows a *branch* that
would return the real agentdb `HierarchicalMemory` controller's native
`MemoryItem` shape instead (`{ id, tier, content, ... }` — no `.value`, no
top-level `.key`) when `hm.getStats` and `hm.promote` both exist. This
looked, at first, like a second silent-data-loss bug of the same shape as
the one 2026-09-05 fixed. **Reading one more layer down** —
`node_modules/@claude-flow/memory/dist/controller-registry.js:677-690` —
refutes it: that file's own comments (citing real upstream issues #2977 and
#2887) state the native `agentdb` `HierarchicalMemory` export was removed
at `alpha.17` and is dead code on every installable version range; the
registry's `hierarchicalMemory` controller is *always* served by its own
`TieredMemoryStore` fallback, which deliberately does **not** implement
both `getStats` and `promote` (confirmed in `tiered-memory.js`'s own
`IMPORTANT` comment) specifically so the detection branch above never
selects it. `TieredMemoryStore.recall()`/`.store()` return exactly the
`{ id, key, value, tier, ts }` shape `agentdb-adapter.ts` already assumes.
**REJECTED before implementation** — a clean, evidence-backed rejection,
not a guess, and the correct outcome of doing the sweep issue #12 asked
for: it says the rest of this file's `callTool<>()` shapes are fine, not
that nothing was checked.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs
dist`) — this repo's real, only entrypoint. No LLM calls (`OPENROUTER_API_KEY`
not needed for this candidate; `LLM_EVAL=n/a`, not blocked — this candidate
never needed a model call).

| | Tests | Pass | Fail |
|---|---|---|---|
| Baseline (`6e73a8f060bcbb69965a50ffe4627e33622d4094`, test file from this branch, production code reverted to baseline) | 330 | 329 | 1 |
| Candidate (this branch) | 330 | 330 | 0 |

The single baseline failure is the new, purpose-built discriminating test
(`wouldCreateCycle detects an 8-hop cycle once complexityBudget.maxDepth is
sent...`), failing with `AssertionError: Missing expected rejection
(AgentDbBridgeError)` — i.e. the baseline genuinely fails to detect the
8-hop cycle and lets the edge write proceed, exactly the predicted bug.
Reproduced by temporarily reverting only the one production file to its
pre-candidate state and rebuilding/retesting; restored immediately after.

`npm run build` (tsc, `--strict` via `tsconfig.json`): clean on both
baseline and candidate. `npm run harness:bench-verify` →
`Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)` — unchanged hash,
no gold-data touched. `npm run lint`: no-op (repo is still in its
pre-lint-config scaffold stage — unchanged by this candidate).

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (this repo's `main`
at the start of tonight's run), evaluated by temporarily reverting only
`src/control-plane/store/agentdb-adapter.ts` to that commit's content while
keeping tonight's new test file, to isolate exactly the one variable under
test (same methodology 2026-09-05 used for its H2 baseline).

## Darwin Lineage

Not run. `CYCLE_CHECK_MAX_DEPTH` is a single deliberately-conservative
constant, not a tunable with a measurable continuous trade-off in this
sandbox — there's no live AgentDB bridge here to measure real latency/
node-visited cost against different depth values, and the "fitness" of a
given depth (does it happen to exceed some real org's real graph diameter)
isn't something a synthetic harness in this repo can honestly simulate
without fabricating org-chart shape data. Recorded as N/A with a named
reason, not skipped silently, same posture 2026-09-02's mechanical
extraction and 2026-09-05/06's binary-correctness fixes took.

## Evidence

- OBSERVATION: `wouldCreateCycle` sent `depth: 5`, no `complexityBudget`
  (grep-confirmed, single call site).
- OBSERVATION: real tool's own source computes `budget.maxDepth =
  complexityBudget?.maxDepth ?? 5` then clamps `depth` to it, independent of
  the caller's requested `depth` (`agentdb-tools.js:1048-1055`, read
  directly, not inferred).
- OBSERVATION: the SQL-CTE k-hop fallback separately hard-caps at
  `Math.min(depth, 3)` regardless of `complexityBudget` (`agentdb-
  tools.js:1080`) — a residual limitation, documented, not fixed (see
  Candidate section).
- REJECTION: the hierarchical-recall/-store shape sweep (issue #12's
  Recommendation #4) — `TieredMemoryStore` (not the native `agentdb`
  `HierarchicalMemory`, confirmed dead code upstream) always backs
  `hierarchicalMemory`, and its shape already matches what `agentdb-
  adapter.ts` assumes. No fix needed; sweep complete, documented as a clean
  negative result.
- MEASUREMENT: baseline 329/330 (1 predicted failure); candidate 330/330;
  `harness:bench-verify` hash unchanged.
- INFERENCE: the fix is structural (a missing request parameter, not a
  logic error) — `complexityBudget` is itself a pre-existing, documented
  field in the real tool's own input schema (`agentdb-tools.js:1022-1031`),
  not a new capability being requested.
- DECISION: ACCEPT. REJECTION: the hierarchical-recall sweep (above),
  kept as a documented clean negative, not discarded silently.

## Reward-Hack Check

Independent adversarial pass against this candidate, run before shipping:
my own first draft of the "detects an 8-hop cycle" test omitted an
`agentdb_causal-edge` mock handler. Traced through `bridge-client.ts`'s
`callTool` (lines 264-281) and confirmed that a missing-handler throw from
the mock's `fetchImpl` gets caught and **rewrapped as `AgentDbBridgeError`**
— meaning that draft would have satisfied `assert.rejects(fn,
AgentDbBridgeError)` regardless of whether the cycle check ever actually
ran correctly, i.e. it would have passed for the wrong reason even against
the unfixed baseline. Caught before shipping (not after a critic flagged
it), fixed by adding the handler, and reverified: with the handler present,
the baseline-revert run now fails with the correct, specific
`AssertionError: Missing expected rejection`, not an incidental wrong-tool
error. No test assertion was weakened to make this pass; no gold data or
threshold touched; `harness:bench-verify` hash unchanged; full suite run
unfiltered both ways. No unresolved reward-hack signal in the shipped
candidate.

## Security Review

`complexityBudget` is a pre-existing, documented parameter of the real
`agentdb_graph-query` tool's own input schema — this is not a new
capability, credential, or authority request, just supplying an optional
field the tool already accepts. No authorization guard, credential path, or
MCP permission scope changed; `wouldCreateCycle`/`recordCausalEdge` are not
an authorization boundary (confirmed in the 2026-09-05 report: `claims-
authorization.ts`/`transitionApprovalState` key off actor identity and
persisted approval state, not graph reachability) — this is a data-
integrity fix, not a new attack surface. The real tool's own
`maxNodesVisited` (10,000) and `maxMillis` (50ms) budget fields are left at
their defaults; this candidate does not relax any other part of the
server's own resource ceiling, only the depth ceiling, and only up to a
fixed, reviewable constant.

## Regression Analysis

0 regressions: candidate is 330/330 (full suite, including 3 new tests);
baseline (isolated) is 329/330 with the single predicted failure;
`npm run build` clean on both; `harness:bench-verify` hash unchanged. No
existing test asserts on `depth` or `complexityBudget` args for
`agentdb_graph-query` (grep-confirmed across `tests/` and the coder-stage
suite), so no pre-existing test needed updating — only new tests were
added.

## ADR

None. This is a bug fix (a missing request parameter against a previously-
documented real-tool contract) continuing the exact finding 2026-09-05
(issue #12) already decided and flagged as follow-up — not a new
architectural decision.

## Scan Findings — performance

Zero added round trips: the fix changes the payload of an existing call,
not the call count. Real-world cost is bounded by the server's own
unchanged `maxMillis`/`maxNodesVisited` defaults — the same safety ceiling
every other caller of this tool already operates under; this candidate
does not raise or lower it. The SQL-CTE fallback's separate hard depth-3
cap (see Candidate) is an *existing* performance/correctness interaction in
the vendored dependency that this fix cannot change — flagged, not silently
absorbed into the finding's scope.

## Scan Findings — tests

1. **Confirmed, reproduced live, caught before shipping**: a mock-handler
   omission in a cycle-detection test makes `assert.rejects(fn,
   AgentDbBridgeError)` pass regardless of whether the cycle check ran
   correctly, because `bridge-client.ts`'s `callTool` rewraps *any* fetch-
   level throw (including "no mock handler registered") as
   `AgentDbBridgeError`. Caught in tonight's own draft; fixed before
   shipping (see Reward-Hack Check).
2. **Still open, not fixed tonight**: the pre-existing `recordCausalEdge
   refuses a reports_to edge that would close a cycle` test
   (`src/control-plane/store/agentdb-adapter.test.ts:175-184`) has exactly
   the same gap — its `mockBridge` call registers no `agentdb_causal-edge`
   handler, so it would keep passing even if `wouldCreateCycle` always
   returned `false`. This is the same test issue #12's Scan Findings —
   tests already flagged ("passes for the wrong reason") for a *different*
   specific reason (a missing handler masking a *different* code path) —
   tonight independently reproduces the same root mechanism against this
   exact test via `bridge-client.ts`'s rewrap behavior, confirming it's
   still live today. Left unfixed here deliberately, to keep tonight's
   diff to one conceptual change in one file pair; a one-line fix (add
   `'agentdb_causal-edge': () => ({ success: true })`) is immediately
   actionable for a future tests-focused night or scan.

## Witness

```
REPORT_HASH    = f383af8656118b95586d2708603742c27b15855ff7cfa0f80661965258d84509
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = f857291ba073e38e8ebeeb5747915aa31467288e5076d05d092fcda09e4544de
```

Verifier procedure (reproducible from this committed file alone):

1. `git show <this commit>:docs/dream-cycle/2026-10-10-correctness-report.md | sed -n '1,/^```$/p'` — hash everything up to (not including) this Witness section's closing content block, i.e. up through the line directly above the `## Witness` heading.
2. `sha256sum` that slice → `REPORT_HASH`.
3. Confirm `SESSION_COMMIT` above matches this PR's documented base commit.
4. `printf '%s%s' "$REPORT_HASH" "$SESSION_COMMIT" | sha256sum` → must equal `WITNESS` below.
5. Independently re-run `npm test` against this branch and against
   `SESSION_COMMIT` with only `src/control-plane/store/agentdb-adapter.ts`
   reverted, per the Evaluation Receipt above, to reproduce 330/330 vs.
   329/330.

## Recommendation

`evaluated: accepted`. Human review requested on the draft PR — this
session never self-merges or self-promotes. Suggested follow-ups:

1. Calibrate `CYCLE_CHECK_MAX_DEPTH` against a real bridge's actual graph
   shape/latency once one is reachable from a dream-cycle sandbox (same
   "shipped conservative, flagged for real-data calibration" posture as
   2026-09-03's concurrency cap).
2. Fix the still-open `recordCausalEdge refuses a reports_to edge...` test
   gap (Scan Findings — tests #2) — a one-line, low-risk, high-value
   tests-night candidate.
3. Consider having `wouldCreateCycle`/`graphNeighbors` assert the server's
   echoed `depth` in its k-hop response matches what was requested, as a
   generic defense against this whole class of silent-clamp bug (see
   Competitors — gRPC/Protobuf row) — would have caught tonight's finding
   automatically without needing to read the real tool's source.
4. The SQL-CTE fallback's independent hard depth-3 cap (Candidate section)
   means this fix is incomplete on that backend; worth its own investigation
   once it's possible to determine from inside this sandbox which backend a
   real deployment actually resolves to.
