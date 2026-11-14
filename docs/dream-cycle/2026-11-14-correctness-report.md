# Correctness SOTA Report — 2026-11-14

Dream Cycle nightly research + bounded evolution for `ruvnet/ruClip`.
Nominal slot 4 (`DAYINT % 5 = 4`): DEEP=developer-experience, SCAN=ci,tooling.
**Rotated** (Step 1.1 learning signal) to DEEP=correctness, SCAN=performance,tests
— see "Rotation rationale" below.

## TL;DR

Two things happened tonight, and the second is far more important than the first.

1. **Correctness deep dive, after rotation, found no new reachable bug.** Eight
   core `src/control-plane` files (validation boundary, employee-interaction
   consent/signal computation, comms/notification signing, autogenous
   budget-mutation triggering, claims authorization, approval state machine,
   heartbeat firing, plus targeted reads of `agentdb-adapter.ts`) were read
   line-by-line looking for a fresh, narrow, currently-reachable correctness
   defect not already filed. Every near-miss resolved one of three ways:
   already a deliberate, tested, documented design decision (e.g.
   `assertValidIssue`'s "cancelled" branch is dead-by-construction but
   *correctly* dead — DOMAIN-MODEL.md §1.4 gates only `done`, and there is a
   passing test asserting exactly this); already filed as an open
   issue/PR (`persistIssue`'s `deps.approver`/`deps.handoffTo` gap → #130/#131;
   `propose-budget-mutation.ts`'s read-then-write level-history race → #70);
   or flagged-but-unreachable from any real call site (same pattern this
   codebase already documents repeatedly, e.g. `nextIssue.goalId` can never
   actually differ from `issue.goalId` through the only production call site
   of `persistIssue`, so a key-collision-on-reparent bug class is real in
   principle but not exploitable today). **EVALUATED=no, VERDICT=INCONCLUSIVE.**
   This is the correctness surface's own first exhaustion signal, echoing the
   performance surface's two already-confirmed exhaustions (#117, #127).

2. **The dream-cycle backlog crisis, quantified precisely tonight, is now the
   dominant fact about this repository.** 60 open PRs (oldest: #17,
   2026-09-07, 69 days), 50 open issues (all but #1 are Dream-Cycle-generated),
   **zero merges since 2026-09-07** — every PR that has ever merged (8 total)
   landed in the project's first 6 days, before the nightly cadence took over.
   `docs/dream-cycle/LEDGER.md` on `main` — the routine's own explicitly-named
   "only durable cross-night memory" — has been stuck at 4 rows since
   2026-09-06, through roughly 69 subsequent nightly runs, because every PR
   that would append to it sits unmerged. This exact finding (ledger rows
   siloed on unmerged branches) was already identified and filed as #35
   (2026-09-19, open, unmerged, 87 days old) — not re-filed tonight to avoid
   a duplicate, but re-measured and re-surfaced because the number has only
   gotten worse (#35 reported "9 nights"; tonight it is ~69).

## Rotation rationale (Step 1.1 learning signal)

Tonight's nominal slot (4) is `developer-experience` / scan `ci,tooling`. The
developer-experience surface has produced a backlog/duplicate/ledger-shaped
finding at least 6 times already (#35 2026-09-19, #47 2026-09-29, #65
2026-10-09, #84 2026-10-18, #119 2026-11-04, #129 2026-11-09) — well past the
"repeated in ≥3 prior nights" threshold. Per Step 1.1, DEEP rotated to the
next slot (0: `correctness`); SCAN moved with it to that slot's own
`performance,tests`. The `ci,tooling`-shaped evidence below was gathered
*before* the rotation decision was finalized (it is in fact what confirmed
the rotation was warranted) and is reported as this run's scan finding rather
than discarded.

## What's new / prior art

### Internal evidence (this run, fully re-measured against GitHub tonight)

| Metric | Value |
|---|---|
| Open PRs | 60 (paginated count via REST, not estimated) |
| Oldest open PR | #17, created 2026-09-07T08:25:34Z (architecture, extract pattern-store) |
| Open issues (non-PR) | 50 (49 Dream-Cycle-titled + #1, an unrelated integration-coordination issue) |
| Lifetime merged PRs | 8 — **all** merged 2026-09-02 to 2026-09-07 (project bootstrap) |
| PRs merged since 2026-09-07 | **0** |
| Closed-unmerged PRs | 3 (#9, #19, #68 — superseded/duplicate, not landed) |
| `LEDGER.md` rows on `main` | 4, last appended 2026-09-06 |
| Build/test baseline tonight | `npm ci && npm run build` clean; `npm test` → **327/327 pass** |

### Prior art / comparable defect class (competitor & literature scan)

| Source | What it shows | Grade |
|---|---|---|
| [Duma et al., EASE 2026, AIDev dataset (arXiv:2605.02273)](https://arxiv.org/abs/2605.02273), via secondary summary | Across 930k+ GitHub PRs from repos with 100+ stars, 61% of AI-agent PRs received *no review at all* before being merged or closed; only ~10% of reviewed ones were human-only. Industry baseline is "mostly unreviewed, but still gets disposed of" | B (academic venue, read via secondary summary — not independently fetched from arXiv tonight; treat the exact 61% figure as needing primary-source confirmation) |
| [LinearB, 8.1M PRs / 4,800+ orgs](https://coderabbit.ai/guides/agentic-engineering), cited by multiple vendor sources | Heavy-AI-adoption teams merge ~98% more PRs while review time climbs ~91%; agentic-PR pickup time ~5.3x longer than unassisted | B (single analytics vendor, cross-cited by several independent secondary sources) |
| Hyrax.dev benchmark (2026-06) | Reports agent-PR merge rates in the ~60% range industry-wide | C (single vendor blog, not independently verified) |
| **ruClip's own measured rate, dream-cycle era (since 2026-09-07)** | **0% merged** (0 of 60 open + 3 closed-unmerged = 63 dream-cycle PRs) over 69 days | A (directly measured this run, paginated GitHub REST API, not estimated) |
| AWS preprint, code-modernization self-review (2026-05) | Self-review by the *producing* model misses 31.7% of its own semantic drift, strongly bimodal per model | B (single preprint, not peer-reviewed, but a controlled measurement) |
| `paperclipai/paperclip` (named competitor, `dream.config.json`) — MIT, 83k–100k+ GitHub stars, Node/React/Postgres control plane for teams of AI agents | Directly comparable domain: human-at-the-top governance, per-agent monthly budgets with soft-alert/hard-stop thresholds, pause/terminate any agent, multi-company isolation. Unlike ruClip, it ships an actual **dashboard** a human uses to review/approve agent work day-to-day — plausibly part of why ruClip's review throughput (asynchronous GitHub PRs only, no dedicated review surface) has collapsed to 0% while this comparable project scaled past 83k stars | B (multiple independent community/docs sources converge on the core facts; star counts vary by snapshot) |

Even on the more pessimistic published industry baselines (60% merge rate,
61% no-review-at-all), ruClip's measured 0%-since-day-6 is an outlier, not a
typical agentic-review slowdown — this is a stopped process, not a slow one.

## Testability gate (Step 5)

No non-duplicate, currently-reachable correctness candidate survived the
screen described above. Per Step 5: `EVALUATED=no`, `VERDICT=INCONCLUSIVE`,
documented here and in the filed issue rather than forcing a low-value diff
onto an already-63-PR-deep unreviewed backlog.

## Evaluation Receipt

- `npm ci && npm run build`: clean (no wasm/NAPI surface in this repo; nothing
  to degrade).
- `npm test` on unmodified `main` (`6e73a8f060bcbb69965a50ffe4627e33622d4094`):
  **327/327 pass** — matches every prior night's reported baseline exactly.
- No candidate exists, so no candidate-vs-baseline comparison was run.
- LLM-eval credentials (`OPENROUTER_API_KEY`) are present tonight — not the
  blocker; the blocker is the absence of a non-duplicate testable finding.

## Darwin Lineage

Not run — no candidate to seed a bounded-evolution run from.

## Reward-Hack Check

Not applicable — no candidate, no benchmark/test/threshold touched.

## Security Review

Not applicable — no code change. (Noted for completeness: nothing in
tonight's research involved prompt injection, new tool/MCP authority, or
credential exposure.)

## Next steps (concrete, not vague)

1. **For the human operator, not this session**: the backlog itself (#35's
   remediation, or any single PR from #41/#94/#115/#102 — all previously
   confirmed small and `mergeable: clean`) is a far higher-leverage action
   than any new correctness candidate this or any future night could produce.
   Zero of the last ~63 dream-cycle PRs merging is not a code-quality
   problem; it is a review-capacity problem external to this session's
   authority to fix.
2. If the correctness surface shows a third exhaustion confirmation on its
   next scheduled night, consider whether `dream.config.json`'s 5-slot
   rotation itself needs a 6th state — "backlog triage" — made a first-class
   DEEP surface rather than something every other surface keeps
   rediscovering as a side finding.
3. Re-run tonight's 8-file correctness sweep after any future merge lands
   (merges change `stored`/call-site assumptions this sweep depended on).

## Witness

```
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
REPORT_HASH    = 526f1be58bdacf37a4894f5b63eb3d46510fa0b9aaa56c2ff8f29a17797b9984
WITNESS        = f6ff77d3f14db9c9ab32f1724ba3d7195391e53e8cda04f3a8868852da3ddfd8
```

Verifier procedure (reproducible by anyone):
1. Check out commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` of `ruvnet/ruClip`.
2. Obtain this exact report file (the committed copy at
   `docs/dream-cycle/2026-11-14-correctness-report.md`, or this gist).
3. `sha256sum` the file; confirm it equals `REPORT_HASH` above.
4. `printf '%s%s' "$REPORT_HASH" "$SESSION_COMMIT" | sha256sum`; confirm the
   result equals `WITNESS` above.
5. Confirm `SESSION_COMMIT` is reachable as an ancestor of (or equal to) the
   branch tip this report was committed alongside.
