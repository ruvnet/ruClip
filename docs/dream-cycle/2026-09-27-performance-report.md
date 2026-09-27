# Performance/Latency SOTA Report — 2026-09-27

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip)
**Rotation**: DAYINT=20260927, SLOT=2 → base DEEP=architecture, SCAN=docs,api. **Rotated** per
Step 1.1's repeated-finding rule (same condition as 2026-09-22, unchanged — see below) to
DEEP=performance, SCAN=memory,latency (slot 3's pairing). No `DAYINT % 25` bonus (27 mod 25 = 2 ≠ 0).

## TL;DR

`persistHeartbeatSchedule` (`src/control-plane/store/agentdb-adapter.ts:1053-1138`) — invoked on
every heartbeat fire, including every successful one (via `fireHeartbeat`'s two `persistHeartbeatSchedule`
call sites) — sequentially `await`ed `recallHeartbeatSchedule` (the previous-state read, used for the
create/resume authorization gates) and then, only after that resolved, `recallIssue`/`recallGoal` (the
target-existence read), even though the two reads are provably independent: neither depends on the
other's result, only on `schedule`/`schedule.target`, both already known before either call starts.
This is exactly the follow-up 2026-09-22's own report (`docs/dream-cycle/2026-09-22-performance-report.md`,
Recommendation §1) flagged and deliberately left out of that night's diff to keep its own candidate to
one conceptual change. Fixed by issuing both reads concurrently via `Promise.all`, preserving the
existing throw/validation order and every existing behavior.

## Learning signals applied (Step 1.1)

- **Repeated-finding rotation, unchanged since 2026-09-22**: `main` is still at `6e73a8f`, the same tip
  2026-09-22's report was written against — nothing has merged in the 5 nights between (no dream-cycle
  ran 2026-09-23 through 2026-09-26; no PR/issue exists for those dates, checked via
  `list_pull_requests`/`list_issues`). The `architecture` surface's repeated finding ("extract from the
  `agentdb-adapter.ts` God-module", #9 2026-09-02, #17 2026-09-07, #31 2026-09-17, all still open) is
  therefore still the most recent state of that surface, so the same rotation rule fires again tonight:
  slot 2 (architecture) → slot 3 (performance), adopting slot 3's `memory,latency` scan pair.
- **Merge-rate bias, escalated further**: re-checked every `dream/*` PR via `list_pull_requests`
  (state=all). Of 16 opened since 2026-09-02 (#9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35,
  37, 39, 41 — 17 total), only **#11, #13, #15** are merged (content confirmed on `main` by commit
  message match in `git log`); **13** are still open, several 3+ weeks old (#9 is 25 nights unmerged).
  Zero of the last 14 merged, same as every prior night since 2026-09-06 — tonight's candidate is kept
  to a single conceptual change in one production file plus its test, per the routine's own bias rule.
- **Do-not-rediscover check**: read `docs/dream-cycle/2026-09-22-performance-report.md` in full before
  starting. It explicitly names `persistHeartbeatSchedule`'s own redundant/sequential
  `recallHeartbeatSchedule` + `recallIssue`/`recallGoal` pair (`agentdb-adapter.ts:1102`/`1119` in that
  night's line numbers) as "a distinct, real latency finding of its own — deliberately left out of
  tonight's diff". Re-read the current source at those lines directly (unchanged, since PR #41 carrying
  the *other* half of that finding — `fireHeartbeat`'s own Company/Issue/Goal fetch — is itself still
  unmerged and touches a different file, `fire-heartbeat.ts`, not `agentdb-adapter.ts`) and confirmed
  the finding is real and not yet fixed anywhere, merged or open. This is that finding, tonight, as its
  own candidate — no duplication with #19 (2026-09-08, 3 listers), #33 (2026-09-18,
  `applyApprovalTransition`), or #41 (2026-09-22, `fireHeartbeat`'s own two reads).

## Deep dive (performance)

`persistHeartbeatSchedule` is called by `fireHeartbeat` on **every** outcome that reaches a persist —
both the successful path (`firedSchedule`) and every `pauseAndPersist` path (error/budget-blocked) — so
it is not a cold path; it is the write half of the same hot loop #41 optimized the read half of. Its
own body does:

1. `recallHeartbeatSchedule(...)` → `stored` (previous state, used only for the two authorization-gate
   throws at lines 1062/1086).
2. (only if `authorization` supplied — never true on `fireHeartbeat`'s own system-initiated calls)
   `resolveVerifiedActor(...)`.
3. `recallIssue(...)` or `recallGoal(...)` → target-existence check + (issue-only) `goalId` cross-check.

Step 1 and step 3 do not depend on each other's result at all — step 3 only needs `schedule.target`,
already fully known at function entry. Confirmed by direct read of the source (no data flow from
`stored` into the `recallIssue`/`recallGoal` call arguments, and none the reverse) and by writing two
new regression tests (below) that fail against the unmodified sequential code and pass against the fix.

## Competitors (graded)

| Source | Claim | Grade | Relevance |
|---|---|---|---|
| Node.js async/await performance guidance (multiple 2026 dev blogs/tutorials, cross-checked; same corpus 2026-09-22 graded) | Independent async reads awaited sequentially sum their latencies; `Promise.all` collapses them to `max()` | B (vendor/blog, cross-checked across ≥5 independent 2026 sources) | Same mechanism as tonight's fix — a third instance in this file's own hot path (after #11's N-way fan-out and #41's n=2 read pair) |
| This repo's own 2026-09-22 report (`docs/dream-cycle/2026-09-22-performance-report.md`) | Named this exact call site (`persistHeartbeatSchedule`'s `recallHeartbeatSchedule`/`recallIssue`/`recallGoal` pair) as a real, distinct, unfixed finding | A (this repo, primary, directly re-verified against current `main` source before use) | Tonight's finding is that report's own flagged follow-up, not independent rediscovery |
| `paperclipai/paperclip`, GitHub PR #1847 (`fix(heartbeat): single-flight the periodic recovery chain`) | Paperclip's own heartbeat/scheduler kernel needed a correctness+performance fix to its periodic recovery chain | A (primary repo, merged PR; same citation as 2026-09-22, re-checked still applicable) | Reinforces the heartbeat/persist path generally as the class of code where this competitor has had to invest real fix effort |
| This repo's own prior nights (#11 2026-09-03, #19 2026-09-08, #41 2026-09-22) | Established precedent: bare `Promise.all` (no bounded-concurrency helper) is correct when fan-out width is a compile-time constant, never attacker- or data-proportional | A (this repo, previously verified 3x, re-confirmed for tonight's site: width is always exactly 2 — `stored` + exactly one of `issue`/`goal`) | Same judgment call applies verbatim |

## Frozen hypothesis (frozen before implementation)

> Given a call to `persistHeartbeatSchedule` against a bridge with non-trivial per-call latency, when
> the `recallHeartbeatSchedule` (previous-state) read and the `recallIssue`/`recallGoal`
> (target-existence) read — currently sequential — are issued concurrently instead, then
> `persistHeartbeatSchedule`'s wall-clock latency up to `targetNodeId` resolution should approach
> `max(schedule_lookup_ms, target_lookup_ms)` instead of `schedule_lookup_ms + target_lookup_ms`,
> subject to: the full existing test suite passing identically before and after, `tsc -p tsconfig.json`
> staying clean, every existing throw/validation (create-without-authorization, resume-without-authorization,
> actor-company mismatch, missing-issue, missing-goal, `goalId` cross-check) firing in the same order
> against the same values, and zero call-site signature changes to `persistHeartbeatSchedule`,
> `recallHeartbeatSchedule`, `recallIssue`, or `recallGoal`.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), Node v22.

- **Baseline** (parent `6e73a8f`, unmodified `main` tip): 327/327 tests pass.
- **Baseline + new tests, pre-fix source** (proof the tests are real, not tautological): `git stash`ed
  the source fix, kept the 2 new tests, ran in isolation
  (`node --test --test-name-pattern="previous-state"`) — **both fail**, `observed max 1` (no overlap),
  exactly as predicted; `git stash pop` restored the candidate afterward.
- **Candidate** (source fix + 2 new tests): **329/329 tests pass**, `tsc -p tsconfig.json` clean.
- **Isolated timing** (the two new tests alone, `ROUND_TRIP_MS = 60` mocked per lookup): **64.0ms and
  61.0ms** respectively — `max(60, 60)` as the frozen hypothesis predicted, not `sum(60, 60) = 120ms`.
- `npm run harness:bench-verify`: `Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)` — corpus
  unchanged, not gone soft.
- `npm run lint`: no-op (scaffold stage, unchanged by this candidate).
- Diff shape: 2 files, +108/-3 (`agentdb-adapter.ts` +14/-3 production; the rest is the 2 new tests) —
  well under the 300-line target, one conceptual change.

## Darwin results

Not run. The candidate is a single, already-minimal conceptual change (replace one sequential pair with
one `Promise.all`); there is no meaningful alternative mutation space to search bounded-Darwin over
without inventing artificial variants, so Bounded Darwin was skipped this run (permitted: "only if
available" / applicable).

## Reward-hack / adversarial critique (independent pass over the candidate)

No gold answer, threshold, or benchmark corpus touched (`.harness/bench.json` hash unchanged,
re-verified above). No existing test modified — only 2 new tests added, and their real-bug-catching
power was verified by running them against the *unmodified* baseline code via `git stash` (both fail
there with `observed max 1`). No export dropped, renamed, or had its signature changed. Fan-out width
is a compile-time constant (`stored` + exactly one of `issue`/`goal`, never both, never
attacker-influenced by `schedule.target.kind` since that's a closed 2-value discriminant), so bare
`Promise.all` is the right tool — same judgment call #11/#19/#41 already made and documented.

**One genuine semantic edge case, surfaced and reasoned through rather than silently left**: before this
change, when `stored === null && !authorization` (the create-without-authorization rejection) or
`stored.status === 'paused' && schedule.status === 'active' && !authorization` (the resume-without-authorization
rejection) is about to throw, `recallIssue`/`recallGoal` was never called at all — the throw happened
before reaching that line. After this change, `recallIssue`/`recallGoal` is always fetched concurrently
with `recallHeartbeatSchedule`, regardless of whether the authorization gate will reject afterward. This
is strictly a **wasted round trip on a rejection path**, not a correctness change (the function still
throws the identical error either way, and the fetched `issue`/`goal` value is simply discarded when the
gate throws first) — traced through both throw sites and confirmed neither one reads `issue`/`goal`
before throwing. No existing test asserts on call counts for either rejection path (checked
`actor-credential-authorization-gaps.test.ts:150-204`, the only file covering the resume-rejection case;
it asserts absence of `claims_list`/`agentdb_hierarchical-store` calls only, unaffected here), so this is
a real but low-severity, previously-untested efficiency cost on two rare, already-slow (they throw)
paths, traded for a real latency win on the common (success) path. Documented rather than silently
assumed. Critic clear.

## Security review (Step 15)

Pure control-flow change (two sequential reads → concurrent reads) on read-only queries feeding
existing authorization gates whose logic and ordering are unchanged (same `stored`/`issue`/`goal`
values, same throw conditions, same order). No authorization check was reordered relative to another
authorization check — only the two *data fetches* that feed separate, already-ordered checks were
overlapped. No new dependency, no cache introduced. Fan-out width is a compile-time constant of ≤2 (see
above), never attacker-influenced, so no new amplification/DoS surface versus the sequential version.
The one edge case considered (a wasted fetch on a rejection path) is analyzed above and found to be an
efficiency cost only, not an authorization weakening — the gate still throws before any write occurs
either way.

## Scan findings (`memory`, `latency`)

- **memory**: no unbounded in-memory accumulation found in `persistHeartbeatSchedule` or its call
  chain; `stored`/`issue`/`goal` are each a single object, discarded on function return, no cache or
  module-level accumulator introduced by this candidate.
- **latency**: this candidate's own finding *is* the latency scan result for tonight (see Deep dive
  above). No second latency finding was pursued once one was identified and evaluated, per the routine's
  "select exactly one" rule.

## Recommendation

`evaluated: accepted`. Human review recommended for the draft PR — this session never self-merges.
Follow-ups for a future night: (1) the wasted-fetch-on-rejection-path edge case above is real but
low-severity and was deliberately left as-is rather than special-cased, to keep this candidate to one
conceptual change; special-casing it (skip the concurrent target fetch when `authorization` is absent
*and* `stored` will predictably reject) would reintroduce a data dependency between the two fetches for
a rare path, trading a latency win on the common path for complexity — not recommended without a
concrete production signal that the rejection path is itself hot; (2) the 13-PR review backlog is now
14 nights deep with zero net progress since 2026-09-06 (escalated again, see Learning signals) — this
remains the single highest-leverage `developer-experience` finding available and should be the very
next `developer-experience`-slot night's focus if rotation reaches it before a human intervenes; (3)
PR #41 (2026-09-22, `fireHeartbeat`'s own Company/Issue/Goal concurrency fix) and tonight's candidate
are complementary halves of the same hot loop's latency and do not conflict (different files) — merging
both together would compound their wins.

## Witness

```
REPORT_HASH    = ad10d0d73a71028bcc37e7306c2810b9804b92983fa0e79d681802d9a7a70878
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 09a433a72592ad6f1cfb7912a5cd7740b617155f4d7bd7540577f4452a500793
```

`REPORT_HASH` is the sha256 of this file's content up to (and including) the line directly above this
Witness section — i.e. everything before `## Witness` itself, computed once before this section
existed. `WITNESS = sha256(REPORT_HASH || SESSION_COMMIT)`, computed as
`printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text (`docs/dream-cycle/2026-09-27-performance-report.md`) up to
   the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` (`6e73a8f060bcbb69965a50ffe4627e33622d4094`) is an ancestor of (or equal to)
   the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. Independently re-run `npm test` against the PR branch's HEAD and confirm 329/329 (0 fail) — the
   receipt this report claims.
