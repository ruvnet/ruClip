/**
 * Pure handler for `POST /v1/attest` (HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md
 * §4) — separated from `server.ts`'s raw HTTP wiring so it can be tested
 * directly against injected dependencies (no real network/GCP calls),
 * mirroring this repo's own `fetchImpl`/`tokenProvider` dependency-injection
 * discipline throughout `store/bridge-client.ts`/`autogenous-client.ts`.
 *
 * Deliberately returns the SAME generic error message for every rejection
 * reason (missing/invalid token, unverified email, no mapping entry) —
 * §4 step 4's "no `orgMemberId`/`companyId`/email leaked in the error"
 * requirement, generalized: a caller should not be able to distinguish
 * "your email isn't verified" from "you're not in our mapping" from the
 * response alone, since either signal narrows down real identity
 * information about who is and isn't a mapped employee.
 *
 * **IAP round (team-lead's authorization, replacing the Authorization-header
 * approach — see google-token.ts's own header for the full history)**: the
 * identity token this handler reads now comes from the
 * `x-goog-iap-jwt-assertion` header IAP itself injects, not the
 * `Authorization` header Cloud Run's own front-end proxy forwards (and
 * redacts the signature of — the reason the previous round couldn't verify
 * it). Confirmed against Google's own IAP documentation
 * (cloud.google.com/iap/docs/signed-headers-howto, fetched 2026-09-02):
 * that header carries the raw JWT with no scheme prefix — unlike
 * `Authorization`, there is no `Bearer <token>` wrapping to parse here.
 * Google's docs also name two additional unsigned convenience headers
 * (`x-goog-authenticated-user-email`/`-id`) that this handler deliberately
 * never reads — Google's own docs warn these are forgeable by anyone who
 * bypasses IAP, so identity comes only from the verified JWT payload.
 */
import type { HumanIdentityAttestation } from '../../../src/control-plane/authorization/human-identity-attestation.js';
import type { GoogleIdTokenVerifier } from './google-token.js';
import type { IdentityMappingEntry } from './identity-map.js';

const GENERIC_REJECTION_MESSAGE = 'no verified employee mapping for this identity';

export interface AttestDeps {
  verifier: GoogleIdTokenVerifier;
  lookupIdentity: (email: string) => Promise<IdentityMappingEntry | null>;
  mintAttestation: (orgMemberId: string, companyId: string, humanIdentityRef: string) => Promise<HumanIdentityAttestation>;
}

export type AttestResult =
  | { status: 200; body: HumanIdentityAttestation }
  | { status: 401; body: { error: string } }
  | { status: 403; body: { error: string } };

export async function handleAttestRequest(
  iapJwtHeader: string | undefined | null,
  deps: AttestDeps,
): Promise<AttestResult> {
  const idToken = iapJwtHeader?.trim();
  if (!idToken) {
    return { status: 401, body: { error: 'missing IAP identity assertion' } };
  }

  let claims: Awaited<ReturnType<GoogleIdTokenVerifier['verify']>>;
  try {
    claims = await deps.verifier.verify(idToken);
  } catch {
    return { status: 401, body: { error: 'invalid identity token' } };
  }

  if (!claims.emailVerified) {
    // Same generic message as "not mapped" — see file header.
    return { status: 403, body: { error: GENERIC_REJECTION_MESSAGE } };
  }

  const mapping = await deps.lookupIdentity(claims.email);
  if (!mapping) {
    return { status: 403, body: { error: GENERIC_REJECTION_MESSAGE } };
  }

  const attestation = await deps.mintAttestation(mapping.orgMemberId, mapping.companyId, `google:${claims.email}`);
  return { status: 200, body: attestation };
}
