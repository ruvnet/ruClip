/**
 * Agent-issuance path for ActorCredential (ACTOR-IDENTITY-VERIFICATION.md
 * §4) — the only module in this codebase that ever holds signing
 * capability. Every verifying function only ever needs the resulting
 * PUBLIC key (`resolveIssuerPublicKeyDerHex` below), which is safe to
 * embed/distribute broadly.
 *
 * Real-behavior correction, found by reading `radio-moe`'s actual
 * `dist/transport.js`/`dist/agent-frame.js` (not just the `.d.ts`) before
 * implementing the design's literal "construct a PeerIdentity from the
 * GCP-Secret-Manager-stored private key" premise: `PeerIdentity` has a
 * `private constructor()` — its ONLY public construction path is the
 * static `PeerIdentity.generate()`, which always mints a brand-new
 * in-process keypair. There is no way to reconstruct a `PeerIdentity` from
 * a previously-generated, externally-stored private key. Confirmed by
 * reading the compiled source, not just the type declarations.
 *
 * This does NOT make the durable-issuer-keypair design unachievable — it
 * changes HOW issuance signs, not whether a durable keypair can work.
 * `dist/transport.js`/`dist/agent-frame.js` show `PeerIdentity.sign()` and
 * `signFrame`/`verifyFrame` are thin wrappers over plain Node `node:crypto`
 * Ed25519: `sign(null, canonicalBytes({...frame, signature: ''}), key)` /
 * `verify(null, ..., {key: der, format:'der', type:'spki'}, sig)`, using
 * the exact DER SPKI key encoding `generateKeyPairSync('ed25519', {...})`
 * already produces. So this module signs directly with `node:crypto`
 * against a durably-stored keypair, reproducing `signFrame`'s exact
 * byte-for-byte contract via `radio-moe`'s own EXPORTED `canonicalBytes`
 * (`actorCredentialFrame` in `actor-credential.ts` is the shared,
 * single-sourced frame shape both sides use, so signing and verification
 * can never drift apart). The resulting signature verifies successfully
 * against real `radio-moe` `verifyFrame` on every verifying caller —
 * verification is completely untouched, real `radio-moe` code end to end.
 * Only issuance needed a different mechanism than `PeerIdentity.generate()`
 * offers.
 *
 * GCP Secret Manager key handling follows root `CLAUDE.md`'s documented
 * discipline for this exact class of secret (the npm publish signing key):
 * the private key is never logged, never persisted to disk by this module,
 * and is read transiently by shelling out to `gcloud secrets versions
 * access` (via `execFile` with an argument array — never a shell string —
 * to rule out injection) directly into this process's memory. No specific
 * secret name/project is hardcoded here — provisioning the actual GCP
 * secret is a deployment-time step outside this code slice (ruClip has no
 * live GCP project of its own yet — ADR-0001 §9). `RUCLIP_ISSUER_SIGNING_SECRET`
 * / `RUCLIP_ISSUER_SIGNING_PROJECT` name which secret/project to read; a
 * test/dev-only `privateKeyPem` override bypasses the shell-out entirely
 * (never sourced from an env var directly — always passed explicitly by
 * the caller, so it can never be accidentally picked up from a stray
 * environment variable in a real deployment).
 */
import { randomUUID, createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { actorCredentialFrame, ActorIdentityVerificationError, type ActorCredential } from './actor-credential.js';
import { assertSafeId } from '../store/bridge-client.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TTL_SECONDS = 15 * 60; // matches federation_bbs_human_join's own default (§1)

export interface IssuerKeyConfig {
  /** Test/dev-only escape hatch — a PKCS8 PEM Ed25519 private key, bypassing the GCP Secret Manager shell-out entirely. Never logged. */
  privateKeyPem?: string;
  /** Overrides RUCLIP_ISSUER_SIGNING_SECRET. */
  secretName?: string;
  /** Overrides RUCLIP_ISSUER_SIGNING_PROJECT. */
  secretProject?: string;
}

async function resolvePrivateKeyPem(issuerConfig?: IssuerKeyConfig): Promise<string> {
  if (issuerConfig?.privateKeyPem) return issuerConfig.privateKeyPem;

  const secretName = issuerConfig?.secretName ?? process.env.RUCLIP_ISSUER_SIGNING_SECRET;
  const secretProject = issuerConfig?.secretProject ?? process.env.RUCLIP_ISSUER_SIGNING_PROJECT;
  if (!secretName || !secretProject) {
    throw new ActorIdentityVerificationError(
      'No issuer signing key available: pass issuerConfig.privateKeyPem for tests/dev, or set both ' +
        'RUCLIP_ISSUER_SIGNING_SECRET and RUCLIP_ISSUER_SIGNING_PROJECT to a provisioned GCP Secret Manager ' +
        "secret (root CLAUDE.md's documented pattern) — provisioning that secret is a deployment step outside " +
        'this code slice',
    );
  }
  try {
    // Argument array (never a shell string) — rules out command injection
    // from secretName/secretProject. Captured directly from stdout, never
    // written to a temp file, never logged.
    const { stdout } = await execFileAsync('gcloud', [
      'secrets',
      'versions',
      'access',
      'latest',
      `--secret=${secretName}`,
      `--project=${secretProject}`,
    ]);
    return stdout.trim();
  } catch (err) {
    throw new ActorIdentityVerificationError(
      `Failed to read the issuer signing key from GCP Secret Manager (secret '${secretName}', project ` +
        `'${secretProject}') — is gcloud authenticated and the secret provisioned?`,
      err,
    );
  }
}

interface IssuerKeypair {
  privateKey: KeyObject;
  publicKeyDerHex: string;
}

async function loadIssuerKeypair(issuerConfig?: IssuerKeyConfig): Promise<IssuerKeypair> {
  const pem = await resolvePrivateKeyPem(issuerConfig);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (err) {
    throw new ActorIdentityVerificationError(
      'Issuer signing key is not a valid PEM-encoded private key (expected PKCS8 Ed25519)',
      err,
    );
  }
  const publicKeyDerHex = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('hex');
  return { privateKey, publicKeyDerHex };
}

interface RadioMoeCanonicalModule {
  canonicalBytes(value: unknown): Buffer;
}

/** Required, not optional — same posture as actor-credential.ts's verify-side loader (see file header). */
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
      throw new ActorIdentityVerificationError(
        'radio-moe is required to mint an ActorCredential but is not installed',
      );
    }
    throw err;
  }
}

/**
 * Mints a fresh, signed `ActorCredential` for `orgMemberId`. Pure signing —
 * does not touch the AgentDB bridge and does not itself check that
 * `orgMemberId` exists or holds any claim; the caller is responsible for
 * only minting a credential for an identity it has already established by
 * some other real means (e.g. a `claims_accept-handoff` success — see this
 * file's header and `docs/PLAN.md` §8 for why that chaining is implemented
 * as an explicit caller responsibility rather than nested inside
 * `applyApprovalTransition` itself).
 */
export async function mintActorCredential(
  orgMemberId: string,
  companyId: string,
  opts?: { ttlSeconds?: number },
  issuerConfig?: IssuerKeyConfig,
): Promise<ActorCredential> {
  assertSafeId(orgMemberId, 'orgMemberId');
  assertSafeId(companyId, 'companyId');

  const { privateKey, publicKeyDerHex } = await loadIssuerKeypair(issuerConfig);
  const canonicalBytes = await loadRadioMoeCanonicalBytes();

  const now = new Date();
  const ttlSeconds = opts?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const nonce = randomUUID();

  const unsignedFields = { orgMemberId, companyId, issuedAt, expiresAt, nonce };
  // Reproduces radio-moe's real signFrame contract exactly: sign
  // canonicalBytes({...frame, signature: ''}) — see this file's header.
  const signingBytes = canonicalBytes({ ...actorCredentialFrame(unsignedFields), signature: '' });
  const signature = edSign(null, signingBytes, privateKey).toString('hex');

  return { ...unsignedFields, signature, issuerPublicKeyDerHex: publicKeyDerHex };
}

/**
 * The durable issuer's public key, as a one-element `admittedIssuerKeys`
 * set — today there is exactly one trusted issuer (this module). Callers
 * resolve this once (it requires the same GCP Secret Manager round trip as
 * minting) and reuse the resulting `Set` across many `verifyActorCredential`
 * calls, rather than re-resolving per verification.
 */
export async function resolveAdmittedIssuerKeys(issuerConfig?: IssuerKeyConfig): Promise<ReadonlySet<string>> {
  const { publicKeyDerHex } = await loadIssuerKeypair(issuerConfig);
  return new Set([publicKeyDerHex]);
}
