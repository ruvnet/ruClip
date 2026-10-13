# Performance/Latency SOTA Report — 2026-10-13 (duplicate-detection night)

**Dream Cycle 2026-10-13** · Slot 3 · DEEP=performance · SCAN=memory,latency · `ruvnet/ruClip`

## TL;DR

Tonight's deep-dive independently re-derived a finding already fully
evidenced and sitting open on GitHub as **PR #53** (`listIssuesForGoal`,
`listApprovalTransitionsForCompany`, `listHeartbeatsForCompany` each
scan both `working`/`episodic` tiers sequentially; fix is a `Promise.all`
fan-out). PR #53 itself explicitly supersedes an earlier closed duplicate,
PR #19 (2026-09-08). This would have been the **third** independent
implementation of the identical fix. Per the routine's own operating
principle ("never optimize for producing a PR"), and directly following
2026-10-12's own architecture finding (#71: 30 unmerged `dream/*`
branches, 0% merge rate, 2 self-admitted duplicates already found and
closed), **no new branch/PR was opened tonight.** Candidate code+tests
were implemented and measured locally (to confirm the finding is still
real and still unfixed on `main`), then discarded rather than committed,
since PR #53 already carries the identical, fully-evaluated fix and is
still `mergeable_state: clean` against current `main`.

## Deep dive (performance)

Grep of `agentdb-adapter.ts` for the file's own "scan both tiers a record
can live in" idiom found the same 3 functions every prior relevant night
found: `listIssuesForGoal`, `listApprovalTransitionsForCompany`,
`listHeartbeatsForCompany` — each loops `for (const tier of ['working',
'episodic'])` with one sequential `await callTool(...)` per tier, no
short-circuit (unlike `recallByKey`, which legitimately stays sequential).
Confirmed by reading `main` @ `6e73a8f` directly (not trusting the
5-week-stale `LEDGER.md`) that this is still present and unfixed.

**Ledger/duplicate check (done BEFORE writing new code, not after):**
`search_issues`/`pull_request_read` against the real GitHub state found:
- Issue #18 / PR #19 (2026-09-08): identical finding, identical fix shape.
  PR #19 is **closed, unmerged** — closed 2026-10-12 as a "confirmed,
  self-admitted duplicate" of PR #53 (per #71's supersession-audit tool
  and PR #19's own closing comment).
- Issue #52 / **PR #53** (2026-10-02): re-implements the identical fix
  from scratch against a fresh `main` checkout, with its own hypothesis,
  baseline (327/330, 3 predicted failures), candidate (330/330), reward-
  hack check, and security review — already `evaluated: accepted`. PR #53
  is **open, draft, `mergeable_state: clean`** (base `6e73a8f` — `main` has
  not moved since 2026-09-07, so no rebase is needed).

Tonight's candidate would have been a byte-for-byte-equivalent
reimplementation of PR #53. Implementing and opening it would have been
the exact failure mode 2026-10-12's own cycle (#71) diagnosed and started
correcting ("the dream-cycle generates candidates nightly but has no
counterpart that ever shrinks the backlog").

## What was actually done tonight (for the record — not committed)

To confirm the finding is real (not stale/already-fixed) rather than take
#71/#53's word for it, the fix was implemented locally and measured:

```
BASELINE (parent 6e73a8f, unmodified, 3 new discriminating tests added):
  tests 330, pass 327, fail 3 (exactly the 3 new tests)
  listIssuesForGoal: took 81ms total — expected ~40ms (concurrent), not ~80ms (sequential)
  listApprovalTransitionsForCompany: tier invocations 40ms apart — expected < 40ms
  listHeartbeatsForCompany: tier invocations 41ms apart — expected < 40ms

CANDIDATE (3x sequential-await → Promise.all):
  tests 330, pass 330, fail 0
  listIssuesForGoal: 40.15ms / listApprovalTransitionsForCompany: 41.95ms / listHeartbeatsForCompany: 44.65ms
```

Same ~2x wall-clock reduction PR #53 itself measured (its own receipt:
~51-54ms baseline → ~25-27ms candidate, different mock delay constant,
same ratio). This independently reproduces PR #53's own evaluation
receipt using a freshly-written test harness, which is itself useful
evidence: **three separate sessions, on three separate nights, each
starting from scratch, converged on the identical diagnosis and the
identical fix.** That convergence is stronger evidence for ACCEPT than
any single night's receipt alone. The diff was then discarded (`git
checkout --`) rather than committed — committing it would have produced
a fourth copy of the same 143-line diff sitting in a 31st unmerged
branch, which has negative expected value given the current backlog.

## Frozen hypothesis

(Unchanged from PR #53's own hypothesis — reproduced here because this
cycle re-tested it independently, not because it is a new claim.)

> Given `listIssuesForGoal`, `listApprovalTransitionsForCompany`, or
> `listHeartbeatsForCompany` against a bridge with non-trivial per-call
> latency, when the two independent tier scans are issued concurrently
> via `Promise.all` instead of sequentially, then each function's
> wall-clock latency should approach `max(tier_working_ms,
> tier_episodic_ms)` instead of the sum, subject to: full test suite
> passing identically before/after, `tsc --strict` clean, merged-result
> correctness unchanged regardless of array order, zero signature changes.

## Evidence ledger (classification)

- OBSERVATION: the 3-function sequential-tier-scan pattern is still
  present, unfixed, on `main` @ `6e73a8f`.
- OBSERVATION: PR #53 (open, draft, clean) already contains the identical
  fix with its own complete, passing evaluation receipt.
- OBSERVATION: PR #19 (closed, unmerged) is a prior, now-superseded
  duplicate of the same finding — confirms this is the *third*
  independent discovery, not the second.
- MEASUREMENT: local reproduction tonight — baseline 327/330 (3 predicted
  failures, ~81-83ms), candidate 330/330 (~40-45ms) — matches PR #53's own
  receipt in shape and ratio (not in absolute ms, since the mock delay
  constants differ by design).
- INFERENCE: three independent convergent implementations is strong
  confirmatory evidence; the bottleneck on this finding is exclusively
  human review bandwidth, not evidence quality or correctness risk.
- DECISION: **ACCEPT the underlying finding** (as PR #53 already does);
  **do not open new code** — recommend human merge PR #53 directly.
  Tonight's own code/test diff was written, measured, and discarded.

## Reward-hack check (independent-critic pass)

Not applicable to a no-new-code night in the usual sense; applied to the
*decision not to duplicate* instead: is "don't open a PR" a disguised way
to avoid producing evidence of a failed/REJECTed hypothesis? No — the
hypothesis is not rejected, it is independently reconfirmed ACCEPT; the
evidence (baseline-fails/candidate-passes receipt) was produced in full,
just not committed as a fourth copy of the same diff. Verified the
decision against the actual GitHub state via API calls (not asserted from
memory): PR #53's `mergeable_state` was fetched live and is `clean`.

## Security review

No code shipped tonight — nothing to review. (PR #53's own security review
already covers the underlying change: pure read-only control-flow,
compile-time-constant fan-out width of 2, no new MCP/auth/credential
surface.)

## Darwin

Not run — no new candidate to search a fitness landscape over.

## Scan findings (memory, latency)

Both scan surfaces this cycle's own deep-dive could have covered are
already open, evaluated dream-cycle issues (checked against the live
`label:performance` issue list, 14 items, to avoid a second duplication in
the same night):
- `checkOperatingBudget`'s `memory_list({ namespace, limit: 1000 })` has
  no server-side key-prefix filter (confirmed against the real, pinned
  `@claude-flow/cli@3.38.20`'s `memory-tools.js` schema — only
  `namespace`/`limit`/`offset`) — a multi-tenant namespace fetches every
  company's entries, filtering client-side. Not actionable from this repo
  (would require patching a pinned third-party tool). Not yet filed as its
  own issue by any prior night, but also not a `ruClip`-side fix — noted,
  not actioned.
- `fireHeartbeat` (Company+Issue/Goal sequential recall): issue #40 / PR
  #41, open, unmerged, not re-touched tonight.
- `persistHeartbeatSchedule` (sequential previous-state+target recall):
  issue #42, open, unmerged, not re-touched tonight.
- `persistHeartbeatSchedule` (unconditional belongs_to edge rewrite):
  issue #54, open, unmerged, not re-touched tonight.
- `buildDashboardSnapshot` (unbounded goal/issue `Promise.all` fan-out,
  data-proportional not fixed-width — a *different* class of finding from
  tonight's fixed-width-2 fan-out): issue #44, open, unmerged, not
  re-touched tonight.
- `persistIssue`'s 3 causal-edge writes: issue #62, already evaluated and
  **REJECTed with evidence** by 2026-10-08's cycle — correctly not
  re-opened.

**Observation for the routine itself:** 14 of ~30 open `dream/*`
branches/issues now carry a `performance` label, nearly all opened across
the 2026-09-08 → 2026-10-12 window, nearly all evaluated ACCEPT, none
merged. The performance surface is not short on findings or evidence; it
is short on review throughput. Tonight adds zero to that count rather than
a 15th.

## Competitors

| Source | Grade | Claim |
|---|---|---|
| dev.to "ghost — a production mystery" (practitioner post) | B | N-way parallel fan-out still opens N connections; fine under light load, can exhaust a pool under pressure — re-checked against tonight's fixed-width-2 case and found inapplicable (same conclusion PR #19 and PR #53 both already reached). |
| Backend-perf checklist (vendor guide) | B | Promise.all for independent calls, with an explicit bound for open-ended lists — matches the already-landed `checkOperatingBudget` precedent (bounded at 25) vs. tonight's fixed-2 case (no bound needed). |
| `paperclipai/paperclip`'s "PR gardening" skill (per 2026-10-12's own research, re-cited not re-researched tonight) | B | A dedicated, bounded (never merges/approves/closes autonomously beyond confirmed duplicates) backlog-tending pass is the missing half of this routine's own loop — directly relevant to tonight's decision not to add a 31st branch. |
| This repo's own PR #53 / #19 (internal) | A | Already-landed, reproducible, triple-independently-converged finding. |

## Gist

No `gh gist create`/gist-creation tool available on this session's GitHub
MCP server (same `FALLBACK`-for-gists pattern as every prior night). Full
report committed at `docs/dream-cycle/2026-10-13-performance-report.md`.
`GIST=LOCAL`.

## Recommendation

`evaluated: accepted` (the underlying finding, independently
triple-confirmed) — but **the actionable recommendation is procedural,
not a new PR**: a human should review and merge (or explicitly close as
redundant) **PR #53** directly; doing so will also resolve issues #18 and
#52. No new branch was opened tonight. This session never self-merges.

## Witness

- Session commit (repo HEAD, `main` tip, unchanged since 2026-09-07):
  `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (this file's content up to, but not including, this
  Witness section's own hash values — i.e. hashed with this section
  reading "(computed and inserted below after this file is finalized)"):
  `c54f690cddec57a158656303a000520608f79e7a079ee286c2d2b6150eb658cb`
- Witness stamp — `sha256(report_sha256 || session_commit)`:
  `808a0b55b4f61d59c4e82d4b27e7750e08741c48ceac9366051f726d68b05d40`

**Verifier procedure:**
1. Check out `6e73a8f060bcbb69965a50ffe4627e33622d4094` of `ruvnet/ruClip`.
2. Obtain this exact report text (the committed copy at
   `docs/dream-cycle/2026-10-13-performance-report.md`), with this Witness
   section's two hash values reverted to the placeholder text above.
3. `sha256sum` it; must equal the Report sha256 above.
4. `printf '%s%s' '<report_sha256>' '6e73a8f060bcbb69965a50ffe4627e33622d4094' | sha256sum`.
5. Must equal the Witness stamp above.
