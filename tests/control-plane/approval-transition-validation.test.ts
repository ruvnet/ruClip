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
 * 2. [Security-stage hardening applied] persistIssue's Guard A "create" branch
 *    (stored === null, src/control-plane/store/agentdb-adapter.ts
 *    checkApprovalStateGuard) originally never read its own `approvalTransition`
 *    parameter — it only checked issue.approvalTransitionRef and
 *    issue.approvalState/budgetImpact, so a caller could pass an arbitrary
 *    (even nonsensical) approvalTransition alongside a brand-new issue and
 *    persistIssue would silently accept the issue write while never
 *    persisting, validating, or acknowledging that transition object. That
 *    was legal per the contract at the time (only applyApprovalTransition
 *    persists transitions) but was a latent authorization-bypass risk: a
 *    future refactor to the create branch could have started trusting the
 *    ignored parameter instead of ignoring it, with nothing to catch the
 *    regression. checkApprovalStateGuard now rejects any create-path call
 *    that supplies an approvalTransition at all — see the test below, which
 *    now locks down the rejection instead of the no-op.
 *
 * No live AgentDB instance is used — mockBridge as elsewhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { credentialFor, nonceMockHandlers } from '../support/actor-credential-fixture.js';
import { assertValidApprovalTransition, SchemaValidationError } from '../../src/control-plane/schema/validation.js';
import {
  persistIssue,
  applyApprovalTransition,
  ApprovalGateViolationError,
} from '../../src/control-plane/store/agentdb-adapter.js';
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

// --- Guard A create-path: approvalTransition parameter must be rejected, not silently ignored ---
//
// Security-stage hardening (see /Users/cohen/Projects/ruClip commit history around
// 13ac549's follow-up): the original version of this test documented that Guard A's
// create branch silently ignored a supplied approvalTransition — neither validating
// nor persisting it, just dropping it on the floor. That is a latent authorization-
// bypass risk: a future refactor to the create branch could start trusting the
// ignored parameter instead of ignoring it, with nothing here to catch the
// regression. checkApprovalStateGuard now rejects any create-path call that supplies
// an approvalTransition at all (there is no prior state for a transition to move
// from), so the failure mode is a loud, immediate ApprovalGateViolationError instead
// of a silent no-op — this test now locks down the rejection, not the no-op.

test(
  'persistIssue on a brand-new issue rejects any supplied approvalTransition ' +
    '(there is no prior approvalState for a transition to move from) and writes nothing',
  async () => {
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': () => ({ results: [] }),
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
    });
    // A transition that would itself be invalid if actually validated
    // (fromState/toState swapped relative to any legal row) — proving the create
    // branch rejects on the mere presence of a transition, before even inspecting
    // its shape.
    const nonsenseTransition = baseTransition({
      action: 'approve',
      fromState: 'approved',
      toState: 'draft',
    });
    await assert.rejects(
      () => persistIssue('co-1', baseIssue({ approvalState: 'draft' }), undefined, nonsenseTransition, undefined, config),
      ApprovalGateViolationError,
    );
    const storeCalls = calls.filter((c) => c.toolName === 'agentdb_hierarchical-store');
    assert.equal(storeCalls.length, 0, 'a rejected create must make no writes at all');
  },
);

// --- applyApprovalTransition: witness failure leaves no partial writes ---

test(
  'applyApprovalTransition propagates a witness.record() rejection before persisting the ApprovalTransition or Issue ' +
    '(the AUTHORIZATION.md §8 claims_handoff step for submit necessarily runs before the witness call, so it is not ' +
    'included in "nothing persisted" — no hierarchical-store/causal-edge write happens)',
  async () => {
    const original = baseIssue({ approvalState: 'draft', approvalTransitionRef: null, status: 'open' });
    const actor = baseActor({ id: 'om-submitter' });
    const approver = baseActor({ id: 'om-approver' });
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': (args) =>
        args.tier === 'semantic' && args.query === 'ruclip:company:co-1:org-member:om-submitter'
          ? { results: [{ key: args.query, value: JSON.stringify(actor) }] }
          : { results: [] },
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      'claims_handoff': () => ({ success: true }),
      ...nonceMockHandlers(),
    });
    const failingWitness: WitnessHook = {
      record: async () => {
        throw new Error('witness service unavailable');
      },
    };

    const authorization = await credentialFor(actor);
    await assert.rejects(() =>
      applyApprovalTransition('co-1', original, 'submit', authorization, null, { witness: failingWitness, approver }, config),
    );
    assert.deepEqual(
      calls.map((c) => c.toolName),
      ['memory_retrieve', 'memory_store', 'agentdb_hierarchical-recall', 'claims_handoff'],
      'credential verification (nonce check/consume + recallOrgMember) and the pre-transition claims_handoff both ' +
        'run, but no store/delete/causal-edge write should happen once the witness hook rejects',
    );
  },
);

// --- assertValidIssue: approvalTransitionRef format is boundary-checked too ---

test('assertValidIssue rejects an approvalTransitionRef containing a key-delimiter colon', async () => {
  // Imported lazily via the adapter's own re-export path is unnecessary — use
  // the same validation module directly for a focused assertion.
  const { assertValidIssue } = await import('../../src/control-plane/schema/validation.js');
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'ruclip:transition:1' });
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});
