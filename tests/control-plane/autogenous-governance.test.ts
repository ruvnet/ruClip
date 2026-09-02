/**
 * Coverage for AUTOGENOUS-RUNTIME-GOVERNANCE.md: every real AdmitResponse
 * error code round-trips correctly (including the PascalCase-vs-snake_case
 * Debug-string nuance, §2.4), CanaryState/Decision's externally-tagged
 * shapes round-trip against hand-built fixture JSON matching §2.6 AND
 * reject anything that doesn't match (the defensive parse boundary §2.6
 * explicitly asked for), AutogenousClientError on unreachability is
 * treated as "not admitted" everywhere it's used, and the audit-trail
 * record faithfully mirrors a multi-step canary observation sequence.
 *
 * No live autogenous-service instance (not deployed yet) — a plain fetch
 * mock dispatching by path stands in for it, and mockBridge stands in for
 * the AgentDB bridge, same "no live instance" discipline as every other
 * test file in this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import {
  getHealth,
  admitMutation,
  createCanary,
  observeCanary,
  assertValidCanaryState,
  assertValidDecision,
  AutogenousClientError,
  type AdmitResponse,
  type CanaryController,
  type HardGates,
  type AutogenousClientConfig,
} from '../../src/control-plane/governance/autogenous-client.js';
import {
  checkAndProposeBudgetMutation,
  observeBudgetMutation,
} from '../../src/control-plane/governance/propose-budget-mutation.js';

// --- Plain-fetch mock for autogenous-service (REST, not JSON-RPC) ----------

interface AutogenousRecordedCall {
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

function mockAutogenousService(handlers: Record<string, (body: unknown) => unknown>) {
  const calls: AutogenousRecordedCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, headers: (init?.headers as Record<string, string>) ?? {} });
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

// --- §2.4: every real AdmitResponse error code ------------------------------

const REAL_ADMIT_ERROR_CODES = [
  'AuthorityExpansion',
  'AuthorityInsufficient',
  'InvariantRegressed',
  'ParentMismatch',
  'ConstitutionalScope',
  'NoRollback',
  'Expired',
] as const;

for (const code of REAL_ADMIT_ERROR_CODES) {
  test(`admitMutation round-trips AdmitResponse.error === '${code}' verbatim, including a PascalCase Debug-string reason`, async () => {
    // The real handler's Debug-string reason uses PascalCase Rust variant
    // names for Authority (e.g. "Governed"), not the snake_case wire form
    // — this fixture matches that exact real shape (§2.4).
    const fixtureReason = `${code} { requested: Governed, ceiling: AutoReversible }`;
    const { calls, config } = mockAutogenousService({
      '/v1/agl/admit': () => ({ admitted: false, error: code, reason: fixtureReason } satisfies AdmitResponse),
    });
    const result = await admitMutation(
      {
        mutation: {
          id: 'm-1',
          parent_genome_hash: 'g-1',
          scope: 'routing_budget',
          requested_authority: 'auto_reversible',
          applicability: { workloads: [], environments: [], jurisdictions: [] },
          preserved_invariants: [],
          rollback_target: 'g-1',
          expires_at: null,
          signature: null,
        },
        parent: {
          hash: 'g-1',
          identity: 'id',
          constitution: 'unconstituted',
          capability_ceiling: 'auto_reversible',
          hard_invariants: [],
          lineage: [],
        },
        now: 1000,
      },
      config,
    );
    assert.equal(result.admitted, false);
    assert.equal(result.error, code);
    assert.equal(result.reason, fixtureReason);
    assert.equal(calls[0]!.path, '/v1/agl/admit');
    // Fields sent to the wire use the literal snake_case Rust field names,
    // never camelCase (§2 header note).
    assert.equal((calls[0]!.body as { mutation: { parent_genome_hash: string } }).mutation.parent_genome_hash, 'g-1');
  });
}

test('admitMutation returns {admitted: true, error: null, reason: null} as-is on success — not an error, a normal response', async () => {
  const { config } = mockAutogenousService({
    '/v1/agl/admit': () => ({ admitted: true, error: null, reason: null }),
  });
  const result = await admitMutation(
    {
      mutation: {
        id: 'm-1',
        parent_genome_hash: 'g-1',
        scope: 'routing_budget',
        requested_authority: 'auto_reversible',
        applicability: { workloads: [], environments: [], jurisdictions: [] },
        preserved_invariants: [],
        rollback_target: 'g-1',
        expires_at: null,
        signature: null,
      },
      parent: {
        hash: 'g-1',
        identity: 'id',
        constitution: 'unconstituted',
        capability_ceiling: 'auto_reversible',
        hard_invariants: [],
        lineage: [],
      },
      now: 1000,
    },
    config,
  );
  assert.deepEqual(result, { admitted: true, error: null, reason: null });
});

// --- §2.6: CanaryState / Decision externally-tagged shapes -----------------

test('assertValidCanaryState accepts all three real variant shapes, hand-built matching §2.6 exactly', () => {
  assert.deepEqual(assertValidCanaryState({ Serving: { stage_idx: 1, healthy_observations: 2 } }), {
    Serving: { stage_idx: 1, healthy_observations: 2 },
  });
  assert.deepEqual(assertValidCanaryState({ Promoted: { signature: 'sig' } }), { Promoted: { signature: 'sig' } });
  assert.deepEqual(assertValidCanaryState({ RolledBack: { at_stage_pct: 10, reason: 'regressed' } }), {
    RolledBack: { at_stage_pct: 10, reason: 'regressed' },
  });
});

test('assertValidCanaryState rejects an unexpected shape rather than silently passing it through', () => {
  assert.throws(() => assertValidCanaryState({ Unknown: {} }), AutogenousClientError);
  assert.throws(() => assertValidCanaryState('Serving'), AutogenousClientError);
  assert.throws(() => assertValidCanaryState(null), AutogenousClientError);
  assert.throws(() => assertValidCanaryState({ Serving: {}, Promoted: {} }), AutogenousClientError);
});

test('assertValidDecision accepts all four real variant shapes, hand-built matching §2.6 exactly', () => {
  assert.equal(assertValidDecision('Hold'), 'Hold');
  assert.equal(assertValidDecision('ReadyForPromotion'), 'ReadyForPromotion');
  assert.deepEqual(assertValidDecision({ Advance: { to_pct: 50 } }), { Advance: { to_pct: 50 } });
  assert.deepEqual(assertValidDecision({ RollBack: { reason: 'unsafe' } }), { RollBack: { reason: 'unsafe' } });
});

test('assertValidDecision rejects an unexpected shape rather than silently passing it through', () => {
  assert.throws(() => assertValidDecision('Unknown'), AutogenousClientError);
  assert.throws(() => assertValidDecision({ Advance: {}, extra: 1 }), AutogenousClientError);
  assert.throws(() => assertValidDecision(42), AutogenousClientError);
});

test('createCanary throws when the service returns a CanaryState shape that does not match §2.6', async () => {
  const { config } = mockAutogenousService({
    '/v1/canary/new': () => ({
      controller: { ...baseController(), state: { NotARealVariant: {} } },
      stage_pct: 1,
    }),
  });
  await assert.rejects(
    () => createCanary({ candidate_id: 'm-1', rollback_target: 'g-1' }, config),
    AutogenousClientError,
  );
});

test('createCanary returns the real response when the CanaryState shape is valid', async () => {
  const { calls, config } = mockAutogenousService({
    '/v1/canary/new': () => ({ controller: baseController(), stage_pct: 1 }),
  });
  const result = await createCanary({ candidate_id: 'm-1', rollback_target: 'g-1' }, config);
  assert.equal(result.stage_pct, 1);
  assert.deepEqual(result.controller.state, { Serving: { stage_idx: 0, healthy_observations: 0 } });
  assert.equal(calls[0]!.path, '/v1/canary/new');
});

test('observeCanary throws when the service returns a Decision shape that does not match §2.6', async () => {
  const { config } = mockAutogenousService({
    '/v1/canary/observe': () => ({ controller: baseController(), decision: 'NotARealDecision', stage_pct: 1 }),
  });
  await assert.rejects(
    () =>
      observeCanary(
        {
          controller: baseController(),
          fitness: {
            task_quality: 1,
            safety: 1,
            governance: 1,
            reliability: 1,
            p99_overhead_ms: 0,
            false_positive_rate: 0,
            regression_count: 0,
            rollback_verified: false,
          },
        },
        config,
      ),
    AutogenousClientError,
  );
});

// --- §3: unreachability is "not admitted" everywhere ------------------------

test('admitMutation throws AutogenousClientError when the service is unreachable — never silently degrades', async () => {
  const config: AutogenousClientConfig = {
    baseUrl: 'https://autogenous.mock',
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
  };
  await assert.rejects(
    () =>
      admitMutation(
        {
          mutation: {
            id: 'm-1',
            parent_genome_hash: 'g-1',
            scope: 'routing_budget',
            requested_authority: 'auto_reversible',
            applicability: { workloads: [], environments: [], jurisdictions: [] },
            preserved_invariants: [],
            rollback_target: 'g-1',
            expires_at: null,
            signature: null,
          },
          parent: {
            hash: 'g-1',
            identity: 'id',
            constitution: 'unconstituted',
            capability_ceiling: 'auto_reversible',
            hard_invariants: [],
            lineage: [],
          },
          now: 1000,
        },
        config,
      ),
    AutogenousClientError,
  );
});

test('AutogenousClientError with no baseUrl configured and no AUTOGENOUS_SERVICE_URL env var — no hardcoded local default (§3)', async () => {
  const previous = process.env.AUTOGENOUS_SERVICE_URL;
  delete process.env.AUTOGENOUS_SERVICE_URL;
  try {
    await assert.rejects(() => admitMutation({} as never, {}), AutogenousClientError);
  } finally {
    if (previous !== undefined) process.env.AUTOGENOUS_SERVICE_URL = previous;
  }
});

// --- tokenProvider: real deployment requires a bearer OIDC identity token --

test('tokenProvider, when supplied, is sent as an Authorization: Bearer header on every call', async () => {
  const { calls, config } = mockAutogenousService({
    '/health': () => ({ status: 'ok' }),
  });
  await getHealth({ ...config, tokenProvider: async () => 'fake-id-token' });
  assert.equal(calls[0]!.headers['authorization'], 'Bearer fake-id-token');
});

test('getHealth omits the Authorization header when no tokenProvider is configured', async () => {
  const { calls, config } = mockAutogenousService({
    '/health': () => ({ status: 'ok' }),
  });
  await getHealth(config);
  assert.equal(calls[0]!.headers['authorization'], undefined);
});

test('a tokenProvider that throws surfaces as AutogenousClientError, not a raw error', async () => {
  const { config } = mockAutogenousService({ '/health': () => ({ status: 'ok' }) });
  await assert.rejects(
    () =>
      getHealth({
        ...config,
        tokenProvider: async () => {
          throw new Error('gcloud not authenticated');
        },
      }),
    AutogenousClientError,
  );
});

// --- Level-history + trigger + observation, against the AgentDB bridge -----

function checkOperatingBudgetMocks(level: 'OK' | 'WARNING') {
  const totalCostUsd = level === 'WARNING' ? 80 : 0;
  return {
    'memory_retrieve': (args: Record<string, unknown>) => {
      if (args.namespace === 'ruclip-cost-tracking' && args.key === 'co-1:budget-config') {
        return { found: true, value: { budgetUsd: 100, thresholds: { info: 0.5, warning: 0.75, critical: 0.9, hardStop: 1.0 } } };
      }
      if (args.namespace === 'ruclip-cost-tracking' && args.key === 'co-1:session-a') {
        return { found: true, value: { total_cost_usd: totalCostUsd } };
      }
      return { found: false };
    },
    'memory_list': () => ({ entries: [{ key: 'co-1:session-a' }] }),
  };
}

/** In-memory backing for the level-history + mutation-record namespaces, so repeated calls within one test see each other's writes — mirrors actor-credential-fixture.ts's nonceMockHandlers() pattern. */
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

test('checkAndProposeBudgetMutation does not trigger before 3 consecutive WARNING-or-worse readings', async () => {
  const namespaceStore = statefulNamespaceStore();
  const { config } = mockBridge({
    ...checkOperatingBudgetMocks('WARNING'),
    memory_retrieve: (args) => {
      // Route budget-config/session lookups to the stateless helper, and
      // the level-history key to the stateful store.
      if (args.namespace === 'ruclip-cost-tracking') return checkOperatingBudgetMocks('WARNING').memory_retrieve(args);
      return namespaceStore.memory_retrieve(args);
    },
    memory_store: (args) => namespaceStore.memory_store(args),
  });

  const first = await checkAndProposeBudgetMutation('co-1', 1.0, config);
  const second = await checkAndProposeBudgetMutation('co-1', 1.0, config);
  assert.equal(first.triggered, false);
  assert.equal(second.triggered, false);
});

test('checkAndProposeBudgetMutation triggers on the 3rd consecutive WARNING-or-worse reading, submits an admit request, and persists the record', async () => {
  const namespaceStore = statefulNamespaceStore();
  const storeCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const { config } = mockBridge({
    memory_retrieve: (args) => {
      if (args.namespace === 'ruclip-cost-tracking') return checkOperatingBudgetMocks('WARNING').memory_retrieve(args);
      return namespaceStore.memory_retrieve(args);
    },
    memory_store: (args) => namespaceStore.memory_store(args),
    memory_list: checkOperatingBudgetMocks('WARNING').memory_list,
    'agentdb_hierarchical-store': (args) => {
      storeCalls.push({ toolName: 'agentdb_hierarchical-store', args });
      return { success: true };
    },
  });
  const { config: autogenousConfig } = mockAutogenousService({
    '/v1/agl/admit': () => ({ admitted: true, error: null, reason: null }),
    '/v1/canary/new': () => ({ controller: baseController({ audit: ['signed-record-1'] }), stage_pct: 1 }),
  });

  await checkAndProposeBudgetMutation('co-1', 1.0, config);
  await checkAndProposeBudgetMutation('co-1', 1.0, config);
  const third = await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);

  assert.equal(third.triggered, true);
  assert.ok(third.record);
  assert.equal(third.record!.admitResponse.admitted, true);
  assert.equal(third.record!.mutation.scope, 'routing_budget');
  assert.equal(third.record!.mutation.requested_authority, 'auto_reversible');
  assert.equal(third.record!.mutation.rollback_target, third.record!.parentGenome.hash);
  assert.ok(third.record!.controller, 'admitted mutation should have created a canary controller');
  assert.deepEqual(third.record!.controller!.audit, ['signed-record-1']);

  const persistCall = storeCalls.find(
    (c) => c.toolName === 'agentdb_hierarchical-store' && (c.args.key as string).includes(':autogenous-mutation:'),
  );
  assert.ok(persistCall, 'expected the AutogenousMutationRecord to be persisted');
});

test('checkAndProposeBudgetMutation persists the record even when the mutation is NOT admitted, with controller left null', async () => {
  const namespaceStore = statefulNamespaceStore();
  const { config } = mockBridge({
    memory_retrieve: (args) => {
      if (args.namespace === 'ruclip-cost-tracking') return checkOperatingBudgetMocks('WARNING').memory_retrieve(args);
      return namespaceStore.memory_retrieve(args);
    },
    memory_store: (args) => namespaceStore.memory_store(args),
    memory_list: checkOperatingBudgetMocks('WARNING').memory_list,
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const { config: autogenousConfig } = mockAutogenousService({
    '/v1/agl/admit': () => ({ admitted: false, error: 'InvariantRegressed', reason: 'InvariantRegressed { name: "budget-hard-stop-monotonic" }' }),
  });

  await checkAndProposeBudgetMutation('co-1', 1.0, config);
  await checkAndProposeBudgetMutation('co-1', 1.0, config);
  const third = await checkAndProposeBudgetMutation('co-1', 1.0, config, autogenousConfig);

  assert.equal(third.triggered, true);
  assert.equal(third.record!.admitResponse.admitted, false);
  assert.equal(third.record!.admitResponse.error, 'InvariantRegressed');
  assert.equal(third.record!.controller, null);
});

test('checkAndProposeBudgetMutation propagates AutogenousClientError (unreachable service) rather than swallowing it — §3 fail-closed', async () => {
  const namespaceStore = statefulNamespaceStore();
  const { config } = mockBridge({
    memory_retrieve: (args) => {
      if (args.namespace === 'ruclip-cost-tracking') return checkOperatingBudgetMocks('WARNING').memory_retrieve(args);
      return namespaceStore.memory_retrieve(args);
    },
    memory_store: (args) => namespaceStore.memory_store(args),
    memory_list: checkOperatingBudgetMocks('WARNING').memory_list,
    'agentdb_hierarchical-store': () => ({ success: true }),
  });
  const unreachableAutogenousConfig: AutogenousClientConfig = {
    baseUrl: 'https://autogenous.mock',
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
  };

  await checkAndProposeBudgetMutation('co-1', 1.0, config);
  await checkAndProposeBudgetMutation('co-1', 1.0, config);
  await assert.rejects(
    () => checkAndProposeBudgetMutation('co-1', 1.0, config, unreachableAutogenousConfig),
    AutogenousClientError,
  );
});

test('observeBudgetMutation appends a multi-step observation sequence and mirrors the service audit trail verbatim', async () => {
  const { config: storeConfig } = mockBridge({
    'agentdb_hierarchical-recall': (args) =>
      args.tier === 'working' && (args.query as string).includes(':autogenous-mutation:mutation-1')
        ? {
            results: [
              {
                key: args.query,
                value: JSON.stringify({
                  id: 'mutation-1',
                  companyId: 'co-1',
                  mutation: {
                    id: 'mutation-1',
                    parent_genome_hash: 'g-1',
                    scope: 'routing_budget',
                    requested_authority: 'auto_reversible',
                    applicability: { workloads: [], environments: [], jurisdictions: [] },
                    preserved_invariants: [],
                    rollback_target: 'g-1',
                    expires_at: null,
                    signature: null,
                  },
                  parentGenome: {
                    hash: 'g-1',
                    identity: 'id',
                    constitution: 'unconstituted',
                    capability_ceiling: 'auto_reversible',
                    hard_invariants: [],
                    lineage: [],
                  },
                  admitResponse: { admitted: true, error: null, reason: null },
                  controller: baseController({ audit: ['record-1'] }),
                  observations: [],
                  createdAt: '2026-09-02T00:00:00.000Z',
                  updatedAt: '2026-09-02T00:00:00.000Z',
                }),
              },
            ],
          }
        : { results: [] },
    'agentdb_hierarchical-store': () => ({ success: true }),
    'memory_retrieve': (args) =>
      args.namespace === 'ruclip-cost-tracking' && args.key === 'co-1:budget-config'
        ? { found: true, value: { budgetUsd: 100, thresholds: { info: 0.5, warning: 0.75, critical: 0.9, hardStop: 1.0 } } }
        : { found: false },
    'memory_list': () => ({ entries: [] }), // no session cost -> utilizationPct 0 -> level OK
  });
  const { config: autogenousConfig } = mockAutogenousService({
    '/v1/canary/observe': () => ({
      controller: baseController({ audit: ['record-1', 'record-2'], state: { Serving: { stage_idx: 1, healthy_observations: 1 } } }),
      decision: { Advance: { to_pct: 10 } },
      stage_pct: 10,
    }),
  });

  const result = await observeBudgetMutation('co-1', 'mutation-1', storeConfig, autogenousConfig);

  assert.deepEqual(result.decision, { Advance: { to_pct: 10 } });
  assert.equal(result.stagePct, 10);
  assert.equal(result.record.observations.length, 1);
  assert.deepEqual(result.record.observations[0]!.decision, { Advance: { to_pct: 10 } });
  // The service's own signed audit trail is copied verbatim, not paraphrased.
  assert.deepEqual(result.record.controller!.audit, ['record-1', 'record-2']);
});

test('observeBudgetMutation throws when no admitted, canarying record exists for the mutation', async () => {
  const { config: storeConfig } = mockBridge({
    'agentdb_hierarchical-recall': () => ({ results: [] }),
  });
  await assert.rejects(() => observeBudgetMutation('co-1', 'no-such-mutation', storeConfig, {}));
});
