# Secret-Fetch Caching Hygiene (Issuer Key) SOTA Report — 2026

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`
**Rotation**: SLOT=3 → DEEP=performance, SCAN=memory,latency (2026-10-28, DAYINT=20261028, DAYINT%25=3, no bonus)

## TL;DR

`src/control-plane/authorization/credential-issuer.ts`'s `loadIssuerKeypair`
resolved ruClip's own issuer signing key on **every single**
`mintActorCredential`/`resolveAdmittedIssuerKeys` call — when no
`privateKeyPem` test override is given, that means shelling out to the
`gcloud secrets versions access` CLI (a full subprocess spawn) on every
call, with no cache at all. This is the exact same class of gap dream-cycle
PR #59 (2026-10-06, still open/unmerged) already fixed in a sibling file,
`services/ruclip-attester/src/signing-key.ts`, whose own report found that
fix was itself completing a pattern two *other* sibling files
(`identity-map.ts`, `google-token.ts`) already used. PR #59's report never
inspected `credential-issuer.ts` — a fourth sibling with the same missed
pattern, and a worse baseline cost (subprocess spawn, not an SDK call).
Added the same short-TTL in-memory cache. Verified with a real fake
secret-accessor that counts calls (not inferred from source reading):
baseline (parent + test seam only, no cache) makes 3 calls for 2 mints + 1
admitted-key resolution and **fails** the new discriminating test; candidate
makes 1 call and **passes**. 327→328 tests, 0 regressions,
`harness:bench-verify` hash unchanged. A simulated-latency micro-benchmark
(N=20 mints, 180ms/secret-read) measured 3655.6ms → 234.5ms (15.6x).

## What's new

Nothing externally novel — this is the identical, already-internally-accepted
caching pattern applied to a fourth sibling call site. What's new is the
site itself: `credential-issuer.ts` was never inspected by the 2026-10-06
night's own research (its report's "sibling files" language names
`identity-map.ts` and `google-token.ts` only), even though
`credential-issuer.ts`'s own file header explicitly calls `signing-key.ts`
structurally parallel ("Same real `radio-moe` signing-contract reproduction
as `credential-issuer.ts`" — `signing-key.ts`'s header, reversed in
`credential-issuer.ts`'s own header). The two files were written in
deliberate parallel and only one got the caching fix proposed against it.

## Competitors (graded)

| Competitor | Relevant to tonight's finding | Grade |
|---|---|---|
| AWS Secrets Manager Caching Client ([AWS Security Blog](https://aws.amazon.com/blogs/security/improve-availability-and-latency-of-applications-by-using-aws-secret-managers-python-client-side-caching-library)) | First-party client-side cache wrapping `GetSecretValue`, explicitly sold on availability + latency, not just API cost — same rationale as tonight's fix | B (vendor, official) |
| HashiCorp Vault Agent (caching proxy + lease renewal) | A local sidecar caches secrets so application code never calls Vault per-request; same "don't re-fetch a signing secret per call" principle, applied at infra layer rather than in-process | C (general knowledge, not independently re-verified this session) |
| `paperclipai/paperclip` ([docs.paperclip.ing](https://docs.paperclip.ing/reference/deploy/secrets)) | Opposite tradeoff: signing secrets back short-lived, per-heartbeat-regenerated run JWTs rather than a long-lived cached signing key; secrets are encrypted at rest behind a master key, not fetched live per call | C (third-party docs site, single-source, cited identically in the 2026-10-06 report for the same technique family) |
| This repo's own `identity-map.ts` / `google-token.ts` / `signing-key.ts` (PR #59) | Three sibling files, same Secret-Manager-class read, already converged on the identical short-TTL in-memory cache shape independently — the strongest evidence for this exact pattern being this codebase's own accepted convention, not a new design decision | A (reproducible — this repo's own, already-merged-in-spirit-if-not-in-main code) |

## Hypothesis (frozen before implementation)

> Given repeated `mintActorCredential`/`resolveAdmittedIssuerKeys` calls
> within a 60-second window against the same issuer secret, when
> `credential-issuer.ts`'s `loadIssuerKeypair` is given the same short-TTL
> in-memory cache `services/ruclip-attester/src/signing-key.ts` already uses
> for its sibling secret (dream-cycle PR #59, 2026-10-06, itself mirroring
> `identity-map.ts`/`google-token.ts`), then the number of `gcloud secrets
> versions access` subprocess invocations per N calls should drop from N to
> 1 (and real wall-clock latency should drop proportionally — a subprocess
> spawn is strictly slower than the SDK-based reads the three already-cached
> siblings make), without changing the minted/resolved keypair's correctness
> (same private key material, same signature bytes, same
> `issuerPublicKeyDerHex`), subject to: the `privateKeyPem` test/dev override
> must keep bypassing the cache entirely (same convention as the three
> sibling files), and no existing test may be weakened to pass.

Not modified after evaluation began.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), real project test runner, no mocked evaluator.

| | Tests | Pass | Fail | tsc --strict | Benchmark hash |
|---|---|---|---|---|---|
| Baseline (`6e73a8f` + test seam only, no cache) | 328 | 327 | 1 | clean | `840fd8d2d698…` (unchanged) |
| Candidate (this branch) | 328 | 328 | 0 | clean | `840fd8d2d698…` (unchanged) |

Discriminating regression test (new):
`mintActorCredential reuses the issuer secret read across calls within the
cache TTL, and privateKeyPem always bypasses it` in
`tests/control-plane/credential-issuer-caching.test.ts`. Adds a minimal,
narrow `IssuerKeyConfig.secretAccessor` test seam (mirrors PR #59's
`secretManagerClient` seam) that replaces the real `gcloud` shell-out with a
call-counting fake while still exercising the real `resolvePrivateKeyPem`/
`loadIssuerKeypair` code path.

- **Run against parent + seam only** (no caching logic): **FAILS** —
  `expected the cached issuer keypair to be reused (1 secret read for 3
  calls), got 3` (2 `mintActorCredential` calls + 1 `resolveAdmittedIssuerKeys`
  call → 3 independent secret reads). Proves the parent is genuinely
  uncached and that the new test has discriminating power.
- **Run against candidate**: **PASSES** — 1 secret read for the same 3 calls;
  a second test assertion in the same test also confirms a direct
  `privateKeyPem` override still bypasses the now-warm cache entirely and
  derives its own distinct keypair, with the counter unchanged.

Simulated-latency micro-benchmark (not the shipped test suite; a throwaway
script, `/tmp/.../bench-credential-issuer.mjs`, deleted after this run):
`secretAccessor` sleeps 180ms (a conservative low-end estimate for a real
`gcloud` CLI subprocess spawn — Node's own SDK-based Secret Manager reads in
this same codebase's sibling files measure far lower), then 20 sequential
`mintActorCredential` calls:

| | N=20 mints, 180ms/secret-read | ms/mint avg |
|---|---|---|
| Baseline (no cache) | 3655.6ms | 182.8ms |
| Candidate (cached) | 234.5ms | 11.7ms |

15.6x at N=20. The win scales with N within the 60s TTL window (bounded
below by one real secret read, however many calls land inside the window).

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (this session's
starting commit), with only the minimal, additive `secretAccessor` test seam
applied (no caching logic) — evaluated on the real `npm test` entrypoint to
prove the new test's discriminating power before any candidate logic
existed.

## Darwin Lineage (bounded)

Skipped, for the same reason PR #59's own report gave for the identical
situation: a 1-line conceptual change (reuse an already-validated,
already-converged-upon caching pattern from three sibling files, applied to
a fourth) has no meaningful mutation space to search — there is exactly one
correct shape for this fix (short-TTL cache, override bypasses it), not a
family of candidates to evolve between. Noted explicitly rather than
silently omitted.

## Evidence

- OBSERVATION: `credential-issuer.ts`'s `loadIssuerKeypair` called
  `resolvePrivateKeyPem` unconditionally on every invocation; no cache
  existed (confirmed by reading the file — `grep -n "cache\|Cache"` found
  zero matches in this file before tonight, vs. one match each in
  `identity-map.ts`, `google-token.ts`, and `signing-key.ts`).
- OBSERVATION: `resolvePrivateKeyPem`'s real (non-override) path shells out
  to the `gcloud` CLI via `execFile` — a full subprocess spawn, structurally
  slower than any of the three already-cached siblings' SDK-based reads.
- MEASUREMENT: baseline (parent + seam) test run — 3 secret reads for 3
  calls (fails the `=== 1` assertion). Candidate's same run — 1 secret read
  for 3 calls (passes). Full suite: 327/328 (baseline, 1 new-test failure,
  0 pre-existing regressions) → 328/328 (candidate).
- MEASUREMENT: simulated-latency sweep (N=20, 180ms/read): baseline
  3655.6ms; candidate 234.5ms (15.6x).
- MEASUREMENT: `npm run harness:bench-verify` → hash `840fd8d2d698…`
  unchanged before and after.
- INFERENCE: this is a real, structural latency win (not a mocked-away
  cost) because the parent's per-call secret read was proven uncached
  empirically (call-counting fake), not assumed from reading the code, and
  three sibling files in this exact codebase already independently
  converged on the identical fix for secrets of equal sensitivity from
  adjacent APIs — strong internal precedent this is the intended pattern.
- DECISION: ACCEPT, recommended for human review.

## Reward-Hack Check

- Benchmark corpus (`.harness/bench.json`) untouched; hash verified
  unchanged via `harness:bench-verify` before and after.
- No existing test's assertions were loosened, deleted, or had expected
  values changed to pass; the only test-suite change is one new, additive
  test file.
- The new test exercises the real `resolvePrivateKeyPem`/`loadIssuerKeypair`
  code path through a minimal, narrowly-typed `secretAccessor` seam (a
  single `() => Promise<string>`), not an internal mock of the function
  under test — mirrors PR #59's `secretManagerClient` seam exactly in
  spirit and narrowness.
- No threshold, timeout, or retry count was adjusted to manufacture a pass.
- The cache is a single, un-keyed 60s TTL slot — the same tradeoff the three
  sibling caches already make, not a new risk category. It is correct for
  this codebase's actual deployment shape (one issuer secret, named by two
  fixed env vars, for the life of the process) but would silently serve a
  stale/wrong keypair for 60s if `secretName`/`secretProject` ever varied
  across calls within that window — flagged explicitly as a known, inherited
  limitation (see Security Review), not hidden.
- Independent adversarial pass (this session, separate from implementation):
  re-read the diff specifically for the cross-test cache-leakage failure
  mode (module-level state outliving a single test) before finalizing the
  test — the first draft of the test suite's second case silently inherited
  a warm cache from the first and read as a false negative; caught and
  fixed by merging both assertions into one test with an explicit ordering
  comment, rather than weakening either assertion. No unresolved signal.

## Security Review

- **Credential exposure**: the cached value is the same `KeyObject` /
  derived public-key hex already materialized per-call before this change;
  caching extends its in-memory lifetime from "one call" to "up to 60s,
  shared across calls in the same process" — identical tradeoff to
  `identity-map.ts`/`google-token.ts`/`signing-key.ts`. Never logged, never
  written to disk, no new persistence.
- **Key rotation**: a rotated issuer key takes up to 60s to take effect
  process-wide post-cache — matches the sibling files' own documented
  tradeoff; no SLA in this repo currently requires faster rotation
  propagation than that.
- **Cache-key scope (known, inherited limitation)**: the cache is not keyed
  by `secretName`/`secretProject`, matching all three sibling caches exactly
  — correct because this process has exactly one issuer secret for its
  entire lifetime (two fixed env vars), but would be wrong if that ever
  changed. Not fixed tonight (would diverge from the established,
  already-accepted sibling pattern for a risk this deployment doesn't have);
  flagged as a next step if multi-issuer-key support is ever added.
- **Test-only seam**: `secretAccessor` is typed to the minimal
  `() => Promise<string>` shape, narrower even than PR #59's
  `SecretVersionReader` interface — it cannot accidentally satisfy a wider
  surface. Additive and optional; the production path (`execFileAsync`
  against the real `gcloud` CLI) is unchanged when omitted.
- **Scope**: one production file (`credential-issuer.ts`) + one new test
  file. No new dependency, no new network egress, no new permission.

## Scan Findings

**memory**: The cache holds exactly one `IssuerKeypair` (a `KeyObject` +
a hex string) at a time, bounded and tiny, released/replaced on the next
cold read after 60s — no growth, no new collection, no unbounded structure.
Checked the three sibling caches for the same shape (all single-slot, not
a growing map) — consistent.

**latency**: The finding itself — see TL;DR/Evaluation Receipt. Also
checked, while in this file, whether `mintActorCredential`'s two remaining
awaited steps (`loadIssuerKeypair`, `loadRadioMoeCanonicalBytes`) could be
run concurrently instead of sequentially: `loadRadioMoeCanonicalBytes` is a
dynamic `import()` that Node caches after the first call in-process (near-
instant on every call after the first), so parallelizing it against a
180ms+ `gcloud` read would save at most the cost of one cold `import()` —
not worth a separate candidate, and now moot on the hot path once
`loadIssuerKeypair` itself is cache-hit in under a millisecond.

## Competitors

See "Competitors (graded)" table above.

## Operational note (not tonight's candidate, flagged for the routine owner)

GitHub state as of tonight: **43 open dream-cycle issues** (#8 through #101)
and **dozens of open dream-cycle PRs going back to #60** (2026-10-07),
**0 merged** since PR #15 (2026-09-06). This exact bottleneck has now been
flagged by at least five prior developer-experience/architecture nights
(#20/2026-09-09, #34/2026-09-19, #46/2026-09-29, #71/2026-10-12,
#91/2026-10-22) and is unchanged tonight — not re-litigated here as tonight's
finding (that would be rediscovering an already-well-evidenced direction
with no new evidence), but worth stating plainly: this report, and PR #59's
before it, describe a genuinely reviewable, low-risk, high-confidence fix
that will keep sitting next to 40+ others until a human reviews the backlog.

## Gist

No gist-creation tool available in this session (GitHub MCP tools cover
issues/PRs/branches but not gist creation) — same constraint as 2026-09-02,
2026-09-03, and 2026-10-06. Full report committed at this file instead.
`GIST=LOCAL`.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not
including) the line `## Witness` above — i.e. delete this section and
everything after it, then hash what remains. This avoids the
self-referential-hash problem (a hash cannot include itself).

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `dc9a4ba64d71fb831719ef3f4b72e29b9af26fbbd02f1cd9ce829914caf7cbba`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `6e2a6b5a996b67aff995c46ea8053590217c9ca4de59f8a442e6082d434caf10`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm
   this is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-10-28-performance-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it matches the Witness stamp recorded in the ledger/issue/PR.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- . && npm ci && npm test` —
   confirm 327/327 pass (this commit's own baseline, before tonight's new test existed).
5. `git checkout dream/2026-10-28-performance -- . && npm test` — confirm
   328/328 pass, and `node --test dist/tests/control-plane/credential-issuer-caching.test.js`
   shows both assertions in the new test passing.

## Next steps (3)

1. **Resolve the human-review bottleneck.** 43 open issues, dozens of open
   PRs, 0 merged since 2026-09-06. No dream-cycle candidate — including this
   one — can close this; it needs the routine owner's attention.
2. **If multi-issuer-key support is ever added**, key this cache (and
   re-check the three sibling caches) by `secretName`/`secretProject` rather
   than relying on "exactly one issuer secret per process" — see Security
   Review's "known, inherited limitation."
3. **Re-run the simulated-latency benchmark against a real `gcloud secrets
   versions access` invocation** (this session had no authenticated `gcloud`
   available) to replace tonight's 180ms estimate with a measured figure —
   the direction and rough order of magnitude of the win do not depend on
   the exact constant, but a real number would strengthen the receipt.
