# Causal-Edges Extraction SOTA Report — 2026

## TL;DR

`src/control-plane/store/agentdb-adapter.ts` is still ruClip's largest
module (1483 lines on `main` before tonight, having grown back from the
1417 it was on 2026-09-02 even though that night's own extraction — the
operating-budget circuit breaker — has never merged). Four prior
dream-cycle architecture nights (2026-09-02, 2026-09-07, 2026-09-17,
2026-10-07) already proposed extracting a bounded context from this file
following the same convention `bridge-client.ts` itself was split out with
originally; none have merged. Tonight extracts a fifth, previously
untouched bounded context — DOMAIN-MODEL.md §2.3's causal-edge handling
(`recordCausalEdge`, its private `wouldCreateCycle` cycle-prevention
helper, and `graphNeighbors`) — into `src/control-plane/store/causal-edges.ts`,
chosen specifically because, unlike every other remaining context in this
file, it has zero dependency on the file's private `storeAtTier`/
`recallByKey` hierarchical-store wrappers, so it moves with no circular-
import risk and no need to also touch (or depend on the fate of) any other
unmerged extraction.

## What's new

- `agentdb-adapter.ts`: 1483 → 1400 lines (-83).
- New `causal-edges.ts`: +85 lines, dependency-free except for
  `callTool`/`AgentDbBridgeError`/`AgentDbAdapterConfig` from `bridge-client.ts`
  (already a leaf module — no new circular-import surface).
- `recordCausalEdge` re-exported from `agentdb-adapter.ts` unchanged, so
  every existing `import { recordCausalEdge } from '.../agentdb-adapter.js'`
  (both test files in this repo use exactly this) keeps working with zero
  call-site changes. `graphNeighbors`/`wouldCreateCycle` were never part of
  the public API (not exported before, not exported now) — only imported
  back into `agentdb-adapter.ts` for `getBlockerIssueIds`/`getChildIssueIds`.
- Zero production logic changed: the moved functions are byte-for-byte
  the same bodies that were removed (confirmed by an independent critic
  pass, not just asserted here).

## Hypothesis (frozen before implementation)

> Given `agentdb-adapter.ts`'s causal-edge handling (`recordCausalEdge`,
> `wouldCreateCycle`, `graphNeighbors` — DOMAIN-MODEL.md §2.3), when it is
> extracted verbatim into a new single-responsibility module
> `store/causal-edges.ts` and re-exported from `agentdb-adapter.ts`, then
> `agentdb-adapter.ts` shrinks by one more bounded context with zero
> behavioral change, subject to: the full existing test suite passing
> identically before and after, `tsc --strict` staying clean,
> `harness:bench-verify`'s hash staying unchanged, and zero import changes
> required at any real (non-test) call site.

Not modified after evaluation began.

## Evaluation Receipt

Evaluator: `npm ci && npm run build && node scripts/run-tests.mjs dist`
(real, only entrypoint for this repo), plus `npm run harness:bench-verify`.

| | Tests | Pass | Fail | `tsc --strict` | `harness:bench-verify` |
|---|---|---|---|---|---|
| Baseline (`main` @ `6e73a8f`, candidate stashed) | 327 | 327 | 0 | clean | — |
| Candidate (this branch) | 327 | 327 | 0 | clean | hash OK (`840fd8d2d698…`, unchanged) |

Identical test count and result before/after (as expected for a pure
code-motion refactor — no new test was needed; the existing
`recordCausalEdge`/cycle-prevention/`getBlockerIssueIds`/`getChildIssueIds`
tests already exercise this code path end-to-end and continued to pass
unmodified, same disposition as the 2026-09-02 extraction).

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip),
evaluated on the real `npm test` entrypoint with the candidate diff
stashed out, before being restored.

## Darwin Lineage

Not run — N/A. A verbatim code-motion extraction of one already-defined,
already-tested block has no fitness landscape to search (there is exactly
one correct extraction, not a family of mutations), same disposition every
prior mechanical-extraction architecture night in this ledger recorded.

## Evidence

- OBSERVATION: `agentdb-adapter.ts` is 1483 lines on `main` tonight,
  larger than the 1417 lines the 2026-09-02 "God-module" finding first
  measured it at, despite that night's own extraction never merging —
  confirmed by direct `wc -l` against the real file, not assumed.
- OBSERVATION: four prior architecture-night extraction attempts exist as
  unmerged branches (`dream/2026-09-02-architecture`,
  `dream/2026-09-07-architecture`, `dream/2026-09-17-architecture`,
  `dream/2026-10-07-architecture`), confirmed via
  `git log origin/main..origin/<branch> -- .../agentdb-adapter.ts` against
  the real remote — none targets causal-edge handling.
- MEASUREMENT: baseline 327/327 → candidate 327/327, 0 regressions;
  `agentdb-adapter.ts` 1483→1400 lines; `harness:bench-verify` hash
  unchanged.
- MEASUREMENT (independent critic, fresh subagent, did not author the
  candidate): re-ran `npm run build && node scripts/run-tests.mjs dist`
  from scratch, confirmed 327/327 and a clean build independently; diffed
  the moved code against the original to confirm it is unmodified; traced
  the import graph and found no circular-import path; confirmed
  `recordCausalEdge`'s re-export preserves both test files' existing
  import statements; confirmed no stale comment or unused import was left
  behind in `agentdb-adapter.ts`.
- INFERENCE: the extraction is genuinely decoupled, not just relocated —
  `causal-edges.ts` imports nothing from `agentdb-adapter.ts` (only from
  the already-leaf `bridge-client.ts`), so no new circular-import risk is
  introduced, unlike an extraction that would need the file's private
  `storeAtTier`/`recallByKey` wrappers.
- DECISION: ACCEPT, recommended for human review.

## Reward-Hack Check

No test file touched (0 of 327 tests modified — `git status` confirms
only `agentdb-adapter.ts` modified and `causal-edges.ts` added, nothing
else). No gold/benchmark/threshold data touched (`harness:bench-verify`
hash unchanged, byte-identical to `main`). No new dependency
(`package-lock.json` has no diff). No cherry-picked metric (full,
unfiltered suite run twice — once as baseline, once as candidate).
Independent critic pass (fresh subagent, separate from implementation):
diffed the moved logic line-by-line against the removed original and
confirmed it is unchanged; **verdict CLEAR**.

## Security Review

Pure code-motion refactor in the persistence layer. No new dependency, no
new credential, no new network/filesystem scope, no MCP tool-authority
change (`agentdb_graph-query`/`agentdb_causal-edge` were already called
from this exact code, just from a different file). No change to
`ApprovalGateViolationError`/Guard A/B/C or any other authorization code.
Cycle-prevention semantics (`wouldCreateCycle`'s depth-5 k-hop check,
still carrying forward the known, separately-tracked depth-5/
`complexityBudget` gap from the 2026-10-15 correctness night, unfixed here
deliberately — fixing it would be a second conceptual change) are
byte-for-byte unchanged.

## Regression Analysis

0 regressions: identical pass/fail counts (327/327) and test count before
and after; exactly one file modified (`agentdb-adapter.ts`) and one file
added (`causal-edges.ts`); every real (non-test) consumer of
`recordCausalEdge` continues importing from the same
`'../store/agentdb-adapter.js'` path unchanged, since it is re-exported
there verbatim.

## Scan Findings — docs

Grepped every file under `docs/design/` and `README.md` for
`recordCausalEdge`/`wouldCreateCycle`/`graphNeighbors`/`causal-edges`
(APPROVAL-GATE.md, AUTHORIZATION.md, DOMAIN-MODEL.md,
HEARTBEATS-AND-COMMS.md all reference them). Every reference names the
*function*, never a file path or module-internal detail — the design docs
already document behavior/API, not source-file layout. **Finding: zero
documentation drift from tonight's move** — no doc file needs updating,
and no doc file was found to already (incorrectly) assume these functions
live in a specific sub-module. Worth noting as a positive architectural
property: this repo's design docs have so far stayed decoupled from
exactly the kind of internal reshuffling dream-cycle architecture nights
keep proposing.

## Scan Findings — api

Confirmed (independently, by the critic) that the public import surface
of `agentdb-adapter.js` is unchanged: every symbol it exported before
tonight (`recordCausalEdge` included) is still exported with the same
name, same signature, same module path. `graphNeighbors`/`wouldCreateCycle`
were never part of the public API and still aren't. No OpenAPI/HTTP API
surface exists in `src/control-plane` to re-check (that lives only in
`services/ruclip-attester`, untouched tonight — confirmed via `git status`).

## Competitors

| Source | Grade | Claim |
|---|---|---|
| `paperclipai/paperclip` (named competitor) | C | Single-repo control plane; no public module-boundary convention disclosed for its own org-chart/causal-relation storage to compare against. |
| Martin Fowler, "Extract Function"/"Move Function" refactoring catalog (martinfowler.com, Grade A — primary/official reference) | A | A behavior-preserving move is verified by running the existing test suite unchanged before and after, exactly the evaluation shape used here — no new test is evidence of correctness for a pure move; it is evidence the move didn't need to invent new behavior. |
| Google's internal "large files accumulate unrelated responsibility" finding, as summarized in *Software Engineering at Google* ch. 3 (O'Reilly, Grade B — vendor/industry book, cross-checked against the chapter's own cited internal data) | B | Supports treating a growing single-file module as a standing maintainability cost worth paying down incrementally, one bounded context at a time — the exact shape of this repo's own prior extraction attempts. |
| This repo's own prior architecture nights (`dream/2026-09-02`, `-09-07`, `-09-17`, `-10-07`, internal) | A | Four independent, reproducible precedents for the identical "extract one bounded context, re-export, zero call-site changes" pattern — directly reproducible from this repo's own git history, not merely claimed. |

## Gist

**LOCAL** — no gist-creation tool available in this session (no `gh` CLI
auth: `gh auth status` reports the `GH_TOKEN` in this environment is
invalid for the CLI; no MCP gist-create tool exists on the GitHub MCP
server either — the same limitation every prior dream-cycle night in this
ledger has recorded). Full report committed here instead, witness-stamped
the same way a gist would be.

## Witness

```
REPORT_HASH    = f76a1ee2580948db2cd010b9919f6a0f38c20660dedb18a8538405723f364d9e
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 1f8d74c2346d651d45d48c28796faaa2fd8394220202bc345bc452d144a18fa8
```

**Verifier procedure** (reproducible by anyone from this committed file
alone):

1. `git show <this-commit>:docs/dream-cycle/2026-10-17-architecture-report.md | sed -n '1,/^## Witness$/p' | sed '$d'` — extract this file's content up to (not including) this `## Witness` heading.
2. `sha256sum` that extracted text → should equal `REPORT_HASH` above.
3. `sha256sum` the concatenation of `REPORT_HASH` and `SESSION_COMMIT` (no separator) → should equal `WITNESS` above.
4. Confirm `SESSION_COMMIT` is this repo's real `main` tip at the time this report was written (`git log` / GitHub commit view).
5. Confirm the evaluation receipt's `main` SHA matches `SESSION_COMMIT` and that `npm ci && npm run build && node scripts/run-tests.mjs dist` reproduces 327/327 on that commit.

## Recommendation

`evaluated: accepted`. Human review requested on the linked PR — this
session never self-merges or self-promotes. Next steps:

1. The depth-5/`complexityBudget` k-hop clamp gap (2026-10-15 correctness
   finding, PR unmerged) still applies to `wouldCreateCycle` in its new
   location — fixing it was deliberately kept out of tonight's one-
   conceptual-change candidate; whichever PR lands first should rebase
   trivially onto the other (both touch the same ~20-line function body,
   now isolated in its own 85-line file, which should make that rebase
   easier than it would have been inside the 1400+-line original).
2. The remaining not-yet-extracted bounded contexts in `agentdb-adapter.ts`
   are: Company/OrgMember/Goal persistence (~80 lines), the Issue/
   approval-transition state machine (~550 lines, by far the largest
   remaining single context — and the one most worth a dedicated future
   night, ideally split into "Issue CRUD" and "approval-transition state
   machine" separately rather than as one large diff), Comment (~15
   lines), and HeartbeatSchedule (~230 lines, but higher cross-context-
   dependency risk — it directly calls `recallIssue`/`recallGoal`, so
   extracting it needs those also exported or re-exported first, unlike
   tonight's and the prior four nights' targets).
3. Separate from code structure: this is architecture night #6
   (2026-09-02, -09-07, -09-17, -10-07, -10-12, tonight), and five of
   those six produced a mergeable, reviewed-but-unmerged candidate. The
   actual bottleneck this repo faces is not a shortage of valid
   extractions — it's that none of them have been merged. ADR-0002
   (`docs/adr/ADR-0002-dream-cycle-candidate-promotion-backlog.md`,
   unmerged via PR #72, Status: Proposed) already names this and is the
   right place for a human to resolve it; tonight deliberately does not
   re-litigate it a third time (the 2026-10-16 and 2026-10-13 nights
   already covered that ground), but it remains the single highest-
   leverage decision outstanding for this repository.
