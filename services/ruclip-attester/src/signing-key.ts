/**
 * `ruclip-attester`'s OWN durable Ed25519 signing keypair
 * (HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md §2) — structurally distinct from
 * ruClip's own issuer key (`credential-issuer.ts`'s
 * `RUCLIP_ISSUER_SIGNING_SECRET`): these are two different trust roles
 * (an external attester vouching for a human's identity, vs. ruClip's own
 * issuer minting a credential from an already-verified event) and must
 * never share a key or a secret.
 *
 * Same real `radio-moe` signing-contract reproduction as
 * `credential-issuer.ts` (`PeerIdentity` cannot be reconstructed from a
 * stored key — see that file's own header for the full finding; this
 * signs directly via `node:crypto` against a durably-stored keypair,
 * reproducing `signFrame`'s exact byte contract via `radio-moe`'s own
 * exported `canonicalBytes`, so verification via real `radio-moe`
 * `verifyFrame` on the consumer side is completely untouched).
 *
 * **Real-behavior correction from LIVE deployment testing (2026-09-02,
 * this session)**: originally read the secret by shelling out to the
 * `gcloud` CLI, mirroring `credential-issuer.ts`'s own discipline —
 * confirmed via the real deployed service's own Cloud Run logs that this
 * fails with `spawn gcloud ENOENT`, because the `node:20-slim` container
 * has no `gcloud` CLI at all. See `identity-map.ts`'s own header for the
 * full finding (same root cause, same fix): a server-side Cloud Run
 * process reads its own secrets via the official
 * `@google-cloud/secret-manager` client library (Application Default
 * Credentials — the service's own runtime service account, automatically),
 * not by shelling out to a CLI that only exists in interactive/CI
 * environments. Still: never logged, never persisted to disk.
 */
import { randomUUID, createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { attestationFrame, type HumanIdentityAttestation } from '../../../src/control-plane/authorization/human-identity-attestation.js';

let secretManagerClient: SecretManagerServiceClient | null = null;
function getSecretManagerClient(): SecretManagerServiceClient {
  secretManagerClient ??= new SecretManagerServiceClient();
  return secretManagerClient;
}

const DEFAULT_TTL_SECONDS = 15 * 60; // matches HumanIdentityAttestation's own default (HUMAN-CREDENTIAL-ISSUANCE.md)

export interface AttesterSigningKeyConfig {
  /** Test/dev-only escape hatch — a PKCS8 PEM Ed25519 private key, bypassing the GCP Secret Manager client entirely. Never logged. */
  privateKeyPem?: string;
  /** Overrides RUCLIP_ATTESTER_SIGNING_SECRET. */
  secretName?: string;
  /** Overrides RUCLIP_ATTESTER_SIGNING_PROJECT. */
  secretProject?: string;
}

async function resolvePrivateKeyPem(config?: AttesterSigningKeyConfig): Promise<string> {
  if (config?.privateKeyPem) return config.privateKeyPem;

  const secretName = config?.secretName ?? process.env.RUCLIP_ATTESTER_SIGNING_SECRET;
  const secretProject = config?.secretProject ?? process.env.RUCLIP_ATTESTER_SIGNING_PROJECT;
  if (!secretName || !secretProject) {
    throw new Error(
      'No attester signing key available: pass config.privateKeyPem for tests/dev, or set both ' +
        'RUCLIP_ATTESTER_SIGNING_SECRET and RUCLIP_ATTESTER_SIGNING_PROJECT to a provisioned GCP Secret Manager ' +
        'secret — provisioning that secret is a deployment step outside this code',
    );
  }
  try {
    const [response] = await getSecretManagerClient().accessSecretVersion({
      name: `projects/${secretProject}/secrets/${secretName}/versions/latest`,
    });
    const data = response.payload?.data;
    if (data === undefined || data === null) {
      throw new Error('Secret Manager returned no payload data');
    }
    return Buffer.from(data).toString('utf8').trim();
  } catch (err) {
    throw new Error(
      `Failed to read the attester signing key from GCP Secret Manager (secret '${secretName}', project ` +
        `'${secretProject}') — is the service's own runtime service account granted access, and is the secret ` +
        'provisioned?',
      { cause: err },
    );
  }
}

interface AttesterKeypair {
  privateKey: KeyObject;
  publicKeyDerHex: string;
}

async function loadAttesterKeypair(config?: AttesterSigningKeyConfig): Promise<AttesterKeypair> {
  const pem = await resolvePrivateKeyPem(config);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (err) {
    throw new Error('Attester signing key is not a valid PEM-encoded private key (expected PKCS8 Ed25519)', {
      cause: err,
    });
  }
  const publicKeyDerHex = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('hex');
  return { privateKey, publicKeyDerHex };
}

interface RadioMoeCanonicalModule {
  canonicalBytes(value: unknown): Buffer;
}

/** Required, not optional — same fail-closed posture as credential-issuer.ts's own loader. */
async function loadRadioMoeCanonicalBytes(): Promise<(value: unknown) => Buffer> {
  try {
    const mod = (await import('radio-moe')) as unknown as RadioMoeCanonicalModule;
    return mod.canonicalBytes;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (
      e?.code === 'ERR_MODULE_NOT_FOUND' ||
      e?.code === 'MODULE_NOT_FOUND' ||
      /Cannot find (module|package)/i.test(String(e?.message))
    ) {
      throw new Error('radio-moe is required to mint a HumanIdentityAttestation but is not installed');
    }
    throw err;
  }
}

/**
 * Mints and signs a fresh `HumanIdentityAttestation`. Pure signing — does
 * not itself decide who to attest for; the caller (the `/v1/attest`
 * handler) is responsible for having already resolved `orgMemberId`/
 * `companyId`/`humanIdentityRef` from a verified Google identity via the
 * identity-mapping lookup.
 */
export async function mintHumanIdentityAttestation(
  orgMemberId: string,
  companyId: string,
  humanIdentityRef: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  config?: AttesterSigningKeyConfig,
): Promise<HumanIdentityAttestation> {
  const { privateKey, publicKeyDerHex } = await loadAttesterKeypair(config);
  const canonicalBytes = await loadRadioMoeCanonicalBytes();

  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const nonce = randomUUID();

  const unsignedFields = { orgMemberId, companyId, humanIdentityRef, issuedAt, expiresAt, nonce };
  // Reproduces radio-moe's real signFrame contract exactly — see file header.
  const signingBytes = canonicalBytes({ ...attestationFrame(unsignedFields), signature: '' });
  const signature = edSign(null, signingBytes, privateKey).toString('hex');

  return { ...unsignedFields, signature, attesterPublicKeyDerHex: publicKeyDerHex };
}

/** The attester's durable public key — safe to distribute broadly (matches `resolveIssuerPublicKeyDerHex`'s own posture in credential-issuer.ts). Consumers set RUCLIP_HUMAN_ATTESTER_KEYS to this value. */
export async function resolveAttesterPublicKeyDerHex(config?: AttesterSigningKeyConfig): Promise<string> {
  const { publicKeyDerHex } = await loadAttesterKeypair(config);
  return publicKeyDerHex;
}
