/**
 * Runtime boundary validation for Company/OrgMember/Goal/Issue/Comment.
 *
 * These entities are accepted from agent "employees" (DOMAIN-MODEL.md), which
 * makes the store adapter a system boundary in the sense the coder-stage
 * brief means — so every write path in store/agentdb-adapter.ts runs its
 * payload through the matching `assert*` here before it reaches AgentDB.
 * Cross-entity/graph invariants (cycle prevention, blocker gating) are NOT
 * checked here — those require a query against stored state and live in the
 * adapter next to the causal-edge writes they guard.
 */
import type { Company, Budget } from './company.js';
import type { OrgMember } from './org-member.js';
import type { Goal } from './goal.js';
import type { Issue } from './issue.js';
import type { Comment } from './comment.js';
import type { ApprovalAction, ApprovalTransition } from './approval-transition.js';
import type { HeartbeatSchedule } from './heartbeat-schedule.js';
import type {
  CompanyStatus,
  OrgMemberKind,
  OrgMemberStatus,
  GoalStatus,
  IssueStatus,
  ApprovalState,
} from './enums.js';

export class SchemaValidationError extends Error {
  constructor(entity: string, reason: string) {
    super(`Invalid ${entity}: ${reason}`);
    this.name = 'SchemaValidationError';
  }
}

const COMPANY_STATUSES: readonly CompanyStatus[] = ['forming', 'active', 'paused', 'dissolved'];
const ORG_MEMBER_KINDS: readonly OrgMemberKind[] = ['agent', 'human'];
const ORG_MEMBER_STATUSES: readonly OrgMemberStatus[] = ['active', 'inactive'];
const GOAL_STATUSES: readonly GoalStatus[] = ['proposed', 'active', 'achieved', 'abandoned'];
const ISSUE_STATUSES: readonly IssueStatus[] = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
const APPROVAL_STATES: readonly ApprovalState[] = ['draft', 'pending', 'approved', 'rejected'];
const APPROVAL_ACTIONS: readonly ApprovalAction[] = ['submit', 'approve', 'reject', 'revise'];
const HEARTBEAT_STATUSES: readonly HeartbeatSchedule['status'][] = ['active', 'paused', 'cancelled'];
const HEARTBEAT_OUTCOMES: readonly NonNullable<HeartbeatSchedule['lastOutcome']>[] = [
  'ok',
  'application_budget_blocked',
  'operating_budget_blocked',
  'error',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * store/agentdb-adapter.ts builds AgentDB keys and causal-edge node ids by
 * string-concatenating id-like fields into `:`-delimited templates (e.g.
 * `ruclip:company:${companyId}:goal:${goalId}:issue:${issueId}`,
 * `entity:${kind}:${id}`). recallByKey does exact-string matching on the
 * result, so an id containing the template's own delimiters (":goal:",
 * ":issue:", etc.) can make two different (companyId, goalId, issueId)
 * triples serialize to the identical key string — letting a crafted id
 * overwrite or shadow a different entity's stored record (e.g. an approved
 * Issue's approvalState/budgetImpact) while still passing per-field
 * validation. Restricting every key-constituent id to a safe charset closes
 * that collision, not just the empty-string case isNonEmptyString covered.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_PATTERN.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function assertBudget(budget: Budget, entity: string): void {
  if (typeof budget !== 'object' || budget === null) {
    throw new SchemaValidationError(entity, 'budget must be an object');
  }
  if (typeof budget.total !== 'number' || budget.total < 0) {
    throw new SchemaValidationError(entity, 'budget.total must be a non-negative number');
  }
  if (typeof budget.spent !== 'number' || budget.spent < 0) {
    throw new SchemaValidationError(entity, 'budget.spent must be a non-negative number');
  }
  if (budget.spent > budget.total) {
    throw new SchemaValidationError(entity, 'budget.spent must not exceed budget.total');
  }
  if (!isNonEmptyString(budget.currency)) {
    throw new SchemaValidationError(entity, 'budget.currency is required');
  }
  if (!isNonEmptyString(budget.period)) {
    throw new SchemaValidationError(entity, 'budget.period is required');
  }
  if (
    typeof budget.hardStopThreshold !== 'number' ||
    budget.hardStopThreshold < 0 ||
    budget.hardStopThreshold > 1
  ) {
    throw new SchemaValidationError(entity, 'budget.hardStopThreshold must be a number in [0, 1]');
  }
}

export function assertValidCompany(company: Company): void {
  const entity = 'Company';
  if (!isSafeId(company.id)) throw new SchemaValidationError(entity, 'id must be a safe non-empty id string');
  if (!isNonEmptyString(company.name)) throw new SchemaValidationError(entity, 'name is required');
  if (company.primaryGoalId !== null && !isSafeId(company.primaryGoalId)) {
    throw new SchemaValidationError(entity, 'primaryGoalId must be a safe non-empty id string or null');
  }
  assertBudget(company.budget, entity);
  if (!COMPANY_STATUSES.includes(company.status)) {
    throw new SchemaValidationError(entity, `status must be one of ${COMPANY_STATUSES.join(', ')}`);
  }
  if (!isIsoDate(company.createdAt)) throw new SchemaValidationError(entity, 'createdAt must be ISO 8601');
  if (!isIsoDate(company.updatedAt)) throw new SchemaValidationError(entity, 'updatedAt must be ISO 8601');
}

export function assertValidOrgMember(member: OrgMember): void {
  const entity = 'OrgMember';
  if (!isSafeId(member.id)) throw new SchemaValidationError(entity, 'id must be a safe non-empty id string');
  if (!isSafeId(member.companyId)) {
    throw new SchemaValidationError(entity, 'companyId must be a safe non-empty id string');
  }
  if (!ORG_MEMBER_KINDS.includes(member.kind)) {
    throw new SchemaValidationError(entity, `kind must be one of ${ORG_MEMBER_KINDS.join(', ')}`);
  }
  if (!isNonEmptyString(member.identityRef)) {
    throw new SchemaValidationError(entity, 'identityRef is required');
  }
  if (!isNonEmptyString(member.role)) throw new SchemaValidationError(entity, 'role is required');
  if (member.managerId !== null && !isSafeId(member.managerId)) {
    throw new SchemaValidationError(entity, 'managerId must be a safe non-empty id string or null');
  }
  if (member.managerId === member.id) {
    throw new SchemaValidationError(entity, 'managerId must not equal id');
  }
  if (!ORG_MEMBER_STATUSES.includes(member.status)) {
    throw new SchemaValidationError(entity, `status must be one of ${ORG_MEMBER_STATUSES.join(', ')}`);
  }
}

export function assertValidGoal(goal: Goal): void {
  const entity = 'Goal';
  if (!isSafeId(goal.id)) throw new SchemaValidationError(entity, 'id must be a safe non-empty id string');
  if (!isSafeId(goal.companyId)) {
    throw new SchemaValidationError(entity, 'companyId must be a safe non-empty id string');
  }
  if (!isNonEmptyString(goal.description)) throw new SchemaValidationError(entity, 'description is required');
  if (!Array.isArray(goal.successCriteria) || goal.successCriteria.some((c) => !isNonEmptyString(c))) {
    throw new SchemaValidationError(entity, 'successCriteria must be an array of non-empty strings');
  }
  if (!GOAL_STATUSES.includes(goal.status)) {
    throw new SchemaValidationError(entity, `status must be one of ${GOAL_STATUSES.join(', ')}`);
  }
  if (goal.ownerId !== null && !isSafeId(goal.ownerId)) {
    throw new SchemaValidationError(entity, 'ownerId must be a safe non-empty id string or null');
  }
  if (goal.budgetAllocation !== null) {
    if (typeof goal.budgetAllocation !== 'number' || goal.budgetAllocation < 0) {
      throw new SchemaValidationError(entity, 'budgetAllocation must be a non-negative number or null');
    }
  }
  if (!isIsoDate(goal.createdAt)) throw new SchemaValidationError(entity, 'createdAt must be ISO 8601');
  if (!isIsoDate(goal.updatedAt)) throw new SchemaValidationError(entity, 'updatedAt must be ISO 8601');
}

export function assertValidIssue(issue: Issue): void {
  const entity = 'Issue';
  if (!isSafeId(issue.id)) throw new SchemaValidationError(entity, 'id must be a safe non-empty id string');
  if (!isSafeId(issue.goalId)) {
    throw new SchemaValidationError(entity, 'goalId must be a safe non-empty id string');
  }
  if (issue.parentId !== null) {
    if (!isSafeId(issue.parentId)) {
      throw new SchemaValidationError(entity, 'parentId must be a safe non-empty id string or null');
    }
    if (issue.parentId === issue.id) {
      throw new SchemaValidationError(entity, 'parentId must not equal id (no self-parenting)');
    }
  }
  if (issue.assigneeId !== null && !isSafeId(issue.assigneeId)) {
    throw new SchemaValidationError(entity, 'assigneeId must be a safe non-empty id string or null');
  }
  if (!isNonEmptyString(issue.title)) throw new SchemaValidationError(entity, 'title is required');
  if (typeof issue.description !== 'string') {
    throw new SchemaValidationError(entity, 'description must be a string');
  }
  if (!ISSUE_STATUSES.includes(issue.status)) {
    throw new SchemaValidationError(entity, `status must be one of ${ISSUE_STATUSES.join(', ')}`);
  }
  if (!APPROVAL_STATES.includes(issue.approvalState)) {
    throw new SchemaValidationError(entity, `approvalState must be one of ${APPROVAL_STATES.join(', ')}`);
  }
  if (typeof issue.budgetImpact !== 'number' || issue.budgetImpact < 0) {
    throw new SchemaValidationError(entity, 'budgetImpact must be a non-negative number');
  }
  if (issue.approvalTransitionRef !== null && !isSafeId(issue.approvalTransitionRef)) {
    throw new SchemaValidationError(entity, 'approvalTransitionRef must be a safe non-empty id string or null');
  }
  if (
    (issue.status === 'done' || issue.status === 'cancelled') &&
    issue.budgetImpact > 0 &&
    issue.status === 'done' &&
    issue.approvalState !== 'approved'
  ) {
    throw new SchemaValidationError(
      entity,
      'status cannot be done while budgetImpact > 0 and approvalState !== approved (DOMAIN-MODEL.md §1.4)',
    );
  }
  if (!isIsoDate(issue.createdAt)) throw new SchemaValidationError(entity, 'createdAt must be ISO 8601');
  if (!isIsoDate(issue.updatedAt)) throw new SchemaValidationError(entity, 'updatedAt must be ISO 8601');
  if (issue.closedAt !== null && !isIsoDate(issue.closedAt)) {
    throw new SchemaValidationError(entity, 'closedAt must be ISO 8601 or null');
  }
  if ((issue.status === 'done' || issue.status === 'cancelled') && issue.closedAt === null) {
    throw new SchemaValidationError(entity, 'closedAt is required once status is done or cancelled');
  }
}

export function assertValidComment(comment: Comment): void {
  const entity = 'Comment';
  if (!isSafeId(comment.id)) throw new SchemaValidationError(entity, 'id must be a safe non-empty id string');
  if (!isSafeId(comment.issueId)) {
    throw new SchemaValidationError(entity, 'issueId must be a safe non-empty id string');
  }
  if (!isSafeId(comment.authorId)) {
    throw new SchemaValidationError(entity, 'authorId must be a safe non-empty id string');
  }
  if (!isNonEmptyString(comment.body)) throw new SchemaValidationError(entity, 'body is required');
  if (!isIsoDate(comment.createdAt)) throw new SchemaValidationError(entity, 'createdAt must be ISO 8601');
}

/**
 * Structural checks only (safe-id fields, enum membership, reason
 * required-when-reject) — no access to prior state. Whether (action,
 * fromState) is a legal move, whether the actor is active, and the
 * self-approval invariant all need the issue/actor/previousTransition
 * context this function doesn't have; those live in
 * transitionApprovalState (src/control-plane/approval/transition-approval-state.ts)
 * per APPROVAL-GATE.md §2.
 */
export function assertValidApprovalTransition(transition: ApprovalTransition): void {
  const entity = 'ApprovalTransition';
  if (!isSafeId(transition.id)) throw new SchemaValidationError(entity, 'id must be a safe non-empty id string');
  if (!isSafeId(transition.issueId)) {
    throw new SchemaValidationError(entity, 'issueId must be a safe non-empty id string');
  }
  if (!APPROVAL_ACTIONS.includes(transition.action)) {
    throw new SchemaValidationError(entity, `action must be one of ${APPROVAL_ACTIONS.join(', ')}`);
  }
  if (!APPROVAL_STATES.includes(transition.fromState)) {
    throw new SchemaValidationError(entity, `fromState must be one of ${APPROVAL_STATES.join(', ')}`);
  }
  if (!APPROVAL_STATES.includes(transition.toState)) {
    throw new SchemaValidationError(entity, `toState must be one of ${APPROVAL_STATES.join(', ')}`);
  }
  if (!isSafeId(transition.actorId)) {
    throw new SchemaValidationError(entity, 'actorId must be a safe non-empty id string');
  }
  if (transition.reason !== null && typeof transition.reason !== 'string') {
    throw new SchemaValidationError(entity, 'reason must be a string or null');
  }
  if (transition.action === 'reject' && !isNonEmptyString(transition.reason)) {
    throw new SchemaValidationError(entity, 'reason is required (non-empty) when action is reject');
  }
  if (!isIsoDate(transition.createdAt)) throw new SchemaValidationError(entity, 'createdAt must be ISO 8601');
  if (transition.witnessRef !== null && !isNonEmptyString(transition.witnessRef)) {
    throw new SchemaValidationError(entity, 'witnessRef must be a non-empty string or null');
  }
}

/**
 * Structural checks only (safe-id fields, discriminated-union target shape,
 * enum membership, the cadenceSeconds floor) — no access to prior state.
 * Whether target.issueId's goalId actually matches the stored Issue's
 * goalId needs a recall and lives in persistHeartbeatSchedule
 * (store/agentdb-adapter.ts), same boundary split as every other
 * assertValid* in this file (HEARTBEATS-AND-COMMS.md §1).
 */
export function assertValidHeartbeatSchedule(schedule: HeartbeatSchedule): void {
  const entity = 'HeartbeatSchedule';
  if (!isSafeId(schedule.id)) throw new SchemaValidationError(entity, 'id must be a safe non-empty id string');
  if (!isSafeId(schedule.companyId)) {
    throw new SchemaValidationError(entity, 'companyId must be a safe non-empty id string');
  }
  if (schedule.target.kind !== 'goal' && schedule.target.kind !== 'issue') {
    throw new SchemaValidationError(entity, "target.kind must be 'goal' or 'issue'");
  }
  if (!isSafeId(schedule.target.goalId)) {
    throw new SchemaValidationError(entity, 'target.goalId must be a safe non-empty id string');
  }
  if (schedule.target.kind === 'issue' && !isSafeId(schedule.target.issueId)) {
    throw new SchemaValidationError(entity, 'target.issueId must be a safe non-empty id string');
  }
  if (!isSafeId(schedule.assigneeId)) {
    throw new SchemaValidationError(entity, 'assigneeId must be a safe non-empty id string');
  }
  if (typeof schedule.cadenceSeconds !== 'number' || schedule.cadenceSeconds < 60) {
    throw new SchemaValidationError(entity, 'cadenceSeconds must be a number >= 60');
  }
  if (!HEARTBEAT_STATUSES.includes(schedule.status)) {
    throw new SchemaValidationError(entity, `status must be one of ${HEARTBEAT_STATUSES.join(', ')}`);
  }
  if (!isIsoDate(schedule.nextFireAt)) throw new SchemaValidationError(entity, 'nextFireAt must be ISO 8601');
  if (schedule.lastFiredAt !== null && !isIsoDate(schedule.lastFiredAt)) {
    throw new SchemaValidationError(entity, 'lastFiredAt must be ISO 8601 or null');
  }
  if (schedule.lastOutcome !== null && !HEARTBEAT_OUTCOMES.includes(schedule.lastOutcome)) {
    throw new SchemaValidationError(entity, `lastOutcome must be one of ${HEARTBEAT_OUTCOMES.join(', ')} or null`);
  }
  if (!isIsoDate(schedule.createdAt)) throw new SchemaValidationError(entity, 'createdAt must be ISO 8601');
  if (!isIsoDate(schedule.updatedAt)) throw new SchemaValidationError(entity, 'updatedAt must be ISO 8601');
}
