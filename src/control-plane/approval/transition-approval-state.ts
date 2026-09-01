/**
 * Pure approval-state-machine function (APPROVAL-GATE.md §2). No I/O, no
 * AgentDB calls, no witness call — the orchestration layer
 * (store/agentdb-adapter.ts's applyApprovalTransition) is what wires this to
 * persistence and the witness hook.
 */
import { randomUUID } from 'node:crypto';
import type { Issue } from '../schema/issue.js';
import type { OrgMember } from '../schema/org-member.js';
import type { ApprovalAction, ApprovalTransition } from '../schema/approval-transition.js';
import type { ApprovalState } from '../schema/enums.js';

export class IllegalApprovalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalApprovalTransitionError';
  }
}

/** The only four legal (action, fromState) -> toState rows, APPROVAL-GATE.md §1. */
const LEGAL_TRANSITIONS: ReadonlyArray<{ action: ApprovalAction; fromState: ApprovalState; toState: ApprovalState }> = [
  { action: 'submit', fromState: 'draft', toState: 'pending' },
  { action: 'approve', fromState: 'pending', toState: 'approved' },
  { action: 'reject', fromState: 'pending', toState: 'rejected' },
  { action: 'revise', fromState: 'rejected', toState: 'draft' },
];

/**
 * Recomputes whether (action, fromState) -> toState is one of the legal
 * rows, without needing an actor/previousTransition. Used by
 * store/agentdb-adapter.ts's persistIssue Guard A as defense in depth
 * against a forged ApprovalTransition object that never went through
 * transitionApprovalState (APPROVAL-GATE.md §3).
 */
export function isLegalApprovalTransition(
  action: ApprovalAction,
  fromState: ApprovalState,
  toState: ApprovalState,
): boolean {
  return LEGAL_TRANSITIONS.some((row) => row.action === action && row.fromState === fromState && row.toState === toState);
}

export interface TransitionApprovalStateOptions {
  reason?: string;
  now?: () => string;
}

export interface TransitionApprovalStateResult {
  nextIssue: Issue;
  transition: ApprovalTransition;
}

function defaultNow(): string {
  return new Date().toISOString();
}

export function transitionApprovalState(
  issue: Issue,
  action: ApprovalAction,
  actor: OrgMember,
  previousTransition: ApprovalTransition | null,
  opts?: TransitionApprovalStateOptions,
): TransitionApprovalStateResult {
  const legalRow = LEGAL_TRANSITIONS.find(
    (row) => row.action === action && row.fromState === issue.approvalState,
  );
  if (!legalRow) {
    throw new IllegalApprovalTransitionError(
      `Illegal approval transition: action '${action}' from state '${issue.approvalState}' — ` +
        `only ${LEGAL_TRANSITIONS.map((r) => `${r.action}:${r.fromState}->${r.toState}`).join(', ')} are legal`,
    );
  }

  const reason = opts?.reason?.trim() || undefined;
  if (action === 'reject' && !reason) {
    throw new IllegalApprovalTransitionError('reject requires a non-empty reason');
  }

  if (actor.status !== 'active') {
    throw new IllegalApprovalTransitionError(
      `Actor '${actor.id}' cannot record an approval decision while status is '${actor.status}' (must be 'active')`,
    );
  }

  if (action === 'approve' || action === 'reject') {
    // The only way to reach 'pending' is a 'submit' transition, so
    // previousTransition is always well-defined here when the row above
    // matched — issue.approvalState === 'pending' cannot be reached any
    // other way per LEGAL_TRANSITIONS.
    if (!previousTransition) {
      throw new IllegalApprovalTransitionError(
        `Cannot ${action} issue '${issue.id}': no previousTransition (submit record) supplied for a pending issue`,
      );
    }
    if (actor.id === previousTransition.actorId) {
      throw new IllegalApprovalTransitionError(
        `Actor '${actor.id}' submitted this issue for approval and cannot also ${action} it (self-approval)`,
      );
    }
  }

  const now = (opts?.now ?? defaultNow)();
  const transition: ApprovalTransition = {
    id: randomUUID(),
    issueId: issue.id,
    action,
    fromState: legalRow.fromState,
    toState: legalRow.toState,
    actorId: actor.id,
    reason: reason ?? null,
    createdAt: now,
    witnessRef: null,
  };

  const nextIssue: Issue = {
    ...issue,
    approvalState: legalRow.toState,
    approvalTransitionRef: transition.id,
    updatedAt: now,
  };

  return { nextIssue, transition };
}
