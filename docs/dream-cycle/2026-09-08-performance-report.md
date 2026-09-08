# Performance/Latency SOTA Report — 2026-09-08

## TL;DR

`listIssuesForGoal`, `listHeartbeatsForCompany`, and `listApprovalTransitionsForCompany`
(`src/control-plane/store/agentdb-adapter.ts`) each scan the `working` and
`episodic` hierarchical-store tiers via two independent
`agentdb_hierarchical-recall` round trips, merged into one accumulator array.
All three ran the two tier calls **sequentially** (`for (const tier of [...])
{ await callTool(...) }`) despite the calls being provably independent (no
data dependency between tiers, and every downstream consumer either treats
the result as an unordered display list or explicitly re-sorts it before use).
Parallelized via `Promise.all` across the two tiers — same conceptual fix as
2026-09-03's `checkOperatingBudget` finding, applied to three call sites this
time. All three functions sit on the dashboard-assembly hot path
(`build-snapshot.ts`) or the interaction-signal-recompute path
(`interaction-profile.ts`).

## What's new / prior art

- A prior night's own report (2026-09-03) claimed `checkOperatingBudget` was
  *"the only place in agentdb-adapter.ts with a sequential per-item await
  loop over an RPC call."* That claim was incorrect — it missed three
  structurally identical tier-scan loops elsewhere in the same file. Tonight
  corrects the record and fixes all three.
- Confirmed via `git log`/GitHub API that none of the prior five dream-cycle
  PRs (#9, #11, #13, #15, #17) are GitHub-recorded as merged as of tonight
  (`merged:false` on every one; three of them `closed` with their content
  nonetheless present on `main` — landed by a mechanism outside this
  session's visibility). Per the routine's own learning signal ("zero of the
  last 14 candidate PRs merged → bias to a tiny, easily-reviewable
  candidate"), tonight's fix is a single mechanical transformation
  (`for...of` + `await` → `Promise.all(...map(...))`) applied identically
  three times, not a redesign.
- **Ledger repair**: 2026-09-07's ledger row was never appended by that
  night's session (issue #16, PR #17, and a local report existed, but
  `docs/dream-cycle/LEDGER.md` stopped at 2026-09-06). Backfilled tonight
  from the GitHub issue/PR bodies before appending this row — see
  `LEDGER.md`'s 2026-09-07 row, marked `(backfilled 2026-09-08)`.

## Ledger check (Step 1)

Re-checked fate of every associated issue/PR via authenticated GitHub MCP
tools (`gh`/gist CLI unavailable this session, same as every prior night —
`FALLBACK` applies to gist publication only, not issue/PR/API tooling):

| PR | Night | API state | Notes |
|---|---|---|---|
| #9 | 09-02 architecture | `open, merged:false` | 6 nights unreviewed |
| #11 | 09-03 performance | `closed, merged:false` | Finding (bounded-concurrency fan-out) IS on `main` — confirmed by reading `agentdb-adapter.ts:1367` directly |
| #13 | 09-05 correctness | `closed, merged:false` | Same landed-outside-GitHub pattern |
| #15 | 09-06 security | `closed, merged:false` | Same pattern — this is `main`'s current tip, `6e73a8f` |
| #17 | 09-07 architecture | `open, merged:false` (draft) | 1 night old; content NOT on `main` (`agentdb-adapter.ts` still 1483 lines, pattern-store not yet extracted) |

**Learning signal applied**: 0 of 5 dream-cycle PRs GitHub-recorded as merged.
Tonight's candidate is a mechanical, uniform transformation applied to three
call sites — not a larger redesign — consistent with the bias the routine's
own rule calls for.

## Deep dive (performance)

Searched `src/control-plane/**/*.ts` (excluding tests) for sequential
per-item `await` loops over RPC calls — the same shape as 2026-09-03's fix.
Found three, all in `agentdb-adapter.ts`, all following the identical
"scan working tier, then scan episodic tier, merge" pattern:

- `listIssuesForGoal` (line 730) — feeds `buildGoalSnapshot`
  (`dashboard/build-snapshot.ts:162`), called once per goal while assembling
  a company's dashboard snapshot.
- `listApprovalTransitionsForCompany` (line 794) — feeds
  `recomputeInteractionSignals` (`employee-augmentation/interaction-profile.ts:254`),
  `topK: 500` (the heaviest of the three).
- `listHeartbeatsForCompany` (line 1208) — feeds `buildDashboardSnapshot`
  (`dashboard/build-snapshot.ts:191`) directly.

No other sequential per-item `await callTool(...)` loop exists anywhere else
in `src/control-plane` (full-repo grep for `for (`/`for...of` blocks
containing `await`, manually reviewed each hit).

## Frozen hypothesis (frozen before implementation)

> Given a call to `listIssuesForGoal`, `listHeartbeatsForCompany`, or
> `listApprovalTransitionsForCompany` against a bridge with non-trivial
> per-call latency, when the two independent tier scans (`working`,
> `episodic`) are issued concurrently via `Promise.all` instead of
> sequentially via `for...of` + `await`, then each function's wall-clock
> latency should approach `max(tier_working_ms, tier_episodic_ms)` instead of
> `tier_working_ms + tier_episodic_ms`, subject to: the full existing test
> suite passing identically before and after, `tsc --strict` staying clean,
> merged-result correctness unchanged regardless of array order (verified
> against every downstream consumer), and zero call-site signature changes.

## Candidate

Three identical edits in `src/control-plane/store/agentdb-adapter.ts`:
replace
```ts
for (const tier of ['working', 'episodic'] as const) {
  const result = await callTool(...);
  for (const r of result.results ?? []) { /* merge */ }
}
```
with
```ts
const tierResults = await Promise.all(
  (['working', 'episodic'] as const).map((tier) => callTool(...)),
);
for (const result of tierResults) {
  for (const r of result.results ?? []) { /* merge, unchanged */ }
}
```
Zero signature changes; the merge/parse/filter logic inside each inner loop
is untouched, byte-for-byte.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), Node v22.

- **Baseline** (parent `6e73a8f`, `main` tip, pre-candidate code): 327/327 tests pass.
- **Baseline + new tests, pre-fix code** (proof the tests are real, not
  tautological): stashed the source fix, kept the 3 new concurrency tests —
  **all 3 fail** (`not ok`, `failureType: 'testCodeFailure'`) against the
  unmodified sequential code.
- **Candidate** (source fix + 3 new tests): 330/330 tests pass, `tsc --strict` clean.
- **Diff shape**: 2 production/test files changed — `agentdb-adapter.ts`
  (three `for...of` loops → `Promise.all(...map(...))`, zero signature
  changes) and `tests/control-plane/dashboard-snapshot.test.ts` (+81, three
  concurrency-overlap tests + one import). `LEDGER.md` backfill is a
  separate, clearly-marked concern (memory/documentation, not code).
- **Latency shape** (synthetic, mocked `ROUND_TRIP_MS = 25`, same technique
  as 2026-09-03's `checkOperatingBudget` test): each function's two-tier scan
  measured at ~25ms (max of two overlapping 25ms calls) post-fix vs. would be
  ~50ms pre-fix (sum of two sequential 25ms calls) — a flat ~2x reduction per
  call, applied at 3 call sites on 2 hot paths (`buildDashboardSnapshot` →
  `buildGoalSnapshot` per goal; `recomputeInteractionSignals`). Unlike
  2026-09-03's N-session fan-out, this is not a scale-dependent win (fan-out
  width is always exactly 2) — it is a fixed, one-time latency halving per
  call site, real but bounded.
- `npm run harness:bench-verify`: `Suite repo-native@0.1.0: 6 tasks, hash OK
  (840fd8d2d698…)` — corpus unchanged, not gone soft.

## Darwin

Not run. No fitness landscape to search: the fix is a single, fully-specified,
zero-behavior-change transformation (mechanical `for...of`+`await` →
`Promise.all`, applied identically 3x) with one correct implementation, not a
tunable parameter or an open design space — same reasoning 2026-09-02's and
2026-09-07's architecture nights gave for skipping Darwin on their own
zero-behavior-change extractions. (`metaharness-darwin evolve` is also not
directly invocable on `PATH` this session — only `bench verify` resolved via
the npm script — moot given the above.)

## Evidence

- OBSERVATION: three structurally identical tier-scan loops in
  `agentdb-adapter.ts` (`listIssuesForGoal:730`,
  `listApprovalTransitionsForCompany:794`, `listHeartbeatsForCompany:1208`),
  each issuing two sequential `agentdb_hierarchical-recall` calls merged into
  one accumulator.
- MEASUREMENT: baseline 327/327; candidate 330/330 (3 new); pre-fix code +
  new tests → 3/3 fail (proves the tests assert something real); synthetic
  25ms/tier mock → ~25ms candidate vs. ~50ms baseline per call;
  `harness:bench-verify` hash unchanged.
- INFERENCE: the parallelization is safe because (a)
  `interaction-profile.ts:262` explicitly re-sorts
  `listApprovalTransitionsForCompany`'s output by `createdAt` per issue
  before any pairing logic runs — raw array order is provably irrelevant
  downstream; (b) `build-snapshot.ts` treats
  `listIssuesForGoal`/`listHeartbeatsForCompany`'s output as a plain display
  list with no order assertion anywhere in `src/` or `tests/`.
- DECISION: ACCEPT, recommended for human review.

## Reward-hack / adversarial critique (independent pass over the candidate)

No gold answer, threshold, or benchmark corpus touched (`.harness/bench.json`
hash unchanged — `harness:bench-verify` re-run, `840fd8d2d698…` OK). No
existing test modified — only 3 new tests added, and their real-bug-catching
power was verified by running them against the *unmodified* baseline code
(all 3 fail there, confirming they are not tautological). No new mock/cache
introduced beyond the existing shared `mockBridge`. No export dropped,
renamed, or had its signature changed. Bare (unlimited-width) `Promise.all`
was deliberately checked against the general "unbounded Promise.all is
dangerous at scale" caution (see Competitors table) and found inapplicable
because the fan-out width here is a compile-time constant of 2, not
data-proportional — this is the one reward-hack-adjacent judgment call in
tonight's diff, and it is documented rather than silently made. Critic clear.

## Security review (Step 15)

Pure control-flow change (loop → `Promise.all`) on read-only queries. No
authorization guard, credential path, `assertSafeId` call site, filesystem/
network scope, or MCP tool surface touched. No new dependency. Fan-out width
unchanged at 2 (not attacker-influenced — `['working', 'episodic']` is a
hardcoded tuple, not derived from input), so no new DoS/amplification surface
versus the sequential version. Least-privilege posture unchanged.

## Scan findings — memory

- `npm run harness:score` reports `memoryUsefulness: 38` (low, pre-existing —
  not something tonight's fix changes; flagged as a candidate deep-dive for
  a future `developer-experience` or `architecture` night, not actionable
  tonight without more context on what the scorer measures).
- No module-level unbounded cache found anywhere in `src/control-plane`
  (`grep` for module-scope `new Map()`/`new Set()` returned zero matches).
  The one cache that exists, `build-snapshot.ts`'s `OrgMemberCache`, is
  explicitly constructed fresh per `buildDashboardSnapshot` call (see that
  file's own header comment on why a shared/module-level cache would be
  wrong) — correct-by-construction, not a leak risk.
- `listApprovalTransitionsForCompany`'s `topK: 500` fetches full
  `ApprovalTransition` JSON blobs when `recomputeInteractionSignals` only
  reads 5 fields (`issueId`, `actorId`, `action`, `fromState`/`toState`,
  `createdAt`) — a real but out-of-scope-tonight memory/bandwidth waste; see
  Recommendation.

## Scan findings — latency

- Confirmed (via `git log` + reading the file directly) that 2026-09-02's and
  2026-09-07's `agentdb-adapter.ts` extraction PRs are **not** on `main`
  despite their ledger rows saying ACCEPT — only the security fix (#15) and
  tonight's parent commit are actually merged content. 2026-09-03's
  `checkOperatingBudget` bounded-concurrency fix IS present on `main`
  (verified by reading `agentdb-adapter.ts:1367` directly), consistent with
  the same "closed-but-landed-outside-GitHub" pattern noted above.
- No other sequential per-item `await callTool(...)` loop found anywhere else
  in `src/control-plane/**/*.ts` (see Deep dive).

## Competitors (graded)

| Source | Claim | Grade | Relevance |
|---|---|---|---|
| p-limit / general Node.js concurrency guidance (2026 dev blogs) | Naive unbounded `Promise.all` over large/unbounded lists causes event-loop congestion and GC pressure at scale (10k+ req/s case study) | B (vendor/blog, cross-checked across multiple 2026 sources) | Explicitly considered and ruled inapplicable here — the fan-out width in all three functions is a compile-time-fixed 2 (`['working', 'episodic']`), never proportional to data size, unlike `checkOperatingBudget`'s N-session fan-out (which correctly used bounded `mapWithConcurrency`, cap 25). Bare `Promise.all` is the right tool at fan-out-of-2. |
| `paperclipai/paperclip` (persistence layer) | Trims issue-detail/activity-ledger response payloads to only the fields each view needs, dropping large embedded metadata; "active issues... load noticeably faster without changing the underlying persistence model" | B (project blog/dev.to deep-dive, not primary repo docs) | A genuinely different lever (payload shape, not fan-out) — noted as a next step, not tonight's candidate: `listApprovalTransitionsForCompany` fetches full blobs when 5 fields are read. |
| `paperclipai/paperclip` (concurrency model) | Per-adapter/company concurrency ceilings (`agent.runtimeConfig.heartbeat.maxConcurrentRuns`), `company_id`-scoped queries/indexes throughout | B | Structural precedent for company-scoped, explicitly-bounded concurrency — consistent with this repo's own `SESSION_COST_FETCH_CONCURRENCY` cap; reinforces fan-out width should always be either fixed-and-small (this fix) or explicitly bounded (2026-09-03's fix), never bare-unbounded-and-data-proportional. |
| Khomh et al. 2012 (empirical, God-module fault risk) | Re-cited from 2026-09-02/09-07 architecture nights | A (peer-reviewed, previously verified) | Not directly applicable to tonight's fix (a latency change, not a decomposition); included for continuity — `agentdb-adapter.ts` remains 1483 lines pending the still-unmerged extraction PRs. |

## Gist

No `gh gist create`/`gh` CLI available this session (same as every prior
dream-cycle night per the ledger). Full SOTA report committed at
`docs/dream-cycle/2026-09-08-performance-report.md` on branch
`dream/2026-09-08-performance`. `GIST=LOCAL`.

## Witness

```
REPORT_HASH    = ad2d24d83552a77e005638ef272100352cbe66777a04371966d3e37106e0b653
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = c37ec041d7726ab46e3fac01b5069ee03ae8d774ad69d2d32a3d115aca803285
```

`REPORT_HASH` is the sha256 of this file's content up to (and including) the
line directly above this Witness section — i.e. everything before `## Witness`
itself — computed once, before this section was filled in (a self-referential
hash of the whole file including its own hash would be circular). `WITNESS =
sha256(REPORT_HASH || SESSION_COMMIT)`, computed as
`printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text (`docs/dream-cycle/2026-09-08-performance-report.md`) up to the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. Independently re-run `npm test` against the PR branch's HEAD and confirm 330/330 (0 fail) — the receipt this report claims.

## Recommendation

`evaluated: accepted`. Human review recommended for the draft PR — this
session never self-merges. Follow-ups: (1) trim
`listApprovalTransitionsForCompany`'s fetched payload to the 5 fields
actually read, if/when the real `agentdb_hierarchical-recall` tool supports
field projection (not attempted tonight — no evidence it does yet); (2)
escalate again to the routine owner — 0 of 5 dream-cycle PRs opened to date
are GitHub-recorded as merged, three nights running now; (3) investigate
`harness:score`'s `memoryUsefulness: 38` metric on a future
`developer-experience` or `architecture` night.
