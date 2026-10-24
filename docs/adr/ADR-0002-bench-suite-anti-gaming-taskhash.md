# ADR-0002: `.harness/bench.json` anti-gaming gate — pin a `taskHash` over the task set, hard-fail CI on mismatch

- **Status**: Proposed (backfill — see Context)
- **Date**: 2026-09-02 (decision date, inferred from `.harness/bench.json`'s
  own `createdAt`; this record itself was written 2026-10-24)
- **Deciders**:
- **Tags**: ruclip, metaharness, dream-machine, ci

## Context

`.github/workflows/ci.yml` and `docs/design/RUCLIP-METAHARNESS.md` have,
since this repo's early history, cited a three-digit decision id (`ADR`
followed by the digits `0`, `7`, `6`) as the source of the anti-gaming
rationale behind the hard CI gate `npm run harness:bench-verify`
(`metaharness-darwin bench verify .harness/bench.json`). No file matching
that id has ever existed in `docs/adr/` — only `ADR-0001` did, until this
record. The 2026-10-24
dream-cycle night (developer-experience deep dive, ci/tooling scan)
confirmed this by building a deterministic scanner
(`src/tooling/adr-reference-check.ts`, wired as advisory CI via
`npm run harness:check-adr-refs`) over every `ADR-NNN` citation in the
codebase: every other citation resolves to a real external repo or tool
schema (`cognitum-one/slack`'s own ADRs, `ruvnet/autogenous`, the agentdb
bridge tool's own `VALID_DOMAINS`/`provenance_type` decisions, `witness`,
`agentbbs`) — this was the one exception, a citation to a decision this
repo itself made but never actually recorded.

This ADR backfills that record rather than leaving the citation dangling.
The decision it describes was already made and is already shipped (the
hard gate has been running in CI since early in this repo's history); this
ADR's own approval status follows the Dream Machine's standing policy of
starting every ADR it writes as `Proposed` for human review, regardless of
whether the underlying behavior already ships.

## Decision

`.harness/bench.json` is ruClip's committed benchmark task corpus for
`@metaharness/darwin`'s evolutionary candidate scoring (see
`docs/design/RUCLIP-METAHARNESS.md` §A). Because the corpus is a plain
JSON file living in the repo, nothing stops a future change — human or
agent-authored — from quietly editing a task to make it easier (loosening
a `successCriteria` entry, weakening a test command, dropping a task)
without that change reading as suspicious in a diff.

The mitigation: `.harness/bench.json` carries a `taskHash` field computed
as `sha256(JSON.stringify(recursively-key-sorted(tasks)))` over the
`tasks` array. `metaharness-darwin bench verify` recomputes this hash on
every CI run and exits non-zero on any mismatch. CI wires this as a **hard
gate** (`.github/workflows/ci.yml`'s `metaharness bench suite integrity`
step, no `continue-on-error`) specifically because it is cheap (~2s,
confirmed by direct measurement) and because its only way to pass is for
the live `tasks` array to byte-for-byte match what was hashed when the
corpus was last legitimately updated — any tampering, however small,
fails loudly rather than silently degrading benchmark fidelity.

This is deliberately narrower than the repo's other `harness:*` checks
(`harness:score`/`harness:genome`/`harness:mcp-scan`, wired as
`continue-on-error: true` advisory under `harness:advisory`): those are
informational scoring with no accumulated baseline to threshold against
yet, while suite-tampering has a clean, binary, zero-false-positive
signal (the hash either matches or it doesn't), which is what justifies
making only this one a hard gate.

## Consequences

- A legitimate, intentional change to `.harness/bench.json`'s `tasks`
  array must recompute and commit a new `taskHash` in the same change, or
  CI fails. This is the intended friction — it forces benchmark-corpus
  edits to be visible, deliberate commits rather than incidental diff
  noise.
- The gate only protects the task set's integrity; it says nothing about
  whether the tasks it protects are good tasks. That remains a separate,
  human (or future dream-cycle) judgment call.
- `.github/workflows/ci.yml` and `docs/design/RUCLIP-METAHARNESS.md`'s
  citations have been repointed from the dangling three-digit id to this
  record (`ADR-0002`) as part of the same change that added this file.

## Links

- `docs/design/RUCLIP-METAHARNESS.md` §A — the taskHash algorithm, derived
  and verified directly against the real installed `@metaharness/darwin`
  tool rather than assumed.
- `src/tooling/adr-reference-check.ts` — the dream-cycle 2026-10-24 scanner
  that found this gap; also catches any future dangling ADR citation.
- `docs/dream-cycle/2026-10-24-developer-experience-report.md` — full
  research, hypothesis, and evaluation receipt for tonight's finding.
