/**
 * Per-human-OrgMember adaptive-learning substrate (EMPLOYEE-INTERACTION-PROFILE.md,
 * Phase 6a — first Human Employee Augmentation slice). Fed entirely by data
 * ruClip already holds (ApprovalTransition timing) — zero new external
 * signal ingestion, zero new PII surface this slice.
 *
 * Two load-bearing constraints, both enforced structurally, not just at
 * runtime:
 * 1. Opt-in (§3): `setInteractionProfileConsent` is the ONLY way
 *    `consentedSignalTypes` changes, and it hard-rejects any
 *    `actor.id !== orgMemberId` — no proxy/admin override exists as a code
 *    path, not merely as an unused option.
 * 2. Access control (§2): `recallOwnInteractionProfile(actor)` — the
 *    subject IS the requester, no separate `orgMemberId` parameter exists
 *    on this function at all. `recallInteractionProfileForComposition
 *    (companyId, orgMemberId)` — no `actor`/requester parameter exists on
 *    THIS function at all either (internal-only, reachable only from a
 *    future notification-composition call site). No function anywhere in
 *    this module takes `(requestingActor, targetOrgMemberId)` as two
 *    independent parameters — that is the actual guarantee, not a runtime
 *    permission check bolted onto a shape that could be misused.
 *
 * `AgentDbBridgeError`/`callTool`/`AgentDbAdapterConfig` are imported from
 * `store/bridge-client.ts` directly, not `store/agentdb-adapter.ts` — this
 * module is imported BY `agentdb-adapter.ts` (for the `deps.interactionLearning`
 * wiring in `applyApprovalTransition`), so importing the class
 * `PrivacyConsentError` extends from `agentdb-adapter.ts` itself would
 * recreate the exact two-way `class X extends Y` circular-import failure
 * `store/bridge-client.ts`'s own header documents (a `class ... extends`
 * heritage clause evaluates at module-load time, unlike a function call) —
 * `bridge-client.ts` is the dependency-free leaf specifically so modules on
 * both sides of that cycle can share it safely.
 */
import type { OrgMember } from '../schema/org-member.js';
import type { ApprovalTransition } from '../schema/approval-transition.js';
import type {
  EmployeeInteractionProfile,
  InteractionSignalType,
} from '../schema/employee-interaction-profile.js';
import { assertValidEmployeeInteractionProfile } from '../schema/validation.js';
import { AgentDbBridgeError, callTool, assertSafeId, type AgentDbAdapterConfig } from '../store/bridge-client.js';
import { recallOrgMember, listApprovalTransitionsForCompany } from '../store/agentdb-adapter.js';

export class PrivacyConsentError extends AgentDbBridgeError {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyConsentError';
  }
}

// --- Storage primitives (EMPLOYEE-INTERACTION-PROFILE.md §5) -------------
//
// Security-hardening correction (security review round 6): these three
// primitives originally lived in store/agentdb-adapter.ts, EXPORTED, per
// the design doc's own §6 file list. That made `recallInteractionProfile`
// a third, completely unrestricted read path — callable by any code that
// imports agentdb-adapter.ts (most of this codebase) with just an
// orgMemberId, no actor/requester parameter of any kind — directly
// contradicting §2's "no others exist" guarantee, confirmed exploitable by
// an independent test. The design's own comment on the export even said
// "NOT exported for general use as a 'read anyone's profile' function in
// disguise," but `export` in a JS/TS module has no such restriction — a
// symbol exported from a module every other file already imports from IS
// general-use, regardless of the comment's intent. Moving these three
// primitives here (their only legitimate caller) and keeping them
// module-private closes the gap the same way the design's own philosophy
// requires elsewhere: "access control... enforced by what parameters
// exist... not by a runtime check on values" — here, by what's
// *importable* at all, not by a comment asking callers not to.

/** Deliberately separate from operational-infra/domain-entity namespaces — see EMPLOYEE-INTERACTION-PROFILE.md §5. */
const RUCLIP_EMPLOYEE_PROFILES_NAMESPACE = 'ruclip-employee-profiles';

function interactionProfileKey(companyId: string, orgMemberId: string): string {
  assertSafeId(companyId, 'companyId');
  assertSafeId(orgMemberId, 'orgMemberId');
  return `ruclip:company:${companyId}:org-member:${orgMemberId}:interaction-profile`;
}

/** Low-level store primitive — memory_store, provenance_type: 'system_observation' (ADR-323), upsert: true. Module-private — see file header. */
async function persistInteractionProfile(
  profile: EmployeeInteractionProfile,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  assertValidEmployeeInteractionProfile(profile);
  await callTool(
    'memory_store',
    {
      key: interactionProfileKey(profile.companyId, profile.orgMemberId),
      value: JSON.stringify(profile),
      namespace: RUCLIP_EMPLOYEE_PROFILES_NAMESPACE,
      upsert: true,
      provenance_type: 'system_observation',
    },
    config,
  );
}

/**
 * Low-level recall primitive — exact (companyId, orgMemberId) key via
 * memory_retrieve. Module-private (see file header) — every caller in this
 * module goes through `recallOwnInteractionProfile`/
 * `recallInteractionProfileForComposition`/`recomputeInteractionSignals`,
 * which are the only functions this file exports for reading a profile.
 */
async function recallInteractionProfile(
  companyId: string,
  orgMemberId: string,
  config?: AgentDbAdapterConfig,
): Promise<EmployeeInteractionProfile | null> {
  const result = await callTool<{ found?: boolean; value?: unknown }>(
    'memory_retrieve',
    { key: interactionProfileKey(companyId, orgMemberId), namespace: RUCLIP_EMPLOYEE_PROFILES_NAMESPACE },
    config,
  );
  if (!result.found || typeof result.value !== 'object' || result.value === null) return null;
  return result.value as EmployeeInteractionProfile;
}

// --- §2: the two, and only two, read paths ------------------------------

/**
 * Self-read: `actor.id` is both the requester and the subject — there is
 * no `orgMemberId` parameter separate from `actor.id`, by construction, so
 * there is no way to call this asking about someone else.
 */
export async function recallOwnInteractionProfile(
  actor: OrgMember,
  config?: AgentDbAdapterConfig,
): Promise<EmployeeInteractionProfile | null> {
  return recallInteractionProfile(actor.companyId, actor.id, config);
}

/**
 * Internal composition-only read — no `actor`/requester parameter at all,
 * because it is not reachable from any actor-driven/API-shaped call path;
 * only from a future notification-composition pipeline deciding how to
 * talk to this exact `orgMemberId`, for that same person.
 */
export async function recallInteractionProfileForComposition(
  companyId: string,
  orgMemberId: string,
  config?: AgentDbAdapterConfig,
): Promise<EmployeeInteractionProfile | null> {
  return recallInteractionProfile(companyId, orgMemberId, config);
}

// --- §3: consent — self-service, fail-closed, per signal type -----------

function emptyProfile(companyId: string, orgMemberId: string, now: string): EmployeeInteractionProfile {
  return {
    id: orgMemberId,
    companyId,
    orgMemberId,
    consentedSignalTypes: [],
    medianDecisionLatencySeconds: null,
    decisionHourHistogram: new Array(24).fill(0),
    sampleCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * NOT retrofitted to ActorCredential despite ACTOR-IDENTITY-VERIFICATION.md
 * §5 item 5 naming this function — found while implementing, flagged back
 * rather than silently applied or silently skipped. This function's own
 * kind !== 'human' rejection below means EmployeeInteractionProfile consent
 * applies ONLY to human OrgMembers, by design (EMPLOYEE-INTERACTION-PROFILE.md
 * §3). ACTOR-IDENTITY-VERIFICATION.md §4's locked decision blocks EVERY
 * `kind: 'human'` OrgMember from ever resolving a valid ActorCredential (no
 * human issuance path exists). Gating this function behind
 * `resolveVerifiedActor` would therefore make it permanently uncallable —
 * no human could ever set their own consent again, a direct regression of
 * already-shipped, already-tested functionality (Phase 6a), not a security
 * fix. Left as the pre-existing self-service `actor.id === orgMemberId`
 * check (already independently hardened — see this file's own history and
 * the access-control-gaps test file) until either real human credential
 * issuance ships (ACTOR-IDENTITY-VERIFICATION.md §4/Phase 2) or the
 * human-block decision is revisited to scope per-call-site rather than
 * blanket. See docs/PLAN.md §8 for the same finding recorded against
 * `mintHumanCommsAccess` (comms/agentbbs-notification-channel.ts) — the
 * root cause is identical in both places.
 */
export async function setInteractionProfileConsent(
  companyId: string,
  orgMemberId: string,
  signalTypes: InteractionSignalType[],
  actor: OrgMember,
  config?: AgentDbAdapterConfig,
): Promise<EmployeeInteractionProfile> {
  // First thing this function does, before any recall/write, per the
  // design's own instruction — consent is self-service only, no
  // proxy/admin/manager override.
  if (actor.id !== orgMemberId) {
    throw new PrivacyConsentError(
      `Consent for EmployeeInteractionProfile is self-service only — actor '${actor.id}' cannot set consent for ` +
        `'${orgMemberId}'`,
    );
  }

  const target = await recallOrgMember(companyId, orgMemberId, config);
  if (!target) {
    throw new PrivacyConsentError(`OrgMember '${orgMemberId}' does not exist in company '${companyId}'`);
  }
  if (target.kind !== 'human') {
    throw new PrivacyConsentError(
      `EmployeeInteractionProfile consent applies only to human OrgMembers — '${orgMemberId}' has kind '${target.kind}'`,
    );
  }

  const existing = await recallInteractionProfile(companyId, orgMemberId, config);
  const now = new Date().toISOString();
  // signalTypes REPLACES (not merges with) consentedSignalTypes — an
  // explicit "these and only these" set each call, so withdrawing consent
  // is the same code path as granting it.
  const profile: EmployeeInteractionProfile = existing
    ? { ...existing, consentedSignalTypes: signalTypes, updatedAt: now }
    : { ...emptyProfile(companyId, orgMemberId, now), consentedSignalTypes: signalTypes };

  await persistInteractionProfile(profile, config);
  return profile;
}

// --- §4: signal computation — from data already in AgentDB ---------------

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Recomputes `medianDecisionLatencySeconds`/`decisionHourHistogram`/
 * `sampleCount` for one human OrgMember, from all currently-available
 * ApprovalTransition records — recomputed fresh each call (§4 step 4), not
 * incrementally averaged. No-op (returns the profile unchanged, or `null`
 * if no profile exists) when `'internal-timing'` is not in
 * `consentedSignalTypes` — no computation happens for an unconsented
 * signal type.
 */
export async function recomputeInteractionSignals(
  companyId: string,
  orgMemberId: string,
  config?: AgentDbAdapterConfig,
): Promise<EmployeeInteractionProfile | null> {
  // System-internal recomputation, not a user-facing read — no actor check
  // needed here (§4 step 1).
  const profile = await recallInteractionProfile(companyId, orgMemberId, config);
  if (!profile || !profile.consentedSignalTypes.includes('internal-timing')) {
    return profile;
  }

  const allTransitions = await listApprovalTransitionsForCompany(companyId, config);
  const byIssue = new Map<string, ApprovalTransition[]>();
  for (const t of allTransitions) {
    const list = byIssue.get(t.issueId) ?? [];
    list.push(t);
    byIssue.set(t.issueId, list);
  }
  for (const list of byIssue.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  const latencySamplesSeconds: number[] = [];
  const decisionHourHistogram = new Array(24).fill(0);

  for (const list of byIssue.values()) {
    for (let i = 0; i < list.length; i++) {
      const transition = list[i]!;
      if (transition.actorId !== orgMemberId) continue;
      if (transition.action !== 'approve' && transition.action !== 'reject') continue;

      // The immediately-prior transition (for the SAME issueId) whose
      // toState matches this transition's fromState — i.e. the submit
      // that put the issue into the state this decision is resolving.
      let priorTransition: ApprovalTransition | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (list[j]!.toState === transition.fromState) {
          priorTransition = list[j];
          break;
        }
      }
      if (!priorTransition) continue;

      const pendingSinceMs = Date.parse(priorTransition.createdAt);
      const decidedAtMs = Date.parse(transition.createdAt);
      if (Number.isNaN(pendingSinceMs) || Number.isNaN(decidedAtMs) || decidedAtMs < pendingSinceMs) continue;

      latencySamplesSeconds.push((decidedAtMs - pendingSinceMs) / 1000);
      // §4 step 6: UTC hour, not per-person local time — no OrgMember
      // timezone field exists yet. Named open item, not silently assumed.
      decisionHourHistogram[new Date(decidedAtMs).getUTCHours()] += 1;
    }
  }

  const now = new Date().toISOString();
  const updated: EmployeeInteractionProfile = {
    ...profile,
    medianDecisionLatencySeconds: latencySamplesSeconds.length > 0 ? median(latencySamplesSeconds) : null,
    decisionHourHistogram,
    sampleCount: latencySamplesSeconds.length,
    updatedAt: now,
  };
  await persistInteractionProfile(updated, config);
  return updated;
}
