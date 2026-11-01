# Dependency-Security SOTA Report — 2026

**Dream Cycle 2026-11-01 — `ruvnet/ruClip`**
DEEP=security · SCAN=dependencies,secrets · SLOT=1 · Session commit `6e73a8f060bcbb69965a50ffe4627e33622d4094`

## TL;DR

`npm audit` on a fresh `npm ci` reports 53 findings (2 critical, 25 high, 26
moderate). Package-**name**-only triage — the level every prior
dependency-security dream-cycle PR (#29, #39, #51, #100) did by hand, once
each — is unsound at this repo's scale: a package can have one patched copy
genuinely loaded by ruClip's own production code *and* a separate unpatched
copy that only exists under the `ruflo` peerDependency's own tooling tree
(exactly protobufjs's case tonight). Built `audit-reachability`, a small,
deterministic, version-aware classifier (`src/tooling/audit-reachability.ts`,
unit-tested, no network in tests) that checks the *exact installed version at
the exact flagged install path* against the dependency closure reachable from
this package's own two `dependencies`. Real receipt against tonight's live
`npm ci`: **1 of 34 flagged high/critical install-locations is reachable from
production (`@grpc/grpc-js@1.14.4`, PR #51's finding); 33 are not**,
including the exact `protobufjs@6.11.6` and `proxy-addr@2.0.7` copies audit
flags CRITICAL (PRs #29, #100). Secrets scan: clean — no real credentials
committed; the only `-----BEGIN PRIVATE KEY-----` literals in the repo are
Ed25519 test fixtures in `tests/support/actor-credential-fixture.ts` and
`services/ruclip-attester/tests/signing-key.test.ts`.

## What's new

- A reusable, CI-gateable tool (`npm run security:audit-reachability`,
  exit 1 iff a high/critical finding is production-reachable) instead of a
  one-off manual trace per CVE.
- Version-aware matching catches a real false-positive class that a
  name-only check (the natural first instinct) would have produced tonight:
  protobufjs's production-reachable copy (`7.6.6`, via
  `@google-cloud/secret-manager`→`google-gax`) is already patched; the copy
  `npm audit` actually flags (`6.11.6`) lives six levels deep under
  `ruflo`→`agentic-flow`→`@xenova/transformers`→`onnxruntime-web`→
  `onnx-proto`, never reachable from `src/`/`services/`.
- Cross-referencing all four open dependency-CVE PRs against one consistent,
  reproducible measure for the first time (previously: #29 and #39 each
  state their own manual "not imported under src/" conclusion in prose;
  #80 did one manual grep-based trace for #51; no PR has checked #100's
  proxy-addr claim this way before tonight).

## Competitors (paperclipai/paperclip and 3 more SCA-adjacent references)

| # | Project/Tool | Relevant practice | Grade |
|---|---|---|---|
| 1 | `paperclipai/paperclip` | MIT Node/React control plane (ADR-0001's own comparison); repo has no dependency-reachability tooling of its own — plain `npm audit` in CI, same coarse-grained signal ruClip started with | B (public repo, read directly) |
| 2 | npm CLI docs — `npm help ls`, `npm help audit` | `--omit=dev/peer/optional` is npm's own documented mechanism for computing a production-only dependency closure; `npm audit --json`'s `vulnerabilities[].nodes` is documented as the literal install path(s) of the flagged copy | A (official docs, directly exercised tonight) |
| 3 | GitHub Advisory Database (GHSA) | CVE-2026-41242/protobufjs, GHSA-m9gg-hp2v-232j/grpc-js, GHSA-jqcg-44mw-7w3h/proxy-addr — advisory text fetched/quoted by prior nights (#29, #80, #100); not re-fetched tonight, reused as-is | A (official, vendor-published) |
| 4 | OWASP Dependency-Check / `npm-check-reachability`-style tools (industry pattern, not vendored) | Established SCA practice: reachability analysis (call-graph or, cheaper, dependency-edge pruning) to de-prioritize unreachable transitive CVEs — this tool implements the cheap dependency-edge-pruning tier of that pattern, not full call-graph analysis | B (well-known practice, not independently reproduced beyond its own documented mechanism) |

## Hypothesis (frozen before evaluation)

> Given ruClip's real `npm ci` install and its real `npm audit --json`
> output, when each high/critical finding's exact installed version (at its
> exact flagged `nodes` path) is checked against the dependency tree `npm ls
> --all --json --omit=dev --omit=peer --omit=optional` resolves from this
> package's own two production `dependencies`, then the count of findings
> classified "reachable from production" should be small and should include
> `@grpc/grpc-js` (PR #51's claim) while excluding the specific `protobufjs`
> and `proxy-addr` copies npm audit flags (PRs #29, #100's claims) — subject
> to: the classifier must not alter npm audit's own severity/range
> computation, must be independently reproducible via plain `npm ls <pkg>
> --all`, and must not assume any PR's conclusion was correct before
> measuring.

## Benchmarks / Evaluation Receipt

Baseline (parent, before this candidate): fresh `npm ci` → `npm audit --json`
→ 53 findings (2 critical/25 high/26 moderate); `npm test` → 327/327, build
clean.

Candidate: added `src/tooling/audit-reachability.ts` (pure
`flattenVersions`/`classify` + a thin `npm audit`/`npm ls` CLI wiring) +
`tests/tooling/audit-reachability.test.ts` (6 new deterministic unit tests,
fixture trees only, no network) + one `package.json` script line. Diff: 2
new files (178 + 82 lines) + 2 lines in `package.json` = 262 lines, under the
300-line target, one conceptual change.

Real run against tonight's live install (`npm run security:audit-reachability`):

```
Reachable from this package's own production dependencies (1):
  [high] @grpc/grpc-js@1.14.4  (node_modules/@grpc/grpc-js)

Only reachable via peerDependencies/devDependencies tooling, e.g. ruflo (33):
  ... (33 entries, incl. [critical] protobufjs@6.11.6 (node_modules/onnx-proto/node_modules/protobufjs)
       and [critical] proxy-addr@2.0.7 (node_modules/proxy-addr) ...)

1 finding(s) at or above 'high' are reachable from production dependencies.
```
Exit code: 1 (by design — a high/critical production-reachable finding exists: `@grpc/grpc-js`).

`npm test` after the candidate: 333/333 (327 baseline + 6 new), 0 regressions, build clean (`tsc --strict`).

## Darwin Results

Not applicable — no tunable parameter or fitness function; this is a
diagnostic classifier, not an optimization (same "skipped" call as PR #29's
own report for the same reason).

## Evidence

- OBSERVATION: 53 npm audit findings on fresh `npm ci`; 4 open PRs (#29, #39,
  #51, #100) each investigated one finding's reachability manually.
- OBSERVATION: `protobufjs` has two installed copies at different versions
  (`7.6.6` top-level via `@google-cloud/secret-manager`→`google-gax`;
  `6.11.6` nested under `ruflo`→`agentic-flow`→...→`onnx-proto`) — confirmed
  via `npm ls protobufjs --all` and direct `node_modules/.../package.json`
  reads, not assumed from the package name alone.
- MEASUREMENT: `audit-reachability` run against the real, current install —
  1 of 34 flagged high/critical install-locations reachable from production
  (`@grpc/grpc-js@1.14.4`); 33 not, incl. the specific flagged copies of
  `protobufjs` and `proxy-addr`.
- INFERENCE: PR #51's "reachable via `@google-cloud/secret-manager`" framing
  is the one of the four still-open dependency-CVE PRs that measures as
  correct by this exact-version check; #29/#39/#100 target copies that, by
  the same check, never execute inside ruClip's own process — consistent
  with (not contradicting) #29's and #39's own prose conclusions, and
  compatible with #80's narrower code-path critique of #51 (#80 argues the
  *specific exploit primitive* doesn't fire from a gRPC client-only use,
  while confirming — same as tonight — that the package itself is loaded).
- DECISION: ACCEPT the `audit-reachability` tool as tonight's candidate.
  REJECT is not the right label for the four *other* PRs — that is each
  PR's own author's call on human review, not something this session
  re-verdicts; tonight only adds a reusable, reproducible measurement they
  can all be checked against.

## Reward-Hack Check

- The classifier never touches `npm audit`'s own severity/range computation,
  never mutates `package.json`/`package-lock.json`, and is read-only against
  the real, unmodified install — nothing for it to cherry-pick.
- Specifically checked for the failure mode a careless version of this tool
  would have (and almost did) commit: matching by package **name** alone.
  That version would have wrongly reported `protobufjs` as a
  production-reachable CRITICAL (since a *different*, already-patched copy
  of the same name is genuinely production-reachable) — a false positive
  that would have duplicated PR #29's already-correct conclusion for the
  wrong reason. Caught by reading the *actual installed version at the
  audit-flagged path* before classifying; the unit test
  `audit-reachability.test.ts`'s "protobufjs case" pins this down so a
  future refactor can't silently regress to name-only matching.
- No benchmark/gold-answer/threshold was touched; no model calls made
  (LLM_EVAL not needed for this candidate).

## Security Review

- No new runtime dependency added. No credentials, MCP/tool authority, or
  network scope expanded — `npm audit`/`npm ls` are the same local npm
  operations this repo's own `npm ci`/`npm test` already perform.
- The tool is strictly read-only (no `--fix`, no lockfile/package.json
  mutation) — lower risk than the override-pin PRs it cross-references,
  which do mutate `package.json`/`package-lock.json`.
- Secrets scan (this cycle's SCAN pairing): repo-wide grep for AWS/GitHub/
  Slack/OpenAI-shaped token patterns and generic
  `(api[_-]?key|secret|password|token)\s*[:=]\s*['"]<literal>` assignments
  outside tests — no matches. The only `-----BEGIN PRIVATE KEY-----` blocks
  in the tree are Ed25519 test fixtures (`tests/support/actor-credential-
  fixture.ts`, `services/ruclip-attester/tests/signing-key.test.ts`) used by
  the existing authorization test suite, not real key material. No
  `.env`/`.pem`/`.key`/service-account files are tracked; `.gitignore`
  already excludes `.env`.

## Scan Findings

**dependencies** (this cycle's scan): see Evidence/receipt above — 53
findings, 1 production-reachable (`@grpc/grpc-js@1.14.4`), 33 not
(including the specific critical `protobufjs@6.11.6` and `proxy-addr@2.0.7`
copies). Recommendation to human review: prioritize re-reviewing/merging
PR #51 over #29/#39/#100, given this measurement.

**secrets** (this cycle's scan): clean — see Security Review above.

## Witness

(see dream-cycle report body / `docs/dream-cycle/2026-11-01-security-report.md` for the full stamped section)

## Recommendation / 3 next steps

1. Human review: prioritize PR #51 (grpc-js) — the one open dependency-CVE
   PR this measurement confirms is production-reachable — over #29/#39/#100.
2. Extend `audit-reachability` (future night) to also classify `moderate`
   severity and to diff against the prior night's receipt, so a newly
   *introduced* production-reachable finding (e.g. a future
   `@google-cloud/secret-manager` bump that picks up a vulnerable
   transitive dep) is flagged as a regression, not just a static count.
3. Wire `npm run security:audit-reachability` into CI (`.github/workflows`)
   as a required check once a human has reviewed tonight's PR — out of
   scope for this candidate itself (one conceptual change per PR).

## Witness

```
REPORT_HASH    = 90fe38cdf60b4588de0ccd9937435e6358b3a7bbbb4af71d700db6bc99018768
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = 043dfd48ecbe60b00385d45d8b373ddda70251f3ab9ff353ebba9467a77e3775
```

Verifier procedure (reproducible by anyone, no special access):
1. Fetch this gist's raw content and save it as `gist.md`.
2. `sha256sum gist.md` → must equal `REPORT_HASH` above.
3. `git -C ruClip rev-parse 6e73a8f060bcbb69965a50ffe4627e33622d4094^{commit}` → must resolve (confirms `SESSION_COMMIT` is a real commit in `ruvnet/ruClip`).
4. `printf '%s%s' "$(sha256sum gist.md | awk '{print $1}')" "6e73a8f060bcbb69965a50ffe4627e33622d4094" | sha256sum` → must equal `WITNESS` above.
5. `git -C ruClip checkout 6e73a8f060bcbb69965a50ffe4627e33622d4094 && npm ci && npm run security:audit-reachability` reproduces this report's central receipt (1 reachable finding, `@grpc/grpc-js@1.14.4`) against a fresh install at the exact commit this cycle ran from — note live `npm audit` data can drift as new advisories are published, so an exact re-run may show additional/fewer findings than tonight's 53/34, but the classification *logic* (and the protobufjs/proxy-addr/grpc-js specific cases described above) is pinned by `tests/tooling/audit-reachability.test.ts`, independent of live advisory data.
