import type { ApprovalState, IssueStatus } from './enums.js';

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
