/**
 * Read-only company-board snapshot assembly (RUCLIP-DASHBOARD.md §5). Pure
 * composition of existing recall/list primitives into one plain-data
 * object — no new AgentDB calls of its own beyond what those primitives
 * already make. This IS the thing that gets embedded as static data in the
 * published dashboard Artifact's HTML (§0): a snapshot, current as of
 * `publishedAt`, not a live feed — the republishing agent calls this,
 * embeds the result, and republishes; there is no in-page fetch.
 */
import {
  recallCompany,
  recallOrgMember,
  listGoalsForCompany,
  listIssuesForGoal,
  listHeartbeatsForCompany,
  getChildIssueIds,
  getBlockerIssueIds,
  operatingBudgetLevel,
  DEFAULT_OPERATING_BUDGET_THRESHOLDS,
  type AgentDbAdapterConfig,
  type OperatingBudgetLevel,
} from '../store/agentdb-adapter.js';
import type { GoalStatus, IssueStatus, ApprovalState, CompanyStatus } from '../schema/enums.js';
import type { HeartbeatTarget, HeartbeatStatus, HeartbeatOutcome } from '../schema/heartbeat-schedule.js';

/** Resolved via recallOrgMember — OrgMember has no dedicated display-name field, so identityRef + role together are the best available identification (schema/org-member.ts). */
export interface DashboardOrgMemberRef {
  id: string;
  identityRef: string;
  role: string;
}

export interface DashboardIssueSnapshot {
  id: string;
  title: string;
  status: IssueStatus;
  approvalState: ApprovalState;
  budgetImpact: number;
  assigneeId: string | null;
  assignee: DashboardOrgMemberRef | null;
  parentId: string | null;
  childIssueIds: string[];
  blockerIssueIds: string[];
}

export interface DashboardGoalSnapshot {
  id: string;
  description: string;
  status: GoalStatus;
  successCriteria: string[];
  ownerId: string | null;
  owner: DashboardOrgMemberRef | null;
  budgetAllocation: number | null;
  issues: DashboardIssueSnapshot[];
}

export interface DashboardHeartbeatSnapshot {
  id: string;
  target: HeartbeatTarget;
  assigneeId: string;
  assignee: DashboardOrgMemberRef | null;
  cadenceSeconds: number;
  status: HeartbeatStatus;
  nextFireAt: string;
  lastFiredAt: string | null;
  lastOutcome: HeartbeatOutcome | null;
}

export interface DashboardCompanySnapshot {
  id: string;
  name: string;
  status: CompanyStatus;
  budget: {
    total: number;
    spent: number;
    remaining: number;
    currency: string;
    period: string;
    utilizationPct: number;
    /** Same alert-ladder (50/75/90/100%) checkOperatingBudget uses — see that function's own thresholds. */
    level: OperatingBudgetLevel;
  };
}

export interface DashboardSnapshot {
  /** ISO 8601 — when this snapshot was assembled, shown on the page so a viewer never mistakes it for live data (§0). */
  publishedAt: string;
  company: DashboardCompanySnapshot;
  goals: DashboardGoalSnapshot[];
  heartbeats: DashboardHeartbeatSnapshot[];
}

/**
 * Per-`buildDashboardSnapshot`-call memoization for `resolveOrgMemberRef`
 * (docs/PLAN.md "Benchmark/optimize investigation", 2026-09-02, team-lead
 * approved) — a small-company shape (5 goals x 6 issues, 4 org members)
 * measured 65 `recallOrgMember` round trips for only 4 distinct members,
 * 61 of them pure duplicates, since `resolveOrgMemberRef` re-fetched the
 * same org member on every reference. **Required, not optional/defaulted**
 * — deliberately not a module-level/default-instance cache, so a stale or
 * cross-company org-member reference can't silently leak between different
 * companies or different snapshot builds (team-lead's explicit correctness
 * requirement, distinct from the optimization itself): every caller must
 * be handed a cache instance, and `buildDashboardSnapshot` is the only
 * place one is constructed, fresh, per call. Stores the in-flight PROMISE
 * (not the resolved value) so concurrent lookups for the same id within
 * one build (e.g. an issue's assignee and a goal's owner resolving
 * concurrently under the same `Promise.all`) also dedupe onto the same
 * `recallOrgMember` call rather than racing to both start one.
 */
type OrgMemberCache = Map<string, Promise<DashboardOrgMemberRef | null>>;

async function resolveOrgMemberRef(
  companyId: string,
  orgMemberId: string | null,
  cache: OrgMemberCache,
  config?: AgentDbAdapterConfig,
): Promise<DashboardOrgMemberRef | null> {
  if (!orgMemberId) return null;
  const cached = cache.get(orgMemberId);
  if (cached) return cached;
  const pending = recallOrgMember(companyId, orgMemberId, config).then((member) =>
    member ? { id: member.id, identityRef: member.identityRef, role: member.role } : null,
  );
  cache.set(orgMemberId, pending);
  return pending;
}

async function buildIssueSnapshot(
  companyId: string,
  issue: Awaited<ReturnType<typeof listIssuesForGoal>>[number],
  cache: OrgMemberCache,
  config?: AgentDbAdapterConfig,
): Promise<DashboardIssueSnapshot> {
  const [assignee, childIssueIds, blockerIssueIds] = await Promise.all([
    resolveOrgMemberRef(companyId, issue.assigneeId, cache, config),
    getChildIssueIds(issue.id, config),
    getBlockerIssueIds(issue.id, config),
  ]);
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    approvalState: issue.approvalState,
    budgetImpact: issue.budgetImpact,
    assigneeId: issue.assigneeId,
    assignee,
    parentId: issue.parentId,
    childIssueIds,
    blockerIssueIds,
  };
}

async function buildGoalSnapshot(
  companyId: string,
  goal: Awaited<ReturnType<typeof listGoalsForCompany>>[number],
  cache: OrgMemberCache,
  config?: AgentDbAdapterConfig,
): Promise<DashboardGoalSnapshot> {
  const [owner, rawIssues] = await Promise.all([
    resolveOrgMemberRef(companyId, goal.ownerId, cache, config),
    listIssuesForGoal(companyId, goal.id, config),
  ]);
  const issues = await Promise.all(rawIssues.map((issue) => buildIssueSnapshot(companyId, issue, cache, config)));
  return {
    id: goal.id,
    description: goal.description,
    status: goal.status,
    successCriteria: goal.successCriteria,
    ownerId: goal.ownerId,
    owner,
    budgetAllocation: goal.budgetAllocation,
    issues,
  };
}

/**
 * Assembles one read-only snapshot for `companyId`. Returns `null` when the
 * company itself doesn't exist — the republishing agent's own job to decide
 * what that means for the page (e.g. skip the publish).
 */
export async function buildDashboardSnapshot(
  companyId: string,
  config?: AgentDbAdapterConfig,
): Promise<DashboardSnapshot | null> {
  const company = await recallCompany(companyId, config);
  if (!company) return null;

  const [goals, heartbeatSchedules] = await Promise.all([
    listGoalsForCompany(companyId, config),
    listHeartbeatsForCompany(companyId, config),
  ]);

  // Fresh per call — see resolveOrgMemberRef's own header for why this must
  // never be module-level/shared across companies or calls.
  const orgMemberCache: OrgMemberCache = new Map();

  const [goalSnapshots, heartbeats] = await Promise.all([
    Promise.all(goals.map((goal) => buildGoalSnapshot(companyId, goal, orgMemberCache, config))),
    Promise.all(
      heartbeatSchedules.map(async (schedule) => ({
        id: schedule.id,
        target: schedule.target,
        assigneeId: schedule.assigneeId,
        assignee: await resolveOrgMemberRef(companyId, schedule.assigneeId, orgMemberCache, config),
        cadenceSeconds: schedule.cadenceSeconds,
        status: schedule.status,
        nextFireAt: schedule.nextFireAt,
        lastFiredAt: schedule.lastFiredAt,
        lastOutcome: schedule.lastOutcome,
      })),
    ),
  ]);

  // Security-hardening correction (security review round 8): getChildIssueIds/
  // getBlockerIssueIds key their causal-graph nodes via entityNodeId('issue',
  // issueId) = `entity:issue:{issueId}` — no companyId component, true since
  // persistIssue's very first parent_of/blocks edge write. If two different
  // companies' issues ever collide on id (assertValidIssue only enforces the
  // safe-id charset, not global uniqueness), a foreign company's issue id
  // could surface in childIssueIds/blockerIssueIds and be displayed verbatim
  // as though it belonged to this company — confirmed by an independent test.
  // No new AgentDB calls are needed to close this: by this point every issue
  // id that genuinely belongs to `companyId` is already known (collected
  // across every goal above), so filter both fields against that set —
  // anything not in it is dropped rather than displayed.
  const companyIssueIds = new Set(goalSnapshots.flatMap((g) => g.issues.map((i) => i.id)));
  for (const goal of goalSnapshots) {
    for (const issue of goal.issues) {
      issue.childIssueIds = issue.childIssueIds.filter((id) => companyIssueIds.has(id));
      issue.blockerIssueIds = issue.blockerIssueIds.filter((id) => companyIssueIds.has(id));
    }
  }

  const utilizationPct = company.budget.total > 0 ? company.budget.spent / company.budget.total : 0;

  return {
    publishedAt: new Date().toISOString(),
    company: {
      id: company.id,
      name: company.name,
      status: company.status,
      budget: {
        total: company.budget.total,
        spent: company.budget.spent,
        remaining: company.budget.total - company.budget.spent,
        currency: company.budget.currency,
        period: company.budget.period,
        utilizationPct,
        level: operatingBudgetLevel(utilizationPct, DEFAULT_OPERATING_BUDGET_THRESHOLDS),
      },
    },
    goals: goalSnapshots,
    heartbeats,
  };
}
