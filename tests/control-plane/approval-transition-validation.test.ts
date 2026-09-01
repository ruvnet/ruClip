/**
 * Independent coverage for the Phase 1c approval-gate enforcement slice
 * (commit 7cc0743), complementing tests/control-plane/approval-transitions.test.ts
 * (transitionApprovalState / isLegalApprovalTransition, written by the coder
 * for their own Phase 1c commit) and tests/control-plane/approval-gate.test.ts
 * (persistIssue Guard A/B + applyApprovalTransition, also written by the
 * coder for that commit).
 *
 * This file targets two gaps that survive after reading both of those files:
 *
 * 1. assertValidApprovalTransition (schema/validation.ts) is never called
 *    directly by any existing test — it's only ever exercised indirectly
 *    through applyApprovalTransition's happy-path tests, where the
 *    ApprovalTransition object always comes from the pure
 *    transitionApprovalState function and is therefore always
 *    well-formed. None of assertValidApprovalTransition's own rejection
 *    branches (bad id/issueId/actorId, invalid action/fromState/toState
 *    enum, wrong reason type, reject-without-reason, bad createdAt/
 *    witnessRef) are exercised by anything in the suite. Since Guard A in
 *    persistIssue calls this function as its last check on a supplied
 *    ApprovalTransition (via applyApprovalTransition -> persistIssue), a
 *    regression here would only be caught by a hand-crafted (not
 *    machine-produced) ApprovalTransition — exactly what's missing.
 *
 * 2. persistIssue's Guard A "create" branch (stored === null,
 *    src/control-plane/store/agentdb-adapter.ts checkApprovalStateGuard)
 *    never reads its own `approvalTransition` parameter — it only checks
 *    issue.approvalTransitionRef and issue.approvalState/budgetImpact. That
 *    means a caller can pass an arbitrary (even nonsensical) approvalTransition
 *    alongside a brand-new issue and persistIssue will silently accept the
 *    issue write while never persisting, validating, or otherwise
 *    acknowledging that transition object. This is legal per the current
 *    contract (only applyApprovalTransition persists transitions), but it's
 *    a real "the parameter is a no-op here" behavior worth locking down —
 *    if a future refactor made create-path Guard A start trusting an
 *    attacker-supplied approvalTransition instead of ignoring it, that would
 *    be a silent authorization-bypass regression.
 *
 * No live AgentDB instance is used — mockBridge as elsewhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { assertValidApprovalTransition, SchemaValidationError } from '../../src/control-plane/schema/validation.js';
import { persistIssue, applyApprovalTransition } from '../../src/control-plane/store/agentdb-adapter.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';
import type { WitnessHook } from '../../src/control-plane/schema/witness.js';

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

function baseTransition(overrides: Partial<ApprovalTransition> = {}): ApprovalTransition {
  return {
    id: 'transition-1',
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

// --- assertValidApprovalTransition: direct coverage of every rejection branch ---

test('assertValidApprovalTransition accepts a well-formed transition', () => {
  assert.doesNotThrow(() => assertValidApprovalTransition(baseTransition()));
});

test('assertValidApprovalTransition rejects an unsafe id (contains a key-delimiter colon)', () => {
  const transition = baseTransition({ id: 'transition:1' });
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition rejects an unsafe issueId', () => {
  const transition = baseTransition({ issueId: '' });
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition rejects an unknown action', () => {
  const transition = { ...baseTransition(), action: 'auto-approve' } as unknown as ApprovalTransition;
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition rejects an unknown fromState', () => {
  const transition = { ...baseTransition(), fromState: 'archived' } as unknown as ApprovalTransition;
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition rejects an unknown toState', () => {
  const transition = { ...baseTransition(), toState: 'archived' } as unknown as ApprovalTransition;
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition rejects an unsafe actorId', () => {
  const transition = baseTransition({ actorId: 'om:1' });
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition rejects a non-string, non-null reason', () => {
  const transition = { ...baseTransition(), reason: 42 } as unknown as ApprovalTransition;
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition rejects a reject action with a null reason (defense in depth vs transitionApprovalState)', () => {
  const transition = baseTransition({ action: 'reject', fromState: 'pending', toState: 'rejected', reason: null });
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition rejects a reject action with an empty-string reason', () => {
  const transition = baseTransition({ action: 'reject', fromState: 'pending', toState: 'rejected', reason: '' });
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition accepts a reject action with a non-empty reason', () => {
  const transition = baseTransition({
    action: 'reject',
    fromState: 'pending',
    toState: 'rejected',
    reason: 'over budget',
  });
  assert.doesNotThrow(() => assertValidApprovalTransition(transition));
});

test('assertValidApprovalTransition rejects a non-ISO createdAt', () => {
  const transition = baseTransition({ createdAt: 'not-a-date' });
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition rejects an empty-string witnessRef', () => {
  const transition = baseTransition({ witnessRef: '' });
  assert.throws(() => assertValidApprovalTransition(transition), SchemaValidationError);
});

test('assertValidApprovalTransition accepts a non-empty witnessRef', () => {
  const transition = baseTransition({ witnessRef: 'witness-ref-abc' });
  assert.doesNotThrow(() => assertValidApprovalTransition(transition));
});

// --- Guard A create-path: approvalTransition parameter is a no-op, not persisted ---

test(
  'persistIssue on a brand-new issue silently ignores a supplied approvalTransition ' +
    '— it is neither validated nor persisted, only the issue document is written',
  async () => {
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': () => ({ results: [] }),
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
    });
    // A transition that would itself be invalid if actually validated
    // (fromState/toState swapped relative to any legal row) — proving Guard A's
    // create branch truly never inspects it, not just that a valid-looking one
    // happens to pass.
    const nonsenseTransition = baseTransition({
      action: 'approve',
      fromState: 'approved',
      toState: 'draft',
    });
    await assert.doesNotReject(() =>
      persistIssue('co-1', baseIssue({ approvalState: 'draft' }), undefined, nonsenseTransition, config),
    );
    const storeCalls = calls.filter((c) => c.toolName === 'agentdb_hierarchical-store');
    assert.equal(storeCalls.length, 1, 'only the issue document should be stored, never the ignored transition');
    assert.equal(storeCalls[0]?.args.key, 'ruclip:company:co-1:goal:goal-1:issue:issue-1');
  },
);

// --- applyApprovalTransition: witness failure leaves no partial writes ---

test('applyApprovalTransition propagates a witness.record() rejection before persisting anything', async () => {
  const original = baseIssue({ approvalState: 'draft', approvalTransitionRef: null, status: 'open' });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [] }),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  const actor = baseActor({ id: 'om-submitter' });
  const failingWitness: WitnessHook = {
    record: async () => {
      throw new Error('witness service unavailable');
    },
  };

  await assert.rejects(() =>
    applyApprovalTransition('co-1', original, 'submit', actor, null, { witness: failingWitness }, config),
  );
  assert.equal(calls.length, 0, 'no bridge call should happen when the witness hook rejects');
});

// --- assertValidIssue: approvalTransitionRef format is boundary-checked too ---

test('assertValidIssue rejects an approvalTransitionRef containing a key-delimiter colon', async () => {
  // Imported lazily via the adapter's own re-export path is unnecessary — use
  // the same validation module directly for a focused assertion.
  const { assertValidIssue } = await import('../../src/control-plane/schema/validation.js');
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'ruclip:transition:1' });
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});
