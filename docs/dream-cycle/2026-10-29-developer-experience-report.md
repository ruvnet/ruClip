# Developer-Experience SOTA Report — 2026

## TL;DR
ruClip's `npm run lint` has been a hardcoded no-op (`echo "no lint config yet —
scaffold stage" && exit 0`) since the repo's first commit — it always exits 0
regardless of code content. Tonight's candidate wires a real
`typescript-eslint` flat-config gate into that same script, advisory-only in
CI (`continue-on-error`, mirroring the existing `harness:advisory` pattern).
First run against the unmodified 68-file TS tree surfaced **7 real errors + 1
warning across 6 files** — a true positive count the structurally-0 baseline
could never produce. Zero runtime source files were changed; `npm test`
stays at 327/327 before and after.

## What's new
- `eslint.config.js`: flat config, `@eslint/js` recommended + `typescript-eslint`
  `recommended` (not `strict`/`stylistic`, to keep the first-pass finding
  count small and reviewable), Node globals via the `globals` package (fixes
  5 `no-undef` false positives from `js.configs.recommended` not knowing
  `process`/`console` exist in a Node-only repo).
- `package.json` `lint` script: `echo ... && exit 0` → `eslint .`.
- `.github/workflows/ci.yml`: new advisory lint step (`continue-on-error:
  true`), placed after the existing hard `npm test` gate and before the
  existing `harness:advisory` block.
- Exact-pinned new devDependencies: `eslint@10.13.0`, `typescript-eslint@8.72.1`,
  `@eslint/js@10.0.1`, `globals@17.13.0` (current npm-registry latest for all
  four, confirmed via `npm view <pkg> version` this session — grade A).

## Competitors / tooling landscape (≥4 rows, each graded)
| Option | Approach | Speed/maturity claim | Fit for ruClip tonight | Grade |
|---|---|---|---|---|
| **ESLint 10 + typescript-eslint 8.72.1** (chosen) | AST-based, mature plugin ecosystem, flat config | n/a (baseline) | Zero existing lint debt to migrate, matches `tsconfig.json`'s existing `strict`+`noUncheckedIndexedAccess`, official `typescript-eslint.io` getting-started path followed verbatim | A — official docs (typescript-eslint.io) + npm registry versions read directly this session |
| Biome 2.6 | Rust, combined linter+formatter, ~670 rules drawn from ESLint/typescript-eslint | "~35x faster than Prettier" (formatter-only benchmark; no linter-vs-ESLint number published) | Would also solve formatting (ruClip has no Prettier either), but typescript-eslint rule parity/plugin ecosystem is less mature; bigger first step than tonight's bounded candidate | B — vendor's own site, benchmark methodology stated but not independently reproduced this session |
| oxlint (oxc) | Rust, ESLint-rule-compatible subset | Vendor-marketed 50-100x speedup over ESLint | Fast, but narrower rule coverage and this repo's custom MCP-boundary patterns (`any` at bridge calls, etc.) are exactly the long-tail rules oxlint doesn't yet replicate | C — not independently verified this session; single-source vendor marketing, informs only, not actioned on |
| **paperclipai/paperclip** (the upstream OSS project ruClip is modeled on, per ADR-0001) | `pnpm typecheck` (raw `tsc`) + Vitest only — **no lint or format tooling visible in its own README** | n/a | Confirms tonight's gap wasn't "catching up to paperclip" — paperclip itself ships no lint gate either. ruClip choosing real lint tooling is doing *more* dev-tooling discipline than its own namesake reference project, not less | B — direct read of the live `paperclipai/paperclip` GitHub repo this session (README's Development section) |

## Frozen hypothesis (before implementation)
> Given ruClip's existing TypeScript tree (68 `.ts` files under `src/`,
> `services/`, `tests/`) and its current `npm run lint` entrypoint — a
> hardcoded stub that always exits 0 regardless of code content — when a
> `typescript-eslint` flat-config lint gate is wired into that same script
> and run read-only (no autofix, no source edits) against the unmodified
> tree, then the gate should surface a nonzero count of real findings that
> the always-0 baseline structurally cannot detect, while `npm test` stays
> at 327/327 and zero runtime source files change, subject to: the gate
> ships advisory-only (`continue-on-error`) until a human triages the first
> finding count, and the candidate never modifies a test or gold file.

## Benchmarks / Evaluation (real, reproduced this session — no model calls)
| Metric | Baseline (stub) | Candidate (`eslint .`) |
|---|---|---|
| Lint findings | 0 (always, by construction — stub never reads the tree) | 7 errors + 1 warning, 6 files |
| `npm test` | 327/327 | 327/327 (unchanged) |
| `npm run build` | clean | clean (unchanged) |
| `.harness/bench.json` hash (`harness:bench-verify`) | `840fd8d2d698…` | `840fd8d2d698…` (unchanged) |
| `harness mcp-scan` | `worst: info`, no MCP surface | `worst: info`, no MCP surface (unchanged) |
| Runtime src/test files touched | — | 0 |

Real findings surfaced (evidence class: MEASUREMENT, raw receipt committed
under `docs/dream-cycle/`):
1. `services/ruclip-attester/src/signing-key.ts:118` — `preserve-caught-error`:
   a rethrow drops the original `cause` in the signing-key loader —
   forensic/audit-trail gap in a security-sensitive path. **Flagged for a
   future security-slot night, not fixed tonight** (out of this candidate's
   bounded scope).
2. `src/control-plane/authorization/human-identity-attestation.ts:52` —
   `actorCredentialFrame` assigned, never used.
3. `src/control-plane/governance/propose-budget-mutation.ts:151` —
   `newThreshold` parameter defined, never used. **Possible real correctness
   bug** (a budget-mutation parameter that silently has no effect) —
   flagged for a future correctness-slot night.
4. `src/control-plane/store/agentdb-adapter.test.ts:50,65,82` — `_h` defined,
   never used ×3 — likely an intentional underscore-prefix convention that
   the default `no-unused-vars` doesn't recognize (config-tuning item, not a
   bug).
5. `tests/control-plane/actor-credential-nonce-durable-backend.test.ts:46` —
   stale `eslint-disable` comment for a rule that reports nothing — itself
   evidence this codebase anticipated a lint gate existing, before tonight.
6. `tests/control-plane/actor-identity-verification.test.ts:163` — `actor`
   assigned, never used, inside a security test file.

## Reward-hack check (independent critic pass, self-administered — see issue/PR body for full writeup)
No benchmark/gold file touched; no threshold changed; no evaluator code
touched; no cache relied on; ruleset is the published `typescript-eslint`
`recommended` default, not hand-tuned to minimize this repo's own finding
count (the one override — `no-explicit-any` demoted to `warn` — is disclosed
in `eslint.config.js`'s own comments, not hidden, and does not suppress any
of the 8 findings listed above). Clear.

## Witness
- Session commit: `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256: `6928b110da1d49e6259e01be4a1a74574968efe45fd61f7d79b2a0f641bc93ef`
- Witness stamp: `6f9d47b771facc1b0305326268c0ce09bcf20a314c4cf896e4c9249c0955c4f5`
  (= `sha256(report_sha256 || session_commit)`, computed via
  `printf '%s%s' "$REPORT_HASH" "$SESSION_COMMIT" | sha256sum`)

### 5-step verifier
**Note on self-reference**: per routine Step 16, `REPORT_HASH` was computed
over this file *before* this Witness section was filled in with its own
value (otherwise the hash would have to include a value it was computing —
a chicken-and-egg impossibility for any single-pass hash). Consequently
`sha256sum` of the *final*, committed version of this file (the one you are
reading, with this section filled in) will **not** reproduce `6928b11...`
— that is expected, not evidence of tampering. What *is* independently
reproducible is steps 3–5 below, plus the git history itself: the commit
that introduced this file (`be25f14` on `dream/2026-10-29-developer-experience`)
can be diffed against its parent to see this file's content at creation
time, before any subsequent edit.
1. `git clone https://github.com/ruvnet/ruClip && cd ruClip && git checkout dream/2026-10-29-developer-experience`
2. `git show be25f14:docs/dream-cycle/2026-10-29-developer-experience-report.md | sha256sum` — reproduces this file's content as of its introducing commit; compare by eye to this section's prose (the hash recorded here was taken one edit earlier still, before the Witness section itself existed, so an exact machine match on this specific step is not expected either — see the note above. This is the honest limitation this run is reporting, not a claim of exact reproducibility for step 2 alone).
3. `printf '%s%s' "6928b110da1d49e6259e01be4a1a74574968efe45fd61f7d79b2a0f641bc93ef" "6e73a8f060bcbb69965a50ffe4627e33622d4094" | sha256sum` → must equal `6f9d47b771facc1b0305326268c0ce09bcf20a314c4cf896e4c9249c0955c4f5`. This arithmetic step *is* exactly reproducible by anyone, independent of the file-hashing chicken-and-egg issue above.
4. `npm ci && npm run build && npm test` → expect `327/327` pass (unchanged from the pre-candidate baseline recorded in `docs/dream-cycle/`).
5. `npm run lint` → expect `7 errors, 1 warning` across the 6 files listed above (if this count has changed, the repo has moved since this report and the finding should be re-measured, not assumed stale).

## Gist
Gist publishing is unavailable in this session's environment (no
gist-creation tool). `GIST=LOCAL` — this report's full content is embedded
verbatim in the GitHub issue and PR bodies below instead of being linked.

## Issue
See the `[Dream Cycle 2026-10-29]` issue opened alongside this PR (link
filled in by the session after creation) for the structured write-up
(Rotation, Ledger Check, Deep Dive, Hypothesis, Evaluation Receipt, Darwin
Results, Evidence, Reward-Hack Check, Security Review, Scan Findings,
Competitors, Gist, Witness, Recommendation sections).

## Next steps (3 concrete)
1. Triage the 7 real findings — especially `propose-budget-mutation.ts`'s
   unused `newThreshold` (possible real correctness bug) — then promote the
   lint gate from advisory (`continue-on-error`) to a hard CI failure once
   the backlog is clean.
2. Add an `argsIgnorePattern`/`varsIgnorePattern` tuning for the `_`-prefixed
   intentionally-unused convention already used in `agentdb-adapter.test.ts`,
   rather than treating those 3 as real bugs.
3. The GitHub-side ledger (46 open `dream-cycle` issues, ~40 open draft PRs,
   0% human-merge rate as of tonight, confirmed via `list_pull_requests`)
   is now the dominant risk to this and every other candidate's eventual
   value — a tooling fix that is correct but never merged produces zero
   real-world effect. This is a process/governance finding outside
   tonight's bounded candidate, already partially flagged by the 2026-10-22
   architecture night (issue #91); not re-litigated here per "do not
   rediscover a direction already surfaced without new evidence."
