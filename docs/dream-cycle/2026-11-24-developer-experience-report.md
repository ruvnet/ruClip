# Developer-Experience SOTA Report — 2026

**Date:** 2026-11-24 · **Slot:** 4 (developer-experience / ci,tooling) · **Session commit:** `ab588b32db00b536436139b1d8e5094cd7a6eb70`

## TL;DR

**Shipped:** `engines.node: ">=20"` on `package.json` only (advisory — `npm install` warns on a mismatch, never fails). **Not shipped, after a real CI failure:** `.npmrc`'s `engine-strict=true`, which was this session's original candidate and was pushed first, then reverted within the same session once real CI (Node 20, not this sandbox's Node 22) showed it breaks installs outright — see "Real-CI correction" below. This is the honest final state: a smaller, safer guard than originally hypothesized, arrived at by letting a real failure correct the plan rather than shipping the first idea untested on its actual target environment.

## What's new

This repo has direct, first-party evidence that a Node-version mismatch already bit it once: commit `366cb36` (PR #3, merged 2026-09-02) bumped CI from Node 20→22 because `node --test "dist/**/*.test.js"` (quoted glob) only expands under Node ≥21. Commit `45bca73` (same day) reverted CI back to Node 20 after `scripts/run-tests.mjs` was rewritten to walk the filesystem itself and pass an explicit file list — sidestepping the glob dependency — "verified on both 20.20.2 and 22.22.1" per that commit's own message. That revert was correct and is **not** reopened by tonight's finding (confirmed: `npm run build && npm test` currently pass clean under Node 22.23.5, and the custom runner's docstring explains exactly why 20 is safe now).

What was never added, in either direction of that incident: anything that stops the *next* version drift from being silent. `package.json` had no `engines` field and the repo had no `.npmrc`, so `npm install` succeeds on any Node version — a contributor or a future CI change on Node 16, 18, or some future 23 with a breaking runtime change would get no signal until a test fails confusingly, exactly the failure mode the Sept 2 incident already produced once.

## Competitors (how other Node CLI/control-plane tools pin their floor)

| Project | Mechanism | Grade |
|---|---|---|
| npm (npm/cli) | `engines.node` + documented `engine-strict` recommendation for apps | A (official npm docs) |
| TypeScript (microsoft/TypeScript) | `engines.node` in package.json, no `.npmrc` enforcement (library, not app) | A (public repo, inspected) |
| paperclipai/paperclip | No committed `engines` field found in its published package manifest at time of check | B (single repo inspection) |
| Node.js own tooling guidance (nodejs/node Collaborator Guide) | Recommends `engines` + CI matrix as the standard floor-pinning pattern for apps (not libraries, where it's advisory only) | A (official guide) |

ruClip is an application/control-plane (`"private": false` CLI with a `bin` entry, not a library consumed by a wide semver range), so the npm-recommended pattern — `engines` + `engine-strict=true` (apps, not libraries) — applies directly and was the correct fit, not the softer library-style advisory-only convention.

## Hypothesis (frozen before implementation)

> Given a contributor or CI runner invoking `npm install`/`npm ci` on this repo with a Node.js version below the floor this repo's own CI, test harness (`scripts/run-tests.mjs`), and git history (commit `45bca73`, verified only on Node 20.20.2/22.22.1) depend on, when an `engines.node` field (`>=20`) is added to `package.json` together with `.npmrc`'s `engine-strict=true`, then `npm install`/`npm ci` should fail fast and loudly on an incompatible Node version instead of silently succeeding, while installs on Node ≥20 (the documented floor) continue to succeed with zero behavioral change — subject to: 0 test regressions, build unchanged, no change to CI's pinned `node-version: 20` path.

## Evaluation receipt (real evaluator, not inferred)

- **Baseline (parent, no `engines`/`.npmrc`):** `npm install --no-audit --no-fund` succeeds on any Node version, including hypothetically incompatible ones — there is no field to check, so nothing can refuse. `npm run build && npm test`: **362/362 pass** on `ab588b3` (Node 22.23.5).
- **Candidate, positive path:** with `engines.node: ">=20"` + `engine-strict=true` added, `npm install --no-audit --no-fund` on the real environment (Node v22.23.5, npm 10.9.9) → succeeds unchanged (`up to date in 714ms`). `npm run build && npm test` → **362/362 pass**, build clean. `package-lock.json` gains exactly 3 lines (the mirrored `engines` block) — no dependency-graph change.
- **Candidate, negative path (adversarial, not simulated):** temporarily set `engines.node` to `">=99.0.0"` (byte-identical file otherwise) and ran `npm install --no-audit --no-fund` → real npm refusal:
  ```
  npm error code EBADENGINE
  npm error engine Unsupported engine
  npm error notsup Required: {"node":">=99.0.0"}
  npm error notsup Actual:   {"npm":"10.9.9","node":"v22.23.5"}
  ```
  Restored the real `>=20` constraint immediately after and re-ran `npm install` to confirm the repo was left clean (succeeded, 0 diff beyond the intended candidate at that point in the session — see "Real-CI correction" below for what changed after this).

Both arms used the real `npm` binary against the real `package.json`/`.npmrc` — no mocked installer, no inferred-from-logs result.

## Real-CI correction (caught after push, before merge consideration)

All of the above evaluation ran in this session's sandbox, which is Node v22.23.5. CI pins `node-version: 20` (deliberately — see commit `45bca73`). Once PR #151 was pushed with `.npmrc`'s `engine-strict=true` in place, GitHub Actions' real `scaffold-check` job (Node 20.20.2) failed:

```
npm error code EBADENGINE
npm error engine Unsupported engine
npm error engine Not compatible with your version of node/npm: @google-cloud/secret-manager@7.0.0
npm error notsup Required: {"node":">=22"}
npm error notsup Actual:   {"npm":"10.8.2","node":"v20.20.2"}
...
sh: 1: tsc: not found      # npm install never completed, so nothing installed, so the build step fails separately
##[error]Process completed with exit code 127.
```

Root cause: `@google-cloud/secret-manager@7.0.0` is a **direct** dependency (`package.json`'s `dependencies`, imported by `services/ruclip-attester/src/signing-key.ts` and `identity-map.ts` — the attester's signing-key loader) and its own `package.json` declares `"engines": {"node": ">=22"}`. Without `engine-strict`, npm only *warns* on an engine mismatch (for any package, root or dependency) — this mismatch has silently existed on every CI run to date, Node 20 vs. the dependency's stated `>=22` floor, tolerated as a warning. Turning on `engine-strict` globally doesn't scope to "just check my own package's `engines` field" — it makes *every* package's engine mismatch fatal, including this pre-existing, unrelated one. That's a real, CI-reproduced regression this candidate introduced, not a hypothetical.

**Correction applied:** reverted `.npmrc` (and its `engine-strict=true`) entirely; kept only `package.json`'s `engines.node: ">=20"`, which is advisory-only by npm's default behavior and cannot fail an install regardless of what any dependency declares. Verified locally (not simulated) that a mismatched `engines.node` without `engine-strict` produces only:
```
npm warn EBADENGINE Unsupported engine { package: 'ruclip@0.0.1', required: { node: '>=99.0.0' }, current: { node: 'v22.23.5', npm: '10.9.9' } }
```
and install/build/test all still succeed (362/362). This revised, smaller candidate cannot reproduce the CI failure above, because it has no mechanism left that can turn any mismatch into a hard failure.

**Net result for the frozen hypothesis:** PARTIALLY REJECTED. The `engine-strict=true` half of the original candidate is rejected — it is unsafe in this specific repo today, because of a pre-existing, unrelated, real Node-version gap in a direct, security-relevant dependency (see Scan Finding 3 below). The `engines.node` field half stands: it is safe, adds real (if softer — warning, not refusal) signal, and is what ships.

## Darwin

Not run. The candidate is a single, atomic, one-parameter change (one JSON field + one `.npmrc` line) with no tunable surface — a 3-generation/4-candidate search has nothing to vary. Recorded as not applicable rather than skipped silently.

## Evidence ledger

- OBSERVATION: `package.json` had no `engines` field; no `.npmrc` existed (pre-change, this session).
- OBSERVATION: commit `366cb36`/`45bca73` (2026-09-02) show a real, resolved Node-version-floor incident in this repo's own history.
- MEASUREMENT: baseline `npm test` 362/362 on Node 22.23.5.
- MEASUREMENT: candidate `npm test` 362/362 on Node 22.23.5 (0 regressions).
- MEASUREMENT: candidate install succeeds unchanged on the documented floor (positive path, real npm).
- MEASUREMENT: candidate install is actually refused (`EBADENGINE`) when the constraint is violated (negative path, real npm, reverted immediately after).
- INFERENCE: the Sept 2 incident would have surfaced faster/louder for a contributor on an incompatible Node version if a strict guard had existed then.
- MEASUREMENT: real CI (Node 20.20.2) with `engine-strict=true` in place → genuine `EBADENGINE` failure on `@google-cloud/secret-manager@7.0.0` (requires `>=22`), then a secondary, unrelated `tsc: not found` failure because install never completed.
- OBSERVATION: `@google-cloud/secret-manager@7.0.0` is a direct dependency with `engines.node >=22`, imported by the attester's signing-key loader; its mismatch against CI's Node 20 predates tonight and was previously silent (warning-only).
- REJECTION: the `engine-strict=true` half of the original candidate — unsafe in this repo today, demonstrated by a real CI run, not inferred.
- DECISION: ship the reduced candidate (`engines.node` field only, no `.npmrc`) as a 1-file, additive-only PR; no ADR (parameter/tooling addition, not an architectural decision). Log the newly-surfaced secret-manager/Node-22 gap as a scan finding for a future human decision, not folded into tonight's fix.

## Reward-hack check

No test, benchmark, or gold-data file was touched. No threshold, cache, or evaluator code was touched. The negative-path check used a real temporary mutation of `package.json` that was fully reverted before the final diff was taken (`git status`/`git diff` confirmed clean against the intended 2-file change before commit). No undocumented cache or hidden cost. Independent self-critique: the only way this candidate could be "gamed" is if `engine-strict` silently no-ops on some npm versions — checked against npm's own documentation and against this session's real `npm --version` (10.9.9) output above, which shows it is honored.

## Security review

No security-sensitive surface: `engines`/`engine-strict` affect only local/CI install-time version gating, not runtime authorization, credentials, or network/filesystem scope. No MCP surface touched. No change to `ActorCredential`/`HumanIdentityAttestation`/budget-gate code paths.

## Scan findings

**ci,tooling scan — finding 1 (not tonight's candidate, logged for the record):** `.github/workflows/ci.yml`'s `npm install --no-audit --no-fund || true` still swallows a genuinely failed install (`|| true` unconditionally exits 0). This exact finding has 2 prior unmerged duplicate PRs already open (#65 from 2026-10-09, #76 from 2026-10-14) — not re-filed tonight to avoid a 3rd duplicate; flagged here only as still-live/still-unfixed on `main` as of this session.

**ci,tooling scan — finding 2 (not tonight's candidate, logged for the record):** `"lint": "echo \"no lint config yet — scaffold stage\" && exit 0"` is still a no-op on `main`. 2 prior unmerged duplicate PRs already open (#21 from 2026-09-09, #106 from 2026-10-29) — not re-filed tonight for the same reason.

**ci,tooling scan — finding 3 (new, surfaced by tonight's candidate's own CI failure, not a candidate itself):** `@google-cloud/secret-manager@7.0.0` is a direct dependency, imported by the attester's signing-key loader (`services/ruclip-attester/src/signing-key.ts`, `identity-map.ts`), and declares `"engines": {"node": ">=22"}`. CI runs on Node 20. This mismatch is real and currently live on every CI run — tolerated today only because nothing before tonight ever set `engine-strict`, so it's a silent warning in the CI log, not a failure. This is a genuine gap worth a human decision (bump CI to Node 22 now that the custom test runner no longer needs 20 specifically for glob reasons; pin an older `@google-cloud/secret-manager` major that supports Node 20; or accept the warning as-is) — deliberately not resolved tonight, since it would reopen the already-settled, deliberate Node-20 CI decision (commit `45bca73`) on a different basis than tonight's own candidate, and deserves its own dedicated night/human call, not a rushed fix bundled into a correction.

**Governance scan (context, not a scan surface finding):** 64 open `dream-cycle`-labeled issues and ~60 open `dream/*` PRs exist as of this session, almost all unreviewed since 2026-09-07 (0% merge rate sustained for >11 developer-experience nights and dozens of other-surface nights). This has already been independently identified, quantified, and tooled against by prior nights (issues/PRs #34/#35, #46/#47, #83/#84, #91, #92, #95/#96, #105/#106, #118/#119, #128/#129, #134/#135, #148/#149) — tonight deliberately did **not** add a 7th backlog-triage/consolidation tool or a 4th "surface exhausted" INCONCLUSIVE report on this same theme, per the ledger's own learning signal ("a finding repeated in ≥3 prior nights → rotate"). The single highest-leverage human action remains unchanged from prior nights' recommendation: review and merge from the existing backlog (starting with the smallest, lowest-risk candidates: PR #111 "ignore .claude-flow/.swarm/", PR #65/#76 "stop swallowing npm install failures," or tonight's own PR) rather than wait for tooling to produce a 61st candidate.

## Gist

LOCAL (published as part of the issue body below; no standalone `gh gist create` run tonight — the full report is reproduced in the issue to avoid a second artifact to track).

## Witness

This report went through two self-caught corrections after its first draft, each recorded rather than hidden: (1) the original witness hash was computed before this Witness section existed, so it didn't match the committed file — fixed by excluding the self-referential section from the hash (see prior commit history on this branch); (2) the original candidate (`engine-strict=true`) was reverted after a real CI failure (see "Real-CI correction" above), which changed the report's substantive content and therefore its hash. The values below are the final, correct ones for the report as merge-considered.

- Session commit: `ab588b32db00b536436139b1d8e5094cd7a6eb70`
- Report sha256 (of this report **with the `## Witness` section removed**, since the stamp cannot hash itself): `a556027cb019c9dd63f96e31e199dd78e3d5d06dc4006dd59bdafc2e1032f6b5`
- Witness stamp: `615ddecc8415a66ce9b472c9ff78a9390d36082c470569570ffef46943df6945`

**Verifier procedure (reproducible by anyone):**
1. `git fetch origin dream/2026-11-24-developer-experience && git checkout dream/2026-11-24-developer-experience` for the final candidate (baseline is `ab588b32db00b536436139b1d8e5094cd7a6eb70` on `main`).
2. From the candidate branch: `awk '/^## Witness$/{skip=1} /^## Recommendation$/{skip=0} !skip' docs/dream-cycle/2026-11-24-developer-experience-report.md | sha256sum` → must equal the Report sha256 above.
3. `printf '%s%s' "a556027cb019c9dd63f96e31e199dd78e3d5d06dc4006dd59bdafc2e1032f6b5" "ab588b32db00b536436139b1d8e5094cd7a6eb70" | sha256sum` → must equal the Witness stamp above.
4. On branch `dream/2026-11-24-developer-experience`: `npm ci && npm run build && npm test` → expect 362/362 pass; final diff against `ab588b3` should be exactly `package.json` (`engines.node: ">=20"`), `package-lock.json`'s mirrored `engines` block, `docs/dream-cycle/LEDGER.md`'s appended row, and this report's committed copy — no `.npmrc` (added, then reverted within this session).
5. Independently reproduced in this session, before the real-CI correction, by a separate adversarial-critic agent (not this report's author): confirmed the then-current diff matched exactly, reproduced 362/362 on the real branch content, and additionally confirmed `npm ci` (not just `npm install`) also refuses under the negative-path `engines.node:">=99.0.0"` probe — verdict `CRITIC_CLEAR`. That critic ran before the real CI failure was discovered and therefore did not catch it; real CI did.

## Recommendation

**Merge-ready, reduced scope.** Final shipped diff: `package.json` `engines.node: ">=20"` (+3/-0) plus the mirrored `package-lock.json` line — `.npmrc`/`engine-strict` was added, then reverted in this same session after a real CI failure (see "Real-CI correction"), and is **not** in the final diff. 0 production code touched, 0 test regressions, CI green on the corrected head. Human review required per merge policy; this session does not merge. Separately flagged (Scan Finding 3, not fixed tonight): `@google-cloud/secret-manager@7.0.0`'s `engines.node >=22` already conflicts with CI's Node 20 — currently silent, worth a deliberate human decision.
