/**
 * HTTP JSON-RPC client for the `ruflo mcp start -t http` bridge, plus its
 * base error class — factored out of store/agentdb-adapter.ts into this
 * dependency-free leaf module.
 *
 * Real-world correction to AUTHORIZATION.md §1/§10 ("export the existing
 * private callTool function ... a one-line change, not a refactor — no need
 * to extract a separate bridge-client module for this"): a one-line export
 * was NOT sufficient. `authorization/claims-authorization.ts` needs
 * `callTool`/`AgentDbBridgeError` from this file's original home in
 * agentdb-adapter.ts, and agentdb-adapter.ts needs
 * `verifyActorHoldsClaim`/`acceptClaimHandoff`/`handoffClaim` from
 * claims-authorization.ts — a genuine two-way import cycle. `tsc` accepted
 * that cycle (it only checks types), but running the compiled output threw
 * `ReferenceError: Cannot access 'AgentDbBridgeError' before initialization`
 * at claims-authorization.ts's `class ClaimAuthorizationError extends
 * AgentDbBridgeError` — unlike a function body (whose contents only run
 * later, after both modules finish loading), a `class ... extends`
 * heritage clause is evaluated immediately when the module body executes,
 * so whichever module's evaluation started the cycle finds the other
 * module's export still uninitialized. Extracting the shared, dependency-
 * free pieces here breaks the cycle: this file imports nothing from either
 * agentdb-adapter.ts or claims-authorization.ts, both of those import from
 * here, and agentdb-adapter.ts re-exports these names so no existing
 * `from '../store/agentdb-adapter.js'` import elsewhere needed to change.
 *
 * Two verified corrections against the real, published bridge
 * (`ruflo@3.38.20`, `ruflo mcp start -t http`), found by running it rather
 * than assumed from the MCP spec:
 *
 * 1. A bare `tools/call` gets `{"error":{"code":-32002,"message":"Server
 *    not initialized"}}` — the bridge requires a JSON-RPC `initialize`
 *    request followed by a `notifications/initialized` notification (no
 *    `id`) first. The server answers with `protocolVersion:"2025-11-25"`
 *    and `serverInfo.name:"Claude-Flow MCP Server V3"`, and MAY return an
 *    `Mcp-Session-Id` response header on `initialize`, which must then be
 *    echoed back as a request header on every subsequent call. `callTool`
 *    performs this handshake lazily, once per (fetch implementation,
 *    baseUrl) pair — see `ensureHandshake` below — caching the in-flight
 *    promise so concurrent first calls don't double-initialize, and
 *    re-running it exactly once if a call comes back `-32002`, so a bridge
 *    that was restarted (and so forgot the session) self-heals instead of
 *    failing forever.
 * 2. For a Cloud Run bridge deployed IAM-protected (no
 *    `--allow-unauthenticated`), every request — including `initialize` —
 *    needs a Google OIDC `Authorization: Bearer` header. That's opt-in
 *    (`AgentDbAdapterConfig.auth: 'gcp-oidc'` or `RUCLIP_BRIDGE_AUTH=gcp-
 *    oidc`) and implemented in `bridge-auth.ts`, split out to keep both
 *    files dependency-free leaves under the repo's file-size convention.
 */

import { resolveAuthorizationHeader, type BridgeAuthMode } from './bridge-auth.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export class AgentDbBridgeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AgentDbBridgeError';
  }
}

/**
 * Shared here (not in store/agentdb-adapter.ts, where this originated) so
 * every module that builds an AgentDB key/node-id — including
 * comms/agentbbs-notification-channel.ts, which reuses this same
 * dependency-free leaf rather than importing agentdb-adapter.ts and risking
 * the two-way import cycle documented above — gets the same guard.
 *
 * Keys/node-ids across this codebase are built by string-concatenating
 * caller-supplied ids into `:`-delimited templates, and AgentDB recall does
 * exact-string matching on the result. An id containing a template's own
 * delimiter (":goal:", ":issue:", ":comms-room", "entity:issue:", etc.) can
 * make two semantically different id tuples serialize to the identical
 * key/node-id string, letting a crafted id collide with — and overwrite or
 * be confused with — a different entity's record or graph node
 * (13ac549 closed the first instance of this repo-wide; reintroduced once
 * in agentbbs-notification-channel.ts's registerCompanyCommsRoom, found by
 * an independent test and closed again here — see that file's call site).
 * assertValid* in schema/validation.ts blocks unsafe ids on entity write
 * paths that go through it; this guard covers every id-only function that
 * builds a key/node-id directly (recall, causal-edge, graph-neighbor
 * lookups, comms-room registration) without going through an assertValid*
 * call first.
 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new AgentDbBridgeError(`Refusing to build an AgentDB key/node-id from unsafe ${label} '${value}'`);
  }
}

export interface AgentDbAdapterConfig {
  /** Base URL of a `ruflo mcp start -t http` server. Defaults to RUCLIP_AGENTDB_BRIDGE_URL or http://localhost:3000. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Opt-in Google OIDC `Authorization` header for an IAM-protected bridge.
   * Overrides RUCLIP_BRIDGE_AUTH. Defaults to 'none' (never touches the
   * network for this). See bridge-auth.ts.
   */
  auth?: BridgeAuthMode;
}

function resolveBaseUrl(config?: AgentDbAdapterConfig): string {
  return config?.baseUrl ?? process.env.RUCLIP_AGENTDB_BRIDGE_URL ?? 'http://localhost:3000';
}

let rpcIdCounter = 0;

/** MCP protocol version this client speaks; the bridge has answered with 2025-11-25 (a later revision), which is fine — MCP negotiation just requires we send a version we understand. */
const MCP_PROTOCOL_VERSION = '2025-03-26';

let cachedClientVersion: string | undefined;

/**
 * Walks up from this module's own directory to find the nearest
 * `package.json` named "ruclip" for `clientInfo.version`, rather than
 * hardcoding a relative `../../../../package.json` depth that would break
 * if the build's `outDir` layout ever changes.
 */
function resolveClientVersion(): string {
  if (cachedClientVersion !== undefined) return cachedClientVersion;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'ruclip' && typeof pkg.version === 'string') {
        cachedClientVersion = pkg.version;
        return cachedClientVersion;
      }
    } catch {
      // no package.json here (or unreadable) — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedClientVersion = '0.0.0';
  return cachedClientVersion;
}

interface HandshakeState {
  sessionId?: string;
}

/**
 * Keyed by fetchImpl (falling back to the real global `fetch`) so tests
 * that inject a fresh fetchImpl per call never share a stale handshake with
 * another test using the same mock baseUrl, while production code sharing
 * the default `fetch` naturally gets the "once per baseUrl" behavior the
 * spec calls for.
 */
const handshakeCache = new WeakMap<typeof fetch, Map<string, Promise<HandshakeState>>>();

function getHandshakeMap(fetchFn: typeof fetch): Map<string, Promise<HandshakeState>> {
  let map = handshakeCache.get(fetchFn);
  if (!map) {
    map = new Map();
    handshakeCache.set(fetchFn, map);
  }
  return map;
}

async function performHandshake(
  fetchFn: typeof fetch,
  baseUrl: string,
  authHeader: string | undefined,
): Promise<HandshakeState> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authHeader) headers['authorization'] = authHeader;

  let initResponse: Response;
  try {
    initResponse = await fetchFn(`${baseUrl}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `ruclip-init-${Date.now()}-${rpcIdCounter++}`,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ruclip', version: resolveClientVersion() },
        },
      }),
    });
  } catch (err) {
    throw new AgentDbBridgeError(
      `Could not reach AgentDB MCP bridge at ${baseUrl}/rpc for the MCP initialize handshake — is 'ruflo mcp start -t http' running?`,
      err,
    );
  }
  if (!initResponse.ok) {
    throw new AgentDbBridgeError(`AgentDB bridge HTTP ${initResponse.status} during MCP initialize handshake`);
  }
  const initPayload = (await initResponse.json()) as { error?: { code: number; message: string } };
  if (initPayload.error) {
    throw new AgentDbBridgeError(`AgentDB bridge MCP initialize failed: ${initPayload.error.message}`);
  }
  const sessionId = initResponse.headers.get('mcp-session-id') ?? undefined;

  const notifyHeaders: Record<string, string> = { 'content-type': 'application/json' };
  if (sessionId) notifyHeaders['mcp-session-id'] = sessionId;
  if (authHeader) notifyHeaders['authorization'] = authHeader;
  try {
    await fetchFn(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: notifyHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    });
  } catch (err) {
    throw new AgentDbBridgeError(
      `Could not send notifications/initialized to AgentDB MCP bridge at ${baseUrl}/rpc`,
      err,
    );
  }
  return { sessionId };
}

function ensureHandshake(
  fetchFn: typeof fetch,
  baseUrl: string,
  authHeader: string | undefined,
): Promise<HandshakeState> {
  const map = getHandshakeMap(fetchFn);
  let handshake = map.get(baseUrl);
  if (!handshake) {
    handshake = performHandshake(fetchFn, baseUrl, authHeader).catch((err: unknown) => {
      // Handshake itself failed — don't poison the cache with a rejected
      // promise forever; the next callTool gets a fresh attempt.
      map.delete(baseUrl);
      throw err;
    });
    map.set(baseUrl, handshake);
  }
  return handshake;
}

function resetHandshake(fetchFn: typeof fetch, baseUrl: string): void {
  getHandshakeMap(fetchFn).delete(baseUrl);
}

type ToolInvocationOutcome<T> = { retryNeeded: true } | { retryNeeded: false; value: T };

async function invokeTool<T>(
  fetchFn: typeof fetch,
  baseUrl: string,
  name: string,
  args: Record<string, unknown>,
  sessionId: string | undefined,
  authHeader: string | undefined,
): Promise<ToolInvocationOutcome<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (authHeader) headers['authorization'] = authHeader;

  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `ruclip-${Date.now()}-${rpcIdCounter++}`,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  } catch (err) {
    throw new AgentDbBridgeError(
      `Could not reach AgentDB MCP bridge at ${baseUrl}/rpc — is 'ruflo mcp start -t http' running?`,
      err,
    );
  }
  if (!response.ok) {
    throw new AgentDbBridgeError(`AgentDB bridge HTTP ${response.status} calling ${name}`);
  }
  const payload = (await response.json()) as {
    error?: { code: number; message: string };
    result?: { content?: Array<{ type: string; text: string }> };
  };
  if (payload.error) {
    if (payload.error.code === -32002) {
      return { retryNeeded: true };
    }
    throw new AgentDbBridgeError(`AgentDB tool '${name}' failed: ${payload.error.message}`);
  }
  const text = payload.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new AgentDbBridgeError(`AgentDB tool '${name}' returned no content`);
  }
  try {
    return { retryNeeded: false, value: JSON.parse(text) as T };
  } catch (err) {
    throw new AgentDbBridgeError(`AgentDB tool '${name}' returned non-JSON content`, err);
  }
}

export async function callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  config?: AgentDbAdapterConfig,
): Promise<T> {
  const fetchFn = config?.fetchImpl ?? fetch;
  const baseUrl = resolveBaseUrl(config);

  let authHeader: string | undefined;
  try {
    authHeader = await resolveAuthorizationHeader(config, baseUrl, fetchFn);
  } catch (err) {
    throw new AgentDbBridgeError(
      `Google OIDC auth is enabled (auth: 'gcp-oidc' / RUCLIP_BRIDGE_AUTH=gcp-oidc) but an identity token for ${baseUrl} could not be obtained`,
      err,
    );
  }

  let handshake = await ensureHandshake(fetchFn, baseUrl, authHeader);
  let outcome = await invokeTool<T>(fetchFn, baseUrl, name, args, handshake.sessionId, authHeader);
  if (outcome.retryNeeded) {
    // The bridge reported "not initialized" — most likely it restarted and
    // forgot our session. Re-handshake exactly once and retry; if it's
    // still -32002 after a fresh handshake, this is a real failure, not a
    // transient restart, so surface it rather than looping.
    resetHandshake(fetchFn, baseUrl);
    handshake = await ensureHandshake(fetchFn, baseUrl, authHeader);
    outcome = await invokeTool<T>(fetchFn, baseUrl, name, args, handshake.sessionId, authHeader);
    if (outcome.retryNeeded) {
      throw new AgentDbBridgeError(
        `AgentDB tool '${name}' still reports "not initialized" after a fresh MCP handshake against ${baseUrl}`,
      );
    }
  }
  return outcome.value;
}
