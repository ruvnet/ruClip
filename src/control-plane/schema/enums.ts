export type CompanyStatus = 'forming' | 'active' | 'paused' | 'dissolved';

export type OrgMemberKind = 'agent' | 'human';

export type OrgMemberStatus = 'active' | 'inactive';

export type GoalStatus = 'proposed' | 'active' | 'achieved' | 'abandoned';

export type IssueStatus =
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type ApprovalState = 'draft' | 'pending' | 'approved' | 'rejected';

/** agentdb_causal-edge relation types used by this schema (DOMAIN-MODEL.md §2.3). */
export type CausalRelation =
  | 'belongs_to'
  | 'parent_of'
  | 'blocks'
  | 'assigned_to'
  | 'reports_to'
  | 'approved_by'
  | 'rejected_by';

/** agentdb_hierarchical-store tiers this schema writes into (DOMAIN-MODEL.md §2.1). */
export type MemoryTier = 'working' | 'episodic' | 'semantic';
