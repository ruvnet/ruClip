/**
 * Coverage for google-token.ts's RealGoogleIdTokenVerifier — real-behavior
 * correction from live deployment testing (docs/PLAN.md commit 1fbdd2e):
 * Cloud Run replaces the forwarded token's signature segment with
 * `SIGNATURE_REMOVED_BY_GOOGLE` before this process ever sees it, so
 * verification is decode-plus-structural-sanity-checks, not cryptographic.
 * That makes this the FIRST time these malformed/expired/wrong-issuer
 * cases can be exercised against the REAL verifier class, offline, with no
 * live network call — the previous cryptographic-verification version
 * could only have these simulated via an injected fake (still done in
 * attest-handler.test.ts for the handler's own reaction to a rejection,
 * but the real decode logic itself is now covered here for real).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealGoogleIdTokenVerifier, GoogleIdTokenVerificationError } from '../src/google-token.js';

function fakeGoogleToken(payload: Record<string, unknown>, opts?: { segments?: number }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = 'SIGNATURE_REMOVED_BY_GOOGLE'; // exactly what Cloud Run forwards — real, confirmed behavior
  const segments = opts?.segments ?? 3;
  return [header, body, signature].slice(0, segments).join('.');
}

const validPayload = {
  iss: 'https://accounts.google.com',
  email: 'ruv@ruv.net',
  email_verified: true,
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const verifier = new RealGoogleIdTokenVerifier();

test('RealGoogleIdTokenVerifier accepts a well-formed, unexpired, correctly-issued token and extracts email/email_verified', async () => {
  const claims = await verifier.verify(fakeGoogleToken(validPayload));
  assert.deepEqual(claims, { email: 'ruv@ruv.net', emailVerified: true });
});

test('RealGoogleIdTokenVerifier accepts the bare "accounts.google.com" issuer form too', async () => {
  const claims = await verifier.verify(fakeGoogleToken({ ...validPayload, iss: 'accounts.google.com' }));
  assert.equal(claims.email, 'ruv@ruv.net');
});

test('RealGoogleIdTokenVerifier extracts email_verified: false honestly, does not default to true', async () => {
  const claims = await verifier.verify(fakeGoogleToken({ ...validPayload, email_verified: false }));
  assert.equal(claims.emailVerified, false);
});

test('RealGoogleIdTokenVerifier rejects a malformed token (wrong number of segments)', async () => {
  await assert.rejects(() => verifier.verify(fakeGoogleToken(validPayload, { segments: 2 })), GoogleIdTokenVerificationError);
  await assert.rejects(() => verifier.verify('not-a-jwt-at-all'), GoogleIdTokenVerificationError);
});

test('RealGoogleIdTokenVerifier rejects a token whose payload segment is not valid base64/JSON', async () => {
  await assert.rejects(() => verifier.verify('aGVhZGVy.not-valid-json-payload!!!.sig'), GoogleIdTokenVerificationError);
});

test('RealGoogleIdTokenVerifier rejects a wrong-issuer token', async () => {
  await assert.rejects(
    () => verifier.verify(fakeGoogleToken({ ...validPayload, iss: 'https://evil.example.com' })),
    GoogleIdTokenVerificationError,
  );
});

test('RealGoogleIdTokenVerifier rejects an expired token', async () => {
  await assert.rejects(
    () => verifier.verify(fakeGoogleToken({ ...validPayload, exp: Math.floor(Date.now() / 1000) - 3600 })),
    GoogleIdTokenVerificationError,
  );
});

test('RealGoogleIdTokenVerifier rejects a token with no email claim', async () => {
  const { email, ...withoutEmail } = validPayload;
  void email;
  await assert.rejects(() => verifier.verify(fakeGoogleToken(withoutEmail)), GoogleIdTokenVerificationError);
});
