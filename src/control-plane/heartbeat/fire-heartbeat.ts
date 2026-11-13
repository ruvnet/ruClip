/**
 * Pure orchestration for one due HeartbeatSchedule firing
 * (HEARTBEATS-AND-COMMS.md §3). Both budget gates run before the wake is
 * ever published; either blocking pauses the schedule (fail closed) rather
 * than silently skipping to retry next cycle.
 */
import type { HeartbeatSchedule, HeartbeatOutcome } from '../schema/heartbeat-schedule.js';
import type { NotificationChannel } from '../schema/notification.js';
import {
  type AgentDbAdapterConfig,
  type PrefetchedHeartbeatTarget,
  recallCompany,
  recallIssue,
  recallGoal,
  checkOperatingBudget,
  persistHeartbeatSchedule,
} from '../store/agentdb-adapter.js';

export interface FireHeartbeatDeps {
  notifications?: NotificationChannel;
}

export interface FireHeartbeatResult {
  schedule: HeartbeatSchedule;
  outcome: HeartbeatOutcome;
}

function publishBestEffort(
  notifications: NotificationChannel | undefined,
  event: Parameters<NotificationChannel['publish']>[0],
): void {
  // HEARTBEATS-AND-COMMS.md §5 — comms is best-effort; never block the
  // underlying domain operation on a lost/degraded notification.
  if (notifications) {
    void notifications.publish(event).catch(() => {});
  }
}

async function pauseAndPersist(
  schedule: HeartbeatSchedule,
  outcome: HeartbeatOutcome,
  notifications: NotificationChannel | undefined,
  config?: AgentDbAdapterConfig,
  prefetchedTarget?: PrefetchedHeartbeatTarget,
): Promise<FireHeartbeatResult> {
  const now = new Date().toISOString();
  const pausedSchedule: HeartbeatSchedule = {
    ...schedule,
    status: 'paused',
    lastOutcome: outcome,
    updatedAt: now,
  };
  publishBestEffort(notifications, {
    kind: 'heartbeat-budget-blocked',
    companyId: schedule.companyId,
    subjectRef: `heartbeat:${schedule.id}`,
    payload: { outcome, target: schedule.target, assigneeId: schedule.assigneeId },
    occurredAt: now,
  });
  // No `actor` — firing is system-initiated cadence upkeep, not one of the
  // actor-driven create/pause/resume operations HEARTBEATS-AND-COMMS.md §6
  // requires a live claim for.
  await persistHeartbeatSchedule(pausedSchedule, undefined, schedule.status, config, prefetchedTarget);
  return { schedule: pausedSchedule, outcome };
}

export async function fireHeartbeat(
  schedule: HeartbeatSchedule,
  deps: FireHeartbeatDeps,
  config?: AgentDbAdapterConfig,
): Promise<FireHeartbeatResult> {
  const company = await recallCompany(schedule.companyId, config);
  if (!company) {
    return pauseAndPersist(schedule, 'error', deps.notifications, config);
  }

  // Gate 1 — application budget (HEARTBEATS-AND-COMMS.md §2/§3 step 2).
  //
  // `prefetchedTarget` captures whichever (non-null) issue/goal this gate
  // already recalled, so the later `persistHeartbeatSchedule` call(s) below
  // (Gate 2's block and the success path) can reuse it instead of issuing a
  // second, identical `recallIssue`/`recallGoal` round trip for the exact
  // same target — `persistHeartbeatSchedule` re-fetched it unconditionally
  // for its own existence/goalId validation even when the caller, moments
  // earlier, already proved it exists (flagged, not fixed, by PR #41's
  // Recommendation §1; left `undefined` on the `!issue`/`!goal` branches
  // below, which are unaffected — they already have nothing valid to pass).
  let prefetchedTarget: PrefetchedHeartbeatTarget | undefined;
  if (schedule.target.kind === 'issue') {
    const issue = await recallIssue(schedule.companyId, schedule.target.goalId, schedule.target.issueId, config);
    if (!issue) {
      return pauseAndPersist(schedule, 'error', deps.notifications, config);
    }
    prefetchedTarget = { kind: 'issue', issue };
    if (issue.budgetImpact > 0) {
      const cap = company.budget.total * company.budget.hardStopThreshold;
      if (company.budget.spent + issue.budgetImpact > cap) {
        return pauseAndPersist(schedule, 'application_budget_blocked', deps.notifications, config, prefetchedTarget);
      }
    }
  } else {
    const goal = await recallGoal(schedule.companyId, schedule.target.goalId, config);
    if (!goal) {
      return pauseAndPersist(schedule, 'error', deps.notifications, config);
    }
    prefetchedTarget = { kind: 'goal', goal };
    if (goal.budgetAllocation !== null) {
      const cap = company.budget.total * company.budget.hardStopThreshold;
      if (company.budget.spent + goal.budgetAllocation > cap) {
        return pauseAndPersist(schedule, 'application_budget_blocked', deps.notifications, config, prefetchedTarget);
      }
    }
  }

  // Gate 2 — operating-spend circuit breaker (HEARTBEATS-AND-COMMS.md §3 step 3, §4).
  const operatingBudget = await checkOperatingBudget(schedule.companyId, config);
  if (operatingBudget.level === 'HARD_STOP') {
    return pauseAndPersist(schedule, 'operating_budget_blocked', deps.notifications, config, prefetchedTarget);
  }

  // Both gates passed — this publish IS the wake (HEARTBEATS-AND-COMMS.md §3 step 4).
  publishBestEffort(deps.notifications, {
    kind: 'heartbeat-fired',
    companyId: schedule.companyId,
    subjectRef: `heartbeat:${schedule.id}`,
    payload: { assigneeId: schedule.assigneeId, target: schedule.target },
    occurredAt: new Date().toISOString(),
  });

  const now = new Date();
  const nextFireAt = new Date(now.getTime() + schedule.cadenceSeconds * 1000).toISOString();
  const firedSchedule: HeartbeatSchedule = {
    ...schedule,
    lastFiredAt: now.toISOString(),
    lastOutcome: 'ok',
    nextFireAt,
    updatedAt: now.toISOString(),
  };
  await persistHeartbeatSchedule(firedSchedule, undefined, schedule.status, config, prefetchedTarget);
  return { schedule: firedSchedule, outcome: 'ok' };
}
