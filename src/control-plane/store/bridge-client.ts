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
 */

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
}

function resolveBaseUrl(config?: AgentDbAdapterConfig): string {
  return config?.baseUrl ?? process.env.RUCLIP_AGENTDB_BRIDGE_URL ?? 'http://localhost:3000';
}

let rpcIdCounter = 0;

export async function callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  config?: AgentDbAdapterConfig,
): Promise<T> {
  const fetchFn = config?.fetchImpl ?? fetch;
  const baseUrl = resolveBaseUrl(config);
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    throw new AgentDbBridgeError(`AgentDB tool '${name}' failed: ${payload.error.message}`);
  }
  const text = payload.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new AgentDbBridgeError(`AgentDB tool '${name}' returned no content`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new AgentDbBridgeError(`AgentDB tool '${name}' returned non-JSON content`, err);
  }
}
