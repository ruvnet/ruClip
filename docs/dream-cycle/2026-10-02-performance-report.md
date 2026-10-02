# ruClip Performance SOTA Report — 2026-10-02

## Rotation

`DATE=2026-10-02`, `DAYINT=20261002`, `SLOT = DAYINT % 5 = 2` → static slot
map says `DEEP=architecture, SCAN=docs,api`. `DAYINT % 25 = 2`, no bonus
roadmap-review. Session commit (parent, `main` tip): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
(unchanged since 2026-09-07 — see Ledger Check).

**Rotated at Step 1.1**: `DEEP=performance, SCAN=memory,latency` (slot 3's
mapping), carried forward exactly as 2026-09-22 (#40/PR#41) and 2026-09-27
(#42/PR#43) already did, for the same reason those two nights gave: the
architecture slot's one real finding — "`agentdb-adapter.ts` is a God-module,
extract a small independent slice" — has now been proposed identically three
times (#8/PR#9 2026-09-02, #16/PR#17 2026-09-07, #30/PR#31 2026-09-17), none
merged, and no new evidence since 09-17 justifies reopening that direction
(Step 2). Confirmed directly rather than assumed: `agentdb-adapter.ts` is
still 1483 lines on current `main`. One update to the standing rotation
rationale: PR#9 (the first instance) now additionally reports
`mergeable_state: "dirty"` — a real merge conflict against `main` — which is
itself evidence *for* the rotation call, not just a repeat-count trigger: the
longer these same-file extraction PRs sit unmerged, the more they will
conflict with each other and with whatever else lands on `main`.

## Ledger Check

`docs/dream-cycle/LEDGER.md` on `main` is frozen at 3 rows (2026-09-02
backfilled + 2026-09-03 + 2026-09-05 + 2026-09-06 — 4 rows total as checked
out), last touched by the commit that merged PR#15 (2026-09-07). Confirmed
directly: `git log main -- docs/dream-cycle/LEDGER.md` shows no commit since.
This exact freeze was already identified and filed as issue #34 (2026-09-19,
developer-experience) — PR#35 even built a `reconcile-ledger.ts` recovery
tool for it — but PR#34/#35 is *itself* one of the 19 unmerged PRs below, so
the fix for "the ledger never gets updated because PRs don't get merged" is
also stuck unmerged. Noting, not re-solving: this is squarely developer-experience
surface territory (already covered twice, #34 and #46), not tonight's.

Full reconciliation (GitHub MCP `pull_request_read`/`issue_read`, not `gh`
CLI — see Build/Credentials below): **22 dream-cycle PRs exist (#9 through
#51 across #9,#11,#13,#15,#17,#19,#21,#23,#25,#27,#29,#31,#33,#35,#37,#39,#41,#43,#45,#47,#49,#51).
Only 3 are merged** — #11 (2026-09-03 performance), #13 (2026-09-05
correctness), #15 (2026-09-06 security), all three before 2026-09-07. **Every
PR opened in the 25 nights since (#17 through #51, 19 PRs) is still open,
unreviewed, every one reporting an ACCEPT verdict in its own evaluation
receipt.** Only #9 (the oldest) has gone stale to the point of an actual merge
conflict (`dirty`); the other 18 open PRs still report `mergeable_state:
clean` (one, #39, reports `unstable` — one pre-existing environmental test
failure reproduced on both sides of that night's diff, not caused by it).
**Learning signal applied**: 0 of the last 14 dream-cycle PRs are merged →
tonight's candidate is biased toward a tiny, mechanical, single-conceptual-change
fix (see Candidate), matching the bias every night since 2026-09-02 has
already applied for the same reason.

Gap nights where no cycle ran at all: 2026-09-04, 09-12 through 09-14, 09-23
through 09-26 — not investigated further tonight (out of scope; flagged for
the routine owner, same as 2026-09-05's report flagged 09-04).

## Deep Dive (performance, rotated from architecture)

2026-09-08's report (#18/PR#19) found three structurally identical sequential
2-tier scans in `src/control-plane/store/agentdb-adapter.ts` — each scans the
`working` tier, awaits, then scans `episodic`, awaits, merging into one
accumulator:

- `listIssuesForGoal` (line 739 on tonight's `main`)
- `listApprovalTransitionsForCompany` (line 811)
- `listHeartbeatsForCompany` (line 1234)

PR#19 fixed exactly this with `Promise.all`, 3+ weeks ago. It is still
unmerged, and because it's unmerged, **tonight's fresh `main` checkout still
has the bug** — confirmed directly by reading the current file rather than
trusting the ledger: all three loops are still sequential `for (const tier of
['working','episodic']) { await ... }` on commit `6e73a8f`. Grepped the rest
of `src/control-plane` for the same `for (const ... of ...) { ... await ...
}` shape to confirm no other unaddressed instance exists: the only other
matches are `recallByKey`'s page-size-escalation retry (line 246 — correctly
sequential by design, since widening only happens *after* a short page proves
there's nothing more to find; parallelizing would issue a wasted second round
trip on every exact-key read) and `recallApprovalTransition`'s `??`
short-circuit fallback (line 782 — already flagged and deliberately left
alone by PR#33's own next-steps, for the same reason: it already short-circuits
to one round trip in the common case, and blind parallelization would make it
always two).

**Tonight's candidate is a fresh, from-scratch implementation of PR#19's
same already-ACCEPT-verdict finding, branched off today's `main` HEAD**, not
a copy of that branch — explicitly disclosed, not presented as a novel
discovery. Given the backlog (above), re-proposing a 20th *new* micro-finding
competing for review attention against the other candidate fix for this exact
bug seemed less valuable than delivering one mergeable, currently-green,
freshly-evidenced version of the one that's already been validated and is
waiting. If both #19 and tonight's PR are ever looked at together, either one
closes the other's issue; they are not meant to both land.

## Hypothesis (frozen before implementation)

> Given `listIssuesForGoal`, `listApprovalTransitionsForCompany`, and
> `listHeartbeatsForCompany` (`src/control-plane/store/agentdb-adapter.ts`),
> each of which scans the `working` then `episodic` hierarchical-store tier
> sequentially via two `await`ed `agentdb_hierarchical-recall` calls, when
> both tier calls are issued concurrently via `Promise.all` instead, then
> each function's wall-clock latency should approach
> `max(tier_working_ms, tier_episodic_ms)` instead of
> `tier_working_ms + tier_episodic_ms`, subject to: the full existing test
> suite passing identically before and after, `tsc --strict` staying clean,
> merged-result correctness unchanged regardless of tier-array order, and
> zero call-site signature changes.

Frozen before implementation; not modified after evaluation began.

## Candidate

`src/control-plane/store/agentdb-adapter.ts`: all three functions changed
from a `for (const tier of ['working','episodic'] as const) { await
callTool(...); <process results> }` loop to `const tierResults = await
Promise.all((['working','episodic'] as const).map((tier) =>
callTool(...)))` followed by the identical unmodified per-result processing
code, now iterating `tierResults` instead of re-fetching per tier. Zero
change to query shape, `topK`, filtering logic, or malformed-entry handling —
only the fetch itself is parallelized. Verified order-independence at every
call site before applying (not assumed): `listIssuesForGoal`'s result feeds
`buildDashboardSnapshot`'s `Promise.all(rawIssues.map(...))` (order-agnostic);
`listHeartbeatsForCompany`'s result is consumed the same way; and
`listApprovalTransitionsForCompany`'s result is explicitly re-sorted by
`createdAt` inside `recomputeInteractionSignals` regardless of fetch order
(`employee-augmentation/interaction-profile.ts:262`) — the exact same
precondition 2026-09-08's and 2026-09-03's reports already verified for
their own fixes.

`tests/control-plane/dashboard-snapshot.test.ts`: 3 new discriminating tests
(one per function), same mock-bridge-based in-flight-counter style as the
merged `checkOperatingBudget` concurrency test
(`tests/control-plane/heartbeats-and-comms.test.ts`): a mocked
`agentdb_hierarchical-recall` handler that increments/decrements an
`inFlight` counter around a 25ms delay, asserting `maxInFlight > 1` and
`elapsedMs < 2 × 25ms`. Diff size: 2 files, +145/-18 (committed report/ledger
not counted) — well under the 300-line target, one conceptual change applied
three times.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), Node v22.22.0.

| | Tests | Pass | Fail | tsc --strict | New-test timing |
|---|---|---|---|---|---|
| Baseline (`6e73a8f`, new tests applied, source fix stashed) | 330 | 327 | **3** (exactly the 3 new tests) | clean | ~51-54ms each |
| Candidate (this branch) | 330 | 330 | 0 | clean | ~25-27ms each |

The 3 new tests are discriminating, not tautological: each fails against
unmodified baseline source with `observed max 1` (sequential) and a ~2×
round-trip elapsed time, and passes against the candidate with `maxInFlight
> 1` and elapsed time under one round trip's worth of margin. `npm run
harness:bench-verify`: `Suite repo-native@0.1.0: 6 tasks, hash OK
(840fd8d2d698…)` — unchanged from every prior performance night's report,
corpus not gone soft.

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip),
evaluated on the real `npm test` entrypoint with the new tests applied and
the source fix temporarily reverted (`git checkout -- src/control-plane/store/agentdb-adapter.ts`),
to prove the new tests' discriminating power before claiming the fix did
anything — not inferred from logs.

## Darwin Results

Not run. Fixed-width (exactly 2) concurrent fan-out with zero tunable
parameter — same "no fitness landscape to search" reasoning as every prior
mechanical extraction/parallelization night (2026-09-02, 09-07, 09-08, 09-17,
09-18) and PR#19 itself for this identical fix shape.

## Evidence

- OBSERVATION: 3 structurally identical sequential 2-tier scans, confirmed
  still present on current `main` by reading the file directly (not trusting
  PR#19's 3-week-old claim).
- OBSERVATION: no other unaddressed sequential-await-in-loop instance exists
  in `src/control-plane` (full grep, both remaining matches already
  correctly sequential by design and already flagged as such by prior nights).
- MEASUREMENT: baseline 327/330 (3 predicted failures, ~51-54ms each);
  candidate 330/330 (~25-27ms each); `harness:bench-verify` hash unchanged.
- INFERENCE: the win is structural, not a mock artifact — every real call
  site already treats each function's result as order-independent (verified,
  not assumed, at all three call sites).
- DECISION: ACCEPT.

## Reward-Hack Check

No existing test assertion weakened — the only test-file change is 3 added
tests plus 1 added import; every pre-existing test in the file is untouched.
No gold answer, threshold, or benchmark corpus modified (`bench-verify` hash
identical before/after). No new mock/cache introduced beyond the new tests'
own local counters. No cherry-picked metric — full, unfiltered 330-test suite
run both ways. Fan-out width is a compile-time constant (2), never
data-proportional, so the general "unbounded `Promise.all` is dangerous at
scale" caution (already raised and ruled inapplicable by 2026-09-08's report
for this exact fix shape) is re-checked and still inapplicable here.
Independent critic pass (this session, adversarial, separate from
implementation): no unresolved signal. One thing disclosed rather than
hidden: this candidate duplicates unmerged PR#19's finding by design (see
Deep Dive) — flagged explicitly rather than presented as novel.

## Security Review

Pure read-only control-flow change (sequential → concurrent fetch) on three
already-existing, already-read-only query functions. No authorization guard,
credential path, `assertSafeId` call site, filesystem/network scope, or MCP
tool surface touched. No new dependency. Re-verified (not re-assumed) the
2026-09-03 finding this relies on still holds unchanged: `bridge-client.ts`'s
`callTool` still caches the MCP `initialize` handshake's in-flight promise,
so the two concurrent first calls per function don't double-initialize.
Fan-out width fixed at 2, not attacker-influenced. Least-privilege posture
unchanged.

## Scan Findings — memory

No new unbounded growth introduced — `Promise.all` over a fixed 2-element
array holds at most 2 pending results simultaneously, same peak memory
shape as the sequential version, just not serialized in time. The
already-documented, already-accepted `topK: 500`/`200`/`100` per-tier caps on
these same three functions (EMPLOYEE-INTERACTION-PROFILE.md §6 open item 3)
are unchanged by tonight's fix — explicitly not re-litigated here (see Deep
Dive: that trade-off was already considered and accepted in the source
comment itself, and no new evidence tonight justifies reopening it).

## Scan Findings — latency

The finding itself (see Deep Dive). Confirmed via fresh grep that these were
the last 3 instances of this specific pattern in `src/control-plane` and
that both apparent remaining candidates (`recallByKey`'s retry widen,
`recallApprovalTransition`'s short-circuit fallback) are correctly sequential
by design, not latent bugs — this performance surface's "sequential-await-in-loop"
search direction is now exhausted for this codebase at its current size.

## Competitors

| Competitor | Relevance | Grade |
|---|---|---|
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | Server-side services issue independent reads via `Promise.all`-equivalent batched queries rather than sequential per-source round trips (Grade B, directory-structure inference, same as 2026-09-02's architecture-night citation of this repo) | B |
| LangSmith / LangGraph Platform | Managed, DB-backed query layer — this specific "two sequential round trips over the same logical index" shape doesn't arise the same way in a platform-managed store (Grade B) | B |
| Node.js/ECMAScript concurrent-I/O semantics | Reproducible directly against this repo's own evaluator — see Evaluation Receipt | A |
| ruvnet/ruClip PR#19 (2026-09-08) | Same repo, same finding, same fix shape, unmerged for 3+ weeks — the single most relevant "competitor" tonight, cited throughout | A |

## Gist

No `gh gist create`/MCP gist tool available this session (`gh auth status`
reports an invalid `GH_TOKEN`; GitHub MCP tool access for issues/PRs works
independently and was used instead — see Ledger Check). Full report
committed here at `docs/dream-cycle/2026-10-02-performance-report.md` on
branch `dream/2026-10-02-performance`. `GIST=LOCAL`.

## Witness

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of this file's content up to, not including, this `## Witness` heading): `99f2193c03559b77da8dbd50e36b0efb6089517867566e0ef39a83edaa6f998b`
- Witness stamp: `5ccd0fe8c5f3ebf4a433d161e1ed966d075ec69539049f89ade4330c2b7e872f`
- Verifier procedure:
  1. `git show <this commit>:docs/dream-cycle/2026-10-02-performance-report.md | sed -n '1,/^## Witness$/p' | sed '$d' > /tmp/verify-report.md`
  2. `sha256sum /tmp/verify-report.md` → must equal the Report sha256 above.
  3. `git rev-parse 6e73a8f060bcbb69965a50ffe4627e33622d4094` → confirms the parent commit this report was computed against.
  4. `printf '%s%s' "<Report sha256>" "6e73a8f060bcbb69965a50ffe4627e33622d4094" | sha256sum` → must equal the Witness stamp above.
  5. `npm test` on this branch → 330/330; on the parent commit with only the test file changes applied → 327/330 (3 predicted failures).

## Recommendation

`evaluated: accepted`. Human review requested on the draft PR — this session
never self-merges or self-promotes. Next steps:

1. **Close the backlog, don't grow it further.** 19 of 22 dream-cycle PRs
   are open, unreviewed, every one ACCEPT. Recommend a dedicated
   human-review pass (or landing the already-built `reconcile-ledger.ts`
   from PR#35 and the branch-audit tool from PR#47) before another 19 nights
   pass. This is now the single highest-leverage action available on this
   repository — not a new finding, a repeated one, now quantified.
2. If tonight's PR and #19 are ever reviewed together, merge at most one —
   they fix the same bug the same way; the other should be closed as a
   duplicate rather than merged redundantly.
3. The "sequential-await-in-loop" search direction in
   `src/control-plane/store/agentdb-adapter.ts` is now exhausted (see Scan
   Findings — latency). A future performance night on this repo should look
   elsewhere — e.g. payload-trimming for `listApprovalTransitionsForCompany`
   (flagged by 2026-09-08's report, still open) or the dashboard snapshot's
   end-to-end latency under realistic company size, not another micro-loop grep.
