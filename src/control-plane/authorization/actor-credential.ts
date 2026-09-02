/**
 * ActorCredential — closes the systemic actor-forgery gap
 * (ACTOR-IDENTITY-VERIFICATION.md): every function across this codebase
 * that took a caller-supplied `actor: OrgMember` trusted the object's `id`
 * field with no proof the caller genuinely IS that person. This module is
 * the one place that turns "trust the object" into "verify a signature,
 * then trust only what the signature covers."
 *
 * Reuses this repo's own real signing primitive rather than inventing a
 * second one — `comms/agentbbs-notification-channel.ts` already
 * established (by reading `radio-moe`'s real `dist/*.d.ts` directly, not
 * assuming) that `signFrame`/`verifyFrame` sign/verify ANY JSON-shaped
 * `AgentFrame`. `verifyActorCredential` below calls the exact same real
 * `verifyFrame` export.
 *
 * Deliberate difference from that file's signing layer: this one FAILS
 * CLOSED. `agentbbs-notification-channel.ts`'s signing is best-effort
 * (a lost/unsigned notification is a nice-to-have gap); an unverifiable
 * actor identity for an approval decision, a comms/heartbeat mutation, or a
 * consent change is not. If `radio-moe` isn't installed, every function
 * that calls `verifyActorCredential` refuses to operate rather than
 * falling back to trusting an unverified `actor` object (ACTOR-IDENTITY-
 * VERIFICATION.md §2). `radio-moe` is therefore a REQUIRED dependency for
 * this specific mechanism, `package.json`'s `peerDependenciesMeta` marks it
 * `optional: false` — the notification channel's own, separate, best-effort
 * `radio-moe` usage is untouched and stays tolerant of it being absent.
 *
 * `kind: 'human'` OrgMembers — see `docs/design/HUMAN-CREDENTIAL-ISSUANCE.md`
 * and `human-identity-attestation.ts`: `resolveVerifiedActor` below now
 * authorizes a `kind: 'human'` OrgMember, but ONLY when its credential
 * carries the AgentDB-backed provenance marker that `mintHumanActorCredential`
 * writes after independently verifying a `HumanIdentityAttestation` from an
 * admitted external attester. Every other `kind: 'human'` credential —
 * including one minted directly via this file's own sibling
 * `mintActorCredential` — stays blocked, matching
 * ACTOR-IDENTITY-VERIFICATION.md §4's original fail-closed default exactly.
 */
import { recallOrgMember, type AgentDbAdapterConfig } from '../store/agentdb-adapter.js';
import type { OrgMember } from '../schema/org-member.js';
import { AgentDbBridgeError, assertSafeId, callTool } from '../store/bridge-client.js';

export class ActorIdentityVerificationError extends AgentDbBridgeError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ActorIdentityVerificationError';
  }
}

/**
 * A short-lived, signed proof of an OrgMember's identity (§1). `signature`/
 * `issuerPublicKeyDerHex` are populated by `credential-issuer.ts`'s
 * `mintActorCredential` — this module never signs, only verifies.
 */
export interface ActorCredential {
  orgMemberId: string;
  companyId: string;
  /** ISO 8601. */
  issuedAt: string;
  /** ISO 8601 — short TTL, default 15 min (matches federation_bbs_human_join's own default). */
  expiresAt: string;
  /** Single-use replay guard — see the nonce-consumption step below. */
  nonce: string;
  /** radio-moe `signFrame()` signature (hex) over `actorCredentialFrame(credential)`. */
  signature: string;
  /** Which durable issuer key produced `signature` — checked against `admittedIssuerKeys` before the signature itself is trusted. */
  issuerPublicKeyDerHex: string;
}

/**
 * A verified caller presents both a credential and the set of issuer public
 * keys it will accept — see this file's own `verifyActorCredential` for why
 * membership in that set is checked BEFORE the signature is trusted (a
 * validly-signed credential from an un-admitted issuer is still rejected;
 * "who signed this" is not "may they issue credentials").
 */
export interface ActorAuthorization {
  credential: ActorCredential;
  admittedIssuerKeys: ReadonlySet<string>;
}

/**
 * The exact frame shape signed/verified — kept in one place (mirroring
 * `agentbbs-notification-channel.ts`'s own `notificationFrame()` discipline)
 * so signing (`credential-issuer.ts`) and verification (this file) can never
 * drift apart. Deliberately excludes `signature`/`issuerPublicKeyDerHex`:
 * `signature` because it IS the thing being produced, and
 * `issuerPublicKeyDerHex` because it doesn't need to be signed over — an
 * ed25519 signature is already cryptographically bound to the specific
 * private key that produced it, so relabelling `issuerPublicKeyDerHex` on a
 * credential cannot make a signature verify against a different key than
 * the one that actually signed it.
 *
 * `radio-moe`'s real `AgentFrame` type (`dist/agent-frame.d.ts`, confirmed
 * by reading it directly) requires `kind: FrameKind` to be one of
 * `'claim' | 'evidence' | 'plan' | 'action' | 'logits'` — this uses `'claim'`
 * (an identity claim), distinct from the notification channel's `'evidence'`.
 */
export function actorCredentialFrame(
  credential: Pick<ActorCredential, 'orgMemberId' | 'companyId' | 'issuedAt' | 'expiresAt' | 'nonce'>,
): Record<string, unknown> {
  return {
    requestId: credential.nonce,
    agentId: 'ruclip',
    step: 0,
    kind: 'claim',
    value: {
      orgMemberId: credential.orgMemberId,
      companyId: credential.companyId,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
    },
    confidence: 1,
    uncertainty: 0,
    dependencies: [],
    capabilityUsed: 'ruclip.actor-credential',
    evidenceHashes: [],
    cost: 0,
  };
}

interface RadioMoeVerifyModule {
  verifyFrame(frame: Record<string, unknown>, publicKeyDerHex: string): boolean;
}

/**
 * Unlike `agentbbs-notification-channel.ts`'s `loadRadioMoe()`, this throws
 * (never returns null) when the module can't be loaded — required, not
 * optional, for this mechanism (see file header).
 */
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
        'radio-moe is required for actor identity verification (ACTOR-IDENTITY-VERIFICATION.md §2) but is not ' +
          'installed — refusing to authorize rather than silently trusting an unverified actor',
      );
    }
    throw err;
  }
}

/** Deliberately separate from every other AgentDB/memory namespace this repo uses — see §3. */
const NONCE_NAMESPACE = 'ruclip-actor-credentials';

function credentialNonceKey(companyId: string, nonce: string): string {
  return `ruclip:company:${companyId}:credential-nonce:${nonce}`;
}

/**
 * Provenance marker for a human-issued `ActorCredential` — see
 * `docs/design/HUMAN-CREDENTIAL-ISSUANCE.md`. `mintHumanActorCredential`
 * (`human-identity-attestation.ts`) writes one of these, keyed by the
 * FRESHLY-MINTED credential's own single-use nonce, immediately after it has
 * verified a real `HumanIdentityAttestation` and minted the credential —
 * never before, never for any other reason. `resolveVerifiedActor` below
 * requires this marker to be present before authorizing a `kind: 'human'`
 * OrgMember; a `kind: 'human'` credential minted any other way (there is no
 * other sanctioned way — `mintActorCredential` alone never writes this
 * marker) has no marker and stays blocked.
 *
 * Deliberately a SEPARATE namespace/key from `NONCE_NAMESPACE`'s own replay
 * guard above — that guard tracks "has THIS credential been verified yet"
 * (consumed by `verifyActorCredential`, single-use); this one tracks "was
 * THIS credential's nonce ever blessed by the human-attestation path"
 * (written once at mint time, read-only here, never consumed) — conflating
 * the two would make the marker disappear the instant the credential is
 * verified, which is exactly when `resolveVerifiedActor` needs to read it.
 */
export const HUMAN_ATTESTED_NAMESPACE = 'ruclip-human-attested-credentials';

/** Exported so `human-identity-attestation.ts` can write the identical key this file reads — kept in one place, same discipline as `credentialNonceKey`/`actorCredentialFrame`. */
export function humanAttestedCredentialMarkerKey(companyId: string, credentialNonce: string): string {
  return `ruclip:company:${companyId}:human-attested-credential:${credentialNonce}`;
}

/**
 * Verifies `credential`, in order, throwing `ActorIdentityVerificationError`
 * on the first failure, before any AgentDB write (§2):
 *
 * 1. `expiresAt` must be in the future.
 * 2. `issuerPublicKeyDerHex` must be a member of `admittedIssuerKeys`.
 * 3. `radio-moe`'s real `verifyFrame` must return true.
 * 4. Replay check: the nonce must not have been consumed before.
 *
 * Returns only `{orgMemberId, companyId}` — never the full `OrgMember`.
 * Every caller must recall the OrgMember fresh (`resolveVerifiedActor`
 * below does this) for anything beyond identity itself.
 */
export async function verifyActorCredential(
  credential: ActorCredential,
  admittedIssuerKeys: ReadonlySet<string>,
  config?: AgentDbAdapterConfig,
): Promise<{ orgMemberId: string; companyId: string }> {
  assertSafeId(credential.orgMemberId, 'credential.orgMemberId');
  assertSafeId(credential.companyId, 'credential.companyId');
  assertSafeId(credential.nonce, 'credential.nonce');

  if (Date.parse(credential.expiresAt) <= Date.now()) {
    throw new ActorIdentityVerificationError(
      `ActorCredential for '${credential.orgMemberId}' expired at ${credential.expiresAt}`,
    );
  }
  if (!admittedIssuerKeys.has(credential.issuerPublicKeyDerHex)) {
    throw new ActorIdentityVerificationError(
      `ActorCredential for '${credential.orgMemberId}' was signed by an issuer key that is not admitted — a ` +
        'validly-signed credential from an unrecognized issuer is still rejected (§2)',
    );
  }

  const radioMoe = await loadRadioMoeRequired();
  const frame = { ...actorCredentialFrame(credential), signature: credential.signature };
  if (!radioMoe.verifyFrame(frame, credential.issuerPublicKeyDerHex)) {
    throw new ActorIdentityVerificationError(
      `ActorCredential for '${credential.orgMemberId}' failed signature verification`,
    );
  }

  // Replay guard (§3) — reuses memory_store's real ttl parameter rather
  // than a new expiry mechanism; the consumed-nonce record self-expires
  // exactly when the credential it guarded would have expired anyway.
  const nonceKey = credentialNonceKey(credential.companyId, credential.nonce);
  const existing = await callTool<{ found?: boolean }>(
    'memory_retrieve',
    { key: nonceKey, namespace: NONCE_NAMESPACE },
    config,
  );
  if (existing.found) {
    throw new ActorIdentityVerificationError(
      `ActorCredential for '${credential.orgMemberId}' was already used (nonce replay)`,
    );
  }
  const ttlSeconds = Math.max(1, Math.ceil((Date.parse(credential.expiresAt) - Date.now()) / 1000));
  await callTool(
    'memory_store',
    { key: nonceKey, value: true, ttl: ttlSeconds, namespace: NONCE_NAMESPACE },
    config,
  );

  return { orgMemberId: credential.orgMemberId, companyId: credential.companyId };
}

/**
 * The standard pattern every retrofitted call site uses (§2 step 5,
 * generalized): verify the credential (consuming its nonce — see this
 * function's own header note on why this must be called at most ONCE per
 * credential), then recall the OrgMember fresh from AgentDB — never trust
 * anything beyond identity from the credential or from a caller-supplied
 * object. Fails closed for `kind: 'human'` OrgMembers (§4's locked
 * decision): human credential issuance does not exist yet, so a human
 * actor can never be authorized via ActorCredential today, regardless of
 * what's presented — there is no fallback path in this code to the older,
 * weaker check.
 *
 * IMPORTANT — call this at most ONCE per credential per logical operation.
 * `verifyActorCredential`'s nonce check is single-use by design (§3); a
 * credential handed to `applyApprovalTransition` is verified here exactly
 * once, at that function's own top, and the RESOLVED `OrgMember` (not the
 * raw credential) is threaded to any internal step that also needs the
 * actor's identity (e.g. `persistIssue`'s Guard C) — re-verifying the same
 * credential a second time would hit the replay guard and fail a
 * legitimate call. See `store/agentdb-adapter.ts`'s `applyApprovalTransition`
 * and `persistIssue` for the concrete resolution, and `docs/PLAN.md` §8 for
 * why this diverges from a literal reading of ACTOR-IDENTITY-VERIFICATION.md
 * §5 items 1-2.
 *
 * `kind: 'human'` handling — UPDATED, see `docs/design/HUMAN-CREDENTIAL-ISSUANCE.md`:
 * §4's original locked decision blocked EVERY `kind: 'human'` OrgMember
 * unconditionally, because no issuance path existed for them at all —
 * "block" was a fail-closed placeholder for a missing mechanism, not a
 * permanent policy (§4: "not closed by verification ... blocking is a
 * fail-closed placeholder, not a solution"). `human-identity-attestation.ts`
 * now provides that mechanism: `mintHumanActorCredential` mints a
 * `kind: 'human'` `ActorCredential` only after independently verifying a
 * signed `HumanIdentityAttestation` from an admitted external attester (a
 * Cognitum-side service that already confirmed the human's identity — e.g.
 * a verified `@cognitum.one` Slack identity, ADR-0002/ADR-0015 in
 * `cognitum-one/slack`), and — critically — is the ONLY code path that ever
 * writes a `humanAttestedCredentialMarkerKey` provenance marker for that
 * credential's nonce. A `kind: 'human'` `ActorCredential` minted any other
 * way (e.g. a bare `mintActorCredential` call naming a human's
 * `orgMemberId`, still possible for anyone holding the durable issuer key,
 * exactly as it always was for agents) carries no such marker and is still
 * blocked below — the fail-closed default is otherwise UNCHANGED, and stays
 * the default for every `kind: 'human'` OrgMember whose credential wasn't
 * minted through that specific path. This is what "the block lifts only
 * when a credential minted through this path is presented" means
 * concretely: not a kind check alone (that would trust any signed
 * credential naming a human, which `mintActorCredential`'s own "pure
 * signer, caller-discipline" trust model — see `credential-issuer.ts`'s
 * header — cannot rule out on its own), but a positive, AgentDB-backed fact
 * that this specific credential went through real attestation
 * verification.
 */
export async function resolveVerifiedActor(
  authorization: ActorAuthorization,
  config?: AgentDbAdapterConfig,
): Promise<OrgMember> {
  const { orgMemberId, companyId } = await verifyActorCredential(
    authorization.credential,
    authorization.admittedIssuerKeys,
    config,
  );
  const actor = await recallOrgMember(companyId, orgMemberId, config);
  if (!actor) {
    throw new ActorIdentityVerificationError(
      `Verified ActorCredential names OrgMember '${orgMemberId}' in company '${companyId}' but no such OrgMember ` +
        'is persisted',
    );
  }
  if (actor.kind === 'human') {
    // Deliberately keyed off the CREDENTIAL's own nonce (not derived from
    // orgMemberId/companyId alone) — the marker binds to this one specific,
    // freshly-minted credential instance, matching how the credential's own
    // replay guard above is scoped (§3), not to "this OrgMember has ever
    // had a marker."
    const attested = await callTool<{ found?: boolean }>(
      'memory_retrieve',
      { key: humanAttestedCredentialMarkerKey(companyId, authorization.credential.nonce), namespace: HUMAN_ATTESTED_NAMESPACE },
      config,
    );
    if (!attested.found) {
      throw new ActorIdentityVerificationError(
        `OrgMember '${orgMemberId}' is kind 'human' and this ActorCredential carries no human-attestation ` +
          'provenance marker (docs/design/HUMAN-CREDENTIAL-ISSUANCE.md) — only a credential minted via ' +
          "mintHumanActorCredential, after verifying a real HumanIdentityAttestation, can authorize a human " +
          'actor; there is no other fallback path',
      );
    }
  }
  return actor;
}
