/**
 * Human-issuance path for `ActorCredential` (ACTOR-IDENTITY-VERIFICATION.md
 * §4's named gap, closed here per `docs/design/HUMAN-CREDENTIAL-ISSUANCE.md`)
 * — the missing half of `credential-issuer.ts`'s agent-issuance path.
 *
 * ruClip is ruvnet-only at the substrate (root `CLAUDE.md`, `package.json`'s
 * own description) — this module imports no Slack SDK, no Firebase, no
 * Cognitum-specific code. It defines one contract instead:
 * `HumanIdentityAttestation`, a short-lived, signed statement that SOME
 * outside system — one that already knows a human is verified — hands to
 * ruClip. ruClip only ever verifies that statement's signature against a
 * caller-supplied, pluggable set of admitted attester keys (mirroring
 * `credential-issuer.ts`'s own `resolveAdmittedIssuerKeys`); it never learns
 * or cares HOW the attester verified the human (Slack OAuth, SSO, a
 * dashboard session — Phase 2's concern, not this module's).
 *
 * Concretely, the intended attester for Cognitum's own deployment is the
 * `cognitum-one/slack` agent's identity resolution (ADR-0002 "Identity &
 * per-user capabilities", ADR-0015 "identity resolution is a single
 * point"): a Slack `user_id` (e.g. `U0BQJNHH7L3`) resolved, server-side, via
 * a verified `@cognitum.one` mailbox to an `Employee` role. That resolution
 * already happens entirely inside `cognitum-one/slack`'s own process; this
 * module does not reach into it or reimplement it — it only defines the
 * shape of the artifact that resolution would need to produce and hand to
 * ruClip, and how ruClip verifies it. `OrgMember.identityRef`
 * (`schema/org-member.ts`: "For kind: 'human' — a claims/BBS identity
 * string") is exactly where that Slack user id (or equivalent verified
 * human identity string) is expected to live for a `kind: 'human'`
 * OrgMember — this module cross-checks the attestation's own asserted
 * identity against that field before minting anything (see
 * `mintHumanActorCredential` below).
 *
 * `cognitum-one/comms`'s ADR-0009 ("Cognitum-verified AgentBBS identity") is
 * real prior art for the SHAPE of this problem — Ed25519 signing, a
 * Secret-Manager-held seed, a single-use nonce — but its actual byte
 * contract (agentbbs-core's own `Credential` type, a domain tag +
 * length-prefixed frame) is a DIFFERENT wire format for a DIFFERENT purpose
 * (AgentBBS room identity, not a ruClip `ActorCredential`). This module does
 * NOT reuse that contract directly — doing so would repeat exactly the
 * mistake ACTOR-IDENTITY-VERIFICATION.md §4 already flagged once for
 * `federation_bbs_human_join`'s token (a real primitive forced into a job
 * its real scope doesn't cover). It reuses only the same STRATEGY —
 * Ed25519 + durable key + single-use nonce — via this repo's own already-
 * established `radio-moe` `AgentFrame`/`canonicalBytes`/`verifyFrame`
 * primitive (the exact same one `actor-credential.ts` and
 * `credential-issuer.ts` already use), same discipline as the rest of this
 * slice: reuse the real primitive already proven in this codebase, don't
 * invent or borrow a second one.
 */
import { randomUUID } from 'node:crypto';
import {
  actorCredentialFrame,
  ActorIdentityVerificationError,
  humanAttestedCredentialMarkerKey,
  HUMAN_ATTESTED_NAMESPACE,
  type ActorCredential,
} from './actor-credential.js';
import { mintActorCredential, type IssuerKeyConfig } from './credential-issuer.js';
import { recallOrgMember, type AgentDbAdapterConfig } from '../store/agentdb-adapter.js';
import { assertSafeId, callTool } from '../store/bridge-client.js';

const DEFAULT_TTL_SECONDS = 15 * 60; // matches ActorCredential's own default (§1) and federation_bbs_human_join's

/**
 * A short-lived, signed statement from an external attester: "the human
 * behind `humanIdentityRef` is who they claim to be, and controls
 * `orgMemberId` in `companyId`." ruClip never produces one of these itself
 * — `mintHumanActorCredential` below only ever CONSUMES an already-signed
 * attestation handed to it by the calling environment.
 */
export interface HumanIdentityAttestation {
  orgMemberId: string;
  companyId: string;
  /**
   * The verified human identity this attestation vouches for — e.g. a
   * Cognitum Slack user id such as `slack:U0BQJNHH7L3`, resolved via a
   * verified `@cognitum.one` mailbox (`cognitum-one/slack` ADR-0002/
   * ADR-0015). MUST equal the target OrgMember's own `identityRef`
   * (`schema/org-member.ts`) — checked in `mintHumanActorCredential`, not
   * here, since that check needs the persisted OrgMember record.
   */
  humanIdentityRef: string;
  /** ISO 8601. */
  issuedAt: string;
  /** ISO 8601 — short TTL, default 15 min (matches ActorCredential's own default). */
  expiresAt: string;
  /** Single-use replay guard — separate namespace from ActorCredential's own nonce (see the replay-guard note below). */
  nonce: string;
  /** radio-moe `signFrame()` signature (hex) over `attestationFrame(attestation)`. */
  signature: string;
  /** Which attester key produced `signature` — checked against `admittedAttesterKeys` before the signature itself is trusted, same discipline as `ActorCredential.issuerPublicKeyDerHex` (§2 of ACTOR-IDENTITY-VERIFICATION.md). */
  attesterPublicKeyDerHex: string;
}

/**
 * The exact frame shape signed/verified for a `HumanIdentityAttestation` —
 * mirrors `actorCredentialFrame`'s own discipline (kept in one place so
 * signing, done by whatever external attester produces one of these, and
 * verification here can never drift apart). Uses `kind: 'claim'` (radio-moe's
 * real, closed `FrameKind` union — confirmed by reading `dist/agent-frame.d.ts`
 * directly, same as `actorCredentialFrame`'s own comment) with a distinct
 * `capabilityUsed` so a `HumanIdentityAttestation` frame and an
 * `ActorCredential` frame can never be confused for one another even though
 * both use `kind: 'claim'`.
 */
export function attestationFrame(
  attestation: Pick<
    HumanIdentityAttestation,
    'orgMemberId' | 'companyId' | 'humanIdentityRef' | 'issuedAt' | 'expiresAt' | 'nonce'
  >,
): Record<string, unknown> {
  return {
    requestId: attestation.nonce,
    agentId: 'ruclip-human-attester',
    step: 0,
    kind: 'claim',
    value: {
      orgMemberId: attestation.orgMemberId,
      companyId: attestation.companyId,
      humanIdentityRef: attestation.humanIdentityRef,
      issuedAt: attestation.issuedAt,
      expiresAt: attestation.expiresAt,
    },
    confidence: 1,
    uncertainty: 0,
    dependencies: [],
    capabilityUsed: 'ruclip.human-identity-attestation',
    evidenceHashes: [],
    cost: 0,
  };
}

interface RadioMoeVerifyModule {
  verifyFrame(frame: Record<string, unknown>, publicKeyDerHex: string): boolean;
}

/** Required, not optional — same fail-closed posture as actor-credential.ts's own loader. */
async function loadRadioMoeRequired(): Promise<RadioMoeVerifyModule> {
  try {
    return (await import('radio-moe')) as unknown as RadioMoeVerifyModule;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (
      e?.code === 'ERR_MODULE_NOT_FOUND' ||
      e?.code === 'MODULE_NOT_FOUND' ||
      /Cannot find (module|package)/i.test(String(e?.message))
    ) {
      throw new ActorIdentityVerificationError(
        'radio-moe is required to verify a HumanIdentityAttestation but is not installed — refusing to mint a ' +
          'human ActorCredential rather than silently trusting an unverified attestation',
      );
    }
    throw err;
  }
}

/** Deliberately separate from every other AgentDB/memory namespace this repo uses (mirrors NONCE_NAMESPACE's own rationale in actor-credential.ts §3). */
const ATTESTATION_NONCE_NAMESPACE = 'ruclip-human-identity-attestations';

function attestationNonceKey(companyId: string, nonce: string): string {
  return `ruclip:company:${companyId}:human-attestation-nonce:${nonce}`;
}

/**
 * The admitted set of external attester public keys — pluggable, mirroring
 * `credential-issuer.ts`'s `resolveAdmittedIssuerKeys`, but deliberately a
 * DIFFERENT mechanism: ruClip's own durable issuer keypair is something
 * THIS repo mints credentials with (GCP Secret Manager, `credential-issuer.ts`);
 * an attester keypair belongs to an EXTERNAL system (e.g. a Cognitum
 * identity-attestation service) that ruClip never holds the private half
 * of — ruClip only ever needs the public key(s) it's willing to trust. The
 * primary mechanism is therefore an explicit, caller-supplied set (whatever
 * wires up a specific deployment passes the keys it trusts); a
 * comma-separated env-var fallback is provided for convenience/ops, not as
 * a second secret-manager integration.
 */
export interface AttesterKeyConfig {
  /** The primary, pluggable mechanism — pass the admitted attester public key(s) (DER SPKI, hex) directly. */
  admittedKeys?: ReadonlySet<string>;
  /** Overrides which env var `resolveAdmittedAttesterKeys` reads when `admittedKeys` is omitted. Defaults to RUCLIP_HUMAN_ATTESTER_KEYS. */
  keysEnvVar?: string;
}

/**
 * Resolves the admitted attester key set. Prefers an explicit
 * `config.admittedKeys` (the pluggable mechanism a real deployment should
 * use); falls back to parsing a comma-separated list of DER SPKI hex keys
 * from an env var (default `RUCLIP_HUMAN_ATTESTER_KEYS`) for convenience.
 * Throws — fails closed, same posture as every other part of this
 * mechanism — rather than returning an empty set, which would make every
 * attestation vacuously fail the membership check with a confusing error
 * far from its real cause.
 */
export function resolveAdmittedAttesterKeys(config?: AttesterKeyConfig): ReadonlySet<string> {
  if (config?.admittedKeys) {
    if (config.admittedKeys.size === 0) {
      throw new ActorIdentityVerificationError('resolveAdmittedAttesterKeys: config.admittedKeys is empty');
    }
    return config.admittedKeys;
  }
  const envVarName = config?.keysEnvVar ?? 'RUCLIP_HUMAN_ATTESTER_KEYS';
  const raw = process.env[envVarName];
  const keys = (raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    throw new ActorIdentityVerificationError(
      `No admitted human-identity attester keys configured: pass config.admittedKeys explicitly (the primary, ` +
        `pluggable mechanism — see this file's header), or set ${envVarName} to a comma-separated list of DER ` +
        'SPKI hex public keys',
    );
  }
  return new Set(keys);
}

/**
 * Verifies `attestation`, in order, throwing `ActorIdentityVerificationError`
 * on the first failure, before any AgentDB write — mirrors
 * `verifyActorCredential`'s own structure exactly (ACTOR-IDENTITY-
 * VERIFICATION.md §2):
 *
 * 1. `expiresAt` must be in the future.
 * 2. `attesterPublicKeyDerHex` must be a member of `admittedAttesterKeys` —
 *    an unrecognized attester is rejected even if the signature over it
 *    verifies internally consistently.
 * 3. `radio-moe`'s real `verifyFrame` must return true.
 * 4. Replay check: the attestation's own nonce must not have been consumed
 *    before (separate namespace/key from `ActorCredential`'s own nonce
 *    guard — an attestation and the credential it mints are two different
 *    single-use artifacts).
 *
 * Returns `{orgMemberId, companyId, humanIdentityRef}` — the caller
 * (`mintHumanActorCredential`) is responsible for cross-checking
 * `humanIdentityRef` against the persisted OrgMember record before minting
 * anything; this function only establishes that the attestation itself is
 * genuine and unreplayed.
 */
export async function verifyHumanIdentityAttestation(
  attestation: HumanIdentityAttestation,
  admittedAttesterKeys: ReadonlySet<string>,
  config?: AgentDbAdapterConfig,
): Promise<{ orgMemberId: string; companyId: string; humanIdentityRef: string }> {
  assertSafeId(attestation.orgMemberId, 'attestation.orgMemberId');
  assertSafeId(attestation.companyId, 'attestation.companyId');
  assertSafeId(attestation.nonce, 'attestation.nonce');

  if (Date.parse(attestation.expiresAt) <= Date.now()) {
    throw new ActorIdentityVerificationError(
      `HumanIdentityAttestation for '${attestation.orgMemberId}' expired at ${attestation.expiresAt}`,
    );
  }
  if (!admittedAttesterKeys.has(attestation.attesterPublicKeyDerHex)) {
    throw new ActorIdentityVerificationError(
      `HumanIdentityAttestation for '${attestation.orgMemberId}' was signed by an attester key that is not ` +
        'admitted — a validly-signed attestation from an unrecognized attester is still rejected',
    );
  }

  const radioMoe = await loadRadioMoeRequired();
  const frame = { ...attestationFrame(attestation), signature: attestation.signature };
  if (!radioMoe.verifyFrame(frame, attestation.attesterPublicKeyDerHex)) {
    throw new ActorIdentityVerificationError(
      `HumanIdentityAttestation for '${attestation.orgMemberId}' failed signature verification`,
    );
  }

  const nonceKey = attestationNonceKey(attestation.companyId, attestation.nonce);
  const existing = await callTool<{ found?: boolean }>(
    'memory_retrieve',
    { key: nonceKey, namespace: ATTESTATION_NONCE_NAMESPACE },
    config,
  );
  if (existing.found) {
    throw new ActorIdentityVerificationError(
      `HumanIdentityAttestation for '${attestation.orgMemberId}' was already used (nonce replay)`,
    );
  }
  const ttlSeconds = Math.max(1, Math.ceil((Date.parse(attestation.expiresAt) - Date.now()) / 1000));
  await callTool(
    'memory_store',
    { key: nonceKey, value: true, ttl: ttlSeconds, namespace: ATTESTATION_NONCE_NAMESPACE },
    config,
  );

  return { orgMemberId: attestation.orgMemberId, companyId: attestation.companyId, humanIdentityRef: attestation.humanIdentityRef };
}

/**
 * The one function that "turns a verified attestation into a mint" (per the
 * design brief): verifies `attestation` (consuming its nonce — see
 * `verifyHumanIdentityAttestation`'s own single-use note), recalls the
 * target OrgMember fresh from AgentDB (never trusts anything about identity
 * beyond what `verifyHumanIdentityAttestation` itself established), and
 * only then mints a real, signed `ActorCredential` via `credential-issuer.ts`'s
 * `mintActorCredential` — the exact same durable-issuer-key signing path
 * agent issuance already uses. Immediately after minting, writes the
 * AgentDB provenance marker `resolveVerifiedActor` (`actor-credential.ts`)
 * requires before it will authorize a `kind: 'human'` actor — this is the
 * ONLY function in this codebase that ever writes that marker.
 *
 * Rejects, before minting anything:
 * - the target OrgMember does not exist (no such `orgMemberId` in `companyId`);
 * - the target OrgMember's `kind` is not `'human'` — this issuance path is
 *   human-only by design (agents already have a real event to chain trust
 *   off — `claims_accept-handoff`, §4 — and don't get interactively
 *   attested);
 * - the target OrgMember's own persisted `identityRef` does not equal the
 *   attestation's `humanIdentityRef` — the binding check that stops an
 *   attestation genuinely proving identity X from minting a credential for
 *   an OrgMember record actually bound to a different identity Y (whether
 *   through attacker tampering — already caught by signature verification
 *   above — or a desynced/misconfigured OrgMember record).
 *
 * IMPORTANT — same single-use caveat as `verifyActorCredential`: call this
 * at most once per `HumanIdentityAttestation`; its nonce is consumed on the
 * first call.
 */
export async function mintHumanActorCredential(
  attestation: HumanIdentityAttestation,
  admittedAttesterKeys: ReadonlySet<string>,
  opts?: { ttlSeconds?: number },
  issuerConfig?: IssuerKeyConfig,
  config?: AgentDbAdapterConfig,
): Promise<ActorCredential> {
  const { orgMemberId, companyId, humanIdentityRef } = await verifyHumanIdentityAttestation(
    attestation,
    admittedAttesterKeys,
    config,
  );

  const target = await recallOrgMember(companyId, orgMemberId, config);
  if (!target) {
    throw new ActorIdentityVerificationError(
      `Verified HumanIdentityAttestation names OrgMember '${orgMemberId}' in company '${companyId}' but no such ` +
        'OrgMember is persisted',
    );
  }
  if (target.kind !== 'human') {
    throw new ActorIdentityVerificationError(
      `mintHumanActorCredential: OrgMember '${orgMemberId}' has kind '${target.kind}', not 'human' — this ` +
        'issuance path mints credentials for human actors only',
    );
  }
  if (target.identityRef !== humanIdentityRef) {
    throw new ActorIdentityVerificationError(
      `mintHumanActorCredential: attestation asserts human identity '${humanIdentityRef}' but OrgMember ` +
        `'${orgMemberId}' is persisted with identityRef '${target.identityRef}' — refusing to mint a credential ` +
        'for a mismatched identity',
    );
  }

  const credential = await mintActorCredential(orgMemberId, companyId, opts ?? { ttlSeconds: DEFAULT_TTL_SECONDS }, issuerConfig);

  await callTool(
    'memory_store',
    {
      key: humanAttestedCredentialMarkerKey(companyId, credential.nonce),
      value: true,
      ttl: Math.max(1, Math.ceil((Date.parse(credential.expiresAt) - Date.now()) / 1000)),
      namespace: HUMAN_ATTESTED_NAMESPACE,
    },
    config,
  );

  return credential;
}

/** Convenience re-export so a caller wiring up a fresh attestation doesn't need a second `randomUUID` import. */
export function generateAttestationNonce(): string {
  return randomUUID();
}
