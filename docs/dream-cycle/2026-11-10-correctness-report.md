# Correctness SOTA Report — 2026-11-10

## TL;DR
`applyApprovalTransition` (`src/control-plane/store/agentdb-adapter.ts`) hands
an issue's `claims` authority to a caller-constructed `deps.approver`
(action `submit`) / `deps.handoffTo` (action `reject`) `OrgMember` object
with no check that either one actually corresponds to a persisted
`OrgMember` record. `actor` — the party already *exercising* authority —
is re-verified against persisted state via `resolveVerifiedActor`'s own
`recallOrgMember` call and (for `persistIssue`) Guard C; the party *about to
receive* authority gets no equivalent check. `handoffClaim`'s only guard is
`from.companyId === to.companyId`
(`docs/design/AUTHORIZATION.md` §4, §6); the underlying `claims_*` system is
itself documented as "agnostic to who is allowed to be on either end of a
handoff" (§4). A same-company but fabricated/mistyped/nonexistent approver
or handoff target is therefore accepted silently: the issue is handed to a
claimant string nobody can ever present a matching credential for (every
later `acceptClaimHandoff` requires `resolveVerifiedActor`, which itself
requires a real persisted `OrgMember`), so the issue deadlocks in `pending`
(or stuck after a reject) with **no error raised at the moment of the
actual mistake** — the opposite of this codebase's own repeatedly-stated
fail-closed philosophy (`fire-heartbeat.ts`, `src/cli/ruclip.ts` headers).
Fixed by recalling the persisted record for `deps.approver`/`deps.handoffTo`
and handing off to *that* record (not the caller-supplied object), mirroring
the exact `recallOrgMember` pattern Guard C already uses for `actor`.

## What's new
- `applyApprovalTransition`'s `submit` and `reject` branches each now call
  `recallOrgMember(companyId, deps.approver.id, config)` /
  `recallOrgMember(companyId, deps.handoffTo.id, config)` and throw
  `ClaimAuthorizationError` if nothing is persisted, before calling
  `handoffClaim` — same file, 26 changed lines, one conceptual change
  applied at both call sites.
- 4 existing test files had their mock `agentdb_hierarchical-recall`
  handlers updated to also resolve the approver/handoff-target's semantic
  key (they only ever registered the *actor's* record, since nothing
  previously required the approver/handoffTo's to exist):
  `tests/control-plane/approval-gate.test.ts`,
  `tests/control-plane/approval-transition-validation.test.ts` (also updates
  one exact-call-sequence assertion to include the new recall call),
  `tests/control-plane/employee-interaction-profile.test.ts`,
  `tests/control-plane/heartbeats-and-comms.test.ts` — this IS the
  regression coverage for "no behavioral change for an already-valid
  approver/handoffTo," same discipline as the 2026-09-05 night's mock
  corrections.
- 1 new test file,
  `tests/control-plane/approver-existence-verification.test.ts` (3 tests):
  `submit` rejects a fabricated same-company approver; `submit` still
  succeeds for a real, persisted approver (no regression); `reject` rejects
  a fabricated same-company handoff target.
- This is a **different, deeper** gap than the one
  `tests/control-plane/cross-company-approver-verification.test.ts` already
  closed on 2026-09-02 — that one is a companyId **mismatch** check; this
  one is an **existence** check. A same-company but fabricated id was never
  caught by anything until tonight. That existing test/file is unchanged.

## Non-duplication check (STEP 2 — accumulated evidence)
Checked against `docs/dream-cycle/LEDGER.md` (frozen at 5 rows,
2026-09-06) and live GitHub state (59 open `dream-cycle` issues, 30 open
draft PRs, 0 merged since 2026-09-06 — see Ledger Check below) before
selecting a candidate. Explicitly NOT re-proposing any of: the
`wouldCreateCycle`/`complexityBudget.maxDepth` k-hop clamp (issue #67/#77,
PR #78, open); `applyApprovalTransition`(reject)'s `deps.handoffTo`
null-check running *after* 4 durable writes (issue #87, PR #88, open — an
**ordering** bug, orthogonal to tonight's **existence** bug, deliberately
not bundled together, same discipline as the 2026-09-05 night's H1/H2
split); `identity-map.ts` email-case sensitivity (issue #97, PR #98, open);
`setInteractionProfileConsent`'s forged-actor trust (issue #120, PR #121,
open); `checkOperatingBudget`'s `memory_list` page-truncation (issue #107,
PR #108, open). A parallel research fork independently scored 5 candidates
before settling on tonight's finding (27/30: fit 5, novelty 4, testability
5, measurability 4, prod-value 4, reviewability 5) over a dead-code
validation nit (14/30, confirmed intentional per `DOMAIN-MODEL.md` §1.4 and
its own test), a cross-company-approver angle (0/30, already closed by
existing coverage), and two speculative wire-shape findings in
`agentbbs-notification-channel.ts`/`autogenous-client.ts` (15/30, 11/30 —
the latter would land `INCONCLUSIVE/blocked`, no live service available).

## Ledger Check
`docs/dream-cycle/LEDGER.md` on `main` remains frozen at 5 rows
(2026-09-06) — already diagnosed extensively by this routine itself
(#71/PR#72, #91/PR#92, #116, #118, #126, #128) and not re-escalated a
further time here. Live-verified tonight via `list_issues`/
`list_pull_requests`: 59 open `dream-cycle`-labeled issues, 30 open draft
PRs, 0 merged since `main`'s last human-reviewed night (2026-09-06, commit
`6e73a8f`, which is also tonight's unchanged starting/ending `main` tip).
`FALLBACK=false` — GitHub MCP access worked tonight. Learning signal
applied: 0 of the last 14+ dream-cycle PRs merged → biased tonight's
candidate to the smallest viable single-conceptual-change diff (26
production lines, one function, two symmetric call sites).

## Build + control-plane discovery
`npm ci && npm run build`: clean, no wasm/NAPI step in this repo (pure
TypeScript → `tsc`), so no degradation to record. `npm run harness:score`/
`harness:genome`/`harness:mcp-scan` not invoked tonight (not needed for a
code-level correctness fix). `OPENROUTER_API_KEY` **is present** this
session (`LLM_EVAL=available`), but unused — tonight's candidate is a
deterministic control-plane fix with no model call in its own code path,
so no LLM-eval claim is made either way.

## Hypothesis (frozen before implementation)
> Given `applyApprovalTransition`'s `deps.approver` (action `submit`) /
> `deps.handoffTo` (action `reject`) are caller-constructed `OrgMember`
> objects never checked against persisted state, when a caller supplies an
> id with no persisted `OrgMember` record in the operation's own
> `companyId`, then `applyApprovalTransition` should reject with
> `ClaimAuthorizationError` before calling `handoffClaim` (fail closed),
> instead of silently succeeding and handing the claim to an unacceptable
> claimant, subject to: zero behavioral change for any caller that already
> supplies a real, persisted approver/handoffTo, and zero regressions in
> the existing 327-test suite.

## Evaluation receipt
Evaluator: real `npm test` (`npm run build && node scripts/run-tests.mjs
dist`), independently re-run by this session for both sides, not inferred
from logs.

| | Tests | Pass | Fail |
|---|---|---|---|
| Baseline (`6e73a8f`, production fix `git stash`-reverted, all test-file updates + new test file present) | 330 | 327 | 3 (exactly the 2 new "FIXED" tests demonstrating the live gap, plus the one call-sequence assertion that encodes the new recall call) |
| Candidate (this branch) | 330 | 330 | 0 |

`npm run build`: clean on both sides. `npm run harness:bench-verify`:
`Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)` — unchanged on
the candidate, confirmed by direct re-run, not assumed.

Diff size: 26 lines in the one production file (two symmetric call sites);
49 lines across 4 existing test files (mock-fixture corrections — adding
the approver/handoffTo's persisted record, the same class of fix the
2026-09-05 night made for a different mismatch); 1 new 233-line test file.
Single conceptual change, applied everywhere the pattern repeats (submit
and reject).

## Darwin results
Not run — single-conceptual-change fail-closed guard (recall-and-verify,
mirroring an already-adopted in-repo pattern), no fitness-tunable parameter
space. Consistent with every prior night's treatment of this class of
finding.

## Evidence classification
- OBSERVATION: `applyApprovalTransition` (lines ~880-884, ~955-959 pre-fix)
  passed `deps.approver`/`deps.handoffTo` straight to `handoffClaim` with
  only a truthiness check; `resolveVerifiedActor` (actor-credential.ts:314)
  and Guard C (agentdb-adapter.ts:616) both already `recallOrgMember` the
  *actor* side; `handoffClaim` (claims-authorization.ts:276) checks only
  `from.companyId === to.companyId`; `orgMemberClaimant` (same file:102-104)
  derives the claimant string from `kind`/`id`/`role`, all caller-supplied
  on the unverified side.
- OBSERVATION: `tests/control-plane/cross-company-approver-verification.test.ts`'s
  own header comment, written by a prior night, explicitly names this exact
  residual gap as "a real, pre-existing gap... not fixed here since it's
  out of [that night's] scope" — independent documentary confirmation this
  was a known-but-unaddressed gap, not a speculative new one.
- MEASUREMENT: baseline 327/330 (3 predicted failures); candidate 330/330;
  `harness:bench-verify` hash unchanged (both sides, both re-run directly
  by this session).
- INFERENCE: a forged/mistyped approver or handoff target produces a
  permanently-stuck issue (nobody can ever `acceptClaimHandoff` as a
  nonexistent `OrgMember`) rather than an immediately-visible error — not
  independently exercised against a live `ruflo` claims backend (none
  available this session), inferred from `acceptClaimHandoff`'s own
  "fails when nothing is pending for actor — that failure IS the
  authorization signal" contract (claims-authorization.ts:300) combined
  with `resolveVerifiedActor`'s hard requirement of a persisted `OrgMember`.
- DECISION: recall and use the **persisted** record as the `to`/`from`
  argument to `handoffClaim`, not the caller-supplied object — so no
  caller-supplied field beyond `id` (not `role`, not `kind`) is trusted
  downstream either, closing a secondary risk (a caller asserting a
  different `role`/`kind` than the real record) as a side effect of the
  same fix, not as a separately-scoped change.
- REJECTION: none this round — no competing hypothesis was implemented and
  found wanting (unlike 2026-09-05's H1/H2). The dead-code validation nit
  and the two speculative wire-shape candidates were rejected at the
  scoring stage, before implementation, not after evaluation.

## Reward-hack check
No existing assertion was weakened, removed, or skipped — every changed
test assertion was *extended* (the 4 mock-fixture files now also resolve a
key they previously left as `{results: []}` by omission, and one
call-sequence array grew by exactly the one new recall call the fix
introduces). No gold/expected value was changed to favor the candidate;
each extended assertion reflects an objectively necessary consequence of
the fix (an approver that now must exist in the mock, for a test that was
never exercising the "approver doesn't exist" path to begin with). No
threshold touched, no benchmark corpus altered, `.harness/bench.json` hash
confirmed byte-identical. No hidden cost: one additional `recallOrgMember`
round trip per `submit`/`reject` call, same O(1)-RPC shape as the existing
Guard C check, not a loop. No undocumented cache introduced. **Verdict:
CLEAR**, independently re-verified by this session (ran both the baseline
and candidate suites directly, not only the implementing pass).

## Security review
This is a security-adjacent correctness fix: it closes a trust gap where
one party to a claims handoff (the recipient) was never cryptographically
or persistence-verified, unlike the other party (the actor). No new
capability, credential, network, or filesystem surface — `recallOrgMember`
is an existing, already-used-elsewhere function; no new dependency; no new
MCP tool authority. Least-privilege preserved: the fix *restricts* what
previously succeeded (a fabricated approver/handoffTo now fails closed)
rather than expanding any caller's power. Residual risk this fix does NOT
address (scoped out deliberately, same discipline as prior nights' residual-risk
notes): (1) the separate, already-filed ordering bug (issue #87/PR#88) means
`deps.handoffTo`'s *existence* check (tonight's fix) still runs after the
same 4 durable writes that bug describes for the *null* check — a caller
who passes a well-formed-but-fabricated `handoffTo` on `reject` will still
see the issue/transition/edge persisted before the new existence check
throws; closing that ordering gap stays PR #88's job, not bundled here;
(2) no change to `claims_handoff`'s own authority model — a caller who
supplies a real, persisted, but *wrong* (e.g. wrong-role) `OrgMember` as
approver still succeeds, exactly as before, since nothing in this slice's
design ever claimed to check "is this id the *correct* reviewer," only
"does this id exist." Both are honestly out of scope, not silently
smoothed over.

## Scan findings (performance, tests)
- **Performance**: the fix adds one `agentdb_hierarchical-recall` round
  trip per `submit`/`reject` call — bounded, non-looping, same shape as the
  existing Guard C check this mirrors; no action needed.
- **Tests**: 4 separate test files needed a mock-fixture correction for
  this one fix, because none of them previously registered the
  approver/handoffTo's persisted record — a recurring tax on this kind of
  "retrofit an existence check" change (the 2026-09-05 night paid the same
  tax for a different reason, 5 call sites across 4 files). Flagged as a
  developer-experience opportunity for a future night, not fixed tonight
  (would be its own conceptual change): a shared test helper that
  auto-registers every `OrgMember` passed anywhere in a test's `deps`/
  `authorization` objects against the mock recall handler, so this class of
  mechanical 4-file update isn't required again next time.

## Competitors / prior art
| System | Relevant lesson | Grade |
|---|---|---|
| `paperclipai/paperclip` (named competitor) | This repo's own prior, independently-verified research (ADR-0001) established paperclip has no `ruflo`-style claims/handoff RPC layer at all — it does not model "transfer in-progress work to a named party" as a separate cross-service call the way `claims_handoff` does, so this specific bug class (trusting an unverified handoff recipient) has no direct analog there to compare against. | B (based on this repo's own previously-verified research, not independently re-fetched tonight) |
| OAuth 2.0 Token Exchange / delegation (RFC 8693) | Standard delegation practice: the party granting delegated authority is expected to independently resolve/verify the subject it delegates to, not trust a caller-supplied assertion of who that subject is — exactly the gap tonight's fix closes. | A (established IETF standard) |
| Object-capability / confused-deputy literature | Passing around a bare caller-supplied identifier instead of a verified reference/capability is a well-documented bug class (the general root cause behind confused-deputy problems); tonight's fix moves from "trust the id" to "resolve and hold the real record," the standard remedy. | A (widely documented security engineering principle) |
| This repo's own `checkAuthorizationGuard`/`resolveVerifiedActor` | Both already re-verify the ACTOR side of every approval decision against persisted state rather than the caller-supplied object (security-hardening rounds documented in this same file's own comments); tonight's fix is that exact, already-adopted pattern extended to the approver/handoff-recipient side it had not yet reached. | A (directly read from the code this session) |

## Witness
Hash scope: sha256 of this file's content from byte 0 up to (not
including) the line `## Witness` below — delete this section and
everything after it, then hash what remains.

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `694a924be9d887c562e5e61b5318f9ca3d7f86569234ef3037605967debb9313`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `f4621be4126d7de5672fc49b95819b603300696c945676a17c48929754054817`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm
   this is the session's starting (and, since this routine never merges,
   also `main`'s current) commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-11-10-correctness-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it matches the Witness stamp recorded here/in the ledger/issue/PR.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src/control-plane/store/agentdb-adapter.ts && npm run build && node scripts/run-tests.mjs dist` —
   confirm 327/330 pass, 3 fail (the two new "FIXED" tests plus the
   call-sequence assertion), matching the Evaluation receipt's baseline row.
5. `git checkout dream/2026-11-10-correctness -- . && npm ci && npm run build && node scripts/run-tests.mjs dist` —
   confirm 330/330 pass, and
   `git diff 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src/control-plane/store/agentdb-adapter.ts`
   shows exactly the two symmetric `recallOrgMember`-and-verify additions
   described above.

## Recommendation
`evaluated: accepted`. Human review required to merge — this session never
self-merges and never autonomously promotes candidate state. PR stays
draft.
