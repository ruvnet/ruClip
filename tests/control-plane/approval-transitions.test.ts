/**
 * Issue.approvalState transitions (DOMAIN-MODEL.md §3 / APPROVAL-GATE.md §1:
 * draft -> pending -> approved | rejected, rejected -> draft).
 *
 * Originally this file recorded (via test.todo) that no transition-checking
 * function existed anywhere in src/control-plane — approval-gate enforcement
 * was out of scope for the Phase 1b schema slice. That gap is closed by the
 * Phase 1c slice: src/control-plane/approval/transition-approval-state.ts's
 * pure `transitionApprovalState`, now covered below for every legal and
 * illegal (action, fromState) pair, the reject-requires-reason rule, the
 * inactive-actor rule, and the self-approval invariant.
 *
 * The pre-existing assertValidIssue tests are kept as-is below (still valid:
 * they document that snapshot validation is not transition validation — an
 * Issue constructed directly with approvalState: 'approved' that never
 * passed through 'pending' still passes assertValidIssue, because *reaching*
 * approvalState legally is transitionApprovalState's job, not
 * assertValidIssue's).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidIssue, SchemaValidationError } from '../../src/control-plane/schema/validation.js';
import {
  transitionApprovalState,
  isLegalApprovalTransition,
  IllegalApprovalTransitionError,
} from '../../src/control-plane/approval/transition-approval-state.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { ApprovalAction, ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';
import type { ApprovalState } from '../../src/control-plane/schema/enums.js';

const now = '2026-09-01T00:00:00.000Z';

function baseIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    goalId: 'goal-1',
    parentId: null,
    assigneeId: null,
    title: 'Build login',
    description: '',
    status: 'open',
    approvalState: 'draft',
    budgetImpact: 0,
    approvalTransitionRef: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    ...overrides,
  };
}

function baseActor(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'om-submitter',
    companyId: 'co-1',
    kind: 'agent',
    identityRef: 'agent-team-name',
    role: 'Engineer',
    managerId: null,
    status: 'active',
    ...overrides,
  };
}

function submitTransition(overrides: Partial<ApprovalTransition> = {}): ApprovalTransition {
  return {
    id: 'transition-submit',
    issueId: 'issue-1',
    action: 'submit',
    fromState: 'draft',
    toState: 'pending',
    actorId: 'om-submitter',
    reason: null,
    createdAt: now,
    witnessRef: null,
    ...overrides,
  };
}

// --- isLegalApprovalTransition ----------------------------------------------

test('isLegalApprovalTransition accepts exactly the four rows in APPROVAL-GATE.md §1', () => {
  assert.equal(isLegalApprovalTransition('submit', 'draft', 'pending'), true);
  assert.equal(isLegalApprovalTransition('approve', 'pending', 'approved'), true);
  assert.equal(isLegalApprovalTransition('reject', 'pending', 'rejected'), true);
  assert.equal(isLegalApprovalTransition('revise', 'rejected', 'draft'), true);
});

test('isLegalApprovalTransition rejects every other (action, fromState, toState) combination', () => {
  const actions: ApprovalAction[] = ['submit', 'approve', 'reject', 'revise'];
  const states: ApprovalState[] = ['draft', 'pending', 'approved', 'rejected'];
  const legal = new Set(['submit:draft:pending', 'approve:pending:approved', 'reject:pending:rejected', 'revise:rejected:draft']);
  let illegalCombinationsChecked = 0;
  for (const action of actions) {
    for (const fromState of states) {
      for (const toState of states) {
        const key = `${action}:${fromState}:${toState}`;
        if (legal.has(key)) continue;
        illegalCombinationsChecked += 1;
        assert.equal(isLegalApprovalTransition(action, fromState, toState), false, key);
      }
    }
  }
  assert.ok(illegalCombinationsChecked > 0);
});

// --- transitionApprovalState: happy paths -----------------------------------

test('transitionApprovalState: submit moves draft -> pending and records the transition', () => {
  const issue = baseIssue({ approvalState: 'draft' });
  const actor = baseActor({ id: 'om-submitter' });
  const { nextIssue, transition } = transitionApprovalState(issue, 'submit', actor, null, { now: () => now });
  assert.equal(nextIssue.approvalState, 'pending');
  assert.equal(nextIssue.approvalTransitionRef, transition.id);
  assert.equal(nextIssue.updatedAt, now);
  assert.equal(transition.action, 'submit');
  assert.equal(transition.fromState, 'draft');
  assert.equal(transition.toState, 'pending');
  assert.equal(transition.actorId, 'om-submitter');
  assert.equal(transition.reason, null);
  assert.equal(transition.witnessRef, null);
});

test('transitionApprovalState: approve moves pending -> approved when the approver differs from the submitter', () => {
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const submit = submitTransition({ actorId: 'om-submitter' });
  const approver = baseActor({ id: 'om-approver' });
  const { nextIssue, transition } = transitionApprovalState(issue, 'approve', approver, submit, { now: () => now });
  assert.equal(nextIssue.approvalState, 'approved');
  assert.equal(transition.toState, 'approved');
  assert.equal(transition.actorId, 'om-approver');
});

test('transitionApprovalState: reject moves pending -> rejected and requires + records a reason', () => {
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const submit = submitTransition({ actorId: 'om-submitter' });
  const approver = baseActor({ id: 'om-approver' });
  const { nextIssue, transition } = transitionApprovalState(issue, 'reject', approver, submit, {
    reason: 'over budget for this quarter',
    now: () => now,
  });
  assert.equal(nextIssue.approvalState, 'rejected');
  assert.equal(transition.toState, 'rejected');
  assert.equal(transition.reason, 'over budget for this quarter');
});

test('transitionApprovalState: revise moves rejected -> draft, no actor restriction beyond active', () => {
  const issue = baseIssue({ approvalState: 'rejected', approvalTransitionRef: 'transition-reject' });
  const actor = baseActor({ id: 'om-submitter' });
  const { nextIssue, transition } = transitionApprovalState(issue, 'revise', actor, null, { now: () => now });
  assert.equal(nextIssue.approvalState, 'draft');
  assert.equal(transition.toState, 'draft');
});

// --- transitionApprovalState: illegal (action, fromState) pairs -------------

test('transitionApprovalState rejects every (action, fromState) pair outside the four legal rows', () => {
  const actions: ApprovalAction[] = ['submit', 'approve', 'reject', 'revise'];
  const states: ApprovalState[] = ['draft', 'pending', 'approved', 'rejected'];
  const legalPairs = new Set(['submit:draft', 'approve:pending', 'reject:pending', 'revise:rejected']);
  const actor = baseActor();
  let illegalPairsChecked = 0;
  for (const action of actions) {
    for (const fromState of states) {
      const key = `${action}:${fromState}`;
      if (legalPairs.has(key)) continue;
      illegalPairsChecked += 1;
      const issue = baseIssue({ approvalState: fromState });
      assert.throws(
        () => transitionApprovalState(issue, action, actor, submitTransition({ actorId: 'someone-else' })),
        IllegalApprovalTransitionError,
        key,
      );
    }
  }
  assert.ok(illegalPairsChecked > 0);
});

// --- reject-requires-reason ---------------------------------------------------

test('transitionApprovalState rejects a reject action with no reason', () => {
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const submit = submitTransition({ actorId: 'om-submitter' });
  const approver = baseActor({ id: 'om-approver' });
  assert.throws(
    () => transitionApprovalState(issue, 'reject', approver, submit),
    IllegalApprovalTransitionError,
  );
});

test('transitionApprovalState rejects a reject action with an empty/whitespace-only reason', () => {
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const submit = submitTransition({ actorId: 'om-submitter' });
  const approver = baseActor({ id: 'om-approver' });
  assert.throws(
    () => transitionApprovalState(issue, 'reject', approver, submit, { reason: '   ' }),
    IllegalApprovalTransitionError,
  );
});

// --- inactive actor -----------------------------------------------------------

test('transitionApprovalState rejects a decision from an inactive actor', () => {
  const issue = baseIssue({ approvalState: 'draft' });
  const inactiveActor = baseActor({ status: 'inactive' });
  assert.throws(
    () => transitionApprovalState(issue, 'submit', inactiveActor, null),
    IllegalApprovalTransitionError,
  );
});

// --- self-approval invariant ---------------------------------------------------

test('transitionApprovalState rejects approve when the approver is the same actor who submitted', () => {
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const submit = submitTransition({ actorId: 'om-submitter' });
  const sameActor = baseActor({ id: 'om-submitter' });
  assert.throws(
    () => transitionApprovalState(issue, 'approve', sameActor, submit),
    IllegalApprovalTransitionError,
  );
});

test('transitionApprovalState rejects reject when the rejecter is the same actor who submitted', () => {
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const submit = submitTransition({ actorId: 'om-submitter' });
  const sameActor = baseActor({ id: 'om-submitter' });
  assert.throws(
    () => transitionApprovalState(issue, 'reject', sameActor, submit, { reason: 'no' }),
    IllegalApprovalTransitionError,
  );
});

test('transitionApprovalState rejects approve/reject with no previousTransition supplied for a pending issue', () => {
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const approver = baseActor({ id: 'om-approver' });
  assert.throws(
    () => transitionApprovalState(issue, 'approve', approver, null),
    IllegalApprovalTransitionError,
  );
});

// --- pre-existing snapshot-validation coverage (kept) -----------------------

test('assertValidIssue accepts an Issue in every individual approvalState value (it validates the enum, not reachability)', () => {
  const states: ApprovalState[] = ['draft', 'pending', 'approved', 'rejected'];
  for (const approvalState of states) {
    const issue = baseIssue({ status: 'open', approvalState });
    assert.doesNotThrow(() => assertValidIssue(issue), `approvalState '${approvalState}' should be a valid enum value on an open issue`);
  }
});

test(
  'assertValidIssue does not reject an Issue constructed directly with approvalState: "approved" ' +
    'that never passed through "pending" — documents that snapshot validation is not transition ' +
    'validation (see file header)',
  () => {
    const issue = baseIssue({ status: 'open', approvalState: 'approved', budgetImpact: 1000 });
    assert.doesNotThrow(() => assertValidIssue(issue));
  },
);

test('assertValidIssue: a zero-budgetImpact issue may be "done" while approvalState is "draft" (implicit-approval path, DOMAIN-MODEL.md §3)', () => {
  const issue = baseIssue({ status: 'done', approvalState: 'draft', budgetImpact: 0, closedAt: now });
  assert.doesNotThrow(() => assertValidIssue(issue));
});

test('assertValidIssue: a positive-budgetImpact issue cannot be "done" while approvalState is "draft"', () => {
  const issue = baseIssue({ status: 'done', approvalState: 'draft', budgetImpact: 1000, closedAt: now });
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test('assertValidIssue: a positive-budgetImpact issue cannot be "done" while approvalState is "pending"', () => {
  const issue = baseIssue({ status: 'done', approvalState: 'pending', budgetImpact: 1000, closedAt: now });
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test('assertValidIssue: a positive-budgetImpact issue can be "done" only once approvalState reaches "approved"', () => {
  const issue = baseIssue({ status: 'done', approvalState: 'approved', budgetImpact: 1000, closedAt: now });
  assert.doesNotThrow(() => assertValidIssue(issue));
});
