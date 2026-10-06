/**
 * Coverage for signing-key.ts — mintHumanIdentityAttestation produces a
 * genuinely valid, real-radio-moe-signed HumanIdentityAttestation that the
 * shipped, unmodified `verifyHumanIdentityAttestation` (consumer side)
 * actually accepts — an end-to-end round trip through real signing/
 * verification, no mocks for the crypto. No live GCP Secret Manager call —
 * the `privateKeyPem` test/dev override bypasses the shell-out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintHumanIdentityAttestation, resolveAttesterPublicKeyDerHex } from '../src/signing-key.js';
import { verifyHumanIdentityAttestation } from '../../../src/control-plane/authorization/human-identity-attestation.js';
import { mockBridge } from '../../../tests/support/mock-bridge.js';
import { nonceMockHandlers } from '../../../tests/support/actor-credential-fixture.js';

const TEST_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIB+of+t76er2yPTYK9e8OTyGqI69X9+9XGLPhTPGeUPw\n-----END PRIVATE KEY-----\n';

test('mintHumanIdentityAttestation produces an attestation the real, unmodified verifyHumanIdentityAttestation accepts', async () => {
  const { config } = mockBridge({ ...nonceMockHandlers() });
  const attestation = await mintHumanIdentityAttestation(
    'om-ceo-001',
    'company-ruclip-001',
    'google:ruv@ruv.net',
    15 * 60,
    { privateKeyPem: TEST_PRIVATE_KEY_PEM },
  );
  const publicKeyDerHex = await resolveAttesterPublicKeyDerHex({ privateKeyPem: TEST_PRIVATE_KEY_PEM });
  assert.equal(attestation.attesterPublicKeyDerHex, publicKeyDerHex);

  const result = await verifyHumanIdentityAttestation(attestation, new Set([publicKeyDerHex]), config);
  assert.deepEqual(result, {
    orgMemberId: 'om-ceo-001',
    companyId: 'company-ruclip-001',
    humanIdentityRef: 'google:ruv@ruv.net',
  });
});

test('mintHumanIdentityAttestation rejects an unadmitted verifier key — signed by a different attester keypair', async () => {
  const { config } = mockBridge({ ...nonceMockHandlers() });
  const attestation = await mintHumanIdentityAttestation('om-1', 'co-1', 'google:x@ruv.net', 15 * 60, {
    privateKeyPem: TEST_PRIVATE_KEY_PEM,
  });
  await assert.rejects(() => verifyHumanIdentityAttestation(attestation, new Set(['some-other-key']), config));
});

test('resolveAttesterPublicKeyDerHex throws when neither privateKeyPem nor secretName/secretProject are configured', async () => {
  const previousSecret = process.env.RUCLIP_ATTESTER_SIGNING_SECRET;
  const previousProject = process.env.RUCLIP_ATTESTER_SIGNING_PROJECT;
  delete process.env.RUCLIP_ATTESTER_SIGNING_SECRET;
  delete process.env.RUCLIP_ATTESTER_SIGNING_PROJECT;
  try {
    await assert.rejects(() => resolveAttesterPublicKeyDerHex({}));
  } finally {
    if (previousSecret !== undefined) process.env.RUCLIP_ATTESTER_SIGNING_SECRET = previousSecret;
    if (previousProject !== undefined) process.env.RUCLIP_ATTESTER_SIGNING_PROJECT = previousProject;
  }
});

// Dream Cycle 2026-10-06 (security): identity-map.ts (CACHE_TTL_MS) and
// google-token.ts (PUBLIC_KEY_CACHE_TTL_MS) both cache their Secret Manager
// read with a short TTL — documented in each file's own header as closing an
// "every request hits GCP" availability/latency gap. signing-key.ts, reading
// a secret of the exact same sensitivity from the exact same Secret Manager
// API, was missed: it re-fetched on every single mint. This directly
// reproduces a real fake Secret Manager backend (counting calls, no network)
// rather than inferring the call count from source reading.
test('mintHumanIdentityAttestation reuses the Secret Manager read across calls within the cache TTL (matches identity-map.ts/google-token.ts)', async () => {
  const { config } = mockBridge({ ...nonceMockHandlers() });
  let accessCount = 0;
  const fakeSecretManagerClient = {
    accessSecretVersion: async () => {
      accessCount += 1;
      return [{ payload: { data: Buffer.from(TEST_PRIVATE_KEY_PEM) } }, undefined, undefined] as [
        { payload: { data: Buffer } },
        undefined,
        undefined,
      ];
    },
  };
  const signingConfig = {
    secretName: 'dream-cycle-test-signing-secret',
    secretProject: 'dream-cycle-test-project',
    secretManagerClient: fakeSecretManagerClient,
  };

  const first = await mintHumanIdentityAttestation('om-1', 'co-1', 'google:cache-test@ruv.net', 15 * 60, signingConfig);
  const second = await mintHumanIdentityAttestation('om-2', 'co-2', 'google:cache-test-2@ruv.net', 15 * 60, signingConfig);

  assert.equal(first.attesterPublicKeyDerHex, second.attesterPublicKeyDerHex);
  assert.equal(accessCount, 1, `expected the cached keypair to be reused (1 Secret Manager read), got ${accessCount}`);
  void config;
});
