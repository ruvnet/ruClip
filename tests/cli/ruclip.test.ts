/**
 * Coverage for src/cli/ruclip.ts's `login()` — HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md
 * §5's fail-closed requirement: any failure at any step aborts with no
 * partial/best-effort credential ever produced, plus the real, unmodified
 * `mintHumanActorCredential` success path end to end (real radio-moe
 * signing, no mocks for the crypto).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, RuclipLoginError } from '../../src/cli/ruclip.js';
import { mockBridge } from '../support/mock-bridge.js';
import {
  humanAttestationFor,
  nonceMockHandlers,
  testAttesterPublicKeyDerHex,
  testIssuerConfig,
} from '../support/actor-credential-fixture.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';

function humanMember(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'om-ceo-001',
    companyId: 'company-ruclip-001',
    kind: 'human',
    identityRef: 'google:ruv@ruv.net',
    role: 'CEO',
    managerId: null,
    status: 'active',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

test('login fails closed when RUCLIP_ATTESTER_URL is not configured — never calls gcloud', async () => {
  let getGoogleIdTokenCalled = false;
  await assert.rejects(
    () =>
      login({
        getGoogleIdToken: async () => {
          getGoogleIdTokenCalled = true;
          return 'token';
        },
        attesterUrl: undefined,
      }),
    RuclipLoginError,
  );
  assert.equal(getGoogleIdTokenCalled, false);
});

test('login fails closed when getGoogleIdToken itself fails (gcloud not authenticated)', async () => {
  await assert.rejects(
    () =>
      login({
        getGoogleIdToken: async () => {
          throw new Error('gcloud not authenticated');
        },
        attesterUrl: 'https://attester.example',
      }),
  );
});

test('login fails closed on a non-200 from the attester — no credential minted', async () => {
  let fetchCalled = false;
  await assert.rejects(
    () =>
      login({
        getGoogleIdToken: async () => 'google-id-token',
        attesterUrl: 'https://attester.example',
        fetchImpl: (async () => {
          fetchCalled = true;
          return jsonResponse(403, { error: 'no verified employee mapping for this identity' });
        }) as unknown as typeof fetch,
      }),
    RuclipLoginError,
  );
  assert.equal(fetchCalled, true);
});

test('login fails closed when the attester is unreachable (network error)', async () => {
  await assert.rejects(
    () =>
      login({
        getGoogleIdToken: async () => 'google-id-token',
        attesterUrl: 'https://attester.example',
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch,
      }),
    RuclipLoginError,
  );
});

test('login fails closed when RUCLIP_HUMAN_ATTESTER_KEYS is not configured, even after a successful attest call', async () => {
  const previous = process.env.RUCLIP_HUMAN_ATTESTER_KEYS;
  delete process.env.RUCLIP_HUMAN_ATTESTER_KEYS;
  try {
    const attestation = await humanAttestationFor(humanMember());
    await assert.rejects(() =>
      login({
        getGoogleIdToken: async () => 'google-id-token',
        attesterUrl: 'https://attester.example',
        fetchImpl: (async () => jsonResponse(200, attestation)) as unknown as typeof fetch,
      }),
    );
  } finally {
    if (previous !== undefined) process.env.RUCLIP_HUMAN_ATTESTER_KEYS = previous;
  }
});

test('login succeeds end to end: gcloud token -> attester -> real mintHumanActorCredential (real radio-moe signing)', async () => {
  const member = humanMember();
  const previous = process.env.RUCLIP_HUMAN_ATTESTER_KEYS;
  process.env.RUCLIP_HUMAN_ATTESTER_KEYS = testAttesterPublicKeyDerHex;
  try {
    const attestation = await humanAttestationFor(member);
    const { config: bridgeConfig } = mockBridge({
      'agentdb_hierarchical-recall': (args) =>
        args.tier === 'semantic' && args.query === `ruclip:company:${member.companyId}:org-member:${member.id}`
          ? { results: [{ key: args.query, value: JSON.stringify(member) }] }
          : { results: [] },
      ...nonceMockHandlers(),
    });

    const result = await login({
      getGoogleIdToken: async () => 'google-id-token',
      attesterUrl: 'https://attester.example',
      fetchImpl: (async () => jsonResponse(200, attestation)) as unknown as typeof fetch,
      bridgeConfig,
      issuerConfig: testIssuerConfig,
    });

    assert.equal(result.credential.orgMemberId, member.id);
    assert.equal(result.credential.companyId, member.companyId);
    assert.equal(result.attestation.humanIdentityRef, 'google:ruv@ruv.net');
    assert.ok(result.credential.signature, 'expected a real signature on the minted ActorCredential');
  } finally {
    if (previous !== undefined) process.env.RUCLIP_HUMAN_ATTESTER_KEYS = previous;
    else delete process.env.RUCLIP_HUMAN_ATTESTER_KEYS;
  }
});
