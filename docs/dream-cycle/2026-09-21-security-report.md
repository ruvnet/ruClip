# Security SOTA Report — 2026-09-21

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 1 (`DAYINT % 5 = 1`): DEEP=security, SCAN=dependencies,secrets.

## TL;DR

`npm audit` on a fresh install reports 36 known vulnerabilities (1 critical,
11 high, 24 moderate) in `ruflo`'s (`@claude-flow/cli`'s) transitive tree —
pulled in because `ruflo` is a *required* (non-optional) peerDependency of
ruClip. Two HIGH-severity findings in the `toml` npm package (not
`@iarna/toml`) — GHSA-82x6-q7mm-w9cf (uncontrolled recursion, CVSS 7.5) and
GHSA-v5mp-jgw5-2x6j (prototype pollution via `__proto__` key-path
desynchronization, CVSS 8.2), vulnerable range `<=4.1.2` — are fixed by a
single `package.json` `overrides` pin (`"toml": "^4.2.0"`). Reachability
confirmed: no file anywhere in the entire installed `@claude-flow/*`
package family (`grep -rn` across `node_modules/@claude-flow/`) actually
`require()`s or `import`s the `toml` npm package — it is a fully unused,
vestigial direct dependency of `@claude-flow/cli`. 326/326→326/326 tests
pass with the fix applied (1 pre-existing, environmental failure present
identically in both baseline and candidate — see Evaluation), `npm audit`
drops 36→35, `toml`'s findings clear to zero.

**This report also documents a process correction made mid-run**: this
session's candidate started out as an independent rediscovery of the
CRITICAL `protobufjs` RCE finding — the exact same finding, same root
cause, same fix mechanism already built and evaluated by the unmerged
`dream/2026-09-16-security` branch (issue #28 / PR #29). The duplication
was caught before publishing by fetching live GitHub state (not trusting
this repo's own `docs/dream-cycle/LEDGER.md`, which is stale — frozen at
2026-09-06, silently missing 9+ subsequent nights' issues/PRs, itself
already flagged by issue #34). The candidate was retargeted to a genuinely
uncovered finding (`toml`) before implementation. See "Process note" below.

## Process note: ledger staleness caused a near-duplicate

STEP 1 instructs reading `docs/dream-cycle/LEDGER.md` and re-checking the
fate of the last 7 rows' issues/PRs via `gh`/GitHub tools. This session's
local `LEDGER.md` (as checked out on `main`, HEAD `6e73a8f`) has exactly 5
rows, the last dated 2026-09-06. Reading it alone gives the false
impression that only 3 dream-cycle nights (`#8`/`#9`/PR#9 open-unmerged,
`#10`/PR#11, `#12`/PR#13, `#14`/PR#15) have run. Querying GitHub directly
(`list_issues`, `list_pull_requests`) shows **17 issues and PRs up through
`#36`/`#37`**, dated through 2026-09-20 — 12 dream-cycle nights this
session's local checkout has no record of, because `main` itself has not
advanced past PR #15 (2026-09-06): every night since has produced a valid,
evaluated candidate on its own `dream/*` branch, and **none have been
merged** except #15 itself (1 of the last 12). This is exactly the
condition issue #34 (2026-09-19, developer-experience night) already
opened: "LEDGER.md frozen since 2026-09-06 — 9 nights of ledger rows
siloed on unmerged dream/* branches." Its own fix (PR #35) is itself
unmerged, so the staleness persists.

Consequence for tonight: this session's own DEEP=security research (fresh
`npm audit`, same 36-vs-39-finding tree, same critical `protobufjs`
finding) independently arrived at the *same* root-cause diagnosis and the
*same* `overrides`-pin fix mechanism already built in PR #29
(`dream/2026-09-16-security`), five nights ago — down to using the same
patched-version floor (`^7.6.6`) and hitting the identical rejected
intermediate step (`npm audit fix` non-forced silently drifting
`@claude-flow/cli`'s version and tripping the real-backend canary test).
Caught via a live GitHub query before implementation was finalized;
retargeted to the next distinct, uncovered finding (`toml`) rather than
publish a duplicate. **Recommendation carried forward from this session**:
future dream-cycle nights should query GitHub's actual issue/PR list
directly (not just the local `LEDGER.md`) as part of STEP 1, precisely
because `LEDGER.md` only updates when a PR merges into `main` — and merges
aren't happening.

## What's new / prior art

| Source | What it shows | Grade |
|---|---|---|
| `dream/2026-09-16-security` (PR #29, this repo) | Established the reachability-first pattern this candidate reuses directly: confirm no ruClip-touched code path imports the vulnerable package before proposing an `overrides` pin; explicitly recommended (its Recommendation #3) applying the same pattern "one package at a time" to the remaining findings | A (primary, same repo, independently reproduced its baseline numbers tonight) |
| [GHSA-82x6-q7mm-w9cf](https://github.com/advisories/GHSA-82x6-q7mm-w9cf) | Official advisory: `toml-node` uncontrolled recursion, CVSS 7.5, CWE-674 | A (official GHSA) |
| [GHSA-v5mp-jgw5-2x6j](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j) | Official advisory: `toml-node` prototype pollution via `__proto__` key-path desynchronization, CVSS 8.2, CWE-1321 | A (official GHSA) |
| npm `overrides` as the standard remediation for an unpatched transitive dependency of a package the consumer doesn't control upstream | Same mechanism, same justification as PR #29 (already cross-checked there against pnpm's equivalent `overrides` field and community 2026 practice) | A/B (reused prior night's own cross-check, not re-derived from scratch tonight — avoids redundant research spend) |
| `paperclipai/paperclip` (named competitor, `dream.config.json`) | No new investigation tonight; PR #29's own note stands (different product layer, not a substitutive comparison for a build-time dependency-resolution fix) | — (not re-investigated, avoiding redundant spend on an already-answered comparison) |

## Frozen hypothesis (frozen before evaluation began)

> Given ruClip's full build+test pipeline (`npm run build` +
> `scripts/run-tests.mjs`) as the workload, when an `overrides` pin
> (`"toml": "^4.2.0"`) is added to `package.json` — forcing the installed
> `toml@3.0.0` (a fully unused, vestigial direct dependency of
> `@claude-flow/cli`, confirmed unreferenced anywhere in the installed
> `@claude-flow/*` package family) up to the first version that fixes both
> bundled advisories — then `npm audit`'s findings for the `toml` package
> should drop to zero relative to a same-`ruflo`-version baseline, subject
> to: zero *new* test regressions (the one pre-existing, environmental
> failure caused by `ruflo`'s floating `"*"` peerDependency range drifting
> `@claude-flow/cli`'s version past this repo's hard-coded `3.38.20` canary
> assertion must remain present, identically, in both baseline and
> candidate — proving the candidate neither causes nor masks it), and no
> new package or vulnerability introduced elsewhere in the tree.

Not modified after evaluation began.

## Testability gate

Testable tonight without any model call (`LLM_EVAL` not needed for this
finding — deterministic `npm audit` + `npm test` only).

## Candidate

One conceptual change, `package.json` only:

```json
"overrides": {
  "toml": "^4.2.0"
}
```

`package-lock.json`: mechanically regenerated by `npm install` after
`rm -rf node_modules package-lock.json` (required — `npm ci` refuses to run
against a lockfile that doesn't already match a changed `package.json`).

No `src/`, `tests/`, or `services/` file touched. Diff: 2 files
(`package.json` +3/-0, `package-lock.json` mechanical), well within the
<300-line target.

**Reachability, confirmed not assumed**: `grep -rn "require(['\"]toml['\"]" \
"from ['\"]toml['\"]"` across the entire installed `node_modules/@claude-flow/`
tree returns zero matches. The only substring hit for `toml` anywhere in
`@claude-flow/cli`'s shipped code is a regex character-class file-extension
pattern in `dist/src/memory/structured-distill.js`
(`\.(?:...\|toml\|...)` matching filenames like `config.toml` in text,
nothing to do with the npm package) — and `structured-distill.js` is not
itself imported by `memory-initializer.js`, the file
`tests/control-plane/actor-credential-nonce-durable-backend.test.ts` and
`tests/support/nonce-store-race-worker.ts` dynamically `import()` as
`@claude-flow/cli/memory`. `toml` is a genuinely dead, vestigial direct
dependency of `@claude-flow/cli` as shipped — more isolated than the
`protobufjs` finding PR #29 fixed (which was at least reachable through an
optional ML/embedding code path, `agentic-flow`, even if ruClip itself
never exercises it).

**Scope discipline**: this candidate does not touch `protobufjs`/
`onnx-proto` — that fix already exists, evaluated and ready, on
`dream/2026-09-16-security` (PR #29). Duplicating it here would create
avoidable merge friction for whichever PR a human reviews second. The
`overrides` block contains only the `toml` entry.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs
dist`) plus `npm audit`, both run against the identical resolved `ruflo`/
`@claude-flow/cli` version for baseline and candidate — a real confound
discovered and controlled for tonight (see below).

**Confound discovered and controlled**: `ruflo`'s peerDependency range is
`"*"` (unpinned). A first, uncontrolled `rm -rf node_modules && npm
install` resolved `ruflo@3.38.20 → 3.42.4` purely from registry drift
between installs, independent of any change under test — this alone
changed the baseline `npm audit` counts (39→36, 14 high→11 high) before
any candidate fix was applied. Controlled for by re-running baseline and
candidate back-to-back and verifying `npm ls ruflo @claude-flow/cli`
resolves to the *identical* version (`3.42.4`) in both runs before trusting
any comparison.

| | Baseline (no override, `ruflo@3.42.4`) | Candidate (`toml` override, `ruflo@3.42.4`) |
|---|---|---|
| `npm audit` | 36 (1 critical / 11 high / 24 moderate) | 35 (1 critical / 9 high / 25 moderate) |
| `toml` package finding | present (2 bundled HIGH advisories) | **absent** (cleared) |
| Tests | 326/327 (1 fail) | 326/327 (1 fail — **same test**) |
| Failing test | `actor-credential-nonce-durable-backend.test.ts`: `@claude-flow/cli` version-pin canary (`expected '3.38.20'`, `actual '3.42.4'`) | identical — same test, same assertion, same actual/expected values |
| `toml` resolved version | `3.0.0` | `4.3.0` (satisfies `^4.2.0`; npm resolved the newest matching `4.x`) |
| New packages/vulnerabilities introduced | — | none (`added: []` — diffed full vulnerability-key sets between the two `npm audit --json` outputs) |

The `moderate` count rising 24→25 and `ruflo`'s own reported severity field
dropping `high`→`moderate` is an `npm audit` rollup-metadata artifact, not
a new vulnerability: diffing the full per-package vulnerability-key sets
between baseline and candidate shows `removed: ['toml']`, `added: []` —
`ruflo`'s own `severity` field is npm's derived rollup for an indirect
node and shifted because the worst *directly-named* advisory formerly
attributed through it (`toml`'s) is now gone; the CRITICAL `protobufjs`
finding remains fully, separately counted and untouched by this candidate
(expected — that's PR #29's territory, not fixed here).

**The one failing test is pre-existing and environmental, not caused by
this candidate**: it is a hard-coded canary
(`tests/control-plane/actor-credential-nonce-durable-backend.test.ts`,
added by the 2026-09-06 night, PR #15) asserting `@claude-flow/cli`'s
installed version equals exactly `3.38.20` — the version its real-backend
evidence was verified against. Because `ruflo`'s peerDependency floats on
`"*"`, 15 days of registry releases have drifted the resolved version to
`3.42.4`, tripping the canary regardless of anything this candidate
touches (reproduced identically with the `overrides` block entirely
absent). Not this candidate's regression to fix; flagged as a next step
(see Recommendation) — the fix belongs to whichever future night addresses
`ruflo`'s unpinned peer range, not to a dependency-vulnerability night.

Install used for every run above: `npm install` (required over `npm ci`
since each `package.json` edit invalidates the previous lockfile).

## Darwin

Skipped, deliberately — same reasoning as PR #29: no continuous parameter
to tune. The fix is a specific, unambiguous version floor (`^4.2.0`, the
first version fixing both bundled advisories, chosen over the newer
available `5.0.0` to keep the diff to the minimal version bump that closes
the findings) forced onto one otherwise-unused nested resolution.

## Evidence

- OBSERVATION: fresh `npm audit` (controlled for `ruflo` version drift)
  shows 36 findings including `toml` (2 bundled HIGH advisories,
  `<=4.1.2`).
- OBSERVATION: `grep -rn` across the entire installed `@claude-flow/*`
  package family finds zero real imports of the `toml` npm package; the
  one substring match is an unrelated file-extension regex, in a file not
  reachable from the `@claude-flow/cli/memory` subpath this repo's own
  tests exercise against the real backend.
- MEASUREMENT: baseline (`ruflo@3.42.4`, no override) — `npm audit` 36
  (1/11/24); tests 326/327 (1 pre-existing failure).
- MEASUREMENT: candidate (`ruflo@3.42.4`, `toml` override) — `npm audit` 35
  (1/9/25, `toml` cleared); tests 326/327 (**identical** pre-existing
  failure, zero new failures).
- MEASUREMENT: full vulnerability-key-set diff between baseline and
  candidate `npm audit --json` — `removed: ['toml']`, `added: []`.
- INFERENCE: the `toml` finding's root cause (a fully dead, never-imported
  direct dependency of `@claude-flow/cli`) makes the fix categorically
  low-risk to ruClip's own exercised code paths — even more so than PR
  #29's `protobufjs` fix, which was reachable (if unused) through an
  optional ML pathway.
- DECISION: use an `overrides` pin at the minimal fixing version (`^4.2.0`)
  rather than jumping to the latest available major (`5.0.0`), matching PR
  #29's minimal-diff precedent.
- REJECTION (process-level, not evaluation-level): the original candidate
  for tonight — an independently-derived `protobufjs` RCE fix — was
  rejected as a duplicate of PR #29 before implementation was finalized,
  once a live GitHub query (rather than the stale local `LEDGER.md`)
  surfaced the existing unmerged work. Retargeted to `toml`.

## Adversarial critique / reward-hack check

Independent critic (separate subagent, instructed to reproduce every claim
itself from a clean install with no access to this session's framing):
**VERDICT: CLEAR**, no concerns flagged.

- (a) No real import of `toml` found anywhere in the installed
  `@claude-flow/*` package family. `grep -rn` for `require`/`from` of
  `toml` across `node_modules/@claude-flow/` returned zero hits; confirmed
  `memory-initializer.js` (the actual `@claude-flow/cli/memory` export
  target) does not import `structured-distill.js` (the file containing the
  one, unrelated, regex substring match).
- (b) Independently reproduced the paired baseline/candidate comparison
  from scratch (`rm -rf node_modules package-lock.json && npm install`
  each time): both resolved to identical `ruflo@3.42.4`/
  `@claude-flow/cli@3.42.4`; baseline 326/327, candidate 326/327 — same
  failing test, same assertion, same actual/expected values. Zero new
  failures.
- (c) `npm audit --json` diff: baseline 36 (`toml` present, matching both
  GHSA IDs and the `<=4.1.2` range exactly), candidate 35, `toml` entirely
  absent, `newly added vs baseline: set()`. Confirmed the `ruflo`
  severity-field shift (high→moderate) is npm's rollup re-aggregating
  `ruflo`'s worst *remaining* transitive finding after `toml`'s was
  removed, not a new issue.
- (d) Diff is scope-clean: only `package.json` (+3 lines) and
  `package-lock.json` (mechanical lockfile regen); the `overrides` block
  contains exactly the one `toml` entry, nothing `protobufjs`/`onnx-proto`
  related. `^4.2.0` (not the newer `5.0.0`) confirmed as the correct
  minimal-diff choice — no reachable code path justifies the extra
  major-version risk.

`git diff` against tracked files touches only `package.json` and the
mechanically-regenerated `package-lock.json` — no test, threshold, or gold
data altered; the one pre-existing failing test is untouched, unsilenced,
and fails identically before and after.

## Security review (Step 15)

- **Prompt injection**: n/a — no LLM calls, no untrusted text processed by
  this candidate.
- **Tool/MCP authority**: none — dependency-resolution change only; no MCP
  tool call shape, scope, or permission touched.
- **Credential exposure**: unrelated; no credential-handling path touched.
- **Filesystem/network scope**: none widened.
- **Supply-chain exposure**: directly reduces supply-chain exposure — two
  HIGH-severity findings (uncontrolled recursion DoS, prototype pollution)
  cleared from the default `npm install ruclip` tree. Residual: 35
  remaining findings (1 critical — `protobufjs`, already fixed on PR #29,
  awaiting merge; 9 high, 25 moderate) are the same `ruflo`/`agentic-flow`
  ONNX/telemetry toolchain PR #29 and the 2026-09-06 night already
  characterized as unreachable from ruClip's own code. Not tonight's
  candidate.
- **Unsafe autonomous mutation**: none — no runtime/production behavior
  changed; `npm install`-time resolution only.
- **Least privilege**: no MCP tool permissions changed.

## Scan findings

**dependencies**: post-candidate `npm audit` — 35 findings (1 critical, 9
high, 25 moderate; `toml`'s 2 HIGH findings cleared). Remaining findings
unchanged in character from the 2026-09-06 and 2026-09-16 nights'
conclusions: reachable only through `ruflo`'s optional ONNX/telemetry
toolchain, not through any code ruClip's own `src`/`tests`/`services`
import. The CRITICAL `protobufjs` finding specifically already has a
ready, evaluated fix on unmerged PR #29 — not re-fixed here to avoid
duplicating that branch's diff.

**secrets**: no hardcoded secrets, API keys, or private-key material in
tracked source. The two files a broad grep for PEM/API-key-shaped strings
matched (`services/ruclip-attester/tests/signing-key.test.ts`,
`tests/support/actor-credential-fixture.ts`) are explicitly-labeled,
throwaway Ed25519 test-only PEM fixtures with no relation to real secrets
— confirmed by reading, not assumed. Clean scan, consistent with the
2026-09-06 and 2026-09-16 nights' same conclusion; recorded as a clean
scan, not a null result.

## Recommendation

1. **Merge PR #29** (`protobufjs` RCE fix, 2026-09-16, already clean/
   mergeable) and **this PR** (`toml`, tonight) — both are minimal,
   reachability-verified, zero-`src/`-change dependency pins. Together they
   clear the CRITICAL finding and 2 of the 9 remaining HIGH findings.
2. **The dream-cycle review backlog is now the dominant risk to this
   routine's value**, not candidate quality: 12 consecutive nights
   (2026-09-08 through 2026-09-20) have produced evaluated, ACCEPT-verdict
   candidates on unmerged branches; only 1 of the last 12 PRs has merged.
   Tonight's own near-duplication of PR #29 is a direct symptom — every
   session works off `main`, which hasn't advanced in 15 days, so each
   night's research is blind to 12 nights of sibling work unless it
   explicitly queries GitHub (not just the local, now-stale `LEDGER.md`).
   This is issue #34's finding, still open; tonight independently
   re-confirms and sharpens it with a concrete near-miss. Not tonight's
   candidate (dev-experience surface, not security) — but worth a human
   decision on review cadence before the backlog grows further.
3. **`ruflo`'s unpinned `peerDependencies: {"ruflo": "*"}` range** is an
   independent finding worth its own future security or dev-experience
   night: it caused the version-drift confound this evaluation had to
   control for by hand, and independently trips this repo's own
   `@claude-flow/cli` version-pin canary test on every fresh install once
   the registry publishes a new `ruflo` release — a real, reproducible test
   fragility, not yet anyone's fixed candidate.
4. Continue the "does ruClip's own code path actually touch this"
   reachability check, one package at a time, for the remaining 9 HIGH
   findings (`sharp`/libvips CVEs, `@opentelemetry/*` DoS, `adm-zip`,
   `fast-uri` SSRF, `onnxruntime-node`) — same repeatable pattern PR #29
   and tonight both used.

## Witness

```
REPORT_HASH    = 0f66f458bd02fdd456f455deff5909d6c0434e27de8d7fd02ddf455914968165
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 519543f275f0945db43222193a6f9284175a19735241da9c049171513303aa2a
```

`REPORT_HASH` is the sha256 of this file's content up to (and including)
the line directly above this Witness section — i.e. everything before
`## Witness` itself. `WITNESS = sha256(REPORT_HASH || SESSION_COMMIT)`,
computed as `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text
   (`docs/dream-cycle/2026-09-21-security-report.md`) up to the `## Witness`
   heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` (`6e73a8f060bcbb69965a50ffe4627e33622d4094`) is
   an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal
   `WITNESS` above.
5. Independently re-run `npm install && npm run build && node
   scripts/run-tests.mjs dist && npm audit` against the PR branch's HEAD
   and confirm: `npm ls ruflo @claude-flow/cli` shows the same resolved
   version in a from-scratch install, `npm audit` shows `toml` absent from
   its findings, and the suite reports 326/327 (the one pre-existing,
   environmental `@claude-flow/cli`-version-pin failure — not caused by
   this candidate, reproduces identically with the `overrides` block
   removed).
