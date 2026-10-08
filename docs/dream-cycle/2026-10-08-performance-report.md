# ruClip Performance SOTA Report — 2026-10-08

## Rotation

`DATE=2026-10-08`, `DAYINT=20261008`, `SLOT = DAYINT % 5 = 3` → `DEEP=performance`,
`SCAN=memory,latency`. `DAYINT % 25 = 8` — no bonus roadmap-review. Session commit
(parent, `main` tip): `6e73a8f060bcbb69965a50ffe4627e33622d4094` (unchanged since
2026-09-06 — see Ledger Check).

No rotation needed tonight: slot 3 already maps to `performance` directly.

## Ledger Check

`docs/dream-cycle/LEDGER.md` on `main` is frozen at 4 unique rows (one
duplicate), last touched by the commit that merged PR #15 (2026-09-07).
Confirmed directly (`git log main -- docs/dream-cycle/LEDGER.md`): no commit
since. Re-checked every dream-cycle PR via the GitHub MCP tools (no `gh` CLI
in this session; `list_pull_requests`/`pull_request_read` work independently
— `FALLBACK=false` for issue/PR access):

- **Merged** (3, all before 2026-09-07): #11 (2026-09-03 performance), #13
  (2026-09-05 correctness), #15 (2026-09-06 security) — confirmed present on
  `main` by commit-message match.
- **Open, unmerged** (20 — #9, #17, #19, #21, #23, #25, #27, #29, #31, #33,
  #35, #37, #39, #41, #43, #45, #47, #49, #51, #53, #55, #57, #59, #61 — every
  dream-cycle PR opened since 2026-09-07, i.e. every night for a month):
  all draft. **Zero of the last 20 dream-cycle PRs are merged.**

## Learning signals applied (Step 1.1)

- **Merge-rate bias (strongest signal, now a month old)**: 0 of the last 20
  dream-cycle PRs merged. Per the routine's own rule, tonight's candidate is
  biased toward the smallest, most trivially-reviewable change possible —
  see Candidate below: the final shipped diff is a **13-line code comment,
  zero behavior change**.
- **Do-not-rediscover check**: read the 6 most recent performance-surface
  reports in full (`docs/dream-cycle/2026-09-{03,22,27,28}-performance-report.md`,
  `2026-10-{02,03}-performance-report.md`) and their PRs' (#41, #43, #45,
  #53, #55) actual diffs via `pull_request_read(get_files)`, not just the
  ledger summaries. Confirmed already covered and NOT to be reproduced:
  `checkOperatingBudget`'s N+1 fan-out (merged, #11); `fireHeartbeat`'s
  sequential Company/Issue/Goal reads (#41); `persistHeartbeatSchedule`'s
  sequential previous-state/target reads (#43); `buildDashboardSnapshot`'s
  unbounded goal/issue fan-out (#45); the 3 sequential tier-scan listers
  (#53, itself a redo of stalled #19); `persistHeartbeatSchedule`'s redundant
  unconditional `belongs_to` edge rewrite on unchanged-target re-persists
  (#55). #55's own Recommendation explicitly flagged `persistGoal`/
  `persistIssue`'s analogous unconditional `recordCausalEdge` calls
  (`agentdb-adapter.ts` ~L394/~L689) as an unexplored follow-up — that flag
  is where tonight's research started.

## Deep dive (performance)

`persistIssue`'s edge-writing tail (`agentdb-adapter.ts:689-706`) writes up
to 3 causal edges sequentially: `belongs_to` (issue→goal, unconditional),
`parent_of` (parentIssue→issue, iff `parentId` set, **cycle-checked**), and
`assigned_to` (issue→assignee, iff `assigneeId` set). On the surface this is
the same shape every performance-surface night since 2026-09-22 has fixed at
a different call site: N independent operations, awaited one at a time,
collapsible to `Promise.all` for a `sum→max` latency win (#41, #43, #53 all
read-side instances of exactly this transformation).

**It is not the same shape.** Unlike those three, these are *writes with a
rejection path*, and the existing test suite encodes a real invariant that
depends on their current sequential order: `recordCausalEdge`'s cycle check
for `parent_of` (`wouldCreateCycle`, a `agentdb_graph-query` read) can
reject — and when it does, `persistIssue` must never attempt the
`assigned_to` write that comes after it in source order. This is asserted
directly by an existing test (`tests/control-plane/agentdb-adapter.test.ts:211`,
*"persistIssue refuses a parent_of edge that would close a genuine
(non-self) cycle, and never writes the assigned_to edge that would have
followed"*), which checks the **exact ordered list of tool calls made**, not
just the thrown error. Grepped the surrounding design docs
(`DOMAIN-MODEL.md` §2.3, `APPROVAL-GATE.md` §3) for an explicit statement of
this fail-fast invariant — none exists; it is implicit in the sequential
code and made explicit only by this one test.

## Competitors (graded)

| Source | Claim | Grade | Relevance |
|---|---|---|---|
| This repo's own prior nights (#41, #43, #53) | `Promise.all` is the correct, already-validated fix for N independent, side-effect-free *reads* with a compile-time-constant fan-out width | A (internal, reproducible 3x) | The pattern tonight's research initially expected to re-apply — and the one it had to falsify for a *writes-with-rejection* call site |
| Transaction/compensating-action literature (multiple independent 2026 backend-engineering write-ups on partial-failure and the saga pattern, cross-checked) | Concurrent execution of dependent write steps that can each independently fail requires either idempotent compensation or a single atomic commit; naively parallelizing a sequence that currently relies on "stop on first failure" reintroduces partial-state bugs | B (vendor/blog, cross-checked across ≥4 independent sources, consistent with tonight's own reproduced regression) | Names exactly the hazard tonight's experiment reproduced concretely against this repo's own evaluator, not just in the abstract |
| `paperclipai/paperclip`, GitHub PR #1847 (`fix(heartbeat): single-flight the periodic recovery chain`) — same citation 2026-09-22's report used | Paperclip's own heartbeat/scheduler kernel needed a correctness fix, not just a latency one, when touching its recovery chain's ordering | A (primary repo, merged PR) | General precedent that this class of system (ordered writes with rejection semantics) is where competitors have hit correctness bugs, not just latency ones — the same class tonight's rejected hypothesis would have introduced here |
| This repo's own 2026-10-03 report (#54/PR#55) | Flagged `persistGoal`/`persistIssue`'s unconditional `recordCausalEdge` calls as an unexplored follow-up, explicitly not yet attempted | A (internal, primary, the direct origin of tonight's research direction) | Tonight's research target, chosen specifically because it was already identified as unexplored rather than independently rediscovered |

## Frozen hypothesis (frozen before implementation)

> Given `persistIssue`'s 3 sequential `recordCausalEdge` calls (`belongs_to`
> always; `parent_of` iff `parentId` set; `assigned_to` iff `assigneeId`
> set), when they are issued concurrently via `Promise.all` instead, then
> `persistIssue`'s edge-writing latency should approach `max()` of the
> individual write latencies instead of their `sum()`, subject to: the full
> existing test suite passing identically before and after, `tsc --strict`
> staying clean, and — critically — the existing fail-fast invariant that a
> `parent_of` cycle rejection must prevent the `assigned_to` write from ever
> being attempted.

Not modified after evaluation began. (The outcome below is exactly the
"subject to" clause failing, not a redefinition of the hypothesis after
seeing the result.)

## Evaluation receipt

Evaluator: real `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), Node v22.

| | Tests | Pass | Fail | tsc --strict |
|---|---|---|---|---|
| Baseline (`6e73a8f`, unmodified `main` tip) | 327 | 327 | 0 | clean |
| Candidate (naive `Promise.all` of the 3 edge writes, implemented and run — not inferred) | 327 | **326** | **1** | clean |

The one candidate failure is exactly the predicted one —
`persistIssue refuses a parent_of edge that would close a genuine (non-self)
cycle, and never writes the assigned_to edge that would have followed`
(`tests/control-plane/agentdb-adapter.test.ts:211`) — with this exact diff
(not inferred from logs, the real assertion failure):

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
  [
    'agentdb_hierarchical-recall',
    'agentdb_hierarchical-recall',
    'agentdb_hierarchical-store',
    'agentdb_causal-edge',   // belongs_to
    'agentdb_graph-query',   // parent_of cycle check (rejects)
+   'agentdb_causal-edge'    // assigned_to — written anyway under Promise.all
  ]
```

Root cause, confirmed by tracing JS's synchronous-dispatch-before-first-`await`
semantics through `Promise.all`'s array evaluation: all 3 `recordCausalEdge`
calls (and, for `parent_of`, its internal cycle-check call) get **registered**
in source order before any of them resolves, so the `assigned_to` write is
already in flight by the time the `parent_of` cycle check's rejection is
known. The sibling test one case up
(`tests/control-plane/agentdb-adapter.test.ts:186`, parent-only, no assignee)
still passed under the candidate — not because the hazard is absent, but
because that specific test's fixture never sets `assigneeId`, so there was
nothing for the race to expose. This is itself evidence the hazard is a
real, silent, data-dependent bug class, not an artifact of one brittle
assertion.

`npm run harness:bench-verify`: `Suite repo-native@0.1.0: 6 tasks, hash OK
(840fd8d2d698…)` — corpus unchanged on both runs, not gone soft. `npm run
lint`: no-op (scaffold stage). `npm run harness:score`: `harnessFit: 76`,
`hardConstraints: 6/6` — capability probe, unaffected by tonight's finding.

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip),
evaluated on the real `npm test` entrypoint before any candidate code was
written: 327/327.

## Darwin lineage

Not run. There is no fitness landscape to search here — the finding is a
binary correctness fact (parallelizing is unsafe), not a tunable parameter,
and Bounded Darwin may never be used to search around a reward-hack; running
it to "optimize" an unsafe transformation would be exactly that.

## Evidence

- OBSERVATION: `persistIssue`'s 3 `recordCausalEdge` calls are sequential;
  `parent_of` is the only cycle-checked one of the three
  (`CYCLE_CHECKED_RELATIONS = ['parent_of', 'reports_to']`,
  `agentdb-adapter.ts:270`); no design doc states the fail-fast ordering
  requirement explicitly, only one test does.
- HYPOTHESIS: parallelizing the 3 writes should yield a `sum→max` latency
  win with no behavior change (frozen above, before implementation).
- MEASUREMENT: baseline 327/327; candidate (naive `Promise.all`) 326/327,
  with the `assigned_to` edge demonstrably written despite a rejected
  `parent_of` cycle check — real, reproduced, not inferred.
- INFERENCE: the regression is structural (a genuine race between write
  registration order and rejection propagation), not a mock artifact — traced
  to JS's own `Promise.all` dispatch semantics, confirmed by the one sibling
  test that *didn't* fail (no `assigneeId` fixture, nothing to expose).
- REJECTION: the frozen hypothesis is REJECTED. Naive parallelization of
  `persistIssue`'s edge writes is unsafe and will not be proposed for merge.
- DECISION: ship a zero-behavior-change documentation fix instead (see
  Candidate) — a 13-line comment directly above the sequential writes,
  citing this finding and the exact test that would catch a regression, so
  a future human or dream-cycle night does not rediscover this the hard way
  (i.e., by shipping it).

## Reward-hack / adversarial critique (independent pass)

The regression was reproduced by actually implementing and running the
naive candidate against the real evaluator — not asserted from reading the
code alone. No existing test was modified, weakened, or had its assertion
loosened to make the candidate pass; the opposite happened — the existing
test caught a genuine regression and the candidate was discarded because of
it, exactly as the routine's reward-hack gate is meant to force. No gold
answer, threshold, or benchmark corpus was touched (`harness:bench-verify`
hash unchanged on every run tonight). The shipped artifact (see Candidate) is
a comment only; `git diff` against baseline for every file other than the
one comment block is empty, verified directly. Independent critic check:
confirmed the one-line "sibling test passed" result is not evidence of
safety, by reading its fixture (no `assigneeId` → the race has no second
write to expose) rather than taking the passing assertion at face value.

## Security review (Step 15)

Tonight's finding is itself a security-relevant one: the regression would
have let an issue's `assigned_to` edge land in the causal graph even when
its `parent_of` edge was refused for would-be-closing an acyclic-hierarchy
cycle — a partial, inconsistent graph mutation on a rejected operation. That
is a data-integrity defect (CWE-664-adjacent: improper control of a resource
through its lifetime — a write completes despite its governing precondition
failing), not merely a latency concern, which is why it was treated as
REJECT rather than "accept with a caveat." The shipped change is a comment
only: no control flow, authorization check, or write ordering changed on
`main`. No new dependency, no MCP permission scope change, no credential or
filesystem/network surface touched.

## Scan findings — memory

No change (comment-only diff). Repo-wide: no new unbounded accumulation
introduced or found tonight; `persistIssue`'s `stored`/`issue` objects are
each a single value, discarded on return, same as every prior night's
finding in this area.

## Scan findings — latency

This *is* tonight's finding, in the negative: `persistIssue`'s 3 sequential
edge writes are now confirmed to be correctly sequential (not a latent
latency bug), closing off a plausible-looking but unsafe search direction.
Repo-wide re-grep for `recordCausalEdge(` (6 call sites total:
`persistOrgMember`, `persistGoal`, `persistIssue` ×3, `persistHeartbeatSchedule`)
found no other multi-edge call site with >1 edge write per function besides
`persistIssue` — `persistGoal` and `persistOrgMember` each write exactly one
edge, so there is nothing to parallelize there either (consistent with
#55's own "lower priority" framing of those two, for the different reason
that they aren't hot-path/recurring — tonight adds a second, structural
reason: `persistGoal`'s one edge has nothing to race against, so it was
never actually a parallelization candidate in the first place).

## Competitors

See graded table above.

## Gist

No `gh`/gist-creation tool is available in this session (same limitation
every prior dream-cycle night has recorded — the GitHub MCP server's
issue/PR tools work independently and were used for Ledger Check, Issue, and
PR). Full report committed at
`docs/dream-cycle/2026-10-08-performance-report.md` on branch
`dream/2026-10-08-performance`. `GIST=LOCAL`.

## Witness

```
REPORT_HASH    = 661f3063498e30050a174586adc92dee80d38145048cd2bcfd8477c53a5b43cb
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 9bc0c8650317f3d7e83cfa629c0fe998b1d1539a0f7718b0b3c55a332868f3bf
```

(`REPORT_HASH` = sha256 of this file's content up to, not including, this
`## Witness` heading. `WITNESS` = `sha256(REPORT_HASH + SESSION_COMMIT)`.)

### Verifier procedure

1. `git fetch origin && git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094`
2. `npm ci && npm run build && npm test` — expect 327/327 (baseline, this
   finding's new comment is not present on this commit).
3. Apply this PR's diff (13-line comment only); `npm run build && npm test`
   — expect 327/327 still (zero behavior change).
4. To reproduce the rejected candidate's regression directly: replace the
   sequential `recordCausalEdge` calls in `persistIssue`
   (`src/control-plane/store/agentdb-adapter.ts`) with a bare
   `Promise.all([...])` over the same 3 calls (ternary-guarded for the
   optional two) and re-run `npm test` — expect 326/327, with the failure at
   `tests/control-plane/agentdb-adapter.test.ts:211` showing an extra
   `agentdb_causal-edge` call in the actual tool-call sequence.
5. `sha256sum` this report's content up to (not including) this `## Witness`
   heading — compare to `REPORT_HASH` recorded in the committed report file
   and in `docs/dream-cycle/LEDGER.md`'s row for this date.

## Recommendation

`evaluated: rejected` (the frozen hypothesis — naive parallelization of
`persistIssue`'s edge writes). This is, per the routine's own stated
invariant, a successful night: a real hazard was found, measured, and
blocked before it could reach production, and a cheap, permanent guard
(the comment) is left behind so no future attempt — human or automated —
has to rediscover it by shipping the regression first. Human review
requested on the draft PR; this session never self-merges or self-promotes.

Follow-ups for a future night:
1. **The real backlog problem, now a full month old.** Zero of the last 20
   dream-cycle PRs (#17 through #61) are merged. Every one of the last
   several nights' reports has flagged this with escalating language; issue
   #34/PR#35 (ledger-silo reconciliation) and issue #46/PR#47
   (branch-backlog CI visibility) already diagnosed and tooled fixes for
   adjacent symptoms of this, and both are themselves unmerged. This report
   repeats the escalation rather than re-solving it, since a
   `developer-experience` night (not tonight's `performance` slot) is the
   right surface for it, and because no dream-cycle session can merge its
   own backlog from inside its own sandbox — this needs the routine owner.
2. If a correct, safe concurrency win is ever wanted for `persistIssue`'s
   edge-writing tail, the right shape is not "parallelize the writes" but
   "decouple the `parent_of` cycle *check* (a read) from its *write*," so the
   check can run concurrently with the unconditional `belongs_to` write
   while still gating both `parent_of`'s and `assigned_to`'s writes behind
   its result. That is a larger, riskier refactor than tonight's
   single-conceptual-change budget allows, and is not recommended as a
   trivial follow-up — flagging the shape, not proposing the diff.
3. `persistGoal`/`persistOrgMember` (the other two sites #55 flagged) are
   now both ruled out as parallelization candidates for a structural reason
   (single edge write each, nothing to race against) rather than only a
   priority one — this closes that thread, not just defers it.
