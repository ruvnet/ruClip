# Company / Goal / Issue — interface signatures

Status: design (Phase 1a). These are the exact interfaces the coder stage
(Phase 1b) implements as real `.ts` files under `src/control-plane/schema/`.
Field names, types, and nullability here are load-bearing — see
`docs/design/DOMAIN-MODEL.md` for the invariants and AgentDB mapping that
justify each shape. Do not add fields not described there without going
back to the domain model first.

Suggested file split for implementation: `company.ts`, `org-member.ts`,
`goal.ts`, `issue.ts`, `comment.ts`, `enums.ts`, `index.ts` (barrel).
`childIds` / `blockedByIds` are deliberately absent from `Issue` — see
DOMAIN-MODEL.md §1.4 — they're derived via causal-edge graph queries, not
stored fields.

## enums.ts

```typescript
export type CompanyStatus = 'forming' | 'active' | 'paused' | 'dissolved';

export type OrgMemberKind = 'agent' | 'human';

export type OrgMemberStatus = 'active' | 'inactive';

export type GoalStatus = 'proposed' | 'active' | 'achieved' | 'abandoned';

export type IssueStatus =
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type ApprovalState = 'draft' | 'pending' | 'approved' | 'rejected';

/** agentdb_causal-edge relation types used by this schema (DOMAIN-MODEL.md §2.3). */
export type CausalRelation =
  | 'belongs_to'
  | 'parent_of'
  | 'blocks'
  | 'assigned_to'
  | 'reports_to'
  | 'approved_by'
  | 'rejected_by';

/** agentdb_hierarchical-store tiers this schema writes into (DOMAIN-MODEL.md §2.1). */
export type MemoryTier = 'working' | 'episodic' | 'semantic';
```

## company.ts

```typescript
import type { CompanyStatus } from './enums';

export interface Budget {
  total: number;
  spent: number;
  currency: string;
  /** ISO 8601 period this budget figure covers, e.g. "2026-09" for monthly. */
  period: string;
  /** Fraction of `total` (0-1) at which the budget-gated heartbeat hard-stops new spend. */
  hardStopThreshold: number;
}

export interface Company {
  id: string;
  name: string;
  /** North-star Goal.id; must reference a Goal with companyId === this.id. */
  primaryGoalId: string | null;
  budget: Budget;
  status: CompanyStatus;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
```

## org-member.ts

```typescript
import type { OrgMemberKind, OrgMemberStatus } from './enums';

export interface OrgMember {
  id: string;
  companyId: string;
  kind: OrgMemberKind;
  /**
   * For kind: 'agent' — a ruflo Agent Teams SendMessage-addressable name.
   * For kind: 'human' — a claims/BBS identity string.
   */
  identityRef: string;
  role: string;
  /** OrgMember.id of this member's manager. Null only for the single root member. */
  managerId: string | null;
  status: OrgMemberStatus;
}
```

## goal.ts

```typescript
import type { GoalStatus } from './enums';

export interface Goal {
  id: string;
  companyId: string;
  description: string;
  /** Each entry is one independently checkable success condition. */
  successCriteria: string[];
  status: GoalStatus;
  /** OrgMember.id accountable for this goal. */
  ownerId: string | null;
  /** Carve-out of Company.budget.total; must not exceed it. */
  budgetAllocation: number | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
```

## issue.ts

```typescript
import type { ApprovalState, IssueStatus } from './enums';

export interface Issue {
  id: string;
  goalId: string;
  /** Parent Issue.id, or null for a top-level issue. Must not equal `id`. */
  parentId: string | null;
  /** Single assignee — agent or human OrgMember. Null while unassigned/backlog. */
  assigneeId: string | null;
  title: string;
  description: string;
  status: IssueStatus;
  approvalState: ApprovalState;
  /**
   * Expected/known USD cost. Issues with budgetImpact === 0 may be created
   * with approvalState: 'approved' directly (no gate needed) — see
   * DOMAIN-MODEL.md §3. Issues with budgetImpact > 0 must pass through
   * draft -> pending -> approved before status can reach 'done'.
   */
  budgetImpact: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  closedAt: string | null; // ISO 8601, set on status -> done | cancelled
}
```

## comment.ts

```typescript
export interface Comment {
  id: string;
  issueId: string;
  /** OrgMember.id of the author — agent or human. */
  authorId: string;
  body: string;
  createdAt: string; // ISO 8601
  // Immutable once written — no updatedAt, no edit/delete in v1.
}
```

## index.ts (barrel — implement last)

```typescript
export * from './enums';
export * from './company';
export * from './org-member';
export * from './goal';
export * from './issue';
export * from './comment';
```
