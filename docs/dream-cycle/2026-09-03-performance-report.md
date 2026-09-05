# Performance SOTA Report — 2026

**Repo**: `ruvnet/ruClip` @ `41433bb971bc6152122acc180c5d695e55ea8c07`
**Rotation**: SLOT=3 → DEEP=performance, SCAN=memory,latency (2026-09-03, DAYINT=20260903, DAYINT%25=3, no bonus)

## TL;DR

`checkOperatingBudget` (`src/control-plane/store/agentdb-adapter.ts`) — ruClip's
own operating-spend circuit breaker, invoked as Gate 2 on **every** heartbeat
fire (`HEARTBEATS-AND-COMMS.md` §2/§4) — sums a company's tracked session
costs by listing session keys via `memory_list`, then issuing one
`memory_retrieve` round trip **per key, sequentially, one `await` at a time**.
For a company with N tracked cost-tracking sessions this is O(N) sequential
network round trips on a hot path that runs unconditionally before every
heartbeat wake decision. Tonight's candidate replaces the sequential loop
with a bounded worker-pool fan-out (`mapWithConcurrency`, cap 25 in flight);
output is unchanged (summation is order-independent), but the same request
now completes in a small constant number of round-trip batches instead of N.
Measured on the real evaluator's mock bridge: 155ms → 32ms for N=6 sessions
at a 25ms simulated round trip (4.8x); a synthetic 200-key benchmark shows
1600ms sequential → 67ms at cap 25 (23.9x).

## What's new

Nothing externally novel — an N+1-round-trip elimination is textbook
concurrent-I/O practice, not a new technique. What's new is applying it to
*this* repo's own real hot path, verified against the actual evaluator
(not inferred from reading the code): the parent implementation was proven,
empirically, to serialize every session fetch (max 1 in flight, confirmed by
running the new regression test against parent commit
`41433bb971bc6152122acc180c5d695e55ea8c07` before writing the candidate).

## Competitors (graded)

| Competitor | Relevant to tonight's finding | Grade |
|---|---|---|
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | Docs claim "atomic execution" and DB-backed (PostgreSQL) cost tracking "by company, agent, project, goal, issue, provider, and model," and that Paperclip "handles the hard orchestration details correctly." Public docs do **not** disclose whether cost aggregation batches or serializes per-record reads — implementation is closed to docs-only inspection (source not in this session's repo scope). | C (single-source, unconfirmed at the implementation level) |
| LangSmith / LangGraph Platform | Cost tracking is platform-managed (seat + trace + deployment-minute billing), not a self-hosted "list keys then read each one" aggregation the deployer's own code performs — this whole *class* of N+1 risk is architected away by not exposing a client-side aggregation step at all. Not a direct architectural comparison to ruClip's self-hosted circuit breaker. | B (vendor pricing/docs, cross-checked across multiple secondary sources) |
| CrewAI / AutoGen (via third-party guardrail middleware, e.g. AgentBudget, agent-cost-guardrails) | Neither framework enforces per-agent token budgets natively; third-party middleware "enforces hard limits before each LLM call" — i.e. a synchronous **pre-flight check per call**, structurally different from ruClip's periodic aggregate-then-decide Gate 2, so N+1 fan-out isn't the same failure mode there (the cost is checked incrementally, never summed from a batch of stored records). | B (vendor-documented pattern, corroborated across independent write-ups) |
| Node.js/ECMAScript concurrent-I/O semantics (`Promise.all` / bounded worker pool vs. sequential `for`-loop `await`) | Directly reproducible: independent async I/O operations run concurrently only when not individually `await`-ed inside the loop body; this is language-level `Promise` semantics, not framework-specific. Reproduced empirically tonight (see Evaluation Receipt) rather than only cited. | A (reproducible — verified directly against this repo's own evaluator, both directions) |

## Hypothesis (frozen before implementation)

> Given ruClip's operating-budget circuit breaker (`checkOperatingBudget`,
> called as Gate 2 on every heartbeat fire) with N tracked
> `ruclip-cost-tracking:{companyId}:session-*` keys, when the sequential
> per-key `memory_retrieve` loop is replaced with a bounded-concurrency
> fan-out (`mapWithConcurrency`, cap `SESSION_COST_FETCH_CONCURRENCY = 25`),
> then wall-clock latency of `checkOperatingBudget` should decrease relative
> to the sequential baseline (proportionally to N up to the concurrency cap),
> subject to: identical `totalCostUsd`/`utilizationPct`/`level` output,
> identical company-scoped key-prefix filtering, the full existing test
> suite passing unchanged, and no unbounded-concurrency risk against the
> real AgentDB bridge (hence the explicit cap, not a bare `Promise.all` over
> up to 1000 `memory_list`-capped keys).

Not modified after evaluation began.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), real project test runner, no mocked evaluator.

| | Tests | Pass | Fail | tsc --strict | Duration |
|---|---|---|---|---|---|
| Baseline (`41433bb971bc6152122acc180c5d695e55ea8c07`) | 320 | 320 | 0 | clean | 1642–2019ms (repeat runs) |
| Candidate (this branch) | 321 | 321 | 0 | clean | 1866–2110ms (repeat runs) |

Discriminating regression test (new):
`checkOperatingBudget fetches per-session memory_retrieve calls concurrently
(bounded), not one round trip at a time` in
`tests/control-plane/heartbeats-and-comms.test.ts`. Uses an async-capable
mock-bridge handler (small additive change to
`tests/support/mock-bridge.ts`: handlers may now return a `Promise`, fully
backward-compatible with every existing synchronous handler) that tracks
peak in-flight `memory_retrieve` calls and elapsed wall time for N=6
simulated session keys at a 25ms simulated round trip.

- **Run against parent commit** (candidate code stashed, test code applied):
  **FAILS** — `expected overlapping in-flight session fetches ... observed
  max 1`, elapsed 155.29ms. Proves the parent is genuinely sequential and
  that the new test has discriminating power, not just passing by
  construction.
- **Run against candidate**: **PASSES** — max in-flight > 1, elapsed
  32.29ms.

## Baseline

Parent commit `41433bb971bc6152122acc180c5d695e55ea8c07`, evaluated on the
real `npm test` entrypoint before any candidate code was written, and
re-evaluated specifically against the new regression test (above) to prove
discriminating power.

## Darwin Lineage (bounded)

Ran — real search space this time (unlike 2026-09-02's mechanical,
single-correct-answer extraction). Frozen fitness (declared before running):
minimize p50 wall-clock ms for a synthetic N=200-key fan-out at a fixed
8ms simulated per-call round trip, subject to the safety constraint that
peak in-flight calls never exceeds the candidate's own limit. 1 generation,
4 candidates (concurrency caps 5/10/25/50), 3 samples each, throwaway
synthetic harness — **not** the shipped test suite or any gold data.

| Candidate (cap) | p50 elapsed (N=200, 8ms/call) |
|---|---|
| 5 | 333.3ms |
| 10 | 164.4ms |
| 25 | 67.3ms |
| 50 | 34.4ms |

By the frozen synthetic fitness alone, cap=50 wins. **Not promoted as the
shipped default.** The synthetic benchmark has no model of the real AgentDB
bridge's actual concurrency/connection tolerance (unmeasured — no
production load data exists for this repo's bridge); over-fitting the
shipped constant to an unrepresentative synthetic microbenchmark against a
system that, per ADR/PR history, is a real deployed Cloud Run service, is
exactly the kind of benchmark-gaming this cycle's own reward-hack check
exists to catch. Shipped default stays **25** (already a >20x win over
sequential in the synthetic model, and the more conservative of the two
"clearly past the knee of the curve" candidates). Flagged as an explicit
next-step measurement, not a decision made tonight.

## Evidence

- OBSERVATION: `checkOperatingBudget`'s session-cost loop issues one
  `memory_retrieve` per session key inside a `for` loop with `await` on each
  iteration (grep-confirmed against the real file, `agentdb-adapter.ts`
  line ~1326 pre-change).
- MEASUREMENT: parent commit's new-test run — max in-flight 1, 155.29ms
  (N=6, 25ms/call). Candidate's same run — max in-flight >1, 32.29ms.
  Full suite: 320/320 (parent) → 321/321 (candidate), tsc clean both.
- MEASUREMENT: synthetic Darwin sweep (N=200, 8ms/call): sequential
  baseline 1600ms; caps 5/10/25/50 → 333.3/164.4/67.3/34.4ms p50.
- INFERENCE: the win is real and structural (not a mocked-away cost) because
  the parent was proven sequential empirically, not assumed from reading
  the code, and the fan-out is over provably independent reads (different
  keys, no shared mutable state, no write ordering to preserve).
- DECISION: ACCEPT, recommended for human review.
- REJECTION (partial): Darwin's synthetic-fitness winner (cap=50) rejected
  as the shipped default — insufficient evidence about real bridge
  concurrency tolerance to justify raising it past the already-large-margin
  cap=25.

## Reward-Hack Check

No existing test's assertions were weakened, no gold/expected value changed,
no threshold touched (budget thresholds `{info,warning,critical,hardStop}`
untouched), no benchmark corpus altered. The one shared-fixture change
(`tests/support/mock-bridge.ts` handlers may now return a `Promise`) is
strictly additive — verified by running the **full**, otherwise-unmodified
320-test suite before adding anything, which stayed green throughout.
`checkOperatingBudget`'s output for identical input data was asserted
unchanged in the (pre-existing, independently authored) summation test
alongside the new concurrency test. No new cache, no undocumented
memoization, no cherry-picked sample size (both empirical runs — parent and
candidate — used the same N, same simulated latency, same assertions).
Independent adversarial pass (this session, separate from implementation):
no unresolved signal.

## Security Review

Read-only fan-out over independent keys in an existing, already-namespaced
(`ruclip-cost-tracking`, company-scoped) persistence path; no write ordering
changes, no new authorization surface, no credential handling changes, no
new dependency, no change to `assertSafeId` usage or any approval/authz
guard. The concurrency-safety precondition this change relies on
(`bridge-client.ts`'s `callTool` already caches the MCP `initialize`
handshake's in-flight promise specifically so concurrent first calls don't
double-initialize — see PR #4) was verified to already exist in this repo,
not assumed. Bounded (not unbounded) fan-out is itself a defensive choice:
caps worst-case simultaneous connections against the real bridge at 25
regardless of company size, versus a bare `Promise.all` that could reach
1000 (the `memory_list` cap) for a company with many tracked sessions.

## Scan Findings

**memory**: No unbounded in-memory growth introduced — `mapWithConcurrency`
allocates one fixed-size `results` array sized to the (already
`memory_list`-capped-at-1000) input length, same as the array the old code
implicitly built by mutating `totalCostUsd` in place (that path held no
intermediate array at all; this one holds a bounded array of ≤1000 small
JSON-RPC response objects transiently, released after `checkOperatingBudget`
returns — negligible and bounded either way).

**latency**: The finding itself — see TL;DR/Evaluation Receipt above.
`checkOperatingBudget` is the only place in `agentdb-adapter.ts` with a
sequential per-item `await` loop over an RPC call inside a hot,
unconditionally-run path (`fireHeartbeat` Gate 2); the other `for` loops in
this file iterate over already-fetched in-memory `result.results` arrays
(client-side filtering, no RPC per iteration) and are not latency-bearing
in the same way — checked directly, not assumed (see repo-wide grep in this
cycle's working notes).

## Competitors

See "Competitors (graded)" table above.

## Gist

No gist-creation tool available in this session (no `gh` CLI, no MCP gist
tool — same constraint as 2026-09-02). Full report committed at this file
instead. `GIST=LOCAL`.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not
including) the line `## Witness` above — i.e. delete this section and
everything after it, then hash what remains. This avoids the
self-referential-hash problem (a hash cannot include itself).

- Session commit (parent): `41433bb971bc6152122acc180c5d695e55ea8c07`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `6a9bd3bb01b138d189d067721ae4b6f119756e7994b9a0d6ed430e62c582e157`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `144a11f1fd079317b6caed4a2974d5305b8fd766989ea2567f37fb493263f81d`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 41433bb971bc6152122acc180c5d695e55ea8c07 --stat` — confirm
   this is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-09-03-performance-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 41433bb971bc6152122acc180c5d695e55ea8c07 | sha256sum` —
   confirm it matches the Witness stamp recorded in the ledger/issue/PR.
4. `git checkout 41433bb971bc6152122acc180c5d695e55ea8c07 -- . && npm ci && npm test` —
   confirm 320/320 pass (baseline receipt).
5. `git checkout dream/2026-09-03-performance -- . && npm test` — confirm
   321/321 pass, and `node --test dist/tests/control-plane/heartbeats-and-comms.test.js`
   shows the new concurrency test's max-in-flight assertion passing.

## Next steps (3)

1. **Measure real bridge concurrency tolerance.** Run `checkOperatingBudget`
   against a live `ruflo mcp start -t http` bridge (or the deployed Cloud
   Run instance referenced in ADR-0001) with an instrumented company at
   varying session counts, to replace tonight's synthetic Darwin sweep with
   a real-world p50/p99 curve and settle whether cap=25 is leaving
   meaningful latency on the table or is already near the bridge's own
   ceiling.
2. **Audit `recallGoalsForCompany`/`recallIssuesForGoal`/`listDueHeartbeats`
   and friends for the same class of issue at larger scale.** Tonight's grep
   confirmed these use `topK`-capped single-call list-then-filter, not
   sequential per-item RPC loops — but only `checkOperatingBudget` was
   empirically load-tested tonight; the others are asserted safe from
   static reading only.
3. **Consider surfacing `checkOperatingBudget`'s own latency as a metric**
   (not built tonight — no metrics/observability surface exists yet in this
   repo to hang it on) so a future regression here is caught by monitoring,
   not by a future Dream Cycle re-discovering it from cold.
