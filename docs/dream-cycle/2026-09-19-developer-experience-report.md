**GitHub auth**: MCP `github` server authenticated as `ruvnet` (`get_me` succeeded) —
issue/PR publication (below, via GitHub MCP tools) is real. No gist-creation
tool is available in this session's toolset (no `gh` CLI binary; the GitHub
MCP server exposes no gist primitive), so this report — normally published
as a gist — is committed to this repo instead, the same fallback pattern
used on 2026-09-03 and 2026-09-09.

---

# Developer-Experience SOTA Report — 2026-09-19

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 4 (`DAYINT % 5 = 4`): DEEP=developer-experience, SCAN=ci,tooling.
Bonus check: `20260919 % 25 = 19` (not 0) — no roadmap-review bonus tonight.

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip)
**Branch**: `dream/2026-09-19-developer-experience`

## TL;DR

The Dream Cycle's own durable cross-night memory is broken. `docs/dream-cycle/LEDGER.md`
on `main` has not gained a row since **2026-09-06** — but the routine has
run, found something, and pushed a draft PR **every night since**
(2026-09-07 through 2026-09-18, 9 nights: issues #16/#18/#20/#22/#24/#26/#28/#30/#32,
PRs #17/#19/#21/#23/#25/#27/#29/#31/#33, all still `OPEN, unmerged` as of
tonight). The mechanism: each night's ledger row is committed only inside
that night's own `dream/<date>-*` branch, alongside the candidate diff, and
since PRs require human review and none has ever merged (0 of the last 14+
dream-cycle PRs), that row never reaches `main`. Every one of those 9
nights' own STEP 1 ("read `docs/dream-cycle/LEDGER.md`") therefore saw a
ledger frozen at 2026-09-06 and re-derived the same "0 of last N PRs merged"
learning signal from scratch, blind to the other 8 nights' worth of
accumulated findings, rejections, and evidence sitting one `git show` away.
This is exactly the failure mode the ledger exists to prevent (PLAN.md §6:
"the flywheel evidence... durable memory across nights"), and it has been
silently active for 13 days.

Built and evaluated tonight, against the real live repository (not a
simulation): `reconcileLedger`, a pure, unit-tested merge function, plus a
`scripts/reconcile-ledger.mjs` CLI wrapper that fetches every `origin/dream/*`
branch, reads each one's own committed `LEDGER.md` via `git show <ref>:path`,
and merges rows by a `Date::Deep` composite key so a row already on `main`
is never duplicated. Run for real against `ruvnet/ruClip` tonight, it
recovered exactly the missing **9 rows**, in the correct chronological
order, into a new file `docs/dream-cycle/LEDGER.reconciled.md` — `LEDGER.md`
itself is never modified; this is a read-only recovery view, not a rewrite
of the append-only source of truth.

## What's new

- `src/control-plane/dream-cycle/reconcile-ledger.ts` — `parseLedgerTable`
  (markdown table → preamble + rows, each row keyed by `${Date}::${Deep}`)
  and `reconcileLedger` (merges `main` + N named branch copies, dedup by
  key, stable sort by date). Pure functions, no I/O, no git calls — fully
  unit-testable without touching the real repo.
- `scripts/reconcile-ledger.mjs` — the only piece that shells out to git
  (`fetch`, `branch -r --list`, `show <ref>:path`), all with static,
  non-interpolated argument arrays (no branch name or file content is ever
  passed through a shell). Best-effort: an unreachable remote, a branch with
  no ledger file, or a fetch failure is logged and skipped, never a hard
  failure — this is a recovery aid, not a gate.
- `docs/dream-cycle/LEDGER.reconciled.md` — tonight's real, live-generated
  output (committed so tomorrow's session can read it even before the
  routine owner decides whether to wire the script into STEP 1).
- `package.json`: one new script, `dream:reconcile-ledger`.
- 6 new unit tests (`tests/control-plane/reconcile-ledger.test.ts`) against
  small fixture tables — dedup, chronological-order merge across
  out-of-order branch visitation, same-date-different-`Deep` rows kept
  distinct, no-op when nothing to recover, exact preservation of `main`'s
  existing rows and preamble text.
- 9 files touched total (5 new, 2 modified: `package.json`,
  `docs/dream-cycle/LEDGER.md` gets tonight's own new row appended at
  publication time per the routine's own STEP 20-25 — not part of the
  candidate diff itself).

## 5 candidates considered (scored 1-5 on fit/novelty/testability/measurability/production-value/reviewability)

1. **Recover siloed ledger rows from unmerged `dream/*` branches (read-only reconciliation tool)** — 5/4/5/5/5/4 = **28** — SELECTED. Directly fixes a verified, active blind spot in the routine's own core memory mechanism; fully offline-testable; real measurement against the live repo tonight (9/9 rows recovered correctly).
2. Wire a CI job to fail/flag when any `dream/*` branch is >3 days old and unmerged (a "PR-age nag") — 4/3/4/2/4/4 = 21. Real and useful, but it's a symptom alert, not a fix for the memory-loss itself — a stale-PR warning doesn't recover 9 nights of already-lost visibility, and CI only runs on push/PR, not on a schedule, so it wouldn't even fire without a push. Deferred as a next step (see below), not selected.
3. Change `dream.config.json`/`PROMPT.md` to have STEP 20-25 push the ledger row directly to `main` in its own tiny always-mergeable commit, separate from the candidate branch — 5/3/2/4/5/2 = 21. This is the more structurally complete fix, but `docs/dream-cycle/PROMPT.md`'s own header says "Do not hand-edit — change the config and recompile," which is the routine owner's action, not this session's; and a direct-to-`main` push from an autonomous session, even for pure bookkeeping, is a process/authority change this session should surface as a recommendation, not make unilaterally. Recorded as the real long-term fix in Next Steps.
4. Re-litigate tonight's DEEP surface as "lint still a no-op on `main`" (issue #20/PR #21 from 2026-09-09 already fixed this in its own branch, unmerged) — 3/1/3/4/3/4 = 18. Real, but it's the *same* underlying disease (a good fix stuck in an unmerged branch) as candidate #1, just one specific instance of it rather than the systemic recovery tool; fixing symptom rather than the pattern. Not selected — tonight's candidate is the more general, higher-leverage fix.
5. Add a GitHub Actions scheduled workflow that runs `reconcile-ledger` and opens/updates a pinned issue comment nightly — 4/3/3/3/4/2 = 19. Good follow-on, but adds new CI surface + scheduling semantics the routine doesn't otherwise touch; larger than tonight's <300-line target combined with candidate #1. Deferred.

No override of the top score needed — #1 is the clear winner on fit,
measurability, and production-value, and ties for testability.

## Hypothesis (frozen before implementation)

> Given the real, live state of `ruvnet/ruClip`'s git remote (as of tonight:
> `main`'s `docs/dream-cycle/LEDGER.md` last updated 2026-09-06, and 9
> unmerged `dream/*` branches from 2026-09-07 through 2026-09-18 each adding
> exactly one ledger row that never reached `main`), when a deterministic
> reconciliation tool (`reconcileLedger`) merges `main`'s ledger with every
> unmerged `dream/*` branch's own committed copy of the file — deduping by a
> `Date::Deep` composite key — then the reconciled output should contain
> every one of those 9 previously-siloed rows, in correct chronological
> order, with zero loss or duplication of `main`'s own existing rows,
> verified both by unit tests over synthetic fixtures (merge, dedup,
> ordering, no-op-when-nothing-to-recover) and by running the tool for real
> against the live repository tonight; subject to: `LEDGER.md` itself is
> never mutated by the tool (the append-only source of truth is preserved),
> and no production control-plane code or existing test assertion is
> touched.

## Evaluation Receipt (real, reproduced — not inferred from logs)

- **Baseline** (`main` @ `6e73a8f0`, before tonight's candidate): `npm run
  build` clean; `npm test` → **327/327** pass. `docs/dream-cycle/LEDGER.md`
  manually inspected: last row `2026-09-06`. Cross-checked via
  `mcp__github__list_pull_requests`/`list_issues` (`state=all`): PRs #17,
  #19, #21, #23, #25, #27, #29, #31, #33 (2026-09-07 through 2026-09-18) all
  exist, all `draft: true`, `merged: false`, `state: open` (except #33 also
  open) — confirming the 9-night gap is real GitHub state, not a local
  artifact.
- **Direct confirmation of the root cause**: `git fetch origin
  '+refs/heads/dream/*:refs/remotes/origin/dream/*'` (real network fetch,
  succeeded) then `git show origin/dream/2026-09-0{7,8,9}...:docs/dream-cycle/LEDGER.md`
  for all 9 branches — each one's own copy ends in exactly one new row for
  its own night, appended after `main`'s 2026-09-06 row. Also confirmed via
  `mcp__github__pull_request_read` (`get_files`) on PR #21 and PR #33: both
  diffs include a `docs/dream-cycle/LEDGER.md` hunk adding one row, on top
  of a base that already had the 09-02..09-09 (resp. ..09-18) history —
  i.e., each branch's ledger is individually complete up to its own night;
  only `main` is missing them.
- **Candidate build**: `npm run build` → clean, 0 errors.
- **Candidate test**: `npm test` → **333/333** pass (327 baseline + 6 new,
  0 regressions, 0 skipped/todo).
- **Candidate real-world run** (the actual measurement this hypothesis
  predicts): `node scripts/reconcile-ledger.mjs` against the live repo:
  ```
  Scanned 12 remote dream/* branch(es); recovered 9 row(s) not present on main.
    + 2026-09-07::architecture  (from dream/2026-09-07-architecture)
    + 2026-09-08::performance   (from dream/2026-09-08-performance)
    + 2026-09-09::developer-experience (from dream/2026-09-09-developer-experience)
    + 2026-09-10::correctness  (from dream/2026-09-10-correctness)
    + 2026-09-11::security     (from dream/2026-09-11-security)
    + 2026-09-15::correctness  (from dream/2026-09-15-correctness)
    + 2026-09-16::security     (from dream/2026-09-16-security)
    + 2026-09-17::architecture (from dream/2026-09-17-architecture)
    + 2026-09-18::performance  (from dream/2026-09-18-performance)
  Wrote docs/dream-cycle/LEDGER.reconciled.md (docs/dream-cycle/LEDGER.md itself was not modified).
  ```
  Exactly matches the manually-verified set of 9 missing nights — no false
  positives, no false negatives. `git diff docs/dream-cycle/LEDGER.md` →
  empty, confirming the source-of-truth file was genuinely untouched by the
  run.
- `npm run harness:bench-verify`: unchanged — `.harness/bench.json` corpus
  was not touched (this candidate has no interaction with the build-time
  genome bench surface).
- **Independent critic** (fresh subagent, no access to this session's
  reasoning, given the full diff + the live repo + told to reproduce every
  claim itself, not trust it): verdict recorded verbatim in Reward-Hack
  Check below.

`evaluated: accepted`

## Darwin Results

Not applicable — this candidate is a deterministic parsing/merge utility
with no continuous or tunable parameter space (no threshold, no
concurrency cap, no fitness landscape to search). Skipped, not
run-and-discarded.

## Evidence

- OBSERVATION: `docs/dream-cycle/LEDGER.md` on `main` last row is
  2026-09-06; 9 further `dream/*` branches (09-07..09-18) exist on
  `origin`, each with its own unmerged draft PR, each with its own ledger
  row absent from `main`.
- MEASUREMENT: baseline `npm test` 327/327; candidate `npm test` 333/333 (6
  new, 0 regressions); live `reconcile-ledger.mjs` run recovered 9/9 known
  missing rows, 0 false positives, `LEDGER.md` diff empty post-run.
  `harness:bench-verify` hash/output unchanged.
- INFERENCE: the ledger's "durable cross-night memory" design assumes rows
  land on `main`, but the routine's own "never self-merge" invariant means
  they structurally cannot, absent human action — this is a design gap in
  the memory mechanism itself, not a one-off oversight, and predicts it
  will keep recurring every night until either PRs start merging or the
  memory model changes.
- DECISION: ship a read-only recovery tool tonight (safe, additive, no
  production-code touch); recommend the structural fix (ledger rows land on
  `main` directly, independent of the candidate PR) to the routine owner
  rather than implement it unilaterally (see Next Steps #1).
- REJECTION: none tonight — no hypothesis was implemented and then
  discarded; the initial 5-candidate scoring did the discarding (see
  Candidates section) before implementation began.

## Reward-Hack Check

Independent critic verdict, reproduced fresh (rebuilt, retested, re-ran the
script itself against the live repo rather than trusting this session's
numbers, and read every changed file in full): **CLEAR — no blocking
issues.**

- Reproduced 333/333 (0 fail), `git diff docs/dream-cycle/LEDGER.md` empty,
  `git diff --stat` shows only `package.json` (+1 line) as a modified
  tracked file, `.harness/bench.json` untouched, no existing test assertion
  altered.
- Independently re-ran `scripts/reconcile-ledger.mjs` and diffed its output
  against the committed `LEDGER.reconciled.md` — byte-identical.
- Security: `execFileSync` with static argv (no shell); the only variable
  input to `git show <ref>:<path>` is ref names `git branch -r --list
  origin/dream/*` itself already returned (real refs on `origin`, not
  attacker-controlled text); network calls bounded to the `dream/*` refspec
  with try/catch fallback; no credentials touched; per-branch failures are
  swallowed (best-effort, non-gating), which is the right default here.
- Found and confirmed correct (not a bug): `main`'s own `LEDGER.md` already
  contains a **pre-existing** duplicate `2026-09-03::performance` key (its
  own lines 9 and 11 — an artifact of that night's own LOCAL-fallback row,
  unrelated to tonight's candidate). `reconcileLedger` passes `main`'s rows
  through unchanged/undeduped against themselves (dedup only applies to
  rows recovered *from branches*), so this pre-existing quirk is correctly
  left as-is rather than silently "fixed" by a tool that isn't supposed to
  rewrite `main`'s history.
- Non-blocking nuance flagged: when a key exists on multiple branches (a
  later night sometimes re-narrates an earlier night's finding in its own
  ledger row while catching up), the reconciler keeps the **earliest**
  branch's own first-hand text (alphabetical branch order = chronological,
  since branch names are `dream/<ISO-date>-...`) — verified concretely for
  the `2026-09-07::architecture` key, which appears (reworded) on 5
  different later branches; the output correctly keeps the 09-07 branch's
  own original wording. Flagged as the semantically correct choice (matches
  "one row per run... never rewritten"), not a defect.
- Non-blocking limitation noted and checked against real data: `splitCells`
  does a naive `'|'` split, so a cell containing a literal unescaped `|`
  would misalign columns; the critic checked all 12 real branch ledger
  copies and found zero such cells — acceptable as shipped for a read-only
  advisory tool, worth hardening later if it ever becomes load-bearing.
- No reward-hacking indicators: no gold-answer/threshold/bench.json touch,
  no cache reliance, no cherry-picking (the script reports every recovered
  row, not a filtered favorable subset), no cost hidden, no existing
  assertion weakened.

## Security Review (STEP 15)

- **Prompt injection / agent impersonation**: N/A — no LLM/model calls
  anywhere in this candidate; it is pure git-log inspection and markdown
  parsing.
- **Tool/MCP authority**: no MCP tools used by the candidate itself (only
  this session's own reporting used `mcp__github__*`, read-only + the
  eventual issue/PR creation covered under Merge Policy below).
- **Filesystem/network scope**: `scripts/reconcile-ledger.mjs` writes to
  exactly one new path (`docs/dream-cycle/LEDGER.reconciled.md`) and reads
  exactly one existing path (`docs/dream-cycle/LEDGER.md`); its only network
  call is `git fetch origin` scoped to the `dream/*` refspec, matching this
  session's own already-granted git remote access — no new credentials, no
  new hosts.
- **Command injection**: every `git` invocation uses `execFileSync` with a
  static argument array (no shell, no string interpolation of branch names
  or file content into a command string) — a maliciously-named `dream/*`
  branch (e.g. containing shell metacharacters) cannot inject a command,
  only fail to match the `--list` glob or fail the `show` lookup, both
  handled as a skip.
- **Credential exposure**: none — no secrets read, logged, or transmitted.
- **Memory/benchmark poisoning**: a branch under attacker control (if the
  repo's push access were ever broader than trusted) could in principle
  push a `dream/*` branch with a fabricated ledger row; `reconcileLedger`
  would merge it in exactly as written, since it does no authenticity
  check on branch content beyond parsing the table shape. This is a real,
  if currently low-likelihood (push access is already trusted — the same
  actor who could do this could also just edit `main` directly), latent
  gap — documented as Next Step #3, not fixed tonight (out of scope for a
  <300-line candidate, and no evidence of exploitation exists).
- **Supply-chain exposure**: **zero new dependencies** — the script uses
  only `node:child_process`/`node:fs`, already-used Node builtins.
- **Unsafe autonomous mutation**: the candidate lives on a draft PR only;
  `LEDGER.md` (the actual source of truth other tooling/humans might trust)
  is never written by this candidate, only read; this session never merges
  or self-promotes.

## Scan Findings: ci

`.github/workflows/ci.yml` runs on `push`/`pull_request` to `main` only —
it has no `schedule:` trigger, so it never runs against `dream/*` branches
independently of their PR being open, and never runs on a cadence that
could itself have surfaced the ledger-staleness pattern (e.g., a nightly
job diffing `main`'s ledger against open PRs). This is the concrete gap
Candidate #2 (deferred) would close. Confirmed unchanged tonight: `build` →
`test` → `harness:advisory` (informational) → `harness:bench-verify` (hard
gate); `npm run lint` is still the pre-#21 no-op stub on `main` (PR #21
fixing it, from 2026-09-09, remains unmerged) — a live, current instance of
tonight's own root cause, left untouched (not this candidate's diff to
carry, per the "one conceptual change" discipline).

## Scan Findings: tooling

`npm run --silent` probe: `build`, `test`, `lint` (still the no-op stub on
`main`), `harness:score`/`genome`/`mcp-scan`/`advisory`/`bench-verify`,
`attester:start`/`assert-not-public`, and (new tonight)
`dream:reconcile-ledger`. `npm ci` resolves all non-optional peer
dependencies (`metaharness@0.4.8`, `ruflo@3.38.20`, `ruvector@0.3.0`,
`radio-moe@0.3.1`) cleanly; `agentbbs` (optional) does not resolve, as
expected and previously documented. No `gh` CLI binary and no gist-creation
MCP tool are available in this session (confirmed: `which gh` → not found;
tool search for a gist primitive → none) — same standing gap the 2026-09-03
and 2026-09-09 nights already recorded; not re-litigated as tonight's
finding, but directly relevant to why this report is a committed file
rather than a published gist.

## Competitors (evidence-graded)

| Approach | Description | Applicability to ruClip's ledger problem | Grade |
|---|---|---|---|
| **Cursor Background Agents' `MEMORIES.md` model** | Anthropic/Cursor-documented pattern for autonomous coding agents: durable agent memory is stored *outside* the working tree/branch lifecycle entirely, so it survives regardless of whether any given PR merges. | Directly validates tonight's diagnosis: the correct fix class is "don't make durable memory depend on merge state" — an external or trunk-independent store, not a branch-scoped file. Tonight's tool is a stopgap (read without merging); the fully-aligned fix would move the ledger itself, or at minimum its write path, off the per-night branch (see Next Steps #1). | A — official vendor documentation |
| **Ehsani et al., "Where Do AI Coding Agents Fail? An Empirical Study of Failed Agentic Pull Requests" (MSR 2026, arXiv 2601.15195)** | Empirical study confirming unmerged/failed agentic PRs are a systemic, measured phenomenon (larger diffs, CI failures, alignment issues correlate with non-merge), not an anecdotal one. | Corroborates that "agent PRs frequently don't merge" is expected steady-state, not a ruClip-specific anomaly — reinforces that the ledger's design should not have assumed merge as the delivery path in the first place. Does not address the specific ledger-rereading mechanism. | A — peer-reviewed, reproducible |
| **paperclipai/paperclip** (this project's own named competitor) | Its audit trail / approval-gate history lives in an application database with in-app workflow states, not as a git-committed file gated by PR merge. | Same underlying lesson as the Cursor comparison from a different angle: paperclip's durable state was never coupled to git-merge status to begin with, because it isn't stored in git. ruClip's ADR-0001 choice to keep the ledger in-repo (for zero-infra reasons) is reasonable, but inherits this specific failure mode paperclip's architecture doesn't have. | B — cross-checked against the repo's README/issue tracker, not exhaustively audited |
| **Dependabot/Renovate PR backlogs** (general open-source pattern) | Widely-observed pattern of automated PRs accumulating unmerged for weeks/months in repos with slow review cadence. | Same family of problem (automation produces PRs faster than humans review them) but Dependabot/Renovate don't depend on a *ledger row inside the PR itself* for their own future runs' correctness — they re-scan dependency manifests fresh each time. ruClip's dream-machine is more exposed because it explicitly relies on reading its own prior output for continuity. | C — multiple scattered single-repo reports, not a canonical/aggregated source |

*(A fifth research thread — a specific claim that another `ruvnet` repo
had documented this exact failure mode with a named CI mitigation — could
not be independently verified from inside this session, since GitHub access
tonight is scoped to `ruvnet/ruClip` only; it is deliberately **excluded**
from this table rather than cited unverified.)*

## Gist

**LOCAL** — no gist-creation tool is available in this session (see Scan
Findings: tooling). This report file is the durable, committed equivalent,
the same fallback the 2026-09-03 and 2026-09-09 nights used for the same
reason.

## Witness

- Session commit (this night's `git rev-parse HEAD` at STEP 0):
  `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256: computed over this file's full content with the 3 stamp
  values below (sha256/witness/verifier-reproduction lines) replaced by the
  placeholder text `PENDING`, i.e. over the report as it stood immediately
  before this Witness section's own stamp values were filled in.
  `REPORT_HASH = 15518a7faab0b11c89929f094bcbb2d4d97857378447b0cd015e92aa10341879`
- Witness stamp: `sha256(REPORT_HASH || SESSION_COMMIT)` =
  `WITNESS = 2b97f0ac5a07e8eaeb581cab19d1d8ee9a93af3c72bf92aa116979a0e1db6411`

**Verifier procedure** (reproduce independently):
1. `git -C ruClip rev-parse 6e73a8f060bcbb69965a50ffe4627e33622d4094` — confirm the commit exists and is `ruvnet/ruClip`'s HEAD as of 2026-09-19's Dream Cycle session start.
2. Take this report's full text and replace the 3 stamp-value lines in this Witness section (the `REPORT_HASH = ...` line, the `WITNESS = ...` line, and this verifier-procedure's own printed hash values below) with the literal text `PENDING` each — that reconstructs the pre-stamp version.
3. `sha256sum` that reconstructed text — confirm it equals `15518a7faab0b11c89929f094bcbb2d4d97857378447b0cd015e92aa10341879`.
4. `printf '%s%s' 15518a7faab0b11c89929f094bcbb2d4d97857378447b0cd015e92aa10341879 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` — confirm it equals `2b97f0ac5a07e8eaeb581cab19d1d8ee9a93af3c72bf92aa116979a0e1db6411`.
5. `git -C ruClip diff 6e73a8f060bcbb69965a50ffe4627e33622d4094 dream/2026-09-19-developer-experience` — confirm the candidate diff matches this report's Evaluation Receipt (9 files, +~430/-0 across new files, +1/-0 in `package.json`).

## Recommendation

`evaluated: accepted` — human review recommended (PR left in draft, never
self-merged). This candidate is safe to merge on its own regardless of
what the routine owner decides about the structural fix: it adds no
production-code behavior change, only a new opt-in recovery script and its
tests. Suggested reviewer focus: decide whether/how to wire
`npm run dream:reconcile-ledger` into the routine's own STEP 1 (reading
`docs/dream-cycle/LEDGER.reconciled.md` instead of, or in addition to,
`LEDGER.md`), since that requires editing `dream.config.json` and
recompiling `PROMPT.md` — explicitly out of this session's authority
(`PROMPT.md`'s own header: "Do not hand-edit").

## Next steps (concrete)

1. **The structural fix** (routine-owner decision, not this session's to
   make): have STEP 20-25 commit the ledger row directly to `main` in its
   own tiny, always-mergeable, review-free commit (pure data, no code),
   separate from the candidate's draft-PR branch — eliminating the
   dependency on human merge for memory continuity entirely, matching the
   Cursor `MEMORIES.md` lesson above. Requires updating `dream.config.json`
   and recompiling `docs/dream-cycle/PROMPT.md`/the cloud scheduler routine.
2. **CI staleness alert** (deferred Candidate #2): a scheduled (not just
   push-triggered) workflow that runs `dream:reconcile-ledger` and fails/
   comments when any `dream/*` branch is >3 days old and unmerged, so the
   backlog itself becomes visible in CI rather than only discoverable by
   manually cross-referencing GitHub issues/PRs the way tonight's session
   did.
3. **Trust boundary on branch-sourced content** (Security Review): before
   ever treating `LEDGER.reconciled.md` as authoritative for automated
   decisions (rather than human-read context), add a check that a
   recovered row's branch ref is reachable from an actual open, still-valid
   PR (via the GitHub API) rather than trusting any `dream/*`-named branch's
   content unconditionally.
4. **Stale-fact rows are inherent, not fixed by reconciliation** (per
   independent critic): some older rows narrate a PR's state ("MERGED")
   that a later night's own row corrects — the reconciler surfaces every
   night's first-hand text as committed, it does not and should not
   silently rewrite history. Any consumer of `LEDGER.reconciled.md`
   (human or future session) should treat each row's status claims as
   dated to that row's own night, not as current fact — cross-check live
   GitHub state for anything status-sensitive, the same discipline this
   report itself used.
