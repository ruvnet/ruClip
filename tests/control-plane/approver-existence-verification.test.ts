/**
 * Dream Cycle 2026-11-10 (correctness). Finding: `applyApprovalTransition`'s
 * `deps.approver` (action 'submit') and `deps.handoffTo` (action 'reject')
 * are caller-constructed `OrgMember` objects, handed straight to
 * `handoffClaim` with no check that either actually corresponds to a
 * persisted `OrgMember` record — unlike `actor`, which is re-verified
 * against persisted state via `resolveVerifiedActor`'s own `recallOrgMember`
 * call. `handoffClaim`'s only guard is `from.companyId === to.companyId`
 * (docs/design/AUTHORIZATION.md §4, §6); the `claims_*` system itself is
 * documented as "agnostic to who is allowed to be on either end of a
 * handoff" (§4). A same-company but nonexistent/fabricated approver or
 * handoff target therefore passes silently: the issue is handed to a
 * claimant string nobody can ever present a matching credential for (every
 * later `acceptClaimHandoff` call requires `resolveVerifiedActor`, which
 * itself requires a persisted `OrgMember`), so the issue deadlocks with no
 * error raised at the moment of the actual mistake — the opposite of this
 * codebase's repeatedly-stated fail-closed philosophy (`fire-heartbeat.ts`,
 * `ruclip.ts` headers).
 *
 * This is a DIFFERENT, deeper gap than the one
 * `tests/control-plane/cross-company-approver-verification.test.ts` already
 * closed (that one is a companyId MISMATCH check; this one is an EXISTENCE
 * check — a same-company fabricated id was never caught by anything).
 *
 * No live AgentDB/claims instance — mockBridge + the shared
 * actor-credential-fixture, same discipline as the rest of this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { credentialFor, nonceMockHandlers } from '../support/actor-credential-fixture.js';
import { applyApprovalTransition } from '../../src/control-plane/store/agentdb-adapter.js';
import { ClaimAuthorizationError } from '../../src/control-plane/authorization/claims-authorization.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';

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

function orgMemberKeyStr(companyId: string, id: string): string {
  return `ruclip:company:${companyId}:org-member:${id}`;
}

/** Same convention as approval-gate.test.ts's own recallReturning helper. */
function recallReturning(stored: Issue | null, ...activeMembers: OrgMember[]) {
  const issueKeyStr = `ruclip:company:co-1:goal:${stored?.goalId ?? 'goal-1'}:issue:${stored?.id ?? 'issue-1'}`;
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

test(
  "FIXED: applyApprovalTransition('submit') rejects a deps.approver with no persisted OrgMember record in the " +
    'same company, instead of silently handing the claim off to it',
  async () => {
    const submitter = baseActor({ id: 'om-submitter' });
    const fabricatedApprover = baseActor({ id: 'om-ghost', role: 'Manager' }); // same company, never persisted
    const draftIssue = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });

    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': recallReturning(null, submitter),
      'claims_handoff': () => ({ success: true }),
      ...nonceMockHandlers(),
    });

    const authorization = await credentialFor(submitter);
    await assert.rejects(
      () =>
        applyApprovalTransition(
          'co-1',
          draftIssue,
          'submit',
          authorization,
          null,
          { approver: fabricatedApprover },
          config,
        ),
      ClaimAuthorizationError,
    );

    assert.ok(
      !calls.some((c) => c.toolName === 'claims_handoff'),
      'handoffClaim must never run once deps.approver fails the existence check',
    );
  },
);

test(
  "applyApprovalTransition('submit') still succeeds when deps.approver IS a persisted OrgMember (no regression)",
  async () => {
    const submitter = baseActor({ id: 'om-submitter' });
    const approver = baseActor({ id: 'om-approver', role: 'Manager' });
    const draftIssue = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });

    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': recallReturning(draftIssue, submitter, approver),
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      'claims_handoff': () => ({ success: true }),
      'claims_list': () => ({
        success: true,
        claims: [
          {
            issueId: 'co-1:issue-1',
            claimant: { type: 'agent', agentId: submitter.id, agentType: submitter.role },
            status: 'active',
          },
        ],
      }),
      ...nonceMockHandlers(),
    });

    const result = await applyApprovalTransition(
      'co-1',
      draftIssue,
      'submit',
      await credentialFor(submitter),
      null,
      { approver },
      config,
    );

    assert.equal(result.issue.approvalState, 'pending');
    const handoffCall = calls.find((c) => c.toolName === 'claims_handoff');
    assert.ok(handoffCall, 'a real, persisted approver must still receive the handoff');
    assert.equal(handoffCall!.args.to, 'agent:om-approver:Manager');
  },
);

test(
  "FIXED: applyApprovalTransition('reject') rejects a deps.handoffTo with no persisted OrgMember record in the " +
    'same company, instead of silently handing the claim back to it',
  async () => {
    const approver = baseActor({ id: 'om-approver', role: 'Manager' });
    const fabricatedSubmitter = baseActor({ id: 'om-ghost' }); // same company, never persisted
    const submit = baseTransition({ id: 'transition-submit', actorId: 'om-ghost', fromState: 'draft', toState: 'pending' });
    const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });

    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': recallReturning(pendingIssue, approver),
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      'claims_accept-handoff': () => ({ success: true }),
      'claims_list': () => ({
        success: true,
        claims: [
          {
            issueId: 'co-1:issue-1',
            claimant: { type: 'agent', agentId: approver.id, agentType: approver.role },
            status: 'active',
          },
        ],
      }),
      'claims_handoff': () => ({ success: true }),
      ...nonceMockHandlers(),
    });

    const authorization = await credentialFor(approver);
    await assert.rejects(
      () =>
        applyApprovalTransition(
          'co-1',
          pendingIssue,
          'reject',
          authorization,
          submit,
          { reason: 'too expensive', handoffTo: fabricatedSubmitter },
          config,
        ),
      ClaimAuthorizationError,
    );

    assert.ok(
      !calls.some((c) => c.toolName === 'claims_handoff'),
      'handoffClaim must never run once deps.handoffTo fails the existence check',
    );
  },
);
