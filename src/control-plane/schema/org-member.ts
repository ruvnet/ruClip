import type { OrgMemberKind, OrgMemberStatus } from './enums.js';

export interface OrgMember {
  id: string;
  companyId: string;
  kind: OrgMemberKind;
  /**
   * For kind: 'agent' — a ruflo Agent Teams SendMessage-addressable name.
   * For kind: 'human' — a claims/BBS identity string.
   */
  identityRef: string;
  role: string;
  /** OrgMember.id of this member's manager. Null only for the single root member. */
  managerId: string | null;
  status: OrgMemberStatus;
}
