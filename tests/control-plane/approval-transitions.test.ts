/**
 * Issue.approvalState transitions (DOMAIN-MODEL.md §3: draft -> pending ->
 * approved | rejected, rejected -> draft).
 *
 * FINDING: there is no `transitionApprovalState` (or equivalent) function
 * anywhere in src/control-plane — grepped the whole tree for
 * "transition"/"nextState"/"VALID_TRANSITIONS" and found nothing outside
 * this state machine's description in docs/design/DOMAIN-MODEL.md. The
 * coder stage explicitly scoped this out: "approval-gate enforcement
 * logic... that's your/downstream's territory." So "only valid
 * state-machine transitions succeed" cannot be tested against real code
 * yet — there is no code that checks a transition (old state -> new state)
 * at all.
 *
 * What DOES exist and IS tested here is the one approvalState-related
 * invariant Phase 1b actually implemented: assertValidIssue's snapshot
 * check that `status: 'done'` requires `approvalState: 'approved'` once
 * `budgetImpact > 0` (validation.ts, DOMAIN-MODEL.md §1.4). That's a
 * same-document invariant, not a transition check — it says nothing about
 * whether approvalState was reached via a legal path (e.g. it does not
 * reject an Issue constructed directly with approvalState: 'approved' that
 * never passed through 'pending'). The test.todo below records that gap so
 * it isn't silently lost; a real transition guard is downstream work per
 * the task brief, not something to invent here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidIssue, SchemaValidationError } from '../../src/control-plane/schema/validation.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
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
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    ...overrides,
  };
}

test.todo(
  'draft->pending->approved / draft->pending->rejected->draft are the only legal ' +
    'approvalState transitions per DOMAIN-MODEL.md §3, but no transition-checking ' +
    'function exists in src/control-plane yet to test against (approval-gate ' +
    'enforcement is explicitly downstream, out of Phase 1b scope) — add real ' +
    'transition tests once that function lands.',
);

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
    'validation (see file header finding)',
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
