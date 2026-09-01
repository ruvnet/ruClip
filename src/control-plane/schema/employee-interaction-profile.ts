export type InteractionSignalType = 'internal-timing'; // extensible — the only value this slice

export interface EmployeeInteractionProfile {
  id: string; // == orgMemberId, one profile per human OrgMember
  companyId: string;
  orgMemberId: string;
  /**
   * Signal types this OrgMember has explicitly consented to. Empty by
   * default — even 'internal-timing' (this slice's only, low-risk,
   * already-in-schema signal) requires explicit opt-in, not just future
   * external signals. No profile is computed for any signal type not in
   * this set (EMPLOYEE-INTERACTION-PROFILE.md §3).
   */
  consentedSignalTypes: InteractionSignalType[];
  /** Median seconds from an Issue reaching 'pending' to this OrgMember's approve/reject decision. Null until >=1 sample. */
  medianDecisionLatencySeconds: number | null;
  /** Count of hour-of-day (0-23, UTC — see §4 note, no per-OrgMember timezone field exists yet) buckets this OrgMember has made decisions in — a lightweight histogram, not raw timestamps. */
  decisionHourHistogram: number[]; // length 24
  /** How many ApprovalTransition observations fed the current aggregate. */
  sampleCount: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
