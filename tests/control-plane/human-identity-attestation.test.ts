/**
 * Coverage for docs/design/HUMAN-CREDENTIAL-ISSUANCE.md — the human-issuance
 * path for ActorCredential that ACTOR-IDENTITY-VERIFICATION.md §4 named as
 * a gap and deferred to Phase 2. Covers: a forged attestation (tampered
 * after signing) is rejected, a replayed attestation nonce is rejected, an
 * expired attestation is rejected, an unadmitted-but-validly-signed attester
 * key is rejected, an attestation for a `kind !== 'human'` OrgMember is
 * rejected, an attestation whose `humanIdentityRef` does not match the
 * target OrgMember's own persisted `identityRef` is rejected, and — the
 * regression that matters most for this slice — a `kind: 'human'` OrgMember
 * CAN now be authorized via `resolveVerifiedActor`/`applyApprovalTransition`
 * when (and only when) its credential was minted through
 * `mintHumanActorCredential`, while a bare `mintActorCredential` call naming
 * the same human `orgMemberId` (no attestation, no provenance marker) is
 * still blocked end to end — confirmed by actually calling
 * `applyApprovalTransition`, not assumed.
 *
 * No live AgentDB/radio-moe network instance — mockBridge for the AgentDB
 * bridge, the real `radio-moe` package for actual signing/verification,
 * same discipline as tests/control-plane/actor-identity-verification.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import {
  credentialFor,
  humanAttestationFor,
  humanCredentialFor,
  nonceMockHandlers,
  testAdmittedAttesterKeys,
  testIssuerConfig,
  unadmittedAttesterPrivateKeyPem,
} from '../support/actor-credential-fixture.js';
import {
  mintHumanActorCredential,
  verifyHumanIdentityAttestation,
} from '../../src/control-plane/authorization/human-identity-attestation.js';
import { resolveVerifiedActor, ActorIdentityVerificationError } from '../../src/control-plane/authorization/actor-credential.js';
import { applyApprovalTransition, persistIssue } from '../../src/control-plane/store/agentdb-adapter.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
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

function baseTransition(overrides: Partial<ApprovalTransition> = {}): ApprovalTransition {
  return {
    id: 'transition-1',
    issueId: 'issue-1',
    action: 'submit',
    fromState: 'draft',
    toState: 'pending',
    actorId: 'om-1',
    reason: null,
    createdAt: now,
    witnessRef: null,
    ...overrides,
  };
}

/** A verified Cognitum human identity — see human-identity-attestation.ts's header (ADR-0002/ADR-0015 shape). */
function humanMember(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'om-human',
    companyId: 'co-1',
    kind: 'human',
    identityRef: 'slack:U0BQJNHH7L3',
    role: 'Employee',
    managerId: null,
    status: 'active',
    ...overrides,
  };
}

function agentMember(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'om-agent',
    companyId: 'co-1',
    kind: 'agent',
    identityRef: 'agent-team-name',
    role: 'Engineer',
    managerId: null,
    status: 'active',
    ...overrides,
  };
}

function orgMemberRecall(member: OrgMember) {
  return (args: Record<string, unknown>) =>
    args.tier === 'semantic' && args.query === `ruclip:company:${member.companyId}:org-member:${member.id}`
      ? { results: [{ key: args.query, value: JSON.stringify(member) }] }
      : { results: [] };
}

// --- verifyHumanIdentityAttestation / mintHumanActorCredential: required cases ---

test('mintHumanActorCredential mints a real ActorCredential for a validly-attested, unexpired, unreplayed human OrgMember', async () => {
  const human = humanMember();
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(human), ...nonceMockHandlers() });
  const attestation = await humanAttestationFor(human);

  const credential = await mintHumanActorCredential(attestation, testAdmittedAttesterKeys, undefined, testIssuerConfig, config);

  assert.equal(credential.orgMemberId, 'om-human');
  assert.equal(credential.companyId, 'co-1');
  assert.ok(credential.signature.length > 0);
});

test('mintHumanActorCredential rejects a forged attestation — tampering the orgMemberId after signing breaks the signature', async () => {
  const human = humanMember();
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(human), ...nonceMockHandlers() });
  const attestation = await humanAttestationFor(human);
  const forged = { ...attestation, orgMemberId: 'om-victim' };

  await assert.rejects(
    () => mintHumanActorCredential(forged, testAdmittedAttesterKeys, undefined, testIssuerConfig, config),
    ActorIdentityVerificationError,
  );
});

test('mintHumanActorCredential rejects an attestation signed by an unadmitted attester key, even though it is internally valid', async () => {
  const human = humanMember();
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(human), ...nonceMockHandlers() });
  const attestation = await humanAttestationFor(human, { attesterPrivateKeyPem: unadmittedAttesterPrivateKeyPem });

  await assert.rejects(
    () => mintHumanActorCredential(attestation, testAdmittedAttesterKeys, undefined, testIssuerConfig, config),
    ActorIdentityVerificationError,
  );
});

test('mintHumanActorCredential rejects an expired attestation', async () => {
  const human = humanMember();
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(human), ...nonceMockHandlers() });
  const attestation = await humanAttestationFor(human, { ttlSeconds: -1 });

  await assert.rejects(
    () => mintHumanActorCredential(attestation, testAdmittedAttesterKeys, undefined, testIssuerConfig, config),
    ActorIdentityVerificationError,
  );
});

test('verifyHumanIdentityAttestation rejects a replayed attestation nonce — the same attestation cannot be verified twice', async () => {
  const human = humanMember();
  const { config } = mockBridge({ ...nonceMockHandlers() });
  const attestation = await humanAttestationFor(human);

  await verifyHumanIdentityAttestation(attestation, testAdmittedAttesterKeys, config);
  await assert.rejects(
    () => verifyHumanIdentityAttestation(attestation, testAdmittedAttesterKeys, config),
    ActorIdentityVerificationError,
  );
});

test('mintHumanActorCredential rejects when the target OrgMember does not exist', async () => {
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': () => ({ results: [] }), ...nonceMockHandlers() });
  const attestation = await humanAttestationFor(humanMember());

  await assert.rejects(
    () => mintHumanActorCredential(attestation, testAdmittedAttesterKeys, undefined, testIssuerConfig, config),
    ActorIdentityVerificationError,
  );
});

test("mintHumanActorCredential rejects when the target OrgMember's kind is not 'human' — this issuance path is human-only", async () => {
  const agent = agentMember({ id: 'om-agent' });
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(agent), ...nonceMockHandlers() });
  // Attestation names the agent's own id/identityRef — still rejected purely on kind.
  const attestation = await humanAttestationFor({ id: agent.id, companyId: agent.companyId, identityRef: agent.identityRef });

  await assert.rejects(
    () => mintHumanActorCredential(attestation, testAdmittedAttesterKeys, undefined, testIssuerConfig, config),
    ActorIdentityVerificationError,
  );
});

test(
  "mintHumanActorCredential rejects when the attestation's humanIdentityRef does not match the target OrgMember's " +
    'own persisted identityRef — an attestation genuinely proving identity X cannot mint a credential for an ' +
    'OrgMember record actually bound to a different identity Y',
  async () => {
    // The real, persisted OrgMember is bound to a DIFFERENT verified identity
    // than the one the (validly-signed, unexpired, unreplayed) attestation
    // asserts — e.g. a desynced/misconfigured OrgMember record, or an
    // attacker who holds a real attestation for their OWN identity trying to
    // point it at someone else's orgMemberId.
    const human = humanMember({ id: 'om-human', identityRef: 'slack:U-REAL-OWNER' });
    const { config } = mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(human), ...nonceMockHandlers() });
    const attestation = await humanAttestationFor(human, { humanIdentityRef: 'slack:U-ATTACKER' });

    await assert.rejects(
      () => mintHumanActorCredential(attestation, testAdmittedAttesterKeys, undefined, testIssuerConfig, config),
      ActorIdentityVerificationError,
    );
  },
);

// --- resolveVerifiedActor: the block lifts ONLY for a credential minted through this path ---

test(
  'resolveVerifiedActor now authorizes a kind: "human" OrgMember whose credential was minted via ' +
    'mintHumanActorCredential — the human-attestation provenance marker lifts the block',
  async () => {
    const human = humanMember();
    const { config } = mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(human), ...nonceMockHandlers() });
    const authorization = await humanCredentialFor(human, config);

    const resolved = await resolveVerifiedActor(authorization, config);
    assert.deepEqual(resolved, human);
  },
);

test(
  'REGRESSION: resolveVerifiedActor still blocks a kind: "human" OrgMember whose credential was minted DIRECTLY ' +
    'via mintActorCredential (no attestation, no provenance marker) — the fail-closed default is unchanged for ' +
    'every credential that did not go through the attestation path',
  async () => {
    const human = humanMember();
    const { config } = mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(human), ...nonceMockHandlers() });
    const authorization = await credentialFor(human);

    await assert.rejects(() => resolveVerifiedActor(authorization, config), ActorIdentityVerificationError);
  },
);

// --- Full pipeline: a human OrgMember can now approve an issue ---

function orgMemberKeyStr(companyId: string, id: string): string {
  return `ruclip:company:${companyId}:org-member:${id}`;
}

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

test(
  'FULL PIPELINE: applyApprovalTransition lets a human OrgMember approve an issue when holding a credential ' +
    'minted through mintHumanActorCredential — "give ruClip a way to mint a human ActorCredential ... so ' +
    "kind: 'human' OrgMembers can approve issues\" confirmed end to end, not just at resolveVerifiedActor's own " +
    'unit level',
  async () => {
    const submit = baseTransition({ id: 'transition-submit', actorId: 'om-submitter', fromState: 'draft', toState: 'pending' });
    const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
    const humanApprover = humanMember({ id: 'om-human-approver', identityRef: 'slack:U0BQJNHH7L3' });
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': recallReturning(pendingIssue, humanApprover),
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      'claims_accept-handoff': () => ({ success: true }),
      'claims_list': activeClaimFor(humanApprover, 'issue-1'),
      ...nonceMockHandlers(),
    });

    const result = await applyApprovalTransition(
      'co-1',
      pendingIssue,
      'approve',
      await humanCredentialFor(humanApprover, config),
      submit,
      {},
      config,
    );

    assert.equal(result.issue.approvalState, 'approved');
    assert.equal(result.transition.actorId, 'om-human-approver');

    const approvedByEdge = calls.find(
      (c) => c.toolName === 'agentdb_causal-edge' && c.args.relation === 'approved_by',
    );
    assert.ok(approvedByEdge, 'expected an approved_by causal edge for the human approver');
    assert.equal(approvedByEdge!.args.targetId, 'entity:org-member:om-human-approver');
  },
);

test(
  'FULL PIPELINE, negative: applyApprovalTransition still refuses a human OrgMember presenting a credential ' +
    'minted directly via mintActorCredential (bypassing the attestation path entirely) — the default block holds ' +
    'through the whole orchestration function, not only at resolveVerifiedActor',
  async () => {
    const submit = baseTransition({ id: 'transition-submit', actorId: 'om-submitter', fromState: 'draft', toState: 'pending' });
    const pendingIssue = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
    const humanApprover = humanMember({ id: 'om-human-approver', identityRef: 'slack:U0BQJNHH7L3' });
    const { config } = mockBridge({
      'agentdb_hierarchical-recall': recallReturning(pendingIssue, humanApprover),
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      'claims_accept-handoff': () => ({ success: true }),
      'claims_list': activeClaimFor(humanApprover, 'issue-1'),
      ...nonceMockHandlers(),
    });

    const forgedAuthorization = await credentialFor(humanApprover);
    await assert.rejects(
      () => applyApprovalTransition('co-1', pendingIssue, 'approve', forgedAuthorization, submit, {}, config),
      ActorIdentityVerificationError,
    );
  },
);

// --- Confirms persistIssue's Guard C (the other named site) is equally reachable by a legitimately-attested human ---

test(
  "persistIssue's Guard C authorizes a human actor's already-verified credential threaded in as { actor } " +
    '(the internal-caller shape applyApprovalTransition itself uses) once minted via mintHumanActorCredential',
  async () => {
    const humanApprover = humanMember({ id: 'om-human-approver' });
    const stored = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
    const { config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.tier === 'working' && args.query === issueKeyStr) {
          return { results: [{ key: args.query, value: JSON.stringify(stored) }] };
        }
        return orgMemberRecall(humanApprover)(args);
      },
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      'claims_list': activeClaimFor(humanApprover, 'issue-1'),
      ...nonceMockHandlers(),
    });
    const authorization = await humanCredentialFor(humanApprover, config);
    const resolvedActor = await resolveVerifiedActor(authorization, config);

    const approveTransition = baseTransition({
      id: 'transition-approve',
      action: 'approve',
      fromState: 'pending',
      toState: 'approved',
      actorId: 'om-human-approver',
    });
    const nextIssue = baseIssue({ approvalState: 'approved', approvalTransitionRef: 'transition-approve' });

    // Should not throw — the human actor is authorized end to end for Guard C too.
    await persistIssue('co-1', nextIssue, undefined, approveTransition, { actor: resolvedActor }, config);
  },
);
