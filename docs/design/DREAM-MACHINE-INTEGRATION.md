# Dream-machine nightly integration (Phase 4)

Status: design + config, ready for review. Implements `docs/PLAN.md` §6/§8
Phase 4 — no application code required, this is a pure config/wiring slice.
Grounded in the real `dream-machine@0.1.1` npm package (not assumed): pulled
the real tarball, read its bundled source, and actually ran
`init`/`compile`/`schedule` against this repo to see the real generated
shapes, per the same discipline every prior slice has used for
claims_*/radio-moe/cost-tracker.

## 0. What running the real tool found

- `dream-machine@0.1.1` is real, published, MIT, zero runtime dependencies
  (bundles `@dream-machine/{compile,ledger,witness,schedule}` — confirmed by
  extracting the tarball and reading `dist/bin.js`). Invoked via `npx
  dream-machine`, matching this project's existing npx-first convention for
  external tools (`npx ruflo`, `npx metaharness`, etc.) — **not** added as a
  `package.json` dependency, since the README's own quick-start is
  npx-only and there's no reason to pin a dev dependency on a tool that
  only ever runs in a separate cloud session.
- `dream-machine init --repo ruvnet/ruClip --out dream.config.json` (run for
  real, not guessed) produces a **generic scaffold** with placeholder
  defaults, not a ruClip-aware config — several fields needed correcting
  before this was actually right for this repo, confirmed by reading the
  bundled source, not by assumption:
  - **`adrConvention`** defaults to the bare string `"4-digit"`, which
    `dream-machine`'s own `adrDir()` function (read directly in `bin.js`)
    hardcodes to `docs/adrs/` (plural) when given a string. ruClip's real
    ADR directory is `docs/adr/` (singular — confirmed:
    `docs/adr/ADR-0001-ruclip-control-plane.md` and every amendment since).
    Left uncorrected, the nightly routine would have created a **second,
    wrong** ADR directory alongside the real one. `adrConvention` also
    accepts an **object form** `{dir, pad}` (found by reading `adrDir()`'s
    branch for `typeof conv === "object"`, not documented in the README) —
    used here as `{"dir": "docs/adr", "pad": 4}` to point at the real
    directory.
  - **`competitors`** defaults to a generic agent-*framework* comparison
    list (`LangGraph`, `AutoGen`, `CrewAI`, `OpenAI Agents SDK`,
    `DSPy/GEPA`) — this is dream-machine's own hardcoded fallback, not
    something it derived from ruClip's actual domain. ruClip is a
    company-*orchestration control plane*, not an agent framework — none
    of those five are genuine points of comparison. The one real,
    already-established comparison point throughout this project's own
    ADR/PLAN docs is `paperclipai/paperclip` (the direct inspiration named
    in ADR-0001 §1). Set `competitors: ["paperclipai/paperclip"]` — kept
    short and honest rather than padding it with speculative names that
    don't actually compete in this space.
  - **`buildStep.cmd: "npm ci && npm run build"`** and
    **`evaluatorEntrypoints.bench: "npm test"`** — both left at their
    generated defaults; both independently confirmed to match this repo's
    real `package.json` scripts (`build: "tsc -p tsconfig.json"`,
    `test: "npm run build && node --test ..."`). `npm test` already runs
    the build internally, so the explicit `buildStep` is slightly
    redundant with the evaluator step — harmless (STEP 0.5's build-first
    discovery still catches a broken build before wasting a research cycle
    on code that can't compile), not worth a special-case to avoid one
    extra `tsc` invocation.
  - **`ledgerPath: "docs/dream-cycle/LEDGER.md"`**, **`branchPrefix:
    "dream/"`**, **`autoMerge: false`**, the 5-slot rotation
    (`correctness`/`security`/`architecture`/`performance`/
    `developer-experience`), and `bonusModuli`/`controlPlaneProbes` — all
    left at their generated defaults, all generic and reasonable for any
    repo including this one, no ruClip-specific reason to diverge.
    `autoMerge: false` in particular must never change — it's the same
    "evaluation is not promotion" invariant this repo already holds
    throughout (`APPROVAL-GATE.md`, Autogenous's antibody/canary model,
    `metaharness`/`flywheel`).
  - **`cron`**: nudged from the generated default `"0 8 * * *"` to `"17 8
    * * *"` — an intentionally off-round-number offset (matching this
    environment's own `CronCreate` tool guidance: avoid `:00`/`:30` so
    every repo's nightly run doesn't land on the API at the same instant)
    and a few minutes clear of `ruflo`/`metaharness`'s own nightly slot
    (`0 9 * * *`, per `ADR-0001`'s Context section) in case they ever share
    cloud-environment capacity.
- `dream-machine compile`/`schedule` were also run for real (not assumed)
  against the corrected config — confirmed the compiled prompt correctly
  reflects every customization (`docs/adr/` paths, the `paperclipai/paperclip`
  competitor line, the `17 8 * * *` cron), and confirmed the real
  `routine.json` shape: a `RemoteTrigger`-style payload
  (`name`, `cron_expression`, `enabled`, `job_config.ccr.{environment_id,
  session_context.{model, sources[].git_repository.url, allowed_tools},
  events[].data.message.content}`) with the entire compiled prompt embedded
  as the routine's opening user message — this is what `/schedule` (or the
  `RemoteTrigger` "create" action) consumes directly, not a bespoke wrapper
  this repo would need to build.

## 1. What's committed

- `/dream.config.json` — the corrected source-of-truth config, at repo root
  (matching `package.json`/`tsconfig.json`'s existing root-level convention
  for project config, not a "never save to root" violation — this is
  config, not a working/output file).
- `/docs/dream-cycle/PROMPT.md` — the compiled prompt, committed as a
  build-output mirror so a human reviewer can read exactly what the nightly
  session will be told to do without running the tool themselves. Its own
  header states plainly: *"the authoritative copy is the cloud scheduler
  routine; any in-repo mirror is a build output of the same `dream.config`
  — do not hand-edit, change the config and recompile."* Treated that way
  here — if `dream.config.json` changes, re-run `dream-machine compile` and
  recommit this file, never edit it directly.
- `/docs/dream-cycle/routine.json` — the compiled `/schedule` payload,
  **committed for review, not yet actionable**: `job_config.ccr.
  environment_id` is the literal placeholder string
  `REPLACE_WITH_CLOUD_ENV_ID`, deliberately left unfilled so this file
  cannot be mistaken for a ready-to-invoke routine. **No `/schedule`
  invocation or `RemoteTrigger` "create" call has been made** — that step
  is explicitly held for your go-ahead per your instruction (a live cloud
  cron routine is a different kind of action than a repo commit). Once you
  confirm the target `environment_id`, the actual `/schedule` invocation is
  the one remaining step, and it's yours to trigger, not something this
  design doc does on your behalf.

## 2. Evaluators (your question 2)

Today: `npm test` (209+ tests as of the last delivered slice) via
`evaluatorEntrypoints.bench`, plus the `npm ci && npm run build` build-first
gate — both real, both confirmed against this repo's actual scripts.

**`ruclip-metaharness` bench suites (Phase 3)**: don't exist yet (Phase 3
hasn't started, per `docs/PLAN.md` §8) — noted as a future
`evaluatorEntrypoints` addition once Phase 3 ships a real `.harness/bench.json`
(e.g. `"metaharness-bench": "npx metaharness bench verify .harness/bench.json"`),
not fabricated now. Not blocking this slice, per your instruction.

**`metaharness security_bench`/`mcp_scan`**: **not wired this slice,
deliberately, not silently skipped.** Checked whether either is reachable
as a plain shell command (`evaluatorEntrypoints` values are shell command
strings, not MCP tool calls) the way `npm test` is — I did not find a
confirmed CLI-shape invocation for either in this session's grounding work,
and unlike `npm test`, there's no ruClip-specific bench corpus for either
to run against yet (same Phase 3 dependency as the bullet above). Adding
an unverified command string here would repeat exactly the class of
mistake this project has consistently avoided (assuming a tool's shape
instead of confirming it) — left out, flagged as a concrete follow-on once
Phase 3 exists and the CLI-vs-MCP-tool question for these two specifically
has been checked the way `ruflo-cost-tracker`'s CLI-script-vs-MCP-tool gap
was checked in `HEARTBEATS-AND-COMMS.md`.

## 3. Should the agentbbs/radio-moe/Actor-Identity-Verification code be part of the adversarial-critique rotation? (your question 3, my call)

**Yes, and no special configuration is needed — it already is.** The
generated 5-slot rotation already includes a `security` DEEP slot (1-in-5
nights, `SCAN=dependencies,secrets`), and the compiled prompt's STEP 15
SECURITY REVIEW section already names exactly the surface this code lives
in: *"prompt injection, tool/MCP authority, credential exposure, ...
agent impersonation, cross-agent and memory/benchmark poisoning,
supply-chain exposure, unsafe autonomous mutation."* `ActorCredential`
verification, the `claims_*` authorization chain, and the `radio-moe`
signing layer are squarely inside that description without needing a
bespoke slot or a special config entry — adding one would just be
duplicating what the default rotation already covers generically.

The one thing worth stating explicitly, matching your framing: **an
INCONCLUSIVE night on this surface is fine, expected even**, given how
much churn this repo has had in one session (four rounds of post-delivery
security fixes across the approval-gate, claims-authorization, and
actor-identity slices, per `docs/PLAN.md`'s own delivery notes). The
engine's own stated goal — *"optimizes for shrinking tomorrow's search
space, not for producing PRs"* — means a night that re-confirms "still
correctly hardened, no new finding" is a legitimate, successful result,
not a wasted one. No config change reflects this — it's a property of how
the engine already scores itself, not something to tune.

## 4. What Phase 4 (coder) implements

**Nothing — this is a docs+config-only slice.** `dream-machine` is a
zero-application-code external tool: everything it needs lives in
`dream.config.json` (committed) and the cloud routine it compiles to
(pending your go-ahead). There is no ruClip source code for `dream-machine`
to call into, and no ruClip source code change this slice requires. Per
your instruction, this skips the coder and goes straight to
`ruclip-reviewer` for the push, the same as the ADR-mirror slices.

## 5. What's explicitly NOT done, and why

- **`/schedule` has not been invoked.** `docs/dream-cycle/routine.json` is
  ready to hand to `/schedule` or a `RemoteTrigger` "create" call, but its
  `environment_id` is a placeholder and no cloud cron routine exists yet.
  This needs your explicit confirmation of the target cloud environment
  before it becomes a live, running nightly job — flagging back to you
  rather than treating "designed and committed" as "done," per your
  instruction that this is a different kind of action than a repo commit.
- **Phase 3's `ruclip-metaharness` bench suites** are not part of the
  evaluator map yet (§2) — not blocking, a clean future addition once
  Phase 3 ships.
- **`metaharness security_bench`/`mcp_scan`** are not wired as evaluator
  entrypoints (§2) — the real CLI-vs-MCP-tool shape for these two specific
  tools wasn't confirmed this session, and there's no bench corpus for
  either yet regardless.
