# Security SOTA Report — 2026-09-16

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 1 (`DAYINT % 5 = 1`): DEEP=security, SCAN=dependencies,secrets.

## TL;DR

`npm audit` on a fresh `npm ci` reports 39 known vulnerabilities including
**1 CRITICAL**: `protobufjs <7.5.5` (CVE-2026-41242 / GHSA-xq3m-2v4x-88gg,
CVSS 9.8, arbitrary code execution via unsafe `Function()`-constructor
code generation from attacker-controlled protobuf schemas). This exact
finding was surfaced by the 2026-09-06 security night and explicitly
deferred as "a next step, not tonight's candidate." Tonight traces it to
its root cause and closes it: there are **two separate installed copies**
of `protobufjs` in this tree — `7.6.6` (hoisted/deduped, used by ruClip's
own real, direct `@google-cloud/secret-manager` → `google-gax` dependency,
already safe) and a second, much older `6.11.6` nested six levels deep
under `ruflo`'s optional `agentic-flow` → `@xenova/transformers` →
`onnxruntime-web` → `onnx-proto` ONNX/ML toolchain — a path no file under
`src/`, `tests/`, or `services/` ever imports. A single `package.json`
`overrides` pin (`"protobufjs": "^7.6.6"`) forces the nested copy up to the
same already-safe version, clearing the critical finding (and 2 related
high findings) to zero. `@claude-flow/cli` — the version-pinned real
backend this project's prior security nights verified TOCTOU/authorization
behavior against — stays at exactly `3.38.20`, unchanged. 327/327 → 328/328
tests (one new regression-guard test added), 0 regressions, `tsc --strict`
clean, `harness:bench-verify` hash unchanged.

## What's new since the last dependency scan (2026-09-06)

09-06's report (`docs/dream-cycle/2026-09-06-security-report.md`, PR #15)
found the same 39 findings, confirmed none were reachable from ruClip's
own code, and flagged two explicit next steps in its Recommendation
section: (1) decide a policy on the 39 findings, and (2) *"re-verify the
`protobufjs` advisory range... this repo's installed, deduped version is
`7.6.6`... either the advisory's range is stale/wrong, or `7.6.6` is not
actually patched for one of its listed CVEs."*

Re-verified tonight, directly against `npm audit --json`'s own per-advisory
`via` array for the `protobufjs` finding — all 11 distinct GHSA advisories
bundled under that one package-name entry, with their exact affected
ranges:

| Severity | Range | Advisory |
|---|---|---|
| critical | `<7.5.5` | GHSA-xq3m-2v4x-88gg (CVE-2026-41242) |
| high | `<=7.5.5` | GHSA-66ff-xgx4-vchm |
| moderate | `<=7.5.5` | GHSA-2pr8-phx7-x9h3 |
| moderate | `<=7.5.5` | GHSA-fx83-v9x8-x52w |
| high | `<=7.5.5` | GHSA-75px-5xx7-5xc7 |
| high | `<=7.5.5` | GHSA-jvwf-75h9-cwgg |
| high | `<=7.5.5` | GHSA-685m-2w69-288q |
| moderate | `<=7.5.5` | GHSA-q6x5-8v7m-xcrf |
| moderate | `<=7.5.7` | GHSA-jggg-4jg4-v7c6 |
| high | `<=7.6.0` | GHSA-wcpc-wj8m-hjx6 |
| moderate | `<=7.6.2` | GHSA-f38q-mgvj-vph7 |

The highest of the 11 ranges is `<=7.6.2`. The installed hoisted copy
(`7.6.6`) is above every one of them — **the advisory range was not stale;
`7.6.6` genuinely is patched for all 11**. 09-06's uncertainty came from
only having found the one hoisted copy and not yet knowing a second,
older, genuinely-vulnerable `6.11.6` copy existed nested elsewhere in the
tree — `npm audit` reports one finding per package *name*, aggregating
across every installed instance, which reads as "the hoisted version looks
safe but is still flagged" unless you go looking for a second instance.
Confirmed directly (`npm explain protobufjs`, `npm ls protobufjs`), not
assumed. This closes 09-06's item 3 with hard evidence and directly
motivates tonight's fix for item 1's critical component.

### Competitor / comparative analysis (evidence-graded)

| Approach | Mechanism | Grade | Note |
|---|---|---|---|
| **npm `overrides`** (this candidate) | Force a version resolution repo-wide via `package.json`, regardless of what any nested `package.json` declares; npm ≥8.3 native | A — used directly this session, verified by rerunning `npm audit`/the full suite before and after | Zero new dependency, zero lockfile-format change; ruClip already runs plain `npm` |
| **pnpm `overrides`** | Same concept, pnpm-native; 2026 community consensus (independent blog posts/PRs found via search) treats it as the standard fix for Dependabot-flagged transitive CVEs | B — cross-checked across several independent 2026 sources, not exercised in this repo | Would require migrating ruClip off `npm` — outside tonight's scope and unrelated to the actual finding; npm's `overrides` is functionally equivalent for this exact use case |
| **`npm audit fix` (non-forced)** | Re-resolves within existing declared semver ranges | A — actually run against this repo as part of tonight's evaluation | Reduced 39→36 findings but **silently bumped `@claude-flow/cli` from `3.38.20` to `3.42.2`**, tripping this repo's own canary test (`actor-credential-nonce-durable-backend.test.ts`) built specifically to fail loudly on that exact drift — REJECTED as tonight's mechanism (see Evaluation); reverted before building the accepted candidate |
| **`npm audit fix --force`** | Allows semver-major bumps of the vulnerable packages' own direct dependents (`onnx-proto`, `toml`, `sharp`) | Not run — same or worse version-drift risk, on packages this repo has zero test coverage for | Rejected without running; the non-forced run already demonstrated the exact risk class this repo has a standing invariant against |
| `paperclipai/paperclip` (named competitor, `dream.config.json`) | No evidence gathered this session of a comparable pinned-transitive-dependency practice | C — not independently investigated tonight (no live checkout in this environment) | Not a substitutive comparison — paperclip solves a different layer (product stack) than ruClip's build-time evaluation harness |

## Frozen hypothesis (frozen before implementation)

> Given ruClip's full build+test pipeline (`npm run build` +
> `scripts/run-tests.mjs`) as the workload, when an `overrides` pin
> (`"protobufjs": "^7.6.6"`) is added to `package.json` — forcing the one
> remaining unpatched, deeply-nested `protobufjs@6.11.6` copy (reachable
> only through `ruflo`'s optional ONNX toolchain, never imported by
> ruClip's own `src`/`tests`/`services`) up to the same patched `7.6.6`
> line already used by ruClip's real, direct `@google-cloud/secret-manager`
> dependency — then `npm audit`'s CRITICAL-severity finding count should
> drop from 1 to 0 relative to baseline, subject to: `@claude-flow/cli`
> stays pinned at exactly `3.38.20` (enforced by the existing canary test),
> `tsc --strict` stays clean, the full test suite remains green with zero
> regressions, and `harness:bench-verify`'s corpus hash is unchanged.

Not modified after evaluation began.

## Candidate

One conceptual change (force every nested `protobufjs` resolution to the
already-safe `7.6.6` line via `overrides`), plus one new regression-guard
test so a future dependency bump can't silently drop the pin without a red
test:

- `package.json` — `+3/-0` lines (the `overrides` block)
- `package-lock.json` — auto-regenerated by `npm install` (52 lines
  changed, entirely mechanical: the single re-pointed `protobufjs`
  resolution and its transitive integrity/resolved-url entries)
- `tests/supply-chain/protobufjs-override-pin.test.ts` — new, 123 lines. A
  dependency-free filesystem walk (no `npm ls` subprocess) that finds every
  installed `protobufjs/package.json` at any nesting depth and asserts
  each is `>=7.5.5` (the patched line across all 11 bundled advisories) —
  same "fail loudly on drift, never silently invalidate prior evidence"
  discipline as `actor-credential-nonce-durable-backend.test.ts`'s
  `@claude-flow/cli` pin.

Diff size: 3 files, well within the <300-line target; one conceptual
change (no source code under `src/` touched at all).

An intermediate attempt, `npm audit fix` (non-forced), was built, run, and
REJECTED before the accepted candidate: it reduced findings 39→36 too, but
silently drifted `@claude-flow/cli` to `3.42.2`, failing this repo's own
version-pin canary test — a real, demonstrated regression this project's
existing suite is specifically built to catch. Reverted
(`package.json`/`package-lock.json` restored from the pre-fix state) before
the `overrides`-only candidate was built.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs
dist`), plus `npm audit` and `npm run harness:bench-verify`, run on the
identical corpus — parent, then the rejected intermediate, then the
accepted candidate.

| | Baseline (parent, `6e73a8f060bcbb69965a50ffe4627e33622d4094`) | Rejected: `npm audit fix` (non-forced) | Accepted candidate: `overrides` pin |
|---|---|---|---|
| `npm audit` | 39 (1 critical, 14 high, 24 moderate) | 36 (0 critical, 12 high, 24 moderate) | 36 (**0 critical**, 12 high, 24 moderate) |
| Tests | 327/327 pass | **326/327 — 1 fail** (`@claude-flow/cli` version-pin canary: expected `3.38.20`, got `3.42.2`) | **328/328 pass**, 0 regressions (327 original + 1 new regression guard) |
| `tsc --strict` | clean | clean | clean |
| `@claude-flow/cli` resolved version | `3.38.20` | **`3.42.2` (drifted)** | `3.38.20` (unchanged) |
| `harness:bench-verify` hash | `840fd8d2d698…` | not run (rejected before this step) | `840fd8d2d698…` (unchanged) |

Regression-guard test proof (this repo's own "baseline fails, candidate
passes" discipline, applied to the new test itself): with the `overrides`
entry temporarily removed and `npm install` re-run, the new
`protobufjs-override-pin.test.ts` **fails** with the exact offending path
and version (`node_modules/onnx-proto/node_modules/protobufjs/package.json
resolves protobufjs@6.11.6, below the patched 7.5.5 line`); with the
`overrides` entry restored, it passes. The test genuinely detects the
regression it exists to guard against, not a vacuous always-pass check.

Install used for every run above: `npm ci` (baseline) / `npm install`
(after each `package.json` edit — required since `npm ci` requires the
lockfile to already match `package.json` exactly, which is the artifact
being regenerated).

## Darwin

Skipped, deliberately. There is no continuous parameter to tune here — the
choice is a specific, unambiguous version floor (`^7.6.6`, already the
version safely in use elsewhere in this exact tree) forced onto one nested
resolution. Bounded Darwin's generation/mutation search has nothing to
explore that reading the 11 advisories' exact ranges didn't already settle
(recorded per Step 26's self-review requirement).

## Evidence

- OBSERVATION: `npm audit` on a fresh `npm ci` shows 39 findings including
  1 critical (`protobufjs`); `npm explain protobufjs` shows two separate
  installed copies at different resolved versions.
- MEASUREMENT: baseline `npm test` — 327/327; `npm audit` — 39 (1/14/24).
- MEASUREMENT: rejected intermediate (`npm audit fix`, non-forced) —
  326/327 (1 predicted failure, the version-pin canary), `@claude-flow/cli`
  drifted to `3.42.2`.
- MEASUREMENT: accepted candidate (`overrides` pin) — 328/328, 0
  regressions; `npm audit` — 36 (0/12/24); `@claude-flow/cli` unchanged at
  `3.38.20`; `harness:bench-verify` hash unchanged.
- MEASUREMENT: regression-guard test, run against both states (override
  present / override removed) — fails precisely when the vulnerable
  resolution is present, passes when it isn't.
- INFERENCE: all 11 advisories bundled under the `protobufjs` finding have
  ranges at or below `<=7.6.2`; `7.6.6` is therefore patched against all of
  them, resolving 09-06's open "is the advisory range stale" question.
- DECISION: use an `overrides` pin (not `npm audit fix`/`--force`) as the
  mechanism, specifically because it is the only one of the options
  evaluated tonight that closes the critical finding without touching
  `@claude-flow/cli`'s resolved version.
- REJECTION: `npm audit fix` (non-forced) — built, evaluated, and reverted
  after it failed the version-pin canary test (see Evaluation).

## Reward-hack / adversarial critique

Independent critic (separate agent, no access to this session's framing —
instructed to reproduce every number itself from a clean `npm ci`, not
trust this report) reviewed the final candidate. Verdict: **CLEAR**.
Findings:

- Reproduced baseline (39/1/14/24) and candidate (36/0/12/24) independently
  from a clean install; confirmed `@claude-flow/cli` unchanged at `3.38.20`
  both before and after; confirmed build clean and full suite 327/327 (its
  run predated the final regression-guard test being counted, then
  independently re-confirmed 328 including the new test).
- `git diff` against tracked files shows only `package.json` (+3 lines) and
  the mechanically-regenerated `package-lock.json` — no existing test,
  threshold, or gold data touched.
- Flagged one accurate scope note: the new
  `tests/supply-chain/protobufjs-override-pin.test.ts` file wasn't
  explicitly named in this report's TL;DR framing at the time of its
  review — addressed by naming it explicitly in the Candidate section
  above; it is a legitimate, passing regression guard, not a hidden
  change.
- Confirmed via `grep -rniE
  "onnxruntime|protobufjs|@xenova|transformers|huggingface|onnx-proto"`
  across `src/`, `tests/`, `services/`: zero matches — a v6→v7 protobufjs
  API surface change is irrelevant to ruClip's own code.
- Confirmed an `overrides` pin in the consumer's `package.json` is the
  standard, appropriate npm mechanism for a transitive dependency ruClip
  does not control upstream — forces (does not merely hide) the vulnerable
  resolution to the patched version.

No unresolved reward-hack signal.

## Security review (Step 15)

- **Prompt injection**: n/a — no LLM calls, no external untrusted text
  processed by this candidate.
- **Tool/MCP authority**: none — this is a dependency-resolution change
  only; no MCP tool call shape, scope, or permission is touched.
- **Credential exposure**: unrelated; `credential-issuer.ts` and
  `services/ruclip-attester/src/signing-key.ts` (the actual key-handling
  paths) were not touched.
- **Filesystem/network scope**: none widened.
- **Supply-chain exposure**: this candidate directly reduces supply-chain
  exposure (closes a CVSS-9.8 RCE-class finding reachable through an
  optional transitive dependency any `npm install` of this repo pulls in).
  Residual: the 36 remaining findings (12 high, 24 moderate — see Scan
  findings) are the same unreachable `ruflo`/`agentic-flow` ONNX toolchain,
  not addressed tonight; none of the 36 has the RCE-class severity or a
  patched version available in-range yet for most of them.
- **Unsafe autonomous mutation**: none — no runtime/production behavior
  changed; this only affects `npm install`-time dependency resolution.
- **Least privilege**: no MCP tool permissions changed.

## Scan findings

**dependencies**: post-candidate `npm audit` — 36 findings (0 critical, 12
high, 24 moderate), down from 39 (1 critical, 14 high, 24 moderate). All 36
remaining are in the same unreachable `ruflo`/`@claude-flow/cli` →
`agentic-flow` (optional) → `@xenova/transformers`/`agentdb` ONNX/telemetry
toolchain (`@opentelemetry/*`, `onnxruntime-node`, `sharp`, `toml`,
`adm-zip`, `@huggingface/transformers`) — confirmed via `npm ls <pkg>`
path-tracing and a repo-wide grep, same reachability conclusion 09-06
established, re-confirmed tonight. None has an in-range vendor fix
available without either a major bump of an unused-by-ruClip package
(risking the same kind of drift the rejected `npm audit fix` attempt
demonstrated, but for packages this repo has zero test coverage over) or
an upstream fix in `ruflo`/`agentic-flow` itself. Not tonight's candidate;
see Recommendation.

**secrets**: no hardcoded secrets, API keys, or private-key material found
in tracked source — `credential-issuer.ts`, `signing-key.ts`, and the GCP
Secret Manager / `gcloud` shell-out paths all read secrets transiently at
call time, never log or persist them (confirmed by reading, not assumed;
unchanged from 09-06's clean finding). `.gitignore` and `.harness/` checked
for accidental secret tracking — clean. No `overrides`/lockfile change
touches any secret-handling path. No change needed; recorded as a clean
scan, not a null result.

## Witness

```
REPORT_HASH    = 2e061cefd9f0bf06096dff22c566b4b033983eef2365bc3dd71edc7399ad2490
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 1579336b4d6dbccdeb4a85ec6cc07cc2a0b78cfcc1fee3439c03ef47e4d99b0e
```

`REPORT_HASH` is the sha256 of this file's content up to (and including)
the line directly above this Witness section — i.e. everything before
`## Witness` itself. `WITNESS = sha256(REPORT_HASH || SESSION_COMMIT)`,
computed as `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text
   (`docs/dream-cycle/2026-09-16-security-report.md`) up to the `##
   Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal
   `WITNESS` above.
5. Independently re-run `npm ci && npm audit && npm test` against the PR
   branch's HEAD and confirm: `npm audit` shows 0 critical / 36 total, and
   the full suite reports 328/328 (0 fail) — the receipt this report
   claims.

## Recommendation

1. **Merge this fix** (draft PR) — closes a genuine, reproducible
   CVSS-9.8 RCE-class finding via the smallest possible diff (one
   `package.json` `overrides` entry + one new regression test, zero
   `src/` changes). 328/328 green, `@claude-flow/cli` version-pin
   preserved, `harness:bench-verify` hash unchanged.
2. **Decide a policy on the remaining 36 transitive `npm audit`
   findings** (unchanged recommendation from 09-06, still not
   independently actionable from inside this repo — most have no
   in-range vendor fix yet) — pin/vendor a patched fork, isolate the
   `ruflo` sidecar more strictly, or accept the risk explicitly. Needs a
   human decision, not another dream-cycle candidate.
3. Consider the same "does ruClip's own code path actually touch this"
   reachability check, applied one package at a time, as a template for
   closing further findings in this tree in future security nights —
   tonight's `protobufjs` fix is a repeatable pattern, not a one-off.
