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

/**
 * HTTP auth scheme names are case-insensitive per RFC 7235 — real-behavior
 * finding from live deployment (docs/PLAN.md, commit 1fbdd2e): Cloud Run's
 * front-end forwards the Authorization header but lowercases the scheme to
 * `bearer`. A literal `startsWith('Bearer ')` check 401s every real,
 * IAM-authorized call. Matches the scheme case-insensitively; the token
 * itself (everything after the scheme) is untouched.
 */
const BEARER_SCHEME_PATTERN = /^bearer\s+(.+)$/i;

export async function handleAttestRequest(
  authorizationHeader: string | undefined | null,
  deps: AttestDeps,
): Promise<AttestResult> {
  const schemeMatch = authorizationHeader ? BEARER_SCHEME_PATTERN.exec(authorizationHeader) : null;
  if (!schemeMatch) {
    return { status: 401, body: { error: 'missing bearer token' } };
  }
  const idToken = schemeMatch[1]!.trim();
  if (!idToken) {
    return { status: 401, body: { error: 'missing bearer token' } };
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
