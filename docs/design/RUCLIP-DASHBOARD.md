# ruClip Dashboard — Phase 2a: read-only company board

Status: design, ready for review. Implements `docs/PLAN.md` §4/§8 Phase 2a —
Company/Goals/Issues visibility and heartbeat status as a Claude Artifact.
**Read-only, no write actions, no human identity needed** — approve/reject
and consent-setting are explicitly Phase 2b, a separate, later, not-yet-designed
slice that needs real auth infrastructure outside Artifacts (`ACTOR-IDENTITY-VERIFICATION.md`
§4, `docs/PLAN.md` §8 Phase 2's split note).

Grounded in the real platform contract: loaded the `artifact-capabilities`
skill and read the actual bundled type definitions (`claude.d.ts`, `db.d.ts`,
`artifact.d.ts`) rather than assuming a mechanism, per the same discipline
every prior slice used for real npm packages. One finding narrowed this
design from what the Phase 2 request suggested — read §0 before implementing.

## 0. Grounding: why this is a republished snapshot, not a live `db` sync

The Phase 2 request suggested `db`'s org-gated shared-read default for
live-updating visibility. Investigating the actual mechanism found a real
gap: **`db` is written to from inside the page's own client-side JS
(`claude.use("db")`, called by a viewer's browser) — there is no
server-side or agent-side API to write into an artifact's `db` store from
outside a loaded page.** For the page to keep its own `db` current, it
would need to `fetch()` ruClip's live state itself, from a
publicly-reachable HTTP endpoint. **ruClip has no such endpoint** — it's a
Node library talking to ruflo's local MCP bridge, not an internet-reachable
service. That's exactly the same live-endpoint gap `RUCLIP-METAHARNESS.md`
§0 Finding B and `ACTOR-IDENTITY-VERIFICATION.md`'s Phase 2b split both
already named — solving it here would mean solving it twice, once for a
dashboard fetch and once for Phase 2b's auth service, when Phase 2b already
owns standing up real reachable infrastructure.

**What works today without that infrastructure**: the `artifact` capability's
republish model. Its own contract: *"the page is the record... embed the
shared state as data in the HTML you publish and render the page from
it... every open view, this one included, reloads to it."* An agent with
local access to ruClip's real backend (this session, or a future
heartbeat-loop-triggered session) periodically reads the current
Company/Goals/Issues/heartbeat state and republishes the dashboard artifact
with that state embedded as static data in the HTML. Multi-viewer works
via the platform's own reload-on-publish behavior — genuinely real, no
fabricated live-sync claim. This is a **snapshot dashboard**, current as of
its last publish, not a continuously live one — an honest, narrower claim
than "live state" (`ADR-0001` point 5's original phrase), stated plainly
rather than quietly built as something it isn't. `db` becomes the right
tool again once Phase 2b's live endpoint exists (a page could then legitimately
fetch-and-cache into `db` for real live updates) — noted as a natural
future upgrade, not built here.

No runtime `capabilities` declaration is needed for this slice at all —
plain published HTML, republished periodically, uses none of the seven
(`artifact`, `db`, `downloads`, `mcp`, `room`, `sample`, `self`). Declaring
`artifact: {}` becomes relevant only if Phase 2b later wants the page
itself to trigger its own republish (e.g. a manual "refresh" button calling
`artifact.publish()`) — out of scope for a read-only snapshot with no
in-page interaction to persist.

## 1. Data gathering — one real gap found, one real pattern reused

**Real gap, confirmed by enumerating every exported adapter function**:
ruClip's backend has `recallCompany`/`recallGoal`/`recallIssue` (each needs
a specific id) and `listApprovalTransitionsForCompany`/`listDueHeartbeats`
(company-scoped listings) — but **no `listGoalsForCompany` or
`listIssuesForGoal`**. The dashboard needs both to render anything beyond a
single hand-picked entity.

**Real pattern to extend, not invent**: `listApprovalTransitionsForCompany`
(`store/agentdb-adapter.ts`) already solves "list all X scoped to a company"
using `agentdb_hierarchical-recall` with a text `query` (e.g.
`"ruclip:company:{companyId} approval-transition"`), `topK: 200`, scanning
both relevant tiers, and client-side JSON-shape validation on each result
(skip malformed entries rather than fail the whole scan). `listGoalsForCompany`
and `listIssuesForGoal` follow the identical shape:

```
listGoalsForCompany(companyId): query "ruclip:company:{companyId} goal", tier: 'semantic', topK: 200
listIssuesForGoal(companyId, goalId): query "ruclip:company:{companyId}:goal:{goalId} issue", tiers: ['working','episodic'], topK: 200
```

Same caveat this pattern already carries (documented in its own existing
code, not new to this design): `agentdb_hierarchical-recall` is
semantic/BM25 search over a `query` string, not an exact structured
filter — at dashboard scale (a handful of Goals/Issues per company) this is
adequate, the same "small-N acceptable at this scale" judgment
`HEARTBEATS-AND-COMMS.md` §7 already made for `listDueHeartbeats`. Revisit
if a company's Issue count grows into the hundreds.

`recallOrgMember` (existing) resolves assignee/owner names for display.
`listDueHeartbeats` (existing, already company-scoped) supplies heartbeat
status directly — no gap there.

## 2. What the snapshot shows (v1 scope)

Per-Company board:
- **Company**: name, status, budget (total/spent/remaining/utilization %,
  reusing the same alert-ladder thresholds `checkOperatingBudget` already
  established — 50/75/90/100%).
- **Goals**: description, status, success criteria, owner (resolved via
  `recallOrgMember`), budget allocation.
- **Issues**, grouped by Goal: title, status, `approvalState`, assignee
  (resolved), parent/blocker relationships (via the existing
  `getChildIssueIds`/`getBlockerIssueIds`), `budgetImpact`.
- **Heartbeats**: target (Goal or Issue), `nextFireAt`, `lastFiredAt`,
  `lastOutcome` (including `application_budget_blocked`/
  `operating_budget_blocked` shown plainly, not hidden — a blocked
  heartbeat is exactly the kind of thing this board should surface).
- **Snapshot provenance**: "as of `{publishedAt}`" stated on the page
  itself, so a viewer never mistakes a republished snapshot for a live
  feed — matches §0's honesty framing structurally, not just in this
  document's prose.

Explicitly out of scope for v1 (not because they're hard, because they're
either Phase 2b's job or not yet requested): approve/reject buttons,
consent-setting UI, org-chart editing, any write path at all.

## 3. Rendering — `artifact-design`/`dataviz` skills apply at build time, not here

Per the Artifact tooling's own rules, the coder must load `artifact-design`
before writing the page (to calibrate layout/visual investment) and
`dataviz` before building any chart/stat-tile/status element (budget
utilization meters, heartbeat status badges) — not designed in this
document, since those are visual-design judgment calls made when the page
is actually built, not architecture decisions. This document specifies
*what data* the page shows and *how it gets there*; the coder's own build
step handles *how it looks*.

## 4. Publish cadence and ownership

The republishing agent needs read access to ruClip's real backend (the
same `AgentDbAdapterConfig`/bridge every other slice already uses) — no new
credential or access path. Candidate triggers, not mutually exclusive:
manual (an operator asks for a fresh view), or wired into the existing
heartbeat-loop pattern (`HEARTBEATS-AND-COMMS.md` §7's already-deferred
scheduler loop) once that exists. **Not designing the scheduler here** —
same "not this slice" boundary `HEARTBEATS-AND-COMMS.md` already drew for
its own scheduler loop; a manual/on-demand republish is sufficient to ship
v1 and prove the snapshot format works before automating its cadence.

## 5. What Phase 2a (coder) implements

- `src/control-plane/store/agentdb-adapter.ts` — `listGoalsForCompany`,
  `listIssuesForGoal` per §1, following `listApprovalTransitionsForCompany`'s
  exact pattern (query shape, tier scanning, malformed-entry skip).
- A snapshot-assembly function (e.g.
  `src/control-plane/dashboard/build-snapshot.ts`) that composes
  `recallCompany` + `listGoalsForCompany` + `listIssuesForGoal` (per goal)
  + `listDueHeartbeats` + the `getChildIssueIds`/`getBlockerIssueIds`/
  `recallOrgMember` resolution calls in §1-2 into one plain-data snapshot
  object — the thing that gets embedded in the published HTML.
- The Artifact page itself (HTML, per §2's content scope) — built and
  published via the `Artifact` tool, loading `artifact-design` (and
  `dataviz` for any chart/meter/badge) first per that tooling's own rules.
  No `capabilities` declaration needed (§0).
- Tests: `listGoalsForCompany`/`listIssuesForGoal` against a seeded
  AgentDB fixture (multiple goals/issues, confirm correct scoping and
  malformed-entry tolerance, mirroring `listApprovalTransitionsForCompany`'s
  own existing test style), and the snapshot-assembly function's output
  shape against a company with a representative mix of goal/issue/heartbeat
  states (including a budget-blocked heartbeat, to confirm §2's "shown
  plainly" requirement).
- Full pipeline (coder → tester → security → reviewer), same as every
  other slice — even read-only, this touches real Company/Goals/Issues
  data assembly and a new public-facing surface.

Please implement verbatim — if `agentdb_hierarchical-recall`'s topK: 200
scan proves inadequate at real data volumes, or the Artifact tool's actual
publish flow surfaces something this design didn't anticipate, that's a
signal to come back to this document, not to silently improvise past it.
