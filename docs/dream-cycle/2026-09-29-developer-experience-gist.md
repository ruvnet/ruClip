# Developer-Experience SOTA Report — 2026-09-29

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 4 (`DAYINT % 5 = 4`): DEEP=developer-experience, SCAN=ci,tooling.
Bonus check: `20260929 % 25 = 4` (not 0) — no roadmap-review bonus tonight.

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip)
**Branch**: `dream/2026-09-29-developer-experience`

## TL;DR

`ruvnet/ruClip`'s own Dream Cycle backlog of unmerged `dream/*` branches has
grown from **9** (measured 2026-09-19, PR #35) to **18** tonight — nearly
doubling in 10 days, and it is now the dominant open-PR population on the
repo (18 of 19 open PRs are `dream/*`; only #7's non-dream-cycle sibling
history is older). Literally **0 of ~20** Dream Cycle PRs have ever merged
via GitHub's merge button (3 — #11/#13/#15 — were manually squashed onto
`main` by a human outside the PR-merge flow; the other 15+ sit open,
`draft: true`, `mergeable_state: clean`, CI green, with no reviewer action).
2026-09-19's own report (PR #35, itself still unmerged) diagnosed the root
disease (ledger rows siloed on unmerged branches) and shipped a
reconciliation tool, but explicitly **deferred** a second, distinct
finding as "Next Step #2": *make the backlog itself visible in CI*, since
right now the only way to see it is to manually cross-reference
`list_pull_requests`/`list_issues` the way both that session and this one
did by hand. Tonight implements exactly that deferred, distinct candidate
— a small, pure, unit-tested branch-staleness audit plus a non-gating CI
step — with fresh evidence that the backlog it will report on has nearly
doubled since it was last measured.

## What's new

- `src/control-plane/dream-cycle/branch-audit.ts` — pure `auditBranches`:
  takes `{name, lastCommitIso}[]` + `now` + a staleness threshold (default
  3 days, matching 2026-09-19's own proposed threshold), returns the stale
  subset sorted oldest-first plus counts. No I/O, no git calls — fully
  unit-testable.
- `scripts/dream-branch-audit.mjs` — CLI wrapper: best-effort
  `git fetch origin '+refs/heads/dream/*:refs/remotes/origin/dream/*'`
  (failure is logged and treated as "use whatever local refs exist", never
  fatal), `git for-each-ref` over `refs/remotes/origin/dream/*` (static
  argv, no shell interpolation), prints a human-readable report, exits 0
  unconditionally (advisory, matching `harness:advisory`'s own
  `continue-on-error` convention — this must never block a future
  contributor's unrelated PR because of a backlog they didn't create).
- `package.json`: +1 script, `dream:branch-audit`.
- `.github/workflows/ci.yml`: +1 advisory step (`continue-on-error: true`),
  so the backlog count appears in every future PR's own CI log without
  requiring a new `schedule:` trigger or any GitHub API token/scope this
  session hasn't already got.
- `docs/dream-cycle/BRANCH-AUDIT.md`: tonight's real, live-generated
  snapshot (regenerable, not a source of truth — same "committed for
  tomorrow's session" precedent as 2026-09-19's `LEDGER.reconciled.md`).
- 8 new unit tests (`tests/control-plane/branch-audit.test.ts`).

## 5 candidates considered (scored 1-5 on fit/novelty/testability/measurability/production-value/reviewability)

1. **Branch/PR backlog visibility in CI** (2026-09-19's deferred Next Step
   #2, now with fresh evidence the backlog nearly doubled) — 5/4/5/5/4/5 =
   **28**. SELECTED.
2. Re-implement/extend `reconcile-ledger` from PR #35 (still unmerged) —
   5/1/4/4/4/3 = 21. Pure duplication of already-shipped-but-unmerged work;
   no new evidence justifies redoing it, only extending its *deferred*
   sibling.
3. Wire `npm run lint` into a real gate (still a no-op stub on `main`; PR
   #21, 2026-09-09, unmerged) — 4/1/4/3/3/3 = 18. Same disease as #2 (a
   good fix stuck in an unmerged branch); 2026-09-19 already declined to
   re-litigate this for the same reason.
4. Add `cache: npm` to `actions/setup-node` in `ci.yml` — 3/3/2/2/3/5 = 18.
   Real but weakly testable from inside this session (the benefit only
   shows up on a second CI run this session can't trigger); smaller
   production value than the backlog-visibility gap.
5. Implement 2026-09-19's Next Step #1 (ledger row commits straight to
   `main`, bypassing the PR) — 5/2/3/3/5/1 = 19. Explicitly flagged by
   2026-09-19 as the routine owner's decision (`PROMPT.md`: "Do not
   hand-edit"), not this session's to make unilaterally. Disqualified on
   authority grounds, not score.

No override of the top score needed.

## Hypothesis (frozen before implementation)

> Given the real, live state of `ruvnet/ruClip`'s git remote (as of
> tonight: 18 `dream/*` branches on `origin`, spanning 2026-09-02 through
> 2026-09-28, every one either still `open`/`draft`/unmerged or `closed`
> without GitHub recording a merge), when a deterministic branch-audit tool
> (`auditBranches`) classifies each branch's age against a 3-day staleness
> threshold, then the tool should correctly separate the genuinely stale
> backlog from branches too young to flag, with zero false
> positives/negatives against ages computed independently via
> `git for-each-ref --format=%(committerdate:iso8601)`, verified both by
> unit tests over synthetic fixtures (below/at/above threshold, empty
> input, sort order) and by a real run against the live repository
> tonight; subject to: the tool never mutates any branch, ledger, or PR
> state (read-only), and its CI integration is advisory
> (`continue-on-error: true`), never a hard gate that could block an
> unrelated future contributor's PR over a backlog they did not create.
>
> (One hypothesis-phase assumption corrected once real data was pulled,
> before evaluation began: the initial draft assumed all 18 branches would
> be >3 days old; the two most recent, 2026-09-27 and 2026-09-28, are not.
> The frozen prediction above — correct separation, not "all stale" — is
> what was actually evaluated.)

## Evaluation Receipt

See `docs/dream-cycle/2026-09-29-developer-experience-report.md` for the
full reproduced receipt (baseline/candidate test counts, real live audit
output, `harness:bench-verify` hash).

## Witness

See the committed report's Witness section for the full stamp and
verifier procedure (this file's own sha256 feeds that stamp).

## Next steps (concrete)

1. Wire `dream:branch-audit`'s output into an actual PR/issue comment on a
   `schedule:`-triggered workflow (not just the advisory `pull_request`
   step shipped tonight) — needs `GITHUB_TOKEN` write scope this session
   hasn't verified is available; deferred, not this session's to assume.
2. 2026-09-19's Next Step #1 (ledger-row-to-`main` structural fix) and
   Next Step #3 (trust boundary on branch-sourced content) remain open —
   unaffected by tonight's candidate, still routine-owner decisions.
3. The 4-day gap 2026-09-23..2026-09-26 (no `dream/*` branch, no PR) found
   incidentally tonight while enumerating branches is itself worth a future
   night's investigation — not investigated further here (out of scope for
   tonight's `<300`-line target).
