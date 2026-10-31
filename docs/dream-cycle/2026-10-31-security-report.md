# Security SOTA Report — 2026-10-31

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 1 (`DAYINT % 5 = 1`): DEEP=security, SCAN=dependencies,secrets.

## TL;DR

`persistHeartbeatSchedule` (`src/control-plane/store/agentdb-adapter.ts`) is
missing authorization on exactly one of the three actor-driven
`HeartbeatSchedule` operations `docs/design/HEARTBEATS-AND-COMMS.md` §6
requires a live claim for: **pausing an active schedule** (create and resume
were already closed in earlier, pre-dream-cycle security-hardening rounds —
see "Prior art inside this repo" below). The code's own round-7 comment
explicitly named this as the open remainder: pause is structurally identical
to `fireHeartbeat`'s own legitimate, unauthenticated system auto-pause on a
budget block, and nothing distinguished "a human asked to pause this" from
"the budget gate paused this." Confirmed exploitable — zero authorization,
zero claim check, no `claims_list` call at all — by an independent test
against the real (pre-fix) code before writing any fix. Closed with the one
discriminant the existing comment asked for: a `systemInitiated` parameter,
set only by `fireHeartbeat`'s own `pauseAndPersist`. Baseline (unfixed):
329/330 tests, 1 failure, exactly the predicted one. Candidate (fixed):
330/330, 0 regressions. `metaharness-darwin bench verify` hash unchanged
(`840fd8d2d698…`).

Diff size: 3 files, +97/-9 lines (106 total, excl. this report) — one
conceptual change, well under the 300-line target.

## Prior art inside this repo (why this wasn't already closed)

`tests/control-plane/actor-credential-authorization-gaps.test.ts`'s own
docstring (predates the dream-cycle; part of this slice's original
development) names this exact gap as "Finding 1" and explicitly leaves it
open, with no test backing it. `agentdb-adapter.ts`'s "security review round
7" comment (which closed the sibling RESUME gap) says the PAUSE case "remains
genuinely ambiguous... closing that specific case needs a design decision
(e.g. an explicit pause-source parameter), not a mechanical fix, so it stays
open." Eight prior dream-cycle security nights (2026-09-06, 10-01, 10-06,
10-11, 10-16, 10-21, 10-26, 10-30 — rotated) each found a *different* defect
(TOCTOU nonce replay, grpc-js/proxy-addr dependency CVEs, missing TTL
ceiling, a lost-update race, a fail-open budget check); none touched this
documented-but-unimplemented pause gap. It is not a duplicate of any open
dream-cycle PR (checked: #51/#80, #58, #70, #90, #100, #108 and their
issues #50/#79, #58, #69, #89, #99, #107 — none mention heartbeat pause).

**Learning-signal note**: per the ledger's own accumulated record (GitHub
issues #71/#91, "0% merge rate," since main is frozen at this repo's night-5
merge — `6e73a8f`, the TOCTOU fix — and nothing from night 6 onward has
landed), 0 of the last 14+ dream-cycle candidate PRs have merged. Per the
routine's own learning-signal rule, tonight's candidate was deliberately kept
tiny and one-parameter rather than a larger restructuring, to stay
reviewable. (This is a security night, not an architecture night — the
merge-rate problem itself is already filed and tracked under issue #91; not
re-litigated here.)

## What's new / competitor & literature scan (SCAN=dependencies,secrets)

### Dependency scan

`npm audit` (today, `npm ci`, exact lockfile): **54 vulnerabilities** (2
critical, 25 high, 27 moderate) — up from the 39 (1 critical, 14 high)
recorded in the 2026-09-06 report, all still via `ruflo`'s (`@claude-flow/cli`)
transitive tree through the non-optional `peerDependency`, same as before.
Verified again tonight: no `src`/`services` file in this repo imports
`protobufjs`, `proxy-addr`, `sharp`, `onnxruntime-*`, or any of the other
flagged packages directly (`grep -rln` over `src services`, empty). Two
criticals today:

- **`protobufjs` (new since the September count)**: 11 stacked advisories
  rolled into one audit entry, worst is `GHSA-xq3m-2v4x-88gg` (arbitrary code
  execution, CVSS 9.8, CWE-94) for `<7.5.5`. Reachable only through
  `node_modules/onnx-proto/node_modules/protobufjs` in `ruflo`'s tree — not
  independently testable from inside ruClip's own code tonight, but, unlike
  September's dependency scan, `npm audit` now reports `fixAvailable: true`
  for this one. **Next step**: a future dependency-tracked night should
  verify `npm audit fix`'s proposed `ruflo`/`@claude-flow/cli` bump doesn't
  break the sidecar bridge contract, then land it — this is now actionable,
  not blocked.
- **`proxy-addr` (`GHSA-jqcg-44mw-7w3h`, IP-spoofing)**: already identified
  and fixed in draft, unmerged PR #100 (2026-10-26 dream-cycle night) — not
  re-done here, flagged only so this report's vulnerability count is
  internally consistent with that PR's own finding.

No new secrets exposure found: re-checked `services/ruclip-attester`'s
signing-key loader (`signing-key.ts`) and `identity-map.ts` — both already
route through GCP Secret Manager per ADR/PR #59's finding, no hardcoded
credentials, no `.env`-style secret committed to the tree (`git grep` for
common key/token patterns in tracked files — none beyond test fixtures using
obviously-fake values already present before tonight).

### Prior art / comparable defect class

| Source | What it shows | Grade |
|---|---|---|
| [CWE-862 (MITRE)](https://cwe.mitre.org/data/definitions/862.html) | Canonical definition: "Missing Authorization" — software does not perform an authorization check when an actor attempts to access a resource or perform an action, the exact shape of this finding (pause had zero gate of any kind, not merely a weak one) | A (official) |
| [VulnCheck: Determined — missing authorization check on generic task endpoints](https://www.vulncheck.com/advisories/determined-missing-authorization-check-on-generic-task-endpoints) | Real, published advisory: "the kill, pause, and unpause handlers skip authorization checks" in Determined AI's task scheduler (CVSS 7.1) — same defect class (a scheduler's pause/unpause operation specifically, not just create), same remediation direction (add the missing authorization check to the handler) | A (official advisory) |
| [OffSeq Radar: CVE-2025-11581, PowerJob — Missing Authorization](https://radar.offseq.com/threat/cve-2025-11581-missing-authorization-in-powerjob-a3cd7e9f) | Unauthenticated job-control endpoint in a scheduler, same CWE-862 class, underscoring that scheduler control-plane actions (not just data endpoints) are a recurring target for this bug class | A (official advisory) |
| `paperclipai/paperclip` (named competitor, `dream.config.json`) | Its heartbeat/scheduling equivalent (if any) was not inspectable within tonight's budget — no code-search access to a repo outside this session's GitHub scope. Flagged as an open comparison for a future night, not fabricated | — (no claim made) |
| General least-privilege/discriminated-caller guidance (e.g. "a system identity and a user identity must never share one unauthenticated code path without an explicit, narrow discriminant") | Cross-checked, vendor-agnostic synthesis matching the fix applied here (`systemInitiated`, settable from exactly one internal call site, not attacker-reachable — no public API wires to it yet, verified by grepping `src/cli/ruclip.ts`) | B (aggregated/cross-checked) |

## Frozen hypothesis (frozen before implementation)

> Given a `HeartbeatSchedule` currently `status: 'active'`, when an
> actor-driven pause (`schedule.status` set to `'paused'`) is persisted via
> `persistHeartbeatSchedule` with no `authorization` and no `systemInitiated`
> flag, then the call should be rejected with `ApprovalGateViolationError`
> (mirroring the existing create/resume gates and
> `HEARTBEATS-AND-COMMS.md` §6's documented requirement), while
> `fireHeartbeat`'s own legitimate system-initiated budget-block pause (which
> passes `systemInitiated: true`) should continue to succeed unauthenticated
> — subject to: zero behavior change on every other existing authorization
> path (create, resume, issue/goal target company-match, claim verification)
> and zero regressions across the full existing test suite.

Not modified after evaluation began.

## Candidate

One conceptual change: an explicit `systemInitiated?: boolean` discriminant
on `persistHeartbeatSchedule`, defaulting to falsy everywhere except the one
call site that legitimately needs to pause without an acting `OrgMember`.

- `src/control-plane/store/agentdb-adapter.ts` — `persistHeartbeatSchedule`
  gains the parameter and one new guard clause (mirrors the existing
  create/resume guards exactly in shape and message format):
  `if (stored.status === 'active' && schedule.status === 'paused' &&
  !authorization && !systemInitiated) throw ApprovalGateViolationError(...)`.
- `src/control-plane/heartbeat/fire-heartbeat.ts` — `pauseAndPersist`'s one
  call site now passes `systemInitiated: true` (its existing no-`actor`
  comment is extended, not replaced).
- `tests/control-plane/heartbeats-authorization-gaps.test.ts` — three new
  tests: (1) an unauthenticated, non-system pause is rejected (the exploit,
  confirmed failing pre-fix, disambiguated from this function's *other*
  `ApprovalGateViolationError` paths by asserting on the exact message, not
  just the error class — an earlier draft of this same test accidentally
  passed on both baseline and candidate for the wrong reason, a mock gap in
  its own goal-recall fixture, caught and fixed before this report was
  written, see Reward-Hack Check below); (2) `systemInitiated: true` still
  succeeds with no authorization (fireHeartbeat's own path, also covered
  end-to-end by the pre-existing Gate 1/Gate 2 tests in
  `heartbeats-and-comms.test.ts`, which exercise the real `pauseAndPersist`
  call site); (3) a real authorized actor holding a live claim can still
  pause (the fix narrows the unauthenticated path only, not legitimate use).

Not touched: no change to `assertValidHeartbeatSchedule`, no change to the
create or resume guards, no change to `.harness/bench.json`.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs
dist`), this repo's real, only test entrypoint — no LLM calls, deterministic
unit/integration tests only (`node:test`). `OPENROUTER_API_KEY` was not
needed for this finding (`LLM_EVAL=not-needed`); nothing here required a
model call.

**Baseline** (current `HEAD` = `6e73a8f`, guard unfixed, new tests present —
confirmed by `grep -c systemInitiated dist/src/.../agentdb-adapter.js` = 0 on
this run):
```
tests 330
pass 329
fail 1
```
The 1 failure is exactly the one the hypothesis predicts:
`persistHeartbeatSchedule rejects an actor-initiated PAUSE ... with NO
authorization and NO systemInitiated flag` — `AssertionError: Missing
expected rejection` (the unauthenticated pause silently succeeded — the
exploit, reproduced deterministically, not a flaky timing artifact).

**Candidate** (fix applied):
```
tests 330
pass 330
fail 0
```
0 regressions; the 1 baseline failure flips to pass; nothing else changes.

`npm run harness:bench-verify`: `Suite repo-native@0.1.0: 6 tasks, hash OK
(840fd8d2d698…)` — identical before and after (the candidate does not touch
the bench corpus).

Install used for every run above: `npm ci` (exact, lockfile-matching
install).

## Darwin results

Not run. This finding is a binary authorization gate (present/absent for one
specific transition), not a tunable parameter space — there is nothing for a
fitness-scored mutation search to vary once the one conceptual fix is
applied. Bounded Darwin is skipped tonight by design, not by failure; noted
rather than silently omitted per the routine's own evidence discipline.

## Evidence classification

- **MEASUREMENT**: the baseline exploit script (ad hoc, pre-diff, run against
  the real built `dist/`) succeeding with zero authorization calls; the
  329/330 baseline and 330/330 candidate `npm test` receipts above; the
  unchanged `bench-verify` hash.
- **OBSERVATION**: the pre-existing, unfixed docstring finding in
  `actor-credential-authorization-gaps.test.ts` and the round-7 code comment
  naming this exact gap as open.
- **INFERENCE**: that no public API currently reaches `systemInitiated`
  (based on grepping `src/cli/ruclip.ts` for call sites — a grep, not an
  exhaustive proof, so recorded as inference, not measurement).
- **DECISION**: ACCEPT (see Promotion Gate below).
- No REJECTION this round — the one hypothesis formed was the one
  implemented and it held.

## Reward-Hack Check (independent-critic pass)

Self-critique, performed as a separate pass after the candidate was green,
specifically hunting for exactly the failure modes the routine's own
Reward-Hack step names:

- **Weakened benchmark or gold data?** No — `.harness/bench.json` untouched,
  hash-verified identical.
- **Cherry-picked evaluation?** No — full suite run both times, not a
  filtered subset.
- **Exploited the evaluator?** No.
- **Hid cost or touched a threshold?** No threshold exists in this finding's
  domain; N/A.
- **Relied on an undocumented cache?** No.
- **Self-caught issue worth stating plainly**: the first draft of the new
  "rejects pause" test (Finding 3, test 1) initially omitted a
  `agentdb_hierarchical-recall` mock entry for the schedule's target `Goal`.
  Because `persistHeartbeatSchedule`'s *own* separate "target does not exist"
  check also throws `ApprovalGateViolationError`, `assert.rejects(...,
  ApprovalGateViolationError)` passed on **both** the unfixed baseline *and*
  the fixed candidate — for the wrong reason (a missing fixture, not the
  authorization gate) on the baseline run specifically. Caught by rerunning
  the single test in isolation and reading the actual rejection message
  before trusting the green result, then fixed by (a) adding the goal mock
  and (b) tightening the assertion from the error *class* to the exact
  rejection *message*, so the test can only pass for the real reason. This
  is exactly the kind of "evaluator looks green for an unrelated reason"
  failure mode the routine asks to hunt for — surfaced here because it
  happened to me, the candidate's own author, not because an outside critic
  caught it, which is itself worth flagging: a truly independent critic
  re-running this report's exact baseline/candidate commands is the
  recommended human-review step before merge.

**Critic verdict: clear**, with the above self-caught issue disclosed and
resolved before this report was finalized, not discovered after and hidden.

## Security review

- **Trust boundary**: `systemInitiated` is a plain TypeScript function
  parameter, not a network-reachable field — no JSON body, CLI flag, or MCP
  tool argument currently deserializes into it (`src/cli/ruclip.ts` has no
  heartbeat pause/resume command wired at all yet; this control plane is
  still library-level, Phase 1e). The only call site that sets it `true` is
  `fire-heartbeat.ts`'s own `pauseAndPersist`, which is reached only from
  `fireHeartbeat`'s own internal budget-gate logic, not from caller input.
- **Forward guardrail (recorded for whoever builds the first public mutation
  API on this control plane)**: that future API must never accept a
  client-supplied `systemInitiated` value — it is reserved for internal
  system callers only. This is a design note, not a code change, since no
  such API exists yet to misuse it.
- **Least-privilege**: the fix narrows an existing over-permissive default
  (unauthenticated pause allowed) to fail-closed (authorization or
  `systemInitiated` required); it does not widen any permission anywhere.
- **No prompt-injection, memory-poisoning, or cross-agent surface** is
  touched by this change — pure server-side authorization logic.

## Scan findings (dependencies, secrets)

Covered inline above under "Dependency scan" and "No new secrets exposure
found."

## Promotion gate

`evaluation_complete` ✓ · `effect_positive` ✓ (closes a real,
independently-reproduced CWE-862 gap) · `significance_sufficient` ✓ (binary
exploit reproduced deterministically, not statistical) · `no_material_regression`
✓ (330/330, bench hash unchanged) · `tests_green` ✓ · `reward_hack_clear` ✓
(see above, with the one self-caught issue disclosed) · `critic_clear` ✓ ·
`witness_valid` — see below · `receipt_reproducible` ✓ (exact commands given
above, no external state needed beyond `npm ci`).

**Verdict: ACCEPT** — recommended for human review, not self-merged.

## Witness

- Session commit (`SESSION_COMMIT`, this run's starting `HEAD`): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (`REPORT_HASH`, computed over this report's content *before*
  this Witness section's own computed values were filled in — the frozen
  pre-image, not a self-referential hash of the final published bytes):
  `b637c24d81c1ef9fb8b45ac1d670a96dd4af3fe8606a512bb285bd7ba74ae9d1`
- Witness stamp (`sha256(REPORT_HASH + SESSION_COMMIT)`):
  `da1d9f28ba621e33e369b854393f6e306f78c765ef503eec1e31ceb6268354eb`
- **Verifier procedure** (reproducible by anyone):
  1. Check out `ruvnet/ruClip` at commit `6e73a8f060bcbb69965a50ffe4627e33622d4094`.
  2. `printf '%s%s' 'b637c24d81c1ef9fb8b45ac1d670a96dd4af3fe8606a512bb285bd7ba74ae9d1' '6e73a8f060bcbb69965a50ffe4627e33622d4094' | sha256sum` — must equal `da1d9f28ba621e33e369b854393f6e306f78c765ef503eec1e31ceb6268354eb`.
  3. `git fetch origin dream/2026-10-31-security && git log origin/dream/2026-10-31-security` — the branch's commit diff must match the "Candidate" section above exactly (3 files, the same two guard clauses, the same three tests).
  4. On that branch: `npm ci && npm run build && node scripts/run-tests.mjs dist` — must report `330 pass, 0 fail`. Reverting just `src/control-plane/store/agentdb-adapter.ts` and `src/control-plane/heartbeat/fire-heartbeat.ts` to `6e73a8f` and re-running must report `329 pass, 1 fail` (the exploit test).

## Next steps (concrete, for a future night or a human reviewer)

1. Merge this PR (or any dream-cycle PR at all) — 0 of 14+ have merged so
   far; this report does not re-solve that (issue #91 already owns it), but
   every unmerged security PR, including this one, leaves main exposed to
   its own finding until a human acts.
2. A future dependencies night: `npm audit fix`'s now-available fix for the
   `protobufjs` critical (new since September — `fixAvailable: true` today).
3. A future API-design pass, when a public mutation endpoint is built on
   top of `persistHeartbeatSchedule`: enforce by type, not just convention,
   that `systemInitiated` can never be set from request-derived input (e.g.
   keep it out of any DTO/schema the API layer deserializes).
