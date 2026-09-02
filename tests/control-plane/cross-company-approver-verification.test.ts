/**
 * Independent verification for the ruvnet/ruClip#5 Finding 1 fix (commit
 * cfbc94f, claims-authorization.ts's company-prefixed issueId). Complements
 * tests/control-plane/claims-authorization.test.ts's own new regression
 * tests (the identical-issueId cross-company claimant collision, and
 * handoffClaim's own from/to company-mismatch rejection) — both verified
 * passing.
 *
 * The commit's own delivery notes flag a caveat, worded as still-open:
 * "applyApprovalTransition's deps.approver/deps.handoffTo aren't
 * independently companyId-checked at that call site — a real, pre-existing
 * gap, unrelated to this fix, not fixed here since it's out of Finding 1's
 * scope." Read `applyApprovalTransition` in full (store/agentdb-adapter.ts)
 * to check whether that's still accurate after this same commit's OTHER
 * change — `handoffClaim` now asserts `from.companyId === to.companyId`
 * before doing anything else.
 *
 * Traced it: `deps.approver` (submit) and `deps.handoffTo` (reject) are
 * used in exactly one place each in `applyApprovalTransition` — as the
 * `to` argument to a direct `handoffClaim(issue.id, actor, deps.approver, ...)`
 * / `handoffClaim(issue.id, actor, deps.handoffTo, ...)` call, with `actor`
 * (whose `companyId` is independently verified against the operation's own
 * `companyId` at the top of the function) as `from`. `handoffClaim`'s
 * from/to company-mismatch assertion runs as its literal first line, before
 * any key construction or bridge call. So a cross-company `deps.approver`/
 * `deps.handoffTo` is, in fact, ALREADY rejected — by this exact commit's
 * own `handoffClaim` change, not left open.
 *
 * This is not a new vulnerability finding — it's the opposite: a
 * documentation-accuracy correction. The fix is MORE complete than its own
 * delivery notes claim. Recording this with a real test rather than only a
 * read-through, so the "still open" framing doesn't get taken at face value
 * by a future engineer (or get "re-fixed" as if it weren't already closed).
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

function orgMemberKeyStr(companyId: string, id: string): string {
  return `ruclip:company:${companyId}:org-member:${id}`;
}

test(
  'VERIFICATION: applyApprovalTransition(\'submit\') rejects a deps.approver from a DIFFERENT company than the ' +
    "verified actor — the commit's own delivery notes describe this as a still-open, pre-existing gap, but " +
    "handoffClaim's from/to company-mismatch assertion (added in this exact commit) already closes it as a side effect",
  async () => {
    const submitter = baseActor({ id: 'om-submitter', companyId: 'co-1' });
    const crossCompanyApprover = baseActor({ id: 'om-approver', companyId: 'co-2', role: 'Manager' });
    const draftIssue = baseIssue({ approvalState: 'draft', approvalTransitionRef: null });

    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.tier === 'semantic' && args.query === orgMemberKeyStr('co-1', 'om-submitter')) {
          return { results: [{ key: args.query, value: JSON.stringify(submitter) }] };
        }
        return { results: [] };
      },
      ...nonceMockHandlers(),
    });

    await assert.rejects(
      async () =>
        applyApprovalTransition(
          'co-1',
          draftIssue,
          'submit',
          await credentialFor(submitter),
          null,
          { approver: crossCompanyApprover },
          config,
        ),
      ClaimAuthorizationError,
    );

    // No claims_handoff bridge call was ever made — the from/to company
    // assertion inside handoffClaim throws before building a key or calling
    // out, and no state-machine computation or persistence happened either.
    assert.ok(
      !calls.some((c) => c.toolName === 'claims_handoff'),
      'handoffClaim must reject before ever calling the bridge',
    );
    assert.ok(
      !calls.some((c) => c.toolName === 'agentdb_hierarchical-store'),
      'no partial persistence should happen when the approver company mismatch is caught this early',
    );
  },
);
