/**
 * Shared mock for the `ruflo mcp start -t http` JSON-RPC bridge that
 * store/agentdb-adapter.ts talks to (see that file's header). Dispatches by
 * MCP tool name so a single mock can stand in for hierarchical-store,
 * causal-edge, graph-query, etc. without a live AgentDB instance.
 *
 * Also answers the MCP `initialize` / `notifications/initialized` handshake
 * bridge-client.ts's callTool now performs before every first `tools/call`
 * against a given (fetchImpl, baseUrl) pair (see bridge-client.ts's header
 * for why the real bridge requires this). Handled generically here —
 * `calls` still records only real tool invocations, in the same shape as
 * before — so every existing test written against `mockBridge` keeps
 * passing unchanged; `rpcLog` is new and records the full RPC sequence
 * (including the handshake) for tests that specifically need to assert on
 * handshake ordering/session-id propagation.
 */
import type { AgentDbAdapterConfig } from '../../src/control-plane/store/agentdb-adapter.js';

export interface RecordedCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface RecordedRpc {
  method: string;
  toolName?: string;
  headers: Record<string, string>;
}

export interface MockBridgeOptions {
  /**
   * Value to return as the `Mcp-Session-Id` response header on `initialize`.
   * Pass `null` to omit the header entirely (simulating a bridge that
   * doesn't use sessions). Defaults to a synthesized id so session-id
   * echoing is exercised even when a test doesn't care about the value.
   */
  sessionId?: string | null;
  /**
   * If > 0, the next N `tools/call` requests get back
   * `{"error":{"code":-32002,"message":"Server not initialized"}}` instead
   * of being dispatched to `handlers` — for exercising callTool's
   * re-handshake-and-retry path. Each such response still shows up in
   * `rpcLog` but NOT in `calls` (it never reached a handler).
   */
  rejectUninitializedCount?: number;
}

function headersToRecord(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = init.headers as Record<string, string> | undefined;
  if (raw) {
    for (const [key, value] of Object.entries(raw)) out[key.toLowerCase()] = value;
  }
  return out;
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: true,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as Response;
}

export function mockBridge(
  handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>,
  options: MockBridgeOptions = {},
) {
  const calls: RecordedCall[] = [];
  const rpcLog: RecordedRpc[] = [];
  const sessionId = options.sessionId === undefined ? 'mock-session-1' : options.sessionId;
  let remainingUninitialized = options.rejectUninitializedCount ?? 0;

  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const headersIn = headersToRecord(init);
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };

    if (body.method === 'initialize') {
      rpcLog.push({ method: 'initialize', headers: headersIn });
      return jsonResponse(
        {
          jsonrpc: '2.0',
          id: '1',
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'Claude-Flow MCP Server V3', version: '3.38.20' },
          },
        },
        sessionId === null ? {} : { 'mcp-session-id': sessionId },
      );
    }

    if (body.method === 'notifications/initialized') {
      rpcLog.push({ method: 'notifications/initialized', headers: headersIn });
      return jsonResponse({});
    }

    const { name, arguments: args } = body.params ?? {};
    if (!name) {
      throw new Error(`Mock bridge received an unrecognized RPC method '${body.method}'`);
    }
    rpcLog.push({ method: body.method, toolName: name, headers: headersIn });

    if (remainingUninitialized > 0) {
      remainingUninitialized -= 1;
      return jsonResponse({
        jsonrpc: '2.0',
        id: '1',
        error: { code: -32002, message: 'Server not initialized' },
      });
    }

    calls.push({ toolName: name, args: args ?? {} });
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`No mock handler registered for tool '${name}'`);
    }
    const result = await handler(args ?? {});
    return jsonResponse({
      jsonrpc: '2.0',
      id: '1',
      result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
    });
  }) as typeof fetch;

  const config: AgentDbAdapterConfig = { fetchImpl, baseUrl: 'http://mock' };
  return { calls, rpcLog, config };
}
