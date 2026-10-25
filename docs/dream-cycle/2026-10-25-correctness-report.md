# Correctness SOTA Report — 2026-10-25

Dream Cycle 2026-10-25 — correctness deep dive + performance,tests scan +
bonus roadmap-review (`DAYINT % 25 == 0`).

## Rotation

`DAYINT=20261025`, `SLOT = DAYINT % 5 = 0` → `DEEP=correctness`,
`SCAN=performance,tests`. `DAYINT % 25 = 0` → **bonus roadmap-review** (see
below). `SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main`
tip at session start, unchanged throughout — no merges landed tonight).

## TL;DR

`services/ruclip-attester/src/identity-map.ts`'s `lookupIdentity` matched
the verified Google `email` claim against the identity-mapping secret with
an exact, case-sensitive JS object-key lookup. Google account email
matching is case-insensitive in practice; a JS object-key lookup is not.
A legitimately-mapped employee whose verified claim happens to differ in
case from however the `ruclip-attester-identity-map` secret's JSON was
hand-typed gets the same generic 403 as someone with no mapping at
all — a false-negative lockout of a real identity. Fixed by normalizing
both sides (`trim().toLowerCase()`) before matching, with a new fail-closed
collision check if two secret entries would collide once normalized.
+32/-2 production, 1 file; +26 test, 1 file. 327→331/331, 0 regressions,
`harness:bench-verify` hash unchanged.

**Build**: `npm ci` (665 packages, 52 vulnerabilities — unchanged from
baseline, tracked separately by prior security nights, not tonight's
surface) + `npm run build` (`tsc`) both clean. **LLM_EVAL**:
`OPENROUTER_API_KEY` is present this session but unused — tonight's
candidate is a deterministic string-normalization fix needing no model
call. **FALLBACK**: `false` — GitHub MCP tools (issue/PR read+write) work;
no gist-creation tool is available this session (`GIST=LOCAL`, same as
every prior night since 2026-09-07).

## Ledger Check (STEP 1) + Learning Signals (STEP 1.1)

`docs/dream-cycle/LEDGER.md` on `main` holds 5 rows (2026-09-02 →
2026-09-06) — frozen, as already fully diagnosed and quantified by
issue #91/PR #92 (2026-10-22) and reconfirmed by #93 (2026-10-23) and #95
(2026-10-24): every night's ledger-row commit lands only on that night's
own unmerged `dream/*` branch, never on `main`. Verified live tonight via
the GitHub MCP tools: **41 dream-cycle issue/PR pairs since #15
(2026-09-07); 0 of the last 37 have merged (7.3% all-time).** Not
re-escalating a 4th time — already pushed to the human operator as a
direct notification this session (see Recommendation).

Two issues already carry security severities and have sat unreviewed for
over 5 weeks: **PR #29** (CRITICAL `protobufjs` RCE, CVE-2026-41242, open
since 2026-09-16 — 39 days) and **PR #51** (`@grpc/grpc-js` auth-bypass,
GHSA-m9gg-hp2v-232j, open since 2026-10-01 — 24 days). Both are
evidence-clean, zero-regression, human-review-only draft PRs.

Learning signals applied: **0 of the last 37 dream-cycle PRs merged** →
bias to a tiny, one-conceptual-change, easily-reviewable candidate.
Tonight's candidate: 1 production file, +32/-2 lines, well under the
`<300` target.

## Load Accumulated Evidence (STEP 2)

Read `docs/adr/ADR-0001-ruclip-control-plane.md`, `docs/PLAN.md`, and all
20 open dream-cycle issues (#8–#95) before researching, to avoid
rediscovering an already-filed finding. Excluded from tonight's search as
already-filed/fixed-on-branch: the `wouldCreateCycle`/k-hop/graph-query
family (#13,#22,#26,#36,#48,#56,#67,#77), `applyApprovalTransition(reject)`
ordering (#87/PR#88), `ActorCredential` TTL ceiling (#89/PR#90),
`recomputeInteractionSignals` full-company sort (#93/PR#94), the
`ADR-076` dangling citation (#95/PR#96), every god-module-extraction
proposal (#8,#16,#30,#60,#81), and all previously-filed dependency/perf
findings.

## Deep Dive: Correctness (STEP 3)

**5 candidate findings proposed, scored 1–5 on
fit/novelty/testability/measurability/production-value/reviewability:**

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod-value | Reviewability | Total |
|---|---|---|---|---|---|---|---|---|
| 1 | **`identity-map.ts` case-sensitive email lookup (winner)** | 5 | 5 | 5 | 5 | 4 | 5 | **29** |
| 2 | `assertValidIssue`'s `cancelled`-branch dead clause | 3 | 2 | 5 | 4 | 1 | 4 | 19 |
| 3 | `bridge-auth.ts` JWT-margin cache defeat under short-lived tokens | 3 | 3 | 3 | 3 | 2 | 4 | 18 |
| 4 | `google-token.ts` public-key cache lifetime depends on verifier reuse | 2 | 2 | 3 | 3 | 1 | 3 | 14 |
| 5 | `propose-budget-mutation.ts` level-history race | — | — | — | — | — | — | already fixed on `main` (prior security night) |

Candidates #2 and #4 were investigated and found **not to be bugs**: #2's
stray `||` is cosmetic — an existing test
(`assertValidIssue allows cancelled status with an unapproved positive
budgetImpact`) already confirms the behavior is spec-compliant per
`DOMAIN-MODEL.md` §1.4. #4's cache is in fact live — `server.ts:28`
constructs one `verifier` at module scope, so the cache persists across
requests as designed. #3 is real but low-impact (GCE/Cloud Run identity
tokens live ~1h, far above the 10-minute refresh margin) — reported below
as a scan finding, not implemented.

**Winner: #1.** Highest score by a wide margin, genuinely novel (zero
prior dream-cycle issue mentions `identity-map`/email/case matching),
cheap to test (no mocks, no bridge dependency), and has real production
consequence: a silent, hard-to-diagnose lockout of a legitimate human
identity.

### Frozen Hypothesis (STEP 3.3, before implementation)

> Given `ruclip-attester`'s identity-mapping secret (Google email →
> `{orgMemberId, companyId}`) and the verified `email` claim
> `handleAttestRequest` passes to `lookupIdentity`, when both the secret's
> keys and the lookup input are normalized with the same
> `trim().toLowerCase()` before matching — instead of today's exact
> raw-string match — then a legitimately-mapped employee whose verified
> claim's email differs only in case from however the secret was typed
> should resolve successfully instead of getting the generic 403 lockout,
> subject to: zero change to the existing exact-case-match test's outcome,
> a new fail-closed rejection when two secret entries collide once
> case-normalized, and 0 regressions in the full suite.

Not modified after evaluation began.

### Candidate

- `services/ruclip-attester/src/identity-map.ts` (+32/-2): new
  `normalizeEmail()` (`trim().toLowerCase()`); `parseIdentityMap` now
  builds its map keyed by normalized email and throws on a post-
  normalization collision; `lookupIdentity` normalizes its input the same
  way before indexing.
- `services/ruclip-attester/tests/identity-map.test.ts` (+26): 4 new
  tests — case-insensitive match (lookup-side differs), case-insensitive
  match (secret-side differs), whitespace trim, collision-detection throw.

No existing test, assertion, or threshold modified.

### Evaluation Receipt (STEP 5–9)

Evaluator: real `npm test` (`tsc -p tsconfig.json && node
scripts/run-tests.mjs dist`), independently re-run by the orchestrating
session (not inferred from the implementing subagent's logs):

| | Tests | Pass | Fail |
|---|---|---|---|
| Baseline (`6e73a8f`, new tests present, production fix reverted via `git stash` on the one source file) | 331 | 327 | **4** |
| Candidate (this diff) | 331 | **331** | 0 |

Baseline's 4 failures are exactly the 4 new tests, each failing for the
precise predicted reason (`null` instead of the mapped entry for the two
case-mismatch tests; "Missing expected rejection" for the collision test).
Candidate: 0 regressions. `npm run build` and `npm run lint` both clean.
`npm run harness:bench-verify` → `Suite repo-native@0.1.0: 6 tasks, hash OK
(840fd8d2d698…)` — unchanged.

### Baseline

Parent commit `6e73a8f060bcbb69965a50ffe4627e33622d4094` (`main` tip),
327/327 on the real suite before this candidate's own test additions.

### Darwin Lineage

Not run — this is a binary correctness fact (two strings match after
normalization, or they don't), not a continuous fitness landscape with a
tunable search space. Same judgment call as prior nights' analogous
binary-fact fixes (#88, #90, #96).

### Evidence

OBSERVATION (`lookupIdentity` does `map[email] ?? null`, exact-match only)
→ OBSERVATION (Google account email matching is case-insensitive; the
mapping secret is hand-typed JSON, so its casing is not guaranteed to
match a verified claim's casing) → MEASUREMENT (baseline: 327/331, 4
predicted failures, independently reproduced) → INFERENCE (false-negative
lockout is a real, silent failure mode — it looks identical to "no
mapping exists" from the caller's side) → DECISION (normalize both sides;
fail closed on post-normalization collision rather than picking one
entry) → MEASUREMENT (candidate: 331/331, 0 regressions, bench-verify hash
unchanged, independently reproduced).

### Reward-Hack Check (STEP 10)

Independent critique (both the implementing subagent's self-critique and
this orchestrating session's own re-verification): no existing test
weakened, removed, skipped, or reassigned; no threshold touched;
`.harness/bench.json` untouched, hash byte-identical baseline vs.
candidate; no cherry-picking (the pre-existing exact-match test still
passes unmodified); no hidden cost (one `.toLowerCase()`/`.trim()` per
lookup, O(1), no new I/O); no undocumented cache (the existing 60s TTL
cache is untouched, only its key space changed). The collision-detection
branch is a genuine new fail-closed behavior, disclosed explicitly rather
than smoothed over. **Verdict: CLEAR.**

### Security Review (STEP 15)

No new capability, credential, network, or filesystem surface — pure
in-process string normalization ahead of an existing object-key lookup.
Fails closed on ambiguity (a case-collision) rather than silently
resolving to one entry. Does not change what `/v1/attest` reveals to a
caller (still one generic rejection message either way). No
prompt-injection surface (no LLM call in this file or its callers).

## Scan: Performance + Tests (SLOT 0's SCAN surface)

- **Performance**: `services/ruclip-attester/src/bridge-auth.ts`'s
  `decodeJwtExpiryMs` sets `expiresAtMs = exp - TOKEN_REFRESH_MARGIN_MS`
  (10 min). For any identity token with less than 10 minutes of remaining
  lifetime, the cache is immediately a no-op — every bridge call pays a
  live metadata-server round trip. Not exploitable today (GCE/Cloud Run
  identity tokens live ~1h, far above the margin), but worth a
  `Math.max(exp - margin, now + minTtl)` guard if token-lifetime policy
  ever tightens. Not implemented tonight (scan-only, no production
  impact today).
- **Tests**: `google-token.test.ts`/`signing-key.test.ts` cover the
  happy-path cache but have no regression test for the margin-exhaustion
  edge above. No test added tonight (out of scope for a scan finding).

## Competitors

| Project | Model | Evidence grade |
|---|---|---|
| **paperclipai/paperclip** | Node/React control plane: org-chart, ticket-based goals, scheduled heartbeats, per-agent budgets, approval gates — nearly the same domain model ruClip implements | B (cross-checked across 3 independent secondary sources: a Railway deploy listing, jimmysong.io's AI landscape page, and a Betterstack multi-agent guide — the `paperclipai/paperclip` README itself was not fetched directly this session) |
| ruClip's point of difference | paperclip ships its own multi-runtime agent adapters (Claude Code, Codex, Cursor, Gemini, OpenCode, bash, webhook); ruClip has none shipped yet — narrower, more strictly schema-validated, no shipped agent-runtime integration layer | B (same sources) |
| `ruvnet/autogenous` `packages/radio-moe` (AgentRadio) | ruvnet's own real, ed25519-signed, already-running cross-provider mesh (Claude/Codex/OpenRouter/Gemini) — named in `docs/PLAN.md` §2/§3 item 4 as ruClip's answer to paperclip's multi-runtime adapters | A (this repo's own confirmed, previously-verified building block — not re-verified tonight, carried forward from ADR-0001) |
| `ruvnet/dream-machine` | The engine actually running this cycle — config-driven, never-merge, draft-PR-only — matches this routine's own observed behavior exactly | A (directly observed: this session's own ledger/issue/PR trail) |

No new benchmark data was fabricated; all quantitative claims above carry
their evidence grade.

## Bonus: Roadmap Review (`DAYINT % 25 == 0`)

This is the **first time this bonus has ever actually fired**: the
schedule says it was also due on 2026-09-25 (`20260925 % 25 == 0`), but
there is no `dream/2026-09-25-*` branch — the remote branch list jumps
`dream/2026-09-22-performance` → `dream/2026-09-27-performance`, a 4-night
gap (09-23 through 09-26) where the routine did not run at all. That gap
is itself a small roadmap-health signal (an unexplained scheduler outage,
separate from the already-diagnosed merge-backlog problem) — flagged here
once, not escalated further; outside this session's authority to
investigate (no scheduler logs available from inside the repo checkout).

**Against `docs/PLAN.md`'s own roadmap**: Phase 1 (control-plane core) and
Phase 3 (build-time genome) are marked shipped; `docs/adr/ADR-0001` names
`ruvnet/dream-machine` as *this exact nightly cycle* — "generalized
engine... governs the CODEBASE only" — i.e., this routine's own evidence
flywheel is not incidental tooling, it **is** the mechanism `docs/PLAN.md`
names for evolving ruClip's codebase over time. Judged purely as a
research/evidence engine, it is working as designed: 42 issues, 41 PRs,
each with frozen hypotheses, real baseline/candidate receipts, independent
critique, and witness stamps — a genuinely strong evidence trail, confirmed
firsthand tonight by independently re-running tonight's own baseline and
candidate rather than trusting the implementing subagent's report.

**The roadmap's actual blocking risk is not technical.** With 0% of the
last 37 PRs merged, the flywheel `docs/PLAN.md`/ADR-0001 depend on for
codebase evolution produces evidence but delivers zero actual code change
to `main`. Two of the stalled PRs are security fixes for a CVSS-9.8 RCE
(#29, 39 days) and a real auth-bypass advisory (#51, 24 days) reachable
from this repo's own direct dependencies — not from an unreachable
transitive tree, as most other dependency findings here are. A roadmap
that is otherwise on track for its stated phases is, in practice, shipping
nothing, and carrying two live, unpatched security advisories in `main`
while equally-stale fixes sit reviewed-and-ready one PR away.

**Recommendation** (repeated from the direct notification already sent
this session, consolidated here as the roadmap item it actually is):
1. Merge or explicitly close PR #29 and PR #51 first — both are
   zero-risk, zero-regression, security-labeled, and have sat the longest.
2. Run one human triage pass over the remaining ~38 open `dream/*` PRs,
   using #91/PR#92's committed backlog snapshot
   (`docs/dream-cycle/pr-backlog-snapshot-2026-10-22.json`) as the
   starting inventory rather than re-deriving it.
3. Decide, as a policy question outside this session's authority: should
   the nightly cycle keep producing new draft PRs at its current rate
   while the backlog is this deep, or should a future night's slot be
   spent exclusively on backlog triage instead of new findings? This
   session followed its instructions and produced one more PR tonight,
   consistent with "never optimize for producing a PR" (the finding above
   is genuine and new) — but the roadmap-level answer to this question is
   the human operator's call, not this routine's.

## Witness (STEP 16)

```
REPORT_HASH    = 4c9c0d6002477420002a50bacc46084b77e707a1a5046374dec1b59e43b3eda1
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 879f586b22fd2618c17767456dcb0c80649fda73bec2bcaa8276c16f70b8e0be
```

Verifier procedure (reproducible by anyone):
1. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094` (or confirm it is `main`'s tip at the time this report was written).
2. Fetch this exact report file content (as committed at `docs/dream-cycle/2026-10-25-correctness-report.md`).
3. `sha256sum <that file>` → must equal `REPORT_HASH` above.
4. `printf '%s%s' "<REPORT_HASH>" "<SESSION_COMMIT>" | sha256sum` → must equal `WITNESS` above.
5. Independently re-run `npm test` at the parent commit with `services/ruclip-attester/src/identity-map.ts` reverted (production fix only) to reproduce the baseline 327/331 (4 predicted failures), then restore it to reproduce the candidate 331/331 — matching the Evaluation Receipt section above.

## Next Steps

1. Human triage pass on the 39 open dream-cycle PRs (security-labeled
   first: #29, #51), per the roadmap-review recommendation above.
2. If the margin-exhaustion cache defeat in `bridge-auth.ts` (scan
   finding) ever becomes exploitable (token-lifetime policy change), add
   the `Math.max` guard and a regression test.
3. A future correctness night should extend `identity-map.ts`'s
   collision-detection pattern (fail closed on ambiguity, not silent
   pick-one) as a general review lens across the repo's other
   hand-typed-secret-keyed lookups, if any are found.
