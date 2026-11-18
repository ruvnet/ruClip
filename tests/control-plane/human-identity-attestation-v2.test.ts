/**
 * Coverage for HUMAN-CREDENTIAL-ISSUANCE.md §6 — version 2 attestations,
 * which bind an attestation to one verifier (`audience`) and one action
 * (`purpose`). Uses the real radio-moe package for signing and
 * verification and mockBridge for the AgentDB nonce store, same discipline
 * as human-identity-attestation.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import {
  humanAttestationFor,
  humanAttestationV2For,
  nonceMockHandlers,
  testAdmittedAttesterKeys,
  testIssuerConfig,
  unadmittedAttesterPrivateKeyPem,
} from '../support/actor-credential-fixture.js';
import {
  ATTESTATION_ACTIONS,
  attestationFrame,
  mintHumanActorCredential,
  verifyHumanIdentityAttestation,
  type AttestationPurpose,
} from '../../src/control-plane/authorization/human-identity-attestation.js';
import { ActorIdentityVerificationError } from '../../src/control-plane/authorization/actor-credential.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';

const AUDIENCE = 'rupro-runtime:rt-1:thumb-abc';
const PURPOSE: AttestationPurpose = {
  action: 'approve',
  subjectRef: 'issue:issue-1',
  subjectVersion: 4,
  payloadDigest: 'sha256:' + 'a'.repeat(64),
};

function human(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'om-human',
    companyId: 'co-1',
    kind: 'human',
    identityRef: 'cognitum:sub-123',
    role: 'Approver',
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

function bridgeFor(member: OrgMember) {
  return mockBridge({ 'agentdb_hierarchical-recall': orgMemberRecall(member), ...nonceMockHandlers() }).config;
}

test('v2: a valid attestation verifies with matching audience and purpose, and returns them', async () => {
  const config = bridgeFor(human());
  const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE, assurance: { orgRole: 'Member', tier: 'edit', surface: 'web' } });
  const verified = await verifyHumanIdentityAttestation(att, testAdmittedAttesterKeys, config, {
    expectedAudience: AUDIENCE,
    expectedPurpose: PURPOSE,
  });
  assert.equal(verified.version, 2);
  assert.equal(verified.audience, AUDIENCE);
  assert.deepEqual(verified.purpose, PURPOSE);
  assert.deepEqual(verified.assurance, { orgRole: 'Member', tier: 'edit', surface: 'web' });
});

test('v2: mintHumanActorCredential mints when audience and purpose match', async () => {
  const config = bridgeFor(human());
  const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE });
  const credential = await mintHumanActorCredential(
    att,
    testAdmittedAttesterKeys,
    { ttlSeconds: 60, expectedAudience: AUDIENCE, expectedPurpose: PURPOSE },
    testIssuerConfig,
    config,
  );
  assert.equal(credential.orgMemberId, 'om-human');
  const ttlMs = Date.parse(credential.expiresAt) - Date.parse(credential.issuedAt);
  assert.ok(ttlMs <= 60_000 + 1000, `credential TTL ${ttlMs}ms should honour ttlSeconds: 60`);
});

test('v2: a different expectedAudience is refused (an attestation for runtime A does not verify on runtime B)', async () => {
  const config = bridgeFor(human());
  const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE });
  await assert.rejects(
    () => verifyHumanIdentityAttestation(att, testAdmittedAttesterKeys, config, { expectedAudience: 'rupro-runtime:rt-2:thumb-def' }),
    (err: unknown) => err instanceof ActorIdentityVerificationError && /audience/.test((err as Error).message),
  );
});

test('v2: tampering the audience after signing breaks the signature', async () => {
  const config = bridgeFor(human());
  const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE });
  const forged = { ...att, audience: 'rupro-runtime:rt-2:thumb-def' };
  await assert.rejects(
    () => verifyHumanIdentityAttestation(forged, testAdmittedAttesterKeys, config, { expectedAudience: 'rupro-runtime:rt-2:thumb-def' }),
    (err: unknown) => err instanceof ActorIdentityVerificationError && /signature/.test((err as Error).message),
  );
});

test('v2: tampering any purpose field after signing breaks the signature', async () => {
  for (const change of [
    { action: 'reject' as const },
    { subjectRef: 'issue:issue-2' },
    { subjectVersion: 5 },
    { payloadDigest: 'sha256:' + 'b'.repeat(64) },
  ]) {
    const config = bridgeFor(human());
    const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE });
    const forged = { ...att, purpose: { ...PURPOSE, ...change } };
    await assert.rejects(
      () => verifyHumanIdentityAttestation(forged, testAdmittedAttesterKeys, config),
      (err: unknown) => err instanceof ActorIdentityVerificationError && /signature/.test((err as Error).message),
      `tampered ${JSON.stringify(change)} must fail signature verification`,
    );
  }
});

test('v2: tampering assurance after signing breaks the signature', async () => {
  const config = bridgeFor(human());
  const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE, assurance: { orgRole: 'Viewer' } });
  const forged = { ...att, assurance: { orgRole: 'Owner' } };
  await assert.rejects(() => verifyHumanIdentityAttestation(forged, testAdmittedAttesterKeys, config), ActorIdentityVerificationError);
});

test('v2: a purpose that does not match expectedPurpose is refused, field by field', async () => {
  for (const change of [
    { action: 'reject' as const },
    { subjectRef: 'issue:issue-2' },
    { subjectVersion: 5 },
    { payloadDigest: 'sha256:' + 'c'.repeat(64) },
  ]) {
    const config = bridgeFor(human());
    const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE });
    await assert.rejects(
      () => verifyHumanIdentityAttestation(att, testAdmittedAttesterKeys, config, { expectedPurpose: { ...PURPOSE, ...change } }),
      (err: unknown) => err instanceof ActorIdentityVerificationError && /purpose/.test((err as Error).message),
      `expected purpose differing by ${JSON.stringify(change)} must be refused`,
    );
  }
});

test('v2: a v1 attestation is refused whenever audience, purpose or version 2 is required', async () => {
  for (const opts of [{ expectedAudience: AUDIENCE }, { expectedPurpose: PURPOSE }, { requireVersion2: true }]) {
    const config = bridgeFor(human());
    const v1 = await humanAttestationFor(human());
    await assert.rejects(
      () => verifyHumanIdentityAttestation(v1, testAdmittedAttesterKeys, config, opts),
      (err: unknown) => err instanceof ActorIdentityVerificationError && /version 2/.test((err as Error).message),
      `v1 must be refused under ${JSON.stringify(opts)}`,
    );
  }
});

test('v2: a v1 attestation carrying unsigned audience/purpose fields is refused, even with no expectations', async () => {
  const config = bridgeFor(human());
  const v1 = await humanAttestationFor(human());
  await assert.rejects(
    () => verifyHumanIdentityAttestation({ ...v1, audience: AUDIENCE }, testAdmittedAttesterKeys, config),
    (err: unknown) => err instanceof ActorIdentityVerificationError && /not be signed/.test((err as Error).message),
  );
  await assert.rejects(
    () => verifyHumanIdentityAttestation({ ...v1, purpose: PURPOSE }, testAdmittedAttesterKeys, config),
    ActorIdentityVerificationError,
  );
});

test('v2: an unsupported version number is refused', async () => {
  const config = bridgeFor(human());
  const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE });
  await assert.rejects(
    () => verifyHumanIdentityAttestation({ ...att, version: 3 as unknown as 2 }, testAdmittedAttesterKeys, config),
    (err: unknown) => err instanceof ActorIdentityVerificationError && /unsupported version/.test((err as Error).message),
  );
});

test('v2: malformed purpose fields are refused before any signature work', async () => {
  for (const bad of [
    { ...PURPOSE, payloadDigest: 'md5:abc' },
    { ...PURPOSE, subjectVersion: -1 },
    { ...PURPOSE, subjectVersion: 1.5 },
    { ...PURPOSE, action: '' },
    { ...PURPOSE, subjectRef: 'x'.repeat(257) },
  ]) {
    const config = bridgeFor(human());
    const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: bad as AttestationPurpose });
    await assert.rejects(
      () => verifyHumanIdentityAttestation(att, testAdmittedAttesterKeys, config),
      (err: unknown) => err instanceof ActorIdentityVerificationError && /requires purpose/.test((err as Error).message),
    );
  }
});

test('v2: a missing or oversized audience is refused', async () => {
  for (const audience of ['', 'a'.repeat(257)]) {
    const config = bridgeFor(human());
    const att = await humanAttestationV2For(human(), { audience, purpose: PURPOSE });
    await assert.rejects(
      () => verifyHumanIdentityAttestation(att, testAdmittedAttesterKeys, config),
      (err: unknown) => err instanceof ActorIdentityVerificationError && /audience/.test((err as Error).message),
    );
  }
});

test('v2: the nonce is single-use exactly as in v1', async () => {
  const config = bridgeFor(human());
  const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE });
  await verifyHumanIdentityAttestation(att, testAdmittedAttesterKeys, config, { expectedAudience: AUDIENCE });
  await assert.rejects(
    () => verifyHumanIdentityAttestation(att, testAdmittedAttesterKeys, config, { expectedAudience: AUDIENCE }),
    (err: unknown) => err instanceof ActorIdentityVerificationError && /replay/.test((err as Error).message),
  );
});

test('v2: an unadmitted attester key is refused even with matching audience and purpose', async () => {
  const config = bridgeFor(human());
  const att = await humanAttestationV2For(
    human(),
    { audience: AUDIENCE, purpose: PURPOSE },
    { attesterPrivateKeyPem: unadmittedAttesterPrivateKeyPem },
  );
  await assert.rejects(
    () => verifyHumanIdentityAttestation(att, testAdmittedAttesterKeys, config, { expectedAudience: AUDIENCE, expectedPurpose: PURPOSE }),
    (err: unknown) => err instanceof ActorIdentityVerificationError && /not admitted/.test((err as Error).message),
  );
});

test('v2: the identity binding to the persisted OrgMember still applies', async () => {
  const persisted = human({ identityRef: 'cognitum:someone-else' });
  const config = bridgeFor(persisted);
  const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE });
  await assert.rejects(
    () => mintHumanActorCredential(att, testAdmittedAttesterKeys, { expectedAudience: AUDIENCE }, testIssuerConfig, config),
    (err: unknown) => err instanceof ActorIdentityVerificationError && /mismatched identity/.test((err as Error).message),
  );
});

test('v1 frames are byte-for-byte unchanged by this change (existing attesters keep verifying)', () => {
  const fields = {
    orgMemberId: 'om-1',
    companyId: 'co-1',
    humanIdentityRef: 'google:someone',
    issuedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:15:00.000Z',
    nonce: 'n-1',
  };
  assert.deepEqual(attestationFrame(fields), {
    requestId: 'n-1',
    agentId: 'ruclip-human-attester',
    step: 0,
    kind: 'claim',
    value: {
      orgMemberId: 'om-1',
      companyId: 'co-1',
      humanIdentityRef: 'google:someone',
      issuedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:15:00.000Z',
    },
    confidence: 1,
    uncertainty: 0,
    dependencies: [],
    capabilityUsed: 'ruclip.human-identity-attestation',
    evidenceHashes: [],
    cost: 0,
  });
});

test('v1 and v2 frames use distinct capabilities, so a signature cannot cross versions', () => {
  const base = {
    orgMemberId: 'om-1',
    companyId: 'co-1',
    humanIdentityRef: 'cognitum:sub',
    issuedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:01:00.000Z',
    nonce: 'n-2',
  };
  const v1 = attestationFrame(base);
  const v2 = attestationFrame({ ...base, version: 2, audience: AUDIENCE, purpose: PURPOSE });
  assert.equal(v1.capabilityUsed, 'ruclip.human-identity-attestation');
  assert.equal(v2.capabilityUsed, 'ruclip.human-identity-attestation.v2');
});

test('v2: a v2 signature presented with its v2 fields stripped (downgrade to v1) fails verification', async () => {
  const config = bridgeFor(human());
  const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose: PURPOSE });
  const { version: _v, audience: _a, purpose: _p, assurance: _s, ...downgraded } = att;
  await assert.rejects(
    () => verifyHumanIdentityAttestation(downgraded, testAdmittedAttesterKeys, config),
    (err: unknown) => err instanceof ActorIdentityVerificationError && /signature/.test((err as Error).message),
  );
});

test('v2: an action outside ATTESTATION_ACTIONS is refused, even when validly signed (fail closed)', async () => {
  for (const action of ['delete', 'APPROVE', 'approve ', 'heartbeat.pause']) {
    const config = bridgeFor(human());
    const att = await humanAttestationV2For(human(), {
      audience: AUDIENCE,
      purpose: { ...PURPOSE, action: action as AttestationPurpose['action'] },
    });
    await assert.rejects(
      () => verifyHumanIdentityAttestation(att, testAdmittedAttesterKeys, config),
      (err: unknown) => err instanceof ActorIdentityVerificationError && /requires purpose/.test((err as Error).message),
      `action '${action}' must be refused`,
    );
  }
});

test('v2: every action in ATTESTATION_ACTIONS is accepted', async () => {
  for (const action of ATTESTATION_ACTIONS) {
    const config = bridgeFor(human());
    const purpose = { ...PURPOSE, action };
    const att = await humanAttestationV2For(human(), { audience: AUDIENCE, purpose });
    const verified = await verifyHumanIdentityAttestation(att, testAdmittedAttesterKeys, config, { expectedPurpose: purpose });
    assert.equal(verified.purpose?.action, action);
  }
});
