# Architecture SOTA Report — 2026-11-12

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 2 (`DAYINT % 5 = 2`): DEEP=architecture, SCAN=docs,api.

## TL;DR

Prior architecture nights (`#9`, `#17`, `#31`, `#61`, `#82`, `#125`) treated
`agentdb-adapter.ts`'s god-module status as the architecture surface and
extracted bounded contexts from it one at a time; `#125` (2026-11-07) took
the *last* zero-contention, zero-call-site piece, so that vein is now
exhausted without adding an 8th branch to the file's existing cross-branch
contention. Separately, developer-experience and security nights
(`#35`, `#47`, `#72`/`#74`, `#84`/`#86`, `#92`, `#117`/`#127`, `#119`, `#129`,
`#133`) have repeatedly measured that the dream-cycle backlog's merge rate
is 0% and is growing (53→58→61 open `dream/*` branches since early
November alone) — `autoMerge: false` is a deliberate, documented safety
invariant (`docs/design/DREAM-MACHINE-INTEGRATION.md` lines 58-67: "the same
'evaluation is not promotion' invariant this repo already holds
throughout"), not a bug to fix autonomously. `#119` (2026-11-04) measured
each branch *independently* against bare `main` and found 51/53 pairwise-
clean. That is a weaker guarantee than it looks: it says nothing about
whether those branches are mergeable *against each other*.

Tonight's architecture finding: they mostly aren't. Simulating a
chronological (oldest-first) integration — each branch merge-tried against
the tip left by every earlier branch that applied cleanly, using
`git merge-tree --write-tree` plus a synthetic (never-pushed, no-ref)
`git commit-tree` to chain commit-ish tips — only **3 of 61** open
`dream/*` branches (`dream/2026-09-06-security`, `dream/2026-09-07-
architecture`, `dream/2026-10-06-security`) merge cleanly in sequence from
`main`. The other 58, including the very first (oldest) branch
(`dream/2026-09-02-architecture`, independently confirmed by `#125` to have
`mergeable_state: dirty`), conflict against the running integration tip.
"51/53 individually clean" and "3/61 clean as a sequence" describe the same
backlog from two different, both-true angles — the first is the right
metric for "can a human look at any one PR on its own," the second is the
right metric for "how much of this backlog could go in during one review
sitting." No prior night measured the second one.

## What's new / prior art

- `git merge-tree --write-tree <commit> <commit>` (git ≥2.38) performs a
  real three-way merge entirely in the object database — no checkout, no
  index or working-tree mutation, no ref created — and prints the resulting
  tree's SHA on success or a nonzero exit + conflict details on failure.
  Grade A (git's own documented behavior, confirmed live against this
  repo's git 2.43.0 install, not assumed).
- `merge-tree --write-tree` needs a *commit-ish* on each side, because it
  computes a merge-base; a bare tree SHA from a previous step isn't one.
  Chaining merges therefore requires synthesizing a commit (`git
  commit-tree <tree> -p <tip> -p <branch>`) to carry forward as the next
  step's "integration tip." This synthetic commit is a loose object local
  to this container's `.git` only — never pushed, never attached to a ref —
  and is exactly the kind of local, read-only-in-effect git plumbing
  `#119`/`#129` already established as this routine's convention. Grade A
  (directly executed and verified this session: 61-branch live run below).
- Competitor check: `paperclipai/paperclip` has no nightly self-evolution
  loop at all (confirmed by `ADR-0001`'s original research), so it has no
  analogous backlog-mergeability problem to compare against. The closer
  comparison is `ruvnet/dream-machine`'s own stated operating model
  ("never merges — draft PRs only", per `ADR-0001` context) — i.e. the
  unmerged backlog isn't ruClip-specific drift, it's the documented
  steady-state of every repo this engine runs against. Grade B (cited via
  this repo's own ADR, not independently re-verified against the
  `dream-machine` repo itself tonight — out of scope).

## Hypothesis (frozen before implementation)

> Given the ≥53 open `dream/*` branches already confirmed independently
> clean against `main` (dream-cycle 2026-11-04, PR #119), when those same
> branches are merged cumulatively in chronological (oldest-first) order
> against the running integration tip (not against bare `main` each time),
> at least one additional conflict will appear that the pairwise-vs-main
> check could not see — because PR #119 only tested each branch against
> bare `main`, not against the combined effect of earlier branches in the
> same backlog, and 7+ open branches are already known to touch the same
> file (`agentdb-adapter.ts`). This quantifies the TRUE serially-mergeable
> prefix length, a new metric no prior night has measured, subject to: no
> mutation of any branch/PR/ledger history, no GitHub API calls required
> (pure local git plumbing), and no claim of semantic correctness beyond
> tree-level merge-conflict detection.

Not modified after evaluation began.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs
dist`). No LLM calls — mechanical, deterministic refactor + a live local
git-plumbing run.

| | Tests | Pass | Fail | tsc --strict | Duration |
|---|---|---|---|---|---|
| Baseline (`6e73a8f060bcbb69965a50ffe4627e33622d4094`, unmodified) | 327 | 327 | 0 | clean | 1904.51ms |
| Candidate (this branch) | 335 | 335 | 0 | clean | 1857.40ms |

8 new unit tests (synthetic fixtures, deterministic, independent of the
live branch graph so they won't flake as branches merge/close), 0
regressions in the pre-existing 327.

### Live run against the real backlog (the finding itself)

`node scripts/dream-cycle-sequential-mergeability.mjs` against all 61 real
`origin/dream/*` branches, base = `main`@`6e73a8f060bcbb69965a50ffe4627e33622d4094`:

```
MERGED    dream/2026-09-06-security
MERGED    dream/2026-09-07-architecture
MERGED    dream/2026-10-06-security
CONFLICT  (the other 58 branches, including the oldest, dream/2026-09-02-architecture)

total dream/* branches: 61
merged in sequence: 3
conflicted in sequence: 58
longest clean prefix (oldest-first, unbroken): 0
first conflict: dream/2026-09-02-architecture
```

Sanity cross-check: `#125` (2026-11-07) independently reported PR #9's
branch (`dream/2026-09-02-architecture`) as `mergeable_state: dirty` against
`main` — exactly the branch tonight's tool reports as the first conflict,
from an entirely different measurement method (GitHub's own mergeable_state
vs. local `git merge-tree`). The two independent methods agree.

`longestCleanPrefix` is 0 because the very oldest branch conflicts
immediately; the three merges that do succeed happen out of strict prefix
order (branch 3 and 4 merge, skip to branch ~23 for the third), which is
exactly the behavior `simulateSequentialMerge`'s unit tests pin down
(a mid-sequence conflict doesn't block later clean branches, but it does
stop `longestCleanPrefix` from growing).

## Darwin Lineage

Not applicable — deterministic classifier/simulator over real git
plumbing, no continuous fitness function to search (same reasoning as
`#119`/`#129`'s precedent).

## Evidence

- OBSERVATION: 61 open `dream/*` branches; `#119` (2026-11-04) measured
  51/53 individually clean against bare `main`; `#125` (2026-11-07)
  independently flagged `dream/2026-09-02-architecture` as
  `mergeable_state: dirty`.
- MEASUREMENT: baseline 327/327 @ 1904.51ms; candidate 335/335 @
  1857.40ms; live sequential-merge run: 3/61 merge cleanly in chronological
  order, 58/61 conflict, longest unbroken clean prefix = 0, first conflict
  = the oldest branch.
- INFERENCE: "individually clean vs. main" (#119's metric) and "clean as a
  chronological sequence" (tonight's metric) are both true and measure
  different things; the gap between 51/53 and 3/61 is the actual cost of
  the backlog's age and cross-branch file contention, not a flaw in #119's
  method.
- DECISION: ACCEPT, recommended for human review — the tool itself (not the
  measurement's pessimism) is the candidate; it gives a human reviewer a
  concrete, reproducible answer to "which of these can I merge together
  right now without manual conflict resolution," which `#119`'s per-branch
  check cannot answer.

## Reward-Hack Check

No test file in the pre-existing suite touched; no gold answer, threshold,
or benchmark corpus modified; no mock or cache introduced; the real `npm
test` entrypoint ran unmodified. The live run reports its least-flattering
number plainly (3/61, not reframed as "95% individually mergeable" — that
framing belongs to #119, not this tool). The synthetic `git commit-tree`
objects created during the live run are local-only, never pushed, attached
to no ref, and don't touch the working tree or index — disclosed in both
the script's own header comment and here, not hidden.

## Security Review

`execFileSync` with argument arrays throughout (`git merge-tree`, `git
commit-tree`, `git for-each-ref`, `git rev-parse`) — no shell
interpolation of branch names or refs. Read/local-object-write-only: no
network calls, no credentials, no new MCP/tool-authority surface, no
mutation of any existing branch, tag, or the working tree/index. Matches
the established `execFileSync`-with-argument-arrays convention from
`#119`/`#129`.

## Scan: docs

`docs/design/DREAM-MACHINE-INTEGRATION.md` (lines 58-67) already documents
`autoMerge: false` as a deliberate, permanent safety invariant — tonight's
candidate is positioned accordingly: decision support for a human's eventual
merge sweep, not a claim that the 0% rate itself is a defect to be
autonomously corrected. No doc drift found here; this scan's only finding
is confirmation that the design doc and tonight's framing agree.

## Scan: api

No new MCP/HTTP bridge surface touched tonight. The new CLI
(`scripts/dream-cycle-sequential-mergeability.mjs`) follows the existing
local-tooling CLI convention (`dream:triage`, `dream:contention` from
`#129`/`#119`): flags, `execFileSync` with argument arrays, plain stdout
summary, exit code signaling pass/fail. No findings beyond consistency with
that established shape.

## Competitors

| | Nightly self-evolution loop? | Draft-PR-only merge policy? | Backlog-mergeability tooling? |
|---|---|---|---|
| `ruvnet/ruClip` (this repo) | yes (Dream Machine) | yes (`autoMerge: false`) | tonight: sequential-merge simulator (new) |
| `ruvnet/dream-machine` (the engine itself, run against `ruflo`/`metaharness`) | yes | yes ("never merges — draft PRs only", per ADR-0001) | unknown — out of scope tonight |
| `paperclipai/paperclip` | no | n/a | n/a |
| generic Dependabot/Renovate-style bots | yes (narrower scope) | usually auto-merge-eligible for low-risk bumps | not applicable — single-purpose diffs rarely conflict with each other |

## Witness

```
REPORT_HASH    = 480fff05b7a3bb9a10837d41e507b8f2a2b4074187bd3f7cfc7876029e247f5a
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = f3aea2b78dbd7c846c5f35206804a4c4d9dbb66adb4ebf82c7c2ce830dfe8981
```

`REPORT_HASH` is the sha256 of this file's content up to (and including) the
line directly above this Witness section — i.e. everything before `##
Witness` itself — computed once, before this section was filled in (a
self-referential hash of the whole file including its own hash would be
circular). `WITNESS = sha256(REPORT_HASH || SESSION_COMMIT)`, computed as
`printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text up to (not including) the `##
   Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal
   `WITNESS` above.
5. `npm test` on this branch → must reproduce 335/335 (0 fail).
6. `git fetch origin --prune && npm run build && node
   scripts/dream-cycle-sequential-mergeability.mjs` → must reproduce
   `merged in sequence: 3`, `first conflict: dream/2026-09-02-architecture`
   (the branch set will have grown since tonight; earlier branches'
   outcomes should remain stable).

## Recommendation

1. **Accept for human review.** Purely additive tooling (1 new source
   module, 1 new test file, 1 new CLI script, 1 new npm script entry, 1 new
   doc, 1 ledger row); 0 behavior change to any existing file; 335/335
   (327 pre-existing + 8 new), 0 regressions.
2. If a human does a merge sweep, `dream/2026-09-06-security` →
   `dream/2026-09-07-architecture` → `dream/2026-10-06-security` is a
   concrete, verified-clean three-PR merge order to start with, with zero
   manual conflict resolution required.
3. This does not fix, and is not intended to fix, the 0%-merge-rate — that
   requires human review time, which is outside this routine's authority
   (`autoMerge: false` is a deliberate invariant, not a bug). The value here
   is making the next human merge sweep faster and lower-risk to execute.

## Next Steps

1. Re-run `dream:seq-merge` after any real merge (even a single PR) — the
   simulator is cheap (no model calls, seconds of git plumbing) and its
   output changes immediately once `main` moves, unlike the once-per-
   measurement snapshots `#119`/`#129` produced.
2. Investigate why `dream/2026-09-02-architecture` (the very first
   dream-cycle branch, `#9`) still conflicts with current `main` after 2+
   months — likely candidate: `agentdb-adapter.ts` has been edited by
   later *merged* work (e.g. `#15`) in ways `#9`'s diff predates; worth a
   dedicated rebase-or-close decision by a human rather than further
   autonomous measurement.
3. If a future night has GitHub-API access and wants to go further: cross-
   reference tonight's local git-plumbing conflict set against each
   branch's live `mergeable_state`/`mergeable` fields (same cross-check
   already done by hand for `dream/2026-09-02-architecture` against `#125`)
   to confirm the two methods agree across the full backlog, not just the
   one branch sampled tonight.
