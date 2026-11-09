# Developer-Experience / CI,Tooling SOTA Report — 2026-11-09

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`
**Rotation**: `DAYINT=20261109`, `SLOT = DAYINT % 5 = 4` → `DEEP=developer-experience`, `SCAN=ci,tooling`. `DAYINT % 25 = 9` — no roadmap bonus.

## TL;DR

Live GitHub state tonight (fully paginated, `FALLBACK=false` — `get_me`,
`list_pull_requests`, `pull_request_read` all reachable this session) shows
**58 open `dream/*` branches, 0 merged since `#15` on 2026-09-06** (61+
nights). This exact backlog-crisis finding has now been raised at least six
times across two DEEP surfaces (`#34`/`#35` 09-19, `#47` 09-29, `#72`/`#74`
10-12/10-13, `#84`/`#86` 10-18/10-19, `#92` 10-22, `#116`/`#117` 11-03,
`#126`/`#127` 11-08) — this report does not re-litigate *that* it exists.

What's new tonight: every one of those prior nights reported the backlog's
**size** (open-PR count, merge rate) but none reported its **composition** —
how much of the 58-branch backlog is genuinely safe to fast-track versus how
much actually needs a careful read. A `main`-only mergeability check (used by
`#127`) answers "will this apply cleanly" but says nothing about review risk.
Tonight's candidate is a small, deterministic classifier that answers that
second question directly from each branch's changed-file list — no model
call, no network beyond the repo's own existing `origin` remote, no mutation
of any branch, PR, or ledger history.

**Verdict: ACCEPT** (recommended for human review — this session never
self-merges or self-promotes).

## Ledger Check (Step 1) / Learning Signals (Step 1.1)

`docs/dream-cycle/LEDGER.md` on `main` is frozen at 4 rows, last dated
2026-09-06 (`#15`) — this is itself an instance of the measured problem: every
night since has appended its ledger row only on its own unmerged branch, so
`main`'s ledger has not reflected real history in 2+ months. (Not tonight's
candidate — already identified by `#92`, 2026-10-22 — but directly explains
why Step 1's "inspect the last 14 rows" instruction has nothing recent to
read on `main` itself; this report instead re-derives the real state from
live GitHub data, same as `#90`/`#117`/`#127` did.)

Learning signals applied:
- **0 of the last 14 (in fact, last 58) candidate PRs merged** → biased
  tonight's candidate to be as small and mechanically reviewable as possible:
  2 new files + 1 test file + a 1-line `package.json` addition, 0 existing
  files' behavior changed.
- No single finding has repeated ≥3 times on *developer-experience*
  specifically (10-24: ADR backfill: `#95`/`#96`; 10-29: lint-stub: `#104`
  (issue)/`#105`; 11-04: branch-contention: `#118`/`#119` — three different
  mechanisms, not one repeated finding), so no surface rotation was triggered
  by that rule. The cross-surface "backlog is the problem" meta-finding has
  repeated far more than 3 times, but a human-review-bandwidth problem is not
  something any DEEP surface's code change can fix — it can only be made
  cheaper to act on, which is exactly tonight's angle.
- `LLM_EVAL`: not blocked tonight — `OPENROUTER_API_KEY` is present in this
  session's environment — but not needed either: tonight's finding and its
  evaluation are both deterministic (`node:test`, local `git` plumbing).

## Deep Dive (developer-experience)

Inspected `.github/workflows/ci.yml` (`scaffold-check`: Node 20, build, test,
advisory `metaharness:advisory` with `continue-on-error`, hard
`harness:bench-verify` gate) and confirmed, live, via
`pull_request_read(method: get_check_runs)` on three recent `dream/*` PRs
(`#127`, `#123`, `#105`), that CI **passes** on all of them —
`scaffold-check` is green in every case. This rules out "the PRs are failing
CI and that's why they're not merged" as an explanation for the 0% merge
rate; the real bottleneck is human review bandwidth, not CI health.

Checked the Node-version history of `ci.yml` (`git log -p --follow`): the
2026-09-01 "Node 22" fix (`366cb36`) was deliberately reverted to Node 20 the
same day (`45bca73`, documented in that commit's own message: Node 20 passes
correctly on its own merits via `scripts/run-tests.mjs`'s explicit file
walk). Current `ci.yml` pinning Node 20 is intentional, not a regression —
no candidate here.

Checked `#111` (2026-10-31, `chore/ignore-tool-state-dirs`, still open,
`mergeable_state: clean` against tonight's exact `main` tip): it already
fixes the `.claude-flow/`/`.swarm/` untracked-directory nuisance this
session's own `git status` reproduced at startup. Not duplicated tonight —
per Step 2, a tracked, still-valid, unmerged fix is not rediscovered.

## Frozen Hypothesis (Step 3.3, frozen before evaluation began)

> Given the 58 currently-open `dream/*` branches, when each branch's diff
> against `main` is classified by a pure function of its changed-file paths
> alone (docs-only / mechanical-with-tests / needs-review) rather than by a
> `main`-only mergeability check, a non-trivial fraction of the backlog
> should classify as `docs-only` (zero production risk, safe to fast-track
> without code review) and the remainder should split into a
> smaller-than-expected `needs-review` tail — subject to: no model call, no
> mutation of any branch/PR/ledger history, and no claim of semantic
> correctness beyond file-path-level risk triage (a single heavily-rewritten
> file with tests still classifies as low-file-count "mechanical" — a
> disclosed heuristic limitation, not a safety guarantee).

Not modified after evaluation began.

## Candidate

One conceptual change (a pure risk-tier classifier over a changed-file list,
plus a live CLI wrapper), touching:

- `src/control-plane/tooling/dream-cycle-pr-triage.ts` — pure
  `classifyBranchDiff(files) -> {tier, reason}` and `summarizeTriage(tiers)`.
  No I/O, no git, no network — fully unit-testable.
- `scripts/dream-cycle-pr-triage.mjs` — CLI wrapper: `git fetch --prune` +
  `git diff --name-only origin/main...<branch>` for every `origin/dream/*`
  branch, fed through the pure classifier above. `execFileSync` with
  argument arrays throughout (no shell interpolation of branch names).
  Wired as `npm run dream:triage`.
- `tests/control-plane/dream-cycle-pr-triage.test.ts` — 9 new unit tests
  against synthetic file-list fixtures, independent of the live branch
  graph (won't flake as branches merge/close).

Diff size: 3 files touched (2 new source/script files, 1 new test file) + a
1-line `package.json` addition. 0 existing files' behavior changed.

## Baseline / Evaluation Receipt (Step 7–9)

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs
dist`), this repo's real, only test entrypoint. `LLM_EVAL=not-needed`
(deterministic classifier + `node:test`, no model call in the evaluation
itself, despite a key being present).

- `npm ci && npm run build`: clean, 0 errors, both before and after the
  candidate.
- **Baseline** (`main`@`6e73a8f060bcbb69965a50ffe4627e33622d4094`, this
  session's own first action tonight, before any file was added): `npm
  test` → **327/327 pass, 0 fail**.
- **Candidate** (3 files added as above): `npm test` → **336/336 pass, 0
  fail, 0 regressions** (327 pre-existing + 9 new).
- **Live measurement** (`npm run dream:triage`, run against all 58
  `origin/dream/*` branches, diffed against `origin/main` at tonight's tip):

  | Tier | Count |
  |---|---|
  | `docs-only` (zero production risk) | 4 — `dream/2026-10-13-performance`, `dream/2026-10-16-security`, `dream/2026-11-03-performance`, `dream/2026-11-08-performance` |
  | `mechanical` (small, test-covered) | 41 |
  | `needs-review` (no test coverage, or above the 3-file mechanical threshold) | 13 |
  | **Total** | **58** |

  Full per-branch output captured in this session's evaluation receipt (see
  Witness §4 for the exact reproduction command). The 4 `docs-only` branches
  are immediately safe to fast-track (squash-merge or close) with no code
  review at all — they carry only a SOTA report + a ledger row. The 13
  `needs-review` branches (7 flagged specifically for "0 production files
  changed" — i.e. a tooling/script/doc change outside `src`/`services` that
  this heuristic can't yet classify as low-risk, plus 6 genuinely
  production-diff-with-no-test-file cases) are the backlog's actual priority
  tail for careful human attention.

## Darwin Lineage

Not run — deterministic classifier over a fixed, disclosed heuristic
(file-path prefix + count thresholds), not a continuous parameter to
evolve. Same judgment call as `#90` (TTL ceiling) and `#119` (contention
detector): nothing here is a fitness landscape worth searching.

## Evidence

- OBSERVATION: `main`'s `LEDGER.md` is frozen at 2026-09-06; live GitHub
  state (58 open `dream/*` PRs, 0 merged since `#15`) diverges sharply from
  it.
- OBSERVATION: CI (`scaffold-check`) is green on `#127`, `#123`, `#105` —
  CI health is not the reason these PRs sit unreviewed.
- OBSERVATION: `ci.yml`'s Node 20 pin is a deliberate, documented reversion
  (`45bca73`), not a regression.
- MEASUREMENT: baseline `327/327`; candidate `336/336`, 0 regressions.
- MEASUREMENT (live, tonight, fully paginated branch list): 58 open
  `dream/*` branches → 4 docs-only / 41 mechanical / 13 needs-review.
- INFERENCE: a meaningful fraction (4/58, ~7%) of the backlog carries zero
  production risk and needs no code review at all; a further majority
  (41/58, ~71%) is small and test-covered. Only 13/58 (~22%) is the genuine
  priority tail.
- DECISION: ship the classifier + live CLI as tonight's candidate, so this
  triage is repeatable by a human (or a future night) in seconds rather than
  re-derived by hand each time.
- REJECTION: none this cycle — the candidate was correct on first
  evaluation; no alternative design was implemented and discarded.

## Reward-Hack Check (Step 11, independent pass)

- Weakened the benchmark/tests? No — 9 tests added, 0 removed, 0 skipped, 0
  existing assertions altered.
- Altered gold answers/evaluator internals? No — no gold data for this
  surface; `npm test` itself untouched.
- Cherry-picked a favorable metric? No — the full 58-branch set was scanned
  and reported (not a sample tuned to look good); the `needs-review` count
  (13, the "least flattering" bucket) is reported plainly, same discipline
  `#119` used for its own 51/53-clean number.
- Exploited the evaluator / undocumented cache? No — pure function, no
  caching, no timing dependence.
- Hid cost? No — `npm run dream:triage` is a new, optional script; nothing
  in the existing `test`/`build`/CI path changed.
- Touched a threshold? The classifier's own thresholds (`docs/`-only
  prefix match; ≤3 production files to count as "mechanical") are new,
  disclosed heuristic constants it introduces for its own purpose — it does
  not touch `.harness/bench.json`, any existing test assertion, or any
  CI gate threshold.
- **Disclosed limitation** (not a hack, a real heuristic gap): file-path
  triage cannot see line-level diff size or semantic risk — a single
  massively-rewritten file with a thin test still tiers as `mechanical`.
  This is stated plainly in the Hypothesis and in the module's own doc
  comment, not hidden.

Critic verdict: no unresolved reward-hack signal; one disclosed heuristic
limitation, not a defect.

## Security Review (Step 15)

- **Prompt injection / untrusted text**: n/a — no LLM calls, no external
  text parsed; input is a list of file paths from local `git` plumbing.
- **Tool/MCP authority**: no new tool or MCP surface. The CLI only shells
  out to `git fetch`/`git diff` against the repo's own already-configured
  `origin` remote — no new credential, no new host.
- **Command injection**: `execFileSync` with argument arrays throughout
  (never string-interpolated into a shell), so a maliciously-named branch
  cannot inject shell syntax.
- **Filesystem/network scope**: unchanged — read-only `git` plumbing,
  no writes to any branch, ledger, or PR.
- **Least privilege**: no MCP tool permissions changed; no new dependency
  added.

## Scan Findings — ci, tooling

- **ci**: `scaffold-check` is green on every recently-sampled `dream/*` PR;
  the Node-20 pin is intentional (see Deep Dive). No CI change proposed
  tonight — the surface is healthy.
- **tooling**: `npm run lint` remains a no-op stub (`#104`/`#105`,
  2026-10-29, still open/unmerged) — not re-implemented tonight to avoid
  duplicating that still-valid, unreviewed candidate. `.claude-flow/`/
  `.swarm/` untracked-dir nuisance is already fixed by `#110`/`#111`
  (2026-10-31, still open, `mergeable: clean`) — not duplicated tonight.

## Competitors / Prior Art (graded)

| Source | Claim | Grade |
|---|---|---|
| This repo's own dream-cycle history (`#92` 10-22, `#117` 11-03, `#127` 11-08) | Three+ prior nights independently measured the backlog's *size* (open-PR count, 0% merge rate); none measured its *composition* by review risk — the gap this candidate fills | A (primary source, this repo, already reviewed by subsequent nights) |
| GitHub's own `actions/stale` / Probot `stale` app documentation | Official first-party precedent for automatically classifying a PR/issue backlog by a cheap, deterministic signal (age) to reduce reviewer triage cost — same goal (cut backlog-triage cost), different signal (this candidate uses changed-file risk, not age, since age alone doesn't distinguish a docs-only PR from a risky one) | A (official, GitHub's own tooling) |
| Renovate's `automerge`/`matchFileNames` configuration model | Vendor-but-widely-adopted precedent for file-path-based auto-merge-eligibility rules (lockfile-only / docs-only changes auto-merge, source changes don't) — directly analogous risk-tiering-by-path-prefix approach, cross-checked against this repo's own file layout rather than copied | B (vendor, cross-checked against this repo's actual structure) |
| `paperclipai/paperclip` (named competitor, `dream.config.json`) | Not inspectable within tonight's session scope (outside this session's GitHub access) — same disclosed gap every prior night has reported for this competitor; no claim made | — (not reproducible tonight) |

## Issue

[#128](https://github.com/ruvnet/ruClip/issues/128)

## Gist

No `gh` CLI / gist-creation MCP tool available this session (`gh auth
status` fails — `GH_TOKEN` invalid; GitHub MCP tools are read/write-capable
for this repo but expose no gist-creation call). Per the routine's own
fallback rule, the full report is this committed file. `GIST=LOCAL`.

## Next steps (3, concrete)

1. **Fast-track the 4 `docs-only` branches** (`dream/2026-10-13-performance`,
   `dream/2026-10-16-security`, `dream/2026-11-03-performance`,
   `dream/2026-11-08-performance`) — zero production risk, pure research
   record, safe to squash-merge or close without a code review pass.
2. **Prioritize the 13 `needs-review` branches** for careful human attention
   over the 41 `mechanical` ones — in particular the 6 that change
   production code with no accompanying test file at all.
3. **Re-run `npm run dream:triage` each future dev-experience/ci,tooling
   night** rather than hand-deriving the backlog composition — it's now a
   10-second, zero-cost, repeatable measurement instead of a manual count.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
this `## Witness` heading.

```
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
REPORT_HASH    = a72352b5e06fd175f11f37f90a8578ebcd8b796bada4dd56b848a4e313abc9a4
WITNESS        = 0205e4fe9605bd6ab10b7f2d1002a3b492ea64b69f6f55e6edbf2745df3e39eb
```

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm this is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-11-09-developer-experience-report.md | sha256sum` — confirm it matches `REPORT_HASH` above.
3. `printf '%s%s' <REPORT_HASH> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` — confirm it matches `WITNESS` above.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- . && npm ci && npm test` — confirm 327/327 pass (baseline receipt).
5. Apply this PR's diff and re-run `npm test` — confirm 336/336 pass, 0 regressions; then `npm run dream:triage` — confirm the 4/41/13 split above (branch set will have shifted with time; re-derive, don't expect an exact match after this PR merges or new nights run).

## Recommendation

`evaluated: accepted`. Recommending human review and merge — small (3 files
+ 1 `package.json` line), additive-only, 336/336 green, 0 regressions,
read-only CLI, and directly actionable: it turns "the backlog is a known
problem" (measured ≥6 times already) into "here is exactly which 4 branches
are free to fast-track and which 13 need real attention first." This
session never self-merges or self-promotes candidate state.
