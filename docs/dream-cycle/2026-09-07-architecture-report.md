# Architecture SOTA Report — 2026-09-07

**Repo**: `ruvnet/ruClip` @ `5c3ea0d2bb450ccbbfb5b25bc06825388a705b9d`
**Rotation**: SLOT=2 → DEEP=architecture, SCAN=docs,api (2026-09-07, DAYINT%25=7, no bonus)

## TL;DR

`src/control-plane/store/agentdb-adapter.ts` is still the repo's God-module
(1483 lines at tonight's start — up from 1417 on 2026-09-02, because two
unrelated dream-cycle nights landed code in it since: the 09-03 performance
fan-out and the 09-05 graph-query field-shape fix). The 09-02 architecture
night extracted the operating-budget circuit breaker into its own module
(PR #9, ACCEPT, still awaiting human merge) and its own report's "Next
steps" named the pattern-store section as the next self-contained
candidate. Tonight does exactly that: `storePattern`/`searchPatterns`/
`RuclipPatternNamespace`/`PatternSearchResult` (~36 lines, zero dependency
on any other adapter-internal helper — only `callTool` from
`bridge-client.ts`) move to `store/pattern-store.ts`, re-exported for zero
call-site changes. This is deliberately the smallest defensible extraction
available, not the largest: see Ledger Check below for why.

## Ledger Check

Read `docs/dream-cycle/LEDGER.md` (4 distinct nights: 09-02 architecture,
09-03 performance ×2 rows [a duplicate/re-run], 09-05 correctness). Re-checked
fate of every associated issue/PR via GitHub MCP (`gh` CLI unavailable this
session too — `FALLBACK` applies only to gist publication, not issue/PR
tooling, which uses the authenticated GitHub MCP server):

| PR | Night | API state | Notes |
|---|---|---|---|
| #9 | 09-02 architecture | `state:open, merged:false` | Still awaiting human review, 5 nights later |
| #11 | 09-03 performance | `state:closed, merged:false` | Commit `5c3ea0d` is nonetheless on `main` — landed by a mechanism the PR-merge API doesn't record as a GitHub merge (manual apply outside this session's visibility) |
| #13 | 09-05 correctness | `state:closed, merged:false` | Same pattern as #11 — commit `7e889d0` is on `main` |
| #15 | 09-06 security | `state:open, merged:false` | Yesterday's night, not yet actioned, outside tonight's scope |

**Learning signal applied**: 0 of the 4 dream-cycle PRs opened to date show
`merged:true` via the GitHub API (even though 2 of the 4 findings did reach
`main` some other way). Per the routine's own learning-signal rule ("zero
of the last 14 candidate PRs merged → bias to a tiny, one-parameter,
easily-reviewable candidate"), tonight's candidate was chosen to be the
*smallest* remaining self-contained extraction (~36 lines) rather than the
next-largest one (`heartbeat-schedule`, ~180 lines, also named as a
candidate in the 09-02 report) — deliberately trading finding-size for
review-friction, in the hope that a trivially-reviewable diff breaks the
zero-merge streak. No finding has repeated in ≥3 prior nights (the God-module
finding has appeared in exactly 1 prior architecture night), so no
slot-rotation signal applies.

## Load Accumulated Evidence

- `docs/dream-cycle/2026-09-02-architecture-report.md` — the God-module
  diagnostic and the operating-budget extraction; its own "Next steps"
  section explicitly proposed tonight's candidate.
- `docs/adr/ADR-0001-ruclip-control-plane.md` — confirms ruClip's
  architecture is explicitly modeled on `paperclipai/paperclip`'s
  per-domain persistence split (§ Context / Decision point 3).
- `docs/design/DOMAIN-MODEL.md` §2.4 — pattern-store is documented as an
  advisory/optional secondary store, not a required hot path — consistent
  with tonight's finding (see Scan Findings — api) that it currently has
  no production call site, only tests.
- No committed benchmark corpus applies to a zero-behavior-change structural
  refactor (no `.harness/bench.json` targets this file's internals).

## Parallel Research

Deep dive: internal, evidence-driven (module decomposition of this actual
repo — line count × bounded-context count × re-import-surface, the same
diagnostic the 09-02 night established and recorded as reusable). External
research this session confirmed the diagnostic still holds against current
literature rather than re-deriving it from scratch:

| Source | Claim | Grade | Note |
|---|---|---|---|
| Industry survey roundup (2025-2026, multiple vendor blogs on the Strangler Fig pattern) | 2025-2026 consensus favors staying a modular monolith and extracting *selectively*, only when justified — a 2025 CNCF survey found 42% of orgs consolidating microservices back due to operational overhead | B | Multiple vendor blogs, cross-checked, no single primary source; directly supports tonight's restraint (file-level extraction inside one package, not a service split) |
| `paperclipai/paperclip` (`packages/db/src/schema/`) | ~100+ one-entity-per-file persistence modules, no monolithic data-access file | A | Re-confirmed this session (public GitHub, consistent with 09-02's own finding) |
| Brown et al., *AntiPatterns* (1998) | "God Class"/"Blob" antipattern + remedy (extract cohesive responsibilities) | A | Canonical text, already cited 09-02, re-applies unchanged |
| Fowler, *Refactoring* | "Large Class" smell → Extract Class, extraction candidates ranked by coupling, not size | A | Canonical text; directly informs tonight's "smallest self-contained slice first" choice over the larger heartbeat-schedule candidate |
| `paperclipai/paperclip` `doc/PRODUCT.md` | Confirms conceptual entity model (companies/org-charts/goals/issues, agent adapters) matches ruClip's; explicitly does not document file-level module boundaries (defers to SPEC.md/TASKS.md, not fetched this session — read-only competitor scope) | B | Official repo doc; conceptual-only, doesn't independently confirm code-level boundary claim beyond the schema-directory listing above |

5 candidate findings considered (1–5 scored on fit/novelty/testability/
measurability/production-value/reviewability, 1-5 each):

1. **Extract pattern-store from agentdb-adapter.ts** — fit 5, novelty 2
   (continues an established, already-ACCEPTed pattern), testability 5,
   measurability 5 (line count + test-count deltas are exact), production-value
   3, reviewability 5 (smallest available slice). **Selected.**
2. Extract heartbeat-schedule from agentdb-adapter.ts (~180 lines) — fit 5,
   novelty 2, testability 5, measurability 5, production-value 4,
   reviewability 3 (4-5x larger diff, and 0/4 prior dream-cycle PRs merged
   argues against a bigger ask tonight). Scored competitively but the
   zero-merge learning signal overrides it in favor of #1 (explicit
   override, per Step 3's own instruction to explain any override of the
   top score — #1 and #2 were near-tied on paper; reviewability under the
   current learning signal broke the tie).
3. Document-vs-code coupling fix (update the two `docs/design/*.md` files
   that cite `store/agentdb-adapter.ts` for `RuclipPatternNamespace`/
   `PatternSearchResult` to cite `store/pattern-store.ts` instead) — fit 3,
   novelty 1, testability 2 (no test can verify doc prose), measurability 2,
   production-value 2, reviewability 5. Rejected as tonight's DEEP finding
   (not independently testable/measurable per the promotion gate) but
   folded into the SCAN — docs section below instead of discarded.
4. Extract the causal-edge / graph-query section (`wouldCreateCycle`,
   `graphNeighbors`, `recordCausalEdge`, ~90 lines) — fit 4, novelty 2,
   testability 4, measurability 4, production-value 4, reviewability 2 (this
   section was just touched by the 09-05 correctness fix five nights ago;
   re-touching it this soon adds review risk without a fresh justification).
   Rejected — held for a future night once #13 (09-05) has had time to be
   reviewed on `main`.
5. Add a `docs/adr/` entry formalizing "extract-and-re-export" as the
   repo's standing decomposition convention for this file — fit 3, novelty
   2, testability 1 (an ADR is not falsifiable/measurable), measurability 1,
   production-value 3, reviewability 4. Rejected per Step 19's own rule:
   ADRs are for architectural *decisions*, and this convention was already
   established and used twice (bridge-client.ts, then operating-budget.ts)
   before tonight without a formal ADR — codifying it now would be
   after-the-fact documentation of an already-settled pattern, not a new
   decision. Recorded as a documentation, not a decision.

## Hypothesis (frozen before implementation)

> Given ruClip's control-plane persistence layer, when the pattern-store
> section (`RuclipPatternNamespace`, `storePattern`, `PatternSearchResult`,
> `searchPatterns`) is extracted from `agentdb-adapter.ts` into a new
> single-responsibility module `store/pattern-store.ts` and re-exported
> from `agentdb-adapter.ts`, then `agentdb-adapter.ts` shrinks by one
> bounded context with zero behavioral change, subject to: the full
> existing test suite (321 tests, including the 2 dedicated
> `storePattern`/`searchPatterns` tests in
> `tests/control-plane/agentdb-adapter.test.ts`) passing identically before
> and after, `tsc --strict` staying clean, and zero import-path changes
> required anywhere else in `src/` or `tests/` (grep-confirmed: no
> production call site outside `agentdb-adapter.ts` itself imports these
> four names today).

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), run on Node v22.22.2.

- **Baseline** (parent `5c3ea0d2bb450ccbbfb5b25bc06825388a705b9d`, `main`
  tip): 321 tests, 321 pass, 0 fail, `tsc --strict` clean, 1567.08ms.
- **Candidate** (branch `dream/2026-09-07-architecture`): 321 tests, 321
  pass, 0 fail, `tsc --strict` clean, 1582.74ms. Identical test count and
  pass rate — zero behavioral change, exactly as the hypothesis predicted.
- **Diff shape**: `git diff --stat origin/main` → 2 files changed, 61
  insertions(+), 35 deletions(-): `agentdb-adapter.ts` 1483 → 1459 lines
  (net -24, one bounded context removed, replaced by an 8-line re-export
  block); new `store/pattern-store.ts` +50 lines (code + header comment).
  **Zero other files touched** — no call site anywhere in `src/` or
  `tests/` needed an import-path change, confirmed by grep before and after.

## Darwin Results

Not run. As with the 09-02 precedent this candidate has no fitness
landscape to search — there is exactly one correct extraction of a
self-contained, already-fully-specified code block (move these 4 exports,
change nothing else), not a family of mutations. Recorded as N/A rather
than skipped silently.

## Evidence

- OBSERVATION: `agentdb-adapter.ts` is 1483 lines pre-change (grew +66
  lines since 09-02 from two unrelated dream-cycle commits); pattern-store
  section is 36 lines with a single external dependency (`callTool` from
  `bridge-client.ts`).
- MEASUREMENT: baseline 321/321 @ 1567.08ms; candidate 321/321 @
  1582.74ms; `agentdb-adapter.ts` 1483→1459 lines; `pattern-store.ts` +50
  lines; diff touches exactly 2 files.
- INFERENCE: the extraction is genuinely decoupled (not merely relocated),
  because zero call sites outside the two files in the diff needed any
  change — matching the same evidence shape the 09-02 extraction produced.
- DECISION: ACCEPT, recommended for human review (not self-promoted; see
  Merge Policy in the PR).

## Reward-Hack Check (independent critic pass, distinct from implementation)

- No test file is in the diff (`git diff --stat` above lists only the two
  `src/` files) — the 2 pre-existing, independently-authored
  `storePattern`/`searchPatterns` tests ran unmodified against the new
  module path and passed. That is the actual regression check for this
  refactor, not an incidental one.
- No gold answer, threshold, benchmark corpus, or `.harness/bench.json`
  entry was touched (none exists for this file's internals).
- No new mock, cache, or test double was introduced.
- No re-export was silently dropped or renamed — `type RuclipPatternNamespace`,
  `type PatternSearchResult`, `storePattern`, `searchPatterns` are the exact
  four names both before and after, confirmed by re-running the dedicated
  tests (which import these exact names from `agentdb-adapter.js`, not from
  the new module) unmodified.
- Corpus/gold-data freshness: N/A, no corpus consumed.
- **Unresolved signal**: none found. Critic clear.

## Security Review

Pure code-motion refactor inside the persistence layer. No security-sensitive
surface touched: no authorization guard (Guard A/B/C in `persistIssue`/
`applyApprovalTransition`), credential path (`ActorCredential`,
`HumanIdentityAttestation`), `assertSafeId` call site, filesystem/network
scope, or MCP tool surface changed. No new dependency added — the new
module imports only `callTool`/`AgentDbAdapterConfig` from the same
`bridge-client.ts` every other adapter section already depends on.
Least-privilege posture unchanged. Not security-sensitive enough to warrant
a dedicated threat-model pass beyond this note.

## Scan Findings — docs

Two design docs cite `RuclipPatternNamespace`/`PatternSearchResult` as
living in `store/agentdb-adapter.ts`: `docs/design/EMPLOYEE-INTERACTION-PROFILE.md:47`
and `docs/design/AUTHORIZATION.md:299`. Because the re-export keeps
`agentdb-adapter.ts` a valid import path for both names, these citations
remain technically accurate (that's still where you'd import them from) but
now describe the re-export location, not the definition site — same
treatment the 09-02 night gave its own 8 dependent docs ("None needed edits
... a future doc pass should [update citations] once more extractions
land"). Not fixed tonight (candidate 3 above, rejected as the DEEP finding
for not being independently testable); flagged as accumulating documentation
debt: 3 extractions in (bridge-client, operating-budget, pattern-store),
every dependent doc still points at the pre-extraction location. Recommend
a dedicated docs-only pass once `heartbeat-schedule` is also extracted,
rather than one doc-edit per code extraction.

## Scan Findings — api

Grep-confirmed (`src/`, before and after the change): **no production call
site anywhere in `src/` invokes `storePattern` or `searchPatterns` today** —
only the two dedicated tests exercise them. This matches
`docs/design/DOMAIN-MODEL.md` §2.4's own framing of the pattern-store as an
"advisory secondary store", not a required hot path, so this is not a
defect — but it means tonight's refactor's real-world risk is lower than
the operating-budget extraction (which had 3 confirmed live call sites) and
its practical value is also lower until something calls it. No dead export
outside this — `storePattern`/`searchPatterns`/`RuclipPatternNamespace`/
`PatternSearchResult` are all exported for a reason external code will
presumably use later (per DOMAIN-MODEL.md's design intent), not orphaned.

## Competitors (paperclipai/paperclip and others)

| Project | Persistence-layer shape | Grade | Note |
|---|---|---|---|
| paperclipai/paperclip | Per-domain, one-entity-per-file (`packages/db/src/schema/companies.ts`, `issues.ts`, `budget_policies.ts`, `cost_events.ts`, ...); no monolithic data-access file | A | Re-confirmed this session via public GitHub, consistent with 09-02's finding |
| Industry Strangler Fig consensus, 2025-2026 | Extract selectively, smallest reviewable slice first; stay a modular monolith unless a service boundary is actually justified | B | Multiple vendor sources, cross-checked, directly supports tonight's "smallest slice" choice over the larger heartbeat-schedule candidate |
| Khomh et al., *Empir. Softw. Eng.* 17 (2012) | Blob/God-Class-participating classes have measurably higher change/fault odds across 54 releases (ArgoUML/Eclipse/Mylyn/Rhino) | A | Peer-reviewed empirical study, cited unchanged from 09-02 — still the primary empirical justification for treating this file's size as a real risk, not just an aesthetic one |

## Gist

No gist-creation tool is available in this session's toolset (no `gh` CLI,
no MCP gist tool — same as every prior dream-cycle night this repo has
run). The full SOTA report is committed at
`docs/dream-cycle/2026-09-07-architecture-report.md` on branch
`dream/2026-09-07-architecture` instead — durable, versioned, reviewable in
the PR diff. `GIST=LOCAL`.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not
including) the line `## Witness` above — i.e. delete this section and
everything after it, then hash what remains. This avoids the
self-referential-hash problem a hash cannot include itself (the exact bug
the 09-02 night's own witness had to correct after the fact — see issue #8
comment).

- Session commit (parent): `5c3ea0d2bb450ccbbfb5b25bc06825388a705b9d`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `4209621016c78aef6346048e821cb7d4db5e3f9d4b9f28bf376c06236743033b`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `42457282a4acff8840c09fb049dcde96909e2ddd939751cf49adea2c807912c1`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 5c3ea0d2bb450ccbbfb5b25bc06825388a705b9d --stat` — confirm this
   is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-09-07-architecture-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 5c3ea0d2bb450ccbbfb5b25bc06825388a705b9d | sha256sum` —
   confirm it matches the Witness stamp recorded in the ledger/issue/PR.
4. `git checkout 5c3ea0d2bb450ccbbfb5b25bc06825388a705b9d -- . && npm ci && npm test` —
   confirm 321/321 pass (baseline receipt).
5. `git checkout dream/2026-09-07-architecture -- . && npm test` — confirm
   321/321 pass, `agentdb-adapter.ts` is 1459 lines, `pattern-store.ts`
   exists at 50 lines, and `git diff origin/main -- src/ tests/ --stat`
   touches exactly two files (one modified, one new).

## Recommendation

`evaluated: accepted`. Human review recommended for the draft PR — this
session never self-merges. Suggested follow-up architecture nights, in
order: (1) resolve the docs-debt noted above once one more extraction
lands, (2) extract `heartbeat-schedule` (~180 lines) next, now the largest
remaining self-contained context after this and the operating-budget
extraction, (3) hold the causal-edge/graph-query section (touched 5 nights
ago by #13) for a future night, (4) separately: escalate to the routine
owner that PR #9 (09-02) is still unreviewed after 5 nights and PR #15
(09-06, security) is unreviewed after 1 night — the zero-merge streak this
report worked around is a human-review bottleneck, not an evidence-quality
one, and no candidate-size adjustment on this session's side will fix it.
