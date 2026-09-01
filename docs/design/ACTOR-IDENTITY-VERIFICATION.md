# Actor Identity Verification

Status: design (cross-cutting, priority — ahead of further Human Employee
Augmentation work). Closes the gap `ruclip-security` confirmed is systemic,
not scoped to one function: every function across this codebase that takes
an `actor: OrgMember` parameter trusts a caller-constructed object's `id`
field with no proof the caller genuinely *is* that person.
`verifyActorHoldsClaim` (`AUTHORIZATION.md`) does not solve this — it
verifies that *some* claimant string currently holds a work claim, not that
the caller controls that claimant string. The approval-gate's self-approval
invariant is theoretically bypassable today by forging a *different*
`actor.id` on the approval call, not just forging your own identity — a
real weakening of already-shipped code, not only a gap in new code.

Per instruction: this design is grounded in how ruClip's functions are
*actually* invoked in this environment, checked first, not assumed — the
mechanism only makes sense once that's established.

## 0. Investigation — what's actually enforceable here

**The four real call sites** (grepped, not estimated):

| Call site | File | What it currently trusts |
|---|---|---|
| Approval-gate self-approval check | `approval/transition-approval-state.ts`, `store/agentdb-adapter.ts` Guard C | `actor.id`/`actor.status` on a caller-supplied `OrgMember` (Guard C already recalls the *persisted* `OrgMember` for `status` — a prior hardening — but still trusts the caller's `actor.id` as *which* persisted record to recall) |
| Comms-room registration / human-join minting | `comms/agentbbs-notification-channel.ts` (registration), wherever `federation_bbs_human_join` gets called on an OrgMember's behalf | Same — whichever `OrgMember` the caller names |
| Heartbeat schedule create/pause/resume | `authorization/claims-authorization.ts`'s `verifyActorHoldsClaim`, reused by heartbeat persistence | Caller-supplied `actor.id`, checked only against claim *ownership*, not caller identity |
| `EmployeeInteractionProfile` consent | `employee-augmentation/interaction-profile.ts` | Bare `actor.id !== orgMemberId` equality on a caller-supplied object — the most exposed of the four, no claims check at all |

**Is there ANY tool in this environment that verifies caller identity rather
than accepting a self-asserted string?** Checked directly, not assumed:

- `claims_claim`/`claims_handoff`/`claims_accept-handoff`'s real schemas
  (`AUTHORIZATION.md` §1) take `claimant`/`from`/`to` as **plain string
  parameters** — the claims system itself has no notion of who is actually
  calling it. `verifyActorHoldsClaim` reading `claims_list` afterward
  confirms *a claim exists for that string*, not *the caller is that
  string*.
- `agentdb_session-start`/`session-end` take a caller-supplied `sessionId`
  string — same pattern, no verification.
- No `whoami`/session-identity tool exists anywhere in this MCP surface
  (checked by search — nothing matches).
- **Conclusion: there is no existing authenticated-calling-context
  primitive anywhere in this stack for a plain exported TypeScript
  function to delegate to.** This is not a gap specific to ruClip's own
  code — it's a structural property of how every tool in this environment
  currently works: identity is self-reported by the caller, everywhere,
  by design (these are same-trust-boundary tool calls between a Claude Code
  session and its own MCP servers, not a multi-tenant API). ruClip's
  functions are plain exported library functions, imported and called
  in-process by whatever code holds them — an agent employee's own
  session, or (in the future) a service layer — with no network/session
  boundary of ruClip's own to authenticate against today.

**What this means for the design**: "derive identity from an authenticated
calling context, never accept a client-supplied argument" is the right
end-state, but the authenticated calling context has to be *built*, not
found — there's nothing existing to plug into. The realistic near-term
answer, given this environment, is not a network-level auth boundary (that
requires an actual service layer, `ADR-0001` point 5's deferred Cloud Run
fallback, or the Phase 2 dashboard backend — neither exists yet) — it's a
**signed, short-lived credential**, verified by every actor-taking function
as its own first step, replacing "trust the object" with "verify the
signature, then trust only what the signature covers." This matches how
every other "prove you are who you say" problem in this exact ecosystem is
already solved (not a new pattern): the npm-publish signing key
(root `CLAUDE.md`), `federation_bbs_human_join`'s Ed25519-signed,
single-use, TTL'd handshake token, and — closest of all — the
`radio-moe`-backed signing this repo's own `agentbbs-notification-channel.ts`
already shipped for notification tamper-evidence (§1 reuses it directly).

## 1. `ActorCredential` — reusing this repo's own real signing primitive, not inventing one

**Do not build a second signing mechanism.** `comms/agentbbs-notification-channel.ts`
already solved "how do we get a genuine ed25519 signature over an arbitrary
payload in this environment" — its own file header documents finding that
`radio-moe`'s `seal`/`verifySealed` are locked to a closed `Wire` union
(`AdvertWire | DispatchWire | LogitFrame | TextFrame`, no notification-shaped
variant — verified in `dist/types.d.ts`), so it correctly uses `PeerIdentity`
+ `signFrame`/`verifyFrame` instead, which sign/verify **any** JSON-shaped
payload. This design reuses the exact same primitive, the exact same way,
for `ActorCredential`.

**One deliberate difference, justified**: `agentbbs-notification-channel.ts`'s
signing identity is *ephemeral, per-process, not persisted across restarts*
(its own comment says so) — correct for that use case, where a notification
is typically signed and verified in a best-effort, same-session round trip
and losing tamper-evidence on restart is an acceptable, already-accepted
trade-off. `ActorCredential` verification cannot use an ephemeral key: a
credential is issued in one call and verified in a *different* call,
potentially a different process, potentially much later. **The
credential-issuer's identity must be durable and its public key
independently knowable to every verifier** — not regenerated every process
start. This is the same distinction `radio-moe`'s own docs draw between
`verifySealed` (proves possession of *a* key) and `AdmittedPeerRegistry`
(binds a specific, durable, admitted key to a specific identity) — `ActorCredential`
needs the durable-admitted-key half, not the ephemeral-possession half.

```typescript
export interface ActorCredential {
  orgMemberId: string;
  companyId: string;
  issuedAt: string; // ISO 8601
  expiresAt: string; // ISO 8601 — short TTL, default 15 min, matching federation_bbs_human_join's own default
  nonce: string; // single-use replay guard, see §3
  signature: string; // radio-moe signFrame() signature over the fields above
  issuerPublicKeyDerHex: string; // which durable issuer key signed this — see §4
}
```

Signed/verified via the exact `signFrame`/`verifyFrame` pattern
`notificationFrame()` already establishes in
`agentbbs-notification-channel.ts` — a small, analogous
`actorCredentialFrame(credential)` canonicalizer, so signing and
verification never drift apart, same discipline that file's own comment
calls out ("kept in one place").

## 2. `verifyActorCredential` — fails closed, not gracefully, on purpose

```
verifyActorCredential(
  credential: ActorCredential,
  admittedIssuerKeys: ReadonlySet<string>, // durable, known-good issuer public keys — see §4
  config?: AgentDbAdapterConfig,
): Promise<{ orgMemberId: string; companyId: string }>
```

Steps, in order, throwing `ActorIdentityVerificationError` (new error
class) on the first failure, before any AgentDB write:

1. `credential.expiresAt` must be in the future.
2. `credential.issuerPublicKeyDerHex` must be a member of
   `admittedIssuerKeys` — an unrecognized issuer key is rejected even if
   the signature over it verifies internally consistently (the
   `verifySealed`-vs-`AdmittedPeerRegistry` distinction from §1: a valid
   signature answers "who signed this," not "may they issue credentials").
3. `radio-moe`'s `verifyFrame(actorCredentialFrame(credential), credential.issuerPublicKeyDerHex)`
   must return `true`.
4. **Replay check**: the nonce must not have been consumed before — see
   §3.
5. On success, returns `{ orgMemberId, companyId }` — **not** the full
   `OrgMember` record. Every caller then recalls the full `OrgMember` fresh
   from AgentDB via `recallOrgMember(companyId, orgMemberId, config)`
   (already-existing function) for anything beyond identity — status,
   kind, role — the same hardening Guard C already applied to `status`
   specifically (`store/agentdb-adapter.ts`'s post-delivery fix,
   `docs/PLAN.md` §8), generalized here into the standard pattern for
   every actor-taking function, not a one-off fix.

**Deliberately fails closed, unlike `agentbbs-notification-channel.ts`'s
signing layer**: that file returns `null`/`false` and continues
(best-effort tamper-evidence on a notification is a nice-to-have).
`verifyActorCredential` **requires `radio-moe` to be installed** — if
`import('radio-moe')` fails, every actor-taking function refuses to
operate rather than silently falling back to trusting an unverified
`actor` object. This is a deliberate split in how the same optional
dependency is treated for two different purposes in the same codebase:
best-effort tamper-evidence on notifications may degrade; authorization
for an approval decision, a comms-room registration, a heartbeat, or
personal-data consent may not. `radio-moe` therefore becomes a **required**
peer dependency for this mechanism specifically, not optional like it is
for the notification channel — `package.json`'s `peerDependenciesMeta`
needs `radio-moe: { optional: false }` scoped to *this* feature (the
existing notification-channel usage stays tolerant of it being absent;
this one does not).

## 3. Replay guard

Reuses `memory_store`'s real `ttl` parameter (already confirmed live,
`HEARTBEATS-AND-COMMS.md` §4) rather than a new expiry mechanism:
`memory_store({ key: 'ruclip:company:{companyId}:credential-nonce:{nonce}',
value: true, ttl: <seconds until credential.expiresAt>, namespace:
'ruclip-actor-credentials' })`. Verification checks `memory_retrieve` on
that key first — if present, the nonce was already consumed, reject. The
`ttl` means consumed-nonce records self-expire exactly when the credential
they guarded would have expired anyway, so this namespace never grows
unbounded (no separate cleanup job needed) — a detail grounded in a real,
already-used tool parameter, not assumed.

## 4. Issuance — one real path, one open gap named honestly

**Durable issuer keypair, operational security**: the private half lives
in **GCP Secret Manager**, following this repo's own hard-won, documented
discipline for exactly this class of secret (root `CLAUDE.md`'s npm
publish signing-key handling: never printed, never logged, read
transiently via `gcloud secrets versions access` piped directly into the
consuming process, `--stdin-key`-style, destroy-and-rotate on any
suspected exposure). Only one small, separately-reviewable
`credential-issuer` module ever holds signing capability; every verifying
function only ever needs the **public** key (`admittedIssuerKeys`, §2),
which is safe to embed/distribute broadly, matching `AdmittedPeerRegistry`'s
own design (`radio-moe`'s `dist/transport.d.ts`, §0).

**Issuance for `kind: 'agent'` OrgMembers — solved, chains off a real,
already-verified event**: immediately after `acceptClaimHandoff` succeeds
inside `applyApprovalTransition`'s existing choreography
(`AUTHORIZATION.md` §8 step 1) — a genuine, already-verified fact (ruflo's
claims system independently confirmed nothing else is pending for that
claimant) — the `credential-issuer` mints an `ActorCredential` bound to
that call's `orgMemberId` and hands it back to the calling session for the
*rest of that same flow* (e.g., threaded into `persistIssue`'s Guard C
instead of a bare `actor`, §5). This chains trust from a real event instead
of asking an autonomous agent to "log in" — there's no interactive step for
it to perform.

**Issuance for `kind: 'human'` OrgMembers — NOT solved here, named
honestly rather than papered over.** The tempting shortcut is reusing
`federation_bbs_human_join`'s existing Ed25519-signed, single-use, TTL'd
token — but that token proves *room access* (ADR-164 §3.2.4), a different
scope than "this human controls this ruClip `OrgMember` identity." Claiming
it doubles as `ActorCredential` would repeat exactly the mistake this
project already corrected once (forcing a real primitive into a job its
real scope doesn't cover — `HEARTBEATS-AND-COMMS.md` §0 Finding D). A
genuine human-issuance path requires an actual login/authentication flow —
SSO, a dashboard session, a CLI auth command — that **does not exist
anywhere in ruClip today** (Phase 2's dashboard, still unbuilt, is the
natural home for it). Building a full identity-provider integration is its
own project, out of scope for a "design the missing primitive" task.

**Decided (2026-09-01, team-lead): option (a), block.** Until real human
credential issuance exists (Phase 2's dashboard/auth), any call where the
resolved `OrgMember.kind === 'human'` and no valid `ActorCredential` is
presented is refused outright — `ActorIdentityVerificationError`, no
fallback to the weaker pre-existing check. No approval decision, comms-room
registration, heartbeat action, or consent change can be attributed to a
human actor until real issuance ships. Fail closed for humans specifically,
not just a documented risk — matching the fail-closed discipline this
domain has held throughout. Costs nothing functionally today: there is no
dashboard/login flow for a human to exercise any of these four paths
through yet anyway, so blocking changes no currently-working behavior.

**Structural consequence, recorded so it isn't rediscovered as a surprise**:
this makes real human authentication/login a **hard prerequisite for
Phase 2 (dashboard)**, not something to design later — `docs/PLAN.md`'s
Phase 2 entry now states this explicitly. Phase 2's own design doc, when
written, must solve human credential issuance as its first concern, the
same way this document solved agent issuance via `claims_accept-handoff`
succeeding.

## 5. Retrofit — the four call sites

Every function below drops its `actor: OrgMember` parameter for
`credential: ActorCredential`, calls `verifyActorCredential` as its
literal first line, and recalls the `OrgMember` fresh via `recallOrgMember`
using the verified `orgMemberId` for anything else it needs:

1. **`applyApprovalTransition`** (`store/agentdb-adapter.ts`) — `actor:
   OrgMember` → `credential: ActorCredential`. The self-approval invariant
   in `transitionApprovalState` (`approval/transition-approval-state.ts`)
   now compares the *verified* `orgMemberId` against
   `previousTransition.actorId`, closing the exact bypass security named:
   a caller can no longer name a *different* `actor.id` than the one their
   credential was actually issued for, because the credential's
   `orgMemberId` was fixed at issuance time by the trusted issuer, not
   chosen by the presenter.
2. **`persistIssue`'s Guard C** (`store/agentdb-adapter.ts`) —
   `authorization?: { actor: OrgMember }` → `authorization?: { credential:
   ActorCredential }`. The self-approval re-check against the *persisted*
   submit transition now compares verified identities on both sides, not
   one verified (status, already fixed) and one not (the id itself).
3. **Comms-room registration / human-join minting**
   (`comms/agentbbs-notification-channel.ts` and wherever it's called on
   an OrgMember's behalf) — the caller must present a valid credential for
   the OrgMember the room/token is being registered/minted for.
4. **Heartbeat schedule create/pause/resume**
   (`authorization/claims-authorization.ts`'s `verifyActorHoldsClaim`
   reused by heartbeat persistence) — `verifyActorHoldsClaim` itself stays
   as the *claim-ownership* check (a different, still-valid question); a
   `verifyActorCredential` call is added *before* it, so the full chain
   becomes "verify the caller really is this OrgMember, then verify that
   OrgMember holds the claim" instead of just the second half.
5. **`EmployeeInteractionProfile` consent** (`employee-augmentation/interaction-profile.ts`) —
   the most exposed site (bare equality check, no claims involvement at
   all) becomes `setInteractionProfileConsent(companyId, orgMemberId,
   signalTypes, credential: ActorCredential, config?)`, verifying the
   credential resolves to `orgMemberId` itself (self-service invariant
   preserved, now cryptographically, not just by object-equality
   convention).

## 6. What this closes vs. what remains open

**Closes**: the specific bypass security found — forging a *different*
`actor.id` than your own to approve/reject an issue you submitted, or to
set consent/register comms/create heartbeats on someone else's behalf —
for every `kind: 'agent'` OrgMember, immediately, chaining off the
already-real `claims_accept-handoff` event.

**Remains open, named not hidden**:
- Human issuance (§4) — resolved as "block" (decided), but the actual
  issuance mechanism itself is still unbuilt; blocking is a fail-closed
  placeholder, not a solution. Real human credential issuance is now a
  named prerequisite for Phase 2.
- `radio-moe` becomes a hard runtime dependency for this mechanism — worth
  confirming that's an acceptable posture given its "research-prototype"
  status (`ADR-0001` amendment 7a), separately from its already-accepted
  optional role in notifications.
- This is still not a network-authenticated boundary — it's a
  signed-credential layer inside a single-trust-domain library. A future
  real service boundary (Phase 2 dashboard backend) would be the more
  standard place for this, and could eventually verify credentials once
  centrally rather than at every function; this design is the achievable
  interim step given today's actual architecture, not the final state.
- Credential *revocation* before natural expiry (e.g. an OrgMember is
  deactivated mid-credential-lifetime) isn't designed here — the short
  (15 min) TTL bounds the exposure window, but an explicit revocation list
  is a reasonable future addition, not built this slice.

## 7. What Phase (coder) implements

Decision locked (§4) — ready to implement:

- `src/control-plane/authorization/actor-credential.ts` —
  `ActorCredential`, `ActorIdentityVerificationError`,
  `actorCredentialFrame`, `verifyActorCredential` (§2), the nonce-replay
  check (§3).
- `src/control-plane/authorization/credential-issuer.ts` — the
  agent-issuance path (§4), GCP Secret Manager key handling following the
  root `CLAUDE.md` discipline exactly (never log/persist the private
  key), `admittedIssuerKeys` resolution.
- Retrofit the five signatures in §5, and their existing tests (every
  `deps.approver`/`actor`-shaped test in `approval-gate.test.ts`,
  `claims-authorization.test.ts`, `interaction-profile` tests needs a
  credential fixture instead of a bare `OrgMember`).
- New tests: a forged-`orgMemberId` credential is rejected (wrong
  signature), an expired credential is rejected, a replayed nonce is
  rejected, an unadmitted issuer key is rejected even with an internally
  valid signature, a `kind: 'human'` `OrgMember` is refused on all four
  call sites regardless of what's presented (the locked "block" decision,
  §4 — no fallback path should exist in the code to fall back to), and —
  the regression test that matters most — the exact scenario security
  found (approve/reject with a credential for a *different* `orgMemberId`
  than the one that submitted) is now blocked.
- `docs/PLAN.md`'s Phase 2 entry now names real human authentication/login
  as a hard prerequisite (added alongside this design) — no code action
  needed for that here, just keeping it in mind that this slice is why
  that dependency exists.
- Full pipeline (coder → tester → security → reviewer) once implemented,
  given what's at stake.

Please implement verbatim — if the `radio-moe` hard-dependency posture
changes anything materially during implementation, that's a signal to come
back to this document and me, not to decide it silently.
