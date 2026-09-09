**GitHub auth**: MCP `github` server authenticated as `ruvnet` (`get_me` succeeded) —
issue/PR publication (below, via GitHub MCP tools) is real. No gist-creation
tool is available in this session's toolset (no `gh` CLI binary; the GitHub
MCP server exposes no gist primitive), so the report normally published as a
gist is committed to this repo instead — see its own "Gist" section below.

---

# Dream Cycle 2026-09-09 — developer-experience + ci,tooling scan

**Repo**: `ruvnet/ruClip` · **Session commit**: `6e73a8f060bcbb69965a50ffe4627e33622d4094`
**Branch**: `dream/2026-09-09-developer-experience`

## Rotation

`DAYINT=20260909`, `SLOT = 20260909 % 5 = 4` → `DEEP=developer-experience`,
`SCAN=ci,tooling`. Bonus check: `20260909 % 25 = 9` (not 0) — no
roadmap-review bonus tonight.

## Ledger Check

Read `docs/dream-cycle/LEDGER.md` (5 prior rows, 2026-09-02 through
2026-09-06 committed to `main`) and cross-checked the last 7 nights' PRs via
the GitHub MCP server (`list_pull_requests`, `state=all`):

| Night | Issue | PR | State |
|---|---|---|---|
| 2026-09-02 architecture | #8 | #9 | OPEN, unmerged |
| 2026-09-03 performance | #10 | #11 | CLOSED, unmerged |
| 2026-09-05 correctness | #12 | #13 | CLOSED, unmerged |
| 2026-09-06 security | #14 | #15 | CLOSED, unmerged |
| 2026-09-07 architecture | #16 | #17 | OPEN, unmerged |
| 2026-09-08 performance | #18 | #19 | OPEN, unmerged |

**Learning signal applied**: 0 of the last 6 dream-cycle PRs merged →
biased tonight's candidate selection toward a tiny, one-parameter,
easily-reviewable change (`PROMPT.md` STEP 1.1). No DEEP surface has
repeated ≥3 nights running (architecture and performance have each run
twice, non-consecutively); no `LLM_EVAL=blocked` streak (`OPENROUTER_API_KEY`
is present tonight, same as 2026-09-06); no self-score history exists in
prior reports to evaluate a 3-consecutive-<5 signal against. 2026-09-04
(slot 4, developer-experience) has no branch/issue/PR in the repo — tonight
is this slot's first real run. Accumulated evidence checked:
`docs/dream-cycle/*.md`, `docs/adr/ADR-0001-ruclip-control-plane.md` (only
existing ADR — no prior lint/tooling/developer-experience finding).

## Deep Dive

`ruClip`'s `npm run lint` has been a permanent no-op stub (`echo "no lint
config yet — scaffold stage" && exit 0`) since the repo's scaffold commit,
and is not even wired into `.github/workflows/ci.yml`. Probing the codebase
with a dedicated, non-emitting stricter `tsc` config (`noUnusedLocals`,
`noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitReturns` —
zero new dependencies, `typescript` is already a devDependency) surfaces 3
real findings on the very first run, one of which is not cosmetic: in
`src/control-plane/governance/propose-budget-mutation.ts`, the tightened
`hardStopThreshold` value computed for a proposed Autogenous budget mutation
is passed into `buildMutation(parent, newThreshold)` and then silently
dropped — `newThreshold` is an unused parameter, and neither the real
Autogenous `Mutation` wire type nor this repo's own local
`AutogenousMutationRecord` persists what value was actually proposed. The
signed audit trail (ADR-103, this project's core reused-primitive per
ADR-0001 point 1) currently has no durable record of what the governance
system asked to change to.

Confirms zero-dependency-cost dead-code detection is available today via
TypeScript's own compiler flags, without adopting a full lint stack; finds
a real correctness/audit-completeness gap that 6 prior dream-cycle nights
(2026-09-02 through 2026-09-08) did not surface, because nothing in this
repo's CI has ever run any form of unused-code analysis; establishes
`docs/dream-cycle/`'s first *developer-experience* finding.

**5 candidates considered** (scored 1-5 on
fit/novelty/testability/measurability/production-value/reviewability):

1. **Wire `npm run lint` to a real stricter-tsc dead-code gate, fix what it finds** — 5/4/5/5/5/5 = **29** — SELECTED.
2. Adopt full ESLint + typescript-eslint flat config — 5/3/4/3/4/2 = 21 (more capable per A-grade evidence, but new deps + config + larger surfaced-finding count; too large for tonight's 0/6-merged bias).
3. Bump CI's `node-version: 20` to 22 — 3/1/2/1/1/5 = 13 (investigated: already moot — `scripts/run-tests.mjs` already walks the filesystem itself rather than relying on Node's built-in `--test` glob, so PR #3's original diagnosis no longer applies; rejected as a non-finding).
4. Add a Knip advisory dead-export scan — 4/4/3/2/3/3 = 19 (interesting per SOTA research; deferred to next-steps, new dependency + tuning risk too large for tonight).
5. Fan out `harness:advisory`'s 3 sequential sub-scripts concurrently — 3/2/3/3/2/4 = 17 (legitimate DX angle, but 2026-09-08 already did a concurrency-fan-out finding this rotation cycle; lower production-value than #1).

No override of the top score needed — #1 is the clear winner on every axis
except novelty (tied with #4).

## Hypothesis (frozen before implementation)

> Given ruClip's current TypeScript source and test tree (327 passing tests,
> `npm run lint` a permanent no-op stub not wired into CI), when `npm run
> lint` is rewired to run a dedicated, non-emitting `tsconfig.lint.json`
> (extending the build config with `noUnusedLocals`, `noUnusedParameters`,
> `noFallthroughCasesInSwitch`, `noImplicitReturns`) and that check is added
> as a required CI step, then: (a) the new lint gate should fail on the
> current tree's 3 real pre-existing dead-code sites and on a synthetic
> injected regression, and pass cleanly once those 3 findings are fixed; (b)
> `npm run build` and `npm test` should remain unchanged (0 regressions, same
> pass count plus any newly added regression test); and (c) fixing the
> `propose-budget-mutation.ts` finding (the unused `newThreshold` parameter)
> should not just satisfy the lint check but close a real data-loss gap in
> the governance audit trail, verified by a new unit test asserting the
> proposed threshold is durably persisted on `AutogenousMutationRecord`.

## Evaluation Receipt (real, reproduced — not inferred from logs)

- **Baseline** (parent: `tsconfig.lint.json` wired to `npm run lint`, 3
  pre-existing findings left unfixed): `npm run lint` → **3 errors**
  (TS6133 ×3 — `actorCredentialFrame` unused import, `newThreshold` unused
  parameter, `actor` unused test-local), exit 2.
- **Reward-hack / placebo check**: injected a 4th synthetic unused
  top-level `const` into `agentdb-adapter.ts` (a file otherwise lint-clean)
  — `npm run lint` correctly reported **4** errors including the injected
  one, at its real line number; file reverted, `git diff --stat` confirmed
  clean revert. Confirms the gate reacts to real code changes, not a
  fixed/cached result.
- **Candidate** (3 findings fixed; `AutogenousMutationRecord` gains
  `proposedHardStopThreshold: number`, threaded through both the admitted
  and rejected paths of `checkAndProposeBudgetMutation`): `npm run lint` →
  **0 errors**, exit 0. `npm run build` → exit 0 (dist output unaffected —
  `tsconfig.lint.json` is `noEmit: true` and fully separate from the build
  config). `npm test` → **327/327** pass, exit 0 (same count as baseline —
  two regression assertions were added to two *existing* tests rather than
  new `test()` blocks).
- **Adversarial regression check on the fix itself**: temporarily hardcoded
  `proposedHardStopThreshold: 0` at the record-construction call site
  (simulating "field added but never wired to the real computed value") —
  `npm test` correctly dropped to **2 failing tests** (the two new
  assertions, both expecting `0.95`), then restored to 327/327 clean. This
  confirms the new tests actually exercise the fix, not a vacuous field.
- `npm run harness:bench-verify`: hash `840fd8d2d698…` unchanged —
  `.harness/bench.json` corpus was not touched.
- Independent critic (fresh subagent, no access to this session's own
  reasoning, given only the diff + claim + repo access): re-derived
  `tightenedThreshold(1.0) === 0.95` from source independently, confirmed
  `tsconfig.json`/`.harness/bench.json` untouched, confirmed no existing
  test *assertion* line was altered (only additions/one dead-line removal),
  confirmed `proposedHardStopThreshold` is not write-only dead weight
  (traced `persistAutogenousMutationRecord`/`recallAutogenousMutationRecord`
  round-tripping it through durable storage), re-ran build/lint/test fresh
  itself (327/327, both exit 0) — verdict: **CLEAR**, no blocking issues.

`evaluated: accepted`

## Darwin Results

Not applicable — tonight's candidate (a boolean lint gate + one audit
field) has no continuous/tunable parameter space to search (contrast with
2026-09-03's concurrency-cap sweep). Skipped, not run-and-discarded.

## Evidence

- OBSERVATION: `npm run lint` was `echo ... && exit 0` (`package.json`) and
  absent from `.github/workflows/ci.yml` before tonight.
- MEASUREMENT: baseline lint 3 errors / exit 2; candidate lint 0 errors /
  exit 0; candidate `npm test` 327/327, exit 0; synthetic-regression probe
  correctly caught (4 errors) and correctly reverted; adversarial
  hardcoded-wrong-value probe correctly failed 2 tests, then restored clean.
- INFERENCE: the `newThreshold`/`proposedHardStopThreshold` gap is a real,
  previously-undetected audit-completeness bug in the Autogenous governance
  integration, not merely a style nit — the durable record had no way to
  say what a proposed mutation actually asked to change to.
- DECISION: fix the 3 findings, add the durable field, wire the gate into
  CI, keep the diff to one conceptual change (+28/-5 across 7 files, one
  new config file).
- REJECTION: candidate #3 (bump CI to Node 22) — investigated and found
  already moot; not pursued further.

## Reward-Hack Check

Independent critic confirmed (see Evaluation Receipt): `tsconfig.json` and
`.harness/bench.json` untouched; `tsconfig.lint.json` adds no
`include`/`exclude` narrowing (inherits the build config's scope
unmodified); no existing test assertion was altered, only added-to or (in
one case) a genuinely-dead line removed; `0.95` is a derived value
(`tightenedThreshold(1.0)`), not a hardcoded coincidence; the new
`proposedHardStopThreshold` field is read back through
`recallAutogenousMutationRecord`, not write-only. Reward-hack signal:
**clear**.

## Security Review (STEP 15)

- Prompt injection / agent impersonation: N/A, no LLM calls in this
  candidate.
- Tool/MCP authority, filesystem/network scope: unchanged — CI gains one
  `tsc --noEmit` step, zero new file writes, zero new network calls.
- Credential exposure: none touched — `human-identity-attestation.ts`'s
  only change is a dead import removal; signing/nonce/attestation logic is
  byte-for-byte unchanged (independently confirmed by the critic).
- Fail-open/fail-closed behavior: unchanged in `propose-budget-mutation.ts`
  — `buildMutation`'s wire-format output is identical (only the unused
  parameter was dropped); admit/reject branching and canary creation are
  untouched; the new field is purely additive to the audit record.
- Memory/benchmark poisoning: `.harness/bench.json` hash verified unchanged.
- Supply-chain exposure: **zero new dependencies** — `typescript` is
  already a devDependency; `tsconfig.lint.json` is pure configuration.
- Unsafe autonomous mutation: candidate lives on a draft PR only; this
  session never merges or self-promotes.

## Scan Findings: ci

`.github/workflows/ci.yml` runs `build` → (now) `lint` → `test` →
`harness:advisory` (continue-on-error, informational) → `harness:bench-verify`
(hard gate). `node-version: 20` is pinned; confirmed non-issue tonight since
`scripts/run-tests.mjs` no longer depends on Node's own `--test` glob
support (see candidate #3 above). No other CI gaps found tonight beyond the
lint gate itself.

## Scan Findings: tooling

`npm run --silent` capability probe: `build`, `test`, `lint` (now real),
`harness:score`/`genome`/`mcp-scan`/`advisory`/`bench-verify`,
`attester:start`/`assert-not-public`. All non-optional peer dependencies
(`metaharness@0.4.8`, `ruflo@3.38.20`, `ruvector@0.3.0`) resolved cleanly via
`npm ci`; `agentbbs` (optional) did not resolve, as expected. Noted but not
pursued tonight: nested `ruvector@0.2.41` under `agentdb`'s dependency tree
vs. top-level `ruvector@0.3.0` — pre-existing, already tracked separately
per ADR-0001's Neutral consequences section.

## Competitors (evidence-graded)

| Tool | Approach | Cost to adopt in ruClip today | Grade |
|---|---|---|---|
| **paperclipai/paperclip** (mission's named competitor) | Full required CI gate set — lint, typecheck, tests, build all block merge; Greptile automated review must score 5/5 | N/A (reference point, not directly reusable — different stack) | B (public repo/CONTRIBUTING.md, not independently re-run tonight) |
| **TypeScript compiler flags** (`noUnusedLocals`/`noUnusedParameters`) — tonight's candidate | Built into `typescript`, already a devDependency; no new deps, no config format to learn | Zero — one new `tsconfig.lint.json` | A (official TS handbook behavior, reproduced directly against this repo tonight) |
| **typescript-eslint `no-unused-vars`** | More configurable than the compiler flags (catches unused `catch` bindings, `_`-prefix opt-out, per-rule severity); maintainer-recommended over the raw compiler flags | New deps (`eslint`, `typescript-eslint`, flat config), first lint-stack adoption in this repo | A (maintainer statement, typescript-eslint/typescript-eslint#1859) |
| **Knip** | Whole-project dead-export/dead-file/dead-dependency graph analysis; called out as 2026's dead-code-layer tool of choice | New dependency, first use, more surface to tune (ignore-lists) before it's CI-safe | C (single-source 2026 blog roundups, not independently verified) |
| **Biome / Oxlint** | Rust-based, 10-56x faster than ESLint; Oxlint's 2026 `tsgo`-backed type-aware mode reaches ESLint-level accuracy | New toolchain, replaces rather than augments; bigger adoption decision | C (single-source 2026 comparison blogs, not independently verified) |

## Gist

**LOCAL** — no gist-creation tool is available in this session (no `gh` CLI
binary; the GitHub MCP server exposes no gist primitive, though its
issue/PR tools work and are used for real publication below). This report
file is the durable, committed equivalent — the same fallback the
2026-09-03 night used for the same reason (`docs/dream-cycle/LEDGER.md`'s
09-03 row: `LOCAL (no gh/gist tool this session — see report)`).

## Witness

- Session commit (this night's `git rev-parse HEAD` at STEP 0):
  `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256: computed over this file's full content with the 3 stamp
  values below (sha256/witness/verifier-reproduction lines) replaced by the
  placeholder text `PENDING`, i.e. over the report as it stood immediately
  before this Witness section's own stamp values were filled in.
  `REPORT_HASH = 55e96bc79f068afafa6f46c55a81e89b68778fbc976e0abb2c7acecb25afb20d`
- Witness stamp: `sha256(REPORT_HASH || SESSION_COMMIT)` =
  `WITNESS = 0ed42ee494f35df7af4883a126b327169174afc8532e8527ab57ed67381282d2`

**Verifier procedure** (reproduce independently):
1. `git -C ruClip rev-parse 6e73a8f060bcbb69965a50ffe4627e33622d4094` — confirm the commit exists and is `ruvnet/ruClip`'s HEAD as of 2026-09-09's Dream Cycle session start.
2. Take this report's full text and replace the 3 stamp-value lines in this Witness section (the `REPORT_HASH = ...` line, the `WITNESS = ...` line, and this verifier-procedure's own printed hash values below) with the literal text `PENDING` each — that reconstructs the pre-stamp version.
3. `sha256sum` that reconstructed text — confirm it equals `55e96bc79f068afafa6f46c55a81e89b68778fbc976e0abb2c7acecb25afb20d`.
4. `printf '%s%s' 55e96bc79f068afafa6f46c55a81e89b68778fbc976e0abb2c7acecb25afb20d 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` — confirm it equals `0ed42ee494f35df7af4883a126b327169174afc8532e8527ab57ed67381282d2`.
5. `git -C ruClip diff 6e73a8f060bcbb69965a50ffe4627e33622d4094 dream/2026-09-09-developer-experience` — confirm the candidate diff matches this report's Evaluation Receipt (7 files, +28/-5, one new `tsconfig.lint.json`).

## Recommendation

`evaluated: accepted` — human review recommended (PR left in draft, never
self-merged). The audit-trail fix is small and additive; the CI change is
one new required step with zero new dependencies. Suggested reviewer focus:
confirm `proposedHardStopThreshold` is the right home for this value versus
waiting for Phase 4b's not-yet-built promotion-application logic to define
its own shape.

## Next steps (concrete)

1. Evaluate adopting typescript-eslint's `no-unused-vars` (A-grade,
   maintainer-recommended) once this repo has more than a scaffold-stage
   lint need — it catches strictly more than the compiler flags (unused
   `catch` bindings, configurable `_`-prefix opt-out) at the cost of two new
   devDependencies and a flat-config file.
2. Audit the rest of `src/control-plane/governance/` for the same
   silently-dropped-parameter pattern now that one instance is confirmed
   real — `buildMutation`'s sibling `buildParentGenome` was checked tonight
   (both its parameters are used), but the broader Autogenous integration
   surface (Phase 4b, not yet built) should re-derive what other proposed
   values need a durable field before that phase starts, not after.
3. Consider Knip (C-grade, unverified tonight) as a whole-project dead-export
   scan once the compiler-flags gate has run clean in CI for a few weeks —
   it catches classes of dead code (unused exports across file boundaries,
   unused npm dependencies) that `noUnusedLocals`/`noUnusedParameters`
   structurally cannot.
