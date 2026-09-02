/**
 * FINDING CLOSED (2026-09-02, IAP verification round): this file originally
 * demonstrated that `RealGoogleIdTokenVerifier` accepted a completely
 * fabricated token — no real Google signature anywhere in its history — end
 * to end through `handleAttestRequest`, minting a real, validly-signed
 * `HumanIdentityAttestation` for an attacker-chosen identity. That was the
 * necessary, honestly-documented consequence of the previous round's
 * decode-without-verify design (Cloud Run redacts the real
 * `Authorization`-header token's signature, so that design could not
 * cryptographically verify it and relied entirely on Cloud Run's own IAM
 * invoker check as an unconfirmable-from-app-code trust boundary).
 *
 * Team-lead's authorized fix (docs/PLAN.md, this round): IAP verification
 * via the `x-goog-iap-jwt-assertion` header (see google-token.ts's own
 * header for the full mechanism) gives the app a channel it CAN
 * cryptographically verify — IAP's own ES256 signature over IAP's own
 * published public keys, not Cloud Run's redacted `Authorization` header.
 *
 * This file now demonstrates the SAME end-to-end attack — a completely
 * fabricated token, never touched by IAP — is REJECTED through the full
 * `handleAttestRequest` pipeline, closing the finding. Complements
 * google-token.test.ts's unit-level "CLOSES THE FINDING" tests (which
 * exercise `RealGoogleIdTokenVerifier` directly, including the specific
 * tampered-payload-with-real-signature and wrong-key forgery variants) —
 * this file's job is the pipeline-level, end-to-end confirmation only.
 *
 * As before: no live network/GCP calls, real cryptography (a real
 * generated ES256 keypair, real `google-auth-library` verification), no
 * mocking of the crypto layer itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { derToJose } from 'ecdsa-sig-formatter';
import { RealGoogleIdTokenVerifier } from '../src/google-token.js';
import { handleAttestRequest, type AttestDeps } from '../src/attest-handler.js';

const TEST_AUDIENCE = '/projects/123456789012/locations/us-central1/services/ruclip-attester';
const IAP_ISSUER = 'https://cloud.google.com/iap';
const TEST_KID = 'test-iap-key-1';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function forgedJwt(payload: Record<string, unknown>, fakeSignature: string): string {
  // `alg: 'none'` and a hand-typed fake signature — no real key, no real
  // Google/IAP involvement anywhere in this token's history.
  const header = { alg: 'none', kid: TEST_KID, typ: 'JWT' };
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.${fakeSignature}`;
}

function realIapSignedJwtForDifferentAudience(): { jwt: string; publicKeyPem: string } {
  // A GENUINE, correctly-signed IAP-shaped token — just for a different
  // service's audience. Proves audience checking, not signature checking,
  // is what stops this one (the signature-forgery cases are covered above
  // and in google-token.test.ts).
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: IAP_ISSUER,
    aud: '/projects/123456789012/locations/us-central1/services/some-other-service',
    email: 'ruv@ruv.net',
    iat: now,
    exp: now + 3600,
  };
  const header = { alg: 'ES256', kid: TEST_KID, typ: 'JWT' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const der = createSign('SHA256').update(signingInput).sign(privateKey as unknown as KeyObject);
  const jose = derToJose(der, 'ES256');
  return { jwt: `${signingInput}.${jose}`, publicKeyPem };
}

test(
  'CLOSED: a token whose signature segment is ENTIRELY fabricated (alg: none, ' +
    'no real key, never touched by IAP or Google) is now REJECTED, not accepted',
  async () => {
    const { publicKeyPem } = realIapSignedJwtForDifferentAudience(); // just need a plausible configured key
    const forged = forgedJwt(
      {
        iss: IAP_ISSUER,
        aud: TEST_AUDIENCE,
        email: 'ruv@ruv.net',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      'this-signature-was-typed-by-a-test-nobody-signed-anything-here',
    );
    const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: publicKeyPem } });
    await assert.rejects(() => verifier.verify(forged));
  },
);

test(
  'CLOSED: the same fully-fabricated token, fed through the complete handleAttestRequest pipeline, ' +
    'no longer mints an attestation — the request is rejected before lookupIdentity/mintAttestation ever run',
  async () => {
    const { publicKeyPem } = realIapSignedJwtForDifferentAudience();
    const forged = forgedJwt(
      { iss: IAP_ISSUER, aud: TEST_AUDIENCE, email: 'ruv@ruv.net', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
      'anyone-with-network-access-to-this-process-could-write-this-string',
    );

    let mintedFor: unknown = null;
    const deps: AttestDeps = {
      verifier: new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: publicKeyPem } }),
      lookupIdentity: async () => {
        throw new Error('lookupIdentity must not be called for a token that failed cryptographic verification');
      },
      mintAttestation: async (orgMemberId, companyId, humanIdentityRef) => {
        mintedFor = { orgMemberId, companyId, humanIdentityRef };
        throw new Error('mintAttestation must not be called for a token that failed cryptographic verification');
      },
    };

    const result = await handleAttestRequest(forged, deps);
    assert.equal(result.status, 401, 'the forged token is now rejected at verification, not accepted');
    assert.equal(mintedFor, null, 'no attestation was minted for the forged token');
  },
);

test(
  'a genuinely IAP-signed token for a DIFFERENT service (wrong audience) is rejected — proves audience is ' +
    'actually checked, not just signature validity',
  async () => {
    const { jwt, publicKeyPem } = realIapSignedJwtForDifferentAudience();
    const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: publicKeyPem } });
    await assert.rejects(() => verifier.verify(jwt));
  },
);
