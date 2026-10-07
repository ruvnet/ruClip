# ruClip Architecture SOTA Report — 2026-10-07

## TL;DR

`src/control-plane/store/agentdb-adapter.ts` is still a 1483-line God-module
(8 unrelated bounded contexts). The 2026-09-02 architecture night already
proved one clean extraction (the operating-budget circuit breaker) and
opened draft PR #9 for it — but #9 has sat unmerged for 5 nights and three
intervening PRs (#11, #13, #15) touched this same file, so #9's branch is
now **stale and conflicting** (`mergeable_state: dirty`). Tonight redoes
the identical, already-accepted extraction fresh against current `main`
(commit `6e73a8f`) so it lands cleanly, and explicitly recommends closing
#9 in favor of this PR. A second candidate (extracting the heartbeat-schedule
section, which issue #8's own "suggested follow-up" named as the next
architecture target) was evaluated and **rejected before implementation**:
it has 5 in-module helper dependencies (`recallIssue`, `recallGoal`,
`verifyActorHoldsClaim`, `resolveVerifiedActor`, `recordCausalEdge`,
`entityNodeId`) that would force either a much larger diff or the exact
circular-import failure `bridge-client.ts`'s own header already documents
discovering at runtime. That finding is this session's actual novel
contribution — it corrects issue #8's own roadmap before code was written
on the wrong path.

## What's new

- Confirmed (OBSERVATION, this session): the operating-budget section
  (`RUCLIP_COST_NAMESPACE` through `checkOperatingBudget`, ~170 lines) is
  still the only genuinely self-contained bounded context left in the file
  — it depends on nothing but `callTool`/`assertSafeId` from
  `bridge-client.ts`, already its own dependency-free module.
- Confirmed (OBSERVATION, this session): the heartbeat-schedule section
  issue #8 named as the suggested next target is **not** mechanically
  extractable the same way — it threads through 5 other in-file helpers.
  The pattern-store section (`storePattern`/`searchPatterns`) is equally
  self-contained but has zero production call sites (test-only), so its
  production-value is low; not selected over completing #9's stuck work.
- `main` has advanced 3 merged PRs since #9 was opened, confirming the
  repo's architecture-surface risk isn't "will this merge" (3 of the last
  4 dream-cycle PRs merged — #11, #13, #15) but "will a slow-to-review
  draft PR rot" (#9's specific failure mode).

## Competitors

| Project | Persistence layer shape | Evidence grade |
|---|---|---|
| `paperclipai/paperclip` | `packages/db/` — Drizzle ORM schema, ~61 tables, no monolithic data-access file | B (web-search summary this session; prior ADR-0001/issue #8 independently confirmed via `gh repo view`, grade A) |
| ruClip (`main`, pre-candidate) | `agentdb-adapter.ts`, 1483 lines, 8 bounded contexts | A (direct grep/read this session) |
| ruClip (`main`, post-candidate) | `agentdb-adapter.ts`, ~1310 lines, 7 bounded contexts; `operating-budget.ts`, ~175 lines | A (this PR's own diff) |
| `ruvnet/dream-machine` precedent | this repo's own `bridge-client.ts` extraction (ADR-cited) used re-export-for-compatibility, same convention reused here | A (direct read this session) |

## Hypothesis (frozen before implementation)

> Given `agentdb-adapter.ts` on current `main` (commit `6e73a8f`, 1483
> lines), when the operating-budget circuit breaker
> (`RUCLIP_COST_NAMESPACE`, `OperatingBudgetLevel`/`Thresholds`/`Config`,
> `DEFAULT_OPERATING_BUDGET_THRESHOLDS`, `operatingBudgetConfigKey`,
> `operatingSessionKeyPrefix`, `setOperatingBudget`, `operatingBudgetLevel`,
> `SESSION_COST_FETCH_CONCURRENCY`, `mapWithConcurrency`,
> `checkOperatingBudget`) is extracted into a new single-responsibility
> module `src/control-plane/store/operating-budget.ts` and re-exported from
> `agentdb-adapter.ts`, then `agentdb-adapter.ts` shrinks by ~170 lines with
> zero behavioral change, subject to: the full existing test suite (327
> tests on current `main`) passing identically before and after, `tsc`
> staying clean, and zero import changes required at any of the three real
> call sites (`heartbeat/fire-heartbeat.ts`,
> `governance/propose-budget-mutation.ts`, `dashboard/build-snapshot.ts`).
> This is the identical candidate already proved by stale draft PR #9
> (2026-09-02) against an older commit — redone fresh because #9 now
> conflicts with `main`.

Not modified after evaluation begins.

## Benchmarks / Evaluation

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`).

| | Tests | Pass | Fail | tsc | Duration |
|---|---|---|---|---|---|
| Baseline (`main`, commit `6e73a8f`) | 327 | 327 | 0 | clean | 1578.78ms |
| Candidate (branch `dream/2026-10-07-architecture`) | 327 | 327 | 0 | clean | 1674.39ms |

`agentdb-adapter.ts`: 1483 → 1327 lines (-156). New `operating-budget.ts`:
+190 lines. `git diff` against the 3 real call sites
(`heartbeat/fire-heartbeat.ts`, `governance/propose-budget-mutation.ts`,
`dashboard/build-snapshot.ts`) is empty — zero import changes required, as
hypothesized. No test file was touched (unlike #9's diff, which also
touched report/ledger docs) — the extracted functions have no dedicated
unit tests of their own that assert on the module path, only on behavior,
so moving the implementation needed no test changes.

## Witness

```
REPORT_HASH    = ac4ff2fc24af6b41f0022673c1a7823d00620098db6e78b87c17c63e25e7f854
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = dd0cccbb4d8f1c64b5b7efa5ee1cca9511d5e9fba4fb972c8e36e47e1edf225b
```

Verifier procedure (reproducible by anyone):
1. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094` (the session's parent commit).
2. Re-run `npm ci && npm run build && npm test` — expect 327/327 pass, tsc clean.
3. Check out `dream/2026-10-07-architecture` and re-run the same — expect 327/327 pass, tsc clean, and `git diff --stat main...dream/2026-10-07-architecture -- src/control-plane/heartbeat/fire-heartbeat.ts src/control-plane/governance/propose-budget-mutation.ts src/control-plane/dashboard/build-snapshot.ts` empty.
4. `REPORT_HASH` = `sha256sum` of this report's content up to, but not including, this `## Witness` heading (as committed at `docs/dream-cycle/2026-10-07-architecture-report.md` on the PR branch).
5. `WITNESS` = `sha256sum` of `REPORT_HASH` concatenated with `SESSION_COMMIT` (no separator).

## Next steps

1. Human: close or rebase stale draft PR #9 (2026-09-02) once this PR lands
   — it is now fully superseded and conflicting.
2. Do not attempt the heartbeat-schedule extraction as a mechanical,
   single-conceptual-change diff — it needs a design pass first (which
   in-file helpers, if any, should become shared exports vs. duplicated).
3. If a future architecture night wants a second extraction, the
   Autogenous-mutation-audit-trail section is the next-most-self-contained
   candidate (2 functions, 3 in-file dependencies: `storeAtTier`,
   `recallByKey`, `autogenousMutationKey` — all three are also used by
   5+ other sections, so moving them is itself the design question to
   answer first).
