/**
 * Independent coverage for the Phase 4 Autogenous governance slice (commit
 * f154254), complementing tests/control-plane/autogenous-governance.test.ts
 * (written by the coder for their own commit — every real AdmitResponse
 * error code, the CanaryState/Decision externally-tagged shape round-trips
 * and rejections, AutogenousClientError-as-"not admitted" everywhere, the
 * 3rd-consecutive-reading trigger, the not-admitted persisted-with-null-
 * controller case, and a multi-step observation sequence). All of that
 * verified passing.
 *
 * FINDING (test 1 below), FIXED (security review round 9): `checkAndProposeBudgetMutation`'s
 * trigger check — `hasConsecutiveWarningOrWorse(history)` — looked only at
 * whether the LAST `CONSECUTIVE_THRESHOLD` (3) readings in the rolling
 * window were all WARNING-or-worse. Nothing reset the window, marked the
 * streak as "already proposed for," or otherwise de-duplicated after a
 * successful trigger. AUTOGENOUS-RUNTIME-GOVERNANCE.md §4 describes the
 * trigger as "a repeated pattern... becomes the trigger for a proposed
 * Mutation" (singular proposal for the pattern), but the code re-evaluated
 * the same "last 3" condition on every call with no memory of having
 * already proposed a mutation for this exact ongoing streak.
 *
 * Concretely: since `Company.budget.hardStopThreshold` is never actually
 * updated by this v1 flow (per §4's own "not applied until a real
 * /v1/promote success" — Phase 4b, out of scope), the caller passes the
 * SAME `currentHardStopThreshold` on every call for as long as the
 * underlying budget problem persists. That meant a sustained WARNING
 * streak didn't just trigger once at the 3rd consecutive reading — every
 * SUBSEQUENT reading (4th, 5th, 6th...) also saw its own "last 3 are all
 * WARNING+" window and re-triggered, submitting a brand-new `/v1/agl/admit`
 * + `/v1/canary/new` pair (a new `mutation.id` via `randomUUID()` each
 * time, but the identical parent genome hash and identical proposed
 * threshold, since nothing about the inputs changed) for what is, from the
 * governance-service's perspective, the exact same already-proposed
 * config change. This was a real operational concern for a system whose
 * whole point is bounded, auditable mutations — an unbounded budget
 * incident would have produced an unbounded number of duplicate
 * Mutation/Canary records, not one governed proposal per incident.
 *
 * Fixed by making the trigger edge-triggered instead of level-triggered:
 * the "last 3 are WARNING+" condition must be true NOW and have been false
 * immediately before the current window began — i.e. this is the reading
 * where the streak first crossed the threshold, not a continuation of an
 * already-triggered one (`isNewWarningStreak` in propose-budget-mutation.ts).
 * A sustained streak now fires exactly once; a genuinely new incident
 * (streak breaks back to OK/INFO, then crosses WARNING+ again) still fires
 * again correctly, as its own separate proposal — test 2 below proves that
 * recovery case.
 *
 * Test 1 below (flipped) proves the fix concretely: 4 consecutive WARNING
 * readings now produce exactly ONE `triggered: true` result and exactly one
 * `/v1/agl/admit` + `/v1/canary/new` pair, not two.
 *
 * No live AgentDB/autogenous-service instance — mockBridge + a plain-fetch
 * mock, same pattern the coder's own test file establishes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import type { AutogenousClientConfig, CanaryController, HardGates } from '../../src/control-plane/governance/autogenous-client.js';
import { checkAndProposeBudgetMutation } from '../../src/control-plane/governance/propose-budget-mutation.js';

interface AutogenousRecordedCall {
  path: string;
  body: unknown;
}

function mockAutogenousService(handlers: Record<string, (body: unknown) => unknown>) {
  const calls: AutogenousRecordedCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const handler = handlers[path];
    if (!handler) {
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }
    const result = handler(body);
    return { ok: true, status: 200, json: async () => result } as Response;
  }) as typeof fetch;
  const config: AutogenousClientConfig = { fetchImpl, baseUrl: 'https://autogenous.mock' };
  return { calls, config };
}

const HARD_GATES: HardGates = { min_safety: 0.99, min_governance: 0.99, max_false_positive_rate: 0.005, max_p99_overhead_ms: 5 };

function baseController(overrides: Partial<CanaryController> = {}): CanaryController {
  return {
    candidate_id: 'mutation-1',
    rollback_target: 'genome-hash-parent',
    gates: HARD_GATES,
    observations_per_stage: 1,
    state: { Serving: { stage_idx: 0, healthy_observations: 0 } },
    audit: [],
    consumed_nonces: [],
    ...overrides,
  };
}

function checkOperatingBudgetMocks() {
  return {
    'memory_retrieve': (args: Record<string, unknown>) => {
      if (args.namespace === 'ruclip-cost-tracking' && args.key === 'co-1:budget-config') {
        return { found: true, value: { budgetUsd: 100, thresholds: { info: 0.5, warning: 0.75, critical: 0.9, hardStop: 1.0 } } };
      }
      if (args.namespace === 'ruclip-cost-tracking' && args.key === 'co-1:session-a') {
        return { found: true, value: { total_cost_usd: 80 } }; // 0.8 utilization -> WARNING
      }
      return { found: false };
    },
    'memory_list': () => ({ entries: [{ key: 'co-1:session-a' }] }),
  };
}

function statefulNamespaceStore() {
  const store = new Map<string, unknown>();
  return {
    memory_retrieve: (args: Record<string, unknown>) => {
      const key = `${args.namespace}:${args.key}`;
      return store.has(key) ? { found: true, value: store.get(key) } : { found: false };
    },
    memory_store: (args: Record<string, unknown>) => {
      store.set(`${args.namespace}:${args.key}`, JSON.parse(args.value as string));
      return { success: true };
    },
  };
}

test(
  'FIXED: a sustained WARNING-or-worse streak triggers checkAndProposeBudgetMutation exactly ONCE, not on ' +
    'every subsequent reading — the 4th consecutive WARNING reading no longer submits a second, redundant ' +
    '/v1/agl/admit + /v1/canary/new pair for the same ongoing incident',
  async () => {
    const namespaceStore = statefulNamespaceStore();
    const { config } = mockBridge({
      memory_retrieve: (args) => {
        if (args.namespace === 'ruclip-cost-tracking') return checkOperatingBudgetMocks().memory_retrieve(args);
        return namespaceStore.memory_retrieve(args);
      },
      memory_store: (args) => namespaceStore.memory_store(args),
      memory_list: checkOperatingBudgetMocks().memory_list,
      'agentdb_hierarchical-store': () => ({ success: true }),
    });
    const { calls: autogenousCalls, config: autogenousConfig } = mockAutogenousService({
      '/v1/agl/admit': () => ({ admitted: true, error: null, reason: null }),
      '/v1/canary/new': () => ({ controller: baseController(), stage_pct: 1 }),
    });

    // Same currentHardStopThreshold on every call, matching the real
    // production shape: this v1 flow never actually updates
    // Company.budget.hardStopThreshold (only /v1/promote would, Phase 4b,
    // out of scope), so a caller re-checking the same ongoing incident
    // passes the same value every time.
    const first = await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);
    const second = await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);
    const third = await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);
    const fourth = await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);

    assert.equal(first.triggered, false);
    assert.equal(second.triggered, false);
    assert.equal(third.triggered, true, 'expected the 3rd consecutive WARNING reading to trigger');
    assert.equal(
      fourth.triggered,
      false,
      'the 4th consecutive WARNING reading must NOT re-trigger — same ongoing incident, already proposed',
    );

    const admitCalls = autogenousCalls.filter((c) => c.path === '/v1/agl/admit');
    const canaryCalls = autogenousCalls.filter((c) => c.path === '/v1/canary/new');
    assert.equal(admitCalls.length, 1, 'expected exactly ONE /v1/agl/admit call for the whole sustained incident');
    assert.equal(canaryCalls.length, 1, 'expected exactly ONE /v1/canary/new call — no redundant canary');
  },
);

test(
  'FIXED (recovery case): after a streak breaks (returns to OK/INFO) and a genuinely NEW WARNING+ streak forms, ' +
    'the trigger fires again — de-duplication only suppresses re-triggers WITHIN one ongoing incident, not across ' +
    'separate incidents',
  async () => {
    const namespaceStore = statefulNamespaceStore();
    const level = { current: 'WARNING' as 'WARNING' | 'OK' };
    const { config } = mockBridge({
      memory_retrieve: (args) => {
        if (args.namespace === 'ruclip-cost-tracking' && args.key === 'co-1:budget-config') {
          return { found: true, value: { budgetUsd: 100, thresholds: { info: 0.5, warning: 0.75, critical: 0.9, hardStop: 1.0 } } };
        }
        if (args.namespace === 'ruclip-cost-tracking' && args.key === 'co-1:session-a') {
          // 0.8 utilization -> WARNING, 0.1 -> OK, toggled by the test.
          return { found: true, value: { total_cost_usd: level.current === 'WARNING' ? 80 : 10 } };
        }
        return namespaceStore.memory_retrieve(args);
      },
      memory_store: (args) => namespaceStore.memory_store(args),
      memory_list: () => ({ entries: [{ key: 'co-1:session-a' }] }),
      'agentdb_hierarchical-store': () => ({ success: true }),
    });
    const { calls: autogenousCalls, config: autogenousConfig } = mockAutogenousService({
      '/v1/agl/admit': () => ({ admitted: true, error: null, reason: null }),
      '/v1/canary/new': () => ({ controller: baseController(), stage_pct: 1 }),
    });

    // Incident 1: 3 consecutive WARNING readings -> triggers once.
    await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);
    await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);
    const incident1 = await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);
    assert.equal(incident1.triggered, true, 'incident 1 triggers on its 3rd consecutive WARNING reading');

    // The streak breaks — back to OK for a few readings.
    level.current = 'OK';
    await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);
    await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);

    // Incident 2: a genuinely new WARNING+ streak begins.
    level.current = 'WARNING';
    await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);
    await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);
    const incident2 = await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);
    assert.equal(incident2.triggered, true, 'incident 2 (a separate, later streak) must still trigger its own proposal');

    assert.notEqual(
      incident1.record!.id,
      incident2.record!.id,
      'two genuinely separate incidents produce two genuinely separate mutation records',
    );

    const admitCalls = autogenousCalls.filter((c) => c.path === '/v1/agl/admit');
    assert.equal(admitCalls.length, 2, 'exactly one admit call per genuinely separate incident, two incidents total');
  },
);
