# Security SOTA Report — 2026-11-11

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 1 (`DAYINT % 5 = 1`): DEEP=security, SCAN=dependencies,secrets.

## TL;DR

Tonight's deep dive asked: can the `npm audit` footprint be shrunk by
correcting `package.json`'s `peerDependenciesMeta` to match what ruClip's
own source actually imports (confirmed by grep: `metaharness` and
`ruvector` are declared as required peers but never imported anywhere in
`src/`, `services/`, or `tests/`; `ruflo` is also never imported directly,
but its transitive `@claude-flow/cli` *is* a genuine, intentional
dependency of `tests/control-plane/actor-credential-nonce-durable-backend.test.ts`,
PR #15's real-backend nonce-replay evidence)? **REJECT.** Marking the two
genuinely-unused peers (`metaharness`, `ruvector`) optional changes nothing
measurable — `ruflo` → `@claude-flow/cli` already drags in the same heavy
transitive tree (`agentic-flow` → `@xenova/transformers` → `onnxruntime-*`/
`sharp`, plus `@metaharness/darwin` and `@ruvector/rabitq-wasm` directly, as
`@claude-flow/cli`'s *own* dependencies) regardless of those two flags. The
one change that *would* shrink the footprint — also marking `ruflo`
optional — breaks the build (`TS2307: Cannot find module
'@claude-flow/cli/memory'`) in PR #15's real-backend test, which is a
deliberate, load-bearing dependency, not dead weight.

Before committing to this candidate, this session's mandatory ledger/PR-fate
check (STEP 1) surfaced that it was about to **duplicate two already-open,
already-clean PRs**: #100 (2026-10-26, fixed the exact `proxy-addr`
CRITICAL this session had independently re-found) and #113 (2026-11-01, a
version-aware reachability classifier covering the exact same "which of
these 53 findings are actually reachable from ruClip's own code" question).
That near-miss — caught only because this session happened to read
`list_pull_requests` before writing new code — is itself the most
actionable finding of the night: see **Governance note** below.

## What's new / prior art

A fresh `npm ci` on `main`@`6e73a8f` reports **53 `npm audit` findings: 1
critical, 25 high, 27 moderate** (metadata: 83 prod + 6 dev + 674 peer + 502
optional = 762 total resolved packages). This is the same 53-finding count
PR #113 (2026-11-01) measured ten nights ago (that report split it 2
critical/26 moderate instead of 1/27 — a one-finding critical↔moderate
reclassification on the advisory database over the intervening ten days,
not a regression in this repo).

Competitor check: `paperclipai/paperclip` — no public evidence of a
peer-dependency-optionality or install-footprint policy for agent-harness
sidecars; out of scope to clone and audit tonight (B-grade: not
independently verified, informs only).

## Candidates considered (scored fit/novelty/testability/measurability/prod-value/reviewability, 1–5)

1. **Peer-dependency optionality audit** (this one) — 4/4/5/5/3/5. Selected:
   highest testability+measurability, and directly continues the carried-over
   flag in PR #15's own ledger row ("39 npm audit findings... flagged as a
   next step, not tonight's candidate").
2. Re-verify the `protobufjs` advisory range (carried over from the
   2026-09-06 report's Recommendation #3) — 3/2/4/4/2/4. Already answered by
   PR #113's exact-install-path classifier (two installed copies at
   different versions; the flagged one is the unpatched copy under
   `onnx-proto`). Not re-run tonight — would duplicate #113.
3. Decide a policy on the 39(→53)-finding transitive tree (Recommendation #2
   from 2026-09-06) — 3/1/2/2/4/2. A human policy decision, not a
   dream-cycle candidate; unchanged since first flagged.
4. Secrets scan only, no dependency work — 2/1/5/3/2/5. Run anyway as this
   slot's paired SCAN (see below); not deep-dive-worthy alone.
5. Re-litigate PR #51/#80's grpc-js exploitability dispute — 2/1/3/3/2/3.
   Already settled by #113's reachability classifier (grpc-js is the one
   production-reachable finding); re-opening it without new evidence would
   violate "do not rediscover a failed direction unless new evidence
   justifies reopening it."

## Hypothesis (frozen before evaluation)

> Given ruClip's real `npm ci` install on `main`@`6e73a8f`, when
> `package.json`'s `peerDependenciesMeta` for `metaharness` and `ruvector`
> is changed from `optional:false` to `optional:true` (matching their
> actual non-use in `src/`/`services/`/`tests/`, confirmed by grep before
> freezing this hypothesis), then a fresh install's `npm audit` finding
> count and installed-package count should drop measurably, subject to:
> `ruflo` stays required (PR #15's real-backend test needs
> `@claude-flow/cli`), `tsc -p tsconfig.json` stays clean, and `npm test`
> stays green with zero regressions.

Not modified after evaluation began. (A broader variant — also flipping
`ruflo` — was evaluated as a *contrast* condition, not a silent redefinition
of this hypothesis; see Candidate C below.)

## Candidate

**No production diff lands tonight** (see Recommendation). Three configurations
of `package.json`'s `peerDependenciesMeta` were built and evaluated in
isolated scratch checkouts (never touching this session's own working tree
until confirmed inert):

- **Candidate A — lockfile refresh only**, zero `package.json` change: delete
  `package-lock.json`, `npm install`.
- **Candidate B — the frozen hypothesis**: `metaharness.optional = true`,
  `ruvector.optional = true`; `ruflo`/`radio-moe` unchanged; fresh install
  (no prior lockfile).
- **Candidate C — contrast/upper-bound**: B plus `ruflo.optional = true` too;
  fresh install.

## Evaluation Receipt

Evaluator: real `npm ci`/`npm install` + `npm audit --json` + real
`npm run build` + real `npm test` (`tsc -p tsconfig.json && node
scripts/run-tests.mjs dist`), each independently re-run in its own scratch
checkout (not inferred from logs).

| | Baseline (`main`, committed lockfile, `npm ci`) | A: lockfile refresh | B: + metaharness/ruvector optional | C: + ruflo optional too |
|---|---|---|---|---|
| Installed packages | 665 | 609 | 611 | 82 |
| `npm audit` | 53 (1 crit/25 high/27 mod) | 6 (0/3/3) | 6 (0/3/3) | **0** |
| `node_modules` size | — | 1.5G | 1.5G | 63M |
| `npm run build` | clean (already verified at session start) | clean | clean | **fails**: `TS2307: Cannot find module '@claude-flow/cli/memory'` in `tests/control-plane/actor-credential-nonce-durable-backend.test.ts` and `tests/support/nonce-store-race-worker.ts` |
| `npm test` | 326/327 pass, 1 fail* | 326/327 pass, 1 fail* | not run (B has no footprint delta over baseline-refresh; A's result stands in) | not run (build fails first) |

\* The one failure in both A and B is
`actor-credential-nonce-durable-backend.test.ts`'s own deliberate version-drift
tripwire (`EXPECTED_CLAUDE_FLOW_CLI_VERSION = '3.38.20'`), which asserts the
*installed* `@claude-flow/cli` equals the exact version PR #15's real-backend
evidence was verified against. A fresh, unpinned resolve picks up
`@claude-flow/cli@3.75.3` (current latest) instead. **This is the tripwire
doing its documented job** ("a version drift must fail loudly here, not
silently invalidate the evidence below") — not a bug introduced tonight, and
not something to patch around by bumping the pinned constant without the
native-bridge manual re-verification the test's own docstring requires
(network-dependent embedding-model download; out of scope for an
unsupervised night).

## Baseline

`main`@`6e73a8f060bcbb69965a50ffe4627e33622d4094`, unchanged all night,
verified separately via `npm ci && npm run build` at session start: build
clean (0 errors).

## Darwin Lineage

Not run — three discrete, mutually-exclusive configuration points, not a
continuous/tunable parameter space.

## Evidence

- OBSERVATION: fresh `npm ci` → 53 findings (1 critical/25 high/27 moderate).
- OBSERVATION (grep, before freezing the hypothesis): `metaharness` and
  `ruvector` have zero import sites in `src/`, `services/`, `tests/`;
  `ruflo`/`@claude-flow/cli` has one, deliberate, documented import site
  (PR #15's real-backend test).
- OBSERVATION: `@claude-flow/cli`'s own `package.json` lists
  `@metaharness/darwin` and `@ruvector/rabitq-wasm` as its *own* direct
  dependencies — the mechanism by which B fails to improve on A.
- MEASUREMENT: A vs. B — 609 vs. 611 packages, 6 vs. 6 audit findings
  (statistically identical; the 2-package delta is `agentbbs`/optional-chain
  noise, not metaharness/ruvector's removal, since neither config installs
  them).
- MEASUREMENT: C — 82 packages, 0 findings, but `npm run build` fails
  (TS2307) on the one source file that genuinely needs `@claude-flow/cli`.
- INFERENCE: the frozen hypothesis (B) is **falsified** — unused-peer
  optionality has no measurable effect here because the *used* peer
  (`ruflo`) independently carries the same heavy transitive packages as its
  own direct dependencies, not merely as siblings pulled in by the unused
  peers.
- INFERENCE: A (plain lockfile refresh) already captures nearly all of the
  achievable reduction (53→6) without touching `package.json` at all — and
  independently reconfirms PR #100's specific `proxy-addr` CRITICAL fix
  (version floor `2.0.8`, already inside `express`'s own declared
  `^2.0.7` range) is real and still open.
- DECISION: REJECT the frozen hypothesis (B: no measurable benefit). REJECT
  landing A or C tonight as this session's own candidate (A exists already,
  cleanly, as PR #100 + the broader reachability work in PR #113; C breaks
  a load-bearing security test and would require a human-supervised
  version-pin bump + native-bridge re-verification this session cannot
  safely do unsupervised).

## Reward-Hack Check

No test was modified, skipped, or weakened to get a favorable number. The
one test failure observed (A, B) is the *correct, intended* behavior of a
tripwire PR #15 added on purpose — reported as a failure, not silently
worked around, and not "fixed" by editing `EXPECTED_CLAUDE_FLOW_CLI_VERSION`
without doing the re-verification work that constant's own docstring
requires. `.harness/bench.json` not touched. No gold data touched. No
threshold tuned. All three scratch evaluations ran in isolated temp
checkouts, never in this session's actual working tree, specifically so a
failed experiment could not accidentally leave `main`'s checkout in a
broken state.

## Security Review

Pure dependency-declaration hygiene question; no credential, MCP/tool
authority, or network-scope code was touched or proposed. No LLM/model
calls used (`LLM_EVAL=blocked` is moot tonight — this candidate needed none).
Confirmed (per Candidate C's build failure) that `@claude-flow/cli` is not
safely removable from the install graph without first replacing or
restructuring PR #15's real-backend nonce-replay test — flagging that
coupling explicitly so a future night doesn't try to "clean up" `ruflo` as
an easy win without reading this report first.

## Scan: dependencies

Covered above in full (this was the deep-dive surface, not a secondary
scan). Supplementary note for future nights: of the 53 current findings,
PR #113's committed classifier already measured exactly 1 as reachable from
ruClip's own two production dependencies (`@grpc/grpc-js@1.14.4`, high,
via `@google-cloud/secret-manager` → `google-gax`) — that remains the
single highest-priority dependency fix in this repo, unchanged since
2026-11-01.

## Scan: secrets

Repo-wide grep for common key/token patterns (`AKIA...`, PEM private-key
blocks, `xox[baprs]-...`, `ghp_...`, `AIza...`, `sk-...`) across `src/`,
`services/`, `tests/`, `docs/`, `scripts/`: the only matches are the same
pre-existing Ed25519 test-fixture private keys PR #113's 2026-11-01 scan
already found and cleared (`services/ruclip-attester/tests/signing-key.test.ts`,
`tests/support/actor-credential-fixture.ts`). No new secrets. Clean scan,
recorded as such, not a null result.

## Witness

```
REPORT_HASH    = 851861e778a3646f709fc344f7bbedf621c5b50beacd525354beb443d23beda0
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = c75a7da9f3db95bec3a89b8928f2bdcbbb754d338a3d44092e8845f45a61ab41
```

`REPORT_HASH` is the sha256 of this file's content up to (and including) the
line directly above this Witness section — i.e. everything before `## Witness`
itself. `WITNESS = sha256(REPORT_HASH || SESSION_COMMIT)`, computed as
`printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text (`docs/dream-cycle/2026-11-11-security-report.md`) up to the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. Independently reproduce Candidates A/B/C in a scratch checkout (delete
   `node_modules`+`package-lock.json`, apply the `peerDependenciesMeta`
   edit described above, `npm install`, `npm audit --json`, `npm run build`)
   and confirm the same package counts, audit counts, and the TS2307 build
   failure for C.

## Governance note (carried forward from #34/#36/#48/#50/#90/#92/#100/#113/#119/#129)

As of tonight, **≥59 `dream-cycle` branches are open against `main`@`6e73a8f`,
spanning 2026-09-07 through 2026-11-10, with a 0% merge rate** (the last
merge into `main` was PR #15, 2026-09-06). This session independently
re-confirmed that count and, more importantly, **almost became another
duplicate**: this candidate's exact area (peer-dependency/footprint
analysis of the same 53 `npm audit` findings) overlaps PR #100's `proxy-addr`
fix and PR #113's reachability classifier closely enough that landing a
third PR here without first reading their bodies would have been redundant
work. The mandatory STEP 1 ledger/PR-fate check caught this before any code
was written — but that check depending on a careful read, rather than on
any structural guarantee, is itself a risk signal: the backlog is now large
enough that duplicate-avoidance is not reliable by inspection alone.

Recommendation, in priority order:
1. **Merge PR #51** (grpc-js auth-bypass) — the one finding PR #113's own
   classifier confirms is reachable from ruClip's production dependencies.
2. **Merge PR #100** (`proxy-addr` CRITICAL, lockfile-only, 328/328 green)
   and **PR #113** (reachability classifier, 333/333 green) — both clean,
   both still `mergeable_state: clean` as of tonight, both directly relevant
   to this report.
3. **A human decision on the backlog itself** is overdue and outside this
   session's authority: either begin merging the ~15+ already-ACCEPT-rated,
   clean, small PRs in this list, or explicitly decide the dream-cycle
   experiment should stop opening new PRs until the existing ones are
   triaged (PR #129's 2026-11-09 risk-tiering of all 58 branches —
   4 docs-only / 41 mechanical / 13 needs-review — is the ready-made triage
   list for that decision).

## Recommendation

1. **No code change recommended from tonight's candidate.** The frozen
   hypothesis (peer-dependency optionality reduces install footprint) is
   REJECTed on clean measurement; the one configuration that would help
   (dropping `ruflo` too) breaks a load-bearing security test and needs
   human-supervised re-verification, not a mechanical edit.
2. See **Governance note** above — this is the real actionable output of
   tonight's run.
3. Next time this surface rotates up: do not re-run this exact
   peer-dependency experiment (now answered); instead check whether PR #51/
   #100/#113 have merged, and if not, re-assess whether the Step 1.1
   learning signal ("zero of the last 14 merged → bias to tiny candidates")
   should instead read as "stop proposing new dependency candidates until
   the existing ones clear."
