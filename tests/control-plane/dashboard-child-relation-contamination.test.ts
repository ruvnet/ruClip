/**
 * Dream Cycle 2026-09-20 — DEEP=correctness.
 *
 * FINDING: `getChildIssueIds`/`getBlockerIssueIds` (store/agentdb-adapter.ts)
 * ask `agentdb_graph-query`'s k-hop mode to filter by `relation`
 * ('parent_of'/'blocks'). The real, currently-installed, load-bearing
 * backend for that call (`@ruvector/graph-node@2.1.0` via
 * `@claude-flow/cli`'s `agentdb-tools.js` k-hop dispatch, confirmed by
 * `npm ls @ruvector/graph-node`) tries its native `graph-node` path FIRST
 * and, when available, calls `getNeighbors(nodeId, depth)` ->
 * `db.kHopNeighbors(nodeId, depth)` — a binding that takes NO relation
 * parameter at all (see `node_modules/@ruvector/graph-node/index.d.ts`).
 * `relation` is silently accepted by the MCP tool's own schema and then
 * dropped on this (the default, first-tried) code path — only the SQL CTE
 * fallback (`buildKHopCTE`, used only when the native backend is
 * unavailable) actually applies it.
 *
 * Verified live against the real installed native module (not inferred
 * from docs): creating `issue:A -[parent_of]-> issue:B` and
 * `issue:A -[blocks]-> issue:C` and calling `kHopNeighbors('issue:A', 1)`
 * returns BOTH `issue:B` and `issue:C` regardless of which relation was
 * asked for (also, separately, confirmed the traversal is direction-blind —
 * an issue's own parent surfaces as its own "neighbor" too — not
 * exercised by this test, which isolates the relation-blindness alone).
 *
 * Net effect on this repo's own code: `getChildIssueIds(issueId)` (relation
 * 'parent_of') and `getBlockerIssueIds(issueId)` (relation 'blocks') can
 * both return the SAME raw neighbor set for an issue that has edges of
 * both kinds — a `blocks`-only-related issue can appear in `childIssueIds`
 * (and vice versa). This is a DIFFERENT defect from the two already known
 * against this same dependency (2026-09-05's `results`/`nodeId` shape fix,
 * merged as #13; 2026-09-10's self-echo-in-k-hop fix, still open as #23) —
 * neither of those touches relation-scoping at all.
 *
 * FIX: `parentId` already lives directly on every `Issue` document
 * (schema/issue.ts) and is the authoritative source of the parent/child
 * relationship — DOMAIN-MODEL.md never derives it from the graph alone.
 * `buildDashboardSnapshot` already collects every issue belonging to the
 * company before its existing cross-company post-processing pass (security
 * review round 8, dashboard-cross-company-gap.test.ts) — extended here to
 * ALSO recompute `childIssueIds` from that authoritative, already-in-memory
 * `parentId` data instead of trusting the graph for it, with zero new
 * AgentDB calls. `blockerIssueIds` has no equivalent ground-truth field
 * (a `blocks` edge is the only record of that relationship), so it is
 * unchanged here and remains exposed to the same underlying dependency
 * defect — a follow-up, not silently claimed fixed by this candidate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { buildDashboardSnapshot } from '../../src/control-plane/dashboard/build-snapshot.js';
import type { Goal } from '../../src/control-plane/schema/goal.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { Company } from '../../src/control-plane/schema/company.js';

const now = '2026-09-01T00:00:00.000Z';

function baseCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: 'co-1',
    name: 'Acme Robotics',
    primaryGoalId: 'goal-1',
    budget: { total: 1000, spent: 100, currency: 'USD', period: '2026-09', hardStopThreshold: 1 },
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    companyId: 'co-1',
    description: 'Ship v1',
    successCriteria: [],
    status: 'active',
    ownerId: null,
    budgetAllocation: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-x',
    goalId: 'goal-1',
    parentId: null,
    assigneeId: null,
    title: 'An issue',
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

test(
  'FIXED: buildDashboardSnapshot derives childIssueIds from Issue.parentId, not from the relation-blind ' +
    "real k-hop backend — an issue's blocks-only neighbor no longer leaks into its childIssueIds",
  async () => {
    const company = baseCompany();
    const goal = baseGoal();
    // issue-parent -[parent_of]-> issue-child (a real parent/child pair)
    // issue-parent -[blocks]-> issue-blocked (an unrelated blocking edge)
    const parentIssue = baseIssue({ id: 'issue-parent' });
    const childIssue = baseIssue({ id: 'issue-child', parentId: 'issue-parent' });
    const blockedIssue = baseIssue({ id: 'issue-blocked' });

    // Mimics the real, currently-installed native graph-node k-hop backend:
    // one adjacency list per node, returned identically REGARDLESS of the
    // `relation` argument (the real bug — see file header). `args.relation`
    // is deliberately never inspected here.
    const adjacency: Record<string, string[]> = {
      'entity:issue:issue-parent': ['entity:issue:issue-child', 'entity:issue:issue-blocked'],
      'entity:issue:issue-child': ['entity:issue:issue-parent'],
      'entity:issue:issue-blocked': ['entity:issue:issue-parent'],
    };

    const { config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        const query = args.query as string;
        if (args.tier === 'semantic' && query === 'ruclip:company:co-1') {
          return { results: [{ key: query, value: JSON.stringify(company) }] };
        }
        if (args.tier === 'semantic' && query === 'ruclip:company:co-1 goal') {
          return { results: [{ value: JSON.stringify(goal) }] };
        }
        if (query === 'ruclip:company:co-1:goal:goal-1 issue') {
          return args.tier === 'working'
            ? {
                results: [
                  { value: JSON.stringify(parentIssue) },
                  { value: JSON.stringify(childIssue) },
                  { value: JSON.stringify(blockedIssue) },
                ],
              }
            : { results: [] };
        }
        if (query === 'ruclip:company:co-1 heartbeat') {
          return { results: [] };
        }
        return { results: [] };
      },
      'agentdb_graph-query': (args) => {
        const neighbors = adjacency[args.nodeId as string] ?? [];
        return { results: neighbors.map((nodeId) => ({ nodeId })) };
      },
    });

    const snapshot = await buildDashboardSnapshot('co-1', config);
    assert.ok(snapshot);
    const issues = snapshot!.goals[0]!.issues;

    const parentSnapshot = issues.find((i) => i.id === 'issue-parent')!;
    assert.deepEqual(
      parentSnapshot.childIssueIds,
      ['issue-child'],
      'issue-blocked must not leak into childIssueIds just because the real backend ignored the relation filter',
    );

    const childSnapshot = issues.find((i) => i.id === 'issue-child')!;
    assert.deepEqual(
      childSnapshot.childIssueIds,
      [],
      "issue-child's own parent must not appear in its childIssueIds",
    );

    const blockedSnapshot = issues.find((i) => i.id === 'issue-blocked')!;
    assert.deepEqual(
      blockedSnapshot.childIssueIds,
      [],
      'issue-blocked has no children of its own via parentId',
    );
  },
);
