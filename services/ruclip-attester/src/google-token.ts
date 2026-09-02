/**
 * Google ID token verification for `ruclip-attester`'s `/v1/attest` handler
 * (HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md §4 step 2). This is the
 * app-level, in-process extraction of the SAME bearer token Cloud Run's
 * own IAM invoker check already used to authorize the call — deliberately
 * not redundant: Cloud Run's decision answers "is this caller allowed to
 * invoke me," but the caller's actual identity claims (the `email` field)
 * are only available to app code that independently decodes the token
 * itself.
 *
 * **Real-behavior correction from LIVE deployment testing (2026-09-01,
 * team-lead — docs/PLAN.md commit `1fbdd2e`), not from reading source this
 * time**: this module originally cryptographically re-verified the token
 * via `google-auth-library`'s `OAuth2Client.verifyIdToken`. Against a real
 * deployed `ruclip-attester` behind Cloud Run's own front-end proxy, that
 * call can NEVER succeed — **Cloud Run replaces the forwarded token's
 * signature segment with the literal string `SIGNATURE_REMOVED_BY_GOOGLE`**
 * before handing the request to the container. The earlier local test
 * (hitting the compiled server directly, bypassing Cloud Run's proxy) used
 * a genuine, un-proxied Google token, which is why it passed — that path
 * is structurally different from every real production request.
 *
 * **This is Cloud Run's own standard, documented pattern for
 * `--no-allow-unauthenticated` services, not a gap to route around**: the
 * platform's IAM invoker check (§3.1) IS the real authentication boundary
 * — a request cannot reach this container at all without already passing
 * it. The redacted, forwarded token exists purely so app code can read
 * identity claims from it, not to re-verify them a second time. So this
 * module deliberately does NOT verify the signature — it decodes the
 * payload and applies structural sanity checks instead:
 * 1. Exactly 3 dot-separated segments (well-formed JWT shape).
 * 2. `iss` is exactly `accounts.google.com` or `https://accounts.google.com`
 *    (Google's real, documented ID token issuer values).
 * 3. `exp` (if present) is in the future — cheap, honest extra sanity;
 *    Cloud Run's own IAM check already gates freshness as part of
 *    authorizing the call, so this is defense in depth, not the real
 *    check.
 * Then extracts `email`/`email_verified` — unaffected by the signature
 * redaction, since Cloud Run only replaces the signature segment, not the
 * payload.
 *
 * **Audience is still deliberately NOT checked** (unchanged from the
 * earlier finding, unrelated to this fix): a bare
 * `gcloud auth print-identity-token` produces a token whose `aud` claim is
 * Google's own fixed gcloud-CLI OAuth client id, not this service's URL —
 * requiring `audience` here would make every real login fail regardless of
 * signature handling.
 */

export interface GoogleIdTokenClaims {
  email: string;
  emailVerified: boolean;
}

export class GoogleIdTokenVerificationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'GoogleIdTokenVerificationError';
  }
}

/** Injectable — `handleAttestRequest` (attest-handler.ts) depends on this interface, not the concrete decoding logic, so tests can simulate malformed/expired/wrong-issuer outcomes precisely. */
export interface GoogleIdTokenVerifier {
  verify(idToken: string): Promise<GoogleIdTokenClaims>;
}

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

interface DecodedGooglePayload {
  iss?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
}

/**
 * The real, deployed verifier — decodes without cryptographic signature
 * verification, per this file's own header. See file header for the full
 * finding and reasoning behind why signature verification is correctly
 * absent here, not a gap.
 */
export class RealGoogleIdTokenVerifier implements GoogleIdTokenVerifier {
  async verify(idToken: string): Promise<GoogleIdTokenClaims> {
    const segments = idToken.split('.');
    if (segments.length !== 3) {
      throw new GoogleIdTokenVerificationError(`Malformed ID token: expected 3 dot-separated segments, got ${segments.length}`);
    }

    let payload: DecodedGooglePayload;
    try {
      payload = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as DecodedGooglePayload;
    } catch (err) {
      throw new GoogleIdTokenVerificationError('Malformed ID token: could not decode payload segment', err);
    }

    if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
      throw new GoogleIdTokenVerificationError(`ID token has an unexpected issuer: ${String(payload.iss)}`);
    }
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
      throw new GoogleIdTokenVerificationError('ID token is expired');
    }
    if (!payload.email) {
      throw new GoogleIdTokenVerificationError('ID token has no email claim');
    }

    return { email: payload.email, emailVerified: payload.email_verified === true };
  }
}
