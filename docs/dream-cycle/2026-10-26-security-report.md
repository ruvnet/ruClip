# Dependency Security SOTA Report — 2026

**Repo**: ruvnet/ruClip · **Date**: 2026-10-26 · **Deep**: security · **Scan**: dependencies, secrets · **Slot**: 1

## TL;DR

`npm audit` on a fresh `main` checkout (`6e73a8f0`) reports 52 findings, **2 CRITICAL**. One of the two — `proxy-addr <2.0.8` (GHSA-jqcg-44mw-7w3h, CVSS 9.1, IPv4-mapped-IPv6 trust-subnet IP spoofing) — had not been raised by any of the 41 prior `dream-cycle` nights. Fixed with a lockfile-only `npm update proxy-addr` (no `package.json`/`overrides` change needed — `express`'s own `^2.0.7` range already permits `2.0.8`), the same minimal-diff pattern used for the `@grpc/grpc-js` finding (#50/#51). A dependency-free regression test walks the real installed tree (handling `@scope` packages correctly, not just top-level hoisting) and fails loudly if a future reinstall re-resolves to a vulnerable copy. 0 regressions, critical count 2→1, `npm audit` now at 51/52 findings.

The second CRITICAL (`protobufjs`, CVE-2026-41242) already has a clean, unmerged fix (#29, 2026-09-16) — not re-done here, per Step 1's "don't rediscover a direction already covered without new evidence."

Also scanned (secrets, no new finding): hardcoded PEM fixtures in `tests/support/actor-credential-fixture.ts` are throwaway Ed25519 test keypairs, not real secrets; the one CLI path that intentionally prints a live `ActorCredential` to stdout (`src/cli/ruclip.ts`) is already deliberately reviewed and warned (comment cites "security review round 10").

## What's new

- `npm`'s advisory database added GHSA-jqcg-44mw-7w3h to `proxy-addr` after this repo's last several dependency scans (#29 2026-09-16, #51 2026-10-01, #80 2026-10-16) — none of which mention `proxy-addr`. This is the first night to catch it.
- The fix needs **zero** `package.json` edit: `express@5.2.1`'s own declared range (`^2.0.7`) already admits the patched `2.0.8`; a plain `npm update proxy-addr` resolves it. No `overrides` entry, no new dependency.

## Competitors (how other agent-company / control-plane projects handle this class of finding)

| Project | Approach to transitive dep CVEs | Grade |
|---|---|---|
| `paperclipai/paperclip` | No committed dependency-audit automation found in public repo; relies on Dependabot default alerts | C (no reproducible process to compare against) |
| Renovate / Dependabot (industry default) | Auto-PRs per vulnerable package, often batched; no reachability analysis | A (official docs) — but doesn't distinguish reachable vs. sidecar-only exposure the way this repo's nights do |
| OSV-Scanner (Google) | Reachability-aware scanning via call-graph analysis (research-grade) | A (official project) — more rigorous than this repo's manual grep-based reachability check, a legitimate next step |
| `npm audit` (used here) | Advisory-DB match on resolved tree, no reachability | A (official tool) — this repo supplements it with manual reachability grep each night, same discipline as #29/#51/#80 |

## Hypothesis (frozen before implementation)

> Given ruClip's full `npm ci && npm run build && npm test` pipeline as the workload, when `proxy-addr` is updated from the currently-resolved `2.0.7` to `2.0.8` (within `express@5.2.1`'s own already-declared `^2.0.7` range — no `package.json` change), then `npm audit`'s CRITICAL-severity finding count should drop from 2 to 1, subject to: `@claude-flow/cli` stays pinned at exactly `3.38.20`, `tsc --strict` stays clean, `harness:bench-verify`'s corpus hash is unchanged, and the full test suite stays green with zero regressions.

Frozen before evaluation began; not modified after.

## Benchmarks / Evaluation Receipt

Evaluator: real `npm test` (`tsc -p tsconfig.json && node scripts/run-tests.mjs dist`), this repo's only entrypoint. No LLM calls (`LLM_EVAL=not_needed` — this candidate needed no model-calling evaluation stage).

| | Baseline (`6e73a8f0`, `proxy-addr@2.0.7`, new test present) | Candidate (`proxy-addr@2.0.8`) |
|---|---|---|
| Tests | 328 | 328 |
| Pass | 327 | **328** |
| Fail | 1 (exactly the new regression test, predicted reason) | **0** |
| `npm audit` critical | 2 | **1** |
| `npm audit` total | 52 | 51 |
| `@claude-flow/cli` | `3.38.20` | `3.38.20` (unchanged) |
| `tsc -p tsconfig.json` | clean | clean |
| `harness:bench-verify` | `840fd8d2d698…` | `840fd8d2d698…` (unchanged) |
| `package.json` diff | — | none |
| `package-lock.json` diff | — | 1 package entry (`proxy-addr` version/resolved/integrity + its `funding` block) |

Re-verified independently twice: baseline measured, candidate applied and measured, then baseline re-measured a second time after fixing a bug found in the regression test's own `@scope`-directory walk (see Reward-Hack Check) — same 328/327/1 result both times.

## Darwin Results

Not run. This is a binary version-floor fact (GHSA's own published fixed version, already permitted by `express`'s declared range), not a continuous parameter to search over — same judgment call as #29, #51, #90, and the 2026-09-06 security night.

## Witness

```
REPORT_HASH    = 395607a6b4337b0046d2e11a439634c053e971ad70f9c0da3cb0eb8406935cb9
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = fa3cca15cb14686972be478c56191043b54ca7f980173b7aedbb32b93ab7895d
```

**Verifier procedure** (reproducible by anyone):
1. `git checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 -- package.json package-lock.json` then `npm ci` → confirm `npm audit --json` reports 2 critical findings including `proxy-addr`.
2. Check out this PR's branch; `npm ci && npm run build && node scripts/run-tests.mjs dist` → confirm 328/328, 0 failures.
3. `npm audit --json` on the PR branch → confirm 1 critical finding (`protobufjs`, tracked separately in #29), `proxy-addr` absent.
4. `npm run harness:bench-verify` → confirm hash `840fd8d2d698…` unchanged from baseline.
5. `sha256sum` this gist file, concatenate with `SESSION_COMMIT`, `sha256sum` again → must equal `WITNESS` above.

## 3 concrete next steps

1. **Merge-review backlog, not another meta-tool.** 41+ `dream-cycle` PRs are open/unmerged (0% merge rate across the last 37); three are independently clean security ACCEPTs (#29 critical `protobufjs`, #51 `@grpc/grpc-js`, #90 `ActorCredential` TTL ceiling) plus tonight's #<TBD> (`proxy-addr`). Outside this session's authority — flagged, not acted on, per PR #92's own "explicitly not done: a 6th duplicate/backlog-detection tool."
2. **Reachability-aware scanning.** This night's and prior nights' reachability checks are manual greps. OSV-Scanner's call-graph-based reachability analysis (see Competitors) would make the "unreachable sidecar tree" classification (true for `protobufjs`, `proxy-addr`, and most of the remaining 25 high/25 moderate findings) automatic and auditable instead of re-derived by hand each night.
3. **`@grpc/grpc-js` reachability is real and still open.** Unlike `protobufjs`/`proxy-addr`, #51's `@grpc/grpc-js` finding sits on a path `ruClip`'s own `@google-cloud/secret-manager` dependency actually uses (`services/ruclip-attester/src/signing-key.ts`). Its fix (#51) has been open since 2026-10-01 with no regressions — the single highest-priority item in the backlog from a pure risk standpoint.
