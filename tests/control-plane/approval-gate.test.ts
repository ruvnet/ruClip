/**
 * Enforcement layer added by the Phase 1c slice (docs/design/APPROVAL-GATE.md
 * §3-4): persistIssue's Guard A (approvalState may not change without a
 * matching, re-validated ApprovalTransition) and Guard B (budgetImpact is
 * frozen once the stored issue leaves 'draft'), plus applyApprovalTransition
 * (the orchestration function that composes transitionApprovalState, the
 * optional witness hook, the ApprovalTransition record write, the
 * approved_by/rejected_by causal edge, and the hardened persistIssue).
 *
 * No live AgentDB instance — every call goes through mockBridge
 * (tests/support/mock-bridge.ts), same as the rest of this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { credentialFor, nonceMockHandlers } from '../support/actor-credential-fixture.js';
import {
  persistIssue,
  applyApprovalTransition,
  ApprovalGateViolationError,
} from '../../src/control-plane/store/agentdb-adapter.js';
import { ClaimAuthorizationError } from '../../src/control-plane/authorization/claims-authorization.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';
import type { WitnessEntryInput, WitnessHook } from '../../src/control-plane/schema/witness.js';

const now = '2026-09-01T00:00:00.000Z';
const issueKeyStr = 'ruclip:company:co-1:goal:goal-1:issue:issue-1';

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

function orgMemberKeyStr(companyId: string, id: string): string {
  return `ruclip:company:${companyId}:org-member:${id}`;
}

/**
 * recall handler that returns `stored` for the working-tier check, nothing
 * for episodic, and (since Guard C's actor-active check now recalls the
 * persisted OrgMember record instead of trusting authorization.actor —
 * security hardening, see agentdb-adapter.ts's checkAuthorizationGuard)
 * serves any `activeMembers` passed in at their semantic-tier key so tests
 * that supply an approvalTransition (and therefore trigger Guard C) don't
 * spuriously fail with "no persisted OrgMember record".
 */
function recallReturning(stored: Issue | null, ...activeMembers: OrgMember[]) {
  const memberEntries = new Map(activeMembers.map((m) => [orgMemberKeyStr(m.companyId, m.id), m]));
  return (args: Record<string, unknown>) => {
    if (args.tier === 'working' && stored) {
      return { results: [{ key: issueKeyStr, value: JSON.stringify(stored) }] };
    }
    if (args.tier === 'semantic') {
      const member = memberEntries.get(args.query as string);
      if (member) return { results: [{ key: args.query as string, value: JSON.stringify(member) }] };
    }
    return { results: [] };
  };
}

/**
 * claims_list mock handler reporting `actor` as holding an active claim on
 * `issueId` — satisfies Guard C's verifyActorHoldsClaim (AUTHORIZATION.md
 * §3, §6). Mirrors the real claims_list response shape verified against
 * v3/@claude-flow/cli/src/mcp-tools/claims-tools.ts (see
 * src/control-plane/authorization/claims-authorization.ts's header comment):
 * `{ success, claims: [{ issueId, claimant: {type, agentId|userId, agentType|name}, status }] }`.
 */
function activeClaimFor(actor: OrgMember, issueId: string) {
  return () => ({
    success: true,
    claims: [
      {
        // Cross-tenant claim collision fix (ruvnet/ruClip#5 Finding 1) —
        // claims-authorization.ts now sends/compares a company-prefixed
        // issueId, not the bare one.
        issueId: `${actor.companyId}:${issueId}`,
        claimant:
          actor.kind === 'agent'
            ? { type: 'agent', agentId: actor.id, agentType: actor.role }
            : { type: 'human', userId: actor.id, name: actor.role },
        status: 'active',
      },
    ],
  });
}

// --- Guard A: create (stored === null) ---------------------------------------

test('Guard A create: a brand-new issue may start in draft', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(null),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  await assert.doesNotReject(() => persistIssue('co-1', baseIssue({ approvalState: 'draft' }), undefined, undefined, undefined, config));
});

test('Guard A create: a brand-new issue may start approved only when budgetImpact === 0', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(null),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  await assert.doesNotReject(() =>
    persistIssue('co-1', baseIssue({ approvalState: 'approved', budgetImpact: 0 }), undefined, undefined, undefined, config),
  );
});

test('Guard A create: a brand-new issue cannot start approved with budgetImpact > 0', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(null),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  await assert.rejects(
    () => persistIssue('co-1', baseIssue({ approvalState: 'approved', budgetImpact: 500 }), undefined, undefined, undefined, config),
    ApprovalGateViolationError,
  );
});

test('Guard A create: a brand-new issue cannot start pending', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(null),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  await assert.rejects(
    () => persistIssue('co-1', baseIssue({ approvalState: 'pending' }), undefined, undefined, undefined, config),
    ApprovalGateViolationError,
  );
});

test('Guard A create: a brand-new issue must not carry a non-null approvalTransitionRef', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(null),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  await assert.rejects(
    () =>
      persistIssue(
        'co-1',
        baseIssue({ approvalState: 'draft', approvalTransitionRef: 'forged-ref' }),
        undefined,
        undefined,
        undefined,
        config,
      ),
    ApprovalGateViolationError,
  );
});

// --- Guard A: no-change (approvalState unchanged) ----------------------------

test('Guard A no-change: succeeds when approvalTransitionRef matches stored and no approvalTransition is supplied', async () => {
  const stored = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1', title: 'Renamed' });
  await assert.doesNotReject(() => persistIssue('co-1', issue, undefined, undefined, undefined, config));
});

test('Guard A no-change: rejects when an approvalTransition is supplied despite approvalState being unchanged', async () => {
  const stored = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1' });
  await assert.rejects(
    () =>
      persistIssue('co-1', issue, undefined, baseTransition({ fromState: 'draft', toState: 'pending' }), undefined, config),
    ApprovalGateViolationError,
  );
});

test('Guard A no-change: rejects when approvalTransitionRef silently diverges from the stored value', async () => {
  const stored = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'some-other-transition' });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, undefined, undefined, config), ApprovalGateViolationError);
});

// --- Guard A: real transition -------------------------------------------------

test('Guard A real transition: succeeds when the supplied ApprovalTransition matches stored/new state exactly (Guard C authorized)', async () => {
  const stored = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  const actor = baseActor({ id: 'om-submitter' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored, actor),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_list': activeClaimFor(actor, 'issue-1'),
  });
  const transition = baseTransition({ id: 'transition-1', fromState: 'draft', toState: 'pending', actorId: actor.id });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1' });
  await assert.doesNotReject(() => persistIssue('co-1', issue, undefined, transition, { actor }, config));
});

test('Guard A real transition: rejects when approvalState changed but no approvalTransition was supplied', async () => {
  const stored = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1' });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, undefined, undefined, config), ApprovalGateViolationError);
});

test('Guard A real transition: rejects an ApprovalTransition for a different issueId', async () => {
  const stored = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const transition = baseTransition({ id: 'transition-1', issueId: 'some-other-issue', fromState: 'draft', toState: 'pending' });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1' });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, transition, undefined, config), ApprovalGateViolationError);
});

test('Guard A real transition: rejects when transition.fromState does not match stored.approvalState', async () => {
  const stored = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  // fromState claims 'rejected' but stored is actually 'draft'.
  const transition = baseTransition({ id: 'transition-1', action: 'revise', fromState: 'rejected', toState: 'draft' });
  const issue = baseIssue({ approvalState: 'draft', approvalTransitionRef: 'transition-1' });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, transition, undefined, config), ApprovalGateViolationError);
});

test('Guard A real transition: rejects when transition.toState does not match issue.approvalState', async () => {
  const stored = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const transition = baseTransition({ id: 'transition-1', fromState: 'draft', toState: 'pending' });
  // issue actually landed on 'approved' but the transition says 'pending'.
  const issue = baseIssue({ approvalState: 'approved', approvalTransitionRef: 'transition-1' });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, transition, undefined, config), ApprovalGateViolationError);
});

test('Guard A real transition: rejects when issue.approvalTransitionRef does not point at the supplied transition.id', async () => {
  const stored = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const transition = baseTransition({ id: 'transition-1', fromState: 'draft', toState: 'pending' });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'a-different-transition-id' });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, transition, undefined, config), ApprovalGateViolationError);
});

test('Guard A real transition: rejects a forged ApprovalTransition object whose (action, fromState, toState) triple is not a legal row, even though every id/state cross-reference lines up', async () => {
  const stored = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  // Every cross-reference is internally consistent (issueId matches, fromState
  // matches stored, toState matches the issue, id matches approvalTransitionRef)
  // but 'approve' never legally starts from 'draft' — this never went through
  // transitionApprovalState. Guard A must catch it by recomputing legality,
  // not by trusting the cross-references alone.
  const forged = baseTransition({ id: 'transition-1', action: 'approve', fromState: 'draft', toState: 'approved' });
  const issue = baseIssue({ approvalState: 'approved', approvalTransitionRef: 'transition-1', budgetImpact: 0 });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, forged, undefined, config), ApprovalGateViolationError);
});

// --- Guard B: budgetImpact frozen once approvalState leaves draft -----------

test('Guard B: budgetImpact is freely editable while stored.approvalState is draft', async () => {
  const stored = baseIssue({ approvalState: 'draft', budgetImpact: 100 });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  const issue = baseIssue({ approvalState: 'draft', budgetImpact: 999 });
  await assert.doesNotReject(() => persistIssue('co-1', issue, undefined, undefined, undefined, config));
});

test('Guard B: budgetImpact is frozen once stored.approvalState is pending', async () => {
  const stored = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1', budgetImpact: 100 });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1', budgetImpact: 500 });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, undefined, undefined, config), ApprovalGateViolationError);
});

test('Guard B: budgetImpact is frozen once stored.approvalState is approved', async () => {
  const stored = baseIssue({ approvalState: 'approved', approvalTransitionRef: 'transition-1', budgetImpact: 100 });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const issue = baseIssue({ approvalState: 'approved', approvalTransitionRef: 'transition-1', budgetImpact: 500 });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, undefined, undefined, config), ApprovalGateViolationError);
});

test('Guard B: budgetImpact is frozen once stored.approvalState is rejected', async () => {
  const stored = baseIssue({ approvalState: 'rejected', approvalTransitionRef: 'transition-1', budgetImpact: 100 });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const issue = baseIssue({ approvalState: 'rejected', approvalTransitionRef: 'transition-1', budgetImpact: 500 });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, undefined, undefined, config), ApprovalGateViolationError);
});

test('Guard B: unchanged budgetImpact is allowed regardless of stored.approvalState', async () => {
  const stored = baseIssue({ approvalState: 'approved', approvalTransitionRef: 'transition-1', budgetImpact: 4250 });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  const issue = baseIssue({ approvalState: 'approved', approvalTransitionRef: 'transition-1', budgetImpact: 4250 });
  await assert.doesNotReject(() => persistIssue('co-1', issue, undefined, undefined, undefined, config));
});

// --- applyApprovalTransition: end-to-end --------------------------------------

test('applyApprovalTransition (submit, no witness): persists the transition, updates the issue, and leaves witnessRef null', async () => {
  const original = baseIssue({ approvalState: 'draft', approvalTransitionRef: null, status: 'open' });
  const actor = baseActor({ id: 'om-submitter' });
  const approver = baseActor({ id: 'om-approver' });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(original, actor),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_handoff': () => ({ success: true }),
    'claims_list': activeClaimFor(actor, 'issue-1'),
    ...nonceMockHandlers(),
  });

  const result = await applyApprovalTransition(
    'co-1',
    original,
    'submit',
    await credentialFor(actor),
    null,
    { approver },
    config,
  );

  assert.equal(result.issue.approvalState, 'pending');
  assert.equal(result.issue.approvalTransitionRef, result.transition.id);
  assert.equal(result.transition.action, 'submit');
  assert.equal(result.transition.witnessRef, null);

  const transitionStoreCall = calls.find(
    (c) => c.toolName === 'agentdb_hierarchical-store' && (c.args.key as string).includes(':approval-transition:'),
  );
  assert.ok(transitionStoreCall, 'expected the ApprovalTransition record to be persisted');
  assert.equal(transitionStoreCall!.args.key, `ruclip:company:co-1:approval-transition:${result.transition.id}`);

  const issueStoreCall = calls.find(
    (c) => c.toolName === 'agentdb_hierarchical-store' && c.args.key === issueKeyStr,
  );
  assert.ok(issueStoreCall, 'expected the updated Issue record to be persisted');

  // submit is neither approve nor reject — no approved_by/rejected_by edge.
  const decisionEdges = calls.filter(
    (c) => c.toolName === 'agentdb_causal-edge' && ['approved_by', 'rejected_by'].includes(c.args.relation as string),
  );
  assert.equal(decisionEdges.length, 0);

  const handoffCall = calls.find((c) => c.toolName === 'claims_handoff');
  assert.ok(handoffCall, 'submit must request a claims_handoff to the approver');
  assert.equal(handoffCall!.args.from, 'agent:om-submitter:Engineer');
  assert.equal(handoffCall!.args.to, 'agent:om-approver:Engineer');
});

test('applyApprovalTransition (approve, with witness): wires the witness ref into both the returned and persisted transition, and records an approved_by edge', async () => {
  const submit = baseTransition({ id: 'transition-submit', actorId: 'om-submitter', fromState: 'draft', toState: 'pending' });
  const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit', status: 'open' });
  const approver = baseActor({ id: 'om-approver' });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(pendingIssue, approver),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_accept-handoff': () => ({ success: true }),
    'claims_list': activeClaimFor(approver, 'issue-1'),
    ...nonceMockHandlers(),
  });
  const witnessCalls: WitnessEntryInput[] = [];
  const witness: WitnessHook = {
    record: async (entry) => {
      witnessCalls.push(entry);
      return { id: 'witness-ref-abc' };
    },
  };

  const result = await applyApprovalTransition(
    'co-1',
    pendingIssue,
    'approve',
    await credentialFor(approver),
    submit,
    { witness },
    config,
  );

  assert.equal(result.issue.approvalState, 'approved');
  assert.equal(result.transition.witnessRef, 'witness-ref-abc');

  assert.equal(witnessCalls.length, 1);
  assert.equal(witnessCalls[0]?.eventType, 'ruclip.issue.approval_transition');
  assert.equal(witnessCalls[0]?.subject, `issue:issue-1:approval-transition:${result.transition.id}`);
  assert.deepEqual(witnessCalls[0]?.payload, {
    issueId: 'issue-1',
    action: 'approve',
    fromState: 'pending',
    toState: 'approved',
    actorId: 'om-approver',
    reason: null,
    createdAt: result.transition.createdAt,
  });

  const transitionStoreCall = calls.find(
    (c) => c.toolName === 'agentdb_hierarchical-store' && (c.args.key as string).includes(':approval-transition:'),
  );
  const storedTransition = JSON.parse(transitionStoreCall!.args.value as string) as ApprovalTransition;
  assert.equal(storedTransition.witnessRef, 'witness-ref-abc', 'witnessRef must be baked into the persisted record, not just the return value');

  const approvedByEdge = calls.find(
    (c) => c.toolName === 'agentdb_causal-edge' && c.args.relation === 'approved_by',
  );
  assert.ok(approvedByEdge, 'expected an approved_by causal edge');
  assert.equal(approvedByEdge!.args.sourceId, 'entity:issue:issue-1');
  assert.equal(approvedByEdge!.args.targetId, 'entity:org-member:om-approver');

  const acceptCall = calls.find((c) => c.toolName === 'claims_accept-handoff');
  assert.ok(acceptCall, 'approve must accept the pending handoff before deciding');
  assert.equal(acceptCall!.args.claimant, 'agent:om-approver:Engineer');
});

test('applyApprovalTransition (reject): records a rejected_by edge, not approved_by, and hands the claim back to the submitter', async () => {
  const submitter = baseActor({ id: 'om-submitter' });
  const submit = baseTransition({ id: 'transition-submit', actorId: 'om-submitter', fromState: 'draft', toState: 'pending' });
  const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const approver = baseActor({ id: 'om-approver' });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(pendingIssue, approver),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_accept-handoff': () => ({ success: true }),
    'claims_list': activeClaimFor(approver, 'issue-1'),
    'claims_handoff': () => ({ success: true }),
    ...nonceMockHandlers(),
  });

  await applyApprovalTransition(
    'co-1',
    pendingIssue,
    'reject',
    await credentialFor(approver),
    submit,
    { reason: 'too expensive', handoffTo: submitter },
    config,
  );

  const edges = calls.filter((c) => c.toolName === 'agentdb_causal-edge');
  assert.ok(edges.some((c) => c.args.relation === 'rejected_by'));
  assert.ok(!edges.some((c) => c.args.relation === 'approved_by'));

  const handoffBackCall = calls.find((c) => c.toolName === 'claims_handoff');
  assert.ok(handoffBackCall, 'reject must hand the claim back to the original submitter');
  assert.equal(handoffBackCall!.args.from, 'agent:om-approver:Engineer');
  assert.equal(handoffBackCall!.args.to, 'agent:om-submitter:Engineer');
});

test('applyApprovalTransition (reject) throws when deps.handoffTo is missing, after the issue has already been persisted', async () => {
  // Documents a real ordering choice in AUTHORIZATION.md §8: the
  // deps.handoffTo requirement is checked at step 6, AFTER persistIssue
  // (step 5) has already written. A missing handoffTo is discovered only
  // once the reject has otherwise fully succeeded.
  const submit = baseTransition({ id: 'transition-submit', actorId: 'om-submitter', fromState: 'draft', toState: 'pending' });
  const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const approver = baseActor({ id: 'om-approver' });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(pendingIssue, approver),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_accept-handoff': () => ({ success: true }),
    'claims_list': activeClaimFor(approver, 'issue-1'),
    ...nonceMockHandlers(),
  });

  const authorization = await credentialFor(approver);
  await assert.rejects(
    () => applyApprovalTransition('co-1', pendingIssue, 'reject', authorization, submit, { reason: 'too expensive' }, config),
    ClaimAuthorizationError,
  );

  const issueStoreCall = calls.find(
    (c) => c.toolName === 'agentdb_hierarchical-store' && c.args.key === issueKeyStr,
  );
  assert.ok(issueStoreCall, 'persistIssue already wrote the issue before the missing-handoffTo check ran');
});

test(
  'applyApprovalTransition still rejects a self-approval attempt via the pure transitionApprovalState check, ' +
    'even though the claims_accept-handoff authorization step (AUTHORIZATION.md §8 step 1, which runs first and ' +
    "does not itself know about self-approval) succeeds — claims authorization and the domain's self-approval " +
    'invariant are complementary, not the same mechanism (AUTHORIZATION.md §4)',
  async () => {
    const submit = baseTransition({ id: 'transition-submit', actorId: 'om-submitter', fromState: 'draft', toState: 'pending' });
    const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
    const sameActor = baseActor({ id: 'om-submitter' });
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': recallReturning(null, sameActor),
      'claims_accept-handoff': () => ({ success: true }),
      ...nonceMockHandlers(),
    });

    const authorization = await credentialFor(sameActor);
    await assert.rejects(
      () => applyApprovalTransition('co-1', pendingIssue, 'approve', authorization, submit, {}, config),
    );

    // Unlike the pre-authorization design, credential verification (nonce
    // check/consume + recallOrgMember) now happens before claims_accept-handoff,
    // which itself still runs before the pure state machine gets a chance to
    // reject — AUTHORIZATION.md §8 puts claims choreography ahead of
    // transitionApprovalState. What must still hold is that nothing past that
    // point runs: no ApprovalTransition/Issue write, no causal edge.
    assert.deepEqual(calls.map((c) => c.toolName), [
      'memory_retrieve',
      'memory_store',
      'agentdb_hierarchical-recall',
      'claims_accept-handoff',
    ]);
  },
);
