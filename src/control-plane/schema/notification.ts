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
