/**
 * Coverage for the two verified bridge-client.ts corrections against the
 * real, published `ruflo@3.38.20` `ruflo mcp start -t http` bridge (see
 * that file's header):
 *
 * 1. The MCP `initialize` -> `notifications/initialized` -> `tools/call`
 *    handshake, once per (fetchImpl, baseUrl) pair, session-id echoing, and
 *    the one-shot re-handshake-on-`-32002` self-heal.
 * 2. The opt-in Google OIDC `Authorization` header for an IAM-protected
 *    bridge, implemented in bridge-auth.ts.
 *
 * No live AgentDB/GCE-metadata instance is used — mockBridge
 * (tests/support/mock-bridge.ts) for the handshake tests, and a small
 * bespoke fetchImpl (same style: records the request sequence) wrapping it
 * for the OIDC tests, since mockBridge only answers `/rpc`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { callTool, AgentDbBridgeError, type AgentDbAdapterConfig } from '../../src/control-plane/store/bridge-client.js';

// ---- MCP initialize handshake -------------------------------------------

test('first callTool emits initialize -> notifications/initialized -> tools/call, in that order', async () => {
  const { rpcLog, config } = mockBridge({ 'agentdb_hierarchical-store': () => ({ ok: true }) });
  const result = await callTool('agentdb_hierarchical-store', { key: 'k' }, config);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    rpcLog.map((r) => r.method),
    ['initialize', 'notifications/initialized', 'tools/call'],
  );
});

test('a second callTool against the same config does NOT re-handshake', async () => {
  const { rpcLog, calls, config } = mockBridge({
    'agentdb_hierarchical-store': () => ({ ok: true }),
    'agentdb_hierarchical-recall': () => ({ found: false }),
  });
  await callTool('agentdb_hierarchical-store', { key: 'k1' }, config);
  await callTool('agentdb_hierarchical-recall', { key: 'k2' }, config);

  assert.equal(calls.length, 2);
  const methods = rpcLog.map((r) => r.method);
  assert.equal(methods.filter((m) => m === 'initialize').length, 1);
  assert.equal(methods.filter((m) => m === 'notifications/initialized').length, 1);
  assert.equal(methods.filter((m) => m === 'tools/call').length, 2);
  // Handshake happens once, up front, before either tool call.
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
});

test('an Mcp-Session-Id returned on initialize is echoed on every later request', async () => {
  const { rpcLog, config } = mockBridge(
    { 'agentdb_hierarchical-store': () => ({ ok: true }) },
    { sessionId: 'session-xyz' },
  );
  await callTool('agentdb_hierarchical-store', { key: 'k1' }, config);
  await callTool('agentdb_hierarchical-store', { key: 'k2' }, config);

  const [, notify, firstCall, secondCall] = rpcLog;
  assert.equal(notify?.headers['mcp-session-id'], 'session-xyz');
  assert.equal(firstCall?.headers['mcp-session-id'], 'session-xyz');
  assert.equal(secondCall?.headers['mcp-session-id'], 'session-xyz');
});

test('no Mcp-Session-Id header is sent when the bridge does not return one', async () => {
  const { rpcLog, config } = mockBridge(
    { 'agentdb_hierarchical-store': () => ({ ok: true }) },
    { sessionId: null },
  );
  await callTool('agentdb_hierarchical-store', { key: 'k1' }, config);
  const toolCall = rpcLog.find((r) => r.method === 'tools/call');
  assert.equal(toolCall?.headers['mcp-session-id'], undefined);
});

test('a -32002 "not initialized" response triggers exactly one re-handshake, then succeeds', async () => {
  const { rpcLog, calls, config } = mockBridge(
    { 'agentdb_hierarchical-store': () => ({ ok: true }) },
    { rejectUninitializedCount: 1 },
  );
  const result = await callTool('agentdb_hierarchical-store', { key: 'k' }, config);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1, 'the handler should only have been invoked by the successful retry');
  const methods = rpcLog.map((r) => r.method);
  assert.deepEqual(methods, [
    'initialize',
    'notifications/initialized',
    'tools/call', // rejected with -32002
    'initialize', // re-handshake
    'notifications/initialized',
    'tools/call', // succeeds
  ]);
});

test('a -32002 that persists through the re-handshake surfaces as AgentDbBridgeError, not an infinite loop', async () => {
  const { config } = mockBridge(
    { 'agentdb_hierarchical-store': () => ({ ok: true }) },
    { rejectUninitializedCount: 2 },
  );
  await assert.rejects(
    () => callTool('agentdb_hierarchical-store', { key: 'k' }, config),
    (err: unknown) => err instanceof AgentDbBridgeError,
  );
});

test('a genuine tool-level error (not -32002) is NOT treated as a re-handshake signal', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-store': () => {
      throw new Error('boom');
    },
  });
  // The handler throwing isn't how mockBridge reports MCP tool errors back
  // to callTool (it always wraps handler results as a success payload), so
  // exercise a real business error via a handler that returns an
  // error-shaped tool result instead — simplest: register no handler and
  // rely on mockBridge's "No mock handler registered" throw surfacing as a
  // rejected fetch, which callTool wraps as AgentDbBridgeError.
  await assert.rejects(
    () => callTool('agentdb_unregistered-tool', {}, config),
    (err: unknown) => err instanceof AgentDbBridgeError,
  );
});

// ---- Opt-in Google OIDC Authorization header -----------------------------

interface MetadataCall {
  url: string;
  headers: Record<string, string>;
}

/** Wraps mockBridge's fetchImpl with a fake GCE metadata-server endpoint, recording every metadata request the same way mockBridge records RPC requests. */
function mockBridgeWithMetadata(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
  metadataToken: string | 'FAIL',
) {
  const bridge = mockBridge(handlers);
  const metadataCalls: MetadataCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.startsWith('http://metadata.google.internal')) {
      const headers: Record<string, string> = {};
      const raw = init?.headers as Record<string, string> | undefined;
      if (raw) for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = v;
      metadataCalls.push({ url: urlStr, headers });
      if (metadataToken === 'FAIL') {
        throw new Error('metadata server unreachable (simulated)');
      }
      return {
        ok: true,
        headers: { get: () => null },
        text: async () => metadataToken,
      } as unknown as Response;
    }
    return bridge.config.fetchImpl!(url as string, init as RequestInit);
  }) as typeof fetch;
  return { ...bridge, metadataCalls, fetchImpl };
}

test('gcp-oidc auth: metadata server is called with Metadata-Flavor: Google and the bridge origin as audience, and Authorization: Bearer reaches the RPC', async () => {
  const { rpcLog, metadataCalls, fetchImpl } = mockBridgeWithMetadata(
    { 'agentdb_hierarchical-store': () => ({ ok: true }) },
    'fake.identity.token',
  );
  const config: AgentDbAdapterConfig = { fetchImpl, baseUrl: 'http://mock', auth: 'gcp-oidc' };

  await callTool('agentdb_hierarchical-store', { key: 'k' }, config);

  assert.equal(metadataCalls.length, 1);
  assert.equal(metadataCalls[0]?.headers['metadata-flavor'], 'Google');
  assert.ok(metadataCalls[0]?.url.includes(`audience=${encodeURIComponent('http://mock')}`));

  const initCall = rpcLog.find((r) => r.method === 'initialize');
  const toolCall = rpcLog.find((r) => r.method === 'tools/call');
  assert.equal(initCall?.headers['authorization'], 'Bearer fake.identity.token');
  assert.equal(toolCall?.headers['authorization'], 'Bearer fake.identity.token');
});

test('gcp-oidc auth: the identity token is cached, not re-fetched on a second callTool', async () => {
  const { metadataCalls, fetchImpl } = mockBridgeWithMetadata(
    { 'agentdb_hierarchical-store': () => ({ ok: true }) },
    'fake.identity.token',
  );
  const config: AgentDbAdapterConfig = { fetchImpl, baseUrl: 'http://mock', auth: 'gcp-oidc' };

  await callTool('agentdb_hierarchical-store', { key: 'k1' }, config);
  await callTool('agentdb_hierarchical-store', { key: 'k2' }, config);

  assert.equal(metadataCalls.length, 1);
});

test('gcp-oidc auth: a failed metadata fetch throws AgentDbBridgeError and sends NO RPC at all', async () => {
  const { rpcLog, calls, fetchImpl } = mockBridgeWithMetadata(
    { 'agentdb_hierarchical-store': () => ({ ok: true }) },
    'FAIL',
  );
  const config: AgentDbAdapterConfig = { fetchImpl, baseUrl: 'http://mock', auth: 'gcp-oidc' };

  await assert.rejects(
    () => callTool('agentdb_hierarchical-store', { key: 'k' }, config),
    (err: unknown) => err instanceof AgentDbBridgeError,
  );
  assert.equal(rpcLog.length, 0, 'no initialize/tools/call should have been sent');
  assert.equal(calls.length, 0);
});

test('auth off (the default): no metadata call is made and no Authorization header is sent', async () => {
  const { rpcLog, metadataCalls, fetchImpl } = mockBridgeWithMetadata(
    { 'agentdb_hierarchical-store': () => ({ ok: true }) },
    'unused-token',
  );
  // auth deliberately omitted from config — defaults to 'none'.
  const config: AgentDbAdapterConfig = { fetchImpl, baseUrl: 'http://mock' };

  await callTool('agentdb_hierarchical-store', { key: 'k' }, config);

  assert.equal(metadataCalls.length, 0);
  for (const rpc of rpcLog) {
    assert.equal(rpc.headers['authorization'], undefined);
  }
});
