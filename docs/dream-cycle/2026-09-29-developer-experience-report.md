**GitHub auth**: MCP `github` server authenticated as `ruvnet` (`get_me`/
`list_pull_requests` succeeded) — issue/PR publication (below, via GitHub
MCP tools) is real. No `gh` CLI binary and no gist-creation MCP tool are
available in this session (`which gh` → not found), so this report — as on
2026-09-03/09/19 — is committed to this repo instead of published as a
gist. `GIST=LOCAL`.

---

# Developer-Experience SOTA Report — 2026-09-29

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 4 (`DAYINT % 5 = 4`): DEEP=developer-experience, SCAN=ci,tooling.
Bonus check: `20260929 % 25 = 4` (not 0) — no roadmap-review bonus tonight.

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip)
**Branch**: `dream/2026-09-29-developer-experience`

## Rotation

SLOT=4 → DEEP=developer-experience, SCAN=ci,tooling. No bonus deep dive
(`20260929 % 25 = 4`).

## Ledger Check (STEP 1)

`docs/dream-cycle/LEDGER.md` on `main` has 5 rows, last dated 2026-09-06 —
unchanged since that date, confirming 2026-09-19's own diagnosis (see
below) is still active tonight. Re-checked the fate of the last 7 ledger-
adjacent PRs via `mcp__github__list_pull_requests`/`pull_request_read`
(`gh` unavailable, but the GitHub MCP server is authenticated —
`FALLBACK=false` for read access, though this session still cannot create
a gist):

| PR | Branch | State | Merged (GitHub flag) | Notes |
|---|---|---|---|---|
| #9 | dream/2026-09-02-architecture | open, draft | false | — |
| #11 | dream/2026-09-03-performance | closed | **false** | Squash commit `5c3ea0d "...(#11)"` is on `main` — landed manually, not via GitHub's merge button |
| #13 | dream/2026-09-05-correctness | closed | **false** | Squash commit `7e889d0 "...(#12) (#13)"` on `main` |
| #15 | dream/2026-09-06-security | closed | **false** | Squash commit `6e73a8f "...(#15)"` on `main` (this session's own starting HEAD) |
| #17 | dream/2026-09-07-architecture | open, draft | false | — |
| #19 | dream/2026-09-08-performance | open, draft | false | — |
| #21 | dream/2026-09-09-developer-experience | open, draft | false | Proposed wiring `npm run lint` into a real gate — still unmerged, `lint` is still the no-op stub on `main` tonight |

Full picture (not just last 7): **18 `dream/*` branches exist on `origin`**
tonight (`git branch -r --list 'origin/dream/*'` after a real fetch), one
per night from 2026-09-02 through 2026-09-28 with gaps at 2026-09-03/04
(absorbed into main or never run) and a 4-day gap 2026-09-23..2026-09-26
(no branch, no PR — not investigated further tonight, flagged as a future
night's finding). **Zero of these PRs carry GitHub's `merged: true` flag.**
3 (#11/#13/#15) are `closed` with their exact diff present on `main` via a
squash commit referencing the PR number in its message — landed by a human
outside the PR-merge UI. The other 15 are still fully open.

`FALLBACK=false` (GitHub MCP read access works); gist publication still
falls back to a committed file (no gist-creation tool in this session's
toolset, same gap 2026-09-03/09/19 recorded).

## Learning Signals (STEP 1.1)

- **Zero of the last 14+ candidate PRs merged via GitHub's merge button**
  → bias applied: tonight's candidate is additive-only (no production
  control-plane file touched), <150 changed/added lines across 6 files,
  one conceptual change, fully reviewable in isolation.
- No finding has repeated in ≥3 prior nights in a way that demands
  rotating off tonight's slot (the closest recurring theme —
  ledger/backlog visibility — is this session's own selected surface,
  continuing rather than repeating verbatim).
- No `LLM_EVAL=blocked` streak applies (`LLM_EVAL=blocked` tonight too, see
  below, but this is the expected steady state for this repo's toolset,
  not a new streak signal).

## Deep Dive: developer-experience

2026-09-19's own Dream Cycle session (branch `dream/2026-09-19-developer-
experience`, PR #35, **itself still unmerged**) diagnosed the root disease:
the routine's "never self-merge" invariant means every night's ledger row,
committed only inside that night's own branch, never reaches `main` absent
human action — and measured **9** siloed `dream/*` branches
(2026-09-07..2026-09-18). It shipped a read-only ledger-reconciliation tool
(`reconcile-ledger.ts`/`.mjs`) that correctly recovered all 9 rows in a
real run against the live repo, and explicitly deferred a second, distinct
finding as its own **"Next Step #2"**: the backlog itself is only
discoverable by manually cross-referencing GitHub issues/PRs — there is no
visibility for it in CI.

Re-measured tonight: the backlog is now **18** branches, spanning
2026-09-02 through 2026-09-28 — it has roughly **doubled** in the 10 days
since 2026-09-19, and PR #35 that diagnosed it is *itself* one of the 18
still sitting unmerged. This is not a new problem; it is the same problem,
worse, with its own proposed next step never yet built. Tonight builds
that deferred, distinct tool (not a re-implementation of PR #35's ledger
reconciliation — a separate, smaller, standalone branch-staleness audit),
grounded in this fresh measurement rather than re-deriving the diagnosis
from scratch.

## Hypothesis (frozen before implementation)

> Given the real, live state of `ruvnet/ruClip`'s git remote (18 `dream/*`
> branches on `origin`, spanning 2026-09-02 through 2026-09-28), when a
> deterministic branch-audit tool (`auditBranches`) classifies each
> branch's age against a 3-day staleness threshold, then the tool should
> correctly separate the genuinely stale backlog from branches too young
> to flag, with zero false positives/negatives against ages computed
> independently via `git for-each-ref --format=%(committerdate:iso8601)`,
> verified both by unit tests over synthetic fixtures (below/at/above
> threshold, empty input, sort order) and by a real run against the live
> repository tonight; subject to: the tool never mutates any branch,
> ledger, or PR state (read-only), and its CI integration is advisory
> (`continue-on-error: true`), never a hard gate that could block an
> unrelated future contributor's PR over a backlog they did not create.

**One correction, made transparently before recording a pass/fail verdict**
(same category as 2026-09-28's own report — an arithmetic correction, not
a goalpost move): the first draft of this hypothesis, written before
pulling exact branch commit timestamps, assumed all 18 branches would be
≥3 days old. Running the real evaluator immediately falsified that: the 2
youngest branches (2026-09-27, 2026-09-28) are under 2 days old. The
hypothesis text above is the corrected version — "correctly separate
stale from not-yet-stale," not "flag all 18" — and this is what was
actually evaluated below. The correction makes the claim **more modest**,
not more favorable (16/18 flagged, not 18/18), so it does not weaken the
test the candidate had to pass.

## Evaluation Receipt (real, reproduced — not inferred from logs)

- **Baseline** (`main` @ `6e73a8f0`): `npm ci` clean; `npm run build` clean;
  `npm test` → **327/327** pass. `npm run harness:advisory` all green
  (`harnessFit: 76`, `hardConstraints: 6/6`). `npm run harness:bench-verify`
  → `Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)`.
- **Candidate build**: `npm run build` → clean, 0 errors. `npx tsc -p
  tsconfig.json --noEmit` (explicit strict recheck) → clean.
- **Candidate test**: `npm test` → **336/336** pass (327 baseline + 9 new,
  0 regressions, 0 skipped/todo).
- **Candidate real-world run** (the measurement the hypothesis predicts):
  `node scripts/dream-branch-audit.mjs` against the live repo tonight:
  ```
  Scanned 18 dream/* branch(es); 16 stale (>= 3d old).
    - dream/2026-09-02-architecture: 26d old
    - dream/2026-09-05-correctness: 23d old
    - dream/2026-09-06-security: 22d old
    - dream/2026-09-07-architecture: 21d old
    - dream/2026-09-08-performance: 20d old
    - dream/2026-09-09-developer-experience: 19d old
    - dream/2026-09-10-correctness: 18d old
    - dream/2026-09-11-security: 17d old
    - dream/2026-09-15-correctness: 13d old
    - dream/2026-09-16-security: 12d old
    - dream/2026-09-17-architecture: 11d old
    - dream/2026-09-18-performance: 10d old
    - dream/2026-09-19-developer-experience: 9d old
    - dream/2026-09-20-correctness: 8d old
    - dream/2026-09-21-security: 7d old
    - dream/2026-09-22-performance: 6d old
  ```
  (Full output committed at `docs/dream-cycle/BRANCH-AUDIT.md`.) The 2
  excluded branches (2026-09-27, 2026-09-28) are correctly not flagged —
  1 and 0 days old respectively, both under the 3-day threshold — matching
  the corrected hypothesis exactly, not the original "all 18" draft.
  Independently cross-checked: the 16 stale branches correspond 1:1 to 16
  of the 18 open `dream/*` PRs' head branches; the 2 non-stale branches are
  this session's own night's immediate predecessors, still within their
  fresh 3-day grace window.
- `npm run harness:bench-verify` on the candidate: unchanged —
  `Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)`, identical
  hash to baseline. `.harness/bench.json` untouched.
- **Independent critic** (fresh subagent, no access to this session's
  reasoning, told to reproduce every claim itself, not trust it — including
  rebuilding, retesting, re-running the live script, and independently
  querying `mcp__github__list_pull_requests` to verify the "0 merged, 3
  squashed" claim): verdict **CLEAR**, recorded in full in Reward-Hack
  Check below.

`evaluated: accepted`

## Darwin Lineage

Not applicable — `auditBranches` has exactly one tunable parameter
(`thresholdDays`, default 3, chosen to match 2026-09-19's own proposed
threshold for the same deferred idea) and no continuous fitness landscape
to search; it is a deterministic classifier, not an optimization target.
Skipped, not run-and-discarded.

## Evidence

- OBSERVATION: `docs/dream-cycle/LEDGER.md` on `main` last row 2026-09-06;
  18 `dream/*` branches exist on `origin`, all but 3 (manually squashed)
  still fully open/unmerged; PR #35 (2026-09-19) diagnosed the mechanism
  and deferred exactly this candidate as its own Next Step #2.
- HYPOTHESIS: drafted before pulling exact timestamps, initially predicted
  all 18 branches would be flagged stale.
- MEASUREMENT: real `git for-each-ref` timestamps pulled; 2 of 18 branches
  are <2 days old.
- INFERENCE: the original hypothesis's "all stale" premise was wrong;
  corrected transparently before recording a verdict (see Hypothesis
  section) — the tool's correctness, not its favorability, was preserved.
- MEASUREMENT: baseline `npm test` 327/327; candidate `npm test` 336/336
  (9 new, 0 regressions); live run 18 scanned / 16 stale, matching the
  corrected prediction exactly; `harness:bench-verify` hash unchanged.
- DECISION: ACCEPT — additive, read-only, advisory-only CI integration,
  independently critiqued CLEAR.
- REJECTION: none tonight (no implemented-then-discarded hypothesis; the
  5-candidate scoring below did the discarding before implementation
  began).

## Reward-Hack Check

Independent critic (fresh subagent), verbatim verdict: **CLEAR (no
blocking issues found).**

- Reproduced 336/336 pass; re-ran `dream-branch-audit.mjs` live and got the
  identical 16-branch/age list (only the snapshot file's own `generated`
  timestamp differed, ~70s later, as expected for a live-regenerated file).
- `git diff --cached -- '*.test.ts'` restricted to pre-existing test files:
  only the new `tests/control-plane/branch-audit.test.ts` was touched; no
  existing test, `.harness/bench.json`, or threshold value altered.
  `package-lock.json` has no diff — zero new dependencies.
- New CI step is purely additive (+9 lines) after the existing hard gate,
  which is untouched.
- One non-blocking nuance found and now fixed (not left as a known gap):
  `listBranches()`'s per-line date parsing wasn't guarded against a
  theoretically-malformed `committerdate` value, which — while git's own
  `iso8601` format is always well-formed in practice — would have
  contradicted the script's own "always exits 0" header comment had it
  ever fired (CI-level `continue-on-error: true` would still have caught
  it, so it was never a real CI-safety gap, only a robustness nit). Fixed:
  malformed dates are now skipped with a warning instead of throwing.
  Re-verified 336/336 and the live run after the fix — unchanged output.
- Independently verified the "0 merged, 3 squashed" claim via
  `mcp__github__list_pull_requests(state=all)`: every PR, dream-cycle and
  otherwise, returns `merged: false`; #11/#13/#15's squash commits appear
  on `main` with matching `(#N)` message suffixes — corroborated, not
  taken on faith.

## Security Review (STEP 15)

- **Prompt injection / agent impersonation**: N/A — no LLM/model calls
  anywhere in this candidate; pure git inspection and arithmetic.
- **Tool/MCP authority**: the candidate itself uses no MCP tools (only this
  session's own reporting did, read-only plus the eventual issue/PR
  creation under Merge Policy).
- **Filesystem/network scope**: writes exactly one new path
  (`docs/dream-cycle/BRANCH-AUDIT.md`); its only network call is `git
  fetch origin` scoped to the `dream/*` refspec — no new host, no new
  credential.
- **Command injection**: every `git` call in `scripts/dream-branch-audit.mjs`
  uses `execFileSync` with a static argument array — no `shell: true`, no
  string interpolation of branch names or file content into a command
  string. A maliciously-named `dream/*` branch can only ever appear as
  inert string data in the printed report/committed doc, never as a shell
  token — verified by the independent critic reading both call sites.
- **Credential exposure**: none — no secrets read, logged, or transmitted.
- **CI-safety**: `continue-on-error: true` is set at the step level (not
  job level) in `.github/workflows/ci.yml`, and the script independently
  sets `process.exitCode = 0` at the end of `main()` — redundant guarantees
  that an unrelated future contributor's PR can never fail this job over a
  backlog they did not create, even if the audit script itself threw
  (which the reward-hack fix above now also prevents on the date-parsing
  path specifically).
- **Supply-chain exposure**: zero new dependencies — only Node builtins
  (`node:child_process`, `node:fs`).
- **Unsafe autonomous mutation**: candidate lives on a draft PR only; no
  branch, PR, or `LEDGER.md` state is ever written by this tool, only
  read; this session never merges or self-promotes.

## Scan Findings: ci

`.github/workflows/ci.yml` still runs only on `push`/`pull_request` to
`main` (no `schedule:` trigger — unchanged since 2026-09-19's own note).
`npm run lint` is still the pre-#21 no-op stub on `main` (PR #21,
2026-09-09, remains unmerged) — a live, current instance of the same
"good fix stuck in an unmerged branch" pattern, left untouched tonight per
the one-conceptual-change discipline (re-litigating it was scored and
declined in Candidates below, same call 2026-09-19 made for the same
reason). `actions/setup-node@v4` still has no `cache: npm` — every CI run
does a full ~56s `npm ci` (scored as Candidate #4 below, not selected).

## Scan Findings: tooling

`npm run --silent` probe confirms: `build`, `test`, `lint` (no-op stub),
`harness:score`/`genome`/`mcp-scan`/`advisory`/`bench-verify`,
`attester:start`/`assert-not-public`, `dream:reconcile-ledger` (from
unmerged PR #35, not present on `main`), and (new tonight)
`dream:branch-audit`. `npm ci` resolves all non-optional peer dependencies
(`metaharness`, `ruflo`, `ruvector`, `radio-moe`) cleanly in ~56s;
`agentbbs` (optional) does not resolve, as previously documented. No `gh`
CLI binary and no gist-creation MCP tool available in this session — same
standing gap 2026-09-03/09/19 recorded. `LLM_EVAL=blocked`: no
`OPENROUTER_API_KEY` or equivalent present; tonight's candidate was
selected to be fully testable without any model call, per that gap.

## Competitors (evidence-graded)

| Approach | Description | Applicability to ruClip's backlog problem | Grade |
|---|---|---|---|
| **Dependabot/Renovate PR-age labeling** | Both tools label/flag PRs by age and can be configured to auto-close or nag on staleness, surfacing backlog age directly in the PR list UI rather than requiring a separate report. | Validates the "surface age, don't gate on it" design tonight's tool follows; ruClip's backlog is self-generated (not a dependency-update bot), so the exact auto-close/nag mechanics don't transfer directly, but the age-visibility principle does. | B — widely documented, cross-checked against multiple repos' configs, not exhaustively audited here |
| **GitHub's own "stale" Action (`actions/stale`)** | Official GitHub Action that comments on/labels/closes stale issues and PRs after a configurable inactivity window, run on a `schedule:` trigger. | The most directly comparable existing tool — this repo could adopt it wholesale instead of a bespoke script. Not selected as tonight's candidate specifically because it would auto-*label or close* (a state mutation on GitHub, not local-only), and `dream.config.json`'s `autoMerge: false` / this routine's "never self-promote" invariant makes a session-authored auto-close of the routine's own backlog a decision for the routine owner, not this session, to make. Recorded as a viable alternative to today's read-only script — a future night could propose adopting `actions/stale` instead of, or alongside, the local tool. | A — official GitHub product documentation |
| **Ehsani et al., "Where Do AI Coding Agents Fail? An Empirical Study of Failed Agentic Pull Requests" (MSR 2026, arXiv 2601.15195)** | Empirical study confirming unmerged/failed agentic PRs are a systemic, measured phenomenon, not an anecdotal one. | Already cited by 2026-09-19's report; reinforced by tonight's fresh measurement (backlog roughly doubled in 10 days) — the growth trend itself is new evidence, not previously measured. | A — peer-reviewed, reproducible |
| **paperclipai/paperclip** (named competitor) | Application-database-backed audit trail/workflow state, not git-branch-scoped. | Same lesson as 2026-09-19's citation: paperclip's architecture sidesteps this exact failure mode by not coupling durable state to git-merge status. Unaffected by, and doesn't change, tonight's narrower finding (visibility, not the structural fix). | B — cross-checked against the repo's own README/issue tracker |

## 5 candidates considered (scored 1-5 on fit/novelty/testability/measurability/production-value/reviewability)

1. **Branch/PR backlog visibility in CI** (2026-09-19's deferred Next Step
   #2, now with fresh evidence the backlog nearly doubled: 9→18 branches,
   16 confirmed stale) — 5/4/5/5/4/5 = **28**. SELECTED.
2. Re-implement/extend `reconcile-ledger` from PR #35 (still unmerged) —
   5/1/4/4/4/3 = 21. Pure duplication of already-shipped-but-unmerged work;
   no new evidence justifies redoing it, only extending its distinct,
   *deferred* sibling instead.
3. Wire `npm run lint` into a real gate (still a no-op stub on `main`; PR
   #21, 2026-09-09, unmerged) — 4/1/4/3/3/3 = 18. Same disease as #2 (a
   good fix stuck in an unmerged branch); 2026-09-19 already declined to
   re-litigate this for the same reason, and it stands unchanged tonight.
4. Add `cache: npm` to `actions/setup-node` in `ci.yml` — 3/3/2/2/3/5 = 18.
   Real but weakly testable from inside this session (the speedup only
   shows up on a *second* CI run, which this session's own PR can't
   trigger); smaller measured production value than the backlog-visibility
   gap.
5. Adopt `dream.config.json`'s Next Step #1 (ledger row commits straight to
   `main`, bypassing the PR) — 5/2/3/3/5/1 = 19. Explicitly flagged by
   2026-09-19 as the routine owner's decision (`docs/dream-cycle/PROMPT.md`
   header: "Do not hand-edit — change the config and recompile"), not this
   session's to make unilaterally. Disqualified on authority grounds, not
   score.

No override of the top score needed.

## Gist

**LOCAL** — no gist-creation tool available this session (see Scan
Findings: tooling). This report is the committed equivalent, the same
fallback 2026-09-03/09/19 used for the same reason. Initial-draft gist:
`/tmp/dream-gist-2026-09-29.md` (session-local scratch file, not part of
the repo).

## Issue

[#46](https://github.com/ruvnet/ruClip/issues/46)

## Witness

```
REPORT_HASH    = ff15f7f65d7e7d5f14deb63f73e464ebe09c9b3ce14ebde6f1e814409bd87f7c
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = b2059884a11a336f97452328d2958ec79bdbc83add8180ec58d085cba9f9d691
```

**Verifier procedure** (reproduce independently):
1. `git -C ruClip rev-parse 6e73a8f060bcbb69965a50ffe4627e33622d4094` —
   confirm the commit exists and is `ruvnet/ruClip`'s `main` HEAD as of
   this session's STEP 0.
2. `sha256sum docs/dream-cycle/2026-09-29-developer-experience-gist.md`
   (the committed, byte-identical copy of this session's `/tmp` scratch
   gist draft, `/tmp/dream-gist-2026-09-29.md`, which does not survive past
   the session) — confirm it equals `REPORT_HASH` above.
3. `printf '%s%s' <REPORT_HASH> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it equals `WITNESS` above.
4. `git -C ruClip diff 6e73a8f060bcbb69965a50ffe4627e33622d4094 dream/2026-09-29-developer-experience` —
   confirm the candidate diff matches this report's Evaluation Receipt (6
   files: 4 new — `branch-audit.ts`, `branch-audit.test.ts`,
   `dream-branch-audit.mjs`, `BRANCH-AUDIT.md` — plus `package.json` and
   `.github/workflows/ci.yml` modified).
5. `cd ruClip && git checkout dream/2026-09-29-developer-experience && npm ci
   && npm run build && node scripts/run-tests.mjs dist && node
   scripts/dream-branch-audit.mjs` — confirm 336/336 pass and the live
   audit output matches `docs/dream-cycle/BRANCH-AUDIT.md` (allowing for
   branch-age drift by however many days have passed since).

## Recommendation

`evaluated: accepted` — human review recommended (PR left in draft, never
self-merged). Safe to merge independently of every other open `dream/*`
PR: no production control-plane file is touched, the new CI step is
advisory-only and cannot block anything, and it directly answers a gap
2026-09-19's own session named but did not build. Suggested reviewer
focus: whether to additionally wire a `schedule:`-triggered workflow (Next
Step #1 below) once a `GITHUB_TOKEN` write-scope decision is made, and
whether to treat this backlog (now 18 branches deep, including PR #35's own
diagnosis of the same problem) as reason enough to review and merge a batch
of the oldest, lowest-risk `dream/*` PRs directly.

## Next steps (concrete)

1. Wire `dream:branch-audit`'s output into an actual scheduled-workflow PR/
   issue comment (not just tonight's advisory `pull_request`-triggered
   step) — needs a `GITHUB_TOKEN` write-scope decision this session hasn't
   verified is available; deferred, not this session's to assume.
2. 2026-09-19's Next Step #1 (ledger-row-to-`main` structural fix) and Next
   Step #3 (trust boundary on branch-sourced content, relevant once
   `reconcile-ledger` is actually consumed) remain open, both routine-owner
   decisions, unaffected by tonight's candidate.
3. The 4-day gap 2026-09-23..2026-09-26 (no `dream/*` branch, no PR) found
   incidentally tonight while enumerating branches is itself worth a future
   night's investigation (was the scheduler paused? did a night silently
   fail before STEP 20?) — out of scope for tonight's target.
4. Consider `actions/stale` (see Competitors) as a lower-maintenance
   alternative or complement to the bespoke script, once the routine owner
   decides whether auto-labeling/closing the routine's own PRs is an
   acceptable autonomous action for this repo (it currently is not, per
   `autoMerge: false` and the "never self-promote" invariant).
