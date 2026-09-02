/**
 * Coverage for google-token.ts's `RealGoogleIdTokenVerifier` — now real
 * cryptographic verification against IAP's ES256 public keys (team-lead's
 * IAP authorization, replacing the decode-without-verify approach; see that
 * file's own header for the full history and reasoning).
 *
 * Deliberately exercises the REAL `google-auth-library` cryptography end to
 * end — a real generated P-256 keypair, a real ES256-signed JWT built with
 * the same `ecdsa-sig-formatter` conversion `google-auth-library` itself
 * uses internally (confirmed by reading its installed source — see
 * google-token.ts's header) — injected via `config.publicKeys`, the
 * documented test/dev escape hatch that bypasses only the LIVE
 * `https://www.gstatic.com/iap/verify/public_key` network fetch, never the
 * cryptographic verification itself. No live IAP-issued token exists yet
 * (IAP enablement is step 2, a separate later task — see google-token.ts
 * header) so these fixtures are shaped exactly per Google's documented IAP
 * JWT format, not captured from a real request; that gap is called out
 * explicitly rather than claimed as "confirmed live".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { derToJose } from 'ecdsa-sig-formatter';
import { RealGoogleIdTokenVerifier, GoogleIdTokenVerificationError } from '../src/google-token.js';

const TEST_AUDIENCE = '/projects/123456789012/locations/us-central1/services/ruclip-attester';
const IAP_ISSUER = 'https://cloud.google.com/iap';
const TEST_KID = 'test-iap-key-1';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signIapJwt(
  privateKey: KeyObject,
  payload: Record<string, unknown>,
  opts?: { kid?: string; alg?: string },
): string {
  const header = { alg: opts?.alg ?? 'ES256', kid: opts?.kid ?? TEST_KID, typ: 'JWT' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  // Real ECDSA signature over the real signing input — DER by default from
  // node:crypto, converted to JOSE (raw R||S) format exactly the way
  // google-auth-library's own verifySignedJwtWithCertsAsync expects (it
  // does the inverse conversion internally — see google-token.ts header).
  const derSignature = createSign('SHA256').update(signingInput).sign(privateKey);
  const joseSignature = derToJose(derSignature, 'ES256');
  return `${signingInput}.${joseSignature}`;
}

function generateIapTestKeypair(): { privateKey: KeyObject; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicKeyPem };
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: IAP_ISSUER,
    aud: TEST_AUDIENCE,
    email: 'ruv@ruv.net',
    sub: 'accounts.google.com:1234567890',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

test('RealGoogleIdTokenVerifier accepts a real ES256-signed IAP token from the configured public key and maps emailVerified: true (IAP has no email_verified claim of its own)', async () => {
  const { privateKey, publicKeyPem } = generateIapTestKeypair();
  const jwt = signIapJwt(privateKey, validPayload());
  const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: publicKeyPem } });

  const claims = await verifier.verify(jwt);
  assert.deepEqual(claims, { email: 'ruv@ruv.net', emailVerified: true });
});

test('CLOSES THE FINDING: a token whose payload was tampered with after signing (email changed, signature untouched) is REJECTED — the previous decode-without-verify round would have silently accepted this', async () => {
  const { privateKey, publicKeyPem } = generateIapTestKeypair();
  const genuinelySignedJwt = signIapJwt(privateKey, validPayload({ email: 'ruv@ruv.net' }));
  const [headerB64, , signatureB64] = genuinelySignedJwt.split('.');

  // Attacker rewrites the payload segment to impersonate a different
  // employee, keeping the ORIGINAL real signature (exactly the class of
  // forgery forged-token-trust-boundary.test.ts demonstrated succeeding
  // against the old verifier).
  const tamperedPayloadB64 = base64url(JSON.stringify(validPayload({ email: 'attacker@ruv.net' })));
  const forged = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;

  const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: publicKeyPem } });
  await assert.rejects(() => verifier.verify(forged), GoogleIdTokenVerificationError);
});

test('CLOSES THE FINDING: a token signed with an attacker-controlled key (not IAP\'s), even with a correct kid claim on the header, is REJECTED', async () => {
  const { publicKeyPem } = generateIapTestKeypair(); // the "real" IAP key ruclip-attester is configured to trust
  const { privateKey: attackerKey } = generateIapTestKeypair(); // a completely different keypair the attacker controls

  // Attacker signs a token with THEIR OWN private key but claims the same
  // kid as the real IAP key, hoping the app only checks structural shape.
  const forged = signIapJwt(attackerKey, validPayload(), { kid: TEST_KID });

  const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: publicKeyPem } });
  await assert.rejects(() => verifier.verify(forged), GoogleIdTokenVerificationError);
});

test('rejects a token whose kid is not in the configured public key set', async () => {
  const { privateKey, publicKeyPem } = generateIapTestKeypair();
  void publicKeyPem;
  const jwt = signIapJwt(privateKey, validPayload(), { kid: 'unknown-kid' });

  const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----' } });
  await assert.rejects(() => verifier.verify(jwt), GoogleIdTokenVerificationError);
});

test('rejects a token with the wrong issuer (not IAP\'s documented https://cloud.google.com/iap)', async () => {
  const { privateKey, publicKeyPem } = generateIapTestKeypair();
  const jwt = signIapJwt(privateKey, validPayload({ iss: 'https://evil.example.com' }));

  const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: publicKeyPem } });
  await assert.rejects(() => verifier.verify(jwt), GoogleIdTokenVerificationError);
});

test('rejects a token with the wrong audience (a different service\'s IAP-fronted Cloud Run backend)', async () => {
  const { privateKey, publicKeyPem } = generateIapTestKeypair();
  const jwt = signIapJwt(
    privateKey,
    validPayload({ aud: '/projects/123456789012/locations/us-central1/services/some-other-service' }),
  );

  const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: publicKeyPem } });
  await assert.rejects(() => verifier.verify(jwt), GoogleIdTokenVerificationError);
});

test('rejects an expired token', async () => {
  const { privateKey, publicKeyPem } = generateIapTestKeypair();
  const now = Math.floor(Date.now() / 1000);
  const jwt = signIapJwt(privateKey, validPayload({ iat: now - 7200, exp: now - 3600 }));

  const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: publicKeyPem } });
  await assert.rejects(() => verifier.verify(jwt), GoogleIdTokenVerificationError);
});

test('rejects a validly-signed token with no email claim', async () => {
  const { privateKey, publicKeyPem } = generateIapTestKeypair();
  const payload = validPayload();
  delete payload.email;
  const jwt = signIapJwt(privateKey, payload);

  const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: { [TEST_KID]: publicKeyPem } });
  await assert.rejects(() => verifier.verify(jwt), GoogleIdTokenVerificationError);
});

test('rejects a structurally malformed token (not 3 segments) without ever reaching the crypto layer', async () => {
  const verifier = new RealGoogleIdTokenVerifier({ audience: TEST_AUDIENCE, publicKeys: {} });
  await assert.rejects(() => verifier.verify('not-a-jwt-at-all'), GoogleIdTokenVerificationError);
});

test('fails closed with no audience configured — never guesses or defaults the audience', async () => {
  const originalEnv = process.env.RUCLIP_ATTESTER_IAP_AUDIENCE;
  delete process.env.RUCLIP_ATTESTER_IAP_AUDIENCE;
  try {
    const { privateKey, publicKeyPem } = generateIapTestKeypair();
    const jwt = signIapJwt(privateKey, validPayload());
    const verifier = new RealGoogleIdTokenVerifier({ publicKeys: { [TEST_KID]: publicKeyPem } });
    await assert.rejects(() => verifier.verify(jwt), GoogleIdTokenVerificationError);
  } finally {
    if (originalEnv !== undefined) process.env.RUCLIP_ATTESTER_IAP_AUDIENCE = originalEnv;
  }
});
