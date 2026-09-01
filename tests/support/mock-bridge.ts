/**
 * Shared mock for the `ruflo mcp start -t http` JSON-RPC bridge that
 * store/agentdb-adapter.ts talks to (see that file's header). Dispatches by
 * MCP tool name so a single mock can stand in for hierarchical-store,
 * causal-edge, graph-query, etc. without a live AgentDB instance.
 */
import type { AgentDbAdapterConfig } from '../../src/control-plane/store/agentdb-adapter.js';

export interface RecordedCall {
  toolName: string;
  args: Record<string, unknown>;
}

export function mockBridge(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    const { name, arguments: args } = body.params;
    calls.push({ toolName: name, args });
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`No mock handler registered for tool '${name}'`);
    }
    const result = handler(args);
    return {
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: '1',
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      }),
    } as Response;
  }) as typeof fetch;
  const config: AgentDbAdapterConfig = { fetchImpl, baseUrl: 'http://mock' };
  return { calls, config };
}
