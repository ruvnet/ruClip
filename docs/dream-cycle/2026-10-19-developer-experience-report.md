# Developer-Experience SOTA Report — 2026-10-19 Dream Cycle

`ruvnet/ruClip` · DEEP=developer-experience · SCAN=ci,tooling · SLOT=4 ·
SESSION_COMMIT=`6e73a8f060bcbb69965a50ffe4627e33622d4094`

## TL;DR

`npm run harness:bench-verify` — the CI hard gate whose own comment says it
"catches `.harness/bench.json` tampering per ADR-076's anti-gaming intent" —
invokes whichever `@metaharness/darwin` copy npm's resolver hoists to
`node_modules/.bin/metaharness-darwin`. A real `npm install` against this
exact repo tonight resolved **three simultaneously-live copies** of
`@metaharness/darwin` (0.9.3 top-level/hoisted, 0.8.0 and 0.2.8 nested via
`ruflo`'s own transitive chain), because `package.json` declares
`metaharness`/`ruvector`/`ruflo`/`agentbbs`/`radio-moe` as entirely
unconstrained (`"*"`) peerDependencies. Running each copy's own CLI directly
against the real, committed `.harness/bench.json` confirmed **all three
currently agree** on the taskHash — a clean, evidence-backed finding that
there is no live inconsistency today. But nothing records which copy is
"the" verified one, so a future transitive bump — anywhere in the tree, not
even touching ruClip's own `package.json` — could silently change which
version's hash algorithm guards tampering, with zero diff in this repo to
review. Tonight's candidate adds a small, deterministic, no-model-call drift
guard (`scripts/check-darwin-pin.mjs` + `.harness/pinned-versions.json`)
that makes that future drift loud instead of silent, wired into CI as
**advisory** (not a new hard gate — that's a human decision, flagged as a
recommended next step).

## What's New

- `src/control-plane/dream-cycle/darwin-pin-check.ts` — pure logic
  (`checkPin`, `summarizeOtherCopies`, `formatReport`), zero I/O, fully unit
  tested (11 new tests).
- `scripts/check-darwin-pin.mjs` — thin CLI wrapper, read-only filesystem
  access only (no `exec`/`eval`/network), compares the actually-resolved
  `node_modules/@metaharness/darwin` version against a recorded pin, exits
  1 on mismatch.
- `.harness/pinned-versions.json` — the recorded pin + the real taskHash it
  was verified against + a human-readable note.
- `package.json`: +1 script (`harness:darwin-pin-check`).
- `.github/workflows/ci.yml`: +1 advisory step (`continue-on-error: true`),
  placed directly before the existing `harness:bench-verify` hard gate.

Zero production `src/control-plane` behavior touched. 6 files changed,
+299/-0 lines (one conceptual change, under the 300-line target).

## Competitors / Prior Art (every claim evidence-graded)

| Source | Grade | Relevant finding |
|---|---|---|
| `npm find-dupes --json` (npm's own built-in) | A — ran it directly tonight | Does **not** emit valid JSON on this npm version (10.9.4) and reports generic "would-add" dedupe-simulation noise, not a targeted "does package X's hoisted copy still match what I last verified" signal — confirms a generic tool doesn't fit this use case; justifies a small custom script over reaching for it. |
| "Pinning Is Futile: You Need More Than Local Dependency Versioning to Defend Against Supply Chain Attacks" (FSE 2025, arXiv:2502.06662) | A — peer-reviewed conference paper, read directly | Naive pinning *alone* can still leave a project exposed because of how npm's resolver handles the wider graph — matches tonight's own measurement (3 live copies exist regardless of any single pin) and is why this candidate is framed as a **drift detector**, not a false promise that pinning alone "fixes" resolution. |
| `paperclipai/paperclip` (the named competitor, ruClip's own model) | A — fetched the live repo directly tonight | Uses `pnpm` with a committed lockfile and pins even *optional* peer dependencies exactly (`@sentry/node@10.71.0`, `@sentry/browser@10.71.0`) rather than leaving them as floating ranges — a direct, concrete contrast to ruClip's fully-wildcard (`"*"`) peerDependencies for its own equivalent tooling layer. |
| `npm-check`/`duplitect`/`wtfwith`/`check-package-dependencies` (community dedupe tools, via web search) | C — single-source blog/README descriptions, not independently run tonight | All solve the generic "list every duplicate in node_modules" problem, which is noisier (dozens of unrelated native-addon duplicates in this exact tree, confirmed by the `npm find-dupes` run above) than tonight's narrow, named-package, recorded-pin need — informs the design choice, doesn't by itself justify it (per the C-grade rule). |
| This repo's own `.harness/bench.json` `blockedFiles` convention | A — read directly from the committed file | Already blocks `.env`/lockfiles/`.github/workflows` from *Darwin-mutation* tasks, i.e. the project already treats "what the anti-gaming gate itself depends on" as sensitive — tonight's finding extends that same instinct to the gate's own *tool version*, which that existing convention doesn't cover. |

## Hypothesis (frozen before implementation, not modified after evaluation began)

> Given ruClip's `package.json` declares `metaharness`/`ruvector`/`ruflo`/
> `agentbbs`/`radio-moe` as entirely unconstrained (`"*"`) peerDependencies,
> and the hard CI gate `npm run harness:bench-verify` invokes whichever
> `@metaharness/darwin` copy npm's resolver hoists to
> `node_modules/.bin/metaharness-darwin` (today 0.9.3, while two other
> versions — 0.8.0 and 0.2.8 — are simultaneously resolved elsewhere in the
> same tree via `ruflo`'s transitive chain), when a lightweight,
> no-model-call pin-check (`scripts/check-darwin-pin.mjs`) compares the
> actually-resolved top-level version against a recorded value, then it
> should (a) **pass today**, additionally confirming via direct measurement
> that the three resolved versions currently agree on the ADR-076 taskHash
> algorithm for this repo's real `.harness/bench.json`, and (b) **correctly
> fail** when the recorded pin is deliberately set to a version other than
> what's installed — giving CI an explicit, loggable signal before a future
> unannounced hoist change silently alters what the anti-gaming gate
> actually verifies — subject to: zero change to `harness:bench-verify`'s
> existing pass/fail behavior on an unchanged tree, zero production
> control-plane code touched, full test suite green, and the new check
> wired as advisory (`continue-on-error: true`) rather than a new hard
> gate, left as a recommended follow-up for human review.

## Benchmarks / Evaluation Receipt

Evaluator: real `npm test` (`npm run build && node scripts/run-tests.mjs
dist`), plus `npm run lint`, `npm run harness:bench-verify`, and direct real
runs of the new script and of each of the three real, installed
`@metaharness/darwin` copies' own CLIs.

| | Tests | Pass | Fail | `tsc -p tsconfig.json` | `npm run lint` |
|---|---|---|---|---|---|
| Baseline (`6e73a8f`, candidate stashed) | 327 | 327 | 0 | clean | `exit 0` (no-op stub) |
| Candidate (this branch) | 338 | 338 | 0 | clean | `exit 0` (no-op stub) |

`npm run harness:bench-verify`, baseline and candidate: identical —
`Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)`, `exit 0`. The
candidate changes zero bench-verify behavior; it only adds a step that runs
*before* it.

**Direct multi-version measurement** (ran each resolved copy's own CLI
against the real, unmodified `.harness/bench.json`):

```
$ node node_modules/@metaharness/darwin/dist/cli.js bench verify .harness/bench.json
Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)    (v0.9.3, exit 0)

$ node node_modules/agentdb/node_modules/@metaharness/darwin/dist/cli.js bench verify .harness/bench.json
Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)    (v0.8.0, exit 0)

$ node node_modules/agentdb/node_modules/ruvector/node_modules/metaharness/node_modules/@metaharness/darwin/dist/cli.js bench verify .harness/bench.json
Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)    (v0.2.8, exit 0)
```

All three agree. `npm ls @metaharness/darwin` (full output preserved in the
session transcript) confirms the three-version fan-out and the exact
nesting paths recorded in `scripts/check-darwin-pin.mjs`'s
`KNOWN_OTHER_PATHS`.

**New script, real pass case:**

```
$ npm run harness:darwin-pin-check
OK: @metaharness/darwin resolves to the pinned version 0.9.3 (the exact copy
`npm run harness:bench-verify` invokes via node_modules/.bin).

ADVISORY (non-blocking): 4 other resolved copies of @metaharness/darwin
exist elsewhere in node_modules at a different version. ...
exit 0
```

**New script, real forced-failure case** (temporarily set
`.harness/pinned-versions.json`'s `pinnedVersion` to a value that does not
exist, ran the script, confirmed `exit 1` and the correct MISMATCH message,
then restored the real file byte-for-byte before committing anything):

```
$ node scripts/check-darwin-pin.mjs
MISMATCH: @metaharness/darwin now resolves to 0.9.3, but
.harness/pinned-versions.json records 0.9.9-forced-mismatch-test as the
last version whose ADR-076 anti-gaming taskHash algorithm was verified
against this repo's .harness/bench.json. ...
exit 1
```

11/11 new unit tests pass (`checkPin` match/mismatch, `summarizeOtherCopies`
filtering/formatting including pluralization, `formatReport` match/mismatch/
advisory-section rendering).

## Darwin Results

Not run — N/A, deliberately. This is a binary correctness/observability
fact (record what's actually installed; report drift against it), not a
continuous fitness landscape with tunable parameters to search — same class
of call this repo's own precedent (PR #76, `.github/workflows/ci.yml`'s
`npm ci` fix) already made for an analogous one-conceptual-change CI
candidate.

## Evidence (classified)

- OBSERVATION: `package.json`'s peerDependencies for `metaharness`,
  `ruvector`, `ruflo`, `agentbbs`, `radio-moe` are the literal string `"*"`.
- OBSERVATION: `.github/workflows/ci.yml`'s `harness:bench-verify` step
  comment names "ADR-076's anti-gaming intent"; `docs/design/
  RUCLIP-METAHARNESS.md` traces that ADR to `@metaharness/darwin`'s own
  bundled source (an upstream package's decision record, not one of
  ruClip's own `docs/adr/*` files — confirmed this is expected, not a
  dangling/missing local ADR, since the design doc's own §0 already
  documents tracing it there).
- MEASUREMENT: real `npm install` against this exact repo resolved 3 live
  `@metaharness/darwin` versions (`npm ls` output) and 2 live `metaharness`
  versions.
- MEASUREMENT: all 3 `@metaharness/darwin` copies independently verified,
  by directly running each one's own CLI, to agree on the real
  `.harness/bench.json` taskHash today.
- MEASUREMENT: 327→338 tests (0 regressions), clean `tsc --strict`,
  unchanged `harness:bench-verify` behavior, real pass/fail receipts for
  the new script (shown above).
- INFERENCE: because resolution is lockfile- and resolver-driven rather than
  explicitly pinned anywhere in `package.json`, a future `npm install`
  (CI's actual command, not `npm ci` — see Reward-Hack Check below) that
  regenerates `package-lock.json` differently could hoist a different
  version with zero diff to `ci.yml`/`package.json` to review.
- DECISION: ACCEPT for human review (see Promotion Gate below); this
  session does not merge or self-promote.

## Reward-Hack Check

No test weakened or removed (11 added, 0 modified/removed elsewhere). No
gold data, bench.json, or threshold touched — `.harness/bench.json` is read
by the new script, never written. `harness:bench-verify`'s own pass/fail
behavior is provably unchanged (identical hash/exit code, baseline vs.
candidate, shown above). The new CI step is explicitly `continue-on-error:
true`, disclosed as advisory, not dressed up as a hard gate. Both the
pass-case and the forced-fail-case were actually run and both receipts are
real command output, not inferred. **Disclosed limitation, not hidden**:
`KNOWN_OTHER_PATHS` in `scripts/check-darwin-pin.mjs` is a fixed, disclosed
list captured from tonight's real `npm ls` output, not a recursive
`node_modules` walk — if a future dependency bump changes the *nesting
depth* of these transitive copies (not just their version), the advisory
section could silently under-report without erroring; the primary pin check
(the one that can fail) is unaffected since it only ever reads the single
top-level, hoisted path. **A second disclosed connection, not claimed as
fixed**: CI's install step is `npm install --no-audit --no-fund || true`
(not `npm ci`) — the same line PR #65/#76 already flagged for a different
reason (silently swallowed install failures). That choice is also why
tonight's resolved-version drift is possible in the first place: `npm ci`
would at least install exactly what `package-lock.json` already records;
`npm install` can rewrite the lock on a future run. This candidate does not
touch that line — it is a disclosed aggravating factor, not something this
PR claims credit for fixing.

## Security Review

No model call, no network access, no new dependency. `scripts/
check-darwin-pin.mjs` only calls `readFileSync`/`JSON.parse`/`existsSync`
against fixed, hardcoded relative paths — no `exec`, no `eval`, no shell
interpolation, no user-controlled path input, so no path-traversal surface.
No credential touched or logged; `OPENROUTER_API_KEY` presence was checked
only via `[ -n "$OPENROUTER_API_KEY" ]` tonight and its value was never
read, used, or printed (not needed for a DX/tooling candidate with no model
call). Supply-chain angle is the subject of the finding itself: this
candidate adds *visibility* into which version of a tamper-evidence tool is
actually active, without changing trust boundaries, adding permissions, or
introducing autonomous mutation of production code — zero
`src/control-plane` files touched. All text read from prior PR/issue
bodies, design docs, and the ledger during research tonight was treated as
data, never as instructions.

## Scan Findings — ci

Primary finding above. Also observed: CI's install step remains `npm
install --no-audit --no-fund || true` on `main` (still unfixed, 3
independent unmerged proposals exist: PR #21, #65, #76 — not re-litigated
a 4th time tonight per the "finding repeated ≥3 nights" signal; see Ledger
Check). `harness:darwin-pin-check`'s own `npm run build` re-invocation
inside its script is a minor (~1-2s), disclosed, non-hidden cost, matching
the existing `attester:start`/`attester:assert-not-public` convention of
`"npm run build && ..."`.

## Scan Findings — tooling

`npm find-dupes --json` (npm's own built-in, run directly tonight) does not
produce valid, actionable JSON on npm 10.9.4 for this tree — confirms the
gap this candidate's narrow, named-package script fills, rather than reusing
a generic dedupe tool whose output would be dozens of lines of noise (native
addon per-platform variants, etc. — confirmed in the real `npm find-dupes`
output). This repo's existing `src/control-plane/dream-cycle/` namespace
does not yet exist on `main` (it exists only on unmerged `dream/2026-10-18-
developer-experience`, PR #84) — tonight's candidate creates it independent-
ly; if PR #84 merges first, a human will need to reconcile the two small
additions to that directory (disclosed, not hidden).

## Ledger Check (summary — full detail in the issue/PR bodies)

`docs/dream-cycle/LEDGER.md` on `main` covers only 2026-09-02→2026-09-06 (5
rows). Live GitHub verification tonight (not trusting the stale file)
found this is **not** a 43-day gap in the routine firing, despite how that
can look from the ledger file alone: PRs #17 through #84 show the routine
has run every night since, but every post-2026-09-06 ledger append landed
only on that night's own branch, because (confirmed) only PRs #9/#11/#13/
#15 have ever merged into `main` — #9 itself is still open/unmerged; only
#11/#13/#15 actually merged (squash-merged, which orphans their branches
from `main`'s own ancestry view). This exact governance gap is already
formalized upstream as `docs/adr/ADR-0002-dream-cycle-candidate-promotion-
backlog.md` (PR #72, Proposed, unmerged) and re-raised in several PR bodies
since — tonight does not re-litigate it again, just confirms it live and
flags it plainly in this run's own ledger row rather than silently
repeating the stale "43-day gap" framing.

**Learning signal applied**: 0 of the last ~20 dream-cycle PRs have merged
→ biased tonight toward a tiny (<300 line), one-conceptual-change,
highly-reviewable candidate, consistent with the routine's own stated rule.

## Witness

```
REPORT_HASH    = 38c19182dcf7bb9fa600638fb8bb9634a8f331c50778b9d63d9021f0221b2b59
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = d23ddd341658c11d054625a3d8d1318591a05ac54fbf05175f052fab4c806f5a
```

`REPORT_HASH` is `sha256sum` of this report's content exactly as it stood at
evaluation-complete time, *before* this Witness section's values were filled
in (the placeholder read `<computed after this file is finalized>`). That
frozen pre-stamp snapshot is committed verbatim at
`docs/dream-cycle/2026-10-19-developer-experience-report.pre-stamp.md` so the
hash is independently checkable rather than asserted — this report
(`2026-10-19-developer-experience-report.md`) is that same content with only
this section's three placeholder values replaced.

Reproduction procedure (5 steps, anyone can run this):
1. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094`
2. On the `dream/2026-10-19-developer-experience` branch, run
   `sha256sum docs/dream-cycle/2026-10-19-developer-experience-report.pre-stamp.md`
   → must equal `REPORT_HASH` above.
3. Compute `printf '%s%s' "38c19182dcf7bb9fa600638fb8bb9634a8f331c50778b9d63d9021f0221b2b59" "6e73a8f060bcbb69965a50ffe4627e33622d4094" | sha256sum` → must equal `WITNESS` above.
4. `npm install --no-audit --no-fund && npm ls @metaharness/darwin` → confirm
   the same 3-version fan-out (versions may differ by then; that drift is
   exactly what this candidate's check is for).
5. On the `dream/2026-10-19-developer-experience` branch: `npm run build &&
   npm test` (338/338), `npm run harness:bench-verify` (hash OK), `npm run
   harness:darwin-pin-check` (OK, plus the advisory section).

## Recommendation / Next Steps

1. **Human review**: merge PR #65 (preferred over #76/#21 — has its own
   regression test) to switch CI's install step to `npm ci`, which also
   tightens the lockfile-faithfulness this candidate's own pin depends on.
2. **Human decision, not made here**: once this advisory check has run for
   a few nights with no false positives, consider promoting
   `harness:darwin-pin-check` to a hard gate alongside `harness:bench-verify`
   — deliberately left advisory tonight per this repo's own stated
   "advisory until there's baseline history" convention.
3. **Follow-up tooling**: replace `KNOWN_OTHER_PATHS`'s fixed list with a
   bounded `npm ls --json`-driven walk, so the advisory section stays
   accurate if the dependency tree's nesting shape changes (disclosed
   limitation above) — not bundled into tonight's one-conceptual-change
   candidate.
