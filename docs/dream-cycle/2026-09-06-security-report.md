# Security SOTA Report — 2026-09-06

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 1 (`DAYINT % 5 = 1`): DEEP=security, SCAN=dependencies,secrets.

## TL;DR

`ActorCredential` and `HumanIdentityAttestation` — the two short-lived,
signed, single-use tokens that authorize every sensitive mutation in
ruClip's control plane (approvals, comms, heartbeats, consent changes) —
each had a **non-atomic, check-then-act nonce-replay guard**: a
`memory_retrieve` existence check followed by a separate `memory_store`
write. Under concurrent verification of the *same* credential, both calls
can observe "not yet used" before either writes the marker, so **both
succeed** — a classic CWE-367 Time-of-check/Time-of-use race that defeats
the single-use guarantee the design (`ACTOR-IDENTITY-VERIFICATION.md` §3)
explicitly promises. Fixed by collapsing the guard into one atomic
`memory_store` call with `upsert: false`, which strict-inserts against the
real AgentDB backend's `UNIQUE(namespace, key)` constraint (verified
against the actual installed `@claude-flow/cli@3.38.20` source, both its
primary `better-sqlite3` bridge path and its `sql.js` fallback — not
assumed). Baseline (unfixed code): 320/323 tests, 3 failures, exactly the
concurrency-race and call-shape assertions this finding predicts. Candidate
(fixed code): 323/323, 0 regressions.

## What's new / prior art

The concurrent-scan track (`dependencies,secrets`) also surfaced 39 known
`npm audit` vulnerabilities (1 critical — `protobufjs` RCE-class; 14 high —
`sharp`/libvips CVEs, `onnxruntime-*`, `agentic-flow`, `agentdb`,
`@huggingface/transformers`, `fast-uri` SSRF) reachable entirely through
`ruflo`'s (`@claude-flow/cli`) transitive tree via a non-optional
`peerDependency`. None of this is exercised by ruClip's own `src/`/`services/`
code (verified: no `src` file imports `ruflo`/`agentdb`/`sharp`/`protobufjs`
directly; the only touchpoint is the HTTP JSON-RPC bridge `ruflo mcp start`
runs as a separate sidecar process). It's a real supply-chain exposure for
anyone who runs `npm install ruclip` (peerDependenciesMeta marks `ruflo`
`optional: false`, so npm ≥7 auto-installs it and its vulnerable subtree),
but it is not independently *testable* tonight without either an upstream
fix to vendor (none of the 39 have one yet per `npm audit`'s ranges) or a
"we accept/pin/isolate this" policy decision above this session's authority
— it is documented here as a scan finding and a next step, not tonight's
DEEP candidate.

### Prior art / comparable defect class (competitor & literature scan)

| Source | What it shows | Grade |
|---|---|---|
| [CWE-367 (MITRE)](https://cwe.mitre.org/data/definitions/367.html) | Canonical definition: a resource is checked, then used, and its state can change in between — the exact shape of the retrieve-then-store guard this finding fixes | A (official) |
| [GHSA-5x9f-6vg5-qg4m, siderolabs/omni](https://github.com/siderolabs/omni/security/advisories/GHSA-5x9f-6vg5-qg4m) | Real, published security advisory: "TOCTOU race condition allows multiple concurrent uses of a single-use SAML session token" — same defect class (single-use auth token, check-then-act guard), same class of fix (atomic single-use enforcement) | A (official GHSA) |
| `paperclipai/paperclip` (named competitor, `dream.config.json`) — open-source AI-agent-company org-chart/governance platform, 53k+ GitHub stars since 2026-03 | Directly comparable domain (mixed human/agent org chart, approval workflows, scoped credentials) to ruClip's control plane. Its specific credential/replay-guard implementation was not inspectable within tonight's budget (no code-search access to a repo outside this session's GitHub scope, and its public docs don't describe token internals) — flagged as an open comparison for a future night, not fabricated | — (not reproducible tonight, no claim made) |
| General TOCTOU remediation guidance (e.g. OAuth/JWT refresh-token-rotation best practice: rotation must be a single atomic DB operation, not check-then-write, or concurrent refreshes both succeed) | Cross-checked, vendor-agnostic synthesis matching the CWE-367 remedy applied here (atomic constraint > separate check) | B (aggregated/cross-checked, not single-source) |

## Frozen hypothesis (frozen before evaluation began)

> Given concurrent presentations of the same short-lived `ActorCredential`
> (or `HumanIdentityAttestation`) to ruClip's single-use nonce-replay guard,
> when the guard is changed from a separate `memory_retrieve`
> existence-check followed by a `memory_store` write, to a single atomic
> `memory_store` call with `upsert: false` (relying on the real AgentDB
> backend's `UNIQUE(namespace, key)` constraint), then at most one
> concurrent verification of the same credential/attestation should
> succeed and every other concurrent verification should be rejected as a
> replay — relative to the current retrieve-then-store baseline, which
> allows every concurrent verification to succeed — subject to: no
> behavior change on the existing sequential (non-concurrent) verification
> paths, and zero regressions across the full existing test suite.

Not modified after evaluation began.

## Candidate

One conceptual change (atomic strict-insert instead of check-then-act),
applied at both of its two occurrences in the codebase (`ActorCredential`'s
own nonce guard and the structurally identical `HumanIdentityAttestation`
guard — same pattern, same fix, not incidental duplication: grep confirms
these are the only two `memory_retrieve`-then-`memory_store` nonce-replay
pairs in the control plane; the third similar-looking write,
`mintHumanActorCredential`'s provenance-marker store, is write-once against
a freshly-minted random nonce with no matching read-then-decide step, so it
has no race to fix).

- `src/control-plane/authorization/actor-credential.ts` — `verifyActorCredential`'s nonce guard
- `src/control-plane/authorization/human-identity-attestation.ts` — `verifyHumanIdentityAttestation`'s nonce guard
- `tests/support/actor-credential-fixture.ts` — `nonceMockHandlers` now models the real backend's `UNIQUE(namespace, key)` constraint under `upsert: false`; new `racingNonceMockHandlers(concurrency)` deterministically barrier-synchronizes N concurrent callers at the `memory_retrieve` step, reproducing the worst-case race without depending on incidental event-loop timing
- 4 existing test files updated: one implementation-detail assertion (`calls.some(... === 'memory_retrieve')`) tightened to assert `upsert: false` instead; three exact call-order arrays (`['memory_retrieve', 'memory_store', ...]`) updated to drop the now-absent `memory_retrieve` entry — these are legitimate updates to an implementation-detail assertion the fix necessarily changes, not a weakened guarantee (each of those three tests' actual security property — "nothing persists past the rejection point" — is unchanged and still enforced)
- 2 new tests added (one per guard) proving the race is closed

Diff size: 8 files, +130/-30 lines (160 total) — within the <300-line target, one conceptual change.

Real-tool verification (not assumed): read `@claude-flow/cli@3.38.20`'s
actual installed source (this repo's own `node_modules`, the exact pinned
version) for both write paths `memory_store` can take:

- **Primary path** (`memory-bridge.js`'s `bridgeStoreEntry`, `better-sqlite3`,
  synchronous, real ADR-323/#2775 code): `upsert: false` compiles to
  `INSERT ... ON CONFLICT(namespace, key) DO UPDATE ... WHERE status='deleted'`;
  an existing *active* row makes `changes === 0`, which the tool detects and
  returns `{success:false, error:'key "..." already exists...'}` — a single
  atomic SQL statement, no separate read.
- **Fallback path** (`memory-initializer.js`'s `storeEntry`, `sql.js`):
  `upsert: false` compiles to a plain `INSERT` against a schema with a real
  `UNIQUE(namespace, key)` constraint, serialized against other writers by
  the file's own `withMemoryDbLock` (added for exactly this reason per its
  own `#2878` comment: "load → mutate → persist must be atomic against
  other writers").

Both paths reject a second strict-insert of an already-occupied key. The
fix's correctness rests on the real tool's real, current behavior, not on
an assumption about what `upsert: false` "should" do.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), this repo's real, only test entrypoint. No LLM calls in this evaluation — deterministic unit/integration tests only (`node:test`). `OPENROUTER_API_KEY` is present this session (`LLM_EVAL=available`), but nothing in tonight's finding needed a model call, so none was made.

**Baseline** (current HEAD, `5c3ea0d2bb450ccbbfb5b25bc06825388a705b9d`, guard unfixed, new tests present):
```
tests 323
pass 320
fail 3
```
The 3 failures are exactly the ones the hypothesis predicts:
1. `verifyActorCredential ... rejects a replayed nonce even when two verifications race concurrently` — `2 !== 1` (**both concurrent verifications succeeded** — the race, reproduced deterministically via the barrier mock, not a flaky timing artifact)
2. `verifyHumanIdentityAttestation ... race concurrently for the same attestation` — same `2 !== 1`
3. `verifyActorCredential succeeds for a validly-signed ... credential` — the new `upsert: false` assertion fails (`undefined !== false`), confirming the baseline guard never asked for strict-insert semantics at all

Full baseline output saved (this session's scratch dir) as receipt.

**Candidate** (fix applied): 
```
tests 323
pass 323
fail 0
```
0 regressions. The 3 baseline failures flip to pass; nothing else changes.

## Darwin

Skipped, deliberately. Bounded Darwin mutates a *parameter or heuristic*
across generations to find a better point in a continuous trade-off space.
This finding has no such space: the choice is "atomic strict-insert
(correct, matches the real backend's actual constraint) vs. check-then-act
(incorrect, race)" — a binary correctness fact, not a tunable, and the
correct answer was independently confirmed by reading both of the real
tool's real write paths rather than guessed. There is nothing for an
evolutionary search to explore that adversarial code-reading didn't already
settle. (This is a judgment call under "only if available/applicable", not
a resource-budget skip — recorded per Step 26's self-review requirement.)

## Evidence

- OBSERVATION: `actor-credential.ts`'s and `human-identity-attestation.ts`'s
  nonce guards each perform `memory_retrieve` then `memory_store` with no
  atomicity between them (read, both files, pre-fix).
- MEASUREMENT: baseline `npm test` — 320/323, the 3 predicted failures
  (concurrency race reproduced twice, `upsert` assertion), captured to a
  saved receipt.
- MEASUREMENT: candidate `npm test` — 323/323, 0 regressions.
- INFERENCE: the real AgentDB backend's `UNIQUE(namespace, key)` constraint
  (both write paths, read directly from the installed
  `@claude-flow/cli@3.38.20` source) makes `memory_store({upsert:false})`
  a genuinely atomic strict-insert in production, not merely in the mock —
  the mock was built to mirror that real constraint, not invented
  independently of it.
- DECISION: apply the atomic-strict-insert fix to both occurrences; do not
  touch the `mintHumanActorCredential` provenance-marker write (no matching
  race — see Candidate section).
- REJECTION: none this cycle (no alternative candidate was implemented and
  discarded — the fix was singular and correct on first evaluation).

## Reward-hack / adversarial critique (independent pass over the candidate)

- Weakened the benchmark/tests? No — 2 tests added, 0 removed, 0 skipped;
  the 4 pre-existing assertions edited were implementation-detail call-shape
  assertions (which tool got called), not the behavioral guarantee under
  test (which is unchanged and still checked by the same test names).
- Altered gold answers / evaluator internals? No — no gold data or
  evaluator code exists for this repo's test suite; nothing of that kind
  was touched.
- Cherry-picked a favorable metric? No single metric was picked; the whole
  suite (323 tests) is the evaluator, run twice (baseline, candidate),
  output not filtered.
- Exploited the evaluator or relied on an undocumented cache? No — the
  concurrency test is a plain `Promise.allSettled`, deterministic via an
  explicit synchronization barrier in the mock (not timing-dependent, not
  cache-dependent).
- Hid cost? No cost dimension applies (no LLM calls, no new runtime
  dependency, `upsert` is an existing, documented parameter of a tool this
  code already calls).
- Touched a threshold? No numeric threshold exists in this guard (single-use
  is boolean).
- Corpus/mock sanity check: the mock's new conflict-detection behavior was
  cross-verified against the REAL installed tool's source on both its write
  paths (see Candidate section) — this is the same discipline the
  2026-09-05 correctness night flagged as previously missing (a mock's
  wrong shape hiding a real bug); tonight's mock update closes that same
  class of risk for this specific tool call rather than reopening it.

Critic verdict: no unresolved reward-hack signal.

## Security review (Step 15)

- **Prompt injection**: n/a — no LLM calls, no external untrusted text
  processed by this candidate.
- **Tool/MCP authority**: the fix constrains an *existing* AgentDB bridge
  call to an existing, documented parameter (`upsert: false`) already
  present in the real tool's schema — no new tool authority requested, no
  scope widened.
- **Credential exposure**: unrelated to this fix; `credential-issuer.ts` and
  `services/ruclip-attester/src/signing-key.ts` (the actual private-key
  handling paths) were read during research and were not touched — they
  already follow the repo's own documented no-log/no-disk-persist
  discipline for the signing key, and this candidate does not change key
  handling in any way.
- **Filesystem/network scope**: none widened — same bridge calls as before,
  one fewer round trip per verification (retrieve dropped), same namespace,
  same TTL semantics.
- **Agent impersonation / cross-agent poisoning**: this IS the vulnerability
  class being closed — the fix directly reduces an actor-impersonation
  window (a replayed credential could, within its ≤15-minute TTL, let a
  captured/observed credential authorize a second sensitive mutation
  concurrently with the legitimate one). Residual risk after the fix: an
  attacker who can observe a valid credential in flight can still use it
  ONCE before its legitimate holder does (this fix closes concurrent
  double-use, it does not add credential secrecy/transport protection,
  which is out of scope for a nonce-replay guard and already handled
  elsewhere — TLS transport, short TTL).
- **Least privilege**: no MCP tool permissions changed.

## Scan findings

**dependencies**: `npm audit` — 39 known vulnerabilities (1 critical, 14
high, 24 moderate) in `ruflo`'s (`@claude-flow/cli@3.38.20`) transitive
tree — `protobufjs` (critical, multiple RCE/prototype-pollution/DoS
advisories, no fixed version in range `<=7.6.2` yet the installed `7.6.6`
is still flagged — the advisory range appears to be stale/mis-scoped and
worth re-checking against the CVE directly next time this surface comes up),
`sharp`/libvips (high, image-processing native-binding CVEs), `onnxruntime-node`/`onnxruntime-web`/`onnx-proto`
(high, no fixed version), `agentic-flow`/`agentdb`/`@huggingface/transformers`/`@xenova/transformers`
(high, no fixed version — likely unmaintained-at-this-pin), `fast-uri`
(high, SSRF-class host-confusion). None of these are imported by ruClip's
own `src`/`services` code (confirmed via `npm ls <pkg>` path-tracing and
`grep` for direct imports) — the exposure is real but indirect (a
non-optional peerDependency's own dependency tree), and not independently
fixable from inside this repo tonight (no vendor fix available in-range for
any of the 39). Flagged as a next step (see below), not tonight's DEEP
candidate.

**secrets**: no hardcoded secrets, API keys, or private-key material found
in tracked source (`credential-issuer.ts`, `signing-key.ts`, and the GCP
Secret Manager / `gcloud` shell-out paths all read secrets transiently at
call time, never log or persist them — matches this repo's own documented
discipline, confirmed by reading, not assumed). `.gitignore` and
`.harness/` were checked for accidental secret tracking — clean. No
change needed; recorded as a clean scan, not a null result.

## Witness

```
REPORT_HASH    = dd0b14eb8402e120cf590e745864f64577125c589b15a4c2e580a9e67dc24f5b
SESSION_COMMIT = 5c3ea0d2bb450ccbbfb5b25bc06825388a705b9d
WITNESS        = dfb958d95f850fabb61b5f7812646ebdf367966a337530fcc02fd5e740368e88
```

`REPORT_HASH` is the sha256 of this file's content up to (and including) the
line directly above this Witness section — i.e. everything before `## Witness`
itself — computed once, before this section was filled in (a self-referential
hash of the whole file including its own hash would be circular). `WITNESS =
sha256(REPORT_HASH || SESSION_COMMIT)`, computed as
`printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text (docs/dream-cycle/2026-09-06-security-report.md) up to the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. Independently re-run `npm test` against the PR branch's HEAD and confirm 323/323 (0 fail) — the receipt this report claims.

## Recommendation

1. **Merge this fix** (draft PR) — closes a genuine, reproducible TOCTOU
   replay window in the actor/human credential single-use guard. Low risk,
   small diff, 323/323 green, no behavior change outside the race window.
2. **Decide a policy on the 39 transitive `npm audit` findings** — either
   pin/vendor a patched fork, isolate the `ruflo` sidecar process more
   strictly (it already runs out-of-process; consider a container/network
   boundary if not already enforced at deploy time), or accept the risk
   explicitly with a documented rationale (several of the 39 have no fixed
   version at all, so "wait for upstream" may not be actionable). This
   needs a human decision, not another dream-cycle candidate.
3. **Re-verify the `protobufjs` advisory range** next time this surface
   comes up — `npm audit` reports `<=7.6.2` as the vulnerable range but this
   repo's installed, deduped version is `7.6.6`; either the advisory's
   range is stale/wrong, or `7.6.6` is not actually patched for one of its
   listed CVEs — worth a direct GHSA/CVE cross-check before deciding this
   one is unfixable-as-is.
