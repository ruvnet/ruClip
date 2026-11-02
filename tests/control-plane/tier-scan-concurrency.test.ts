/**
 * Dream Cycle 2026-11-02 (performance, rotated from architecture — see
 * LEDGER.md). listIssuesForGoal, listApprovalTransitionsForCompany, and
 * listHeartbeatsForCompany (store/agentdb-adapter.ts) each scan the
 * 'working' and 'episodic' tiers of the same key/prefix and merge the
 * results client-side — the two tiers are independent reads with no
 * data dependency between them, so they now fan out via Promise.all
 * instead of paying their two agentdb_hierarchical-recall round trips
 * back to back.
 *
 * This file proves two things per function: (1) merged output is
 * unchanged from the old sequential-for-loop behavior (order-preserving:
 * working's matches still precede episodic's matches), and (2) both tier
 * calls are genuinely in flight at once, not just dispatched in a tight
 * loop — via an in-flight counter in the mock handler, the same technique
 * a race would be caught with, used here in reverse to prove concurrency.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import {
  listIssuesForGoal,
  listApprovalTransitionsForCompany,
  listHeartbeatsForCompany,
} from '../../src/control-plane/store/agentdb-adapter.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';
import type { HeartbeatSchedule } from '../../src/control-plane/schema/heartbeat-schedule.js';

const now = '2026-11-02T00:00:00.000Z';

function baseIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    goalId: 'goal-1',
    parentId: null,
    assigneeId: null,
    title: 'Do the thing',
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

function baseTransition(overrides: Partial<ApprovalTransition> = {}): ApprovalTransition {
  return {
    id: 'txn-1',
    issueId: 'issue-1',
    action: 'submit',
    fromState: 'draft',
    toState: 'pending',
    actorId: 'om-1',
    reason: null,
    createdAt: now,
    witnessRef: null,
    ...overrides,
  };
}

function baseHeartbeat(overrides: Partial<HeartbeatSchedule> = {}): HeartbeatSchedule {
  return {
    id: 'hb-1',
    companyId: 'co-1',
    target: { kind: 'goal', goalId: 'goal-1' },
    assigneeId: 'om-assignee',
    cadenceSeconds: 3600,
    status: 'active',
    nextFireAt: now,
    lastFiredAt: null,
    lastOutcome: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * A mock `agentdb_hierarchical-recall` handler that tracks how many calls
 * are simultaneously in flight (via a real microtask-queue yield, not a
 * timer — deterministic, no clock reliance) and resolves each call only
 * after every expected call has arrived. If the caller issued the tier
 * scans sequentially, the second call would never arrive before the first
 * one's handler returns, so `maxInFlight` would be stuck at 1 and the
 * handlers would deadlock-timeout; `Promise.all` lets both land first.
 */
function trackingTierHandler(byTier: Record<string, unknown>, expectedCalls: number) {
  let inFlight = 0;
  let maxInFlight = 0;
  let armed = 0;
  let resolveAllArrived: () => void;
  const allArrived = new Promise<void>((resolve) => {
    resolveAllArrived = resolve;
  });
  const handler = async (args: Record<string, unknown>) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    armed += 1;
    if (armed === expectedCalls) resolveAllArrived();
    await allArrived;
    inFlight -= 1;
    return byTier[args.tier as string] ?? { results: [] };
  };
  return { handler, getMaxInFlight: () => maxInFlight };
}

test('listIssuesForGoal fans the working/episodic scan out concurrently and preserves working-then-episodic merge order', async () => {
  const working = baseIssue({ id: 'issue-working' });
  const episodic = baseIssue({ id: 'issue-episodic', status: 'done' });
  const { handler, getMaxInFlight } = trackingTierHandler(
    {
      working: { results: [{ value: JSON.stringify(working) }] },
      episodic: { results: [{ value: JSON.stringify(episodic) }] },
    },
    2,
  );
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': handler });

  const result = await listIssuesForGoal('co-1', 'goal-1', config);

  assert.equal(getMaxInFlight(), 2, 'both tier scans should be in flight at the same time');
  assert.deepEqual(result.map((i) => i.id), ['issue-working', 'issue-episodic']);
});

test('listApprovalTransitionsForCompany fans the working/episodic scan out concurrently and preserves working-then-episodic merge order', async () => {
  const working = baseTransition({ id: 'txn-working' });
  const episodic = baseTransition({ id: 'txn-episodic', action: 'approve', toState: 'approved' });
  const { handler, getMaxInFlight } = trackingTierHandler(
    {
      working: { results: [{ key: 'co-1:approval-transition:txn-working', value: JSON.stringify(working) }] },
      episodic: { results: [{ key: 'co-1:approval-transition:txn-episodic', value: JSON.stringify(episodic) }] },
    },
    2,
  );
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': handler });

  const result = await listApprovalTransitionsForCompany('co-1', config);

  assert.equal(getMaxInFlight(), 2, 'both tier scans should be in flight at the same time');
  assert.deepEqual(result.map((t) => t.id), ['txn-working', 'txn-episodic']);
});

test('listHeartbeatsForCompany fans the working/episodic scan out concurrently and preserves working-then-episodic merge order', async () => {
  const working = baseHeartbeat({ id: 'hb-working', status: 'paused' });
  const episodic = baseHeartbeat({ id: 'hb-episodic', status: 'cancelled' });
  const { handler, getMaxInFlight } = trackingTierHandler(
    {
      working: { results: [{ value: JSON.stringify(working) }] },
      episodic: { results: [{ value: JSON.stringify(episodic) }] },
    },
    2,
  );
  const { config } = mockBridge({ 'agentdb_hierarchical-recall': handler });

  const result = await listHeartbeatsForCompany('co-1', config);

  assert.equal(getMaxInFlight(), 2, 'both tier scans should be in flight at the same time');
  assert.deepEqual(result.map((h) => h.id), ['hb-working', 'hb-episodic']);
});
