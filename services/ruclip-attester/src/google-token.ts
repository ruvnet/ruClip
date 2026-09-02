/**
 * Google ID token verification for `ruclip-attester`'s `/v1/attest` handler
 * (HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md §4 step 2). This is the
 * app-level, in-process re-verification of the SAME bearer token Cloud
 * Run's own IAM invoker check already used to authorize the call —
 * deliberately not redundant: Cloud Run's decision answers "is this caller
 * allowed to invoke me," but the caller's actual identity claims (the
 * `email` field) are only available to app code that independently
 * decodes/verifies the token itself.
 *
 * Real behavior confirmed by reading `google-auth-library@10.9.1`'s actual
 * `OAuth2Client.verifyIdTokenAsync`/`verifySignedJwtWithCertsAsync` source
 * directly (not just its `.d.ts`), same "check, don't assume" discipline
 * `autogenous-client.ts` used for the `--audiences` flag correction:
 *
 * 1. **Audience is deliberately NOT checked here.** `verifyIdToken`'s
 *    `audience` option is only enforced `if (typeof requiredAudience !==
 *    'undefined' && requiredAudience !== null)` — passing no `audience`
 *    skips that check entirely, confirmed in the library's own source. This
 *    is the right call, not an oversight: `RUCLIP-ATTESTER-URL`'s own
 *    §0.3-confirmed finding is that `gcloud auth print-identity-token`
 *    (bare, no `--audiences`) produces a token whose `aud` claim is
 *    Google's own fixed gcloud-CLI OAuth client id, NOT this service's URL
 *    — requiring `audience` here would make every real login fail. The
 *    actual per-service authorization boundary is Cloud Run's own IAM
 *    invoker check (§3.1), which authorizes by caller identity/signature,
 *    not by the token's `aud` claim — this layer's job is purely to
 *    extract a reliable, signature-verified `email`/`email_verified` claim
 *    from an already-Cloud-Run-authorized request, not to re-gate "was
 *    this token meant for me."
 * 2. `verifyIdToken` fetches Google's real federated signon certs (a
 *    network call to Google) BEFORE parsing the token at all — confirmed in
 *    `verifyIdTokenAsync`'s own source (`getFederatedSignonCertsAsync()`
 *    runs first, unconditionally). This means even a malformed-token
 *    rejection is not exercisable offline — this module's REAL behavior
 *    against Google's live endpoint has NOT been covered by this repo's own
 *    test suite (network-dependent, would be flaky/environment-dependent in
 *    CI) — only the `GoogleIdTokenVerifier` interface's CONTRACT is
 *    covered, via `handleAttestRequest`'s own tests against a fake
 *    implementation. Flagged honestly, not hidden, matching this project's
 *    "confirmed vs still assumed" discipline for every other live-service
 *    integration point.
 * 3. Expiry (`exp`) and issuer (`iss`, defaults to Google's real
 *    `accounts.google.com`/`https://accounts.google.com`) ARE enforced by
 *    the library unconditionally — no extra code needed here for those.
 */
import { OAuth2Client, type TokenPayload } from 'google-auth-library';

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

/** Injectable — `handleAttestRequest` (attest-handler.ts) depends on this interface, not the concrete google-auth-library wiring, so tests can simulate expired/malformed/wrong-issuer outcomes without a live network call. */
export interface GoogleIdTokenVerifier {
  verify(idToken: string): Promise<GoogleIdTokenClaims>;
}

/** The real, google-auth-library-backed verifier — see file header for what's confirmed vs. not yet exercised live. */
export class RealGoogleIdTokenVerifier implements GoogleIdTokenVerifier {
  private readonly client = new OAuth2Client();

  async verify(idToken: string): Promise<GoogleIdTokenClaims> {
    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({ idToken }); // no `audience` — see file header point 1
      payload = ticket.getPayload();
    } catch (err) {
      throw new GoogleIdTokenVerificationError('Google ID token failed verification', err);
    }
    if (!payload || !payload.email) {
      throw new GoogleIdTokenVerificationError('Google ID token has no email claim');
    }
    return { email: payload.email, emailVerified: payload.email_verified === true };
  }
}
