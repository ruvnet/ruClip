import type { CompanyStatus } from './enums.js';

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
