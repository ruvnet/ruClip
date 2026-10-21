# Security SOTA Report — 2026-10-21

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 1 (`DAYINT % 5 = 1`): DEEP=security, SCAN=dependencies,secrets.

## TL;DR

`mintActorCredential`/`mintHumanActorCredential` (`credential-issuer.ts`,
`human-identity-attestation.ts`) — the only two code paths that ever sign a
ruClip `ActorCredential` — accepted a caller-supplied `ttlSeconds` with **no
upper bound**. `ACTOR-IDENTITY-VERIFICATION.md` explicitly names "the short
(15 min) TTL bounds the exposure window" as the design's *stated mitigation*
for not having mid-credential-lifetime revocation (§8) — yet nothing in code
enforced that any credential's requested lifetime actually stayed within that
ceiling. Every call site in this repo today only ever requests the 900s
default (or a negative TTL, deliberately, to mint an already-expired
credential for a `verifyActorCredential` expiry test) — so there is no live
exploit path today — but the one documented safety net the whole
no-revocation design leans on was not actually wired into the code that is
supposed to provide it. Fixed by adding `MAX_TTL_SECONDS` (= the design's own
documented 900s default) and a fail-closed check in `mintActorCredential`,
before any Secret Manager/`radio-moe` work — a caller requesting a longer
TTL is now refused at mint time rather than silently honored. Baseline
(current HEAD, guard unfixed, new tests present): 328/329 tests, 1 failure,
exactly the predicted gap. Candidate (fixed): 329/329, 0 regressions.

## What's new / prior art

The concurrent scan track (`dependencies,secrets`) re-ran `npm audit`: 54
findings now (2 critical, 23 high, 29 moderate), up from 39 (1 critical, 14
high, 24 moderate) in the 2026-09-06 security night. The new critical,
`proxy-addr` (IP-spoofing via IPv4-mapped IPv6 trust-subnet confusion), was
traced the same way that night traced `protobufjs`: `npm ls proxy-addr --all`
shows it is reachable only via `ruflo` → `@claude-flow/cli` → `express`, a
separate out-of-process sidecar; `grep` confirms no `src`/`services` file in
this repo imports `express`, `proxy-addr`, or (checked specifically because
`ruvector@0.3.0` resolves as a **top-level** sibling package, unlike every
other flagged package) `ruvector`/`@modelcontextprotocol/*` directly. Real
exposure, not independently fixable from inside ruClip tonight (no in-range
vendor fix for most of the 54), not tonight's DEEP candidate — same
conclusion as 2026-09-06, re-confirmed rather than assumed stale. `toml`
(high, flagged 2026-09-21, PR #39 still open/unmerged) and the `@grpc/grpc-js`
auth-bypass (flagged 2026-10-01, PR #51, since self-critiqued for an
overstated reachability claim in PR #80, 2026-10-16) remain open from prior
nights — not re-litigated here, per Step 2's "don't rediscover a direction
already being tracked" rule. `radio-moe` itself — the one dependency ruClip's
own authorization code calls directly and unconditionally (`credential-issuer.ts`,
`actor-credential.ts`, `human-identity-attestation.ts`) — carries zero `npm audit`
findings.

### Prior art / comparable defect class

| Source | What it shows | Grade |
|---|---|---|
| [CWE-613 (MITRE/WASC), "Insufficient Session Expiration"](https://cwe.mitre.org/data/definitions/613.html) | Canonical weakness: a system that lets a session/credential remain valid longer than the design intends; mitigation is "set sessions/credentials expiration date" — the exact property this finding closes (a credential whose expiry a caller could inflate past the documented policy) | A (official) |
| [OAuth 2.0 Security Best Current Practice (RFC 9700 / draft-ietf-oauth-security-topics)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics.html) | Vendor-independent IETF guidance: access-token lifetime should be short and is a policy the *authorization server* sets, not something a client/caller-requested value should be trusted to self-limit — same shape of fix (server-side ceiling, not caller discretion) | A (official IETF BCP) |
| Vendor OAuth/OIDC best-practice docs (Gravitee, Airlock, mojoauth) cross-checked against the BCP above | Convergent, vendor-agnostic recommendation: short, server-enforced access-token lifetimes (minutes, not hours) specifically because a self-contained signed token (JWT-shaped, as ruClip's `ActorCredential` is) is honored until its embedded `exp`/`expiresAt` — matches this repo's own design rationale almost verbatim | B (aggregated/cross-checked, not single-source) |
| `paperclipai/paperclip` (named competitor, `dream.config.json`) | Directly comparable domain (agent-company governance platform with scoped credentials/approvals). Its credential-lifetime-enforcement internals were not inspectable within tonight's budget (no code-search access to a repo outside this session's GitHub scope) — flagged as an open comparison for a future night, not fabricated, same disclosed-gap discipline as 2026-09-06's competitor row | — (not reproducible tonight, no claim made) |
| This repo's own 2026-09-06 security night (`docs/dream-cycle/2026-09-06-security-report.md`, PR #15, merged) | Direct internal precedent: the exact same surface (ActorCredential issuance/verification), the exact same "fail closed before any side effect" discipline this fix follows (the new ceiling check runs before `loadIssuerKeypair`/Secret Manager, same ordering principle as that night's atomic-nonce fix running before any AgentDB write) | A (primary source, this repo, already human-reviewed once) |

## Frozen hypothesis (frozen before evaluation began)

> Given ruClip's `mintActorCredential`/`mintHumanActorCredential` — the only
> two code paths that ever sign a short-lived `ActorCredential` — when a
> caller-supplied `ttlSeconds` is checked against the design's own documented
> policy ceiling (`ACTOR-IDENTITY-VERIFICATION.md`'s "short TTL, default 15
> min", the stated mitigation for not having mid-lifetime credential
> revocation) and minting is made to fail closed for any `ttlSeconds`
> exceeding that ceiling, then a request for a longer-lived credential should
> be refused at mint time — relative to the current baseline, which accepts
> any numeric `ttlSeconds` with no upper-bound check and silently mints a
> longer-lived credential — subject to: the existing default-TTL (900s)
> issuance path, and the existing negative/short-TTL test usage (used to
> produce an already-expired credential for `verifyActorCredential`'s own
> expiry test), remain unaffected, and zero regressions across the full test
> suite.

Not modified after evaluation began.

## Candidate

One conceptual change (a fail-closed upper-bound check on credential TTL, at
the one place credentials are minted), applied at its single occurrence —
`mintHumanActorCredential` already forwards its own `opts` straight into
`mintActorCredential` (see that file's existing code), so one check point
covers both issuance paths; grep confirms these are the only two functions
in this codebase that ever construct a signed `ActorCredential`.

- `src/control-plane/authorization/credential-issuer.ts` — new exported
  `MAX_TTL_SECONDS` constant (= `DEFAULT_TTL_SECONDS`, 900s) and a check in
  `mintActorCredential`, moved **before** `loadIssuerKeypair`/the dynamic
  `radio-moe` import so an out-of-policy request never touches the GCP
  Secret Manager shell-out or signs anything
- `tests/control-plane/actor-identity-verification.test.ts` — 2 new tests:
  one proving a `ttlSeconds` one second over the documented ceiling is
  rejected, one proving minting still succeeds exactly at the ceiling
  (boundary case, guards against an off-by-one in either direction)

Diff size: 2 files, +31/-1 lines — well within the <300-line target, one
conceptual change. No existing test, assertion, or benchmark was modified or
removed.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`),
this repo's real, only test entrypoint. No LLM calls in this evaluation —
deterministic unit/integration tests only (`node:test`). No `OPENROUTER_API_KEY`
check was needed; nothing in tonight's finding requires a model call
(`LLM_EVAL=not-needed`).

**Baseline** (current HEAD, `6e73a8f060bcbb69965a50ffe4627e33622d4094`, guard
unfixed, new tests present — isolated via `git stash push -- src/control-plane/authorization/credential-issuer.ts`
so only the source fix, not the tests, was reverted):
```
tests 329
pass 328
fail 1
```
The 1 failure is exactly the one the hypothesis predicts:
`mintActorCredential rejects a ttlSeconds exceeding the documented policy
ceiling` — `Missing expected rejection (ActorIdentityVerificationError)` —
confirming the baseline silently mints a credential whose requested TTL
exceeds the design's own stated 15-minute exposure-window mitigation.

Full baseline output saved (this session's scratch dir, `/tmp/baseline-test-output.txt`).

**Candidate** (fix restored via `git stash pop`):
```
tests 329
pass 329
fail 0
```
0 regressions. The 1 baseline failure flips to pass; the boundary test
(`ttlSeconds` exactly at the ceiling still mints successfully) also passes,
ruling out an off-by-one in the new check. Full candidate output saved
(`/tmp/candidate-test-output.txt`).

Install used for every run above: `npm ci` (exact, lockfile-matching
install — no `|| true` fallback of any kind). `npm run build` (bare `tsc`)
and `npm run lint` (no-op, scaffold stage — unchanged by this candidate) both
still succeed. `npm run harness:mcp-scan` → `{"mcpEnabled": false, "worst":
"info"}` — unchanged, ruClip registers no MCP server of its own.

## Darwin

Skipped, deliberately — same judgment call as 2026-09-06's night. This is a
binary correctness/policy-conformance fact ("the ceiling the design already
names in prose is enforced in code, or it isn't"), not a continuous parameter
to search over; `MAX_TTL_SECONDS` is set to the design document's own already-
chosen value (900s), not a tunable this candidate invented. There is nothing
for an evolutionary search to explore that reading `ACTOR-IDENTITY-
VERIFICATION.md`'s own text didn't already settle.

## Evidence

- OBSERVATION: `mintActorCredential` (`credential-issuer.ts`) and
  `mintHumanActorCredential` (`human-identity-attestation.ts`, which forwards
  straight into the former) accepted any numeric `opts.ttlSeconds` with no
  upper-bound check (read, both files, pre-fix).
- OBSERVATION: `ACTOR-IDENTITY-VERIFICATION.md` §8 states the short (15 min)
  TTL is this design's explicit mitigation for not having mid-lifetime
  credential revocation — read directly from the committed design doc, not
  assumed.
- MEASUREMENT: baseline `npm test` — 328/329, the 1 predicted failure,
  captured to a saved receipt.
- MEASUREMENT: candidate `npm test` — 329/329, 0 regressions, boundary case
  included.
- INFERENCE: every current call site (CLI `login()`, `mintHumanActorCredential`'s
  own default, every test fixture bar the deliberate `ttlSeconds: -1` expiry
  cases) already requests exactly the 900s default or less — confirmed by
  grep across `src/` and `tests/` — so this fix changes behavior for zero
  existing callers; it only closes the gap for a future caller (a new CLI
  flag, a future HTTP API) that would otherwise silently violate the policy.
- DECISION: enforce the ceiling once, at the single shared mint function,
  before any Secret Manager/network/signing work — not duplicated into
  `mintHumanActorCredential` (which has no independent ttlSeconds path) and
  not added to the verify side (the trust model already restricts signing to
  the one durable issuer key this same function controls, so a second check
  at verify time would be redundant with, not additional to, this one).
- REJECTION: none this cycle (the fix was singular and correct on first
  evaluation; no alternative candidate was implemented and discarded).

## Reward-hack / adversarial critique (independent pass over the candidate)

- Weakened the benchmark/tests? No — 2 tests added, 0 removed, 0 skipped, 0
  existing assertions altered.
- Altered gold answers/evaluator internals? No — no gold data or evaluator
  code exists for this repo's test suite; nothing of that kind touched.
- Cherry-picked a favorable metric? No single metric was picked; the whole
  suite (329 tests) is the evaluator, run twice (baseline, candidate), output
  not filtered.
- Exploited the evaluator or relied on an undocumented cache? No — both new
  tests are plain `assert.rejects`/`assert.ok` calls through the mock bridge
  fixture already used by every other test in this file; no timing
  dependence, no cache dependence.
- Hid cost? No — the fix *removes* work on the rejected path (fails before
  the Secret Manager shell-out and the dynamic `radio-moe` import run at
  all), a strict cost reduction for invalid requests, no new dependency.
- Touched a threshold? Yes, by design — `MAX_TTL_SECONDS` is a genuinely new
  enforcement point, but its value is copied from the design document's own
  pre-existing, already-documented 900s default, not invented or tuned by
  this candidate, and it does not touch `DEFAULT_TTL_SECONDS` or any existing
  threshold (the expiry check in `verifyActorCredential` is untouched).
- Corpus/mock sanity check: no corpus exists for this surface (pure unit
  tests over real `radio-moe` signing, same pattern the 2026-09-06 night
  already established as sound); nothing to go soft.

Critic verdict: no unresolved reward-hack signal.

## Security review (Step 15)

- **Prompt injection**: n/a — no LLM calls, no external untrusted text
  processed by this candidate.
- **Tool/MCP authority**: no new tool/MCP call added. The fix *removes* a
  Secret-Manager/`radio-moe`-import round trip for requests it now rejects
  up front — a strict narrowing of what gets reached for an invalid
  request, not a widening of authority anywhere.
- **Credential exposure**: unrelated to key handling — `loadIssuerKeypair`'s
  own no-log/no-disk-persist discipline is untouched; this candidate only
  adds a check that runs *before* that function is ever called for an
  out-of-policy request.
- **Filesystem/network scope**: narrowed, not widened, for the rejected
  path; unchanged for every accepted (in-policy) request.
- **Agent/human impersonation / cross-agent poisoning**: directly
  strengthens the one mitigation `ACTOR-IDENTITY-VERIFICATION.md` names for
  the accepted risk of no mid-lifetime revocation — an attacker who captures
  a credential in flight is now guaranteed it cannot outlive the documented
  15-minute ceiling, regardless of what `ttlSeconds` a future caller might
  (accidentally or otherwise) request.
- **Least privilege**: no MCP tool permissions changed.

## Scan findings

**dependencies**: `npm audit` now reports 54 findings (2 critical, 23 high,
29 moderate), up from 39 (1 critical, 14 high, 24 moderate) on 2026-09-06.
The new critical, `proxy-addr` (CVE-class IP-spoofing via IPv4-mapped IPv6
trust-subnet confusion), traced via `npm ls proxy-addr --all` to
`ruflo → @claude-flow/cli → express` — not imported by ruClip's own
`src`/`services` code (confirmed by `grep`), same out-of-process-sidecar
exposure shape as every prior dependency finding on this surface. Also
specifically checked tonight because it resolves as a **top-level** sibling
rather than purely nested: `ruvector@0.3.0` (a non-optional peerDependency)
and the `@modelcontextprotocol/*` family of high findings it pulls in — `grep`
across `src/`/`services/` confirms zero direct imports of `ruvector` or
`@modelcontextprotocol/*` anywhere in ruClip's own code; the exposure stays
indirect. Not independently fixable from inside this repo tonight (no in-range
vendor fix for most of the 54); `toml` (PR #39) and `@grpc/grpc-js` (PR #51,
reachability claim since corrected by PR #80) remain open from prior nights
and are not re-litigated here.

**secrets**: no hardcoded secrets, API keys, or private-key material found in
tracked source. The only `BEGIN PRIVATE KEY` matches in a repo-wide grep are
in `services/ruclip-attester/tests/signing-key.test.ts` and
`tests/support/actor-credential-fixture.ts` — synthetic, clearly-named
test-only Ed25519 fixture keys (same two files, same conclusion as the
2026-09-06 night). `credential-issuer.ts`, `signing-key.ts`, and every GCP
Secret Manager / `gcloud` shell-out path still read secrets transiently at
call time only, never log or persist them. `.gitignore` clean. No change
needed; recorded as a clean scan, not a null result.

## Process note (not tonight's DEEP candidate, carried forward from prior nights)

`gh`/GitHub MCP access this session (`FALLBACK=false`) surfaced the scale of
a known, already-repeatedly-flagged problem: **29 open, unmerged `dream-cycle`
PRs (#29–#88), 0% merge rate**, spanning 2026-09-16 through 2026-10-20 — this
is not a new finding (issues #34/PR#35 "09-19", #47 "09-29", #72 "10-12", #74
"10-13", #84/#86 "10-18/10-19" already documented it from several angles) and
is not re-investigated or re-litigated here per Step 2's rule against
rediscovering a tracked direction. Flagged again only because it directly
shaped tonight's candidate-selection bias (Step 1.1: "zero of last 14 merged
→ bias toward tiny, single-param, easily-reviewable candidate") — this is
why tonight's fix is a 2-file, +31/-1-line, single-boolean-condition change
rather than a larger refactor. The backlog includes at least two *security*
fixes with real severity (`protobufjs` critical RCE, PR #29; `@grpc/grpc-js`
auth-bypass, PR #51) sitting unreviewed for 5+ weeks — a human-review
bottleneck this session has no authority to resolve (it never merges), but
one worth a human's direct attention independent of tonight's own finding.

## Witness

```
REPORT_HASH    = 8661f27347798563886e13be895ca78f41c451186f58bc444f5900be162b5a8e
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 48977587edf1a1ae79ab16ca8280eb4d1de58078443aec17c35304abc649a1a2
```

`REPORT_HASH` is the sha256 of this file's content up to (and including) the
line directly above this Witness section — i.e. everything before `## Witness`
itself. `WITNESS = sha256(REPORT_HASH || SESSION_COMMIT)`, computed as
`printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text (`docs/dream-cycle/2026-10-21-security-report.md`) up to the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. Independently re-run `npm test` against the PR branch's HEAD and confirm 329/329 (0 fail) — the receipt this report claims.

## Recommendation

1. **Merge this fix** (draft PR) — closes a real gap between
   `ACTOR-IDENTITY-VERIFICATION.md`'s documented security model (short TTL as
   the stated mitigation for no mid-lifetime revocation) and what the code
   actually enforced. No live exploit path today (every current call site
   already requests the 900s default or less), but the one safety net the
   design leans on was not wired in — low risk, 2-file diff, 329/329 green,
   zero behavior change for any existing caller.
2. **Address the human-review backlog directly** — 29 open dream-cycle PRs,
   0% merge rate, including two unreviewed security fixes (critical
   `protobufjs` RCE, `@grpc/grpc-js` auth-bypass) open for 5+ weeks. This is
   outside this session's authority (no self-merge) and already tracked by
   prior nights' own meta-findings (#34, #47, #72, #74, #84, #86) — raised
   again here only as a recommendation for direct human attention, not as a
   new candidate.
3. **Re-verify the `proxy-addr`/CVE-2026-class critical advisory range**
   next time this surface comes up, the same way 2026-09-06 flagged
   `protobufjs`'s advisory range as worth a direct GHSA/CVE cross-check —
   tonight's reachability tracing was done, but the advisory's precise CVE
   mapping was not independently re-verified against NVD.
