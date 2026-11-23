# Performance SOTA Report — 2026

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`
**Rotation**: SLOT=3 → DEEP=performance, SCAN=memory,latency (2026-11-18, DAYINT=20261118, DAYINT%25=18, no bonus)

## TL;DR

`bridge-auth.ts`'s `getIdentityToken` cached only the *resolved* Google OIDC
identity token, not the in-flight fetch itself. When the cache is cold
(first use, or a token just expired) and two or more `callTool` invocations
race for the same `(fetchImpl, audience)` pair — the normal shape of
concurrent control-plane operations against an IAM-protected bridge
(`auth: 'gcp-oidc'`) — every one of them independently calls
`fetchIdentityToken`, each issuing its own GCE-metadata-server round trip for
what is, by definition, the identical token value. The sibling file in the
same directory, `bridge-client.ts`'s `ensureHandshake`, already solves the
exact same cold-cache concurrent-call shape by caching the in-flight
`Promise<HandshakeState>` itself (its own header comment names this
explicitly: "caching the in-flight promise so concurrent first calls don't
double-initialize") — `bridge-auth.ts` just didn't follow the pattern its own
neighbor already established. Fixed by caching `Promise<CachedToken>` instead
of `CachedToken`, synchronously set before any await (same ordering
`ensureHandshake` uses), with the same fail-open-on-rejection discipline
(a failed fetch is evicted from the cache immediately so the next call gets a
fresh attempt, never a poisoned permanent rejection).

## What's new

Nothing externally novel — de-duplicating concurrent cache-miss fetches for
the same key ("in-flight promise memoization" / "request coalescing") is a
standard, textbook idiom. What's notable is that this exact idiom is already
present, named, and documented *in this same codebase, in the sibling file
`bridge-client.ts`, in the same directory* — making this an internal
consistency gap, not a newly-invented technique: one of two near-identical
caching problems in `store/` followed the established house pattern, the
other didn't.

## Competitors (graded)

| Competitor | Relevant to tonight's finding | Grade |
|---|---|---|
| This repo's own `bridge-client.ts` (`ensureHandshake`) | Directly comparable, already-merged-in-spirit (open, unmerged, but ACCEPTed) prior art for the identical cold-cache concurrent-call shape, in the same directory, same file-size/dependency-free-leaf discipline. Read in full tonight, not inferred. | A (directly verified by reading the file) |
| Node.js "promise memoization" / request-coalescing idiom (e.g. `p-memoize`, DataLoader's per-tick batching) | General pattern: cache the pending `Promise`, not the resolved value, so concurrent callers for the same key await one shared operation. Reproduced directly against this repo's own evaluator (see Evaluation Receipt), not only cited. | A (reproducible, verified against this repo's real test runner, both directions) |
| GCE metadata-server identity-token endpoint | Google's own guidance (Cloud Run/metadata-server docs) advises caching identity tokens client-side and avoiding unnecessary metadata-server calls under load, without specifying a concurrency-coalescing mechanism — the general "don't call the metadata server more than you have to" guidance is vendor-stated; the specific in-flight-promise technique is not Google-specific. | B (vendor documentation, cross-checked against this repo's own prior PR #104, which fixed an adjacent "re-reads a secret on every call" gap in `credential-issuer.ts` under the same general guidance) |
| Prior dream-cycle nights (#41/#43/#94/#102/#104/#115/#137) | Every merged-in-spirit performance PR to date fixes a sequential-await-in-a-loop shape, a cross-call missing-cache shape, or a cross-function duplicate-fetch shape (PR #137). None addresses a cross-*caller* cache-stampede shape (N concurrent callers racing one cold cache). Tonight's finding is the first of that specific shape in this repo's dream-cycle history. | A (directly verified by reading every one of those PRs' bodies/diffs tonight) |

## Hypothesis (frozen before implementation)

> Given N ≥ 2 concurrent callers of `resolveAuthorizationHeader`/
> `getIdentityToken` for the same `(fetchImpl, audience)` pair while
> `bridge-auth.ts`'s token cache is cold (missing or expired), when
> `getIdentityToken` caches the in-flight `Promise<CachedToken>` instead of
> only the resolved value, then the number of `fetchIdentityToken` calls to
> the GCE metadata server for that one cold-cache window should drop from N
> to 1, subject to: every caller still receives the correct, identical token
> value; a failed fetch is still evicted from the cache (not permanently
> poisoned); the existing proactive-refresh/TTL-margin behavior is
> unchanged; the full test suite passing; and `tsc`/`harness:bench-verify`
> staying clean.

Not modified after evaluation began.

## Ledger Check (live GitHub state; local `LEDGER.md` is frozen at
2026-09-06 — main hasn't advanced past `6e73a8f` since then)

Live, fully-paginated backlog measurement tonight: **65 open PRs** (`#17`–
`#144`), **0 merged since `#15`** (2026-09-06/07) — roughly **73 consecutive
days / ~70 nights at 0% merge rate**. 8 PRs merged all-time, all in the first
5 nights. This exact finding has now been independently raised as the
*primary* finding at least 7 times (#35, #71, #91/#92, #124, #126, #134/#135,
#136/#137, #142/#143) across every DEEP surface this routine rotates through.
Tonight does **not** restate it as the primary finding an 8th time — see
Recommendation.

Specifically for tonight's surface:
- **#136/PR#137** (2026-11-13, ACCEPT): fixed a cross-*function*
  duplicate-fetch in `fire-heartbeat.ts`/`agentdb-adapter.ts`. Confirmed by
  reading its full diff tonight: does not touch `bridge-auth.ts` or
  `bridge-client.ts`.
- **#126/PR#127** (2026-11-08, INCONCLUSIVE): explicitly audited
  `bridge-auth.ts`/`bridge-client.ts` for "cache/timer leaks" and found them
  "clean — bounded caches, `finally`-cleared timeout." That check is a
  different question (leaks) from tonight's (a cold-cache concurrency
  stampede) — re-read `bridge-auth.ts` tonight specifically for the
  concurrent-caller shape `ensureHandshake` already guards against, which
  that night's leak-focused pass did not check.
- **#142/PR#143** (2026-11-17, INCONCLUSIVE): re-swept
  `fire-heartbeat.ts`/`agentdb-adapter.ts`/`interaction-profile.ts`/
  `governance/*` for a non-duplicate candidate and found none — did not read
  `bridge-auth.ts` at all (file not named in that report).
- `gh api search/issues` for `bridge-auth`/`getIdentityToken`/"identity
  token" in body: 7 hits, all passing mentions in broader sweeps (file named
  as "checked, clean" or "not examined"), none implementing or proposing
  tonight's specific in-flight-promise-caching fix.

**Learning signals applied**: the "finding repeated ≥3 nights → rotate DEEP"
signal has already fired 7 times for the backlog-crisis finding specifically
(see above) — tonight deliberately did **not** re-run that exact sweep an 8th
time. The "0 of last N PRs merged → bias to a tiny, one-parameter,
easily-reviewable candidate" signal is maximally triggered (0 of the last 65)
— applied: this candidate is 2 files, 51 changed lines (incl. test), one
conceptual change, mirrors a pattern this exact codebase already uses
elsewhere, and touches a file (`bridge-auth.ts`) with its own prior "clean"
audit — but for a different question than tonight's.

## Evaluation Receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), real project test runner, no mocked evaluator.

| | Tests | Pass | Fail | tsc | bench-verify hash |
|---|---|---|---|---|---|
| Baseline (`6e73a8f060bcbb69965a50ffe4627e33622d4094`, unmodified) | 328 | 327 | 1 | clean | `840fd8d2d6980c05657eef47034be902866c58868617f34e86ecacf8dde8ac1d` unchanged |
| Candidate (this branch) | 328 | 328 | 0 | clean | `840fd8d2d6980c05657eef47034be902866c58868617f34e86ecacf8dde8ac1d` unchanged |

1 new discriminating test added to
`tests/control-plane/bridge-client-handshake-and-oidc.test.ts`
(`gcp-oidc auth: two concurrent callTool calls on a cold token cache share
one metadata-server fetch, not two`), which fires two concurrent `callTool`
calls through `gcp-oidc` auth with a cold cache and counts real
metadata-server fetches:

- **Run against parent commit** (production diff stashed, test file
  applied): **FAILS** — `expected exactly 1 metadata-server fetch for 2
  concurrent cold-cache callers, observed 2`. Proves the parent genuinely
  double-fetches and that the new test has discriminating power, not just
  passing by construction.
- **Run against candidate**: **PASSES** — exactly 1 fetch.

Synthetic timing (ad hoc script, not committed — mocked 20ms metadata-server
round trip, fresh `fetchImpl` per run so no cross-run cache reuse, N
concurrent cold-cache callers for the same audience):

| N concurrent callers | Baseline: metadata fetches | Candidate: metadata fetches |
|---|---|---|
| 2 | 2 | 1 |
| 5 | 5 | 1 |
| 20 | 20 | 1 |

Fetch count drops from O(N) to O(1) regardless of N — an exact match to "N−1
eliminated round trips," not an approximation. Wall-clock time is
comparable in this synthetic setup (`Promise.all` starts all N fetches
essentially simultaneously against a mock with no real concurrency ceiling),
so the material win here is metadata-server request volume under load, not
single-call latency — stated plainly rather than inflated with a
misleading wall-clock multiplier.

## Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip,
unmodified), evaluated on the real `npm test` entrypoint before any candidate
code was written, and re-evaluated specifically against the 1 new regression
test (above) to prove its discriminating power.

## Darwin Lineage

Not run — single, fully-specified, minimal-surface change (cache the
in-flight promise instead of the resolved value, mirroring an existing
in-repo pattern exactly); no tunable parameter or alternative design space to
search.

## Evidence

- OBSERVATION: `bridge-auth.ts`'s `getIdentityToken` (pre-change) checked a
  `Map<string, CachedToken>` for a live entry, and on a miss/expiry called
  `fetchIdentityToken` directly and awaited it before populating the cache —
  read- and grep-confirmed.
- OBSERVATION: `bridge-client.ts`'s `ensureHandshake` (unchanged, read for
  comparison) caches `Promise<HandshakeState>` synchronously, before any
  await, specifically to prevent concurrent first callers from
  double-initializing — confirmed by its own header comment and code shape.
- MEASUREMENT: the new discriminating test — baseline observes 2 metadata
  fetches for 2 concurrent callers (expected 1); full suite 328 (327 pass /
  1 fail — the 1 new test only, 0 other regressions).
- MEASUREMENT: candidate — 328/328, 1 fetch observed for 2 concurrent
  callers. `tsc` clean. `harness:bench-verify` hash unchanged
  (`840fd8d2d698…`).
- MEASUREMENT: synthetic N-sweep (2/5/20 concurrent callers) — baseline
  fetches scale 1:1 with N; candidate stays at exactly 1 for every N.
- INFERENCE: the eliminated round trips are real network calls to the GCE
  metadata server (or, under test, the injected `fetchImpl`), not a mocked-
  away cost — the token value returned is unchanged and existence/validity
  checks are unaffected, only the redundant concurrent fetches are removed.
- DECISION: ACCEPT, recommended for human review.
- REJECTION: none this cycle — no alternative direction was tried and
  discarded; one candidate was selected from 5 scored proposals (see
  Candidate Selection) and implemented directly.

## Candidate Selection (5 scored, 1 selected)

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod. value | Reviewability | Total |
|---|---|---|---|---|---|---|---|---|
| 1 | **`bridge-auth.ts`'s cold-cache concurrent-fetch stampede** (selected) | 4 | 3 | 5 | 5 | 3 | 5 | 25 — the only candidate found tonight that is both non-duplicate and testable without re-running an already-6×-confirmed-exhausted sweep |
| 2 | 7th restatement of the backlog-crisis finding (0% merge rate) as tonight's primary finding | 1 | 1 | 5 | 5 | 1 | 5 | 18 — rejected: #35/#71/#91-92/#124/#126/#134-135/#136-137/#142-143 already established this; an 8th restatement under a performance label adds no new evidence (see Ledger Check) |
| 3 | Re-run the sequential-await-in-a-loop / cross-function-duplicate-fetch sweep across `src/control-plane` a 3rd/4th time | 1 | 1 | 5 | 3 | 1 | 5 | 16 — rejected: #116/#126 (sequential-await shape) and #137/#142 (cross-function-duplicate shape, specifically re-confirmed exhausted just last night) already did this; a repeat would be exactly the "repeated null result" the routine's own rotation rule flags |
| 4 | `employee-augmentation/interaction-profile.ts` beyond `recomputeInteractionSignals` (already PR #94) — checked the rest of the file for a second candidate | 2 | 2 | 3 | 3 | 2 | 3 | 15 — rejected: rest of the file is pure, synchronous scoring logic with no I/O or loop-of-awaits shape to optimize |
| 5 | `claims-authorization.ts`'s `verifyActorHoldsClaim` — checked for a redundant-recall shape parallel to PR #137's fix | 3 | 2 | 3 | 3 | 2 | 3 | 16 — rejected: reads a single claim by its own key once; no second entity re-fetched elsewhere in the same call stack, unlike `persistHeartbeatSchedule`'s shape |

Candidate 1 selected — highest score, the only one both non-duplicate and
not a re-run of an already-exhausted sweep.

## Reward-Hack Check (independent critic pass — this session, separate from
implementation)

- `.harness/bench.json` untouched; hash unchanged
  (`840fd8d2d6980c05657eef47034be902866c58868617f34e86ecacf8dde8ac1d`) before
  and after.
- No existing test's assertions weakened, deleted, or had an expected value
  changed — only 1 new test added, independently proven to fail against the
  real, unmodified baseline (observed 2 fetches, not a value tuned to pass
  trivially).
- Exhaustive, not cherry-picked: `grep -rn "getIdentityToken\|tokenCache"
  src/` confirms exactly one call site (`resolveAuthorizationHeader`) and one
  cache (`tokenCache`), both updated; no other caller bypasses the cache.
- No threshold, timeout, or retry adjusted to manufacture a pass.
- The cache now holds a `Promise<CachedToken>` rather than a `CachedToken` —
  this is the same caching discipline `bridge-client.ts`'s `ensureHandshake`
  already uses for an equivalent purpose (de-duplicating concurrent cold-
  cache work), not a new, undocumented memoization scheme; a failed fetch is
  evicted from the cache (`cache.delete(audience)` in the `.catch`), so a
  transient failure cannot permanently poison it — mirrors `ensureHandshake`'s
  `resetHandshake`-on-failure behavior exactly.
- One genuine, documented tradeoff (not hidden): concurrent callers racing a
  cold cache now share one outcome — if the single in-flight fetch fails,
  every waiting caller fails together (previously, by coincidence, each
  failed independently with its own error object, same `AgentDbBridgeError`
  wrapping, same message). This is the same tradeoff `ensureHandshake`
  already accepts for handshakes, stated here rather than left implicit.
- Independent adversarial pass (this session, separate from implementation):
  confirmed the warm-cache fast path (`cached` exists and
  `entry.expiresAtMs > Date.now()`) is unchanged in shape — still a
  synchronous Map lookup plus one `await` on an already-resolved promise
  (negligible, same as awaiting an already-settled promise anywhere else in
  this codebase) — verified by reading, not assumed. No unresolved signal.

## Security Review

- No new authorization surface, no new credential, no new network
  destination — the same GCE metadata-server endpoint, same audience
  derivation, same `Metadata-Flavor: Google` header. The change strictly
  *reduces* the number of outbound requests to that endpoint under
  concurrency; it introduces no new one.
- No change to the OIDC token's lifetime/refresh-margin logic
  (`TOKEN_REFRESH_MARGIN_MS`/`TOKEN_MAX_AGE_MS`/`decodeJwtExpiryMs`) — all
  three are untouched, still applied identically once a token is obtained.
- No cross-request leakage: the cache remains keyed by `(fetchFn, audience)`
  exactly as before (via the same `WeakMap<typeof fetch, Map<string, …>>`
  shape) — concurrent tests injecting distinct `fetchImpl`s still never
  share a cache entry, verified by the existing (unmodified) OIDC test suite
  still passing unchanged.
- Fail-closed property preserved: a failed fetch still propagates as a
  rejection to every awaiting caller (`callTool` still wraps it in
  `AgentDbBridgeError` and sends no RPC), and is evicted rather than cached,
  so there is no way for this change to cause a caller to proceed
  unauthenticated.

## Regression Analysis

0 regressions: 327→328 (1 new, additive, independently-verified-discriminating
test only). `tsc --strict` clean on both baseline and candidate.
`harness:bench-verify` hash unchanged. 2 files touched (`bridge-auth.ts`:
cache value type changed from `CachedToken` to `Promise<CachedToken>`, same
function signatures, no exported API change; the OIDC test file: 1 new test
appended, no existing test modified). No other call site of
`resolveAuthorizationHeader`/`getIdentityToken` touched; every existing OIDC
test (single-call-site caching, failure-throws-no-RPC, auth-off-default)
still passes unchanged, verified by the full 328-test run.

## Scan Findings

**memory**: No new allocation pattern, no unbounded growth — the cache still
holds at most one entry per `(fetchFn, audience)` pair, same as before;
during the cold-cache window it now holds one `Promise` object instead of N
independent in-flight fetch continuations, which is strictly less transient
memory under concurrency, not more.

**latency**: The finding itself — see TL;DR/Evaluation Receipt above. Swept
`store/`, `authorization/`, and `services/ruclip-attester/` for the same
cold-cache-concurrent-caller-stampede shape (not the sequential-await-in-a-
loop or cross-function-duplicate-fetch shapes prior nights already ruled
out): `credential-issuer.ts`'s secret cache (PR #104) and
`signing-key.ts`'s key cache (PR #59) are each already covered by an
existing open PR for their own caching gap — re-read both tonight
specifically for this stampede shape: `credential-issuer.ts`'s cache (per
PR #104's diff) already caches the in-flight promise, not just the resolved
secret, so it does **not** have tonight's gap; `signing-key.ts` was not
re-examined in enough depth to rule in or out tonight (flagged as a next
step, not claimed clean). No second confirmed instance of tonight's exact
shape found elsewhere in the time available.

## Competitors

See "Competitors (graded)" table above.

## Gist

`gh gist create`/`gh auth status` fail in this session (`GH_TOKEN` invalid)
— the GitHub MCP tools (issues/PRs) work fine, so this is not a `FALLBACK`
condition, only no public-gist capability, same as several prior nights.
Full report committed instead at this path. `GIST=LOCAL`.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
the line `## Witness` above — delete this section and everything after it,
then hash what remains (avoids the self-referential-hash problem).

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `dc73c1348de29ef5b930e02940f700647f9fce39a64d56741ea318a315d77536`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `dd64e8dafc340de2a2415b3baaea2b43fb0048383050b58fa10773c2e74a3eea`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm this
   is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-11-18-performance-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it matches the Witness stamp recorded here/in the issue/PR.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- . && npm ci && npm test` —
   confirm 327/328 pass against the unmodified baseline once the 1 new test
   is applied (see this branch's test file).
5. `git checkout dream/2026-11-18-performance -- . && npm test` — confirm
   328/328 pass.

## Next steps (3)

1. **Land this alongside #41/#43/#137** (fire-heartbeat/persistHeartbeatSchedule
   fixes) and any one of the other confirmed-clean, zero-risk PRs — none
   conflicts with any other; reviewing a handful together would meaningfully
   dent the 65-PR backlog without requiring deep review of each in isolation.
2. **Re-examine `signing-key.ts`'s key cache** for the same cold-cache
   concurrent-stampede shape tonight's time budget didn't allow going deeper
   on — flagged, not fixed, this cycle (one conceptual change per night).
3. **Instrument real concurrent-caller volume against a live IAM-protected
   bridge deployment.** Tonight's finding is real but the `gcp-oidc` auth
   path itself is opt-in and not confirmed to be exercised in the actual
   deployed configuration (ADR-0001) — if it isn't enabled in production
   yet, this fix's practical value is "correct now, ahead of need" rather
   than "fixing an active hot-path cost," which should be stated plainly to
   a reviewer, not implied otherwise.
