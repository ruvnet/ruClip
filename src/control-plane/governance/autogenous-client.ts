/**
 * HTTP client for `autogenous-service` (`ruvnet/autogenous`,
 * AUTOGENOUS-RUNTIME-GOVERNANCE.md §3) — ruClip's runtime governance layer
 * (ADR-0001 amendment 7a). Every type below is the literal Rust field
 * name/shape read directly from `crates/agl-types`/`crates/promotion`'s
 * source (no `#[serde(rename_all = "camelCase")]` anywhere in that
 * service) — do not camelCase these fields.
 *
 * Two real differences from `store/bridge-client.ts`'s discipline, stated
 * here rather than copied by habit:
 * 1. Plain REST (`JSON.stringify`/`.json()`), not the AgentDB bridge's
 *    JSON-RPC `tools/call` envelope — this is a real Cloud Run service, not
 *    an MCP tool bridge.
 * 2. No hardcoded `localhost` default — `AUTOGENOUS_SERVICE_URL` must be
 *    set; there is no "obviously local" default for a real deployed
 *    service the way `bridge-client.ts`'s sidecar assumption works.
 *
 * Fail-closed contract, load-bearing (§3): `AutogenousClientError` (thrown
 * only on genuine unreachability/non-JSON/HTTP-error responses) must be
 * treated as "not admitted" by every caller — never silently skipped like
 * the notification channel's best-effort contract. A well-formed
 * `{admitted: false, ...}` response is NOT an error — it's a normal,
 * successful HTTP response this client returns as-is; the caller decides
 * what "not admitted" means for its own flow.
 *
 * Live requirement, confirmed against the real deployment (2026-09-02): the
 * service is `--no-allow-unauthenticated` (403 confirmed anonymous), so
 * every call needs a bearer OIDC identity token. `tokenProvider` is
 * injectable, not hardcoded to shelling out to `gcloud` — ruClip's own
 * backend has no dedicated service account with `roles/run.invoker` on
 * this service yet (tracked separately, not designed further here). For
 * local/test verification, `gcloud auth print-identity-token` (an
 * authenticated user identity that already holds `roles/run.invoker`) is
 * the real, confirmed-working command — **not**
 * `gcloud auth print-identity-token --audiences=<baseUrl>`, which the
 * original design doc suggested: that flag combination errors for a plain
 * user account ("Invalid account type for `--audiences`. Requires valid
 * service account.") — `--audiences` requires either a real service
 * account key or `--impersonate-service-account`. A bare
 * `print-identity-token` worked because Cloud Run's IAM invoker check
 * authorizes by identity, not by matching the token's audience claim to
 * the service URL, for an already-authorized caller.
 */

export class AutogenousClientError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AutogenousClientError';
  }
}

export interface AutogenousClientConfig {
  /** Defaults to the AUTOGENOUS_SERVICE_URL env var. No hardcoded default — see file header. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Supplies the bearer OIDC identity token for every call — see file header. Omit only against a deployment that doesn't require one (e.g. a local dev instance). */
  tokenProvider?: () => Promise<string>;
}

function resolveBaseUrl(config?: AutogenousClientConfig): string {
  const baseUrl = config?.baseUrl ?? process.env.AUTOGENOUS_SERVICE_URL;
  if (!baseUrl) {
    throw new AutogenousClientError(
      'AUTOGENOUS_SERVICE_URL is not set and no baseUrl was supplied — autogenous-service has no local/default ' +
        'endpoint to fall back to',
    );
  }
  return baseUrl;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  config?: AutogenousClientConfig,
): Promise<T> {
  const fetchFn = config?.fetchImpl ?? fetch;
  const baseUrl = resolveBaseUrl(config);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (config?.tokenProvider) {
    let token: string;
    try {
      token = await config.tokenProvider();
    } catch (err) {
      throw new AutogenousClientError('tokenProvider failed to produce a bearer token', err);
    }
    headers['authorization'] = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new AutogenousClientError(`Could not reach autogenous-service at ${baseUrl}${path}`, err);
  }
  if (!response.ok) {
    throw new AutogenousClientError(`autogenous-service HTTP ${response.status} calling ${path}`);
  }
  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new AutogenousClientError(`autogenous-service returned non-JSON content from ${path}`, err);
  }
}

// --- 2.1 Authority / MutationScope — snake_case string enums ---------------

export type Authority = 'observe_only' | 'simulate_only' | 'auto_reversible' | 'governed' | 'constitutional';

export type MutationScope =
  | 'prompt_context'
  | 'routing_budget'
  | 'retrieval_rerank'
  | 'cache_memory'
  | 'agent_topology'
  | 'application_code'
  | 'schema_migration'
  | 'security_policy'
  | 'compiler_ir'
  | 'constitutional';

// --- 2.2 Genome, HardInvariant, Applicability, Mutation ---------------------

export interface HardInvariant {
  name: string;
  holds: boolean;
}

export interface Genome {
  hash: string;
  identity: string;
  /** Reference (hash) to the pinned Constitution. */
  constitution: string;
  capability_ceiling: Authority;
  hard_invariants: HardInvariant[];
  /** Parent genome hashes, oldest first. */
  lineage: string[];
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
  /** REQUIRED in practice — the real admission check's AdmissionError::NoRollback confirms a missing target is inadmissible. */
  rollback_target: string | null;
  /** Unix seconds. */
  expires_at: number | null;
  signature: string | null;
}

// --- 2.3 FitnessVector / HardGates ------------------------------------------

export interface FitnessVector {
  task_quality: number;
  safety: number;
  governance: number;
  reliability: number;
  p99_overhead_ms: number;
  false_positive_rate: number;
  regression_count: number;
  rollback_verified: boolean;
}

export interface HardGates {
  min_safety: number;
  min_governance: number;
  max_false_positive_rate: number;
  max_p99_overhead_ms: number;
}

/** Real ADR-392 §14 first-production default, used server-side when `gates` is omitted from a request. */
export const DEFAULT_HARD_GATES: HardGates = {
  min_safety: 0.99,
  min_governance: 0.99,
  max_false_positive_rate: 0.005,
  max_p99_overhead_ms: 5.0,
};

// --- 2.4 /v1/agl/admit -------------------------------------------------------

export interface AdmitRequest {
  mutation: Mutation;
  parent: Genome;
  /** Unix seconds — caller-supplied so the verdict is deterministic/reproducible. */
  now: number;
}

/**
 * `error`/`reason` are NOT `AdmissionError`'s `Serialize` output — the real
 * handler calls Rust `Debug` (`format!("{e:?}")`) and splits a short code
 * off the front. `reason`'s Debug string uses PascalCase Rust variant names
 * for `Authority` (e.g. `Governed`), NOT the snake_case wire form every
 * other field in this API uses — a real, easy-to-miss inconsistency,
 * confirmed by reading `agl_admit`'s handler body directly, not the type's
 * own derive. The seven real `error` codes: AuthorityExpansion,
 * AuthorityInsufficient, InvariantRegressed, ParentMismatch,
 * ConstitutionalScope, NoRollback, Expired.
 */
export interface AdmitResponse {
  admitted: boolean;
  error: string | null;
  reason: string | null;
}

// --- 2.5 /v1/agl/fitness -----------------------------------------------------

export interface FitnessRequest {
  fitness: FitnessVector;
  /** Omit to use the real server-side ADR-392 §14 default (DEFAULT_HARD_GATES above). */
  gates?: HardGates;
}

export interface FitnessResponse {
  passes: boolean;
  gates: HardGates;
}

// --- 2.6 CanaryState / Decision / CanaryController — externally-tagged enums

/**
 * INFERRED, NOT YET CONFIRMED AGAINST A LIVE RESPONSE (§2.6/§5) —
 * autogenous-service was not deployed when this was written. Neither
 * `CanaryState` nor `Decision` carries a serde tag/rename attribute in
 * `crates/promotion/src/lib.rs`, so serde's default externally-tagged
 * enum encoding applies: a struct-like variant is `{"<VariantName>": {...}}`,
 * a unit variant is the bare string `"<VariantName>"`. Standard, stable
 * serde behavior — but verify against the real service before trusting
 * this in production; see `parseCanaryState`/`parseDecision` below, which
 * fail loud (throw) on anything that doesn't match this shape rather than
 * silently coercing an unexpected response.
 */
export type CanaryState =
  | { Serving: { stage_idx: number; healthy_observations: number } }
  | { Promoted: { signature: string } }
  | { RolledBack: { at_stage_pct: number; reason: string } };

export type Decision = 'Hold' | { Advance: { to_pct: number } } | 'ReadyForPromotion' | { RollBack: { reason: string } };

export interface CanaryController {
  candidate_id: string;
  rollback_target: string;
  gates: HardGates;
  observations_per_stage: number;
  state: CanaryState;
  /** Signed promotion/rollback audit records the service itself maintains, oldest first — see §6. */
  audit: string[];
  /** Single-use replay guard — in-process only on the service side, real code comment: cross-process durability is a separate, not-yet-built item. */
  consumed_nonces: string[];
}

/** Real STAGES constant, promotion crate. */
export const CANARY_STAGES = [1, 10, 50, 100] as const;

export interface CanaryNewRequest {
  candidate_id: string;
  rollback_target: string;
  /** Default 1 server-side (real `fn one() -> u32 { 1 }`) when omitted. */
  observations_per_stage?: number;
  gates?: HardGates;
}

export interface CanaryStateResponse {
  controller: CanaryController;
  stage_pct: number | null;
}

export interface CanaryObserveRequest {
  controller: CanaryController;
  fitness: FitnessVector;
}

export interface CanaryObserveResponse {
  controller: CanaryController;
  decision: Decision;
  stage_pct: number | null;
}

/**
 * Validates the externally-tagged shape §2.6 documents, failing loud
 * (AutogenousClientError) on anything unexpected rather than silently
 * passing through a response that doesn't actually match — this is the
 * one boundary this design explicitly asked to be defensive at, since it's
 * unconfirmed against a live response.
 */
export function assertValidCanaryState(value: unknown): CanaryState {
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1 && ['Serving', 'Promoted', 'RolledBack'].includes(keys[0]!)) {
      return value as CanaryState;
    }
  }
  throw new AutogenousClientError(
    `Unexpected CanaryState shape from autogenous-service: ${JSON.stringify(value)} — does not match the ` +
      'externally-tagged {"Serving"|"Promoted"|"RolledBack": {...}} shape §2.6 documents',
  );
}

export function assertValidDecision(value: unknown): Decision {
  if (value === 'Hold' || value === 'ReadyForPromotion') return value;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1 && ['Advance', 'RollBack'].includes(keys[0]!)) {
      return value as Decision;
    }
  }
  throw new AutogenousClientError(
    `Unexpected Decision shape from autogenous-service: ${JSON.stringify(value)} — does not match §2.6's ` +
      '"Hold" | {"Advance": {...}} | "ReadyForPromotion" | {"RollBack": {...}} shape',
  );
}

// --- Client functions --------------------------------------------------------

export interface AutogenousHealth {
  [key: string]: unknown;
}

/** GET /health — the "first real integration test" §7 names once the service URL is live. */
export async function getHealth(config?: AutogenousClientConfig): Promise<AutogenousHealth> {
  return request<AutogenousHealth>('GET', '/health', undefined, config);
}

/**
 * POST /v1/agl/admit. Returns the response as-is, including
 * `{admitted: false, ...}` — that is a normal, successful call, not an
 * error. Only genuine unreachability/HTTP/JSON failures throw
 * `AutogenousClientError`; callers must treat that thrown case as "not
 * admitted" themselves (§3).
 */
export async function admitMutation(req: AdmitRequest, config?: AutogenousClientConfig): Promise<AdmitResponse> {
  return request<AdmitResponse>('POST', '/v1/agl/admit', req, config);
}

/** POST /v1/agl/fitness. */
export async function checkFitness(req: FitnessRequest, config?: AutogenousClientConfig): Promise<FitnessResponse> {
  return request<FitnessResponse>('POST', '/v1/agl/fitness', req, config);
}

/** POST /v1/canary/new. Validates the returned CanaryState shape before returning. */
export async function createCanary(
  req: CanaryNewRequest,
  config?: AutogenousClientConfig,
): Promise<CanaryStateResponse> {
  const result = await request<CanaryStateResponse>('POST', '/v1/canary/new', req, config);
  assertValidCanaryState(result.controller.state);
  return result;
}

/** POST /v1/canary/observe. Validates the returned CanaryState/Decision shapes before returning. */
export async function observeCanary(
  req: CanaryObserveRequest,
  config?: AutogenousClientConfig,
): Promise<CanaryObserveResponse> {
  const result = await request<CanaryObserveResponse>('POST', '/v1/canary/observe', req, config);
  assertValidCanaryState(result.controller.state);
  assertValidDecision(result.decision);
  return result;
}
