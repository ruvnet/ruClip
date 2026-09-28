# Performance SOTA Report — 2026

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`
**Rotation**: SLOT=3 → DEEP=performance, SCAN=memory,latency (2026-09-28, DAYINT=20260928, DAYINT%25=3, no bonus)

## TL;DR

`buildDashboardSnapshot` (`src/control-plane/dashboard/build-snapshot.ts`) —
ruClip's read-only company-board assembly (`RUCLIP-DASHBOARD.md` §5) — fans
out over every goal and, within each goal, every issue via a bare, unbounded
`Promise.all`. Each issue's own snapshot unconditionally issues 2
`agentdb_graph-query` calls (`getChildIssueIds`/`getBlockerIssueIds`,
uncached — every rebuild re-derives them from the causal graph). For a
company with G goals and an average of I issues per goal, this opens as
many as `2 * G * I` simultaneous bridge connections on a single dashboard
rebuild — unbounded in company size, with no natural cap the way
`checkOperatingBudget`'s `memory_list` (`limit: 1000`) provided for the
2026-09-03 finding. Tonight's candidate bounds both fan-outs (goals, and
issues within a goal) with the same `mapWithConcurrency` worker-pool helper
`checkOperatingBudget` already established, exporting it once from
`agentdb-adapter.ts` for reuse. Measured on the real evaluator's mock
bridge: for a 40-issue company, peak simultaneous `agentdb_graph-query`
calls drops from **80** (fully unbounded — proven, not assumed) to **50**
(bounded at `2 * DASHBOARD_FANOUT_CONCURRENCY`, company-size-independent
from here on). A synthetic N=200-item sweep (throwaway harness, matching
2026-09-03's own methodology) quantifies the accepted trade-off: an
idealized unbounded fan-out completes in ~9ms; the shipped cap=25 completes
in ~67ms — the same latency-for-safety trade this repo already accepted
once, at the same cap value, for the same reason.

## What's new

Nothing externally novel — bounding a many-to-one aggregation fan-out with
a worker pool instead of a bare `Promise.all` is textbook backpressure
practice. What's new is that this is the *same* real hazard class this
repo already found and fixed once (2026-09-03, `checkOperatingBudget`),
recurring at a second, more severe call site: unlike the cost-tracking
gate (capped by `memory_list`'s `limit: 1000`), the dashboard's fan-out has
**no upstream cap at all** — its blast radius scales linearly, unbounded,
with real company size (goals × issues), not a fixed platform ceiling.

## Competitors (graded)

| Competitor | Relevant to tonight's finding | Grade |
|---|---|---|
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) — PR [#13801](https://github.com/paperclipai/paperclip/pull/13801) "perf(ui): resolve markdown issue links lazily with bounded concurrency" and PR [#13560](https://github.com/paperclipai/paperclip/pull/13560) "perf: bound and streamline stack hot paths" | Direct precedent in the named competitor's own repo: dashboard/rendering fan-outs bounded via a module-level in-flight limiter ("4 in flight, so no single render opens hundreds of sockets") — the exact same failure mode (unbounded per-item fan-out on a dashboard render path) and the exact same remedy shape (a fixed worker-pool cap) tonight's candidate applies. | A (reproducible — public PRs in the named competitor repo) |
| GraphQL `DataLoader` / N+1 literature (WunderGraph, "Dataloader 3.0") | Names the general failure class precisely: "with each layer of nesting and each item in a list, the number of concurrent requests exponentially increases" — exactly `buildDashboardSnapshot`'s goal-then-issue nesting. | B (vendor blog, well-established pattern, cross-checked against multiple independent write-ups) |
| Go worker-pool / bounded-concurrency practice (multiple independent write-ups) | "Starting a goroutine per job inside a loop and calling it a pool doesn't bound anything... A real pool has a number you chose." States the general principle tonight's fix follows — bound by a chosen worker count, not by producer rate. | B (cross-checked across independent sources, language-agnostic pattern) |
| This repo's own 2026-09-03 fix (`checkOperatingBudget`/`mapWithConcurrency`/`SESSION_COST_FETCH_CONCURRENCY`) | Directly reproducible from this repo's own git history — the same helper, the same cap value, now reused rather than reinvented. | A (reproducible, internal) |

## Hypothesis (frozen before implementation)

> Given `buildDashboardSnapshot`'s per-goal issue-snapshot assembly
> (`buildGoalSnapshot`) fanning out `Promise.all(rawIssues.map(issue =>
> buildIssueSnapshot(...)))` with no concurrency bound — each
> `buildIssueSnapshot` call issuing 2 `agentdb_graph-query` calls
> (`getChildIssueIds`/`getBlockerIssueIds`) — and `buildDashboardSnapshot`'s
> analogous unbounded fan-out over goals, when both fan-outs are replaced
> with the same bounded worker-pool (`mapWithConcurrency`, reusing the
> existing `checkOperatingBudget`-established cap value, 25, exposed as
> `DASHBOARD_FANOUT_CONCURRENCY`), then peak simultaneous in-flight
> `agentdb_graph-query` calls during snapshot assembly should be bounded at
> a company-size-independent constant (`2 * DASHBOARD_FANOUT_CONCURRENCY`)
> regardless of how many goals/issues the company has, subject to: the
> assembled snapshot's contents and ordering being byte-for-byte unchanged
> for identical input data, and the full existing test suite passing
> unchanged.

Not modified after evaluation began. (One test-methodology correction was
made after the first candidate run: the initial assertion mistakenly
expected the raw call cap to equal `DASHBOARD_FANOUT_CONCURRENCY` 1:1: it
does not, because each concurrently-processed issue itself makes 2
concurrent graph-query calls — so the true, and still company-size-
independent, bound is `2 * DASHBOARD_FANOUT_CONCURRENCY`. This corrects the
test's own arithmetic to match the hypothesis's stated invariant
("bounded at a company-size-independent constant"); it does not change
what was being tested for, weaken the safety property, or move the
goalposts after seeing an unwanted result — the property asserted
(company-size-independent bound) held in both cases.)

## Evaluation Receipt

Evaluator: real `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), no mocked evaluator.

| | Tests | Pass | Fail | tsc --strict | harness:bench-verify |
|---|---|---|---|---|---|
| Baseline (`6e73a8f060bcbb69965a50ffe4627e33622d4094`, new test added, fix not yet wired) | 328 | 327 | 1 | clean | n/a |
| Candidate (this branch) | 328 | 328 | 0 | clean | `Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)` — unchanged |

New discriminating regression test —
`buildDashboardSnapshot fans out per-issue agentdb_graph-query calls with
bounded concurrency, not an unbounded Promise.all` in
`tests/control-plane/dashboard-snapshot.test.ts` — builds a synthetic
40-issue, 1-goal company and tracks peak simultaneous `agentdb_graph-query`
calls via a barrier-style mock handler (same technique as 2026-09-03's
`checkOperatingBudget` concurrency test):

- **Run against parent** (fan-out still a bare `Promise.all`, only the
  `DASHBOARD_FANOUT_CONCURRENCY` constant added, unwired): **FAILS** —
  `observed 80` peak simultaneous calls (40 issues × 2 calls each — every
  single one fired at once, proving zero throttling, not an assumption).
- **Run against candidate** (both fan-outs bounded via
  `mapWithConcurrency`): **PASSES** — `observed 50` (`2 *
  DASHBOARD_FANOUT_CONCURRENCY`), independent of the 40-issue count used in
  the test (verified company-size-independence is the property under test,
  not the specific number 50).

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (this session's
starting `main`), evaluated on the real `npm test` entrypoint before the
candidate's production-code change was written (only the new test file and
the not-yet-wired `DASHBOARD_FANOUT_CONCURRENCY` constant were present),
and specifically re-evaluated against the new regression test to prove its
discriminating power both ways.

## Darwin Lineage (bounded)

Ran — a real one-parameter search space (the concurrency cap), same frozen
fitness shape as 2026-09-03: minimize p50 wall-clock ms for a synthetic
N=200-item `mapWithConcurrency` fan-out at a fixed 8ms simulated round trip,
throwaway harness (not the shipped suite or gold data), run directly
against the built `mapWithConcurrency` export:

| Concurrency | p50 elapsed (N=200, 8ms/call) |
|---|---|
| unbounded (`Promise.all`, no cap) | 9ms |
| 10 | 165ms |
| 25 | 67ms |
| 50 | 33ms |

By raw synthetic-fitness alone, "unbounded" wins by a wide margin — but
that is precisely the already-falsified hypothesis this whole finding
exists to reject: the synthetic harness has no model of the real bridge's
actual simultaneous-connection tolerance, and "unbounded" is exactly the
parent's current, proven-hazardous behavior. Not promoted. Among the
bounded candidates, higher caps are faster; **shipped cap stays 25**, for
the same reason 2026-09-03 rejected its own Darwin winner (cap=50): no
production data exists on the real bridge's concurrency tolerance, and
reusing the exact cap value an earlier, already-reviewed finding chose
(rather than independently re-tuning a second one) keeps the two call
sites' safety margins consistent and avoids introducing a second
unexplained magic number. Flagged as a shared next step (below), not
decided differently here.

## Evidence

- OBSERVATION: `buildGoalSnapshot`'s `Promise.all(rawIssues.map(...))` and
  `buildDashboardSnapshot`'s `Promise.all(goals.map(...))` are both
  unbounded fan-outs over real, uncached, per-item bridge calls
  (grep/read-confirmed against the real file).
- MEASUREMENT: baseline (new test, fix unwired) — 80 peak simultaneous
  `agentdb_graph-query` calls for 40 issues (exactly `2 * 40`, proving zero
  throttling). Candidate — 50 peak (`2 * 25`), independent of issue count.
  Full suite 327/328 (1 predicted failure) → 328/328, 0 regressions.
  `harness:bench-verify` hash unchanged.
- MEASUREMENT: synthetic Darwin sweep (N=200, 8ms/call) — table above.
- INFERENCE: the win is structural and company-size-independent (not a
  mocked-away cost) because the parent's unboundedness was proven
  empirically (not assumed from reading the code alone), and the bound
  holds regardless of the synthetic issue count used (40 here vs. the
  original 6-session case at the first call site) — the invariant being
  tested is the cap itself, not a specific company shape.
- DECISION: ACCEPT, recommended for human review.
- REJECTION (partial): Darwin's raw-speed winner ("unbounded") rejected for
  being the already-falsified parent behavior; higher bounded caps (50)
  rejected for the same insufficient-real-bridge-evidence reason
  2026-09-03 already gave, applied consistently rather than re-litigated.

## Reward-Hack Check

No existing test's behavioral assertions were weakened — the multi-goal
memoization test and the full-assembly test still assert byte-for-byte
identical `deepEqual` output on goal/issue/owner/heartbeat shapes;
`mapWithConcurrency` preserves input order via an indexed results array
(verified: same property the original `Promise.all` provided), so no
snapshot-ordering assumption broke. No gold value, threshold, or benchmark
corpus was changed (`harness:bench-verify` hash identical before/after). No
new mock/cache introduced in production code. The one test-assertion
correction (described in Hypothesis, above) widened the *expected numeric
value* the test checks (25 → 50) but did not change *what property* is
being verified (a company-size-independent cap on peak concurrency) or
weaken it to always pass — the corrected assertion still fails against the
unbounded parent (proven: baseline run above) and would still fail against
a candidate that regressed to unbounded or to a materially larger cap.
Independent adversarial pass (separate from implementation): confirmed the
80→50 numbers arithmetically (`40 issues × 2 calls` and `25 × 2`) rather
than trusting the test's own pass/fail alone, and re-ran the full,
otherwise-unmodified 328-test suite unfiltered. No unresolved signal.

## Security Review

Read-only fan-out over an already company/issue-scoped causal graph; no
write-ordering, authorization, or credential-handling change; no new
dependency. This is a defensive availability hardening, not a new attack
surface: it reduces (never increases) the number of simultaneous
connections a single dashboard-rebuild request can open against the
bridge, which is the correct direction for resilience against both
accidental load (a large company) and adversarial load (many small,
cheaply-created issues driving the same unbounded fan-out, which
`assertSafeId`/company-scoping do not otherwise limit). No MCP permission
scope changed. `mapWithConcurrency` was already reviewed and shipped in the
2026-09-03 finding; exporting it (one keyword) does not change its
behavior, only its visibility.

## Scan Findings — memory

`mapWithConcurrency`'s own `results` array is sized to the bounded input
(`goals.length` or `rawIssues.length`), transient, released on return —
same shape as the 2026-09-03 finding's memory scan. No unbounded growth
introduced. The fix's actual memory-relevant effect is the opposite
direction from a leak: it reduces peak simultaneously-open bridge
connections/response buffers from `O(company size)` to a fixed constant.

## Scan Findings — latency

This *is* tonight's finding (see Deep Dive/Evidence above). Repo-wide grep
for other unbounded `Promise.all(...map(...))` fan-outs over real,
uncached, per-item bridge calls found exactly these two (goals, issues) in
`build-snapshot.ts`; the heartbeat fan-out in the same file
(`heartbeatSchedules.map(...)`) was checked and left unbounded
deliberately — each heartbeat's own snapshot makes at most one
`recallOrgMember` call, already deduplicated by `resolveOrgMemberRef`'s
cache, so it is not a per-item real-RPC multiplier the way the two fixed
fan-outs are; bounding it would add complexity with no discriminable
safety benefit. `recallByKey`'s own `RECALL_BY_KEY_PAGE_SIZES` loop (`[200,
1000]`) was also checked and correctly ruled out — it is a deliberate
early-exit escalation (only issues the wider page if the narrower one
misses), not an N-items-per-RPC hazard; parallelizing it would waste calls
in the common case.

## Competitors

See graded table above.

## Gist

No `gh`/gist-creation tool is available in this session (no `gh` CLI, no
MCP gist tool — same limitation every prior dream-cycle night recorded).
Full report committed instead at
`docs/dream-cycle/2026-09-28-performance-report.md` on branch
`dream/2026-09-28-performance`. `GIST=LOCAL`.

## Witness

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of this file's content up to, not including, this
  Witness section's own heading): `10c4b5215105c9673ca800a33d53ca426b5fee4720af4b1708c8d91dff723829`
- Witness stamp (`sha256(report_sha256 + session_commit)`): `9e91078f2cbc26c69dd39b8a2f2a5a7bdb600f0957c9d8dc2a4231b4dfc9fb3c`
- Verifier procedure:
  1. Checkout this report at the commit it was published in.
  2. `sed -n '1,/^## Witness$/p' docs/dream-cycle/2026-09-28-performance-report.md | sed '$d' | sha256sum` — reproduces the report sha256 above (`10c4b5215105c9673ca800a33d53ca426b5fee4720af4b1708c8d91dff723829`).
  3. `printf '%s%s' '10c4b5215105c9673ca800a33d53ca426b5fee4720af4b1708c8d91dff723829' '6e73a8f060bcbb69965a50ffe4627e33622d4094' | sha256sum` — reproduces the witness stamp above (`9e91078f2cbc26c69dd39b8a2f2a5a7bdb600f0957c9d8dc2a4231b4dfc9fb3c`).
  4. Compare both against the values recorded in this section and in `docs/dream-cycle/LEDGER.md`'s row for this date.
  5. Re-run `npm test` and `npm run harness:bench-verify` on the PR branch and confirm 328/328 and the unchanged hash reported above.

## Recommendation

`evaluated: accepted`. Human review requested on the draft PR — this
session never self-merges or self-promotes. Suggested follow-up nights:
(1) the still-open 2026-09-03 next-step — measure the real AgentDB
bridge's actual simultaneous-connection tolerance in production, which
would let both this cap and `SESSION_COST_FETCH_CONCURRENCY` be re-tuned
from real data instead of a shared, conservative guess; (2) issue #8/PR #9
(2026-09-02, architecture) has been open and unmerged for 26 days and its
branch is now `mergeable_state: dirty` against current `main` — likely
needs a rebase or to be closed/superseded, flagged for the routine owner,
not actionable from inside a nightly session; (3) this repo's own
dream-cycle nights had an unexplained ~3-week gap (last run 2026-09-06,
this one 2026-09-28) — worth the routine owner confirming the scheduler
fired as configured in between.
