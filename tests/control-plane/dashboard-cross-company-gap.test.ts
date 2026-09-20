/**
 * Independent coverage for the Phase 2a read-only dashboard slice (commit
 * f204c07), complementing tests/control-plane/dashboard-snapshot.test.ts
 * (written by the coder for their own commit — listGoalsForCompany/
 * listIssuesForGoal scoping + malformed-entry tolerance,
 * listHeartbeatsForCompany's deliberate deviation from listDueHeartbeats
 * verified correct by reading the code directly, and buildDashboardSnapshot's
 * full assembled shape including the budget-blocked-heartbeat "shown
 * plainly" requirement). All of that verified passing, and I independently
 * read the published Artifact HTML in full (required before it "counts as
 * viewed") looking specifically for an XSS/injection risk in how it embeds
 * data — found none: every data-derived value goes through `.textContent`/
 * `createTextNode`, the one `innerHTML` assignment is a static, hardcoded
 * table-header string with zero data interpolation. That's a real,
 * deliberate finding of NO vulnerability, not skipped — recorded here so a
 * future reviewer doesn't have to re-derive it, and because a repo with this
 * many real findings in its history deserves the negative result stated as
 * plainly as a positive one.
 *
 * FINDING (test below), FIXED (security review round 8): `getBlockerIssueIds`
 * (store/agentdb-adapter.ts) keys its causal-graph nodes via
 * `entityNodeId('issue', issueId)` = `entity:issue:{issueId}` — no companyId
 * component at all. This is a pre-existing architectural property (true
 * since persistIssue's very first `parent_of`/`blocks` edge writes), not new
 * to this slice — but this dashboard slice was the FIRST consumer that
 * surfaced the RESULT of that unscoped lookup directly to a viewer,
 * cross-referenced against one specific company's own Goal/Issue listing,
 * with no verification the returned neighbor id actually belonged to that
 * company. If two different companies' issues ever collide on id (a real
 * possibility if issue ids are ever sequential/predictable rather than
 * globally-unique UUIDs — nothing in `assertValidIssue` enforces global
 * uniqueness, only the safe-id charset), Company A's dashboard would have
 * displayed a relationship to an issue that isn't actually any of Company
 * A's own issues at all. Fixed in `buildDashboardSnapshot`: by the time
 * every goal's issues are assembled, the full set of issue ids that
 * genuinely belong to `companyId` is already known (no new AgentDB calls
 * needed) — `blockerIssueIds` is filtered against that set, dropping
 * anything not in it rather than displaying it. The test below doesn't
 * require an actual id collision to demonstrate the gap — it shows a
 * blockerIssueIds entry with NO corresponding issue anywhere in the
 * company's own goals/issues list is dropped instead of displayed.
 *
 * UPDATED (Dream Cycle 2026-09-20, DEEP=correctness): this test originally
 * exercised `childIssueIds` via the same `agentdb_graph-query` mock (a
 * `parent_of` edge to a foreign-company id). `childIssueIds` is no longer
 * graph-derived at all — see dashboard-child-relation-contamination.test.ts
 * for why (the real k-hop backend ignores `relation` entirely) — it is now
 * computed from each Issue's own authoritative `parentId` field, which
 * structurally cannot reference a foreign company's issue once every issue
 * is already scoped to `companyId` before that computation runs. Asserting
 * `childIssueIds` here would no longer exercise the graph-cross-company gap
 * this file is about, so this test now targets `blockerIssueIds` instead —
 * the one field still genuinely exposed to this defect.
 *
 * No live AgentDB instance — mockBridge, same pattern the coder's own test
 * file establishes for buildDashboardSnapshot.
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
    id: 'co-A',
    name: 'Company A',
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
    companyId: 'co-A',
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
    id: 'issue-shared-id',
    goalId: 'goal-1',
    parentId: null,
    assigneeId: null,
    title: "Company A's issue",
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
  'FIXED: buildDashboardSnapshot drops a blockerIssueIds entry that does not correspond to any issue in the ' +
    "company's own goals/issues list, instead of embedding it verbatim — getBlockerIssueIds' causal-graph " +
    'lookup is still keyed only by bare issueId (no companyId component), but buildDashboardSnapshot now ' +
    'cross-checks every returned neighbor against the company whose dashboard is being built before display',
  async () => {
    const company = baseCompany({ id: 'co-A' });
    const goal = baseGoal({ id: 'goal-1', companyId: 'co-A' });
    const issue = baseIssue({ id: 'issue-shared-id', goalId: 'goal-1' });

    const { config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        const query = args.query as string;
        if (args.tier === 'semantic' && query === 'ruclip:company:co-A') {
          return { results: [{ key: query, value: JSON.stringify(company) }] };
        }
        if (args.tier === 'semantic' && query === 'ruclip:company:co-A goal') {
          return { results: [{ value: JSON.stringify(goal) }] };
        }
        if (query === 'ruclip:company:co-A:goal:goal-1 issue') {
          return args.tier === 'working' ? { results: [{ value: JSON.stringify(issue) }] } : { results: [] };
        }
        if (query === 'ruclip:company:co-A heartbeat') {
          return { results: [] };
        }
        return { results: [] };
      },
      'agentdb_graph-query': (args) => {
        // Simulates a blocks edge that was actually written by a
        // DIFFERENT company's persistIssue call for an issue that happens
        // to share the id 'issue-shared-id' — reachable because
        // entityNodeId('issue', id) has no companyId component at all.
        if (args.nodeId === 'entity:issue:issue-shared-id' && args.relation === 'blocks') {
          return { results: [{ nodeId: 'entity:issue:issue-belongs-to-company-b' }] };
        }
        return { results: [] };
      },
    });

    const snapshot = await buildDashboardSnapshot('co-A', config);
    assert.ok(snapshot);

    const allIssueIdsInThisCompanysSnapshot = new Set(
      snapshot!.goals.flatMap((g) => g.issues.map((i) => i.id)),
    );
    const issueSnapshot = snapshot!.goals[0]!.issues.find((i) => i.id === 'issue-shared-id')!;

    assert.deepEqual(
      issueSnapshot.blockerIssueIds,
      [],
      'the foreign id must be dropped, not embedded, since it does not belong to this company',
    );
    assert.ok(
      !allIssueIdsInThisCompanysSnapshot.has('issue-belongs-to-company-b'),
      "sanity check: the referenced 'blocker' issue is genuinely not anywhere in company co-A's own goals/issues",
    );
  },
);
