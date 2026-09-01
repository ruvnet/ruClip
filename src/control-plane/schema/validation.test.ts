import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidCompany,
  assertValidOrgMember,
  assertValidGoal,
  assertValidIssue,
  assertValidComment,
  SchemaValidationError,
} from './validation.js';
import type { Company } from './company.js';
import type { OrgMember } from './org-member.js';
import type { Goal } from './goal.js';
import type { Issue } from './issue.js';
import type { Comment } from './comment.js';

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

function baseComment(): Comment {
  return { id: 'comment-1', issueId: 'issue-1', authorId: 'om-1', body: 'hi', createdAt: now };
}

test('assertValidCompany accepts a well-formed company', () => {
  assert.doesNotThrow(() => assertValidCompany(baseCompany()));
});

test('assertValidCompany rejects spent > total', () => {
  const company = baseCompany();
  company.budget = { ...company.budget, spent: 2000 };
  assert.throws(() => assertValidCompany(company), SchemaValidationError);
});

test('assertValidOrgMember rejects self-managing member', () => {
  const member = baseOrgMember();
  member.managerId = member.id;
  assert.throws(() => assertValidOrgMember(member), SchemaValidationError);
});

test('assertValidGoal rejects negative budgetAllocation', () => {
  const goal = baseGoal();
  goal.budgetAllocation = -1;
  assert.throws(() => assertValidGoal(goal), SchemaValidationError);
});

test('assertValidIssue rejects self-parenting', () => {
  const issue = baseIssue();
  issue.parentId = issue.id;
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test('assertValidIssue rejects done status with unapproved positive budget impact', () => {
  const issue = baseIssue();
  issue.status = 'done';
  issue.budgetImpact = 100;
  issue.approvalState = 'pending';
  issue.closedAt = now;
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test('assertValidIssue allows done status when budgetImpact is zero regardless of approvalState', () => {
  const issue = baseIssue();
  issue.status = 'done';
  issue.budgetImpact = 0;
  issue.closedAt = now;
  assert.doesNotThrow(() => assertValidIssue(issue));
});

test('assertValidIssue allows done status when approved with positive budget impact', () => {
  const issue = baseIssue();
  issue.status = 'done';
  issue.budgetImpact = 250;
  issue.approvalState = 'approved';
  issue.closedAt = now;
  assert.doesNotThrow(() => assertValidIssue(issue));
});

test('assertValidIssue requires closedAt once closed', () => {
  const issue = baseIssue();
  issue.status = 'cancelled';
  assert.throws(() => assertValidIssue(issue), SchemaValidationError);
});

test('assertValidComment rejects empty body', () => {
  const comment = baseComment();
  comment.body = '';
  assert.throws(() => assertValidComment(comment), SchemaValidationError);
});
