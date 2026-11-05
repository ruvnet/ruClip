# Security SOTA Report — 2026
### Dream Cycle 2026-11-05 — `ruvnet/ruClip`

## TL;DR

Tonight's rotated DEEP surface is **security** (rotated from the scheduled
**correctness** per the ledger's own learning signal — see below), SCAN
`performance,tests`. Candidate: retrofit `setInteractionProfileConsent`
(`src/control-plane/employee-augmentation/interaction-profile.ts`) to require
a cryptographically-verified `ActorAuthorization` (`resolveVerifiedActor`)
instead of a caller-constructed `actor: OrgMember` object. This closes a
**named, dated, previously-unfixable** actor-forgery gap: two design docs
(`ACTOR-IDENTITY-VERIFICATION.md` §6, `HUMAN-CREDENTIAL-ISSUANCE.md` §5) and
a standing test named `FINDING` all documented this exact vulnerability as
real but deliberately left open, because its blocking precondition — no
human `ActorCredential` issuance path existed — made the obvious fix
"permanently uncallable." That precondition shipped (`mintHumanActorCredential`,
commit `c6bee35`, hardened by commit `6e73a8f`/PR #15), but
`interaction-profile.ts` was never revisited (confirmed by git history: it
has exactly one commit, the initial scaffold, `35a2a15`). Tonight's
retrofit is the "genuine follow-up" both docs explicitly named and deferred.

**Verdict: ACCEPT.** 327/327 tests pass (unchanged count from baseline — one
`FINDING`-shaped vulnerability-demonstration test was converted, 1:1, into a
`FIXED`-shaped regression test proving the same attack now fails). The
forged-actor-object attack is no longer merely rejected at runtime — it is
no longer *expressible*: `tsc` refuses to compile a bare `OrgMember` where
an `ActorAuthorization` is now required (confirmed: reverting only the
source change against the updated tests reproduces exactly 6 `TS2345`
compile errors, one per now-incompatible call site).

## Rotation (Ledger Check, STEP 1/1.1)

`docs/dream-cycle/LEDGER.md` (5 rows, through 2026-09-06 — see "Ledger
staleness" below) plus live GitHub issue/PR history show the
`wouldCreateCycle`/`complexityBudget.maxDepth` correctness finding
independently (re)found and PR'd under the **correctness** DEEP surface on
**three** separate prior nights: 2026-09-05 (issue closed via merged PR #13),
2026-10-10 (issue #67 / PR #68, closed unmerged), and 2026-10-15 (issue #77 /
PR #78, still open). Per STEP 1.1's learning signal ("a finding repeated in
≥3 prior nights → rotate to the next slot's DEEP surface"), tonight's
scheduled `correctness` DEEP surface (slot 0, `DAYINT % 5 == 0`) rotates to
slot 1's DEEP surface, **security** — matching the most recent precedent for
a rotated night (PR/issue #114/#115, 2026-11-02, which rotated the full
slot, DEEP+SCAN together, not DEEP alone as an earlier night, #101, did).
SCAN stays as originally computed for slot 0 (`performance,tests`) since the
signal names DEEP rotation specifically; a security-relevant correctness gap
is well inside that intersection anyway.

**Fate of the last 7 nights' issues/PRs** (`gh`/GitHub MCP authenticated,
`FALLBACK=false`): all OPEN or CLOSED-unmerged — #117 (INCONCLUSIVE,
performance surface exhausted), #119/#118 (dev-experience, branch
contention), #115/#114 (perf), #113/#112 (security), #110/#109 (security).
Zero merged in this window. **Correction to a possible
misreading of that fact**: `docs/PLAN.md` line 29 states, as a *design*
property of `ruvnet/dream-machine` itself (not a malfunction of this repo),
**"Never merges — draft PRs only."** The 0%-last-14 learning signal still
fired (see Candidate below, biased small/reviewable), but the long
unmerged-PR backlog is not itself tonight's finding — it is already
well-documented (#71, #91, #114, #116, #118) and working as designed, not a
process failure to re-report a fifth time.

## What's new (this session's own archaeology, not literature)

This repo has no public literature to survey (ruvnet-only control plane);
"SOTA" here means prior Dream Cycle nights' own findings plus this session's
direct source/git/test archaeology:

1. **`ACTOR-IDENTITY-VERIFICATION.md` §6** (repo doc, 2026-09-01): names
   `setInteractionProfileConsent`'s actor-forgery risk as open, "carried
   forward until Phase 2's human issuance work closes it" (Grade A — primary
   source, this repo).
2. **`HUMAN-CREDENTIAL-ISSUANCE.md` §5** (repo doc): repeats the same named
   gap, explicitly as a "genuine follow-up... not done here to keep this
   slice's diff scoped" (Grade A).
3. **`tests/control-plane/employee-profile-access-control-gaps.test.ts`**
   FINDING 2 (pre-existing, passing): a live, runnable proof-of-concept of
   the exploit (Grade A — not a claim, a reproducible demonstration).
4. **Git history** (`git log --oneline -- interaction-profile.ts`): exactly
   one commit ever touches this file (`35a2a15`, the initial scaffold) —
   `mintHumanActorCredential` (`c6bee35`) and its TOCTOU hardening
   (`6e73a8f`/PR #15) both post-date it and never revisited it (Grade A —
   derived directly from this repo's own history, not inferred).
5. **Competitor**: `paperclipai/paperclip` (this repo's stated reference
   point, §1 of `docs/PLAN.md`) has no equivalent per-employee consent/
   interaction-telemetry feature to compare against — its org-chart/approval
   model does not model opt-in behavioral telemetry at all (Grade C — absence
   noted, not independently re-verified against paperclip's current source
   this session).

## Hypothesis (frozen before implementation)

> Given `setInteractionProfileConsent`'s existing `actor.id === orgMemberId`
> self-check (trusting a caller-constructed `OrgMember` object, with no
> cryptographic verification — demonstrated exploitable by the pre-existing
> `FINDING` test), when the function is retrofitted to accept an
> `ActorAuthorization` and resolve the real actor via the already-shipped
> `resolveVerifiedActor` (the same mechanism `applyApprovalTransition`/
> `persistIssue`/`persistHeartbeatSchedule` already use, now viable for
> `kind: 'human'` actors since `mintHumanActorCredential` shipped), then:
> (a) the forged-actor exploit must fail closed, and (b) the legitimate
> self-service case (a human or agent presenting their OWN validly-minted
> credential) must still succeed — with zero regression across the other
> 326 baseline-passing tests.

## Candidate

`src/control-plane/employee-augmentation/interaction-profile.ts`:
`setInteractionProfileConsent`'s 4th parameter changes from `actor: OrgMember`
to `authorization: ActorAuthorization`; the function now calls
`resolveVerifiedActor(authorization, config)` first, then applies the exact
same `actor.companyId !== companyId` (mirroring `checkAuthorizationGuard`'s
own "security review round 7" correction, applied here for the first time)
and `actor.id !== orgMemberId` checks as before — now against a trustworthy
actor, not a caller-supplied one. One conceptual change, 1 source file + 2
test files (mechanical fixture substitution using the pre-existing
`credentialFor`/`humanCredentialFor` test helpers), **177 insertions / 83
deletions**, well under the 300-line target.

## Baseline vs. candidate (real evaluator: `npm test`)

- **Baseline** (parent, this session's first action before any change):
  `npm ci && npm run build && npm test` → **327/327 pass**, including the
  pre-existing test literally named
  `FINDING: setInteractionProfileConsent grants/withdraws consent on a real
  OrgMember's behalf when the caller constructs a forged actor object...`
  — i.e. the baseline's own test suite *proves* the vulnerability is live,
  not merely suspected.
- **Candidate**: `npm run build && npm test` → **327/327 pass** (same total;
  the `FINDING` test was converted 1:1 into `FIXED: setInteractionProfileConsent
  no longer grants/withdraws consent on a victim's behalf for an attacker
  holding only their OWN valid, verified credential...`, which now asserts
  the same attack **rejects** with `PrivacyConsentError`).
- **Compile-time confirmation**: building the candidate's *updated tests*
  against the *original* (reverted) source fails with exactly 6 `TS2345`
  errors — one per call site that used to pass a bare `OrgMember` — i.e. the
  old forged-object shape is no longer merely rejected at runtime, it is
  rejected by the type system before the code can even run.
- **Regression scope**: 0 other files touched beyond the 1 source file + 2
  test files; the other 320 tests (including every other
  `interaction-profile.ts`/`agentdb-adapter.ts`/`actor-credential.ts` test)
  pass unchanged.

## Darwin

Not run. This is a single-conceptual-change authorization retrofit, not a
fitness-tunable parameter — no genome/fitness function applies, consistent
with how prior correctness/security fixes of this shape (2026-09-05,
2026-09-06) also skipped Darwin.

## Reward-hack / adversarial critique (independent pass, same session,
performed adversarially against the candidate rather than by its author)

- Did it weaken the benchmark or alter gold answers? No — no benchmark/gold
  corpus exists for this change; the real `npm test` suite ran unmodified
  except for the 1:1 FINDING→FIXED conversion and 4 mechanical fixture
  substitutions (bare `OrgMember` → `credentialFor`/`humanCredentialFor`,
  pre-existing helpers, not new primitives invented to make the test pass).
- Did it cherry-pick or hide cost? No new runtime dependency, no new network
  call — `resolveVerifiedActor`/`mintHumanActorCredential` were already
  shipped, already-tested machinery; this change is pure reuse.
- Does the fix generalize or just relabel the gap? Checked for other
  callers: `grep -rn setInteractionProfileConsent` found only the function
  definition and the 2 test files — no other production call site exists
  yet (Phase 6a has no live caller besides tests), so there is nothing left
  un-retrofitted.
- Undocumented cache reliance? None introduced.
- Threshold/gate touched? None.

## Security review (STEP 15)

This candidate *is* a security fix (closes an authorization-forgery gap on
a consent-setting function touching PII-adjacent behavioral data). No new
MCP tool authority, no new credential/secret exposure, no filesystem/network
scope change. Reuses the existing, already-reviewed `resolveVerifiedActor`
mechanism verbatim rather than inventing a parallel one — least-privilege
preserved. No agent-impersonation, cross-agent, or benchmark-poisoning
surface touched.

## Evidence classification

- OBSERVATION: `FINDING` test passed pre-change (327/327 baseline, forged
  actor accepted).
- MEASUREMENT: `npm test` pass/fail counts before (327/327, vulnerable) and
  after (327/327, fixed); `tsc` error count (6) when the old source is
  paired with the new tests.
- INFERENCE: the git-history gap (no commit between `35a2a15` and now)
  establishes the fix was never attempted, not that it was attempted and
  reverted.
- DECISION: retrofit now, per both design docs' own named "genuine
  follow-up" framing — not a new policy call invented tonight.
- REJECTION: n/a — no hypothesis was rejected tonight.

## Witness

- Session starting commit: `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (`REPORT_HASH`, of this file as published, pre-witness-section
  edit — see verifier step 2): `5f0c841f7228b7c0573f8ad4e37a661b713458e0e5d7f01a2a98a4dd8cc63e00`
- Witness stamp (`sha256(REPORT_HASH || SESSION_COMMIT)`):
  `4a2f4da56ce94c6b271be3d95e70d24df040ed9301c0a8a2355199696b302ffe`

**Verifier procedure** (anyone can reproduce):
1. Check out `ruvnet/ruClip` at commit `6e73a8f060bcbb69965a50ffe4627e33622d4094`.
2. Take this gist's content as it existed immediately before this Witness
   section was filled in (the published gist URL's revision history, or the
   copy committed to the PR branch at `docs/dream-cycle/2026-11-05-security-report.md`
   prior to this section).
3. `sha256sum` that content; it must equal `REPORT_HASH` above.
4. Compute `sha256(REPORT_HASH + SESSION_COMMIT)` (string concatenation, no
   separator) and confirm it equals the witness stamp above.
5. Confirm the PR/issue referencing this gist cites the same witness stamp
   verbatim, and that `git log` on the PR branch shows `SESSION_COMMIT` as
   its merge-base with `main`.

## Recommendation / next steps

1. **Human review**: merge policy requires human review (Dream Machine never
   self-merges/self-promotes) — this PR stays draft.
2. **Follow-up** (not done tonight, scope discipline): no production caller
   of `setInteractionProfileConsent` exists yet; when one is built (e.g. a
   future `ruclip consent` CLI subcommand mirroring `ruclip login`), it
   should mint/reuse a human `ActorCredential` the same way `ruclip login`
   already does for `mintHumanActorCredential`.
3. **Follow-up**: `docs/design/ACTOR-IDENTITY-VERIFICATION.md` §6 and
   `docs/design/HUMAN-CREDENTIAL-ISSUANCE.md` §5's "remains open" lists
   should be updated to mark this item closed, mirroring how `EMPLOYEE-
   INTERACTION-PROFILE.md`/`ACTOR-IDENTITY-VERIFICATION.md` document other
   closed gaps — left to the PR's own review thread rather than done
   unilaterally tonight (doc-truth maintenance is a reasonable ask for the
   human reviewer, not a unilateral rewrite of a locked design decision).
