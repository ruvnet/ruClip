/**
 * Independent coverage for the Phase 6a EmployeeInteractionProfile slice
 * (commit ec20440), targeting exactly what the team-lead/coder flagged as
 * load-bearing: the two access-control constraints in
 * docs/design/EMPLOYEE-INTERACTION-PROFILE.md §2/§3. Complements the
 * coder's own tests/control-plane/employee-interaction-profile.test.ts
 * (consent self/human-only rejection, replace-not-merge semantics, the
 * latency/histogram computation, deps.interactionLearning wiring, and the
 * two structural arity tests on recallOwnInteractionProfile/
 * recallInteractionProfileForComposition) — all of which I verified pass —
 * rather than re-testing that ground.
 *
 * FINDING 1 (test 1 below), most severe: docs/design/EMPLOYEE-INTERACTION-PROFILE.md
 * §2 states "Two read paths are designed, and no others exist" and frames
 * that as "the actual guarantee" — specifically that a future manager-facing
 * feature "cannot 'unlock' by relaxing a parameter on these two, because
 * these two never had the parameter that would need relaxing." That
 * guarantee is false today: store/agentdb-adapter.ts's
 * `recallInteractionProfile(companyId, orgMemberId, config)` — the shared
 * low-level primitive both "gated" functions call internally — is itself a
 * public export with NO actor/requester parameter of any kind, gated or
 * otherwise. Nothing stops ANY code that imports store/agentdb-adapter.ts
 * (which is most of this codebase, and any external consumer of this
 * package) from calling it directly with an arbitrary orgMemberId and
 * getting back that person's full profile — no self-check, no composition
 * context, no access control whatsoever. This isn't a forgeable-parameter
 * bug like the ones prior slices found; it's a THIRD, completely open read
 * path that the design's own "no others exist" claim says shouldn't exist.
 * The employee-augmentation/interaction-profile.ts module's own comment on
 * this export even says "NOT exported for general use as a 'read anyone's
 * profile' function in disguise" — but exporting it from a module every
 * other file in the codebase already imports from IS exactly that, in
 * effect, regardless of the comment's intent.
 *
 * FINDING 2 (test 2 below), narrower but real: `setInteractionProfileConsent`'s
 * entire "self-service only" guarantee rests on comparing `actor.id` to
 * `orgMemberId` — two values the CALLER supplies. Nothing anywhere
 * verifies that `actor` genuinely represents the real, currently-acting
 * party (no live external check analogous to Guard C's
 * `verifyActorHoldsClaim`, which is unforgeable specifically because it
 * queries ruflo's own claims system rather than trusting a caller-supplied
 * object). A caller who knows another employee's `orgMemberId` (not
 * treated as a secret anywhere else in this schema — ids appear in issues,
 * assignments, comments) can construct an `OrgMember` object with
 * `id: <victim's id>` and grant or withdraw PII-adjacent consent on that
 * person's behalf, with the function believing it's self-service the whole
 * time.
 *
 * No live AgentDB/memory instance — mockBridge, same as the rest of this
 * suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { recallInteractionProfile } from '../../src/control-plane/store/agentdb-adapter.js';
import {
  recallOwnInteractionProfile,
  recallInteractionProfileForComposition,
  setInteractionProfileConsent,
} from '../../src/control-plane/employee-augmentation/interaction-profile.js';
import type { EmployeeInteractionProfile } from '../../src/control-plane/schema/employee-interaction-profile.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';

const now = '2026-09-01T00:00:00.000Z';

function baseOrgMember(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    id: 'victim-om',
    companyId: 'co-1',
    kind: 'human',
    identityRef: 'bbs:victim',
    role: 'Engineer',
    managerId: null,
    status: 'active',
    ...overrides,
  };
}

function baseProfile(overrides: Partial<EmployeeInteractionProfile> = {}): EmployeeInteractionProfile {
  return {
    id: 'victim-om',
    companyId: 'co-1',
    orgMemberId: 'victim-om',
    consentedSignalTypes: ['internal-timing'],
    medianDecisionLatencySeconds: 3600,
    decisionHourHistogram: new Array(24).fill(0),
    sampleCount: 12,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const profileKey = (companyId: string, orgMemberId: string) =>
  `ruclip:company:${companyId}:org-member:${orgMemberId}:interaction-profile`;
const orgMemberRecallKey = (companyId: string, orgMemberId: string) => `ruclip:company:${companyId}:org-member:${orgMemberId}`;

// --- Finding 1: recallInteractionProfile is an unrestricted third read path ---

test(
  'FINDING: recallInteractionProfile (store/agentdb-adapter.ts, exported) reads ANY human OrgMember\'s ' +
    'profile with no actor/requester parameter at all — bypassing BOTH access-controlled read paths ' +
    'EMPLOYEE-INTERACTION-PROFILE.md §2 says are the only two that exist',
  async () => {
    const victimProfile = baseProfile();
    const { config } = mockBridge({
      'memory_retrieve': (args) =>
        args.key === profileKey('co-1', 'victim-om')
          ? { found: true, value: victimProfile }
          : { found: false },
    });

    // No actor object constructed, forged, or otherwise involved at all —
    // this is not even the actor-forgery shape, it's simpler: the function
    // itself has nothing to check.
    const leaked = await recallInteractionProfile('co-1', 'victim-om', config);

    assert.ok(leaked, 'expected the profile to be readable with zero access control');
    assert.equal(leaked!.orgMemberId, 'victim-om');
    assert.equal(leaked!.medianDecisionLatencySeconds, 3600);
    assert.equal(leaked!.sampleCount, 12);
  },
);

test(
  'the two "gated" read functions and the ungated primitive return identical data for the same profile — ' +
    'confirming the primitive is not some reduced/redacted view, it is the exact same read',
  async () => {
    const victim = baseOrgMember({ id: 'victim-om' });
    const victimProfile = baseProfile();
    const { config } = mockBridge({
      'memory_retrieve': (args) =>
        args.key === profileKey('co-1', 'victim-om') ? { found: true, value: victimProfile } : { found: false },
    });

    const viaSelfRead = await recallOwnInteractionProfile(victim, config);
    const viaComposition = await recallInteractionProfileForComposition('co-1', 'victim-om', config);
    const viaRawPrimitive = await recallInteractionProfile('co-1', 'victim-om', config);

    assert.deepEqual(viaSelfRead, victimProfile);
    assert.deepEqual(viaComposition, victimProfile);
    assert.deepEqual(viaRawPrimitive, victimProfile);
  },
);

// --- Finding 2: setInteractionProfileConsent's self-check trusts a caller-constructed actor object ---

test(
  'FINDING: setInteractionProfileConsent grants/withdraws consent on a real OrgMember\'s behalf when the ' +
    'caller constructs a forged actor object with id === the victim\'s orgMemberId — nothing verifies actor ' +
    'genuinely represents the real, currently-acting party (no live/external check, unlike Guard C\'s ' +
    'verifyActorHoldsClaim elsewhere in this codebase)',
  async () => {
    const realVictim = baseOrgMember({ id: 'victim-om', identityRef: 'bbs:victim', role: 'Engineer' });
    const stored: { profile: EmployeeInteractionProfile | null } = { profile: null };
    const { config } = mockBridge({
      'agentdb_hierarchical-recall': (args) =>
        args.query === orgMemberRecallKey('co-1', 'victim-om')
          ? { results: [{ key: orgMemberRecallKey('co-1', 'victim-om'), value: JSON.stringify(realVictim) }] }
          : { results: [] },
      'memory_retrieve': () => (stored.profile ? { found: true, value: stored.profile } : { found: false }),
      'memory_store': (args) => {
        stored.profile = JSON.parse(args.value as string) as EmployeeInteractionProfile;
        return { success: true };
      },
    });

    // The attacker doesn't need any real credential for 'victim-om' — just
    // its id, which is not a secret anywhere else in this schema (it shows
    // up in Issue.assigneeId, Comment.authorId, ApprovalTransition.actorId,
    // causal edges, etc). Every OTHER field is fabricated freely.
    const forgedActor: OrgMember = {
      id: 'victim-om', // <- the only field that matters to the self-check
      companyId: 'co-1',
      kind: 'human',
      identityRef: 'bbs:attacker-controlled-value',
      role: 'attacker-controlled-role',
      managerId: null,
      status: 'active',
    };

    const result = await setInteractionProfileConsent('co-1', 'victim-om', ['internal-timing'], forgedActor, config);
    assert.deepEqual(result.consentedSignalTypes, ['internal-timing']);
    assert.ok(stored.profile, 'consent was actually persisted for the real victim OrgMember');
    assert.equal(stored.profile!.orgMemberId, 'victim-om');
  },
);
