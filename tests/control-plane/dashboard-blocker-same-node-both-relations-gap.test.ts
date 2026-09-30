/**
 * Dream Cycle 2026-09-30 — DEEP=correctness. KNOWN GAP, not fixed tonight
 * (see repo convention: *-gaps.test.ts pins a known limitation as tracked,
 * tested evidence rather than leaving it undocumented — e.g.
 * actor-credential-authorization-gaps.test.ts,
 * employee-profile-access-control-gaps.test.ts).
 *
 * Tonight's candidate (dashboard-blocker-parent-contamination.test.ts)
 * fixes `buildDashboardSnapshot` so an issue's own parent/child can no
 * longer leak into its `blockerIssueIds` just because the real k-hop
 * backend ignores the `relation` filter (see that file's header for the
 * full, independently-verified evidence chain). That fix works by
 * excluding any neighbor id that is provably parent_of noise — the issue's
 * own parentId or one of its own children.
 *
 * The gap: nothing in the schema prevents a `parent_of` edge and a
 * `blocks` edge from existing between the SAME pair of issues (e.g. a
 * subtask that also genuinely blocks its own parent epic — DOMAIN-MODEL.md
 * §1.4 imposes no such restriction, and `blocks` is deliberately excluded
 * from `CYCLE_CHECKED_RELATIONS` in agentdb-adapter.ts). Because the real
 * k-hop backend returns a plain neighbor-id list with no relation
 * information attached (confirmed live, same verification as the sibling
 * test), tonight's fix cannot distinguish "this neighbor is here only via
 * parent_of noise" from "this neighbor is here via parent_of AND a real
 * blocks edge" — it drops both, silently hiding a genuine blocker.
 *
 * Not reachable today: `addBlocksEdge` (agentdb-adapter.ts) has zero
 * production call sites in this repo (grep-confirmed — the only caller is
 * this repo's own test suite), so no real `blocks` edge is currently
 * created by any live code path. This test pins the gap as known,
 * intentional, un-silent scope for tonight's candidate — not a defect
 * introduced by it — so a future dream-cycle night (or `addBlocksEdge`'s
 * eventual real caller) has a concrete, reproducible starting point rather
 * than having to rediscover this by hand. Closing it needs a dedicated
 * `blockerIds`-style field maintained alongside `addBlocksEdge` writes
 * (the same class of fix `childIssueIds` already got from `parentId`), out
 * of tonight's single-conceptual-change scope.
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
  'KNOWN GAP (untouched by tonight\'s fix): a genuine blocks edge between an issue and its own parent is ' +
    "currently indistinguishable from parent_of noise and gets dropped from blockerIssueIds, since the real " +
    'k-hop backend returns no relation information to tell them apart — not reachable today because ' +
    'addBlocksEdge has no production caller',
  async () => {
    const company = baseCompany();
    const goal = baseGoal();
    // issue-parent -[parent_of]-> issue-child AND issue-parent -[blocks]-> issue-child:
    // both edges exist between the same pair. The real backend's k-hop call
    // cannot report them separately — it returns one flat neighbor list.
    const parentIssue = baseIssue({ id: 'issue-parent' });
    const childIssue = baseIssue({ id: 'issue-child', parentId: 'issue-parent' });

    const adjacency: Record<string, string[]> = {
      'entity:issue:issue-parent': ['entity:issue:issue-child'],
      'entity:issue:issue-child': ['entity:issue:issue-parent'],
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
            ? { results: [{ value: JSON.stringify(parentIssue) }, { value: JSON.stringify(childIssue) }] }
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

    // Documents the known gap: issue-parent IS a real blocker of issue-child
    // here, but tonight's fix cannot tell that apart from ordinary parent_of
    // noise and drops it. If this assertion ever starts failing because
    // blockerIssueIds correctly includes 'issue-parent', that means the gap
    // has been closed — update this test to assert the fixed behavior
    // instead of treating the failure as a regression.
    assert.deepEqual(
      childSnapshot.blockerIssueIds,
      [],
      'KNOWN GAP: the real blocks edge from issue-parent is indistinguishable from parent_of noise and is ' +
        'currently dropped — see file header',
    );
  },
);
