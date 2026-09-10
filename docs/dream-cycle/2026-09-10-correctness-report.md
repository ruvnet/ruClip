# Correctness SOTA Report — 2026

## TL;DR
`ruvnet/ruClip`'s `graphNeighbors` (`src/control-plane/store/agentdb-adapter.ts`,
feeding `getChildIssueIds`/`getBlockerIssueIds`) never excludes the queried
node's own id from its own k-hop neighbor set. Reading the real, currently
pinned `@ruvector/graph-node@2.1.0` native graph backend's own
`.d.ts`/behavior (the live backend in this environment — confirmed installed
and loadable, not the SQL fallback) shows `kHopNeighbors(startNode, k)`
**includes the start node itself** in its result array, even at `k=1`. This
was verified **empirically against the real installed native binary**, not
just by reading source: a throwaway script creating two nodes and one edge
via the actual `@ruvector/graph-node` package shows `kHopNeighbors('P', 1)`
returning `['P', 'CH']` — the query node included alongside its real
neighbor. ruClip's own `graphNeighbors` passes that array straight through
(only filtering by id prefix, which the query node's own id also matches),
so **`getChildIssueIds(issueId)` and `getBlockerIssueIds(issueId)` report
every issue as its own child and its own blocker** — visible verbatim in
`buildDashboardSnapshot`'s per-issue `childIssueIds`/`blockerIssueIds`
fields. Every existing test for these two functions mocks
`agentdb_graph-query` with a response that never includes the query node's
own id, so this self-reference bug is invisible to the current suite
(same "mock never checked against the real tool's actual behavior" pattern
as the 2026-09-05 correctness finding) — except now the check was made by
actually running the real installed dependency, not by reading its source.

## What's new
- `graphNeighbors` (private helper, `store/agentdb-adapter.ts`) now drops
  the queried `nodeId` from its own returned neighbor list before mapping
  to raw ids — a one-line, single-conceptual, single-function fix with a
  header comment recording the empirical reproduction.
- Two existing tests (`getBlockerIssueIds strips...`,
  `getChildIssueIds strips...`) gain a self-referential entry in their
  mock's `results` array (matching the real backend's actual behavior) plus
  an assertion that it is excluded from the returned list.
- One new regression test added to prove the fix is not vacuous: given a
  mock that returns *only* the query node's own id (the real backend's
  actual reply for an issue with zero real neighbors, at depth 1, per the
  probe below), both functions must return `[]`, not `[issueId]`.
- Diff: 1 production file, 1 test file, ~20 lines total.

## Empirical reproduction (real installed dependency, not a mock)
`npm ls @ruvector/graph-node` confirms `@ruvector/graph-node@2.1.0` is
installed and load-bearing (`agentdb@3.0.0-alpha.20`'s own dependency, and
the same version `agentic-flow@3.0.0-alpha.2` deduplicates to). A throwaway
script (`require('@ruvector/graph-node').GraphDatabase`, run from the repo
root so Node resolves the real installed native binding, not a mock)
constructed two tiny graphs and called the *actual* native `kHopNeighbors`:

- Nodes `A`,`B`,`C`; edges `A -[blocks]-> B`, `B -[parent_of]-> C`.
  `kHopNeighbors('A', 2)` → `['C', 'B', 'A']` — **the start node `A` itself
  is in its own 2-hop result**, alongside a wholly separate finding (not
  fixed tonight, see Next steps): the traversal also ignores edge labels
  entirely (`C` is reachable only via an unrelated `blocks` edge, yet
  appears in a query that exists, in ruClip's usage, specifically to check
  `parent_of`-only reachability).
- Nodes `P`,`CH`; edge `P -[parent_of]-> CH`. `kHopNeighbors('P', 1)` →
  `['P', 'CH']` — **the start node is present even at depth 1**, which is
  exactly the depth `graphNeighbors` uses for `getChildIssueIds`/
  `getBlockerIssueIds`. `@ruvector/graph-node`'s own `index.d.ts` confirms
  the public signature is `kHopNeighbors(startNode: string, k: number):
  Promise<Array<string>>` — no relation/edge-type parameter and no
  documented "excludes self" contract either.

This is A-grade evidence (reproduced against the real, exact-pinned,
already-installed native binary this deployment actually loads — not a
vendor doc, not a guess, not source-reading alone).

## Competitors / prior art (a client trusting an SDK's k-hop contract
## without re-verifying it against the real binary)
| System | Relevant lesson | Grade |
|---|---|---|
| `paperclipai/paperclip` (named competitor) | Single-repo org-chart storage, no third-party native graph backend indirection — this class of "SDK includes the seed node in its own traversal" surprise doesn't arise the same way | B |
| Neo4j Cypher `MATCH (a)-[*1..k]-(b) WHERE a <> b` | The standard graph-DB idiom for k-hop neighbor queries explicitly excludes the seed node with a `WHERE` clause — self-inclusion in a "neighbors" result is treated as a known footgun the query language makes you opt out of by default, not the reverse | A (widely documented Cypher pattern) |
| NetworkX `single_source_shortest_path_length` | Its docs explicitly note the return dict includes the source node at distance 0 — callers are expected to `del`/filter it before treating the result as "neighbors"; the convention of the ecosystem is "self-inclusion is the SDK default, filtering is the caller's job" | A (official NetworkX documentation) |
| This repo's own 2026-09-05 correctness finding (same file, same `agentdb_graph-query` call, different field-shape bug) | Same root cause class recurring: a hand-written mock that satisfies the client's tests while never being checked against what the real, already-installed dependency actually returns | B (internal precedent, now twice for this one call site) |

The common thread is identical to 2026-09-05's: nothing exotic, a very
ordinary "does my mock match my real dependency's real behavior" gap — this
time caught by literally running the real dependency instead of only
reading its source, which is why it surfaces a second, independent defect
(self-inclusion) that source-reading alone had not yet found.

## Hypothesis (frozen before implementation)
> Given the real, currently-installed `@ruvector/graph-node@2.1.0` native
> graph backend (confirmed load-bearing in this deployment via
> `npm ls @ruvector/graph-node` and a live reproduction script), whose
> `kHopNeighbors(nodeId, k)` includes `nodeId` itself in its own result set
> at any `k >= 1`, when `graphNeighbors` (agentdb-adapter.ts) is changed to
> filter the queried `nodeId` out of the neighbor list it returns, then
> `getChildIssueIds(issueId)` and `getBlockerIssueIds(issueId)` should never
> again include `issueId` itself in their output, subject to: every other
> currently-passing test for these two functions and their callers
> (`buildIssueSnapshot`/`buildDashboardSnapshot`) continues to pass
> unmodified in behavior (only their mocks gain the previously-missing
> self-referential entry to match real behavior), and no other caller of
> `graphNeighbors` (`wouldCreateCycle` does not call it — it inlines its own
> k-hop call directly) is affected.

## Evaluation Receipt
Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), Node v22.22.2.

- **Baseline** (parent `6e73a8f`, tests updated to the real mock shape,
  production code NOT yet fixed): `npm test` → **325/329 pass, 4 fail** —
  all 4 failures are the new/updated assertions exercising the
  self-inclusion behavior directly (`getBlockerIssueIds strips...`,
  `getChildIssueIds strips...`, `getChildIssueIds returns [] ... childless`,
  `getBlockerIssueIds returns [] ... unblocked`), i.e. genuine behavioral
  divergences, not incidental breakage.
- **Candidate** (`graphNeighbors` filters `id !== nodeId`): `npm test` →
  **329/329 pass**, `npm run build` clean, `npm run harness:bench-verify`
  → `Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)` (unchanged
  from every prior night's hash — corpus untouched).
- Diff size: 2 files, +52/-4 (production: 1 function, +1 filter clause and
  header comment; tests: 2 existing tests gain a self-referential mock
  entry + assertion, 2 new tests added).
- **Empirical reproduction** (the finding's actual evidence — see TL;DR):
  a throwaway script run from the repo root against the real, installed
  `@ruvector/graph-node@2.1.0` native binding (not a mock) showed
  `kHopNeighbors` including the query node in its own result at both
  `k=1` and `k=2`.

## Independent critic (adversarial, fresh subagent, no access to this
## session's own reasoning)
Re-derived the empirical claim from scratch with its OWN throwaway script
against the real installed native binary (not trusting this report):
`kHopNeighbors('issue-1', 1)` on a graph with one real `parent_of` edge
returned `['issue-child', 'issue-1']` (self included); on a zero-neighbor
node returned `['lonely-issue']` alone — independently confirming both the
core defect and the exact "childless issue reports itself as its own
child" scenario the new regression tests assert against. Confirmed
`graphNeighbors`'s only callers are `getChildIssueIds`/`getBlockerIssueIds`,
whose only caller is `build-snapshot.ts`'s dashboard-snapshot assembly, and
that no test or caller anywhere depends on the old self-inclusive behavior.
Independently verified `wouldCreateCycle` (a separate function, not
touched by this diff) cannot be affected by the same defect: it checks
reachability of `candidateSourceId` from `candidateTargetId`, and
`recordCausalEdge` already rejects `sourceId === targetId` before
`wouldCreateCycle` ever runs, so the query node echoing itself back can
never spuriously equal a *different* id being searched for. Confirmed
`.harness/bench.json` untouched and no pre-existing assertion's semantics
were altered (only additions + mock fixtures corrected to match reality).
Ran `npm test` itself fresh: 329/329, 0 fail. **Verdict: CLEAR.**

## Reward-Hack Check
No gold answer, benchmark corpus, or threshold touched (`.harness/bench.json`
diff is empty). No existing test assertion was weakened — the two modified
tests only gained an additional mock entry (matching newly-discovered real
behavior) plus a strengthened assertion; the two new tests are net
additions. No new mock/cache introduced beyond the existing `mockBridge`
helper. No export dropped or renamed. The fix could not be satisfied by a
degenerate no-op: baseline (pre-fix) genuinely fails all 4 targeted
assertions; an independent critic re-derived the same failure from a fresh
reproduction rather than trusting this session's numbers.

## Security Review
No new capability, credential, authorization, or network/filesystem
surface. `graphNeighbors` is a private (non-exported) helper; its only two
callers (`getChildIssueIds`/`getBlockerIssueIds`) feed read-only dashboard
display data (`build-snapshot.ts`), not any authorization or approval-gate
decision — confirmed by grep, neither function is referenced anywhere in
`authorization/`, `approval/`, or `governance/`. No change to
`wouldCreateCycle`, `recordCausalEdge`, or any cycle-prevention/write-path
logic. Zero new dependencies; zero lines of vendor code modified (the fix
is entirely client-side, defensive filtering of a third-party dependency's
already-observed real behavior). Residual risk newly surfaced by this
finding (documented, not silently left implicit): the same real backend
also ignores the `relation` filter entirely (see Next steps #1) — a larger,
separate, not-yet-fixed correctness gap in the opposite direction (over-
inclusion across relation types) that this fix does not touch or mask.

## Next steps
1. **Not fixed tonight, larger scope**: the same probe shows
   `kHopNeighbors` ignores edge relation/label entirely — `agentdb_graph-query`
   is called with a `relation` filter (`'parent_of'`, `'blocks'`,
   `'reports_to'`) that the real native backend's public API has no
   parameter for at all (confirmed via `@ruvector/graph-node`'s own
   `index.d.ts`: `kHopNeighbors(startNode: string, k: number)`, no
   relation argument). This means `wouldCreateCycle`'s cycle-prevention
   check and `graphNeighbors`' own child/blocker lists can currently pick
   up nodes reachable only through an *unrelated* relation — a
   correctness gap in the opposite direction (false positives / false
   inclusions) from 2026-09-05's finding. Needs its own frozen hypothesis;
   a real fix likely requires either an upstream relation-aware traversal
   or a client-side per-edge verification pass (`agentdb_causal-edge`
   existence checks) that is not a tiny, single-conceptual change.
2. 2026-09-05's own next step 1 (the `depth: 5` false-negative — cycle
   detection is blind past 5 hops because `complexityBudget.maxDepth`
   is never sent) is still open. Deliberately **not** attempted tonight:
   widening depth on a backend now known (next step 1 above) to ignore
   relation filtering would widen the blast radius of that unresolved
   false-positive risk before it's understood — tightening scope, not
   expanding it, given tonight's independent finding.
3. `recordCausalEdge refuses a reports_to edge that would close a cycle`
   (flagged 2026-09-05, still unfixed) passes for the wrong reason — an
   unrelated missing mock handler throws the same error class as a real
   cycle rejection. Still worth tightening independently of tonight's fix.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
the line `## Witness` above — i.e. delete this section and everything after
it, then hash what remains. This avoids the self-referential-hash problem (a
hash cannot include itself).

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `76d94523d8b38931be3d7d96fec5b60a121a64f1165f7694c92f9e7e9174d831`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `e701f0245f003d32e12d8a44b431f645ee2414157e8a152bd5dad9acacc495a5`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm this
   is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-09-10-correctness-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it matches the Witness stamp recorded above.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- . && npm ci && npm run build`,
   then apply just the test-file hunk from
   `git diff 6e73a8f060bcbb69965a50ffe4627e33622d4094 dream/2026-09-10-correctness -- tests/control-plane/agentdb-adapter.test.ts`
   without the production fix — confirm 325/329 (4 genuine failures).
5. `git checkout dream/2026-09-10-correctness -- . && npm ci && npm test` —
   confirm 329/329 pass, and
   `git diff 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src/control-plane/store/agentdb-adapter.ts`
   shows exactly the `.filter((id) => id !== nodeId)` addition in
   `graphNeighbors`.
6. Independently reproduce the root cause: from the repo root, run a
   script that `require('@ruvector/graph-node')`'s `GraphDatabase`, adds a
   node + one outgoing edge, and calls `kHopNeighbors(<nodeId>, 1)` — the
   query node's own id appears in the returned array.
