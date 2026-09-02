/**
 * Coverage for RUCLIP-DASHBOARD.md §5: listGoalsForCompany/listIssuesForGoal
 * (the real gap the design found — no primitive listed Goals/Issues scoped
 * to a company/goal before this slice), listHeartbeatsForCompany (the
 * deviation found while implementing — listDueHeartbeats actively excludes
 * paused/blocked schedules, which §2 explicitly wants shown plainly), and
 * buildDashboardSnapshot's assembled output shape, including a
 * budget-blocked heartbeat to prove that requirement holds end to end.
 *
 * No live AgentDB instance — mockBridge, same as the rest of this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import {
  listGoalsForCompany,
  listIssuesForGoal,
  listHeartbeatsForCompany,
} from '../../src/control-plane/store/agentdb-adapter.js';
import { buildDashboardSnapshot } from '../../src/control-plane/dashboard/build-snapshot.js';
import type { Goal } from '../../src/control-plane/schema/goal.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { Company } from '../../src/control-plane/schema/company.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { HeartbeatSchedule } from '../../src/control-plane/schema/heartbeat-schedule.js';

const now = '2026-09-01T00:00:00.000Z';

function baseGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    companyId: 'co-1',
    description: 'Ship v1',
    successCriteria: ['Users can sign up'],
    status: 'active',
    ownerId: 'om-owner',
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
    assigneeId: 'om-assignee',
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

function baseCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: 'co-1',
    name: 'Acme Robotics',
    primaryGoalId: 'goal-1',
    budget: { total: 1000, spent: 920, currency: 'USD', period: '2026-09', hardStopThreshold: 1 },
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseMember(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'om-owner',
    companyId: 'co-1',
    kind: 'agent',
    identityRef: 'agent-team-name',
    role: 'Engineer',
    managerId: null,
    status: 'active',
    ...overrides,
  };
}

function baseHeartbeat(overrides: Partial<HeartbeatSchedule> = {}): HeartbeatSchedule {
  return {
    id: 'hb-1',
    companyId: 'co-1',
    target: { kind: 'issue', goalId: 'goal-1', issueId: 'issue-1' },
    assigneeId: 'om-assignee',
    cadenceSeconds: 3600,
    status: 'active',
    nextFireAt: '2099-01-01T00:00:00.000Z',
    lastFiredAt: null,
    lastOutcome: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// --- listGoalsForCompany ------------------------------------------------------

test('listGoalsForCompany returns only goals scoped to the requested company, tolerating malformed entries', async () => {
  const goal1 = baseGoal({ id: 'goal-1' });
  const goal2 = baseGoal({ id: 'goal-2' });
  const otherCompanyGoal = baseGoal({ id: 'goal-other', companyId: 'co-2' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) =>
      args.tier === 'semantic'
        ? {
            results: [
              { value: JSON.stringify(goal1) },
              { value: JSON.stringify(goal2) },
              { value: JSON.stringify(otherCompanyGoal) },
              { value: 'not json' },
              { value: JSON.stringify({ description: 'no id field' }) },
              {},
            ],
          }
        : { results: [] },
  });
  const result = await listGoalsForCompany('co-1', config);
  assert.deepEqual(
    result.map((g) => g.id).sort(),
    ['goal-1', 'goal-2'],
  );
});

// --- listIssuesForGoal ---------------------------------------------------------

test('listIssuesForGoal scopes to the requested goal across both working and episodic tiers, tolerating malformed entries', async () => {
  const openIssue = baseIssue({ id: 'issue-open', status: 'open' });
  const doneIssue = baseIssue({ id: 'issue-done', status: 'done', approvalState: 'approved' });
  const otherGoalIssue = baseIssue({ id: 'issue-other', goalId: 'goal-2' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'working') return { results: [{ value: JSON.stringify(openIssue) }, { value: 'garbage' }] };
      if (args.tier === 'episodic')
        return { results: [{ value: JSON.stringify(doneIssue) }, { value: JSON.stringify(otherGoalIssue) }] };
      return { results: [] };
    },
  });
  const result = await listIssuesForGoal('co-1', 'goal-1', config);
  assert.deepEqual(
    result.map((i) => i.id).sort(),
    ['issue-done', 'issue-open'],
  );
});

// --- listHeartbeatsForCompany ---------------------------------------------------

test('listHeartbeatsForCompany returns every schedule for the company regardless of status or due-ness, unlike listDueHeartbeats', async () => {
  const activeDue = baseHeartbeat({ id: 'hb-active-due', status: 'active', nextFireAt: '2020-01-01T00:00:00.000Z' });
  const activeNotDue = baseHeartbeat({ id: 'hb-active-not-due', status: 'active', nextFireAt: '2099-01-01T00:00:00.000Z' });
  const paused = baseHeartbeat({
    id: 'hb-paused',
    status: 'paused',
    lastOutcome: 'application_budget_blocked',
  });
  const otherCompany = baseHeartbeat({ id: 'hb-other-co', companyId: 'co-2' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) =>
      args.tier === 'working'
        ? {
            results: [activeDue, activeNotDue, paused, otherCompany].map((h) => ({ value: JSON.stringify(h) })),
          }
        : { results: [] },
  });
  const result = await listHeartbeatsForCompany('co-1', config);
  assert.deepEqual(
    result.map((h) => h.id).sort(),
    ['hb-active-due', 'hb-active-not-due', 'hb-paused'],
  );
  // The blocked/paused schedule is present — this is exactly what
  // listDueHeartbeats would have silently dropped.
  const pausedResult = result.find((h) => h.id === 'hb-paused');
  assert.equal(pausedResult?.status, 'paused');
  assert.equal(pausedResult?.lastOutcome, 'application_budget_blocked');
});

// --- buildDashboardSnapshot ----------------------------------------------------

test('buildDashboardSnapshot assembles Company/Goals/Issues/Heartbeats into one snapshot, surfacing a budget-blocked heartbeat plainly', async () => {
  const company = baseCompany({ budget: { total: 1000, spent: 920, currency: 'USD', period: '2026-09', hardStopThreshold: 1 } });
  const goal = baseGoal({ id: 'goal-1', ownerId: 'om-owner' });
  const parentIssue = baseIssue({ id: 'issue-parent', goalId: 'goal-1', assigneeId: 'om-assignee' });
  const childIssue = baseIssue({ id: 'issue-child', goalId: 'goal-1', parentId: 'issue-parent', assigneeId: null });
  const owner = baseMember({ id: 'om-owner', identityRef: 'architect', role: 'Architect' });
  const assignee = baseMember({ id: 'om-assignee', identityRef: 'coder', role: 'Engineer' });
  const blockedHeartbeat = baseHeartbeat({
    id: 'hb-blocked',
    target: { kind: 'issue', goalId: 'goal-1', issueId: 'issue-parent' },
    assigneeId: 'om-assignee',
    status: 'paused',
    lastFiredAt: '2026-08-30T00:00:00.000Z',
    lastOutcome: 'operating_budget_blocked',
  });

  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      const query = args.query as string;
      if (args.tier === 'semantic' && query === 'ruclip:company:co-1') {
        return { results: [{ key: query, value: JSON.stringify(company) }] };
      }
      if (args.tier === 'semantic' && query === 'ruclip:company:co-1:org-member:om-owner') {
        return { results: [{ key: query, value: JSON.stringify(owner) }] };
      }
      if (args.tier === 'semantic' && query === 'ruclip:company:co-1:org-member:om-assignee') {
        return { results: [{ key: query, value: JSON.stringify(assignee) }] };
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
        return args.tier === 'working' ? { results: [{ value: JSON.stringify(blockedHeartbeat) }] } : { results: [] };
      }
      return { results: [] };
    },
    'agentdb_graph-query': (args) => {
      if (args.nodeId === 'entity:issue:issue-parent' && args.relation === 'parent_of') {
        return { nodes: [{ id: 'entity:issue:issue-child' }] };
      }
      return { nodes: [] };
    },
  });

  const snapshot = await buildDashboardSnapshot('co-1', config);
  assert.ok(snapshot, 'expected a snapshot for an existing company');
  assert.equal(snapshot!.company.id, 'co-1');
  assert.equal(snapshot!.company.budget.utilizationPct, 0.92);
  assert.equal(snapshot!.company.budget.level, 'CRITICAL'); // 0.92 >= 0.9 threshold, below 1.0 hard-stop

  assert.equal(snapshot!.goals.length, 1);
  const goalSnapshot = snapshot!.goals[0]!;
  assert.equal(goalSnapshot.id, 'goal-1');
  assert.deepEqual(goalSnapshot.owner, { id: 'om-owner', identityRef: 'architect', role: 'Architect' });
  assert.equal(goalSnapshot.issues.length, 2);

  const parentSnapshot = goalSnapshot.issues.find((i) => i.id === 'issue-parent')!;
  assert.deepEqual(parentSnapshot.assignee, { id: 'om-assignee', identityRef: 'coder', role: 'Engineer' });
  assert.deepEqual(parentSnapshot.childIssueIds, ['issue-child']);

  const childSnapshot = goalSnapshot.issues.find((i) => i.id === 'issue-child')!;
  assert.equal(childSnapshot.assignee, null);
  assert.equal(childSnapshot.parentId, 'issue-parent');

  // The point of the whole exercise — a blocked/paused heartbeat is present
  // and its outcome is surfaced plainly, not hidden.
  assert.equal(snapshot!.heartbeats.length, 1);
  assert.equal(snapshot!.heartbeats[0]!.status, 'paused');
  assert.equal(snapshot!.heartbeats[0]!.lastOutcome, 'operating_budget_blocked');
  assert.deepEqual(snapshot!.heartbeats[0]!.assignee, { id: 'om-assignee', identityRef: 'coder', role: 'Engineer' });

  assert.ok(snapshot!.publishedAt);
});

test('buildDashboardSnapshot returns null when the company does not exist', async () => {
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': () => ({ results: [] }) });
  const snapshot = await buildDashboardSnapshot('co-missing', config);
  assert.equal(snapshot, null);
});
