/**
 * Independent coverage for the Phase 1e heartbeats+comms slice (commit
 * 95d17f8), complementing tests/control-plane/heartbeats-and-comms.test.ts
 * (written by the coder for their own commit — heartbeatKey,
 * assertValidHeartbeatSchedule, persistHeartbeatSchedule's claim-check reuse
 * for issue targets, tier migration, listDueHeartbeats filtering,
 * checkOperatingBudget/setOperatingBudget, fireHeartbeat's two gates, both
 * NotificationChannel implementations, and applyApprovalTransition's new
 * notification wiring — all already 174/174 green).
 *
 * Per the established pattern for this repo (every prior slice's "trusting
 * caller-supplied data instead of recalling/enforcing ground truth" bug
 * class — the Guard A create-path bug fixed in de48670, the Guard C
 * actor-status trust gap fixed in 2c08d8a), this file specifically hunts
 * for a THIRD instance of that same bug class in the brand-new code this
 * slice adds, rather than re-testing what the coder's own suite already
 * covers well.
 *
 * FINDING 1 (test 1 below), most severe, FIXED (security review round 4):
 * `registerCompanyCommsRoom` (comms/agentbbs-notification-channel.ts) built
 * its AgentDB key via raw string interpolation —
 * `ruclip:company:${companyId}:comms-room` — with NO `assertSafeId`/
 * `isSafeId` check on `companyId` at all. Every OTHER key-builder in
 * store/agentdb-adapter.ts (companyKey, orgMemberKey, goalKey, issueKey,
 * commentKey, approvalTransitionKey, heartbeatKey, entityNodeId) calls
 * `assertSafeId` specifically because of the id-collision class of bug the
 * security-hardening commit (13ac549, referenced in validation.ts's
 * SAFE_ID_PATTERN comment) closed repo-wide: an id containing a template's
 * own delimiter can make two different entities serialize to the identical
 * AgentDB key. This new file was written without that same guard,
 * reintroducing the exact vulnerability class that was supposedly closed
 * everywhere else. Concretely: `registerCompanyCommsRoom` always writes its
 * own key to the 'semantic' tier — the SAME tier `persistOrgMember`/
 * `orgMemberKey` use — and it was possible to craft a `companyId` string
 * such that `ruclip:company:${companyId}:comms-room` exactly equalled
 * `orgMemberKey(realCompanyId, 'comms-room')`
 * (= `ruclip:company:${realCompanyId}:org-member:comms-room`), by passing
 * `companyId = '${realCompanyId}:org-member'`. Test 1 proved this was a real
 * collision, not just matching strings. `assertSafeId`/`SAFE_ID_PATTERN` now
 * live in store/bridge-client.ts (the dependency-free leaf both
 * agentdb-adapter.ts and this comms file import from, avoiding the same
 * two-way-import-cycle problem bridge-client.ts's own header documents), and
 * `registerCompanyCommsRoom` calls `assertSafeId(companyId, 'companyId')`
 * before building its key — test 1 now locks down the rejection.
 *
 * FINDING 2 (test 2 below), narrower, FIXED: `persistHeartbeatSchedule`'s
 * `actor` parameter was optional with no way to distinguish a legitimate
 * system-bookkeeping write (fireHeartbeat's own re-persist after firing,
 * which correctly omits actor per the file's own comment) from a hostile
 * caller creating/pausing/resuming a schedule and simply omitting `actor` to
 * dodge HEARTBEATS-AND-COMMS.md §6's stated requirement ("Creating, pausing,
 * or resuming a HeartbeatSchedule requires the acting OrgMember to currently
 * hold a live claim"). Unlike persistIssue's Guard A (which uses
 * `stored === null` to know a call is a genesis create and therefore must
 * follow create-path rules), persistHeartbeatSchedule had no equivalent
 * signal. Fixed the same way: persistHeartbeatSchedule now recalls the
 * stored schedule first, and a `null` result (genesis create) hard-requires
 * `actor` — fireHeartbeat never creates, only re-persists a schedule it just
 * recalled to fire, so its no-actor bookkeeping writes are unaffected. Test
 * 2 now locks down the rejection for a caller impersonating a genesis create
 * with no actor and no live claim on the target issue at all.
 *
 * FINDING 3 (tests 3-4 below), Dream Cycle 2026-10-31 (security): the
 * create-path and resume-path checks above (rounds 4/7) left exactly one
 * transition unauthenticated — an actor-initiated PAUSE (active ->
 * paused) — because it is structurally identical to fireHeartbeat's own
 * legitimate system auto-pause on a budget block, and nothing
 * distinguished the two. Confirmed exploitable (zero authorization needed
 * to pause an active schedule) by an independent test before this fix —
 * `persistHeartbeatSchedule` never even called `recallOrgMember`/
 * `claims_list`. Fixed with the one discriminant the existing round-7
 * comment named as the missing piece: a `systemInitiated` parameter, set
 * only by fireHeartbeat's own `pauseAndPersist`. Test 3 proves the exploit
 * is now rejected; test 4 proves fireHeartbeat's own unauthenticated
 * system pause (the one legitimate no-authorization caller) still works —
 * also covered end-to-end by the existing Gate 1/Gate 2 tests in
 * heartbeats-and-comms.test.ts, which exercise fireHeartbeat's real
 * pauseAndPersist call site and would fail if this fix regressed it.
 *
 * No live AgentDB/claims/agentbbs instance — mockBridge / a small stateful
 * mock, same as the rest of this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { credentialFor, nonceMockHandlers } from '../support/actor-credential-fixture.js';
import {
  persistOrgMember,
  recallOrgMember,
  orgMemberKey,
  persistHeartbeatSchedule,
  heartbeatKey,
  ApprovalGateViolationError,
} from '../../src/control-plane/store/agentdb-adapter.js';
import { registerCompanyCommsRoom } from '../../src/control-plane/comms/agentbbs-notification-channel.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { Goal } from '../../src/control-plane/schema/goal.js';
import type { HeartbeatSchedule } from '../../src/control-plane/schema/heartbeat-schedule.js';

const now = '2026-09-01T00:00:00.000Z';

function baseOrgMember(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'comms-room', // deliberately the exact id the collision targets
    companyId: 'acme',
    kind: 'human',
    identityRef: 'bbs:root',
    role: 'CEO',
    managerId: null,
    status: 'active',
    ...overrides,
  };
}

// --- Finding 1: registerCompanyCommsRoom's unchecked companyId collides with a real OrgMember key ---

test(
  'registerCompanyCommsRoom rejects a companyId that would collide with orgMemberKey(realCompanyId, "comms-room") ' +
    '— assertSafeId now runs before the key is ever built',
  async () => {
    const tiers: Record<string, Map<string, string>> = { working: new Map(), episodic: new Map(), semantic: new Map() };
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-store': (args) => {
        tiers[args.tier as string]!.set(args.key as string, args.value as string);
        return { success: true };
      },
      'agentdb_hierarchical-recall': (args) => {
        const tier = args.tier as string | undefined;
        const query = args.query as string;
        const tiersToCheck = tier ? [tier] : ['working', 'episodic', 'semantic'];
        for (const t of tiersToCheck) {
          const value = tiers[t]!.get(query);
          if (value !== undefined) return { results: [{ key: query, value }] };
        }
        return { results: [] };
      },
      'federation_bbs_register': () => ({ success: true, roomId: 'ruclip-acme-room', nodeId: 'node-1' }),
    });

    // A real OrgMember, id 'comms-room', genuinely persisted for company 'acme'.
    const realMember = baseOrgMember({ companyId: 'acme' });
    await persistOrgMember(realMember, config);
    const expectedKey = orgMemberKey('acme', 'comms-room');
    assert.equal(tiers.semantic!.get(expectedKey), JSON.stringify(realMember), 'sanity check: the real member is stored');

    // The attack: register a comms room with a crafted companyId that would
    // make the comms-room key template collide with that exact OrgMember
    // key. assertSafeId now rejects it before any bridge call is made.
    const craftedCompanyId = 'acme:org-member';
    const callsBeforeAttack = calls.length;
    await assert.rejects(() => registerCompanyCommsRoom(craftedCompanyId, config), /unsafe companyId/);
    assert.equal(
      calls.length,
      callsBeforeAttack,
      'a rejected companyId must make no bridge calls at all (assertSafeId runs before federation_bbs_register)',
    );

    // The real OrgMember record must be untouched.
    const stillReal = await recallOrgMember('acme', 'comms-room', config);
    assert.equal(stillReal?.kind, 'human');
    assert.equal(stillReal?.id, 'comms-room');
  },
);

// --- Finding 2: persistHeartbeatSchedule create/pause/resume with no actor skips authorization entirely ---

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

function baseSchedule(overrides: Partial<HeartbeatSchedule> = {}): HeartbeatSchedule {
  return {
    id: 'hb-1',
    companyId: 'co-1',
    target: { kind: 'issue', goalId: 'goal-1', issueId: 'issue-1' },
    assigneeId: 'om-1',
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

test(
  'persistHeartbeatSchedule rejects creating a brand-new schedule (recallHeartbeatSchedule returns null, ' +
    'i.e. not fireHeartbeat\'s own bookkeeping re-persist of an existing one) with NO actor supplied — ' +
    'HEARTBEATS-AND-COMMS.md §6\'s "requires a live claim" invariant now has a genesis-create gate to enforce it against',
  async () => {
    const issue = baseIssue();
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': (args) =>
        args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1'
          ? { results: [{ key: 'ruclip:company:co-1:goal:goal-1:issue:issue-1', value: JSON.stringify(issue) }] }
          : { results: [] },
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      // Deliberately NO 'claims_list' handler registered — if
      // verifyActorHoldsClaim were ever invoked, the mock would throw
      // "No mock handler registered". It never gets that far now: the
      // create-path actor requirement rejects first.
    });

    await assert.rejects(
      () => persistHeartbeatSchedule(baseSchedule(), undefined, undefined, config),
      ApprovalGateViolationError,
    );
    assert.ok(
      !calls.some((c) => c.toolName === 'agentdb_hierarchical-store' || c.toolName === 'claims_list'),
      'a rejected genesis create must make no writes and no authorization calls',
    );
  },
);

// --- Finding 3: an actor-initiated PAUSE had no authorization check at all ---

function existingGoalSchedule(overrides: Partial<HeartbeatSchedule> = {}): HeartbeatSchedule {
  return baseSchedule({ target: { kind: 'goal', goalId: 'goal-1' }, status: 'active', ...overrides });
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

test(
  'persistHeartbeatSchedule rejects an actor-initiated PAUSE (active -> paused) of an EXISTING schedule with ' +
    'NO authorization and NO systemInitiated flag — the exploit confirmed against pre-fix code (reproduced in ' +
    "this night's gist report): zero authorization needed to pause an active schedule",
  async () => {
    const existing = existingGoalSchedule();
    const goal = baseGoal();
    const key = heartbeatKey(existing.companyId, existing.target, existing.id);
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.query === key) return { results: [{ key, value: JSON.stringify(existing) }] };
        if (args.query === 'ruclip:company:co-1:goal:goal-1') {
          return { results: [{ key: args.query, value: JSON.stringify(goal) }] };
        }
        return { results: [] };
      },
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      // Deliberately NO 'claims_list' handler — if any authorization check
      // ran, the mock would throw. It never gets that far: the new pause
      // gate rejects before resolveVerifiedActor is even called.
    });

    const attackerPause = { ...existing, status: 'paused' as const };
    await assert.rejects(
      () => persistHeartbeatSchedule(attackerPause, undefined, existing.status, config),
      // Disambiguate from the (different) "goal does not exist" error path
      // the same error class also covers elsewhere in this function — the
      // goal mock above exists precisely so this rejection is unambiguously
      // the new pause-authorization gate, not a missing-fixture artifact.
      /Pausing HeartbeatSchedule 'hb-1' requires an acting OrgMember/,
    );
    assert.ok(
      !calls.some((c) => c.toolName === 'agentdb_hierarchical-store'),
      'a rejected pause must make no write',
    );
  },
);

test(
  "persistHeartbeatSchedule's PAUSE gate does not block fireHeartbeat's own systemInitiated auto-pause " +
    '(the one legitimate unauthenticated caller — see fire-heartbeat.ts pauseAndPersist)',
  async () => {
    const existing = existingGoalSchedule();
    const goal = baseGoal();
    const key = heartbeatKey(existing.companyId, existing.target, existing.id);
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.query === key) return { results: [{ key, value: JSON.stringify(existing) }] };
        if (args.query === 'ruclip:company:co-1:goal:goal-1') {
          return { results: [{ key: args.query, value: JSON.stringify(goal) }] };
        }
        return { results: [] };
      },
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
    });

    const systemPause = { ...existing, status: 'paused' as const, lastOutcome: 'operating_budget_blocked' as const };
    await assert.doesNotReject(() =>
      persistHeartbeatSchedule(systemPause, undefined, existing.status, config, true),
    );
    assert.ok(calls.some((c) => c.toolName === 'agentdb_hierarchical-store'));
  },
);

test(
  'persistHeartbeatSchedule allows a PAUSE when real authorization + a held claim is supplied (legitimate ' +
    'actor-initiated pause is not blocked by the fix, only the unauthenticated path is)',
  async () => {
    const actor: OrgMember = {
      id: 'om-1',
      companyId: 'co-1',
      kind: 'agent',
      identityRef: 'agent-team-name',
      role: 'Engineer',
      managerId: null,
      status: 'active',
    };
    const issue = baseIssue();
    const existing = baseSchedule({ status: 'active' });
    const key = heartbeatKey(existing.companyId, existing.target, existing.id);
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.tier === 'working' && args.query === key) return { results: [{ key, value: JSON.stringify(existing) }] };
        if (args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1') {
          return { results: [{ key: args.query, value: JSON.stringify(issue) }] };
        }
        if (args.tier === 'semantic' && args.query === 'ruclip:company:co-1:org-member:om-1') {
          return { results: [{ key: args.query, value: JSON.stringify(actor) }] };
        }
        return { results: [] };
      },
      'claims_list': () => ({
        success: true,
        claims: [{ issueId: 'co-1:issue-1', claimant: { type: 'agent', agentId: actor.id, agentType: actor.role }, status: 'active' }],
      }),
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      ...nonceMockHandlers(),
    });

    const authorization = await credentialFor(actor);
    const actorPause = { ...existing, status: 'paused' as const };
    await assert.doesNotReject(() => persistHeartbeatSchedule(actorPause, authorization, existing.status, config));
    assert.ok(calls.some((c) => c.toolName === 'claims_list'));
    assert.ok(calls.some((c) => c.toolName === 'agentdb_hierarchical-store'));
  },
);
