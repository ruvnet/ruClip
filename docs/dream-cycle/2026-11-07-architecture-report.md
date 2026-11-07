# Architecture SOTA Report — 2026

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`
**Rotation**: SLOT=2 → DEEP=architecture, SCAN=docs,api (2026-11-07, DAYINT=20261107, DAYINT%25=7, no bonus)

## TL;DR

`src/control-plane/store/agentdb-adapter.ts` is still a 1483-line God-module —
the sole persistence surface for ~9 unrelated bounded contexts (company/goal/
issue persistence, 3 approval guards, causal edges, heartbeat scheduling, an
operating-budget circuit breaker, an advisory pattern-store, and an Autogenous
mutation audit trail). Two prior dream-cycle nights already proposed
extracting a context from this file (2026-09-02 → `operating-budget.ts`,
PR #9, now **closed/unmerged, `mergeable_state: dirty`**; 2026-10-17 →
`causal-edges.ts`, PR #82, **still open/unmerged**), and a `git diff`
scan across the 27 most recent open `dream/*` branches (2026-10-11 through
2026-11-06) shows **7 of them already touch this same file**
(2026-11-02, 10-31, 10-30, 10-27, 10-20, 10-17, 10-15) — real branch
contention on the exact file this finding would otherwise add an 8th
candidate to.

Tonight's candidate instead targets the **advisory pattern-store** bounded
context (`RuclipPatternNamespace`/`storePattern`/`PatternSearchResult`/
`searchPatterns`, DOMAIN-MODEL.md §2.4) — the smallest fully self-contained
context left (depends only on the already-exported `callTool` bridge
primitive, not on any of this file's private helpers), has **zero open
`dream/*` branches touching it**, and has **zero production call sites**
(only the test file imports it), so the extraction is provably zero-risk to
every real caller. Extracted into a new `store/pattern-store.ts`, re-exported
verbatim. `agentdb-adapter.ts`: 1483 → 1461 lines (net -22; the new module is
54 lines, slightly larger than the code it carries because of an explanatory
header, matching the operating-budget.ts precedent's own ratio). 327/327
tests pass unchanged, 0 regressions, 0 other files touched besides the two
store files.

## What's new

Nothing externally novel — this is the exact "extract a bounded context into
its own module" refactor this repo already established as a local convention
(`bridge-client.ts` was extracted from this same file for an analogous
reason, per that file's own header). What's new tonight is the **contention-
aware selection**: rather than re-proposing the same `operating-budget.ts`
extraction a third time, or adding an 8th open branch to an already-7-deep
pile on this file, this candidate is the one remaining bounded context that
is simultaneously (a) genuinely self-contained, (b) completely untouched by
any of the 27 most recent open `dream/*` branches, and (c) has no production
call sites to risk breaking.

## Competitors (graded)

| Competitor | Relevant to tonight's finding | Grade |
|---|---|---|
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | Node/React/TypeScript control plane (ADR-0001's own comparison target); public docs do not disclose internal module boundaries for its persistence layer, so no implementation-level architecture comparison is possible from docs alone. | C (single-source, unconfirmed at the implementation level) |
| Martin Fowler, *Refactoring* — "Extract Class"/"Extract Module" (behavior-preserving decomposition of a class/module with too many responsibilities) | Directly applicable, textbook justification for tonight's mechanical move: a module serving N unrelated bounded contexts should be split along those boundaries with zero behavior change, verified by an unchanged test suite. | A (reproducible — the precondition and postcondition are both checked directly against this repo's own real test suite, not cited secondhand) |
| This repo's own prior extraction, `bridge-client.ts` (cited in `agentdb-adapter.ts`'s own header, lines 94-98) | Internal precedent: `AgentDbBridgeError`/`callTool`/`AgentDbAdapterConfig` were already pulled out of this same file and re-exported verbatim for "a real circular-import failure... discovered at runtime, not by tsc." Establishes the re-export convention tonight's candidate reuses exactly. | A (reproducible — read directly from this repo's own source, not inferred) |
| CrewAI / AutoGen persistence layers (community docs/source skim) | Neither frameworks' built-in state/memory persistence is organized as a single adapter file touching every domain entity; both split storage backends (SQLite/Redis/vector-store adapters) from domain-specific call sites. Not a byte-for-byte comparison (different domain model) but corroborates that collapsing N bounded contexts into one adapter file is the architectural smell being corrected here, not an idiosyncratic ruClip-only judgment. | B (vendor/community docs, cross-checked across independent sources, not independently reproduced) |

## Hypothesis (frozen before implementation)

> Given ruClip's control-plane persistence layer, when the advisory
> pattern-store bounded context (`RuclipPatternNamespace`, `storePattern`,
> `PatternSearchResult`, `searchPatterns` — DOMAIN-MODEL.md §2.4) is
> extracted from `agentdb-adapter.ts` into a new single-responsibility module
> `store/pattern-store.ts` and re-exported verbatim from
> `agentdb-adapter.ts`, then `agentdb-adapter.ts` shrinks by one bounded
> context (~36 lines of code) with zero behavioral change, subject to: the
> full existing test suite (327/327) passing identically before and after,
> `tsc --strict` staying clean, and zero import-path changes required at any
> real call site (grep-confirmed: zero production call sites exist today;
> only `tests/control-plane/agentdb-adapter.test.ts` imports
> `storePattern`/`searchPatterns`, from the same `agentdb-adapter.js` path,
> unchanged).

Frozen before implementation; not modified after evaluation began.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), the repo's real, only test entrypoint. No model calls involved — `LLM_EVAL=not_applicable` (this is a mechanical, deterministic refactor, not a hypothesis requiring an LLM judge).

| | Tests | Pass | Fail | tsc --strict | Duration |
|---|---|---|---|---|---|
| Baseline (`6e73a8f060bcbb69965a50ffe4627e33622d4094`, parent, unmodified) | 327 | 327 | 0 | clean | 1361.70ms |
| Candidate (this branch) | 327 | 327 | 0 | clean | 1229.83ms |

`agentdb-adapter.ts`: 1483 → 1461 lines (-22 net; -34 code/+12 re-export+comment). New `pattern-store.ts`: +54 lines. `git diff --stat` against `src/`/`tests/` touches exactly one modified file plus one new file; `tests/` is untouched. Zero other call sites changed (grep-confirmed against the whole `src/`/`tests/` tree: only the pre-existing test file references `storePattern`/`searchPatterns`, and it imports from the unchanged `agentdb-adapter.js` path).

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (origin/main HEAD — confirmed via `git merge-base --is-ancestor`; main has not advanced since the 2026-09-06 security merge, consistent with the wider 0%-recent-merge-rate pattern already flagged by PR #92/#119 and not re-litigated here), evaluated on the real `npm test` entrypoint before any candidate code was written.

## Darwin Lineage

Not run — N/A, same reasoning as PR #9's precedent: a mechanical, zero-behavior-change extraction of one already-fully-defined code block has exactly one correct extraction, not a family of mutations to search over.

## Evidence

- OBSERVATION: `agentdb-adapter.ts` is 1483 lines across ~9 bounded contexts (grep-confirmed export list); 7 of the 27 most recently opened `dream/*` branches already touch this file; the pattern-store block (`storePattern`/`searchPatterns`) has zero production call sites and zero open-branch contention.
- MEASUREMENT: baseline 327/327 @ 1361.70ms; candidate 327/327 @ 1229.83ms; line-count deltas above; `git diff --stat` confirms exactly 1 modified + 1 new file.
- INFERENCE: the extraction is genuinely decoupled, not just relocated — the moved code's only external dependency is the already-exported `callTool`/`AgentDbAdapterConfig` bridge primitives, so no private helper had to be newly exported to support the move (unlike, e.g., the Autogenous-mutation-record or causal-edges contexts, which depend on this file's private `storeAtTier`/`recallByKey`/`graphNeighbors` helpers and would need a larger, more invasive candidate).
- DECISION: ACCEPT, recommended for human review.

## Reward-Hack Check

No test file touched (`tests/` is untouched by this diff), no gold answer/threshold/benchmark corpus modified, no new mock/cache introduced, no evaluator code touched. The pre-existing, independently-authored `storePattern`/`searchPatterns` tests in `tests/control-plane/agentdb-adapter.test.ts` ran unmodified against the new re-export path and passed. Independent adversarial self-check (separate pass from implementation): no unresolved signal — this is pure code motion with an unchanged public import surface.

## Security Review

Pure code-motion refactor in the persistence layer's advisory-pattern surface. No change to authorization guards (Guard A/B/C untouched), credential handling, `assertSafeId` usage, or the MCP/HTTP bridge call shape (`callTool` is invoked identically, just from a different file). No new dependency, no new network/filesystem scope, no new environment variable. The extracted namespace (`RuclipPatternNamespace`) stores non-secret advisory heuristic strings only — no PII/credential surface to reconsider.

## Scan: docs

`docs/dream-cycle/LEDGER.md` on `main` has not accumulated a new row since 2026-09-06, even though 27+ nightly dream-cycle runs have produced reports/branches since (`docs/dream-cycle/*-report.md` and the PR-history scan above) — every one of those nights' own ledger-row updates lives only on its own unmerged branch, so `main`'s copy is stale relative to the repo's real run history. This is a direct consequence of the already-known, by-design 0%-merge pattern (ADR-0001 itself documents that the upstream `ruvnet/dream-machine` engine "never merges — draft PRs only"), not a new defect — noted here as a docs-currency fact for the record, not re-raised as tonight's finding (already covered by PR #92/#119).

## Scan: api

`storePattern`/`searchPatterns` (DOMAIN-MODEL.md §2.4's advisory pattern-store) have **zero production call sites** anywhere in `src/` — the only consumer in the whole repo is the test file. The public surface exists and is tested but is not yet wired into any real org-chart/issue-template/approval-heuristic workflow described in DOMAIN-MODEL.md §2.4. Not tonight's candidate (wiring it up is a feature-scoped decision, not a bounded-context extraction), but flagged as a concrete next step below.

## Security Review (scan)

No security-sensitive findings in either scan surface tonight.

## Candidates considered (scored 1-5 each on fit/novelty/testability/measurability/production-value/reviewability; selected one)

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod value | Reviewability | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | **Extract pattern-store → `pattern-store.ts`** (selected) | 5 | 1 | 5 | 5 | 3 | 5 | Zero call sites, zero branch contention, zero private-helper leakage — smallest possible safe diff. |
| 2 | Extract Autogenous-mutation-record → new module | 4 | 1 | 4 | 4 | 3 | 3 | Depends on this file's *private* `storeAtTier`/`recallByKey` helpers — would require newly exporting generic internal primitives, a larger architectural call than a pure move. |
| 3 | Extract heartbeat-schedule block (~186 lines) | 3 | 1 | 4 | 4 | 4 | 2 | Larger diff; touched by 3 of the 7 contended open branches near this code — adds pile-up risk. |
| 4 | Extract approval-transition block (~300 lines, 3 functions) | 2 | 1 | 3 | 3 | 4 | 1 | Largest remaining context; `approval-gate.test.ts` already modified on an open 2026-10-20 branch — high collision risk, exceeds the "tiny" bias the 0-merge-rate learning signal calls for. |
| 5 | Re-attempt `operating-budget.ts` extraction (redo PR #9) | 1 | 1 | 5 | 5 | 3 | 5 | Would duplicate a result already recorded and independently evaluated (2026-09-02); PR #9 is closed/dirty, not a live candidate to improve — re-doing it adds nothing new. Rejected to avoid re-litigating a closed finding. |

Top-scored candidate (#1) was selected without override.

## Witness

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256: `62c13aba6e3a8fbc618b6a4f9e2b85d1006c5ab79f911180b026c1129df40145` (hash of this report's pre-witness-section draft)
- Witness stamp: `7678d7ede10119a69d9b41bff188c865e8f628270d23dd5c67ce18a0c1d2e6b1` (`sha256(report_sha256 + session_commit)`)
- Verifier procedure:
  1. The Report sha256 above is the hash of this report's content as drafted before this Witness section's values were filled in (self-referential-hash avoidance, same convention as the 2026-09-02 architecture night's PR #9) — it is not expected to match a hash of the final committed file, which includes this section.
  2. Confirm the PR's base/parent commit equals the Session commit above (`git merge-base <PR branch> main`).
  3. `printf '%s%s' <report-sha256> <session-commit> | sha256sum` → must equal the Witness stamp above.
  4. Re-run `npm test` on the parent commit, then on the PR branch — both must show 327/327 passing, matching the Evaluation Receipt table.
  5. `git diff --stat main <PR branch> -- src/ tests/` → must show exactly `agentdb-adapter.ts` (modified) and `pattern-store.ts` (new), matching the Evidence section.

## Recommendation

1. **Human action**: review and merge this PR (or explicitly reject it) — it is the smallest, lowest-risk candidate this routine has produced in the architecture slot, specifically chosen to not add to the existing 7-deep contention on `agentdb-adapter.ts`.
2. **Next step (not tonight)**: wire `storePattern`/`searchPatterns` into a real caller (org-chart pattern suggestions, issue-template matching, or approval-heuristic suggestions per DOMAIN-MODEL.md §2.4) — currently dead code outside tests.
3. **Next step (not tonight)**: once/if any currently-open `agentdb-adapter.ts`-touching PR merges, re-scan for the next safely-extractable bounded context (heartbeat-schedule or approval-transition) rather than re-proposing the already-closed operating-budget.ts move.
4. **Next step (not tonight, process-level)**: `docs/dream-cycle/LEDGER.md` on `main` is ~27 rows stale relative to actual run history, purely because no dream-cycle PR has merged since 2026-09-06. This is expected/by-design per ADR-0001's own description of the upstream engine, not a defect — but if the routine owner wants `main`'s ledger to stay current regardless of merge cadence, that would need a deliberate design change (e.g. a separate, always-merged ledger-append path) out of scope for this candidate.
