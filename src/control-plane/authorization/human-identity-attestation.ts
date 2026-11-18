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
  /**
   * Version 2 (HUMAN-CREDENTIAL-ISSUANCE.md §6) — absent means version 1.
   * Only when this is exactly 2 are `audience`, `purpose` and `assurance`
   * covered by the signature; a version 1 attestation carrying any of them
   * is rejected, because those fields would be unsigned.
   */
  version?: 2;
  /** v2: which verifier this attestation is for (e.g. one runtime, or one company's leader). Checked against `expectedAudience`. */
  audience?: string;
  /** v2: the single action this attestation authorises. */
  purpose?: AttestationPurpose;
  /** v2: what the attester checked about the human, recorded for audit. Advisory — ruClip does not gate on it. Signed only when present; `{}` is refused. */
  assurance?: AttestationAssurance;
}

/** v2: binds an attestation to exactly one action on one subject at one version. */
export interface AttestationPurpose {
  /** One of `ATTESTATION_ACTIONS`; anything else is refused (fail closed). */
  action: AttestationAction;
  /** e.g. `issue:<issueId>`. */
  subjectRef: string;
  /** The subject's version the human saw (a non-negative integer). */
  subjectVersion: number;
  /** `sha256:<64 hex>` of the exact summary the human confirmed. */
  payloadDigest: string;
}

/** v2: attester-side facts, for audit only. */
export interface AttestationAssurance {
  orgRole?: string;
  tier?: string;
  surface?: string;
}

/**
 * Options for the v2 checks. Optional for v1 callers. A v2 attestation is refused unless both
 * `expectedAudience` and `expectedPurpose` are given; build `expectedPurpose` from server state
 * (the subject, its current version, the digest of the summary the server rendered), never from the request.
 */
export interface AttestationVerifyOptions {
  /** The attestation must be v2 and its `audience` must equal this exactly. Required for v2. */
  expectedAudience?: string;
  /** When true, a v1 attestation is rejected even if no `expectedAudience` is given. */
  requireVersion2?: boolean;
  /** The attestation must be v2 and its `purpose` must equal this field for field. Required for v2. */
  expectedPurpose?: AttestationPurpose;
}

/**
 * The closed set of actions a v2 attestation may authorise: the four
 * approval transitions plus heartbeat creation. An unknown action is
 * refused, so a new action needs a deliberate change here.
 */
export const ATTESTATION_ACTIONS = ['submit', 'approve', 'reject', 'revise', 'heartbeat.create'] as const;
export type AttestationAction = (typeof ATTESTATION_ACTIONS)[number];

const V2_CAPABILITY = 'ruclip.human-identity-attestation.v2';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_V2_FIELD_LENGTH = 256;
/** `<kind>:<id>`, e.g. `issue:issue-1`: a lower-case kind, then an id in the store's safe-id charset. */
const SUBJECT_REF_PATTERN = /^[a-z][a-z0-9._-]{0,63}:[A-Za-z0-9_-]{1,256}$/;
const PURPOSE_KEYS = ['action', 'subjectRef', 'subjectVersion', 'payloadDigest'] as const;
const ASSURANCE_KEYS = ['orgRole', 'tier', 'surface'] as const;
/** An attestation may claim an issuedAt at most this far ahead of the verifier's clock. */
export const ATTESTATION_CLOCK_SKEW_MS = 60_000;
/** The longest an attestation may live (expiresAt - issuedAt). The default TTL is 15 minutes. */
export const MAX_ATTESTATION_LIFETIME_MS = 60 * 60 * 1000;
/** One message for every audience/purpose mismatch, so the error is not an oracle for which field differs. */
const BINDING_MISMATCH = 'HumanIdentityAttestation is not bound to this verifier and action';

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_V2_FIELD_LENGTH;
}

/** A plain object whose own keys (symbols and non-enumerables included) are all in `allowed`. */
function hasOnlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key) && isDataProperty(value, key));
}

function isDataProperty(value: object, key: PropertyKey): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor;
}

const TOP_LEVEL_KEYS = [
  'orgMemberId', 'companyId', 'humanIdentityRef', 'issuedAt', 'expiresAt', 'nonce', 'signature',
  'attesterPublicKeyDerHex', 'version', 'audience', 'purpose', 'assurance',
] as const;

/** Copies one nested object's own data properties (symbol keys included, so the shape check still sees them). */
function snapshotNested(value: unknown, field: string): unknown {
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value) || (proto !== Object.prototype && proto !== null)) {
    throw new ActorIdentityVerificationError(`HumanIdentityAttestation ${field} must be a plain object`);
  }
  const copy: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (!isDataProperty(value, key)) {
      throw new ActorIdentityVerificationError(`HumanIdentityAttestation ${field} must hold data properties only (no accessors)`);
    }
    copy[key as string] = (value as Record<PropertyKey, unknown>)[key as string];
  }
  return Object.freeze(copy);
}

/**
 * The single read of presenter-supplied data. Every later step (shape, expectations, frame, nonce,
 * return value) reads this frozen snapshot, so an accessor cannot answer differently per read.
 * Accessor properties are refused outright.
 */
function snapshotAttestation(presented: HumanIdentityAttestation): HumanIdentityAttestation {
  if (presented === null || typeof presented !== 'object') {
    throw new ActorIdentityVerificationError('HumanIdentityAttestation must be an object');
  }
  const copy: Record<string, unknown> = {};
  for (const key of TOP_LEVEL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(presented, key)) {
      if (key in presented) {
        throw new ActorIdentityVerificationError(`HumanIdentityAttestation ${key} must be an own data property`);
      }
      continue;
    }
    if (!isDataProperty(presented, key)) {
      throw new ActorIdentityVerificationError(`HumanIdentityAttestation ${key} must be a data property (no accessors)`);
    }
    const value = (presented as unknown as Record<string, unknown>)[key];
    copy[key] = key === 'purpose' || key === 'assurance' ? snapshotNested(value, key) : value;
  }
  return Object.freeze(copy) as unknown as HumanIdentityAttestation;
}

/**
 * Base fields every attestation must carry as bounded strings, plus the time
 * window. null, undefined and NaN canonicalise alike, so a missing or
 * non-string field could otherwise be swapped for another after signing.
 */
function assertWellFormedBase(attestation: HumanIdentityAttestation, nowMs: number): void {
  for (const key of ['humanIdentityRef', 'issuedAt', 'expiresAt', 'signature', 'attesterPublicKeyDerHex'] as const) {
    const value: unknown = attestation[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > (key === 'humanIdentityRef' ? MAX_V2_FIELD_LENGTH : 1024)) {
      throw new ActorIdentityVerificationError(`HumanIdentityAttestation requires ${key} as a non-empty bounded string`);
    }
  }
  const expiresAtMs = Date.parse(attestation.expiresAt);
  const issuedAtMs = Date.parse(attestation.issuedAt);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(issuedAtMs)) {
    throw new ActorIdentityVerificationError('HumanIdentityAttestation issuedAt and expiresAt must be valid ISO 8601 timestamps');
  }
  if (expiresAtMs <= nowMs) {
    throw new ActorIdentityVerificationError(
      `HumanIdentityAttestation for '${attestation.orgMemberId}' expired at ${attestation.expiresAt}`,
    );
  }
  if (issuedAtMs > nowMs + ATTESTATION_CLOCK_SKEW_MS) {
    throw new ActorIdentityVerificationError('HumanIdentityAttestation issuedAt is in the future');
  }
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > MAX_ATTESTATION_LIFETIME_MS) {
    throw new ActorIdentityVerificationError('HumanIdentityAttestation lifetime (expiresAt - issuedAt) exceeds the maximum');
  }
}

/** The v2 fields exactly as signed. Verification returns these, never the presented objects. */
function signedV2Fields(
  attestation: Partial<Pick<HumanIdentityAttestation, 'audience' | 'purpose' | 'assurance'>>,
): { audience: string | undefined; purpose: AttestationPurpose | undefined; assurance?: AttestationAssurance } {
  const p = attestation.purpose;
  const a = attestation.assurance;
  return {
    audience: attestation.audience,
    purpose: p
      ? { action: p.action, subjectRef: p.subjectRef, subjectVersion: p.subjectVersion, payloadDigest: p.payloadDigest }
      : undefined,
    ...(a
      ? {
          assurance: {
            ...(a.orgRole !== undefined ? { orgRole: a.orgRole } : {}),
            ...(a.tier !== undefined ? { tier: a.tier } : {}),
            ...(a.surface !== undefined ? { surface: a.surface } : {}),
          },
        }
      : {}),
  };
}

/**
 * Structural check of the v2 fields, run before any signature work so a
 * malformed attestation fails with a precise message. Also rejects a v1
 * attestation that carries v2 fields (they would be unsigned).
 */
function assertWellFormedVersion(attestation: HumanIdentityAttestation): void {
  const carriesV2Fields =
    attestation.audience !== undefined || attestation.purpose !== undefined || attestation.assurance !== undefined;
  if (attestation.version === undefined) {
    if (carriesV2Fields) {
      throw new ActorIdentityVerificationError(
        'HumanIdentityAttestation carries audience/purpose/assurance without version 2 — those fields would not be signed',
      );
    }
    return;
  }
  if (attestation.version !== 2) {
    throw new ActorIdentityVerificationError(`HumanIdentityAttestation has unsupported version '${String(attestation.version)}'`);
  }
  if (!isBoundedString(attestation.audience)) {
    throw new ActorIdentityVerificationError('HumanIdentityAttestation v2 requires a non-empty audience of at most 256 characters');
  }
  const p = attestation.purpose;
  if (
    !hasOnlyKeys(p, PURPOSE_KEYS) ||
    !(ATTESTATION_ACTIONS as readonly string[]).includes(p.action as string) ||
    typeof p.subjectRef !== 'string' ||
    !SUBJECT_REF_PATTERN.test(p.subjectRef) ||
    !Number.isSafeInteger(p.subjectVersion) ||
    p.subjectVersion < 0 ||
    typeof p.payloadDigest !== 'string' ||
    !DIGEST_PATTERN.test(p.payloadDigest)
  ) {
    throw new ActorIdentityVerificationError(
      'HumanIdentityAttestation v2 requires purpose with exactly {action (one of ATTESTATION_ACTIONS), subjectRef (<kind>:<id>), subjectVersion (integer >= 0), payloadDigest (sha256:<64 hex>)}',
    );
  }
  const a = attestation.assurance;
  if (a !== undefined) {
    // An empty assurance is refused: absent assurance is not signed, so `{}` added after signing must not verify.
    if (!hasOnlyKeys(a, ASSURANCE_KEYS) || Reflect.ownKeys(a).length === 0) {
      throw new ActorIdentityVerificationError('HumanIdentityAttestation v2 assurance must hold at least one of orgRole, tier, surface and nothing else');
    }
    for (const key of ASSURANCE_KEYS) {
      if (a[key] !== undefined && !isBoundedString(a[key])) {
        throw new ActorIdentityVerificationError(`HumanIdentityAttestation v2 assurance.${key} must be a non-empty string of at most 256 characters`);
      }
    }
  }
}

function assertExpectations(attestation: HumanIdentityAttestation, opts: AttestationVerifyOptions | undefined): void {
  const needsV2 =
    !!opts && (opts.requireVersion2 === true || opts.expectedAudience !== undefined || opts.expectedPurpose !== undefined);
  if (attestation.version !== 2) {
    if (needsV2) {
      throw new ActorIdentityVerificationError(
        'A version 2 HumanIdentityAttestation is required here (audience/purpose binding); a version 1 attestation was presented',
      );
    }
    return;
  }
  // A v2 attestation binds nothing unless the verifier states both what it is and what is being
  // authorised; requireVersion2 alone would accept any audience and any purpose.
  const want = opts?.expectedPurpose;
  if (!isBoundedString(opts?.expectedAudience) || !want || typeof want !== 'object') {
    throw new ActorIdentityVerificationError(
      'A version 2 HumanIdentityAttestation must be verified against both expectedAudience and expectedPurpose',
    );
  }
  const got = attestation.purpose;
  if (
    attestation.audience !== opts!.expectedAudience ||
    !got ||
    got.action !== want.action ||
    got.subjectRef !== want.subjectRef ||
    got.subjectVersion !== want.subjectVersion ||
    got.payloadDigest !== want.payloadDigest
  ) {
    throw new ActorIdentityVerificationError(BINDING_MISMATCH);
  }
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
  > &
    Partial<Pick<HumanIdentityAttestation, 'version' | 'audience' | 'purpose' | 'assurance'>>,
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    orgMemberId: attestation.orgMemberId,
    companyId: attestation.companyId,
    humanIdentityRef: attestation.humanIdentityRef,
    issuedAt: attestation.issuedAt,
    expiresAt: attestation.expiresAt,
  };
  // v1 frames stay byte-identical to before this change: the v2 fields are
  // added, and the capability changes, only when version === 2. A distinct
  // capability means a v2 signature can never verify as a v1 frame or the
  // reverse, even over the same base fields.
  const isV2 = attestation.version === 2;
  if (isV2) {
    // Assurance is signed only when present; verification refuses an empty one, so adding `{}`
    // after signing cannot pass as signed.
    value.version = 2;
    Object.assign(value, signedV2Fields(attestation));
  }
  return {
    requestId: attestation.nonce,
    agentId: 'ruclip-human-attester',
    step: 0,
    kind: 'claim',
    value,
    confidence: 1,
    uncertainty: 0,
    dependencies: [],
    capabilityUsed: isV2 ? V2_CAPABILITY : 'ruclip.human-identity-attestation',
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
export interface VerifiedHumanIdentityAttestation {
  orgMemberId: string;
  companyId: string;
  humanIdentityRef: string;
  /** Present (as 2) only for a version 2 attestation; absent for v1, so the v1 return shape is unchanged. */
  version?: 2;
  /** v2 only — already compared against `expectedAudience` when one was given. */
  audience?: string;
  /** v2 only — already compared against `expectedPurpose` when one was given. */
  purpose?: AttestationPurpose;
  /** v2 only — advisory. */
  assurance?: AttestationAssurance;
}

export async function verifyHumanIdentityAttestation(
  presented: HumanIdentityAttestation,
  admittedAttesterKeys: ReadonlySet<string>,
  config?: AgentDbAdapterConfig,
  verifyOptions?: AttestationVerifyOptions,
): Promise<VerifiedHumanIdentityAttestation> {
  const attestation = snapshotAttestation(presented);
  // Read once from the snapshot; the frame and the return value both use exactly these fields.
  const signed = attestation.version === 2 ? signedV2Fields(attestation) : undefined;
  assertSafeId(attestation.orgMemberId, 'attestation.orgMemberId');
  assertSafeId(attestation.companyId, 'attestation.companyId');
  assertSafeId(attestation.nonce, 'attestation.nonce');

  assertWellFormedBase(attestation, Date.now());
  // v2 shape and the caller's audience/purpose expectations are checked
  // before the signature and before the nonce is consumed: they need no
  // I/O, and a mis-addressed attestation is refused with a precise reason.
  assertWellFormedVersion(attestation);
  assertExpectations(attestation, verifyOptions);
  if (!admittedAttesterKeys.has(attestation.attesterPublicKeyDerHex)) {
    throw new ActorIdentityVerificationError(
      `HumanIdentityAttestation for '${attestation.orgMemberId}' was signed by an attester key that is not ` +
        'admitted — a validly-signed attestation from an unrecognized attester is still rejected',
    );
  }

  const radioMoe = await loadRadioMoeRequired();
  const frame = { ...attestationFrame({ ...attestation, ...(signed ?? {}) }), signature: attestation.signature };
  if (!radioMoe.verifyFrame(frame, attestation.attesterPublicKeyDerHex)) {
    throw new ActorIdentityVerificationError(
      `HumanIdentityAttestation for '${attestation.orgMemberId}' failed signature verification`,
    );
  }

  // Atomic strict-insert, not a retrieve-then-store race — see
  // actor-credential.ts's `verifyActorCredential` for the full rationale
  // (same fix, same underlying `UNIQUE(namespace, key)` backend guarantee).
  const nonceKey = attestationNonceKey(attestation.companyId, attestation.nonce);
  const ttlSeconds = Math.max(1, Math.ceil((Date.parse(attestation.expiresAt) - Date.now()) / 1000));
  const stored = await callTool<{ success?: boolean }>(
    'memory_store',
    { key: nonceKey, value: true, ttl: ttlSeconds, namespace: ATTESTATION_NONCE_NAMESPACE, upsert: false },
    config,
  );
  if (!stored.success) {
    throw new ActorIdentityVerificationError(
      `HumanIdentityAttestation for '${attestation.orgMemberId}' was already used (nonce replay)`,
    );
  }

  const verified: VerifiedHumanIdentityAttestation = {
    orgMemberId: attestation.orgMemberId,
    companyId: attestation.companyId,
    humanIdentityRef: attestation.humanIdentityRef,
  };
  if (signed) {
    // The reconstructed, signed objects — never the presenter's, which could carry unsigned keys.
    verified.version = 2;
    verified.audience = signed.audience;
    verified.purpose = signed.purpose;
    if (signed.assurance) verified.assurance = signed.assurance;
  }
  return verified;
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
  opts?: { ttlSeconds?: number } & AttestationVerifyOptions,
  issuerConfig?: IssuerKeyConfig,
  config?: AgentDbAdapterConfig,
): Promise<ActorCredential> {
  const { orgMemberId, companyId, humanIdentityRef } = await verifyHumanIdentityAttestation(
    attestation,
    admittedAttesterKeys,
    config,
    opts ? { expectedAudience: opts.expectedAudience, requireVersion2: opts.requireVersion2, expectedPurpose: opts.expectedPurpose } : undefined,
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

  const credential = await mintActorCredential(
    orgMemberId,
    companyId,
    { ttlSeconds: opts?.ttlSeconds ?? DEFAULT_TTL_SECONDS },
    issuerConfig,
  );

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
