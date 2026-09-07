/**
 * Real-backend evidence for the nonce-replay-guard fix in
 * `actor-credential.ts`/`human-identity-attestation.ts` (see
 * docs/dream-cycle/2026-09-06-security-report.md and PR #15).
 *
 * The rest of this repo's coverage (`actor-identity-verification.test.ts`,
 * `human-identity-attestation.test.ts`) exercises the fix through
 * `mockBridge`, whose `memory_store` handler was hand-written to MODEL the
 * real `@claude-flow/cli` backend's `UNIQUE(namespace, key)` constraint —
 * useful for testing ruClip's own call sites in isolation, but a mock is
 * not proof the real backend actually enforces that constraint the way the
 * mock assumes. PR #15 review asked for evidence that crosses that
 * boundary: the same concurrent-replay shape run against the real,
 * installed tool, across real OS processes, with durability checked after
 * the writer has exited.
 *
 * This file calls `@claude-flow/cli`'s own real `storeEntry`/`getEntry`
 * directly (no HTTP bridge process — there is none running in CI; ruClip's
 * production code talks to a live `ruflo mcp start` bridge, but the
 * `memory_store`/`memory_retrieve` MCP tools these tests exercise are thin
 * wrappers over these exact functions — confirmed by reading
 * `@claude-flow/cli`'s own `memory-tools.js` handlers, see the security
 * report's Candidate section).
 *
 * Backend coverage: the sql.js (WASM SQLite) fallback path, forced via the
 * real tool's own `CLAUDE_FLOW_DISABLE_BRIDGE=1` escape hatch (see
 * `nonce-store-race-worker.ts`'s header for why — the native
 * `better-sqlite3` bridge path eagerly loads a transformer embedding model
 * on first use, which is slow and network-dependent, unsuitable for a fast
 * deterministic CI suite). Both paths write through the identical
 * `UNIQUE(namespace, key)` SQL contract; the native bridge path was
 * separately confirmed by manual invocation during this fix's development
 * (successCount 1/2, durable read true) — see the security report — but is
 * not wired into the automated suite for the reason above.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CLAUDE_FLOW_DISABLE_BRIDGE = '1';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { initializeMemoryDatabase, storeEntry, getEntry } = await import('@claude-flow/cli/memory');

/**
 * `@claude-flow/cli` is `ruflo`'s own transitive dependency, not one
 * ruClip's package.json declares directly — asserted here (via a plain
 * filesystem read of its package.json, not a module-specifier resolution,
 * since the package's own `exports` map does not list `./package.json`)
 * rather than pinned in ruClip's own package.json, so a future `npm
 * install` that resolves a different version fails this test LOUDLY
 * instead of silently invalidating the real-backend conclusions below.
 */
const EXPECTED_CLAUDE_FLOW_CLI_VERSION = '3.38.20';

function installedClaudeFlowCliVersion(): string {
  const pkgPath = join(process.cwd(), 'node_modules', '@claude-flow', 'cli', 'package.json');
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

test(
  '@claude-flow/cli is the exact version this suite\'s real-backend conclusions were verified against — a version ' +
    'drift must fail loudly here, not silently invalidate the evidence below',
  () => {
    assert.equal(installedClaudeFlowCliVersion(), EXPECTED_CLAUDE_FLOW_CLI_VERSION);
  },
);

function freshTempDb(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ruclip-nonce-durable-backend-'));
  return { dbPath: join(dir, 'memory.db'), dir };
}

test('real backend: memory_store(upsert:false) strict-inserts — first call succeeds, second fails', async () => {
  const { dbPath, dir } = freshTempDb();
  try {
    await initializeMemoryDatabase({ dbPath, backend: 'hybrid' });
    const key = 'strict-insert-key';
    const namespace = 'ruclip-nonce-durable-backend-test';

    const first = await storeEntry({ key, value: 'true', namespace, ttl: 60, upsert: false, generateEmbeddingFlag: false, dbPath });
    assert.equal(first.success, true);

    const second = await storeEntry({ key, value: 'true', namespace, ttl: 60, upsert: false, generateEmbeddingFlag: false, dbPath });
    assert.equal(second.success, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'real backend: two concurrent same-process memory_store(upsert:false) calls for the same key — exactly one ' +
    'succeeds (the property the nonce-replay guard fix depends on)',
  async () => {
    const { dbPath, dir } = freshTempDb();
    try {
      await initializeMemoryDatabase({ dbPath, backend: 'hybrid' });
      const key = 'concurrent-key';
      const namespace = 'ruclip-nonce-durable-backend-test';

      const [a, b] = await Promise.all([
        storeEntry({ key, value: 'true', namespace, ttl: 60, upsert: false, generateEmbeddingFlag: false, dbPath }),
        storeEntry({ key, value: 'true', namespace, ttl: 60, upsert: false, generateEmbeddingFlag: false, dbPath }),
      ]);
      const successCount = [a, b].filter((r) => r.success).length;
      assert.equal(successCount, 1, `expected exactly one concurrent strict-insert to succeed, got ${successCount}`);

      const read = await getEntry({ key, namespace, dbPath });
      assert.equal(read.found, true, 'the successful write must be durably readable back');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'real backend: two REAL, separate OS processes racing memory_store(upsert:false) for the same key against the ' +
    'same on-disk file — exactly one succeeds, and the result is durably readable by a third process after both ' +
    'writers have exited (the exact "repeated processes" / "durable after restart" evidence PR #15 review asked for)',
  async () => {
    const { dbPath, dir } = freshTempDb();
    const barrierPath = join(dir, 'go');
    const workerPath = fileURLToPath(new URL('../support/nonce-store-race-worker.js', import.meta.url));
    try {
      await initializeMemoryDatabase({ dbPath, backend: 'hybrid' });
      const key = 'multiprocess-key';
      const namespace = 'ruclip-nonce-durable-backend-test';

      function runWorker(): Promise<{ success: boolean }> {
        return new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [workerPath, dbPath, key, namespace, barrierPath]);
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.stderr.on('data', (chunk) => (stderr += chunk));
          child.on('error', reject);
          child.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`nonce-store-race-worker exited ${code}${stderr ? `: ${stderr}` : ''}`));
              return;
            }
            resolve(JSON.parse(stdout.trim()) as { success: boolean });
          });
        });
      }

      const racers = [runWorker(), runWorker()];
      // Let both child processes spawn, load their module graph, and reach
      // the barrier wait before releasing them together — otherwise one
      // process could finish its entire store call before the second one
      // even starts, which would prove nothing about the race.
      await new Promise((resolve) => setTimeout(resolve, 200));
      writeFileSync(barrierPath, '1');

      const results = await Promise.all(racers);
      const successCount = results.filter((r) => r.success).length;
      assert.equal(
        successCount,
        1,
        `expected exactly one of two real OS processes to win the strict-insert, got ${successCount} (${JSON.stringify(results)})`,
      );

      // Read from THIS (third) process, after both writer processes have
      // already exited — durability across process boundaries, not just
      // within one process's lifetime.
      const read = await getEntry({ key, namespace, dbPath });
      assert.equal(read.found, true, 'the winning write must survive both writer processes exiting');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
