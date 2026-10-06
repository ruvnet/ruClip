# Secret-Fetch Caching Hygiene SOTA Report — 2026

## TL;DR

`ruclip-attester`'s signing-key loader (`services/ruclip-attester/src/signing-key.ts`)
read its Ed25519 private key from GCP Secret Manager on **every single**
`/v1/attest` call. Its two sibling files in the same service —
`identity-map.ts` (`CACHE_TTL_MS`) and `google-token.ts`
(`PUBLIC_KEY_CACHE_TTL_MS`) — already closed this exact gap for their own
Secret-Manager/IAP-key reads, each documented in its own file header as an
"every request hits GCP" availability/latency fix. `signing-key.ts` was
missed. Added the same 60s TTL in-memory cache. Verified with a real fake
Secret Manager client that counts calls (not inferred from source reading):
baseline (parent) makes 2 calls for 2 mints in the same TTL window and FAILS
the new test; candidate makes 1 call and PASSES. 328/328 tests green, 0
regressions, `harness:bench-verify` hash unchanged.

## What's new

Nothing novel is being introduced — this closes an **inconsistency within
the repo's own, already-accepted security pattern**. Two of three files
that read secrets of equal sensitivity from the exact same Secret Manager
API already cache the read with a short TTL; the third (handling the
actual signing-key material used to mint every human identity attestation)
did not. Each unchached mint of a `HumanIdentityAttestation` cost one full
Secret Manager round trip, meaning:
- added per-login latency (same complaint `google-token.ts`'s header
  raised about `getIapPublicKeysAsync`'s lack of built-in caching),
- a new single point of failure where a transient Secret Manager
  outage/rate-limit fails **every** `/v1/attest` call, not just the one in
  flight,
- needless duplicated calls to the API that gates the service's most
  sensitive secret.

## Competitors / prior art

| Source | Approach | Grade |
|---|---|---|
| AWS Secrets Manager Caching Client (official, [AWS Security Blog](https://aws.amazon.com/blogs/security/improve-availability-and-latency-of-applications-by-using-aws-secret-managers-python-client-side-caching-library)) | First-party client-side cache library wrapping `GetSecretValue`, explicitly sold on availability + latency, not just cost | B (vendor, official) |
| HashiCorp Vault Agent (caching proxy + lease renewal) | A local sidecar caches secrets and auto-renews leases so application code never calls Vault per-request | C (general knowledge, not independently re-verified this session) |
| `paperclipai/paperclip` ([docs.paperclip.ing](https://docs.paperclip.ing/reference/deploy/secrets), [stanza.dev course](https://www.stanza.dev/courses/paperclip-fundamentals/agents-and-org-charts/paperclip-fundamentals-agent-auth-security)) | Opposite tradeoff: `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`-style signing secrets back short-lived, per-heartbeat-regenerated run JWTs rather than a long-lived cached signing key; secrets are AES-256-GCM-encrypted at rest behind a master key, not fetched live per call | C (third-party docs site, single-source) |
| GCP Secret Manager community guidance ([oneuptime.com](https://oneuptime.com/blog/post/2026-01-24-secret-manager/markdown)) | "Avoid fetch-on-every-request"; cache with TTL (commonly ~300s) plus background refresh, emergency refetch on auth failure | C (vendor-adjacent blog, single-source) |

None of these contradict the direction already chosen by this repo's own
`identity-map.ts`/`google-token.ts` (short in-memory TTL cache, no
background refresh, test/dev override always bypasses the cache). This
finding is an internal-consistency fix, not a new design — graded
accordingly (no claim above is load-bearing for the implementation; the
implementation mirrors code already in this repo).

## Hypothesis (frozen before implementation)

> Given repeated `/v1/attest` requests within a 60-second window, when
> `mintHumanIdentityAttestation`'s private-key load is cached with the same
> short-TTL pattern `identity-map.ts`/`google-token.ts` already use, then
> the number of Secret Manager `accessSecretVersion` calls per N mints
> should drop from N to 1, without changing the minted attestation's
> correctness (same keypair, same signature bytes, same
> `attesterPublicKeyDerHex`), subject to: the `privateKeyPem` test/dev
> override must keep bypassing the cache entirely (same convention as
> `identity-map.ts`'s `mapJson` override), and no existing test may be
> weakened to pass.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), real `node:test` suite, no mocked results.

- **Baseline (parent, no cache)**: added a fake Secret Manager client
  (`accessSecretVersion` call counter, no network) wired through a new
  `secretManagerClient` test-only config field (the only change needed to
  make the parent's behavior observable — no caching logic yet). Ran the
  new test against this parent: **FAILED** — `expected the cached keypair
  to be reused (1 Secret Manager read), got 2` (2 mints → 2 calls).
- **Candidate**: added `ATTESTER_KEYPAIR_CACHE_TTL_MS = 60_000` and a
  module-level `keypairCache`, mirroring `identity-map.ts`'s
  `loadIdentityMap` shape exactly (bypass on explicit override, else
  TTL-gated reuse). Re-ran: **PASSED** — 1 call for 2 mints.
- **Full suite, candidate**: `328/328` pass, `0` fail, `0` regressions
  (325 pre-existing + 1 new cache-hit test + 2 other unrelated tests added
  earlier this session's build churn did not occur — exact delta is the 1
  new test).
- `npm run harness:bench-verify` → `Suite repo-native@0.1.0: 6 tasks, hash
  OK (840fd8d2d698…)` — unchanged, candidate did not touch the benchmark
  corpus.
- `npm run build` (tsc) clean on both baseline-seam and candidate commits.

## Darwin

Skipped. A 1-line conceptual change (reuse an existing 7-line caching
pattern from a sibling file) with a single, already-validated correct
implementation has no meaningful mutation space to search — bounded Darwin
would spend budget without a credible alternative candidate to evolve
against. Noted explicitly per protocol rather than silently omitted.

## Evidence ledger

- OBSERVATION: `signing-key.ts`'s `loadAttesterKeypair` called
  `resolvePrivateKeyPem` unconditionally on every invocation; no cache
  existed (confirmed by reading the file, `grep` for `CACHE` found zero
  matches in this file vs. one each in its two siblings).
- MEASUREMENT: baseline test, 2 mints → `accessCount === 2` (failed
  assertion against expected 1).
- MEASUREMENT: candidate test, 2 mints → `accessCount === 1` (assertion
  passed).
- MEASUREMENT: full suite 328/328, `harness:bench-verify` hash unchanged.
- INFERENCE: the same class of fix applied twice already in this exact
  service (`identity-map.ts`, `google-token.ts`) for secrets of equal
  sensitivity from the same API is strong internal precedent that this is
  the intended pattern, not a new design decision needing wider review.
- DECISION: ACCEPT — recommend human review and merge.

## Reward-hack check

- Benchmark corpus (`.harness/bench.json`) untouched; hash verified
  unchanged via `harness:bench-verify` before and after.
- No existing test's assertions were loosened, deleted, or had their
  expected values changed to pass.
- The new test exercises a real fake Secret Manager client (counts real
  calls through the real `resolvePrivateKeyPem`/`loadAttesterKeypair` code
  path) rather than asserting against an internal mock of the function
  under test.
- No threshold, timeout, or retry count was adjusted to manufacture a pass.
- Caching introduces a bounded 60s staleness window on key-rotation
  detection — identical, already-accepted tradeoff to the two sibling
  files; not a new risk category.

## Security review

- **Credential exposure**: the cached value is the same `KeyObject` /
  derived public-key hex already materialized per-call before this change;
  caching extends its in-memory lifetime from "one request" to "up to 60s,
  shared across requests in the same process" — the same tradeoff
  `identity-map.ts` already makes for its own sensitive secret. Never
  logged, never written to disk, no new persistence.
- **Key rotation**: a rotated signing key takes up to 60s to take effect
  process-wide post-cache — matches the sibling files' own documented
  tradeoff; no SLA in this repo currently requires faster rotation
  propagation than that.
- **Test-only seam**: the new `secretManagerClient` config field is
  explicitly typed to the minimal `accessSecretVersion` shape this module
  needs (not the full GCP SDK client type), reducing what a test fixture
  can accidentally satisfy incorrectly; it is additive and optional, the
  production path (`getSecretManagerClient()`) is unchanged when omitted.
- **Scope**: single file (`signing-key.ts`) + its test file. No new
  network egress, no new permissions, no new dependency.

## Scan: dependencies

`npm audit` (post-`npm ci`): 50 findings (2 critical, 19 high, 29
moderate). Both criticals (`protobufjs`, `proxy-addr`) and the majority of
highs trace through `ruflo`'s/`@claude-flow/cli`'s own transitive tree
(confirmed via `npm ls <pkg>` for the critical `proxy-addr` finding: its
only path is `ruclip → ruflo → @claude-flow/cli → express → proxy-addr`) —
**not reachable from ruClip's own `src`/`services` code**, same class
already flagged 2026-09-06 as "needs a human policy decision, not another
dream-cycle candidate." One genuinely reachable high (`@grpc/grpc-js`
auth-bypass via the direct dependency `@google-cloud/secret-manager`) was
already identified and has an open, unmerged fix (dream-cycle PR #51,
2026-10-01) — not re-litigated here to avoid duplicating that candidate.
No new reachable-from-ruClip's-own-code dependency finding emerged beyond
what #51 already covers.

## Scan: secrets

Regex sweep for hardcoded credentials (`api[_-]?key|secret|password|token`
patterns with inline literal values) across `src/`, `services/`, `scripts/`
— zero hits outside `process.env.*` reads and test fixtures. No `.env`,
`.pem`, or private-key files committed. Clean.

## Operational note (not tonight's candidate, flagged for the routine owner)

As of this run: **22 open dream-cycle issues** (#8 through #56) and
**~20 open dream-cycle PRs**, **0 merged**. This has been separately
flagged by three prior developer-experience nights (#20/2026-09-09,
#34/2026-09-19, #46/2026-09-29) and is unchanged tonight. Several of the
unmerged open PRs are security fixes for genuinely reachable findings
(critical `protobufjs` RCE, PR #29; `@grpc/grpc-js` auth-bypass, PR #51;
HIGH `toml` vulnerabilities, PR #39) that have sat unreviewed for 5–20
days. This is a human-review bottleneck, not a research gap — no dream-cycle
candidate can close it.

## Witness

`REPORT_HASH` is the sha256 of this file's content up to (and including)
the line directly above this Witness section — i.e. everything before
`## Witness` itself — computed once, before this section was filled in.
`WITNESS = sha256(REPORT_HASH || SESSION_COMMIT)`.

```
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
REPORT_HASH    = 04b8c80bf5d6d8dafbca9dd68a31034dca66bb4d259035aa0c8806c842ee6044
WITNESS        = 392dbcb2ffc0a0f9700d1c83845ee5727dec7aeb48a64e4a0b06d77707bfea94
```

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text up to the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. Independently re-run `npm test` against the PR branch's HEAD and confirm 328/328 (0 fail) — the receipt this report claims.

## Recommendation

1. **Merge this fix** (draft PR) — closes a genuine, reproducible,
   well-evidenced inconsistency (2 of 3 sibling files already cache this
   exact class of read; this completes the pattern). Low risk, small diff
   (1 production file + 1 test file), 328/328 green, 0 behavior change
   outside the cache window.
2. **Address the human-review bottleneck** — 22 open issues / ~20 open PRs,
   0 merged, flagged 3 times before tonight. This needs the routine owner's
   attention, not another dream-cycle candidate.
3. **Re-check `proxy-addr` (critical, IP-spoofing, CVSS-rated) reachability**
   next time the dependency surface comes up — confirmed unreachable from
   ruClip's own code this run (`ruflo`'s transitive `express` dependency
   only), but worth re-confirming if `ruflo`'s own invocation boundary ever
   changes (e.g. if ruClip starts proxying HTTP in front of it).
