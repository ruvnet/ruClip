# Human Credential Issuance — Producer (Phase 2b)

Status: design (pending coder handoff)

`docs/design/HUMAN-CREDENTIAL-ISSUANCE.md` built the consumer side of human
`ActorCredential` issuance — `HumanIdentityAttestation`,
`verifyHumanIdentityAttestation`, `mintHumanActorCredential` — and named its
own open item precisely: **"No producer of `HumanIdentityAttestation`
exists yet."** This document is that producer. It is scoped by
`ADR-0001` point 5 and `docs/PLAN.md`'s Phase 2b entry: "a real auth
mechanism outside Artifacts entirely, the Cloud Run fallback ADR-0001 point
5 already anticipated." It does not touch the Phase 2a dashboard or its own
still-open viewer-identity question (`RUCLIP-DASHBOARD.md`) — that is a
separate, still-deferred surface.

## 0. Ground truth checked before designing this

1. **`cognitum-one/slack`'s identity resolution is real but not exportable
   to ruClip.** Read directly (via `gh api`, private-repo read access): all
   20 ADRs. ADR-0002/ADR-0015 confirm a mature, already-shipped Slack
   `user_id` → verified `@cognitum.one` mailbox → `Employee` role
   resolution, single-resolution-point discipline hardened by a real
   production incident. ADR-0016 confirms it already calls
   `autogenous-service` via a dedicated runtime service account with named
   `roles/run.invoker` grants — the exact per-service IAM-scoping precedent
   this design reuses below. **No mechanism exists anywhere in that repo to
   export a signed identity attestation to an external consumer.** That repo
   is owned by a different team and is out of this phase's scope to modify.
   This ruled out "Cognitum Slack identity is the Phase 2b producer" as the
   default assumption `human-identity-attestation.ts`'s own header comments
   float ("the intended attester for Cognitum's own deployment") — it is a
   plausible *future* attester, not something that exists to build against
   today.
2. **`OrgMember.identityRef`'s own doc comment is already provider-agnostic**
   (`schema/org-member.ts`: "For kind: 'human' — a claims/BBS identity
   string") — nothing in the schema assumes Slack specifically. Switching the
   producer to a different verified-identity source is a value-convention
   change (`slack:U0BQJNHH7L3` → `google:ruv@ruv.net`), not a schema change.
3. **`autogenous-client.ts`'s header comment is real, empirically-confirmed
   prior art for exactly the auth mechanism this design needs**: a
   `--no-allow-unauthenticated` Cloud Run service, called with a bearer OIDC
   identity token from `gcloud auth print-identity-token` (bare, no
   `--audiences` — that flag combination was tried and **errors** for a
   plain user account: "Invalid account type for `--audiences`. Requires
   valid service account."). Cloud Run's IAM invoker check authorizes by
   caller identity, not by matching the token's audience claim to the
   service URL. This design reuses that confirmed command/flag combination
   rather than re-deriving it.
4. **`credential-issuer.ts`'s GCP Secret Manager discipline is the reusable
   pattern for every new secret this design introduces**: read transiently
   via `execFile('gcloud', [...])` (argument array, never a shell string),
   never logged, never written to disk, no hardcoded secret name/project —
   env vars name where to look, with an explicit test/dev override that
   bypasses the shell-out entirely.
   - **Correction (implementation round 2, live deployment, 2026-09-02)**:
     this pattern is correct for `credential-issuer.ts`'s OWN callers (this
     repo's dev/CI/publish environment, which has `gcloud` on `PATH`) but
     does NOT work inside `ruclip-attester` itself — deploying to the real
     Cloud Run service produced `spawn gcloud ENOENT`, confirmed via the
     service's own logs: the `node:20-slim` container has no `gcloud` CLI
     installed at all. `identity-map.ts`/`signing-key.ts` (§2/§3.2 below)
     were fixed to use the official `@google-cloud/secret-manager` client
     library instead (Application Default Credentials — the service's own
     runtime service account, automatically, no CLI needed). This is a
     genuine gap in this design doc's own §0.4/§2/§3.2 assumption, not
     something the coder should have caught without deploying — a design
     doc reusing `credential-issuer.ts`'s pattern by name didn't account
     for the two modules running in structurally different environments
     (a dev/CI shell with `gcloud` vs. a minimal server container without
     it). `credential-issuer.ts` itself is unaffected — its own callers
     still have `gcloud` available.
5. **No admin/company-owner concept exists in the schema today.** Checked
   `schema/org-member.ts`, `schema/company.ts`, `schema/enums.ts` directly:
   `OrgMember.role` is a free-form `string` (no capability semantics),
   `OrgMemberStatus` is just `active|inactive`, and the only structural
   hierarchy signal is `managerId: null`, reserved for "the single root
   member." There is no `isOwner`/`isAdmin` flag, and no existing
   authorization primitive a self-service "let the company owner manage
   their own identity mappings" feature could hang off without inventing
   new schema *and* a new authority-bearing write path — see §3.4 for why
   that is explicitly deferred rather than designed now.
6. **No CLI entry point exists anywhere in this repo yet** (`find src
   -iname '*cli*' -o -iname '*bin*'` returns nothing outside
   `governance`/`store`; no `bin` field in `package.json`). This phase
   introduces the first one. Flagged plainly since it is new surface area,
   not a small addition to something already there.

## 1. Team-lead's governance requirement (load-bearing, drives §3)

> "The mapping from Google identity → `OrgMember.identityRef` is now THE
> critical security boundary — whoever can add an entry to that mapping can
> effectively grant someone the ability to act as a specific human
> employee... figure out: who's allowed to create/edit a mapping entry, and
> how is THAT authenticated... don't let 'add a new human identity mapping'
> itself be an unguarded write."

§3 is the answer. The short version: **v1 has no write path for the mapping
at all.** It is a static, deploy-time artifact; changing it requires the
same GCP IAM authority already trusted with this repo's other durable
secrets. This isn't a narrowed version of a runtime admin feature — there
is no runtime admin feature, on purpose, because building one correctly
needs a real owner/admin schema concept (§0.5) that does not exist yet, and
inventing one under this phase's scope would be exactly the kind of
speculative, unreviewed authority-bearing surface this repo's own discipline
avoids.

## 2. Architecture

A new, minimal, standalone Cloud Run service — `ruclip-attester` — sitting
entirely outside ruClip's existing control-plane code, matching
`autogenous-service`'s own relationship to this repo (a separate deployed
service ruClip's code calls as a client, not code that runs inside ruClip's
own process).

```
human (already has a real Google/Workspace session via `gcloud auth login`)
   │
   │ 1. gcloud auth print-identity-token   (bare — §0.3)
   ▼
┌─────────────────────────────┐
│  ruclip login  (new CLI)     │
└──────────────┬───────────────┘
               │ 2. POST /v1/attest
               │    Authorization: Bearer <google-id-token>
               ▼
┌───────────────────────────────────────────┐
│  ruclip-attester (Cloud Run,                │
│  --no-allow-unauthenticated)                │
│                                              │
│  a. Cloud Run IAM invoker check              │  ← layer 1: is this
│     (grants: a Google Group of real           │     caller a real
│     ruvnet human employees — §3.1)            │     ruvnet identity?
│                                              │
│  b. App-level: re-verify the SAME ID token   │
│     against Google's JWKS, require            │  ← §4, defense in
│     email_verified === true, extract email    │     depth, not redundant
│                                              │
│  c. Look up email in the identity-mapping    │  ← layer 2: is THIS
│     secret (read-only at runtime — §3)        │     specific person bound
│                                              │     to an OrgMember?
│  d. Sign a HumanIdentityAttestation with      │
│     the attester's OWN Ed25519 keypair        │
│     (radio-moe attestationFrame/signFrame,    │
│     distinct key from ruClip's issuer key)    │
└──────────────┬───────────────────────────────┘
               │ 3. HumanIdentityAttestation (JSON)
               ▼
┌─────────────────────────────┐
│  ruclip login  (continued)   │
│  4. mintHumanActorCredential  │  ← already shipped, unchanged
│     (local call, or via       │
│     ruClip's own bridge)      │
└──────────────┬───────────────┘
               │ 5. ActorCredential (15 min TTL)
               ▼
       stored for this CLI session's
       remaining ruClip calls
```

Two keys, two secrets, kept structurally separate (mirrors
`AttesterKeyConfig` already being a distinct type from `IssuerKeyConfig` in
the shipped consumer code):

- **Attester signing key** (`ruclip-attester-signing-key`, Secret Manager) —
  the private half of `attesterPublicKeyDerHex`; only `ruclip-attester`'s
  own Cloud Run service account can read it.
- **ruClip's issuer key** (`RUCLIP_ISSUER_SIGNING_SECRET`, already named in
  `credential-issuer.ts`) — unchanged, still only used by whatever process
  calls `mintHumanActorCredential`/`mintActorCredential`.

## 3. The identity-mapping governance boundary

### 3.1 Layer 1 — Cloud Run IAM invoker (who can call the service at all)

`ruclip-attester` is deployed `--no-allow-unauthenticated`.
`roles/run.invoker` on this one service (never project-wide — same
per-service-grant discipline `cognitum-one/slack` ADR-0016 already
established, and root `CLAUDE.md`'s own signing-key precedent) is granted to
a Google Group representing real ruvnet human employees, not to individual
principals one at a time. Managing that group's membership is **not** a
mechanism this design invents — it is deferred to whatever already manages
ruvnet's Google Workspace/GCP org membership, the same "third-party
identity source" carve-out `ADR-0001` amendment 7b already drew for
calendar/email/meeting-recorder signals. This layer answers "is the caller
some real ruvnet person," not "which OrgMember are they."

### 3.2 Layer 2 — the identity-mapping secret (who they're allowed to act as)

The mapping — Google email → `{orgMemberId, companyId}` — lives as JSON in
a **second**, independently-scoped Secret Manager secret,
`ruclip-attester-identity-map`:

```json
{
  "ruv@ruv.net": { "orgMemberId": "om-ceo-001", "companyId": "company-ruclip-001" }
}
```

`ruclip-attester`'s own runtime code only ever **reads** this secret (same
`execFile('gcloud', ['secrets', 'versions', 'access', ...])` discipline as
`credential-issuer.ts`'s key read — argument array, never logged, never
persisted to disk, resolved fresh per cold start / on a short in-memory TTL,
not cached indefinitely). **There is no HTTP endpoint, on this service or
anywhere else in ruClip, that writes to this secret.** The only way to add,
change, or remove a mapping entry is `gcloud secrets versions add
ruclip-attester-identity-map ...` — which requires
`roles/secretmanager.versions.add` (or broader) on that one named secret,
granted narrowly, mirroring exactly how the npm-publish signing key and
`RUCLIP_ISSUER_SIGNING_SECRET` are already scoped in this repo. This is the
concrete answer to team-lead's requirement: **"who's allowed to add a
mapping entry" is identical to "who already holds deploy/secret-edit
authority over this repo's GCP project"** — a real, pre-existing, audited
IAM boundary, not a new bespoke one invented for this feature, and it fails
closed by construction (no write code path exists to have a bug in) rather
than by a runtime check that could be wrong.

### 3.3 What this buys, and what it costs

**Buys**: the single highest-consequence action in this whole design — "who
can grant impersonation of a specific human employee" — has exactly the
same blast radius and exactly the same set of trusted principals as this
repo's other durable secrets already do. No new class of privileged actor
is created. A compromised `ruclip-attester` Cloud Run *deploy* (not just the
running service) would be required to alter it, same as compromising the
npm-publish pipeline would be required to ship a malicious release.

**Costs**: onboarding a new human employee is a `gcloud secrets versions
add` operation by whoever already holds that authority, not a self-service
flow. For ruClip's actual current scale (a small, ruvnet-only team) this is
the right v1 trade-off; §3.4 names the real follow-on.

### 3.4 Explicitly deferred, not designed here

A self-service "company owner adds a new mapping entry through the product"
flow would need, at minimum: (a) a real `OrgMember` owner/admin concept in
the schema (§0.5 confirmed none exists — not even the root-member convention
carries authority semantics today, only hierarchy), and (b) a mapping-write
path itself authorized by a verified `ActorCredential` belonging to that
owner — which is circular with this very phase's bootstrap problem (you'd
need a credential to grant credentials) unless deliberately broken with its
own review pass. Not designed here, consistent with this repo's standing
discipline against building speculative future authority surface ahead of
being asked.

## 4. `/v1/attest` — request/response, and why the token carries the identity

`POST /v1/attest` takes **no body** — only `Authorization: Bearer
<google-id-token>`. The server never accepts a client-supplied
`orgMemberId`/`companyId`/email; it derives all three unilaterally from its
own trusted lookup. This closes an entire class of confusion/attack by
construction: a caller has no way to *ask* for an attestation naming a
different OrgMember than the one their own verified Google identity maps
to, because the request has no field to say so in the first place.

Handler steps:

1. Extract the bearer token from `Authorization`.
2. **Independently verify it against Google's own JWKS** (signature,
   issuer, expiry). This is a deliberate second check, not redundant with
   Cloud Run's own platform-level IAM invoker check from §3.1: Cloud Run's
   IAM decision answers "is this caller authorized to invoke the service,"
   but the caller's actual identity claims (the `email` field specifically)
   are only available to the app if it independently decodes/verifies the
   same token itself — **flagged for the coder to confirm empirically
   against the real deployed service** (same discipline
   `autogenous-client.ts`'s header comment used to correct the
   `--audiences` assumption in §0.3), since this is standard, documented
   Cloud Run/OIDC behavior but had not been directly tested when this
   section was first written.
   - **Correction (implementation, 2026-09-01)**: this step's original text
     said `aud` should be checked against "this service's own OAuth
     client/service context." That is not achievable with the bare
     `gcloud auth print-identity-token` command §0.3/§5 both specify: the
     coder found, by reading `google-auth-library`'s real source, that
     such a token's `aud` claim is Google's own fixed gcloud-CLI OAuth
     client id, not this service's URL — requiring it would reject every
     real login. `google-token.ts` deliberately omits the `audience` check
     for this reason, relying on Cloud Run's own IAM invoker check (§3.1)
     as the actual per-service authorization boundary; this layer's job is
     narrowed to "extract a reliable, signature-verified `email` claim from
     an already-Cloud-Run-authorized request." Consistent with the
     `--audiences` finding already established for `autogenous-client.ts`
     — not a new risk, the same trade-off already accepted for that
     service.
   - **Correction #2 (live deployment, 2026-09-02) — this step's "verify
     against Google's own JWKS" premise was also wrong, confirmed via a
     real, isolated, deployed-then-deleted echo service, not inferred**:
     Cloud Run's front-end DOES forward the `Authorization` header to the
     container (closing this step's own flagged-open question above), but
     it replaces the forwarded JWT's signature segment with the literal
     string `SIGNATURE_REMOVED_BY_GOOGLE` first. Cryptographic
     verification against Google's JWKS is therefore structurally
     impossible on the real deployed path — the earlier "confirmed LIVE"
     local test (PLAN.md, round 1) was testing a genuine, un-proxied
     Google token, a different code path than any real production
     request. Team-lead's resolved decision: this is Cloud Run's own
     standard, documented pattern for `--no-allow-unauthenticated`
     services — the platform's IAM invoker check (§3.1) already IS the
     authentication boundary; the forwarded, redacted token exists so app
     code can read identity claims, not re-verify them. `google-token.ts`
     now decodes the payload without cryptographic verification, plus
     structural sanity checks (exactly 3 dot-separated segments, `iss`
     exactly `accounts.google.com`/`https://accounts.google.com`, `exp`
     in the future if present) in place of signature verification —
     documented in the file's own header as a deliberate, understood
     choice, not a gap.
   - **Correction #3 (2026-09-02) — decode-without-verify itself was a
     real, complete identity-impersonation exploit, not just a documented
     trade-off**: `ruclip-tester` demonstrated concretely (not just in
     prose) that decode-only verification checks a JWT-shaped token's
     segment count, never its content — a completely fabricated token
     (never touched by Google) was accepted and minted a real, validly-
     signed `HumanIdentityAttestation` for an attacker-chosen identity,
     with no misconfiguration required. `ruclip-security` escalated rather
     than signed off, verified against Google's own documentation, and
     recommended Identity-Aware Proxy (IAP) as the real fix; team-lead
     authorized it in two steps (code first through the full pipeline,
     live IAP enablement second, as a separate dedicated task). This
     REPLACES Correction #2's decode-without-verify design entirely:
     `google-token.ts` now performs real ES256 cryptographic verification
     of the `x-goog-iap-jwt-assertion` header — a channel IAP itself signs
     and Cloud Run's proxy never touches or redacts, unlike the old
     `Authorization` header — against IAP's own published public keys
     (`OAuth2Client#getIapPublicKeysAsync()`/`#verifySignedJwtWithCertsAsync()`,
     confirmed against the real installed `google-auth-library@10.9.1`
     source, not a docs sample). The 3-segment/`iss`/`exp` structural
     sanity checks from Correction #2 are gone — this is real signature
     verification, not decode-plus-heuristics. IAP's JWT has no
     `email_verified` claim (unlike a classic Google Sign-In ID token); a
     cryptographically-verified IAP `email` claim now maps to
     `emailVerified: true` unconditionally, documented as a deliberate
     mapping, not an observed value. Step 2 — enabling IAP on the live
     service and confirming the real project number for
     `RUCLIP_ATTESTER_IAP_AUDIENCE` — has not happened yet; the identity-
     mapping secret stays empty (hard gate) until it does.
3. Require `email_verified === true` on the token's claims (mirrors
   `cognitum-one/slack`'s own cited discipline of requiring a *verified*
   mailbox, not just workspace membership). **Stale after Correction #3**:
   IAP's JWT carries no `email_verified` claim to check — the handler's
   `emailVerified` gate is still present but now vestigial, since
   `google-token.ts` only ever returns `true` for a cryptographically-
   verified token (see Correction #3). The real "is this email verified"
   guarantee now comes from IAP's own signature check, not this field.
4. Look up `email` in `ruclip-attester-identity-map` (§3.2). Not found →
   `403`, generic message ("no verified employee mapping for this
   identity") — no `orgMemberId`/`companyId` values leaked either way.
5. Build and sign a `HumanIdentityAttestation` (existing
   `attestationFrame`/`signFrame` shape, unchanged) with
   `humanIdentityRef: `google:${email}`` and the mapped `orgMemberId` /
   `companyId`, `expiresAt` = now + 15 min (matches the consumer's own
   `DEFAULT_TTL_SECONDS`), a fresh `nonce`, and `attesterPublicKeyDerHex`
   set to this service's own public key.
6. Return the attestation JSON. `mintHumanActorCredential` (unchanged,
   already shipped) is the very next call the CLI makes — see §5.

No AgentDB / `bridge-client.ts` call happens inside `ruclip-attester`
itself — it is a pure signer over a static, deploy-time mapping. The
existing nonce-replay guard for the resulting `HumanIdentityAttestation`
still lives where it already does, inside
`verifyHumanIdentityAttestation` (unchanged).

## 5. `ruclip login` — the CLI, end to end

New, minimal CLI entry point (first one in this repo — §0.6):

1. `gcloud auth print-identity-token` (bare, per §0.3's confirmed finding —
   **not** `--audiences=<attester-url>`, which errors for a plain user
   account exactly as `autogenous-client.ts`'s header already documents for
   the sibling case).
2. `POST <RUCLIP_ATTESTER_URL>/v1/attest` with that token as the bearer.
   Non-200 (not mapped, expired session, network failure) surfaces a clear,
   fail-closed error — no partial/best-effort credential is ever produced.
3. On success, calls the existing, unmodified `mintHumanActorCredential`
   with the returned attestation and this deployment's
   `admittedAttesterKeys` (`ruclip-attester`'s public key — safe to
   distribute, matching how `resolveAdmittedIssuerKeys`'s public key is
   already handled).
4. Holds the resulting `ActorCredential` for the remainder of this CLI
   invocation/session. Given its 15-minute TTL (unchanged from the existing
   design), this is a "log in immediately before you need to act" flow, not
   a long-lived session token — consistent with the short-TTL trade-off
   `ACTOR-IDENTITY-VERIFICATION.md` already accepted for `ActorCredential`
   itself.

This deliberately does **not** build a browser-based OAuth consent flow.
Team-lead's framing ("reusing gcloud identity instead of building new OAuth
is the right call") is realized literally: the human's existing,
already-authenticated `gcloud` session is the entire identity source: no
new credential type for the human to manage, no new consent screen, no
redirect URIs to secure.

## 6. Threat model (additions specific to this new component)

- **Attester signing-key compromise** → same blast radius as
  `credential-issuer.ts`'s issuer-key compromise already accepted (mint
  attestations/credentials for any mapped identity) — same GCP Secret
  Manager mitigation already in use, independently scoped key (§2).
- **Identity-mapping secret compromise or malicious edit** → misdirects
  which real person can act as which `OrgMember`. Mitigated by §3.2's
  narrow, per-secret IAM grant — the same principals already trusted with
  this repo's other durable secrets, not a broader set.
- **Google ID token forgery** → covered by standard JWKS signature
  verification (§4 step 2); not something this design invents cryptography
  for.
- **A human's own Google/`gcloud` session being phished or stolen** → same
  blast radius their existing Google Workspace credentials already carry
  everywhere else in their job; not a new risk this design introduces. Not
  mitigated further here (out of scope — this is a property of Google's own
  account security, not ruClip's).
- **Two OrgMembers sharing one Google identity** → structurally prevented:
  the mapping is one email → one `{orgMemberId, companyId}` pair, and
  `mintHumanActorCredential`'s own existing binding check (§4 of the
  original design) still cross-verifies the attestation's
  `humanIdentityRef` against the target `OrgMember`'s persisted
  `identityRef` before minting anything.
- **Anonymous/unauthenticated calls to `/v1/attest`** → blocked at Cloud
  Run's own IAM layer (§3.1) before the request ever reaches app code,
  same posture as `autogenous-service`'s own `--no-allow-unauthenticated`
  deployment.

## 7. What this closes vs. what remains open

**Closes**: Phase 2b's own prerequisite, narrowed precisely by
`HUMAN-CREDENTIAL-ISSUANCE.md` §5 to "produce one signed statement" — a
real, narrowly-authorized producer now exists for `HumanIdentityAttestation`,
with the identity-mapping write boundary designed explicitly per team-lead's
requirement (§3), not glossed over.

**Remains open, named not hidden**:

- Self-service mapping management (§3.4) — deferred, needs real
  owner/admin schema work first.
- `setInteractionProfileConsent`'s residual `actor.id` forgery risk
  (`ACTOR-IDENTITY-VERIFICATION.md` §4's narrowed exception) — unchanged by
  this phase, still tracked as a pre-existing accepted gap.
- Credential/attestation revocation before natural TTL expiry — still not
  designed, same accepted trade-off as the original design (short TTL
  bounds exposure).
- ~~The Cloud Run app-level identity-forwarding behavior noted in §4 step
  2~~ — **CLOSED (2026-09-02), confirmed live**: Cloud Run does forward
  the `Authorization` header, but redacts the JWT signature first. See
  §4 step 2's Correction #2 for the full finding and the resulting design
  change (decode-without-verify, not JWKS verification).
- **Still genuinely open**: the service's runtime service account
  (`875130704813-compute@developer.gserviceaccount.com`, the default
  compute SA — no dedicated one provisioned yet) has not been granted
  `roles/secretmanager.secretAccessor` on either
  `ruclip-attester-signing-key` or `ruclip-attester-identity-map` — a real
  IAM change on a live GCP project, correctly not made unilaterally by
  either the coder or this document. Full end-to-end live verification (a
  real `200` with a signed attestation) is blocked on this grant. The
  already-tracked "no dedicated service account with `roles/run.invoker`"
  item (§3.1) should be folded into the same IAM change — one new service
  account, both grants — rather than patching the default compute SA
  piecemeal.
- **Still genuinely open (2026-09-02) — IAP step 2**: enabling IAP on the
  live `ruclip-attester` service (granting IAP's service agent
  `roles/run.invoker`, granting real users `roles/iap.httpsResourceAccessor`)
  and confirming the real `RUCLIP_ATTESTER_IAP_AUDIENCE` value (the
  service's actual project number) against a genuinely IAP-issued JWT —
  see §4 step 2's Correction #3. Not started. The identity-mapping secret
  stays empty (hard gate, team-lead) until this step verifies working
  end-to-end on the live service, not just in code review.
- Phase 2a's own separate open question (no exportable Claude Artifact
  viewer identity — `RUCLIP-DASHBOARD.md`) is unaffected by this phase;
  the dashboard's own write-action auth story, if it ever needs one beyond
  what 2a already scoped as read-only, would be a distinct future piece of
  work, not solved by `ruclip login` being CLI-only.
