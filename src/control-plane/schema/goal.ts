import type { GoalStatus } from './enums.js';

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
