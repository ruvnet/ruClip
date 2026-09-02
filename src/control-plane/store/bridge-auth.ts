/**
 * Opt-in Google Cloud OIDC `Authorization: Bearer <token>` header for an
 * IAM-protected `ruflo mcp start -t http` bridge (e.g. a Cloud Run sidecar
 * deployed without `--allow-unauthenticated`).
 *
 * Mirrors the verified pattern in `cognitum-one/slack`'s
 * `src/harness.rs::id_token()`: `GET` the GCE/Cloud Run metadata server's
 * identity endpoint with `?audience=<bridge origin>` and header
 * `Metadata-Flavor: Google`, off whatever service account is already
 * attached to the process — no credentials file, no `google-auth-library`
 * (or any other) npm dependency. This file stays a dependency-free leaf
 * (`node:` builtins only), same discipline as `bridge-client.ts`.
 *
 * Deliberately **not** auto-detected. A silent metadata-server probe from a
 * developer laptop off GCP — which typically hangs until it times out, or
 * answers with an identity for an unrelated audience — is exactly the kind
 * of magic `bridge-client.ts`'s own header comment warns this codebase
 * avoids. Callers opt in explicitly via `AgentDbAdapterConfig.auth:
 * 'gcp-oidc'` or the `RUCLIP_BRIDGE_AUTH=gcp-oidc` env var (config wins);
 * the default `'none'` never touches the network for this and
 * `resolveAuthorizationHeader` resolves to `undefined` immediately.
 *
 * Deliberately throws a plain `Error`, not `AgentDbBridgeError` — importing
 * that class from `bridge-client.ts` here (while `bridge-client.ts` in turn
 * imports `resolveAuthorizationHeader` from this file) would recreate the
 * exact two-way class/value import cycle `bridge-client.ts`'s header
 * documents as having broken `agentdb-adapter.ts`/`claims-authorization.ts`
 * once already. `bridge-client.ts`'s `callTool` wraps this file's throws
 * into `AgentDbBridgeError` at the one call site that needs to. Callers
 * MUST fail closed: when auth is enabled and the token cannot be obtained,
 * propagate the throw — never fall through to an unauthenticated request.
 */

const METADATA_IDENTITY_PATH =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const METADATA_TIMEOUT_MS = 3_000;
/** Proactively refresh this long before the token's real `exp`. */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** Fallback re-fetch interval when a token's `exp` claim can't be read (~50 min, inside the ~1h GCE identity-token lifetime). */
const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;

export type BridgeAuthMode = 'gcp-oidc' | 'none';

export interface BridgeAuthConfig {
  /** Explicit opt-in. Overrides RUCLIP_BRIDGE_AUTH. Defaults to 'none' — no metadata-server call is ever made in that case. */
  auth?: BridgeAuthMode;
}

function resolveAuthMode(config?: BridgeAuthConfig): BridgeAuthMode {
  if (config?.auth) return config.auth;
  return process.env.RUCLIP_BRIDGE_AUTH === 'gcp-oidc' ? 'gcp-oidc' : 'none';
}

/** The OIDC audience is the bridge's origin (scheme + host, no path). */
function audienceFor(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** Keyed by fetchImpl so concurrent tests injecting distinct fetchImpls never share a cached token (mirrors bridge-client.ts's handshake cache). */
const tokenCache = new WeakMap<typeof fetch, Map<string, CachedToken>>();

function getTokenCacheMap(fetchFn: typeof fetch): Map<string, CachedToken> {
  let map = tokenCache.get(fetchFn);
  if (!map) {
    map = new Map();
    tokenCache.set(fetchFn, map);
  }
  return map;
}

/**
 * Decodes a JWT's `exp` claim without verifying the signature — the bridge
 * (via Cloud Run IAM) is what verifies this token; decoding here is only to
 * time our own proactive refresh.
 */
function decodeJwtExpiryMs(token: string): number | undefined {
  try {
    const parts = token.split('.');
    const payloadPart = parts[1];
    if (parts.length !== 3 || !payloadPart) return undefined;
    const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

async function fetchIdentityToken(fetchFn: typeof fetch, audience: string): Promise<string> {
  const url = `${METADATA_IDENTITY_PATH}?audience=${encodeURIComponent(audience)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      `Could not reach the GCE metadata server for a Google OIDC identity token (audience ${audience})`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(
      `GCE metadata server returned HTTP ${response.status} for the identity token (audience ${audience})`,
    );
  }
  const token = (await response.text()).trim();
  if (!token) {
    throw new Error(`GCE metadata server returned an empty identity token (audience ${audience})`);
  }
  return token;
}

async function getIdentityToken(fetchFn: typeof fetch, audience: string): Promise<string> {
  const cache = getTokenCacheMap(fetchFn);
  const cached = cache.get(audience);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.token;
  }
  const token = await fetchIdentityToken(fetchFn, audience);
  const exp = decodeJwtExpiryMs(token);
  const expiresAtMs = exp !== undefined ? exp - TOKEN_REFRESH_MARGIN_MS : Date.now() + TOKEN_MAX_AGE_MS;
  cache.set(audience, { token, expiresAtMs });
  return token;
}

/**
 * Returns the `Authorization: Bearer <token>` header value to send, or
 * `undefined` when auth is disabled (the default — no network call is made
 * in that case). Throws a plain `Error` when auth is enabled and the token
 * cannot be obtained; callers must fail closed, never fall through to an
 * unauthenticated call.
 */
export async function resolveAuthorizationHeader(
  config: BridgeAuthConfig | undefined,
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<string | undefined> {
  if (resolveAuthMode(config) !== 'gcp-oidc') {
    return undefined;
  }
  const token = await getIdentityToken(fetchFn, audienceFor(baseUrl));
  return `Bearer ${token}`;
}
