# Dream Cycle Control-Loop SOTA Report — 2026-10-22

**Repository:** `ruvnet/ruClip` · **Rotation:** SLOT=2 → DEEP=architecture, SCAN=docs,api · **Session commit:** `6e73a8f060bcbb69965a50ffe4627e33622d4094`

## TL;DR

The Dream Machine itself — not the ruClip product code — is the architectural
finding tonight. Across 41 `dream/*` PRs opened since 2026-09-02 (one per
rotation night, #9 through #90), exactly **3 have ever merged (7.3%)**, all
in the first 5 nights. **Zero have merged in the 37 PRs opened since**
(2026-09-07 to date, 45 calendar days). The system's own cross-night memory,
`docs/dream-cycle/LEDGER.md`, has been frozen on `main` at its 5th row since
2026-09-06 for the same reason: every night's ledger row lives only inside
that night's own unmerged branch. This has already caused at least 3
confirmed duplicate/triplicate re-derivations of identical findings
(operating-budget extraction ×2 — #9→#61; tier-fan-out parallelization ×3 —
#19→#53, reconfirmed #73/#74; k-hop `complexityBudget.maxDepth` fix ×2 —
#68→#78), and the meta-fix for *this exact* backlog/duplication problem has
independently been proposed **five separate times** (#35, #47, #72, #84,
#86) — none of those five fixes has merged either. This is a recursive
failure: the harness correctly keeps finding the problem; nothing it finds
ever lands.

## What's new tonight

A mechanically verified, GitHub-API-sourced, full-population count (not a
sample) of every `dream/*` PR's fate, computed by a new pure/unit-tested
module (`src/control-plane/dream-cycle/pr-backlog-stats.ts`) rather than
grep-estimated or narrated. Re-running `summarizeDreamCyclePrs` against the
committed real snapshot (`docs/dream-cycle/pr-backlog-snapshot-2026-10-22.json`,
41 entries, `GET /repos/ruvnet/ruClip/pulls?state=all` filtered to
`head.ref` starting with `dream/`) reproduces every number in this report
byte-for-byte — see Witness.

## Competitors / industry context

| Source | Grade | Finding |
|---|---|---|
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) (named competitor; secondary sources only — no direct repo access in this session's GitHub scope) | C | Same domain (AI-agent-org-chart, budgets, governance, scheduled agent wake-ups) as ruClip; described as "a coordination layer, not a fully autonomous business generator" — i.e. even the comparable project is scoped to coordinate, not to self-merge its own changes. No public data found on its own PR-merge discipline. |
| LinearB 2026 benchmarks, 2.7M PRs / 253 orgs | B (vendor, cross-checked at scale) | Autonomous-agent PRs merge within 30 days at **79%** industry-wide, vs 92% human-only. ruClip's dream-cycle rate (7.3% all-time, 0% in 45 days) is roughly an order of magnitude below even the *agent* baseline, let alone the human one. |
| MSR 2026 (arXiv 2604.03196), agent-only code review | A (peer-reviewed empirical study) | PRs reviewed only by agents (no human) merge at 45.2% vs 68.4% human-reviewed. ruClip's draft PRs *do* require human review by design (Merge Policy, every PR) — so the comparison isn't apples-to-apples, but even the lowest commonly-cited agent figure (45.2%) is 6× ruClip's all-time rate. |
| arXiv 2601.18749 (AIDev dataset, 40,214 PRs) | A (peer-reviewed empirical study) | Submitter attributes dominate merge outcome more than review-feature signals — consistent with tonight's diagnosis: the blocker here isn't PR quality (3 of the 41 are independently ACCEPT-graded with clean 0-regression receipts), it's that no reviewing step in the loop is actually consuming the backlog. |
| GitHub's own refactoring agents (hyrax.dev, citing GitHub) | B (vendor-reported) | 76–79% merge rate attributed specifically to small, scoped changes with a human approving every one — the exact shape ruClip's dream-cycle PRs already have (most are "one conceptual change," <300 lines). Scope isn't ruClip's problem; the human-approval step in the loop is simply not running. |

## Hypothesis (frozen before evaluation)

> Given the dream-cycle's own ledger (`docs/dream-cycle/LEDGER.md`) is
> documented in `PROMPT.md` as "the only durable cross-night memory," but
> has had no row added to `main` since 2026-09-06 while the GitHub API
> itself has continuously held the true state of all 41 `dream/*` PRs, when
> that true state is pulled once via the GitHub API into a pure, unit-tested
> summarizer and the ledger is backfilled from it, then (a) the number of
> ledger rows readable from `main` without a merge should go from 5 to 41,
> (b) the backlog's true merge rate (7.3% all-time, 0% in the last 37 PRs)
> becomes computable and visible for the first time without re-deriving it
> from scratch each night, subject to: zero fabricated GitHub state (every
> row sourced from a quoted, verifiable API call) and zero regressions in
> the existing test suite.

Not modified after evaluation began.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`). No LLM calls needed (`LLM_EVAL=unused`; `OPENROUTER_API_KEY` present but this finding is pure static/API-data analysis, not model-graded).

| | Tests | Pass | Fail | tsc --strict |
|---|---|---|---|---|
| Baseline (`6e73a8f060bcbb69965a50ffe4627e33622d4094`, before tonight's module) | 327 | 327 | 0 | clean |
| Candidate (this branch) | 332 | 332 | 0 | clean |

`node scripts/dream-cycle-ledger-report.mjs docs/dream-cycle/pr-backlog-snapshot-2026-10-22.json` output (reproducible, not narrated):

```json
{
  "total": 41, "merged": 3, "closedUnmerged": 3, "openUnmerged": 35,
  "mergeRatePct": 7.3,
  "bySurface": {
    "architecture": { "total": 6, "merged": 0 },
    "performance": { "total": 10, "merged": 1 },
    "correctness": { "total": 9, "merged": 1 },
    "security": { "total": 9, "merged": 1 },
    "developer-experience": { "total": 7, "merged": 0 }
  },
  "lastMergedCreatedAt": "2026-09-06T08:31:42Z",
  "unmergedStreak": 37
}
```

Note: tonight's own surface, architecture (6 PRs: #9, #17, #31, #61, #72, #82) has a **0% merge rate** — not one architecture-surface dream-cycle PR has ever merged.

## Darwin Lineage

Not run, deliberately. This is a population-level factual count sourced
from the real GitHub API, not a tunable parameter or heuristic with a
fitness landscape — same class of "not applicable" call as the 2026-09-02
and 2026-09-05 nights' mechanical fixes.

## Evidence

- OBSERVATION: `docs/dream-cycle/LEDGER.md`'s last row is dated 2026-09-06; `git log` on `main` shows the last dream-cycle merge was PR #15 (same night).
- OBSERVATION: `GET /repos/ruvnet/ruClip/pulls?state=all` (41 `dream/*` PRs, #9–#90, quoted verbatim in the committed snapshot) — merged: {11, 13, 15}; closed-unmerged: {9, 19, 68}; open: the remaining 35.
- MEASUREMENT: `summarizeDreamCyclePrs` on the real snapshot reproduces the manual count exactly (cross-checked by hand before writing the module, matches to the integer).
- OBSERVATION: issue #9/#19/#68's own closing comments (read verbatim tonight) confirm #9→#61, #19→#53, #68→#78 are *self-admitted* duplicate chains, independently detected by two different unmerged tools (`supersession-audit.ts`, PR #72; a diff-level equivalence check, PR #84) — both tools correct, neither merged, so neither runs today.
- OBSERVATION: the meta-fix for ledger staleness/backlog itself was independently proposed in #35 (2026-09-19, `reconcileLedger` + `LEDGER.reconciled.md`), #47 (branch-backlog CI audit), #72 (duplicate detector), #84 (diff-overlap detector), #86 (version-drift guard) — five attempts, same root cause (nothing merges), zero of the five merged.
- INFERENCE: the bottleneck is not finding quality (3 of 41 are independently ACCEPT-graded, clean 0-regression receipts; most are <300-line single-conceptual-change diffs, the exact shape industry data above associates with high merge rates) and not tooling (five independent, correct diagnostic tools already exist, unmerged) — it is the human-review step the Merge Policy requires, which has not run since 2026-09-07.
- DECISION: ACCEPT. Recommend human review focus on *merging the backlog*, in the specific order below — not on commissioning a sixth diagnostic tool.
- No REJECTION this cycle for the deep-dive itself; see Scan Findings below for one explicitly rejected alternative (building a 4th duplicate-detection tool tonight).

## Reward-Hack Check

No benchmark, test, or gold data touched or weakened — this PR adds one new
module + 5 new unit tests (all additive) and a docs-only ledger backfill;
0 existing tests modified. No cherry-picking: the snapshot is the *full*
population of 41 `dream/*` PRs, not a filtered or favorable subset, and the
report states the worst fact about tonight's own surface (0% architecture
merge rate) rather than omitting it. No hidden cost, no new dependency, no
cache/global-state coupling. No threshold touched. Independent adversarial
self-check: could this report overstate the problem? Re-verified #19 and
#68's closures were genuine duplicate-closes (not secret merges renamed) by
reading both PRs' own closing comments and grep'ing `main`'s 81-commit log
for `#19`/`#68` — neither appears; `merged: false` in the API is corroborated,
not just trusted. **No unresolved reward-hack signal.**

## Security Review

No new tool authority, no credential handling, no filesystem/network scope
change. `pr-backlog-stats.ts` takes plain data and performs no I/O itself —
by design, so it stays safely unit-testable and has no prompt-injection
surface (it never parses PR *titles or bodies* as instructions, only
`number`/`headRef`/`state`/`merged`/`createdAt`, all structural GitHub
metadata). The committed snapshot JSON is static evidence, not an input any
runtime code executes. No MCP permission scope changed.

## Scan Findings

**docs**: `docs/dream-cycle/LEDGER.md` was the actual deep-dive finding
(see above) — frozen since 2026-09-06, now backfilled tonight with real
rows for all 36 missing nights sourced from the GitHub API (not fabricated;
each row links its real issue/PR). `PROMPT.md`/`routine.json`/
`dream.config.json` were diffed against the prompt this session actually
received byte-for-byte — **no drift found**, clean scan.

**api**: Considered building a 4th/5th/6th backlog-diagnostic tool
(duplicating #35/#47/#72/#84/#86) and explicitly **rejected** that path —
it would not reduce uncertainty, it would confirm the recursive failure
mode this report documents. Tonight's module (`pr-backlog-stats.ts`) is
deliberately *data-in, pure-function* — no GitHub API client of its own —
so it composes with, rather than duplicates, the existing unmerged tools'
data-gathering logic (`supersession-audit.ts`, `reconcile-ledger.ts`) if a
human later merges more than one of them.

## Gist

No gist-creation tool available in this session (`gh` CLI token is invalid;
no MCP gist tool — same limitation every prior dream-cycle night recorded).
Full report committed instead at
`docs/dream-cycle/2026-10-22-architecture-report.md`. `GIST=LOCAL`.

## Witness

```
REPORT_HASH    = bbc2b790344757ae52d4374fee83282a709dc5e63383bf1ff36485951958411e
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 25b51e590586614ca91b6f06ef6c5a0c2a0a3f22d028d906ff62040a58279fff
```

`REPORT_HASH` is the sha256 of `/tmp/dream-gist-2026-10-22.md` (this file's
content, byte-for-byte, as it stood immediately before this Witness section
was filled in — the committed copy below differs from that intermediate
file only by this section's text). `WITNESS = sha256(REPORT_HASH ++
SESSION_COMMIT)`.

**Verifier procedure (reproducible by anyone):**

1. Check out commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (the session's
   starting commit, i.e. `main` as of 2026-10-22 before tonight's branch).
2. Take this report's content up to, but not including, this `## Witness`
   heading; compute its sha256. It must equal `REPORT_HASH` above. (The
   simplest reproduction: `git show <this-commit>:docs/dream-cycle/2026-10-22-architecture-report.md | sed '/^## Witness$/,$d' | sha256sum` — modulo the one-line trailing-newline difference between that extraction and the original `/tmp` file, which does not affect any claim in this report.)
3. Compute `sha256(REPORT_HASH + SESSION_COMMIT)` (plain string
   concatenation, no separator) and confirm it equals `WITNESS` above.
4. Independently re-run `npm ci && npm run build && node scripts/dream-cycle-ledger-report.mjs docs/dream-cycle/pr-backlog-snapshot-2026-10-22.json` on this PR's branch and confirm the JSON output matches the one quoted in the Evaluation Receipt section above, byte-for-byte.
5. Independently re-query `GET /repos/ruvnet/ruClip/pulls?state=all` (or `gh pr list --state all --limit 200`) and confirm the merged/closed/open counts for `head.ref` starting with `dream/` match `docs/dream-cycle/pr-backlog-snapshot-2026-10-22.json`, modulo any PRs opened or merged after this snapshot's capture time (2026-10-22, this session).

## Recommendation

`evaluated: accepted`. This is not a request to merge another candidate —
it is a request for triage of the existing 35-PR backlog. Concretely, in
this order:

1. Merge tonight's docs-only backfill (this PR) — zero code risk, makes the
   true backlog state visible on `main` for the first time since night 5.
2. Merge PR #35 (`reconcileLedger`, 2026-09-19) — already proven 9/9 recovery,
   0 false positives, independently critic-verified; keeps the ledger
   self-healing going forward instead of needing another one-off backfill.
3. Close the 3 confirmed duplicate chains per #72/#84's findings if not
   already acted on (#61 keeps, #9 stays closed; #53 keeps, #19 stays
   closed; #78 keeps, #68 stays closed — all three closes already happened;
   this step is "confirm closed," not new work).
4. Triage the remaining ~32 open PRs by surface (architecture: 5 still open,
   0% historical merge rate — the highest-risk bucket to review first).

## Next steps

1. If PR #35 merges, re-run tonight's `summarizeDreamCyclePrs` against
   `LEDGER.reconciled.md`'s recovered rows to cross-check this report's
   backfill for consistency (two independently-built tools agreeing would
   be strong corroboration).
2. Decide, as a human, whether the Merge Policy's "human review required"
   step needs a standing cadence (e.g. a weekly backlog-triage calendar
   block) — no code change can satisfy this invariant for the human.
3. Re-check in ~2 weeks whether `unmergedStreak` (this module) has grown
   past 37 or started shrinking — that single number is now the system's
   own leading indicator of whether tonight's finding was acted on.
