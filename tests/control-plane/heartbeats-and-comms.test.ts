/**
 * Coverage for the Phase 1e slice (docs/design/HEARTBEATS-AND-COMMS.md):
 * HeartbeatSchedule persistence + authorization reuse, fireHeartbeat's two
 * gates, checkOperatingBudget/setOperatingBudget (including the
 * memory_list-is-metadata-only finding this slice discovered), the
 * AgentBBS-backed NotificationChannel (including its optional real
 * radio-moe signing layer — there is no separate AgentRadio channel, see
 * agentbbs-notification-channel.ts's file header for why), and
 * applyApprovalTransition's new deps.notifications wiring.
 *
 * No live AgentDB/memory/agentbbs instance — every call goes through
 * mockBridge (tests/support/mock-bridge.ts), same as the rest of this
 * suite. radio-moe itself IS real here (a devDependency, see package.json)
 * so the signing tests exercise the actual published API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { credentialFor, nonceMockHandlers } from '../support/actor-credential-fixture.js';
import {
  heartbeatKey,
  persistHeartbeatSchedule,
  recallHeartbeatSchedule,
  listDueHeartbeats,
  checkOperatingBudget,
  setOperatingBudget,
  applyApprovalTransition,
  ApprovalGateViolationError,
} from '../../src/control-plane/store/agentdb-adapter.js';
import { ClaimAuthorizationError } from '../../src/control-plane/authorization/claims-authorization.js';
import { fireHeartbeat } from '../../src/control-plane/heartbeat/fire-heartbeat.js';
import {
  AgentBbsNotificationChannel,
  registerCompanyCommsRoom,
  mintHumanCommsAccess,
  verifySignedNotification,
  type RadioMoeSignature,
} from '../../src/control-plane/comms/agentbbs-notification-channel.js';
import { assertValidHeartbeatSchedule, SchemaValidationError } from '../../src/control-plane/schema/validation.js';
import type { HeartbeatSchedule } from '../../src/control-plane/schema/heartbeat-schedule.js';
import type { Company } from '../../src/control-plane/schema/company.js';
import type { Goal } from '../../src/control-plane/schema/goal.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { NotificationChannel, NotificationEvent } from '../../src/control-plane/schema/notification.js';

const now = '2026-09-01T00:00:00.000Z';

function baseCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: 'co-1',
    name: 'Acme',
    primaryGoalId: null,
    budget: { total: 1000, spent: 0, currency: 'USD', period: '2026-09', hardStopThreshold: 0.9 },
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
    successCriteria: ['Users can sign up'],
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

function baseActor(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'om-1',
    companyId: 'co-1',
    kind: 'agent',
    identityRef: 'agent-team-name',
    role: 'Engineer',
    managerId: null,
    status: 'active',
    ...overrides,
  };
}

function baseSchedule(overrides: Partial<HeartbeatSchedule> = {}): HeartbeatSchedule {
  return {
    id: 'hb-1',
    companyId: 'co-1',
    target: { kind: 'issue', goalId: 'goal-1', issueId: 'issue-1' },
    assigneeId: 'om-1',
    cadenceSeconds: 300,
    status: 'active',
    nextFireAt: now,
    lastFiredAt: null,
    lastOutcome: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function activeClaimFor(actor: OrgMember, issueId: string) {
  return () => ({
    success: true,
    // Cross-tenant claim collision fix (ruvnet/ruClip#5 Finding 1) —
    // claims-authorization.ts now sends/compares a company-prefixed
    // issueId, not the bare one.
    claims: [{ issueId: `${actor.companyId}:${issueId}`, claimant: { type: 'agent', agentId: actor.id, agentType: actor.role }, status: 'active' }],
  });
}

// --- heartbeatKey ------------------------------------------------------------

test('heartbeatKey is company-scoped for both goal and issue targets (bridge caps keys at 128 chars)', () => {
  assert.equal(
    heartbeatKey('co-1', { kind: 'goal', goalId: 'goal-1' }, 'hb-1'),
    'ruclip:company:co-1:heartbeat:hb-1',
  );
  assert.equal(
    heartbeatKey('co-1', { kind: 'issue', goalId: 'goal-1', issueId: 'issue-1' }, 'hb-1'),
    'ruclip:company:co-1:heartbeat:hb-1',
  );
});

// --- assertValidHeartbeatSchedule ---------------------------------------------

test('assertValidHeartbeatSchedule accepts a well-formed schedule', () => {
  assert.doesNotThrow(() => assertValidHeartbeatSchedule(baseSchedule()));
});

test('assertValidHeartbeatSchedule rejects cadenceSeconds below the 60-second floor', () => {
  const schedule = baseSchedule({ cadenceSeconds: 30 });
  assert.throws(() => assertValidHeartbeatSchedule(schedule), SchemaValidationError);
});

test('assertValidHeartbeatSchedule rejects an issue target missing issueId', () => {
  const schedule = { ...baseSchedule(), target: { kind: 'issue', goalId: 'goal-1' } } as unknown as HeartbeatSchedule;
  assert.throws(() => assertValidHeartbeatSchedule(schedule), SchemaValidationError);
});

test('assertValidHeartbeatSchedule accepts a goal target with no issueId', () => {
  const schedule = baseSchedule({ target: { kind: 'goal', goalId: 'goal-1' } });
  assert.doesNotThrow(() => assertValidHeartbeatSchedule(schedule));
});

// --- persistHeartbeatSchedule: authorization reuse (§6) ----------------------

test('persistHeartbeatSchedule (issue target, actor supplied) reuses verifyActorHoldsClaim and succeeds when the actor holds the claim', async () => {
  const actor = baseActor();
  const issue = baseIssue();
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
        return { results: [{ key: 'ruclip:company:co-1:goal:goal-1:issue:issue-1', value: JSON.stringify(issue) }] };
      }
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1:org-member:om-1') {
        return { results: [{ key: args.query, value: JSON.stringify(actor) }] };
      }
      return { results: [] };
    },
    'claims_list': activeClaimFor(actor, 'issue-1'),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    ...nonceMockHandlers(),
  });
  const authorization = await credentialFor(actor);
  await assert.doesNotReject(() => persistHeartbeatSchedule(baseSchedule(), authorization, undefined, config));
  assert.ok(calls.some((c) => c.toolName === 'claims_list'));
});

test('persistHeartbeatSchedule (issue target, actor supplied) rejects when the actor does not hold the claim', async () => {
  const actor = baseActor();
  const issue = baseIssue();
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
        return { results: [{ key: 'ruclip:company:co-1:goal:goal-1:issue:issue-1', value: JSON.stringify(issue) }] };
      }
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1:org-member:om-1') {
        return { results: [{ key: args.query, value: JSON.stringify(actor) }] };
      }
      return { results: [] };
    },
    'claims_list': () => ({ success: true, claims: [] }),
    'agentdb_hierarchical-store': () => ({ success: true }),
    ...nonceMockHandlers(),
  });
  const authorization = await credentialFor(actor);
  await assert.rejects(
    () => persistHeartbeatSchedule(baseSchedule(), authorization, undefined, config),
    ClaimAuthorizationError,
  );
});

test('persistHeartbeatSchedule rejects when target.goalId does not match the real issue.goalId', async () => {
  const actor = baseActor();
  const issue = baseIssue({ goalId: 'goal-actual' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
        return { results: [{ key: 'ruclip:company:co-1:goal:goal-1:issue:issue-1', value: JSON.stringify(issue) }] };
      }
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1:org-member:om-1') {
        return { results: [{ key: args.query, value: JSON.stringify(actor) }] };
      }
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    ...nonceMockHandlers(),
  });
  const authorization = await credentialFor(actor);
  await assert.rejects(
    () => persistHeartbeatSchedule(baseSchedule(), authorization, undefined, config),
    ApprovalGateViolationError,
  );
});

test('persistHeartbeatSchedule (goal target) does not call claims_list — a bare Goal has no claims concept', async () => {
  const actor = baseActor();
  const goal = baseGoal();
  const schedule = baseSchedule({ target: { kind: 'goal', goalId: 'goal-1' } });
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1:goal:goal-1') {
        return { results: [{ key: 'ruclip:company:co-1:goal:goal-1', value: JSON.stringify(goal) }] };
      }
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1:org-member:om-1') {
        return { results: [{ key: args.query, value: JSON.stringify(actor) }] };
      }
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    ...nonceMockHandlers(),
  });
  const authorization = await credentialFor(actor);
  await assert.doesNotReject(() => persistHeartbeatSchedule(schedule, authorization, undefined, config));
  assert.ok(!calls.some((c) => c.toolName === 'claims_list'));
});

test('persistHeartbeatSchedule without an actor (system-firing path) skips the claim check entirely', async () => {
  // Represents fireHeartbeat's own re-persist of a schedule that ALREADY
  // EXISTS (a genesis create with no actor is a different, rejected case —
  // see the security-hardening create-path check in agentdb-adapter.ts and
  // its coverage in heartbeats-authorization-gaps.test.ts), so the mock
  // simulates that prior existence via the schedule's own heartbeat key.
  const issue = baseIssue();
  const existingSchedule = baseSchedule();
  const scheduleKey = heartbeatKey(existingSchedule.companyId, existingSchedule.target, existingSchedule.id);
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
        return { results: [{ key: 'ruclip:company:co-1:goal:goal-1:issue:issue-1', value: JSON.stringify(issue) }] };
      }
      if (args.tier === 'working' && args.query === scheduleKey) {
        return { results: [{ key: scheduleKey, value: JSON.stringify(existingSchedule) }] };
      }
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  await assert.doesNotReject(() =>
    persistHeartbeatSchedule(existingSchedule, undefined, existingSchedule.status, config),
  );
  assert.ok(!calls.some((c) => c.toolName === 'claims_list'));
});

// --- persistHeartbeatSchedule / recallHeartbeatSchedule: tier migration ------

test('persistHeartbeatSchedule moves working -> episodic on cancel and deletes the stale working copy', async () => {
  const issue = baseIssue();
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => ({ results: [{ key: args.query, value: JSON.stringify(issue) }] }),
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_hierarchical-delete': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  const cancelledSchedule = baseSchedule({ status: 'cancelled' });
  await persistHeartbeatSchedule(cancelledSchedule, undefined, 'active', config);
  const storeCall = calls.find((c) => c.toolName === 'agentdb_hierarchical-store');
  const deleteCall = calls.find((c) => c.toolName === 'agentdb_hierarchical-delete');
  assert.equal(storeCall?.args.tier, 'episodic');
  assert.equal(deleteCall?.args.tier, 'working');
});

test('recallHeartbeatSchedule falls back to the episodic tier when the working tier has no match', async () => {
  const cancelled = baseSchedule({ status: 'cancelled' });
  const key = heartbeatKey('co-1', cancelled.target, cancelled.id);
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) =>
      args.tier === 'episodic' ? { results: [{ key, value: JSON.stringify(cancelled) }] } : { results: [] },
  });
  const recalled = await recallHeartbeatSchedule('co-1', cancelled.target, cancelled.id, config);
  assert.deepEqual(recalled, cancelled);
});

// --- listDueHeartbeats ---------------------------------------------------------

test('listDueHeartbeats filters client-side by companyId, status active, and nextFireAt <= now', async () => {
  const due = baseSchedule({ id: 'hb-due', nextFireAt: '2020-01-01T00:00:00.000Z' });
  const notYetDue = baseSchedule({ id: 'hb-not-due', nextFireAt: '2099-01-01T00:00:00.000Z' });
  const paused = baseSchedule({ id: 'hb-paused', status: 'paused', nextFireAt: '2020-01-01T00:00:00.000Z' });
  const otherCompany = baseSchedule({ id: 'hb-other-co', companyId: 'co-2', nextFireAt: '2020-01-01T00:00:00.000Z' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': () => ({
      results: [due, notYetDue, paused, otherCompany].map((s) => ({ key: s.id, value: JSON.stringify(s) })),
    }),
  });
  const results = await listDueHeartbeats('co-1', config);
  assert.deepEqual(
    results.map((s) => s.id),
    ['hb-due'],
  );
});

// --- checkOperatingBudget / setOperatingBudget (Finding C + the memory_list finding) ---

test('checkOperatingBudget returns OK/0 when no budget-config is found — matches budget.mjs\'s non-alerting "no budget configured" path', async () => {
  const { config } = mockBridge({
    'memory_retrieve': () => ({ found: false }),
  });
  const result = await checkOperatingBudget('co-1', config);
  assert.deepEqual(result, { level: 'OK', utilizationPct: 0 });
});

test(
  'checkOperatingBudget sums total_cost_usd via memory_list (keys only) + one memory_retrieve per key ' +
    '— the real memory_list shape returns no value/content field, only metadata',
  async () => {
    const { calls, config } = mockBridge({
      'memory_retrieve': (args) => {
        if (args.key === 'co-1:budget-config') {
          return { found: true, value: { budgetUsd: 100, thresholds: { info: 0.5, warning: 0.75, critical: 0.9, hardStop: 1.0 } } };
        }
        if (args.key === 'co-1:session-a') return { found: true, value: { total_cost_usd: 30 } };
        if (args.key === 'co-1:session-b') return { found: true, value: { total_cost_usd: 45 } };
        return { found: false };
      },
      'memory_list': () => ({
        entries: [
          { key: 'co-1:session-a' },
          { key: 'co-1:session-b' },
          { key: 'co-2:session-unrelated' }, // different company — must be excluded by the key-prefix filter
        ],
      }),
    });
    const result = await checkOperatingBudget('co-1', config);
    assert.equal(result.utilizationPct, 0.75); // (30 + 45) / 100
    assert.equal(result.level, 'WARNING'); // >= 0.75 threshold
    assert.ok(calls.some((c) => c.toolName === 'memory_list' && c.args.namespace === 'ruclip-cost-tracking'));
    assert.ok(!calls.some((c) => c.toolName === 'memory_retrieve' && c.args.key === 'co-2:session-unrelated'));
  },
);

test('checkOperatingBudget reports HARD_STOP once utilization reaches 100%', async () => {
  const { config } = mockBridge({
    'memory_retrieve': (args) => {
      if (args.key === 'co-1:budget-config') {
        return { found: true, value: { budgetUsd: 100, thresholds: { info: 0.5, warning: 0.75, critical: 0.9, hardStop: 1.0 } } };
      }
      if (args.key === 'co-1:session-a') return { found: true, value: { total_cost_usd: 120 } };
      return { found: false };
    },
    'memory_list': () => ({ entries: [{ key: 'co-1:session-a' }] }),
  });
  const result = await checkOperatingBudget('co-1', config);
  assert.equal(result.level, 'HARD_STOP');
});

test('setOperatingBudget calls memory_store with upsert:true against the ruclip-cost-tracking namespace', async () => {
  const { calls, config } = mockBridge({
    'memory_store': () => ({ success: true }),
  });
  await setOperatingBudget('co-1', 500, undefined, config);
  const call = calls.find((c) => c.toolName === 'memory_store');
  assert.equal(call?.args.key, 'co-1:budget-config');
  assert.equal(call?.args.namespace, 'ruclip-cost-tracking');
  assert.equal(call?.args.upsert, true);
  const stored = JSON.parse(call!.args.value as string);
  assert.equal(stored.budgetUsd, 500);
});

// --- fireHeartbeat: Gate 1 (application budget) -------------------------------

test('fireHeartbeat Gate 1 blocks and pauses when an issue-target heartbeat would push spend over the hard-stop cap', async () => {
  const company = baseCompany({ budget: { total: 1000, spent: 800, currency: 'USD', period: '2026-09', hardStopThreshold: 0.9 } });
  const issue = baseIssue({ budgetImpact: 200 }); // 800 + 200 = 1000 > 1000*0.9 = 900
  const schedule = baseSchedule();
  const scheduleKey = heartbeatKey(schedule.companyId, schedule.target, schedule.id);
  const { calls, config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1') return { results: [{ key: args.query, value: JSON.stringify(company) }] };
      if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
        return { results: [{ key: args.query, value: JSON.stringify(issue) }] };
      }
      // persistHeartbeatSchedule now recalls the schedule itself first
      // (security hardening — see agentdb-adapter.ts's create-path check) —
      // this is fireHeartbeat's legitimate no-actor re-persist of an
      // ALREADY-EXISTING schedule, so the mock must simulate that it exists.
      if (args.tier === 'working' && args.query === scheduleKey) {
        return { results: [{ key: scheduleKey, value: JSON.stringify(schedule) }] };
      }
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
  });
  const result = await fireHeartbeat(schedule, {}, config);
  assert.equal(result.outcome, 'application_budget_blocked');
  assert.equal(result.schedule.status, 'paused');
  assert.equal(result.schedule.lastOutcome, 'application_budget_blocked');
  // No wake happened — no memory_retrieve/list for the operating-budget gate.
  assert.ok(!calls.some((c) => c.toolName === 'memory_retrieve'));
});

test('fireHeartbeat Gate 1 is a no-op when the target issue has budgetImpact === 0', async () => {
  const company = baseCompany();
  const issue = baseIssue({ budgetImpact: 0 });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1') return { results: [{ key: args.query, value: JSON.stringify(company) }] };
      if (args.tier === 'working') return { results: [{ key: args.query, value: JSON.stringify(issue) }] };
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'memory_retrieve': () => ({ found: false }), // Gate 2: no budget configured -> OK
  });
  const result = await fireHeartbeat(baseSchedule(), {}, config);
  assert.equal(result.outcome, 'ok');
});

test('fireHeartbeat Gate 1 for a goal-target heartbeat checks Goal.budgetAllocation, and passes trivially when unset', async () => {
  const company = baseCompany();
  const goal = baseGoal({ budgetAllocation: null });
  const schedule = baseSchedule({ target: { kind: 'goal', goalId: 'goal-1' } });
  const scheduleKey = heartbeatKey(schedule.companyId, schedule.target, schedule.id);
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1') return { results: [{ key: args.query, value: JSON.stringify(company) }] };
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1:goal:goal-1') {
        return { results: [{ key: args.query, value: JSON.stringify(goal) }] };
      }
      // persistHeartbeatSchedule now recalls the schedule itself first
      // (security hardening) — simulate it already existing, matching
      // fireHeartbeat's legitimate no-actor re-persist.
      if (args.tier === 'working' && args.query === scheduleKey) {
        return { results: [{ key: scheduleKey, value: JSON.stringify(schedule) }] };
      }
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'memory_retrieve': () => ({ found: false }),
  });
  const result = await fireHeartbeat(schedule, {}, config);
  assert.equal(result.outcome, 'ok');
});

// --- fireHeartbeat: Gate 2 (operating-spend circuit breaker) -----------------

test('fireHeartbeat Gate 2 blocks and pauses on HARD_STOP even when Gate 1 passes', async () => {
  const company = baseCompany();
  const issue = baseIssue({ budgetImpact: 0 });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1') return { results: [{ key: args.query, value: JSON.stringify(company) }] };
      if (args.tier === 'working') return { results: [{ key: args.query, value: JSON.stringify(issue) }] };
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'memory_retrieve': (args) => {
      if (args.key === 'co-1:budget-config') {
        return { found: true, value: { budgetUsd: 10, thresholds: { info: 0.5, warning: 0.75, critical: 0.9, hardStop: 1.0 } } };
      }
      if (args.key === 'co-1:session-a') return { found: true, value: { total_cost_usd: 999 } };
      return { found: false };
    },
    'memory_list': () => ({ entries: [{ key: 'co-1:session-a' }] }),
  });
  const result = await fireHeartbeat(baseSchedule(), {}, config);
  assert.equal(result.outcome, 'operating_budget_blocked');
  assert.equal(result.schedule.status, 'paused');
});

// --- fireHeartbeat: both gates pass -------------------------------------------

test('fireHeartbeat publishes heartbeat-fired and advances nextFireAt by cadenceSeconds when both gates pass', async () => {
  const company = baseCompany();
  const issue = baseIssue({ budgetImpact: 0 });
  const schedule = baseSchedule({ cadenceSeconds: 600, nextFireAt: '2020-01-01T00:00:00.000Z' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1') return { results: [{ key: args.query, value: JSON.stringify(company) }] };
      if (args.tier === 'working') return { results: [{ key: args.query, value: JSON.stringify(issue) }] };
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'memory_retrieve': () => ({ found: false }),
  });
  const published: NotificationEvent[] = [];
  const notifications: NotificationChannel = {
    publish: async (event) => {
      published.push(event);
      return { delivered: true };
    },
  };
  const before = Date.now();
  const result = await fireHeartbeat(schedule, { notifications }, config);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.schedule.status, 'active');
  assert.equal(result.schedule.lastOutcome, 'ok');
  assert.ok(new Date(result.schedule.nextFireAt).getTime() >= before + 600_000);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.kind, 'heartbeat-fired');
});

test('fireHeartbeat never throws or blocks the domain write when the notifications channel is degraded/rejects', async () => {
  const company = baseCompany();
  const issue = baseIssue({ budgetImpact: 0 });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1') return { results: [{ key: args.query, value: JSON.stringify(company) }] };
      if (args.tier === 'working') return { results: [{ key: args.query, value: JSON.stringify(issue) }] };
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'memory_retrieve': () => ({ found: false }),
  });
  const throwingChannel: NotificationChannel = {
    publish: async () => {
      throw new Error('comms backend unavailable');
    },
  };
  const result = await fireHeartbeat(baseSchedule(), { notifications: throwingChannel }, config);
  assert.equal(result.outcome, 'ok'); // the domain write still succeeded despite the notification failure
});

// --- AgentBbsNotificationChannel ----------------------------------------------

test('AgentBbsNotificationChannel maps every NotificationKind to the real, closed federation_bbs_publish msgType vocabulary', async () => {
  const seenMsgTypes: string[] = [];
  const { config } = mockBridge({
    'federation_bbs_publish': (args) => {
      seenMsgTypes.push(args.msgType as string);
      return { success: true, envelopeId: 'env-1' };
    },
  });
  const channel = new AgentBbsNotificationChannel('room-1', config);
  const kinds: NotificationEvent['kind'][] = [
    'heartbeat-fired',
    'heartbeat-budget-blocked',
    'issue-approval-transition',
    'budget-threshold-crossed',
  ];
  for (const kind of kinds) {
    await channel.publish({ kind, companyId: 'co-1', subjectRef: 'issue:issue-1', payload: {}, occurredAt: now });
  }
  assert.deepEqual(seenMsgTypes, ['pod-status', 'alert', 'alert', 'alert']);
});

test('AgentBbsNotificationChannel returns {delivered:false, degraded:true} when federation_bbs_publish reports degraded (agentbbs optional dep missing) — success stays true on degradation, only `degraded` signals it', async () => {
  const { config } = mockBridge({
    'federation_bbs_publish': () => ({ success: true, degraded: true, reason: 'agentbbs-not-found' }),
  });
  const channel = new AgentBbsNotificationChannel('room-1', config);
  const result = await channel.publish({
    kind: 'heartbeat-fired',
    companyId: 'co-1',
    subjectRef: 'issue:issue-1',
    payload: {},
    occurredAt: now,
  });
  assert.deepEqual(result, { delivered: false, degraded: true });
});

test('registerCompanyCommsRoom persists the room mapping on success and reports degraded on failure without persisting', async () => {
  const { calls, config } = mockBridge({
    'federation_bbs_register': () => ({ success: true, roomId: 'ruclip-co-1-abc', nodeId: 'node-1' }),
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const result = await registerCompanyCommsRoom('co-1', config);
  assert.equal(result.degraded, false);
  assert.equal(result.roomId, 'ruclip-co-1-abc');
  const storeCall = calls.find((c) => c.toolName === 'agentdb_hierarchical-store');
  assert.equal(storeCall?.args.key, 'ruclip:company:co-1:comms-room');

  const { calls: degradedCalls, config: degradedConfig } = mockBridge({
    'federation_bbs_register': () => ({ success: true, degraded: true, reason: 'agentbbs-not-found' }),
  });
  const degradedResult = await registerCompanyCommsRoom('co-1', degradedConfig);
  assert.deepEqual(degradedResult, { roomId: '', degraded: true });
  assert.ok(!degradedCalls.some((c) => c.toolName === 'agentdb_hierarchical-store'));
});

test('mintHumanCommsAccess returns the real token bundle on success and {degraded:true} when agentbbs is unavailable', async () => {
  const { config } = mockBridge({
    'federation_bbs_human_join': () => ({
      success: true,
      webUrl: 'https://agentbbs.local/rooms/room-1?token=abc',
      sshCommand: 'ssh -p 2222 agentbbs.local -- join room-1 abc',
      handshakeToken: 'abc',
      expiresAt: '2026-09-01T00:05:00.000Z',
    }),
  });
  const result = await mintHumanCommsAccess('room-1', 300, config);
  assert.equal(result.degraded, false);

  const { config: degradedConfig } = mockBridge({
    'federation_bbs_human_join': () => ({ success: true, degraded: true, reason: 'agentbbs-not-found' }),
  });
  const degraded = await mintHumanCommsAccess('room-1', 300, degradedConfig);
  assert.deepEqual(degraded, { degraded: true });
});

// --- AgentBbsNotificationChannel: real radio-moe signing layer ---------------
//
// radio-moe is installed as a real devDependency (package.json) precisely so
// these tests exercise the actual, published radio-moe@0.3.1
// PeerIdentity/signFrame/verifyFrame API — not a mock of it. There is no
// AgentRadioNotificationChannel: neither radio-moe nor @metaharness/radio's
// real API is a notification bus (see agentbbs-notification-channel.ts's file
// header) — radio-moe only adds a genuine signature to what agentbbs
// delivers.

test('AgentBbsNotificationChannel.publish attaches a real radio-moe signature that verifySignedNotification confirms', async () => {
  const { calls, config } = mockBridge({
    'federation_bbs_publish': () => ({ success: true, envelopeId: 'env-1' }),
  });
  const channel = new AgentBbsNotificationChannel('room-1', config);
  const event: NotificationEvent = {
    kind: 'issue-approval-transition',
    companyId: 'co-1',
    subjectRef: 'issue:issue-1',
    payload: { issueId: 'issue-1', action: 'approve' },
    occurredAt: now,
  };

  const result = await channel.publish(event);
  assert.equal(result.delivered, true);

  const publishCall = calls.find((c) => c.toolName === 'federation_bbs_publish');
  const payload = publishCall!.args.payload as { radioMoeSignature?: RadioMoeSignature };
  assert.ok(payload.radioMoeSignature, 'expected a radio-moe signature attached to the published payload');
  assert.equal(typeof payload.radioMoeSignature!.signature, 'string');
  assert.equal(typeof payload.radioMoeSignature!.publicKeyDerHex, 'string');

  const verified = await verifySignedNotification(event, payload.radioMoeSignature!);
  assert.equal(verified, true);
});

test('verifySignedNotification rejects a signature computed over a different event (tamper-evidence)', async () => {
  const captured: { payload?: Record<string, unknown> } = {};
  const { config } = mockBridge({
    'federation_bbs_publish': (args) => {
      captured.payload = args.payload as Record<string, unknown>;
      return { success: true, envelopeId: 'env-1' };
    },
  });
  const channel = new AgentBbsNotificationChannel('room-1', config);
  const original: NotificationEvent = {
    kind: 'issue-approval-transition',
    companyId: 'co-1',
    subjectRef: 'issue:issue-1',
    payload: { issueId: 'issue-1', action: 'approve' },
    occurredAt: now,
  };

  await channel.publish(original);
  const signature = captured.payload!.radioMoeSignature as RadioMoeSignature;

  const tamperedEvent: NotificationEvent = { ...original, payload: { issueId: 'issue-1', action: 'reject' } };
  const verified = await verifySignedNotification(tamperedEvent, signature);
  assert.equal(verified, false);
});

// --- applyApprovalTransition: deps.notifications wiring -----------------------

test('applyApprovalTransition publishes issue-approval-transition after a legal transition persists, best-effort', async () => {
  const original = baseIssue({ approvalState: 'draft', approvalTransitionRef: null, status: 'open' });
  const actor = baseActor({ id: 'om-submitter' });
  const approver = baseActor({ id: 'om-approver' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
        return { results: [{ key: args.query, value: JSON.stringify(original) }] };
      }
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1:org-member:om-submitter') {
        return { results: [{ key: args.query, value: JSON.stringify(actor) }] };
      }
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_handoff': () => ({ success: true }),
    'claims_list': activeClaimFor(actor, 'issue-1'),
    ...nonceMockHandlers(),
  });
  const published: NotificationEvent[] = [];
  const notifications: NotificationChannel = {
    publish: async (event) => {
      published.push(event);
      return { delivered: true };
    },
  };

  const result = await applyApprovalTransition(
    'co-1',
    original,
    'submit',
    await credentialFor(actor),
    null,
    { approver, notifications },
    config,
  );

  assert.equal(published.length, 1);
  assert.equal(published[0]?.kind, 'issue-approval-transition');
  assert.equal(published[0]?.subjectRef, 'issue:issue-1');
  assert.deepEqual(published[0]?.payload, {
    issueId: 'issue-1',
    action: 'submit',
    fromState: 'draft',
    toState: 'pending',
    actorId: 'om-submitter',
  });
  assert.equal(result.issue.approvalState, 'pending');
});

test('applyApprovalTransition succeeds even when deps.notifications.publish rejects — comms never blocks an approval decision', async () => {
  const original = baseIssue({ approvalState: 'draft', approvalTransitionRef: null, status: 'open' });
  const actor = baseActor({ id: 'om-submitter' });
  const approver = baseActor({ id: 'om-approver' });
  const { config } = mockBridge({
    'agentdb_hierarchical-recall': (args) => {
      if (args.tier === 'working' && args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
        return { results: [{ key: args.query, value: JSON.stringify(original) }] };
      }
      if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1:org-member:om-submitter') {
        return { results: [{ key: args.query, value: JSON.stringify(actor) }] };
      }
      return { results: [] };
    },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'agentdb_causal-edge': () => ({ success: true }),
    'claims_handoff': () => ({ success: true }),
    'claims_list': activeClaimFor(actor, 'issue-1'),
    ...nonceMockHandlers(),
  });
  const throwingChannel: NotificationChannel = {
    publish: async () => {
      throw new Error('comms backend unavailable');
    },
  };
  const result = await applyApprovalTransition(
    'co-1',
    original,
    'submit',
    await credentialFor(actor),
    null,
    { approver, notifications: throwingChannel },
    config,
  );
  assert.equal(result.issue.approvalState, 'pending');
});
