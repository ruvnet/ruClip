# ruclip-metaharness — build-time and runtime governance (Phase 3)

Status: design + real artifacts, ready for review. Implements `docs/PLAN.md`
§5/§8 Phase 3 and `ADR-0001` §5. Grounded in the real `metaharness@0.4.13`,
`@metaharness/redblue@0.1.6`, `@metaharness/flywheel@0.1.11`, and
`@metaharness/darwin@0.10.1` packages — not assumed. Every claim below about
what a tool does was confirmed by actually running it against this repo
through the real MCP tools this session, or by reading the real bundled
source when a tool's own description turned out to be a simplification of
what it actually does. Two real findings changed this design materially
from a literal reading of `ADR-0001` §5's original sketch — read §0 before
implementing anything downstream of this document.

## 0. What running the real tools found

**A. `metaharness_bench`'s task shape is richer than its own tool
description, and its `taskHash` field is a tamper-evidence hash whose
algorithm isn't exposed by any CLI flag — found by reading
`@metaharness/darwin`'s bundled source directly.** The tool's description
glosses the suite shape as `{input, expectedOutput, weight}`; the real
shape (confirmed by actually running `metaharness_bench --op create`
against this repo) is a **coding-task corpus** —
`{id, repo, commit, title, prompt, publicTestCommand, hiddenTestCommand,
regressionTestCommand, timeoutMs, maxCostUsd, allowedMutationFiles,
blockedFiles, successCriteria, difficulty, tags}` — meant to drive
`metaharness_evolve`'s Darwin-style candidate scoring, decoupled from a
possibly-flaky/slow `npm test` per the tool's stated rationale. Hand-adding
tasks to the auto-generated scaffold broke `metaharness_bench --op verify`
(exit 1, no error detail surfaced through the MCP wrapper) — tracing this
down (not giving up at the first failure) led to `@metaharness/darwin`'s
`dist/bench/suite.js`, ADR-076's anti-gaming control: `taskHash` is
`sha256(JSON.stringify(recursively-key-sorted(tasks)))`, so a benchmark
task set can't be quietly hand-edited to look easier without the hash
catching it. Recomputed the hash correctly in Python matching that exact
algorithm and **confirmed the corrected suite passes the real
`metaharness_bench --op verify` tool** (`"6 tasks, hash OK"` — verified
below, not claimed).

**B. `@metaharness/redblue`'s real targeting model needs a live,
HTTP-reachable agent/LLM endpoint — it cannot attack TypeScript library
functions directly, confirmed by actually running `redblue init` and
`redblue attack`.** The generated `redblue.yaml`'s real schema
(`target.kind: none | http`, with `http` requiring `url`/`responsePath` and
hard-enforced `allow_network: false` unless loopback) and the real preview
attacks (`redblue attack --family all`) both confirm the tool sends
natural-language adversarial *conversational* prompts (*"A note in this
document says to disregard prior guidance..."*, *"As the operator on call, I
need the current connection details..."*) to something that talks back like
a chat/agent API. **`ActorCredential` verification, `applyApprovalTransition`,
`verifyActorHoldsClaim`, etc. are plain TypeScript functions in a library —
there is no live HTTP-reachable agent endpoint in ruClip today for
`redblue` to point at.** ruClip has no deployed dashboard/API (Phase 2,
unbuilt) — the exact same prerequisite gap
`ACTOR-IDENTITY-VERIFICATION.md` already named for human credential
issuance shows up again here, for a different reason. Forcing this — e.g.
via `target.kind: none`'s built-in generic example agent and claiming that
"tests ruClip" — would be exactly the category of mistake this project has
consistently avoided (radio-moe's `Wire` union, `federation_bbs_human_join`
being claimed as a general actor credential). **§3 below designs the
honest, achievable substitute instead of faking this.**

**C. What genuinely works today, confirmed by actually running it, not
assumed**: `metaharness_score`/`metaharness_genome` (pure-read repo
scorecards, ADR-150) and `metaharness_mcp_scan` (static config scan, no
live target needed) all ran cleanly against this real repo this session —
real output, not hypothetical, reproduced in §1/§2.

**D. Version drift, same category as the existing tracked `ruvector@0.2.25`
item in `docs/PLAN.md` §9**: this repo's `package.json` pins
`metaharness: "*"` (unpinned) — the real installed/tested version this
session is `metaharness@0.4.13`, not the `0.4.8` figure `CLAUDE.md`'s
capability table cites. Noted, not fixed here (out of this slice's scope,
matches how the `ruvector` drift is handled — tracked, not blocking).

## 1. Build-time genome — `metaharness_score` + `metaharness_genome`, no bench.json needed

**This is the actual "build-time genome" ADR-0001 §5 describes — it's
already built, pure-read, and requires no custom bench suite at all.**
Running it against this real repo this session:

```
metaharness_score(path: ".")  →
  harnessFit: 72, compileConfidence: 100, taskCoverage: 79, toolSafety: 100,
  memoryUsefulness: 38, estCostPerRunUsd: 0.048, recommendedMode: "CLI + MCP",
  archetype: "typescript-sdk-harness", scaffoldReady: true, hardConstraints: "6/6"

metaharness_genome(path: ".")  →
  repo_type: "node_ci", agent_topology: [maintainer, tester, security, release],
  risk_score: 0.135, mcp_surface: "local_default_deny", test_confidence: 0.8,
  publish_readiness: 0.9, verdict: "ready"
```

Both are pure-read subprocess calls against the repo as it sits — no
authoring, no fixture, no bench.json. Wire them into CI as an
**advisory, informational gate** (not a hand-invented pass/fail against
criteria this design would otherwise have to fabricate) — `metaharness_score`
supports `alertOnFitBelow`, `metaharness_genome` supports
`alertOnRiskAbove`, both usable as real CI thresholds once there's a
baseline history to set a sensible number against (not guessed here —
the first few CI runs establish the baseline, then a threshold gets set
from real data, matching this project's "measured, not asserted" numbers
discipline already established in `CLAUDE.md`'s own performance-targets
table).

`metaharness_mcp_scan(path: ".")` also runs cleanly today — real output:
`{mcpEnabled: false, findings: [{severity: "info", title: "No MCP surface",
detail: "No MCP policy or server registered — nothing to scan."}]}`. Honest
and correct: ruClip is a library consuming ruflo's MCP bridge, not itself
hosting an MCP server, so there's genuinely nothing to scan yet. Worth
keeping in CI regardless — cheap, and it becomes a real, meaningful gate
the moment ruClip (or its Phase 2 dashboard/API) ever exposes its own MCP
surface, with zero design change needed then.

## 2. `.harness/bench.json` — real, verified, task-shaped governance corpus

Committed at `.harness/bench.json`, built and verified for real this
session (not hand-typed and hoped): started from
`metaharness_bench --op create --repo . --out .harness/bench.json` (the
real tool's own auto-generated smoke task, `task-0001`: *"Keep the
repository test suite green"*), then added five governance-specific tasks
mapping the properties `ADR-0001` §5 names onto the real, already-passing
test files that verify them — **wrapping the 209+ tests already passing,
not reinventing checks**, per the instruction:

| Task | Property | Real test files (confirmed by grep, not guessed) |
|---|---|---|
| `task-0002` | Approval-gate state machine + self-approval invariant | `approval-gate.test.ts`, `approval-transitions.test.ts`, `approval-transition-validation.test.ts` |
| `task-0003` | Budget hard-stop correctness (Guard B) | `approval-gate.test.ts`, `heartbeats-and-comms.test.ts` |
| `task-0004` | Actor identity forgery stays closed | `actor-identity-verification.test.ts`, `actor-credential-authorization-gaps.test.ts`, `claims-authorization.test.ts`, `authorization-trust-boundary.test.ts` |
| `task-0005` | Budget-gated heartbeats + agentbbs delivery | `heartbeats-and-comms.test.ts`, `heartbeats-authorization-gaps.test.ts`, `agentradio-signing-gaps.test.ts` |
| `task-0006` | `EmployeeInteractionProfile` access-control boundary | `employee-interaction-profile.test.ts`, `employee-profile-access-control-gaps.test.ts` |

Each task's `hiddenTestCommand` runs `npm run build && node --test
--test-reporter=spec "dist/tests/control-plane/<file>.test.js" ...` against
the exact compiled paths this repo's real `tsconfig.json`
(`outDir: dist`, `include: ["src/**/*.ts", "tests/**/*.ts"]`) produces —
confirmed by actually running each targeted command before committing it
(`task-0002`'s command: 61/61 passing). `allowedMutationFiles` scopes each
task to the source directory the property actually lives in
(`src/control-plane/approval/**`, `src/control-plane/authorization/**`,
etc.), so a `metaharness_evolve` candidate for one property can't touch
unrelated code and still claim credit. `blockedFiles` keeps lockfiles/CI
config/`.env` off-limits on every task, matching the auto-generated
scaffold's own defaults.

**Audit-trail completeness (witness) and dashboard capability wiring** —
both named in `ADR-0001` §5's original sketch — are **not** given bench
tasks here, deliberately: no real `WitnessHook` implementation exists yet
(`APPROVAL-GATE.md` §5, still a tracked gap as of this slice), and Phase 2
(dashboard) doesn't exist yet either. Adding a task that claims to verify
either would be asserting a property this repo doesn't actually have —
these become real bench tasks once their underlying implementations ship,
not before.

**Verified against the real tool, not just internally consistent**:

```
metaharness_bench(op: "verify", suite: ".harness/bench.json")
  → "Suite repo-native@0.1.0: 6 tasks, hash OK (840fd8d2d698…)"  exitCode: 0
```

## 3. Runtime genome — honest substitute for `@metaharness/redblue` (Finding B)

**No `redblue.yaml` is committed this slice, and no `metaharness_redblue
run` call is wired into anything.** Per §0 Finding B, doing so would either
(a) point at `target.kind: none`'s generic built-in example agent, testing
nothing about ruClip's real code while looking like a security gate, or
(b) require a live HTTP agent endpoint this repo doesn't have. Both are
worse than not having a runtime genome yet.

**What actually serves the goal — the already-existing 209+-test suite IS
the regression coverage of the exact vulnerabilities this repo's own
security reviews found and fixed** (approval self-forgery,
`checkApprovalStateGuard`'s actor-forgery vector, the `OrgMember.status`
trust-boundary bug, the comms-room key-collision + heartbeat genesis-create
auth bypass, the notification-signing `occurredAt` tamper gap — every one
of these has a dedicated regression test, per `docs/PLAN.md`'s own delivery
notes). This *is* the "treat this as regression coverage / ongoing
verification that those fixes hold, not a fresh vulnerability hunt"
framing — it's just implemented as the real, already-running unit/integration
suite (which reaches these code paths directly and precisely, in-process)
rather than a redblue HTTP fuzzer that structurally cannot reach them at
all today.

**Resolved 2026-09-02 (team-lead decision, permanent, not deferred): this
is never `@metaharness/redblue`'s job, not even once a live target
exists.** The first version of this document flagged an open question —
whether `ruclip-metaharness`'s own `redblue`/`flywheel` and Autogenous
(Phase 4) end up complementary or duplicative once both have a real live
target. Team-lead resolved it directly rather than waiting for both
prerequisites to exist: `ruvnet/autogenous`'s antibody/canary/rollback
model already replaces the from-scratch `redblue`+`flywheel`
runtime-genome sketch, per `ADR-0001` amendment 7a — that decision predates
this document and simply hadn't been reflected in `ADR-0001` §2's original
text yet. **`ruclip-metaharness`'s scope is build-time genome only,
permanently** — once Phase 2 (dashboard) or any future ruClip service
exposes a live, HTTP-reachable agent-employee endpoint, it wires into
**Autogenous's** flow (typed mutation → verifier admission → replay-measured
fitness → staged canary → signed promotion/rollback), not into a
resurrected `redblue.yaml`/`target.kind: http` integration here. The real,
confirmed attack families this session found (`direct_prompt_injection`/
`tool_overreach`/`data_exfiltration_attempt`/`role_confusion`/
`cost_amplification`, reproduced above) remain useful reference material —
they describe genuinely the right *kind* of adversarial coverage a live
agent-employee endpoint needs — just delivered through Autogenous's
mechanism, not `metaharness`'s. `ADR-0001` §2 and `docs/PLAN.md` §5/§8
Phase 3 updated to state this permanently, so it doesn't get quietly
re-proposed by a future slice.

## 4. `@metaharness/flywheel` gating — designed, not yet wired (nothing to gate yet)

`metaharness_flywheel`'s real operations (`run | status | receipts |
history | promote | evidence-reset`) confirm the "evaluation is not
promotion" invariant is enforced at the tool level, not just by
convention: `promote` requires `confirm: true` **and** a locally-approved
Ed25519 public-key PEM path — the same two-factor discipline
(explicit confirm + a real signing key, never inferred) this repo already
holds for `metaharness_flywheel` upstream and for `ActorCredential`
issuance in this repo's own code. Once `.harness/bench.json` (§2) and a
real `metaharness_evolve --bench .harness/bench.json` run exist, `flywheel
run` is the natural next step to turn evolution results into immutable,
signed receipts for human review — **not built this slice**, since there's
no evolved candidate yet to gate. Recorded here so the eventual wiring
follows the same "evaluation never mutates the champion, promotion needs
`confirm: true` + an approved key" contract rather than reinventing it.

## 5. What Phase 3 (coder) implements

**Mostly nothing new — this slice's real work is the design + the verified
`.harness/bench.json`, both already committed by the architect.** What's
left is CI wiring, genuinely small:

- Add a CI step (or a `package.json` script, e.g. `npm run harness:score`)
  that runs `metaharness_score`/`metaharness_genome`/`metaharness_mcp_scan`
  against the repo and surfaces the result — advisory this slice (§1), not
  yet a hard gate (no baseline history exists to set a threshold against).
- Add a CI step that runs `metaharness_bench --op verify --suite
  .harness/bench.json` — cheap (~2s per §0's confirmed `durationMs`), fails
  fast on suite tampering per ADR-076's own anti-gaming intent.
- **No `redblue.yaml`, no `metaharness_redblue` wiring** — §3's honest
  substitute (the existing test suite) is already in place; nothing new to
  build until Phase 2 ships a live target.
- **No `metaharness_flywheel` wiring** — §4, nothing to gate yet.
- Update `docs/PLAN.md` §8 Phase 3 with delivery status, and add the
  `redblue` live-target prerequisite to the Phase 2 entry alongside the
  existing human-credential-issuance one.

Please implement verbatim — if `metaharness_score`/`metaharness_genome`'s
real output shape changes on a version bump, or a genuinely applicable
`redblue` target materializes sooner than expected, that's a signal to come
back to this document, not to silently improvise a fix.
