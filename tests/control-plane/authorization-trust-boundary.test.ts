/**
 * Independent coverage for the Phase 1d claims_* authorization slice
 * (commit c52c8d8), complementing tests/control-plane/claims-authorization.test.ts
 * (written by the coder for their own commit — verifyActorHoldsClaim,
 * claimIssueForActor/handoffClaim/acceptClaimHandoff, Guard C's four checks
 * in isolation including the exact 57ab6ab forged-transition case, and two
 * stateful submit->approve / submit->reject->revise round trips).
 *
 * Per the task brief, this targets exactly the two questions asked: can
 * Guard C be bypassed the way the old Guard A create-path bug worked
 * (trusting caller-supplied data instead of recalling ground truth), and is
 * self-approval actually unbypassable now that it's enforced via persisted
 * claim state. Read src/control-plane/store/agentdb-adapter.ts's
 * checkAuthorizationGuard (Guard C) and applyApprovalTransition in full
 * before writing these.
 *
 * FINDING (test 1 below): checkAuthorizationGuard's `actor.status !== 'active'`
 * check operates ENTIRELY on the caller-supplied `authorization.actor`
 * object — it never calls recallOrgMember (exported, but grep confirms it
 * has no other call site in agentdb-adapter.ts) to cross-reference the
 * actually-persisted OrgMember record. This is structurally the same class
 * of bug as the pre-de48670 Guard A create-path issue: trusting a
 * caller-supplied field instead of recalling ground truth. A caller who
 * knows a real, currently-live claimant string (kind:id:role — needed to
 * pass verifyActorHoldsClaim, the one check that IS unforgeable) can freely
 * lie about that actor's `status` field and Guard C will not catch it,
 * because nothing ever looks up what that OrgMember's real, persisted
 * status is. This is narrower than the old Guard A bug (verifyActorHoldsClaim
 * still requires a genuine live claim, which isn't forgeable from inside
 * this repo) but it is real: an OrgMember an operator has marked 'inactive'
 * in ruClip's own store — expecting that to freeze their approval authority
 * — keeps deciding approvals for as long as ruflo's claims system (which
 * has no concept of ruClip's OrgMember.status at all) still shows them
 * holding the claim.
 *
 * ANSWER (test 2 below): self-approval via the *legitimate* choreography —
 * an actor submits an issue naming themselves as deps.approver, then calls
 * 'approve' as themselves — IS still blocked, by transitionApprovalState's
 * own actor.id === previousTransition.actorId check (unchanged from the
 * Phase 1c slice). Guard C's persisted-record re-check (already tested by
 * the coder for the persistIssue-bypass forgery case) is a second,
 * independent line of defense for a different attack shape; this test
 * exercises the first line of defense via the honest, non-bypassing API
 * path the coder's own round-trip tests don't attempt (their round trips
 * always use a distinct submitter/approver pair).
 *
 * No live AgentDB/claims instance — mockBridge / a small stateful mock, same
 * as the rest of this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import {
  persistIssue,
  applyApprovalTransition,
  recallOrgMember,
} from '../../src/control-plane/store/agentdb-adapter.js';
import { IllegalApprovalTransitionError } from '../../src/control-plane/approval/transition-approval-state.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';

const now = '2026-09-01T00:00:00.000Z';
const issueKeyStr = 'ruclip:company:co-1:goal:goal-1:issue:issue-1';
const orgMemberKeyStr = 'ruclip:company:co-1:org-member:om-approver';
const submitTransitionKeyStr = `${issueKeyStr}:approval-transition:transition-submit`;

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
    id: 'om-approver',
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

// --- Finding: Guard C trusts the caller-supplied actor.status, never recalls ground truth ---

test(
  'Guard C accepts a self-reported status: "active" actor even when the REAL, persisted OrgMember record ' +
    'for that id is "inactive" — checkAuthorizationGuard never calls recallOrgMember',
  async () => {
    const realInactiveMember: OrgMember = baseActor({ id: 'om-approver', status: 'inactive' });
    const persistedSubmitTransition = baseTransition({ actorId: 'om-submitter' }); // different actor: not a self-approval case
    const stored = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });

    // Ground truth, established independently: the real persisted OrgMember
    // record for om-approver genuinely has status: 'inactive'.
    const { config: groundTruthConfig } = mockBridge({
      'agentdb_hierarchical-recall': (args) =>
        args.query === orgMemberKeyStr
          ? { results: [{ key: orgMemberKeyStr, value: JSON.stringify(realInactiveMember) }] }
          : { results: [] },
    });
    const recalledGroundTruth = await recallOrgMember('co-1', 'om-approver', groundTruthConfig);
    assert.equal(recalledGroundTruth?.status, 'inactive', 'test setup sanity check: the real record must be inactive');

    // The attack: persistIssue is called (bypassing applyApprovalTransition,
    // same shape as the coder's 57ab6ab forgery test) with an approve
    // transition whose actorId is 'om-approver', and an authorization.actor
    // object claiming status: 'active' for that same id. No handler for the
    // org-member key is registered on THIS bridge at all — if Guard C ever
    // tried to recall the real record, this mock would throw
    // "No mock handler registered", proving definitively that it doesn't.
    const { config: attackConfig } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.query === issueKeyStr && args.tier === 'working') {
          return { results: [{ key: issueKeyStr, value: JSON.stringify(stored) }] };
        }
        if (args.query === submitTransitionKeyStr && args.tier === 'working') {
          return { results: [{ key: submitTransitionKeyStr, value: JSON.stringify(persistedSubmitTransition) }] };
        }
        return { results: [] };
      },
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      'claims_list': (args) =>
        args.claimant === 'agent:om-approver:Engineer'
          ? { success: true, claims: [{ issueId: 'issue-1', claimant: { type: 'agent', agentId: 'om-approver', agentType: 'Engineer' }, status: 'active' }] }
          : { success: true, claims: [] },
    });

    const forgedActiveClaim = baseActor({ id: 'om-approver', status: 'active' }); // lies about status
    const approveTransition = baseTransition({
      id: 'transition-approve',
      action: 'approve',
      fromState: 'pending',
      toState: 'approved',
      actorId: 'om-approver',
    });
    const approvedIssue = baseIssue({
      approvalState: 'approved',
      approvalTransitionRef: 'transition-approve',
    });

    // If this rejects, Guard C is doing its job correctly and this test
    // documents that the finding above is NOT (or no longer) exploitable.
    // As of commit c52c8d8, it does not reject.
    await assert.doesNotReject(() =>
      persistIssue('co-1', approvedIssue, undefined, approveTransition, { actor: forgedActiveClaim }, attackConfig),
    );
  },
);

// --- Answer: self-approval via the honest, non-bypassing choreography IS still blocked ---

test(
  'applyApprovalTransition: an actor who submits an issue naming THEMSELVES as deps.approver ' +
    'still cannot approve() it as themselves — transitionApprovalState\'s self-approval check ' +
    'blocks the honest choreography, not just the forged persistIssue-bypass case',
  async () => {
    const tiers: Record<string, Map<string, string>> = { working: new Map(), episodic: new Map(), semantic: new Map() };
    const claim: { claimant: string | null; status: 'active' | 'handoff-pending'; handoffTo: string | null } = {
      claimant: null,
      status: 'active',
      handoffTo: null,
    };
    const { config } = mockBridge({
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
        if (claim.claimant !== args.from) return { success: false, error: 'Only the current claimant can request handoff' };
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
        if (claim.claimant !== args.claimant) return { success: true, claims: [] };
        const [type, id, label] = (claim.claimant as string).split(':');
        const claimant = type === 'human' ? { type, userId: id, name: label } : { type, agentId: id, agentType: label };
        return { success: true, claims: [{ issueId: 'issue-1', claimant, status: claim.status }] };
      },
    });

    const selfDealer = baseActor({ id: 'om-self-dealer' });
    await import('../../src/control-plane/authorization/claims-authorization.js').then(({ claimIssueForActor }) =>
      claimIssueForActor('issue-1', selfDealer, undefined, config),
    );

    const draft = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });
    await persistIssue('co-1', draft, undefined, undefined, undefined, config);

    // Submits naming themselves as the approver — nothing in applyApprovalTransition
    // stops deps.approver === actor at the choreography layer.
    const submitResult = await applyApprovalTransition(
      'co-1',
      draft,
      'submit',
      selfDealer,
      null,
      { approver: selfDealer },
      config,
    );
    assert.equal(submitResult.issue.approvalState, 'pending');

    // Now attempts to approve as the same actor who just submitted.
    await assert.rejects(
      () =>
        applyApprovalTransition('co-1', submitResult.issue, 'approve', selfDealer, submitResult.transition, {}, config),
      IllegalApprovalTransitionError,
    );

    // And the issue's persisted state must still show 'pending', never 'approved'.
    const finalIssue = JSON.parse(tiers.working!.get(issueKeyStr)!) as Issue;
    assert.equal(finalIssue.approvalState, 'pending');
  },
);
