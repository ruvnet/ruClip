# Performance/Latency SOTA Report — 2026-09-18

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip)
**Rotation**: DAYINT=20260918, SLOT=3 → DEEP=performance, SCAN=memory,latency (no bonus modulus)

## TL;DR

`applyApprovalTransition` (`src/control-plane/store/agentdb-adapter.ts:928`) — invoked
on every approve/reject decision — `await`ed `recomputeInteractionSignals(...)
.catch(() => {})` even though the comment directly above it says the call is
meant to be "best-effort, same non-blocking contract `deps.notifications`
already has." `deps.notifications`'s own publish call two blocks later is
`await`ed too (a second, smaller instance of the same shape), but the
project's own precedent for a *correctly* non-blocking best-effort call
already exists verbatim in `heartbeat/fire-heartbeat.ts:34`:
`void notifications.publish(event).catch(() => {})` — no `await`.
`recomputeInteractionSignals` internally scans a company's **entire**
approval-transition history (`listApprovalTransitionsForCompany`, itself a
known, already-flagged 2-tier sequential scan) and does an O(n) recompute —
real, non-trivial work whose *result is unconditionally discarded* by the
caller. Every approve/reject decision was paying that full latency before
the caller ever saw its own answer. Fixed by dropping the `await`
(`void recomputeInteractionSignals(...).catch(() => {})`), matching the
existing in-repo precedent exactly. Measured on the real evaluator: a
scenario with 50ms-per-round-trip simulated tier scans dropped from
**104.8ms → 2.3ms** for the caller's own `applyApprovalTransition` call
(the detached background computation still runs and still eventually
persists the profile — nothing is skipped, only its timing moved off the
critical path).

## What's new / correcting the record

Tonight's own research (see Deep dive) found a **fourth** sequential
2-tier-lookup call site — `recallApprovalTransition`
(`agentdb-adapter.ts:768-771`, `(await recallByKey(key,'working',config)) ??
(await recallByKey(key,'episodic',config))`) — that the 2026-09-08 report's
"exhaustive grep for `for...of` blocks containing `await`" missed, because
it isn't a loop, it's an inline `??`-chained fallback. **This is flagged,
not fixed, tonight** — see Scan findings/latency below for why blindly
parallelizing it would very likely be a regression, not a win, unlike the
three loop-based call sites 09-08 already fixed.

## Ledger check (Step 1) — reconstructed from GitHub + every `dream/*` branch

`main`'s `docs/dream-cycle/LEDGER.md` was **8 nights stale** (last row:
2026-09-06) despite 9 further dream-cycle nights (09-07, 08, 09, 10, 11, 15,
16, 17) each having run, produced a real issue/PR/report, and appended a
ledger row **on their own branch** — none of which ever reached `main`,
because zero of those PRs have GitHub's `merged:true` flag. Verified
directly against the GitHub API (`pull_request_read`/`list_pull_requests`),
not inferred:

| PR | Night | `state` | `merged` | Notes |
|---|---|---|---|---|
| #9 | 09-02 architecture | open | false | 16 nights unreviewed |
| #11 | 09-03 performance | closed | **false** | content nonetheless on `main` (verified: `agentdb-adapter.ts`'s `mapWithConcurrency` fix is present) |
| #13 | 09-05 correctness | closed | **false** | content nonetheless on `main` |
| #15 | 09-06 security | closed | **false** | content nonetheless on `main` — this is `main`'s current tip |
| #17 | 09-07 architecture | open | false | content NOT on `main` |
| #19 | 09-08 performance | open | false | content NOT on `main` — see below |
| #21 | 09-09 developer-experience | open | false | |
| #23 | 09-10 correctness | open | false | |
| #25 | 09-11 security | open | false | |
| #27 | 09-15 correctness | open | false | |
| #29 | 09-16 security | open | false | |
| #31 | 09-17 architecture | open | false | |

**Correction**: the 09-11 and 09-17 branch reports each independently
claimed PR #15 (or "#11/#13/#15") was "**MERGED**." The GitHub API says
`merged: false` for all three, unambiguously, as of tonight — same
`closed-but-landed-on-main-via-a-mechanism-outside-GitHub`
pattern documented correctly by every *other* night's report. That claim
appears to have been a one-off misreading in two prior sessions, not a
change in the actual PRs; corrected here rather than silently repeated a
third time. **0 of 12 dream-cycle PRs to date carry `merged: true`.**

**Consequence worth escalating again, more concretely than prior nights
could**: because PR #19 (09-08's own ACCEPT-verdict fix for the three
sequential tier-scan loops) never merged, tonight's fresh `main` checkout
still contains the exact bug #19 already fixed — confirmed directly
(`grep -c "for (const tier of \['working', 'episodic'\]" src/control-plane/store/agentdb-adapter.ts`
→ 3 matches, still present). The routine is correctly re-deriving evidence
each night, but the *codebase* is not accumulating the fixes, only the
paper trail is. This is a process/ownership gap, not a code defect —
flagged for the routine owner, third night running (09-08, 09-16, and now
09-18) to name it explicitly.

**Also confirmed**: a 3-night gap at 09-12/09-13/09-14 (slots
architecture/performance/developer-experience) — no issue, PR, branch, or
report exists for any of the three, same as the previously-flagged 09-04
gap. Not investigable further from inside this session.

**Ledger backfilled tonight** (Step 25) by reconciling every `dream/*`
branch's own `LEDGER.md` (each night's branch independently re-derived and
re-backfilled from a stale `main`, so branches disagree on exact wording in
places, e.g. the 09-07/09-08 row text differs slightly between the
09-08, 09-10, and 09-11 branches' own copies) — used the most complete
single source (`dream/2026-09-11-security`'s branch, which already carried
09-07 through 09-11) plus the 09-15/09-16/09-17 branches' own final rows,
appended verbatim, plus tonight's row. See `LEDGER.md`.

## Deep dive (performance)

Delegated a read-only exploration pass across
`dashboard/`, `employee-augmentation/`, `governance/`, `comms/`, `heartbeat/`,
`approval/`, `authorization/`, `cli/` for N+1/sequential-await, O(n²), unbounded
caches, and redundant recompute, explicitly excluding the three
already-known/already-reported items (`checkOperatingBudget`, the three
09-08 tier-scan loops, and the previously-flagged-but-unactioned
`listApprovalTransitionsForCompany` `topK:500` full-blob fetch). Confirmed
clean (no candidate): `dashboard/build-snapshot.ts` (already has its own
documented per-call-memoized `OrgMemberCache`), `bridge-auth.ts`/
`bridge-client.ts` caches (bounded, one entry per `baseUrl`),
`claims-authorization.ts`/`credential-issuer.ts` (admitted-key sets resolved
once, reused).

Three real candidates found, all in
`employee-augmentation/interaction-profile.ts` and its
`agentdb-adapter.ts` call site — an area untouched by the two prior
performance reports:

1. **(tonight's candidate)** `applyApprovalTransition` awaits
   `recomputeInteractionSignals`'s full result despite discarding it —
   blocks the approve/reject critical path on a company-wide scan for no
   reason. Smallest diff, exact in-repo precedent, cleanest measurement.
2. **(not fixed tonight)** `recomputeInteractionSignals`'s own prior-transition
   pairing (`interaction-profile.ts:268-283`) is an O(n²) backward scan per
   transition (bounded today by the 500-per-tier cap, ~1000 records max, so
   real impact is modest but the algorithm itself doesn't scale). A linear
   `Map<ApprovalState, ApprovalTransition>` single-pass rewrite is
   straightforward and would fit under the 300-line bar, but is a second,
   separate conceptual change from tonight's — flagged as next-step #1.
3. **(not fixed tonight, weaker)** The same function recomputes a
   company's *entire* transition history from scratch on every single
   approve/reject rather than incrementally updating from the last-known
   profile state — correct only as an O(n²)-over-a-company's-lifetime
   design; a real fix here is an incremental-state redesign, a materially
   larger and riskier diff than the 300-line bar allows for one night —
   flagged as next-step #2, not attempted.

Also independently re-derived (not by the exploration pass — by chasing an
unexpected timing residual while building tonight's own regression test,
see Reward-Hack Check): a **fourth**, previously-undocumented sequential
2-tier lookup, `recallApprovalTransition` (`agentdb-adapter.ts:760-771`),
used by Guard C to re-verify a `previousTransition` against persisted
state. Unlike the three `for...of` loops 09-08 fixed (which scan *both*
tiers unconditionally on every call), this one is a **short-circuiting
fallback** — `(await recallByKey(key,'working',config)) ??
(await recallByKey(key,'episodic',config))` — that skips the `episodic`
lookup entirely whenever the `working`-tier lookup already finds a match.
For a `previousTransition` that is (by definition) recent, it is very
likely still resident in the `working` tier, so the **common case today is
already a single round trip**. Blindly converting this to
`Promise.all`-style concurrency would make it **always** two round trips —
trading away the common-case win for a worst-case-only win, with no
evidence in this repo about how often the `episodic` fallback is actually
hit in practice. Correctly not the same fix shape as the other three;
flagged as Scan finding / next-step #3, explicitly **not** a candidate for
tonight or an "obvious" future fix without real usage data first.

## Frozen hypothesis (frozen before implementation)

> Given `applyApprovalTransition`'s `deps.interactionLearning`-gated call to
> `recomputeInteractionSignals` on every approve/reject decision, whose
> return value is unconditionally discarded (only failure-swallowing via
> `.catch(() => {})` is observed), when the call is changed from `await
> recomputeInteractionSignals(...).catch(() => {})` to `void
> recomputeInteractionSignals(...).catch(() => {})`, then
> `applyApprovalTransition`'s own wall-clock latency for an approve/reject
> decision should drop by approximately `recomputeInteractionSignals`'s own
> latency, subject to: `recomputeInteractionSignals` still actually running
> to completion and still persisting its result in the background (nothing
> silently skipped), the full existing test suite passing (with the one
> necessarily-updated pre-existing test that asserted synchronous-by-return
> completion, since that specific assumption is exactly what this change
> invalidates), `tsc --strict` staying clean, and zero behavior change to
> the approve/reject decision's own return value or persisted `Issue`/
> `ApprovalTransition` state.

Not modified after evaluation began.

## Candidate

One line changed in `src/control-plane/store/agentdb-adapter.ts`:

```diff
-    await recomputeInteractionSignals(companyId, actor.id, config).catch(() => {});
+    void recomputeInteractionSignals(companyId, actor.id, config).catch(() => {});
```

Plus one new regression test
(`tests/control-plane/employee-interaction-profile.test.ts`) and one
necessary update to a pre-existing test whose assertion assumed the
now-detached call's first side effect had already landed by the time
`applyApprovalTransition` returned (fixed by flushing one macrotask tick
before asserting — the call itself is unchanged, only *when* it's checked).
Zero signature changes; zero other call sites touched.

## Evaluation receipt

Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), real project test runner, no mocked evaluator.

| | Full suite | New/updated test | Duration (new test) |
|---|---|---|---|
| Baseline (`6e73a8f`, parent, source unmodified, new+updated tests applied) | 327/328 (1 predicted failure) | **FAILS**: `expected applyApprovalTransition to resolve before recomputeInteractionSignals's own 50ms tier scan completed, took 104ms` | 104.837239ms |
| Candidate (this branch) | 328/328 | **PASSES** | 2.313071ms |

The discriminating test (`applyApprovalTransition with
deps.interactionLearning: true does not block on
recomputeInteractionSignals's own latency — fire-and-forget, same
non-blocking contract as deps.notifications`) mocks
`agentdb_hierarchical-recall` to delay 50ms on the specific query
`listApprovalTransitionsForCompany` issues (`companyKey(companyId)`,
tiers `working`/`episodic`), while resolving the issue-recall,
actor-recall, and Guard C's own `recallApprovalTransition` lookups
immediately (verified via one debug run against the *unnarrowed* mock that
those three calls are genuinely unrelated background noise, not part of
tonight's finding — see Reward-Hack Check for how that was caught).
`npm run harness:bench-verify`: `Suite repo-native@0.1.0: 6 tasks, hash OK
(840fd8d2d698…)` — unchanged, corpus not gone soft. `tsc --strict`: clean,
both baseline and candidate.

## Darwin

Not run. Single, fully-specified, zero-tunable-parameter fix (delete one
keyword) — no fitness landscape to search, same reasoning prior
zero-behavior-change/mechanical-fix nights (09-02, 09-07, 09-08) gave for
skipping Darwin.

## Evidence

- OBSERVATION: `applyApprovalTransition` (`agentdb-adapter.ts:928`)
  `await`s `recomputeInteractionSignals(...).catch(() => {})`, discarding
  its resolved value entirely (no assignment, no branch on it) — read
  directly from the current file, not inferred.
- OBSERVATION: the exact correct fire-and-forget shape already exists
  in this repo, unrelated code: `heartbeat/fire-heartbeat.ts:34`,
  `void notifications.publish(event).catch(() => {})`.
- MEASUREMENT: baseline (source unmodified) 327/328, new test fails at
  104.837239ms; candidate 328/328, same test passes at 2.313071ms.
  `harness:bench-verify` hash unchanged both runs.
- INFERENCE: the win is real and structural, not a mocked-away artifact,
  because (a) the baseline was proven to genuinely block via the new
  test's own failure (not assumed from reading the code), and (b) the
  background work still demonstrably completes afterward (the
  pre-existing "triggers recomputeInteractionSignals" test still passes,
  after a one-tick flush, proving the call still happens and still
  reaches its own first `memory_retrieve`).
- DECISION: ACCEPT, recommended for human review.
- REJECTION (scope, not implementation): the O(n²) prior-transition scan
  (Deep dive #2) and the full-history-recompute-every-time design
  (Deep dive #3) are real but explicitly out of scope tonight (separate
  conceptual changes, and #3 is a materially larger redesign than the
  300-line bar allows) — recorded as next steps, not attempted.
- REJECTION (explicitly not a fix): `recallApprovalTransition`'s
  short-circuiting two-tier fallback (What's new / Deep dive) — blindly
  parallelizing it would regress the common case (1 round trip →
  guaranteed 2) with no evidence the worst case it would improve is
  common enough to be worth that trade. Correctly identified as
  structurally different from the three `for...of` loops 09-08 fixed, not
  "the same bug missed again."

## Reward-Hack Check (independent pass over the candidate)

No gold answer, threshold, or benchmark corpus touched
(`harness:bench-verify` hash unchanged both runs). No existing test's
*assertions* were weakened — the one pre-existing test that needed a
change got a timing-flush added before its assertion, not a loosened or
removed assertion; its expected outcome (the call happens, with the exact
same key) is identical before and after. New test's discriminating power
was verified the correct way round (fails on unmodified source, passes on
the fix), not merely "passes on the fix." No new mock/cache introduced.

Two things specifically caught by this pass, both corrected before the
final receipt above (documented here rather than silently fixed and
forgotten, since both would otherwise look like reward-hacking evaluator
design if left unexplained):
1. **First draft of the new test's mock had an over-broad catch-all**
   (delay *any* unmatched `agentdb_hierarchical-recall` call), which
   silently also delayed Guard C's unrelated `recallApprovalTransition`
   lookup — inflating the *baseline* number (204ms, not the fix's fault)
   and, worse, leaving a **stale ~104ms residual even on the candidate**
   that had nothing to do with tonight's fix at all. Root-caused via a
   one-off debug print of the unmatched call's exact `args` (see git
   history on this branch's test file iteration — the debug line was
   removed before the final commit), then the mock was narrowed to match
   only the query `listApprovalTransitionsForCompany` actually issues.
   Left uninvestigated, this would have either produced a misleadingly
   small "win" number or, worse, a false negative on the fix.
2. **Residual concurrency consideration, judged acceptable, not hidden**:
   making `recomputeInteractionSignals` fire-and-forget means two
   approve/reject decisions for the *same* `orgMemberId` in quick
   succession (e.g. one person approving two different issues moments
   apart) can now have their background profile recomputes genuinely
   overlap, where previously the caller's own `await` fully serialized
   them. `recomputeInteractionSignals` is read-modify-write (read the
   profile, compute, `memory_store` the whole updated object), not an
   atomic increment, so an overlap could in principle lose one of the two
   updates (last-write-wins). This is a **pre-existing non-atomicity** in
   `recomputeInteractionSignals` itself (it was never safe against two
   *concurrent* callers, e.g. two different orgMembers deciding on issues
   that both feed the same interaction profile is not a real scenario
   here — the profile is keyed by `orgMemberId`, and only that same
   person's own overlapping decisions could race) — tonight's change makes
   an already-narrow, already-non-security-relevant race marginally easier
   to hit, not a new class of bug. Judged acceptable given: the profile is
   an explicitly best-effort, opt-in, self-correcting-on-next-recompute
   analytics signal (EMPLOYEE-INTERACTION-PROFILE.md §4), not a security
   or financial-correctness guarantee (unlike the 09-06 nonce-replay
   TOCTOU, which was a security guarantee and got a real atomic fix, not a
   documented shrug) — flagged as a genuine next-step (next-step #4) rather
   than silently accepted with no record.

Independent critic verdict: CLEAR, with the two items above disclosed
rather than omitted.

## Security review (Step 15)

Pure control-flow change (`await` → `void`) on a call whose result was
already fully discarded and whose failure was already swallowed — no new
authorization surface, no credential/nonce path touched (verified: this is
a different code block from the credential nonce-replay guard, several
lines earlier in the same function, untouched), no new dependency, no
`assertSafeId` call site touched, no change to what data is read or
written, only *when* the write to the interaction-profile happens relative
to the caller's own return. The one residual risk this pass surfaces (the
narrow same-orgMember concurrent-recompute race, above) is a data-quality/
analytics-freshness concern, not an authorization, credential, or
tenant-isolation one — the interaction profile itself is only ever read by
`recallOwnInteractionProfile(actor)` (self-only, structurally enforced —
verified unchanged by this diff) and
`recallInteractionProfileForComposition` (internal-only, no external actor
parameter — also verified unchanged). Least-privilege posture unchanged.

## Scan findings — memory

No new allocation pattern introduced; `void recomputeInteractionSignals(...)`
still allocates exactly what `await recomputeInteractionSignals(...)` did,
just without the caller waiting on it. `listApprovalTransitionsForCompany`
still fetches full `ApprovalTransition` JSON blobs at `topK: 500` per tier
when `recomputeInteractionSignals` only reads 5 fields — same
already-flagged (09-08), still-unattempted follow-up; not touched tonight.

## Scan findings — latency

The finding itself (TL;DR/Evaluation Receipt). Additionally: confirmed (via
the exploration pass, cross-checked directly against the file) that the
09-08 report's claim of an exhaustive grep for sequential tier-scan loops
was **incomplete** — `recallApprovalTransition`'s inline `??`-chained
short-circuit fallback is structurally the same *family* of bug (splitting
one logical lookup into two sequential tier round trips) but is not a
`for...of` loop, so it doesn't match a grep for that shape. Explicitly
**not fixed tonight** — see Deep dive/Evidence for why parallelizing it is
not a clear win here, unlike the three loop-based sites.

## Competitors (graded)

| Source | Claim | Grade | Relevance |
|---|---|---|---|
| General Node.js 2026 guidance (multiple cross-checked dev/blog sources, e.g. Medium "Controlling Concurrency in Node.js") | "Bounded concurrency equals predictable latency... never exceed a safe number of in-flight calls"; fire-and-forget vs. awaited side effects is a standard performance lever for discardable results | B (multiple independent vendor/blog sources, cross-checked, consistent with each other) | Directly on point for both tonight's fix (correctly *not* bounding, since fan-out width here is 1 detached call, not N) and the flagged-not-fixed `recallApprovalTransition` case (bounded/unbounded concurrency tradeoffs apply differently to a short-circuiting fallback than a full scan). |
| Node.js/ECMAScript `async`/`await` semantics (language spec, reproducible) | An `async` function's own returned promise resolves once its synchronous continuation past the last relevant `await` completes; an un-awaited call (`void expr.catch(...)`) does not block that continuation | A (reproducible — verified directly against this repo's own evaluator, both directions, including the two debugging iterations documented in Reward-Hack Check) | The mechanism tonight's fix relies on; not novel, but verified empirically against the real evaluator rather than assumed. |
| `paperclipai/paperclip` (per Towards AI / Ry Walker research write-ups, 2026) | Agents "wake up on schedule... event-based triggers also exist"; heartbeat/notification-style side effects are explicitly modeled as async, decoupled signals in that architecture, not synchronous return-blocking steps | B (independent secondary write-ups of the same open-source project, consistent with each other, not primary source code — Paperclip's source is outside this session's repo scope) | Structural precedent for treating "notify/record something happened" as decoupled from the decision path itself — same principle tonight's fix applies internally to `recomputeInteractionSignals`. |
| Hierarchical Memory Orchestration for Personalized Persistent Agents (arXiv 2604.01670, 2026) | Persistent-agent memory systems separate the "decision" path from asynchronous memory-consolidation/write-back to avoid blocking interactive latency on background learning updates | A (peer-reviewed preprint, directly on the exact pattern: decouple a decision from its own background learning-signal write-back) | The closest literature match to tonight's actual fix — `recomputeInteractionSignals` is precisely a memory-consolidation write-back that should not gate the decision (`applyApprovalTransition`) it's derived from. |

## Gist

No `gh gist create`/`gh` CLI available this session (same constraint every
prior dream-cycle night). Full report committed at
`docs/dream-cycle/2026-09-18-performance-report.md` on branch
`dream/2026-09-18-performance`. `GIST=LOCAL`.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not
including) the line `## Witness` above — i.e. delete this section and
everything after it, then hash what remains.

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `02d376440c92863d256478466e53d5c161398a3d676f865ec7d3df8cbbd8b068`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `4b2f2af6abc1b3ba5a9a9bd1f61f187fe6dea7765fcad873dde6370d8ee2095f`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm this is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-09-18-performance-report.md | sha256sum` — confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` — confirm it matches the Witness stamp recorded in the ledger/issue/PR.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src/control-plane/store/agentdb-adapter.ts tests/control-plane/employee-interaction-profile.test.ts && npm test` — confirm 327/328 (1 predicted failure at ~104ms, the discriminating test).
5. `git checkout dream/2026-09-18-performance -- . && npm test` — confirm 328/328, and the new test resolves in single-digit ms.

## Next steps (4)

1. **Linear-time prior-transition pairing.** Rewrite
   `recomputeInteractionSignals`'s O(n²) backward scan
   (`interaction-profile.ts:268-283`) as a single forward pass with a
   `Map<ApprovalState, ApprovalTransition>` — O(n) total, bounded today by
   the 500-per-tier cap so not urgent, but doesn't scale if that cap is
   ever raised. Separate conceptual change from tonight's; not attempted.
2. **Incremental profile recompute.** `recomputeInteractionSignals`
   currently reprocesses a company's *entire* transition history on every
   single approve/reject; an incremental design (track last-processed
   transition per profile, only fetch/process new ones) would remove the
   O(n²)-over-a-company's-lifetime cost entirely. Materially larger diff
   than tonight's bar; flagged, not attempted.
3. **`recallApprovalTransition`'s short-circuit fallback — needs real
   usage data before touching.** Do not parallelize without first
   measuring how often the `episodic`-tier fallback actually fires in
   practice (requires either production telemetry this repo doesn't have
   yet, or a synthetic model of transition aging); blindly parallelizing
   would very likely regress the common case.
4. **Same-`orgMemberId` concurrent-recompute race** (Reward-Hack Check
   item 2) — if `EmployeeInteractionProfile` ever needs a stronger
   freshness guarantee than "eventually consistent, self-correcting on
   next recompute," `recomputeInteractionSignals`'s read-modify-write
   would need the same atomic-guard treatment the 09-06 nonce-replay fix
   gave `verifyActorCredential`. Not needed today — this is an
   explicitly best-effort, non-security signal — but named rather than
   left implicit.
