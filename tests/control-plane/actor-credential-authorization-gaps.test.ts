/**
 * Independent coverage for the Actor Identity Verification slice (commit
 * b8648f7), complementing tests/control-plane/actor-identity-verification.test.ts
 * (written by the coder for their own commit — real signed-credential
 * verification, expiry/replay/unadmitted-issuer rejection, the human-block
 * decision, and the exact forged-actorId regression security found). All of
 * that verified passing; this file hunts for what it doesn't cover.
 *
 * FINDING 1 (test 1 below): docs/design/ACTOR-IDENTITY-VERIFICATION.md §5
 * item 4 names "Heartbeat schedule create/pause/resume" as one of the four
 * call sites this slice closes, and the earlier HEARTBEATS-AND-COMMS.md §6
 * itself says "Creating, PAUSING, or RESUMING a HeartbeatSchedule requires
 * the acting OrgMember to currently hold a live claim." But
 * `persistHeartbeatSchedule`'s only authorization gate is
 * `if (stored === null && !authorization) throw` — that only fires on
 * CREATE. For an UPDATE (stored !== null — pausing an active schedule, or
 * resuming a paused one), `authorization` is entirely optional; omitting it
 * skips `resolveVerifiedActor` AND the `verifyActorHoldsClaim` call inside
 * the issue-target branch (which is itself gated on `if (actor)`). This
 * isn't a forgeable-credential bug — it's simpler: no identity or claim
 * check of ANY kind runs at all for pause/resume of an existing schedule.
 * Since `fireHeartbeat` is the only legitimate system caller that persists
 * without authorization, and it only ever fires or auto-pauses on budget
 * block (never resumes — "a human must explicitly resume" per
 * HEARTBEATS-AND-COMMS.md §3 step 2), a RESUME is unambiguously one of the
 * three actor-driven operations the design names, yet nothing enforces
 * that here.
 *
 * TEST-QUALITY FINDING (test 2 below), FIXED: the coder's own
 * tests/control-plane/actor-identity-verification.test.ts has a
 * `baseTransition(overrides)` helper that accepts an `overrides` parameter
 * but never spreads it into the returned object — every override at every
 * call site in that file was silently dropped. This mattered most for the
 * test explicitly labeled "REGRESSION (the exact scenario security
 * found)" — meant to prove a credential for a DIFFERENT orgMemberId than a
 * forged transition's actorId is rejected. With overrides dropped, the
 * forged transition ends up with `fromState: 'draft'` while `stored` is
 * deliberately `approvalState: 'pending'`, so `assert.rejects` passed
 * because Guard A's structural fromState-mismatch check fired three checks
 * before Guard C's actor-identity check would ever run — not because the
 * identity mismatch was caught. Fixed the helper (added the missing
 * `...overrides` spread) directly in that file. Test 2 below is the
 * ground-truth check: the same scenario, built so Guard A's structural
 * checks pass cleanly, isolating Guard C's actor-identity check
 * specifically — proving the real fix works, independent of the broken
 * test that was supposed to prove it.
 *
 * (A third hypothesis was chased and did NOT hold up, so it isn't a test
 * here: whether persistIssue's Guard C `checkAuthorizationGuard` was
 * missing the cross-company check `applyApprovalTransition` has. Guard C's
 * existing status-recheck recalls the OrgMember using persistIssue's own
 * `companyId` param rather than the credential's verified one, which
 * incidentally fails closed — not open — when they differ, so it wasn't
 * independently exploitable. Reported to security as a "make it
 * deliberate, not incidental" note rather than a finding; security added
 * the explicit `actor.companyId !== companyId` check to Guard C anyway,
 * mirroring the sibling code path exactly, so this is now closed either
 * way.)
 *
 * No live AgentDB/radio-moe network instance — mockBridge for the AgentDB
 * bridge, real radio-moe signing/verification via the shared
 * actor-credential-fixture, same as the coder's own test file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { credentialFor, nonceMockHandlers } from '../support/actor-credential-fixture.js';
import { persistHeartbeatSchedule, persistIssue } from '../../src/control-plane/store/agentdb-adapter.js';
import type { ActorAuthorization } from '../../src/control-plane/authorization/actor-credential.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';
import type { ApprovalTransition } from '../../src/control-plane/schema/approval-transition.js';
import type { HeartbeatSchedule } from '../../src/control-plane/schema/heartbeat-schedule.js';

const now = '2026-09-01T00:00:00.000Z';

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

function baseTransition(overrides: Partial<ApprovalTransition> = {}): ApprovalTransition {
  return {
    id: 'transition-1',
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

function orgMemberRecall(member: OrgMember) {
  return (args: Record<string, unknown>) =>
    args.tier === 'semantic' && args.query === `ruclip:company:${member.companyId}:org-member:${member.id}`
      ? { results: [{ key: args.query, value: JSON.stringify(member) }] }
      : { results: [] };
}

// --- Finding 1: heartbeat pause/resume of an EXISTING schedule needs no authorization at all ---
//
// FIXED (security review round 7): persistHeartbeatSchedule now requires
// `authorization` whenever the transition is specifically a resume
// (stored.status === 'paused' && schedule.status === 'active') — the one
// UPDATE shape that's unambiguously always actor-driven, since fireHeartbeat
// never resumes. This test now locks down the rejection.

test(
  'FIXED: persistHeartbeatSchedule rejects resuming a previously-paused schedule (an UPDATE, stored !== null) ' +
    'with NO authorization supplied — resume is unambiguously actor-driven (fireHeartbeat never resumes)',
  async () => {
    const issue = baseIssue();
    const pausedSchedule = baseSchedule({ status: 'paused' });
    const issueKeyStr = 'ruclip:company:co-1:goal:goal-1:issue:issue-1';
    const scheduleKeyStr = `${issueKeyStr}:heartbeat:hb-1`;
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.query === scheduleKeyStr) {
          return args.tier === 'working' ? { results: [{ key: scheduleKeyStr, value: JSON.stringify(pausedSchedule) }] } : { results: [] };
        }
        if (args.query === issueKeyStr && args.tier === 'working') {
          return { results: [{ key: issueKeyStr, value: JSON.stringify(issue) }] };
        }
        return { results: [] };
      },
      'agentdb_hierarchical-store': () => ({ success: true }),
      'agentdb_causal-edge': () => ({ success: true }),
      // Deliberately no 'claims_list' handler — if verifyActorHoldsClaim (or
      // any credential verification) ran, the mock would throw immediately.
    });

    const resumedSchedule = baseSchedule({ status: 'active' });
    await assert.rejects(
      () => persistHeartbeatSchedule(resumedSchedule, undefined, 'paused', config),
      /Resuming HeartbeatSchedule .* requires an acting OrgMember/,
    );
    assert.ok(
      !calls.some((c) => c.toolName === 'claims_list' || c.toolName === 'agentdb_hierarchical-store'),
      'a rejected resume must make no authorization calls and no writes',
    );
  },
);

// --- Finding 2: the coder's own "regression that matters most" test is a false positive ---
//
// tests/control-plane/actor-identity-verification.test.ts's baseTransition
// helper accepts an `overrides` parameter but never spreads it into the
// returned object — every call to `baseTransition({...})` in that entire
// file silently returns the unmodified defaults, ignoring every override.
// This means the test explicitly labeled "REGRESSION (the exact scenario
// security found)" — meant to prove a credential for a DIFFERENT
// orgMemberId than a forged transition's actorId is rejected — never
// actually constructs that transition. Traced it directly: with overrides
// dropped, `forgedApproval` is `{fromState: 'draft', ...}` while `stored`
// is deliberately set up as `{approvalState: 'pending', ...}` — so the
// test's `assert.rejects` passes for a completely unrelated reason (Guard
// A's structural fromState-mismatch check fires three checks before Guard
// C's actor-identity check would ever run), NOT because the actor-identity
// mismatch was caught. The single most important test in this
// security-critical slice currently proves nothing about the vulnerability
// it's named for.
//
// The test below is the SAME scenario, built with a correctly-overriding
// helper, to establish ground truth: does the real fix actually work?

test(
  "GROUND TRUTH for the coder's own untested regression claim: a validly-signed credential for 'om-attacker' " +
    "cannot be used to approve an issue via a forged ApprovalTransition claiming actorId: 'om-victim' — " +
    "constructed so Guard A's structural checks pass cleanly, isolating Guard C's actor-identity check specifically",
  async () => {
    const attacker = baseActor({ id: 'om-attacker' });
    const stored = baseIssue({ approvalState: 'pending', approvalTransitionRef: 'transition-submit' });
    const { config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.query === 'ruclip:company:co-1:goal:goal-1:issue:issue-1' && args.tier === 'working') {
          return { results: [{ key: args.query, value: JSON.stringify(stored) }] };
        }
        return orgMemberRecall(attacker)(args);
      },
      'claims_list': () => ({
        success: true,
        claims: [{ issueId: 'issue-1', claimant: { type: 'agent', agentId: 'om-attacker', agentType: 'Engineer' }, status: 'active' }],
      }),
      ...nonceMockHandlers(),
    });
    const authorization: ActorAuthorization = await credentialFor(attacker);

    // fromState/toState correctly match stored.approvalState so Guard A's
    // structural checks pass — actorId is the only forged field, isolating
    // exactly what Guard C's identity check is supposed to catch.
    const forgedApproval = baseTransition({
      id: 'transition-approve',
      issueId: 'issue-1',
      action: 'approve',
      fromState: 'pending',
      toState: 'approved',
      actorId: 'om-victim',
    });
    const nextIssue = baseIssue({ approvalState: 'approved', approvalTransitionRef: 'transition-approve' });

    await assert.rejects(
      () => persistIssue('co-1', nextIssue, undefined, forgedApproval, authorization, config),
      /does not match approvalTransition.actorId/,
      'expected Guard C to reject on the actor.id vs approvalTransition.actorId mismatch specifically',
    );
  },
);
