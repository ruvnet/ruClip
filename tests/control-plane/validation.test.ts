/**
 * Additional boundary-validation coverage for Company/OrgMember/Goal/Issue,
 * complementing src/control-plane/schema/validation.test.ts (written by the
 * coder stage). Focuses on invalid-construction cases the coder's own suite
 * didn't hit, plus a canary for silently dropped Issue fields (see the last
 * describe block).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidCompany,
  assertValidOrgMember,
  assertValidGoal,
  assertValidIssue,
  SchemaValidationError,
} from '../../src/control-plane/schema/validation.js';
import type { Company } from '../../src/control-plane/schema/company.js';
import type { OrgMember } from '../../src/control-plane/schema/org-member.js';
import type { Goal } from '../../src/control-plane/schema/goal.js';
import type { Issue } from '../../src/control-plane/schema/issue.js';

const now = '2026-09-01T00:00:00.000Z';

function baseCompany(): Company {
  return {
    id: 'co-1',
    name: 'Acme',
    primaryGoalId: null,
    budget: { total: 1000, spent: 100, currency: 'USD', period: '2026-09', hardStopThreshold: 0.9 },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function baseOrgMember(): OrgMember {
  return {
    id: 'om-1',
    companyId: 'co-1',
    kind: 'agent',
    identityRef: 'agent-team-name',
    role: 'CEO',
    managerId: null,
    status: 'active',
  };
}

function baseGoal(): Goal {
  return {
    id: 'goal-1',
    companyId: 'co-1',
    description: 'Ship v1',
    successCriteria: ['Users can sign up'],
    status: 'active',
    ownerId: 'om-1',
    budgetAllocation: 500,
    createdAt: now,
    updatedAt: now,
  };
}

function baseIssue(): Issue {
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
  };
}

// --- Company ---------------------------------------------------------------

test('assertValidCompany rejects an empty id', () => {
  const company = baseCompany();
  company.id = '';
  assert.throws(() => assertValidCompany(company), SchemaValidationError);
});

test('assertValidCompany rejects an unknown status value', () => {
  const company = baseCompany();
  (company as unknown as { status: string }).status = 'archived';
  assert.throws(() => assertValidCompany(company), SchemaValidationError);
});

test('assertValidCompany rejects negative budget.total', () => {
  const company = baseCompany();
  company.budget = { ...company.budget, total: -1 };
  assert.throws(() => assertValidCompany(company), SchemaValidationError);
});

test('assertValidCompany rejects hardStopThreshold outside [0, 1]', () => {
  const company = baseCompany();
  company.budget = { ...company.budget, hardStopThreshold: 1.5 };
  assert.throws(() => assertValidCompany(company), SchemaValidationError);
});

test('assertValidCompany rejects a non-ISO createdAt', () => {
  const company = baseCompany();
  company.createdAt = 'not-a-date';
  assert.throws(() => assertValidCompany(company), SchemaValidationError);
});

test('assertValidCompany rejects a non-empty-string primaryGoalId of empty string', () => {
  const company = baseCompany();
  company.primaryGoalId = '';
  assert.throws(() => assertValidCompany(company), SchemaValidationError);
});

// --- OrgMember ---------------------------------------------------------------

test('assertValidOrgMember rejects an unknown kind', () => {
  const member = baseOrgMember();
  (member as unknown as { kind: string }).kind = 'robot';
  assert.throws(() => assertValidOrgMember(member), SchemaValidationError);
});

test('assertValidOrgMember rejects an unknown status', () => {
  const member = baseOrgMember();
  (member as unknown as { status: string }).status = 'on-leave';
  assert.throws(() => assertValidOrgMember(member), SchemaValidationError);
});

test('assertValidOrgMember rejects a managerId pointing at an empty string', () => {
  const member = baseOrgMember();
  member.managerId = '';
  assert.throws(() => assertValidOrgMember(member), SchemaValidationError);
});

// --- Goal ---------------------------------------------------------------

test('assertValidGoal rejects an unknown status', () => {
  const goal = baseGoal();
  (goal as unknown as { status: string }).status = 'stalled';
  assert.throws(() => assertValidGoal(goal), SchemaValidationError);
});

test('assertValidGoal rejects an empty description', () => {
  const goal = baseGoal();
  goal.description = '';
  assert.throws(() => assertValidGoal(goal), SchemaValidationError);
});

test('assertValidGoal rejects successCriteria containing an empty entry', () => {
  const goal = baseGoal();
  goal.successCriteria = ['Users can sign up', ''];
  assert.throws(() => assertValidGoal(goal), SchemaValidationError);
});

test('assertValidGoal rejects a non-array successCriteria', () => {
  const goal = baseGoal();
  (goal as unknown as { successCriteria: string }).successCriteria = 'not an array';
  assert.throws(() => assertValidGoal(goal), SchemaValidationError);
});

// --- Issue ---------------------------------------------------------------

test('assertValidIssue rejects an unknown status', () => {
  const issue = baseIssue();
  (issue as unknown as { status: string }).status = 'archived';
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test('assertValidIssue rejects an unknown approvalState', () => {
  const issue = baseIssue();
  (issue as unknown as { approvalState: string }).approvalState = 'auto-approved';
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test('assertValidIssue rejects a negative budgetImpact', () => {
  const issue = baseIssue();
  issue.budgetImpact = -50;
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test('assertValidIssue rejects an empty-string assigneeId', () => {
  const issue = baseIssue();
  issue.assigneeId = '';
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test('assertValidIssue rejects an empty title', () => {
  const issue = baseIssue();
  issue.title = '';
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test(
  'assertValidIssue allows cancelled status with an unapproved positive budgetImpact ' +
    '(DOMAIN-MODEL.md §1.4 gates only the done transition, not cancelled)',
  () => {
    const issue = baseIssue();
    issue.status = 'cancelled';
    issue.budgetImpact = 300;
    issue.approvalState = 'draft';
    issue.closedAt = now;
    assert.doesNotThrow(() => assertValidIssue(issue));
  },
);

test('assertValidIssue rejects done status with a rejected approvalState and positive budgetImpact', () => {
  const issue = baseIssue();
  issue.status = 'done';
  issue.budgetImpact = 100;
  issue.approvalState = 'rejected';
  issue.closedAt = now;
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test('assertValidIssue allows a non-done, non-cancelled status with any approvalState regardless of budgetImpact', () => {
  const issue = baseIssue();
  issue.status = 'in_progress';
  issue.budgetImpact = 500;
  issue.approvalState = 'rejected';
  assert.doesNotThrow(() => assertValidIssue(issue));
});

// --- Canary: a silently dropped budgetImpact/approvalState field must be caught ---

test('assertValidIssue rejects an Issue missing the budgetImpact field entirely', () => {
  const issue = baseIssue() as Partial<Issue>;
  delete issue.budgetImpact;
  assert.throws(() => assertValidIssue(issue as Issue), SchemaValidationError);
});

test('assertValidIssue rejects an Issue missing the approvalState field entirely', () => {
  const issue = baseIssue() as Partial<Issue>;
  delete issue.approvalState;
  assert.throws(() => assertValidIssue(issue as Issue), SchemaValidationError);
});
