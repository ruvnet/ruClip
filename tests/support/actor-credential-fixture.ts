/**
 * Shared ActorCredential test fixture — mints REAL, cryptographically valid
 * credentials via the real `credential-issuer.ts` signing path (radio-moe's
 * real `canonicalBytes` + Node's real Ed25519 `sign`/`verify`), against a
 * throwaway, test-only Ed25519 keypair (never used anywhere but this test
 * suite — not the production issuer key, no GCP Secret Manager involved).
 *
 * Every caller also needs `memory_retrieve`/`memory_store` mock handlers for
 * `verifyActorCredential`'s nonce-replay guard (§3) — `nonceMockHandlers`
 * below provides an in-memory implementation to merge into `mockBridge`.
 */
import { mintActorCredential, resolveAdmittedIssuerKeys, type IssuerKeyConfig } from '../../src/control-plane/authorization/credential-issuer.js';
import type { ActorAuthorization } from '../../src/control-plane/authorization/actor-credential.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';

/** Throwaway Ed25519 PKCS8 PEM — test-only, generated once for this fixture, no relation to any real secret. */
const TEST_ISSUER_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIM8F4M0wgWHu3FFIPB4D7vrH/DZgu0MXNn/bDb4KQKzw\n-----END PRIVATE KEY-----\n';

export const testIssuerConfig: IssuerKeyConfig = { privateKeyPem: TEST_ISSUER_PRIVATE_KEY_PEM };

/** A second, never-admitted keypair — for "signed by an unadmitted issuer" tests. */
export const unadmittedIssuerConfig: IssuerKeyConfig = {
  privateKeyPem:
    '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBIi+Qvfjx2WKGckXxM4S4tO/qRk1D7AAyf/9LIyYsvC\n-----END PRIVATE KEY-----\n',
};

/** Real, valid `ActorAuthorization` for `member` — signed by the test issuer, admitting only the test issuer's key. */
export async function credentialFor(member: OrgMember, opts?: { ttlSeconds?: number }): Promise<ActorAuthorization> {
  const credential = await mintActorCredential(member.id, member.companyId, opts, testIssuerConfig);
  const admittedIssuerKeys = await resolveAdmittedIssuerKeys(testIssuerConfig);
  return { credential, admittedIssuerKeys };
}

/**
 * In-memory `memory_retrieve`/`memory_store` handlers for the
 * `ruclip-actor-credentials` nonce namespace — merge into `mockBridge`'s
 * handler map. A fresh `Map` per call keeps tests isolated from each other.
 */
export function nonceMockHandlers(): Record<string, (args: Record<string, unknown>) => unknown> {
  const store = new Map<string, boolean>();
  return {
    memory_retrieve: (args) => ({ found: store.has(args.key as string) }),
    memory_store: (args) => {
      store.set(args.key as string, true);
      return { success: true };
    },
  };
}
