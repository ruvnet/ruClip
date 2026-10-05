# Correctness SOTA Report — 2026-10-05

## TL;DR
`wouldCreateCycle` (`src/control-plane/store/agentdb-adapter.ts`), which gates
every `parent_of`/`reports_to` causal-edge write (DOMAIN-MODEL.md §1.2/§1.4 —
a real write-blocking data-integrity invariant, not a display-only field),
delegates cycle detection to the real, installed `agentdb_graph-query` k-hop
tool. That tool's graph-node-native backend (`@ruvector/graph-node`) is
**both relation-blind and direction-blind** — already confirmed live,
independently, by this same repo's own 2026-09-30 dream-cycle night
(unmerged PR #49) for a *display-only* dashboard field. Tonight extends that
same confirmed defect to its more severe consequence: `wouldCreateCycle`
**false-positives** on any two nodes already connected by *any* edge of
*any* relation within 5 hops — e.g. two sibling `Issue`s under the same
`Goal` (connected only via two unrelated `belongs_to` edges) cannot be made
parent/child of each other; `recordCausalEdge` refuses the edge with "would
close a cycle" even though no `parent_of`/`reports_to` cycle exists. No prior
dream-cycle night examined this consumer — #13, #27, #37, #49 all touched
the k-hop shape/display-field surface, never the cycle-*prevention*
write-gate itself.

## What's new
- Independently re-confirmed the relation-blindness root cause by reading
  `node_modules/@ruvector/graph-node/index.d.ts`'s real NAPI signature:
  `kHopNeighbors(startNode: string, k: number): Promise<Array<string>>` — no
  relation parameter exists on this API at all, confirming
  `node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js:1064`'s
  `graphBackend.getNeighbors(nodeId, depth)` call (which itself drops the
  `relation` the caller sent) has no way to recover it downstream.
- Traced where relation data actually lives: `graph-backend.js`'s
  `recordCausalEdge`/`addEdge` *do* store it, as the edge's `label` property
  (`node_modules/@claude-flow/cli/dist/src/ruvector/graph-backend.js:182-198`)
  — but `kHopNeighbors`'s return shape (`Array<string>` of node ids only)
  never surfaces it, so no caller, including this one, can filter by it
  post-hoc. This is why #49's own dashboard fix had to settle for a
  structural (parent/child exclusion) heuristic rather than a true
  relation-aware filter — the data is write-side-only, unreadable back out.
- This confirms the SAME root defect blocks **write-path correctness**
  (cycle prevention), not just read-path display, a materially more severe
  consequence than any prior night's framing of this bug.
- 1 doc comment + 1 new regression test, 2 files, +70 lines. No production
  *behavior* change — see "Why no fix tonight" below.

## Ledger check / learning signals applied
`docs/dream-cycle/LEDGER.md`'s last row (2026-10-03) recorded: **zero of the
last 19 dream-cycle PRs (#17–#53) are merged** — `main` has not merged a
dream-cycle PR since #15 (2026-09-07). Independently re-confirmed tonight via
`mcp__github__pull_request_read` across the full `dream/*` branch set
(`git ls-remote --heads origin` lists 23 `dream/*` branches total as of
tonight, #55/2026-10-03 included) — still 0 of the last ~20 merged, and the
exact same backlog has now been named explicitly in PR bodies 5 times (#34,
#36, #48, #50, #55) with no action. Learning signal applied: bias tonight's
candidate to the smallest, most easily reviewable shape possible. A full fix
for the finding above (an independent, relation-exact per-relation adjacency
index, since the real backend cannot be asked to filter by relation) is a
write-path behavioral change to a heavily-tested, production-critical hot
path — not tiny, not one-parameter. Tonight ships the test+doc-only
candidate instead and names the real fix as a next step, consistent with the
signal.

## Competitors / prior art
| System | Relevant lesson | Grade |
|---|---|---|
| `paperclipai/paperclip` (named competitor) | Single-repo control plane, no third-party native graph-backend indirection for its own org-chart storage — this exact failure mode (a traversal primitive that can't be asked to respect edge type) doesn't arise the same way in its architecture | B |
| Neo4j / Cypher, Amazon Neptune (industry graph-DB practice) | Both make relation-typed traversal (`-[:PARENT_OF*1..5]->`) a first-class query primitive precisely because an untyped k-hop BFS over a multi-relation graph is a well-known correctness trap for exactly this invariant (cycle/ancestor checks) — this repo's dependency chose a lower-level native binding (`@ruvector/graph-node`) that doesn't offer that primitive at all | A (widely documented graph-database design practice) |
| This repo's own prior self-corrections (file headers throughout `agentdb-adapter.ts`) | Strong, repeatedly-demonstrated practice of reading the actual installed tool source rather than trusting an assumed contract — tonight extends that same practice to a consumer (`wouldCreateCycle`) the 2026-09-30 night's otherwise-thorough investigation didn't reach | B (internal precedent) |

## Hypothesis (frozen before implementation)
> Given the real, installed `agentdb_graph-query` k-hop backend (confirmed
> relation-blind and direction-blind — PR #49, 2026-09-30, live repro; and
> independently re-confirmed here from `@ruvector/graph-node`'s own type
> declarations), when `wouldCreateCycle` is asked whether adding a
> `parent_of` edge between two `Issue`s connected only via an unrelated
> `belongs_to` path (e.g. two siblings under the same `Goal`) would close a
> cycle, then it incorrectly reports `true` (refuses the edge) even though no
> cycle exists in the `parent_of` relation's own edge set — a false positive,
> not a true safety rejection — and this is reproducible today,
> deterministically, against this repo's own existing mock-bridge
> conventions (which already, elsewhere in this same test file, model
> `agentdb_graph-query` as ignoring the `relation` it was asked to filter by).

## Why no production fix tonight (testability gate)
A real fix requires ruClip to stop delegating relation-exact cycle detection
to this tool — e.g. its own per-relation adjacency index via
`memory_store`/`memory_retrieve` (the same technique
`governance/propose-budget-mutation.ts`'s level-history window already
uses), maintained on every `parent_of`/`reports_to` write. That is a
behavior change to `persistIssue`/`persistOrgMember`'s hot write path, not a
tiny/one-parameter candidate — directly the shape of risk tonight's learning
signal says to avoid proposing into an already-19-PR-deep unreviewed queue.
Candidate shipped instead: a doc comment pinning the exact root cause (with
file/line citations into this repo's own `node_modules`) plus a regression
test that proves the false positive is real today and is not vacuous (see
Evaluation receipt). `EVALUATED=yes` (the claim itself is fully testable and
was tested) — this is a documentation+evidence night, not a behavior-change
night; see Verdict.

## Evaluation receipt
Evaluator: `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`).

| | Tests | Pass | Fail | tsc --strict | harness:bench-verify |
|---|---|---|---|---|---|
| Baseline (`main` @ `6e73a8f0`, unmodified) | 327 | 327 | 0 | clean | hash OK (`840fd8d2d698…`) |
| Candidate (this branch) | 328 | 328 | 0 | clean | hash OK (`840fd8d2d698…`, unchanged) |

The new test (`GAP (known, not fixed here...)`) passes against **unmodified**
production code — proving the false positive described above is real today,
not hypothetical.

**Discriminating-power check** (is the test actually testing the claim, or
would it pass regardless?): `wouldCreateCycle`'s real `.some(...)` check was
temporarily replaced with an unconditional `return false;` (simulating an
idealized relation-aware fix that correctly finds no `parent_of` path between
true siblings), rebuilt, and retested. Result: the new GAP test **correctly
fails** under that simulated fix (328 tests, 326 pass / 2 fail — the GAP test
and one genuine true-cycle test that the blunt `return false;` stub also
breaks, as expected, since it's not a real fix). Production code was then
restored byte-identical (`diff` confirmed) and the suite re-run clean
(328/328). This mirrors the exact lesson PR #27 (2026-09-15 dream-cycle)
already established in this file for the sibling true-cycle test — a mock
that doesn't register a handler for the downstream `agentdb_causal-edge`
write can make an assertion pass for the wrong reason; this candidate's test
explicitly mocks that call to succeed so the assertion is only true when a
cycle is genuinely (mis-)detected.

## Darwin
Not run — no tunable parameter space; this is a factual-claim-pinning test,
not a heuristic with variants to search.

## Evidence classification
- OBSERVATION: `@ruvector/graph-node/index.d.ts`'s `kHopNeighbors` signature
  has no relation parameter; `agentdb-tools.js`'s graph-node-native k-hop
  branch calls `getNeighbors(nodeId, depth)`, dropping `relation`;
  `graph-backend.js`'s `addEdge`/`recordCausalEdge` store relation only as
  `label`, never read back by `kHopNeighbors`.
- MEASUREMENT: baseline 327/327; candidate 328/328; discriminating-power
  experiment 326/328 (2 expected failures) under a simulated relation-aware
  stub, restored to 328/328 clean; `harness:bench-verify` hash unchanged
  throughout.
- INFERENCE: this same defect, already confirmed live by PR #49
  (2026-09-30) for `getChildIssueIds`/`getBlockerIssueIds`, necessarily also
  reaches `wouldCreateCycle` — both call the identical `graphNeighbors`-family
  k-hop primitive against the identical backend; not independently
  live-tested against a real running AgentDB bridge (none available in this
  sandbox, same limitation every prior dream-cycle night touching this file
  has recorded).
- DECISION: ship the test+doc-only candidate; defer the structural fix
  (next steps below) rather than attempt it as tonight's one-parameter-biased
  candidate.

## Reward-hack check
No existing test's assertions, gold values, or thresholds touched —
`git diff --stat` shows exactly one new test (additive) and one doc comment
(no code-path change). `.harness/bench.json` untouched;
`harness:bench-verify` hash unchanged before/after. The new test's mock
explicitly registers `agentdb_causal-edge` to succeed (not omitted) so the
assertion cannot pass merely because of a missing-mock-handler artifact — the
discriminating-power experiment above is the direct proof this isn't
vacuously true. Independent adversarial critic pass: see PR for verdict.

## Security review
No new dependency, credential, authorization, or MCP-tool-authority surface
— this candidate is a comment plus a test; zero production code paths
changed. The underlying (pre-existing, not introduced by this candidate)
defect fails in the SAFE direction for a cycle-prevention invariant: it
over-blocks (refuses some legitimate edges) rather than under-blocks
(letting a real cycle through) — so the residual risk it documents is
availability/usability (some legitimate `parent_of`/`reports_to` edges
cannot currently be created when the two nodes share an unrelated graph
connection), not an integrity or authorization bypass. Confirmed (grep, same
check #49 and #27 already performed for this exact call graph):
`wouldCreateCycle`/`recordCausalEdge` are not relied on anywhere as an
authorization boundary — `claims-authorization.ts`/`transitionApprovalState`
key off actor identity and persisted approval state, not graph reachability.

## Regression analysis
0 regressions: 327 pre-existing tests unchanged + 1 new, all passing;
`tsc --strict` clean; `harness:bench-verify` hash unchanged. No existing
test's behavior was altered.

## ADR
None — this is a documented, tested gap finding with a deferred fix, not an
architectural decision.

## Next steps
1. A true fix requires ruClip to stop delegating relation-exact cycle
   detection to this tool entirely — maintain its own per-relation adjacency
   index (e.g. via `memory_store`/`memory_retrieve`, same technique
   `governance/propose-budget-mutation.ts`'s level-history window already
   uses) for the two cycle-checked relations only (`parent_of`, `reports_to`).
   Needs its own frozen hypothesis, its own evaluation, and — given it
   changes a hot write path — probably its own Darwin-bounded design-space
   check before it ships, which is why it's named here rather than attempted
   tonight.
2. Human-review priority: this is a *correctness-severity escalation* of
   PR #49's already-open finding, not an unrelated new bug — recommend
   reviewing #37/#49 (the display-field fix) and this run's issue/PR
   together, since a real fix will likely touch the same root cause once.
3. Confirm whether `persistOrgMember`'s `reports_to` edge (org-chart manager
   hierarchy) hits this same false positive in practice on a live bridge —
   not verified against a real running AgentDB bridge in this sandbox (no
   live bridge available here either, same limitation every prior
   dream-cycle night touching this file has recorded).
4. Standing governance note (same backlog named in #34/#36/#48/#50/#55,
   still unresolved): 23 `dream/*` branches now exist on `origin`, 0 merged
   since #15 (2026-09-07), including real, already-ACCEPT-verdict security
   fixes (#29 critical protobufjs RCE, #39 two HIGH toml findings, #51
   grpc-js auth-bypass). Escalated directly to the routine's human owner via
   push notification at the start of tonight's run (see this session's own
   record) rather than only noted here, since report-prose escalation alone
   has not surfaced it across 5+ prior nights.

## Scan: performance
No new performance candidate pursued tonight (DEEP=correctness). Noted,
not re-investigated: #41 (`dream/2026-09-22-performance`, unmerged) already
found and fixed `fireHeartbeat` recalling `Company` and `Issue`/`Goal`
sequentially instead of concurrently — consistent with this repo's now-
established pattern (first found 2026-09-03, PR #11) of sequential-RPC-loop
latency on hot paths. No new instance found tonight.

## Scan: tests
This candidate itself is the tests-scan finding: a previously-undetected gap
in test coverage for `wouldCreateCycle`'s real-backend behavior, now pinned.
Also reconfirmed (unchanged from 2026-09-15's PR #27 finding): the sibling
test `recordCausalEdge refuses a reports_to edge that would close a cycle`
still only works because its own cycle IS genuine — it was not re-weakened
by tonight's change, and continues to pass for the right reason once
`agentdb_causal-edge` succeeds there too (verified unaffected by this diff).

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
the line `## Witness` above — delete this section and everything after it,
then hash what remains.

- Session commit (parent): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `9311ea3abef53146bebcf684049c7a6910061e465c9991432d2868fbe3575785`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `8a81c9df0ff7d559501b7b76d5d2c9d654b9d2ff33864f974b3adc22f3ca52e1`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 6e73a8f060bcbb69965a50ffe4627e33622d4094 --stat` — confirm this
   is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-10-05-correctness-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 6e73a8f060bcbb69965a50ffe4627e33622d4094 | sha256sum` —
   confirm it matches the Witness stamp recorded in the ledger/issue/PR.
4. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src/control-plane/store/agentdb-adapter.ts src/control-plane/store/agentdb-adapter.test.ts && npm ci && npm run build && node scripts/run-tests.mjs dist` —
   confirm 327/327 pass (parent, unmodified).
5. `git checkout dream/2026-10-05-correctness -- . && npm run build && node scripts/run-tests.mjs dist` —
   confirm 328/328 pass, and
   `git diff 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- src/control-plane/store/agentdb-adapter.ts src/control-plane/store/agentdb-adapter.test.ts`
   shows exactly the doc comment + new test described above.
6. Independently confirm the real tool/library shape: `node_modules/@ruvector/graph-node/index.d.ts`
   (`kHopNeighbors`), `node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js`
   (k-hop branch, line ~1064), `node_modules/@claude-flow/cli/dist/src/ruvector/graph-backend.js`
   (`addEdge`/`recordCausalEdge`/`getNeighbors`).
