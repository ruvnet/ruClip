/**
 * Seam for ADR-103's signed-manifest pattern. This control plane is a
 * witness *consumer*, not a reimplementation — no client exists yet, see
 * APPROVAL-GATE.md §5.
 */
export type WitnessEventType =
  | 'ruclip.issue.approval_transition'
  | 'ruclip.issue.status_transition'; // reserved — no call site yet, see APPROVAL-GATE.md §5

export interface WitnessEntryInput {
  /** Stable identifier for the entity/event being witnessed, e.g. "issue:{issueId}:approval-transition:{transitionId}". */
  subject: string;
  eventType: WitnessEventType;
  /** Canonical JSON-serializable payload the signature covers. */
  payload: Record<string, unknown>;
  /** ISO 8601 — the event's own timestamp, not signing time. */
  occurredAt: string;
}

export interface WitnessEntryRef {
  /** Opaque id/hash the witness manifest assigns; stored back as ApprovalTransition.witnessRef. */
  id: string;
}

export interface WitnessHook {
  record(entry: WitnessEntryInput): Promise<WitnessEntryRef>;
}
