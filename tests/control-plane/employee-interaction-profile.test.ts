/**
 * Coverage for the Phase 6a slice (docs/design/EMPLOYEE-INTERACTION-PROFILE.md):
 * consent (self-only, human-only, replace-not-merge), no computation for an
 * unconsented signal type, the latency-pairing/median/histogram computation
 * itself, applyApprovalTransition's new deps.interactionLearning wiring
 * (both the regression case — omitted, no behavior change — and the
 * best-effort-failure case), and the structural guarantee that the two read
 * functions never gain a second identity parameter.
 *
 * No live AgentDB/memory instance — every call goes through mockBridge
 * (tests/support/mock-bridge.ts), same as the rest of this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { applyApprovalTransition } from '../../src/control-plane/store/agentdb-adapter.js';
import {
  recallOwnInteractionProfile,
  recallInteractionProfileForComposition,
  setInteractionProfileConsent,
  recomputeInteractionSignals,
  PrivacyConsentError,
} from '../../src/control-plane/employee-augmentation/interaction-profile.js';
import type { EmployeeInteractionProfile } from '../../src/control-plane/schema/employee-interaction-profile.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';

const now = '2026-09-01T00:00:00.000Z';

function baseActor(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'om-1',
    companyId: 'co-1',
    kind: 'human',
    identityRef: 'bbs:alice',
    role: 'Engineer',
    managerId: null,
    status: 'active',
    ...overrides,
  };
}

function baseProfile(overrides: Partial<EmployeeInteractionProfile> = {}): EmployeeInteractionProfile {
  return {
    id: 'om-1',
    companyId: 'co-1',
    orgMemberId: 'om-1',
    consentedSignalTypes: [],
    medianDecisionLatencySeconds: null,
    decisionHourHistogram: new Array(24).fill(0),
    sampleCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

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

function activeClaimFor(actor: OrgMember, issueId: string) {
  return () => ({
    success: true,
    claims: [{ issueId, claimant: { type: actor.kind, agentId: actor.id, agentType: actor.role, userId: actor.id, name: actor.role }, status: 'active' }],
  });
}

const orgMemberRecallKey = (companyId: string, orgMemberId: string) => `ruclip:company:${companyId}:org-member:${orgMemberId}`;
const profileKey = (companyId: string, orgMemberId: string) => `ruclip:company:${companyId}:org-member:${orgMemberId}:interaction-profile`;

// --- §3: consent — self-service, fail-closed, per signal type ---------------

test('setInteractionProfileConsent rejects when actor.id !== orgMemberId (self-service only, no proxy/admin override)', async () => {
  const { calls, config } = mockBridge({});
  const actor = baseActor({ id: 'om-other' });
  await assert.rejects(
    () => setInteractionProfileConsent('co-1', 'om-1', ['internal-timing'], actor, config),
    PrivacyConsentError,
  );
  assert.equal(calls.length, 0, 'rejected before any bridge call');
});

test('setInteractionProfileConsent rejects a kind:"agent" actor consenting on a human OrgMember\'s behalf', async () => {
  const { calls, config } = mockBridge({});
  const agentActor = baseActor({ id: 'agent-1', kind: 'agent' });
  await assert.rejects(
    () => setInteractionProfileConsent('co-1', 'om-1', ['internal-timing'], agentActor, config),
    PrivacyConsentError,
  );
  assert.equal(calls.length, 0);
});

test('setInteractionProfileConsent rejects when the target OrgMember has kind !== "human" (even for a self-consistent actor.id === orgMemberId call)', async () => {
  const agentMember = baseActor({ id: 'agent-1', kind: 'agent' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) =>
      args.query === orgMemberRecallKey('co-1', 'agent-1')
        ? { results: [{ key: args.query, value: JSON.stringify(agentMember) }] }
        : { results: [] },
  });
  await assert.rejects(
    () => setInteractionProfileConsent('co-1', 'agent-1', ['internal-timing'], agentMember, config),
    PrivacyConsentError,
  );
});

test('setInteractionProfileConsent creates a fresh profile with zero defaults on first consent, and persists via memory_store with the right namespace/provenance', async () => {
  const humanMember = baseActor({ id: 'om-1' });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args) =>
      args.query === orgMemberRecallKey('co-1', 'om-1')
        ? { results: [{ key: args.query, value: JSON.stringify(humanMember) }] }
        : { results: [] },
    'memory_retrieve': () => ({ found: false }),
    'memory_store': () => ({ success: true }),
  });
  const profile = await setInteractionProfileConsent('co-1', 'om-1', ['internal-timing'], humanMember, config);
  assert.deepEqual(profile.consentedSignalTypes, ['internal-timing']);
  assert.equal(profile.sampleCount, 0);
  assert.equal(profile.medianDecisionLatencySeconds, null);
  assert.equal(profile.decisionHourHistogram.length, 24);

  const storeCall = calls.find((c) => c.toolName === 'memory_store');
  assert.equal(storeCall?.args.key, profileKey('co-1', 'om-1'));
  assert.equal(storeCall?.args.namespace, 'ruclip-employee-profiles');
  assert.equal(storeCall?.args.provenance_type, 'system_observation');
  assert.equal(storeCall?.args.upsert, true);
});

test('setInteractionProfileConsent replaces (not merges) consentedSignalTypes — withdrawing consent is the same code path as granting it', async () => {
  const humanMember = baseActor({ id: 'om-1' });
  const existing = baseProfile({ consentedSignalTypes: ['internal-timing'], sampleCount: 5 });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args) =>
      args.query === orgMemberRecallKey('co-1', 'om-1')
        ? { results: [{ key: args.query, value: JSON.stringify(humanMember) }] }
        : { results: [] },
    'memory_retrieve': () => ({ found: true, value: existing }),
    'memory_store': () => ({ success: true }),
  });
  const profile = await setInteractionProfileConsent('co-1', 'om-1', [], humanMember, config);
  assert.deepEqual(profile.consentedSignalTypes, []);
  // Withdrawing consent does not retroactively delete already-aggregated values (§3).
  assert.equal(profile.sampleCount, 5);
  assert.ok(calls.some((c) => c.toolName === 'memory_store'));
});

// --- §4: no computation for an unconsented signal type -----------------------

test('recomputeInteractionSignals writes nothing and makes no scan call when internal-timing is not consented', async () => {
  const profile = baseProfile({ consentedSignalTypes: [] });
  const { calls, config } = mockBridge({
    'memory_retrieve': (args) => (args.key === profileKey('co-1', 'om-1') ? { found: true, value: profile } : { found: false }),
  });
  const result = await recomputeInteractionSignals('co-1', 'om-1', config);
  assert.deepEqual(result, profile);
  assert.ok(!calls.some((c) => c.toolName === 'memory_store'));
  assert.ok(!calls.some((c) => c.toolName === 'agentdb_hierarchical-recall'));
});

test('recomputeInteractionSignals returns null and writes nothing when no profile exists at all (never consented)', async () => {
  const { calls, config } = mockBridge({
    'memory_retrieve': () => ({ found: false }),
  });
  const result = await recomputeInteractionSignals('co-1', 'om-1', config);
  assert.equal(result, null);
  assert.ok(!calls.some((c) => c.toolName === 'memory_store'));
});

// --- §4: the latency-pairing / median / histogram computation itself --------

test('recomputeInteractionSignals pairs each approve/reject transition with the immediately-prior submit for the SAME issue, computing median latency and the hour histogram', async () => {
  const profile = baseProfile({ consentedSignalTypes: ['internal-timing'] });
  const submit1 = baseTransition({
    id: 't-submit-1', issueId: 'issue-1', action: 'submit', fromState: 'draft', toState: 'pending',
    actorId: 'om-submitter', createdAt: '2026-09-01T10:00:00.000Z',
  });
  const approve1 = baseTransition({
    id: 't-approve-1', issueId: 'issue-1', action: 'approve', fromState: 'pending', toState: 'approved',
    actorId: 'om-approver', createdAt: '2026-09-01T10:01:40.000Z', // +100s
  });
  const submit2 = baseTransition({
    id: 't-submit-2', issueId: 'issue-2', action: 'submit', fromState: 'draft', toState: 'pending',
    actorId: 'om-submitter2', createdAt: '2026-09-01T14:00:00.000Z',
  });
  const reject2 = baseTransition({
    id: 't-reject-2', issueId: 'issue-2', action: 'reject', fromState: 'pending', toState: 'rejected',
    actorId: 'om-approver', reason: 'not ready', createdAt: '2026-09-01T14:00:50.000Z', // +50s
  });

  const { config } = mockBridge({
    'memory_retrieve': (args) => (args.key === profileKey('co-1', 'om-approver') ? { found: true, value: profile } : { found: false }),
    'memory_store': () => ({ success: true }),
    'agentdb_hierarchical-recall': (args) =>
      args.tier === 'working'
        ? { results: [submit1, approve1, submit2, reject2].map((t) => ({ value: JSON.stringify(t) })) }
        : { results: [] },
  });

  const updated = await recomputeInteractionSignals('co-1', 'om-approver', config);
  assert.equal(updated?.sampleCount, 2);
  assert.equal(updated?.medianDecisionLatencySeconds, 75); // median(100, 50)
  assert.equal(updated?.decisionHourHistogram[10], 1);
  assert.equal(updated?.decisionHourHistogram[14], 1);
  assert.equal(updated?.decisionHourHistogram.reduce((a, b) => a + b, 0), 2);
});

test('recomputeInteractionSignals ignores submit/revise transitions as latency samples and only pairs against the actor\'s own approve/reject decisions', async () => {
  const profile = baseProfile({ consentedSignalTypes: ['internal-timing'] });
  // A revise->resubmit chain before the final approve: reject, then revise
  // (by the submitter), then a fresh submit, then approve by om-approver.
  // Only the LAST submit->approve pairing should count.
  const submit1 = baseTransition({ id: 't1', issueId: 'issue-1', action: 'submit', fromState: 'draft', toState: 'pending', actorId: 'om-submitter', createdAt: '2026-09-01T09:00:00.000Z' });
  const reject1 = baseTransition({ id: 't2', issueId: 'issue-1', action: 'reject', fromState: 'pending', toState: 'rejected', actorId: 'om-approver', reason: 'no', createdAt: '2026-09-01T09:00:10.000Z' });
  const revise1 = baseTransition({ id: 't3', issueId: 'issue-1', action: 'revise', fromState: 'rejected', toState: 'draft', actorId: 'om-submitter', createdAt: '2026-09-01T09:05:00.000Z' });
  const submit2 = baseTransition({ id: 't4', issueId: 'issue-1', action: 'submit', fromState: 'draft', toState: 'pending', actorId: 'om-submitter', createdAt: '2026-09-01T09:06:00.000Z' });
  const approve1 = baseTransition({ id: 't5', issueId: 'issue-1', action: 'approve', fromState: 'pending', toState: 'approved', actorId: 'om-approver', createdAt: '2026-09-01T09:07:00.000Z' }); // +60s from submit2

  const { config } = mockBridge({
    'memory_retrieve': (args) => (args.key === profileKey('co-1', 'om-approver') ? { found: true, value: profile } : { found: false }),
    'memory_store': () => ({ success: true }),
    'agentdb_hierarchical-recall': (args) =>
      args.tier === 'working'
        ? { results: [submit1, reject1, revise1, submit2, approve1].map((t) => ({ value: JSON.stringify(t) })) }
        : { results: [] },
  });

  const updated = await recomputeInteractionSignals('co-1', 'om-approver', config);
  // Two decisions by om-approver: reject1 (paired with submit1, +10s) and approve1 (paired with submit2, +60s).
  assert.equal(updated?.sampleCount, 2);
  assert.equal(updated?.medianDecisionLatencySeconds, 35); // median(10, 60)
});

// --- applyApprovalTransition: deps.interactionLearning wiring ---------------

test('applyApprovalTransition with deps.interactionLearning omitted never touches memory_store/memory_retrieve — existing behavior unchanged', async () => {
  const original = baseIssue({ approvalState: 'draft', approvalTransitionRef: null, status: 'open' });
  const actor = baseActor({ id: 'om-submitter', kind: 'agent', role: 'Engineer' });
  const approver = baseActor({ id: 'om-approver', kind: 'agent', role: 'Engineer' });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
        return { results: [{ key: args.query, value: JSON.stringify(original) }] };
      }
      if (args.tier === 'semantic' && args.query === orgMemberRecallKey('co-1', 'om-submitter')) {
        return { results: [{ key: args.query, value: JSON.stringify(actor) }] };
      }
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_handoff': () => ({ success: true }),
    'claims_list': activeClaimFor(actor, 'issue-1'),
  });
  const result = await applyApprovalTransition('co-1', original, 'submit', actor, null, { approver }, config);
  assert.equal(result.issue.approvalState, 'pending');
  assert.ok(!calls.some((c) => c.toolName === 'memory_store' || c.toolName === 'memory_retrieve'));
});

test('applyApprovalTransition succeeds even when recomputeInteractionSignals fails — interactionLearning is best-effort, same non-blocking contract as notifications', async () => {
  const submit = baseTransition({ id: 'transition-submit', actorId: 'om-submitter', fromState: 'draft', toState: 'pending' });
  const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const approver = baseActor({ id: 'om-approver', kind: 'agent', role: 'Engineer' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
        return { results: [{ key: args.query, value: JSON.stringify(pendingIssue) }] };
      }
      if (args.tier === 'semantic' && args.query === orgMemberRecallKey('co-1', 'om-approver')) {
        return { results: [{ key: args.query, value: JSON.stringify(approver) }] };
      }
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_accept-handoff': () => ({ success: true }),
    'claims_list': activeClaimFor(approver, 'issue-1'),
    // Deliberately NO 'memory_retrieve' handler — recomputeInteractionSignals's
    // first call throws "No mock handler registered", proving the approval
    // still succeeds despite that failure.
  });
  const result = await applyApprovalTransition(
    'co-1',
    pendingIssue,
    'approve',
    approver,
    submit,
    { interactionLearning: true },
    config,
  );
  assert.equal(result.issue.approvalState, 'approved');
});

test('applyApprovalTransition with deps.interactionLearning: true triggers recomputeInteractionSignals for approve/reject', async () => {
  const submit = baseTransition({ id: 'transition-submit', actorId: 'om-submitter', fromState: 'draft', toState: 'pending' });
  const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const approver = baseActor({ id: 'om-approver', kind: 'agent', role: 'Engineer' });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
        return { results: [{ key: args.query, value: JSON.stringify(pendingIssue) }] };
      }
      if (args.tier === 'semantic' && args.query === orgMemberRecallKey('co-1', 'om-approver')) {
        return { results: [{ key: args.query, value: JSON.stringify(approver) }] };
      }
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_accept-handoff': () => ({ success: true }),
    'claims_list': activeClaimFor(approver, 'issue-1'),
    'memory_retrieve': () => ({ found: false }), // no profile -> no-op, but the call must have happened
  });
  await applyApprovalTransition('co-1', pendingIssue, 'approve', approver, submit, { interactionLearning: true }, config);
  assert.ok(calls.some((c) => c.toolName === 'memory_retrieve' && c.args.key === profileKey('co-1', 'om-approver')));
});

// --- §2/§6: structural guarantee — no second identity parameter -------------

test(
  'structural guarantee: recallOwnInteractionProfile takes exactly (actor, config?) — an arity change here means a ' +
    'targetOrgMemberId parameter was accidentally added (or the actor param was removed)',
  () => {
    assert.equal(recallOwnInteractionProfile.length, 2);
  },
);

test(
  'structural guarantee: recallInteractionProfileForComposition takes exactly (companyId, orgMemberId, config?) — ' +
    'no actor/requester parameter exists on this function',
  () => {
    assert.equal(recallInteractionProfileForComposition.length, 3);
  },
);
