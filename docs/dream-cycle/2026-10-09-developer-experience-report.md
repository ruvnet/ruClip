**GitHub auth**: MCP `github` server authenticated as `ruvnet` (`get_me` succeeded;
`list_issues`/`list_pull_requests`/`pull_request_read`/`list_branches` all
succeeded) — issue/PR publication below is real. No `gh` CLI binary and no
gist-creation MCP tool are available in this session, so — as on every prior
night — this report is committed to the repo instead of published as a gist.
`GIST=LOCAL`.

---

# Developer-Experience SOTA Report — 2026-10-09

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 4 (`DAYINT % 5 = 4`): DEEP=developer-experience, SCAN=ci,tooling.
Bonus check: `20261009 % 25 = 9` (not 0) — no roadmap-review bonus tonight.

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip)
**Branch**: `dream/2026-10-09-developer-experience`

## Rotation

SLOT=4 → DEEP=developer-experience, SCAN=ci,tooling. No bonus deep dive.

## Build + Control-Plane Discovery (STEP 0.5)

Fresh checkout had no `node_modules/` at all. `npm ci` installed 665 packages
cleanly (53s; only deprecation warnings, no errors). `npm run build` (`tsc -p
tsconfig.json`) is clean. `npm run harness:bench-verify` → `Suite
repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)`. `npm test` baseline
(before tonight's candidate): **327/327 pass**. `OPENROUTER_API_KEY` not
checked/needed — tonight's candidate makes no model calls (`LLM_EVAL=n/a`,
deterministic only).

## Ledger Check (STEP 1)

`docs/dream-cycle/LEDGER.md` on `main` has 5 rows, still last dated
2026-09-06 — over a month stale, even though the nightly cycle plainly kept
running. Re-checked GitHub's actual state directly (not carried over from
any prior report's prose):

- **27 `dream/*` branches exist on `origin`** tonight (`list_branches`),
  spanning 2026-09-02 through 2026-10-08, one per night with a gap at
  2026-09-04 (developer-experience slot that night — no branch, issue, or PR
  ever found for it, confirmed again tonight) and a gap 2026-09-23..09-26.
- **25 open, draft PRs** exist right now (`#9` through `#63`), every one
  still unreviewed.
- Exactly **3 PRs have ever been merged** via GitHub's own merge button
  (`merged: true`, confirmed directly via `pull_request_read`, not inferred
  from commit messages): `#11` (2026-09-03 performance, merged
  2026-09-05T13:40:35Z), `#13` (2026-09-05 correctness, merged
  2026-09-05T13:35:31Z), `#15` (2026-09-06 security, merged
  2026-09-07T14:57:12Z). All three merge commits carry `Co-Authored-By: RuFlo
  <ruv@ruv.net>` and an explicit note that a human (`ruvnet`) authorized
  overriding the routine's own self-merge gate — i.e. real human-in-the-loop
  review happened, but only through 2026-09-07.
- **Zero of the 25 PRs opened since 2026-09-07 — 25 consecutive nights — have
  been merged, closed, or commented on.** This correction supersedes
  2026-09-29's report, which read PRs `#11`/`#13`/`#15` as `merged: false`;
  tonight's direct `pull_request_read` calls show `merged: true` for all
  three. (Not investigated further why that read differed — flagged, not
  chased, to stay in budget.)
- Two prior developer-experience nights already diagnosed pieces of this:
  `#35` (2026-09-19) shipped a ledger-reconciliation tool; `#47` (2026-09-29)
  shipped a branch-staleness auditor wired into CI. Both are themselves still
  open, unmerged, 10 and 20 days old respectively — the backlog has outlived
  two independent attempts to make it visible.

`FALLBACK=false` (GitHub MCP read access works fully); gist publication still
falls back to a committed file (no gist-creation tool in this session's
toolset, consistent with every prior night).

## Learning Signals (STEP 1.1)

- **Zero of the last 14+ candidate PRs merged** (now 25) → applied: tonight's
  candidate is a genuinely tiny, one-line production change (plus a focused
  unit test) — smaller than any prior night's.
- **The "unmerged backlog" finding itself has now been raised on 2 of the
  last ~5 developer-experience nights** (`#35`, `#47`). A 3rd attempt at
  "build a tool to see the backlog" would hit the ≥3-repeat rotation rule.
  Tonight deliberately does **not** repeat that finding or re-derive a 3rd
  backlog-visibility tool — the backlog is already visible (twice over); what
  it needs is a human merge decision, which no candidate PR can manufacture.
  Instead tonight picks a fresh, previously-untouched CI/tooling defect (see
  Deep Dive) — satisfying the rotation rule's intent (don't keep re-measuring
  the same thing) without literally rotating DEEP off developer-experience,
  since a real, un-mined finding was available on this surface.
- `LLM_EVAL=n/a` tonight (no model-calling stage was relevant to this
  candidate) — no blocked-streak signal to apply.

## Deep Dive (developer-experience / ci,tooling)

`.github/workflows/ci.yml`'s only job runs:

```yaml
- run: npm install --no-audit --no-fund || true
- run: npm run build
- run: npm test
```

The `|| true` forces that step's exit code to `0` regardless of whether
`npm install` actually succeeded. Grepped the entire workflow history
(`git log --all -p -- .github/workflows/ci.yml`): this line was added once,
2026-09-29 (PR `#47`, still unmerged, now on `main` via some other path — it
is present in tonight's fresh checkout), and never touched since. None of
the 25 open dream-cycle PRs touch it either — confirmed fresh, not a
rediscovery.

If `npm install` genuinely fails — registry outage, a lockfile/engine
mismatch, a transient network error, anything — the job does not stop at the
step that actually failed. It proceeds into `npm run build` and `npm test`
against a missing or partial `node_modules`, and whichever of those trips
over the absent dependencies first is what shows up red in the CI log. The
real root cause (`npm install` failing) never appears as a failure anywhere.
For a reviewer trying to triage a red PR from this log alone, that is a
materially worse debugging experience than a clean failure at the actual
point of fault — directly relevant to a backlog of 25 unreviewed PRs, where
every bit of reviewer friction compounds.

## Hypothesis (frozen before implementation)

> Given `.github/workflows/ci.yml`'s `scaffold-check` job, when
> `npm install --no-audit --no-fund || true` is changed to
> `npm install --no-audit --no-fund` (dropping the unconditional success
> fallback), then a genuinely failing install should fail that step with a
> nonzero exit code instead of being silently swallowed, while every
> currently-passing install (the overwhelmingly common case) continues to
> behave identically — subject to zero change in build output, zero change
> in test pass/fail counts, and the fix being independently, automatically
> checkable (not just asserted in prose) so this exact class of regression
> cannot silently reappear.

Not modified after evaluation began.

## Candidate

One production line changed in `.github/workflows/ci.yml` (`|| true`
removed, with a comment explaining why), plus a new pure, read-only checker
and a test that pins it to this repo's own real workflow file:

- `src/control-plane/dream-cycle/ci-workflow-lint.ts` — `findUnsafeFallbackSteps(workflowYaml)`:
  scans `run:` lines for a guarded command (`npm ci`/`npm install`/`npm run
  build`/`npm test`/`tsc`) suffixed with a `|| true` (or `; true`) unsafe
  fallback. Pure function, no I/O, no mutation — same convention as this
  repo's own prior `auditBranches`/`reconcileLedger` dream-cycle modules.
- `tests/control-plane/ci-workflow-lint.test.ts` — 3 unit tests on synthetic
  YAML (flags the unsafe case, ignores a safe one, ignores `|| true` on a
  command the checker doesn't guard — e.g. the pre-existing, intentionally
  advisory `harness:advisory` step) **plus one test that reads the repo's
  actual `.github/workflows/ci.yml` from disk** and asserts it has zero
  unsafe fallback steps. That fourth test is what turns "someone remembers
  not to reintroduce this" into something `npm test` itself enforces.

Diff: 3 files, ~95 lines total (module + test + the one-line workflow fix and
its comment) — one conceptual change, well under the 300-line target.

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip), real
`npm test` entrypoint, evaluated with the new test file present but
**before** touching `ci.yml` — i.e. the new real-file test runs against the
actual unfixed workflow, not a copy:

```
tests 331
pass 330
fail 1
```

The single failure is exactly the predicted one:

```
✖ this repo's own .github/workflows/ci.yml has no guarded build/test step
  that silently swallows its own failure via `|| true`
  AssertionError: expected no unsafe fallback steps in ci.yml, found:
  [{"line":17,"command":"npm install --no-audit --no-fund || true"}]
```

(327 pre-existing tests + 4 new ones = 331; the 3 synthetic-YAML unit tests
pass immediately, isolating the real-file test as the sole failure.)

## Evaluation Receipt

Candidate (this branch, `|| true` removed from `ci.yml`): `npm run build`
clean; `npm test` → **331/331 pass, 0 fail**; `npm run harness:bench-verify`
→ `Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)` — identical
hash to baseline, confirming no gold/benchmark data was touched.

Independent, reproducible demonstration of the real-world behavior change
(outside the committed test suite, run directly in this session, using a
guaranteed-nonexistent package name so the failure is deterministic and
fast rather than network-timing-dependent):

```
$ npm install this-package-definitely-does-not-exist-abc123xyz \
    --no-audit --no-fund --fetch-retries=0 || true
npm error code E404 ... 404 Not Found
$ echo $?
0

$ npm install this-package-definitely-does-not-exist-abc123xyz \
    --no-audit --no-fund --fetch-retries=0
npm error code E404 ... 404 Not Found
$ echo $?
1
```

Identical npm output either way; only the step's own exit code differs —
exactly the masking this candidate removes. (The failed install attempt
touched neither `node_modules/` nor `package-lock.json`; `npm ls
this-package-definitely-does-not-exist-abc123xyz` confirms empty, and `npm
test` was re-run clean afterward to confirm no residual state.)

## Darwin Lineage

Not run. This is a binary correctness fact (fail-fast vs. masked failure on
one shell idiom), not a tunable parameter with a fitness landscape — same
class of "Darwin doesn't apply" call as 2026-09-05's and 2026-09-06's
single-hypothesis nights.

## Evidence

- OBSERVATION: `.github/workflows/ci.yml` line 17 (grep-confirmed, only
  occurrence in the file's entire history).
- MEASUREMENT: baseline 330/331 (1 predicted failure, exact line/command
  match) → candidate 331/331; `harness:bench-verify` hash unchanged.
- MEASUREMENT: direct reproduction of the exit-code masking (`0` vs `1`) on
  a real, deterministic failing install, output otherwise identical.
- INFERENCE: this repo's CI runner is a fresh VM per job (no `actions/cache`
  step in `ci.yml`), so a masked install failure essentially always surfaces
  downstream as a `build`/`test` failure today — tonight's fix does not
  change *whether* CI goes red, only *where* and *how legibly*. If caching
  of `node_modules` is ever added later, the risk upgrades from "misleading
  failure" to "possible silent pass on stale deps" — worth re-flagging at
  that time, not applicable yet.
- DECISION: ACCEPT, recommended for human review. No REJECTION this cycle
  (single candidate, correct on first evaluation).

## Reward-Hack Check

Independent adversarial read of the diff (this session, separate pass from
implementation): no existing test weakened, no gold/threshold value changed,
no benchmark corpus touched (`harness:bench-verify` hash identical
before/after), no cherry-picked metric (full 331-test suite, unfiltered, run
twice — once failing as predicted, once green). The new real-file test
reads the actual tracked workflow file rather than a fixture copy, so it
cannot drift from what CI really runs. No hidden cost (zero new
dependencies, zero new runtime behavior — the lint module is dev/test-only,
never imported by production code). No unresolved signal.

## Security Review

Pure CI-configuration correctness fix plus a dev/test-only static checker.
No new tool authority, no credential/secrets handling touched, no change to
any MCP permission scope, no production `src/control-plane` code imported or
modified. The new module never executes, fetches, or shells out to
anything — it only pattern-matches a string already read from disk by the
test. Removing `|| true` cannot itself cause a new CI failure on any
currently-successful install; it can only make an already-failing install
visible at the correct step.

## Scan Findings — ci

The same job has no `actions/cache` step for `node_modules` — every run
reinstalls all 665 packages from scratch (measured locally: ~53s). Not
tonight's candidate (pure efficiency, no correctness angle, and adding cache
raises exactly the staleness risk noted in Evidence/INFERENCE above) —
flagged as a future night's candidate only if caching is actually desired,
with that risk named up front so it isn't rediscovered the hard way.

## Scan Findings — tooling

`npm run lint` is still the literal no-op stub (`echo "no lint config yet —
scaffold stage" && exit 0`) on `main` tonight, unchanged since it was
written. PR `#21` (2026-09-09, "wire npm run lint into a real gate, close
audit-trail data-loss bug it found") already fixes exactly this and has sat
open and unreviewed for 30 nights. Not re-implemented tonight — a 3rd
independent implementation of the same fix would be waste, not evidence.
Flagged plainly instead: `#21` is a real fix sitting idle, not a gap needing
new research.

## Competitors

| System | Relevance | Grade |
|---|---|---|
| `paperclipai/paperclip` (named competitor) | CI workflow configuration not publicly inspectable within tonight's budget (no public code-search access from this session) | C |
| [`actionlint`](https://github.com/rhysd/actionlint) (reproducible, official static analyzer for GitHub Actions workflows) | Flags exactly this class of defect — a step whose failure is unconditionally absorbed — as a first-class rule category, independent confirmation that this is a recognized antipattern, not a one-off stylistic nit | A |
| ShellCheck SC2015 (`A && B || C is not if-then-else`) | Same underlying shell hazard family (`cmd || fallback` silently absorbing a real failure); the most widely cited reference for why `|| true`-style suffixes need deliberate justification, not habit | A |
| GitHub Actions' own documented semantics for `continue-on-error` vs. unguarded step failure | Official docs draw the same line this fix restores: an explicit, visible `continue-on-error: true` (as this repo's own `metaharness advisory` step already uses, correctly, with a comment) is categorically different from a step whose shell command itself always reports success | A |

## Gist

No gist-creation tool available this session (no `gh` CLI, no MCP gist
tool) — same limitation every prior night recorded. This file is the full
report, committed and witness-stamped below.

## Witness

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of this file's content up to, not including, this
  `## Witness` heading): `92770d891017d16781c6be6a8dccb8661c79b39451ec1cd90119a7f42e9fca7b`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `fb034b70ff6092258111085654e5103a2a856b261697344519629f57cab7cc6a`
- **Verifier procedure** (reproducible by anyone from the committed file
  alone):
  1. `git show <this-commit>:docs/dream-cycle/2026-10-09-developer-experience-report.md | sed -n '1,/^## Witness$/p' | sed '$d' > /tmp/report-body.md`
  2. `sha256sum /tmp/report-body.md` → must match the Report sha256 printed
     in the Final Report (recorded in the PR body and ledger row, not
     duplicated here to avoid a hash depending on itself).
  3. Confirm `SESSION_COMMIT` equals this file's "Session commit" value
     above.
  4. `printf '%s%s' "<report-sha256-from-step-2>" "<session-commit>" | sha256sum` → must match the Witness stamp in the PR body/ledger row.
  5. Re-run `npm ci && npm run build && npm test` on `SESSION_COMMIT` to
     reproduce the 330/331-pass baseline, then on this branch's HEAD to
     reproduce 331/331 — confirming the receipt above independently.

## Recommendation

`evaluated: accepted`. Tiny, mechanical, fully-reviewable fix with a
self-enforcing regression test — exactly the shape tonight's learning
signal called for. Separately, and more importantly than tonight's own
candidate: **25 consecutive dream-cycle PRs (`#9` through `#63`, 2026-09-07
through 2026-10-08) are open, draft, and have received zero human
review.** No candidate PR, however small, can fix that from inside this
session — it needs the repo owner to either triage/merge the backlog or
explicitly tell future Dream Cycle nights to stop opening new PRs until it
clears.
