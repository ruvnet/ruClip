# Architecture SOTA Report — 2026

**Repo**: `ruvnet/ruClip` @ `41433bb971bc6152122acc180c5d695e55ea8c07`
**Rotation**: SLOT=2 → DEEP=architecture, SCAN=docs,api (2026-09-02, DAYINT%25=2, no bonus)

## TL;DR

`src/control-plane/store/agentdb-adapter.ts` (1417 lines) is a God-module:
sole persistence/orchestration surface for 8 unrelated bounded contexts
(company/org-member/goal/issue/comment persistence, 3 approval-transition
guards, causal-edge graph writes, heartbeat scheduling, an operating-budget
circuit breaker, a semantic pattern-store, and an Autogenous mutation audit
trail), referenced by 8 of the repo's own design docs. Tonight extracts the
most self-contained of those contexts — the operating-budget circuit
breaker (~140 lines: `OperatingBudgetLevel`/`Thresholds`/`Config`,
`DEFAULT_OPERATING_BUDGET_THRESHOLDS`, `setOperatingBudget`,
`operatingBudgetLevel`, `checkOperatingBudget`) — into its own module,
re-exported for zero call-site changes. This continues a pattern the repo
already established itself: `bridge-client.ts` was extracted from this same
file previously for the identical reason (breaking coupling), with the
identical re-export-for-compatibility technique.

## What's new

Nothing externally novel — this is an internal-evidence-driven finding
(module-size/reference-count analysis of the actual repo), grounded against
established software-engineering literature on module cohesion, not a new
technique. The "new" part is applying the diagnostic (line count × distinct
bounded contexts × dependent-doc count) systematically and picking the
lowest-risk, most self-contained extraction first rather than attempting a
full decomposition in one shot.

## Competitors (paperclipai/paperclip and others)

| Project | Persistence-layer shape | Grade | Note |
|---|---|---|---|
| paperclipai/paperclip | Split by domain, not a monolith: `packages/db/src/schema/` has ~100+ one-entity-per-file modules (`companies.ts`, `issues.ts`, `issue_approvals.ts`, `approvals.ts`, `budget_policies.ts`, `cost_events.ts`, `heartbeat_runs.ts`, `goals.ts`, ...); `server/src/services/` is likewise decomposed per-domain. No monolithic data-access file found. No formal pattern name documented (no hexagonal/repository-pattern doc), but the file-per-domain convention is consistent throughout. | A | Confirmed via public GitHub directory listing, not GitHub API (out of session repo scope) |
| Robert C. Martin / SRP | One reason to change per module | B | Author's own canonical blog restatement of SRP |
| Brown et al., *AntiPatterns* (1998) | "God Class"/"Blob" named antipattern + remedy | A | Canonical text |
| Fowler, *Refactoring* | "Large Class"/"Divergent Change" smells → Extract Class | A | Canonical text |
| Khomh et al., *Empir. Softw. Eng.* 17 (2012) | Blob/God-Class-participating classes have measurably higher change/fault odds (54 releases, ArgoUML/Eclipse/Mylyn/Rhino) | A | Peer-reviewed empirical study |

## Hypothesis (frozen before implementation)

> Given ruClip's control-plane persistence layer, when the operating-budget
> circuit breaker (`OperatingBudgetLevel`/`Thresholds`/`Config`,
> `DEFAULT_OPERATING_BUDGET_THRESHOLDS`, `setOperatingBudget`,
> `operatingBudgetLevel`, `checkOperatingBudget`) is extracted from
> `agentdb-adapter.ts` into a new single-responsibility module
> `store/operating-budget.ts` and re-exported from `agentdb-adapter.ts`,
> then `agentdb-adapter.ts` shrinks by one full bounded context (~140
> lines) with zero behavioral change, subject to: the full existing test
> suite (320 tests, including 4 dedicated
> `checkOperatingBudget`/`setOperatingBudget` tests) passing identically
> before and after, `tsc --strict` staying clean, and zero import changes
> required at any of the three real call sites
> (`heartbeat/fire-heartbeat.ts`, `governance/propose-budget-mutation.ts`,
> `dashboard/build-snapshot.ts`).

## Benchmarks / Evaluation

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`).

- **Baseline (parent, commit `41433bb971bc6152122acc180c5d695e55ea8c07`)**:
  320 tests, 320 pass, 0 fail, 0 skipped, `tsc --strict` clean, 1642.07ms.
- **Candidate** (branch `dream/2026-09-02-architecture`): 320 tests, 320
  pass, 0 fail, 0 skipped, `tsc --strict` clean, 1556.91ms. Identical test
  count and pass rate — zero behavioral change, as the hypothesis predicted.
- **Diff shape**: `agentdb-adapter.ts` 1417 → 1301 lines (net -116, one
  bounded context removed); new `operating-budget.ts` +149 lines; **zero
  other files touched** — no call site anywhere in `src/` or `tests/`
  needed an import-path change, confirming the extraction was genuinely
  decoupled, not just relocated.
- **Reward-hack check**: no test file touched, no threshold/gold-answer
  changed, no new mock/cache introduced. The existing dedicated
  `checkOperatingBudget`/`setOperatingBudget` tests in
  `heartbeats-and-comms.test.ts` ran unmodified against the new module path
  and passed, which is the actual regression check for this refactor, not
  an incidental one.

## Verdict

**ACCEPT** (recommended for human review — see Merge Policy, this is not
self-promotion). All promotion-gate criteria met: evaluation_complete ∧
effect_positive (god-module shrinks, one fewer mixed bounded context,
confirmed against paperclip's own per-domain split) ∧
significance_sufficient (binary/structural claim, not a noisy metric —
either the module shrinks with zero call-site changes or it doesn't; it
did) ∧ no_material_regression (320/320 both sides) ∧ tests_green ∧
reward_hack_clear ∧ critic_clear (see PR body) ∧ witness_valid ∧
receipt_reproducible (`npm test` on both commits).

## Witness

- Session commit (parent): `41433bb971bc6152122acc180c5d695e55ea8c07`
- Report sha256 (of this file, pre-witness-section-edit content hashed at
  publish time — see verifier step 2): `35944f18c4e6de5471332ac4143f9fa9d3b05469d376b83b9465db8cf12c4cbd`
- Witness stamp: `24e92f50954ff3fc5aa69ec3fc617cfd5cb55a58980e35da86a79fd9d2f04ffb`

Verifier procedure (reproducible by anyone):
1. `git show 41433bb971bc6152122acc180c5d695e55ea8c07 --stat` — confirm this
   is the session's starting commit.
2. `sha256sum <this file>` — confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 41433bb971bc6152122acc180c5d695e55ea8c07 | sha256sum` —
   confirm it matches the Witness stamp above.
4. `git checkout 41433bb971bc6152122acc180c5d695e55ea8c07 -- . && npm ci && npm test` —
   confirm 320/320 pass (baseline receipt).
5. `git checkout dream/2026-09-02-architecture -- . && npm test` — confirm
   320/320 pass, `agentdb-adapter.ts` is 1301 lines, `operating-budget.ts`
   exists at 149 lines, and `git diff 41433bb -- src/ tests/ --stat` touches
   exactly two files (one modified, one new).

## Next steps (concrete)

1. If ACCEPT: repeat the same extraction for the next most self-contained
   context (candidate: the "pattern-store" section, ~35 lines, or the
   heartbeat-schedule section, ~180 lines) on a future architecture night —
   do not attempt the full 8-context decomposition in one PR.
2. paperclip's own `budget_policies.ts`/`cost_events.ts` split (confirmed
   this session, A-grade) directly parallels tonight's operating-budget
   extraction — the next architecture night should extract
   heartbeat-scheduling next, matching paperclip's separate
   `heartbeat_runs.ts`.
3. Track `agentdb-adapter.ts`'s line count in the ledger going forward as a
   standing metric — the god-module diagnostic (line count × bounded
   contexts × dependent docs) is reusable on every future architecture
   rotation, not just tonight's.
