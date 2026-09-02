# Autogenous runtime governance (Phase 4)

Status: design, ready for review. Implements `ADR-0001` amendment 7a and
`docs/PLAN.md` §8 Phase 4 — Autogenous's antibody/canary/rollback model as
ruClip's runtime governance layer. Grounded entirely in the real
`ruvnet/autogenous` repository (`gh api`, reading actual Rust source, not
README prose) — no npm/WASM binding exists, but a real, purpose-built HTTP
service does, and this document designs ruClip's TypeScript client against
its actual route/type contracts.

## 0. Investigation summary (already reported, restated for the record)

- No npm/WASM binding: `packages/` in `ruvnet/autogenous` contains only
  `radio-moe` (already integrated, `HEARTBEATS-AND-COMMS.md`). No
  `@autogenous/*` npm scope exists (checked directly, every likely name
  404s). No compiled CLI binary either — the sole GitHub release
  (`radio-moe-v0.3.1`) ships zero assets.
- `crates/service` builds `autogenous-service`, a real, complete Rust HTTP
  API (axum) wrapping the actual `agl-types`/`promotion`/`envelope`/
  `constitution`/`antibody`/`evaluator`/`witness` crates — read the entire
  handler source (`crates/service/src/main.rs`), not just route names. The
  repo ships a Dockerfile purpose-built for Cloud Run
  (`cargo build --release -p autogenous-service`, `$PORT` convention).
  Team-lead is deploying this to `ruv-dev` in parallel; this document
  designs against the documented contract, to be pointed at the real URL
  once live.

**Live, 2026-09-02**: deployed to Cloud Run (`ruv-dev`),
`https://autogenous-service-875130704813.us-central1.run.app` —
`--no-allow-unauthenticated` (confirmed 403 anonymous), `/v1/judges/keys`
confirmed returning real production keys distinct from the DEV seed
fallback (§2's `main.rs` reading already showed the DEV-key path is a
deliberate, logged fallback — this confirms production keys are actually
pinned, not silently defaulting). Every call needs an OIDC identity token
(`gcloud auth print-identity-token` with this URL as the audience, or
equivalent) — there is no anonymous path. **Outstanding, not blocking
today's verification**: ruClip's own backend has no GCP service account
yet with `roles/run.invoker` on this service — the deployment agent
correctly flagged this rather than deciding it unilaterally (same OIDC
pattern already tracked for the AgentDB bridge, `ruvnet/ruClip` issue #1).
`autogenous-client.ts` (§3/§7) should accept an injectable token-provider
function (mirroring `fetchImpl`'s injection pattern) rather than assuming
`gcloud` is always on the caller's `PATH` — production wiring of that
service account is a concrete next step, tracked here, not designed
further in this document.

## 1. The real API surface (every shape read from source, not assumed)

Base routes (`crates/service/src/main.rs`'s `Router::new()`):

| Method | Path | Handler | Purpose |
|---|---|---|---|
| GET | `/health`, `/status` | `health` | Liveness + the five Autogenous planes |
| POST | `/v1/agl/admit` | `agl_admit` | Typed-mutation admission (ADR-392 §6) |
| POST | `/v1/agl/fitness` | `agl_fitness` | Hard-gate check in isolation |
| POST | `/v1/canary/new` | `canary_new` | Start a staged rollout |
| POST | `/v1/canary/observe` | `canary_observe` | Feed one fitness measurement, get the next decision |
| GET | `/v1/judges/keys` | `judges_keys` | The service's judge/controller public keys, for constitution pinning |
| POST | `/v1/judges/evaluate` | `judges_evaluate` | Originate signed evaluation receipts (needs a `Constitution` + labeled corpus) |
| POST | `/v1/promote` | `promote` | Verify signed receipts, finalize a 100%-healthy canary |

**Scope decision for this design (§5 explains why): v1 wires
`/v1/agl/admit`, `/v1/agl/fitness`, `/v1/canary/new`, `/v1/canary/observe`
only.** `/v1/promote` and `/v1/judges/evaluate` both require a
`Constitution` document — a durable, externally-authored governance
artifact (`identity`, `version`, `authority_ceiling`,
`prohibited_effects`, `hard_gates`, `signers`, `pinned_keys`,
`effective_at`, real fields from `crates/constitution/src/lib.rs`) that
ruClip does not have yet and authoring one is a governance decision, not a
code task — a natural, explicitly-scoped Phase 4b, not guessed at here.

## 2. Core types — exact field names, exact wire shapes, read from source

**Critical implementation note, stated once here so it isn't relearned per
field**: none of the structs below carry `#[serde(rename_all = "camelCase")]`
— every field name below is the **literal Rust field name**, which serde's
default behavior serializes verbatim. **Do not camelCase these when
building request bodies** — `parent_genome_hash`, not `parentGenomeHash`.

### 2.1 `Authority` / `MutationScope` — snake_case string enums

Both carry `#[serde(rename_all = "snake_case")]` (confirmed in
`crates/agl-types/src/lib.rs`), so their JSON form is the snake_case
variant name:

```typescript
export type Authority =
  | 'observe_only' | 'simulate_only' | 'auto_reversible'
  | 'governed' | 'constitutional';
// Strictly ordered (Rust PartialOrd/Ord derive): observe_only < simulate_only
// < auto_reversible < governed < constitutional. A mutation's
// requested_authority must be <= its parent Genome's capability_ceiling —
// enforced server-side (§2.4), but ruClip should never construct a request
// that would violate this, per §5's scope decision.

export type MutationScope =
  | 'prompt_context' | 'routing_budget' | 'retrieval_rerank' | 'cache_memory'
  | 'agent_topology' | 'application_code' | 'schema_migration'
  | 'security_policy' | 'compiler_ir' | 'constitutional';
// auto_promotable() (real method, agl-types) is true ONLY for the first
// four — routing_budget and cache_memory are the two this design uses
// (§5). Every scope from agent_topology up requires Authority::governed at
// minimum (MutationScope::min_authority(), same source) — ruClip's v1
// integration never requests these, by design, not by omission.
```

### 2.2 `Genome`, `HardInvariant`, `Applicability`, `Mutation`

```typescript
export interface HardInvariant {
  name: string;
  holds: boolean;
}

export interface Genome {
  hash: string;
  identity: string;
  constitution: string; // reference (hash) to the pinned Constitution
  capability_ceiling: Authority;
  hard_invariants: HardInvariant[];
  lineage: string[]; // parent genome hashes, oldest first
}

export interface Applicability {
  workloads: string[];
  environments: string[];
  jurisdictions: string[];
}

export interface Mutation {
  id: string;
  parent_genome_hash: string;
  scope: MutationScope;
  requested_authority: Authority;
  applicability: Applicability;
  preserved_invariants: HardInvariant[];
  rollback_target: string | null; // REQUIRED by the real admission check (§2.4) — irreversible mutations are inadmissible
  expires_at: number | null; // unix seconds
  signature: string | null;
}
```

### 2.3 `FitnessVector` / `HardGates`

```typescript
export interface FitnessVector {
  task_quality: number; // [0,1]
  safety: number; // [0,1]
  governance: number; // [0,1]
  reliability: number; // [0,1]
  p99_overhead_ms: number; // raw measurement, lower is better
  false_positive_rate: number; // raw measurement, lower is better
  regression_count: number; // integer
  rollback_verified: boolean;
}

export interface HardGates {
  min_safety: number;
  min_governance: number;
  max_false_positive_rate: number;
  max_p99_overhead_ms: number;
}
// Real ADR-392 §14 first-production default (Rust `impl Default`), used
// server-side when `gates` is omitted from a request:
// { min_safety: 0.99, min_governance: 0.99, max_false_positive_rate: 0.005,
//   max_p99_overhead_ms: 5.0 }
```

### 2.4 `/v1/agl/admit` — request/response, including a real handler-code nuance

```typescript
export interface AdmitRequest {
  mutation: Mutation;
  parent: Genome;
  now: number; // unix seconds — caller-supplied so the verdict is deterministic/reproducible
}

export interface AdmitResponse {
  admitted: boolean;
  error: string | null; // present only when refused
  reason: string | null; // present only when refused
}
```

**Read directly from `agl_admit`'s handler body, not inferred from the
`AdmissionError` type's own `Serialize` derive**: the response's `error`/
`reason` are **not** `AdmissionError`'s JSON serialization. The handler
calls `format!("{e:?}")` (Rust `Debug`, not `Serialize`) on the
`AdmissionError`, then extracts a short code via
`full.split([' ', '(', '{']).next()`. So for
`AdmissionError::AuthorityExpansion { requested, ceiling }`, `error` is
the string `"AuthorityExpansion"` and `reason` is the full Debug string
(`"AuthorityExpansion { requested: Governed, ceiling: AutoReversible }"` —
note: Debug output uses the **PascalCase Rust variant names for
`Authority`**, e.g. `Governed`, not the snake_case `governed` the JSON
wire format uses elsewhere — a real, easy-to-miss inconsistency between
this one string field and every other field in this API, worth a code
comment where `error`/`reason` are parsed). The seven possible `error`
codes, real (from `AdmissionError`'s variants,
`crates/agl-types/src/lib.rs`): `AuthorityExpansion`,
`AuthorityInsufficient`, `InvariantRegressed`, `ParentMismatch`,
`ConstitutionalScope`, `NoRollback`, `Expired`.

### 2.5 `/v1/agl/fitness`

```typescript
export interface FitnessRequest {
  fitness: FitnessVector;
  gates?: HardGates; // omit to use the real server-side ADR-392 §14 default
}
export interface FitnessResponse {
  passes: boolean;
  gates: HardGates; // echoes back whichever gates (supplied or default) were actually applied
}
```

### 2.6 `CanaryState` / `Decision` / `CanaryController` — externally-tagged enums

**Confirmed from source, not observed live (the service isn't deployed
yet) — flagged honestly, not silently assumed**: neither `CanaryState`
nor `Decision` carries a `#[serde(tag = ...)]` or `rename_all` attribute
in `crates/promotion/src/lib.rs`, so serde's well-documented default
applies — a struct-like variant serializes as `{"<VariantName>": {fields}}`
(externally tagged), a unit variant as the bare string `"<VariantName>"`.
This is standard, stable serde behavior, not a guess — but it has not been
confirmed against a live response from this specific service, since none
exists yet. Verify against the real deployed service before shipping;
this is exactly the kind of assumption that needs re-checking once the
URL is live (§5's own closing note).

```typescript
export type CanaryState =
  | { Serving: { stage_idx: number; healthy_observations: number } }
  | { Promoted: { signature: string } }
  | { RolledBack: { at_stage_pct: number; reason: string } };

export type Decision =
  | 'Hold'
  | { Advance: { to_pct: number } }
  | 'ReadyForPromotion'
  | { RollBack: { reason: string } };

export interface CanaryController {
  candidate_id: string;
  rollback_target: string;
  gates: HardGates;
  observations_per_stage: number;
  state: CanaryState;
  audit: string[]; // signed promotion/rollback audit records, oldest first — see §6
  consumed_nonces: string[]; // single-use replay guard, in-process only (real code comment: cross-process durability is a separate, not-yet-built item)
}

export const CANARY_STAGES = [1, 10, 50, 100] as const; // real STAGES constant, promotion crate
```

```typescript
export interface CanaryNewRequest {
  candidate_id: string;
  rollback_target: string;
  observations_per_stage?: number; // default 1 (real server-side default, `fn one() -> u32 { 1 }`)
  gates?: HardGates;
}
export interface CanaryStateResponse { controller: CanaryController; stage_pct: number | null; }

export interface CanaryObserveRequest { controller: CanaryController; fitness: FitnessVector; }
export interface CanaryObserveResponse { controller: CanaryController; decision: Decision; stage_pct: number | null; }
```

**Stateless by design, confirmed from source comment**: *"the caller
threads the `CanaryController`... the service stays a pure transform, is
durable across restarts."* ruClip owns persisting `CanaryController`
between calls — the service holds no session state. This is exactly
ruClip's own job, and exactly what §6's audit-trail design does.

## 3. HTTP client module — same discipline as `store/bridge-client.ts`

```typescript
export interface AutogenousClientConfig {
  baseUrl?: string; // defaults to AUTOGENOUS_SERVICE_URL env var; no hardcoded default — unlike bridge-client.ts's localhost:3000, this service has no "obviously local" default since it's a real Cloud Run deployment, not a sidecar
  fetchImpl?: typeof fetch;
  /**
   * Real requirement, confirmed against the live deployment: the service
   * is `--no-allow-unauthenticated` (403 confirmed anonymous), so every
   * call needs a bearer OIDC identity token with this service's URL as
   * audience. Injectable, not hardcoded to shelling out to `gcloud` —
   * ruClip's own backend has no dedicated service account with
   * `roles/run.invoker` on this service yet (tracked above, a concrete
   * next step, not designed further here); a local developer/test
   * identity can supply one via `gcloud auth print-identity-token
   * --audiences=<baseUrl>` in the meantime.
   */
  tokenProvider?: () => Promise<string>;
}

export class AutogenousClientError extends Error {
  constructor(message: string, public readonly cause?: unknown) { super(message); this.name = 'AutogenousClientError'; }
}
```

Same injectable-`fetchImpl`, same "throw a typed error on unreachability,
never silently degrade" contract `bridge-client.ts` already established —
**but fail-closed here means something specific and important**: unlike
the AgentDB bridge (whose unavailability blocks a write ruClip was already
about to make) or the notification channel (whose unavailability skips a
best-effort side-effect), `AutogenousClientError` on `/v1/agl/admit`
**must be treated as "not admitted"** — a proposed mutation with no
verdict is not a promoted one. §5 makes this the load-bearing default: no
verdict, no config-parameter change ships. Plain HTTP POST/GET with
`JSON.stringify`/`.json()` — no JSON-RPC envelope like the AgentDB
bridge's `callTool` (this service is REST, not the `tools/call` MCP
convention) — a second, real difference from `bridge-client.ts` worth
stating plainly rather than copying its request shape by habit.

## 4. Integration point — what becomes a typed AGL mutation, and what deliberately doesn't

**The load-bearing scope decision, stated once, applied consistently**:
ruClip's v1 Autogenous integration proposes **only narrow,
`auto_reversible`-authority, `routing_budget`/`cache_memory`-scoped
configuration-parameter adjustments** — never `application_code`,
`security_policy`, `schema_migration`, or `constitutional` scope. ruClip
has no self-modifying code capability and this design does not invent
one — a "mutation" here is a proposed **data-level config change**
(e.g. a budget threshold), never a code or policy-logic change. This
mirrors, exactly, `MutationScope::auto_promotable()`'s own real boundary
(agl-types, §2.1) and is the same "authority never silently expands"
discipline `ActorCredential` already holds — extending it here rather than
inventing a separate rule.

**Concrete v1 trigger, using an already-shipped signal, not a new
detector**: `checkOperatingBudget` (`HEARTBEATS-AND-COMMS.md` §4, already
shipped) already computes the 50/75/90/100% alert ladder. When it
observes a **repeated pattern** — e.g. `WARNING` or worse on 3+
consecutive heartbeat-triggered checks within a bounded window — that
pattern, not a single reading, becomes the trigger for a proposed
`Mutation`: tightening `Company.budget.hardStopThreshold` (or an
analogous operating-budget parameter) by a small, bounded amount.
Concretely:

- `parent` (`Genome`): a `Genome` record representing ruClip's *own*
  current governance-config snapshot — `hash` over the current
  threshold values, `capability_ceiling: 'auto_reversible'` (ruClip never
  grants itself more), `hard_invariants` naming the properties that must
  keep holding (e.g. `{name: 'budget-hard-stop-monotonic', holds: true}`
  — the new threshold must still be stricter than or equal to, never
  looser than, the current one). This is a new, small ruClip-side
  concept — not a literal port of Autogenous's own genome model, just
  enough structure to satisfy the real admission check.
- `mutation` (`Mutation`): `scope: 'routing_budget'`,
  `requested_authority: 'auto_reversible'`, `rollback_target`: the prior
  threshold's genome hash (**required** — §2.2's `Mutation.rollback_target`
  is `Option<String>` in Rust but the real admission check's
  `AdmissionError::NoRollback` variant confirms a missing target is
  inadmissible, so ruClip's own construction code should never omit it,
  not merely rely on the server to reject an omission).
- Submit to `/v1/agl/admit`. Not admitted → log and stop, no further
  action (§3's fail-closed contract already covers unreachability the
  same way).
- Admitted → `/v1/canary/new`, then `/v1/canary/observe` fed by
  subsequent real `checkOperatingBudget` readings translated into
  `FitnessVector` (`safety`/`governance` derived from whether the
  tightened threshold is actually preventing further alert-ladder
  breaches; `regression_count`/`rollback_verified` tracked honestly, not
  defaulted to a value that always passes).
- Reaching `Decision: 'ReadyForPromotion'` at 100% is where this design's
  v1 scope stops (§1) — promotion itself needs `/v1/promote` and a
  `Constitution`, Phase 4b. **The threshold change is not applied to
  `Company.budget` until a real `/v1/promote` success returns a
  signature** — an admitted-and-canarying mutation is not yet a promoted
  one, matching the project's "evaluation is not promotion" invariant
  throughout. Until Phase 4b ships `/v1/promote`, a `ReadyForPromotion`
  candidate simply waits, visible in the audit trail (§6), for a human or
  a later slice to finish the loop — never auto-applied.

## 5. Why this scope, not a broader one

- Every mutation this design proposes is reversible-by-construction and
  bounded to a single config parameter — matches `auto_promotable()`
  exactly, so nothing here needs `Authority::governed` (canary + signed
  promotion for higher-stakes changes) or `Authority::constitutional`
  (external human authority) — those exist in the real API for scopes
  ruClip explicitly does not use yet.
- `/v1/promote`/`/v1/judges/evaluate` need a `Constitution` — authoring
  one (who are ruClip's judges/controllers, what's the `authority_ceiling`,
  what's `prohibited_effects`) is a governance decision this document
  does not make unilaterally, matching every other "needs a decision, not
  a design" boundary this session has drawn (Phase 2b's human-issuance
  block, the redblue/Autogenous scope split).
- The CanaryState/Decision wire-format inference (§2.6) is real,
  well-grounded serde default behavior, but genuinely unconfirmed against
  a live response — flagged, not hidden, and the natural first thing to
  verify once team-lead's deployment is up.

## 6. Feeding back into ruClip's audit trail (witness pattern, ADR-103)

New entity, `AutogenousMutationRecord`, persisted the same way
`ApprovalTransition`/`HeartbeatSchedule` already are (AgentDB,
`ruclip:company:{companyId}:autogenous-mutation:{mutationId}`):

```typescript
export interface AutogenousMutationRecord {
  id: string; // == mutation.id
  companyId: string;
  mutation: Mutation;
  parentGenome: Genome;
  admitResponse: AdmitResponse;
  controller: CanaryController | null; // null until /v1/canary/new succeeds
  observations: Array<{ at: string; fitness: FitnessVector; decision: Decision }>; // append-only
  createdAt: string;
  updatedAt: string;
}
```

Every `/v1/canary/observe` response updates this record — the real
`CanaryController.audit: string[]` field (§2.6, a signed
promotion/rollback log the service itself maintains) is copied verbatim
into the persisted record, giving ruClip's own operators a queryable
history that's provably the same trail the service produced, not a
paraphrase. This is the concrete answer to "how does a canary/promotion
result feed back into ruClip's own audit trail": **it doesn't need a new
witness mechanism** — `CanaryController.audit` already *is* a signed
audit log; ruClip's job is durably storing it, the same "persist what the
authoritative source already produced" pattern `ApprovalTransition`
already follows for `witnessRef`. A real `WitnessHook` (`APPROVAL-GATE.md`
§5, still unbuilt) would eventually wrap this record too — not built
here, same tracked-gap discipline as everywhere else.

## 7. What Phase 4 (coder) implements

- `src/control-plane/governance/autogenous-client.ts` — the HTTP client
  (§3) and every type in §2, verbatim field names.
- `src/control-plane/governance/propose-budget-mutation.ts` — the
  concrete v1 trigger (§4): reads `checkOperatingBudget`'s pattern,
  constructs `Genome`/`Mutation`, calls `/v1/agl/admit`, then
  `/v1/canary/new`/`observe` on subsequent readings.
- `store/agentdb-adapter.ts` — `persistAutogenousMutationRecord`/
  `recallAutogenousMutationRecord` (§6), following the existing key/tier
  pattern.
- Tests: every `AdmitResponse.error` code (§2.4) handled correctly
  (including the PascalCase-vs-snake_case Debug-string nuance — a test
  that would have caught it if the format assumption were wrong), the
  `CanaryState`/`Decision` externally-tagged shapes round-trip correctly
  against hand-built fixture JSON matching §2.6's inferred format,
  `AutogenousClientError` on unreachability is treated as "not admitted"
  everywhere (§3), and the audit-trail record faithfully mirrors a
  multi-step canary observation sequence.
- **Do not wire `/v1/promote`/`/v1/judges/evaluate`** — explicitly out of
  scope (§1, §5).
- **First real integration test, once the URL lands**: call `/health`
  and confirm the real response matches §1's `Health` shape, then run
  one real `/v1/agl/admit` call against a hand-built fixture mutation and
  confirm §2.4's error-code/Debug-string behavior matches what's
  documented here — this is the "verify against the live service" step
  every prior slice in this project has treated as mandatory before
  trusting a source-derived assumption.

Please implement verbatim once the service URL is available — and if the
live service's actual JSON shapes differ from what's inferred here
(especially §2.6's enum tagging), that's a signal to come back to this
document and me, not to silently adapt around it.
