# Correctness SOTA Report — 2026 (+ roadmap-review bonus)

**Date:** 2026-11-25 · **Slot:** 0 (correctness / performance,tests scan) · **Bonus:** roadmap-review (`20261125 % 25 == 0`) · **Session commit:** `ab588b32db00b536436139b1d8e5094cd7a6eb70`

## TL;DR

**Shipped:** `docs/design/HUMAN-CREDENTIAL-ISSUANCE.md` had its entire body
accidentally duplicated by a prior edit, with the duplication point falling
*inside* one markdown table cell — the file's second half literally resumed
mid-sentence ("...kind matching `^[a-z][a-z0-9._-]{0,63}# Human Credential
Issuance") before restarting the whole document from the title. Deduplicated
to one coherent copy and reconstructed the single split table row from its
two halves: `-271/+1` lines, zero semantic content lost, zero code touched.
`npm run build && npm test`: 362/362 before, 363/363 after (see "What's new"
for the +1).

**Found, not fixed (filed for human review):** investigating this doc's own
§6 (the just-merged `HumanIdentityAttestation` version-2 audience/purpose
binding) turned up a real design gap, not a regression tonight's edit
introduced: v2's `purpose` binding is checked only once, at
`mintHumanActorCredential` time, against the attestation. The resulting
`ActorCredential` (`actor-credential.ts`) has no `purpose`/`subjectRef`
field at all — `resolveVerifiedActor`, `applyApprovalTransition` and
`persistIssue`'s Guard C never see it. A credential minted from an
attestation purpose-bound to `{action: "approve", subjectRef: "issue:issue-1"}`
is, in practice, just as usable to reject issue-1, or to approve/reject/revise
any other issue, or create a heartbeat, for the rest of its TTL. That is
exactly the v1 weakness §6's own problem statement says v2 exists to close
("one attestation can mint a credential that is then spent on any
transition") — reopened the instant verification succeeds. Demonstrated with
a new, real, passing test (not a code fix — see "Evaluation receipt").

**Roadmap-review bonus:** 65 open `dream-cycle` issues, ~50 open `dream/*`
draft PRs, 0% of them merged since 2026-09-07 (3 nights' worth — `#9`/`#11`/
`#13`/`#15` — did eventually merge before that). This has already been
independently found, quantified and tooled against by at least 10 prior
nights (`#34/35, #46/47, #83/84, #91/92, #95/96, #105/106, #118/119,
#128/129, #134/135, #148/149`) — per the ledger's own learning signal
("repeated ≥3 times → rotate"), tonight does **not** add an 11th
backlog-triage tool. Tonight's own PR is deliberately the smallest possible
counter-example: a 1-file, pure-documentation, zero-production-code-risk
diff that removes lines rather than adding a new mechanism — offered as a
low-friction first candidate to actually merge and start testing the review
pipeline itself, since tooling has clearly stopped being the bottleneck.

## What's new

`docs/design/HUMAN-CREDENTIAL-ISSUANCE.md` (599 lines) contained two
complete, nearly-identical copies of its own body (`## 0` through `## 6`,
confirmed via `grep -n "^## [0-9]"` returning every heading twice, 270 lines
apart, with byte-identical text at matched offsets). The split point lands
inside the `purpose` table row of §6's field table: the row's description
cuts off at `` `^[a-z][a-z0-9._-]{0,63}` `` and is immediately followed, on
the same physical line, by `# Human Credential Issuance` — the second
copy's own title, with no line break. The row's actual remainder (`` ` and
id the store's safe-id charset | shape always, ... |``) exists later, as the
start of the *second* copy's own (equally truncated) version of the same
row. Reconstructed the one correct row by splicing the two fragments
together (closing the dangling `` ` `` code span), then deleted the entire
duplicated middle block. The merged row's prose now matches
`human-identity-attestation.ts`'s real `SUBJECT_REF_PATTERN` regex
(`^[a-z][a-z0-9._-]{0,63}:[A-Za-z0-9_-]{1,256}$`) exactly: "kind matching
`^[a-z][a-z0-9._-]{0,63}` and id the store's safe-id charset" describes the
two halves either side of regex's own `:` separator.

Checked every other file in `docs/` for the same duplicate-heading pattern
(`grep -n "^## " | sort | uniq -d` per file) — this was isolated to this one
file; `HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md` (the sibling doc for
`services/ruclip-attester`, read in full for this slice) is clean.

Also noted, not fixed tonight (§5's own "remains open" list is stale): it
still says "No producer of `HumanIdentityAttestation` exists yet" — but
`services/ruclip-attester` (`attest-handler.ts`/`signing-key.ts`/`server.ts`)
is exactly that producer, already shipped. A one-line staleness fix, logged
here rather than bundled into tonight's dedup diff to keep that diff's
`git blame` story to exactly one thing.

## Competitors (transaction/action-scoped credential binding)

| Mechanism | Binds a credential/token to | Grade |
|---|---|---|
| OAuth 2.0 DPoP (RFC 9449) | the specific HTTP request (method+URL+ath hash), checked on every use, not just at issuance | A (IETF RFC) |
| OAuth 2.0 Mutual-TLS client certs (RFC 8705) | the TLS client cert presented on every call that spends the token | A (IETF RFC) |
| WebAuthn/FIDO2 transaction confirmation ("what you see is what you sign") | the exact transaction payload the user saw, verified at use time, not just at authentication time | A (W3C standard, implemented by all major authenticators) |
| Okta/Auth0 step-up auth (ACR/AMR claims) | an authentication *context*, re-checked by the relying party per sensitive action | B (vendor docs, widely deployed) |
| ruClip `HumanIdentityAttestation` v2 (this repo, pre-fix) | nothing past mint time — binding is checked once, then discarded | — (this finding) |

Every A/B-grade comparator above re-checks the binding **at the moment the
credential is spent**, not only at the moment it is issued. That is the gap
this report's second finding names.

## Hypothesis (frozen before implementation)

> Given `docs/design/HUMAN-CREDENTIAL-ISSUANCE.md`'s duplicated body and
> split table row, when the duplicate is removed and the row is
> reconstructed from its two halves, then the document should read as one
> internally-consistent copy (every `## 0`–`## 6` heading exactly once, one
> `# Human Credential Issuance` title) with zero change to any code path —
> subject to: `npm run build && npm test` reporting the identical pass
> count plus any tests added for the separately-characterized v2 finding,
> and 0 regressions.

Not modified after evaluation began.

## Evaluation receipt (real evaluator, not inferred)

- **Baseline (parent, `ab588b3`):** `grep -c "^## [0-9]"` on the doc = 14
  (7 headings × 2). `npm run build && npm test` → **362/362** pass.
- **Candidate (doc dedup only):** `grep -c "^## [0-9]"` = 7 (each exactly
  once). File: 599 → 329 lines. Read top to bottom: coherent, no
  mid-sentence restart. `npm run build && npm test` → still **362/362**
  (the doc touches no code path tests exercise) — confirmed by running
  the suite with only the doc change staged, before adding the new test
  below.
- **Candidate (+ characterization test for the v2 purpose-binding gap,
  `tests/control-plane/human-identity-attestation-v2-credential-scope-gap.test.ts`):**
  mints a real, validly-signed v2 `HumanIdentityAttestation` purpose-bound
  to `{action: "approve", subjectRef: "issue:issue-1", ...}`; confirms
  `mintHumanActorCredential` correctly enforces that binding at mint time
  (throws on any mismatch — covered by the pre-existing
  `human-identity-attestation-v2.test.ts`); then presents that SAME,
  correctly-minted credential to the real `applyApprovalTransition` to
  **reject** issue-1 instead (not what the attestation's `purpose` named).
  This **succeeds** (`result.issue.approvalState === 'rejected'`) — real,
  reproducible, not inferred from reading the code. `npm run build && npm
  test` → **363/363**, 0 regressions.

Both runs used the real `npm run build && npm test` pipeline (`tsc` +
`scripts/run-tests.mjs`'s real `node --test`), no mocked test runner.

## Darwin

Not run. The doc fix is a 1-file textual deduplication with no tunable
parameter to search over. The purpose-binding finding is explicitly not a
code candidate tonight (see Security review) — nothing to evolve.

## Evidence ledger

- OBSERVATION: `docs/design/HUMAN-CREDENTIAL-ISSUANCE.md`'s `## 0`–`## 6`
  headings each appeared twice, 270 lines apart, byte-identical at matched
  offsets, with the split falling inside one table cell.
- MEASUREMENT: `npm run build && npm test` 362/362 on `ab588b3`, before any
  change.
- MEASUREMENT: doc deduplicated (599→329 lines, headings 14→7); `npm run
  build && npm test` unchanged at 362/362 with only this change staged.
- OBSERVATION: `HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md` and every other file
  under `docs/` checked clean of the same duplicate-heading pattern.
- OBSERVATION: `ActorCredential` (`actor-credential.ts`) has no
  `purpose`/`subjectRef`/`audience` field; `resolveVerifiedActor` checks
  only `orgMemberId`/`companyId`/the human-attestation provenance marker.
- MEASUREMENT: a credential minted from a v2 attestation purpose-bound to
  `{action: "approve", subjectRef: "issue:issue-1"}` was presented to
  `applyApprovalTransition` for `action: "reject"` on the same issue and
  the call succeeded — real test, `tests/control-plane/
  human-identity-attestation-v2-credential-scope-gap.test.ts`.
- INFERENCE: this reopens HUMAN-CREDENTIAL-ISSUANCE.md §6's own stated v1
  weakness ("one attestation can mint a credential that is then spent on
  any transition") for the full credential TTL, for any caller that does
  not independently enforce mint-once-per-action discipline (§6 rule 6
  explicitly leaves that discipline to the caller, not to ruClip's code).
- DECISION: ship the doc dedup (zero risk, zero ambiguity) tonight; file
  the purpose-binding gap as a confirmed, evidenced finding for human
  architectural review rather than threading `purpose` through
  `ActorCredential`'s signed frame myself — that changes a core,
  heavily-reviewed cryptographic trust boundary shared by every credential
  this codebase issues (agent and human), which this repo's own established
  practice (see `interaction-profile.ts`'s and
  `agentbbs-notification-channel.ts`'s own "flagged, not retrofitted"
  precedents) reserves for a team-lead call, not an automated tiny-candidate
  night.
- REJECTION: none — no candidate hypothesis was tried and failed tonight.

## Reward-hack check

No test, benchmark, or gold-data file was weakened, skipped, or had a
threshold moved. The doc fix removes duplicate content and repairs one
broken sentence — verified by diffing both original halves against the
merged result; nothing was dropped beyond the duplication itself. The new
test is additive, asserts a true (confirmed, reproducible) fact about real
code via the real `applyApprovalTransition`/`mintHumanActorCredential`
functions (no mocked business logic, only the AgentDB bridge is mocked, the
established convention across this whole test suite), and does not touch
any evaluator, cache, or threshold. Independent self-critique: could the
"gap" test be a false positive caused by a test-fixture mistake rather than
real production behavior? No — `activeClaimFor`/`recallReturning` mirror
the exact fixtures `human-identity-attestation.test.ts`'s own passing
"FULL PIPELINE" tests already use for the identical real functions.

## Security review

The purpose-binding finding is security-relevant (an authorization/identity
trust boundary) and is **not silently fixed** — flagged plainly, per this
codebase's own stated discipline for exactly this class of gap. No secret,
credential, or key material was read, logged, or touched by either part of
tonight's diff. The doc fix touches no code and has no runtime effect.
Least-privilege: no new MCP tool, no new network/filesystem scope, no new
dependency.

## Scan findings

**Performance scan:** reviewed the three hot paths named across prior
nights' performance findings (`fireHeartbeat`'s budget gates, `agentdb-
adapter.ts`'s causal-edge fan-out, `bridge-auth.ts`'s identity-token cache) —
all three already have an open, unmerged consolidation/fix PR (`#136`,
`#145`, `#148`). No new, non-duplicate performance candidate found tonight;
not re-filing a duplicate per the repeated-finding learning signal.

**Tests scan:** `npm test` is green at 363/363 with 0 skipped/todo across
two independent full runs tonight (before and after the new test); no
flakiness observed. `scripts/run-tests.mjs` continues to correctly discover
both `dist/src/**/*.test.js` and `dist/tests/**/*.test.js` — re-confirmed,
not assumed, by checking the new test file was actually collected (test
count went 362→363, matching the one test added).

## Gist

LOCAL — no `gh gist create`-equivalent tool available to this session (only
`mcp__github__*` MCP tools, which do not expose Gist creation). Full report
reproduced in the issue body below, same convention the 2026-11-24 night
used for the same reason.

## Witness

- Session commit: `ab588b32db00b536436139b1d8e5094cd7a6eb70`
- Report sha256 (of this report **with the `## Witness` section removed**,
  since the stamp cannot hash itself): `49fe0d6a664d5e945fa303d7a8de204be8bf2f14a8b4e3f6aa88d2a51415285a`
- Witness stamp: `a76d9c113592a3d9280440676d65e8617aba874d14366e25f0ec696b7fe2d37a`

**Verifier procedure (reproducible by anyone):**
1. `git fetch origin dream/2026-11-25-correctness && git checkout dream/2026-11-25-correctness` (baseline is `ab588b32db00b536436139b1d8e5094cd7a6eb70` on `main`).
2. From the candidate branch: `awk '/^## Witness$/{skip=1} /^## Recommendation$/{skip=0} !skip' docs/dream-cycle/2026-11-25-correctness-report.md | sha256sum` → must equal the Report sha256 above.
3. `printf '%s%s' "49fe0d6a664d5e945fa303d7a8de204be8bf2f14a8b4e3f6aa88d2a51415285a" "ab588b32db00b536436139b1d8e5094cd7a6eb70" | sha256sum` → must equal the Witness stamp above.
4. On branch `dream/2026-11-25-correctness`: `npm ci && npm run build && npm test` → expect 363/363 pass; diff against `ab588b3` should be exactly `docs/design/HUMAN-CREDENTIAL-ISSUANCE.md` (dedup), one new test file, this report, and `docs/dream-cycle/LEDGER.md`'s appended row.
5. `grep -c "^## [0-9]" docs/design/HUMAN-CREDENTIAL-ISSUANCE.md` on the candidate branch must print `7` (was `14` on `main`).

## Recommendation

**Merge-ready.** Final diff: `docs/design/HUMAN-CREDENTIAL-ISSUANCE.md`
(-271/+1, pure dedup) + one new, additive test file. 0 production code
touched, 0 test regressions, build clean. Human review required per merge
policy; this session does not merge.

**Separately flagged for a human architectural decision (not fixed
tonight):** `HumanIdentityAttestation` v2's `purpose`/`audience` binding
does not survive past `mintHumanActorCredential` — the resulting
`ActorCredential` is fully general-purpose. If any future caller relies on
v2 binding for its stated security property rather than purely as an
audit/provenance signal, `purpose` needs to be threaded through
`ActorCredential`'s own signed frame and checked at the point of use
(`resolveVerifiedActor`/`applyApprovalTransition`/`persistIssue`'s Guard C),
not only at mint time. Demonstrated, not assumed — see the new test.
