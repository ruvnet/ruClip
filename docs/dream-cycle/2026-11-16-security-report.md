# Dependency Security SOTA Report — 2026

**Repo**: ruvnet/ruClip · **Date**: 2026-11-16 · **Deep**: security · **Scan**: dependencies, secrets · **Slot**: 1

## TL;DR

Tonight's `npm audit` on a fresh `main` checkout (`6e73a8f0`) reproduces the
**exact same CRITICAL** (`proxy-addr <2.0.8`, GHSA-jqcg-44mw-7w3h, CVSS 9.1)
that dream-cycle night 2026-10-26 ACCEPTed with a clean, lockfile-only fix
21 days ago in **PR #100** — still open, unreviewed, unmerged. It also
reproduces a **HIGH** (`@grpc/grpc-js <1.14.5`, GHSA-m9gg-hp2v-232j, CVSS 7.4)
ACCEPTed 46 days ago in **PR #51** (2026-10-01) — also still open, unreviewed,
unmerged. Both are genuinely live on `main` right now: `npm ci` today resolves
`proxy-addr@2.0.7` and `@grpc/grpc-js@1.14.4`, and the latter is reachable
from ruClip's own production code, not just a sidecar tree (see Deep Dive).

Writing a **third** independent fix PR for either finding would be reward
hacking by volume, not by test-weakening — PR #133 (2026-11-11) was already
REJECTED by this same routine for being a near-duplicate of #100/#113, and
the backlog itself (64 open `dream/*` branches, 60 open dream-cycle PRs, 0%
merge rate since 2026-09-07 — flagged by #92, #118, #128, #134, #139) is the
dominant problem, not a shortage of fixes. Tonight's candidate is instead a
**consolidation**: one tiny PR that (a) bumps both `proxy-addr` and
`@grpc/grpc-js` lockfile-only, (b) adds one new regression-floor test
covering both, and (c) explicitly recommends closing #51 and #100 as
superseded — netting the backlog down by two PRs instead of up by one, while
actually closing both live vulnerabilities today.

Also scanned (secrets): fresh grep across `src/`, `services/` for hardcoded
API keys/tokens/passwords/private-key blocks outside tests/fixtures — **no
new finding**, consistent with every prior night's clean secrets result
(2026-09-06, 2026-10-26).

## What's new

- Independently re-confirmed, from a fresh `npm ci` today, that both
  findings are still exactly reproducible on `main` at `6e73a8f0` — this is
  new evidence (continued, measured staleness) that justifies re-surfacing
  an already-ACCEPTed direction per Step 2's "unless new evidence justifies
  reopening it."
- New: traced `@grpc/grpc-js`'s reachability precisely.
  `services/ruclip-attester/src/signing-key.ts` imports
  `@google-cloud/secret-manager` (`^7.0.0`), whose own dependency chain pulls
  in `@grpc/grpc-js@1.14.4` to make the real gRPC calls that fetch the
  signing key from Secret Manager — the vulnerable transport-auth code
  (`getAuthContext` can return an unauthorized peer cert as authorized)
  executes on a real, security-critical path, not an inert sidecar. Neither
  #51's original report nor #100's (which only flagged `@grpc/grpc-js` as
  "the single highest-priority item... from a pure risk standpoint" without
  citing the exact import) traced this file-level path explicitly.
- `npm audit`'s total finding count grew from 39 (2026-09-06) → 52
  (2026-10-26) → 53 (tonight, pre-fix) as the installed tree has drifted;
  this is an upstream-churn signal, not a regression caused by any
  dream-cycle PR.

## Competitors (how other agent-company / control-plane projects handle this class of finding)

| Project | Approach to transitive dep CVEs | Grade |
|---|---|---|
| `paperclipai/paperclip` | No committed dependency-audit automation found in public repo; relies on Dependabot default alerts | C (no reproducible process to compare against) |
| Renovate / Dependabot (industry default) | Auto-PRs per vulnerable package, batched, auto-mergeable with required checks | A (official docs) — the capability this repo is missing isn't *finding* fixes (dream-cycle already does that nightly) but *merging* them; Dependabot's auto-merge-on-green is the direct remedy for the 0%-merge-rate problem |
| OSV-Scanner (Google) | Reachability-aware, call-graph-based scanning | A (official project) — more rigorous than this repo's manual-grep reachability tracing (used above for `@grpc/grpc-js`) |
| `npm audit` (used here) | Advisory-DB match on resolved tree, no reachability | A (official tool) — baseline for all of the above |

## Hypothesis (frozen before implementation)

> Given ruClip's full `npm ci && npm run build && npm test` pipeline as the
> workload, when `proxy-addr` is updated from the currently-resolved
> `2.0.7` to `2.0.8` and `@grpc/grpc-js` from `1.14.4` to `1.14.7` (both
> lockfile-only — `express`'s own declared `^2.0.7` range already permits
> `2.0.8`, and `google-gax`'s `^1.12.6` / the OTLP-gRPC exporters' `^1.14.3`
> already permit `1.14.7`; no `package.json` change in either case) — then
> `npm audit`'s CRITICAL-severity count should drop 1→0 and the
> `GHSA-m9gg-hp2v-232j` HIGH finding should clear, subject to: `tsc --strict`
> stays clean, the full test suite stays green with zero regressions, and
> `harness:bench-verify`'s corpus hash is unchanged.

Frozen before evaluation began; not modified after.

## Evaluation Receipt

Evaluator: real `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), this repo's only entrypoint. No LLM calls needed (`LLM_EVAL=not_needed`).

| | Baseline (`6e73a8f0`, versions unfixed, new test present) | Candidate (lockfile bump applied) |
|---|---|---|
| Tests | 329 | 329 |
| Pass | 327 | **329** |
| Fail | 2 (exactly the 2 new regression-floor assertions, predicted) | **0** |
| `npm audit` critical | 1 | **0** |
| `npm audit` high | 25 | **24** |
| `npm audit` total | 53 | 51 |
| `tsc -p tsconfig.json` | clean | clean |
| `harness:bench-verify` | `840fd8d2d698…` | `840fd8d2d698…` (unchanged) |
| `package.json` diff | — | none |
| `package-lock.json` diff | — | 2 package entries (`proxy-addr`, `@grpc/grpc-js`: version/resolved/integrity only) |

Re-verified twice (baseline measured, candidate applied and measured, then
baseline re-measured again after fixing a scoped-package (`@scope/name`)
bug in the new test's own `node_modules` walk, caught during self-review —
see Reward-Hack Check) — same 329/327/2 → 329/329/0 result both times.

## Darwin Results

Not run. Both are binary version floors (the GHSAs' own published fixed
versions, already permitted by the real dependents' declared ranges), not a
continuous parameter to search over — same judgment call as #29, #51, #90,
#100, and the 2026-09-06 security night.

## Evidence

- OBSERVATION: `npm audit --json` on fresh `main` reports 53 findings, 1
  critical (`proxy-addr`), 25 high (incl. `@grpc/grpc-js`).
- MEASUREMENT: baseline `npm test` = 329/327/2 (new test present, code
  unfixed); candidate `npm test` = 329/329/0.
- MEASUREMENT: `harness:bench-verify` hash `840fd8d2d698…` identical before
  and after.
- INFERENCE: `@grpc/grpc-js`'s vulnerable code path is reachable from
  `services/ruclip-attester/src/signing-key.ts` via
  `@google-cloud/secret-manager`'s own dependency tree (confirmed by
  grep + `node_modules` tree inspection, not by executing a real Secret
  Manager call in this session).
- DECISION: candidate = consolidated lockfile bump + regression test,
  rather than a third independent fix PR.
- REJECTION (implicit): a from-scratch independent re-fix of either
  finding, rejected as reward-hacking-by-volume given #133's precedent.

## Reward-Hack Check (independent critic pass)

Checked: did the candidate weaken the benchmark? No — 0 existing tests
touched, only 1 new test file added. Alter gold answers? No. Cherry-pick?
No — both installed, broken copies checked, not a curated subset. Exploit
the evaluator? No — real `npm test`, real `npm audit`, no mocked network
calls. Hide cost? No — lockfile diff shown in full above. Touch a
threshold? No. Rely on an undocumented cache? No — `npm ci` was run fresh
at the start of this session. One genuine bug was caught and fixed during
self-review: the new test's `node_modules` walker initially failed to find
`@grpc/grpc-js` at all (scoped-package path-joining bug), which would have
made that half of the test vacuously un-runnable rather than failing
correctly — fixed before finalizing, both failure and pass states verified
afterward.

## Security Review

This finding is itself about unsafe autonomous accumulation: 60 open,
unreviewed `dream-cycle` PRs (per GitHub, state as of tonight) is a
supply-chain and process-security exposure in its own right — an autonomous
agent with repo write access has been producing unreviewed change surface
for 71 days (2026-09-07 → 2026-11-16) with no human gate ever closing the
loop. No prompt-injection, credential-exposure, or cross-agent-poisoning
vector was found in tonight's own tool use (MCP calls used were
read/list/get only until the final branch+push+PR; no secret or credential
value was ever read, printed, or transmitted). The `@grpc/grpc-js` finding
itself (`getAuthContext` returning an unauthorized cert as authorized) is a
real agent/service authentication-boundary weakness — exactly the class of
cross-trust-boundary risk Step 15 asks to review for, and it sits on this
repo's own attester signing-key path.

## Scan Findings

**Dependencies**: see TL;DR / Evaluation Receipt above — 1 critical + 1
high finding reproduced and fixed, both already-ACCEPTed directions with a
net backlog reduction (2 stale PRs → 1 fresh, recommended-for-closure pair).

**Secrets**: fresh grep for hardcoded API keys / tokens / passwords /
private-key PEM blocks across `src/` and `services/` (excluding
`node_modules`), outside test/fixture files — zero matches. `git ls-files`
shows no tracked `.env*` file. Consistent with every prior secrets scan on
this repo (2026-09-06, 2026-10-26): clean.

## Gist

This file (published as a GitHub gist if `gh` is authenticated this
session; see Witness section and final report for the actual URL or
`LOCAL` fallback status).

## Witness

```
REPORT_HASH    = b1e4fd92ace5148a9270d34604801a406c80b278f0c8cec14680a96e5e7d5954
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 22d06933b77f42239bad34f35fec7ed116947c922671914ccf856dbf398e1e5c
```

`REPORT_HASH` is the sha256 of this file's content up to (and including) the
line directly above this Witness section — i.e. everything before `## Witness`
itself — computed once, before this section was filled in. `WITNESS =
sha256(REPORT_HASH || SESSION_COMMIT)`.

Verifier procedure (reproducible by anyone):
1. Fetch this report's exact committed text (`docs/dream-cycle/2026-11-16-security-report.md`) up to the `## Witness` heading.
2. `sha256sum` that prefix → must equal `REPORT_HASH` above.
3. Confirm `SESSION_COMMIT` is an ancestor of (or equal to) the PR's base.
4. `printf '%s%s' REPORT_HASH SESSION_COMMIT | sha256sum` → must equal `WITNESS` above.
5. Independently re-run `npm test` against the PR branch's HEAD and confirm 329/329 (0 fail) — the receipt this report claims.

## Recommendation

1. **Merge tonight's PR, then close #51 and #100 as superseded.** Net
   effect: backlog −2, two live vulnerabilities (1 critical, 1 high) closed
   on `main`, zero production-code risk (lockfile-only, 0 regressions,
   bench hash unchanged).
2. **The 0%-merge-rate problem is the real finding, not any one CVE.**
   Five separate nights (#92, #118, #128, #134, and tonight) have now
   independently surfaced the same root cause: an autonomous nightly agent
   generating reviewable work with no human reviewing loop closing it.
   Tonight adds data (71 days, 60 PRs, 2 live CVEs with clean fixes sitting
   unmerged for 21–46 days) but this needs a human policy decision
   (dedicated review time, Dependabot-style auto-merge-on-green for the
   narrowest/safest class of these PRs, or pausing the routine), not
   another dream-cycle tool.
3. **Re-verify `@grpc/grpc-js` reachability with a real Secret Manager call**
   in an environment with live GCP credentials — tonight's reachability
   claim is based on static import-graph tracing (grep + `node_modules`
   inspection), not an executed call through the vulnerable
   `getAuthContext` path; an environment with real credentials could
   confirm the exact gRPC auth flow actually exercised.
