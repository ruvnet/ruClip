/**
 * Independent coverage answering the architect's specific round-2 review
 * question directly: "trace through whether there's any path where the
 * container receives a request that DIDN'T pass Cloud Run's IAM check."
 *
 * Complements google-token.test.ts (which exercises RealGoogleIdTokenVerifier
 * against a token shaped exactly like what Cloud Run legitimately forwards —
 * signature segment literally `SIGNATURE_REMOVED_BY_GOOGLE`) and
 * attest-handler.test.ts (which exercises the handler's reactions via an
 * injected fake verifier). Neither directly demonstrates the thing worth
 * stating plainly: `RealGoogleIdTokenVerifier` does not check the signature
 * segment's CONTENT at all — not "is it the redacted marker string," not
 * "is it a plausible signature," nothing. It only checks that a third
 * segment exists (`segments.length !== 3`). This means it makes no
 * distinction whatsoever between a token Cloud Run actually redacted and a
 * token any caller with network access fabricated from nothing, with no
 * Google involvement anywhere in its history.
 *
 * ANSWER to the architect's question: yes, structurally, there is such a
 * path — but it is not a code bug to fix, it is the necessary, honestly-
 * documented consequence of google-token.ts's own design (per that file's
 * header: "the platform's IAM invoker check IS the real authentication
 * boundary... this module deliberately does NOT verify the signature").
 * The application layer has ZERO independent means of confirming a request
 * actually passed through Cloud Run's `--no-allow-unauthenticated` gate —
 * it trusts that context unconditionally, with no defense-in-depth of its
 * own. Concretely, this means the entire security model's correctness
 * depends entirely on infrastructure configuration remaining exactly right
 * (the IAM flag never flipped to `--allow-unauthenticated`, this service
 * never run in a different context — local dev exposed to a network, a
 * different hosting platform, a misconfigured proxy/gateway in front of it)
 * — if that assumption is ever violated, ANY caller with network reach to
 * the process can impersonate ANY mapped employee by fabricating a
 * JWT-shaped JSON blob with a plausible `iss`/`exp`/`email` and an
 * arbitrary, meaningless third segment — and the code as written has no
 * way to tell the difference from a real Cloud Run request. This is worth
 * having on record explicitly, in a form more concrete than prose, since
 * it's the load-bearing assumption behind google-token.ts's entire
 * "decode without verify" design.
 *
 * The `exp` check the architect specifically asked about does not change
 * this: it is trivially bypassable by a forger simply omitting `exp`
 * (the check is skipped entirely when `payload.exp` is not a number) or
 * setting it arbitrarily far in the future — confirmed below. It provides
 * no real protection against a forged token; only against a genuinely
 * Google-issued token that has since expired, which is exactly what the
 * file's own "defense in depth, not the real check" framing already says.
 *
 * No live network/GCP calls — pure, offline, matching the rest of this
 * test suite's discipline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealGoogleIdTokenVerifier } from '../src/google-token.js';
import { handleAttestRequest, type AttestDeps } from '../src/attest-handler.js';
import type { HumanIdentityAttestation } from '../../../src/control-plane/authorization/human-identity-attestation.js';

function forgedGoogleToken(payload: Record<string, unknown>, fakeSignature: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'); // no real algorithm, no real key, ever
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return [header, body, fakeSignature].join('.');
}

test(
  'FINDING: RealGoogleIdTokenVerifier accepts a token whose signature segment is ENTIRELY fabricated ' +
    '(not the real Cloud-Run-redacted SIGNATURE_REMOVED_BY_GOOGLE marker, not a real signature of any kind, ' +
    'never touched by Google) — it only checks that a third segment exists, never its content',
  async () => {
    const verifier = new RealGoogleIdTokenVerifier();
    const forged = forgedGoogleToken(
      {
        iss: 'https://accounts.google.com',
        email: 'ruv@ruv.net',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      'this-signature-was-typed-by-a-test-nobody-google-signed-anything-here',
    );
    const claims = await verifier.verify(forged);
    assert.deepEqual(claims, { email: 'ruv@ruv.net', emailVerified: true });
  },
);

test(
  'FINDING: the same fully-fabricated token, fed through the complete handleAttestRequest pipeline, mints a ' +
    "real, validly-signed HumanIdentityAttestation for an attacker-chosen identity — end to end, this service's " +
    "entire security model rests on infrastructure (Cloud Run's IAM invoker check) with zero application-level " +
    'verification that a request actually came through it',
  async () => {
    const forged = forgedGoogleToken(
      {
        iss: 'accounts.google.com',
        email: 'ruv@ruv.net',
        email_verified: true,
      },
      'anyone-with-network-access-to-this-process-could-write-this-string',
    );

    let mintedFor: { orgMemberId: string; companyId: string; humanIdentityRef: string } | null = null;
    const deps: AttestDeps = {
      verifier: new RealGoogleIdTokenVerifier(),
      lookupIdentity: async (email) =>
        email === 'ruv@ruv.net' ? { orgMemberId: 'om-ceo-001', companyId: 'company-ruclip-001' } : null,
      mintAttestation: async (orgMemberId, companyId, humanIdentityRef) => {
        mintedFor = { orgMemberId, companyId, humanIdentityRef };
        const attestation: HumanIdentityAttestation = {
          orgMemberId,
          companyId,
          humanIdentityRef,
          issuedAt: '2026-09-02T00:00:00.000Z',
          expiresAt: '2026-09-02T00:15:00.000Z',
          nonce: 'test-nonce',
          signature: 'real-attester-signature-would-go-here',
          attesterPublicKeyDerHex: 'real-attester-key-would-go-here',
        };
        return attestation;
      },
    };

    const result = await handleAttestRequest(`Bearer ${forged}`, deps);
    assert.equal(result.status, 200, 'the forged token was accepted and a real attestation was minted');
    assert.deepEqual(mintedFor, {
      orgMemberId: 'om-ceo-001',
      companyId: 'company-ruclip-001',
      humanIdentityRef: 'google:ruv@ruv.net',
    });
  },
);

test(
  "the 'exp' defense-in-depth check provides no protection against a forger who simply omits exp entirely " +
    "— confirms the architect's specific concern that this check might be mistaken for load-bearing: it is not",
  async () => {
    const verifier = new RealGoogleIdTokenVerifier();
    const forgedNoExp = forgedGoogleToken(
      { iss: 'accounts.google.com', email: 'ruv@ruv.net', email_verified: true }, // no exp field at all
      'no-signature-needed-to-omit-a-field',
    );
    const claims = await verifier.verify(forgedNoExp);
    assert.deepEqual(claims, { email: 'ruv@ruv.net', emailVerified: true });
  },
);
