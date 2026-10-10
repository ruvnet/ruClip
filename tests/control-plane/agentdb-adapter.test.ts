/**
 * Additional AgentDB adapter coverage, complementing
 * src/control-plane/store/agentdb-adapter.test.ts (coder stage), which
 * already covers keying, tierForIssueStatus, persistCompany,
 * persistOrgMember, recordCausalEdge cycle refusal, and recallCompany.
 *
 * This file covers the functions that suite doesn't exercise: persistGoal,
 * recallGoal, recallOrgMember, persistIssue (including the working->episodic
 * tier move on close), recallIssue's working->episodic fallback,
 * addBlocksEdge, getBlockerIssueIds, getChildIssueIds, persistComment,
 * storePattern/searchPatterns, a genuine (non-self-referential) parent_of
 * cycle, and — per the task brief — a canary that would fail if
 * budgetImpact/approvalState were silently dropped before hitting the wire.
 *
 * No live AgentDB instance is used anywhere here: every call goes through
 * mockBridge (tests/support/mock-bridge.ts), which dispatches on MCP tool
 * name exactly like the coder's own suite does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import {
  persistGoal,
  recallGoal,
  recallOrgMember,
  persistIssue,
  recallIssue,
  addBlocksEdge,
  getBlockerIssueIds,
  getChildIssueIds,
  persistComment,
  storePattern,
  searchPatterns,
  recordCausalEdge,
  AgentDbBridgeError,
} from '../../src/control-plane/store/agentdb-adapter.js';
import type { Goal } from '../../src/control-plane/schema/goal.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { Comment } from '../../src/control-plane/schema/comment.js';

const now = '2026-09-01T00:00:00.000Z';

function baseGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    companyId: 'co-1',
    description: 'Ship v1',
    successCriteria: ['Users can sign up'],
    status: 'active',
    ownerId: 'om-1',
    budgetAllocation: 500,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    goalId: 'goal-1',
    parentId: null,
    assigneeId: null,
    title: 'Build login',
    description: '',
    status: 'open',
    approvalState: 'draft',
    budgetImpact: 0,
    approvalTransitionRef: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    ...overrides,
  };
}

// --- Goal ---------------------------------------------------------------

test('persistGoal stores to the semantic tier and writes a belongs_to edge to its company', async () => {
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  await persistGoal(baseGoal(), config);
  const toolNames = calls.map((c) => c.toolName);
  assert.deepEqual(toolNames, ['agentdb_hierarchical-store', 'agentdb_causal-edge']);
  assert.equal(calls[0]?.args.key, 'ruclip:company:co-1:goal:goal-1');
  assert.equal(calls[0]?.args.tier, 'semantic');
  assert.equal(calls[1]?.args.relation, 'belongs_to');
  assert.equal(calls[1]?.args.sourceId, 'entity:goal:goal-1');
  assert.equal(calls[1]?.args.targetId, 'entity:company:co-1');
});

test('persistGoal rejects an invalid goal before any bridge call is made', async () => {
  const { calls, config } = mockBridge({});
  const invalidGoal = baseGoal({ description: '' });
  await assert.rejects(() => persistGoal(invalidGoal, config));
  assert.equal(calls.length, 0);
});

test('recallGoal returns the goal on an exact-key hit', async () => {
  const stored = baseGoal();
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({
      results: [{ key: 'ruclip:company:co-1:goal:goal-1', value: JSON.stringify(stored) }],
    }),
  });
  const recalled = await recallGoal('co-1', 'goal-1', config);
  assert.deepEqual(recalled, stored);
});

// --- OrgMember recall ------------------------------------------------------

test('recallOrgMember returns null when hierarchical-recall has no exact-key match', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [{ key: 'ruclip:company:co-1:org-member:someone-else', value: '{}' }] }),
  });
  const recalled = await recallOrgMember('co-1', 'om-missing', config);
  assert.equal(recalled, null);
});

test('recallOrgMember returns the member on an exact-key hit', async () => {
  const stored: OrgMember = {
    id: 'om-2',
    companyId: 'co-1',
    kind: 'human',
    identityRef: 'bbs:jane',
    role: 'Engineer',
    managerId: 'om-1',
    status: 'active',
  };
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({
      results: [{ key: 'ruclip:company:co-1:org-member:om-2', value: JSON.stringify(stored) }],
    }),
  });
  const recalled = await recallOrgMember('co-1', 'om-2', config);
  assert.deepEqual(recalled, stored);
});

// --- Issue: persist, tier moves, edges --------------------------------------

test('persistIssue on first creation (no previousStatus) does not touch hierarchical-delete', async () => {
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [] }),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  await persistIssue('co-1', baseIssue({ status: 'open' }), undefined, undefined, undefined, config);
  const toolNames = calls.map((c) => c.toolName);
  assert.ok(!toolNames.includes('agentdb_hierarchical-delete'));
  const storeCall = calls.find((c) => c.toolName === 'agentdb_hierarchical-store');
  assert.equal(storeCall?.args.tier, 'working');
});

test('persistIssue closing an issue (open -> done) re-stores to episodic and deletes the stale working copy', async () => {
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [] }),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_hierarchical-delete': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  const closedIssue = baseIssue({ status: 'done', closedAt: now, budgetImpact: 0 });
  await persistIssue('co-1', closedIssue, 'open', undefined, undefined, config);

  const storeCall = calls.find((c) => c.toolName === 'agentdb_hierarchical-store');
  const deleteCall = calls.find((c) => c.toolName === 'agentdb_hierarchical-delete');
  assert.equal(storeCall?.args.tier, 'episodic');
  assert.equal(storeCall?.args.key, 'ruclip:company:co-1:goal:goal-1:issue:issue-1');
  assert.equal(deleteCall?.args.tier, 'working');
  assert.equal(deleteCall?.args.key, storeCall?.args.key);
});

test('persistIssue does not call hierarchical-delete when previousStatus maps to the same tier as the new status', async () => {
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [] }),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  // open -> in_progress: both 'working' tier.
  await persistIssue('co-1', baseIssue({ status: 'in_progress' }), 'open', undefined, undefined, config);
  assert.ok(!calls.some((c) => c.toolName === 'agentdb_hierarchical-delete'));
});

test('persistIssue with a parentId checks for a parent_of cycle before writing the edge', async () => {
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [] }),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_graph-query': () => ({ results: [] }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  await persistIssue('co-1', baseIssue({ parentId: 'issue-parent' }), undefined, undefined, undefined, config);
  const toolNames = calls.map((c) => c.toolName);
  // Guard A/B's recallIssue read (working tier, then episodic fallback) runs
  // first; belongs_to (goal) needs no cycle check, parent_of does.
  assert.deepEqual(toolNames, [
    'agentdb_hierarchical-recall', // Guard A/B read: working tier
    'agentdb_hierarchical-recall', // Guard A/B read: episodic fallback
    'agentdb_hierarchical-store',
    'agentdb_causal-edge', // belongs_to -> goal
    'agentdb_graph-query', // cycle check for parent_of
    'agentdb_causal-edge', // parent_of
  ]);
  const parentEdge = calls.filter((c) => c.toolName === 'agentdb_causal-edge')[1];
  assert.equal(parentEdge?.args.relation, 'parent_of');
  assert.equal(parentEdge?.args.sourceId, 'entity:issue:issue-parent');
  assert.equal(parentEdge?.args.targetId, 'entity:issue:issue-1');
});

test('persistIssue refuses a parent_of edge that would close a genuine (non-self) cycle, and never writes the assigned_to edge that would have followed', async () => {
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [] }),
    'agentdb_hierarchical-store': () => ({ success: true }),
    // The proposed parent ("issue-parent") is reachable from the issue being
    // persisted ("issue-1") — i.e. issue-parent is already a descendant of
    // issue-1 — so parent_of: issue-parent -> issue-1 would close a cycle.
    'agentdb_graph-query': () => ({ results: [{ nodeId: 'entity:issue:issue-parent' }] }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  const issue = baseIssue({ parentId: 'issue-parent', assigneeId: 'om-9' });
  await assert.rejects(() => persistIssue('co-1', issue, undefined, undefined, undefined, config), AgentDbBridgeError);
  const toolNames = calls.map((c) => c.toolName);
  // Guard A/B read succeeded (stored=null), belongs_to succeeded, then the
  // cycle check ran and rejected before any parent_of/assigned_to edge write
  // was attempted.
  assert.deepEqual(toolNames, [
    'agentdb_hierarchical-recall',
    'agentdb_hierarchical-recall',
    'agentdb_hierarchical-store',
    'agentdb_causal-edge',
    'agentdb_graph-query',
  ]);
});

// --- wouldCreateCycle vs. the real tool's server-side depth clamp ----------

/**
 * Simulates the real, installed `agentdb_graph-query` tool's actual k-hop
 * depth clamp (`node_modules/@claude-flow/cli/dist/src/mcp-tools/agentdb-
 * tools.js`, `agentdbGraphQuery.handler`): `budget.maxDepth = complexity
 * Budget?.maxDepth ?? 5`, then the effective depth is
 * `Math.min(requestedDepth ?? 2, budget.maxDepth)` — a caller's `depth`
 * above the server's own budget is silently ignored unless
 * `complexityBudget.maxDepth` is also raised. This is the exact mechanism
 * the 2026-09-05 dream-cycle night (issue #12) read from the real tool
 * source and flagged as still-open follow-up work (`wouldCreateCycle`'s
 * hardcoded `depth: 5` alone can never see past 5 hops against the real
 * bridge, no matter how large `depth` is set, because `complexityBudget`
 * was never sent).
 */
function graphQueryDepthClampHandler(chain: Record<string, string>) {
  return (args: Record<string, unknown>) => {
    const requestedDepth = typeof args.depth === 'number' ? args.depth : 2;
    const budget = args.complexityBudget as { maxDepth?: number } | undefined;
    const maxDepth = typeof budget?.maxDepth === 'number' ? budget.maxDepth : 5;
    const effectiveDepth = Math.min(requestedDepth, maxDepth);
    const results: Array<{ nodeId: string }> = [];
    let current = args.nodeId as string;
    for (let hop = 0; hop < effectiveDepth; hop++) {
      const next = chain[current];
      if (!next) break;
      results.push({ nodeId: next });
      current = next;
    }
    return { results };
  };
}

// n0 -> n1 -> ... -> n8: an 8-hop parent_of chain already recorded in the
// graph (8 prior persistIssue/persistOrgMember-style writes, not re-created
// here — only the resulting graph shape matters to wouldCreateCycle).
const EIGHT_HOP_CHAIN: Record<string, string> = Object.fromEntries(
  Array.from({ length: 8 }, (_, i) => [`entity:issue:n${i}`, `entity:issue:n${i + 1}`]),
);

test('wouldCreateCycle misses an 8-hop cycle when the real tool server-clamps depth to its default of 5 (no complexityBudget sent)', async () => {
  // Reproduces the baseline bug directly: calling agentdb_graph-query with
  // only `depth`, no `complexityBudget`, against a mock that enforces the
  // real tool's own default maxDepth=5 clamp. n8 is 8 hops from n0, beyond
  // that clamp, so the cycle must go undetected and the edge write must
  // proceed (wrongly) rather than reject.
  const { config } = mockBridge({
    'agentdb_graph-query': (args) => {
      // depth alone, uncapped by complexityBudget, still clamps to 5 —
      // the real server ignores depth above its own default budget.
      const effectiveDepth = Math.min(typeof args.depth === 'number' ? args.depth : 2, 5);
      const results: Array<{ nodeId: string }> = [];
      let current = args.nodeId as string;
      for (let hop = 0; hop < effectiveDepth; hop++) {
        const next = EIGHT_HOP_CHAIN[current];
        if (!next) break;
        results.push({ nodeId: next });
        current = next;
      }
      return { results };
    },
    'agentdb_causal-edge': () => ({ success: true }),
  });
  // Would close an 8-hop cycle (n8 -> n0 -> n1 -> ... -> n8), but a 5-hop
  // clamp can never see n8 from n0 — demonstrates the gap, not the fix.
  await assert.doesNotReject(() => recordCausalEdge('entity:issue:n8', 'entity:issue:n0', 'parent_of', config));
});

test('wouldCreateCycle detects an 8-hop cycle once complexityBudget.maxDepth is sent (the actual fix: depth alone is not enough)', async () => {
  const { config } = mockBridge({
    'agentdb_graph-query': graphQueryDepthClampHandler(EIGHT_HOP_CHAIN),
    // Registered so that, against the unfixed baseline (cycle undetected),
    // this test fails on a genuine missing `assert.rejects` rather than on
    // an incidental "no mock handler for agentdb_causal-edge" throw — the
    // exact wrong-reason-pass trap issue #12 flagged in a different test.
    'agentdb_causal-edge': () => ({ success: true }),
  });
  await assert.rejects(
    () => recordCausalEdge('entity:issue:n8', 'entity:issue:n0', 'parent_of', config),
    AgentDbBridgeError,
  );
});

test('wouldCreateCycle still correctly ignores a non-cycle beyond its search depth', async () => {
  // n9 was never linked into the chain at all — not a cycle at any depth.
  const { config } = mockBridge({
    'agentdb_graph-query': graphQueryDepthClampHandler(EIGHT_HOP_CHAIN),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  await assert.doesNotReject(() =>
    recordCausalEdge('entity:issue:n9', 'entity:issue:n0', 'parent_of', config),
  );
});

test('recallIssue falls back to the episodic tier when the working tier has no match', async () => {
  const closedIssue = baseIssue({ status: 'done', closedAt: now });
  let recallCallCount = 0;
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      recallCallCount += 1;
      if (args.tier === 'working') return { results: [] };
      if (args.tier === 'episodic') {
        return {
          results: [
            { key: 'ruclip:company:co-1:goal:goal-1:issue:issue-1', value: JSON.stringify(closedIssue) },
          ],
        };
      }
      return { results: [] };
    },
  });
  const recalled = await recallIssue('co-1', 'goal-1', 'issue-1', config);
  assert.deepEqual(recalled, closedIssue);
  assert.equal(recallCallCount, 2);
});

test('recallIssue returns null when neither working nor episodic has a match', async () => {
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [] }),
  });
  const recalled = await recallIssue('co-1', 'goal-1', 'missing-issue', config);
  assert.equal(recalled, null);
});

// --- blocks edge / graph reads ----------------------------------------------

test('addBlocksEdge writes a blocks edge with no cycle check (blocks is not a tree relation)', async () => {
  const { calls, config } = mockBridge({
    'agentdb_causal-edge': () => ({ success: true }),
  });
  await addBlocksEdge('issue-a', 'issue-b', config);
  assert.deepEqual(
    calls.map((c) => c.toolName),
    ['agentdb_causal-edge'],
  );
  assert.equal(calls[0]?.args.relation, 'blocks');
  assert.equal(calls[0]?.args.sourceId, 'entity:issue:issue-a');
  assert.equal(calls[0]?.args.targetId, 'entity:issue:issue-b');
});

test('getBlockerIssueIds strips the entity:issue: prefix and ignores non-issue neighbors', async () => {
  const { config } = mockBridge({
    'agentdb_graph-query': () => ({
      results: [
        { nodeId: 'entity:issue:blocker-1' },
        { nodeId: 'entity:org-member:om-1' },
        { nodeId: 'entity:issue:blocker-2' },
      ],
    }),
  });
  const blockers = await getBlockerIssueIds('issue-1', config);
  assert.deepEqual(blockers.sort(), ['blocker-1', 'blocker-2']);
});

test('getChildIssueIds strips the entity:issue: prefix and ignores non-issue neighbors', async () => {
  const { config } = mockBridge({
    'agentdb_graph-query': () => ({
      results: [{ nodeId: 'entity:issue:child-1' }, { nodeId: 'entity:goal:goal-1' }],
    }),
  });
  const children = await getChildIssueIds('issue-1', config);
  assert.deepEqual(children, ['child-1']);
});

// --- Comment ---------------------------------------------------------------

test('persistComment stores at the tier passed in for the parent issue', async () => {
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const comment: Comment = { id: 'comment-1', issueId: 'issue-1', authorId: 'om-1', body: 'hi', createdAt: now };
  await persistComment('co-1', 'goal-1', comment, 'working', config);
  assert.equal(calls[0]?.args.key, 'ruclip:company:co-1:comment:comment-1');
  assert.equal(calls[0]?.args.tier, 'working');
});

test('persistComment rejects an invalid comment before any bridge call', async () => {
  const { calls, config } = mockBridge({});
  const invalidComment = { id: 'comment-1', issueId: 'issue-1', authorId: 'om-1', body: '', createdAt: now } as Comment;
  await assert.rejects(() => persistComment('co-1', 'goal-1', invalidComment, 'working', config));
  assert.equal(calls.length, 0);
});

// --- Pattern-store namespace encoding (DOMAIN-MODEL.md §2.4 deviation) -----

test('storePattern encodes the namespace into the `type` field (the tool has no `namespace` param)', async () => {
  const { calls, config } = mockBridge({
    'agentdb_pattern-store': () => ({ success: true }),
  });
  await storePattern('ruclip/approval-heuristics', 'issues under $500 auto-approve', 0.6, config);
  assert.equal(calls[0]?.args.type, 'ruclip/approval-heuristics');
  assert.equal(calls[0]?.args.pattern, 'issues under $500 auto-approve');
  assert.equal(calls[0]?.args.confidence, 0.6);
  assert.equal(calls[0]?.args.namespace, undefined);
});

test('searchPatterns filters out results whose type does not match the requested namespace', async () => {
  const { config } = mockBridge({
    'agentdb_pattern-search': () => ({
      results: [
        { pattern: 'a', type: 'ruclip/approval-heuristics', confidence: 0.9 },
        { pattern: 'b', type: 'ruclip/issue-templates', confidence: 0.9 },
        { pattern: 'c', type: 'ruclip/approval-heuristics', confidence: 0.5 },
      ],
    }),
  });
  const results = await searchPatterns('ruclip/approval-heuristics', 'budget', 5, config);
  assert.deepEqual(
    results.map((r) => r.pattern),
    ['a', 'c'],
  );
});

// --- Canary: budgetImpact/approvalState must reach the wire unchanged -----

test(
  'persistIssue round-trips budgetImpact and approvalState verbatim into the hierarchical-store payload ' +
    '— fails if either field were silently dropped or renamed before serialization',
  async () => {
    // Guard A/B need a stored issue whose approvalState/budgetImpact already
    // match the write (unchanged), or the write would be rejected as an
    // illegal direct-create of an 'approved' issue with budgetImpact > 0 —
    // that rejection is exactly Guard A working as designed, not a bug, but
    // it isn't what this canary is testing (whether the fields round-trip to
    // the wire), so the mock represents "this issue already existed in this
    // state" via the working-tier recall.
    const storedIssue = baseIssue({
      status: 'in_progress',
      approvalState: 'approved',
      budgetImpact: 4250,
      approvalTransitionRef: null,
    });
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': (args) =>
        args.tier === 'working'
          ? { results: [{ key: 'ruclip:company:co-1:goal:goal-1:issue:issue-1', value: JSON.stringify(storedIssue) }] }
          : { results: [] },
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_hierarchical-delete': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
    });
    const issue = baseIssue({
      status: 'done',
      approvalState: 'approved',
      budgetImpact: 4250,
      approvalTransitionRef: null,
      closedAt: now,
    });
    await persistIssue('co-1', issue, 'in_progress', undefined, undefined, config);

    const storeCall = calls.find((c) => c.toolName === 'agentdb_hierarchical-store');
    assert.ok(storeCall, 'expected a hierarchical-store call');
    const wirePayload = JSON.parse(storeCall!.args.value as string) as Issue;
    assert.equal(wirePayload.budgetImpact, 4250);
    assert.equal(wirePayload.approvalState, 'approved');
  },
);

test('recordCausalEdge for a non-cycle-checked relation (assigned_to) performs no graph-query call', async () => {
  const { calls, config } = mockBridge({
    'agentdb_causal-edge': () => ({ success: true }),
  });
  await recordCausalEdge('entity:issue:issue-1', 'entity:org-member:om-1', 'assigned_to', config);
  assert.deepEqual(
    calls.map((c) => c.toolName),
    ['agentdb_causal-edge'],
  );
});
