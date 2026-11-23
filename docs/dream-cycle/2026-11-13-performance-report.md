# Performance SOTA Report — 2026

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`
**Rotation**: SLOT=3 → DEEP=performance, SCAN=memory,latency (2026-11-13, DAYINT=20261113, DAYINT%25=13, no bonus)

## TL;DR

`fireHeartbeat` (`src/control-plane/heartbeat/fire-heartbeat.ts`) recalls its
target `Issue`/`Goal` once, at Gate 1, to evaluate `budgetImpact`/
`budgetAllocation`. Every outcome of a heartbeat fire — the success path and
every pause/error path that has a valid target in hand — then calls
`persistHeartbeatSchedule` (`src/control-plane/store/agentdb-adapter.ts`),
which unconditionally re-recalls the *exact same* `Issue`/`Goal`, by the exact
same key, for its own existence/`goalId` validation. On the hot, unconditional
"fired successfully" path — which runs on every scheduler tick for every
active `HeartbeatSchedule`, forever — this is one fully redundant
`agentdb_hierarchical-recall` round trip per call, paid twice for data fetched
once. Already flagged, by name, as a deliberately-deferred follow-up in PR
#41's own Recommendation §1 (2026-09-22) and never picked up since — PR #43
(2026-09-27) fixed a *different*, adjacent redundancy (parallelizing
`persistHeartbeatSchedule`'s own `recallHeartbeatSchedule` + `recallIssue`/
`recallGoal` pair) but left this cross-function duplicate untouched. Tonight's
candidate threads the already-fetched, already-validated entity through to
`persistHeartbeatSchedule` via a new optional, narrowly-typed parameter,
eliminating the duplicate round trip wherever the caller already holds a
proven-non-null copy — while still re-running every existing validation
(existence, `goalId` match) against that object, not skipping it.

## What's new

Nothing externally novel — eliminating a provably-duplicate read of the same
key within one logical operation is textbook, not a new technique. What's new
is that this exact gap, in this exact repo, was identified by name on
2026-09-22, survived an adjacent fix on 2026-09-27 that could easily have been
mistaken for covering it, and has sat unaddressed for 7 weeks (per the GitHub
issue/PR history checked live tonight — see Ledger Check) while two other
"surface exhausted" nights (#116, #126) swept the same file family without
re-surfacing it, because it isn't a sequential-await-in-a-loop shape (the
pattern both exhaustion sweeps specifically grepped for) — it's a
redundant-recomputation shape across two functions instead.

## Competitors (graded)

| Competitor | Relevant to tonight's finding | Grade |
|---|---|---|
| paperclipai/paperclip | Public docs claim orchestration "handles the hard details correctly" for agent/task state; no implementation-level disclosure of whether a comparable "gate re-validates what its caller already fetched" pattern exists or is avoided. Source not in this session's repo scope. | C (single-source, unconfirmed at the implementation level) |
| Temporal / durable-execution workflow engines | A directly comparable, better-known instance of this same class of problem: Temporal's own docs explicitly warn against "re-fetching the same Activity result inside a different Activity" and recommend passing results through Workflow state instead of re-querying — the general pattern (thread a fetched value through, don't re-derive it) is an established durable-execution idiom, not invented tonight. | B (vendor documentation, cross-checked against independent write-ups on Temporal's own activity-result-passing guidance) |
| Node.js/TypeScript parameter-threading vs. re-fetch | Directly reproducible: passing an already-held reference through an optional function parameter costs nothing beyond the parameter itself and is strictly cheaper than a second network round trip for the same data — language/runtime-level fact, not framework-specific. Reproduced empirically tonight (see Evaluation Receipt), not only cited. | A (reproducible — verified directly against this repo's own evaluator, both directions) |
| This repo's own prior nights (PR #41, #43, #94, #102, #104, #115) | Every merged-in-spirit (still-unmerged, but ACCEPTed) performance PR to date fixes either a sequential-await-in-a-loop shape (concurrency fan-out) or a cross-call cache miss (secret re-read); none fixes a cross-function duplicate-fetch-of-an-already-held-value shape. Tonight's finding is the first of that specific shape in this repo's dream-cycle history. | A (directly verified by reading every one of those PRs' bodies/diffs tonight, not inferred) |

## Hypothesis (frozen before implementation)

> Given `fireHeartbeat`'s Gate 1 already recalling the target `Issue`/`Goal`
> (a non-null, validated object) before calling `persistHeartbeatSchedule`
> on every subsequent outcome of that same fire (pause, error-with-target,
> or success), when `persistHeartbeatSchedule` is given that already-fetched
> object through a new optional parameter instead of always re-recalling it
> by key, then the number of `agentdb_hierarchical-recall` calls for that
> exact target key, across one `fireHeartbeat` invocation, should drop from
> 2 to 1 on every path where a valid target was already in hand, subject to:
> `persistHeartbeatSchedule`'s existence/`goalId`-match validation still runs
> (against the passed-in object, not skipped), every existing caller that
> omits the new parameter keeps the prior fetch-and-validate behavior
> unchanged, the full test suite passing, and `tsc`/`harness:bench-verify`
> staying clean.

Not modified after evaluation began.

## Ledger Check (live GitHub state, since the local `LEDGER.md` is frozen at
2026-09-06 — see Standing Context)

61 open dream-cycle issues (#8–#134), dozens of open draft PRs, **0 ever
merged** (last merge: PR #15, 2026-09-07). Checked specifically for this
surface:

- **#40/PR#41** (2026-09-22): `fireHeartbeat` parallelizes `recallCompany` +
  `recallIssue`/`recallGoal`. Still open. Its own Recommendation §1 is the
  origin of tonight's finding (quoted above).
- **#42/PR#43** (2026-09-27): parallelizes `persistHeartbeatSchedule`'s
  internal `recallHeartbeatSchedule` + `recallIssue`/`recallGoal`. Still open.
  Confirmed, by reading its full diff/body tonight, that it does **not**
  touch the cross-function duplicate — orthogonal fix, compatible with
  tonight's candidate (both could land together with no conflict in intent).
- **#93/PR#94** (2026-10-23), **#101/PR#102** (2026-10-27), **#103/PR#104**
  (2026-10-28), **#114/PR#115** (2026-11-02): four more performance nights on
  adjacent files/functions (`recomputeInteractionSignals`, dashboard
  fan-out, credential-issuer secret cache, agentdb-adapter tier scans) — none
  overlaps tonight's call sites.
- **#116** (2026-11-03) and **#126** (2026-11-08): both declared the
  memory/latency surface "exhausted" after grepping for sequential-await-in-
  a-loop shapes specifically — neither re-swept for cross-function duplicate
  reads, which is a structurally different pattern their own grep shape
  would not have caught.
- All of #41/#43/#94/#102/#104/#115/#126's PRs, checked live tonight via
  `pull_request_read`: still **open, draft, `mergeable_state: clean`**.

**Learning signals applied**: zero-merged-PRs bias → this candidate is
deliberately scoped to 2 production files, ~48 changed production lines, one
new exported type, one conceptual change (thread a value instead of
re-fetching it) — no new runtime dependency, no new subsystem. Did **not**
re-run a 3rd "surface exhausted" sweep (which would itself be the kind of
repeated-null-result the routine's own rotation rule exists to avoid) —
instead went one level deeper into files the last two sweeps already touched,
for a pattern shape they didn't check.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), real project test runner, no mocked evaluator.

| | Tests | Pass | Fail | tsc | bench-verify hash |
|---|---|---|---|---|---|
| Baseline (`6e73a8f060bcbb69965a50ffe4627e33622d4094`, unmodified) | 330 | 327 | 3 | clean | `840fd8d2d698…` unchanged |
| Candidate (this branch) | 330 | 330 | 0 | clean | `840fd8d2d698…` unchanged |

3 new discriminating tests in `tests/control-plane/heartbeats-and-comms.test.ts`
(`fireHeartbeat (issue target, success path) recalls the target issue exactly
once...`, the goal-target equivalent, and the Gate-2-HARD_STOP-pause-path
equivalent) count real `agentdb_hierarchical-recall` calls for the target's
exact key through the mock bridge across one full `fireHeartbeat` call:

- **Run against parent commit** (production diff stashed, test file applied):
  **all 3 FAIL** — `expected exactly 1 recall of <key>, observed 2`. Proves
  the parent genuinely double-fetches and that the new tests have
  discriminating power, not just passing by construction.
- **Run against candidate**: **all 3 PASS** — exactly 1 recall each.

Synthetic timing (ad hoc script, not committed — 30ms mocked round trip per
`agentdb_hierarchical-recall`/`-store`/`-edge` call via a direct
`fetchImpl`/`baseUrl` mock, `fireHeartbeat`'s full success path, N=20 calls
against the same already-existing schedule):

| | ms/call (3 runs) | 
|---|---|
| Baseline | 213.9 |
| Candidate | 182.9 / 183.1 / 183.4 |

~30ms/call absolute reduction, matching the single eliminated round trip
exactly (not a multiplicative concurrency win like PR #41/#43/#102/#115 —
this is a flat, per-call, every-single-tick saving, which compounds because
`fireHeartbeat` runs continuously for every active schedule rather than once).

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip,
unmodified), evaluated on the real `npm test` entrypoint before any candidate
code was written, and re-evaluated specifically against the 3 new regression
tests (above) to prove their discriminating power.

## Darwin Lineage

Not run — single, fully-specified, minimal-surface change (thread an
already-held reference through one new optional parameter at 2 call sites);
no tunable parameter or alternative design space to search, same disposition
and reasoning as PR #41/#43/#94 for comparably-shaped mechanical fixes.

## Evidence

- OBSERVATION: `fireHeartbeat`'s Gate 1 recalls the target `Issue`/`Goal`
  (grep- and read-confirmed, `fire-heartbeat.ts` pre-change); every call to
  `persistHeartbeatSchedule` that follows re-recalls the identical entity by
  the identical key (`agentdb-adapter.ts` lines ~1100–1126 pre-change).
- OBSERVATION: this exact gap was named, not discovered tonight — PR #41's
  own Recommendation §1 (2026-09-22) — and confirmed, by reading PR #43's
  full diff, to remain unaddressed by the one PR whose title could plausibly
  have covered it.
- MEASUREMENT: baseline's 3 new discriminating tests — 2 recalls observed
  where 1 is expected, on all 3 paths checked (issue success, goal success,
  Gate-2-pause). Full suite 330 (327 pass / 3 fail — the 3 new tests only, 0
  other regressions).
- MEASUREMENT: candidate — 330/330, 1 recall observed on all 3 paths. `tsc`
  clean. `harness:bench-verify` hash unchanged (`840fd8d2d698…`).
- MEASUREMENT: synthetic timing, 213.9ms/call → 182.9–183.4ms/call (3 runs),
  ~30ms/call reduction at a 30ms simulated round trip — exact match to "one
  fewer round trip," not an approximation.
- INFERENCE: the win is structural, not a mocked-away cost — the eliminated
  call is literally the same RPC (tool, key, tier) Gate 1 already made
  moments earlier in the same call stack; the entity's existence/`goalId`
  validation still runs, against the passed-in object, so no safety check is
  skipped, only the network round trip that re-derived the same answer.
- DECISION: ACCEPT, recommended for human review.
- REJECTION (none this cycle — no candidate direction was tried and
  discarded tonight; the single candidate above is the one selected from 5
  scored proposals, see Candidate Selection).

## Candidate Selection (5 scored, 1 selected)

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod. value | Reviewability | Total |
|---|---|---|---|---|---|---|---|---|
| 1 | **persistHeartbeatSchedule's redundant re-fetch of fireHeartbeat's already-held issue/goal** (selected) | 5 | 4 | 5 | 5 | 4 | 5 | 28 |
| 2 | 3rd "memory/latency surface exhausted" confirmation sweep (same grep shape as #116/#126) | 2 | 1 | 5 | 3 | 1 | 5 | 17 — rejected: would be the 3rd identical null result on the exact grep shape the routine's own rotation rule flags |
| 3 | Investigate *why* dream-cycle PRs don't merge (merge-conflict/backlog tooling) | 3 | 2 | 4 | 4 | 3 | 3 | 19 — rejected: #91 (population stats) and #134 (chronological merge-tree simulator, *last night*) already did this thoroughly; a 3rd pass under a performance label would itself be a duplicate finding |
| 4 | Algorithmic-complexity audit (O(n²)/repeated-sort patterns) across `src/control-plane` beyond `interaction-profile.ts` (already PR #94) | 3 | 3 | 3 | 3 | 2 | 3 | 17 — rejected: broad grep (`.sort(`, `.includes(` in loops) across the whole tree tonight found no second instance of the already-fixed-in-#94 shape; would need a profiler/live workload this session doesn't have, to go further |
| 5 | `persistHeartbeatSchedule`'s unconditional `recordCausalEdge` write even when the `belongs_to` edge is unchanged (adjacent to PR #55's `belongs_to`-edge-skip finding) | 3 | 2 | 3 | 3 | 2 | 3 | 16 — rejected: PR #55 (2026-10-03, open) already covers this exact write-skip optimization; would be a direct duplicate |

Candidate 1 selected — highest score, and the only one not already covered by
an existing open PR or a prior night's sweep of the identical pattern shape.

## Reward-Hack Check (independent critic pass — this session, separate from
implementation)

- `.harness/bench.json` untouched; `harness:bench-verify` hash unchanged
  before and after (`840fd8d2d698…`).
- No existing test's assertions weakened, deleted, or had an expected value
  changed — only 3 new tests added, each independently proven to fail against
  the real, unmodified baseline (observed 2 recalls, not a value tuned to
  pass trivially).
- Exhaustive, not cherry-picked: `grep -n "persistHeartbeatSchedule("` across
  the whole repo confirms exactly 2 production call sites, both in
  `fire-heartbeat.ts`, both updated; test-file call sites deliberately left
  as-is (they omit the new parameter, exercising the unchanged default
  behavior, which is the correct thing for them to do).
- No threshold, timeout, or retry adjusted to manufacture a pass.
- `prefetchedTarget` is a plain function-call argument scoped to one
  `fireHeartbeat` invocation — not a cache (nothing persists across calls or
  outlives the call stack), not a new subsystem, not an undocumented
  memoization.
- **One genuine tradeoff, documented, not hidden**: when `prefetchedTarget`
  is supplied, `persistHeartbeatSchedule` validates the target's existence/
  `goalId` against the object the caller already holds, rather than against
  a fresh read taken at write time. This narrows (does not introduce) an
  existing staleness window — the current code structure already tolerates
  at least one intervening `await` (`checkOperatingBudget`) between Gate 1's
  original fetch and the persist call on the hot success/Gate-2 paths, so
  "freshness at write time" was already not guaranteed by the old code's
  shape, only by an extra round trip that happened to re-ask the same
  question. Flagged here exactly as PR #43 flagged its own rejection-path
  wasted-round-trip edge case — a real, bounded cost stated plainly, not
  engineered around.
- Independent adversarial pass (this session, separate from implementation):
  confirmed both `!issue`/`!goal`-null branches in `fireHeartbeat` correctly
  leave `prefetchedTarget` as `undefined` (nothing valid to pass), so
  `persistHeartbeatSchedule`'s existing (unrelated, pre-existing,
  out-of-scope-tonight) behavior on those branches is unchanged byte-for-byte
  — verified by reading, not assumed. No unresolved signal.

## Security Review

- No new authorization surface: the `verifyActorHoldsClaim`/`resolveVerifiedActor`
  branch (gated on `authorization` being supplied) is untouched —
  `fire-heartbeat.ts` never supplies `authorization` on either call site
  (system-initiated cadence upkeep, HEARTBEATS-AND-COMMS.md §6), so
  `prefetchedTarget` only ever bypasses the redundant *existence* re-check on
  the no-actor path, never the actor-authorization path.
- No credential, filesystem, or network-scope change. No new dependency.
- No new cache (see Reward-Hack Check) — nothing outlives the single
  `fireHeartbeat` call, so there is no cross-request staleness, only the
  narrow, documented, already-largely-pre-existing intra-call window above.
- `PrefetchedHeartbeatTarget`'s discriminated-union typing
  (`{kind:'issue', issue}` / `{kind:'goal', goal}`) makes a mismatched
  (wrong-kind entity) pairing a compile-time error, not a runtime
  possibility — verified: `tsc --strict` (via `npm run build`) is clean, and
  both call sites in `fire-heartbeat.ts` construct the object from the same
  branch's own `schedule.target.kind` check, so they cannot mismatch.

## Regression Analysis

0 regressions: 327→330 (3 new, additive, independently-verified-discriminating
tests only). `tsc --strict` clean on both baseline and candidate.
`harness:bench-verify` hash unchanged. 2 production files touched
(`agentdb-adapter.ts`: +1 exported type, 2 call sites threaded through
`prefetchedTarget` instead of always recalling; `fire-heartbeat.ts`: capture
+ thread the already-held entity). No other call site of `recallIssue`,
`recallGoal`, or `persistHeartbeatSchedule` touched; every existing test
calling `persistHeartbeatSchedule` directly omits the new parameter and
keeps the prior fetch-and-validate behavior, unchanged, verified by the full
330-test run passing.

## Scan Findings

**memory**: No new allocation pattern, no unbounded growth — `prefetchedTarget`
is a single small object reference passed through an existing call, released
with the rest of the call stack when `fireHeartbeat` returns; strictly less
total allocation than before (one fewer parsed JSON-RPC response object per
call on the paths this touches).

**latency**: The finding itself — see TL;DR/Evaluation Receipt above. Swept
the rest of `src/control-plane` and `services/` for the same cross-function
"caller already has it, callee re-fetches it" shape (not the
sequential-await-in-a-loop shape #116/#126 already ruled out): no second
instance found tonight — `checkOperatingBudget`, the 3 tier-scan call sites
(PR #115), `buildGoalSnapshot` (PR #102), and `credential-issuer.ts` (PR #104)
are each already covered by an existing open PR for their own distinct
latency shape; `recomputeInteractionSignals` (PR #94) is a redundant-
recomputation shape but entirely within one function, not a cross-function
duplicate fetch.

## Competitors

See "Competitors (graded)" table above.

## Gist

`gh`'s `GH_TOKEN` is invalid in this session (`gh auth status` fails) — the
GitHub MCP tools (issues/PRs) work fine, so this is not a `FALLBACK`
condition, only no public-gist capability. Full report committed instead at
`docs/dream-cycle/2026-11-13-performance-report.md`. `GIST=LOCAL`.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
the line `## Witness` above — delete this section and everything after it,
then hash what remains (avoids the self-referential-hash problem).

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `bd3746633f99ecb836f166f86ffd956beb3236aa70bc5826b20bf5ea1921b275`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `915414e518e5e05695ab7eefc6ba45d0526ff3f65f85257a7925bedf4a3e57b6`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm this
   is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-11-13-performance-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it matches the Witness stamp recorded here/in the issue/PR.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- . && npm ci && npm test` —
   confirm 327/330 pass against the unmodified baseline once the 3 new tests
   are applied (see this branch's test file).
5. `git checkout dream/2026-11-13-performance -- . && npm test` — confirm
   330/330 pass.

## Next steps (3)

1. **Land PR #41/#43 alongside this one.** All three touch
   `fire-heartbeat.ts`/`persistHeartbeatSchedule` in compatible, non-
   conflicting ways (concurrency fan-out ×2, plus tonight's duplicate-fetch
   elimination) — reviewing them together would resolve 3 of the ~60-PR
   backlog's items on the exact same hot path at once, rather than serially.
2. **Instrument `fireHeartbeat`'s real round-trip count against a live
   bridge.** Tonight's 30ms/round-trip figure is a synthetic mock, same
   caveat every prior synthetic-timing night in this ledger has carried — a
   real p50/p99 against `ruflo mcp start -t http` (or the deployed Cloud Run
   instance, ADR-0001) would settle whether 1 round trip in ~6–7 per fire is
   as material in production as the mock makes it look.
3. **Revisit the `!issue`/`!goal`-null branch's own latent behavior**
   (independently observed tonight, out of scope for a performance night):
   when `fireHeartbeat`'s Gate 1 finds the target genuinely missing, it calls
   `pauseAndPersist`, which calls `persistHeartbeatSchedule`, which
   re-recalls the (still-missing) target and **throws**
   `ApprovalGateViolationError` rather than completing the intended
   graceful pause — a correctness gap, not a performance one, flagged here
   for a future correctness-slot night rather than fixed tonight (one
   conceptual change per night, per routine).
