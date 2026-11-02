# Control-Plane Read-Path Concurrency SOTA Report — 2026

## TL;DR

`ruvnet/ruClip`'s AgentDB adapter scans its `working` and `episodic` memory
tiers sequentially in three list-style read helpers
(`listIssuesForGoal`, `listApprovalTransitionsForCompany`,
`listHeartbeatsForCompany`), even though the two tiers are independent reads
merged client-side with no data dependency between them. Converted all three
to `Promise.all`-based fan-out. Measured effect: a single call's two tier
round-trips go from paying their latency back to back (~103ms at 50ms/call in
a synthetic harness) to paying it once (~54ms), ~1.9x. Real test suite:
327→330 (3 new, additive), 0 regressions. The baseline (pre-candidate) code
is proven, not asserted, to be sequential: the 3 new tests deadlock against
it (an in-flight-call tracker that only resolves once both tier calls have
simultaneously arrived never resolves under the old for-loop).

## What's new

Nothing novel algorithmically — this is the exact same "independent reads,
fan out, bounded where unbounded" family of fix the ledger already has one
ACCEPTed precedent for (`checkOperatingBudget`'s `mapWithConcurrency`,
2026-09-03). What's new tonight is finding three more call sites in the same
file with the identical shape (`for (const tier of ['working','episodic'])`)
that the earlier fix didn't touch, because they aren't the session-cost path
it was scoped to.

## Competitors (tonight's surface: control-plane read-path concurrency)

| Project | Approach to independent multi-source reads | Grade |
|---|---|---|
| paperclipai/paperclip | Single relational DB (Prisma/Postgres) — no tiered-store fan-out problem exists; reads are one query | A (official repo, read directly) |
| Temporal (workflow orchestration) | `Promise.all`/activity-batching is the documented idiom for independent activities; sequential awaits flagged as an anti-pattern in their own docs | B (official docs, not ruClip-specific) |
| LangChain/LangGraph parallel nodes | Graph-level fan-out (`Send` API) for independent branches, same rationale: no data dependency, no reason to serialize | B (official docs) |
| This repo's own prior art | `mapWithConcurrency` (bounded worker pool) for unbounded N; plain `Promise.all` is the right tool specifically because N here is fixed and small (2 tiers), not open-ended | A (this repo, read directly) |

No paper/arXiv citation needed — "don't serialize independent I/O" is not a
research claim, it's the standard idiom every competitor above already uses;
tonight's contribution is locating the 3 remaining instances of the one
anti-pattern in this specific codebase, not a novel technique.

## Hypothesis (frozen before implementation)

> Given a dashboard build (`buildGoalSnapshot` → `listIssuesForGoal`), an
> interaction-profile recompute (`recomputeInteractionSignals` →
> `listApprovalTransitionsForCompany`), or a heartbeat-status listing
> (`listHeartbeatsForCompany`), when the two-tier (`working`, `episodic`)
> `agentdb_hierarchical-recall` scan inside each of those three helpers is
> issued via `Promise.all` instead of a sequential `for` loop, then per-call
> latency should approach `max(tier latencies)` instead of their sum,
> subject to: byte-identical merged result (working-then-episodic order
> preserved regardless of which tier resolves first — `Promise.all`
> preserves input-array order), 0 regressions in the existing 327-test
> suite, and no new MCP tool/permission surface.

## Benchmarks / Evaluation Receipt

Evaluator: `npm test` (this repo's real, only entrypoint — `tsc` build then
`node --test` over `dist/tests`). No LLM calls; `OPENROUTER_API_KEY` is
present in this environment but this repo's evaluator never calls a model —
`LLM_EVAL=not-applicable`, not blocked.

- **Baseline** (`6e73a8f060bcbb69965a50ffe4627e33622d4094`, `main`'s current
  HEAD): `327 tests, 327 pass, 0 fail`. Applying only the 3 new tests
  (`tests/control-plane/tier-scan-concurrency.test.ts`) against this
  baseline's *unmodified* `agentdb-adapter.ts`: **3 fail** — each with
  `'Promise resolution is still pending but the event loop has already
  resolved'` (Node's test runner's own name for the deadlock: an in-flight
  counter that only unblocks once 2 calls have simultaneously arrived never
  unblocks when the two tier calls are issued one after the other).
- **Candidate** (this branch): `330 tests, 330 pass, 0 fail` (3 new,
  additive, 0 regressions).
- **Synthetic timing** (ad hoc harness, not committed — a single
  `listIssuesForGoal` call against a mock bridge with a real 50ms
  `setTimeout` per `agentdb_hierarchical-recall` call):
  - Baseline: `103ms` (two 50ms round trips back to back).
  - Candidate: `53-54ms` (two 50ms round trips concurrently) — **~1.9x**.

## Darwin Lineage

Not run. There is no fitness landscape here: the fix is "fan out exactly 2
fixed, independent calls with `Promise.all`" — there is no tunable parameter
(unlike `mapWithConcurrency`'s concurrency cap, which did warrant a sweep on
2026-09-03) and no alternative implementation worth generating and scoring
against it.

## Evidence

OBSERVATION (`for (const tier of ['working','episodic'] as const)` with a
sequential `await callTool(...)` inside, at 3 call sites in
`store/agentdb-adapter.ts`: `listIssuesForGoal`,
`listApprovalTransitionsForCompany`, `listHeartbeatsForCompany`) →
OBSERVATION (both tiers' results are merged client-side with no ordering or
data dependency between them — confirmed by reading every call site; none
inspects one tier's result before querying the other) → MEASUREMENT (3 new
tests deadlock against the unmodified baseline, pass against the candidate;
327→330, 0 regressions) → MEASUREMENT (synthetic 50ms/call harness: 103ms →
53ms, ~1.9x) → DECISION (ACCEPT).

## Reward-Hack Check

No benchmark/gold data touched or weakened — 0 existing tests modified, only
3 new additive tests plus the production change. The new tests are
adversarial toward the *baseline*, not favorable to the candidate by
construction: they assert `maxInFlight === 2`, which only a genuinely
concurrent implementation can satisfy; a candidate that merely reordered the
`for` loop or memoized a result could not pass. No cherry-picked workload —
the 3 call sites are the complete set of this exact pattern in the file
(verified by `grep -n "for (const tier of \['working', 'episodic'\]"`,
re-run after the edit to confirm 0 remaining matches). No hidden cost: 0 new
dependencies, 0 new MCP tool calls per invocation (same 2 calls, now
concurrent instead of sequential), no threshold or cache touched. Promise.all
fails fast on the first rejection exactly like the old sequential code did
(a `working`-tier failure already aborted `episodic` under the old code too,
by throwing before the loop's second iteration) — verified by reading, not
assumed; no behavior change on the error path beyond also shaving its
latency. No unresolved signal.

## Security Review

No new MCP tool authority (same `agentdb_hierarchical-recall` tool, same
`working`/`episodic` tiers, routed through the existing `callTool` bridge
wrapper and `config` pass-through — nothing new is reachable). No credential
handling, filesystem, or network-scope change. No prompt-injection surface:
the change is pure control-flow (loop → `Promise.all`), touches no string
built from untrusted input beyond what the unmodified query strings already
built. `Promise.all`'s fail-fast semantics match the prior sequential
fail-fast semantics, so no new partial-failure/inconsistent-state class is
introduced.

## Scan: docs,api (slot's originally-assigned scan, done in addition to the
rotated performance deep-dive — see Rotation note in the issue)

- **docs**: `docs/dream-cycle/LEDGER.md` on `main` is still frozen at its
  2026-09-06 row plus the lone 2026-11-01 backfill row added by last night's
  security run — the ledger-fragmentation finding from 2026-10-12 (#71) and
  2026-10-22 (#91/#92) is unresolved; this is the reason tonight's DEEP
  surface was rotated away from architecture (see Rotation below), not a new
  finding.
- **api**: no public API surface change. `listIssuesForGoal`,
  `listApprovalTransitionsForCompany`, and `listHeartbeatsForCompany` keep
  their exact signatures and return types; only their internal fan-out
  strategy changed.

## Competitors note (repo-wide, not tonight-specific)

`paperclipai/paperclip` remains the only named competitor in this repo's own
ADR-0001; it has no equivalent tiered-memory read path (relational DB, one
query) so this specific finding has no paperclip analogue to compare
against.

## Next steps (concrete, for whoever reviews this)

1. **Review and merge the dream-cycle backlog, starting with the smallest,
   lowest-risk PRs first.** As of tonight: 0% of dream-cycle PRs merged
   across at least 20 consecutive nights (2026-10-14 → 2026-11-01, PRs
   #76-#113, all `state: open`), on top of the 2026-09-02→09-06 backlog
   (#9/#11/#13/#15) that was already unmerged when #71/#91 raised this
   exact concern on 2026-10-12 and 2026-10-22. This PR is designed to be
   one of the easiest in that backlog to review: 1 file of production code,
   a mechanical loop→`Promise.all` change repeated identically 3 times,
   fully covered by new tests that fail without the fix.
2. Apply the identical pattern check (`grep` for sequential-award loops over
   a fixed, small, independent set) to `claims-authorization.ts` and
   `bridge-client.ts` — not done tonight (budget), flagged for a future scan
   night.
3. Reconcile `docs/dream-cycle/LEDGER.md` on `main` (PR #92, already open,
   already does this) so future nights' "last 14 rows" ledger check reflects
   reality instead of requiring a live GitHub API pull every time, as
   tonight's run had to do.

## Witness

```
REPORT_HASH    = 130ffcdf38b25a7870f96475377a6c976b1427e8724f9339ba2655e96aa3ed94
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 403e577c9fad018d8e05a167febf001233b2ab1a4b0d78be75e0ff9cc81de887
```

(`REPORT_HASH` is the sha256 of this file's content immediately before this
line was filled in with its own value, per `dream-machine witness stamp`'s
usual self-reference convention — recompute from the gist's raw bytes to
confirm, keeping in mind the stamp step necessarily edits the file after
hashing it.)

**Verifier procedure** (reproducible by anyone, no tool beyond `sha256sum`/`git`):
1. Check out `ruvnet/ruClip` at commit `6e73a8f060bcbb69965a50ffe4627e33622d4094`.
2. Fetch this gist's raw content; compute `sha256sum` of the raw file → must equal `REPORT_HASH` above.
3. Compute `printf '%s%s' "$REPORT_HASH" "$SESSION_COMMIT" | sha256sum` → must equal `WITNESS` above.
4. Check out branch `dream/2026-11-02-performance`; run `npm test` → expect `330 tests, 330 pass, 0 fail`.
5. Revert only `src/control-plane/store/agentdb-adapter.ts` to the `main`
   commit above (keep the new test file) and rerun `npm test` → expect
   `327 pass`, the 3 new tests failing/cancelled with a pending-promise
   error, reproducing tonight's baseline-vs-candidate receipt.
