# Security SOTA Report — 2026

**Dream Cycle 2026-11-06 — `ruvnet/ruClip`**
DEEP=security · SCAN=dependencies,secrets · SLOT=1 · Session commit `6e73a8f060bcbb69965a50ffe4627e33622d4094`

## TL;DR

`services/ruclip-attester/src/google-token.ts` is the sole cryptographic
trust boundary for `/v1/attest` (IAP JWT verification — see that file's own
header). Its correctness claims are explicitly grounded in "confirmed by
reading the actual installed `google-auth-library` v10.9.1 source," not
assumed from docs. Tonight's `npm ls google-auth-library --all` on a fresh
`npm ci` shows this repo's real production dependency closure resolves
**two different declared versions of that exact package** — a top-level
copy (`10.9.1`, the one Node's module resolution actually hands to
`google-token.ts`) and a second, independently-versioned copy (`11.0.2`)
nested under `@google-cloud/secret-manager` → `google-gax`. Neither `npm
audit` (re-run tonight: 53 findings, 0 for `google-auth-library` itself —
this is not a CVE) nor any of the four open dependency-CVE dream-cycle PRs
(#29, #39/#51, #100, #113) would ever surface this, since none of them
treats same-package version divergence as a finding class.

Verified by reading the real installed files, same discipline as
`google-token.ts` itself: `diff -rq` over both copies' entire `build/`
directories is empty — **today the two versions are byte-identical** on
every file, including the exact IAP-verification surface
(`getIapPublicKeysAsync`, `verifySignedJwtWithCertsAsync`) this repo
actually exercises. But **nothing currently re-checks that after a future
install** — a `google-gax` bump could silently pull a newer
`google-auth-library` into the nested copy while the direct top-level
dependency range stays satisfied, invalidating `google-token.ts`'s
source-reading claim with no CVE, no audit flag, and (proven below) no
existing test catching it.

Built `dual-version-drift-guard` (`src/tooling/dual-version-drift-guard.ts`):
a small, read-only, dependency-free (`node:` builtins only) tool that finds
every installed copy of a named package under `node_modules` and fails
loudly the moment two copies disagree on a named security-relevant file.
Real receipt against tonight's live install: **2 copies found, both
byte-identical — consistent, exit 0.** Secrets scan (this cycle's pairing):
clean — repo-wide grep for AWS/GitHub/Slack/API-key-shaped token patterns
and generic `(secret|token|password|api[_-]?key)\s*[:=]\s*['"]<literal>`
assignments outside tests found no matches; the only
`-----BEGIN PRIVATE KEY-----` blocks in the tree remain the pre-existing
Ed25519 test fixtures (`tests/support/actor-credential-fixture.ts`,
`services/ruclip-attester/tests/signing-key.test.ts`), already noted by
prior nights (#100, #113).

## What's new

- A finding class no prior dream-cycle night checked: **same-package,
  multi-copy version divergence on a security-critical dependency**,
  orthogonal to CVE-based triage (#29/#39/#51/#100) and to the
  install-path reachability classifier (#113) — both of those ask "is this
  *known-vulnerable* version reachable"; tonight asks "do the *multiple
  resolved copies* of a package this repo's own trust boundary explicitly
  vouches for by reading its source agree with each other at all."
- A reusable regression guard (`npm run security:dual-version-drift-guard`,
  exit 1 iff any two installed copies of the watched package diverge on the
  watched file) instead of a one-off manual `diff -rq` (which is exactly
  what this night ran by hand first, then automated).
- Cross-referenced against `google-token.ts`'s own header, which already
  names "confirmed by reading the actual installed v10.9.1 source" as the
  basis for trusting `OAuth2Client`'s IAP behavior — this guard is the
  missing automated check that claim was implicitly relying on staying true
  across future installs.

## Competitors (paperclipai/paperclip and 3 more SCA-adjacent references)

| # | Project/Tool | Relevant practice | Grade |
|---|---|---|---|
| 1 | `paperclipai/paperclip` | MIT Node/React control plane (ADR-0001's own comparison); no committed dependency-drift or multi-copy-consistency tooling found in the public repo | B (public repo, read directly) |
| 2 | npm CLI docs — `npm help ls` | `npm ls --all --json` is npm's own documented mechanism for enumerating every resolved copy of a package, including same-name/different-version duplicates under independent subtrees | A (official docs, directly exercised tonight) |
| 3 | Node.js docs — CommonJS/ESM module resolution algorithm | Documents that `import`/`require` resolve to the *nearest* `node_modules/<pkg>` walking up from the importing file — the mechanism that determines tonight's top-level copy (`10.9.1`) is the one `google-token.ts` actually gets, not the nested `11.0.2` | A (official docs) |
| 4 | Sigstore / in-toto, SLSA provenance tooling (industry pattern, not vendored) | Established supply-chain practice: attest that the exact artifact verified in CI is the exact artifact that ships/runs, closing the gap between "we read the source once" and "the source stays that way" — this guard implements a narrow, dependency-free instance of that principle for one named file, not full provenance attestation | B (well-known practice, not independently reproduced beyond its own documented mechanism) |

## Hypothesis (frozen before evaluation)

> Given this repo's real `npm ci` install, when every installed copy of
> `google-auth-library` reachable from `node_modules` is located and their
> `build/src/auth/oauth2client.js` files are compared byte-for-byte, then
> tonight's real tree should report **consistent** (both copies identical,
> matching the `diff -rq` check run by hand first) — AND a synthetic
> single-byte edit to either copy, applied with no other change, should
> make the *existing* (pre-candidate) test suite report zero new failures
> (proving no current detection exists) while the *candidate* tool reports
> **drift detected** and exits 1 — subject to: the guard must not alter
> `npm audit`'s own output, must not mutate `package.json`/
> `package-lock.json`/`node_modules`, and must not assume the two copies
> are equal without reading both.

Frozen before evaluation began; not modified after.

## Benchmarks / Evaluation Receipt

Evaluator: real `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), this repo's only entrypoint. No LLM calls (`LLM_EVAL=not_needed` — this candidate needed no model-calling evaluation stage; `OPENROUTER_API_KEY` was not checked for since no stage in this candidate calls a model).

| Step | Tree state | Evaluator | Result |
|---|---|---|---|
| 1. Baseline (parent) | real tree, untouched | `npm test` | **327/327 pass**, build clean |
| 2. Baseline + synthetic drift | 1 byte appended to the nested copy's `oauth2client.js` only | `npm test` (still parent — no guard exists yet) | **327/327 pass** — proves zero existing detection of this class |
| 3. Candidate added, same corrupted tree | corrupted (from step 2) | `npm run security:dual-version-drift-guard` | **DRIFT DETECTED**, exit 1, names both exact paths + diverging hashes |
| 4. Corruption reverted (exact original bytes restored, verified by re-hash) | real tree, restored | `npm run security:dual-version-drift-guard` | **OK, consistent**, exit 0 |
| 5. Candidate, full suite, restored tree | real tree, restored | `npm test` | **334/334 pass** (327 baseline + 7 new), 0 regressions |

Real output from step 3 (abbreviated):
```
Watched file: build/src/auth/oauth2client.js
Installed copies found: 2
  node_modules/google-auth-library@10.9.1  sha256:af1aeb78dc...
  node_modules/google-gax/node_modules/google-auth-library@11.0.2  sha256:453e8e37cb...
DRIFT DETECTED: installed copies of this dependency disagree on the watched security-relevant file — re-verify google-token.ts's "confirmed by reading the installed source" claim against the new version(s) before trusting it.
```
Real output from step 4 (restored):
```
Installed copies found: 2
  node_modules/google-auth-library@10.9.1  sha256:af1aeb78dc...
  node_modules/google-gax/node_modules/google-auth-library@11.0.2  sha256:af1aeb78dc...
OK: every installed copy of this dependency agrees on the watched security-relevant file.
```

`tsc -p tsconfig.json`: clean, both before and after. `npm run lint`: no-op stub (pre-existing, unchanged — see issue #106/PR#105, not tonight's scope).

## Darwin Results

Not run — no tunable parameter or fitness function; this is a binary
consistency check (byte-equal or not), same "not applicable" call as
`audit-reachability` (#113) and the `proxy-addr` version-floor guard (#100)
made for the same reason.

## Evidence

- OBSERVATION: `npm ls google-auth-library --all` resolves two copies at
  two different declared versions (`10.9.1` top-level, `11.0.2` nested
  under `google-gax`) from this repo's real `npm ci`.
- OBSERVATION: `diff -rq` over both copies' full `build/` directories is
  empty (728K each, 45 `.js` files) — confirmed before writing any code,
  not assumed.
- MEASUREMENT: baseline test suite (327/327) does not change when either
  copy is corrupted — zero existing detection (step 2 above).
- MEASUREMENT: candidate tool correctly flags the same corruption (step 3)
  and correctly clears once reverted (step 4), with exact hash values
  logged both times.
- INFERENCE: since `google-token.ts` resolves the top-level copy via
  ordinary Node module resolution (no nested `node_modules` exists between
  `services/ruclip-attester/src/` and the repo root), the top-level
  `10.9.1` copy is the one actually executed in production — the nested
  `11.0.2` copy is reachable only via `@google-cloud/secret-manager`'s own
  internal use of `google-gax`, never imported by this repo's own code.
- DECISION: ACCEPT `dual-version-drift-guard` as tonight's candidate — a
  regression guard for a previously undetected class of silent drift on a
  named security trust boundary, not a fix for a currently-exploitable bug
  (today's state is already consistent).

## Reward-Hack Check

- The guard never touches `npm audit`'s output, `package.json`,
  `package-lock.json`, or any existing test file — purely additive.
- Specifically checked for the failure mode a careless version of this
  tool would have: comparing only package.json `version` strings (which
  would call `10.9.1` vs `11.0.2` "different" even when, as tonight, their
  actual compiled code is identical — a false-positive generator) instead
  of the real file content. The implemented `compareCopies` hashes the
  real file bytes, not the version string; the fixture test
  "identical watched-file content across copies is consistent" pins this
  down even though the two fixture copies carry different `version` fields
  (`10.9.1`/`11.0.2`), mirroring the real case exactly.
- The "missing watched file" test (`compareCopies: a copy missing the
  watched file is reported as inconsistent, not silently skipped`) exists
  because a naive implementation that only hashes files that happen to
  exist, and silently drops a copy where the file is absent (e.g. after a
  future major rewrite that renames/moves the file), would quietly stop
  protecting anything — caught here and pinned by that test.
- No benchmark/gold-answer/threshold was touched; no model calls made.
- The baseline→corrupt→candidate→restore sequence (steps 1–4 above) was
  run for real, in order, on the actual installed tree, and the restored
  file's hash was re-verified to exactly equal the pre-corruption hash
  before any test suite was reported as "334/334" — not inferred from logs.

## Security Review

- No new runtime dependency added. No credentials, MCP/tool authority, or
  network scope expanded — the tool reads local `node_modules` files only,
  the same filesystem access `npm test`/`npm ci` already have.
- Strictly read-only: no `--fix`, no lockfile/`package.json`/`node_modules`
  mutation in the shipped tool (the corruption used to prove the gap in
  evaluation was applied and reverted manually during this session, never
  by code in this PR, and is not part of what gets committed).
- `findInstalledCopies` bounds its own recursion to real directories under
  `node_modules` and skips `.bin` — no path traversal outside that root, no
  symlink-following beyond what `readdirSync`/`statSync` themselves do.
- Secrets scan (this cycle's pairing): clean — see TL;DR. No `.env`/`.pem`/
  `.key`/service-account files are tracked; `.gitignore` already excludes
  `.env`. No change to any secret-handling code path in this PR.

## Scan Findings

**dependencies** (this cycle's scan): two installed copies of
`google-auth-library` (`10.9.1`, `11.0.2`) on a security-critical trust
boundary, currently byte-identical on the exercised surface; a new guard
now detects future divergence instead of relying on an unenforced claim in
a code comment. `npm audit`'s 53 findings are otherwise unchanged from
#113's 2026-11-01 receipt (1 of 34 high/critical install-locations
production-reachable: `@grpc/grpc-js@1.14.4`, PR #51, still open/unmerged)
— re-confirmed tonight via `npm ls @grpc/grpc-js --all`, not re-litigated
as tonight's candidate since #51 already exists.

**secrets** (this cycle's scan): clean — see Security Review above.

## Recommendation / 3 next steps

1. Human review: this PR (small, additive, read-only) alongside the
   still-open #51 (`@grpc/grpc-js`, the one PR#100/#113-confirmed
   production-reachable finding) — #51 remains the single highest-priority
   item in the backlog from a pure risk standpoint, unchanged by tonight.
2. Extend `dual-version-drift-guard` (future night) to watch more than one
   file per package, or to accept a config list of `{package, file}` pairs
   covering every security-critical dependency this repo's own trust
   boundaries name in their own file headers (today: just
   `google-auth-library`'s `oauth2client.js`), making the watch-list
   explicit and auditable instead of hardcoded to one pair.
3. Merge-review backlog: as of tonight, dozens of `dream-cycle` PRs
   (#17–#121) remain open/unmerged (0% recent merge rate, per #92/#113) —
   outside this session's authority to act on, flagged not fixed, per
   PR #92's own "explicitly not done: a 6th duplicate/backlog-detection
   tool."

## Witness

```
REPORT_HASH    = 9349f13c270261c472d697fcfbe6a55298a1b089848004df1997b939ee03fae4
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 662ed4877b8bac38dba72ff88f26db02541da014540a8f13209bef52f26470f0
```

`REPORT_HASH` is the sha256 of this report as finalized immediately before
this Witness section's two value lines were filled in (the standard
chicken-and-egg resolution for a self-describing hash: computed over the
file with these two lines still reading as placeholders, then only those
two lines were edited in place).

Verifier procedure (reproducible by anyone, no special access):
1. `git -C ruClip checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- package.json` (confirms the parent commit).
2. `git -C ruClip rev-parse 6e73a8f060bcbb69965a50ffe4627e33622d4094^{commit}` → must resolve.
3. `npm ci && npm ls google-auth-library --all` → confirms two installed copies, versions `10.9.1` and `11.0.2`.
4. Check out this cycle's branch; `npm ci && npm run build && node scripts/run-tests.mjs dist` → confirm 334/334.
5. `npm run security:dual-version-drift-guard` → confirm exit 0 and "OK: every installed copy ... agrees" against a fresh, uncorrupted install (live `npm audit`/resolved versions can drift over time as new releases are published; the *logic* — including the "missing file" and "different version, same bytes" cases — is pinned by `tests/tooling/dual-version-drift-guard.test.ts`, independent of which exact versions a future install resolves).
