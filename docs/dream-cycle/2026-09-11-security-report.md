# Security SOTA Report — 2026-09-11

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Slot 1 (`DAYINT % 5 = 1`): DEEP=security, SCAN=dependencies,secrets.

## TL;DR

`persistIssue`'s Guard C (`checkAuthorizationGuard`,
`src/control-plane/store/agentdb-adapter.ts`) accepts two authorization
shapes: `{ credential, admittedIssuerKeys }` (verified fresh via
`resolveVerifiedActor`) or `{ actor: OrgMember }` (an already-verified
actor, threaded in by `applyApprovalTransition` — Guard C's own docstring
calls this "an ALREADY-VERIFIED OrgMember"). For the `{ actor }` shape,
two of Guard C's checks trust the caller-supplied `actor` object instead
of the ground-truth `persistedActor` it already recalls two lines later:
(1) the `actor.companyId !== companyId` cross-tenant check is gated
behind `'credential' in authorization`, so it is **skipped entirely** for
`{ actor }`; (2) the final external check, `verifyActorHoldsClaim(issue.id,
actor, config)`, is called with the caller-supplied `actor` — whose
`kind`/`role` feed directly into the claimant string ruflo's claims system
is queried with — rather than `persistedActor`, the same freshly-recalled
record Guard C already uses for its status and self-approval checks. This
is the identical bug CLASS security-hardening "round 7" fixed for the
`{ credential }` shape's companyId check (`checkAuthorizationGuard`'s own
comment: "made deliberate here, matching the sibling code path exactly")
and "round 6" fixed for the status check (`authorization-trust-boundary.test.ts`)
— both rounds closed the gap for fields Guard C independently re-verifies
against `persistedActor`; this is the same gap, still open, for the two
fields this report closes. Currently not reachable through the only real
production caller (`applyApprovalTransition` always resolves its own
`actor` via a genuine `ActorCredential`, already company-matched, before
ever building `{ actor }`) — bounded severity, same disclosure posture as
the 2026-09-02 cross-tenant claims-collision finding — but `persistIssue`
is an **exported** function, and the `{ actor }` shape exists specifically
so a future caller that already did its own verification elsewhere
(precisely the shape a bypass would present) can skip re-verifying a
single-use credential. Closing both gaps now, before any second caller of
`persistIssue` exists, is cheap insurance against exactly the class of bug
`ACTOR-IDENTITY-VERIFICATION.md`/`AUTHORIZATION.md` were built to close.

## What's new / prior art

An independent parallel research pass (fresh subagent, no access to this
session's reasoning) surveyed the same authorization/attester/store
surface concurrently and reported the identical finding independently —
convergent discovery, not a single analyst's guess. The same pass also
flagged (documented here, not tonight's candidate — see Next Steps):
`setInteractionProfileConsent` (`employee-augmentation/interaction-profile.ts`)
trusts a caller-supplied `actor: OrgMember` for its self-service consent
check with no credential verification at all (already covered by an
existing, still-open test, `tests/control-plane/employee-profile-access-control-gaps.test.ts`
"FINDING 2" — real, but lower production-value: no wired caller exists
yet for this not-yet-launched feature, versus tonight's finding, which
sits in the core approval-gate path every issue decision goes through);
a non-atomic retrieve-then-store race in `propose-budget-mutation.ts`
(same TOCTOU class as 2026-09-06's fix, in a directory with zero existing
test files); and re-confirmed the OIDC/IAP verification in
`ruclip-attester` does real audience+issuer+signature checks, not merely
header-presence.

The concurrent scan track (`dependencies,secrets`) re-ran `npm audit`
(39 findings, 1 critical/14 high/24 moderate — same headline count as
2026-09-06) and, per that report's own "Next Step 3" ("re-verify the
protobufjs advisory range"), traced the critical `protobufjs` finding to
ground truth: the audit's reported range (`<=7.6.2`) is not stale — it
correctly does NOT flag this repo's actual top-level, deduped install
(`protobufjs@7.6.6`, used directly by `@google-cloud/secret-manager`/
`@grpc/proto-loader`/`@google/genai`, confirmed patched for the newest
GHSA in the chain, `GHSA-f38q-mgvj-vph7`, fixed range `>7.6.2`). The
vulnerable instance is a completely separate, much older nested duplicate,
`protobufjs@6.11.6`, at `node_modules/onnx-proto/node_modules/protobufjs`
— four `peerDependency` hops deep (`ruflo` → `@claude-flow/cli` →
`agentic-flow` → `@xenova/transformers` → `onnxruntime-web` → `onnx-proto`
→ this copy), reachable only through the ONNX/embedding-model code path
this repo's own memory-bridge calls never exercise (`CLAUDE_FLOW_DISABLE_BRIDGE`
and `generateEmbeddingFlag:false`, per 2026-09-06's own real-backend
evidence). `npm audit fix` (non-force, dry-run) does not offer a scoped
fix for this one package — it proposes adding ~150 new packages across
unrelated native-binding platform variants (`@ruvector/*`, `nostr-tools`,
nine-platform `@img/sharp-*` matrices), evidence that no in-range
upstream fix exists yet for this specific nested copy, confirming
2026-09-06's own conclusion ("not independently fixable from inside this
repo tonight") rather than overturning it. Recorded as this cycle's
`dependencies` scan finding, not tonight's DEEP candidate.

### Prior art / comparable defect class (competitor & literature scan)

| Source | What it shows | Grade |
|---|---|---|
| [CWE-863 (MITRE), "Incorrect Authorization"](https://cwe.mitre.org/data/definitions/863.html) | Canonical definition: an actor's provided identity/attributes are trusted for an authorization decision without independent re-verification against the system's own ground truth — exactly the shape of trusting `actor` instead of `persistedActor` for the claims check this report closes | A (official) |
| [CWE-284 (MITRE), "Improper Access Control"](https://cwe.mitre.org/data/definitions/284.html) | Parent weakness class covering the skipped cross-tenant `companyId` check specifically | A (official) |
| `ruvnet/ruClip`'s own commit history, "security review round 6"/"round 7" (`authorization-trust-boundary.test.ts`, this file's own inline comments) | Two prior, already-shipped fixes of the SAME bug class in the SAME function (`checkAuthorizationGuard`) — a caller-supplied field trusted where a ground-truth recall already exists nearby — strong internal precedent that this class recurs field-by-field rather than being fully closed in one pass | A (this repo, verified by reading, not assumed) |
| `paperclipai/paperclip` (named competitor, `dream.config.json`) — comparable domain (mixed human/agent org chart, approval workflows, scoped authorization) | Its specific Guard-C-equivalent implementation was not inspectable within tonight's budget (no code-search access to a repo outside this session's GitHub scope) — flagged as an open comparison for a future night, not fabricated | — (not reproducible tonight, no claim made) |
| General "confused deputy" / trust-boundary literature (an internal function accepting two authorization shapes, one weaker than intended, without a compile-time tag distinguishing them) | Cross-checked, vendor-agnostic synthesis matching the root cause here: TypeScript's structural typing erases the "already verified" guarantee `{ actor }` depends on at runtime — a plain object literal satisfies the same interface | B (aggregated pattern, not single-source) |

## Frozen hypothesis (frozen before evaluation began)

> Given a call to `persistIssue`'s Guard C (`checkAuthorizationGuard`)
> using the `{ actor: OrgMember }` authorization shape — the shape a
> caller other than `applyApprovalTransition` would present, e.g. a
> forged actor object naming a real, active OrgMember id but a different
> `companyId` (cross-tenant collision) and/or a different `kind`/`role`
> than that id's real persisted record — when (a) the existing
> `actor.companyId !== companyId` check is made unconditional (currently
> gated behind `'credential' in authorization`, so it is skipped for the
> `{ actor }` shape) and (b) the final `verifyActorHoldsClaim` call is
> given the freshly-recalled `persistedActor` instead of the
> caller-supplied `actor`, then both the forged-company and the
> forged-kind/role `{ actor }` attacks should be rejected by Guard C
> before any external claims check runs against attacker-controlled
> fields — relative to the current baseline, where the company check is
> skipped entirely for this shape and the claims check queries ruflo's
> claims system with the caller-supplied, potentially-forged `kind`/`role`
> — subject to: zero behavior change for the `{ credential }} }` shape,
> zero behavior change for `applyApprovalTransition`'s own existing
> production call path (its `actor` is already real, already
> company-matched, never forged, so its results are byte-identical), and
> zero regressions across the full existing test suite.

Not modified after evaluation began.

## Candidate

One conceptual change (stop trusting caller-supplied fields Guard C
already has ground truth for, applied to the two fields "round 7"/"round
6" didn't yet cover), in one function:

- `src/control-plane/store/agentdb-adapter.ts` — `checkAuthorizationGuard`:
  (a) drop the `'credential' in authorization &&` guard so the
  `actor.companyId !== companyId` check runs for both authorization
  shapes; (b) pass `persistedActor` (not `actor`) to the closing
  `verifyActorHoldsClaim` call.
- `tests/control-plane/authorization-trust-boundary.test.ts` — 2 new
  tests, same file/pattern "round 7"'s own finding used (direct
  `persistIssue` call, bypassing `applyApprovalTransition`, same fixture
  shapes already in this file).

Target: comfortably under the 300-line budget (a 2-line production change
plus two new, self-contained tests).

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`),
this repo's real, only test entrypoint. No LLM calls in this evaluation —
deterministic unit/integration tests only (`node:test`). `OPENROUTER_API_KEY`
is present this session (`LLM_EVAL=available`), but nothing in tonight's
finding needed a model call, so none was made.

**Baseline** (current HEAD, `6e73a8f060bcbb69965a50ffe4627e33622d4094`, Guard C
unfixed, new tests present):
```
tests 329
pass 327
fail 2
```
Both failures are exactly the ones the hypothesis predicts, and are the
real behaviors, not artifacts (confirmed by an independent critic
re-deriving them from a fresh `git stash` of only the production file —
see Reward-Hack Check):
1. `Guard C rejects the { actor } shape when actor.companyId does not
   match the target companyId...` — `AssertionError: Missing expected
   rejection` — `persistIssue` **succeeds**: an attacker's own genuine,
   active claim held in company `co-2` wrongly authorizes a write against
   company `co-1`'s issue, because the `{ actor }` shape's `companyId`
   check was skipped and `verifyActorHoldsClaim` was queried scoped by the
   caller-supplied (forged) `companyId`.
2. `Guard C's external claims check is queried using the PERSISTED
   OrgMember's real kind/role...` — throws `ClaimAuthorizationError:
   Actor 'om-y' does not hold the claim on issue 'issue-1' in company
   'co-1'` — a **legitimate** actor, genuinely holding a real, active
   claim under their real persisted role (`'Ops'`), is wrongly rejected
   because the caller-supplied object's stale/different role (`'Manager'`)
   was used to build the claimant string instead.

Full baseline output saved (this session's scratch dir) as receipt.

**Candidate** (fix applied):
```
tests 329
pass 329
fail 0
```
0 regressions. Both baseline failures flip to pass; nothing else changes.
`npx tsc -p tsconfig.json --noEmit` clean. `npm run harness:bench-verify`
hash unchanged (`840fd8d2d698…`). `npm run lint` clean (no-op stage, as
recorded every prior night).

Install used for every run above: `npm ci` (exact, lockfile-matching
install — no `npm install ... || true` fallback of any kind).

## Darwin

Skipped, deliberately. As with 2026-09-06's finding, this is a binary
correctness/authorization fact (re-verify against ground truth vs. trust
the caller), not a tunable parameter with a continuous search space —
nothing for an evolutionary search to explore that reading the two prior
"round 6"/"round 7" fixes in the same function didn't already settle.

## Evidence

- OBSERVATION: `checkAuthorizationGuard`'s `{ actor }` authorization shape
  (pre-fix) skips the `companyId` cross-tenant check entirely (gated
  behind `'credential' in authorization`) and passes the caller-supplied
  `actor` object, not `persistedActor`, to `verifyActorHoldsClaim` — read,
  `store/agentdb-adapter.ts`, before any test was written.
- MEASUREMENT: baseline `npm test` — 327/329, the 2 predicted failures
  (a genuine cross-tenant claims bypass succeeding; a legitimate actor's
  own real role wrongly rejected), captured to a saved receipt.
- MEASUREMENT: candidate `npm test` — 329/329, 0 regressions.
- INFERENCE: through the only current production call path
  (`applyApprovalTransition`), both gaps are unreachable — its own actor
  is already resolved via a genuine `ActorCredential` and already
  company-matched before `persistIssue`'s `{ actor }` shape is ever built
  — confirmed independently by a separate critic re-deriving this from
  the code, not assumed from this report's own framing.
- DECISION: apply both hardenings (unconditional companyId check;
  `persistedActor` into the claims check) to the one function that has
  already been hardened twice before for the identical bug class ("round
  6" status check, "round 7" companyId-for-credential-shape) — closing
  the two fields those rounds didn't yet cover, before any second,
  non-`applyApprovalTransition` caller of `persistIssue` exists.
- REJECTION: none this cycle (no alternative candidate was implemented
  and discarded — the fix was singular and correct on first evaluation).
  A separate, real candidate in the same bug class
  (`setInteractionProfileConsent`, see Next Steps) was surveyed and
  deliberately deferred, not rejected — see Next Steps for why.

## Reward-hack / adversarial critique (independent pass over the candidate)

An independent critic (fresh subagent, no access to this session's
reasoning or draft report) re-read `checkAuthorizationGuard`,
`persistIssue`, `applyApprovalTransition`, and `verifyActorHoldsClaim`/
`orgMemberClaimant` in full, independently re-derived that the bug is
real but unreachable via the only current production caller, itself
re-ran the baseline (via its own `git stash` of only the production file)
and candidate, confirmed the exact same 2-fail/329-pass and 0-fail/329-pass
receipts, grepped every `{ actor: ... }` call site in the repo (only
`applyApprovalTransition`, already company-matched by construction) to
confirm no legitimate caller regresses, and specifically checked the new
tests' `claims_list` mocks for realism against this codebase's own
established "Cross-tenant claim collision fix" precedent rather than a
contrived/rigged shortcut.

- Weakened the benchmark/tests? No — 2 tests added, 0 removed, 0 skipped;
  no existing assertion in this file or any other was touched.
- Altered gold answers / evaluator internals? No — no gold data or
  evaluator code exists for this repo's test suite; nothing of that kind
  was touched. `harness:bench-verify`'s hash is unchanged.
- Cherry-picked a favorable metric? No single metric was picked; the
  whole suite (329 tests) is the evaluator, run twice (baseline,
  candidate), output not filtered.
- Exploited the evaluator or relied on an undocumented cache? No — both
  new tests are deterministic mock-bridge calls with no timing dependency;
  the critic independently reproduced identical results.
- Hid cost? No cost dimension applies (no LLM calls, no new dependency,
  both changed lines call functions/read fields this code already had in
  scope).
- Touched a threshold? No numeric threshold exists in this guard
  (company match and claim-holding are both boolean facts).
- Does the companyId check becoming unconditional break any legitimate
  caller? No — verified by the critic via a repo-wide grep of every
  `{ actor: ... }` call site, and by the full suite staying green.

Critic verdict: **CLEAR** — no unresolved reward-hack signal.

## Security review (Step 15)

- **Prompt injection**: n/a — no LLM calls, no external untrusted text
  processed by this candidate.
- **Tool/MCP authority**: no new tool authority requested and no scope
  widened — the fix removes trust from two already-caller-controllable
  fields on an existing parameter shape; it adds no new bridge call
  (`verifyActorHoldsClaim` was already called; it now receives a
  different, more-trustworthy argument).
- **Credential exposure**: unrelated to this fix — no credential/signing
  code touched.
- **Filesystem/network scope**: none widened — identical bridge calls as
  before, same namespace, same semantics; one call's argument object
  changes, not the call itself.
- **Agent/actor impersonation**: this directly closes a residual
  impersonation-adjacent gap in the SAME function ACTOR-IDENTITY-
  VERIFICATION.md/AUTHORIZATION.md were built to close, for the two
  fields ("round 6"/"round 7") those efforts didn't yet cover on the
  `{ actor }` shape. Residual risk after this fix: none newly identified;
  the `{ actor }` shape still requires a caller to already possess an
  `OrgMember`-shaped object naming a real, active id in the target
  company to get past the id/status/self-approval checks at all — this
  fix closes what happens to the *company*/*kind*/*role* fields on that
  object once id/status are already satisfied, not those checks
  themselves.
- **Least privilege**: no MCP tool permissions changed.

## Scan findings

**dependencies**: `npm audit` — 39 known vulnerabilities (1 critical, 14
high, 24 moderate), same headline count as 2026-09-06. Traced the
critical `protobufjs` finding to ground truth per that report's own
recommended next step: the top-level, deduped install
(`protobufjs@7.6.6`, used directly by `@google-cloud/secret-manager`/
`@grpc/proto-loader`/`@google/genai`) is **not** vulnerable — it is
patched for the newest GHSA in the audit's chain
(`GHSA-f38q-mgvj-vph7`, fixed `>7.6.2`). The actually-vulnerable instance
is a separate, much older nested duplicate,
`protobufjs@6.11.6`, at `node_modules/onnx-proto/node_modules/protobufjs`
— confirmed by reading that copy's own `package.json` directly, not
inferred from `npm ls`'s deduped top-level view — reachable only through
`ruflo` → `@claude-flow/cli` → `agentic-flow` → `@xenova/transformers` →
`onnxruntime-web` → `onnx-proto`, the ONNX/embedding-model code path this
repo's own memory-bridge calls never exercise (confirmed again tonight:
no `src`/`services` import of any of these packages). `npm audit fix`
(non-force, dry-run) does not offer a scoped fix for this nested copy —
it proposes ~150 unrelated new packages (native platform-binary matrices
for `@ruvector/*`, `nostr-tools`, nine-platform `@img/sharp-*`), evidence
that no in-range, targeted upstream fix exists yet, not a fix this repo
declined to take. Not independently fixable from inside this repo
tonight — confirms, rather than overturns, 2026-09-06's conclusion.

**secrets**: no hardcoded secrets, API keys, or private-key material
found in tracked source (re-checked `credential-issuer.ts`,
`services/ruclip-attester/src/signing-key.ts`, `identity-map.ts`, and the
GCP Secret Manager paths — all read secrets transiently at call time,
never log or persist them). `.gitignore`/`.harness/` checked for
accidental secret tracking — clean. No change needed; recorded as a
clean scan, not a null result.

## Next steps

1. Retrofit `setInteractionProfileConsent` (`employee-augmentation/
   interaction-profile.ts`) to `ActorAuthorization`/`resolveVerifiedActor`
   — the precondition its own docstring cites for deferring this
   ("no human issuance path exists") is now false: `mintHumanActorCredential`
   /the human-attestation pipeline shipped 2026-09-02/09-06. Same bug
   class as tonight's finding, already has an open, demonstrating test
   (`employee-profile-access-control-gaps.test.ts` FINDING 2); deferred
   tonight only because it has no wired production caller yet, making
   tonight's approval-gate-path finding the higher production-value pick.
2. Same TOCTOU audit "round 6/7"-style pass on `governance/
   propose-budget-mutation.ts`'s retrieve-then-store rolling-window write
   — zero existing test coverage in that directory.
3. Decide a policy on the 39 transitive `npm audit` findings (unchanged
   from 2026-09-06's recommendation) — now additionally informed by
   tonight's confirmation that the specific vulnerable `protobufjs@6.11.6`
   copy is nested under `onnx-proto`, not the safe top-level 7.6.6 install,
   and that no scoped upstream fix exists yet (`npm audit fix --dry-run`
   only offers an unrelated, sweeping platform-binary reinstall, not a
   targeted patch).

## Witness

```
REPORT_HASH    = df96d08b73786faf00e5189e6a2ae272ae7d4be76b005e8105a62e8907c63e21
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 0f6893ca44ea811a2928538217b5a492af9bca7219664ea87df7348de2fc8fa9
```

`REPORT_HASH` is the sha256 of this file's content up to (and including) the
line directly above this Witness section — i.e. everything before `## Witness`
itself — computed once, before this section was filled in (a self-referential
hash of the whole file including its own hash would be circular). `WITNESS =
sha256(REPORT_HASH || SESSION_COMMIT)`, computed as
`printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text (`docs/dream-cycle/2026-09-11-security-report.md`) up to the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` (`6e73a8f060bcbb69965a50ffe4627e33622d4094`) is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. Independently re-run `npm test` against the PR branch's HEAD and confirm 329/329 (0 fail) — the receipt this report claims.
