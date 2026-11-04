# Developer-Experience SOTA Report — 2026-11-04

## TL;DR

53 open `dream/*` branches now sit on `ruvnet/ruClip` (issues #8 through #116), 0 of the last 14 merged. Checking each branch's *mergeability against `main`* (as prior nights have repeatedly done — #71, #83, #91) hides the real problem: 51/53 merge cleanly against `main` in isolation, but 24 of them (45%) independently edit the same 1,417-line file (`src/control-plane/store/agentdb-adapter.ts`), invisibly to each other, because none has ever landed. Tonight's candidate is a small, dependency-free diagnostic (`scripts/dream-cycle-contention.mjs` + a pure `computeFileContention` module) that surfaces this cross-branch file contention using only local git plumbing — no GitHub API, no model call — so a future night or a human reviewer sees it before adding branch #54 to the same hot file.

## What's new

Every prior "backlog" finding (#34, #46, #71, #83, #91) measured branch-vs-`main` mergeability or a single hand-found duplicate trio. None measured branch-vs-*each-other* overlap at scale. Tonight's measurement, reproducible with one command (`npm run dream:contention`, after `npm run build`):

```
Scanned 53 branches against origin/main. 8 contested file(s):

  24x  src/control-plane/store/agentdb-adapter.ts   (architecture, performance, correctness, and dev-experience nights alike)
   4x  src/control-plane/dashboard/build-snapshot.ts
   4x  src/control-plane/store/agentdb-adapter.test.ts
   2x  src/control-plane/authorization/credential-issuer.ts
   2x  src/control-plane/authorization/human-identity-attestation.ts
   2x  src/control-plane/governance/propose-budget-mutation.ts
   2x  src/control-plane/heartbeat/fire-heartbeat.ts
   2x  src/control-plane/store/operating-budget.ts
```

(full branch lists for each row are in the committed report / tool output). Separately: dry-merging all 53 branches against the current `main` HEAD (`6e73a8f`) one at a time shows only 2 conflict (the two oldest, from 2026-09-02 and 2026-09-05 — both superseded by code that has since actually merged, e.g. #13/#15). The other 51 apply byte-clean. **Git-level mergeability is not the bottleneck; semantic duplication on a few hot files, invisible to a per-branch `main`-only check, is.**

## Competitor / prior-art scan (ci,tooling + dev-experience)

| Project / tool | Approach to concurrent-branch contention | Grade |
|---|---|---|
| GitHub native "This branch has conflicts" banner | Per-PR, vs. base only — exactly the blind spot measured above | A (observed directly, this repo) |
| `git-town` / `git stack` tooling (stacked branches) | Assumes linear rebase chain; doesn't apply to independently-created nightly branches off a shared, never-advancing base | B (docs, not run against this repo) |
| Dependabot's "superseded" grouping | Groups updates by *dependency*, not by file-path overlap of arbitrary diffs — different problem shape | B |
| `paperclipai/paperclip` (named competitor) | No public nightly-research-branch pattern found to compare against; not an applicable baseline for this finding | C (no public evidence) |
| This repo's own prior art, PR #83/#92/#84 (unmerged) | Hand-rolled "diff-overlap duplicate detector" found one 3-branch trio by manual inspection; never landed, so main still has none | A (this repo, inspected directly) |

## Hypothesis (frozen before implementation)

> Given the 53 currently-open `dream/*` branches in `ruvnet/ruClip`, when file-level change-sets are compared branch-to-branch (not branch-to-`main`) using local git diff output alone, then at least one production file will show contention from 3+ independent branches, revealing duplication that a `main`-only mergeability check cannot see — subject to: the detector must run without GitHub API access or model calls (works even if `LLM_EVAL=blocked`), must not mutate any branch or the ledger's historical rows, and must not claim semantic duplication beyond file-path overlap (textual overlap is a signal, not proof of logical conflict).

## Evaluation receipt

- Build: `npm run build` — clean (tsc, strict mode, 0 errors).
- Baseline: `npm test` before this change — 327 tests, 327 pass (confirmed by diffing test count before/after adding 5 new tests below).
- Candidate: added `src/control-plane/tooling/dream-cycle-contention.ts` (57 lines, pure functions, no I/O) + `tests/control-plane/dream-cycle-contention.test.ts` (5 new unit tests against synthetic fixtures, not the live branch graph — deterministic, won't flake as branches merge/close) + `scripts/dream-cycle-contention.mjs` (CLI wrapper shelling to `git branch -r` / `git diff --name-only`, same pattern as the existing `attester:*` scripts).
- `npm test` after: **332/332 pass, 0 regressions** (327 pre-existing + 5 new).
- Tool run against the live repo (receipt captured, not inferred): `node scripts/dream-cycle-contention.mjs --warn-branch origin/dream/2026-10-07-architecture --threshold 3` → exit code 1, correctly flags that branch's edit to `agentdb-adapter.ts` against the 24-branch cluster. Run against `origin/dream/2026-11-03-performance` (touches no `src`/`services` files) → exit code 0, no false positive.
- LLM_EVAL: `OPENROUTER_API_KEY` is present in this environment, but deliberately unused — the candidate is pure git plumbing by design, so this diagnostic keeps working on a night where `LLM_EVAL=blocked`.

## Darwin results

Not applicable. This candidate is a deterministic correctness/detection tool, not a tunable numeric optimization — there is no continuous fitness function to evolve against. Skipped per STEP 10-14 ("only if available / applicable").

## Evidence classification

- MEASUREMENT: 53 open `dream/*` branches; 24/53 touch `agentdb-adapter.ts`; 51/53 merge cleanly against `main` HEAD `6e73a8f`; 332/332 tests pass post-candidate.
- OBSERVATION: `.github/workflows/ci.yml` still runs `npm install --no-audit --no-fund || true` (the swallowed-install-failure finding from #64/#75/#106's lineage) — unchanged, not tonight's candidate, flagged for the backlog.
- INFERENCE: the 0% dream-cycle PR merge rate is a review-throughput problem, not a technical-staleness problem — supported by the 51/53 clean-merge measurement, not asserted without it.
- DECISION: ship the contention detector as a small, reviewable, additive tool rather than re-reporting the already-documented backlog size.
- REJECTION: considered also auto-closing branches/PRs that are now git-stale or semantic duplicates; rejected — this session has no mandate to resolve other PRs' fates and that is a human call, not an autonomous one.

## Reward-hack check (independent-critic pass, self-administered per STEP 10 — no second LLM available; checked explicitly against each criterion)

- Did it weaken any benchmark/test? No — only additions; no existing test file touched.
- Did it alter gold answers or thresholds? No gold data or thresholds exist for this area.
- Cherry-picked result? No — the full branch set (53) was scanned, not a favorable subset; both the "51 clean" and "24-way contention" numbers are reported even though the first number cuts against the finding's framing.
- Exploited the evaluator? No — `npm test` is run unmodified via its real entrypoint (`npm run build && node scripts/run-tests.mjs dist`).
- Hidden cost? The CLI script shells out to git once per branch (53 processes) — O(branches), stated plainly, not hidden.
- Relied on an undocumented cache? No.

## Security review

- New code executes `git branch -r` / `git diff --name-only` via `execFileSync` with an argument array (no shell interpolation of branch names) — not injectable via branch naming.
- Read-only: no branch, ref, or file is mutated; `git merge --abort` was used manually during investigation (not by the shipped tool) and left the tree clean (`git status` verified empty before commit).
- No credentials, no network access, no MCP/tool-authority surface touched.
- Least-privilege: the CLI needs only local git history already present in CI/dev checkouts (`git fetch` of remote branches), nothing additional to grant.

## Scan findings (ci, tooling)

1. `.github/workflows/ci.yml`'s `npm install --no-audit --no-fund || true` still silently swallows install failures — documented three times already (#64, #75, #106's lineage) across unmerged PRs; not re-implemented tonight to avoid a 4th duplicate, but still unresolved on `main`.
2. `npm run lint` is still the literal no-op stub (`echo "no lint config yet" && exit 0`) — also already proposed as a fix in unmerged PR #105; same non-duplication reasoning applied.

## Competitors

See the scan table above (paperclipai/paperclip has no public equivalent found; GitHub's own per-PR conflict UI is the closest comparable, and shares the exact blind spot measured here).

## Gist

This document. Published via `gh gist create` if `gh` auth succeeds tonight; otherwise retained at `docs/dream-cycle/2026-11-04-developer-experience-report.md` (LOCAL).

## Witness

- Session commit (the `main` HEAD this cycle ran against): `6e73a8f060bcbb69965a50ffe4627e33622d4094`
- Report sha256: `2199295d47f07d0028dbcaf401a45b676153981ce7b378ac7de984a6416203e5`
- Witness stamp (`sha256(report_sha256 + session_commit)`): `90ea28c33a05cc91f0309c25899c2b17a4c1b39269a462b495d26d796543c4f3`

Verifier procedure (reproducible by anyone):
1. `git -C ruClip rev-parse 6e73a8f` — confirm that commit exists and is an ancestor of (or equal to) `main` as of 2026-11-04.
2. Fetch this gist's raw content to a file, e.g. `report.md`.
3. `sha256sum report.md` — must equal the Report sha256 above.
4. `printf '%s%s' "$(sha256sum report.md | cut -d' ' -f1)" "6e73a8f060bcbb69965a50ffe4627e33622d4094" | sha256sum` — must equal the Witness stamp above.
5. To check the underlying measurement itself (not just the report's integrity): `git fetch origin && npm ci && npm run build && node scripts/dream-cycle-contention.mjs` from a `ruvnet/ruClip` checkout at or after this commit reproduces the "24x agentdb-adapter.ts" finding directly from git history, independent of this report.

## Next steps (concrete, for the human reviewer)

1. Merge this PR (or cherry-pick just `dream-cycle-contention.ts`/`.mjs`) — it is additive, zero-risk, and the smallest possible candidate (per the 0%-merge-rate learning signal).
2. Before accepting any *other* open `dream/*` PR that touches `agentdb-adapter.ts`, run `npm run dream:contention -- --warn-branch origin/<that-branch>` to see which of the other 23 branches it now silently conflicts-in-intent with, and pick one per cluster rather than attempting all 24.
3. Treat `agentdb-adapter.ts`'s god-module status itself (already flagged architecturally in #8/#16/#30/#60/#81, all unmerged) as the upstream cause of this contention — decomposing it would shrink the blast radius of future concurrent nightly edits, independent of whether this particular PR merges.
