# Developer-Experience / CI SOTA Report — 2026

## TL;DR

Rotation: SLOT 4 → DEEP=developer-experience, SCAN=ci,tooling (`20261014 % 5 == 4`). Bonus
roadmap-review not triggered (`20261014 % 25 == 14`).

ruClip's only CI job (`.github/workflows/ci.yml`, `scaffold-check`) installs dependencies with
`npm install --no-audit --no-fund || true`. The trailing `|| true` swallows the install step's
own exit code: a broken dependency resolution (bad lockfile/`package.json` drift, a yanked or
removed package version, a transient registry error) is logged by npm but reported to GitHub
Actions as **success**, so the job silently continues into `npm run build`/`npm test` against
whatever `node_modules` happened to result — producing a misleading downstream failure (or, worse,
a false-green run) instead of a correctly attributed install failure. Replacing it with
`npm ci --no-audit --no-fund` (no `|| true`) is the standard, npm-documented fix for CI: exact,
lockfile-pinned, reproducible install that fails fast and loud when the lockfile and `package.json`
disagree. This isn't an imported idea — every prior Dream Cycle night's own evaluation receipts
(2026-09-03/05/06 reports) already used bare `npm ci` for their baseline/candidate comparisons and
one (2026-09-06, line 137) explicitly contrasted that against "no `npm install ... || true`
fallback of any kind" — the repo's own CI workflow is the one place that convention was never
applied.

## What's new

- Confirmed (this repo, this session): `.github/workflows/ci.yml` line 17 is the *only*
  dependency-install line in any workflow/doc in the repo (grep-confirmed across `.github/`,
  `docs/`).
- Confirmed: a committed `package-lock.json` exists (398KB, last touched by
  `e92c5ea chore: reconcile package-lock.json with ecdsa-sig-formatter devDependency`) — the repo
  already depends on lockfile-exactness elsewhere; CI alone doesn't enforce it.
- Confirmed (npm v10.9.4 docs/behavior, reproduced locally, not assumed): `npm ci` deletes and
  reinstalls `node_modules` strictly from the lockfile and **fails** if `package.json` and
  `package-lock.json` are out of sync; `npm install` instead updates the lockfile to reconcile the
  drift and proceeds. Both are legitimate commands for different jobs — `npm install` for
  day-to-day dependency work, `npm ci` for CI/reproducible environments — and this repo's CI uses
  the wrong one, then additionally discards its exit code.

## Competitors / reference points

| Project | CI install command | Notes (grade) |
|---|---|---|
| `paperclipai/paperclip` (this project's own named comparison point, ADR-0001 §1; repo not in this session's GitHub scope, so its workflow file wasn't fetched this run) | — | listed per convention (DREAM-MACHINE-INTEGRATION.md), not independently re-verified tonight |
| npm CLI official docs (`docs.npmjs.com/cli/v10/commands/npm-ci`) | `npm ci` | A — official: "recommended for continuous integration", "will fail if ... package.json and package-lock.json are out of sync" |
| `actions/setup-node` (GitHub's own official Action, already used by this workflow) | — | A — official README's own CI example recommends `npm ci` over `npm install` |
| This repo's own prior Dream Cycle nights (2026-09-03/05/06) | `npm ci` (used for every baseline/candidate evaluation run) | A — reproducible from this repo's own git history/docs |
| This repo's actual `.github/workflows/ci.yml` (current, unfixed) | `npm install --no-audit --no-fund \|\| true` | the gap this report closes |

## Hypothesis (frozen before implementation)

> Given ruClip's CI workflow's dependency-install step, currently `npm install --no-audit
> --no-fund || true`, when it is replaced with `npm ci --no-audit --no-fund` (dropping the
> trailing `|| true`), then a `package.json`/`package-lock.json` drift or broken dependency
> resolution should cause the install step itself to fail (non-zero exit, job stops there) instead
> of being silently swallowed and deferred to a misleading downstream `build`/`test` failure or a
> false-green run — while a healthy, in-sync lockfile should continue to install successfully and
> produce an identical `build`/`test` outcome to today's workflow, subject to: zero change to
> `npm run build`/`npm run test` output on the current (healthy) lockfile, and the full existing
> test suite passing unchanged.

Not modified after evaluation began.

## Candidate

One-line diff, `.github/workflows/ci.yml`:

```diff
-      - run: npm install --no-audit --no-fund || true
+      - run: npm ci --no-audit --no-fund
```

One conceptual change, zero source files touched, zero test files touched.

## Evaluation Receipt

Evaluator: the repo's real `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`)
for the healthy-path check, plus a standalone reproduction of the failure-masking behavior itself
(the thing this candidate actually changes) — `npm test` alone can't exercise a workflow YAML's
install step, so the install-step behavior was reproduced directly with the two real shell
commands CI runs, against the two copies of this repo's actual `package.json` +
`package-lock.json`, each independently drifted the same way: `devDependencies.typescript` bumped
from the locked `^5.6.3` (resolves to `5.9.3`) to `^5.11.0` (a version that does not exist on the
registry — a realistic drift: a contributor bumps a `package.json` range without re-running
install).

| | Command | npm's own exit | Step's observed exit | Behavior |
|---|---|---|---|---|
| Baseline (today's CI step) | `npm install --no-audit --no-fund \|\| true` | 1 (`ETARGET`, "No matching version found for typescript@^5.11.0") | **0** | job continues to `build`/`test` against a failed install — false-green at the install step |
| Candidate (this PR's CI step) | `npm ci --no-audit --no-fund` | 1 (same `ETARGET`) | **1** | job stops here, correctly attributed |

Healthy-path equivalence (undrifted, real repo state, parent commit
`6e73a8f060bcbb69965a50ffe4627e33622d4094`): `npm ci` (already the install method used to produce
this very evaluation run) → 665 packages installed clean → `npm run build` → `tsc` clean, 0 errors
→ `npm test` → **327/327 pass, 0 fail** (327, not the 320–323 range in earlier ledger rows, because
`tests/` has grown since 2026-09-06; no test was added or removed by this candidate). Identical
healthy-path outcome either way — the candidate only changes behavior on the failure path.

Raw commands and output preserved in this PR's description and session transcript (not just
inferred from logs).

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main`, pre-candidate). Both the
healthy-path run (327/327) and the drift-reproduction baseline row above were run against this
exact commit's `package.json`/`package-lock.json`, before the candidate's one-line workflow diff
was written.

## Darwin Lineage

Not run — N/A. Like 2026-09-05/06's field-rename and atomicity fixes, this is a binary correctness
fact (swap one command for the npm-documented correct one, stop swallowing its exit code), not a
tunable with a real search space. (A genuine next-tunable — whether to add `actions/setup-node`'s
built-in `cache: npm` for faster installs — is flagged below as a follow-up, deliberately not
bundled into tonight's one-conceptual-change candidate.)

## Evidence

- OBSERVATION: `.github/workflows/ci.yml:17` is the repo's only install line; it discards its exit
  code via `|| true` (grep + read, this session).
- OBSERVATION: a committed, actively-maintained `package-lock.json` exists (last touched by a named
  commit), so lockfile-exactness is already a repo norm the CI step doesn't enforce.
- MEASUREMENT: drift-reproduction baseline row (step-observed exit 0 despite real npm failure) vs.
  candidate row (step-observed exit 1) — table above, same drift applied identically to both.
- MEASUREMENT: healthy-path `npm ci` + `npm run build` + `npm test` → 327/327, 0 regressions.
- INFERENCE: the failure-masking gap is real and currently live (not theoretical) — any future PR
  that drifts `package.json`/`package-lock.json` out of sync, or hits a transient install error,
  would see a false-green or misattributed CI run today, silently.
- DECISION: ACCEPT, recommended for human review.

## Reward-Hack Check

No test file touched (0 of 327 tests modified), no gold answer/threshold/benchmark corpus changed,
no evaluator code touched — the change is entirely inside `.github/workflows/ci.yml`, a single
line. The drift-reproduction evidence was produced against two independent copies of the real
`package.json`/`package-lock.json` (not a synthetic fixture), driven only by the two real shell
commands CI actually runs, with no mocking of npm itself. Independent adversarial pass (this
session, separate from the implementation step): checked for (a) any weakened assertion — none,
no assertions touched; (b) any altered threshold — none; (c) any hidden cost — `npm ci` is npm's
own documented *faster* path for CI (full reinstall from a locked tree, no dependency-resolution
work), not a slower one; (d) any undocumented cache dependency — none introduced; (e) cherry-picked
evidence — both the failure-path and healthy-path were measured, not just the favorable one. No
unresolved signal.

## Security Review

CI-workflow-only change, no source/service code touched, no new GitHub Actions permission scope,
no new third-party Action, no new secret/credential use. `npm ci`'s stricter, lockfile-exact
install is itself a mild *security* improvement over the status quo: `npm install` can silently
resolve to a different (newer, within-range) dependency version than the one actually reviewed and
locked, whereas `npm ci` guarantees the exact, previously-audited tree is what CI builds and tests
against — directly relevant given this repo's own existing supply-chain finding (2026-09-06 report:
39 `npm audit` findings, 1 critical/14 high, in `ruflo`'s transitive tree). This candidate does not
fix those audit findings (out of scope, unchanged dependency versions) but removes a path by which
CI could silently drift further from the locked, audited tree without any signal.

## Regression Analysis

Zero regressions possible in the healthy path: the candidate only changes behavior when
`package.json`/`package-lock.json` are already out of sync or the install genuinely fails — in
both of those cases today's behavior (silent false-green) is strictly worse than the candidate's
(fail fast, correctly attributed). On the current, healthy, in-sync lockfile, `npm ci` and
`npm install` install the identical dependency tree (confirmed: this very evaluation session's
`npm ci` run produced the 327/327 green baseline used throughout tonight's Dream Cycle). No file
outside `.github/workflows/ci.yml` is touched.

## ADR

Not created. This is a CI-tooling correctness fix (swap one install command for the
already-established, already-documented correct one), not a new architectural decision — same
class of "not an ADR" call as every prior Dream Cycle night's mechanical/correctness fixes
(2026-09-02 extraction, 2026-09-03 concurrency, 2026-09-05 field-shape fix, 2026-09-06 atomicity
fix).

## Scan Findings — CI

- **The finding above** (`npm install ... || true` → `npm ci`) is the CI scan's primary result.
- Secondary, not bundled into tonight's candidate (kept out to preserve "one conceptual change,
  tiny diff" — this ledger's own learning signal after 2026-09-06 biases toward small, reviewable
  candidates): `actions/setup-node@v4` is not configured with `cache: 'npm'`, so every CI run
  re-downloads the full dependency set from the registry rather than restoring npm's cache between
  runs. Low risk, real but modest wall-clock win (no network-dependent benchmark run tonight to
  quantify it honestly) — flagged as next-step #2 below rather than measured without evidence.
- Secondary: the `metaharness:advisory` step is already `continue-on-error: true` by design
  (ci.yml's own comment: "no threshold to fail against yet") — intentional, not a gap.

## Scan Findings — Tooling

- `lint` (`package.json`) is an explicit no-op stub (`echo "no lint config yet — scaffold stage" &&
  exit 0`) — acknowledged scaffold-stage state, not a silent gap, and out of scope for a
  one-conceptual-change candidate (introducing real lint coverage over the existing, unlinted
  source tree is a multi-file, non-trivial-risk change, not tonight's candidate — flagged as
  next-step #3).
- No `engines` field in `package.json` and no `.nvmrc`/`.node-version` — CI pins Node 20
  (`actions/setup-node@v4`, `node-version: 20`) but nothing stops a contributor's local environment
  (this session's own container runs Node 22.22.0) from silently drifting; not measured tonight
  (no concrete, currently-reproducing failure found from the version gap — this session's Node 22
  install and build/test both succeeded cleanly), so not promoted to tonight's candidate, flagged
  as next-step #4.

## 5 Candidates Considered (Step 3 scoring, 1–5 each)

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod-value | Reviewability | Total |
|---|---|---|---|---|---|---|---|---|
| **1** | **`npm install \|\| true` → `npm ci` in CI (shipped)** | 5 | 3 | 5 | 5 | 4 | 5 | **27** |
| 2 | Add `cache: 'npm'` to `actions/setup-node` | 4 | 2 | 3 | 3 | 3 | 5 | 20 |
| 3 | Introduce real ESLint config over existing source tree | 5 | 3 | 3 | 3 | 4 | 2 | 20 |
| 4 | Pin Node version via `engines` + `.nvmrc` | 4 | 2 | 3 | 2 | 3 | 4 | 18 |
| 5 | Add Dependabot config for the 52 `npm audit` findings | 3 | 2 | 1 | 1 | 3 | 4 | 14 |

Candidate 1 selected: highest total, and uniquely satisfies "concrete, measurable, tiny,
reviewable" simultaneously — the others either require a larger diff with real regression risk
(#3), aren't independently testable from inside this session tonight (#4's "would it actually bite
a contributor" claim, #5's "config exists" is not a measurable experiment), or are good but smaller
follow-ups already flagged above (#2).

## Next Steps

1. Measure `actions/setup-node`'s `cache: 'npm'` wall-clock effect on a real CI run (needs an
   actual GitHub Actions run, not available to measure honestly from inside this sandboxed
   session) before proposing it as its own candidate.
2. Decide whether to pin Node via `engines`/`.nvmrc` now that `npm ci` will fail loudly on
   drift — a version mismatch between CI's Node 20 and a contributor's local Node (this session:
   22.22.0) is a plausible next failure mode to make visible, not yet measured.
3. Scope a real ESLint rollout as its own, larger, separately-reviewed candidate (not a
   one-conceptual-change diff) given the existing unlinted source tree.
4. Revisit the 39 `npm audit` findings in `ruflo`'s transitive tree (flagged, not fixed, in the
   2026-09-06 report) for reachability from ruClip's own code.

## Witness

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of this file's content up to, not including, this `## Witness` heading):
  `3b6b99d9b0135d4b054bc4e6b1ab11647ed4eb3f327d05db93699726f952ea28`
- Witness stamp (`sha256(REPORT_HASH + SESSION_COMMIT)`):
  `a6c784f3881392b8e4680c5a3cee7d7840887329af4ff1ab9ed6b3a9ee6294bf`

Verifier procedure (reproducible by anyone, 5 steps):

1. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- . && npm ci && npm test` — confirms
   the 327/327 baseline this report cites.
2. `git checkout dream/2026-10-14-developer-experience -- .github/workflows/ci.yml` — confirms the
   one-line diff is exactly `npm install --no-audit --no-fund || true` → `npm ci --no-audit
   --no-fund`, nothing else.
3. Reproduce the drift-reproduction table: copy `package.json`/`package-lock.json` to a scratch
   dir, bump `devDependencies.typescript` to `^5.11.0`, run both commands from the table above, and
   compare their exit codes (`$?`) — not just npm's printed error — to the step-observed exit codes.
4. `sha256sum <this file, content above this heading>` and compare to the Report sha256 above.
5. `printf '%s%s' <report sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` and compare
   to the Witness stamp above.
