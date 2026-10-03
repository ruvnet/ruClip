# Dream Cycle 2026-10-03 — Performance SOTA Report

## Rotation

`DAYINT=20261003`, `SLOT=3` (`DAYINT % 5`) → `DEEP=performance`,
`SCAN=memory,latency`. `DAYINT % 25 = 3` — no bonus roadmap-review. Session
commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094` — `main`'s tip,
unchanged since 2026-09-06.

## Ledger Check

`docs/dream-cycle/LEDGER.md` on `main` has 4 rows (frozen since 2026-09-06),
but the real cross-night memory lives in GitHub issues/PRs (repo-global,
unlike the per-branch ledger file). Re-checked every dream-cycle PR via the
GitHub MCP tools (no `gh` CLI in this session; API tools unaffected,
`FALLBACK` does not apply to issue/PR access, only to gist creation — see
Gist section):

- **Merged** (3): #11 (2026-09-03 performance), #13 (2026-09-05
  correctness), #15 (2026-09-06 security) — all present on `main`.
- **Open, unmerged** (19, #17 through #53, every performance/correctness/
  security/architecture/developer-experience night since 2026-09-07):
  all draft, all `mergeable_state: clean` except #39 (`unstable`). **Zero of
  the last 19 dream-cycle PRs are merged.** Every one carries an ACCEPT
  verdict with a clean evaluation receipt — this is a review-throughput
  problem, not a quality problem. See Recommendation for the escalation.

**Do-not-rediscover check** (read current `main` source directly, and the
body of every open performance-labeled issue, before picking tonight's
candidate): confirmed still-open, unmerged, and NOT to be reproduced again:
`checkOperatingBudget` N+1 fan-out (#10/PR#11 — **merged**, so this one truly
is fixed on `main`); the 3 sequential tier-scan listers (#18/PR#19,
re-attempted fresh off `main` by #52/PR#53 since #19 never merged);
`fireHeartbeat`'s sequential `recallCompany`/`recallIssue`/`recallGoal`
(#40/PR#41); `persistHeartbeatSchedule`'s sequential previous-state/target
recalls (#42/PR#43); `buildDashboardSnapshot`'s unbounded goal/issue fan-out
(#44/PR#45); `applyApprovalTransition`'s blocking await on a discarded
`recomputeInteractionSignals` result (#32/PR#33). Tonight's candidate
(below) is none of these — a genuinely new finding on a different write
path, surfaced by fresh exploration of `agentdb-adapter.ts`'s causal-edge
call sites rather than its already-mined sequential-await/fan-out patterns.

**Learning signal applied**: 0 of the last 19 merged is a strong, long-running
signal toward a tiny, easily-reviewable candidate (Step 1.1). Tonight's fix
is 2 files, +23/-1 production, one conditional added around one existing
call — about as small as a real finding gets.

## TL;DR

`persistHeartbeatSchedule` (`src/control-plane/store/agentdb-adapter.ts`) is
called by `fireHeartbeat` on **every single heartbeat fire** — success path
and every `pauseAndPersist` path — and unconditionally wrote a `belongs_to`
causal edge via `recordCausalEdge`/`agentdb_causal-edge` every time, even
though a `HeartbeatSchedule.target` is never reassigned once the schedule
exists (confirmed: no call site anywhere in this codebase writes a new
`target` onto an existing schedule). Every re-persist after the first
therefore repeated a byte-identical edge write. Read against the real,
installed `agentdb_causal-edge` tool source, this is not a cheap no-op: it
does a fire-and-forget SQL `graph_edges` write, a dynamic
`import('../ruvector/graph-backend.js')` + availability probe, and — on the
bridge fallback path — a second write "for compatibility". Fixed by skipping
the write when this is a re-persist of an unchanged target; a genesis create,
or a genuinely different target, still always writes it.

## What's new

Every prior Dream Machine performance finding in this repo (2026-09-03,
09-08/10-02, 09-18, 09-22, 09-27, 09-28) addressed *sequential-await* or
*unbounded-fan-out* hazards — parallelizing work that still needed to happen.
Tonight's finding is a different remedy shape: **eliminate the work
entirely**, because it was redundant, not merely serial. This is the first
dream-cycle performance finding of that shape in this repo.

## Competitors

| Source | Claim | Grade |
|---|---|---|
| arXiv 2412.04698, "One-Hop Sub-Query Result Caches for Graph Database Systems" | Caching/skipping previously-resolved one-hop graph results avoids redundant round trips in exactly this class of system | A (peer-reviewed/arXiv) |
| Adobe GraphTalk SF 2026, "The Cheapest Computation Is the One You Never Perform — Lessons from Scaling Enterprise Graph Systems" | Vendor conference talk, directly on-point title/thesis for this finding's remedy shape | B (vendor, not independently reproduced) |
| `Blockcast/paperclip` PR #913 (fork of the named competitor `paperclipai/paperclip`) | Paperclip's own heartbeat-adjacent recovery path added deduplication to skip duplicate process_lost/wakeup/retry/run-event side effects | C (fork, not the primary repo — informs but doesn't alone justify) |
| This repo's own 2026-09-22 (#40/PR#41) and 2026-09-27 (#42/PR#43) | Same hot loop (`fireHeartbeat`/`persistHeartbeatSchedule`), same evidence methodology (real tool source read, `git stash` baseline-vs-candidate proof); those fixed the *read* half's sequential-await latency — tonight fixes the *write* half's redundant-RPC latency. Complementary, non-overlapping. | A (internal, reproducible) |

## Hypothesis (frozen before implementation)

> Given `fireHeartbeat`'s unconditional re-persist of its `HeartbeatSchedule`
> on every fire (success and every pause path), where `persistHeartbeatSchedule`
> unconditionally calls `recordCausalEdge` to (re)write a `belongs_to` edge
> from the heartbeat to its target, when the edge write is skipped for a
> re-persist (`stored !== null`) whose target is unchanged from what's already
> stored, then `persistHeartbeatSchedule`'s own latency on that hot path
> should drop by approximately one `agentdb_causal-edge` round trip per call,
> subject to: a genesis create (`stored === null`) always still writing the
> edge, a schedule whose target genuinely differs from what's stored always
> still writing the edge, the full existing test suite passing identically,
> `tsc --strict` staying clean, and zero call-site signature changes.

Not modified after evaluation began.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), Node v22.

| | Tests | Pass | Fail | tsc --strict |
|---|---|---|---|---|
| Baseline (`6e73a8f`, source unmodified, new tests + corrected mocks applied) | 329 | 328 | 1 | clean |
| Candidate (this branch) | 329 | 329 | 0 | clean |

The one predicted baseline failure is the new discriminating test itself
(`persistHeartbeatSchedule skips the redundant belongs_to causal-edge write
when re-persisting an existing schedule with an unchanged target`), which
registers **no** `agentdb_causal-edge` mock handler at all — against baseline
it throws `No mock handler registered for tool 'agentdb_causal-edge'`
(reproduced via `git stash` on the source fix alone); against the candidate
it passes cleanly. A second new test proves the defensive branch: when the
recalled target genuinely differs from the schedule being persisted, the
edge write still fires.

Four pre-existing tests needed their mocks corrected (not weakened): each had
a catch-all `if (args.tier === 'working') return <issue JSON>` that
incidentally also answered the schedule-key recall with the *issue's* JSON
(harmless before, since the edge was written unconditionally regardless of
`stored`'s shape; my fix is the first code to actually read `stored.target`,
which surfaced the mismatch as a `TypeError: Cannot read properties of
undefined (reading 'kind')`). Each was corrected to return the real schedule
JSON for the schedule-key query specifically, matching the precise-key style
already used elsewhere in the same file — no assertion was loosened.

`npm run harness:bench-verify`: hash unchanged (`840fd8d2d698…`) — corpus not
gone soft.

Isolated timing (throwaway script against the built `dist/`, mocked 20ms
`agentdb_causal-edge` round trip, 20 re-persists of a schedule with an
unchanged target):

- Baseline (source reverted via `git stash`, same mock): **20.40ms/call**
  (408ms / 20 calls) — essentially the full mocked round trip every time.
- Candidate: **0.25ms/call** (5ms / 20 calls) — ~82x on this synthetic
  measurement; in production the real saving is one full
  `agentdb_causal-edge` round trip eliminated per fire (SQL write + dynamic
  import probe + possible second bridge write, per the real tool's own
  source).

Diff: 2 files, `agentdb-adapter.ts` (+23/-1), test file (+~85/-5 incl. the 4
corrected mocks) — one conceptual change, well under the 300-line target.

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (current `main` tip
— unchanged since 2026-09-06; see Ledger Check), evaluated on the real
`npm test` entrypoint before any candidate source code was written.

## Darwin Lineage

Not run. This is a single, fully-specified, zero-tunable-parameter fix (skip
vs. don't-skip is a correctness fact derived from reading the schema and
every call site, not a parameter to search over) — same disposition as every
prior night's analogous zero-behavior-change transformation (#11, #19, #33,
#41, #43).

## Evidence

- OBSERVATION: `persistHeartbeatSchedule:1137` (pre-fix) unconditionally
  called `recordCausalEdge`; `fire-heartbeat.ts` calls
  `persistHeartbeatSchedule` on every fire with `previousStatus` always set;
  grep-confirmed no call site anywhere reassigns `schedule.target`.
- OBSERVATION: the real, installed `agentdb_causal-edge` handler
  (`node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js:430-505`)
  does real work on every call (fire-and-forget SQL write, dynamic import +
  availability probe, possible second bridge write) — not a cheap no-op.
- MEASUREMENT: baseline 328/329 (1 predicted failure) → candidate 329/329;
  `harness:bench-verify` hash unchanged; isolated timing 20.40ms → 0.25ms
  per re-persist call (mocked 20ms round trip).
- INFERENCE: the skip is safe because `belongs_to` is not among
  `CYCLE_CHECKED_RELATIONS` (no cycle-prevention side effect is lost) and no
  other code path depends on the edge being rewritten on every persist for
  any audit/weight-refresh purpose (see Reward-Hack Check / critic pass).
- DECISION: ACCEPT, recommended for human review.

## Reward-Hack Check

No existing test's behavioral assertion was weakened — the 4 corrected mocks
only fix which object a given mock *query* resolves to (schedule vs. issue),
every existing `assert.*` call is untouched. No gold answer, threshold, or
`.harness/bench.json` entry touched (hash unchanged). The new discriminating
test is maximally strict by construction (no fallback handler at all for the
tool being eliminated, not a call-count assertion that could be gamed).
Independent adversarial critic pass: see Security Review / critic verdict
below.

## Security Review

Pure control-flow change: skips a write only when it is provably redundant
(identical edge already persisted), never skips on ambiguous or
unverifiable state (falls back to "always write" for create and for any
target mismatch). `belongs_to` is not a `CYCLE_CHECKED_RELATIONS` member, so
no cycle-prevention invariant depends on the repeated write. No
authorization/credential/claim-verification logic touched — the skip sits
entirely after all of `persistHeartbeatSchedule`'s existing authorization
gates. No new dependency, no new cache, no new amplification surface.
Residual consideration: if the real `agentdb_causal-edge` write path ever
had a side channel that's relied upon elsewhere (e.g. refreshing a last-seen
timestamp on the edge) independent of the edge's own existence, skipping
would now also skip that — checked: the real tool's handler
(`agentdb-tools.js:430-505`) has no such side effect beyond the edge/weight
write itself and the fire-and-forget `graph_edges` mirror, both idempotent
for an unchanged edge.

## Regression Analysis

0 regressions: candidate is 329/329 (328 prior conceptual tests + the 1
pre-existing test unaffected, +2 new), `harness:bench-verify` hash
unchanged, `tsc --strict` clean. Only `agentdb-adapter.ts` and one test file
touched.

## ADR

None — this is a bug fix eliminating redundant work on an already-decided
hot path (HEARTBEATS-AND-COMMS.md's own design), not a new architectural
decision, same call prior nights made for analogous fixes.

## Scan Findings — memory

No new allocation pattern; the skip path does strictly less work (no new
object retained, no new buffer). Net effect is fewer in-flight RPC
connections/response buffers on the hottest recurring path in this repo, not
more.

## Scan Findings — latency

This is tonight's finding itself (see Deep Dive/TL;DR/Evaluation Receipt
above). Repo-wide grep for `recordCausalEdge(` found 6 call sites
(`persistOrgMember`, `persistGoal`, `persistIssue` ×3, `persistHeartbeatSchedule`);
only `persistHeartbeatSchedule`'s sits on a path that fires on a recurring
cadence rather than a discrete create/update event, so it was ranked highest
and is the only one fixed tonight (see Recommendation for the other three as
a flagged, lower-priority follow-up).

## Gist

No `gh`/gist-creation tool available in this session (same limitation every
prior dream-cycle night has recorded — GitHub issue/PR API access via the
GitHub MCP server is unaffected). Full SOTA report committed here instead:
`docs/dream-cycle/2026-10-03-performance-report.md`. `GIST=LOCAL`.

## Witness

```
REPORT_HASH    = f34446074c0244114dde158d25bc19d4434fdb538254bfb5dc97b9af8d91841e
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = caff7ef2777cf79a112419b7c9f124abf7e3a185ff6ca1262fd411046a94f896
```

(`REPORT_HASH` = `sha256` of this file's content up to, not including, this
`## Witness` heading. `WITNESS` = `sha256(REPORT_HASH + SESSION_COMMIT)`.)

### Verifier procedure

1. `git fetch origin && git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094`
2. `npm ci && npm run build && npm test` — expect 327/327 (this file's own
   new tests are not present on this commit).
3. Apply this PR's diff; `npm run build && npm test` — expect 329/329.
4. `git stash push -- src/control-plane/store/agentdb-adapter.ts && npm run build && npm test` — expect 328/329, the one predicted failure named above; `git stash pop`.
5. `sha256sum docs/dream-cycle/2026-10-03-performance-report.md` (content up
   to, not including, this Witness section) should equal `REPORT_HASH`
   above; `printf '%s%s' "$REPORT_HASH" "$SESSION_COMMIT" | sha256sum` should
   equal `WITNESS` above.

## Recommendation

`evaluated: accepted`. Human review requested on the draft PR — this session
never self-merges or self-promotes candidate state.

Follow-up (independent critic's non-blocking observation, not fixed tonight
to keep this PR to one conceptual change): `persistGoal`/`persistIssue`
(`agentdb-adapter.ts` ~L394, ~L689) still call `recordCausalEdge`
unconditionally on every persist, so this redundant-write elimination is now
applied inconsistently across the codebase. Neither fires on a recurring
cadence the way `fireHeartbeat` does, so lower priority — worth a future
night's look if the same real-tool cost profile applies there too.

**Also flagging, not as tonight's finding but as the single highest-leverage
open item on this repository** (re-verified tonight, see Ledger Check): of
22 dream-cycle PRs opened to date (#9 through #53), **zero have been merged
via GitHub's merge button** since #15 (2026-09-07) — 19 consecutive
ACCEPT-verdict, evidence-backed PRs (#17–#53) sit open and unreviewed, one
added per performance/correctness/security/architecture/dev-experience night
for nearly a month. `docs/dream-cycle/LEDGER.md` on `main` is correspondingly
frozen at its 2026-09-06 row. Issue #34 (2026-09-19, PR #35) and issue #46
(2026-09-29, PR #47) already diagnosed and tooled fixes for the ledger-silo
and backlog-visibility problems respectively — both are themselves still
unmerged. This is not a code-quality problem; every reviewed finding's
evidence receipt has been clean. It is a review-throughput problem that no
future dream-cycle night can fix from inside its own sandbox.
