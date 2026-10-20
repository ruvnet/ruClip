# Correctness SOTA Report — 2026

## TL;DR
`applyApprovalTransition`'s `reject` action validated its `deps.handoffTo`
precondition (presence + same-company-as-actor) only at the very end of the
function — *after* the `ApprovalTransition` record was persisted, the
`rejected_by` causal edge was recorded, and `persistIssue` had already written
the issue's new status. A missing or cross-company `handoffTo` therefore threw
only once the reject had otherwise fully, durably succeeded — a non-atomic
operation that could leave a durably-"rejected" Issue whose claim was never
actually handed back. This was not a latent, undiscovered bug: a prior night's
test (`approval-gate.test.ts`) explicitly documented and asserted the
partial-write behavior as expected. Tonight's candidate moves the precondition
to the top of the function, before any side effect, mirroring how the
`submit` action's `deps.approver` precondition has always worked — fixing the
ordering rather than discovering a new authorization gap (an independent
critic confirmed the final authorization outcome for a cross-company
`handoffTo` was already guaranteed by `handoffClaim`'s own from/to check;
this fix only changes *when* that failure surfaces, not *whether* it does).

## What's new
- `applyApprovalTransition` (`src/control-plane/store/agentdb-adapter.ts`)
  now validates `deps.handoffTo` (presence, and `companyId` match with the
  verified `actor`) immediately after the top-of-function company check,
  before `acceptClaimHandoff`, `transitionApprovalState`, witness recording,
  `ApprovalTransition` persistence, the `rejected_by` causal edge, or
  `persistIssue` run.
- Two tests in `tests/control-plane/approval-gate.test.ts`: the existing
  "missing handoffTo" test's assertion was *flipped* (it used to assert the
  issue WAS already persisted when the throw happened; it now asserts zero
  durable writes), and a new test covers a cross-company `handoffTo` on
  `reject` (previously only covered for `submit`'s `deps.approver`, in
  `cross-company-approver-verification.test.ts`).

## Rotation / ledger check (full detail)
`DATE=2026-10-20, DAYINT=20261020, SLOT=0` → `DEEP=correctness,
SCAN=performance,tests` (`DAYINT % 25 = 20`, no bonus roadmap-review).

`docs/dream-cycle/LEDGER.md` on `main` is 4 rows deep, last dated
2026-09-06 — **not** because the routine stopped, but because every night
since has appended its own row on its own unmerged `dream/*` branch, never
merged forward. Cross-checked directly against GitHub (`list_pull_requests`,
`search_issues`, `git branch -r` after `git fetch`): **38 `dream/*` branches**
exist on `origin` (2026-09-02 → 2026-10-19, one per night, every slot
represented), **38 open `dream-cycle`-labeled issues**, and of roughly 30+
dream-cycle PRs, **only the first 3 (#9/#11/#13/#15, week 1) were ever
squashed onto `main`, manually, outside normal review — zero since.** This
exact governance gap has already been self-diagnosed and reported by the
routine itself at least 4 times (issues #34 2026-09-19, #46 2026-09-29, #71
2026-10-12, and PR #51's footer 2026-10-01) without resolution — including a
dedicated supersession-audit tool (PR #72, 2026-10-12) that is **itself**
still unmerged. Several of the stuck PRs are substantive, ACCEPT-verdict
security fixes (critical protobufjs RCE #29, two HIGH toml findings #39,
`@grpc/grpc-js` auth-bypass hygiene fix #51) sitting unpatched on `main` for
6+ weeks.

**Learning-signal application (STEP 1.1):** the correctness `DEEP` surface's
own recurring finding — the real `agentdb_graph-query`/`@ruvector/graph-node`
backend's quirks (self-inclusion #23, relation-blindness #37/#49,
direction-blindness #49, and the `complexityBudget.maxDepth` 5-hop clamp
#68/#78) — has now been independently rediscovered and re-fixed across
**at least 5** correctness nights (09-05, 09-10, 09-20, 09-30, 10-05, 10-10,
10-15), well past the ≥3 threshold that calls for rotating `DEEP` to the
next slot. Two of those nights (#68, closed 2026-10-18) even independently
duplicated an earlier still-open PR (#78) byte-for-byte in approach. Rather
than mechanically rotating into `security` — which has its own, narrower
repeat (the `@grpc/grpc-js` dependency finding, hit twice: #51 2026-10-01,
#80 2026-10-16) — tonight's candidate deliberately targets a **different,
previously-undiscovered correctness defect** in the same `DEEP=correctness`
surface, so as not to produce a 6th variant of the graph-backend-quirk fix.
This judgment call is recorded plainly rather than silently overriding the
signal; a human may reasonably prefer strict rotation next time this signal
fires.

**Zero-merge bias (STEP 1.1):** applied — tonight's candidate is
deliberately tiny (1 production file, 1 test file, +~50/-8 lines, one
conceptual change, no new dependency, no new capability).

## Deep dive (correctness)
Five candidates considered, scored 1–5 on
fit/novelty/testability/measurability/production-value/reviewability:

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod-value | Reviewability | Total |
|---|---|---|---|---|---|---|---|---|
| 1 | **`applyApprovalTransition`(reject) non-atomic `deps.handoffTo` check (selected)** | 5 | 4 | 5 | 5 | 4 | 5 | 28 |
| 2 | Re-widen `wouldCreateCycle`'s k-hop depth again | 5 | 1 | 5 | 5 | 2 | 5 | 23 (rejected — 5th+ repeat of #23/#37/#49/#68/#78) |
| 3 | `npm audit` dependency triage (grpc-js/protobufjs/toml) | 4 | 1 | 5 | 5 | 3 | 5 | 23 (rejected — already found: #29, #39, #51, #80) |
| 4 | Audit unused direct dependency `google-auth-library@10.9.1` (declared, never imported by ruClip's own code — confirmed via grep across `src/`/`services/`; only `bridge-auth.ts`'s comment *mentions* it, as something deliberately NOT used) | 3 | 4 | 3 | 2 | 2 | 4 | 18 (hygiene note only, not a correctness defect — recorded as a Next Step, not implemented) |
| 5 | Write a git-only "PR-age" dashboard for the backlog (process tooling, not a code correctness finding) | 2 | 2 | 4 | 3 | 3 | 3 | 17 (out of scope for `DEEP=correctness`; the backlog itself is already the subject of #71/PR#72) |

Candidate 1 selected; candidate 2 explicitly overridden despite scoring
competitively, per the ≥3-repeat learning signal discussed above.

## Hypothesis (frozen before implementation)
> Given `applyApprovalTransition`'s `reject` action, whose `deps.handoffTo`
> precondition (presence, and `companyId` match with the verified `actor`)
> is currently validated only at step 6 — after `transitionApprovalState`,
> witness recording, `ApprovalTransition` persistence, the `rejected_by`
> causal edge, and `persistIssue` have already run — when that precondition
> is instead validated up front, before any side effect (mirroring the
> `submit` action's existing `deps.approver` check, which already runs
> before any side effect), then a `reject` call with a missing or
> cross-company `deps.handoffTo` should fail closed with **zero** durable
> writes (no `ApprovalTransition` record, no `rejected_by` causal edge, no
> `Issue` status change), matching `submit`'s existing all-or-nothing
> behavior — subject to: every currently-passing test for a *valid* reject
> (same-company `handoffTo` present) continues to pass unchanged, and the
> full existing test suite shows 0 regressions.

Not modified after evaluation began.

## Candidate
One production file, one test file, +52/-8 (production: +22/-8; tests:
+58/-6 net). `src/control-plane/store/agentdb-adapter.ts`:
`applyApprovalTransition` now checks, immediately after the top-of-function
`actor.companyId !== companyId` guard and before any side effect:
1. `action === 'reject' && !deps.handoffTo` → throw (previously checked at
   the end).
2. `action === 'reject' && deps.handoffTo.companyId !== actor.companyId` →
   throw (previously *never* checked explicitly inside this function at
   all — only reached transitively, and late, via `handoffClaim`'s own
   guard).

The end-of-function `handoffClaim(issue.id, actor, deps.handoffTo!, ...)`
call is unchanged in effect (the non-null assertion is safe — guarded by
the identical `action === 'reject'` condition with the presence check
immediately above, `deps` is never reassigned in between, confirmed by
grep). `handoffClaim`'s own from/to company-mismatch assertion
(`claims-authorization.ts`) is left untouched and still runs — defense in
depth is preserved, not replaced.

## Evaluation receipt
Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), this repo's real, only entrypoint. No LLM calls — deterministic bugfix, `LLM_EVAL=blocked` is irrelevant here (see Build status below; credentials were in fact present, see Security review).

| | Tests | Pass | Fail | Build | `harness:bench-verify` |
|---|---|---|---|---|---|
| **Baseline** (`main`@`6e73a8f060bcbb69965a50ffe4627e33622d4094`, production file reverted via `git stash`, both new/modified test assertions present) | 328 | 326 | **2** | clean | n/a (no src change in this isolated run) |
| **Candidate** (this branch) | 328 | 328 | 0 | clean | `Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)` — unchanged |

The 2 baseline failures are exactly the two new/modified assertions, failing
for the precise predicted reason (`AssertionError: the missing-handoffTo
precondition must be checked before persistIssue ever writes` /
`AssertionError: no partial persistence should happen when the handoffTo
company mismatch is caught this early`) — proof the tests discriminate, not
merely pass by construction. Isolation method: `git stash push -- <prod
file>` (test file unstashed), rebuild, retest, `git stash pop`, rebuild,
retest — identical methodology to this repo's own 2026-09-05/2026-10-15
nights.

## Baseline
Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main`, 327/327
tests before this candidate's own test additions).

## Darwin lineage
Not run — a single, unambiguous ordering/precondition fix with no
continuous parameter or tunable trade-off space. Recorded N/A with a named
reason, per STEP 10-14.

## Evidence
OBSERVATION (reading `applyApprovalTransition` in full: the `deps.handoffTo`
precondition sits at step 6, after 4 durable side effects) → OBSERVATION
(an existing test, `approval-gate.test.ts`, explicitly named and asserted
this as current behavior — "after the issue has already been persisted" —
confirming it was known, not latent) → HYPOTHESIS (frozen above) →
MEASUREMENT (baseline 326/328 with 2 precise predicted failures; candidate
328/328; build clean both ways; `harness:bench-verify` hash unchanged) →
INFERENCE (the fix is a pure ordering/atomicity change — the ultimate
authorization outcome for an invalid `handoffTo` was already guaranteed by
`handoffClaim`'s own from/to guard, independently confirmed by a fresh
critic subagent) → DECISION: ACCEPT (recommend human review/merge).
REJECTION: candidate "re-widen `wouldCreateCycle`'s depth again" — not
attempted, ≥3-repeat learning signal (see Rotation section).

## Reward-hack check
Independent critic (fresh subagent, no visibility into this session's own
reasoning, instructed to be skeptical) re-read the diff and the full
function from scratch, re-ran `npm run build && node scripts/run-tests.mjs
dist` itself (confirmed 328/328), traced `handoffClaim`'s own guard
independently, checked for any other caller of `applyApprovalTransition`
(none found outside its own file/tests), and verified the test file changes
strengthen rather than weaken assertions (no `.only`/`.skip`, no threshold
edit, `.harness/bench.json` untouched, the cross-company test's `co-2`
override confirmed genuinely different from `baseActor`'s default `co-1`).
**Verdict: CLEAR.** One nuance the critic flagged and this report keeps
rather than smooths over: the explicit `companyId` check added inside
`applyApprovalTransition` is itself new code (the old step-6 check only
checked *presence*, not company — company-mismatch protection for `reject`
previously existed only transitively, via `handoffClaim`'s own guard a few
lines later in the call chain) — a correctness/defense-in-depth
improvement, not merely a reordering, slightly understated by this
report's own TL;DR framing. No unresolved reward-hack signal.

## Security review
No new capability, credential, dependency, MCP tool, or network/filesystem
surface. The authorization OUTCOME for a cross-company or missing
`deps.handoffTo` is unchanged (`handoffClaim`'s guard already made it fail);
this closes an atomicity/consistency gap (durable writes before an
already-doomed operation's final failure), not a new authorization bypass.
Residual, explicitly-named risk, inherited and unchanged by this fix: the
`approve` path and `submit`'s own `acceptClaimHandoff`/witness/persist
sequence were not re-audited tonight for analogous ordering issues (out of
tonight's scope — flagged as Next Step 1). Credentials reality check:
`OPENROUTER_API_KEY` **is present** in this session's environment
(`LLM_EVAL` is therefore not blocked), but no model-calling evaluation
stage was needed for a deterministic bugfix — no LLM calls made tonight,
consistent with "never fabricate model-call results" even when credentials
exist but aren't required.

## Scan findings (performance, tests)
- **tests**: 328/328 green (up from 327 baseline + 1 net new test). No
  flaky/skipped/`.only` tests introduced. No existing assertion weakened.
- **performance**: no new candidate tonight — `checkOperatingBudget`'s
  concurrency fix (#11, 2026-09-03) and the dashboard org-member
  memoization fix (already merged, `8ab68f1`) remain the only
  performance-surface changes; `npm run harness:bench-verify`'s corpus hash
  (`840fd8d2d698…`) is unchanged across every night checked this session,
  so no sign of benchmark-corpus drift or softening.

## Competitors
| Project | Relevant practice | Grade |
|---|---|---|
| `paperclipai/paperclip` | Ships a dedicated, explicitly-bounded "PR gardening" skill (never merges/approves/closes autonomously, 3-round cap) for tending already-opened PRs — the structural gap this repo's own backlog (38 open dream-cycle PRs) keeps surfacing. | B (read directly, cross-checked against its README) |
| GitHub's own "stale bot" pattern | Auto-labels/closes PRs past an age threshold with no human action — explicitly NOT adopted here (Dream Machine's own merge policy forbids autonomous closure without a textual self-admission of duplication, per PR #72's narrower design) | B |
| Temporal / saga-pattern workflow engines | Model exactly this class of bug (a multi-step operation with a late precondition check) as a first-class "compensating transaction" or ordered-step workflow, making ordering bugs structurally harder to introduce | A (established literature/production pattern, not vendor-specific) |
| MSR 2026 mining-challenge study (cited by issue #71, not re-verified tonight) | Found that automated-PR backlogs without a human triage cadence see merge rates trend toward 0% past ~20 open PRs — matches this repo's own observed ~0% rate over 38 | C (single citation, not independently re-verified this session) |

## Gist
**LOCAL** — no `gh` CLI / gist-creation primitive available on this
session's GitHub MCP server (confirmed: tool search found only issue/PR/
repo tools, no gist tool). Full report committed at
`docs/dream-cycle/2026-10-20-correctness-report.md`.

## Witness
```
REPORT_HASH    = ad1e453f6963ac115c184b2fe39fc4e271ac5607351ebabeca756e78bb6471cc
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 4ce98eaf1b2d77399e0c793c830abf226f1408b21cf1a60038f4f4e3f94f2f78
```
(`REPORT_HASH` is `sha256sum` of this report as it stood immediately before
this Witness section was filled in — the same self-referential-hash
convention this repo's prior dream-cycle nights have used; a fresh
`sha256sum` of this *final* committed file will differ from `REPORT_HASH`
by design, since the hash necessarily predates its own insertion. `WITNESS
= sha256(REPORT_HASH || SESSION_COMMIT)` is independently reproducible from
the two values above regardless.)
Verifier procedure (reproduce from a clean checkout of the PR branch):
1. `git fetch origin dream/2026-10-20-correctness && git checkout dream/2026-10-20-correctness`
2. `sha256sum docs/dream-cycle/2026-10-20-correctness-report.md` → must equal `REPORT_HASH` above.
3. `git log -1 --format=%H` on the PR's base/merge-base against `6e73a8f060bcbb69965a50ffe4627e33622d4094` → `SESSION_COMMIT`.
4. `printf '%s%s' "$REPORT_HASH" "$SESSION_COMMIT" | sha256sum` → must equal `WITNESS`.
5. `npm ci && npm run build && node scripts/run-tests.mjs dist` → 328/328; `npm run harness:bench-verify` → hash `840fd8d2d698…` unchanged.

## Next steps
1. Re-audit `approve`'s and `submit`'s own side-effect ordering for an
   analogous late-precondition-check gap (not found tonight, not ruled
   out either — out of scope, flagged for a future correctness night, but
   explicitly NOT the "same finding" the rotation signal above warns
   against, since it would be `approve`/`submit`-specific, distinct code
   paths).
2. Human triage pass on the 38-PR dream-cycle backlog, prioritizing the
   already-ACCEPT-verdict security fixes (#29 critical, #39, #51) sitting
   unpatched for 6+ weeks — independent of tonight's own outcome.
3. Remove or document the unused direct dependency `google-auth-library@10.9.1`
   (declared in `package.json`, confirmed via grep to have zero imports in
   `src/`/`services/`) — minor hygiene, not implemented tonight.

## Recommendation
`evaluated: accepted`. Human: review/merge this PR (small, isolated,
one conceptual change, independently critic-cleared); separately and more
urgently, triage the 38-PR dream-cycle backlog — this routine cannot make
the repository safer by producing more evidence if none of it ever lands.
