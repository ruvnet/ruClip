/**
 * Dream Cycle 2026-09-30 — DEEP=correctness.
 *
 * FINDING: `getBlockerIssueIds` (store/agentdb-adapter.ts) asks
 * `agentdb_graph-query`'s k-hop mode to filter neighbors by relation
 * ('blocks'). Verified fresh tonight, directly against this repo's own
 * currently-installed dependency (not inferred, and not sourced from any
 * unmerged branch): `node_modules/@claude-flow/cli/dist/src/mcp-tools/
 * agentdb-tools.js`'s k-hop handler parses `relation` but never passes it
 * to `graphBackend.getNeighbors(nodeId, depth)` on the native `graph-node`
 * path (only the unused SQL CTE fallback applies it); that function
 * (`ruvector/graph-backend.js`) forwards to `db.kHopNeighbors(nodeId,
 * hops)`, whose own type signature (`@ruvector/graph-node/index.d.ts`) has
 * no relation parameter at all. Confirmed live by calling the actual
 * installed `@ruvector/graph-node` module directly: a `parent_of` edge and
 * an unrelated `blocks` edge into the same node both come back from one
 * k-hop call, and neighbors surface regardless of edge direction too.
 * (PR #37 / issue #36, 2026-09-20 dream cycle, still open/unmerged as of
 * tonight, independently found and fixed the same underlying defect for
 * `childIssueIds` — a different call site, read for context but not relied
 * on as evidence here since it isn't merged.)
 *
 * `parent_of` and `blocks` are the only two causal relations ever recorded
 * between two issue nodes (schema/enums.ts CausalRelation — the other five
 * relations connect an issue to a goal/org-member, not to another issue).
 * So the raw, relation-blind neighbor set `getBlockerIssueIds` receives for
 * an issue is the union of: its parent, its children (both via `parent_of`,
 * direction-blind), and its actual blocks-relation neighbors. Since an
 * issue's parentId is already an authoritative, non-graph field
 * (schema/issue.ts) and its children are derivable from every sibling
 * issue's own parentId (both already collected in `buildDashboardSnapshot`
 * with zero extra AgentDB calls), any id in `blockerIssueIds` that is
 * provably the issue's own parent or child is provably `parent_of` noise,
 * not a real blocker, and can be removed with full confidence — independent
 * of whatever the real backend does. This does not claim `blockerIssueIds`
 * is fully correct afterward. Two residual gaps remain, both because the
 * underlying k-hop call cannot distinguish relations at all, not from an
 * oversight in this filter: (1) an issue this one itself blocks can still
 * surface here too, since the backend can't distinguish "blocks" from
 * "blocked by"; (2) if an issue's real blocker is ALSO its own parent or
 * child (both a `parent_of` and a `blocks` edge exist between the same
 * pair — legal per the schema), this filter cannot tell that neighbor
 * apart from pure parent_of noise and will drop a genuine blocker — not
 * reachable today since `addBlocksEdge` has zero production call sites
 * (grep-confirmed), see the dedicated gap test in
 * dashboard-blocker-same-node-both-relations-gap.test.ts. This candidate
 * removes only the specific, provable parent/child contamination.
 *
 * This is a different call site from the 2026-09-20 finding (which fixed
 * `childIssueIds`, still open/unmerged as PR #37) — tonight's candidate
 * does not touch `childIssueIds` or depend on PR #37 landing first; it is
 * implemented directly against `main` using only the pre-existing
 * `Issue.parentId` field already present on every issue.
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
  "buildDashboardSnapshot must not let an issue's own parent leak into its blockerIssueIds just because the " +
    "real k-hop backend ignores the relation filter and returns the issue's parent_of neighbor for a 'blocks' query",
  async () => {
    const company = baseCompany();
    const goal = baseGoal();
    // issue-parent -[parent_of]-> issue-child (a real parent/child pair)
    // issue-real-blocker -[blocks]-> issue-child (a real, unrelated blocker)
    const parentIssue = baseIssue({ id: 'issue-parent' });
    const childIssue = baseIssue({ id: 'issue-child', parentId: 'issue-parent' });
    const blockerIssue = baseIssue({ id: 'issue-real-blocker' });

    // Mimics the real, currently-installed native graph-node k-hop backend
    // (2026-09-20 report): one adjacency list per node, returned identically
    // REGARDLESS of the `relation` argument. `args.relation` is deliberately
    // never inspected here.
    const adjacency: Record<string, string[]> = {
      'entity:issue:issue-parent': ['entity:issue:issue-child'],
      'entity:issue:issue-child': ['entity:issue:issue-parent', 'entity:issue:issue-real-blocker'],
      'entity:issue:issue-real-blocker': ['entity:issue:issue-child'],
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
                  { value: JSON.stringify(blockerIssue) },
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

    const childSnapshot = issues.find((i) => i.id === 'issue-child')!;
    assert.deepEqual(
      childSnapshot.blockerIssueIds,
      ['issue-real-blocker'],
      "issue-child's own parent must not appear in its blockerIssueIds, only the real blocks-relation neighbor",
    );

    const parentSnapshot = issues.find((i) => i.id === 'issue-parent')!;
    assert.deepEqual(
      parentSnapshot.blockerIssueIds,
      [],
      "issue-parent's own child must not appear in its blockerIssueIds (direction-blind leak)",
    );
  },
);
