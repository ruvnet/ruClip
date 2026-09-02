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
 * FINDING (test 1 below), FIXED post-a51d487: checkAuthorizationGuard's
 * `actor.status !== 'active'` check originally operated ENTIRELY on the
 * caller-supplied `authorization.actor` object — it never called
 * recallOrgMember to cross-reference the actually-persisted OrgMember
 * record. That was structurally the same class of bug as the pre-de48670
 * Guard A create-path issue: trusting a caller-supplied field instead of
 * recalling ground truth. A caller who knew a real, currently-live claimant
 * string (kind:id:role — needed to pass verifyActorHoldsClaim, the one
 * check that IS unforgeable) could freely lie about that actor's `status`
 * field and Guard C would not catch it, because nothing ever looked up what
 * that OrgMember's real, persisted status was. That was narrower than the
 * old Guard A bug (verifyActorHoldsClaim still requires a genuine live
 * claim, which isn't forgeable from inside this repo) but it was real: an
 * OrgMember an operator has marked 'inactive' in ruClip's own store —
 * expecting that to freeze their approval authority — would keep deciding
 * approvals for as long as ruflo's claims system (which has no concept of
 * ruClip's OrgMember.status at all) still showed them holding the claim.
 * checkAuthorizationGuard now calls recallOrgMember and checks the
 * PERSISTED record's status (a missing record is treated as unauthorized,
 * not as "trust the caller") — test 1 below now locks down the rejection.
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
import { credentialFor, nonceMockHandlers } from '../support/actor-credential-fixture.js';
import {
  persistIssue,
  persistOrgMember,
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
  'Guard C rejects a self-reported status: "active" actor when the REAL, persisted OrgMember record ' +
    'for that id is "inactive" — checkAuthorizationGuard now recalls ground truth instead of trusting the caller',
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
    // object claiming status: 'active' for that same id. This bridge DOES
    // wire the org-member key to the real 'inactive' record (unlike the
    // pre-fix version of this test, which deliberately left it unregistered
    // to prove Guard C never queried it at all) — post-fix, Guard C must
    // recall this record and reject on its real status, not the caller's.
    const { config: attackConfig } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.query === issueKeyStr && args.tier === 'working') {
          return { results: [{ key: issueKeyStr, value: JSON.stringify(stored) }] };
        }
        if (args.query === submitTransitionKeyStr && args.tier === 'working') {
          return { results: [{ key: submitTransitionKeyStr, value: JSON.stringify(persistedSubmitTransition) }] };
        }
        if (args.query === orgMemberKeyStr && args.tier === 'semantic') {
          return { results: [{ key: orgMemberKeyStr, value: JSON.stringify(realInactiveMember) }] };
        }
        return { results: [] };
      },
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      'claims_list': (args) =>
        args.claimant === 'agent:om-approver:Engineer'
          ? { success: true, claims: [{ issueId: 'co-1:issue-1', claimant: { type: 'agent', agentId: 'om-approver', agentType: 'Engineer' }, status: 'active' }] }
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

    // checkAuthorizationGuard now recalls the real OrgMember record and
    // rejects on ITS status ('inactive'), ignoring the caller's forged claim.
    await assert.rejects(
      () => persistIssue('co-1', approvedIssue, undefined, approveTransition, { actor: forgedActiveClaim }, attackConfig),
      /status is 'inactive'/,
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
        // Cross-tenant claim collision fix (ruvnet/ruClip#5 Finding 1) —
        // company-prefixed, matching this test file's actors' companyId: 'co-1'.
        return { success: true, claims: [{ issueId: 'co-1:issue-1', claimant, status: claim.status }] };
      },
      ...nonceMockHandlers(),
    });

    const selfDealer = baseActor({ id: 'om-self-dealer' });
    // Persisted so Guard C's actor-active check (ground-truth-recalled, see
    // the fix documented at the top of this file) finds a real record.
    await persistOrgMember(selfDealer, config);
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
      await credentialFor(selfDealer),
      null,
      { approver: selfDealer },
      config,
    );
    assert.equal(submitResult.issue.approvalState, 'pending');

    // Now attempts to approve as the same actor who just submitted.
    const approveAuthorization = await credentialFor(selfDealer);
    await assert.rejects(
      () =>
        applyApprovalTransition(
          'co-1',
          submitResult.issue,
          'approve',
          approveAuthorization,
          submitResult.transition,
          {},
          config,
        ),
      IllegalApprovalTransitionError,
    );

    // And the issue's persisted state must still show 'pending', never 'approved'.
    const finalIssue = JSON.parse(tiers.working!.get(issueKeyStr)!) as Issue;
    assert.equal(finalIssue.approvalState, 'pending');
  },
);
