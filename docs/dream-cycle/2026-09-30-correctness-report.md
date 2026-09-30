# Correctness SOTA Report — 2026-09-30

## TL;DR
`ruvnet/ruClip`'s dashboard-facing `getBlockerIssueIds`
(`src/control-plane/store/agentdb-adapter.ts`) asks the `agentdb_graph-query`
MCP tool's k-hop mode to filter neighbors by `relation` (`'blocks'`). Verified
fresh tonight directly against this repo's own currently-installed
dependency: `node_modules/@claude-flow/cli/dist/src/mcp-tools/
agentdb-tools.js`'s k-hop handler parses `relation` (line ~1057) but never
passes it to `graphBackend.getNeighbors(nodeId, depth)` on the native
`graph-node` path (line ~1064; only the unused SQL CTE fallback applies it),
and that function (`ruvector/graph-backend.js`) forwards straight to
`db.kHopNeighbors(nodeId, hops)` — whose own type signature
(`@ruvector/graph-node/index.d.ts`) takes no relation parameter at all.
Confirmed live by calling the actual installed `@ruvector/graph-node` module
directly tonight (not inferred, not sourced from any unmerged branch — see
Evidence): a `parent_of` edge and an unrelated `blocks` edge into the same
node both come back from one k-hop call, and neighbors surface regardless of
direction too. Since `parent_of` and `blocks` are the only two relations
ever recorded between two issue nodes, an issue's own parent/children
(already known authoritatively from `Issue.parentId`, zero extra AgentDB
calls) can leak into its `blockerIssueIds` as false "blockers." Fixed by
excluding an issue's own parentId and children from `blockerIssueIds` in
`buildDashboardSnapshot`'s existing cross-company post-processing pass. Two
residual gaps are explicitly named and one is pinned with its own test
rather than left silent — see Evidence and Next steps.

A prior, independent finding against the same underlying dependency defect —
`docs/dream-cycle/2026-09-20-correctness-report.md` per its own PR, fixing
`childIssueIds` the same way via `parentId` — exists only on the still-open,
unmerged `dream/2026-09-20-correctness` branch (PR #37/issue #36) as of
tonight; it is **not** present in this checkout or in `main`'s git history.
Tonight's candidate is implemented independently against `main`, does not
depend on PR #37 landing, does not touch `childIssueIds`, and cites only
evidence re-verified first-hand tonight (see Evidence) rather than that
unmerged file — an adversarial critique run tonight caught an earlier draft
of this report/code citing that file as if it were committed, which it is
not; corrected before this candidate was finalized.

## What's new
- `src/control-plane/dashboard/build-snapshot.ts`: `buildDashboardSnapshot`'s
  existing cross-company post-processing pass (security review round 8) is
  extended to also build a `parentId -> children` map from every issue
  already collected for the company, and filters `blockerIssueIds` to
  exclude an issue's own parentId and children before display.
  `childIssueIds`'s own (separate, already-known, still-open) contamination
  is deliberately left untouched — out of scope for this call site.
- New test `tests/control-plane/dashboard-blocker-parent-contamination.test.ts`
  — reproduces the exact cross-relation leak with a mock that mimics the
  real backend's relation-blindness faithfully, asserts the fix holds for
  both directions (parent leaking into child's blockers, child leaking into
  parent's blockers).
- New test `tests/control-plane/dashboard-blocker-same-node-both-relations-gap.test.ts`
  — pins a known, undodged residual gap (see Evidence #4 and Next steps) as
  tracked, tested evidence rather than leaving it silent, following this
  repo's existing `*-gap(s).test.ts` convention.
- ~65 lines changed in 1 production file, 2 new test files (~230 lines,
  mostly test fixtures/mocks). One conceptual change (stop trusting a graph
  traversal that cannot honor the relation it was asked for, when an
  authoritative alternative exists for the specific parent/child case).

## Five candidates considered (correctness surface)
| # | Candidate | Fit | Novelty | Testability | Measurability | Prod value | Reviewability |
|---|---|---|---|---|---|---|---|
| 1 | **[selected]** `blockerIssueIds` can include an issue's own parent/child because the real k-hop backend ignores `relation`; exclude them using the authoritative `parentId` field | 5 | 4 | 5 | 5 | 3 | 5 |
| 2 | Full fix for `blockerIssueIds` via a dedicated `blockerIds`-style field maintained alongside every `addBlocksEdge` write (mirrors what `parentId` already gives `childIssueIds`) | 5 | 3 | 4 | 4 | 2 | 2 |
| 3 | `addBlocksEdge` never rejects a self-referential edge (`issueId` blocking itself) — `blocks` is excluded from `CYCLE_CHECKED_RELATIONS` on purpose ("blocking isn't a tree relation"), but self-reference isn't a cycle question | 3 | 3 | 4 | 3 | 1 | 4 |
| 4 | Re-audit `checkAuthorizationGuard`'s self-approval check and `recomputeInteractionSignals`'s transition pairing for a bypass/mis-pairing bug | 3 | 1 | 4 | 4 | 3 | 3 |
| 5 | Investigate the 17+ open, unmerged `dream/*` PRs / frozen ledger as tonight's correctness finding | 2 | 1 | 2 | 2 | 4 | 2 |

Candidate 2 is the real, complete fix but requires a schema change
(`blockerIds` field on `Issue`, threaded through every `addBlocksEdge` call
site and issue-load path) — larger than tonight's <300-line,
one-conceptual-change budget, and `addBlocksEdge` currently has zero
production callers (grep-confirmed) so there is no live urgency forcing it
tonight; named as next step 1. Candidate 3 is real but low production value
today for the same zero-callers reason, and conflates "self-reference" with
"cycle prevention scope," a design question better raised as its own
discussion than silently patched; named as next step 2. Candidate 4 was
investigated by reading the code in full (both paths already went through
several documented hardening rounds this repo's history records); no new
defect found — declined to avoid manufacturing a finding. Candidate 5 is a
real, already-known, already-flagged (issue #34/PR #35, and re-flagged by
#36) process/governance issue, not a code-correctness defect fitting
tonight's DEEP=correctness surface — re-flagged again in Next steps rather
than claimed as tonight's own finding. Candidate 1 selected: only one with a
live, independently-reproducible defect, fully testable within budget.

## Hypothesis (frozen before implementation)
> Given an issue with a `parent_of` edge to/from one neighbor and a separate
> `blocks` edge to a different neighbor, when `buildDashboardSnapshot`
> computes `blockerIssueIds` via the real, currently-installed
> `agentdb_graph-query` k-hop backend, then `blockerIssueIds` will
> incorrectly include the `parent_of`-related neighbor (parent or child),
> because that backend's k-hop traversal ignores the `relation` filter
> entirely and is direction-blind. Excluding an issue's own parentId and
> parentId-derived children from `blockerIssueIds` should eliminate that
> specific contamination with zero new AgentDB calls, verified by: (1) a
> fixture reproducing the exact scenario against a mock that faithfully
> mimics the real backend's relation-blindness, (2) the real dependency's
> behavior captured directly from its own installed source and confirmed
> live by calling it, (3) the full existing regression suite staying green,
> (4) an independent adversarial critic finding no reward-hacking, no
> weakened test, and no unaddressed false-negative.

## Evaluation receipt
- Baseline (`main` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`, new test
  added, production code unmodified): `npm run build` clean;
  `node --test dist/tests/control-plane/dashboard-blocker-parent-contamination.test.js`
  → **0/1 pass, 1 fail** — `issue-child's own parent must not appear in its
  blockerIssueIds` fails exactly as predicted (`['issue-parent',
  'issue-real-blocker']` vs expected `['issue-real-blocker']`).
- Candidate (working tree): `npm run build` clean; `npm test` (full suite,
  the real evaluator) → **329/329 pass** (327 baseline + 2 new, 0
  regressions); `npm run harness:bench-verify` →
  `Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)` (unchanged).
- Real, live dependency verification (first-hand, tonight): a standalone
  script requiring `@ruvector/graph-node` directly (run from inside this
  repo so `node_modules` resolves) created
  `entity:issue:issue-parent -[parent_of]-> entity:issue:issue-child` and
  `entity:issue:issue-real-blocker -[blocks]-> entity:issue:issue-child` as
  real native edges and called `kHopNeighbors('entity:issue:issue-child',
  1)` — returned `['entity:issue:issue-real-blocker',
  'entity:issue:issue-parent', 'entity:issue:issue-child']` (also
  incidentally reconfirming the already-known self-echo — see next steps —
  and direction-blindness: `kHopNeighbors('entity:issue:issue-parent', 1)`
  returned `issue-child` even though `issue-parent` has only an OUTGOING
  edge to it, no incoming edge from it).
- Diff size: ~65 lines in 1 production file, 2 new test files.

## Darwin
Not applicable — deterministic bugfix with no tunable parameter space.

## Evidence classification
- OBSERVATION: `node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js`
  line ~1057 parses `relation` into a local variable; line ~1064's native
  `graph-node` k-hop path calls `graphBackend.getNeighbors(nodeId, depth)`
  without ever passing it — read directly tonight, not assumed.
- OBSERVATION: `node_modules/@claude-flow/cli/dist/src/ruvector/graph-backend.js`'s
  `getNeighbors(nodeId, hops)` forwards to `db.kHopNeighbors(nodeId, hops)`;
  `node_modules/@ruvector/graph-node/index.d.ts`'s `kHopNeighbors` signature
  takes no relation/label parameter.
- MEASUREMENT: standalone script against the real installed native module
  (see Evaluation receipt) — first-hand tonight, confirms relation-blindness
  and direction-blindness together on a fixture matching the new test.
- MEASUREMENT: baseline 0/1 (new test) with production code unfixed;
  candidate 329/329 (full suite); `harness:bench-verify` hash unchanged.
- INFERENCE: `parent_of` and `blocks` are the only two relations ever
  recorded between two issue-prefixed nodes — confirmed by reading every
  `recordCausalEdge` call site in `agentdb-adapter.ts` and `CausalRelation`'s
  full enum in `schema/enums.ts` (the other five relations all target a
  goal/org-member node, filtered out elsewhere by the existing
  `entity:issue:` prefix check).
- INFERENCE: `addBlocksEdge` has zero production call sites in this repo
  (grep across `src/` — only `tests/control-plane/agentdb-adapter.test.ts`
  calls it), so the false-negative gap named below cannot manifest in any
  currently-deployed path.
- DECISION: fix `blockerIssueIds`'s provable parent/child contamination only
  (an authoritative `parentId`-derived exclusion set exists); do not attempt
  the full `blockerIds`-field fix (candidate 2) or touch `childIssueIds`
  (separate call site, separate unmerged PR #37) — named as next steps, not
  silently left unfixed.
- REJECTION (of an earlier draft, tonight): the first drafted version of
  this fix's code comments and new test cited
  `docs/dream-cycle/2026-09-20-correctness-report.md` as committed,
  confirmed evidence. An independent adversarial critic subagent found that
  file does not exist anywhere in this checkout or `main`'s git history —
  it exists only on the unmerged `dream/2026-09-20-correctness` branch
  (PR #37) — a real process defect in an evidence-gated pipeline: citing an
  unmerged branch's claims as if committed. Corrected before finalizing: all
  comments/tests now cite only file paths/line numbers in the
  currently-installed dependency, independently re-verified live (see
  Evaluation receipt) rather than any unmerged branch's report.
- REJECTION (design, tonight): considered leaving the false-negative gap
  (real blocker == issue's own parent/child) undocumented since it's
  unreachable today. Rejected by the same critic pass as an accepted
  shortcut for an evidence-gated process — fixed by adding an explicit code
  comment and a dedicated, honestly-asserting gap test
  (`dashboard-blocker-same-node-both-relations-gap.test.ts`) instead.

## Reward-hack check
Independent critic (fresh subagent, two rounds): round 1 found the
fabricated-citation and undocumented-false-negative issues above (both
genuine, both fixed — see Evidence); round 2, after the fixes, independently
re-verified every cited `node_modules` line number itself, ran the full
build/test/bench-verify suite itself, confirmed no existing test was
weakened, no gold data or threshold touched, and the new gap test asserts
real (not vacuous) behavior — **verdict: ACCEPT**. `.harness/bench.json`
untouched; hash unchanged.

## Security review
No new capability, credential, dependency, host, or authority surface —
this is a read-path data-integrity fix for the read-only dashboard snapshot.
Not reachable from any authorization/approval-gate decision:
`blockerIssueIds` is a display-only field, never consulted by
`checkApprovalStateGuard`, `checkAuthorizationGuard`, or any
claims/authorization code path (grep-confirmed, neither field name appears
outside `agentdb-adapter.ts` and `dashboard/`). Residual risk, precisely
named rather than left implicit: (1) an issue this one itself blocks can
still surface as a false "blocker" (direction-blindness, undistinguished by
this fix); (2) a genuine blocker that also happens to be the issue's own
parent/child is currently masked (see the dedicated gap test) — both
display-only, not an authorization bypass, and (2) is not reachable in any
currently-deployed path since `addBlocksEdge` has no production caller yet.

## Scan findings

**performance**: No new AgentDB calls added — the parentId/children map
reuses data `buildDashboardSnapshot` already collects for the existing
`childIssueIds`/cross-company filtering pass. Not separately benchmarked as
its own finding; it rides along with tonight's correctness fix at zero
marginal cost.

**tests**: Two new test files added (a fix-verification test and a
known-gap test). No existing test was weakened, retargeted, or had an
assertion relaxed — verified independently by the critic. This differs from
the 2026-09-20 night, where fixing `childIssueIds` incidentally made a
different existing test's assertion vacuous; tonight's fix touches only
`blockerIssueIds`, and no existing test asserts on that field in a way this
change affects (checked: `dashboard-cross-company-gap.test.ts`'s
`blockerIssueIds` assertion covers the foreign-company-id case, unrelated to
and unaffected by the parent/child exclusion added here).

## Competitors
| System | Relevant lesson | Grade |
|---|---|---|
| `paperclipai/paperclip` (named competitor) | Single-repo control plane with no third-party MCP graph-bridge indirection for its dependency graph — this class of "client asks for X, server silently drops X" bug doesn't arise the same way | B |
| Consumer-driven contract testing (e.g. Pact) | The standard, vendor-neutral answer to exactly this failure mode — a hand-rolled mock that agrees with a hand-rolled client while both silently disagree with the real provider's actual behavior; this repo's own mock-bridge tests were written before anyone checked the real bridge's behavior, the root cause of three separate correctness nights now | A |
| Evidence-gated CI provenance tooling (e.g. SLSA-style build provenance / in-toto attestations) | The general practice this routine's own "REJECTION (of an earlier draft)" episode tonight instantiates by hand: don't trust a claim's *conclusion* without a chain back to something independently checkable — an unmerged branch's own report is not that chain | A |
| This repo's own prior self-corrections (2026-09-05 PR #13, 2026-09-10 PR #23, 2026-09-20 PR #37) | Fourth independent real finding against the same `agentdb_graph-query` k-hop call this month — reinforces next step 3 (a standing integration test against the real installed module) | B (internal precedent) |

## Gist
**LOCAL** — no gist-creation tool available in this session's MCP toolset
(the GitHub MCP server exposes issue/PR/branch/file tools but no gist
primitive; same situation as the 2026-09-20 night). Full report committed
at `docs/dream-cycle/2026-09-30-correctness-report.md` (this file).

## Next steps
1. A complete fix for `blockerIssueIds` needs a dedicated `blockerIds`-style
   field on `Issue`, maintained alongside every `addBlocksEdge` write (the
   same class of fix `parentId` already gives `childIssueIds` in the
   still-unmerged PR #37) — a schema change, out of tonight's
   single-conceptual-change scope. Candidate 2 above.
2. `addBlocksEdge`'s missing self-reference guard (candidate 3 above) is a
   real, low-urgency finding (zero production callers today) worth its own
   frozen hypothesis once `addBlocksEdge` gets a real caller.
3. Fourth independent finding this month against the exact same
   `agentdb_graph-query` k-hop call (2026-09-05 field-shape fix, merged into
   main directly; 2026-09-10 self-echo fix, PR #23, open; 2026-09-20
   `childIssueIds` relation-blindness fix, PR #37, open; tonight's
   `blockerIssueIds` relation-blindness fix) — still worth a standing
   integration test against the real installed `@ruvector/graph-node`/
   `@claude-flow/cli` modules directly (not just hand-written mocks), so the
   next drift surfaces before a dream-cycle night has to rediscover it by
   hand.
4. Separately, unrelated to tonight's candidate but re-confirmed tonight:
   this repository has 18 open, unmerged `dream/*` and dream-cycle PRs as of
   tonight (#9, #17, #19, #21, #23, #25, #27, #29, #31, #33, #35, #37, #39,
   #41, #43, #45, #47, plus tonight's own), several already carrying a clean
   ACCEPT verdict — spanning 2026-09-02 through 2026-09-29. This has already
   been flagged twice (issue #34/PR #35 on 2026-09-19, re-flagged by issue
   #36 on 2026-09-20) and is re-flagged again here for human attention; it
   is a recurring, worsening pattern (0 of the last 18+ dream-cycle PRs
   merged), not a one-off — tonight's own candidate was deliberately kept
   as small and single-conceptual-change as possible in response to this
   same signal (learning signal: 0-of-last-14-merged bias applied).
5. Tonight's own process finding (a drafted citation to an unmerged branch's
   uncommitted file, caught by an independent critic before this report was
   finalized) suggests dream-cycle nights should not treat another night's
   *docs/dream-cycle/\*-report.md* file as citable evidence unless it is
   actually present in the checkout being worked from (i.e. on `main`, not
   merely claimed by an open PR) — worth stating explicitly in
   `docs/dream-cycle/PROMPT.md` for future nights.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
the line `## Witness` above — i.e. delete this section and everything after
it, then hash what remains.

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `41fe1dd13124a1972cfbfeacf6e62e0c4da88d12b9db4a42699d48e0747a2bfb`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `4380b493f763dc71a365588b174377b6047f7e6370e7b75b1562e0bdd9ca9f36`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm this
   is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-09-30-correctness-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it matches the Witness stamp recorded here/in the ledger/issue/PR.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src tests && npm ci && npm run build && npm test` —
   confirm 327/327 pass (the unmodified parent).
5. `git checkout dream/2026-09-30-correctness -- . && npm ci && npm run build && npm test` —
   confirm 329/329 pass, and
   `git diff 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src/control-plane/dashboard/build-snapshot.ts`
   shows exactly the parentId/children-derived `blockerIssueIds` exclusion
   described above.
6. Independently confirm the real dependency's relation-blindness: from
   inside this repo, run
   `node -e "const {GraphDatabase}=require('@ruvector/graph-node'); (async()=>{const db=new GraphDatabase({distanceMetric:'Cosine',dimensions:8});const e=new Float32Array(8).fill(0.1);await db.createNode({id:'entity:issue:issue-parent',embedding:e,labels:[],properties:{}});await db.createNode({id:'entity:issue:issue-child',embedding:e,labels:[],properties:{}});await db.createNode({id:'entity:issue:issue-real-blocker',embedding:e,labels:[],properties:{}});await db.createEdge({from:'entity:issue:issue-parent',to:'entity:issue:issue-child',description:'parent_of',embedding:e,confidence:1});await db.createEdge({from:'entity:issue:issue-real-blocker',to:'entity:issue:issue-child',description:'blocks',embedding:e,confidence:1});console.log(await db.kHopNeighbors('entity:issue:issue-child',1));})()"`
   — confirm the output includes both `entity:issue:issue-parent` and
   `entity:issue:issue-real-blocker` despite them being connected via
   different, unrelated edge labels.
