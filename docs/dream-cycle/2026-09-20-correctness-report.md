# Correctness SOTA Report — 2026-09-20

## TL;DR
`ruvnet/ruClip`'s dashboard-facing `getChildIssueIds`/`getBlockerIssueIds`
(`src/control-plane/store/agentdb-adapter.ts`) both ask the
`agentdb_graph-query` MCP tool's k-hop mode to filter neighbors by
`relation` (`'parent_of'` / `'blocks'`). The real, currently-installed,
load-bearing backend for that tool's k-hop mode
(`@ruvector/graph-node@2.1.0`, reached via `@claude-flow/cli`'s
`agentdb-tools.js` dispatch) tries its native path FIRST and, on that path,
**silently ignores `relation` entirely** — `getNeighbors(nodeId, depth)` ->
`db.kHopNeighbors(nodeId, depth)`, a binding that takes no relation
parameter at all (only the SQL CTE fallback, used solely when the native
backend is unavailable, actually filters by relation). Confirmed live
against the real installed module, not inferred from docs: a `parent_of`
edge and an unrelated `blocks` edge from the same node both come back from
one k-hop query regardless of which relation was requested. Net effect:
`getChildIssueIds`/`getBlockerIssueIds` can return each other's neighbors —
a `blocks`-only-related issue can appear in a `childIssueIds` list on the
company dashboard. Fixed by deriving `childIssueIds` from each `Issue`'s own
authoritative `parentId` field (already loaded in memory, zero new AgentDB
calls) instead of trusting the graph for it. `blockerIssueIds` has no
equivalent ground-truth field and is left exposed — a named next step, not
silently declared fixed.

## What's new
- `src/control-plane/dashboard/build-snapshot.ts`: `buildIssueSnapshot` no
  longer calls `getChildIssueIds` (also removes one wasted, still-buggy
  `agentdb_graph-query` round trip per issue). `buildDashboardSnapshot`'s
  existing cross-company post-processing pass (security review round 8) is
  extended to also compute `childIssueIds` from a `parentId -> children`
  map built from every issue already collected for the company.
- New test: `tests/control-plane/dashboard-child-relation-contamination.test.ts`
  — reproduces the exact cross-relation leak with a mock that mimics the
  real backend's relation-blindness faithfully (one adjacency list per node,
  returned identically regardless of the `relation` argument), asserts the
  fix holds.
- `tests/control-plane/dashboard-cross-company-gap.test.ts` updated: its
  `childIssueIds` cross-company assertion was made vacuous by tonight's fix
  (childIssueIds no longer consults the graph at all, so it can no longer
  leak a foreign company's id) — independent critic caught this. Retargeted
  at `blockerIssueIds`, the field still genuinely exposed to that same
  cross-company gap. No assertion was weakened; the scenario the test
  proves was moved to the one field it still actually applies to.
- ~75 lines changed across 2 production/test files, 1 new test file. One
  conceptual change (stop trusting a graph traversal that cannot honor the
  relation it was asked for, when an authoritative alternative exists).

## Five candidates considered (correctness surface)
| # | Candidate | Fit | Novelty | Testability | Measurability | Prod value | Reviewability |
|---|---|---|---|---|---|---|---|
| 1 | **[selected]** k-hop `relation` filter is a no-op on the native graph-node backend; `childIssueIds`/`blockerIssueIds` can cross-contaminate | 5 | 5 | 5 | 5 | 4 | 5 |
| 2 | Re-audit `isNewWarningStreak`'s rolling-window edge-triggering (`governance/propose-budget-mutation.ts`) for a re-trigger bug at window eviction boundaries | 4 | 2 | 4 | 4 | 3 | 4 |
| 3 | Re-audit `checkAuthorizationGuard`'s self-approval check for a bypass | 4 | 1 | 4 | 4 | 4 | 4 |
| 4 | Audit `recomputeInteractionSignals`'s prior-transition pairing for a mis-pairing bug across a submit/reject/revise/submit cycle | 4 | 3 | 4 | 4 | 3 | 3 |
| 5 | Flag `listApprovalTransitionsForCompany`/`listDueHeartbeats`'s non-exhaustive `topK` scan as a correctness risk at scale | 3 | 1 | 2 | 2 | 2 | 3 |

Candidates 2-4 were each investigated by reading the real code paths in
full; no defect was found in any of them (2 and 3 in particular have already
been through several documented security-hardening rounds this repo's own
history records). Candidate 5 is a pre-existing, already-documented,
accepted trade-off (not new). Candidate 1 was the only one with a live,
independently-reproducible defect — selected without needing to override a
higher score.

## Hypothesis (frozen before implementation)
> Given a company issue with both a `parent_of` edge to one neighbor and a
> `blocks` edge to a different neighbor, when `buildDashboardSnapshot`
> computes `childIssueIds` via the real, currently-installed
> `agentdb_graph-query` k-hop backend (native `@ruvector/graph-node@2.1.0`,
> confirmed load-bearing), then `childIssueIds` will incorrectly include the
> `blocks`-only neighbor, because that backend's k-hop traversal ignores the
> `relation` filter entirely. Deriving `childIssueIds` instead from each
> Issue's own `parentId` field should eliminate the contamination with zero
> new AgentDB calls, verified by: (1) a fixture reproducing the exact
> scenario against a mock that faithfully mimics the real backend's
> relation-blindness, (2) the real dependency's behavior captured directly
> from source and an ad hoc script against the actual installed native
> module, (3) the full existing regression suite staying green.

## Evaluation receipt
- Baseline (`main` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`, new test
  added, production code untouched): `npm run build` clean;
  `node --test dist/tests/control-plane/dashboard-child-relation-contamination.test.js`
  → **0/1 pass, 1 fail** — `issue-blocked must not leak into childIssueIds`
  fails exactly as predicted (`['issue-child', 'issue-blocked']` vs expected
  `['issue-child']`).
- Candidate (working tree): `npm run build` clean; `npm test` (full suite,
  the real evaluator) → **328/328 pass** (327 baseline + 1 new, 0
  regressions); `npm run harness:bench-verify` →
  `Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)` (unchanged).
- Real, live dependency verification (not inferred): a standalone script
  requiring `@ruvector/graph-node` directly (run from inside this repo so
  `node_modules` resolves) created `issue:A -[parent_of]-> issue:B` and
  `issue:A -[blocks]-> issue:C` as real native edges and called
  `kHopNeighbors('issue:A', 1)` — returned `['org-member:W', 'issue:A',
  'issue:B', 'issue:C', 'issue:D']` (also incidentally re-confirming the
  already-known self-echo and revealing the traversal is direction-blind
  too — `issue:D -[parent_of]-> issue:A` surfaced as a neighbor of `A`, and
  `kHopNeighbors('issue:B', 1)` returned `A` even though `B` has only an
  INCOMING edge from `A`). Independently reproduced by a fresh critic
  subagent from scratch, byte-for-byte consistent conclusion.
- Diff size: ~75 lines across 3 files (2 modified, 1 new).

## Darwin
Not applicable — deterministic bugfix with no tunable parameter space (a
graph-derived vs. field-derived computation is a binary choice, not a
continuum to search over).

## Evidence classification
- OBSERVATION: `node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js`
  lines ~1058-1096, `agentdbGraphQuery.handler`'s k-hop branch — the native
  path calls `graphBackend.getNeighbors(nodeId, depth)`, never passing the
  parsed `relation` variable; only the SQL CTE fallback
  (`buildKHopCTE(nodeId, depth, relation, ...)`) uses it.
- OBSERVATION: `node_modules/@ruvector/graph-node/index.d.ts` —
  `kHopNeighbors(startNode: string, k: number): Promise<Array<string>>`, no
  relation/label parameter in the native binding's own signature.
- MEASUREMENT: standalone script against the real installed native module
  (see Evaluation receipt) — empirically confirms relation-blindness AND
  direction-blindness; independently re-run by a fresh critic subagent with
  matching results.
- MEASUREMENT: baseline 0/1 (new test) with production code unfixed;
  candidate 328/328 (full suite); `harness:bench-verify` hash unchanged.
- INFERENCE: the only two production call sites of the affected
  `graphNeighbors` helper are `getChildIssueIds`/`getBlockerIssueIds`
  (confirmed by grep across `src/`), and their only caller is
  `dashboard/build-snapshot.ts` — so the fix's blast radius is fully
  characterized, not assumed.
- DECISION: fix `childIssueIds` only (an authoritative `parentId` field
  exists to replace the graph read entirely); leave `blockerIssueIds`
  exposed (no authoritative non-graph field exists for `blocks`) rather than
  attempt a partial/heuristic mitigation that isn't provably correct —
  recorded as next step 1, not silently left unfixed.
- REJECTION: none tonight — the first and only hypothesis frozen was the one
  shipped.

## Security review
No new capability, credential, dependency, host, or authority surface — this
is a read-path data-integrity fix for the read-only dashboard snapshot
(`build-snapshot.ts`'s own header: "no new AgentDB calls of its own"; this
fix reduces the call count further). Not reachable from any
authorization/approval-gate decision — `childIssueIds`/`blockerIssueIds` are
display-only fields, never consulted by `checkApprovalStateGuard`,
`checkAuthorizationGuard`, or any claims/authorization code path (confirmed
by grep: neither field name appears outside `agentdb-adapter.ts` and
`dashboard/`). Residual risk, precisely named rather than left implicit:
`getBlockerIssueIds` remains exposed to the identical underlying defect —
a `blocks`-unrelated issue (e.g. one connected only via `parent_of` or
`assigned_to`, wait: `assigned_to`/`belongs_to` targets are org-members/goals
and already filtered out by the existing `entity:issue:` prefix check, so in
practice only a `parent_of`-connected issue could leak into
`blockerIssueIds`) can still appear as a false "blocker" on the dashboard.
Display-only, not an authorization bypass, but a genuine data-integrity gap
that a human reviewer could reasonably prioritize next.

## Next steps
1. `getBlockerIssueIds` has no authoritative non-graph field to fall back on
   (unlike `parentId` for children) — closing this fully needs either (a) a
   new `blockerIds`-style field maintained alongside `addBlocksEdge` writes
   (a schema change, out of tonight's <300-line, one-conceptual-change
   scope), or (b) an upstream fix/PR against `@claude-flow/cli`'s
   `agentdb-tools.js` to actually pass `relation` into
   `graphBackend.getNeighbors`, which this session has no authority to
   merge into a third-party dependency.
2. The direction-blindness observed tonight (an issue's own PARENT can
   surface as its own "neighbor" via an INCOMING edge) is a second,
   independent defect in the same native backend, not exercised by
   tonight's fix beyond incidentally not mattering for `childIssueIds`
   anymore (parentId-derived, not graph-derived). Worth its own frozen
   hypothesis if `blockerIssueIds` or any future graph consumer needs
   direction-correct results.
3. This repo now has three independent, real findings against the exact
   same `agentdb_graph-query` k-hop call
   (2026-09-05: wrong field names, merged #13; 2026-09-10: self-echo,
   open #23; tonight: relation-blindness) — worth a standing ADR or a
   dedicated integration-style test harness that runs against the real
   installed `@ruvector/graph-node`/`@claude-flow/cli` modules directly
   (not just hand-written mocks), so the NEXT drift in this one dependency
   surfaces before a dream-cycle night has to rediscover it by hand.
4. Separately, unrelated to tonight's candidate: this repository currently
   has 11 open, unmerged `dream/*` PRs (2026-09-02 through 2026-09-19,
   ~2 weeks of accumulated nightly output), several already carrying an
   ACCEPT verdict with clean receipts (including PR #23, which fixes the
   self-echo defect referenced above). Recommended for human attention
   independent of tonight's own PR.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
the line `## Witness` above — i.e. delete this section and everything after
it, then hash what remains.

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `707ba88896dbcbb33c81481799ae08474d96be53c78752e24e7a1ec20115fc6c`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `5d11af3f07b8ebc3c75b9dd80e4b77ca5a142c84f96ec112da7ea9693538e3cd`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm this
   is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-09-20-correctness-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it matches the Witness stamp recorded in the ledger/issue/PR.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src tests && npm ci && npm run build && npm test` —
   confirm 327/327 pass (the unmodified parent).
5. `git checkout dream/2026-09-20-correctness -- . && npm ci && npm run build && npm test` —
   confirm 328/328 pass, and
   `git diff 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src/control-plane/dashboard/build-snapshot.ts`
   shows exactly the `parentId`-derived `childIssueIds` computation described
   above.
6. Independently confirm the real dependency's relation-blindness: from
   inside this repo, `node -e "const {GraphDatabase}=require('@ruvector/graph-node'); (async()=>{const db=new GraphDatabase({distanceMetric:'Cosine',dimensions:8});const e=new Float32Array(8).fill(0.1);await db.createNode({id:'x',embedding:e,labels:[],properties:{}});await db.createNode({id:'y',embedding:e,labels:[],properties:{}});await db.createNode({id:'z',embedding:e,labels:[],properties:{}});await db.createEdge({from:'x',to:'y',description:'rel-a',embedding:e,confidence:1});await db.createEdge({from:'x',to:'z',description:'rel-b',embedding:e,confidence:1});console.log(await db.kHopNeighbors('x',1));})()"`
   — confirm the output includes both `y` and `z` despite them being
   connected via different, unrelated edge labels.
