# Performance SOTA Report — 2026

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`
**Rotation**: SLOT=3 → DEEP=performance, SCAN=memory,latency (2026-10-23, DAYINT=20261023, DAYINT%25=23, no bonus)

## TL;DR

`recomputeInteractionSignals` (`src/control-plane/employee-augmentation/interaction-profile.ts`),
invoked synchronously (fire-and-forget, but still fully executed) from
`applyApprovalTransition` on every single approve/reject decision made by a
human OrgMember who has consented to `'internal-timing'`, fetched **every**
`ApprovalTransition` record the company has ever produced and then grouped
and sorted **every issue's** transition list — before the very next loop
discarded all but the handful of issues this one `orgMemberId` ever actually
decided on. The grouping/sorting cost scaled with the *company's total*
approval history, not with the deciding member's own involvement, on a path
that runs once per consenting member per decision, forever. Tonight's
candidate collects the relevant issue ids in one cheap linear pass first,
then scopes the grouping+sort to just those issues. Output is provably
identical (an issue with no decision by `orgMemberId` contributed zero
samples either way, before and after). Measured via a deterministic
`Array.prototype.sort`-call-count regression test (51 issues, 1 relevant):
**52 sort calls → 1** (parent fails the new test outright: 327/328 baseline,
1 predicted failure; candidate 328/328). A synthetic isolated-stage
benchmark at N=5,000 issues shows a 25.4x reduction in the grouping/sort
stage's own wall-clock cost (3.871ms → 0.152ms, p50 of 50 samples).

## What's new

Nothing externally novel — "only do grouping/sorting work for the data the
final answer actually depends on" is a textbook locality/selectivity
optimization, not a new technique. What's new is that this is a genuinely
**distinct** finding from every prior Dream Cycle performance candidate in
this repo: it is not the sequential-vs-concurrent two-tier scan already
independently re-derived three times (closed-duplicate PR #19 2026-09-08,
open PR #53 2026-10-02, re-confirmed-no-new-PR issue #73 2026-10-13) — this
candidate does not touch `listApprovalTransitionsForCompany`'s fetch
mechanics at all, and does not reduce the number of round trips (still
exactly 2, one per tier, same as before). It is also not PR #33's finding
(`applyApprovalTransition` blocking on the call's own latency, fixed there
by `await` → `void`) — PR #33's fix only stops the *caller* from blocking on
the result; it does nothing about the work `recomputeInteractionSignals`
itself still performs once invoked, which is what tonight's candidate
reduces. Checked directly against the 8 previously-logged performance
findings and the repo's own `EMPLOYEE-INTERACTION-PROFILE.md` design doc
before writing any code (see Evidence) specifically to avoid a 9th
rediscovery in this heavily-mined area.

## Competitors (graded)

| Competitor / reference | Relevant to tonight's finding | Grade |
|---|---|---|
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | Public docs describe DB-backed (PostgreSQL) per-agent/per-project activity tracking but do not disclose whether per-actor analytics queries scan a full project's history or are indexed/scoped by actor at the query layer — implementation is closed to docs-only inspection from this session's repo scope. | C (single-source, unconfirmed at the implementation level) |
| Standard "selectivity before materialization" query-optimization practice (filter/partition by the predicate the final result actually depends on before paying grouping/sort cost on the rest) | Directly reproducible, not merely cited: verified empirically in this repo's own evaluator both ways (see Evaluation Receipt) — the parent's unconditional group+sort was proven wasteful, not assumed from reading the code. | A (reproducible — verified directly against this repo's own evaluator and a synthetic isolated-stage benchmark) |
| Node.js `Array.prototype.sort` cost model (near-constant for tiny arrays, so the win here is from *allocation/iteration count*, not comparator cost) | Used to design the discriminating test (counting `sort` calls rather than wall-clock, to avoid timing flakiness) and to interpret the synthetic benchmark's magnitude. | A (language-level semantics, directly verified in this session) |

## Hypothesis (frozen before implementation)

> Given `recomputeInteractionSignals` building a full per-issue, sorted
> transition index across **every** approval transition the company has
> ever recorded before filtering for one `orgMemberId`'s own approve/reject
> decisions, when the function instead first identifies, in one linear pass
> with no additional allocation, only the issue ids where `orgMemberId` has
> at least one approve/reject transition, and then scopes the
> grouping-and-sorting step to just those issues, then the number of
> `Array.prototype.sort` invocations (and the Map/array allocation this
> function performs) should decrease in proportion to
> `(companyIssueCount / memberDecidedIssueCount)`, subject to: byte-for-byte
> identical `medianDecisionLatencySeconds` / `decisionHourHistogram` /
> `sampleCount` output versus the unfixed baseline for every existing test
> case, the full existing test suite passing unchanged, and no change to
> which transitions are fetched from the bridge (the RPC call count and
> shape are untouched — this is a pure post-fetch processing optimization).

Not modified after evaluation began.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), real project test runner, no mocked evaluator.

| | Tests | Pass | Fail | tsc --strict | Duration |
|---|---|---|---|---|---|
| Baseline (`6e73a8f060bcbb69965a50ffe4627e33622d4094`, new test applied, production code unfixed) | 328 | 327 | 1 | clean | ~2.3–2.9s (repeat runs) |
| Candidate (this branch) | 328 | 328 | 0 | clean | ~2.3–2.9s (repeat runs) |

Discriminating regression test (new):
`recomputeInteractionSignals only groups+sorts transitions for the issue(s)
orgMemberId actually decided on, not every issue in the company (Dream
Cycle 2026-10-23, memory/latency)` in
`tests/control-plane/employee-interaction-profile.test.ts`. Builds 50
"noise" issues (submit+approve by two *other* actors — `om-approver` never
appears on them) plus 1 issue `om-approver` actually approved, then
monkeypatches `Array.prototype.sort` (manually, with a `finally`-block
restore — `node:test`'s `mock.method` refuses `Array.prototype` itself as a
target object, `ERR_INVALID_ARG_TYPE`, confirmed by trying it first) to
count invocations.

- **Run against parent commit** (production code reverted to
  `6e73a8f060bcbb69965a50ffe4627e33622d4094`, new test kept): **FAILS** —
  `expected grouping/sorting scoped to the 1 issue om-approver decided on,
  not all 51 issues in the company — observed 52 Array.prototype.sort
  call(s)`. Full-suite run: 328 total, 327 pass, 1 fail (exactly this
  test) — proves the parent genuinely does company-wide grouping/sorting
  and that the new test has discriminating power, not just passing by
  construction.
- **Run against candidate**: **PASSES** — 1 sort call, `sampleCount: 1`,
  `medianDecisionLatencySeconds: 100` (both correctness assertions also
  hold). Full suite: 328/328.

Supplementary synthetic benchmark (throwaway script, **not** part of the
shipped test suite or any gold data — isolates just the grouping+sort stage
with the identical algorithm, inline, to get a wall-clock number without
needing to mock the AgentDB bridge for N=5,000): N=5,000 issues, 1 relevant
to the target member. Parent-shaped grouping+sort p50 (50 samples):
3.871ms. Candidate-shaped: 0.152ms. **25.4x**. This number describes only
the in-process grouping/sort stage, not end-to-end request latency (the
underlying `agentdb_hierarchical-recall` RPC round trip, unchanged by this
candidate, dominates real-world wall-clock at realistic N — see Scan
Findings below for why this is still a real, worth-fixing waste).

`npm run harness:bench-verify`: `Suite repo-native@0.1.0: 6 tasks, hash OK
(840fd8d2d698…)` — unchanged from every prior dream-cycle night's receipt,
confirming no benchmark corpus was touched.

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`origin/main`
tip), evaluated on the real `npm test` entrypoint before any candidate
production code was written (327/327, the repo's existing suite, 0 fail),
then re-evaluated specifically against the new regression test (above) to
prove discriminating power.

## Darwin Lineage (bounded)

Not run. This fix has no tunable parameter to sweep (no concurrency cap,
no batch size, no threshold) — it is a single correctness-preserving
algorithmic restructuring with one shape. Forcing a Darwin search over
nothing would be theater, not evidence; skipped honestly rather than
fabricated, same as 2026-09-02's purely-mechanical extraction night.

## Evidence

- OBSERVATION: `recomputeInteractionSignals` (pre-change) builds `byIssue`
  from **every** transition in `allTransitions`, then calls
  `.sort()` once per entry in `byIssue`, before the subsequent loop filters
  for `transition.actorId === orgMemberId` — grep/read-confirmed against
  the real file, lines ~254–268 pre-change.
- OBSERVATION: cross-checked against the 8 previously-logged
  performance/memory/latency findings in this repo's dream-cycle history
  (PRs #11, #33, #41, #45, #55, #63, and the #19/#53/#73 family) and
  against `PR #33`'s actual diff (`git diff 6e73a8f
  origin/dream/2026-09-18-performance -- src/control-plane/store/agentdb-adapter.ts`)
  — confirmed PR #33 changes only `await` → `void` at the call site and
  does not touch `recomputeInteractionSignals`'s own body at all. Tonight's
  finding is therefore not a duplicate of any logged prior finding.
- MEASUREMENT: parent-code + new-test run — 52 `Array.prototype.sort`
  calls, test fails. Candidate run — 1 sort call, test passes. Full suite:
  327/328 (parent) → 328/328 (candidate), tsc clean both.
- MEASUREMENT: synthetic isolated-stage benchmark (N=5,000, 1 relevant
  issue): parent-shaped 3.871ms p50 → candidate-shaped 0.152ms p50 (25.4x).
- INFERENCE: the win is real and structural (not a mocked-away cost)
  because the parent was proven, by a deterministic call-count assertion
  (not a timing-based one, to avoid flakiness), to pay company-wide
  grouping/sorting cost regardless of the deciding member's own footprint,
  and the optimization only skips work whose output was always discarded
  (verified by output-equivalence assertions in the same test).
- DECISION: ACCEPT, recommended for human review.

## Reward-Hack Check

No existing test's assertions were weakened or deleted; no gold/expected
value changed; no threshold touched. The one new test is purely additive.
`recomputeInteractionSignals`'s output (`sampleCount`,
`medianDecisionLatencySeconds`, `decisionHourHistogram`) is asserted
unchanged for every pre-existing pairing/consent test (all of which passed
unmodified against the candidate) and explicitly re-asserted in the new
test itself. No new cache, no undocumented memoization, no change to the
RPC calls made (`agentdb_hierarchical-recall` is still called exactly
twice, once per tier, with identical arguments) — this is a pure
post-fetch, in-process processing change. `harness:bench-verify`'s hash is
unchanged (`840fd8d2d698…`). Independent adversarial pass (this session,
separate from implementation): tried to break output equivalence by
constructing a case where a "noise" issue's own internal ordering could
leak into the relevant issue's samples — confirmed impossible, since
`byIssue` keys strictly partition by `issueId` and the final pairing loop
only ever looks within one issue's own list. No unresolved signal.

## Security Review

Pure read-side, in-process computation change over data the caller was
already authorized to fetch (the whole-company `ApprovalTransition` scan
itself is unchanged, pre-existing, and out of this candidate's scope — see
`listApprovalTransitionsForCompany`'s own header comment, which already
documents why a company-wide fetch is structurally required here). No new
authorization surface, no new RPC call, no new dependency, no change to
`assertSafeId` usage, no change to what `recomputeInteractionSignals`
reveals to its caller (still the same `EmployeeInteractionProfile` shape,
still module-private storage primitives, still the same two read paths
documented in this file's own header). The §4 "recomputed fresh each call,
not incrementally averaged" design decision (EMPLOYEE-INTERACTION-PROFILE.md)
is preserved exactly — this candidate does not cache or incrementally
average anything across calls, it only avoids doing within-a-single-call
work whose result that same call was always going to discard.

## Scan Findings

**memory**: The parent's `byIssue` Map and its per-issue arrays held every
transition for every issue the company has ever recorded, on every single
qualifying `applyApprovalTransition` call — an allocation that grows
without bound as a company's approval history grows, repeated once per
consenting human member per decision. The candidate bounds this allocation
to the subset of transitions on issues the deciding member actually
touched. This is the finding itself; see TL;DR/Evaluation Receipt above.

**latency**: `recomputeInteractionSignals` is invoked (fire-and-forget per
PR #33, unmerged — on `main` as of tonight it is still `await`-ed and does
block, see Evidence) from `applyApprovalTransition`'s hot path once per
approve/reject by a consenting human OrgMember. The RPC round trip itself
(2 calls, one per tier) is unaffected by tonight's change — the
in-process grouping/sort stage this candidate targets is the *secondary*
cost after the network round trip, which is why the Evaluation Receipt is
explicit that the 25.4x figure describes only that stage, not end-to-end
latency. For a company with a large, long-lived approval history and many
consenting human members, this stage is no longer the dominant cost
post-fix; it was a real, growing, uncapped cost pre-fix.

## Standing context: the review backlog (not tonight's candidate, carried forward from prior nights)

As of this run: **41 dream-cycle issue/PR pairs opened since PR #15
(2026-09-07), only 3 ever merged (#11, #13, #15 — all Sept 2–7), a 7.3%
all-time merge rate, and 0% in the last 37 (#17 through #90)** — reconfirmed
live tonight via `mcp__github__list_pull_requests`/`list_issues` (highest
open PR as of this run is #92, unchanged since 2026-10-22; no new
dream-cycle PR landed between last night and tonight). The most recent
prior night (issue #91/PR #92, 2026-10-22, still open/draft) already did
the full forensic backfill and recommended merging the backlog directly
rather than building another visibility tool; at least 5 independent prior
nights (#34/#35, #46/#47, #62/#63-adjacent, #73, #91/#92) have diagnosed or
tooled this same structural problem, all still unmerged. Tonight does not
add a 6th — this paragraph exists only so the ledger row below carries an
accurate, current number, per this repo's own established convention for
every performance-night ledger row since 2026-10-03.

## Gist

No gist-creation tool available in this session (no `gh` CLI, no gist MCP
tool — same constraint noted on 2026-09-02/09-03 and every night since).
Full report committed at this file instead. `GIST=LOCAL`.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not
including) the line `## Witness` above — i.e. delete this section and
everything after it, then hash what remains. This avoids the
self-referential-hash problem (a hash cannot include itself).

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `d9f6b64b8bee16862df1a3db7c64366dc2d7e4de160d6eb01ec6c29f422a9dce`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `c52549e12b6a5408f19eabce646d1eb459df1dc89ee60dea06ea74660b0f41c0`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm
   this is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-10-23-performance-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it matches the Witness stamp recorded in the ledger/issue/PR.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- . && npm ci && npm test` —
   confirm 327/327 pass (baseline receipt).
5. `git checkout dream/2026-10-23-performance -- . && npm test` — confirm
   328/328 pass, and `node --test dist/tests/control-plane/employee-interaction-profile.test.js`
   shows the new sort-call-count test passing with exactly 1 call recorded.

## Next steps (3)

1. **Audit other `deps.*`-gated best-effort call sites for the same
   "fetch/process broadly, filter narrowly" shape.** Tonight's fix was
   found by reading one specific function end to end; a systematic grep for
   "list*ForCompany followed by client-side filtering to one actor/entity"
   across `src/control-plane` was not performed (budget-bounded tonight) —
   `fire-heartbeat.ts` and `claims-authorization.ts` were spot-checked and
   found already properly scoped, but the sweep was not exhaustive.
2. **Measure real-world `ApprovalTransition` history size per company.**
   Tonight's synthetic benchmark (N=5,000) has no production data behind
   it — no metrics/observability surface exists yet in this repo (same gap
   flagged by 2026-09-03's report) to say whether real companies' approval
   histories ever reach a size where this fix's win is material versus
   negligible.
3. **The review backlog is the dominant uncertainty, not performance
   findings.** With 0% of the last 37 dream-cycle PRs merged, the question
   this repository most needs answered is not "is there another
   performance win to find" (this night's research suggests the easily
   reachable ones in `agentdb-adapter.ts`/`interaction-profile.ts` are
   close to exhausted) but "why isn't anything merging, and what does the
   human reviewer need to unblock that." A nightly session cannot answer
   that from inside its own sandbox.
