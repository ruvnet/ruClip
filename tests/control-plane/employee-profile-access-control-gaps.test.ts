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
 * FINDING 1 (test 1 below), most severe, FIXED (security review round 6):
 * docs/design/EMPLOYEE-INTERACTION-PROFILE.md §2 states "Two read paths are
 * designed, and no others exist" and frames that as "the actual guarantee"
 * — specifically that a future manager-facing feature "cannot 'unlock' by
 * relaxing a parameter on these two, because these two never had the
 * parameter that would need relaxing." That guarantee was false as shipped:
 * store/agentdb-adapter.ts's `recallInteractionProfile(companyId,
 * orgMemberId, config)` — the shared low-level primitive both "gated"
 * functions call internally — was itself a public export with NO
 * actor/requester parameter of any kind, gated or otherwise. Nothing
 * stopped ANY code that imported store/agentdb-adapter.ts (which is most of
 * this codebase) from calling it directly with an arbitrary orgMemberId and
 * getting back that person's full profile — no self-check, no composition
 * context, no access control whatsoever. This wasn't a forgeable-parameter
 * bug like the ones prior slices found; it was a THIRD, completely open
 * read path that the design's own "no others exist" claim said shouldn't
 * exist. The module's own comment on the export even said "NOT exported
 * for general use as a 'read anyone's profile' function in disguise" — but
 * `export` has no such restriction; a symbol exported from a module every
 * other file already imports from IS general-use regardless of the
 * comment's intent. Fixed by moving `interactionProfileKey`/
 * `persistInteractionProfile`/`recallInteractionProfile` out of
 * store/agentdb-adapter.ts entirely and into
 * employee-augmentation/interaction-profile.ts (their only legitimate
 * caller) as module-private (non-exported) functions — the unsafe shape no
 * longer exists to be misused, matching the design's own "access control by
 * function shape" philosophy. Test 1 now proves the old import path is
 * gone; test 2 proves the two designed read paths still return correct,
 * identical data.
 *
 * FINDING 2 (test 2 below), ORIGINALLY narrower but real, NOW FIXED
 * (dream-cycle correctness/security retrofit): `setInteractionProfileConsent`'s
 * entire "self-service only" guarantee used to rest on comparing `actor.id`
 * to `orgMemberId` — two values the CALLER supplied directly on a plain
 * `OrgMember` object, with nothing verifying that object genuinely
 * represented the real, currently-acting party (no live external check
 * analogous to Guard C's `verifyActorHoldsClaim`). A caller who knew another
 * employee's `orgMemberId` (not treated as a secret anywhere else in this
 * schema — ids appear in issues, assignments, comments) could construct an
 * `OrgMember` object with `id: <victim's id>` and grant or withdraw
 * PII-adjacent consent on that person's behalf. Test 2 below reproduces that
 * exact exploit shape and proves it no longer works, now that
 * `setInteractionProfileConsent` requires a verified `ActorAuthorization`
 * (`resolveVerifiedActor`) instead of a bare object — see
 * `interaction-profile.ts`'s own updated comment and
 * `docs/dream-cycle/` for the dated finding this closes.
 *
 * No live AgentDB/memory instance — mockBridge, same as the rest of this
 * suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import { humanCredentialFor } from '../support/actor-credential-fixture.js';
import * as agentDbAdapter from '../../src/control-plane/store/agentdb-adapter.js';
import {
  recallOwnInteractionProfile,
  recallInteractionProfileForComposition,
  setInteractionProfileConsent,
  PrivacyConsentError,
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

/**
 * Namespace-scoped in-memory store — the retrofitted
 * `setInteractionProfileConsent` now goes through `resolveVerifiedActor`
 * (ActorCredential nonce guard, HumanIdentityAttestation nonce guard, the
 * human-attestation provenance marker) in addition to its own
 * EmployeeInteractionProfile read/write, each in its own real namespace.
 * Mirrors `employee-interaction-profile.test.ts`'s own `statefulStore`.
 */
function statefulStore(seed?: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    memory_retrieve: (args: Record<string, unknown>) => {
      const key = `${args.namespace}:${args.key}`;
      return store.has(key) ? { found: true, value: store.get(key) } : { found: false };
    },
    memory_store: (args: Record<string, unknown>) => {
      const key = `${args.namespace}:${args.key}`;
      if (args.upsert === false && store.has(key)) {
        return { success: false, error: 'UNIQUE constraint failed: memory_entries.namespace, memory_entries.key' };
      }
      store.set(key, typeof args.value === 'string' ? JSON.parse(args.value) : args.value);
      return { success: true };
    },
  };
}

// --- Finding 1: recallInteractionProfile is an unrestricted third read path ---

test(
  'FIXED: store/agentdb-adapter.ts no longer exports recallInteractionProfile (or persistInteractionProfile/ ' +
    'interactionProfileKey) at all — the unrestricted third read path is gone, not just discouraged by comment',
  () => {
    const adapterExports = agentDbAdapter as unknown as Record<string, unknown>;
    assert.equal(
      'recallInteractionProfile' in adapterExports,
      false,
      'recallInteractionProfile must not be reachable from store/agentdb-adapter.ts at all',
    );
    assert.equal('persistInteractionProfile' in adapterExports, false);
    assert.equal('interactionProfileKey' in adapterExports, false);
  },
);

test(
  'the two designed read paths still return correct, identical data for the same profile after the fix ' +
    '(the move to module-private primitives did not change observable behavior)',
  async () => {
    const victim = baseOrgMember({ id: 'victim-om' });
    const victimProfile = baseProfile();
    const { config } = mockBridge({
      'memory_retrieve': (args) =>
        args.key === profileKey('co-1', 'victim-om') ? { found: true, value: victimProfile } : { found: false },
    });

    const viaSelfRead = await recallOwnInteractionProfile(victim, config);
    const viaComposition = await recallInteractionProfileForComposition('co-1', 'victim-om', config);

    assert.deepEqual(viaSelfRead, victimProfile);
    assert.deepEqual(viaComposition, victimProfile);
  },
);

// --- Finding 2: setInteractionProfileConsent's self-check trusts a caller-constructed actor object ---

test(
  'FIXED: setInteractionProfileConsent no longer grants/withdraws consent on a victim\'s behalf for an attacker ' +
    'holding only their OWN valid, verified credential — the old forgery (a caller-constructed actor object ' +
    'with id === the victim\'s orgMemberId) is no longer even expressible: the function now requires a real ' +
    'ActorAuthorization, and there is no way to make a credential say "victim-om" without it actually having ' +
    'been minted for victim-om (resolveVerifiedActor replaces the old caller-trusted object)',
  async () => {
    const realVictim = baseOrgMember({ id: 'victim-om', identityRef: 'bbs:victim', role: 'Engineer' });
    const attacker = baseOrgMember({ id: 'attacker-om', identityRef: 'bbs:attacker', role: 'Engineer' });
    const { calls, config } = mockBridge({
      'agentdb_hierarchical-recall': (args) => {
        if (args.query === orgMemberRecallKey('co-1', 'victim-om')) {
          return { results: [{ key: args.query, value: JSON.stringify(realVictim) }] };
        }
        if (args.query === orgMemberRecallKey('co-1', 'attacker-om')) {
          return { results: [{ key: args.query, value: JSON.stringify(attacker) }] };
        }
        return { results: [] };
      },
      ...statefulStore(),
    });

    // The attacker has a REAL, validly-signed, properly human-attested
    // credential — but for their OWN orgMemberId. Unlike the old attack
    // (just set id: 'victim-om' on a plain object, and the id — not a
    // secret anywhere else in this schema — was all that mattered), there
    // is no way to make this credential assert "victim-om" without it
    // genuinely having been minted for victim-om.
    const attackerAuthorization = await humanCredentialFor(attacker, config);

    await assert.rejects(
      () => setInteractionProfileConsent('co-1', 'victim-om', ['internal-timing'], attackerAuthorization, config),
      PrivacyConsentError,
    );
    assert.ok(
      !calls.some((c) => c.toolName === 'memory_store' && c.args.namespace === 'ruclip-employee-profiles'),
      'no consent was ever persisted for the real victim OrgMember',
    );
  },
);
