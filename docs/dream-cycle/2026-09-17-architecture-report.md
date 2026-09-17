# ruClip Architecture SOTA Report — 2026-09-17

**Rotation:** DEEP=architecture, SCAN=docs,api (slot 2, `20260917 % 5 == 2`), no bonus modulus (`20260917 % 25 == 17`).

## TL;DR

`src/control-plane/store/agentdb-adapter.ts` is a 1483-line God-module (8+ bounded
contexts, 48 exports) — the same finding two prior architecture nights (2026-09-02,
2026-09-07) already made and tried to fix, both still unmerged. Tonight extracts the
one piece nobody has touched yet: the three **generic hierarchical-store wrappers**
(`storeAtTier`/`deleteFromTier`/`recallByKey`) that every other bounded context in
the file depends on. They were private, dependency-free (only `callTool` +
`MemoryTier`), and used by all 12 persistence call sites in the file — moving them
first, onto the same dependency-free leaf layer as `bridge-client.ts`, is what
*unblocks* future clean extraction of heartbeat-schedule, approval-transition, and
comment persistence, each of which needs these three helpers and would otherwise
risk recreating the exact two-way import cycle `bridge-client.ts`'s own header
already documents hitting once (a `class ... extends` heritage clause evaluated at
module-load time faulting on an uninitialized circular import).

## What's new tonight

- New file `src/control-plane/store/hierarchical-store.ts` (105 lines): verbatim
  move of `storeAtTier`, `deleteFromTier`, `recallByKey`, `assertToolSucceeded`.
- `agentdb-adapter.ts`: -64 net lines (1483 → 1419), imports the three exported
  names, zero call-site changes elsewhere in the repo (nothing outside this file
  referenced these four names — confirmed by repo-wide grep).
- Zero behavioral change: confirmed byte-identical logic by an independent critic
  subagent that diffed old vs. new line-by-line, then ran the build and test suite
  itself rather than trusting this session's numbers.

## Competitor / landscape context (grade noted per row)

| Row | Note | Grade |
|---|---|---|
| `paperclipai/paperclip` (this project's one established real competitor per ADR-0001 — a company-orchestration control plane, not an agent framework) | Public repo structure keeps persistence/integration concerns in a dedicated `packages/adapters/` tree (per-adapter packages), rather than one monolithic adapter file — same direction this extraction moves ruClip toward. Also confirmed (ADR-0001 §"context"): paperclip's own backend is Node/React/**Postgres**, which gets per-bounded-context table/schema separation "for free" from the DB layer; ruClip's single hierarchical-store abstraction has to earn that separation manually through module boundaries — exactly the gap tonight's fix narrows. | B (public GitHub repo structure + docs, cross-checked against this repo's own ADR-0001) |
| LangGraph / AutoGen / CrewAI / OpenAI Agents SDK / DSPy | Generic agent-*frameworks*, not company-orchestration control planes — explicitly rejected as non-competitors for ruClip's domain by this repo's own `docs/design/DREAM-MACHINE-INTEGRATION.md` (dream-machine's generated config default before correction). Repeated here for completeness, not re-litigated. | A (first-party repo doc, already-settled finding) |
| God Object / Large Class antipattern (Brown et al., *AntiPatterns*, 1998; Fowler, *Refactoring*, "Extract Class") | The literature basis this project's own 2026-09-02 architecture-night comment already cited for the same file. Not new tonight, carried forward for continuity. | A (established literature, already cited in-repo) |
| ruClip's own prior extraction attempts (2026-09-02 `operating-budget.ts`, 2026-09-07 `pattern-store.ts`) | Both ACCEPT-verdict, both clean (0 regressions), both still unmerged (PR #9 open/draft, PR #17 open) as of tonight. Internal precedent/lineage for tonight's technique, not a new source. | A (this repo's own ledger + git history) |

## Frozen hypothesis (written before implementation, unmodified since)

> Given the existing `npm test` suite (327 tests) exercising every bounded context
> in `agentdb-adapter.ts` that calls the generic hierarchical-store wrappers
> (`storeAtTier`/`deleteFromTier`/`recallByKey`), when those three functions (plus
> their private helper `assertToolSucceeded`) are extracted verbatim into a new
> dependency-free module `store/hierarchical-store.ts` and imported back, then the
> god-module's line count should decrease by roughly 60-80 lines and the full test
> suite should pass with an identical pass count and zero behavioral change at every
> call site, subject to: `tsc` type-checks clean, no test file needs modification,
> and no function outside this file references the four moved names (confirmed via
> repo-wide grep before the move).

## Evaluation receipt

- Baseline (`git stash` off, i.e. current `main` @ `6e73a8f`): `npm test` → **327
  pass / 0 fail / 0 skipped** (build clean, `tsc -p tsconfig.json`).
- Candidate (this branch): `npm test` → **327 pass / 0 fail / 0 skipped** (build
  clean). Line count: `agentdb-adapter.ts` 1483 → 1419 (**-64**); new
  `hierarchical-store.ts`: **+105**. Diff to `agentdb-adapter.ts`: 8 insertions, 72
  deletions (pure code motion + a replacement pointer comment).
- Both runs performed for real (`npm test`, which runs `npm run build` first) — not
  inferred from logs. Independent critic subagent re-ran both `npm run build` and
  `npm test` itself from a fresh shell and got the same 327/327, confirming the
  numbers above rather than trusting this session's own report.

## Adversarial critique (independent subagent, not this session's author identity)

**Verdict: CLEAN.** Checked: line-by-line diff (byte-identical logic, only
whitespace/comment differences); visibility change (three functions now `export`ed
from the new file but **not** re-exported further from `agentdb-adapter.ts` — no
new public surface); repo-wide grep for all four names (only internal use + one
test *title string* that exercises `storeAtTier` indirectly through `persistCompany`,
no direct import or reflection dependency anywhere); re-ran build + tests itself
(327/327, matching); confirmed no test file was modified, no gold value or
threshold touched, no `.harness/bench.json` benchmark-corpus regression (that file's
`allowedMutationFiles` for task-0002/0003 names `agentdb-adapter.ts`, which is still
present and still mutable — the new file isn't yet listed, flagged as a follow-up
for whoever owns Phase 3 bench-corpus wiring, not a blocker for this slice).

## Darwin

Not run tonight — the change is a single, already-minimal mechanical extraction
with no meaningful mutation space (there is exactly one correct way to move three
functions verbatim); Bounded Darwin is optional per the routine and adds no signal
here. Budget spent on the independent critique pass instead.

## Reward-hack check

No weakened assertions, no suppressed `tsc` diagnostics, no skipped/altered tests,
no touched thresholds, no undocumented cache dependency. Confirmed independently
(see critique above), not just self-asserted.

## Security review

Not security-sensitive: pure code motion of already-existing internal storage
primitives (unchanged error handling, unchanged wire calls to `agentdb_hierarchical-
store`/`-delete`/`-recall`), no new external surface, no credential/authorization/
prompt-injection/MCP-authority path touched. `assertToolSucceeded`'s fail-loud
behavior (treating `{success:false}` as a thrown error, not a silent no-op) is
preserved verbatim.

## Process finding (SCAN=docs, not tonight's candidate, but material)

`docs/dream-cycle/LEDGER.md` on `main` has not been appended to since 2026-09-06,
despite 8 further dream-cycle nights (09-07, 08, 09, 10, 11, 15, 16) each producing
a real issue, PR, and branch (confirmed via GitHub MCP + `git fetch` of every
`dream/*` branch). Root cause found: each of those nights *did* append its own
ledger row — but only on its own unmerged branch (confirmed: `dream/2026-09-07-
architecture`, `-09-10-correctness`, and `-09-15-correctness` all carry a
`docs/dream-cycle/LEDGER.md` diff). Because only 3 of 11 dream-cycle PRs have
merged (#11, #13, #15 — most recently 2026-09-07), and STEP 1 instructs each night
to read the ledger from `main`, every night since 09-07 has been computing STEP 1.1's
learning signals (duplicate-avoidance, "N of last 14 merged" bias) against a ledger
that is 8 nights stale relative to actual GitHub state. This session corrected for
it by fetching every `dream/*` branch directly and cross-checking PR states via the
GitHub MCP tools rather than trusting `main`'s `LEDGER.md` alone — recommended as a
standing STEP 1 practice (fetch `dream/*` branches, not just read `main`) until PRs
start merging or the ledger-write step is moved somewhere durability doesn't depend
on merge. Real numbers as of tonight: 11 dream-cycle PRs total, 3 merged (27%), most
recent merge 2026-09-07 — 6 of the last 6 dream-cycle nights (08 through 16)
produced a PR that is still open. This IS this session's applied learning signal
(STEP 1.1: "zero of last 14 merged" bias) — tonight's candidate was deliberately
chosen to be the smallest, most mechanical, most obviously-reviewable change
available (a verbatim function move with an independent-critic CLEAN verdict), for
exactly this reason.

## 3 concrete next steps

1. A human should review and merge (or explicitly reject) the backlog of 8 open
   dream-cycle PRs (#9, #17, #19, #21, #23, #25, #27, #29) — several are small,
   independently-evaluated, ACCEPT-verdict changes sitting idle; the ledger's own
   cross-night learning signals degrade the longer this backlog grows.
2. With `hierarchical-store.ts` now a clean dependency-free leaf, the
   heartbeat-schedule bounded context (`persistHeartbeatSchedule`/
   `recallHeartbeatSchedule`/`listDueHeartbeats`/`listHeartbeatsForCompany`, ~186
   lines) becomes a *safe* extraction candidate for a future architecture night —
   it was not safe before tonight (it needs `storeAtTier`/`deleteFromTier`, which
   were private to `agentdb-adapter.ts` until now).
3. Consider whether `docs/dream-cycle/LEDGER.md` should be written to a location
   whose durability doesn't depend on PR merge (e.g. appended directly to `main` by
   a lightweight, low-risk automation step, or tracked via GitHub Issues/labels
   instead of a file) — flagged for the routine owner, not something this session
   should decide unilaterally.

## Witness

```
REPORT_HASH    = 6eb027ab0c63eefdf1dd18ddeb664b68f4f68352cf2d029036662207192337f3
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = cb1e32c95d6fc7050b00ea6253f61088c76d00a1c15d66de3ad8b165686a6197
```

`REPORT_HASH` is the sha256 of this file's content up to (and including) the
line directly above this Witness section — i.e. everything before `## Witness`
itself — computed once, before this section was filled in (a self-referential
hash of the whole file including its own hash would be circular). `WITNESS =
sha256(REPORT_HASH || SESSION_COMMIT)`, computed as
`printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text (docs/dream-cycle/2026-09-17-architecture-report.md) up to the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. Independently re-run `npm test` against the PR branch's HEAD and confirm 327/327 (0 fail) — the receipt this report claims.
