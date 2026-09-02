/**
 * Coverage for docs/design/HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md §4's
 * `/v1/attest` handler: mapping hit, mapping miss, expired/malformed/
 * wrong-issuer tokens (simulated here via the injected `GoogleIdTokenVerifier`
 * interface, to isolate the HANDLER's own reaction to a rejection —
 * google-token.test.ts covers the real `RealGoogleIdTokenVerifier` decode
 * logic directly, now that it's pure/offline-testable, see that file's own
 * header for why), unverified email, the generic-error-message requirement
 * (no info leaked about which rejection reason applied), and the
 * case-insensitive `Bearer` scheme match (real-behavior finding from live
 * deployment testing, docs/PLAN.md commit 1fbdd2e — Cloud Run forwards the
 * Authorization header but lowercases the scheme to `bearer`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAttestRequest, type AttestDeps } from '../src/attest-handler.js';
import { GoogleIdTokenVerificationError, type GoogleIdTokenVerifier } from '../src/google-token.js';
import type { HumanIdentityAttestation } from '../../../src/control-plane/authorization/human-identity-attestation.js';

function fakeVerifier(result: { email: string; emailVerified: boolean } | Error): GoogleIdTokenVerifier {
  return {
    async verify() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function fakeAttestation(orgMemberId: string, companyId: string, humanIdentityRef: string): HumanIdentityAttestation {
  return {
    orgMemberId,
    companyId,
    humanIdentityRef,
    issuedAt: '2026-09-02T00:00:00.000Z',
    expiresAt: '2026-09-02T00:15:00.000Z',
    nonce: 'test-nonce',
    signature: 'test-signature',
    attesterPublicKeyDerHex: 'test-attester-key',
  };
}

test('handleAttestRequest: mapping hit -> 200 with the minted attestation', async () => {
  const deps: AttestDeps = {
    verifier: fakeVerifier({ email: 'ruv@ruv.net', emailVerified: true }),
    lookupIdentity: async (email) =>
      email === 'ruv@ruv.net' ? { orgMemberId: 'om-ceo-001', companyId: 'company-ruclip-001' } : null,
    mintAttestation: async (orgMemberId, companyId, humanIdentityRef) =>
      fakeAttestation(orgMemberId, companyId, humanIdentityRef),
  };
  const result = await handleAttestRequest('Bearer real-google-token', deps);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, fakeAttestation('om-ceo-001', 'company-ruclip-001', 'google:ruv@ruv.net'));
});

test('handleAttestRequest: mapping miss -> 403 with a generic message (no orgMemberId/companyId/email leaked)', async () => {
  const deps: AttestDeps = {
    verifier: fakeVerifier({ email: 'nobody@ruv.net', emailVerified: true }),
    lookupIdentity: async () => null,
    mintAttestation: async () => {
      throw new Error('mintAttestation must not be called on a mapping miss');
    },
  };
  const result = await handleAttestRequest('Bearer real-google-token', deps);
  assert.equal(result.status, 403);
  assert.equal((result.body as { error: string }).error, 'no verified employee mapping for this identity');
  assert.ok(!JSON.stringify(result.body).includes('nobody@ruv.net'));
});

test('handleAttestRequest: unverified email -> 403 with the SAME generic message as a mapping miss', async () => {
  const deps: AttestDeps = {
    verifier: fakeVerifier({ email: 'ruv@ruv.net', emailVerified: false }),
    lookupIdentity: async () => {
      throw new Error('lookupIdentity must not be called when email_verified is false');
    },
    mintAttestation: async () => {
      throw new Error('mintAttestation must not be called when email_verified is false');
    },
  };
  const result = await handleAttestRequest('Bearer real-google-token', deps);
  assert.equal(result.status, 403);
  assert.equal((result.body as { error: string }).error, 'no verified employee mapping for this identity');
});

test('handleAttestRequest: expired token (simulated verifier rejection) -> 401 generic', async () => {
  const deps: AttestDeps = {
    verifier: fakeVerifier(new GoogleIdTokenVerificationError('Token used too late')),
    lookupIdentity: async () => {
      throw new Error('must not reach lookupIdentity');
    },
    mintAttestation: async () => {
      throw new Error('must not reach mintAttestation');
    },
  };
  const result = await handleAttestRequest('Bearer expired-token', deps);
  assert.equal(result.status, 401);
  assert.equal((result.body as { error: string }).error, 'invalid identity token');
});

test('handleAttestRequest: malformed token (simulated verifier rejection) -> 401 generic', async () => {
  const deps: AttestDeps = {
    verifier: fakeVerifier(new GoogleIdTokenVerificationError("Wrong number of segments in token: 'garbage'")),
    lookupIdentity: async () => {
      throw new Error('must not reach lookupIdentity');
    },
    mintAttestation: async () => {
      throw new Error('must not reach mintAttestation');
    },
  };
  const result = await handleAttestRequest('Bearer garbage', deps);
  assert.equal(result.status, 401);
  assert.equal((result.body as { error: string }).error, 'invalid identity token');
});

test('handleAttestRequest: wrong-issuer token (simulated verifier rejection) -> 401 generic', async () => {
  const deps: AttestDeps = {
    verifier: fakeVerifier(new GoogleIdTokenVerificationError('Invalid issuer, expected one of [accounts.google.com]')),
    lookupIdentity: async () => {
      throw new Error('must not reach lookupIdentity');
    },
    mintAttestation: async () => {
      throw new Error('must not reach mintAttestation');
    },
  };
  const result = await handleAttestRequest('Bearer wrong-issuer', deps);
  assert.equal(result.status, 401);
  assert.equal((result.body as { error: string }).error, 'invalid identity token');
});

test('handleAttestRequest: missing Authorization header -> 401, verifier never called', async () => {
  let verifierCalled = false;
  const deps: AttestDeps = {
    verifier: {
      async verify() {
        verifierCalled = true;
        return { email: 'x', emailVerified: true };
      },
    },
    lookupIdentity: async () => null,
    mintAttestation: async () => {
      throw new Error('must not reach mintAttestation');
    },
  };
  const result = await handleAttestRequest(undefined, deps);
  assert.equal(result.status, 401);
  assert.equal(verifierCalled, false);
});

test('handleAttestRequest: non-Bearer Authorization header -> 401', async () => {
  const deps: AttestDeps = {
    verifier: fakeVerifier({ email: 'x', emailVerified: true }),
    lookupIdentity: async () => null,
    mintAttestation: async () => {
      throw new Error('must not reach mintAttestation');
    },
  };
  const result = await handleAttestRequest('Basic dXNlcjpwYXNz', deps);
  assert.equal(result.status, 401);
});

test('handleAttestRequest: matches the Bearer scheme case-insensitively — Cloud Run forwards it lowercased as "bearer" (real finding, docs/PLAN.md 1fbdd2e)', async () => {
  const deps: AttestDeps = {
    verifier: fakeVerifier({ email: 'ruv@ruv.net', emailVerified: true }),
    lookupIdentity: async () => ({ orgMemberId: 'om-1', companyId: 'co-1' }),
    mintAttestation: async (orgMemberId, companyId, humanIdentityRef) => fakeAttestation(orgMemberId, companyId, humanIdentityRef),
  };
  const lowercase = await handleAttestRequest('bearer real-google-token', deps);
  assert.equal(lowercase.status, 200);

  const mixedCase = await handleAttestRequest('BeArEr real-google-token', deps);
  assert.equal(mixedCase.status, 200);

  const upperCase = await handleAttestRequest('BEARER real-google-token', deps);
  assert.equal(upperCase.status, 200);
});

test('handleAttestRequest: the returned attestation names google:<email> as humanIdentityRef, never the client-supplied token', async () => {
  const deps: AttestDeps = {
    verifier: fakeVerifier({ email: 'architect@ruv.net', emailVerified: true }),
    lookupIdentity: async () => ({ orgMemberId: 'om-architect', companyId: 'co-1' }),
    mintAttestation: async (orgMemberId, companyId, humanIdentityRef) =>
      fakeAttestation(orgMemberId, companyId, humanIdentityRef),
  };
  const result = await handleAttestRequest('Bearer token', deps);
  assert.equal(result.status, 200);
  assert.equal((result.body as HumanIdentityAttestation).humanIdentityRef, 'google:architect@ruv.net');
});
