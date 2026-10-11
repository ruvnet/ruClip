# Security SOTA Report — 2026

Issue: #69 · Branch: `dream/2026-10-11-security`

## TL;DR

`propose-budget-mutation.ts`'s rolling observation window — the sole gate on
ruClip's one autonomous governance trigger (auto-tightening
`Company.budget.hardStopThreshold` after 3 consecutive WARNING-or-worse
budget readings) — stored its history as a single mutable JSON blob under one
shared key, updated by `memory_retrieve`-the-blob, append, `memory_store`-the-
whole-blob-back. That is a textbook check-then-act race (CWE-362), the exact
same class the 2026-09-06 dream cycle fixed in the actor-credential nonce
guard, just in a different file. Two overlapping heartbeat fires for the same
company (plausible: this design's heartbeat delivery is at-least-once, never
documented as at-most-once) can both read the same prior history before
either writes, and the second writer's blob silently clobbers the first's —
losing an observation with no error, no log, nothing. Confirmed with an
independent, deterministic concurrency test: baseline 28/29 (the new test
fails exactly as predicted — 2 observations retained instead of 3), candidate
328/328 (full suite), 0 regressions.

Fixed by replacing the shared mutable key with one immutable, uniquely-keyed
entry per observation (`upsert: false`) and reconstructing the window via
`memory_list` + per-key `memory_retrieve` — the same shape this repo's own
`checkOperatingBudget` cost-tracking namespace already established
(2026-09-03 dream cycle). This is not a style preference: the backend's only
atomicity primitive is strict-insert-on-a-new-key; there is no
compare-and-swap on an existing key's value, so a shared mutable blob cannot
be made race-free with the tools available, under any sequencing of the
read and the write.

## What's new

Nothing externally new is being adopted here — this is an internal
correctness/security finding grounded entirely in this repository's own code
and its own real backend's documented tool contract, not a claim about the
wider field. The one load-bearing external fact is general and well
established, not benchmarked: check-then-act races on shared mutable state
(CWE-362) are a standard class, and the standard mitigation where no
value-level CAS exists is append-only/event-sourced writes (each write
immutable and independently addressable) rather than in-place mutation —
exactly what this fix does, and exactly the shape this repo's own
cost-tracking namespace and nonce guard already use elsewhere. Grade: A for
"CWE-362 is a real, named class and append-only writes are a standard
mitigation" (textbook, not disputed); the application of it here is derived
directly from this repo's own code, not from an external benchmark.

## Competitors / prior art (how other agent-governance / audit-trail designs avoid this)

| System | Relevant mechanism | Grade |
|---|---|---|
| This repo's own `actor-credential.ts` nonce guard (2026-09-06 dream cycle) | Single-use replay guard collapsed from retrieve-then-store into one atomic strict-insert (`upsert: false`) — the direct precedent for tonight's fix | A (reproducible — same codebase, same backend, read directly) |
| This repo's own `agentdb-adapter.ts` cost-tracking namespace (2026-09-03 dream cycle) | Per-session-key fan-out via `memory_list` + bounded concurrent `memory_retrieve`, never a single mutable summary blob | A (reproducible — same codebase) |
| Event-sourced audit logs generally (e.g. Kafka-style append-only logs, CQRS event stores) | Writes are immutable, independently ordered facts; current state is a fold over the log, not an in-place mutation — structurally immune to the lost-update class this fix closes | B (well-documented industry pattern, not independently re-verified against a specific vendor claim tonight) |
| `paperclipai/paperclip` (named competitor) | No equivalent autonomous budget-governance trigger surfaced in its public docs to compare against; no specific claim made | C (not independently confirmed — too thin a surface to grade higher; not used to justify the fix) |

## Hypothesis (frozen before implementation)

> Given two concurrent `recordLevelObservation` calls for the same
> `companyId` (e.g. two overlapping heartbeat fires under this design's
> at-least-once delivery), when the rolling window is stored as a single
> mutable key updated by retrieve-then-store, then one of the two
> observations is silently lost (last-writer-wins) — corrupting the input
> `isNewWarningStreak` gates the one autonomous budget-tightening trigger on.
> Replacing the shared mutable key with one immutable key per observation
> (`upsert: false`) plus a `memory_list`-based window read should make
> concurrent calls lose zero observations, with `isNewWarningStreak`'s
> existing sequential-call behavior (and the rest of the 327-test baseline
> suite) unchanged.

## Evaluation receipt

- **Evaluator**: `npm test` (`tsc -p tsconfig.json && node --test` over
  `dist/**/*.test.js`) — the repo's own real evaluator, not inferred from
  logs.
- **Baseline** (parent `propose-budget-mutation.ts`, unmodified; new
  concurrency test applied on top, `recordLevelObservation` temporarily
  exported for direct testability): `tests/control-plane/autogenous-governance.test.ts`
  + `tests/control-plane/autogenous-runaway-trigger-gap.test.ts` → **28/29**.
  The one failure is exactly the predicted one: `recordLevelObservation loses
  no observation when two callers race` — `actual: 2, expected: 3` (one of
  the three observations — 2 concurrent + 1 sequential — was lost to the
  race, reproduced deterministically via a shared-barrier mock gating every
  `memory_store`/`memory_retrieve`/`memory_list` call until both concurrent
  callers have arrived, the same technique `actor-credential-fixture.ts`'s
  `racingNonceMockHandlers` already established).
- **Candidate** (fix applied): full suite → **328/328** (327 pre-existing +
  1 new), **0 regressions**. The same barrier-gated race now durably retains
  all 3 observations: two concurrent writers write two distinct,
  `randomUUID()`-suffixed keys (no collision to race), and the window read
  (`memory_list` + per-key `memory_retrieve`) sees both once both land.
- **Build**: `tsc -p tsconfig.json` clean, no errors, no `any`-suppression
  added.
- **Lint**: `npm run lint` — no-op (scaffold stage, unchanged by this PR).

## Darwin

Not run — the candidate's correctness rests on a structural property (no
read-modify-write step exists to race) verifiable directly by the
concurrency test above; there is no tunable parameter here for a bounded
mutation search to explore, and Bounded Darwin is explicitly optional.

## Evidence ledger

- **OBSERVATION**: `propose-budget-mutation.ts`'s `recordLevelObservation`
  (pre-fix) performs `memory_retrieve` the shared blob, append, `memory_store`
  the whole blob back with `upsert: true` — read directly from the file.
- **MEASUREMENT**: baseline 28/29 on the two affected test files (the new
  concurrency test fails exactly as predicted); candidate 328/328 full suite.
- **INFERENCE**: two overlapping heartbeat fires for the same company are a
  plausible real trigger for this race, since `HEARTBEATS-AND-COMMS.md`
  documents at-least-once (never at-most-once) heartbeat delivery — this is
  a reasoned inference from the design docs, not a measurement of a live
  duplicate-fire event (none exists; no live deployment yet).
- **DECISION**: ship the per-observation-key fix; do not attempt a
  same-key CAS fix, because the backend's only atomicity primitive
  (strict-insert on a new key) cannot express compare-and-swap on an
  existing key's value — confirmed by reading `callTool`'s real contract
  and the two existing codebase precedents that already work around the
  identical limitation this way.
- **REJECTION**: none — the first fix shape considered (atomic CAS on the
  existing shared key) was rejected analytically, before implementation,
  for the reason given above, not after a failed attempt.

## Reward-hack check (independent critic pass)

- Benchmark/gold data: untouched — no existing test's expected value was
  changed; the only new assertion (`finalHistory.length === 3`) is additive.
- Cherry-picking: ran the FULL 328-test suite, not just the new/affected
  files, for the final candidate verdict.
- Evaluator exploitation: none — same real `npm test` entrypoint, no mock
  substituted for it.
- Hidden cost: `readLevelHistory` now costs one `memory_list` plus up to
  `WINDOW_SIZE` (10) `memory_retrieve` calls per observation, versus the old
  single `memory_retrieve`+`memory_store` pair — a real, disclosed latency
  increase on this file's own hot path (every heartbeat fire), not hidden;
  bounded by `WINDOW_SIZE`, not by input size.
- Threshold tampering: `CONSECUTIVE_THRESHOLD`/`WINDOW_SIZE` unchanged.
- Undocumented caching: none added.
- Self-identified residual risk: `LEVEL_HISTORY_NAMESPACE`'s `memory_list`
  call shares the same repo-wide, not-company-scoped, 1000-entry cap
  `checkOperatingBudget` already relies on — documented inline as a known,
  pre-existing, not-reachable-at-current-scale caveat rather than silently
  omitted.

## Security review

No prompt-injection, credential, filesystem/network-scope, or MCP-authority
surface touched. No new dependency. The change is strictly within the
existing `memory_store`/`memory_retrieve`/`memory_list` tool contract this
file already used. Net effect on the one autonomous-mutation trigger in this
codebase is a *tightening*, not a loosening: the governance trigger's input
can no longer silently lose data, so if anything this closes a path by which
the trigger could under-fire (miss or delay a real budget incident), never a
path to over-fire or escalate privilege. `Mutation.requested_authority`
remains `auto_reversible`-only (`buildMutation`, unchanged); this PR does not
touch admission, canary, or promotion logic at all.

## Scan findings

- **dependencies**: `npm audit` (fresh `npm ci` this session) reports 52
  vulnerabilities (2 critical: `protobufjs`, `proxy-addr`; 21 high) across
  this repo's full dependency closure — overwhelmingly in the
  `@claude-flow/*`/`agentdb`/`agentic-flow`/ONNX/OpenTelemetry peer-dependency
  tree (`metaharness`/`ruflo`/`ruvector`/`agentbbs` ecosystem), not ruClip's
  own ~30 source files. Two prior dream-cycle nights (2026-09-21 PR #39,
  2026-10-01 PR #51) already opened point fixes for specific findings in
  this tree (`toml`, `@grpc/grpc-js`); neither is merged. Not tonight's
  candidate (out of the <300-line, one-conceptual-change scope, and already
  has open, unmerged tickets) — flagged here as a standing scan result, not
  re-filed as a new issue.
- **secrets**: no hardcoded secrets, API keys, or credentials found in the
  changed files or in a targeted re-read of `signing-key.ts`/`credential-
  issuer.ts`/`google-token.ts` (all GCP Secret Manager / escape-hatch-only,
  confirmed in a prior round and re-read tonight, unchanged).

## Gist

LOCAL — no `gh`/gist-creation tool available in this session (GitHub access
here is via the GitHub MCP server's issue/PR tools only, no gist-equivalent).
This file is the full report; its hash is stamped below and the file itself
is committed into `docs/dream-cycle/2026-10-11-security-report.md` on the
`dream/2026-10-11-security` branch.

## Witness

- Session commit (`SESSION_COMMIT`, HEAD at the start of this run):
  `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- This report's own sha256 (`REPORT_HASH`):
  `5efb8f752bba1befff89d0a342007e242d5d0e6d4f242df128a9f728c00483ff`
- Witness stamp (`sha256(REPORT_HASH || SESSION_COMMIT)`):
  `62dffe07e17712796e64552395a6e7202a8711d405be15ff3f9472a17e2a0d17`

Anyone can reproduce this independently:

1. Check out `ruvnet/ruClip` at commit `6e73a8f060bcbb69965a50ffe4627e33622d4094`.
2. Take the exact byte content of this report as committed at
   `docs/dream-cycle/2026-10-11-security-report.md` on branch
   `dream/2026-10-11-security`.
3. `sha256sum docs/dream-cycle/2026-10-11-security-report.md` — must equal
   `REPORT_HASH` above (note: hashing the file AFTER this Witness section is
   filled in reproduces the PUBLISHED hash chain's final link, not
   `REPORT_HASH` itself, which was computed on the pre-Witness-section draft
   — see the PR body's Witness section for the exact two-stage procedure).
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` — must equal the
   witness stamp above.
5. Cross-check against the PR (`dream/2026-10-11-security`) and the issue
   `[Dream Cycle 2026-10-11]` filed in the same repository — both name the
   same witness stamp.

## Recommended next steps

1. **Review and merge the actual backlog.** As of tonight, 28 dream-cycle
   issues and ~21 dream-cycle PRs (plus 3 earlier, pre-dream-cycle PRs) are
   open and unreviewed back to 2026-09-02/09-17 (issue #8/PR#9 is the
   oldest still-open one; three findings — #15 security, #11 performance,
   #13 correctness — did land on `main` via direct pushes, bypassing their
   own still-open PRs, which is itself a process gap: the ledger and the PR
   list disagree about what's actually shipped). `docs/dream-cycle/LEDGER.md`
   itself has been frozen since 2026-09-06 (issue #34 already names this
   gap) despite ~25 more nights of real work landing on GitHub since — the
   durable cross-night memory this file is supposed to be has been silently
   incomplete for over a month. No dream-cycle PR has ever been reviewed or
   merged through GitHub's own merge path. This is a human-review bottleneck,
   not a code-quality problem — flagged for the routine owner, not
   actioned autonomously (merge policy: human review required).
2. **Company-scope `LEVEL_HISTORY_NAMESPACE`** (or shorten
   `OBSERVATION_TTL_SECONDS`) before this project has more than a handful of
   companies, to retire the shared-namespace `memory_list` 1000-cap caveat
   documented inline in tonight's fix.
3. **Apply the same audit** (search for other `memory_retrieve`-then-
   `memory_store` read-modify-write pairs) to the rest of the codebase —
   tonight's search covered `src/`+`services/` exhaustively for this exact
   grep pattern and found exactly one other instance beyond the two already
   fixed (nonce guard, 09-06; this file, tonight); worth re-running after
   future feature work adds new memory_store call sites.
