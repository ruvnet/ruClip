# Architecture SOTA Report — 2026-10-12

## TL;DR
`ruvnet/ruClip`'s own nightly Dream Cycle has quietly accumulated **30
unmerged `dream/*` branches** on `origin` (2026-09-02 → 2026-10-11), every
one still open as a draft PR, CI green on every sampled run, **zero merged
via GitHub's review/merge button** (3 early commits — #11/#13/#15 — were
manually squashed onto `main` outside normal PR review; everything since
has simply piled up). Twice already a session independently rediscovered
and reimplemented an older stale candidate from scratch, and said so in its
own commit message (PR #53 "Supersedes stalled, unmerged PR #19"; PR #61
"Redoes the identical candidate stale draft PR #9"). Tonight's finding: the
routine that generates nightly candidates has no counterpart that ever
*shrinks* the backlog — and `ruClip`'s own named architectural model,
`paperclipai/paperclip`, ships exactly that counterpart as a guardrailed
"PR gardening" skill. Candidate: a small, pure, git-only tool
(`supersession-audit`) that mechanically finds self-admitted duplicate-PR
claims in commit history — live run against the real repo recovers both
known cases (PRs #9 and #19) with zero false positives across all 53
commits on all 30 branches.

## What's new
- `src/control-plane/dream-cycle/supersession-audit.ts` — pure
  `parseSupersessionClaims`/`summarizeSupersessionClaims`, no I/O.
- `scripts/dream-supersession-audit.mjs` — CLI wrapper, git-only
  (`execFileSync` static argv, no shell interpolation of branch names),
  writes `docs/dream-cycle/SUPERSESSION-AUDIT.md`.
- `package.json`: +1 script, `dream:supersession-audit`.
- 8 new unit tests, 2 of them built from the real, verbatim commit text of
  PRs #53 and #61.
- No production control-plane file touched.

## Competitors / prior art (candidate-backlog governance)
| System | Relevant lesson | Grade |
|---|---|---|
| `paperclipai/paperclip` (named competitor) — `pr-gardening` skill | Ships a dedicated, explicitly bounded (3 rounds), read-mostly loop whose entire job is tending *already-opened* PRs (CI fixes, review responses) under a hard guardrail: "never merges, approves, or closes a pull request," scoped only to PRs the instance itself opened. `ruClip`'s dream-cycle has the PR-opening half of this pattern and nothing resembling the gardening half. | B (third-party skill-definition mirrors of the real `SKILL.md`, cross-checked across 3 independent mirror sites with consistent wording; not the primary repo) |
| `paperclipai/paperclip` — `prepare-paperclip-pr` skill | Caps every PR at <100 changed files (a reviewer-tool limit) and runs iterative automated review (Greptile) to 5/5 clean *before* a human ever sees it — i.e. it raises the odds a human reviewer says yes, rather than only producing more candidates for a queue that never drains. | B (same caveat as above) |
| MSR 2026 mining-challenge study, "LGTM Characteristics of Auto-Merged LLM-based Agentic PRs" | Across real agent-authored PRs, non-integration is driven mainly by failing tests, oversized diffs, and **prior resolution of the same issue by another PR** — exactly the #9/#19 duplication pattern found here, independently corroborated. | A (peer-reviewed-venue mining-challenge submission) |
| arXiv 2601.00753 ("attention tax" study, 33,707 agent-authored PRs) | Only 28.3% of agent PRs merge instantly; most of the delay is maintainer attention, not code quality — the paper proposes pre-review triage (AUC 0.96) to route reviewer attention, which is the same shape of fix this candidate takes at a much smaller scale (triage/dedup signal, not a merge decision). | B (single arXiv preprint, not yet venue-reviewed) |
| GitHub's own refactoring-agent program (vendor blog, hyrax.dev write-up) | Reports 76–79% merge rates specifically *because* changes are kept tiny and a human still approves every one — consistent with this repo's own learning signal ("0 of last N PRs merged → bias to tiny, reviewable candidates"), already applied for months here without changing the merge rate, because the blocker is throughput of review attention, not candidate size. | C (vendor-sourced, single case) |

## Hypothesis (frozen before implementation)
> Given `ruvnet/ruClip`'s real git remote state (30 `dream/*` branches,
> 2026-09-02 through 2026-10-11, confirmed via `git branch -r` and
> cross-checked against the GitHub API for merge/CI status), when a
> deterministic, git-only tool scans every branch's own commits (ahead of
> `main`) for an explicit textual admission that it supersedes/redoes an
> earlier PR number, then it should recover exactly the known, independently
> human-written instances (PR #53 naming #19; PR #61 naming #9) with zero
> false positives across the full real corpus — verified by unit tests
> against fixtures taken verbatim from the real commits, and by a live run
> against the current remote — subject to: the tool never touches GitHub
> state itself (detection only), is read-only/git-only (no GitHub API token
> dependency, matching the security posture already established by this
> repo's own still-unmerged `reconcile-ledger`/`branch-audit` tools), and any
> PR closure performed this session is limited strictly to pairs the tool
> itself flags with an already-published, auditable textual admission —
> never a subjective judgment call.

## Evaluation receipt
Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), plus a real live run of the new CLI.

| | Tests | Pass | Fail | tsc --strict | harness:bench-verify |
|---|---|---|---|---|---|
| Baseline (`main` @ `6e73a8f`) | 327 | 327 | 0 | clean | hash OK (`840fd8d2d698…`) |
| Candidate (this branch) | 335 | 335 | 0 | clean | hash OK (`840fd8d2d698…`) unchanged |

Real live run tonight (`npm run dream:supersession-audit`, against the real
`origin` remote, 30 branches / 53 commits scanned):

```
Self-admitted supersession claims found: 2
Distinct superseded PR/issue numbers named: 9, 19
| dream/2026-10-02-performance  | 97dbcf340afe | #19 | Supersedes stalled, unmerged PR #19 |
| dream/2026-10-07-architecture | b4fdc20328e1 | #9  | Redoes the identical candidate stale draft PR #9 |
```
Matches an independent manual `grep -niE "redo|supersed"` over the same
53-commit corpus exactly — 2 hits, same two commits, no others.

## Baseline
`main` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`: 327/327 tests, `tsc
--strict` clean, 30 `dream/*` branches on `origin`, 0 merged via GitHub's
merge button (3 — #11/#13/#15 — manually squashed onto `main` outside the
PR-merge UI, same fact 2026-09-29's report already established and still
true tonight).

## Darwin lineage
Not applicable — deterministic text-pattern detector over a fixed, finite
real corpus, no tunable parameter space or continuous fitness landscape.

## Evidence trail
- OBSERVATION: `git branch -r` → 30 `dream/*` branches, none merged;
  `mcp__github__actions_list` → CI `conclusion: success` on every sampled
  PR (checked #9, #19, #35, #47, #53, #61, #65, #68, #70 and the full
  `list_workflow_runs(event: pull_request)` page) — ruling out CI as the
  blocker.
- OBSERVATION: `mcp__github__pull_request_read` on #9 and #19 confirms both
  still `state: open`, `draft: true`, `merged: false` (PR #9's
  `mergeable_state` has since gone `dirty`).
- MEASUREMENT: `grep -niE "redo|supersed" over 1025 lines of real commit
  history (all 30 branches) → exactly 2 hits, both already known from
  reading PR #53/#61's own bodies.
- INFERENCE: this is a genuine, self-admitted duplication the backlog is
  carrying for no reason — closing the 2 older PRs loses no unique work
  (the superseding PRs were independently re-verified: 330/330 and
  327/327→330/330 respectively, per their own evaluation receipts already
  in the ledger/issue history).
- DECISION: ACCEPT the detection tool; recommend (not autonomously perform
  beyond what this session's closure authority already covers — see PR body)
  closing PR #9 and PR #19 as confirmed, evidence-backed duplicates.

## Reward-hack check
The two regex patterns were derived *by inspecting* the two known real
matches — flagged transparently rather than hidden, since the honest
mitigation is evidence, not disclaimer: applied against the **full** real
corpus (53 commits, 30 branches, not a cherry-picked subset), the patterns
fire on exactly those 2 commits and nowhere else — a blind, after-the-fact
grep (`-niE "redo|supersed"`) over the same corpus independently confirms
0 additional hits. Negative unit tests cover the obvious near-miss cases
(an unrelated issue-number mention; "redo"/"supersede" used with no PR
reference at all; both patterns matching the same commit, verified to count
once, not twice). No existing test assertion, gold answer, threshold, or
`.harness/bench.json` entry touched — `git diff --stat` against tracked
test/bench files shows only the one new test file added.

## Security review
No LLM calls. Zero new dependencies (`package-lock.json` has no diff). Every
git invocation in `dream-supersession-audit.mjs` uses `execFileSync` with a
static argv array — branch names, sourced only from `git branch -r --list`
output, are passed as inert array elements, never interpolated into a shell
string, so a maliciously named `dream/*` branch (this repo's push access is
already scoped to the owner, but worth stating) cannot inject a command. The
tool is read-only against GitHub (git-object reads only, no API token, no
new credentials or hosts) and writes only one local markdown file. The one
irreversible, GitHub-visible action this session recommends — closing PR #9
and #19 — is explicitly not a merge, not a code-state change, and is scoped
only to pairs with an already-public, independently-verifiable textual
admission from the superseding PR's own author (this same routine, in an
earlier run); it does not touch `main`, does not alter test/bench state, and
is reversible (a closed draft PR can be reopened).

## Next steps
1. Human: review and merge (or explicitly decline) this PR — it is the
   smallest, least risky of the ~30 currently open, and is itself evidence
   that the backlog needs a non-code (process) decision, not another nightly
   candidate.
2. Consider adopting a `paperclipai/paperclip`-style bounded "gardening" loop
   (CI-fix + review-response only, never merge/close beyond what this
   session's own evidence-backed detection already covers) as a named phase
   of the dream-cycle, formalized in a follow-up ADR once the human decides
   whether `main`'s merge policy should change at all, or whether this
   detector should simply run nightly and auto-close self-admitted
   duplicates going forward (a policy decision, not a code one — see
   `ADR-0002`).
3. The two still-unmerged prior remediation attempts for ledger durability
   (`reconcile-ledger.ts`, PR #35) and branch visibility (`branch-audit.ts`,
   PR #47) remain valid and increasingly relevant as the backlog grows —
   not rebuilt tonight to avoid tripling redundant tooling; recommend they
   be reviewed together with this PR.

## Witness
```
REPORT_HASH    = 4bd206bb92daa7a467c9621cd7444631733c521ffb2d45dc771a4f4c8679e299
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = e1ee50e3ac0768d2839877042ea47800f4ee7f1ee7aaca8467c6648970fb8739
```
`REPORT_HASH` is `sha256sum` of this report's content up to (not including)
this `## Witness` section. `WITNESS = sha256(REPORT_HASH || SESSION_COMMIT)`.

**Verifier procedure (reproducible by anyone):**
1. Check out `ruvnet/ruClip` at commit `6e73a8f060bcbb69965a50ffe4627e33622d4094`.
2. Take this report's text up to (not including) this `## Witness` heading,
   save it verbatim, and run `sha256sum` on it — it must equal `4bd206bb92daa7a467c9621cd7444631733c521ffb2d45dc771a4f4c8679e299`.
3. Concatenate that hash with the session commit (`REPORT_HASH + SESSION_COMMIT`,
   no separator) and `sha256sum` the result — it must equal
   `e1ee50e3ac0768d2839877042ea47800f4ee7f1ee7aaca8467c6648970fb8739`.
4. Run `npm run dream:supersession-audit` against the real `ruvnet/ruClip`
   remote — it must report exactly 2 claims, naming PR #19 and PR #9.
5. Run `npm test`, `npx tsc -p tsconfig.json --noEmit`, and `npm run
   harness:bench-verify` on this branch — they must show 335/335, clean, and
   hash `840fd8d2d698…` unchanged, matching this report's Evaluation Receipt.
