/**
 * Characterizes a real gap between HUMAN-CREDENTIAL-ISSUANCE.md §6's stated
 * goal for version 2 attestations and what the code actually enforces.
 *
 * §6's own problem statement (consequence #2 of v1): "One attestation can
 * mint a credential that is then spent on any transition, so the human's
 * confirmation is not bound to what they saw." Version 2 adds `audience`/
 * `purpose` specifically to fix this — but `verifyHumanIdentityAttestation`/
 * `mintHumanActorCredential` only compare `purpose` against `expectedPurpose`
 * at the ATTESTATION-VERIFICATION step, before the credential is minted.
 * `ActorCredential` (actor-credential.ts) itself has no `purpose`/`audience`/
 * `subjectRef` field — signing frame, verification (`resolveVerifiedActor`)
 * and every downstream consumer (`applyApprovalTransition`, `persistIssue`'s
 * Guard C) only ever check `orgMemberId`/`companyId`/the human-attestation
 * provenance marker, never what action/subject the originating attestation
 * was bound to.
 *
 * Net effect: a human who confirmed (and had cryptographically attested)
 * "approve issue-1" receives a credential that is, in fact, just as usable
 * to reject issue-1 (or approve/reject/revise any other issue, or create a
 * heartbeat) for the rest of its TTL — exactly the v1 weakness §6 says v2
 * exists to close, reopened the instant verification succeeds. §6 rule 6
 * ("what stays the caller's job") pushes single-use-per-action discipline
 * onto whatever mints credentials just-in-time per action; nothing in this
 * repository's own code enforces it. Not a regression introduced here — a
 * confirmed, demonstrated characterization of the current design, filed for
 * human review per the dream-cycle 2026-11-25 correctness finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import {
  humanAttestationV2For,
  nonceMockHandlers,
  testAdmittedAttesterKeys,
  testIssuerConfig,
} from '../support/actor-credential-fixture.js';
import {
  mintHumanActorCredential,
  type AttestationPurpose,
} from '../../src/control-plane/authorization/human-identity-attestation.js';
import { resolveAdmittedIssuerKeys } from '../../src/control-plane/authorization/credential-issuer.js';
import { applyApprovalTransition } from '../../src/control-plane/store/agentdb-adapter.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';

const now = '2026-11-25T00:00:00.000Z';

function baseIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    goalId: 'goal-1',
    parentId: null,
    assigneeId: null,
    title: 'Spend the quarterly budget',
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

function humanApprover(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'om-human-approver',
    companyId: 'co-1',
    kind: 'human',
    identityRef: 'cognitum:sub-123',
    role: 'Approver',
    managerId: null,
    status: 'active',
    ...overrides,
  };
}

const issueKeyStr = 'ruclip:company:co-1:goal:goal-1:issue:issue-1';

function recallReturning(stored: Issue, member: OrgMember) {
  return (args: Record<string, unknown>) => {
    if (args.tier === 'working' && args.query === issueKeyStr) {
      return { results: [{ key: issueKeyStr, value: JSON.stringify(stored) }] };
    }
    if (args.tier === 'semantic' && args.query === `ruclip:company:${member.companyId}:org-member:${member.id}`) {
      return { results: [{ key: args.query, value: JSON.stringify(member) }] };
    }
    return { results: [] };
  };
}

function activeClaimFor(actor: OrgMember, issueId: string) {
  return () => ({
    success: true,
    claims: [
      {
        issueId: `${actor.companyId}:${issueId}`,
        claimant: { type: 'human', userId: actor.id, name: actor.role },
        status: 'active',
      },
    ],
  });
}

test(
  'GAP: a v2 attestation purpose-bound to {action: "approve", subjectRef: "issue:issue-1"} mints an ' +
    'ActorCredential that is just as usable to REJECT the same issue — the credential carries no purpose/subject ' +
    'binding, so §6\'s stated goal ("the human\'s confirmation is bound to what they saw") does not survive past ' +
    'the mint call',
  async () => {
    const approver = humanApprover();
    const submit = baseTransition({ id: 'transition-submit', actorId: 'om-submitter' });
    const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
    const purpose: AttestationPurpose = {
      action: 'approve',
      subjectRef: 'issue:issue-1',
      subjectVersion: 1,
      payloadDigest: 'sha256:' + 'a'.repeat(64),
    };
    const audience = 'rupro-runtime:rt-1';

    const { config } = mockBridge({
      'agentdb_hierarchical-recall': recallReturning(pendingIssue, approver),
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      'claims_accept-handoff': () => ({ success: true }),
      'claims_handoff': () => ({ success: true }),
      'claims_list': activeClaimFor(approver, 'issue-1'),
      ...nonceMockHandlers(),
    });

    // The human saw, and attested to, "approve issue-1" specifically — and
    // minting correctly enforces that binding (would throw on any mismatch
    // here; see human-identity-attestation-v2.test.ts for the mismatch
    // cases). This confirms the v2 gate itself works as documented.
    const attestation = await humanAttestationV2For(approver, { audience, purpose });
    const credential = await mintHumanActorCredential(
      attestation,
      testAdmittedAttesterKeys,
      { expectedAudience: audience, expectedPurpose: purpose },
      testIssuerConfig,
      config,
    );
    const admittedIssuerKeys = await resolveAdmittedIssuerKeys(testIssuerConfig);

    // The gap: nothing stops that SAME credential — minted for "approve" —
    // from being presented to REJECT the same issue instead. This should,
    // per §6's own stated goal, be refused as out-of-purpose. It succeeds.
    const result = await applyApprovalTransition(
      'co-1',
      pendingIssue,
      'reject',
      { credential, admittedIssuerKeys },
      submit,
      { reason: 'changed my mind', handoffTo: humanApprover({ id: 'om-submitter' }) },
      config,
    );

    assert.equal(
      result.issue.approvalState,
      'rejected',
      'demonstrates the gap: a credential from an "approve"-purpose-bound attestation still rejects successfully',
    );
  },
);
