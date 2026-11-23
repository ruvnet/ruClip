# Performance/Latency SOTA Report — 2026-09-22

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip)
**Rotation**: DAYINT=20260922, SLOT=2 → base DEEP=architecture, SCAN=docs,api. **Rotated** per
Step 1.1's own learning signal (see below) to DEEP=performance, SCAN=memory,latency (slot 3's
pairing) — no `DAYINT % 25` bonus (22 ≠ 0).

## TL;DR

`fireHeartbeat` (`src/control-plane/heartbeat/fire-heartbeat.ts:70-77`) — invoked once per due
`HeartbeatSchedule`, i.e. on every tick of ruClip's own "kernel" scheduler — sequentially
`await`ed `recallCompany(...)` and then, only after that resolved, `recallIssue(...)` /
`recallGoal(...)`, even though the two reads are provably independent: neither the issue/goal
key nor the decision to fetch `issue` vs `goal` depends on `company`'s value, only on
`schedule.target` (already known before either call starts). The design doc itself
(`docs/design/HEARTBEATS-AND-COMMS.md` §3 step 1) lists both recalls as one step — "Recall the
target Issue (or Goal) and its Company" — with no ordering requirement. Fixed by issuing both
reads concurrently and checking both results afterward, preserving the existing fail-closed
semantics (missing company OR missing target both still `pauseAndPersist('error', ...)`).

## Learning signals applied (Step 1.1)

- **Repeated-finding rotation**: the `architecture` surface's last three appearances (2026-09-02
  PR #9, 2026-09-07 PR #17, 2026-09-17 PR #31) are all the *same* finding —
  "`agentdb-adapter.ts` is a God-module, extract a small independent slice" — applied to a
  different slice each time, and none of the three PRs has merged (#9 is still open 20 nights
  later; #17 and #31 are open). This matches the rule verbatim: "a finding repeated in ≥3 prior
  nights → rotate to the next slot's DEEP surface." Rotated slot 2 (architecture) → slot 3
  (performance), adopting slot 3's paired SCAN (`memory,latency`) rather than slot 2's
  (`docs,api`), since the rotation is meant to move the whole night's surface, not just relabel it.
- **Merge-rate bias**: of the 16 `dream/*` PRs opened since 2026-09-02 (#9, 11, 13, 15, 17, 19,
  21, 23, 25, 27, 29, 31, 33, 35, 37, 39), only #11, #13, #15 show `merged`-shaped state (closed,
  with `merged_at` set, content confirmed present on `main`); the other 13 — including *every*
  PR opened since 2026-09-08 — are still open, unreviewed, some for 20 days. Zero of the last 14
  are merged. Per the routine's own bias rule, tonight's candidate is kept to a single conceptual
  change in one production file plus its test, not a redesign.
- **Do-not-rediscover check**: `agentdb-adapter.ts`'s three tier-scan loops (`listIssuesForGoal`,
  `listApprovalTransitionsForCompany`, `listHeartbeatsForCompany`) and `applyApprovalTransition`'s
  blocking `await recomputeInteractionSignals(...)` are *already* diagnosed and fixed, correctly,
  in still-open PRs #19 (2026-09-08) and #33 (2026-09-18) respectively — confirmed by reading
  `main`'s current source (both patterns are still present, unmerged) and each PR's diff directly.
  Resubmitting either would be pure duplication, not new evidence, so tonight's search was
  deliberately scoped to find a *different* sequential-independent-read site. PR #19's own
  "trim `listApprovalTransitionsForCompany`'s fetched payload to 5 fields" follow-up was checked
  against the real, currently-pinned `agentdb_hierarchical-recall` tool schema
  (`node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js:701-745`, exact match to
  what #19 read) and confirmed still infeasible — no `fields`/projection parameter exists on the
  real tool today, so that follow-up is correctly still not actionable.

## Deep dive (performance)

Grepped `src/control-plane/**/*.ts` for `for (const ... await` / sequential-independent-read
shapes not already covered by #19/#33 (see above). Found one more, in
`heartbeat/fire-heartbeat.ts`, structurally the same class of bug (sequential await of two
independent reads) but a distinct call site on a distinct hot path — `fireHeartbeat` runs once
per due schedule per scheduler tick, upstream of both Gate 1 and Gate 2, so its own latency is
pure overhead added to *every* heartbeat regardless of outcome.

## Competitors (graded)

| Source | Claim | Grade | Relevance |
|---|---|---|---|
| Node.js async/await performance guidance (multiple 2026 dev blogs/tutorials, cross-checked) | Independent async reads awaited sequentially sum their latencies; the same reads issued via `Promise.all` complete in `max()` instead of `sum()` — a dashboard-style example measured 1000ms→200ms for 5 independent calls | B (vendor/blog, cross-checked across ≥5 independent 2026 sources, consistent with this repo's own #11/#19 measurements) | Directly the mechanism of tonight's fix — an `n=2` instance of the same shape #11 (n≈6, bounded) and #19 (n=2, bare) already fixed elsewhere in this file's sibling module |
| `paperclipai/paperclip`, GitHub PR #1847 (`fix(heartbeat): single-flight the periodic recovery chain`) | Paperclip's own heartbeat/scheduler "kernel" needed a correctness+performance fix to its periodic recovery chain (`resumeRunningExternalRuntimeRuns → reapOrphanedRuns → …`) to stop overlapping executions | A (primary repo, merged PR) | Direct confirmation that the *heartbeat/scheduler* code path specifically — not the general codebase — is where this class of competitor product has had to invest real fix effort; reinforces `fireHeartbeat` as a well-chosen target for a latency audit tonight |
| `paperclipai/paperclip` docs/deep-dive (dev.to, "Paperclip Deep Dive") | "If you need horizontal scale, the bottleneck is the heartbeat scheduler... Atomic SQL UPDATE = your concurrency story" | B (project-adjacent technical deep-dive, not primary docs) | Paperclip's own architecture explicitly names the heartbeat scheduler as the scaling bottleneck of the whole system — the same role `fireHeartbeat` plays here, once per due schedule, on ruClip's own architecture (ADR-0001 point 1) |
| This repo's own prior nights (#11 2026-09-03, #19 2026-09-08) | Established precedent: bare `Promise.all` is correct when fan-out width is a compile-time constant (here, always exactly 2 — `company` and `issue`-or-`goal`), no bounded-concurrency helper (`mapWithConcurrency`) needed unless width is data-proportional | A (this repo, previously verified, re-confirmed by re-reading `agentdb-adapter.ts:1322-1397` directly) | Same judgment call applies verbatim to tonight's fix |

## Frozen hypothesis (frozen before implementation)

> Given a call to `fireHeartbeat` against a bridge with non-trivial per-call latency, when the
> `recallCompany` and `recallIssue`/`recallGoal` reads (currently sequential) are issued
> concurrently instead, then `fireHeartbeat`'s wall-clock latency up to Gate 1 should approach
> `max(company_lookup_ms, target_lookup_ms)` instead of `company_lookup_ms + target_lookup_ms`,
> subject to: the full existing test suite passing identically before and after, `tsc --strict`
> staying clean, the missing-company and missing-target early-return (`'error'` outcome) behaviors
> being preserved exactly, and zero call-site signature changes to `fireHeartbeat`,
> `recallCompany`, `recallIssue`, or `recallGoal`.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), Node v22.

- **Baseline** (parent `6e73a8f`, unmodified `main` tip): 327/327 tests pass, 1811.5ms.
- **Baseline + new tests, pre-fix source** (proof the tests are real, not tautological): `git
  stash`ed the source fix, kept the 2 new tests, ran in isolation
  (`node --test --test-name-pattern="concurrently"`) — **both fail**, `observed max 1` (no
  overlap) on the sequential code, exactly as predicted.
- **Candidate** (source fix + 2 new tests): **329/329 tests pass**, `tsc -p tsconfig.json` clean,
  1796.9–1860.5ms full-suite wall time (noise-dominated at this scale, not a signal either way).
- **Isolated timing** (the two new tests alone, `ROUND_TRIP_MS = 60` mocked per lookup): **61.5ms
  and 61.4ms** respectively — `max(60, 60)` as the frozen hypothesis predicted, not `sum(60, 60) =
  120ms`. (An earlier draft of these tests measured `fireHeartbeat`'s *total* wall time
  end-to-end and got ~124–128ms even post-fix — traced to `persistHeartbeatSchedule`
  (`agentdb-adapter.ts:1102`/`1119`) independently re-fetching the same Issue/Goal a second time
  for its own existence/goalId validation, a distinct, pre-existing redundancy this candidate does
  not touch. The tests were corrected to delay only the first lookup of each key, isolating the
  measurement to the pair this candidate actually changes — see inline comments in the test file.)
- `npm run harness:bench-verify`: `Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)` —
  corpus unchanged, not gone soft.
- `npm run lint`: no-op (scaffold stage, unchanged by this candidate).
- Diff shape: 2 files, +141/-3 (`fire-heartbeat.ts` +12/-3 production; the rest is the 2 new
  tests) — well under the 300-line target, one conceptual change.

## Reward-hack / adversarial critique (independent pass over the candidate)

No gold answer, threshold, or benchmark corpus touched (`.harness/bench.json` hash unchanged,
re-verified above). No existing test modified — only 2 new tests added, and their real-bug-catching
power was verified by running them against the *unmodified* baseline code via `git stash` (both
fail there with `observed max 1`, confirming they are not tautological). No export dropped,
renamed, or had its signature changed (`fireHeartbeat`'s own signature is identical). Fan-out
width is a compile-time constant (`recallCompany` + exactly one of `recallIssue`/`recallGoal`,
never both, never attacker-influenced by `schedule.target.kind`), so bare `Promise.all` is the
right tool — same judgment call this repo's own #11/#19 nights already made and documented.

**One genuine semantic edge case, surfaced and reasoned through rather than silently left**: before
this change, when `company` is missing, `recallIssue`/`recallGoal` were never called at all
(early return pre-empted them); after this change, they're always called concurrently with
`recallCompany`, regardless of whether `company` turns out to exist. If `schedule.target.issueId`/
`goalId` were ever unsafe enough to fail `assertSafeId` (`bridge-client.ts:89`, a charset check,
not an existence check), that would now throw immediately instead of only surfacing after a
present `company`. Traced this to unreachable in practice: every `HeartbeatSchedule` that reaches
`fireHeartbeat` was itself written through `persistHeartbeatSchedule`, which already calls
`assertSafeId` (via `recallIssue`/`recallGoal`/`heartbeatKey`) on the exact same ids at creation
time — a schedule with an unsafe target id could never have been persisted in the first place, on
either side of this diff. Documented rather than silently assumed. Critic clear.

## Security review (Step 15)

Pure control-flow change (two sequential reads → concurrent reads) on read-only queries, no
authorization guard, credential path, or MCP tool surface touched. Fan-out width is a
compile-time constant of ≤2 (see above), never attacker-influenced, so no new amplification/DoS
surface versus the sequential version. No new dependency, no cache introduced. The one edge case
considered (unsafe target id surfacing earlier) is analyzed above and found unreachable through
this codebase's actual write path.

## Recommendation

`evaluated: accepted`. Human review recommended for the draft PR — this session never
self-merges. Follow-ups for a future night: (1) `persistHeartbeatSchedule`'s own redundant
second `recallIssue`/`recallGoal` fetch (surfaced above, `agentdb-adapter.ts:1102`/`1119`) is a
distinct, real latency finding of its own — deliberately left out of tonight's diff to keep this
candidate to one conceptual change, given the merge-backlog bias; (2) the 13-PR review backlog
itself (escalated again — see Learning signals above) is now large enough that it may itself
warrant a `developer-experience` night once rotation reaches it; (3) PR #19's payload-projection
follow-up remains blocked on the real tool gaining a `fields` parameter — re-check when
`@claude-flow/cli` is upgraded past `3.38.20`.

## Witness

```
REPORT_HASH    = 52281b436bd0355bf0e5be4da3859d79801a9a42a048a9c83258aaae88913e44
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 3c05514b20033d41ee1a7c87592bc01e756b16f425b178c5c4490d37023b67ba
```

`REPORT_HASH` is the sha256 of this file's content up to (and including) the line directly above
this Witness section — i.e. everything before `## Witness` itself, computed once before this
section existed. `WITNESS = sha256(REPORT_HASH || SESSION_COMMIT)`, computed as
`printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text (`docs/dream-cycle/2026-09-22-performance-report.md`)
   up to the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` (`6e73a8f060bcbb69965a50ffe4627e33622d4094`) is an ancestor of (or
   equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. Independently re-run `npm test` against the PR branch's HEAD and confirm 329/329 (0 fail) —
   the receipt this report claims.
