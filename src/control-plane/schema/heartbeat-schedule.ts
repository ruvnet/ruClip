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
  nextFireAt: string; // ISO 8601 — the durable source of truth, see HEARTBEATS-AND-COMMS.md Finding B
  lastFiredAt: string | null; // ISO 8601
  lastOutcome: HeartbeatOutcome | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
