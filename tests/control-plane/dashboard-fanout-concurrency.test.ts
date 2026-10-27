/**
 * Dream Cycle 2026-10-27 (performance/memory + docs/api scan).
 *
 * FINDING: `buildGoalSnapshot` (dashboard/build-snapshot.ts) built every
 * issue's `DashboardIssueSnapshot` — each of which fires its own
 * `getChildIssueIds`/`getBlockerIssueIds` `agentdb_graph-query` round
 * trips — through a bare `Promise.all(rawIssues.map(buildIssueSnapshot))`.
 * Peak concurrent `agentdb_graph-query` RPCs therefore scaled directly
 * with the goal's own issue count, with no ceiling — the exact unbounded
 * fan-out shape `checkOperatingBudget` had before the 2026-09-03 fix
 * (store/agentdb-adapter.ts's `SESSION_COST_FETCH_CONCURRENCY`), just
 * never applied to this later call site. For a goal with many issues this
 * can open hundreds of simultaneous RPCs against the bridge on a single
 * dashboard-snapshot build.
 *
 * This test measures peak concurrent `agentdb_graph-query` calls directly
 * (not wall-clock time, which would be flaky under a mocked bridge) using
 * a counter the mock handler bumps on entry and drops after a short,
 * fixed delay — long enough for every call issued in the same scheduling
 * wave to have started before the first one resolves, so the peak is a
 * faithful count of true overlap, not a timing artifact.
 *
 * FIXED: `buildGoalSnapshot` now runs that same fan-out through the
 * existing, newly-exported `mapWithConcurrency` worker pool, capped at
 * `DASHBOARD_ISSUE_FANOUT_CONCURRENCY` (25) concurrent `buildIssueSnapshot`
 * calls — bounding peak graph-query concurrency to a constant
 * (2 × 25 = 50, since each issue fires 2 graph-query calls), independent
 * of the goal's own issue count, instead of O(issue count).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { buildDashboardSnapshot } from '../../src/control-plane/dashboard/build-snapshot.js';
import type { Goal } from '../../src/control-plane/schema/goal.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { Company } from '../../src/control-plane/schema/company.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';

const now = '2026-09-01T00:00:00.000Z';

const ISSUE_COUNT = 60;
// 25-issue-wide worker pool x 2 graph-query calls per issue (child + blocker).
const EXPECTED_BOUND = 50;

function buildManyIssueCompany() {
  const company: Company = {
    id: 'co-1',
    name: 'Scale Co',
    primaryGoalId: 'goal-1',
    budget: { total: 1000, spent: 100, currency: 'USD', period: '2026-09', hardStopThreshold: 1 },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  const goal: Goal = {
    id: 'goal-1',
    companyId: 'co-1',
    description: 'Scale test',
    successCriteria: ['n/a'],
    status: 'active',
    ownerId: null,
    budgetAllocation: null,
    createdAt: now,
    updatedAt: now,
  };
  const member: OrgMember = {
    id: 'om-shared',
    companyId: 'co-1',
    kind: 'agent',
    identityRef: 'agent-shared',
    role: 'Engineer',
    managerId: null,
    status: 'active',
  };
  const issues: Issue[] = Array.from({ length: ISSUE_COUNT }, (_, i) => ({
    id: `issue-${i}`,
    goalId: 'goal-1',
    parentId: null,
    // Every issue shares one assignee — resolveOrgMemberRef's per-build
    // memoization (unrelated to this fix) means assignee lookups are not
    // what we're measuring here; only the two graph-query calls per issue
    // are unbounded before this fix.
    assigneeId: 'om-shared',
    title: `Issue ${i}`,
    description: '',
    status: 'open',
    approvalState: 'draft',
    budgetImpact: 0,
    approvalTransitionRef: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  }));
  return { company, goal, member, issues };
}

test('buildDashboardSnapshot bounds peak concurrent graph-query RPCs for a goal with many issues, independent of issue count', async () => {
  const { company, goal, member, issues } = buildManyIssueCompany();

  let inFlight = 0;
  let peak = 0;

  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      const query = args.query as string;
      const tier = args.tier as string;
      if (tier === 'semantic' && query === 'ruclip:company:co-1') {
        return { results: [{ key: query, value: JSON.stringify(company) }] };
      }
      if (tier === 'semantic' && query === 'ruclip:company:co-1:org-member:om-shared') {
        return { results: [{ key: query, value: JSON.stringify(member) }] };
      }
      if (tier === 'semantic' && query === 'ruclip:company:co-1 goal') {
        return { results: [{ value: JSON.stringify(goal) }] };
      }
      if (query === 'ruclip:company:co-1:goal:goal-1 issue') {
        return tier === 'working' ? { results: issues.map((issue) => ({ value: JSON.stringify(issue) })) } : { results: [] };
      }
      if (query === 'ruclip:company:co-1 heartbeat') {
        return { results: [] };
      }
      return { results: [] };
    },
    'agentdb_graph-query': async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Long enough that every call issued in the same scheduling wave has
      // started (and been counted above) before any of them resolve —
      // makes the peak measurement deterministic rather than a timing race.
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return { results: [] };
    },
  });

  const snapshot = await buildDashboardSnapshot('co-1', config);
  assert.ok(snapshot, 'expected a snapshot for an existing company');
  assert.equal(snapshot!.goals[0]!.issues.length, ISSUE_COUNT, 'output correctness unaffected by the concurrency bound');

  assert.ok(
    peak <= EXPECTED_BOUND,
    `peak concurrent agentdb_graph-query calls was ${peak}, expected <= ${EXPECTED_BOUND} ` +
      `(${ISSUE_COUNT} issues x 2 graph-query calls each, unbounded, would be ${ISSUE_COUNT * 2})`,
  );
});
