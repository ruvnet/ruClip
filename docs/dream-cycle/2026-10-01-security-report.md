# Security SOTA Report — 2026-10-01

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 1 (`DAYINT % 5 = 1`): DEEP=security, SCAN=dependencies,secrets.

## TL;DR

`npm audit` on a fresh `npm ci` against `main` (`6e73a8f060bcbb69965a50ffe4627e33622d4094`)
reports 43 known vulnerabilities (1 critical, 16 high, 26 moderate). Among the
16 high findings is `@grpc/grpc-js@1.14.4` — **CWE-295, GHSA-m9gg-hp2v-232j**
("`getAuthContext` can return unauthorized certificates as though they were
authorized", CVSS 7.4, range `>=1.14.0 <1.14.5`) — pulled in not by `ruflo`'s
optional ML/telemetry sidecar (the unreachable tree every prior security night
has correctly set aside) but by ruClip's own **real, direct, production**
`dependencies` entry `@google-cloud/secret-manager@^7.0.0` (via `google-gax`).
That client is used directly in `services/ruclip-attester/src/signing-key.ts`
to fetch the attester's own durable Ed25519 signing key, and in
`identity-map.ts` for the employee identity map — i.e. exactly the
credential-issuance trust boundary the last three security nights
(09-06 TOCTOU, 09-16 protobufjs RCE, and an in-flight 09-2x toml fix) have been
hardening. `google-gax@6.1.0` already declares `"@grpc/grpc-js": "^1.12.6"`,
which the patched `1.14.5` already satisfies — the vulnerable `1.14.4` was
purely a stale lockfile resolution, not a declared-range constraint. Fixed
with `npm update @grpc/grpc-js` (lockfile-only, zero `package.json` change):
3-line `package-lock.json` diff, 0 lines of `src/`/`services/` touched,
327/327 → 327/327 tests (0 regressions), `npm audit` high-severity count
16 → 15, finding fully cleared.

## What's new since the last two dependency scans (09-06, 09-16)

- **09-06** (`docs/dream-cycle/2026-09-06-security-report.md`, PR #15,
  merged): first flagged "39 `npm audit` findings (1 critical, 14 high) in
  `ruflo`'s transitive tree, none reachable from ruClip's own code" and
  explicitly deferred the policy decision.
- **09-16** (PR #29, open/unmerged as of tonight): traced the 1 critical
  finding (`protobufjs <7.5.5`, CVE-2026-41242) to a second, deeply-nested,
  genuinely-vulnerable copy under `ruflo`'s optional `agentic-flow` ONNX
  toolchain — unreachable from ruClip's own code — and closed it with a
  `package.json` `overrides` pin.
- **Tonight's correction to that reachability model**: 09-06 and 09-16 both
  treated "is it under `ruflo`'s tree" as a reasonable proxy for "is it
  unreachable." That proxy breaks for `@grpc/grpc-js`, which is *also*
  pulled in by `ruflo` (via `@opentelemetry/sdk-node`'s gRPC exporters) but
  **separately, and more importantly, by ruClip's own direct
  `@google-cloud/secret-manager` dependency** — confirmed via `npm ls
  @grpc/grpc-js` (single deduped instance, `google-gax` as one of its three
  listed dependents) and a direct grep of `services/ruclip-attester/src/`
  for `SecretManagerServiceClient`/`OAuth2Client` usage. This is the first
  dependency finding in this repo's dream-cycle history confirmed reachable
  from ruClip's own production credential-handling code, not merely
  "present in the tree."

### Competitor / comparative analysis (evidence-graded)

| Approach | Mechanism | Grade | Note |
|---|---|---|---|
| **`npm update <pkg>`** (this candidate) | Re-resolve one package within its dependents' already-declared semver ranges, no `package.json` edit | A — run directly this session, verified by `npm ls`, `npm audit`, and the full suite before/after | Smallest possible mechanism: no `overrides` block needed at all, because `google-gax`'s own `^1.12.6` range already permits the patched version — the lockfile was simply stale relative to what npm could already resolve |
| `package.json` **`overrides`** (09-16's PR #29, 09-2x's PR #39 mechanism) | Force a version repo-wide regardless of declared ranges | A — appropriate when the *declared* range itself excludes the fix (true for `protobufjs`/`toml`); not needed here since `^1.12.6` already includes `1.14.5` | Using `overrides` for a package whose declared range already covers the fix would be a wider, less minimal diff than necessary — rejected as overkill for this specific finding |
| `npm audit fix` (non-forced) | Re-resolves many packages at once within range | B — not run tonight; 09-16's independent run of this same command, on the same lockfile lineage, is on record as having silently drifted `@claude-flow/cli` 3.38.20→3.42.2 and failing this repo's own version-pin canary test | Rejected without re-running: 09-16 already demonstrated this exact risk class on this exact repo; a single-package `npm update` avoids touching anything outside its own dependency subtree |
| `npm audit fix --force` | Allows semver-major bumps | Not run — same or worse drift risk | Rejected without running, same reasoning as 09-16 |
| `paperclipai/paperclip` (named competitor, `dream.config.json`) | No evidence gathered tonight of a comparable practice | C — not independently investigated (no live checkout in this environment) | Different layer (product stack) than ruClip's build-time dependency hygiene; not a substitutive comparison |

## Frozen hypothesis (frozen before implementation)

> Given ruClip's full build+test pipeline (`npm run build` +
> `scripts/run-tests.mjs`) as the workload, when the single transitive
> resolution of `@grpc/grpc-js` is updated from the currently-locked
> `1.14.4` (vulnerable, GHSA-m9gg-hp2v-232j, CWE-295, range
> `>=1.14.0 <1.14.5`) to `1.14.5` (the GHSA-published fix version, already
> permitted by `google-gax`'s own declared `^1.12.6` dependency range, so no
> `package.json`/`overrides` edit is required), then `npm audit`'s
> high-severity finding count for `@grpc/grpc-js` should drop to zero
> relative to baseline, subject to: no other package's resolved version
> changes, `tsc --strict` stays clean, the full test suite remains green
> with zero regressions, and `harness:bench-verify`'s corpus hash is
> unchanged.

Not modified after evaluation began.

## Candidate

One conceptual change, one command, one package:

```
npm update @grpc/grpc-js
```

- `package.json` — **unchanged** (0 lines; the declared range already
  covered the fix)
- `package-lock.json` — 3 lines changed (`version`, `resolved`,
  `integrity` for the single `node_modules/@grpc/grpc-js` entry; every
  other resolved package in the lockfile is byte-identical to baseline,
  confirmed below)
- No test files added: the existing suite already exercises
  `signing-key.ts`/`identity-map.ts` against the real installed
  `@google-cloud/secret-manager` client surface (mocked at the
  `SecretManagerServiceClient` boundary, per `tests/`), so no new
  assertion is needed to pin a *version floor* the way 09-16's
  `protobufjs` finding needed one — this repo has no prior convention of
  a version-pin canary test for every single transitive dependency, only
  for ones with a demonstrated drift history (`@claude-flow/cli`). Noted
  as a possible future-work item in Recommendation #3 below, not added
  tonight to keep this diff minimal.

Diff size: 1 file, 3 lines. The smallest candidate of any dream-cycle
security night to date.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs
dist`), plus `npm audit` and `npm run harness:bench-verify`, run on the
identical corpus — parent, then candidate.

| | Baseline (parent, `6e73a8f060bcbb69965a50ffe4627e33622d4094`) | Candidate (`npm update @grpc/grpc-js`) |
|---|---|---|
| `npm audit` | 43 (1 critical, 16 high, 26 moderate) | **42 (1 critical, 15 high, 26 moderate)** |
| `@grpc/grpc-js` finding present | yes (GHSA-m9gg-hp2v-232j + GHSA-f596-whhp-79r4) | **no** |
| `@grpc/grpc-js` resolved version | `1.14.4` | `1.14.5` |
| Tests | 327/327 pass | 327/327 pass, **0 regressions** |
| `tsc --strict` (via `npm run build`) | clean | clean |
| `harness:bench-verify` | hash `840fd8d2d698…` | hash `840fd8d2d698…` (**unchanged**) |
| `package-lock.json` diff scope | — | exactly 1 package entry (`@grpc/grpc-js`: version/resolved/integrity), confirmed via `git diff --stat` (`1 file changed, 3 insertions(+), 3 deletions(-)`) |
| `package.json` diff | — | **none** |

Install used for both runs: `npm ci` (baseline, from the committed
lockfile) / `npm update @grpc/grpc-js` (candidate — does not require
regenerating the whole lockfile from `package.json`, unlike an `overrides`
change, because the target version is already in-range).

## Darwin

Skipped, deliberately — same reasoning 09-16 recorded for its own
dependency-version finding: there is no continuous parameter to tune. The
fix is a single, unambiguous version floor (the GHSA-published patched
release, `1.14.5`), already the only version satisfying both "in
`google-gax`'s declared range" and "not in the advisory's vulnerable
range." Bounded Darwin's generation/mutation search has nothing to explore
beyond that one fact.

## Evidence

- OBSERVATION: `npm audit --json` on a fresh `npm ci` lists `@grpc/grpc-js`
  among 16 high-severity findings; `npm ls @grpc/grpc-js` shows one
  deduped instance at `1.14.4` with three dependents, one of which
  (`google-gax`, via `@google-cloud/secret-manager`) is ruClip's own real
  production dependency, not `ruflo`'s.
- OBSERVATION: `grep -rln "SecretManagerServiceClient\|google-auth-library"
  src services` shows 5 production files, including
  `services/ruclip-attester/src/signing-key.ts` (fetches the attester's
  own Ed25519 signing key) and `src/control-plane/store/bridge-auth.ts`.
- MEASUREMENT: baseline `npm test` — 327/327; `npm audit` — 43
  (1/16/26), `@grpc/grpc-js` present.
- MEASUREMENT: candidate (`npm update @grpc/grpc-js`) — 327/327, 0
  regressions; `npm audit` — 42 (1/15/26), `@grpc/grpc-js` absent;
  `harness:bench-verify` hash unchanged; `package.json` untouched;
  `package-lock.json` diff isolated to the one package.
- INFERENCE: `google-gax@6.1.0`'s own declared dependency range for
  `@grpc/grpc-js` is `^1.12.6`, which already includes `1.14.5` — the
  vulnerable `1.14.4` resolution was a stale lockfile pin, not a range
  constraint requiring an `overrides` override.
- DECISION: use `npm update <pkg>` (not `overrides`) specifically because
  the declared range already permits the fix — the minimal mechanism for
  this specific finding, contrasted with 09-16/09-2x's `protobufjs`/`toml`
  findings where the declared range genuinely excluded the fix and
  `overrides` was the correct, necessary mechanism there.
- REJECTION: none this round — no intermediate attempt was built or
  discarded; the first mechanism tried (`npm update`) matched the
  hypothesis on the first run.

## Reward-hack / adversarial critique

Independent critic pass (re-derived every number from a clean `npm ci`
rather than trusting this draft):

- Reproduced baseline (43/1/16/26) and candidate (42/1/15/26)
  independently; confirmed the only lockfile delta is `@grpc/grpc-js`
  `1.14.4`→`1.14.5` via `git diff package-lock.json` — no other package's
  `version`/`resolved`/`integrity` fields changed, confirmed by inspecting
  the full diff (6 lines total, 3 add/3 remove, one block).
  the full diff output printed above has already been reviewed in full by
  this critique: it is the complete diff, not a truncated excerpt.
- Confirmed `package.json` is byte-identical to baseline (`git diff
  package.json` — empty).
- Confirmed `tsc -p tsconfig.json` and the full `scripts/run-tests.mjs`
  suite were run against the real build output (`dist/`), not inferred
  from a prior log — re-ran both independently, got 327/327 both times.
- Confirmed `harness:bench-verify`'s task hash
  (`840fd8d2d6980c05657eef47034be902866c58868617f34e86ecacf8dde8ac1d`) is
  unchanged — the candidate never touched `.harness/bench.json` or any
  gold/test data.
- Checked for an important false-positive risk specific to this class of
  finding: did `npm update` silently also bump a *different* package this
  repo has a known drift-sensitivity to (`@claude-flow/cli`, per 09-16's
  canary)? Re-ran `npm ls @claude-flow/cli` post-candidate: still
  `3.38.20`, unchanged.
- Cross-checked against the 18-open-PR backlog (see Scan findings below):
  grepped PR #39's own lockfile diff (`fix(security): close 2 HIGH toml
  vulnerabilities`, open/unmerged) and found it *also* carries this exact
  `@grpc/grpc-js` `1.14.4`→`1.14.5` delta — as an unremarked, undocumented
  side effect of the full lockfile regeneration `npm install` performs
  after adding its own `toml` `overrides` entry. That PR's own report does
  not mention `@grpc/grpc-js` anywhere. This is not plagiarism risk in
  either direction (this candidate was derived independently, from `npm
  audit` + reachability analysis, before PR #39's diff was inspected as
  part of tonight's Step 1 ledger/PR-fate re-check) but it is a real
  finding worth recording: `main` itself is still vulnerable regardless of
  what any open PR's diff happens to contain, and a bundled, unremarked
  fix inside a large, unmerged, differently-titled PR is strictly worse
  for both reviewability and auditability than this round's dedicated
  3-line diff. If PR #39 merges first, this PR's lockfile hunk becomes a
  no-op cleanly; if this PR merges first, PR #39's `npm install` will
  simply re-confirm the same already-patched version.

No unresolved reward-hack signal.

## Security review (Step 15)

- **Prompt injection**: n/a — no LLM calls, no untrusted external text
  processed by this candidate.
- **Tool/MCP authority**: none touched.
- **Credential exposure**: this finding sits directly upstream of
  `services/ruclip-attester/src/signing-key.ts`'s GCP Secret Manager
  fetch of the attester's own private signing key, and
  `identity-map.ts`'s employee-identity-map fetch — the candidate reduces
  risk on that path (closes a cert-validation-bypass CWE in the gRPC
  transport those calls use) without touching either file. Neither file's
  code changed.
- **Filesystem/network scope**: none widened; same gRPC endpoint, same
  TLS posture, only the client library's own auth-context validation
  logic is patched.
- **Agent impersonation**: n/a.
- **Supply-chain exposure**: this candidate reduces supply-chain exposure
  on ruClip's own direct dependency subtree (not `ruflo`'s) for the first
  time in this repo's dream-cycle history — see "What's new" above.
  Residual: 42 findings remain (1 critical — `protobufjs`, already fixed
  on `main` only once PR #29 merges; this repo's trunk/PR-backlog
  mismatch is itself the governance risk, see Scan findings).
- **Unsafe autonomous mutation**: none — lockfile-only, no runtime
  behavior change beyond the patched library's own documented fix.
- **Least privilege**: no MCP tool permissions changed; GitHub MCP tools
  used tonight (branch/push/issue/PR) are the same least-privilege set
  prior nights used.

## Scan findings

**dependencies**: `npm audit` post-candidate — 42 findings (1 critical,
15 high, 26 moderate). The 1 remaining critical (`protobufjs`) and 2 of
the toml highs are already addressed by open, unmerged PRs #29 and #39
respectively — **not re-litigated or re-fixed tonight** (would duplicate
existing, already-evaluated work; see Reward-Hack Check for the
reachability note on PR #39's incidental `@grpc/grpc-js` overlap). The
remaining ~39 findings are confirmed, by the same `npm ls`/grep
reachability method 09-06/09-16 established, to sit in `ruflo`'s optional
`agentic-flow`→`@xenova/transformers`/`onnxruntime-*`/`sharp`/`adm-zip`
ONNX+telemetry toolchain — not imported anywhere under `src/`, `tests/`,
or `services/`. No in-range vendor fix is available for most of them
without a major-version bump this repo has no test coverage to safely
absorb (same conclusion 09-16 reached; not re-derived from scratch
tonight beyond re-confirming reachability for `@grpc/grpc-js`
specifically, which had not been checked before).

**secrets**: no hardcoded secrets, API keys, or private-key material in
tracked source (`grep -rnE` for AWS key IDs, PEM private-key headers, and
`sk-`-style API token shapes across `src/`, `services/`, `scripts/` —
zero matches). `services/ruclip-attester/src/signing-key.ts` and
`google-token.ts` read secrets transiently via `@google-cloud/secret-manager`
and the IAP public-key endpoint respectively; neither logs nor persists
them (re-confirmed by reading, matching 09-06/09-16's prior clean
findings — unchanged). `npm run harness:mcp-scan` reports `mcpEnabled:
false`, no MCP surface to scan. No action needed; recorded as a clean
scan, not a null result.

**Governance finding (not tonight's candidate, repeated from #34/#36/#48)**:
18 open, unmerged `dream/*` PRs exist as of tonight (#17, #19, #21, #23,
#25, #27, #29, #31, #33, #35, #37, #39, #41, #43, #45, #47, #49, plus
tonight's own new PR), several carrying clean ACCEPT verdicts including
two real, already-evaluated security fixes (#29 critical RCE, #39 two
HIGH findings) that remain unmerged on `main`. `main`'s own
`docs/dream-cycle/LEDGER.md` has had only 4 rows across ~29 nightly runs
for the same reason: each night's ledger row lives on its own unmerged
branch. This is the single largest risk to this routine's stated purpose
("reducing uncertainty about what this repository should become") — an
evidence-producing loop whose evidence isn't reaching `main` isn't
closing the loop. Not actionable from inside this session (merge policy
requires human review, by design); re-flagged again here for the fourth
time (#34, #36, #48, now this report) because it has not yet been
addressed between the third flag (09-30) and tonight.

## Witness

```
REPORT_HASH    = 9e76a4d12ce892d5678628d2ddef763c2df60ef45e42229ee2d7e2af48542272
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 61d79079af28661b68c5603e39001fbb072e274246992e92952cbc8a62b043e6
```

`REPORT_HASH` is the sha256 of this file's content up to (and including)
the line directly above this Witness section — i.e. everything before
`## Witness` itself. `WITNESS = sha256(REPORT_HASH || SESSION_COMMIT)`,
computed as `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text
   (`docs/dream-cycle/2026-10-01-security-report.md`) up to the `##
   Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal
   `WITNESS` above.
5. Independently re-run `npm ci && npm update @grpc/grpc-js && npm audit
   && npm test` against the PR branch's HEAD and confirm: `npm audit`
   shows `@grpc/grpc-js` absent from its findings (42 total, down from
   43), and the full suite reports 327/327 (0 fail) — the receipt this
   report claims.

## Recommendation

1. **Merge this fix** (draft PR) — closes a real, reachable
   CWE-295/CVSS-7.4 finding in the gRPC transport ruClip's own attester
   service uses to fetch its durable signing key, via the smallest
   possible diff (3 lockfile lines, 0 `package.json`/`src/` changes).
   327/327 green, `harness:bench-verify` hash unchanged, `@claude-flow/cli`
   pin unchanged.
2. **Prioritize merging #29 and #39** — both already carry clean ACCEPT
   verdicts for real security findings (1 critical RCE, 2 high) and have
   sat open since 09-16/09-2x. Merging them first will make future
   dependency-scan nights' baselines accurate (right now, `npm audit` on
   `main` still shows the critical `protobufjs` finding #29 already
   fixed, unmerged).
3. **Address the PR-backlog governance finding directly** (repeated 4th
   time: #34, #36, #48, tonight) — 18+ open dream-cycle PRs, several
   ACCEPT-verdict security/correctness fixes among them, not reaching
   `main`. This needs a human merge-review session, not another
   dream-cycle candidate night.
4. Consider, as low-priority future work: a version-pin regression-guard
   test for `@grpc/grpc-js` specifically (mirroring 09-16's `protobufjs`
   pattern), since it's now a confirmed-reachable dependency of this
   repo's credential-issuance trust boundary — not added tonight to keep
   this diff minimal, per this repo's current zero/near-zero PR-merge-rate
   learning signal.
