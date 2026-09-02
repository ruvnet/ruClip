import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  companyKey,
  orgMemberKey,
  goalKey,
  issueKey,
  commentKey,
  tierForIssueStatus,
  persistCompany,
  persistOrgMember,
  recordCausalEdge,
  recallCompany,
  AgentDbBridgeError,
  type AgentDbAdapterConfig,
  heartbeatKey,
  MAX_AGENTDB_KEY_LENGTH,
} from './agentdb-adapter.js';
import type { Company } from '../schema/company.js';
import type { OrgMember } from '../schema/org-member.js';

const now = '2026-09-01T00:00:00.000Z';

interface RecordedCall {
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Builds a fetchImpl that dispatches on the MCP tool name being called.
 *
 * Also answers the `initialize` / `notifications/initialized` MCP handshake
 * bridge-client.ts's callTool now performs before every first `tools/call`
 * (see that file's header) — generically, so `calls` still records only
 * real tool invocations and every test below keeps passing unchanged. This
 * mirrors tests/support/mock-bridge.ts's fix for the same reason; this
 * file predates that shared helper and keeps its own local copy.
 */
function mockBridge(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };

    if (body.method === 'initialize') {
      return {
        ok: true,
        headers: { get: (_h: string) => null },
        json: async () => ({
          jsonrpc: '2.0',
          id: '1',
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'Claude-Flow MCP Server V3', version: '3.38.20' },
          },
        }),
      } as unknown as Response;
    }
    if (body.method === 'notifications/initialized') {
      return {
        ok: true,
        headers: { get: (_h: string) => null },
        json: async () => ({}),
      } as unknown as Response;
    }

    const { name, arguments: args } = body.params ?? {};
    if (!name) {
      throw new Error(`Mock bridge received an unrecognized RPC method '${body.method}'`);
    }
    calls.push({ toolName: name, args: args ?? {} });
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`No mock handler registered for tool '${name}'`);
    }
    const result = handler(args ?? {});
    return {
      ok: true,
      headers: { get: (_h: string) => null },
      json: async () => ({
        jsonrpc: '2.0',
        id: '1',
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      }),
    } as unknown as Response;
  }) as typeof fetch;
  const config: AgentDbAdapterConfig = { fetchImpl, baseUrl: 'http://mock' };
  return { calls, config };
}

test('keying scheme matches DOMAIN-MODEL.md §2.2', () => {
  assert.equal(companyKey('co-1'), 'ruclip:company:co-1');
  assert.equal(orgMemberKey('co-1', 'om-1'), 'ruclip:company:co-1:org-member:om-1');
  assert.equal(goalKey('co-1', 'goal-1'), 'ruclip:company:co-1:goal:goal-1');
  assert.equal(issueKey('co-1', 'goal-1', 'issue-1'), 'ruclip:company:co-1:goal:goal-1:issue:issue-1');
  assert.equal(
    commentKey('co-1', 'goal-1', 'issue-1', 'comment-1'),
    'ruclip:company:co-1:comment:comment-1',
  );
});

test('tierForIssueStatus places open/in_progress/blocked in working, done/cancelled in episodic', () => {
  assert.equal(tierForIssueStatus('open'), 'working');
  assert.equal(tierForIssueStatus('in_progress'), 'working');
  assert.equal(tierForIssueStatus('blocked'), 'working');
  assert.equal(tierForIssueStatus('done'), 'episodic');
  assert.equal(tierForIssueStatus('cancelled'), 'episodic');
});

test('persistCompany stores to the semantic tier under the company key', async () => {
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const company: Company = {
    id: 'co-1',
    name: 'Acme',
    primaryGoalId: null,
    budget: { total: 1000, spent: 0, currency: 'USD', period: '2026-09', hardStopThreshold: 0.9 },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await persistCompany(company, config);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.toolName, 'agentdb_hierarchical-store');
  assert.equal(calls[0]?.args.key, 'ruclip:company:co-1');
  assert.equal(calls[0]?.args.tier, 'semantic');
});

test('persistOrgMember without a manager skips the reports_to edge', async () => {
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const member: OrgMember = {
    id: 'om-1',
    companyId: 'co-1',
    kind: 'human',
    identityRef: 'bbs:root',
    role: 'CEO',
    managerId: null,
    status: 'active',
  };
  await persistOrgMember(member, config);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.toolName, 'agentdb_hierarchical-store');
});

test('persistOrgMember with a manager checks for cycles then writes reports_to', async () => {
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_graph-query': () => ({ nodes: [] }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  const member: OrgMember = {
    id: 'om-2',
    companyId: 'co-1',
    kind: 'agent',
    identityRef: 'agent-team-name',
    role: 'Engineer',
    managerId: 'om-1',
    status: 'active',
  };
  await persistOrgMember(member, config);
  const toolNames = calls.map((c) => c.toolName);
  assert.deepEqual(toolNames, ['agentdb_hierarchical-store', 'agentdb_graph-query', 'agentdb_causal-edge']);
  const edgeCall = calls.find((c) => c.toolName === 'agentdb_causal-edge');
  assert.equal(edgeCall?.args.relation, 'reports_to');
  assert.equal(edgeCall?.args.sourceId, 'entity:org-member:om-2');
  assert.equal(edgeCall?.args.targetId, 'entity:org-member:om-1');
});

test('recordCausalEdge refuses a reports_to edge that would close a cycle', async () => {
  const { config } = mockBridge({
    // The proposed target (om-1) can already reach the proposed source (om-2)
    // one hop away, so adding om-2 -> om-1 would close a cycle.
    'agentdb_graph-query': () => ({ nodes: [{ id: 'entity:org-member:om-2' }] }),
  });
  await assert.rejects(
    () => recordCausalEdge('entity:org-member:om-2', 'entity:org-member:om-1', 'reports_to', config),
    AgentDbBridgeError,
  );
});

test('recordCausalEdge refuses a self-referential parent_of edge without calling the bridge', async () => {
  const { calls, config } = mockBridge({});
  await assert.rejects(
    () => recordCausalEdge('entity:issue:a', 'entity:issue:a', 'parent_of', config),
    AgentDbBridgeError,
  );
  assert.equal(calls.length, 0);
});

test('recallCompany filters hierarchical-recall results to an exact key match', async () => {
  const stored: Company = {
    id: 'co-1',
    name: 'Acme',
    primaryGoalId: null,
    budget: { total: 1000, spent: 0, currency: 'USD', period: '2026-09', hardStopThreshold: 0.9 },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({
      results: [
        { key: 'ruclip:company:other-co', value: JSON.stringify({ id: 'other-co' }) },
        { key: 'ruclip:company:co-1', value: JSON.stringify(stored) },
      ],
    }),
  });
  const recalled = await recallCompany('co-1', config);
  assert.deepEqual(recalled, stored);
});

test('recallCompany finds the exact key even when many sibling records share its prefix (ruvnet/ruClip#5)', async () => {
  // A seeded company quickly has more than ten records under ruclip:company:<id>
  // (members, goal, issues, heartbeats). The old topK:10 page could omit the exact key.
  const stored: Company = {
    id: 'co-1',
    name: 'Acme',
    primaryGoalId: null,
    budget: { total: 1000, spent: 0, currency: 'USD', period: '2026-09', hardStopThreshold: 0.9 },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  const siblings = Array.from({ length: 11 }, (_, i) => ({
    key: `ruclip:company:co-1:org-member:om-${i}`,
    value: JSON.stringify({ id: `om-${i}` }),
  }));
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({
      results: [...siblings, { key: 'ruclip:company:co-1', value: JSON.stringify(stored) }],
    }),
  });
  const recalled = await recallCompany('co-1', config);
  assert.deepEqual(recalled, stored);
  const recallCall = calls.find((c) => c.toolName === 'agentdb_hierarchical-recall');
  assert.ok((recallCall?.args.topK as number) >= 12, 'first recall page must be wider than the sibling count');
});

test('recallCompany widens the page when the first one is full without a match, and stops on a short page', async () => {
  let pages = 0;
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args: Record<string, unknown>) => {
      pages += 1;
      const topK = args.topK as number;
      // First page: completely full of non-matching siblings. Second page: short, still no match.
      const count = pages === 1 ? topK : 3;
      return {
        results: Array.from({ length: count }, (_, i) => ({ key: `ruclip:company:co-1:issue:i-${i}`, value: '{}' })),
      };
    },
  });
  const recalled = await recallCompany('co-1', config);
  assert.equal(recalled, null);
  const topKs = calls.filter((c) => c.toolName === 'agentdb_hierarchical-recall').map((c) => c.args.topK as number);
  assert.equal(topKs.length, 2, 'one widening retry, then stop on the short page');
  assert.ok(topKs[1]! > topKs[0]!, 'second page must be wider than the first');
});

test('recallCompany returns null when no exact key match is found', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [] }),
  });
  const recalled = await recallCompany('missing-co', config);
  assert.equal(recalled, null);
});

test('storeAtTier fails loudly when the bridge answers success:false inside a normal result (key too long)', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-store': () => ({ success: false, error: 'key exceeds 128 characters' }),
  });
  const company: Company = {
    id: 'co-1',
    name: 'Acme',
    primaryGoalId: null,
    budget: { total: 1000, spent: 0, currency: 'USD', period: '2026-09', hardStopThreshold: 0.9 },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await assert.rejects(() => persistCompany(company, config), /refused key .*key exceeds 128 characters/);
});

test('heartbeat, comment and approval-transition keys are company-scoped and stay under the bridge cap with long ids', () => {
  const companyId = 'cognitum';
  const goalId = 'goal-ruclip-launch';
  const issueId = 'issue-heartbeat-scheduler-loop';
  const hb = heartbeatKey(companyId, { kind: 'issue', goalId, issueId }, 'hb-issue-issue-heartbeat-scheduler-loop');
  assert.equal(hb, 'ruclip:company:cognitum:heartbeat:hb-issue-issue-heartbeat-scheduler-loop');
  assert.ok(hb.length <= MAX_AGENTDB_KEY_LENGTH);
  const cm = commentKey(companyId, goalId, 'issue-a77be3cc-3cd6-455f-bf65-606f87f439ef', 'comment-10cb0f00-22fc-4156-b64c-ebca97472537');
  assert.equal(cm, 'ruclip:company:cognitum:comment:comment-10cb0f00-22fc-4156-b64c-ebca97472537');
  assert.ok(cm.length <= MAX_AGENTDB_KEY_LENGTH);
  assert.throws(() => goalKey(companyId, 'g'.repeat(120)), /exceeds 128 characters/);
});
