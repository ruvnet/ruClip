# Human Credential Issuance

Status: implemented (`b8648f7`'s follow-on — closes the gap
`ACTOR-IDENTITY-VERIFICATION.md` §4 named and deliberately deferred:
"Issuance for `kind: 'human'` OrgMembers — NOT solved here, named honestly
rather than papered over.")

This is the first concrete piece of what that document called a "hard
prerequisite for Phase 2 (dashboard)... Phase 2's own design doc, when
written, must solve human credential issuance as its first concern." It
does not build Phase 2's dashboard or a login flow — it builds the
*primitive* a login flow (or any other verified-identity source) needs to
hand ruClip: a signed statement that lets ruClip mint a real
`ActorCredential` for a `kind: 'human'` OrgMember, closing the residual
`applyApprovalTransition`/`persistIssue` Guard C/heartbeat block for humans
specifically who present one.

## 0. What §4 actually blocked, restated precisely

`resolveVerifiedActor` (`actor-credential.ts`) unconditionally rejected
every `kind: 'human'` OrgMember, regardless of what credential was
presented — not because a human's identity is inherently less verifiable
than an agent's, but because **no issuance mechanism existed** for humans.
Agents get theirs by chaining trust off a real, already-verified event
(`claims_accept-handoff` succeeding, §4 of the original document). Humans
had no equivalent event to chain off — "a genuine human-issuance path
requires an actual login/authentication flow... that does not exist
anywhere in ruClip today."

This document supplies that equivalent event: **a signed attestation from
an external system that has already verified the human's identity by some
means outside ruClip's own scope.**

## 1. Ground truth checked before designing this

Per this repo's own established discipline (`ACTOR-IDENTITY-VERIFICATION.md`
§0's own opening line — "grounded in how ruClip's functions are *actually*
invoked... checked first, not assumed"), three things were read directly,
not assumed:

1. **`credential-issuer.ts`'s actual trust model.** `mintActorCredential` is
   documented as "Pure signing — does not touch the AgentDB bridge and does
   not itself check that `orgMemberId` exists or holds any claim; the
   caller is responsible for only minting a credential for an identity it
   has already established by some other real means." This means the
   *security boundary* for agent issuance today is not "the signer checks
   anything about the target" — it is "only code paths that establish a
   real prior event (a successful `claims_accept-handoff`) are supposed to
   call `mintActorCredential`." Nothing in `mintActorCredential` itself
   enforces that discipline; it is an architectural convention, not a
   runtime check. A human-issuance mechanism built the same way — "only
   call the mint function after establishing identity by some real means" —
   would inherit that same property: anyone who can call
   `mintActorCredential` directly (i.e., anyone who holds the durable
   issuer's private key) could, in principle, mint a `kind: 'human'`
   credential with no attestation at all, exactly as they always could for
   an agent's `orgMemberId`. That is unacceptable for the specific class of
   action §4 named "block" for (authority on behalf of the company,
   effects visible to other parties) — it would make "block" a policy that
   is trivially bypassable by anyone with issuer-key access, not a real
   gate. See §2 for how this design closes that gap structurally rather
   than by convention alone.
2. **`cognitum-one/comms`'s ADR-0009** ("Cognitum-verified AgentBBS
   identity") is real, working prior art for the *shape* of this exact
   problem in a sibling repo: Ed25519 signing, a Secret-Manager-held
   attester seed, a single-use nonce. Read directly, not assumed similar.
   Its actual wire format, though, is agentbbs-core's own `Credential` type
   — a domain tag plus length-prefixed framing, built for AgentBBS room
   identity, not for a ruClip `ActorCredential`. Reusing that type directly
   would repeat the exact mistake `ACTOR-IDENTITY-VERIFICATION.md` §4
   already flagged once (forcing `federation_bbs_human_join`'s
   room-access token into a job — "this human controls this ruClip
   `OrgMember` identity" — its real scope doesn't cover). This design reuses
   ADR-0009's *strategy* (Ed25519 + durable key + single-use nonce), not
   its byte contract, and reuses it via `radio-moe`'s
   `AgentFrame`/`canonicalBytes`/`verifyFrame` — the SAME primitive
   `actor-credential.ts` and `credential-issuer.ts` already use in this
   repo, for the same "don't invent a second signing mechanism" reason §1
   of the original design gave.
3. **`cognitum-one/slack`'s identity resolution** (ADR-0002 "Identity &
   per-user capabilities", ADR-0015 "identity resolution is a single
   point"). Read directly: the real, shipped identity primitive there is a
   Slack `user_id` (e.g. `U0BQJNHH7L3`) resolved server-side, via a
   verified `@cognitum.one` mailbox (`users.info`, `users:read.email`
   scope), to an `Employee` role — "every event carries the Slack `user`
   id... a Slack workspace membership alone must never grant a
   capability... every tool call needs an authorization decision
   attributable to a person." That resolution is a real, already-built,
   already-verified event, structurally the human analogue of
   `claims_accept-handoff` for agents. This design's
   `HumanIdentityAttestation.humanIdentityRef` is shaped to carry exactly
   that value (e.g. `slack:U0BQJNHH7L3`), matching
   `schema/org-member.ts`'s own existing comment on `identityRef`: "For
   kind: 'human' — a claims/BBS identity string."

   **ruClip stays ruvnet-only at the substrate regardless.** This module
   imports no Slack SDK, no Firebase, nothing from `cognitum-one/slack` or
   `cognitum-one/comms`. It only defines a contract — a signed JSON
   statement — and verifies it. Whatever system produces a
   `HumanIdentityAttestation` (a Cognitum-side service sitting in front of
   `cognitum-one/slack`'s identity resolution is the natural first
   producer, but the contract does not know or care) is entirely outside
   this repo's own code, exactly the same separation
   `federation_bbs_human_join` already keeps between AgentBBS room access
   and this repo.

## 2. The contract: `HumanIdentityAttestation`

```typescript
export interface HumanIdentityAttestation {
  orgMemberId: string;
  companyId: string;
  /** The verified human identity this attestation vouches for — e.g. a
   *  Cognitum Slack user id such as `slack:U0BQJNHH7L3`. MUST equal the
   *  target OrgMember's own `identityRef`. */
  humanIdentityRef: string;
  issuedAt: string;   // ISO 8601
  expiresAt: string;  // ISO 8601 — short TTL, default 15 min
  nonce: string;      // single-use replay guard, own namespace
  signature: string;  // radio-moe signFrame() signature (hex)
  attesterPublicKeyDerHex: string; // which admitted attester key signed this
}
```

Signed/verified via `attestationFrame()` — the exact same
`AgentFrame`/`canonicalBytes`/`verifyFrame` discipline
`actorCredentialFrame()` already established, kept in one place so signing
and verification can never drift apart. Uses `kind: 'claim'` (radio-moe's
real, closed `FrameKind` union) with a distinct `capabilityUsed` field
(`ruclip.human-identity-attestation`) so an attestation frame and an
`ActorCredential` frame can never be mistaken for one another even though
both use the same `kind`.

## 3. Verification: `verifyHumanIdentityAttestation`

Mirrors `verifyActorCredential`'s own structure exactly (§2 of the original
design), throwing `ActorIdentityVerificationError` on the first failure,
before any AgentDB write:

1. `expiresAt` must be in the future.
2. `attesterPublicKeyDerHex` must be a member of a caller-supplied
   `admittedAttesterKeys` set — an unrecognized attester is rejected even
   if the signature over it verifies internally consistently.
3. `radio-moe`'s real `verifyFrame` must return `true`.
4. **Replay check**, own namespace (`ruclip-human-identity-attestations`,
   separate from `ActorCredential`'s own `ruclip-actor-credentials`
   namespace — an attestation and the credential it mints are two
   different single-use artifacts): the nonce must not have been consumed
   before, using the same `memory_store` `ttl` guard the original design
   established for `ActorCredential`'s own nonce (§3 of the original
   document) — a self-expiring record, no separate cleanup job needed.

`admittedAttesterKeys` is resolved via `resolveAdmittedAttesterKeys`,
mirroring `credential-issuer.ts`'s `resolveAdmittedIssuerKeys` in *shape*
but deliberately different in *mechanism*: ruClip's own durable issuer
keypair is something this repo mints credentials with (GCP Secret Manager,
`credential-issuer.ts`); an attester keypair belongs to an EXTERNAL system
that ruClip never holds the private half of — only the public key(s) it
chooses to trust. The primary mechanism is an explicit, caller-supplied
`ReadonlySet<string>` (whatever wires up a specific deployment passes the
keys it trusts); a comma-separated `RUCLIP_HUMAN_ATTESTER_KEYS` env var is
a convenience fallback, not a second secret-manager integration — there is
no real GCP project of ruClip's own yet to provision one against
(`ADR-0001` §9, same caveat `credential-issuer.ts`'s own header already
notes for the issuer key).

## 4. Minting: `mintHumanActorCredential` and the provenance-marker fix to §1's gap

`mintHumanActorCredential(attestation, admittedAttesterKeys, opts?,
issuerConfig?, config?)`:

1. Calls `verifyHumanIdentityAttestation` (consumes the attestation's
   nonce — single-use, like §3 above).
2. Recalls the target `OrgMember` fresh from AgentDB (never trusts anything
   about identity beyond what step 1 established).
3. Rejects if the target does not exist.
4. Rejects if the target's `kind !== 'human'` — this issuance path is
   human-only by design, mirroring how agent issuance chains off an
   agent-only event (`claims_accept-handoff`).
5. Rejects if the target's own persisted `identityRef` does not equal the
   attestation's `humanIdentityRef` — the binding check that stops an
   attestation genuinely proving identity X from minting a credential for
   an OrgMember record actually bound to a different identity Y (a
   desynced/misconfigured record, or a real attestation for one's own
   identity misapplied to a different `orgMemberId`).
6. Only then calls `credential-issuer.ts`'s real `mintActorCredential` —
   the exact same durable-issuer-key signing path agent issuance already
   uses. No second signing mechanism.
7. **Immediately writes an AgentDB provenance marker**, keyed by the
   freshly-minted credential's own nonce:
   `humanAttestedCredentialMarkerKey(companyId, credential.nonce)` in a
   dedicated `ruclip-human-attested-credentials` namespace, TTL matched to
   the credential's own expiry.

Step 7 is the structural fix to the gap §1 point 1 identified: without it,
"only call the human-mint function after a real attestation" would be pure
caller discipline, exactly as fragile as it already is for agents — anyone
holding the issuer's private key could still mint an unattested `kind:
'human'` credential directly via `mintActorCredential`. The marker makes
the human-issuance path's guarantee independently checkable at
*verification* time, not just trusted at *mint* time: `resolveVerifiedActor`
(`actor-credential.ts`) now requires this marker to be present, for the
SPECIFIC credential nonce being verified, before authorizing a `kind:
'human'` actor — a credential minted any other way (including a bare
`mintActorCredential` call naming a human `orgMemberId`) has no marker and
is rejected, exactly as before this slice. This is what "the block lifts
only when a credential minted through this path is presented" means
concretely, verified by the
`REGRESSION: resolveVerifiedActor still blocks...` test in
`tests/control-plane/human-identity-attestation.test.ts`, not assumed.

## 5. What this closes vs. what remains open

**Closes**: `applyApprovalTransition`, `persistIssue`'s Guard C, and
`persistHeartbeatSchedule`'s authorization requirement can now all be
satisfied by a `kind: 'human'` OrgMember, provided its credential was
minted via `mintHumanActorCredential` after a real, verified attestation.
Confirmed end to end (not just unit-level at `resolveVerifiedActor`) by the
`FULL PIPELINE` tests in `tests/control-plane/human-identity-attestation.test.ts`,
which drive a human actor through `applyApprovalTransition`'s real
'approve' action.

**Remains open, named not hidden** (unchanged from the original design's
own §6, since none of it was this slice's job):

- **No producer of `HumanIdentityAttestation` exists yet.** This document
  and its code define the contract and the consumer (verification +
  minting); an actual attester service — e.g. a small Cognitum-side
  process sitting in front of `cognitum-one/slack`'s identity resolution,
  holding its own Ed25519 keypair, that a Phase 2 dashboard/login flow
  would call — is not built here. That is Phase 2's own remaining work,
  narrowed by this slice to "produce one signed JSON statement," not
  "solve human authentication from scratch."
- `setInteractionProfileConsent`'s `actor.id` forgery risk (original §4's
  narrowed exception) — still not retrofitted, per the team lead's explicit
  scope for this slice (strictly self-referential, no other party
  affected, low priority relative to the three authority-bearing sites).
  Could now be closed the same way as the other three, using this same
  attestation mechanism, as a genuine follow-up — not done here to keep
  this slice's diff scoped to what was asked.
- Credential/attestation *revocation* before natural expiry is still not
  designed — the short (15 min) TTL on both artifacts bounds the exposure
  window, same trade-off the original design accepted for `ActorCredential`
  itself.
- The admitted-attester-key resolution mechanism (`RUCLIP_HUMAN_ATTESTER_KEYS`
  env var fallback) is a convenience default, not a production secret-
  management story — a real deployment should pass `admittedKeys`
  explicitly, sourced however that deployment manages its own trust
  relationships (this is intentionally NOT prescribed here, mirroring how
  ruClip does not prescribe which GCP project holds its own issuer secret
  either).
