/**
 * Coverage for the Phase 1d authorization slice (docs/design/AUTHORIZATION.md)
 * that isn't already exercised by tests/control-plane/approval-gate.test.ts's
 * Guard A/B tests (which mostly leave Guard C a no-op by never supplying an
 * approvalTransition) or its applyApprovalTransition happy-path tests
 * (which always supply valid claims_* mocks and never exercise a claims
 * failure or Guard C's isolated rejection branches).
 *
 * Covers: verifyActorHoldsClaim directly (success, no-match, claims_list
 * failure, and the claims_board fallback for an unexpected response shape —
 * AUTHORIZATION.md §1's flagged assumption), claimIssueForActor /
 * handoffClaim / acceptClaimHandoff success+failure, Guard C's four checks
 * in isolation (missing authorization, actor/transition id mismatch,
 * inactive actor, and — the specific case 57ab6ab flagged — a forged
 * ApprovalTransition reusing the real submitter's id, calling persistIssue
 * directly and bypassing applyApprovalTransition entirely), a failed
 * claims_accept-handoff short-circuiting applyApprovalTransition before
 * transitionApprovalState runs, and true stateful round trips
 * (submit->approve, submit->reject->revise) against an in-memory mock that
 * actually tracks hierarchical-store/claims state across sequential calls
 * (tests/support/mock-bridge.ts's per-test handlers are otherwise stateless
 * pure functions of one call's args).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { credentialFor, nonceMockHandlers } from '../support/actor-credential-fixture.js';
import {
  orgMemberClaimant,
  verifyActorHoldsClaim,
  claimIssueForActor,
  handoffClaim,
  acceptClaimHandoff,
  ClaimAuthorizationError,
} from '../../src/control-plane/authorization/claims-authorization.js';
import {
  persistIssue,
  persistOrgMember,
  recallApprovalTransition,
  applyApprovalTransition,
  ApprovalGateViolationError,
} from '../../src/control-plane/store/agentdb-adapter.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';

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

// --- orgMemberClaimant ---------------------------------------------------

test('orgMemberClaimant formats "{kind}:{id}:{role}" per the real claims_* claimant format', () => {
  assert.equal(orgMemberClaimant(baseActor({ kind: 'agent', id: 'coder-1', role: 'coder' })), 'agent:coder-1:coder');
  assert.equal(
    orgMemberClaimant(baseActor({ kind: 'human', id: 'user-1', role: 'Alice' })),
    'human:user-1:Alice',
  );
});

// --- verifyActorHoldsClaim ------------------------------------------------

test('verifyActorHoldsClaim resolves when claims_list reports a matching active claim', async () => {
  const actor = baseActor();
  const { config } = mockBridge({
    'claims_list': () => ({
      success: true,
      claims: [{ issueId: 'issue-1', claimant: { type: 'agent', agentId: 'om-submitter', agentType: 'Engineer' }, status: 'active' }],
    }),
  });
  await assert.doesNotReject(() => verifyActorHoldsClaim('issue-1', actor, config));
});

test('verifyActorHoldsClaim rejects when claims_list has no matching issueId', async () => {
  const actor = baseActor();
  const { config } = mockBridge({
    'claims_list': () => ({
      success: true,
      claims: [{ issueId: 'some-other-issue', claimant: { type: 'agent', agentId: 'om-submitter', agentType: 'Engineer' }, status: 'active' }],
    }),
  });
  await assert.rejects(() => verifyActorHoldsClaim('issue-1', actor, config), ClaimAuthorizationError);
});

test('verifyActorHoldsClaim rejects when claims_list returns an empty list', async () => {
  const actor = baseActor();
  const { config } = mockBridge({
    'claims_list': () => ({ success: true, claims: [] }),
  });
  await assert.rejects(() => verifyActorHoldsClaim('issue-1', actor, config), ClaimAuthorizationError);
});

test('verifyActorHoldsClaim rejects when claims_list itself fails', async () => {
  const actor = baseActor();
  const { config } = mockBridge({
    'claims_list': () => ({ success: false, error: 'boom' }),
  });
  await assert.rejects(() => verifyActorHoldsClaim('issue-1', actor, config), ClaimAuthorizationError);
});

test(
  'verifyActorHoldsClaim falls back to claims_board when claims_list returns an unexpected shape ' +
    '(AUTHORIZATION.md §1\'s flagged assumption) and succeeds via the fallback',
  async () => {
    const actor = baseActor();
    const { calls, config } = mockBridge({
      // Deliberately NOT the real shape (missing issueId on the record) —
      // simulates the "claims_list's records don't carry issueId" case the
      // design doc names.
      'claims_list': () => ({ success: true, claims: [{ claimant: { type: 'agent' } }] }),
      'claims_board': () => ({
        success: true,
        board: { active: [{ issueId: 'issue-1', claimant: 'agent:om-submitter:Engineer' }] },
      }),
    });
    await assert.doesNotReject(() => verifyActorHoldsClaim('issue-1', actor, config));
    assert.deepEqual(
      calls.map((c) => c.toolName),
      ['claims_list', 'claims_board'],
    );
  },
);

test('verifyActorHoldsClaim fails loudly (not silently) when both claims_list has an unexpected shape AND the claims_board fallback finds no match', async () => {
  const actor = baseActor();
  const { config } = mockBridge({
    'claims_list': () => ({ success: true, claims: [{ claimant: { type: 'agent' } }] }),
    'claims_board': () => ({ success: true, board: { active: [] } }),
  });
  await assert.rejects(() => verifyActorHoldsClaim('issue-1', actor, config), ClaimAuthorizationError);
});

// --- claimIssueForActor / handoffClaim / acceptClaimHandoff --------------

test('claimIssueForActor resolves on success and throws ClaimAuthorizationError on failure', async () => {
  const actor = baseActor();
  const { config: okConfig } = mockBridge({ 'claims_claim': () => ({ success: true }) });
  await assert.doesNotReject(() => claimIssueForActor('issue-1', actor, undefined, okConfig));

  const { config: failConfig } = mockBridge({
    'claims_claim': () => ({ success: false, error: 'Issue already claimed by agent:someone-else:Engineer' }),
  });
  await assert.rejects(() => claimIssueForActor('issue-1', actor, undefined, failConfig), ClaimAuthorizationError);
});

test('handoffClaim resolves on success and throws ClaimAuthorizationError on failure', async () => {
  const from = baseActor({ id: 'om-submitter' });
  const to = baseActor({ id: 'om-approver' });
  const { config: okConfig } = mockBridge({ 'claims_handoff': () => ({ success: true }) });
  await assert.doesNotReject(() => handoffClaim('issue-1', from, to, undefined, okConfig));

  const { config: failConfig } = mockBridge({
    'claims_handoff': () => ({ success: false, error: 'Only the current claimant can request handoff' }),
  });
  await assert.rejects(() => handoffClaim('issue-1', from, to, undefined, failConfig), ClaimAuthorizationError);
});

test('acceptClaimHandoff resolves on success and throws ClaimAuthorizationError on failure', async () => {
  const actor = baseActor({ id: 'om-approver' });
  const { config: okConfig } = mockBridge({ 'claims_accept-handoff': () => ({ success: true }) });
  await assert.doesNotReject(() => acceptClaimHandoff('issue-1', actor, okConfig));

  const { config: failConfig } = mockBridge({
    'claims_accept-handoff': () => ({ success: false, error: 'No pending handoff for this issue' }),
  });
  await assert.rejects(() => acceptClaimHandoff('issue-1', actor, failConfig), ClaimAuthorizationError);
});

// --- Guard C in isolation --------------------------------------------------

/** recall handler returning `stored` for the issue's working-tier key, and nothing else. */
function recallReturning(stored: Issue | null) {
  return (args: Record<string, unknown>) =>
    args.tier === 'working' && stored ? { results: [{ key: issueKeyStr, value: JSON.stringify(stored) }] } : { results: [] };
}

test('Guard C rejects when approvalState changes but authorization is not supplied', async () => {
  const stored = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const transition = baseTransition({ id: 'transition-1', fromState: 'draft', toState: 'pending' });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1' });
  await assert.rejects(
    () => persistIssue('co-1', issue, undefined, transition, undefined, config),
    ApprovalGateViolationError,
  );
  // Guard A passed (no rejection until Guard C), so the issue write must not
  // have happened either — Guard C ran before any write.
  assert.ok(!calls.some((c) => c.toolName === 'agentdb_hierarchical-store'));
});

test('Guard C rejects when authorization.actor.id does not match approvalTransition.actorId', async () => {
  const stored = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const transition = baseTransition({ id: 'transition-1', fromState: 'draft', toState: 'pending', actorId: 'om-submitter' });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1' });
  const impersonator = baseActor({ id: 'om-impersonator' });
  await assert.rejects(
    () => persistIssue('co-1', issue, undefined, transition, { actor: impersonator }, config),
    ApprovalGateViolationError,
  );
});

test('Guard C rejects when authorization.actor.status is not active', async () => {
  const stored = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': recallReturning(stored),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const transition = baseTransition({ id: 'transition-1', fromState: 'draft', toState: 'pending', actorId: 'om-submitter' });
  const issue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-1' });
  const inactiveActor = baseActor({ id: 'om-submitter', status: 'inactive' });
  await assert.rejects(
    () => persistIssue('co-1', issue, undefined, transition, { actor: inactiveActor }, config),
    ApprovalGateViolationError,
  );
});

test(
  'Guard C rejects self-approval verified against the PERSISTED submit record — the exact 57ab6ab forgery case: ' +
    'a structurally-legal ApprovalTransition reusing the real submitter\'s id as the "approver," calling ' +
    'persistIssue directly and bypassing applyApprovalTransition entirely',
  async () => {
    const submitterId = 'om-submitter';
    const submitTransitionKey = `${issueKeyStr}:approval-transition:transition-submit`;
    const persistedSubmitTransition = baseTransition({
      id: 'transition-submit',
      action: 'submit',
      fromState: 'draft',
      toState: 'pending',
      actorId: submitterId,
    });
    const stored = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
    const orgMemberKeyStr = `ruclip:company:co-1:org-member:${submitterId}`;
    // The forged approval names submitterId as the "approver," so Guard C's
    // (now ground-truth-recalled) actor-active check must find a persisted,
    // active OrgMember for that id — otherwise the test would reject for
    // "no persisted OrgMember record" instead of the self-approval recheck
    // this test exists to exercise.
    const impersonatingSubmitterRecord = baseActor({ id: submitterId, status: 'active' });

    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        const query = args.query as string;
        if (args.tier === 'semantic' && query === orgMemberKeyStr) {
          return { results: [{ key: orgMemberKeyStr, value: JSON.stringify(impersonatingSubmitterRecord) }] };
        }
        if (args.tier !== 'working') return { results: [] };
        if (query === issueKeyStr) return { results: [{ key: issueKeyStr, value: JSON.stringify(stored) }] };
        if (query === submitTransitionKey) {
          return { results: [{ key: submitTransitionKey, value: JSON.stringify(persistedSubmitTransition) }] };
        }
        return { results: [] };
      },
      'agentdb_hierarchical-store': () => ({ success: true }),
      // If Guard C's live-claims check were ever reached, this would report
      // the forged actor as holding a claim — proving the rejection below
      // comes from the persisted-record self-approval recheck, not from
      // verifyActorHoldsClaim happening to fail too.
      'claims_list': () => ({
        success: true,
        claims: [{ issueId: 'issue-1', claimant: { type: 'agent', agentId: submitterId, agentType: 'Engineer' }, status: 'active' }],
      }),
    });

    // Forged: every id/state cross-reference lines up (issueId, fromState,
    // toState, id-matches-approvalTransitionRef) and the (action,fromState,
    // toState) triple IS legal — approve:pending->approved is real — so
    // Guard A alone would accept this. Only re-checking self-approval
    // against the record persistIssue itself already wrote (not this
    // caller-supplied transition object) catches it.
    const forgedApproval = baseTransition({
      id: 'transition-approve',
      action: 'approve',
      fromState: 'pending',
      toState: 'approved',
      actorId: submitterId,
    });
    const issue = baseIssue({ approvalState: 'approved', approvalTransitionRef: 'transition-approve' });
    const impersonatingSubmitter = baseActor({ id: submitterId });

    await assert.rejects(
      () => persistIssue('co-1', issue, undefined, forgedApproval, { actor: impersonatingSubmitter }, config),
      ClaimAuthorizationError,
    );
    assert.ok(
      !calls.some((c) => c.toolName === 'agentdb_hierarchical-store'),
      'the forged self-approval must be rejected before any write',
    );
  },
);

test('recallApprovalTransition (used by Guard C\'s self-approval recheck) round-trips a stored transition by key', async () => {
  const transition = baseTransition({ id: 'transition-submit' });
  const key = `${issueKeyStr}:approval-transition:transition-submit`;
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) =>
      args.tier === 'working' && args.query === key
        ? { results: [{ key, value: JSON.stringify(transition) }] }
        : { results: [] },
  });
  const recalled = await recallApprovalTransition('co-1', 'goal-1', 'issue-1', 'transition-submit', config);
  assert.deepEqual(recalled, transition);
});

// --- applyApprovalTransition: failed claims_accept-handoff short-circuits ---

test('applyApprovalTransition: a failed claims_accept-handoff short-circuits before transitionApprovalState runs', async () => {
  const submit = baseTransition({ id: 'transition-submit', actorId: 'om-submitter', fromState: 'draft', toState: 'pending' });
  const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
  const approver = baseActor({ id: 'om-approver' });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args) =>
      args.tier === 'semantic' && args.query === 'ruclip:company:co-1:org-member:om-approver'
        ? { results: [{ key: args.query, value: JSON.stringify(approver) }] }
        : { results: [] },
    'claims_accept-handoff': () => ({ success: false, error: 'No pending handoff for this issue' }),
    ...nonceMockHandlers(),
  });

  const authorization = await credentialFor(approver);
  await assert.rejects(
    () => applyApprovalTransition('co-1', pendingIssue, 'approve', authorization, submit, {}, config),
    ClaimAuthorizationError,
  );
  // No hierarchical-store — proves the rejection happened before persistIssue
  // (and before transitionApprovalState) ever ran; the hierarchical-recall
  // seen here is credential verification's own recallOrgMember, which now
  // necessarily runs before claims_accept-handoff.
  assert.deepEqual(
    calls.map((c) => c.toolName),
    ['memory_retrieve', 'memory_store', 'agentdb_hierarchical-recall', 'claims_accept-handoff'],
  );
});

// --- End-to-end round trips against a stateful mock -------------------------

/**
 * Minimal in-memory backend standing in for the real AgentDB + claims
 * bridge across a MULTI-CALL sequence — tests/support/mock-bridge.ts's
 * handlers are otherwise stateless (pure functions of one call's args), but
 * a genuine round trip (submit, then approve; or submit, reject, revise)
 * needs each step to see the previous step's writes, matching how
 * AUTHORIZATION.md §4/§8 describes the claim actually moving between
 * claimants across calls.
 */
function createStatefulBridge() {
  const tiers: Record<string, Map<string, string>> = { working: new Map(), episodic: new Map(), semantic: new Map() };
  const claim: { claimant: string | null; status: 'active' | 'handoff-pending'; handoffTo: string | null } = {
    claimant: null,
    status: 'active',
    handoffTo: null,
  };

  const { calls, config } = mockBridge({
    'agentdb_hierarchical-store': (args) => {
      tiers[args.tier as string]!.set(args.key as string, args.value as string);
      return { success: true };
    },
    'agentdb_hierarchical-delete': (args) => {
      tiers[args.tier as string]!.delete(args.key as string);
      return { success: true };
    },
    'agentdb_hierarchical-recall': (args) => {
      const tier = args.tier as string | undefined;
      const query = args.query as string;
      const tiersToCheck = tier ? [tier] : ['working', 'episodic', 'semantic'];
      for (const t of tiersToCheck) {
        const value = tiers[t]!.get(query);
        if (value !== undefined) return { results: [{ key: query, value }] };
      }
      return { results: [] };
    },
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_claim': (args) => {
      claim.claimant = args.claimant as string;
      claim.status = 'active';
      return { success: true };
    },
    'claims_handoff': (args) => {
      if (claim.claimant !== args.from) {
        return { success: false, error: 'Only the current claimant can request handoff' };
      }
      claim.status = 'handoff-pending';
      claim.handoffTo = args.to as string;
      return { success: true };
    },
    'claims_accept-handoff': (args) => {
      if (claim.status !== 'handoff-pending' || claim.handoffTo !== args.claimant) {
        return { success: false, error: 'No pending handoff for this issue' };
      }
      claim.claimant = args.claimant as string;
      claim.status = 'active';
      claim.handoffTo = null;
      return { success: true };
    },
    'claims_list': (args) => {
      if (claim.claimant !== args.claimant) {
        return { success: true, claims: [] };
      }
      const [type, id, label] = (claim.claimant as string).split(':');
      const claimant = type === 'human' ? { type, userId: id, name: label } : { type, agentId: id, agentType: label };
      return { success: true, claims: [{ issueId: 'issue-1', claimant, status: claim.status }] };
    },
    ...nonceMockHandlers(),
  });
  return { calls, config };
}

test('End-to-end round trip: submit -> approve against a stateful mock', async () => {
  const submitter = baseActor({ id: 'om-submitter' });
  const approver = baseActor({ id: 'om-approver' });
  const { config } = createStatefulBridge();

  // Persisted so Guard C's actor-active check (now ground-truth-recalled,
  // not trusted from the caller-supplied object — see agentdb-adapter.ts's
  // checkAuthorizationGuard) finds a real, active OrgMember record for each.
  await persistOrgMember(submitter, config);
  await persistOrgMember(approver, config);

  // Claim established at issue-creation time, per AUTHORIZATION.md §5.
  await claimIssueForActor('issue-1', submitter, undefined, config);

  const draft = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  await persistIssue('co-1', draft, undefined, undefined, undefined, config);
  const submitResult = await applyApprovalTransition(
    'co-1',
    draft,
    'submit',
    await credentialFor(submitter),
    null,
    { approver },
    config,
  );
  assert.equal(submitResult.issue.approvalState, 'pending');

  const approveResult = await applyApprovalTransition(
    'co-1',
    submitResult.issue,
    'approve',
    await credentialFor(approver),
    submitResult.transition,
    {},
    config,
  );
  assert.equal(approveResult.issue.approvalState, 'approved');
  assert.equal(approveResult.transition.actorId, 'om-approver');
});

test('End-to-end round trip: submit -> reject -> revise against a stateful mock', async () => {
  const submitter = baseActor({ id: 'om-submitter' });
  const approver = baseActor({ id: 'om-approver' });
  const { config } = createStatefulBridge();

  await persistOrgMember(submitter, config);
  await persistOrgMember(approver, config);

  await claimIssueForActor('issue-1', submitter, undefined, config);

  const draft = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
  await persistIssue('co-1', draft, undefined, undefined, undefined, config);
  const submitResult = await applyApprovalTransition(
    'co-1',
    draft,
    'submit',
    await credentialFor(submitter),
    null,
    { approver },
    config,
  );
  assert.equal(submitResult.issue.approvalState, 'pending');

  const rejectResult = await applyApprovalTransition(
    'co-1',
    submitResult.issue,
    'reject',
    await credentialFor(approver),
    submitResult.transition,
    { reason: 'needs more detail', handoffTo: submitter },
    config,
  );
  assert.equal(rejectResult.issue.approvalState, 'rejected');
  assert.equal(rejectResult.transition.reason, 'needs more detail');

  const reviseResult = await applyApprovalTransition(
    'co-1',
    rejectResult.issue,
    'revise',
    await credentialFor(submitter),
    rejectResult.transition,
    {},
    config,
  );
  assert.equal(reviseResult.issue.approvalState, 'draft');
});
