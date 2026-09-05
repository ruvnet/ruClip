# Correctness SOTA Report — 2026

## TL;DR
`ruvnet/ruClip`'s causal-graph k-hop reads (`wouldCreateCycle` — cycle
prevention for `parent_of`/`reports_to` edges — and `graphNeighbors`, which
feeds `getChildIssueIds`/`getBlockerIssueIds`) have been **silent no-ops
against the real bridge since the code was written**: they parse the MCP
tool response as `{ nodes: [{ id }] }`, but the real, currently-pinned
`agentdb_graph-query` tool (`@claude-flow/cli@3.38.20`, confirmed installed
in this repo's own `node_modules` — the exact version this codebase's own
comments already cite as "ruflo@3.38.20") returns `{ results: [{ nodeId }] }`.
Every existing unit test still passed because the test-suite's own mocks
were written to the same wrong shape as the code — a self-consistent fiction
that was never checked against the real tool's actual contract. Fixed by
reading the real field names; every affected mock corrected to match.

## What's new
- Two functions corrected: `wouldCreateCycle` and `graphNeighbors` in
  `src/control-plane/store/agentdb-adapter.ts` now read `result.results` /
  `r.nodeId`, not `result.nodes` / `n.id`.
- 5 mock-bridge call sites across 4 test files corrected to the real shape
  (`src/control-plane/store/agentdb-adapter.test.ts`,
  `tests/control-plane/agentdb-adapter.test.ts`,
  `tests/control-plane/dashboard-snapshot.test.ts`,
  `tests/control-plane/dashboard-cross-company-gap.test.ts`) — no new tests
  needed; the existing tests, once corrected, ARE the regression tests.
- ~65 lines changed across 5 files. One conceptual change (a wire-shape
  correction), applied everywhere it appears.

## A rejected hypothesis first (kept, not discarded — see Final Operating
## Principle)
Tonight's research initially targeted a *different*, real bug in the same
function: `wouldCreateCycle` hardcodes `depth: 5`, which is a false negative
for any `parent_of`/`reports_to` cycle whose only path back exceeds 5 hops.
**H1** (frozen, implemented, evaluated): widen the k-hop depth geometrically
(5→20→80→320) with a reachable-count stabilization rule. This *passed*
`npm test` (323/323, 3 new tests added) and `harness:bench-verify`. An
independent adversarial critic then read the real tool implementation
directly (`node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js`)
and found the server clamps `depth` to `complexityBudget.maxDepth` (default
**5**) regardless of what the caller sends — H1's fix is a no-op against the
real bridge, and adds a permanent extra round trip for nothing.
**Verdict: REJECTED** (critic_clear failed) — a clean measurement, not a
wasted night: reading that same real tool source line-by-line is what
surfaced tonight's actual finding (the response-shape bug below), which the
mock-based test suite alone could never have revealed.

## Competitors / prior art (bridge-contract drift between a client and its
## real backend)
| System | Relevant lesson | Grade |
|---|---|---|
| `paperclipai/paperclip` (named competitor) | Single-repo control plane, no third-party MCP bridge indirection for its org-chart storage — this whole class of client/server-shape drift doesn't arise the same way in its architecture | B |
| gRPC / Protobuf schema evolution practice | The standard industry answer to "client and server drift on wire shape" is a shared, versioned schema (proto/IDL) checked at build time, not independently-hand-written client parsing + independently-hand-written test mocks that can silently agree with each other while both disagree with the real server | A (widely documented, vendor-neutral engineering practice) |
| Consumer-driven contract testing (e.g. Pact) | Exists specifically to catch this exact failure mode — a mock that satisfies the client's tests while never being checked against the real provider's actual response shape | A (established methodology, e.g. pact.io documentation) |
| This repo's own prior self-corrections (file headers throughout `agentdb-adapter.ts`, `bridge-client.ts`, `claims-authorization.ts`) | The codebase has a strong, repeatedly-demonstrated practice of finding real-tool behavior by reading the actual installed source rather than trusting a design doc — tonight's finding is a case that practice had not yet reached for this one tool call | B (internal precedent, consistent pattern across many files) |

The common thread: nothing here is exotic. A hand-rolled MCP client with a
hand-rolled test mock, with no schema contract or consumer-driven contract
test tying the two to the real provider, is a known-shaped gap — this repo
already reads real source elsewhere for exactly this reason; this was the
one k-hop call site that hadn't been checked that way yet.

## Hypothesis (H2, frozen before implementation, the one actually shipped)
> Given the real, currently-pinned `agentdb_graph-query` MCP tool
> (`@claude-flow/cli@3.38.20`) returns k-hop results as
> `{ results: [{ nodeId }] }`, when `wouldCreateCycle`/`graphNeighbors` parse
> the response as `{ nodes: [{ id }] }` instead, then both functions should
> [currently do NOT] ever observe a populated result — cycle prevention never
> rejects any edge and `getChildIssueIds`/`getBlockerIssueIds` always return
> `[]`, regardless of what causal edges actually exist. The candidate (read
> `results`/`nodeId`) should make both functions observe real graph state,
> subject to: id values remain the same domain-prefixed strings the rest of
> the file already assumes (`entityNodeId`, the `entity:issue:` prefix strip
> in `getChildIssueIds`/`getBlockerIssueIds`), and no regression in any
> currently-passing test once its mock is corrected to the real shape.

## Evaluation receipt
- Baseline (parent — `git stash` of the one production file, test-file
  corrections to the real shape left in place): `npm test` → **316/320
  pass, 4 fail** — all 4 failures are genuine behavioral divergences (empty
  array where a populated one was expected), not incidental:
  `persistIssue refuses a parent_of edge that would close a genuine
  (non-self) cycle...`, `getBlockerIssueIds strips the entity:issue:
  prefix...`, `getChildIssueIds strips the entity:issue: prefix...`,
  `buildDashboardSnapshot assembles Company/Goals/Issues/Heartbeats...`.
  (One further cycle test, `recordCausalEdge refuses a reports_to edge...`,
  still incidentally "passes" against baseline for the wrong reason — it
  only asserts `rejects(..., AgentDbBridgeError)`, and a missing mock
  handler for the edge-write step throws that same error class regardless
  of whether a cycle was actually detected. Noted as a pre-existing test
  brittleness, out of tonight's scope to fix.)
- Candidate (working tree): `npm test` → **320/320 pass**, `npm run build`
  clean, `npm run harness:bench-verify` → `Suite repo-native@0.1.0: 6 tasks,
  hash OK` (unchanged hash).
- Diff size: ~65 lines across 5 files.

## Darwin
Not run — this is a mechanical, single-root-cause field-rename with no
parameter space to explore (unlike H1's depth schedule, which did have
tunable constants). Time budget went to the critic passes instead (one per
hypothesis, both independently grounded in the real installed tool source).

## Evidence classification
- MEASUREMENT: baseline 316/320 (4 genuine behavioral failures); candidate
  320/320; `harness:bench-verify` hash unchanged.
- OBSERVATION: `node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js`
  (`agentdbGraphQuery.handler`) returns `results`/`nodeId` on both its
  graph-node-native and SQL-CTE-fallback k-hop paths; `package.json` version
  `3.38.20` matches this repo's own existing citations exactly (not a
  version-drift artifact).
- INFERENCE: id VALUES returned by the real tool are the same
  domain-prefixed strings (`entity:issue:...`) this file already assumes
  elsewhere — inferred from `getNeighbors`'s role in the broader
  `agentdb-tools.js` module (it feeds the same node-id space `agentdb_causal-edge`
  writes into), not independently exercised end-to-end against a live bridge
  (none is available in this sandbox).
- REJECTION: H1 (depth widening via a larger `depth` parameter) — real tool
  clamps server-side regardless of the value sent; kept as a documented,
  falsified hypothesis, not deleted from the record.
- DECISION: ship H2 (shape fix) only; do not bundle H1's depth change into
  the same PR — two independent conceptual changes, and H1's premise
  (raising `depth` helps) is now known false without also sending
  `complexityBudget.maxDepth`, which is unexplored/untested tonight.

## Security review
No new capability, credential, or authority surface. Cycle prevention was
already relied on nowhere else as an authorization boundary (confirmed:
`claims-authorization.ts`/`transitionApprovalState`'s self-approval and
authorization guards key off actor identity and persisted approval state,
not off `parent_of`/`reports_to` graph reachability) — so tonight's fix is a
correctness/data-integrity restoration, not a new attack-surface change.
Residual risk this fix newly ACTIVATES (worth flagging precisely because the
feature starts actually running for the first time): cycle prevention was
previously always a no-op (never rejected anything); now that it can reject,
any legitimate deep-but-acyclic `parent_of`/`reports_to` write beyond 5 hops
could hit H1's still-open false-negative gap in the *other* direction — i.e.
a truly cyclic edge beyond depth 5 can still slip through undetected post-fix,
same as before, just for the first time in a way that matters. Documented as
next step 1 below, not silently left implicit.

## Next steps
1. H1's real gap (depth-5 false negative) is now LIVE for the first time
   (cycle prevention actually runs). A correct fix must pass
   `complexityBudget: { maxDepth: N }` in the `agentdb_graph-query` call
   (confirmed from the real tool's own schema — `depth` alone is clamped to
   `complexityBudget.maxDepth ?? 5`), not just raise `depth`. Needs its own
   frozen hypothesis and evaluation against that corrected mock shape.
2. `recordCausalEdge refuses a reports_to edge that would close a cycle`
   (coder-stage suite) passes for the wrong reason (an unrelated missing
   mock handler throws the same error class as a real cycle rejection) —
   worth tightening so it actually proves cycle detection, independent of
   tonight's fix.
3. Sweep the rest of `agentdb-adapter.ts`'s other `callTool<...>()` response
   shapes against `node_modules/@claude-flow/cli`'s real handler source the
   same way tonight's fix did for `agentdb_graph-query` — this was found by
   an adversarial critic checking ONE call site; there may be others.

## Witness

Hash scope: sha256 of this file's content from byte 0 up to (not including)
the line `## Witness` above — i.e. delete this section and everything after
it, then hash what remains. This avoids the self-referential-hash problem (a
hash cannot include itself).

- Session commit (parent): `41433bb971bc6152122acc180c5d695e55ea8c07`
- Report sha256 (of the pre-Witness-section content, per the scope above):
  `746f9fa2310f65c8f2f40e989186d55ac8d32fc811cbffade406e57a4468e32d`
- Witness stamp (`sha256(report_sha256 + session_commit)`):
  `00af13527b925842621f8252b5faea310ae7750fd4062f990ac66915195a03a3`

Verifier procedure (reproducible by anyone from this committed file alone):
1. `git show 41433bb971bc6152122acc180c5d695e55ea8c07 --stat` — confirm this
   is the session's starting commit.
2. `sed '/^## Witness$/,$d' docs/dream-cycle/2026-09-05-correctness-report.md | sha256sum` —
   confirm it matches the Report sha256 above.
3. `printf '%s%s' <report_sha256> 41433bb971bc6152122acc180c5d695e55ea8c07 | sha256sum` —
   confirm it matches the Witness stamp recorded in the ledger/issue/PR.
4. `git checkout 41433bb971bc6152122acc180c5d695e55ea8c07 -- . && npm ci && npm test` —
   confirm 320/320 pass (baseline receipt matches the "with corrected test
   mocks, unfixed production code" state described in the Evaluation
   receipt above — note this differs from the architecture/performance
   nights' baseline convention since tonight's baseline is "mocks fixed,
   code not yet fixed", not literally the parent commit unmodified).
5. `git checkout dream/2026-09-05-correctness -- . && npm ci && npm test` —
   confirm 320/320 pass, and
   `git diff 41433bb971bc6152122acc180c5d695e55ea8c07 -- src/control-plane/store/agentdb-adapter.ts`
   shows exactly the `results`/`nodeId` shape correction in
   `wouldCreateCycle` and `graphNeighbors`.
6. Independently confirm the real tool shape:
   `node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-tools.js`,
   `agentdbGraphQuery.handler`, k-hop branch.
