import type { ApprovalState } from './enums.js';

export type ApprovalAction = 'submit' | 'approve' | 'reject' | 'revise';

export interface ApprovalTransition {
  id: string;
  issueId: string;
  action: ApprovalAction;
  fromState: ApprovalState;
  toState: ApprovalState;
  /** OrgMember.id of whoever made this decision. */
  actorId: string;
  /** Required (non-null, non-empty) when action === 'reject'; optional otherwise. */
  reason: string | null;
  createdAt: string; // ISO 8601
  /**
   * WitnessEntryRef.id once a WitnessHook is wired and this transition has
   * been witnessed. Null when no WitnessHook was supplied at persist time
   * (expected in v1 — no witness client exists yet, see witness.ts and
   * APPROVAL-GATE.md §5) — this is a tracked gap, not a silently accepted
   * one.
   */
  witnessRef: string | null;
  // Immutable once written — no updatedAt, no edit/delete, same as Comment.
}
