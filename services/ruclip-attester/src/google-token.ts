/**
 * Caller-identity verification for `ruclip-attester`'s `/v1/attest` handler
 * (HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md §4 step 2).
 *
 * **This replaces, not layers on top of, the previous round's decode-without-
 * verify approach** (team-lead authorization, docs/PLAN.md 2026-09-02).
 * That round's finding: Cloud Run's own front-end forwards the caller's
 * `Authorization: Bearer <token>` header but replaces its signature segment
 * with the literal string `SIGNATURE_REMOVED_BY_GOOGLE` before the container
 * ever sees it — cryptographic verification of THAT header is structurally
 * impossible, so the previous version deliberately decoded the payload
 * without verifying it, relying entirely on Cloud Run's own IAM invoker
 * check (§3.1) as the real authentication boundary. ruclip-tester/
 * ruclip-security then demonstrated this has a real, complete gap: the
 * app process has zero independent way to confirm a request actually came
 * through that IAM check, so ANY caller with network reach to the container
 * can impersonate ANY mapped employee by fabricating a JWT-shaped blob with
 * a plausible `iss`/`exp`/`email` (see `tests/forged-token-trust-boundary.test.ts`,
 * now rewritten to demonstrate this is CLOSED).
 *
 * **The fix: Identity-Aware Proxy (IAP), not the raw Cloud Run `Authorization`
 * header.** Once IAP is enabled in front of this service (a separate,
 * later, live-deployment step — NOT done as part of this change; see
 * docs/PLAN.md), IAP itself authenticates the caller and injects its OWN
 * signed JWT into the `x-goog-iap-jwt-assertion` header — a channel Cloud
 * Run's proxy does not touch or redact, because it isn't the Authorization
 * header IAP is fronting. That header's signature IS genuinely verifiable
 * by app code, against IAP's own published public keys — giving this
 * module a real cryptographic trust boundary that the old
 * `Authorization`-header path never had.
 *
 * Verification here uses `google-auth-library`'s real, documented IAP
 * support — confirmed by reading the actual installed v10.9.1 source
 * (`node_modules/google-auth-library/build/src/auth/oauth2client.js`), not
 * assumed from a docs sample:
 *   - `OAuth2Client#getIapPublicKeysAsync()` fetches
 *     `https://www.gstatic.com/iap/verify/public_key` (a `{kid: PEM}` map —
 *     confirmed to be the same URL Google's own docs name,
 *     cloud.google.com/iap/docs/signed-headers-howto, fetched 2026-09-02).
 *   - `OAuth2Client#verifySignedJwtWithCertsAsync(jwt, certs, audience,
 *     issuers)` does real ES256 signature verification (via the
 *     `ecdsa-sig-formatter` JOSE→DER conversion this exact library already
 *     depends on) plus `iat`/`exp`/`iss`/`aud` checks, and returns a
 *     `LoginTicket` wrapping the verified payload. `getIapPublicKeysAsync()`'s
 *     output plugs directly into this as the `certs` argument — both use
 *     the same `{kid: PEM}` shape.
 *
 * **Audience**: per Google's docs, a Cloud Run backend's IAP `aud` claim is
 * exactly `/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE_NAME}`
 * — this is deployment-specific and NOT hardcoded here (confirming the
 * real project number for `ruclip-attester` is step 2's job, not this
 * round's — see `RUCLIP_ATTESTER_IAP_AUDIENCE` below). Getting this wrong
 * fails closed (verification throws), never open.
 *
 * **`emailVerified` mapping**: IAP's JWT has NO `email_verified` claim at
 * all (confirmed against Google's documented IAP claim set — distinct from
 * a classic Google Sign-In ID token, which does carry one). Since an IAP
 * JWT's `email` claim only exists because Cloud IAM has already
 * authenticated the caller as that identity before minting this signed
 * assertion, a cryptographically-verified IAP `email` claim is at least as
 * strong a signal as `email_verified: true` was on the older token type —
 * so `verify()` maps a successfully-verified IAP token's email to
 * `emailVerified: true` unconditionally, not because the field was
 * observed on the wire.
 *
 * **What's verified-by-reading-source vs. still-to-be-confirmed-once-IAP-
 * is-actually-enabled (step 2's job, explicitly out of scope here)**: the
 * cryptographic mechanism above (library methods, endpoint URL, ES256
 * handling, claim names) is confirmed against real installed source and
 * Google's own documentation. What is NOT yet confirmed, because IAP isn't
 * live on the real service yet: the exact `RUCLIP_ATTESTER_IAP_AUDIENCE`
 * value for the real deployed service (this project's real project number),
 * and that IAP's real, live-issued JWTs match this shape byte-for-byte
 * against this exact code path. Test coverage here uses a real ES256
 * keypair and a real `verifySignedJwtWithCertsAsync` call (no mocking of
 * the cryptography itself) against fixtures shaped exactly like Google's
 * documented format — not a live IAP-issued token, since none exists yet.
 */
import { OAuth2Client } from 'google-auth-library';

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

/** Injectable — `handleAttestRequest` (attest-handler.ts) depends on this interface, not the concrete verification logic, so tests can simulate malformed/expired/wrong-issuer/wrong-audience outcomes precisely. */
export interface GoogleIdTokenVerifier {
  verify(idToken: string): Promise<GoogleIdTokenClaims>;
}

/** IAP's fixed, documented issuer value — not deployment-specific, unlike audience. */
const IAP_ISSUER = 'https://cloud.google.com/iap';

export interface IapVerifierConfig {
  /**
   * Overrides RUCLIP_ATTESTER_IAP_AUDIENCE. The exact Cloud Run IAP
   * audience string: `/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE_NAME}`.
   * Required (verification fails closed with no audience configured) —
   * never guessed or defaulted.
   */
  audience?: string;
  /**
   * Test/dev-only escape hatch — a fixed `{kid: PEM}` public-key map,
   * bypassing the live `https://www.gstatic.com/iap/verify/public_key`
   * fetch entirely. Real signature verification still runs against
   * whatever map is supplied here.
   */
  publicKeys?: Record<string, string>;
}

/**
 * Security-review addition (round 2 of the IAP fix, pre-deployment):
 * `OAuth2Client#getIapPublicKeysAsync()` — unlike its sibling
 * `getFederatedSignonCertsAsync()` (used for classic Google ID tokens,
 * confirmed by reading the same installed source) — has NO caching of its
 * own; it hits `https://www.gstatic.com/iap/verify/public_key` fresh on
 * every single call. Left as-is, every `/v1/attest` request would make a
 * live network round-trip to Google before it could verify anything: added
 * latency per login, and a new single point of failure where a transient
 * outage/rate-limit on Google's endpoint fails EVERY login, not just the
 * one in flight. Not a security gap (a fetch failure still fails closed —
 * see the catch below, unchanged), but exactly the "operational risk once
 * this is actually live" this class was asked to be checked for before
 * step 2 touches the real service. Fixed with the same short-TTL,
 * per-process cache identity-map.ts already establishes for the same class
 * of secret/network read in this exact codebase (`CACHE_TTL_MS`) — the
 * `config.publicKeys` test/dev escape hatch bypasses it entirely, same
 * convention as that file's `mapJson` override.
 */
const PUBLIC_KEY_CACHE_TTL_MS = 60_000;

/**
 * The real, deployed verifier — real ES256 cryptographic verification
 * against IAP's published public keys. See file header for the full
 * mechanism and what's confirmed-by-source vs. pending step 2 (live IAP
 * enablement).
 */
export class RealGoogleIdTokenVerifier implements GoogleIdTokenVerifier {
  private readonly client = new OAuth2Client();
  private keyCache: { value: Record<string, string>; fetchedAt: number } | null = null;

  constructor(private readonly config: IapVerifierConfig = {}) {}

  private async loadPublicKeys(): Promise<Record<string, string>> {
    if (this.config.publicKeys) return this.config.publicKeys;
    if (this.keyCache && Date.now() - this.keyCache.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
      return this.keyCache.value;
    }
    try {
      const { pubkeys } = await this.client.getIapPublicKeysAsync();
      this.keyCache = { value: pubkeys, fetchedAt: Date.now() };
      return pubkeys;
    } catch (err) {
      throw new GoogleIdTokenVerificationError('Failed to fetch IAP public keys from Google', err);
    }
  }

  async verify(idToken: string): Promise<GoogleIdTokenClaims> {
    const audience = this.config.audience ?? process.env.RUCLIP_ATTESTER_IAP_AUDIENCE;
    if (!audience) {
      throw new GoogleIdTokenVerificationError(
        'No IAP audience configured: pass config.audience for tests/dev, or set RUCLIP_ATTESTER_IAP_AUDIENCE to ' +
          "this service's exact Cloud Run IAP audience string " +
          '(/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE_NAME}) — provisioning/confirming ' +
          'that value against the real deployed service is a deployment step outside this code',
      );
    }

    const publicKeys = await this.loadPublicKeys();

    let payload;
    try {
      const ticket = await this.client.verifySignedJwtWithCertsAsync(idToken, publicKeys, audience, [IAP_ISSUER]);
      payload = ticket.getPayload();
    } catch (err) {
      throw new GoogleIdTokenVerificationError('IAP JWT failed cryptographic verification', err);
    }

    if (!payload?.email) {
      throw new GoogleIdTokenVerificationError('IAP JWT has no email claim');
    }

    // See file header "emailVerified mapping" — IAP has no email_verified
    // claim; a cryptographically-verified IAP email claim IS the strong
    // signal that field represents.
    return { email: payload.email, emailVerified: true };
  }
}
