# ADR-0002: Dream Cycle candidate-promotion backlog is a governance gap, not a candidate-quality gap

- **Status**: Proposed
- **Date**: 2026-10-12
- **Deciders**:
- **Tags**: dream-machine, governance, ci, dream-cycle

## Context

`ruvnet/ruClip`'s nightly Dream Machine cycle (ADR-0001 point 6) opens one
draft PR against `main` per run and, by standing invariant, never merges
one — "human review required" is the stated merge policy on every PR it has
ever opened. Measured live tonight (2026-10-12) against the real GitHub
state:

- **30** `dream/*` branches exist on `origin`, spanning 2026-09-02 through
  2026-10-11 (`git branch -r --list 'origin/dream/*'`), every one still an
  open draft PR.
- CI (`.github/workflows/ci.yml`) is **green on every sampled run**
  (`mcp__github__actions_list` → `list_workflow_runs(event: pull_request)`
  and spot-checks on PRs #9, #19, #35, #47, #53, #61, #65, #68, #70 — all
  `conclusion: success`). CI is not the blocker.
- **0** of these PRs have been merged via GitHub's review/merge button.
  Exactly 3 early commits (#11/#13/#15) were manually squashed onto `main`
  outside normal PR review, in the repo's first week; nothing since.
- Two sessions have already independently rediscovered and reimplemented an
  older, now-stale candidate from scratch, saying so explicitly in their own
  commit message: PR #53 ("Supersedes stalled, unmerged PR #19") and PR #61
  ("Redoes the identical candidate stale draft PR #9"). Both superseded PRs
  (#9, #19) remain open.
- Two prior dream-cycle nights (2026-09-19 PR #35, 2026-09-29 PR #47)
  already diagnosed adjacent symptoms of this same backlog — ledger rows
  siloed on unmerged branches, and no CI-visible branch-staleness signal —
  and shipped clean, ACCEPT-verdict, unit-tested tools for each. Both PRs
  are themselves still open and unmerged, 23 and 13 days later respectively.
- The repo's own learning signal ("0 of last N PRs merged → bias to tiny,
  reviewable candidates") has been live and applied for months. It has not
  changed the merge rate, because — per external evidence below — PR size
  was never the actual constraint.

External grounding (graded; see tonight's full report,
`docs/dream-cycle/2026-10-12-architecture-report.md`, for the complete
table):

- An MSR 2026 mining-challenge study of agent-authored fix PRs (Grade A,
  peer-reviewed-venue submission) finds non-integration is driven mainly by
  failing tests, oversized diffs, and **prior resolution of the same issue
  by another PR** — the exact #9/#19 pattern observed here.
- `paperclipai/paperclip` — the system ADR-0001 names as ruClip's own
  architectural model — ships a dedicated, explicitly bounded (3-round),
  read-mostly **"PR gardening"** skill whose only job is tending
  already-opened PRs (CI fixes, review responses) under a hard guardrail:
  "never merges, approves, or closes a pull request," scoped to PRs the
  instance itself opened (Grade B, cross-checked third-party skill
  mirrors). `ruClip`'s dream-cycle has the PR-*opening* half of this shape
  and no counterpart that ever reduces the backlog.
- Paperclip's companion `prepare-paperclip-pr` skill also caps every PR at
  <100 changed files and runs iterative automated review to a clean state
  *before* a human ever sees it (Grade B) — raising the odds a human says
  yes, rather than only adding to a queue that never drains.

## Decision

This ADR records an architectural **finding and recommendation**, not a
code change to `main`'s merge policy (this session has no authority to
change that policy, and never self-merges or self-promotes a candidate —
ADR-0001's and the nightly routine's own standing invariant). What it does
decide, for the dream-cycle's own tooling going forward:

1. **The backlog is a governance/throughput gap, not a candidate-quality
   gap.** Future dream-cycle nights should stop treating "0 of N merged" as
   a signal to shrink candidates further (already tried, already
   ineffective per the evidence above) and instead treat it as a standing
   fact to report, not re-solve nightly.
2. **Duplicate detection is now a first-class, reusable capability.**
   `src/control-plane/dream-cycle/supersession-audit.ts` (this PR) is the
   canonical tool for finding self-admitted duplicate/stale candidates by
   text admission in commit history. It is deliberately conservative
   (precision over recall: text-admission only, no code-similarity
   heuristic) and read-only against GitHub.
3. **Closing a confirmed, self-admitted duplicate is not "promotion" and is
   not forbidden by the never-merge invariant.** It is pure backlog
   hygiene: it changes no code, no test, no benchmark state, and is
   reversible (a closed draft PR can be reopened). This session closes PR
   #9 and PR #19 on that narrow basis — each has an already-public,
   independently-verifiable admission, from its own superseding PR's
   author (this same routine, in an earlier run), that it was fully
   reimplemented and that the reimplementation's own evaluation receipt
   (330/330 and 327/327→330/330 tests respectively) already supersedes it.
4. **Open question for the human reviewer, not decided here**: whether to
   (a) adopt a `paperclipai/paperclip`-style bounded gardening phase (CI-fix
   and review-response only, still never merge) as a named dream-cycle
   phase, (b) authorize nightly auto-closure of future self-admitted
   duplicates under this same narrow rule, or (c) leave backlog disposition
   entirely to periodic human batch review. This ADR stays **Proposed**
   until that choice is made.

## Consequences

### Positive
- Gives future dream-cycle nights a tested, reusable way to recognize "this
  was already solved and abandoned" before spending a night re-solving it
  again (directly serving the routine's own "make tomorrow's search space
  smaller" operating principle).
- Removes 2 confirmed-dead branches from the open-PR count without touching
  any code, test, or benchmark state, and without requiring the backlog's
  harder, as-yet-undecided question to be resolved first.
- Grounds a months-old, previously circumstantial internal observation ("PRs
  pile up") in both hard measurement (30 branches, 0% merge rate, 100%
  sampled CI pass rate) and external, graded prior art, making the case for
  human attention concrete rather than anecdotal.

### Negative
- Does not fix the underlying throughput problem — only a human decision
  (point 4) can do that. Absent that decision, the backlog keeps growing by
  about one branch per night.
- The detector's conservative, text-only design means it will miss
  duplicate work that isn't self-admitted in a commit message — a known,
  documented limitation, not a silent one.

### Neutral
- `reconcile-ledger.ts` (PR #35) and `branch-audit.ts` (PR #47) remain valid
  and are not superseded by this ADR or this candidate — they solve
  adjacent, different problems (ledger durability; staleness visibility)
  and should be reviewed alongside this PR, not instead of it.

## Links

- ADR-0001 — names `paperclipai/paperclip` as ruClip's architectural model
  and the dream-cycle integration this backlog belongs to (point 6)
- PR #9 (2026-09-02), PR #19 (2026-09-08) — the two confirmed, self-admitted
  superseded candidates closed by this session
- PR #53 (2026-10-02), PR #61 (2026-10-07) — the superseding PRs whose own
  commit messages are this ADR's primary evidence
- PR #35 (2026-09-19), PR #47 (2026-09-29) — prior, still-unmerged
  dream-cycle attempts at adjacent backlog symptoms
- `docs/dream-cycle/2026-10-12-architecture-report.md` — full SOTA report,
  competitor table, evidence trail, and witness stamp for tonight's run
