# Budget-gated heartbeats + comms wiring

Status: design (Phase 1e). Implements the two remaining Phase 1 items from
`docs/PLAN.md` §8: a recurring "wake up and check on this" cycle for an
Issue's (or Goal's) assigned agent employee, gated on budget before it
executes; and routing the resulting notifications (heartbeat fires,
approval-state transitions, budget thresholds crossed) through comms rather
than a parallel notification system. This slice is additive — the
Company/Goal/Issue schema, the approval-gate state machine, and claims
authorization (`DOMAIN-MODEL.md`, `APPROVAL-GATE.md`, `AUTHORIZATION.md`)
are unchanged.

## 0. Grounding corrections (read before implementing against this doc)

Per the same discipline that caught real bugs in the claims_* slice, this
section reads the actual `ruflo-loop-workers`/`ruflo-cost-tracker` source in
the `ruvnet/ruflo` monorepo (not assumed from CLAUDE.md's summary table) and
checks the real, live MCP/tool schemas available in this environment — not
the skill docs' claims about them. Four findings changed this design from
what a literal reading of the brief would have produced:

**A. `hooks_worker-dispatch`'s 12 triggers are a fixed, repo-maintenance
vocabulary — none of them is "check on an Issue."** `ruflo-loop-workers`
ADR-0001 documents exactly 12 trigger names: `ultralearn`, `optimize`,
`consolidate`, `predict`, `audit`, `map`, `preload`, `deepdive`, `document`,
`refactor`, `benchmark`, `testgaps` — all codebase-maintenance workers
(security audit, docs generation, coverage analysis...). There is no 13th,
extensible, or parameterized trigger a downstream consumer like ruClip can
register. A ruClip Issue heartbeat **cannot** be modeled as a
`hooks_worker-dispatch` call — that tool's vocabulary is closed and owned by
`ruflo-loop-workers` itself.

**B. Neither of `ruflo-loop-workers`' two documented scheduling mechanisms
is actually a durable, cross-restart scheduler, contrary to its own skill
doc.** The `cron-schedule` skill says "Use `CronCreate` for workers that
must survive session restarts" and contrasts it with `/loop`'s
"in-session... self-pacing." Checking the **real, live `CronCreate` tool
schema** available in this environment directly contradicts that: its
description states plainly *"Jobs live only in this Claude session —
nothing is written to disk, and the job is gone when Claude exits,"*
`durable` "has no effect — durable persistence is not available," and
recurring jobs "auto-expire after 7 days." The `loop-worker` skill's own
`ScheduleWakeup` tool, meanwhile, **does not exist at all** in this
environment's tool set (confirmed by search — no match). So as far as this
environment can verify, there is no primitive that survives a session
restart indefinitely. This changes the design in §3 below: the durable
source of truth for "when should this heartbeat next fire" must live in
AgentDB (already durable, already this repo's persistence layer), not in a
cron job — `CronCreate`/an active `/loop` session is only ever the
*proximate* trigger for an already-running session to remember to check
again soon.

**C. `ruflo-cost-tracker`'s "budget" is a whole-project circuit breaker over
real Claude Code session spend — not a per-Issue/per-Company primitive, and
not an MCP tool.** Reading `scripts/budget.mjs`, `scripts/health.mjs`, and
`commands/ruflo-cost.md` directly: `cost budget check` sums
`total_cost_usd` across `cost-tracking:session-*` records (real, measured
LLM-call spend, produced by `cost track`/`track.mjs` parsing
`~/.claude/projects/*/` session logs) against a single project-wide
`cost-tracking:budget-config` record, and emits the 50/75/90/100% alert
ladder. It takes no `companyId`/`issueId`/`goalId` parameter — it has no
concept of any of those entities. It is a **CLI script** wrapping
`npx @claude-flow/cli memory {store,retrieve,list}` shell-outs
(`ADR-0002` "considered an MCP-tool form but deferred"), invoked at a path
relative to the `ruvnet/ruflo` monorepo checkout
(`node plugins/ruflo-cost-tracker/scripts/budget.mjs`) — a path that does
not exist inside ruClip's own repo, and depending on a sibling repo's
internal file layout would be the wrong dependency direction for a
standalone published project. **This means `ruflo-cost-tracker`'s "budget"
and ruClip's own `Company.budget`/`Issue.budgetImpact` (already fully
designed and shipped, `DOMAIN-MODEL.md` §1.1/§1.4) are two genuinely
different things that happen to share a name** — one is real infrastructure
spend (what ruClip's own AI compute costs to run), the other is ruClip's
in-schema business-budget accounting (what a Goal/Issue is allowed to cost
the company). §2 below keeps them as two separate gates. ruClip reuses
`ruflo-cost-tracker`'s *data shape and alert ladder* — not its script
path — via the `memory_store`/`memory_retrieve`/`memory_list` MCP tools
this repo's bridge already talks to, against ruClip's **own** namespace
(§4), not the shared `cost-tracking` namespace (which may already be
tracking unrelated development spend on whatever bridge instance is
running).

**D. `agentbbs` has real, concrete MCP tools available right now;
AgentRadio has zero implementation surface available in this environment.**
`federation_bbs_register`/`federation_bbs_publish`/`federation_bbs_watch`/
`federation_bbs_human_join` are real, live MCP tools with concrete input
schemas (checked directly, §5) — `agentbbs` is an optional dependency that
every handler gracefully degrades to `{degraded: true}` for when missing,
matching the ADR-150 pattern already established elsewhere in this repo. By
contrast, a repo-wide search for `radio-moe`/`AgentRadio` in the
`ruvnet/ruflo` checkout finds only the two amendment documents this session
itself wrote — no source, no MCP tools, and `ruvnet/autogenous` is not
checked out anywhere on this machine (checked `/Users/cohen/Projects/*`).
**This slice cannot ground an AgentRadio implementation in anything real**,
so §5 designs it as an interface-only stub, and agentbbs — not AgentRadio —
is the channel actually wired and used this slice, contrary to the
"AgentRadio primary, agentbbs option" framing in the brief. This is
flagged explicitly as a deviation, not silently implemented against
fabricated AgentRadio API calls.

## 1. `HeartbeatSchedule` entity

A recurring check-in on a `Goal` or an `Issue`, targeting a single
`OrgMember` to wake. New entity, additive to the existing schema.

```typescript
export type HeartbeatTarget =
  | { kind: 'goal'; goalId: string }
  | { kind: 'issue'; goalId: string; issueId: string };

export type HeartbeatStatus = 'active' | 'paused' | 'cancelled';
export type HeartbeatOutcome = 'ok' | 'application_budget_blocked' | 'operating_budget_blocked' | 'error';

export interface HeartbeatSchedule {
  id: string;
  companyId: string;
  target: HeartbeatTarget;
  /** OrgMember.id to wake each time this fires. */
  assigneeId: string;
  cadenceSeconds: number;
  status: HeartbeatStatus;
  nextFireAt: string; // ISO 8601 — the durable source of truth, see Finding B
  lastFiredAt: string | null; // ISO 8601
  lastOutcome: HeartbeatOutcome | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
```

A discriminated-union `target` (rather than nullable `goalId`/`issueId`
fields) rules out the invalid "neither goal nor issue" and "both, but they
disagree" states at the type level — the same reasoning `ApprovalAction`'s
closed union already applies elsewhere in this schema.

Invariants:
- `cadenceSeconds >= 60` — a floor against accidental sub-minute polling
  storms; not a hard technical limit, a sanity guard.
- `target.issueId`'s `goalId` (when `target.kind === 'issue'`) must match
  the recalled `Issue.goalId` — checked at write time the same way
  `Issue.parentId`'s existence isn't independently re-validated by
  `assertValid*` (structural only) but the write path (`persistHeartbeatSchedule`,
  §6) recalls the target and rejects a mismatch, mirroring how
  `persistIssue` already recalls state before writing.
- `nextFireAt` only ever moves forward (set once at creation, then
  monotonically advanced by firing or explicit resume) — never backdated by
  a write.

Keying, following the existing `companyKey`/`goalKey`/`issueKey`/
`commentKey`/`approvalTransitionKey` convention in `store/agentdb-adapter.ts`:

```
ruclip:company:{companyId}:goal:{goalId}:heartbeat:{heartbeatId}                       (target.kind: 'goal')
ruclip:company:{companyId}:goal:{goalId}:issue:{issueId}:heartbeat:{heartbeatId}       (target.kind: 'issue')
```

Hierarchical-store tier: `working` while `status === 'active' | 'paused'`
(it's actively-managed, mutable state, same reasoning as an open `Issue` —
`DOMAIN-MODEL.md` §2.1), moved to `episodic` on `status: 'cancelled'`
following the exact same tier-migration pattern `persistIssue` already
implements for `Issue.status` transitions. A new `belongs_to` causal edge
(`entity:heartbeat:{id} -> entity:issue:{issueId}` or `-> entity:goal:{goalId}`)
lets `agentdb_graph-query` answer "all heartbeats for this issue" the same
way it already answers issue/goal/comment relationships — no new
`CausalRelation` variant needed, `belongs_to` already covers this shape.

## 2. Two budgets, two gates — do not conflate them (Finding C)

| | Gate 1 — application budget | Gate 2 — operating-spend circuit breaker |
|---|---|---|
| Question | "Can this *Issue*, given its estimated cost, still proceed?" | "Can the *company* safely spend more real AI-compute money right now?" |
| Data | `Company.budget` / `Issue.budgetImpact` (already shipped, `DOMAIN-MODEL.md` §1.1/§1.4) | ruClip's own `ruclip-cost-tracking` namespace, modeled on `ruflo-cost-tracker`'s shape (§4) |
| Scope | Per-Issue, per-Company | Whole-company, checked once per heartbeat firing regardless of which Issue |
| Owner | ruClip's own schema/adapter — no external dependency | Mirrors `ruflo-cost-tracker`'s alert ladder, but ruClip-owned data |

A heartbeat firing checks **both**, in order (§3 step 2), and either one
failing blocks the wake — they're AND'ed, not alternatives.

## 3. Firing sequence (`fireHeartbeat`)

Pure orchestration function, one call per due `HeartbeatSchedule`:

```
fireHeartbeat(schedule: HeartbeatSchedule, config?): Promise<{ schedule: HeartbeatSchedule; outcome: HeartbeatOutcome }>
```

1. Recall the target `Issue` (or `Goal`) and its `Company`.
2. **Gate 1**: if `target.kind === 'issue'` and `issue.budgetImpact > 0`,
   check `company.budget.spent + issue.budgetImpact <= company.budget.total
   * company.budget.hardStopThreshold`. (`target.kind === 'goal'` checks
   the analogous `Goal.budgetAllocation` against the same company budget
   when set; when unset, Gate 1 passes trivially — a goal-level heartbeat
   with no allocation isn't this gate's concern.) On failure: set
   `lastOutcome: 'application_budget_blocked'`, `status: 'paused'` (fail
   closed — a human must explicitly resume, matching the hard-stop
   philosophy `DOMAIN-MODEL.md` §1.1 already states for `Company.budget`),
   publish a `heartbeat-budget-blocked` notification (§5), return early.
   **No wake happens.**
3. **Gate 2**: call `checkOperatingBudget(companyId, config)` (§4). On
   `HARD_STOP`: same as step 2 — `operating_budget_blocked`, pause,
   notify, return early.
4. Both gates passed: publish a `heartbeat-fired` notification addressed to
   `schedule.assigneeId` (§5) — this *is* the wake. For an `OrgMember` of
   `kind: 'agent'`, the assignee's own agent loop is expected to be
   consuming this channel and picks up the "please check on Issue X" event;
   for `kind: 'human'`, the notification itself is the entire interaction
   — ruClip does not spawn anything on a human's behalf.
5. `persistHeartbeatSchedule` with `lastFiredAt: now`, `lastOutcome: 'ok'`,
   `nextFireAt: now + cadenceSeconds * 1000`.

Steps 2-3 run **before** step 4 unconditionally — a blocked heartbeat never
reaches the point of waking anyone, and blocking always pauses rather than
silently skipping-and-retrying-next-cycle, so a stuck budget doesn't produce
a silent, repeating no-op forever.

## 4. `checkOperatingBudget` — ruClip's own circuit breaker (Finding C)

Mirrors `ruflo-cost-tracker`'s alert-ladder *shape* (50/75/90/100%,
`OK|INFO|WARNING|CRITICAL|HARD_STOP`), but reads/writes ruClip's **own**
namespace, `ruclip-cost-tracking`, via `memory_store`/`memory_retrieve`/
`memory_list` (the real MCP tools, confirmed live schemas above) through the
same `bridge-client.ts` `callTool` this repo already has — not the shared
`cost-tracking` namespace `ruflo-cost-tracker` itself uses, which may be
tracking unrelated development spend on whatever bridge instance is
running. Deliberately separate: ruClip is its own "company" with its own
agent-employee operating spend, distinct from the cost of whoever is
developing ruClip.

```
checkOperatingBudget(companyId: string, config?): Promise<{ level: 'OK'|'INFO'|'WARNING'|'CRITICAL'|'HARD_STOP'; utilizationPct: number }>
```

- Reads `ruclip-cost-tracking:{companyId}:budget-config` (a
  `{ budgetUsd, thresholds: {info:.5, warning:.75, critical:.9,
  hardStop:1} }` record — same threshold defaults as `ruflo-cost-tracker`'s,
  no reason to diverge) via `memory_retrieve`.
- **Using `memory_store`'s real `upsert: true` default (confirmed live
  schema) rather than `budget.mjs`'s timestamp-stamping workaround.**
  `budget.mjs`'s `budget-config-<timestamp>` + "pick the lexicographically
  latest" dance exists to work around a UNIQUE-constraint quirk specific to
  the `@claude-flow/cli` CLI's own memory-store code path. The
  `memory_store` **MCP tool** ruClip calls documents plain upsert semantics
  on repeated writes to the same key — so `checkOperatingBudget`'s
  companion `setOperatingBudget` can simply `memory_store({key:
  'ruclip-cost-tracking:{companyId}:budget-config', value, upsert: true})`
  directly, no stamping/index-of-latest needed. If this assumption proves
  wrong against a live bridge (the same category of surprise Finding 2 in
  the claims_* slice was), that's a signal to adopt the stamping workaround
  here too — not to silently assume it.
- Sums `total_cost_usd` across `ruclip-cost-tracking:{companyId}:session-*`
  records via `memory_list({namespace: 'ruclip-cost-tracking'})` filtered
  client-side by key prefix — mirrors `budget.mjs`'s `loadSessions`.
  **Precondition, documented not assumed**: these `session-*` records must
  be populated by *something* in the deployment (e.g. a `ruflo-cost-tracker`
  Stop-hook, or a bespoke ruClip equivalent) — `checkOperatingBudget` only
  *reads* them, it does not produce them. If nothing populates this
  namespace, `checkOperatingBudget` degrades to `OK` with `utilizationPct:
  0` (no data means no known problem, not a hard failure) — matching
  `budget.mjs check`'s own "no budget configured" non-alerting path.
- Applies the exact same threshold table `alertLevel()` in `budget.mjs`
  uses (50/75/90/100%).

## 5. Comms seam

```typescript
export type NotificationKind =
  | 'heartbeat-fired'
  | 'heartbeat-budget-blocked'
  | 'issue-approval-transition'
  | 'budget-threshold-crossed';

export interface NotificationEvent {
  kind: NotificationKind;
  companyId: string;
  /** e.g. "issue:{issueId}" or "heartbeat:{heartbeatId}" */
  subjectRef: string;
  payload: Record<string, unknown>;
  occurredAt: string; // ISO 8601
}

export interface NotificationChannel {
  publish(event: NotificationEvent): Promise<{ delivered: boolean; degraded?: boolean }>;
}
```

`degraded: true` (never a thrown error) is the contract for "the backend is
unavailable" — matching `federation_bbs_*`'s own `{degraded: true}`
graceful-degradation shape and the wider ADR-150 "removable, optional peer"
architecture this repo already follows. **Callers of `publish` must never
let a `degraded`/failed notification block the underlying domain
operation** — `fireHeartbeat` (§3) and `applyApprovalTransition`
(`APPROVAL-GATE.md` §4, extended below) treat comms as best-effort;
losing a notification is not grounds for failing an approval decision or a
budget check that already succeeded/failed on its own terms.

### AgentBBS-backed channel (implemented this slice — real tools)

```
AgentBbsNotificationChannel implements NotificationChannel
```

- One-time setup per company: `federation_bbs_register({roomLabel:
  '#ruclip-{companyId}'})` → a `roomId`, persisted as a small AgentDB config
  record `ruclip:company:{companyId}:comms-room` (`{roomId, roomLabel,
  registeredAt}`) — **not** added as a field on `Company` itself, to avoid
  touching the already-shipped `Company` interface for what's an
  infrastructure-wiring detail, not a domain fact.
- `NotificationKind → msgType` mapping, respecting `federation_bbs_publish`'s
  real, closed `msgType` vocabulary (`pod-status | task-result | alert |
  human-override-ack | bench-result`):

  | `NotificationKind` | `msgType` |
  |---|---|
  | `heartbeat-fired` | `pod-status` — routine, non-alarming |
  | `heartbeat-budget-blocked` | `alert` |
  | `issue-approval-transition` | `alert` — a human/approver needs to see every decision |
  | `budget-threshold-crossed` | `alert` |

- `publish()` calls `federation_bbs_publish({roomId, msgType, payload:
  event.payload})`. When the tool result carries `degraded: true` (the
  optional `agentbbs` dependency isn't installed), returns `{delivered:
  false, degraded: true}` rather than throwing.
- `federation_bbs_human_join({roomId, ttlSeconds})` is exposed as a
  separate helper (`mintHumanCommsAccess`) for when an operator needs
  scoped, time-limited access to the room — not auto-called by the
  heartbeat/approval flows.

### AgentRadio-backed channel (interface-only, NOT implemented — Finding D)

```
AgentRadioNotificationChannel implements NotificationChannel
```

Stub that returns `{ delivered: false, degraded: true }` unconditionally,
with a comment explaining why — no fabricated API calls. Whoever wires this
for real needs to (a) locate an actual `ruvnet/autogenous` checkout or
published `packages/radio-moe` artifact, (b) read its real interface the
same way this document read `claims-tools.ts`/`budget.mjs`, (c) implement
this class against that real interface, not this stub. Tracked as an open
item in §7.

### Which channel is used this slice

Both implement the same `NotificationChannel` interface, so a future
`CompositeNotificationChannel` (try AgentRadio, fall back to agentbbs) can
be introduced without touching any call site — but for *this* slice, since
AgentRadio has no real implementation, `AgentBbsNotificationChannel` is
the one actually constructed and passed to `fireHeartbeat`/
`applyApprovalTransition`. This is the deviation from the brief's
"AgentRadio primary" framing, made explicit rather than papered over.

### Wiring into the approval gate (additive to `APPROVAL-GATE.md`)

`applyApprovalTransition` (already shipped) gains one more optional
dependency, following the exact same injection pattern `deps.witness`
already uses:

```
deps: { witness?: WitnessHook; notifications?: NotificationChannel; reason?: string; approver?: OrgMember; handoffTo?: OrgMember }
```

After a transition is persisted (after `APPROVAL-GATE.md` §4 step 5), if
`deps.notifications` is supplied, publish an `issue-approval-transition`
event with `payload: { issueId, action, fromState, toState, actorId }`.
Omitted the same way `deps.witness` can be omitted — no behavior change to
existing callers that don't pass it.

## 6. Authorization: reuse, don't reinvent

Creating, pausing, or resuming a `HeartbeatSchedule` requires the acting
`OrgMember` to currently hold a live claim on the target `Issue`/`Goal` —
this reuses `verifyActorHoldsClaim` from
`authorization/claims-authorization.ts` (`AUTHORIZATION.md` §3) directly, no
new authorization machinery. `persistHeartbeatSchedule` calls it the same
way `persistIssue`'s Guard C does, before any write. This is the one place
this slice touches the authorization layer, and it's pure reuse.

## 7. What Phase 1e (coder) implements

- `src/control-plane/schema/heartbeat-schedule.ts` — `HeartbeatTarget`,
  `HeartbeatStatus`, `HeartbeatOutcome`, `HeartbeatSchedule` per §1, plus
  `assertValidHeartbeatSchedule` in `schema/validation.ts` (structural only,
  same boundary the existing `assertValid*` functions keep).
- `src/control-plane/schema/notification.ts` — `NotificationKind`,
  `NotificationEvent`, `NotificationChannel` per §5.
- `src/control-plane/heartbeat/fire-heartbeat.ts` — `fireHeartbeat` per §3
  (orchestration: recall target + company, run both gates, publish,
  persist).
- `src/control-plane/store/agentdb-adapter.ts` — `heartbeatKey` (following
  the existing key-builder pattern), `persistHeartbeatSchedule` /
  `recallHeartbeatSchedule` / `listDueHeartbeats` (`nextFireAt <= now`,
  `status === 'active'` — needs a scan; exact AgentDB query shape is a
  known open question, see below), `checkOperatingBudget` /
  `setOperatingBudget` per §4.
- `src/control-plane/comms/agentbbs-notification-channel.ts` — real
  implementation per §5.
- `src/control-plane/comms/agentradio-notification-channel.ts` — stub per
  §5.
- `applyApprovalTransition` in `store/agentdb-adapter.ts` — add
  `deps.notifications` per §5's approval-gate wiring.
- **Open question, needs resolving during implementation, not guessed
  here**: `listDueHeartbeats`'s "all active schedules with `nextFireAt <=
  now`" is a range/scan query, not an exact-key recall or a k-hop graph
  walk — neither of which is what `agentdb_hierarchical-recall` (semantic/
  BM25 search, per the existing adapter's own header comment) or
  `agentdb_graph-query` (relation-filtered k-hop) are built for. Check
  whether `agentdb_hierarchical-recall`'s `query` can usefully search on a
  structured field like this, or whether the practical answer is: the
  heartbeat-loop session lists all `HeartbeatSchedule` keys via
  `agentdb_pattern-search`/a broader recall and filters `nextFireAt`
  client-side (small-N acceptable at this scale, same as `budget.mjs`'s own
  `loadSessions` client-side filtering). Don't invent a query capability
  that hasn't been confirmed against the real tool schemas — same
  discipline as Findings A-D above.
- **The scheduler loop itself** (whatever periodically calls
  `listDueHeartbeats` + `fireHeartbeat` for each due schedule) is explicitly
  **not** designed here in detail, given Finding B: it's a
  `/loop`-style in-session cache-aware pattern (or a `CronCreate` job while
  a session is alive) for the active-session case, with the AgentDB-backed
  `nextFireAt` as the durable state that survives the loop itself
  restarting — implement the simplest version that re-derives due
  heartbeats from AgentDB on wake rather than trusting any cron job's own
  memory. `dream-machine`'s already-integrated nightly infra (`PLAN.md` §6,
  real GCP-level persistent cron, unlike `CronCreate`) is the natural
  long-term durable backstop for "no active session" — cross-referenced
  here, not wired this slice (scope note, matches how `WitnessHook`'s real
  implementation was deferred in `APPROVAL-GATE.md`).
- Tests: Gate 1 blocking (with/without `budgetImpact`), Gate 2 blocking
  (`HARD_STOP` from a synthetic `ruclip-cost-tracking` state), both gates
  passing → wake published, pause-on-block (not silent skip), degraded
  comms never throwing/blocking the domain operation, the `NotificationKind
  → msgType` mapping, `verifyActorHoldsClaim` reuse on schedule
  create/pause/resume, and the `AgentRadioNotificationChannel` stub
  returning `degraded: true` rather than being silently skipped in tests.

Please implement verbatim — if `listDueHeartbeats`'s query shape or
`memory_store`'s upsert assumption (§4) turns out wrong against a real
bridge, that's a signal to come back to this document, not to silently
diverge, same convention as every prior slice.
