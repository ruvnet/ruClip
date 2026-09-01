/**
 * Coverage for ACTOR-IDENTITY-VERIFICATION.md — the actor-forgery gap the
 * design closes. Covers §7's required cases: a forged orgMemberId (tampered
 * post-signing) is rejected, an expired credential is rejected, a replayed
 * nonce is rejected, an unadmitted-but-validly-signed issuer key is
 * rejected, a kind:'human' OrgMember is refused with no fallback, and the
 * regression that matters most — the exact scenario security found (a
 * credential for a DIFFERENT orgMemberId than the one that submitted being
 * used to approve/reject) is now blocked.
 *
 * No live AgentDB/radio-moe network instance — mockBridge for the AgentDB
 * bridge, and the real `radio-moe` package (a real devDependency of this
 * repo, see package.json) for actual signing/verification, same as
 * agentradio-signing-gaps.test.ts already does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { credentialFor, nonceMockHandlers, testIssuerConfig, unadmittedIssuerConfig } from '../support/actor-credential-fixture.js';
import {
  verifyActorCredential,
  resolveVerifiedActor,
  ActorIdentityVerificationError,
  type ActorAuthorization,
} from '../../src/control-plane/authorization/actor-credential.js';
import { mintActorCredential, resolveAdmittedIssuerKeys } from '../../src/control-plane/authorization/credential-issuer.js';
import { persistIssue, ApprovalGateViolationError } from '../../src/control-plane/store/agentdb-adapter.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';

const now = '2026-09-01T00:00:00.000Z';

function baseActor(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'om-1',
    companyId: 'co-1',
    kind: 'agent',
    identityRef: 'agent-team-name',
    role: 'Engineer',
    managerId: null,
    status: 'active',
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
    actorId: 'om-1',
    reason: null,
    createdAt: now,
    witnessRef: null,
  };
}

function orgMemberRecall(member: OrgMember) {
  return (args: Record<string, unknown>) =>
    args.tier === 'semantic' && args.query === `ruclip:company:${member.companyId}:org-member:${member.id}`
      ? { results: [{ key: args.query, value: JSON.stringify(member) }] }
      : { results: [] };
}

// --- verifyActorCredential: §7 required cases -------------------------------

test('verifyActorCredential succeeds for a validly-signed, unexpired, unreplayed credential', async () => {
  const actor = baseActor();
  const { calls, config } = mockBridge({ ...nonceMockHandlers() });
  const { credential, admittedIssuerKeys } = await credentialFor(actor);

  const result = await verifyActorCredential(credential, admittedIssuerKeys, config);
  assert.deepEqual(result, { orgMemberId: 'om-1', companyId: 'co-1' });
  assert.ok(calls.some((c) => c.toolName === 'memory_retrieve'));
  assert.ok(calls.some((c) => c.toolName === 'memory_store'));
});

test('verifyActorCredential rejects a forged orgMemberId — tampering the credential after signing breaks the signature', async () => {
  const actor = baseActor();
  const { config } = mockBridge({ ...nonceMockHandlers() });
  const { credential, admittedIssuerKeys } = await credentialFor(actor);
  const forged = { ...credential, orgMemberId: 'om-victim' };

  await assert.rejects(() => verifyActorCredential(forged, admittedIssuerKeys, config), ActorIdentityVerificationError);
});

test('verifyActorCredential rejects an expired credential', async () => {
  const actor = baseActor();
  const { config } = mockBridge({ ...nonceMockHandlers() });
  const { credential, admittedIssuerKeys } = await credentialFor(actor, { ttlSeconds: -1 });

  await assert.rejects(() => verifyActorCredential(credential, admittedIssuerKeys, config), ActorIdentityVerificationError);
});

test('verifyActorCredential rejects a replayed nonce — the same credential cannot be verified twice', async () => {
  const actor = baseActor();
  const { config } = mockBridge({ ...nonceMockHandlers() });
  const { credential, admittedIssuerKeys } = await credentialFor(actor);

  await verifyActorCredential(credential, admittedIssuerKeys, config);
  await assert.rejects(
    () => verifyActorCredential(credential, admittedIssuerKeys, config),
    ActorIdentityVerificationError,
  );
});

test('verifyActorCredential rejects a validly-signed credential from an unadmitted issuer key', async () => {
  const actor = baseActor();
  const { config } = mockBridge({ ...nonceMockHandlers() });
  const credential = await mintActorCredential('om-1', 'co-1', undefined, unadmittedIssuerConfig);
  const admittedIssuerKeys = await resolveAdmittedIssuerKeys(testIssuerConfig); // does NOT admit unadmittedIssuerConfig's key

  await assert.rejects(() => verifyActorCredential(credential, admittedIssuerKeys, config), ActorIdentityVerificationError);
});

// --- resolveVerifiedActor: the generalized recall + human-block pattern -----

test('resolveVerifiedActor recalls the fresh OrgMember and returns it for a kind: "agent" actor', async () => {
  const actor = baseActor({ kind: 'agent' });
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(actor), ...nonceMockHandlers() });
  const authorization = await credentialFor(actor);

  const resolved = await resolveVerifiedActor(authorization, config);
  assert.deepEqual(resolved, actor);
});

test('resolveVerifiedActor blocks a kind: "human" OrgMember with no fallback path — ACTOR-IDENTITY-VERIFICATION.md §4 locked decision', async () => {
  const human = baseActor({ kind: 'human', id: 'om-human', identityRef: 'bbs:alice' });
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(human), ...nonceMockHandlers() });
  const authorization = await credentialFor(human);

  await assert.rejects(() => resolveVerifiedActor(authorization, config), ActorIdentityVerificationError);
});

test('resolveVerifiedActor rejects when the verified orgMemberId has no persisted OrgMember record', async () => {
  const actor = baseActor();
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': () => ({ results: [] }), ...nonceMockHandlers() });
  const authorization = await credentialFor(actor);

  await assert.rejects(() => resolveVerifiedActor(authorization, config), ActorIdentityVerificationError);
});

// --- The regression that matters most: a credential for a DIFFERENT orgMemberId cannot approve/reject ---

test(
  'REGRESSION (the exact scenario security found): persistIssue Guard C rejects a validly-signed credential for a ' +
    "DIFFERENT orgMemberId than the forged ApprovalTransition's own actorId — a valid credential no longer lets a " +
    'caller name an arbitrary actorId in the transition it presents',
  async () => {
    const attacker = baseActor({ id: 'om-attacker' });
    const stored = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
    const { config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
          return { results: [{ key: args.query, value: JSON.stringify(stored) }] };
        }
        return orgMemberRecall(attacker)(args);
      },
      ...nonceMockHandlers(),
    });
    const authorization: ActorAuthorization = await credentialFor(attacker);

    // Forged transition claims a DIFFERENT actorId ('om-victim') than the
    // credential actually verifies to ('om-attacker').
    const forgedApproval = baseTransition({
      id: 'transition-approve',
      action: 'approve',
      fromState: 'pending',
      toState: 'approved',
      actorId: 'om-victim',
    });
    const nextIssue = baseIssue({ approvalState: 'approved', approvalTransitionRef: 'transition-approve' });

    await assert.rejects(
      () => persistIssue('co-1', nextIssue, undefined, forgedApproval, authorization, config),
      ApprovalGateViolationError,
    );
  },
);
