# Correctness SOTA Report — 2026

**Repo**: `ruvnet/ruClip` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`
**Rotation**: SLOT=0 → DEEP=correctness, SCAN=performance,tests (2026-09-15, DAYINT=20260915, DAYINT%25=15, no bonus)

## TL;DR
`ruvnet/ruClip`'s test `recordCausalEdge refuses a reports_to edge that would
close a cycle` (`src/control-plane/store/agentdb-adapter.test.ts:175`) does
**not actually verify cycle detection**. It asserts only
`assert.rejects(fn, AgentDbBridgeError)` — `instanceof`, nothing about *why*
the promise rejected — and its mock registers a handler for
`agentdb_graph-query` only, not `agentdb_causal-edge`. `bridge-client.ts`'s
`invokeTool` wraps *any* thrown error from the fetch implementation
(including the mock harness's own `Error("No mock handler registered for
tool 'agentdb_causal-edge'")`) in a generic `AgentDbBridgeError`. So if
`wouldCreateCycle` were completely broken (always `false`, cycle prevention
silently disabled — exactly the class of bug this repo's own 2026-09-05 and
2026-09-10 correctness nights each found once already, at this same call
site), the test would still report a pass, for the wrong reason. **Verified
empirically**, not asserted: forced `wouldCreateCycle` to `return false`
unconditionally, rebuilt, ran the test file — the pre-fix test still passed
(13/13); an independent fresh critic subagent reproduced the same result
from scratch (13 pass, 0 fail) and then confirmed the fixed test correctly
fails under the identical injected bug (12 pass, 1 fail, the target test).

## What's new
- `agentdb_causal-edge` is now mocked to succeed (not left unregistered) in
  that one test, so a broken cycle-check would actually reach and complete a
  real edge write — which would make `assert.rejects` genuinely fail — instead
  of masquerading as a cycle rejection via the generic bridge-unreachable path.
- The assertion is strengthened from a bare `instanceof AgentDbBridgeError`
  to `instanceof AgentDbBridgeError && /would close a cycle/.test(message)`,
  plus `assert.deepEqual(calls.map(c => c.toolName), ['agentdb_graph-query'])`
  — proving the edge write never happened, mirroring the rigor the sibling
  `persistIssue refuses a parent_of edge that would close a genuine (non-self)
  cycle...` test already applies one file up
  (`tests/control-plane/agentdb-adapter.test.ts:211`).
- No production code changed. One conceptual change, one test, one file:
  `src/control-plane/store/agentdb-adapter.test.ts`, +17/-2.

## A note on scope (why no production fix tonight)
This is a **test-assurance gap**, not a live production bug: `wouldCreateCycle`
itself is currently correct (confirmed by reading it and by the 2026-09-05
fix already on `main`). The finding is that the regression test guarding it
was blind to its own subject — if a future change broke `wouldCreateCycle`,
this suite would not have caught it. Tonight's fix closes that blind spot
before it costs a real incident, consistent with the Final Operating
Principle ("reducing uncertainty," not "producing a PR").

## Competitors / prior art (a passing assertion that never actually
## exercises the behavior it names)
| System | Relevant lesson | Grade |
|---|---|---|
| `paperclipai/paperclip` (named competitor, confirmed real — Node.js server + React UI control plane for AI-agent orgs, same domain as ruClip: companies/org-charts/goals/issues/budgets/approvals) | Its own architecture puts org-chart cycle prevention behind the same class of graph-backed hierarchy check; no public evidence either way on its test rigor for that path, but the *shape* of the risk (a graph-cycle guard whose regression test doesn't independently confirm the guard fired) is generic to any agent-org control plane, not ruClip-specific | A (official repo, confirmed live 2026-03) |
| PIT / mutation testing (Java ecosystem, but the concept is language-agnostic) | "A survived mutant usually indicates weak assertions... mutation testing forces tests to assert behavior, not just call methods" — exactly this bug class: a test whose assertion is coherent with both the correct implementation and at least one broken mutant (here, `wouldCreateCycle` hard-coded to `false`) is, by definition, not verifying the behavior it's named for | A (vendor-neutral, widely documented methodology, corroborated across multiple 2025-2026 sources) |
| xUnit Test Patterns — "Assertion Roulette" / "Free Ride" test smells | Established literature on tests that pass regardless of the code under test being correct; the fix pattern (assert the *specific* mechanism, not just "an error of some kind happened") matches tonight's change exactly | A (established software-testing literature) |
| This repo's own 2026-09-05 and 2026-09-10 correctness nights (same file, same `wouldCreateCycle`/`graphNeighbors` call site, two independent real bugs already found there) | Third finding in a row anchored to this exact function pair — the call site is a demonstrated hotspot for "mock/test never checked against real behavior," now covering the mock's shape (09-05), the real backend's self-inclusion behavior (09-10), and the regression test's own blindness (tonight) | B (internal precedent, now three-for-three on one call site) |

## Hypothesis (frozen before implementation)
> Given the existing test `recordCausalEdge refuses a reports_to edge that
> would close a cycle`, whose mock registers no handler for
> `agentdb_causal-edge` and whose assertion checks only
> `instanceof AgentDbBridgeError`, when `wouldCreateCycle` is deliberately
> broken (forced to always return `false`), then the existing test should
> [it does NOT] fail — it passes regardless, because the unmocked
> `agentdb_causal-edge` call is caught by `invokeTool`'s generic catch-all
> and rethrown as the same `AgentDbBridgeError` class. The candidate (mock
> `agentdb_causal-edge` to succeed; assert the rejection message and the
> exact call sequence) should make the test fail under the same injected
> break, subject to: no change to `wouldCreateCycle`/`recordCausalEdge`
> production code, no regression in any other currently-passing test, and
> `harness:bench-verify`'s corpus hash unchanged.

## Evaluation Receipt
Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), Node v22.22.2, repo HEAD `6e73a8f`.

- **Baseline** (parent, test file unmodified): `npm test` → **327/327 pass**.
  Targeted experiment: `wouldCreateCycle` forced to `return false;`
  unconditionally (production code only, test file untouched), rebuilt, ran
  `node --test dist/src/control-plane/store/agentdb-adapter.test.js` directly
  → **13/13 pass**, including the target test — the false positive,
  reproduced. `wouldCreateCycle` then restored byte-identical to original
  (diffed to confirm).
- **Candidate** (test file fix only, production code untouched): full suite
  `npm test` → **327/327 pass** (same count — one existing test strengthened,
  no test added or removed). Targeted experiment repeated with the SAME
  injected break (`wouldCreateCycle` → `return false;`): candidate test file
  → **12/12 pass, 1/13 fail** — the target test now correctly fails
  (`AssertionError: Missing expected rejection`). `wouldCreateCycle` restored
  again; final `npm test` → 327/327 confirmed clean.
- `npm run harness:bench-verify` → `Suite repo-native@0.1.0: 6 tasks, hash OK
  (840fd8d2d698…)` — unchanged from every prior night, corpus untouched.
- Diff size: 1 file, +17/-2 (test-only).

## Independent critic (adversarial, fresh subagent, no access to this
## session's own reasoning or numbers — re-derived everything itself)
Read `bridge-client.ts`/`agentdb-adapter.ts` independently and confirmed the
`invokeTool` catch-all mechanism from scratch. Ran its OWN experiment: forced
`wouldCreateCycle` to `return false`, ran the **pre-diff** test file (via
`git show HEAD:...` for comparison) → **13 pass, 0 fail** (false positive
independently reproduced); ran the **candidate** test file under the same
injected break → **12 pass, 1 fail** (correctly caught). Ran the full suite
with only the legitimate candidate diff in place → **327 pass, 0 fail**.
Confirmed `git diff --stat` scope is exactly one file; `.harness/bench.json`
untouched. Raised one caveat, addressed here rather than hidden: an
`recordCausalEdge` implementation that *always* threw the cycle-rejection
message (never writing any edge) would still pass this one strengthened
test — but that degenerate case is independently caught by the sibling test
`persistOrgMember with a manager checks for cycles then writes reports_to`,
which asserts the edge **is** written when no cycle exists. Verdict:
**CLEAR**.

## Reward-Hack Check
No benchmark, gold answer, or `.harness/bench.json` touched (confirmed by
`git status`/`git diff --stat`: exactly one test file). No threshold moved,
no cache introduced, no export renamed or removed. The fix cannot be
satisfied by a degenerate no-op on its own (see critic caveat above), and
combined with existing sibling coverage there is no known implementation
that passes the full suite without genuine cycle detection. Both the
false-positive baseline and the corrected candidate were independently
re-derived by a critic with no visibility into this session's own claims.

## Security Review
Test-only change; touches no authorization, credential, network, or
filesystem surface. `wouldCreateCycle`/`recordCausalEdge` are unchanged.
Confirmed by grep that neither function nor this test file is referenced
from `authorization/`, `approval/`, or `governance/` in a way this diff
affects. No new dependency, no new mock/cache primitive beyond the existing
per-test `mockBridge` closure.

## Scan Findings — performance
Re-confirmed (still true on `main` @ `6e73a8f`, not a new finding — this is
the SCAN surface, reported not re-fixed): the three sequential
`for (const tier of ['working', 'episodic'])` tier-scan loops in
`agentdb-adapter.ts` (lines 738, 800, 1214 at tonight's HEAD — feeding
`listIssuesForGoal`/`listApprovalTransitionsForCompany`/
`listHeartbeatsForCompany`) are exactly the pattern 2026-09-08's dream-cycle
night (issue #18, PR #19) already found and fixed with `Promise.all`
fan-out — but that PR is still open/unmerged, so the sequential version is
still what ships on `main` seven nights later. Not re-implemented tonight
(duplicate work); flagged because a landing gap this old is itself a
finding (see Recommendation).

## Scan Findings — tests
`src/control-plane/store/agentdb-adapter.test.ts` carries its own
hand-rolled `mockBridge` (lines 39-92), duplicated from
`tests/support/mock-bridge.ts`, by the file's own header comment ("this file
predates that shared helper and keeps its own local copy"). Confirmed via
grep: exactly two independent `mockBridge` implementations plus one
differently-named variant (`mockBridgeWithMetadata` in
`tests/control-plane/bridge-client-handshake-and-oidc.test.ts`) exist in this
repo. Not a correctness bug — both copies currently implement the same
MCP-handshake-then-dispatch behavior — but it's the same root-cause shape as
tonight's finding and 09-05/09-10's: two independently-maintained pieces of
test infrastructure that could silently drift from each other (or from the
real bridge) with nothing to catch it. Flagged as a next step, not fixed
tonight (a merge of the two mock implementations is a larger, multi-test-file
change, not tonight's tiny/single-conceptual candidate per the ledger's
current learning signal).

## Learning signals applied
Ledger's last recorded row is 2026-09-06; GitHub shows five further nights
(2026-09-07 through 2026-09-11 — architecture #16/#17, performance #18/#19,
developer-experience #20/#21, correctness #22/#23, security #24/#25) that
ran and were partially backfilled into the ledger by the 2026-09-10 session,
plus an apparent 3-night gap (2026-09-12 through 2026-09-14) with no
corresponding issues/PRs found — flagged for the routine owner, not
investigable further from inside this session. Across the last 7
ledger-eligible nights, **zero PRs carry GitHub's `merged: true` flag**
(two — #11, #13 — were closed with an equivalent commit landed on `main` by
direct push rather than the PR merge button; five — #9, #17, #19, #21, #23 —
remain open and unmerged). Learning signal "zero of the last 14 merged →
bias to a tiny, one-parameter, easily-reviewable candidate" applied: tonight's
candidate is a single test file, +17/-2, one conceptual change, no production
code touched — deliberately smaller than most prior nights' candidates.

## Next steps
1. **Landing gap** (bigger than tonight's scope): five dream-cycle PRs
   (#9, #17, #19, #21, #23) are open and unreviewed as of tonight, one as old
   as 2026-09-02 (13 nights). The Dream Machine cannot self-merge by design,
   but the accumulating backlog means real, already-evaluated fixes
   (including 09-08's performance fix for the exact sequential-loop pattern
   re-confirmed in tonight's SCAN) are not reaching production. This is a
   human/process action item, not a candidate.
2. Merge the two independent `mockBridge` implementations (this repo's own
   copy in `src/control-plane/store/agentdb-adapter.test.ts` vs.
   `tests/support/mock-bridge.ts`) into one shared helper — a real
   fix, but multi-file and not tonight's tiny/single-conceptual candidate.
3. Apply the same "does this test's assertion actually distinguish a broken
   implementation from a correct one" check across the rest of
   `agentdb-adapter.test.ts`'s `assert.rejects(fn, AgentDbBridgeError)`-style
   assertions (a grep shows several more) — tonight only fixed the one this
   session's correctness deep-dive specifically targeted; a systematic sweep
   is a larger, separate night's worth of work.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
the line `## Witness` above — delete this section and everything after it,
then hash what remains.

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `c7a55e23a6e1fecca785de313695edff1276231159d93431b2ccda10b2d6e20d`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `67e2353d2fa8eba10ba1fac008c589a89ef78c15644b9a1ed57f5ca3a5e8db3c`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm this
   is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-09-15-correctness-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it matches the Witness stamp recorded above.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- . && npm ci && npm run build`,
   then edit `wouldCreateCycle` in `src/control-plane/store/agentdb-adapter.ts`
   to `return false;` unconditionally, rebuild, and run
   `node --test dist/src/control-plane/store/agentdb-adapter.test.js` with
   the ORIGINAL (pre-fix) test file — confirm the target test still passes
   (13/13).
5. `git checkout dream/2026-09-15-correctness -- src/control-plane/store/agentdb-adapter.test.ts`,
   repeat the same `wouldCreateCycle` → `return false;` injection, rebuild,
   run the tests again — confirm the target test now fails (12/13, one
   failure).
6. Restore `wouldCreateCycle` to its real body and run `npm test` — confirm
   327/327 pass.
