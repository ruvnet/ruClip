# Performance SOTA Report — 2026-11-23

**Repo**: `ruvnet/ruClip` @ `ab588b32db00b536436139b1d8e5094cd7a6eb70` (`main` tip)
**Rotation**: SLOT=3 → DEEP=performance, SCAN=memory,latency (DAYINT=20261123, DAYINT%25=23, no bonus)

## TL;DR

Five independently-authored, still-open dream-cycle performance/latency PRs
(#41 2026-09-22, #94 2026-10-23, #115 2026-11-02, #137 2026-11-13, #146
2026-11-18) already cover essentially every clean, reward-hack-free
sequential-independent-read and cold-cache-stampede finding reachable in
this codebase's hot paths. Two prior nights at this exact rotation (#117
2026-11-03, #127 2026-11-08) already confirmed the "sequential-await-in-a-loop"
vein exhausted; tonight's own fresh sweep (`build-snapshot.ts`,
`propose-budget-mutation.ts`, `autogenous-client.ts`,
`interaction-profile.ts`, `bridge-client.ts`, `claims-authorization.ts`)
found nothing new — every remaining sequential-await pair is either already
covered by an open PR, or a genuine latency-vs-wasted-work tradeoff already
correctly left as a human decision (`observeBudgetMutation`'s
`recallAutogenousMutationRecord`-then-`checkOperatingBudget` pair; the
`recallIssue` working→episodic short-circuit flagged by #117).

Rather than file a 3rd "surface exhausted" report with no new evidence,
tonight tested a different, concrete, falsifiable question: **can the 5
existing open performance PRs be combined into one reviewable unit without
conflict?** They can. All 5 branches merge cleanly onto current `main`
(`ab588b3`) with zero functional conflicts — only `docs/dream-cycle/LEDGER.md`
(an append-only file every dream-cycle PR appends one row to) needed trivial,
mechanical conflict resolution (keep all rows, chronological order). The
combined tree builds clean, passes **372/372** tests (362 existing + 10
additive, the exact sum of each PR's own new tests), and
`harness:bench-verify`'s corpus hash is unchanged (`840fd8d2d698…`) from
every one of the 5 individual PRs' own receipts.

This PR is that consolidation: the same 5 already-individually-reviewed
diffs, as one branch, so a human reviewer faces 1 diff instead of 5 — while
also, as a side effect, backfilling `main`'s `LEDGER.md` and
`docs/dream-cycle/` report history for 2026-09-22 through 2026-11-18, which
has sat un-landed on unmerged branches this entire time.

## What's new

Nothing novel at the technique level (these are 5 already-reported,
already-ACCEPTed findings — see their own PRs for the "what's new"/competitor
analysis on each). What is new tonight: this is the first dream-cycle run to
empirically test, rather than merely assert, that the performance-surface
backlog is **mutually mergeable** — i.e. that the 0% merge rate is not being
caused (even partially) by these 5 candidates conflicting with each other or
piling up incompatible changes to the same functions. `fire-heartbeat.ts` is
touched by both #41 and #137; `agentdb-adapter.ts` is touched by #115, #137,
and (pre-existing) #11's merged code. All three merged via git's 3-way merge
with zero hunk-level conflicts, confirming the 5 PRs were each scoped
narrowly enough (one conceptual change, non-overlapping edit regions) that
they compose.

## Competitors (graded)

| Source | Claim | Grade | Relevance |
|---|---|---|---|
| This repo's own 5 open performance PRs (#41, #94, #115, #137, #146) | Each independently measured and ACCEPTed a latency/memory win via the real `npm test` evaluator, with discriminating regression tests (parent fails, candidate passes) | A (reproducible, this repo, re-verified tonight in combination, not just individually) | Direct inputs to tonight's consolidation experiment |
| PR #94's own "Next steps" §3 (2026-10-23) | "The review backlog is the dominant uncertainty, not performance findings... why isn't anything merging, and what does the human reviewer need to unblock that" | A (this repo, primary source, one month old, still true tonight) | Directly motivates tonight's choice of candidate — reducing reviewer-facing diff count is the most direct, in-scope lever this session can pull without exceeding its own authority (no self-merge) |
| Git's three-way merge algorithm (`ort` strategy, Git ≥2.34) | Non-overlapping hunks across independently-authored branches merge automatically; only genuinely overlapping lines conflict | A (language/tool-level mechanism, directly reproduced below, not just cited) | The mechanism tonight's experiment relies on and empirically confirms held for these 5 specific branches |
| `paperclipai/paperclip` — no new competitor research performed tonight | N/A | — | Tonight's candidate is internal-process evidence (mergeability), not an external algorithmic technique, so a fresh competitor sweep would not inform it; the 4 competitor rows already on file across #11/#41/#94/#115/#137/#146 stand unrepeated |

## Hypothesis (frozen before implementation)

> Given 5 independently-authored, currently-open dream-cycle performance PRs
> (#41, #94, #115, #137, #146), each individually ACCEPTed against the real
> `npm test` evaluator on its own branch, when they are merged sequentially,
> oldest-first, onto current `main` (`ab588b3`), then the merge should
> complete with zero conflicts in any production source or test file (the
> append-only `LEDGER.md` is expected, and permitted, to need mechanical
> reconciliation), and the full test suite on the merged tree should pass
> with exactly the sum of each branch's own additive test count (362 + 2 + 1
> + 3 + 3 + 1 = 372), subject to: no existing test modified or weakened,
> `tsc --strict` clean, and `harness:bench-verify`'s corpus hash unchanged
> from every individual PR's own reported value (`840fd8d2d698…`).

Not modified after evaluation began.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), real project test runner, no mocked evaluator. `npm run harness:bench-verify` also run directly.

| | Tests | Pass | Fail | tsc --strict | bench-verify hash |
|---|---|---|---|---|---|
| Baseline (`ab588b3`, unmodified `main` tip) | 362 | 362 | 0 | clean | `840fd8d2d698…` |
| Consolidated (5 PRs merged, this branch) | 372 | 372 | 0 | clean | `840fd8d2d698…` (unchanged) |

Merge trial (`git merge --no-edit`, sequential, oldest PR first):

| Branch merged | Conflicts | Files needing resolution |
|---|---|---|
| `dream/2026-09-22-performance` (#41) | none | — |
| `dream/2026-10-23-performance` (#94) | 1 | `docs/dream-cycle/LEDGER.md` (append-order only) |
| `dream/2026-11-02-performance` (#115) | 1 | `docs/dream-cycle/LEDGER.md` (append-order only); `agentdb-adapter.ts` auto-merged clean |
| `dream/2026-11-13-performance` (#137) | 1 | `docs/dream-cycle/LEDGER.md` (append-order only); `fire-heartbeat.ts`, `agentdb-adapter.ts`, `heartbeats-and-comms.test.ts` all auto-merged clean despite #41/#115 touching the same files |
| `dream/2026-11-18-performance` (#146) | 1 | `docs/dream-cycle/LEDGER.md` (append-order only); `bridge-auth.ts` auto-merged clean |

Every `LEDGER.md` conflict was the same shape every time: two branches each
appending one row after the same parent row. Resolved by keeping both rows,
in chronological order — no content from any branch dropped or altered.

`npm run harness:bench-verify`: `Suite repo-native@0.1.0: 6 tasks, hash OK
(840fd8d2d698…)` — identical to the hash every one of the 5 source PRs
already reported, confirming the benchmark corpus was not touched by the
merge and has not gone soft.

## Baseline

`main` tip `ab588b32db00b536436139b1d8e5094cd7a6eb70`, evaluated unmodified
before any merge: 362/362, clean build, bench hash `840fd8d2d698…`.

## Darwin Lineage

Not run. There is no tunable parameter or alternative design here — the
"candidate" is a deterministic merge of 5 already-fixed implementations,
not a search space. Running Darwin over nothing would be theater.

## Evidence

- OBSERVATION: 5 open dream-cycle performance PRs exist, each individually
  evaluated and ACCEPTed (#41, #94, #115, #137, #146), none merged, 2 of
  them (#41, #137) touching the same file (`fire-heartbeat.ts`) and 3 of
  them (#115, #137, plus already-merged #11) touching the same file
  (`agentdb-adapter.ts`).
- OBSERVATION: two prior nights at this exact rotation (#117 2026-11-03,
  #127 2026-11-08) already confirmed the sequential-await-in-a-loop vein of
  this surface exhausted; tonight's own fresh sweep of 6 additional files
  (listed in TL;DR) found no new clean candidate of that shape, and the 2
  genuine latency-vs-waste tradeoffs found were correctly left unconverted
  (consistent with #117's own treatment of the `recallIssue` short-circuit).
- MEASUREMENT: sequential `git merge` of all 5 branches onto `main` tip —
  4 of 5 merges hit exactly 1 conflicted file (`LEDGER.md`, append-order
  only); 0 of 5 merges conflicted in any production or test file.
- MEASUREMENT: consolidated tree — 372/372 tests (362 baseline + exactly
  the sum of each branch's own new-test count), `tsc --strict` clean,
  `harness:bench-verify` hash unchanged.
- INFERENCE: the 5 PRs are mutually mergeable with no coordination cost
  beyond the trivial ledger append, so stacking them into one review unit
  loses no information and costs a human reviewer 1 diff instead of 5.
- DECISION: ACCEPT (the frozen hypothesis — zero functional conflicts, full
  additive test sum, clean bench hash — held exactly as stated).

## Reward-Hack Check

No existing test was modified, weakened, or deleted — git's merge preserved
every one of the 5 branches' own test files verbatim (confirmed: 372 = 362 +
2+1+3+3+1, an exact arithmetic match, not an approximation). No gold data,
threshold, or `.harness/bench.json` entry touched — hash identical to every
individual PR's own already-reported value, re-verified directly tonight
(not inferred from old logs). No cherry-picking: all 5 currently-open
`dream/*-performance` PRs as of tonight's `list_pull_requests` call were
included, none skipped. No new authority, dependency, or behavior was
introduced beyond the union of the 5 source PRs' own already-reviewed
changes — this candidate's only original contribution is the merge
resolution of `LEDGER.md` (mechanical, append-only, auditable line-by-line
above) and the evidence that the merge is clean. Independent critic pass:
checked whether consolidating could mask a conflict between #41's and
#137's changes to `fire-heartbeat.ts` by taking one side silently — it
cannot, under `ort`/3-way merge a silent one-sided resolution only happens
when hunks fully overlap, which `npm test` passing all 3 of #41's own
discriminating concurrency tests *and* all 3 of #137's own discriminating
duplicate-fetch tests on the combined tree empirically rules out (both
sets of behavior are present and independently verified in the same run).

## Security Review

No new authorization surface, credential, filesystem, or network scope
versus the union of what the 5 individual PRs already disclosed in their
own Security Review sections (re-read tonight, not re-derived) — this
candidate adds no code of its own beyond the ledger append. No new MCP
tool authority. The consolidation itself introduces no additional
attack surface: it is a git merge, evaluated the same way the individual
branches were, against the same test suite and bench corpus.

## Regression Analysis

Zero regressions: 362 → 372 (exactly the union of 5 branches' own additive
tests, 0 modified, 0 removed). `tsc --strict` clean. `harness:bench-verify`
hash unchanged. Every one of the 5 branches' own previously-reported
baseline/candidate test counts is reproduced exactly in this combined run
(cross-checked against each PR's own Evaluation Receipt table).

## ADR

None — this is a mechanical consolidation of 5 already-ACCEPTed mechanical
fixes, not a new architectural decision.

## Scan Findings (memory, latency)

**latency**: the 5 PRs being combined (#41, #94, #115, #137, #146) already
cover: 2 independent-read fan-outs in `fire-heartbeat.ts`/`agentdb-adapter.ts`
(#41, #115), 1 cross-function duplicate-fetch elimination (#137), 1
company-history-proportional allocation/sort reduction (#94), and 1
cold-cache thundering-herd coalescing (#146). Tonight's fresh sweep of
`build-snapshot.ts` (already fully `Promise.all`-based — no finding),
`propose-budget-mutation.ts`/`autogenous-client.ts` (2 sequential-await
pairs found, both genuine data dependencies or latency-vs-waste tradeoffs,
not free wins), and `interaction-profile.ts`'s per-issue O(n²) reverse scan
(bounded by realistically small per-issue transition counts; not re-flagged,
already superseded in relevance by #94's own fix to the same function)
found nothing further to add.

**memory**: no unbounded cache or growing-allocation pattern found beyond
what #127 (2026-11-08) already audited clean in `bridge-auth.ts`/
`bridge-client.ts`, and what #94 already fixed in `interaction-profile.ts`.

## Standing context: the review backlog (not restated as tonight's primary finding)

As of tonight (`mcp__github__list_pull_requests`, live): the most recent
dream-cycle PRs are still open (#111 through #146), last actual merge
of a `dream/*` branch remains 2026-09-07 (PR #15). Two non-dream-cycle
feature PRs (#144, #147) *have* merged since, moving `main` from `6e73a8f`
to `ab588b3` — confirming review activity on this repo is not globally
stalled, only on the `dream/*` backlog specifically. This finding has been
raised independently at least 8 times (#35, #71, #91/92, #117, #124, #127,
#134/135, #136/137, #142/143, #145/146) with no change in outcome — not
raised as tonight's primary finding a 9th time. Tonight's candidate is the
first concrete *action* on it from inside a session's own authority
(bounded consolidation, not another diagnosis), rather than a 9th repeat of
the same correct-but-inert observation.

## Gist

`gh gist create` unavailable (`gh auth status`: `GH_TOKEN` invalid; no gist
MCP tool this session — GitHub MCP issue/PR/branch/push tools work fine
independently of `gh`'s own token, confirmed via `mcp__github__get_me`).
Full report committed at this file. `GIST=LOCAL`.

## Recommendation

`evaluated: accepted`. Human review requested for the draft PR carrying
this consolidation — reviewing it resolves 5 backlog items (#41, #94, #115,
#137, #146) at once, each of which was already individually small and
reviewable. Concrete next steps: (1) if this consolidation PR is preferred
to merging the 5 individually, the 5 original PRs can be closed as
superseded once this one lands; (2) the 4 backfilled report files
(2026-09-22, 2026-10-23, 2026-11-02, 2026-11-13, plus tonight's own
2026-11-18 already carried the report into its own branch) finally land on
`main` as a side effect, partially addressing the long-standing
report/ledger backfill gap; (3) the 2 deferred latency-vs-waste tradeoffs
(`observeBudgetMutation`'s sequential pair, `recallIssue`'s tier
short-circuit) remain open human decisions, not further automated.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
the line `## Witness` above.

```
SESSION_COMMIT = ab588b32db00b536436139b1d8e5094cd7a6eb70
REPORT_HASH    = a122946538cc3e009dd1577f7da772fced7fd9d454130c5d51b7660be08824e7
WITNESS        = daf4e843af3fb6386b3f98c99db47fab397d09ecede01a66a03adb92a0d3a476
```

Verifier procedure (reproducible by anyone):
1. `git show ab588b32db00b536436139b1d8e5094cd7a6eb70 --stat` — confirm this is the session's starting commit (`main` tip at the start of tonight's run).
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-11-23-performance-report.md | sha256sum` — confirm it matches `REPORT_HASH` below.
3. `printf '%s%s' <REPORT_HASH> ab588b32db00b536436139b1d8e5094cd7a6eb70 | sha256sum` — confirm it matches `WITNESS` below.
4. `git checkout ab588b32db00b536436139b1d8e5094cd7a6eb70 -- . && npm ci && npm test` — confirm 362/362 pass (baseline receipt).
5. `git checkout dream/2026-11-23-performance -- . && npm test && npm run harness:bench-verify` — confirm 372/372 pass and the bench hash reads `840fd8d2d698…`.
