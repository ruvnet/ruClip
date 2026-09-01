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
 * FINDING 1 (test 1 below), most severe: `registerCompanyCommsRoom`
 * (comms/agentbbs-notification-channel.ts) builds its AgentDB key via raw
 * string interpolation — `ruclip:company:${companyId}:comms-room` — with NO
 * `assertSafeId`/`isSafeId` check on `companyId` at all. Every OTHER
 * key-builder in store/agentdb-adapter.ts (companyKey, orgMemberKey,
 * goalKey, issueKey, commentKey, approvalTransitionKey, heartbeatKey,
 * entityNodeId) calls `assertSafeId` specifically because of the id-collision
 * class of bug the security-hardening commit (13ac549, referenced in
 * validation.ts's SAFE_ID_PATTERN comment) closed repo-wide: an id
 * containing a template's own delimiter can make two different entities
 * serialize to the identical AgentDB key. This new file was written without
 * that same guard, reintroducing the exact vulnerability class that was
 * supposedly closed everywhere else. Concretely: `registerCompanyCommsRoom`
 * always writes its own key to the 'semantic' tier — the SAME tier
 * `persistOrgMember`/`orgMemberKey` use — and it is possible to craft a
 * `companyId` string such that `ruclip:company:${companyId}:comms-room`
 * exactly equals `orgMemberKey(realCompanyId, 'comms-room')`
 * (= `ruclip:company:${realCompanyId}:org-member:comms-room`), by passing
 * `companyId = '${realCompanyId}:org-member'`. Test 1 proves this is a real
 * collision, not just matching strings: it persists a genuine OrgMember with
 * id 'comms-room' in a real company, then calls registerCompanyCommsRoom
 * with the crafted companyId, and shows recallOrgMember now returns the
 * corrupted comms-room config blob in place of the OrgMember record.
 *
 * FINDING 2 (test 2 below), narrower: `persistHeartbeatSchedule`'s `actor`
 * parameter is optional with no way to distinguish a legitimate
 * system-bookkeeping write (fireHeartbeat's own re-persist after firing,
 * which correctly omits actor per the file's own comment) from a hostile
 * caller creating/pausing/resuming a schedule and simply omitting `actor` to
 * dodge HEARTBEATS-AND-COMMS.md §6's stated requirement ("Creating, pausing,
 * or resuming a HeartbeatSchedule requires the acting OrgMember to currently
 * hold a live claim"). Unlike persistIssue's Guard A (which uses
 * `stored === null` to know a call is a genesis create and therefore must
 * follow create-path rules), persistHeartbeatSchedule has no equivalent
 * signal — `previousStatus === undefined` would be the natural analogue but
 * nothing checks it. The coder's own suite documents the system-firing skip
 * as intentional (heartbeats-and-comms.test.ts:226) but doesn't test the
 * inverse: a caller impersonating a genesis create with no actor and no live
 * claim on the target issue at all. Test 2 proves that succeeds today.
 *
 * No live AgentDB/claims/agentbbs instance — mockBridge / a small stateful
 * mock, same as the rest of this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import {
  persistOrgMember,
  recallOrgMember,
  orgMemberKey,
  persistHeartbeatSchedule,
} from '../../src/control-plane/store/agentdb-adapter.js';
import { registerCompanyCommsRoom } from '../../src/control-plane/comms/agentbbs-notification-channel.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
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
  'registerCompanyCommsRoom with an unsanitized companyId collides with orgMemberKey(realCompanyId, "comms-room") ' +
    'and overwrites a real, previously-persisted OrgMember record at the same AgentDB key/tier',
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

    // The attack: register a comms room with a crafted companyId that makes
    // the comms-room key template collide with that exact OrgMember key.
    const craftedCompanyId = 'acme:org-member';
    const result = await registerCompanyCommsRoom(craftedCompanyId, config);
    assert.equal(result.degraded, false);

    const commsRoomStoreCall = calls.find(
      (c) => c.toolName === 'agentdb_hierarchical-store' && (c.args.value as string).includes('roomId'),
    );
    assert.equal(
      commsRoomStoreCall?.args.key,
      expectedKey,
      'the comms-room write landed on the exact same key as the real OrgMember',
    );

    // Observable corruption: recalling the OrgMember now returns the
    // comms-room config blob instead, silently, with no error anywhere.
    const corrupted = await recallOrgMember('acme', 'comms-room', config);
    assert.notEqual((corrupted as unknown as { kind?: string })?.kind, 'human');
    assert.ok(
      (corrupted as unknown as { roomId?: string })?.roomId,
      'the value now recalled through the OrgMember accessor is the comms-room record, not the OrgMember',
    );
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
  'persistHeartbeatSchedule creates a brand-new schedule (previousStatus undefined, ' +
    'i.e. not fireHeartbeat\'s own bookkeeping re-persist) with NO actor supplied and NO live claim ' +
    'on the target issue anywhere — HEARTBEATS-AND-COMMS.md §6\'s "requires a live claim" invariant ' +
    'is never checked, because nothing distinguishes this from the legitimate system-firing skip',
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
      // "No mock handler registered", proving definitively it never runs.
    });

    await assert.doesNotReject(() =>
      persistHeartbeatSchedule(baseSchedule(), undefined, undefined, config),
    );
    assert.ok(
      !calls.some((c) => c.toolName === 'claims_list'),
      'no authorization check of any kind ran for this genesis create',
    );
  },
);
