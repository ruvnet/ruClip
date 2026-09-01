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
  /**
   * Frozen once the stored issue's approvalState leaves 'draft' — a write
   * that changes budgetImpact while stored.approvalState is pending,
   * approved, or rejected is rejected by persistIssue's Guard B. See
   * APPROVAL-GATE.md §3.
   */
  budgetImpact: number;
  /**
   * Id of the ApprovalTransition record that produced the CURRENT
   * approvalState. Null only when approvalState is still 'draft' and has
   * never been submitted, or for the budgetImpact === 0 create-time
   * fast-path (approvalState: 'approved' with no transition). Every other
   * approvalState value requires a matching, persisted ApprovalTransition
   * — see approval-transition.ts and APPROVAL-GATE.md §2-3. This field,
   * not approvalState alone, is what persistIssue's Guard A checks against
   * to reject a direct/forged approvalState write.
   */
  approvalTransitionRef: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  closedAt: string | null; // ISO 8601, set on status -> done | cancelled
}
