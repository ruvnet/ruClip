# ruClip Domain Model — Company → Goals → Issues

Status: design (Phase 1a, no implementation yet — see `docs/PLAN.md` §8 Phase 1)
Scope: ADR-0001 §3 point 3 / PLAN.md §3.3, §4 — the one genuinely new schema
this project needs. This document defines the entities, their invariants,
and how each maps onto AgentDB primitives (`v3/@claude-flow/memory` — the
`agentdb_*` MCP tools). It does not introduce a new database: every entity
below is a document/record living inside AgentDB's existing stores.

Downstream concerns (explicitly out of scope here, consumers of the fields
this model exposes):
- Budget-gated heartbeats (`ruflo-loop-workers` + `ruflo-cost-tracker`) —
  consumes `Company.budget` and `Issue.budgetImpact`.
- Approval gates (`claims_handoff` / `claims_accept-handoff`) — consumes
  `Issue.approvalState`.
- Signed audit trail (`witness`, ADR-103) — every state transition described
  below is expected to produce a witness entry; the entry format is not
  defined here.

## 1. Entities

### 1.1 Company

A Company is the root of the org chart and the budget. It tracks exactly one
north-star `Goal` (`primaryGoalId`) but a company accrues many `Goal`s over
its lifetime — `Goal.companyId` is the many-side of the relationship.

Fields: `id`, `name`, `primaryGoalId`, `budget` (total / spent / currency /
period / hardStopThreshold), `status` (`forming | active | paused |
dissolved`), `createdAt`, `updatedAt`.

Invariants:
- Exactly one `OrgMember` with `managerId = null` per company (the root —
  "CEO," human or agent) — enforced at org-chart write time, not by AgentDB.
- `budget.spent <= budget.total` at all times; a write that would violate
  this is rejected before it reaches AgentDB (budget-gated heartbeats own
  the enforcement, this model just carries the fields).
- `primaryGoalId`, once set, must reference a `Goal` with `companyId ===
  this.id`.

### 1.2 OrgMember

The org hierarchy is a flat table of members with a `managerId` pointer
rather than a nested tree — this is what lets membership be mixed
human/agent and lets the hierarchy be walked via AgentDB causal edges
instead of an application-level tree structure.

Fields: `id`, `companyId`, `kind` (`agent | human`), `identityRef` (a
ruflo Agent Teams name for `kind: agent`, or a claims/BBS identity string
for `kind: human`), `role` (title), `managerId` (nullable — null only for
the single root member), `status` (`active | inactive`).

Invariants:
- `managerId`, when set, must reference another `OrgMember` with the same
  `companyId`.
- No cycles in the `managerId` chain (an org chart is a tree, not a graph)
  — enforced by refusing a causal-edge write that would close a cycle (see
  §2.3).

### 1.3 Goal

Fields: `id`, `companyId`, `description`, `successCriteria` (string array —
each entry is a single checkable condition), `status` (`proposed | active |
achieved | abandoned`), `ownerId` (nullable `OrgMember.id`, the member
accountable for the goal), `budgetAllocation` (nullable — a carve-out of
`Company.budget.total`), `createdAt`, `updatedAt`.

Invariants:
- `budgetAllocation`, if set, must not exceed the parent company's
  `budget.total`; the sum of all non-abandoned goals' `budgetAllocation`
  for one company should not exceed `budget.total` (soft invariant —
  advisory, enforced by the budget-gated heartbeat downstream, not by this
  schema layer).
- A goal can only move to `achieved` when every `successCriteria` entry is
  satisfied — satisfaction bookkeeping is out of scope for this model
  (candidate: a future `SuccessCriterionCheck` record, not needed for
  Phase 1).

### 1.4 Issue

The highest-churn entity, and the one with real graph structure
(parent/child, blockers). Belongs to exactly one `Goal`.

Fields: `id`, `goalId`, `parentId` (nullable `Issue.id`), `assigneeId`
(nullable `OrgMember.id` — single assignee, agent or human, per ADR-0001),
`title`, `description`, `status` (`open | in_progress | blocked | done |
cancelled`), `approvalState` (`draft | pending | approved | rejected` — see
§3 for the transition diagram), `budgetImpact` (number, USD — the cost this
issue is expected/known to consume; feeds the budget-gated heartbeat's
hard-stop check), `createdAt`, `updatedAt`, `closedAt` (nullable).

`childIds` and `blockedByIds` are **not** stored fields on `Issue` — they
are derived by querying causal edges (§2.3) at read time. Storing them
redundantly on the document would let the edge graph and the document
tier drift out of sync; AgentDB's `graph-query`/`graph-pathfinder` tools
exist precisely so this denormalization isn't necessary.

Invariants:
- `parentId !== id` (no self-parenting).
- No cycles in the `parentId` chain (an issue tree, not a graph) — same
  enforcement approach as OrgMember §1.2.
- An issue cannot reach `status: in_progress` or `status: done` while it
  has an open `blocks` causal edge pointing at it from an `Issue` whose own
  `status !== done` (i.e., you cannot progress a blocked issue).
- An issue cannot reach `status: done` unless `approvalState === approved`
  when `budgetImpact > 0` — issues with no budget impact may close without
  an approval gate. This is the load-bearing link between this schema and
  the downstream approval-gate/claims_handoff mechanism named in the task.
- `budgetImpact`, once an issue is `approved`, is treated as committed
  spend for the purposes of `Company.budget.spent` bookkeeping (bookkeeping
  itself is downstream, not this model).

### 1.5 Comment

A flat, append-only list scoped to one `Issue`. Modeled as its own record
type (not an inline array on `Issue`) so high-comment-volume issues don't
bloat the issue document that budget/approval logic reads on every check.

Fields: `id`, `issueId`, `authorId` (`OrgMember.id`), `body`, `createdAt`.

Invariants: immutable once written (no edit/delete in v1 — matches the
audit-trail-completeness goal in PLAN.md §5's build-time genome).

## 2. AgentDB mapping

Three AgentDB primitives are used, matching the task's framing: the
hierarchical-store tiers for the entity documents themselves, causal edges
for the graph-shaped relationships (Issue↔Issue, Issue↔Goal, Goal↔Company,
OrgMember↔OrgMember), and pattern-store for organizational heuristics that
should be searchable/reusable rather than looked up by exact key.

### 2.1 Hierarchical-store tier assignment

AgentDB's tiers (`agentdb_hierarchical-store` / `agentdb_hierarchical-recall`)
are `working` (active, fast-changing context), `episodic` (a record of a
completed event/experience), and `semantic` (durable structured facts).
Mapping:

| Entity / state | Tier | Why |
|---|---|---|
| `Company` | `semantic` | Structural, low-churn, referenced by everything else. |
| `OrgMember` | `semantic` | Org chart changes rarely relative to issue churn. |
| `Goal` | `semantic` | Structural; status changes are infrequent, milestone-level events. |
| `Issue` with `status ∈ {open, in_progress, blocked}` | `working` | Actively mutated — comments, assignee changes, approval churn. This is the "hot" working set a heartbeat or dashboard polls. |
| `Issue` with `status ∈ {done, cancelled}` | `episodic` | Once closed, an issue becomes a record of a completed episode — read for history/audit/dream-machine ledger rows, not mutated. |
| `Comment` | attached to its `Issue`'s current tier (moves `working → episodic` when the parent issue closes, in the same write that closes it) | Comments are cheap context for an active issue; once the issue is closed they're part of the historical record. |

An issue's tier therefore changes exactly once in its lifecycle — on the
`in_progress|blocked|open → done|cancelled` transition, the write that
closes the issue also re-stores it (and its comments) into the `episodic`
tier and removes it from `working`. This is a single extra
`agentdb_hierarchical-store` call at close time, not a background sweep.

### 2.2 Keying

Hierarchical-store keys are namespaced by company to keep multi-company
recall scoped correctly (ruClip's v1 target is one company, but the schema
should not assume that):

```
ruclip:company:{companyId}
ruclip:company:{companyId}:org-member:{orgMemberId}
ruclip:company:{companyId}:goal:{goalId}
ruclip:company:{companyId}:goal:{goalId}:issue:{issueId}
ruclip:company:{companyId}:goal:{goalId}:issue:{issueId}:comment:{commentId}
```

### 2.3 Causal edges

`agentdb_causal-edge` relation types used, all directed:

| Relation | From → To | Meaning |
|---|---|---|
| `belongs_to` | `Goal → Company` | Goal is scoped to this company. |
| `belongs_to` | `Issue → Goal` | Issue is scoped to this goal. |
| `parent_of` | `Issue → Issue` | Parent/child issue hierarchy (query children via inverse traversal). |
| `blocks` | `Issue → Issue` | Source issue blocks target issue from progressing (§1.4 invariant). |
| `assigned_to` | `Issue → OrgMember` | Single-assignee link — modeled as an edge (not just a foreign-key field) so "all issues assigned to member X" is a graph query, not a table scan. |
| `reports_to` | `OrgMember → OrgMember` | Org-chart hierarchy; walked with `agentdb_graph-pathfinder` to answer "who is in this member's management chain." |
| `approved_by` / `rejected_by` | `Issue → OrgMember` | Written at the moment `approvalState` transitions to `approved`/`rejected` (§3) — the accountability trail the build-time genome's "approval-gate enforcement" check verifies. |

Cycle prevention for `parent_of` (Issues) and `reports_to` (OrgMembers) is
enforced at write time by running `agentdb_graph-pathfinder` from the
proposed target back to the proposed source before committing the edge —
if a path exists, the edge would close a cycle and the write is rejected.

`agentdb_graph-query` is the read side: "children of issue X," "who does
member Y report to," "everything blocking issue Z" are all graph queries
over these edges rather than fields resolved from the document tier.

### 2.4 Pattern-store

`agentdb_pattern-store` / `agentdb_pattern-search` hold reusable,
fuzzy-searchable organizational knowledge — not individual entity records.
Namespaces:

| Namespace | Contents |
|---|---|
| `ruclip/org-chart` | Recurring role/reporting-line templates (e.g. "new agent hire under role X reports to Y") the org-chart bootstrap can search for instead of hand-authoring every time. |
| `ruclip/issue-templates` | Common issue shapes (title/description/budgetImpact skeletons) surfaced when creating a new issue under a recognized goal type. |
| `ruclip/approval-heuristics` | Learned patterns of what tends to get approved/rejected for a given budget-impact bracket — read by the approval-gate flow as advisory context, never as the decision itself (the decision stays with `claims_accept-handoff`). |

Pattern-store entries are advisory context, not authoritative state — they
never gate a transition on their own, matching the flywheel/dream-machine
"evaluation is not promotion" invariant this repo already applies elsewhere
(ADR-0001 §2).

## 3. Issue.approvalState transitions

```
        submit
 draft ────────► pending
   ▲                │  │
   │  revise        │  │
   └────────────────┘  │
     (on reject)        │ approve          reject
                         ├─────────► approved   (terminal — issue may
                         │                        proceed to done)
                         └─────────► rejected
                                        │
                                        │ (author revises)
                                        ▼
                                      draft
```

States:
- `draft` — being authored; not yet submitted for approval. Default state
  for a newly created `Issue` with `budgetImpact > 0`. Issues with
  `budgetImpact === 0` may skip straight to an implicit `approved` (no gate
  needed) — modeled as the same enum value for schema simplicity, set at
  creation time rather than via a transition.
- `pending` — submitted, awaiting a decision via `claims_handoff` /
  `claims_accept-handoff`. Writes an `approved_by`/`rejected_by`-pending
  marker; no edge yet.
- `approved` — terminal for the approval concern. Writes an `approved_by`
  causal edge to the deciding `OrgMember`. Unblocks the `status → done`
  transition (§1.4).
- `rejected` — writes a `rejected_by` causal edge to the deciding
  `OrgMember`. Not terminal — the issue returns to `draft` for revision
  and can be resubmitted. `rejected` issues cannot reach `status: done`
  while in this state.

Only `draft → pending`, `pending → approved`, `pending → rejected`, and
`rejected → draft` are valid transitions. `approved → *` is not a valid
transition in v1 (re-opening an approved, budget-committed issue is a
Phase 2+ concern — out of scope here).

## 4. What Phase 1b (coder) implements verbatim

`src/control-plane/schema/types.md` in this same commit carries the
concrete TypeScript interfaces for `Company`, `OrgMember`, `Goal`, `Issue`,
`Comment`, and the enum/union types referenced above. The coder stage
should implement those signatures as real `.ts` files without renegotiating
field names or shapes — if a field genuinely doesn't work during
implementation, that's a signal to come back to this document, not to
silently diverge.
