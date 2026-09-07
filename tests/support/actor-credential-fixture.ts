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
import { createPrivateKey, createPublicKey, randomUUID, sign as edSign } from 'node:crypto';
import { mintActorCredential, resolveAdmittedIssuerKeys, type IssuerKeyConfig } from '../../src/control-plane/authorization/credential-issuer.js';
import type { ActorAuthorization } from '../../src/control-plane/authorization/actor-credential.js';
import {
  attestationFrame,
  mintHumanActorCredential,
  resolveAdmittedAttesterKeys,
  type HumanIdentityAttestation,
} from '../../src/control-plane/authorization/human-identity-attestation.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { AgentDbAdapterConfig } from '../../src/control-plane/store/agentdb-adapter.js';

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
 * Test-only Ed25519 keypair standing in for an external human-identity
 * attester (e.g. a Cognitum-side identity-resolution service) — see
 * `human-identity-attestation.ts`. Not the ruClip issuer key above; a real
 * deployment's attester and issuer keys belong to different systems.
 */
const TEST_ATTESTER_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIOTpG5rV5jJPGl1OTRSdvNs5SfZ0BbZ4EJZmxr77nDPI\n-----END PRIVATE KEY-----\n';

/** A second, never-admitted attester keypair — for "signed by an unadmitted attester" tests. */
export const unadmittedAttesterPrivateKeyPem =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA1D7Q4yQvV3z0y2m2u1x3n4M8xkQwYyMv1n0F9c6qzu\n-----END PRIVATE KEY-----\n';

function attesterPublicKeyDerHex(privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('hex');
}

export const testAttesterPublicKeyDerHex = attesterPublicKeyDerHex(TEST_ATTESTER_PRIVATE_KEY_PEM);

/** `resolveAdmittedAttesterKeys`-compatible set admitting only the test attester's key. */
export const testAdmittedAttesterKeys = resolveAdmittedAttesterKeys({ admittedKeys: new Set([testAttesterPublicKeyDerHex]) });

interface RadioMoeCanonicalModule {
  canonicalBytes(value: unknown): Buffer;
}

/** Real `radio-moe` `canonicalBytes` (a real devDependency, not reimplemented) — loaded the exact same required-not-optional dynamic-import way the src modules load it. */
async function loadCanonicalBytes(): Promise<(value: unknown) => Buffer> {
  const mod = (await import('radio-moe')) as unknown as RadioMoeCanonicalModule;
  return mod.canonicalBytes;
}

/**
 * Mints a real, validly-signed `HumanIdentityAttestation` using the given
 * attester private key (defaults to the admitted test attester). `humanIdentityRef`
 * defaults to `member.identityRef` — pass an explicit value to construct a
 * deliberately mismatched attestation for the identity-binding tests.
 * Mirrors `credential-issuer.ts`'s own reproduction of radio-moe's real
 * `signFrame` contract: sign `canonicalBytes({...frame, signature: ''})`.
 */
export async function humanAttestationFor(
  member: Pick<OrgMember, 'id' | 'companyId' | 'identityRef'>,
  opts?: { ttlSeconds?: number; humanIdentityRef?: string; attesterPrivateKeyPem?: string },
): Promise<HumanIdentityAttestation> {
  const privateKey = createPrivateKey(opts?.attesterPrivateKeyPem ?? TEST_ATTESTER_PRIVATE_KEY_PEM);
  const attesterKeyDerHex = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('hex');
  const canonicalBytes = await loadCanonicalBytes();

  const now = new Date();
  const ttlSeconds = opts?.ttlSeconds ?? 15 * 60;
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const nonce = randomUUID();
  const humanIdentityRef = opts?.humanIdentityRef ?? member.identityRef;

  const unsignedFields = { orgMemberId: member.id, companyId: member.companyId, humanIdentityRef, issuedAt, expiresAt, nonce };
  const signingBytes = canonicalBytes({ ...attestationFrame(unsignedFields), signature: '' });
  const signature = edSign(null, signingBytes, privateKey).toString('hex');
  return { ...unsignedFields, signature, attesterPublicKeyDerHex: attesterKeyDerHex };
}

/**
 * Mints a real `ActorCredential` for `member` via the full attestation ->
 * mint pipeline (`mintHumanActorCredential`), using the test attester and
 * test issuer keys. This is the ONLY fixture helper that produces a
 * credential carrying the human-attestation provenance marker — a
 * credential from `credentialFor(humanMember)` above does NOT carry it
 * (mirrors production: only `mintHumanActorCredential` ever writes that
 * marker).
 */
export async function humanCredentialFor(
  member: OrgMember,
  config: AgentDbAdapterConfig,
  opts?: { ttlSeconds?: number },
): Promise<ActorAuthorization> {
  const attestation = await humanAttestationFor(member, opts);
  const credential = await mintHumanActorCredential(attestation, testAdmittedAttesterKeys, opts, testIssuerConfig, config);
  const admittedIssuerKeys = await resolveAdmittedIssuerKeys(testIssuerConfig);
  return { credential, admittedIssuerKeys };
}

/**
 * In-memory `memory_retrieve`/`memory_store` handlers for the
 * `ruclip-actor-credentials` nonce namespace — merge into `mockBridge`'s
 * handler map. A fresh `Map` per call keeps tests isolated from each other.
 *
 * `memory_store` mirrors the real backend's `UNIQUE(namespace, key)`
 * constraint (`memory-initializer.js`'s `memory_entries` schema): a call
 * that passes `upsert: false` against an already-occupied key fails instead
 * of overwriting it, exactly like the real `INSERT` (no `OR REPLACE`) SQL
 * the real tool runs in that mode. Callers that omit `upsert` (or pass
 * `true`) keep the old always-succeeds behavior.
 */
export function nonceMockHandlers(): Record<string, (args: Record<string, unknown>) => unknown> {
  const store = new Map<string, boolean>();
  return {
    memory_retrieve: (args) => ({ found: store.has(args.key as string) }),
    memory_store: (args) => {
      const key = args.key as string;
      if (args.upsert === false && store.has(key)) {
        return { success: false, error: 'UNIQUE constraint failed: memory_entries.namespace, memory_entries.key' };
      }
      store.set(key, true);
      return { success: true };
    },
  };
}

/**
 * Same contract as `nonceMockHandlers`, plus a deterministic barrier on
 * `memory_retrieve`: every caller blocks there until exactly `concurrency`
 * callers have arrived, then all proceed together. Reproduces the
 * worst-case interleaving of a check-then-act race — every concurrent
 * caller observes the nonce as unused before any of them writes it — as a
 * repeatable, non-flaky test rather than hoping the event loop happens to
 * interleave that way. `memory_store` is deliberately NOT gated: a
 * synchronous check-and-set has no `await` in between for another caller to
 * interleave through, which is exactly the atomicity the real
 * `UNIQUE(namespace, key)` constraint (serialized by the real backend's own
 * per-file write lock) provides in production.
 */
export function racingNonceMockHandlers(concurrency: number): Record<string, (args: Record<string, unknown>) => unknown> {
  const store = new Map<string, boolean>();
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    memory_retrieve: async (args) => {
      arrived += 1;
      if (arrived >= concurrency) release();
      await gate;
      return { found: store.has(args.key as string) };
    },
    memory_store: (args) => {
      const key = args.key as string;
      if (args.upsert === false && store.has(key)) {
        return { success: false, error: 'UNIQUE constraint failed: memory_entries.namespace, memory_entries.key' };
      }
      store.set(key, true);
      return { success: true };
    },
  };
}
