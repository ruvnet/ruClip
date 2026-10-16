# Security SOTA Report — 2026-10-16 (Dream Cycle, ruvnet/ruClip)

## TL;DR
`PR #51` ("close @grpc/grpc-js auth-bypass GHSA-m9gg-hp2v-232j reachable via
`@google-cloud/secret-manager`") is a sound, zero-regression lockfile bump —
but its security narrative overstates reachability. GHSA-m9gg-hp2v-232j's
bypass requires a process that (a) constructs **gRPC server credentials**
with `requireClientCertificate: false` and (b) calls `getAuthContext()` for
authorization. `@google-cloud/secret-manager`/`google-gax` use `@grpc/grpc-js`
purely as an **outbound client**; `requireClientCertificate` appears nowhere
outside `@grpc/grpc-js`'s own `server-credentials.ts`, and `getAuthContext`
is called nowhere in the secret-manager/google-gax tree or in ruClip's own
`src/`/`services/`. The vulnerable *package version* is loaded into the
process; the vulnerable *code path* is not reachable. REJECT of the
"actively exploitable" sub-claim; the bump itself remains good hygiene.

## What's new
Grade A (reproducible, self-derived): direct inspection of the installed
`@grpc/grpc-js@1.14.4`, `google-gax`, `@google-cloud/secret-manager` trees
plus ruClip's own source, cross-checked against the official GHSA advisory
text (fetched directly).

## Competitors (paperclipai/paperclip + general field)
| Project | Dependency-audit practice | Reachability analysis beyond `npm audit` presence? |
|---|---|---|
| `paperclipai/paperclip` | `npm audit` in CI (Grade B, public workflow) | No — presence-only, same gap this report closes |
| OSV-Scanner (Google) | call-graph-aware reachability (Grade A, official docs) | Yes — exactly the technique applied by hand here |
| Socket.dev | reachability + behavior analysis (Grade B, vendor) | Yes, commercial |
| GitHub Dependabot | version-range matching only (Grade A, official docs) | No — this is why `npm audit`/Dependabot both flag grpc-js here without the nuance |

## Hypothesis (frozen before this evaluation)
> Given GHSA-m9gg-hp2v-232j's documented trigger (a `@grpc/grpc-js` process
> creating **server** credentials with `requireClientCertificate: false` and
> using `getAuthContext()` for authorization), when ruClip's own source
> (`src/`, `services/`) and its one path to `@grpc/grpc-js`
> (`@google-cloud/secret-manager` → `google-gax`) are inspected, then no such
> server-side authorization-decision code path should exist — subject to:
> `ruflo`/`metaharness`/`ruvector` peer dependencies are not installed this
> session and their own exposure cannot be ruled out from here.

## Evaluation (deterministic, reproducible — no model calls, `LLM_EVAL=blocked` not relevant)
```
$ grep -rl "createServer\|grpc.Server\|new Server(" node_modules/@google-cloud/secret-manager node_modules/google-gax
(no matches)
$ grep -rl "getAuthContext" node_modules/@google-cloud/secret-manager node_modules/google-gax
(no matches)
$ grep -rl "requireClientCertificate" node_modules/@google-cloud/secret-manager node_modules/google-gax node_modules/@grpc/grpc-js
node_modules/@grpc/grpc-js/src/server-credentials.ts
node_modules/@grpc/grpc-js/build/src/server-credentials.js
node_modules/@grpc/grpc-js/build/src/server-credentials.d.ts
$ grep -rn "grpc\|getAuthContext\|requireClientCertificate" src/ services/
(no matches — only `google-auth-library`'s OAuth2Client and
 `SecretManagerServiceClient`, both outbound clients, are used)
```
GHSA advisory (fetched directly): "When server credentials are created with
the `requireClientCertificate` option set to `false`, `getAuthContext` does
not distinguish between authorized and unauthorized certificates." — a
server-side configuration ruClip's code, and its one path to the library,
never creates.

Baseline receipt (`main` @ `6e73a8f060bcbb69965a50ffe4627e33622d4094`, this
session, fresh `npm ci`): build clean (`tsc -p tsconfig.json`), 327/327 tests
pass. No code changed by tonight's finding — it is a critique of an existing
open PR's narrative, not a new candidate (precedent: PR #74, "no new code").

## Secrets scan (tonight's SCAN surface 1/2)
`grep -rnE` for AWS/GCP/GitHub/Slack/OpenAI-style key patterns and
`-----BEGIN ... PRIVATE KEY-----` blocks across `src/`, `services/`,
`scripts/`, `docs/`, `.github/`: one hit, a locally-generated Ed25519 test
fixture in `services/ruclip-attester/tests/signing-key.test.ts`, explicitly
documented in-file as a test/dev override ("No live GCP Secret Manager
call"). No `.env` tracked (`.gitignore` excludes it). **No actionable
finding** — a clean scan is itself evidence, not a gap.

## Dependencies scan (tonight's SCAN surface 2/2)
`npm audit` on current `main`: 52 findings (2 critical, 21 high, 29
moderate) — up from the 39 findings recorded on 2026-09-06, confirming the
tree has drifted further from the dependency fixes already sitting unmerged.
Reachability triage, same method as 09-06 and tonight's primary finding:
- `protobufjs` (critical, GHSA-xq3m-2v4x-88gg) — resolves via
  `onnx-proto`→`@xenova/transformers` (optional peer of `ruflo`'s sidecar
  tree). **Not reachable** from ruClip's own code (0 references to
  `xenova`/`onnxruntime`/`onnx-proto` in `src/`/`services/`) — consistent
  with 09-06's finding for this exact package.
- `toml` (2× high) — via `@claude-flow/cli`'s own tree. **Not reachable**
  from ruClip's own code.
- `@grpc/grpc-js` (high, GHSA-m9gg-hp2v-232j) — this report's primary
  finding: package *present* via a real direct dependency, specific
  vulnerable *code path* **not reachable**.

## Governance context (not tonight's novel finding — cited, not re-derived)
35+ `dream/*` PRs (#17–#76) remain open/unmerged since 2026-09-07; only
#11/#13/#15 were ever merged (manually, week 1). This has been raised as a
standing governance note 4 times already in PR bodies (#34, #36, #48, #50)
and formalized as `docs/adr/ADR-0002-dream-cycle-candidate-promotion-backlog.md`
(Proposed, via PR #72, still unmerged). Tonight does not re-raise this as a
new finding — it is cited here only as context for why PR #51 (correct
mechanism, overstated narrative) is still sitting open 15 days later.

## Evaluation Receipt
| | Baseline (`main`@`6e73a8f0`) | Tonight's check |
|---|---|---|
| Build | clean | clean (unchanged, no code touched) |
| Tests | 327/327 | 327/327 (unchanged, no code touched) |
| `npm audit` | 52 findings (2 crit/21 high/29 mod) | unchanged (no dependency touched) |
| grpc-js server-authz code path in ruClip+deps | — | confirmed absent (grep, reproducible) |

## Reward-Hack Check
No benchmark/test/threshold touched (no code candidate this cycle — a
critique of an existing PR's claim, same category as PR #63/#74's "REJECT,
evidence-backed" / "no new code" nights). Grep patterns tested against the
one known match (`server-credentials.ts`) plus negative controls
(`google-gax`, `@google-cloud/secret-manager`, ruClip's own `src/`,
`services/`) — all negative as predicted.

## Security Review
This correction affects only how a human reviewer should prioritize PR #51
(still recommend merging it — free, zero-regression hygiene — but as
defense-in-depth/audit-cleanliness, not as closing an active exploit path).
No credentials, MCP authority, or network scope touched. No LLM calls.

## Darwin Results
Not applicable — no tunable candidate.

## Next steps (concrete)
1. Human: merge PR #51 (still a good, free fix) and PR #39/#29 reachability
   note should be added to their bodies for the same reason tonight's note
   is added to #51.
2. Human: a bounded backlog-gardening pass (per ADR-0002) before the
   dependency drift (39→52 `npm audit` findings since 09-06) outpaces it
   further.
3. Dream Machine: when a future night's SCAN=dependencies surface flags a
   package as "reachable," require the same code-path check (not just
   presence-in-tree) applied here, to avoid repeating PR #51's overstatement
   pattern on a future finding.

## Witness
```
REPORT_HASH    = 3a4808d65e89e91f4ab52bee165f079541f4d5c5d550c77d0a0199d72b967111
SESSION_COMMIT = 6e73a8f060bcbb69965a50ffe4627e33622d4094
WITNESS        = f0f8c41fa3765ba7076fa8126052e9081507c51c152e1b838c838c49698abf43
```
Verifier procedure: (1) checkout `6e73a8f060bcbb69965a50ffe4627e33622d4094`;
(2) `sha256sum` this file, compare to REPORT_HASH; (3) concatenate
REPORT_HASH + SESSION_COMMIT, `sha256sum`, compare to WITNESS; (4) re-run the
four `grep`/advisory checks in the Evaluation section above and confirm
identical (empty/non-empty) results; (5) confirm `npm ci && npm run build &&
node scripts/run-tests.mjs dist` reports 327/327 on that commit.
