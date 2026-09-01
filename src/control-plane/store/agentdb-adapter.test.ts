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
} from './agentdb-adapter.js';
import type { Company } from '../schema/company.js';
import type { OrgMember } from '../schema/org-member.js';

const now = '2026-09-01T00:00:00.000Z';

interface RecordedCall {
  toolName: string;
  args: Record<string, unknown>;
}

/** Builds a fetchImpl that dispatches on the MCP tool name being called. */
function mockBridge(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
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

test('keying scheme matches DOMAIN-MODEL.md §2.2', () => {
  assert.equal(companyKey('co-1'), 'ruclip:company:co-1');
  assert.equal(orgMemberKey('co-1', 'om-1'), 'ruclip:company:co-1:org-member:om-1');
  assert.equal(goalKey('co-1', 'goal-1'), 'ruclip:company:co-1:goal:goal-1');
  assert.equal(issueKey('co-1', 'goal-1', 'issue-1'), 'ruclip:company:co-1:goal:goal-1:issue:issue-1');
  assert.equal(
    commentKey('co-1', 'goal-1', 'issue-1', 'comment-1'),
    'ruclip:company:co-1:goal:goal-1:issue:issue-1:comment:comment-1',
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

test('recallCompany returns null when no exact key match is found', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [] }),
  });
  const recalled = await recallCompany('missing-co', config);
  assert.equal(recalled, null);
});
